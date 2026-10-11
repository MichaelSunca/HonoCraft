import {z} from 'zod';
import {EmailSchema,VersionSchema,PaginationSchema,text} from './common.js';

export const defaultInvitationRoleId='00000000-0000-4000-8000-000000000003';
const RoleIdsSchema=z.array(z.uuid()).transform(ids=>[...new Set(ids)].sort()).pipe(z.array(z.uuid()).min(1).max(100));
const reason=text(1,500).refine(value=>value.trim().length>0);
export const InvitationCreateSchema=z.strictObject({
  email:EmailSchema,role_ids:RoleIdsSchema.default([defaultInvitationRoleId]),
  confirmation:z.strictObject({target_email:EmailSchema,typed_label:text(1,254).optional(),reason}).optional(),
});
export const InvitationActionSchema=z.strictObject({
  id:z.uuid(),expected_version:VersionSchema,confirmation:z.strictObject({target_id:z.uuid(),typed_label:text(1,254).optional(),reason}),
});
export const InvitationSentSchema=z.strictObject({id:z.uuid(),version:VersionSchema,status:z.literal('pending'),expires_at:z.iso.datetime(),mail_status:z.literal('queued')});
export const InvitationRevokedSchema=z.strictObject({id:z.uuid(),version:VersionSchema,status:z.literal('revoked')});
export const InvitationStatusSchema=z.enum(['pending','accepted','expired','revoked']);
export const InvitationQuerySchema=PaginationSchema.extend({
  query:z.string().transform(value=>value.trim()).pipe(text(0,100)).refine(value=>value.length===0||[...value].length>=2).default(''),
  status:InvitationStatusSchema.optional(),inviter_id:z.uuid().optional(),created_from:z.iso.datetime({offset:true}).optional(),created_to:z.iso.datetime({offset:true}).optional(),
  sort:z.enum(['created_at','email','expires_at']).default('created_at'),direction:z.enum(['asc','desc']).default('desc'),
}).refine(value=>!value.created_from||!value.created_to||Date.parse(value.created_from)<Date.parse(value.created_to));
const ActionSchema=z.enum(['resend','revoke','reinvite']);
export const InvitationDtoSchema=z.strictObject({
  id:z.uuid(),email:z.string(),status:InvitationStatusSchema,version:VersionSchema,created_at:z.iso.datetime(),expires_at:z.iso.datetime(),
  inviter:z.strictObject({id:z.uuid(),display_name:z.string()}),roles:z.array(z.strictObject({id:z.uuid(),code:z.string(),name:z.string(),version:VersionSchema})),
  mail:z.strictObject({status:z.enum(['queued','sending','sent','failed','cancelled']),attempts:z.number().int().nonnegative(),error_code:z.string().nullable(),updated_at:z.iso.datetime()}).nullable(),
  allowed_actions:z.array(ActionSchema),requires_reauth_actions:z.array(ActionSchema),
});
export const InvitationListSchema=z.strictObject({items:z.array(InvitationDtoSchema),page:z.number().int().positive(),page_size:z.number().int().positive(),total:z.number().int().nonnegative()});
