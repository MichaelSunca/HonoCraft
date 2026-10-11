import { z } from 'zod';

export const IdSchema = z.uuid();
export const VersionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const LocaleSchema = z.enum(['zh-CN', 'en']);
export const ThemeSchema = z.enum(['light', 'dark', 'system']);
export const UserStatusSchema = z.enum(['pending', 'active', 'suspended', 'deleted']);
export const text = (min: number, max: number) => z.string().refine(value => {
  const length = [...value].length;
  return !value.includes('\0') && length >= min && length <= max;
}, { message: 'VALIDATION_ERROR' });
export const DisplayNameSchema = text(1, 80).refine(value => value.trim().length > 0);
export const PasswordSchema = text(15, 128);
export const TokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const EmailSchema = z.string().transform((input, ctx) => {
  const value = input.trim();
  const at = value.lastIndexOf('@');
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  let asciiDomain = '';
  try {
    if (!/^[\p{L}\p{N}.-]+$/u.test(domain)) throw new Error();
    asciiDomain = new URL(`http://${domain}`).hostname;
  } catch { /* handled by the common invalid-input branch */ }
  const labels = asciiDomain.split('.');
  if (at < 1 || local.length > 64 || !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..') || labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) || local.length + asciiDomain.length + 1 > 254) {
    ctx.addIssue({ code: 'custom', message: 'INVALID_EMAIL' });
    return z.NEVER;
  }
  return `${local}@${asciiDomain}`;
});
export function normalizeEmail(value: string): string { return EmailSchema.parse(value).toLowerCase(); }

const queryInteger = (fallback: number, maximum: number) => z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().min(1).max(maximum)).default(fallback);
export const PaginationSchema = z.strictObject({ page: queryInteger(1, 1_000_000), page_size: queryInteger(20, 100) });
export const ProfileUpdateSchema = z.strictObject({
  expected_version: VersionSchema, display_name: DisplayNameSchema.optional(), locale: LocaleSchema.optional(), theme: ThemeSchema.optional(),
}).refine(value => value.display_name !== undefined || value.locale !== undefined || value.theme !== undefined, { message: 'EMPTY_UPDATE' });
export const LoginSchema = z.strictObject({ email: EmailSchema, password: text(1, 128) });
export const RegisterSchema = z.strictObject({ email: EmailSchema, password: PasswordSchema, display_name: DisplayNameSchema });
export const EmailRequestSchema = z.strictObject({ email: EmailSchema });
export const TokenRequestSchema = z.strictObject({ token: TokenSchema });
export const ResetPasswordSchema = z.strictObject({ token: TokenSchema, new_password: PasswordSchema });
export const CompleteInvitationSchema = z.strictObject({ token: TokenSchema, password: PasswordSchema, display_name: DisplayNameSchema });
export const RoleCodeSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/);
export const NoteInputSchema = z.strictObject({ title: text(1, 120).refine(value => value.trim().length > 0), body: text(0, 20_000) });
export const NoteUpdateSchema = NoteInputSchema.extend({ expected_version: VersionSchema });
export type Pagination = z.infer<typeof PaginationSchema>;
export type Locale = z.infer<typeof LocaleSchema>;
export const ReauthenticateSchema=z.strictObject({current_password:text(1,128)});
export const ChangePasswordSchema=z.strictObject({expected_version:VersionSchema,current_password:text(1,128),new_password:PasswordSchema});
