import { z } from 'zod';
import { errorStatus } from '@honocraft/contracts/errors';
import {AuditChangesSchema,AuditSnapshotSchema} from '@honocraft/contracts/logs';
import type { Tx } from '../../infrastructure/db.js';

/** Free text is never copied verbatim to audit or access logs. */
export function sanitizeAuditText(text: string): string {
  return Array.from(text
    .replace(/(?:password|passwd|token|cookie|authorization|csrf|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,'[redacted]')
    .replace(/[^\s<>@]+@[^\s<>@]+/g,'[email]')
    .replace(/[A-Za-z0-9_+/=-]{32,}/g,'[redacted]')
    .replace(/[\p{Cc}\p{Cf}]/gu,' ')).slice(0,500).join('');
}
export const requestMetaSchema=z.strictObject({requestId:z.uuid(),ip:z.union([z.ipv4(),z.ipv6()]),userAgent:z.string().max(512)});
export type RequestMeta=z.infer<typeof requestMetaSchema>;
const eventSchema=z.strictObject({
  actor:z.strictObject({type:z.enum(['user','operator','worker','anonymous']),id:z.uuid().optional()}),
  action:z.string().regex(/^[a-z_]+\.[a-z_]+\.[a-z_]+$/),
  target:z.strictObject({type:z.string().regex(/^[a-z_]+$/),id:z.uuid().optional()}),
  result:z.enum(['success','denied','failed']), reasonCode:z.enum(Object.keys(errorStatus) as [keyof typeof errorStatus,...(keyof typeof errorStatus)[]]).optional(),
  reason:z.string().max(2000).optional(), meta:requestMetaSchema, changes:AuditChangesSchema.default({}),
});
export type AuditEvent=z.input<typeof eventSchema>;
/** Accept unknown at this trust boundary so accidentally leaked extra fields abort the transaction. */
export async function appendAudit(tx: Tx, event: unknown): Promise<string> {
  const value=eventSchema.parse(event);
  let snapshot:z.infer<typeof AuditSnapshotSchema>={};
  if(value.actor.type==='user'&&value.actor.id){const user=(await tx.query<{display_name:string}>('SELECT display_name FROM users WHERE id=$1',[value.actor.id])).rows[0];if(user)snapshot=AuditSnapshotSchema.parse({display_name:Array.from(sanitizeAuditText(user.display_name)).slice(0,80).join('')});}
  const result=await tx.query<{id:string}>(`INSERT INTO audit_events(actor_type,actor_id,actor_snapshot,action,target_type,target_id,result,
    reason_code,reason,changes,request_id,ip,user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,[
    value.actor.type,value.actor.id??null,snapshot,value.action,value.target.type,value.target.id??null,value.result,
    value.reasonCode??null,value.reason===undefined?null:sanitizeAuditText(value.reason),value.changes,
    value.meta.requestId,value.meta.ip,sanitizeAuditText(value.meta.userAgent),
  ]);
  return result.rows[0]!.id;
}
