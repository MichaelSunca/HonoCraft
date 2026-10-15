import {z} from 'zod';
import {PaginationSchema,LocaleSchema,text} from './common.js';
import {errorStatus} from './errors.js';
import {PERMISSION_CODES} from './permissions.js';
import {BRANDING_SETTING_KEYS,SECURITY_SETTING_KEYS,SecurityFieldsSchema} from './settings.js';
export const LogResultSchema=z.enum(['success','denied','failed']);
export const LogReasonCodeSchema=z.enum(Object.keys(errorStatus) as [keyof typeof errorStatus,...(keyof typeof errorStatus)[]]);
export const MaskedRecipientSchema=z.string().max(254).regex(/^[^@\s]?\*{3}@[^@\s]+$/u);
export const AuditSnapshotSchema=z.strictObject({display_name:text(1,80).optional()});
export const AuditChangesSchema=z.strictObject({
  setting_keys:z.array(z.enum([...BRANDING_SETTING_KEYS,...SECURITY_SETTING_KEYS])).optional(),settings_before:SecurityFieldsSchema.partial().optional(),settings_after:SecurityFieldsSchema.partial().optional(),
  before_version:z.number().int().positive().optional(),after_version:z.number().int().positive().optional(),affected_count:z.number().int().nonnegative().optional(),
  is_delegable_before:z.boolean().optional(),is_delegable_after:z.boolean().optional(),is_registration_default_eligible_before:z.boolean().optional(),is_registration_default_eligible_after:z.boolean().optional(),
  status_before:z.enum(['pending','active','suspended','deleted','accepted','revoked','expired']).optional(),status_after:z.enum(['pending','active','suspended','deleted','accepted','revoked','expired']).optional(),
  role_ids_before:z.array(z.uuid()).max(100).optional(),role_ids_after:z.array(z.uuid()).max(100).optional(),permissions_added:z.array(z.enum(PERMISSION_CODES)).optional(),permissions_removed:z.array(z.enum(PERMISSION_CODES)).optional(),
  email_before_masked:MaskedRecipientSchema.optional(),email_after_masked:MaskedRecipientSchema.optional(),
  changed_fields:z.array(z.enum(['display_name','locale','theme','avatar','password','email','roles','status','branding','security','title','body'])).optional(),
});
const queryBase=PaginationSchema.extend({from:z.iso.datetime({offset:true}).optional(),to:z.iso.datetime({offset:true}).optional(),sort:z.literal('created_at').default('created_at'),direction:z.enum(['asc','desc']).default('desc')});
const validRange=(value:{from?:string|undefined;to?:string|undefined})=>!value.from||!value.to||Date.parse(value.from)<Date.parse(value.to);
export const AuditQuerySchema=queryBase.extend({actor_id:z.uuid().optional(),action:z.string().max(120).regex(/^[a-z_]+\.[a-z_]+\.[a-z_]+$/).optional(),target_type:z.string().max(60).regex(/^[a-z_]+$/).optional(),target_id:z.uuid().optional(),result:LogResultSchema.optional()}).refine(validRange);
export const SecurityQuerySchema=queryBase.extend({user_id:z.uuid().optional(),event_type:z.string().max(120).regex(/^[a-z_]+(?:\.[a-z_]+){1,3}$/).optional(),result:LogResultSchema.optional()}).refine(validRange);
export const MailPurposeSchema=z.enum(['email_verify','password_reset','invite_accept','email_change','bootstrap','operator_recovery','password_changed','email_change_started','email_changed','account_suspended']);
export const MailStatusSchema=z.enum(['queued','sending','sent','failed','cancelled']);
export const MailErrorSchema=z.enum(['SMTP_TEMPORARY','SMTP_TIMEOUT','SMTP_CONNECTION','SMTP_REJECTED','PAYLOAD_INVALID','CREDENTIAL_INVALID','CREDENTIAL_REPLACED','CREDENTIAL_CONSUMED','USER_STATE_CHANGED','RETRY_EXHAUSTED','DELIVERY_UNKNOWN','LEASE_EXPIRED','UNKNOWN_ERROR']);
export const EmailTaskQuerySchema=queryBase.extend({purpose:MailPurposeSchema.optional(),status:MailStatusSchema.optional()}).refine(validRange);
const eventBase={id:z.uuid(),created_at:z.iso.datetime(),request_id:z.uuid(),ip:z.union([z.ipv4(),z.ipv6()]).nullable(),user_agent:z.string().max(500).nullable(),result:LogResultSchema,reason_code:LogReasonCodeSchema.nullable()};
export const AuditDtoSchema=z.strictObject({...eventBase,actor_type:z.enum(['user','operator','worker','anonymous']),actor_id:z.uuid().nullable(),actor_snapshot:AuditSnapshotSchema,action:z.string(),target_type:z.string(),target_id:z.uuid().nullable(),reason:z.string().max(500).nullable(),changes:AuditChangesSchema});
export const SecurityEventDtoSchema=z.strictObject({...eventBase,user_id:z.uuid().nullable(),event_type:z.string()});
export const EmailTaskDtoSchema=z.strictObject({id:z.uuid(),purpose:z.enum([...MailPurposeSchema.options,'unknown']),status:MailStatusSchema,recipient_masked:z.string().max(254),attempts:z.number().int().min(0).max(3),error_code:MailErrorSchema.nullable(),locale:LocaleSchema,template_version:z.number().int().positive(),created_at:z.iso.datetime(),updated_at:z.iso.datetime(),next_attempt_at:z.iso.datetime().nullable()});
const page={page:z.number().int().positive(),page_size:z.number().int().positive(),total:z.number().int().nonnegative()};
export const AuditListSchema=z.strictObject({...page,items:z.array(AuditDtoSchema)});
export const SecurityEventListSchema=z.strictObject({...page,items:z.array(SecurityEventDtoSchema)});
export const EmailTaskListSchema=z.strictObject({...page,items:z.array(EmailTaskDtoSchema)});
export type AuditDto=z.infer<typeof AuditDtoSchema>;
export type SecurityEventDto=z.infer<typeof SecurityEventDtoSchema>;
export type EmailTaskDto=z.infer<typeof EmailTaskDtoSchema>;
