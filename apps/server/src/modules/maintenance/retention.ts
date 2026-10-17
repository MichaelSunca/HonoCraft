import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import {withTransaction,type Tx} from '../../infrastructure/db.js';
import {appendAudit} from '../audit/writer.js';
export type RetentionTask='mail'|'task_links'|'credentials'|'sessions'|'idempotency'|'rate_limits'|'heartbeats'|'audit'|'security';
export type RetentionOptions={batchSize?:number;auditDays?:number;securityDays?:number};
const taskSchema=z.enum(['mail','task_links','credentials','sessions','idempotency','rate_limits','heartbeats','audit','security']);
const optionsSchema=z.strictObject({batchSize:z.number().int().min(1).max(1000).default(1000),auditDays:z.number().int().min(1).max(3650).default(180),securityDays:z.number().int().min(1).max(3650).default(90)});
const tables=['audit_events','security_events','sessions','one_time_credentials','idempotency_records','rate_limit_buckets','worker_heartbeats','email_tasks'].map(name=>'public.'+name);
async function maintenanceRole(tx:Tx){
  const valid=(await tx.query<{valid:boolean}>(`SELECT
    (SELECT bool_and(has_table_privilege(current_user,t,'SELECT') AND has_table_privilege(current_user,t,'DELETE')) FROM unnest($1::text[]) t)
    AND has_column_privilege(current_user,'public.email_tasks','credential_id','UPDATE')
    AND has_column_privilege(current_user,'public.invites','id','SELECT') AND has_column_privilege(current_user,'public.invites','status','SELECT')
    AND has_column_privilege(current_user,'public.email_change_requests','id','SELECT') AND has_column_privilege(current_user,'public.email_change_requests','status','SELECT')
    AND NOT has_any_column_privilege(current_user,'public.users','UPDATE')
    AND NOT has_any_column_privilege(current_user,'public.roles','UPDATE')
    AND NOT has_table_privilege(current_user,'public.role_permissions','INSERT') AS valid`,[tables])).rows[0]?.valid;
  if(!valid)throw new Error('MAINTENANCE_ROLE_INCOMPATIBLE');
}
export async function assertMaintenanceRole(pool:Pool):Promise<void>{await withTransaction(pool,'read',maintenanceRole);}
const cutoff=(days:string)=>`clock_timestamp()-(${days}::integer*interval '1 day')`;
function credentialReady(alias:string,days:string,taskCheck:'active'|'all'){
  return `COALESCE(${alias}.consumed_at,${alias}.revoked_at,${alias}.expires_at)<=${cutoff(days)}
    AND NOT EXISTS(SELECT 1 FROM public.invites i WHERE i.id=${alias}.invite_id AND i.status='pending')
    AND NOT EXISTS(SELECT 1 FROM public.email_change_requests e WHERE e.id=${alias}.email_change_request_id AND e.status='pending')
    AND NOT EXISTS(SELECT 1 FROM public.email_tasks t WHERE t.credential_id=${alias}.id ${taskCheck==='active'?"AND t.status IN('queued','sending')":''})`;
}
const definitions={
  sessions:{table:'sessions',order:'COALESCE(r.revoked_at,LEAST(r.idle_expires_at,r.absolute_expires_at)),r.id',days:7,predicate:(day:string)=>`COALESCE(r.revoked_at,LEAST(r.idle_expires_at,r.absolute_expires_at))<=${cutoff(day)}`},
  credentials:{table:'one_time_credentials',order:'COALESCE(r.consumed_at,r.revoked_at,r.expires_at),r.id',days:7,predicate:(day:string)=>credentialReady('r',day,'all')},
  task_links:{table:'email_tasks',order:'r.updated_at,r.id',days:7,predicate:(day:string)=>`r.status IN('sent','failed','cancelled') AND r.credential_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.one_time_credentials c WHERE c.id=r.credential_id AND ${credentialReady('c',day,'active')})`},
  mail:{table:'email_tasks',order:'r.updated_at,r.id',days:90,predicate:(day:string)=>`r.status IN('sent','failed','cancelled') AND r.updated_at<=${cutoff(day)}`},
  idempotency:{table:'idempotency_records',order:'r.expires_at,r.id',days:0,predicate:(day:string)=>`r.expires_at<=${cutoff(day)}`},
  heartbeats:{table:'worker_heartbeats',order:'r.last_seen_at,r.worker_id',days:1,predicate:(day:string)=>`r.last_seen_at<=${cutoff(day)}`},
  audit:{table:'audit_events',order:'r.created_at,r.id',days:180,predicate:(day:string)=>`r.created_at<=${cutoff(day)}`},
  security:{table:'security_events',order:'r.created_at,r.id',days:90,predicate:(day:string)=>`r.created_at<=${cutoff(day)}`},
  rate_limits:{table:'rate_limit_buckets',order:'r.expires_at,r.scope,r.key_digest,r.window_start',days:0,predicate:(day:string)=>`r.expires_at<=${cutoff(day)} AND (r.locked_until IS NULL OR r.locked_until<=clock_timestamp())
    AND (r.window_start<>'1970-01-01 00:00:00+00'::timestamptz OR NOT EXISTS(SELECT 1 FROM public.rate_limit_buckets c WHERE c.scope=r.scope AND c.key_digest=r.key_digest AND c.window_start<>'1970-01-01 00:00:00+00'::timestamptz AND c.expires_at>clock_timestamp()))`},
} as const;
/** Fixed task registry only. Every selection, recheck, change and audit is one bounded transaction. */
export async function pruneBatch(pool:Pool,task:RetentionTask,options:RetentionOptions={}):Promise<number>{
  const kind=taskSchema.safeParse(task),settings=optionsSchema.safeParse(options);if(!kind.success)throw new Error('RETENTION_TASK_INVALID');if(!settings.success)throw new Error('RETENTION_OPTIONS_INVALID');
  const definition=definitions[kind.data],days=kind.data==='audit'?settings.data.auditDays:kind.data==='security'?settings.data.securityDays:definition.days;
  return withTransaction(pool,'independent',async tx=>{
    await maintenanceRole(tx);
    const primary=kind.data==='heartbeats'?'worker_id':'id',rate=kind.data==='rate_limits';
    const selected=(await tx.query<{id:string;scope:string;key_digest:Buffer;window_start:string}>(`SELECT candidate_id AS id,scope_key AS scope,digest_key AS key_digest,bucket_start AS window_start
      FROM public.lock_retention_candidates($1,$2,$3)`,[kind.data,days,settings.data.batchSize])).rows;
    if(!selected.length)return 0;
    const meta={requestId:randomUUID(),ip:'127.0.0.1',userAgent:'HonoCraft retention'},audit=(action:'started'|'completed',count:number)=>appendAudit(tx,{actor:{type:'worker'},action:'maintenance.'+kind.data+'.'+action,target:{type:'retention'},result:'success',meta,changes:{affected_count:count}});
    await audit('started',selected.length);
    let count:number;
    if(rate){
      count=(await tx.query(`DELETE FROM public.rate_limit_buckets r USING unnest($1::text[],$2::bytea[],$3::timestamptz[]) k(scope,digest,start)
        WHERE r.scope=k.scope AND r.key_digest=k.digest AND r.window_start=k.start AND ${definition.predicate('$4')}`,[selected.map(row=>row.scope),selected.map(row=>row.key_digest),selected.map(row=>row.window_start),days])).rowCount??0;
    }else{
      const verb=kind.data==='task_links'?'UPDATE public.email_tasks r SET credential_id=NULL':'DELETE FROM public.'+definition.table+' r';
      count=(await tx.query(`${verb} WHERE r.${primary}=ANY($1::uuid[]) AND ${definition.predicate('$2')}`,[selected.map(row=>row.id),days])).rowCount??0;
    }
    await audit('completed',count);return count;
  });
}
