import type {Pool} from 'pg';
import {z} from 'zod';
import {AppError} from '@honocraft/contracts/errors';
import {OperationNameSchema,OperationSummarySchema} from '@honocraft/contracts/operations';
import {withTransaction,databaseNow} from '../../infrastructure/db.js';
import {operationKeyDigest,type DigestKey} from '../../infrastructure/idempotency.js';
import {locateSession,authenticateLockedSession} from '../auth/sessions.js';
import {lockIdentityRows} from '../access/repository.js';
import {operationPolicies} from './policies.js';
const querySchema=z.strictObject({});
type Row={digest_key_id:string;policy_context:unknown;result_summary:unknown;target_type:string;target_id:string|null;http_status:number;expires_at:Date};
const hidden=new Set(['FORBIDDEN','TARGET_NOT_MANAGEABLE','NOT_FOUND','VALIDATION_ERROR','PERMISSION_DEPENDENCY_MISSING','SELF_MANAGEMENT_FORBIDDEN']);
const notFound=()=>new AppError('OPERATION_NOT_FOUND');
const sameId=(left:string|null,right:string|null)=>left?.toLowerCase()===right?.toLowerCase();
export function createOperationQueries(pool:Pool,secrets:{epoch:string;digestKey:DigestKey},exampleNotesEnabled:boolean){
  return async(ref:{token:string},rawOperation:unknown,rawKey:unknown,rawQuery:unknown={})=>{
    try{return await withTransaction(pool,'shared',async tx=>{
    const locator=await locateSession(tx,ref.token);await lockIdentityRows(tx,[locator.userId]);const context=await authenticateLockedSession(tx,locator,secrets.epoch);
    if(!querySchema.safeParse(rawQuery).success)throw new AppError('VALIDATION_ERROR');
    const operation=OperationNameSchema.safeParse(rawOperation),key=z.uuid().safeParse(rawKey);
    if(!operation.success||!key.success||(!exampleNotesEnabled&&operation.data.startsWith('example.notes.')))throw notFound();
    const definition=operationPolicies[operation.data];
    if(definition.permissions.some(permission=>!context.permissions.has(permission)))throw notFound();
    const row=(await tx.query<Row>(`SELECT digest_key_id,policy_context,result_summary,target_type,target_id,http_status,expires_at FROM idempotency_records
      WHERE actor_id=$1 AND operation=$2 AND key_digest=$3`,[context.actor.userId,operation.data,operationKeyDigest(secrets.digestKey.key,context.actor.userId,operation.data,key.data)])).rows[0];
    if(!row||row.digest_key_id!==secrets.digestKey.id||row.expires_at<=await databaseNow(tx)||row.http_status<200||row.http_status>=300)throw notFound();
    try{
      const summary=OperationSummarySchema.parse(row.result_summary),binding=await definition.authorize(tx,context,row.policy_context);
      if(row.target_type!==definition.targetType||!sameId(row.target_id,binding.targetId)||!sameId(summary.resource_id,binding.resourceId)||summary.outcome!==definition.outcome)throw notFound();
      if(row.expires_at<=await databaseNow(tx))throw notFound();return summary;
    }catch(error){if(error instanceof z.ZodError||(error instanceof AppError&&hidden.has(error.code)))throw notFound();throw error;}
    });}catch(error){
      const code=typeof error==='object'&&error!==null&&'code' in error?error.code:undefined;
      if(['55P03','57014','25P04'].includes(String(code)))throw new AppError('BUSY_RETRY',{},2);throw error;
    }
  };
}
