import { z } from 'zod';
import type { Tx } from '../../infrastructure/db.js';
import { requestMetaSchema, sanitizeAuditText } from './writer.js';
const eventSchema=z.strictObject({
  userId:z.uuid().nullable(),type:z.enum(['auth.login','auth.reauthenticate','auth.logout','auth.session_revoked','auth.credential_rejected','auth.mail_request']),
  result:z.enum(['success','denied','failed']),reasonCode:z.enum(['AUTH_FAILED','EMAIL_VERIFICATION_REQUIRED','SESSION_INVALID','RATE_LIMITED','INTERNAL_ERROR','CREDENTIAL_INVALID','REGISTRATION_ROLE_INVALID','ACCOUNT_EXISTS']).nullable(),
  targetDigest:z.instanceof(Buffer).refine(value=>value.length===32).nullable(),meta:requestMetaSchema,
});
export type SecurityEvent=z.input<typeof eventSchema>;
export async function appendSecurityEvent(tx:Tx,event:SecurityEvent):Promise<void> {
  const value=eventSchema.parse(event);
  await tx.query(`INSERT INTO security_events(user_id,event_type,result,reason_code,target_digest,request_id,ip,user_agent)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,[value.userId,value.type,value.result,value.reasonCode,value.targetDigest,
    value.meta.requestId,value.meta.ip,sanitizeAuditText(value.meta.userAgent)]);
}
