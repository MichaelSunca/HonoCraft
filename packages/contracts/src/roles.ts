import {z} from 'zod';
import {PaginationSchema,VersionSchema,text} from './common.js';
import {PERMISSION_CODES} from './permissions.js';
export const RoleQuerySchema=PaginationSchema.extend({
  query:z.string().transform(value=>value.trim()).pipe(text(0,100)).refine(value=>value.length===0||[...value].length>=2).default(''),
  code:z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/).optional(),
  is_builtin:z.enum(['true','false']).transform(value=>value==='true').optional(),
});
const RoleActionSchema=z.enum(['invite','copy','update','delete','eligibility']);
export const RoleDtoSchema=z.strictObject({
  id:z.uuid(),code:z.string(),name:z.string(),description:z.string(),version:VersionSchema,
  is_builtin:z.boolean(),is_delegable:z.boolean(),is_registration_default_eligible:z.boolean(),
  permission_codes:z.array(z.enum(PERMISSION_CODES)),
  reference_counts:z.strictObject({users:z.number().int().nonnegative(),pending_registrations:z.number().int().nonnegative(),registration_defaults:z.number().int().nonnegative(),pending_invites:z.number().int().nonnegative()}),
  allowed_actions:z.array(RoleActionSchema),requires_reauth_actions:z.array(RoleActionSchema),
});
export type RoleDto=z.infer<typeof RoleDtoSchema>;
export const RoleListSchema=z.strictObject({items:z.array(RoleDtoSchema),page:z.number().int().positive(),page_size:z.number().int().positive(),total:z.number().int().nonnegative()});
