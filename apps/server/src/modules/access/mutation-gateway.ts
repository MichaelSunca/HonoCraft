import type { Pool } from 'pg';
import { z } from 'zod';
import { AppError } from '@honocraft/contracts/errors';
import type { PermissionCode } from '@honocraft/contracts/permissions';
import { withTransaction, type Tx } from '../../infrastructure/db.js';
import { verifyCsrf } from '../../infrastructure/crypto.js';
import { runIdempotent, type DigestKey, type OperationSummary } from '../../infrastructure/idempotency.js';
import { appendAudit, requestMetaSchema, type AuditEvent, type RequestMeta } from '../audit/writer.js';
import { authenticateLockedSession, locateSession, type SessionContext } from '../auth/sessions.js';
import { lockIdentityRows } from './repository.js';
import { requireRecentAuthentication } from './policy.js';

type AuditDetail=Pick<AuditEvent,'target'|'changes'|'reason'>;
type Locks={userIds:readonly string[];roleIds:readonly string[]};
type MutationResult<T>={data:T;audit:AuditDetail;status?:number};
type Definition<I extends z.ZodType,O extends z.ZodType,P extends z.ZodType>={
  input:I;output:O;mode:'shared'|'exclusive';permission:PermissionCode|null;recentAuth:boolean;auditAction:string;
  resolveLocks:(tx:Tx,input:z.output<I>,actorId:string)=>Promise<Locks>;
  authorize:(tx:Tx,context:SessionContext,input:z.output<I>)=>Promise<void>;
  execute:(tx:Tx,context:SessionContext,input:z.output<I>)=>Promise<MutationResult<z.output<O>>>;
  idempotency?:{
    policySchema:P;
    authorizeStored:(tx:Tx,context:SessionContext,input:z.output<I>,stored:z.output<P>)=>Promise<void>;
    summarize:(data:z.output<O>,context:SessionContext)=>OperationSummary;
    policyContext:(data:z.output<O>,context:SessionContext,input:z.output<I>)=>z.input<P>;
  };
};
type BoundMutation={
  input:unknown;
  resolveLocks:(tx:Tx,actorId:string)=>Promise<Locks>;
  authorize:(tx:Tx,context:SessionContext)=>Promise<void>;
  execute:(tx:Tx,context:SessionContext)=>Promise<MutationResult<unknown>>;
  idempotency?:{
    policySchema:z.ZodType;
    authorizeStored:(tx:Tx,context:SessionContext,stored:unknown)=>Promise<void>;
    summarize:(data:unknown,context:SessionContext)=>OperationSummary;
    policyContext:(data:unknown,context:SessionContext)=>unknown;
  };
};
type RegisteredMutation={
  input:z.ZodType;output:z.ZodType;mode:'shared'|'exclusive';permission:PermissionCode|null;
  recentAuth:boolean;auditAction:string;bind:(input:unknown)=>BoundMutation;
};
/** Only server-owned modules register definitions. HTTP accepts operation IDs and data, never callbacks. */
export function defineMutation<I extends z.ZodType,O extends z.ZodType,P extends z.ZodType=z.ZodType>(definition:Definition<I,O,P>) {
  return {
    input:definition.input,output:definition.output,mode:definition.mode,permission:definition.permission,
    recentAuth:definition.recentAuth,auditAction:definition.auditAction,
    bind(raw:unknown):BoundMutation {
      const parsed=definition.input.safeParse(raw);
      if(!parsed.success)throw new AppError('VALIDATION_ERROR');
      const input=parsed.data;
      const bound:BoundMutation={
        input,
        resolveLocks:(tx,actorId)=>definition.resolveLocks(tx,input,actorId),
        authorize:(tx,context)=>definition.authorize(tx,context,input),
        execute:async(tx,context)=>{
          const result=await definition.execute(tx,context,input);
          return {...result,data:definition.output.parse(result.data)};
        },
      };
      const idem=definition.idempotency;
      if(idem)bound.idempotency={
        policySchema:idem.policySchema,
        authorizeStored:(tx,context,stored)=>idem.authorizeStored(tx,context,input,idem.policySchema.parse(stored)),
        summarize:(data,context)=>idem.summarize(definition.output.parse(data),context),
        policyContext:(data,context)=>idem.policyContext(definition.output.parse(data),context,input),
      };
      return bound;
    },
  };
}
type GatewaySecrets=Readonly<{epoch:string;csrfKey:Buffer;digestKey:DigestKey}>;
type ActorRef=Readonly<{token:string;csrfToken:string}>;
export function createMutationGateway<const Registry extends Record<string,RegisteredMutation>>(pool:Pool,secrets:GatewaySecrets,registry:Registry) {
  return async function authorizeMutation<K extends keyof Registry & string>(operation:K,ref:ActorRef,input:unknown,meta:RequestMeta,idempotencyKey?:string,remainingBudgetMs=15_000) {
    if(!Object.hasOwn(registry,operation))throw new AppError('NOT_FOUND');
    const definition=registry[operation]!;
    const bound=definition.bind(input);
    const request=requestMetaSchema.parse(meta);
    if(bound.idempotency&&!z.uuid().safeParse(idempotencyKey).success)throw new AppError('VALIDATION_ERROR',{idempotency_key:['Expected UUID']});
    let actorId:string|undefined;
    const deadline=performance.now()+Math.min(15_000,remainingBudgetMs);
    for(let attempt=0;;attempt++) {
      try {
        if(deadline-performance.now()<8_000)throw new AppError('BUSY_RETRY',{},2);
        return await withTransaction(pool,definition.mode,async tx=>{
          const locator=await locateSession(tx,ref.token);
          const locks=await bound.resolveLocks(tx,locator.userId);
          await lockIdentityRows(tx,[locator.userId,...locks.userIds],locks.roleIds);
          const context=await authenticateLockedSession(tx,locator,secrets.epoch);
          actorId=context.actor.userId;
          if(!verifyCsrf(secrets.csrfKey,context.sessionId,secrets.epoch,ref.csrfToken))throw new AppError('CSRF_INVALID');
          if(definition.permission&&!context.permissions.has(definition.permission))throw new AppError('FORBIDDEN');
          if(definition.recentAuth)requireRecentAuthentication(context.reauthenticatedAt,context.now);
          const execute=async()=>{
            await bound.authorize(tx,context);
            const result=await bound.execute(tx,context);
            await appendAudit(tx,{actor:{type:'user',id:actorId},action:definition.auditAction,result:'success',meta:request,...result.audit});
            return result;
          };
          const idem=bound.idempotency;
          if(idem) {
            let fresh:MutationResult<unknown>|undefined;
            const result=await runIdempotent(tx,{
              actorId:context.actor.userId,operation,key:idempotencyKey!,input:bound.input,digestKey:secrets.digestKey,
              policySchema:idem.policySchema,authorizeStored:stored=>idem.authorizeStored(tx,context,stored),
              execute:async()=>{
                fresh=await execute();
                return {summary:idem.summarize(fresh.data,context),status:fresh.status??200,
                  target:{type:fresh.audit.target.type,id:fresh.audit.target.id??null},policyContext:idem.policyContext(fresh.data,context)};
              },
            });
            return {data:(fresh?fresh.data:result.summary) as z.output<Registry[K]['output']>|OperationSummary,status:result.status,replayed:result.replayed};
          }
          const result=await execute();
          return {data:result.data as z.output<Registry[K]['output']>,status:result.status??200,replayed:false};
        });
      } catch(error) {
        const code=typeof error==='object'&&error!==null&&'code' in error?error.code:undefined;
        if(bound.idempotency&&attempt<2&&['40001','40P01'].includes(String(code))&&deadline-performance.now()>=8_000)continue;
        const failure=code==='55P03'?new AppError('BUSY_RETRY',{},2):error;
        const safe=failure instanceof AppError?failure:new AppError('INTERNAL_ERROR');
        try {
          await withTransaction(pool,'independent',tx=>appendAudit(tx,{
            actor:actorId?{type:'user',id:actorId}:{type:'anonymous'},action:definition.auditAction,
            target:{type:'operation'},result:safe.status<500?'denied':'failed',reasonCode:safe.code,meta:request,
          }));
        } catch { console.error('Failed to persist sanitized mutation failure event'); }
        throw failure;
      }
    }
  };
}
