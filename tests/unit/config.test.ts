import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/server/src/infrastructure/config.js';

const valid = {
  NODE_ENV: 'development', PUBLIC_ORIGIN: 'http://localhost:3000', PORT: '3000',
  DATABASE_URL: 'postgresql://app:secret@localhost:5432/honocraft_dev',
  SMTP_HOST: '127.0.0.1', SMTP_PORT: '1025', MAIL_FROM: 'HonoCraft <noreply@example.test>',
  MAIL_MODE: 'capture', FILE_STORAGE_ROOT: '.local/media',
  MAIL_PAYLOAD_KEYRING_FILE: '.local/secrets/mail.json', DIGEST_KEY_FILE: '.local/secrets/digest',
  CSRF_KEY_FILE: '.local/secrets/csrf', CREDENTIAL_EPOCH_FILE: '.local/secrets/epoch',
};

describe('deployment configuration boundaries', () => {
  it('accepts a local mail capture deployment with explicit secret files', () => {
    expect(loadConfig(valid)).toMatchObject({ environment: 'development', origin: 'http://localhost:3000', port: 3000, exampleNotesEnabled: true });
  });
  it('uses a separate production cookie and disables example routes by default', () => {
    expect(loadConfig({ ...valid, NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://admin.example.com', MAIL_MODE: 'smtp', SMTP_HOST: 'smtp.example.com' }))
      .toMatchObject({ sessionCookieName: '__Host-honocraft_session', secureCookies: true, exampleNotesEnabled: false });
  });
  it.each(['http://admin.example.com', 'https://admin.example.com/path', 'https://admin.example.com#token', 'https://user:pass@admin.example.com'])('rejects untrusted production origin %s', (PUBLIC_ORIGIN) => {
    expect(() => loadConfig({ ...valid, NODE_ENV: 'production', PUBLIC_ORIGIN, MAIL_MODE: 'smtp', SMTP_HOST: 'smtp.example.com' })).toThrow(/PUBLIC_ORIGIN/);
  });
  it('rejects capture mail in production', () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://example.com' })).toThrow(/MAIL_MODE/);
  });
  it.each(['', '0', '-1', 'NaN', '3000x', '65536'])('rejects invalid port %s', (PORT) => {
    expect(() => loadConfig({ ...valid, PORT })).toThrow(/PORT/);
  });
  it('rejects missing secret paths without leaking database credentials', () => {
    let error: unknown;
    try { loadConfig({ ...valid, CSRF_KEY_FILE: '', DATABASE_URL: 'postgresql://private:sensitive-password@localhost/test' }); } catch (e) { error = e; }
    expect(String(error)).toContain('CSRF_KEY_FILE');
    expect(String(error)).not.toContain('sensitive-password');
  });
  it('rejects misspelled boolean switches instead of silently enabling a module', () => {
    expect(() => loadConfig({ ...valid, EXAMPLE_NOTES_ENABLED: 'flase' })).toThrow(/EXAMPLE_NOTES_ENABLED/);
  });
  it('rejects a malformed trusted proxy CIDR', () => {
    expect(() => loadConfig({ ...valid, TRUSTED_PROXY_CIDRS: 'anything,999.1.2.3/99' })).toThrow(/TRUSTED_PROXY_CIDRS/);
  });
});
