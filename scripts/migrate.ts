import { existsSync } from 'node:fs';
import pg from 'pg';
import { migrate } from '../apps/server/src/infrastructure/migrations.js';
if (existsSync('.env')) process.loadEnvFile('.env');
const connectionString = process.env.MIGRATION_DATABASE_URL;
if (!connectionString) { console.error('MIGRATION_DATABASE_URL is required'); process.exitCode = 2; }
else {
  const pool = new pg.Pool({ connectionString, max: 2 });
  try { await migrate(pool); console.log('Migrations applied. No user accounts were created.'); }
  catch (error) { console.error(error instanceof Error && error.message.startsWith('MIGRATION_') ? error.message : 'Migration failed; inspect database diagnostics securely.'); process.exitCode = 3; }
  finally { await pool.end(); }
}
