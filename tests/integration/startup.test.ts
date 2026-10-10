import {appendFile,cp,mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import pg from 'pg';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {startTestPostgres} from '../helpers/postgres.js';
import {migrate,DEFAULT_MIGRATION_DIRECTORY} from '../../apps/server/src/infrastructure/migrations.js';
import {checkDatabaseCompatibility} from '../../apps/server/src/infrastructure/startup.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>;
beforeAll(async()=>{database=await startTestPostgres();});
afterAll(async()=>{await database?.close();});
beforeEach(async()=>{await database.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await migrate(database.pool);});
describe('read-only startup compatibility gate',()=>{
  it.each(['honocraft_web','honocraft_worker'])('accepts the current database with restricted role %s before initialization',async role=>{
    const pool=new pg.Pool({connectionString:database.connectionString,options:`-c role=${role}`});
    try{await expect(checkDatabaseCompatibility(pool,false)).resolves.toBeUndefined();}finally{await pool.end();}
    expect((await database.pool.query('SELECT count(*)::int n FROM users')).rows[0].n).toBe(0);
  });
  it('rejects an unmigrated database without creating schema',async()=>{
    await database.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await expect(checkDatabaseCompatibility(database.pool,false)).rejects.toThrow('DATABASE_SCHEMA_INCOMPATIBLE');
    expect((await database.pool.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n).toBe(0);
  });
  it('rejects a missing migration',async()=>{
    await database.pool.query('DELETE FROM migration_history WHERE name=(SELECT max(name) FROM migration_history)');
    await expect(checkDatabaseCompatibility(database.pool,false)).rejects.toThrow('DATABASE_SCHEMA_INCOMPATIBLE');
  });
  it('rejects migrations from a future release',async()=>{
    await database.pool.query("INSERT INTO migration_history(name,checksum,app_version) VALUES('9999_future.sql','unknown','future')");
    await expect(checkDatabaseCompatibility(database.pool,false)).rejects.toThrow('DATABASE_SCHEMA_INCOMPATIBLE');
  });
  it('rejects altered shipped SQL even when the database version matches',async()=>{
    const directory=await mkdtemp(resolve('.local/tests/startup-migrations-'));
    try{await cp(DEFAULT_MIGRATION_DIRECTORY,directory,{recursive:true});await appendFile(resolve(directory,'0001_core.sql'),'\n-- altered');
      await expect(checkDatabaseCompatibility(database.pool,false,directory)).rejects.toThrow('DATABASE_SCHEMA_INCOMPATIBLE');
    }finally{await rm(directory,{recursive:true,force:true});}
  });
  it('requires an explicit catalog migration when the module flag changes',async()=>{
    await expect(checkDatabaseCompatibility(database.pool,true)).rejects.toThrow('PERMISSION_CATALOG_INCOMPATIBLE');
    expect((await database.pool.query('SELECT example_notes_enabled FROM system_state')).rows[0].example_notes_enabled).toBe(false);
  });
  it('rejects mismatched permission properties',async()=>{
    await database.pool.query("UPDATE permissions SET is_delegable=false WHERE code='user:read'");
    await expect(checkDatabaseCompatibility(database.pool,false)).rejects.toThrow('PERMISSION_CATALOG_INCOMPATIBLE');
  });
  it('rejects missing permission dependencies',async()=>{
    await database.pool.query("DELETE FROM permission_dependencies WHERE permission_id=(SELECT id FROM permissions WHERE code='role:manage')");
    await expect(checkDatabaseCompatibility(database.pool,false)).rejects.toThrow('PERMISSION_CATALOG_INCOMPATIBLE');
  });
  it('rejects unsupported catalog versions',async()=>{
    await database.pool.query('UPDATE system_state SET catalog_version=99');
    await expect(checkDatabaseCompatibility(database.pool,false)).rejects.toThrow('PERMISSION_CATALOG_INCOMPATIBLE');
  });
});
