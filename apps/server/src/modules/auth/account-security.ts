import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import {AppError} from '@honocraft/contracts/errors';
import {ChangePasswordSchema,ReauthenticateSchema} from '@honocraft/contracts/common';
import {ReauthenticatedSchema} from '@honocraft/contracts/http';
import type {PasswordService} from '../../infrastructure/passwords.js';
import {keyedDigest,verifyCsrf,type Keyring} from '../../infrastructure/crypto.js';
import {databaseNow,withTransaction,type Tx} from '../../infrastructure/db.js';
import {accountFailureState,consumeLimits} from '../../infrastructure/rate-limit.js';
import {createMutationGateway,defineMutation} from '../access/mutation-gateway.js';
import {lockIdentityRows} from '../access/repository.js';
import {requestMetaSchema,type RequestMeta} from '../audit/writer.js';
import {appendSecurityEvent} from '../audit/security-writer.js';
import {authenticateLockedSession,locateSession,type SessionContext} from './sessions.js';
import {enqueueMail} from '../mail/outbox.js';
import {cancelCredentialTasks} from '../mail/cancellation.js';
import {loadPublicSettings} from '../settings/public.js';
type Secrets={epoch:string;csrfKey:Buffer;digestKey:{id:string;key:Buffer};mailKeyring:Keyring};
type Ref={token:string;csrfToken:string};
type Candidate={id:string;password_hash:string|null;password_version:number;normalized_email:string};
const policySchema=z.object({login_ip_per_minute:z.number().int().min(1).max(20),account_failures_per_window:z.number().int().min(1).max(5),account_lock_minutes:z.number().int().min(15).max(60),password_min_length:z.number().int().min(15).max(128)});
async function policyAt(tx:Tx){const row=(await tx.query<{typed_value:unknown}>("SELECT typed_value FROM system_settings WHERE key='security'")).rows[0];const value=policySchema.safeParse(row?.typed_value);if(!value.success)throw new AppError('DEPENDENCY_UNAVAILABLE');return value.data;}
const failurePolicy=(policy:z.infer<typeof policySchema>)=>({limit:policy.account_failures_per_window,windowMs:900000,lockMs:policy.account_lock_minutes*60000});
function parse<S extends z.ZodType>(schema:S,input:unknown):z.output<S>{const value=schema.safeParse(input);if(!value.success)throw new AppError('VALIDATION_ERROR');return value.data;}
function budget(deadline:number){if(deadline-performance.now()<8000)throw new AppError('BUSY_RETRY',{},2);}
export function createAccountSecurity(pool:Pool,secrets:Secrets,passwords:PasswordService){
  async function rejected(candidate:Candidate,meta:RequestMeta,increment:boolean){
    await withTransaction(pool,'shared',async tx=>{
      await lockIdentityRows(tx,[candidate.id]);
      if(increment){const policy=await policyAt(tx);const result=await accountFailureState(tx,secrets.digestKey.key,candidate.normalized_email,'failure',failurePolicy(policy));await tx.query('UPDATE users SET locked_until=$2 WHERE id=$1',[candidate.id,result.lockedUntil]);}
      await appendSecurityEvent(tx,{userId:candidate.id,type:'auth.reauthenticate',result:'denied',reasonCode:'AUTH_FAILED',targetDigest:keyedDigest(secrets.digestKey.key,'honocraft.security-target.v1',candidate.normalized_email),meta});
    });
  }
  async function verify(ref:Ref,password:string,meta:RequestMeta,deadline:number){
    const prepared=await withTransaction(pool,'independent',async tx=>{
      const context=await authenticateLockedSession(tx,await locateSession(tx,ref.token),secrets.epoch);
      if(!verifyCsrf(secrets.csrfKey,context.sessionId,secrets.epoch,ref.csrfToken))throw new AppError('CSRF_INVALID');
      const policy=await policyAt(tx);
      const limit=await consumeLimits(tx,secrets.digestKey.key,[{scope:'auth.password_check.ip',identifier:meta.ip,limit:policy.login_ip_per_minute,windowMs:60000,bucketMs:1000}]);
      const candidate=(await tx.query<Candidate>('SELECT id,password_hash,password_version,normalized_email FROM users WHERE id=$1',[context.actor.userId])).rows[0]!;
      return {candidate,sessionId:context.sessionId,policy,limit};
    });
    if(!prepared.limit.allowed)throw new AppError('RATE_LIMITED',{},prepared.limit.retryAfter);
    budget(deadline);const matches=await passwords.verify(prepared.candidate.password_hash,password);budget(deadline);
    if(!matches){await rejected(prepared.candidate,meta,true);throw new AppError('AUTH_FAILED');}
    return prepared;
  }
  async function checkProof(tx:Tx,context:SessionContext,proof:Awaited<ReturnType<typeof verify>>){
    const candidate=(await tx.query<Candidate>('SELECT id,password_hash,password_version,normalized_email FROM users WHERE id=$1',[context.actor.userId])).rows[0];
    if(!candidate||candidate.id!==proof.candidate.id||context.sessionId!==proof.sessionId||candidate.password_hash!==proof.candidate.password_hash||candidate.password_version!==proof.candidate.password_version||candidate.normalized_email!==proof.candidate.normalized_email)throw new AppError('AUTH_FAILED');
    const policy=await policyAt(tx),account=failurePolicy(policy);
    if((await accountFailureState(tx,secrets.digestKey.key,candidate.normalized_email,'inspect',account)).lockedUntil)throw new AppError('AUTH_FAILED');
    return {candidate,policy,account};
  }
  async function withRejection<T>(proof:Awaited<ReturnType<typeof verify>>,meta:RequestMeta,work:()=>Promise<T>){
    try{return await work();}catch(error){if(error instanceof AppError&&error.code==='AUTH_FAILED')await rejected(proof.candidate,meta,false);throw error;}
  }
  async function reauthenticate(ref:Ref,raw:unknown,metadata:RequestMeta,remaining=15000){
    const deadline=performance.now()+Math.min(15000,remaining),input=parse(ReauthenticateSchema,raw),meta=requestMetaSchema.parse(metadata),proof=await verify(ref,input.current_password,meta,deadline);
    const definition=defineMutation({input:ReauthenticateSchema,output:ReauthenticatedSchema,mode:'shared',permission:null,recentAuth:false,auditAction:'auth.session.reauthenticated',
      resolveLocks:async()=>({userIds:[],roleIds:[]}),authorize:async(tx,context)=>{await checkProof(tx,context,proof);},
      execute:async(tx,context)=>{
        const policy=await policyAt(tx),now=await databaseNow(tx);await accountFailureState(tx,secrets.digestKey.key,proof.candidate.normalized_email,'success',failurePolicy(policy));
        await tx.query('UPDATE users SET locked_until=NULL WHERE id=$1',[context.actor.userId]);await tx.query('UPDATE sessions SET reauthenticated_at=$2 WHERE id=$1',[context.sessionId,now]);
        await appendSecurityEvent(tx,{userId:context.actor.userId,type:'auth.reauthenticate',result:'success',reasonCode:null,targetDigest:null,meta});
        return {data:{reauthenticated_at:now.toISOString(),valid_until:new Date(now.getTime()+300000).toISOString()},audit:{target:{type:'session',id:context.sessionId}}};
      },
    });
    const mutate=createMutationGateway(pool,secrets,{'auth.reauthenticate':definition});
    return withRejection(proof,meta,async()=>{const result=await mutate('auth.reauthenticate',ref,input,meta,undefined,deadline-performance.now());return {...result,data:ReauthenticatedSchema.parse(result.data)};});
  }
  async function changePassword(ref:Ref,raw:unknown,metadata:RequestMeta,key?:string,remaining=15000){
    const deadline=performance.now()+Math.min(15000,remaining),input=parse(ChangePasswordSchema,raw),meta=requestMetaSchema.parse(metadata);
    if(!z.uuid().safeParse(key).success)throw new AppError('VALIDATION_ERROR');
    const proof=await verify(ref,input.current_password,meta,deadline);budget(deadline);
    const hash=await passwords.hash(input.new_password,proof.policy.password_min_length);budget(deadline);
    const definition=defineMutation({input:ChangePasswordSchema,output:z.strictObject({changed:z.literal(true),login_required:z.literal(true)}),mode:'exclusive',permission:null,recentAuth:false,auditAction:'auth.password.changed',
      resolveLocks:async()=>({userIds:[],roleIds:[]}),authorize:async(tx,context,value)=>{
        const {policy}=await checkProof(tx,context,proof);
        if(context.actor.version!==value.expected_version)throw new AppError('VERSION_CONFLICT');
        if([...value.new_password].length<policy.password_min_length)throw new AppError('PASSWORD_REJECTED');
      },
      execute:async(tx,context,value)=>{
        await tx.query('SELECT id FROM sessions WHERE user_id=$1 ORDER BY id FOR UPDATE',[context.actor.userId]);
        await tx.query('SELECT id FROM one_time_credentials WHERE user_id=$1 ORDER BY id FOR UPDATE',[context.actor.userId]);
        const user=(await tx.query<{id:string;email:string;display_name:string;locale:'en'|'zh-CN'|null;version:number}>(`UPDATE users SET password_hash=$2,password_version=password_version+1,version=version+1,
          authorization_version=authorization_version+1,locked_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND version=$3 RETURNING id,email,display_name,locale,version`,[context.actor.userId,hash,value.expected_version])).rows[0];
        if(!user)throw new AppError('VERSION_CONFLICT');
        await tx.query("UPDATE sessions SET revoked_at=clock_timestamp(),revoked_reason='password_changed' WHERE user_id=$1 AND revoked_at IS NULL",[user.id]);
        const revoked=await tx.query<{id:string}>("UPDATE one_time_credentials SET revoked_at=clock_timestamp() WHERE user_id=$1 AND purpose IN ('password_reset','operator_recovery') AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id",[user.id]);
        await cancelCredentialTasks(tx,revoked.rows.map(row=>row.id),'USER_STATE_CHANGED');
        const policy=await policyAt(tx);await accountFailureState(tx,secrets.digestKey.key,proof.candidate.normalized_email,'success',failurePolicy(policy));
        const settings=await loadPublicSettings(tx);
        await enqueueMail(tx,secrets.mailKeyring,{eventId:randomUUID(),purpose:'password_changed',recipient:user.email,displayName:user.display_name,instanceName:settings.instance_name,locale:user.locale??settings.default_locale,timeZone:settings.timezone,occurredAt:context.now.toISOString()});
        return {data:{changed:true as const,login_required:true as const},audit:{target:{type:'user',id:user.id},changes:{before_version:value.expected_version,after_version:user.version,changed_fields:['password' as const]}}};
      },
      idempotency:{policySchema:z.strictObject({user_id:z.uuid()}),authorizeStored:async(tx,context,_input,stored)=>{if(stored.user_id!==context.actor.userId)throw new AppError('FORBIDDEN');await checkProof(tx,context,proof);},
        summarize:(_data,context)=>({outcome:'password_changed',resource_id:context.actor.userId,version:context.actor.version+1,completed_at:context.now.toISOString()}),policyContext:(_data,context)=>({user_id:context.actor.userId})},
    });
    const mutate=createMutationGateway(pool,secrets,{'me.password.change':definition});return withRejection(proof,meta,()=>mutate('me.password.change',ref,input,meta,key,deadline-performance.now()));
  }
  return {reauthenticate,changePassword};
}
