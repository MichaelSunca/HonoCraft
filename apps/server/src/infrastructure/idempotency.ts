import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '@honocraft/contracts/errors';
import { databaseNow, type Tx } from './db.js';
import { keyedDigest, requestDigest } from './crypto.js';

export const operationSummarySchema=z.strictObject({
  outcome:z.string().regex(/^[a-z_]{1,40}$/),resource_id:z.uuid().nullable(),version:z.number().int().positive().nullable(),completed_at:z.iso.datetime(),
});
export type OperationSummary=z.infer<typeof operationSummarySchema>;
export type DigestKey=Readonly<{id:string;key:Buffer}>;
export type StoredResult=Readonly<{summary:OperationSummary;status:number;replayed:boolean}>;
type RecordRow={request_digest:Buffer;digest_key_id:string;policy_context:unknown;result_summary:unknown;http_status:number;expires_at:Date};
type IdempotentOptions<S extends z.ZodType>={
  actorId:string;operation:string;key:string;input:unknown;digestKey:DigestKey;policySchema:S;
  authorizeStored:(context:z.output<S>)=>Promise<void>;
  execute:()=>Promise<{summary:OperationSummary;status:number;target:{type:string;id:string|null};policyContext:z.input<S>}>;
};
/** Internal service: call only after current session, operation permission, and target authorization. */
export async function runIdempotent<S extends z.ZodType>(tx:Tx,options:IdempotentOptions<S>):Promise<StoredResult> {
  const key=z.uuid().safeParse(options.key);
  if (!key.success) throw new AppError('VALIDATION_ERROR',{idempotency_key:['Expected UUID']});
  const scope=JSON.stringify([options.actorId,options.operation,key.data.toLowerCase()]);
  const digest=keyedDigest(options.digestKey.key,'honocraft.idempotency.v1',scope);
  const body=requestDigest(options.digestKey.key,options.operation,options.input);
  // Stable operation/actor/key lock also covers the not-yet-inserted row; a collision only serializes unrelated requests.
  try { await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[scope]); }
  catch(error) {
    if (typeof error==='object' && error!==null && 'code' in error && error.code==='55P03') throw new AppError('REQUEST_IN_PROGRESS',{},2);
    throw error;
  }
  const now=await databaseNow(tx);
  const args=[options.actorId,options.operation,digest];
  const row=(await tx.query<RecordRow>(`SELECT request_digest,digest_key_id,policy_context,result_summary,http_status,expires_at
    FROM idempotency_records WHERE actor_id=$1 AND operation=$2 AND key_digest=$3 FOR UPDATE`,args)).rows[0];
  if(row && row.expires_at>now) {
    if(row.digest_key_id!==options.digestKey.id || row.request_digest.length!==body.length || !timingSafeEqual(row.request_digest,body)) throw new AppError('IDEMPOTENCY_CONFLICT');
    await options.authorizeStored(options.policySchema.parse(row.policy_context));
    return {summary:operationSummarySchema.parse(row.result_summary),status:row.http_status,replayed:true};
  }
  if(row) await tx.query('DELETE FROM idempotency_records WHERE actor_id=$1 AND operation=$2 AND key_digest=$3',args);
  const result=await options.execute();
  const summary=operationSummarySchema.parse(result.summary);
  const policyContext=options.policySchema.parse(result.policyContext);
  if(!Number.isInteger(result.status)||result.status<200||result.status>299) throw new Error('IDEMPOTENCY_RESULT_INVALID');
  const completedAt=await databaseNow(tx);
  await tx.query(`INSERT INTO idempotency_records(actor_id,operation,key_digest,request_digest,digest_key_id,target_type,target_id,
    policy_context,result_summary,http_status,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[
    ...args,body,options.digestKey.id,result.target.type,result.target.id,policyContext,summary,result.status,completedAt,
    new Date(completedAt.getTime()+86_400_000),
  ]);
  return {summary,status:result.status,replayed:false};
}
