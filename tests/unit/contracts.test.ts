import { describe, expect, it } from 'vitest';
import { PasswordSchema, ProfileUpdateSchema, PaginationSchema, EmailSchema, normalizeEmail } from '../../packages/contracts/src/common.js';

describe('public input boundaries', () => {
  it('normalizes email case and outer spaces without dropping dots or tags', () => {
    expect(normalizeEmail('  A.B+work@Example.COM  ')).toBe('a.b+work@example.com');
  });
  it('converts international domain names to ASCII without changing the local part for display', () => {
    expect(EmailSchema.parse('User@例え.jp')).toBe('User@xn--r8jz45g.jp');
  });
  it.each(['a..b@example.com', 'user@localhost', 'user@a..com', 'user@evil.com/path', '用戶@example.com', 'a@b.com\nBCC:target@test.com'])('rejects unsupported email %s', value => {
    expect(EmailSchema.safeParse(value).success).toBe(false);
  });
  it('counts password Unicode codepoints, rejecting seven surrogate-pair characters', () => {
    expect(PasswordSchema.safeParse('😀'.repeat(7)).success).toBe(false);
    expect(PasswordSchema.safeParse('😀'.repeat(15)).success).toBe(true);
  });
  it('does not trim or truncate a valid password', () => {
    const value = '  a long passphrase  ';
    expect(PasswordSchema.parse(value)).toBe(value);
    expect(PasswordSchema.safeParse('a'.repeat(129)).success).toBe(false);
  });
  it('rejects privilege fields injected into personal profile edits', () => {
    expect(ProfileUpdateSchema.safeParse({ expected_version: 1, display_name: 'Alice', role_ids: ['super_admin'] }).success).toBe(false);
  });
  it('requires a real change and a current editable version', () => {
    expect(ProfileUpdateSchema.safeParse({ expected_version: 1 }).success).toBe(false);
    expect(ProfileUpdateSchema.safeParse({ expected_version: 0, theme: 'dark' }).success).toBe(false);
    expect(ProfileUpdateSchema.safeParse({ expected_version: 1, display_name: '😀'.repeat(80) }).success).toBe(true);
  });
  it('defaults pagination and rejects requests exceeding its bounded size', () => {
    expect(PaginationSchema.parse({})).toEqual({ page: 1, page_size: 20 });
    expect(PaginationSchema.safeParse({ page_size: '101' }).success).toBe(false);
    expect(PaginationSchema.safeParse({ page: '0' }).success).toBe(false);
    expect(PaginationSchema.safeParse({ page_size: '1x' }).success).toBe(false);
  });
});
