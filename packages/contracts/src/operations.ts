import {z} from 'zod';
export const OPERATION_NAMES=[
  'auth.session.revoke','auth.sessions.revoke_others','me.password.change',
  'me.avatar.update','me.avatar.delete','settings.branding.logo.update','settings.branding.logo.delete','settings.branding.favicon.update','settings.branding.favicon.delete',
  'settings.branding','settings.security','invitations.create','invitations.resend','invitations.revoke',
  'roles.create','roles.update','roles.copy','roles.delete','roles.eligibility',
  'users.profile','users.status','users.delete','users.roles','users.reset',
  'email-change.self-start','email-change.self-cancel','email-change.admin-start','email-change.admin-cancel',
  'example.notes.create','example.notes.update','example.notes.delete',
] as const;
export const OperationNameSchema=z.enum(OPERATION_NAMES);
export type OperationName=z.infer<typeof OperationNameSchema>;
export const OperationSummarySchema=z.strictObject({outcome:z.string().regex(/^[a-z_]{1,40}$/),resource_id:z.uuid().nullable(),version:z.number().int().positive().nullable(),completed_at:z.iso.datetime()});
export type OperationSummary=z.infer<typeof OperationSummarySchema>;
