import {z} from 'zod';
import {LocaleSchema,ThemeSchema,VersionSchema,text} from './common.js';
const plain=(min:number,max:number)=>text(min,max).refine(value=>!/<\/?[a-z!][^>]*>/i.test(value));
export const BrandingValueSchema=z.strictObject({instance_name:plain(1,80).refine(value=>value.trim().length>0),copyright:plain(0,200),default_locale:LocaleSchema,default_theme:ThemeSchema,
  timezone:text(1,80).refine(value=>{try{if(/^[+-]/.test(value))return false;new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}}),logo_file_id:z.uuid().nullable(),favicon_file_id:z.uuid().nullable()});
export const BrandingEditableSchema=BrandingValueSchema.omit({logo_file_id:true,favicon_file_id:true});
export const SecurityFieldsSchema=z.strictObject({registration_open:z.boolean(),registration_default_role_id:z.uuid(),password_min_length:z.number().int().min(15).max(64),
  session_idle_minutes:z.number().int().min(5).max(30),session_absolute_minutes:z.number().int().min(30).max(480),email_verify_hours:z.number().int().min(1).max(48),password_reset_minutes:z.number().int().min(10).max(60),
  invite_hours:z.number().int().min(1).max(168),email_change_hours:z.number().int().min(1).max(48),login_ip_per_minute:z.number().int().min(1).max(20),account_failures_per_window:z.number().int().min(1).max(5),
  account_lock_minutes:z.number().int().min(15).max(60),mail_cooldown_seconds:z.number().int().min(60).max(3600),mail_target_per_hour:z.number().int().min(1).max(5),mail_ip_per_hour:z.number().int().min(1).max(20)});
export const SecurityValueSchema=SecurityFieldsSchema.refine(value=>value.session_absolute_minutes>=value.session_idle_minutes);
const meta={version:VersionSchema,allowed_actions:z.array(z.literal('update')),requires_reauth_actions:z.array(z.literal('update'))};
export const BrandingSettingsSchema=BrandingValueSchema.extend(meta);
export const SecuritySettingsSchema=SecurityValueSchema.safeExtend(meta);
export const SettingsSchema=z.strictObject({branding:BrandingSettingsSchema,security:SecuritySettingsSchema});
export const BrandingUpdateSchema=BrandingEditableSchema.extend({expected_version:VersionSchema});
export const SecurityUpdateSchema=SecurityValueSchema.safeExtend({expected_version:VersionSchema,confirmation:z.strictObject({target_id:z.literal('security'),typed_label:z.literal('security'),reason:text(1,500).refine(value=>value.trim().length>0)})});
export const BRANDING_SETTING_KEYS=BrandingEditableSchema.keyof().options;
export const SECURITY_SETTING_KEYS=SecurityFieldsSchema.keyof().options;
export type BrandingSettings=z.infer<typeof BrandingSettingsSchema>;
export type SecuritySettings=z.infer<typeof SecuritySettingsSchema>;
export type Settings=z.infer<typeof SettingsSchema>;
