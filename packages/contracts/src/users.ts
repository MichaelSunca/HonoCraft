import {z} from 'zod';
import {DisplayNameSchema,PaginationSchema,UserStatusSchema,VersionSchema,text} from './common.js';

export const UserQuerySchema=PaginationSchema.extend({
  query:z.string().transform(value=>value.trim()).pipe(text(0,100)).refine(value=>value.length===0||[...value].length>=2).default(''),
  status:UserStatusSchema.optional(),role_id:z.uuid().optional(),created_from:z.iso.datetime({offset:true}).optional(),created_to:z.iso.datetime({offset:true}).optional(),
  sort:z.enum(['created_at','display_name','email']).default('created_at'),direction:z.enum(['asc','desc']).default('desc'),
}).refine(value=>!value.created_from||!value.created_to||Date.parse(value.created_from)<Date.parse(value.created_to));
export const UserActionSchema=z.enum(['update','suspend','enable','delete','reset-password','change-email','assign-roles','cancel-email-change']);
export type UserAction=z.infer<typeof UserActionSchema>;
export const UserListItemSchema=z.strictObject({
  id:z.uuid(),display_name:z.string(),email:z.string().nullable(),masked_email:z.string().nullable(),email_visibility:z.enum(['full','masked']),avatar_url:z.string().nullable(),
  roles:z.array(z.strictObject({id:z.uuid(),code:z.string(),name:z.string()})),status:UserStatusSchema,created_at:z.iso.datetime(),last_login_at:z.iso.datetime().nullable(),version:VersionSchema,
  allowed_actions:z.array(UserActionSchema),requires_reauth_actions:z.array(UserActionSchema),
});
export const UserDetailSchema=UserListItemSchema.extend({
  verified:z.boolean(),updated_at:z.iso.datetime(),can_read_audit:z.boolean(),
  pending_email_change:z.strictObject({id:z.uuid(),version:VersionSchema,new_email:z.string(),expires_at:z.iso.datetime()}).nullable(),
});
export const UserListSchema=z.strictObject({items:z.array(UserListItemSchema),page:z.number().int().positive(),page_size:z.number().int().positive(),total:z.number().int().nonnegative()});
export type UserListItem=z.infer<typeof UserListItemSchema>;
export type UserDetail=z.infer<typeof UserDetailSchema>;
const confirmation=z.strictObject({target_id:z.uuid(),typed_label:text(1,254).optional(),reason:text(1,500).refine(value=>value.trim().length>0)});
const mutation={id:z.uuid(),expected_version:VersionSchema};
export const UserProfileUpdateSchema=z.strictObject({...mutation,display_name:DisplayNameSchema,confirmation:confirmation.optional()});
export const UserStatusUpdateSchema=z.strictObject({...mutation,action:z.enum(['suspend','enable']),confirmation});
export const UserDeleteSchema=z.strictObject({...mutation,confirmation});
export const UserPasswordResetSchema=z.strictObject({...mutation,confirmation});
export const UserPasswordResetResultSchema=z.strictObject({accepted:z.literal(true)});
export const UserRolesUpdateSchema=z.strictObject({...mutation,role_ids:z.array(z.uuid()).max(200).transform(ids=>[...new Set(ids)].sort()).pipe(z.array(z.uuid()).max(100)),confirmation});
export const UserProfileResultSchema=z.strictObject({id:z.uuid(),display_name:DisplayNameSchema,version:VersionSchema});
export const UserStatusResultSchema=z.strictObject({id:z.uuid(),status:UserStatusSchema,version:VersionSchema});
export const UserRolesResultSchema=z.strictObject({id:z.uuid(),role_ids:z.array(z.uuid()),version:VersionSchema,login_required:z.literal(true)});
