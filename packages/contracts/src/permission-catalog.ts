import {z} from 'zod';
import {PERMISSION_CODES} from './permissions.js';

export const PermissionModuleSchema=z.enum(['user','invite','role','permission','audit','security-log','email-task','settings','example-note']);
export const PermissionQuerySchema=z.strictObject({module:PermissionModuleSchema.optional()});
export const PermissionDtoSchema=z.strictObject({
  code:z.enum(PERMISSION_CODES),module:PermissionModuleSchema,name_key:z.string(),description_key:z.string(),
  is_reserved:z.boolean(),is_delegable:z.boolean(),is_self_assignable:z.boolean(),
  catalog_version:z.number().int().positive(),dependencies:z.array(z.enum(PERMISSION_CODES)),
});
export const PermissionCatalogSchema=z.strictObject({
  catalog_version:z.number().int().positive(),
  modules:z.array(z.strictObject({module:PermissionModuleSchema,permissions:z.array(PermissionDtoSchema)})),
});
export type PermissionDto=z.infer<typeof PermissionDtoSchema>;
export type PermissionCatalog=z.infer<typeof PermissionCatalogSchema>;
