import {z} from 'zod';
import {DisplayNameSchema,LocaleSchema,ThemeSchema,UserStatusSchema,VersionSchema} from './common.js';
export const PublicSettingsSchema=z.object({
  instance_name:z.string(),copyright:z.string(),default_locale:LocaleSchema,default_theme:ThemeSchema,timezone:z.string(),
  logo_url:z.string().nullable(),favicon_url:z.string().nullable(),registration_open:z.boolean(),password_min_length:z.number().int().min(15).max(64),initialized:z.boolean(),
});
export const SelfProfileSchema=z.strictObject({id:z.uuid(),display_name:DisplayNameSchema,locale:LocaleSchema.nullable(),theme:ThemeSchema.nullable(),version:VersionSchema});
export const MeSchema=z.object({
  user:SelfProfileSchema.extend({email:z.string(),status:UserStatusSchema,email_verified_at:z.string().nullable(),avatar_url:z.string().nullable()}),
  roles:z.array(z.object({id:z.uuid(),code:z.string(),name:z.string()})),instance:PublicSettingsSchema,permission_codes:z.array(z.string()),csrf_token:z.string(),
  session:z.object({id:z.uuid(),reauthenticated_at:z.string().nullable(),absolute_expires_at:z.string()}),
  pending_email_change:z.object({id:z.uuid(),version:VersionSchema,new_email:z.string(),expires_at:z.string()}).nullable(),
});
export type PublicSettings=z.infer<typeof PublicSettingsSchema>;
export type Me=z.infer<typeof MeSchema>;
export const DeviceSchema=z.object({category:z.enum(['desktop','mobile','tablet','unknown']),browser:z.enum(['Chrome','Firefox','Safari','Edge','unknown']),os:z.enum(['Windows','macOS','Linux','Android','iOS','unknown'])});
export const SessionListSchema=z.object({items:z.array(z.object({id:z.uuid(),is_current:z.boolean(),device:DeviceSchema,ip:z.string(),created_at:z.string(),last_seen_at:z.string(),absolute_expires_at:z.string()})),page:z.number().int().positive(),page_size:z.number().int().positive(),total:z.number().int().nonnegative()});
export const ReauthenticatedSchema=z.object({reauthenticated_at:z.iso.datetime(),valid_until:z.iso.datetime()});
export const InvitationPreviewSchema=z.strictObject({instance_name:z.string(),email:z.string(),expires_at:z.iso.datetime()});
