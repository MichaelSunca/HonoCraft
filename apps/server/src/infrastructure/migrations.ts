import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

export const DEFAULT_MIGRATION_DIRECTORY = fileURLToPath(new URL('../../../../db/migrations/', import.meta.url));
/** Explicit deployment command only. Application startup must not invoke this. */
export async function migrate(pool: Pool, directory = DEFAULT_MIGRATION_DIRECTORY): Promise<void> {
  const filenames = (await readdir(directory)).filter(name => /^\d{4}_[a-z0-9_-]+\.sql$/.test(name)).sort();
  if (!filenames.length) throw new Error('MIGRATIONS_MISSING');
  const client = await pool.connect();
  try {
    await client.query("SET lock_timeout='5s'");
    await client.query('SELECT pg_advisory_lock(48434, 1)');
    await client.query(`CREATE TABLE IF NOT EXISTS migration_history (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp(), app_version text NOT NULL)`);
    const applied = (await client.query<{ name: string; checksum: string }>('SELECT name,checksum FROM migration_history ORDER BY name')).rows;
    if (applied.some(item => !filenames.includes(item.name))) throw new Error('MIGRATION_VERSION_UNSUPPORTED');
    for (const name of filenames) {
      const sql = await readFile(new URL(name, `file://${directory.endsWith('/') ? directory : `${directory}/`}`), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = applied.find(item => item.name === name);
      if (previous) { if (previous.checksum !== checksum) throw new Error(`MIGRATION_CHECKSUM_MISMATCH: ${name}`); continue; }
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL statement_timeout='60s'");
        await client.query(sql);
        await client.query('INSERT INTO migration_history(name,checksum,app_version) VALUES ($1,$2,$3)', [name, checksum, '0.1.0']);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(48434,1)').catch(() => undefined);
    await client.query('RESET lock_timeout').catch(() => undefined);
    client.release();
  }
}
