import type {Pool} from 'pg';
import {z} from 'zod';
import {AppError} from '@honocraft/contracts/errors';
import {AuditChangesSchema,AuditSnapshotSchema,AuditDtoSchema,AuditListSchema,AuditQuerySchema,SecurityEventDtoSchema,SecurityEventListSchema,SecurityQuerySchema,EmailTaskDtoSchema,EmailTaskListSchema,EmailTaskQuerySchema,LogReasonCodeSchema,MailPurposeSchema,MailErrorSchema,MaskedRecipientSchema} from '@honocraft/contracts/logs';
import {withTransaction} from '../../infrastructure/db.js';
import {authenticateRead} from '../auth/sessions.js';
import {sanitizeAuditText} from './writer.js';
type Row={id:string;created_at:Date;[key:string]:unknown};
const timestamp=(value:unknown)=>value instanceof Date?value.toISOString():new Date(String(value)).toISOString();
function safeChanges(raw:unknown){
  const value=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:{};
  return Object.fromEntries(Object.entries(AuditChangesSchema.shape).flatMap(([key,schema])=>{const parsed=schema.safeParse(value[key]);return parsed.success&&parsed.data!==undefined?[[key,parsed.data]]:[];}));
}
function safeSnapshot(raw:unknown){
  const value=AuditSnapshotSchema.shape.display_name.safeParse(raw&&typeof raw==='object'&&'display_name' in raw?raw.display_name:undefined);
  return value.success&&value.data?{display_name:Array.from(sanitizeAuditText(value.data)).slice(0,80).join('')}:{};
}
function event(row:Row){const reason=LogReasonCodeSchema.safeParse(row.reason_code);return {id:row.id,created_at:timestamp(row.created_at),request_id:row.request_id,ip:row.ip,user_agent:row.user_agent===null?null:sanitizeAuditText(String(row.user_agent)),result:row.result,reason_code:reason.success?reason.data:null};}
function projectAudit(row:Row){return {...event(row),actor_type:row.actor_type,actor_id:row.actor_id,actor_snapshot:safeSnapshot(row.actor_snapshot),action:sanitizeAuditText(String(row.action)),target_type:sanitizeAuditText(String(row.target_type)),target_id:row.target_id,reason:row.reason===null?null:sanitizeAuditText(String(row.reason)),changes:safeChanges(row.changes)};}
function projectSecurity(row:Row){return {...event(row),user_id:row.user_id,event_type:sanitizeAuditText(String(row.event_type))};}
function projectMail(row:Row){const purpose=MailPurposeSchema.safeParse(row.purpose),error=MailErrorSchema.safeParse(row.error_code),recipient=MaskedRecipientSchema.safeParse(row.recipient_masked);return {
  id:row.id,purpose:purpose.success?purpose.data:'unknown',status:row.status,recipient_masked:recipient.success?recipient.data:'[redacted]',attempts:row.attempts,error_code:row.error_code===null?null:error.success?error.data:'UNKNOWN_ERROR',locale:row.locale,template_version:row.template_version,
  created_at:timestamp(row.created_at),updated_at:timestamp(row.updated_at),next_attempt_at:row.status==='queued'?timestamp(row.next_attempt_at):null,
};}
const events='id,created_at,request_id,host(ip) AS ip,user_agent,result,reason_code';
const groups={
  audit:{table:'audit_events',permission:'audit:read',query:AuditQuerySchema,dto:AuditDtoSchema,listSchema:AuditListSchema,projection:events+',actor_type,actor_id,actor_snapshot,action,target_type,target_id,reason,changes',project:projectAudit,filters:[['actor_id','uuid'],['action','text'],['target_type','text'],['target_id','uuid'],['result','text']]},
  security:{table:'security_events',permission:'security-log:read',query:SecurityQuerySchema,dto:SecurityEventDtoSchema,listSchema:SecurityEventListSchema,projection:events+',user_id,event_type',project:projectSecurity,filters:[['user_id','uuid'],['event_type','text'],['result','text']]},
  mail:{table:'email_tasks',permission:'email-task:read',query:EmailTaskQuerySchema,dto:EmailTaskDtoSchema,listSchema:EmailTaskListSchema,projection:'id,purpose,status,recipient_masked,attempts,error_code,locale,template_version,created_at,updated_at,next_attempt_at',project:projectMail,filters:[['purpose','text'],['status','text']]},
} as const;
/** Current permission is checked before existence; lists and totals share one read-only snapshot. */
export function createLogQueries(pool:Pool,epoch:string){
  function resource(kind:keyof typeof groups){const group=groups[kind];
    async function authenticate(ref:{token:string}){const context=await authenticateRead(pool,{token:ref.token,epoch});if(!context.permissions.has(group.permission))throw new AppError('FORBIDDEN');}
    async function list(ref:{token:string},raw:unknown){
      await authenticate(ref);const parsed=group.query.safeParse(raw);if(!parsed.success)throw new AppError('VALIDATION_ERROR');const input=parsed.data;
      return withTransaction(pool,'read',async tx=>{
        const values:unknown[]=[],clauses:string[]=[];const filters=input as Record<string,unknown>;
        for(const [column,type] of group.filters){values.push(filters[column]??null);clauses.push(`($${values.length}::${type} IS NULL OR ${column}=$${values.length})`);}
        values.push(input.from??null);clauses.push(`($${values.length}::timestamptz IS NULL OR created_at>=$${values.length})`);values.push(input.to??null);clauses.push(`($${values.length}::timestamptz IS NULL OR created_at<$${values.length})`);const where=clauses.join(' AND ');
        // Table/column/type names above are private constants; direction is a strict enum.
        const total=(await tx.query<{total:number}>(`SELECT count(*)::int AS total FROM ${group.table} WHERE ${where}`,values)).rows[0]!.total;
        const rows=(await tx.query<Row>(`SELECT ${group.projection} FROM ${group.table} WHERE ${where} ORDER BY created_at ${input.direction},id ${input.direction} LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,input.page_size,(input.page-1)*input.page_size])).rows;
        return group.listSchema.parse({items:rows.map(row=>group.project(row)),page:input.page,page_size:input.page_size,total});
      });
    }
    async function get(ref:{token:string},raw:unknown){
      await authenticate(ref);const id=z.uuid().safeParse(raw);if(!id.success)throw new AppError('VALIDATION_ERROR');
      return withTransaction(pool,'read',async tx=>{const row=(await tx.query<Row>(`SELECT ${group.projection} FROM ${group.table} WHERE id=$1`,[id.data])).rows[0];if(!row)throw new AppError('NOT_FOUND');return group.dto.parse(group.project(row));});
    }
    return {list,get};
  }
  return {audit:resource('audit'),security:resource('security'),mail:resource('mail')};
}
