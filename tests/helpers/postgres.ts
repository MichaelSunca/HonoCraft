import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { initdb, pg_ctl } from '@embedded-postgres/linux-x64';
import pg from 'pg';
const execFile = promisify(execFileCallback);

export async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  return address.port;
}

/** A real, isolated PostgreSQL 17 cluster. No product state or system services are touched. */
export async function startTestPostgres() {
  await mkdir('.local/tests', { recursive: true });
  const root = await mkdtemp(resolve('.local/tests/pg-'));
  const data = resolve(root, 'data');
  const passwordFile = resolve(root, 'password');
  const password = randomBytes(32).toString('hex');
  const port = await availablePort();
  await writeFile(passwordFile, password, { mode: 0o600 });
  let started = false;
  try {
    await execFile(initdb, ['-D', data, '-U', 'honocraft_owner', '--pwfile', passwordFile, '--auth=scram-sha-256', '--encoding=UTF8', '--no-locale'], { timeout: 30_000 });
    await rm(passwordFile);
    await execFile(pg_ctl, ['-D', data, '-l', resolve(root, 'postgres.log'), '-o', `-p ${port} -h 127.0.0.1 -k ${root}`, '-w', 'start'], { timeout: 30_000 });
    started = true;
    const connectionString = `postgresql://honocraft_owner:${password}@127.0.0.1:${port}/postgres`;
    const pool = new pg.Pool({ connectionString, max: 10 });
    await pool.query('SELECT 1');
    return { pool, connectionString, async close() {
      await pool.end();
      await execFile(pg_ctl, ['-D', data, '-m', 'fast', '-w', 'stop'], { timeout: 15_000 });
      await rm(root, { recursive: true, force: true });
    } };
  } catch (error) {
    if (started) await execFile(pg_ctl, ['-D', data, '-m', 'fast', '-w', 'stop']).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
