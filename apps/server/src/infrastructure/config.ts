import { isIP } from 'node:net';
import { resolve } from 'node:path';

export type AppConfig = Readonly<{
  environment: 'development' | 'test' | 'production';
  origin: string; port: number; databaseUrl: string; migrationDatabaseUrl: string | undefined;
  maintenanceDatabaseUrl: string | undefined; workerDatabaseUrl: string | undefined;
  sessionCookieName: string; secureCookies: boolean; exampleNotesEnabled: boolean;
  trustedProxyCidrs: readonly string[]; fileStorageRoot: string;
  mailKeyringFile: string; digestKeyFile: string; csrfKeyFile: string; credentialEpochFile: string;
  smtp: Readonly<{ host: string; port: number; secure: boolean; user: string | undefined; password: string | undefined; from: string; mode: 'capture' | 'smtp' }>;
  dbPoolMax: number; hashConcurrency: number; httpTimeoutMs: number; uploadTimeoutMs: number;
  auditRetentionDays: number; securityRetentionDays: number;
}>;

/** Errors deliberately contain field names only: environment values may be secrets. */
export class ConfigurationError extends Error {
  constructor(readonly fields: readonly string[]) {
    super(`Invalid configuration: ${[...new Set(fields)].join(', ')}`);
    this.name = 'ConfigurationError';
  }
}

export function loadConfig(input: NodeJS.ProcessEnv): AppConfig {
  const errors: string[] = [];
  const required = (key: string): string => {
    const value = input[key];
    if (!value?.trim()) { errors.push(key); return ''; }
    return value;
  };
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    const raw = input[key] ?? String(fallback);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) errors.push(key);
    return value;
  };
  const boolean = (key: string, fallback: boolean): boolean => {
    const raw = input[key];
    if (raw === undefined) return fallback;
    if (raw !== 'true' && raw !== 'false') errors.push(key);
    return raw === 'true';
  };
  const environment = input.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(environment)) errors.push('NODE_ENV');
  const production = environment === 'production';
  const rawOrigin = required('PUBLIC_ORIGIN');
  let origin = '';
  try {
    const url = new URL(rawOrigin);
    if (!['http:', 'https:'].includes(url.protocol) || (production && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    origin = url.origin;
  } catch { errors.push('PUBLIC_ORIGIN'); }
  const databaseUrl = required('DATABASE_URL');
  for (const [key, value] of Object.entries({ DATABASE_URL: databaseUrl, MIGRATION_DATABASE_URL: input.MIGRATION_DATABASE_URL, MAINTENANCE_DATABASE_URL: input.MAINTENANCE_DATABASE_URL, WORKER_DATABASE_URL: input.WORKER_DATABASE_URL })) {
    if (value === undefined) continue;
    try { const url = new URL(value); if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) throw new Error(); } catch { errors.push(key); }
  }
  const mode = required('MAIL_MODE');
  if (!['capture', 'smtp'].includes(mode) || (production && mode !== 'smtp')) errors.push('MAIL_MODE');
  const smtpHost = required('SMTP_HOST');
  if (production && /^(mailpit|localhost|127\.0\.0\.1)$/i.test(smtpHost) && (input.SMTP_PORT ?? '1025') === '1025') errors.push('SMTP_HOST');
  const from = required('MAIL_FROM');
  if (/[\r\n]/.test(from) || !/@/.test(from)) errors.push('MAIL_FROM');
  const user = input.SMTP_USER;
  const password = input.SMTP_PASSWORD;
  if (Boolean(user) !== Boolean(password)) errors.push('SMTP_USER', 'SMTP_PASSWORD');
  const trustedProxyCidrs = (input.TRUSTED_PROXY_CIDRS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  for (const cidr of trustedProxyCidrs) {
    const parts = cidr.split('/');
    const family = isIP(parts[0] ?? '');
    if (parts.length > 2 || !family || (parts.length === 2 && (!/^\d+$/.test(parts[1] ?? '') || Number(parts[1]) > (family === 4 ? 32 : 128)))) errors.push('TRUSTED_PROXY_CIDRS');
  }
  const paths = {
    fileStorageRoot: resolve(required('FILE_STORAGE_ROOT')),
    mailKeyringFile: resolve(required('MAIL_PAYLOAD_KEYRING_FILE')),
    digestKeyFile: resolve(required('DIGEST_KEY_FILE')),
    csrfKeyFile: resolve(required('CSRF_KEY_FILE')),
    credentialEpochFile: resolve(required('CREDENTIAL_EPOCH_FILE')),
  };
  const secrets = [paths.mailKeyringFile, paths.digestKeyFile, paths.csrfKeyFile, paths.credentialEpochFile];
  if (new Set(secrets).size !== secrets.length) errors.push('SECRET_FILE_SEPARATION');
  const config: AppConfig = {
    environment: environment as AppConfig['environment'], origin, databaseUrl,
    migrationDatabaseUrl: input.MIGRATION_DATABASE_URL, maintenanceDatabaseUrl: input.MAINTENANCE_DATABASE_URL,
    workerDatabaseUrl: input.WORKER_DATABASE_URL,
    port: integer('PORT', 3000, 1, 65535), sessionCookieName: production ? '__Host-honocraft_session' : 'honocraft_dev_session', secureCookies: production,
    exampleNotesEnabled: boolean('EXAMPLE_NOTES_ENABLED', !production), trustedProxyCidrs: Object.freeze(trustedProxyCidrs), ...paths,
    smtp: Object.freeze({ host: smtpHost, port: integer('SMTP_PORT', 587, 1, 65535), secure: boolean('SMTP_SECURE', false), user, password, from, mode: mode as 'capture' | 'smtp' }),
    dbPoolMax: integer('DB_POOL_MAX', 10, 1, 100), hashConcurrency: integer('HASH_CONCURRENCY', 2, 1, 16),
    httpTimeoutMs: integer('HTTP_TIMEOUT_MS', 15_000, 1000, 120_000), uploadTimeoutMs: integer('UPLOAD_TIMEOUT_MS', 30_000, 1000, 120_000),
    auditRetentionDays: integer('LOG_RETENTION_DAYS', 180, 1, 3650), securityRetentionDays: integer('SECURITY_RETENTION_DAYS', 90, 1, 3650),
  };
  if (errors.length) throw new ConfigurationError(errors);
  return Object.freeze(config);
}
