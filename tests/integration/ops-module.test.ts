import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it} from 'vitest';
import {startTestPostgres} from '../helpers/postgres.js';
import {migrate} from '../../apps/server/src/infrastructure/migrations.js';
import {checkDatabaseCompatibility} from '../../apps/server/src/infrastructure/startup.js';
const exec=promisify(execFile),script=resolve('scripts/ops-module.ts');
let database:Awaited<ReturnType<typeof startTestPostgres>>,directory:string,env:NodeJS.ProcessEnv;
beforeAll(async()=>{database=await startTestPostgres();});
beforeEach(async()=>{
  await database.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await migrate(database.pool);directory=await mkdtemp(join(tmpdir(),'honocraft-module-'));
  env={NODE_ENV:'test',PUBLIC_ORIGIN:'http://localhost:3000',DATABASE_URL:'not-the-operator-database',MIGRATION_DATABASE_URL:database.connectionString,MAIL_MODE:'capture',SMTP_HOST:'127.0.0.1',SMTP_PORT:'1025',MAIL_FROM:'test@example.test',FILE_STORAGE_ROOT:join(directory,'media'),EXAMPLE_NOTES_ENABLED:'false',MAIL_PAYLOAD_KEYRING_FILE:'not-required-mail',DIGEST_KEY_FILE:'not-required-digest',CSRF_KEY_FILE:'not-required-csrf',CREDENTIAL_EPOCH_FILE:'not-required-epoch'};
});
afterEach(async()=>{await rm(directory,{recursive:true,force:true});});
afterAll(async()=>{await database?.close();});
async function run(args:string[]){try{return {code:0,...await exec(process.execPath,['--import',createRequire(import.meta.url).resolve('tsx'),script,...args],{cwd:directory,env,timeout:15000})};}catch(error){const result=error as {code:number;stdout:string;stderr:string};if(typeof result.code!=='number')throw error;return result;}}
it('enables and disables the fixed module through the operator connection with safe summaries and no secret loading',async()=>{
  const enabled=await run(['--','--enable=example-notes','--reason=Use the reference module']);expect(enabled.code).toBe(0);expect(JSON.parse(enabled.stdout)).toMatchObject({module:'example-notes',enabled:true,changed:true,permissions_changed:4,data_preserved:true,next_step:'SET_MODULE_FLAG_AND_RESTART'});expect(enabled.stdout).not.toContain(database.connectionString);expect(enabled.stdout).not.toContain(directory);await expect(checkDatabaseCompatibility(database.pool,true)).resolves.toBeUndefined();
  const repeated=await run(['--enable=example-notes','--reason=Already enabled']);expect(repeated.code).toBe(0);expect(JSON.parse(repeated.stdout)).toMatchObject({changed:false,permissions_changed:0});const disabled=await run(['--disable=example-notes','--reason=Keep data while hiding the example']);expect(disabled.code).toBe(0);expect(JSON.parse(disabled.stdout)).toMatchObject({enabled:false,changed:true,data_preserved:true});await expect(checkDatabaseCompatibility(database.pool,false)).resolves.toBeUndefined();expect((await database.pool.query("SELECT action FROM audit_events WHERE action LIKE 'ops.module.%'")).rowCount).toBe(2);
});
it('requires a separate migration connection and does not fall back to web configuration',async()=>{
  delete env.MIGRATION_DATABASE_URL;const result=await run(['--enable=example-notes','--reason=Enable']);expect(result.code).toBe(2);expect(JSON.parse(result.stderr)).toMatchObject({code:'CONFIGURATION_INVALID',fields:['MIGRATION_DATABASE_URL']});expect((await database.pool.query('SELECT example_notes_enabled FROM system_state')).rows[0].example_notes_enabled).toBe(false);
});
it('refuses old schemas and undeclared catalog entries without repairing them',async()=>{
  await database.pool.query("DELETE FROM migration_history WHERE name='0006_file_cleanup_index.sql'");const schema=await run(['--enable=example-notes','--reason=Enable']);expect(schema.code).toBe(3);expect(schema.stderr).toContain('DATABASE_SCHEMA_INCOMPATIBLE');
  // Recreate a clean database rather than pretending the already-created index was not applied.
  await database.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await migrate(database.pool);await database.pool.query("INSERT INTO permissions(code,module,name_key,description_key) VALUES('unexpected:read','unexpected','unexpected','unexpected')");const catalog=await run(['--enable=example-notes','--reason=Enable']);expect(catalog.code).toBe(3);expect(catalog.stderr).toContain('PERMISSION_CATALOG_INCOMPATIBLE');expect((await database.pool.query('SELECT example_notes_enabled FROM system_state')).rows[0].example_notes_enabled).toBe(false);
});
it('returns a sanitized dependency error for runtime credentials without changing state',async()=>{
  const url=new URL(database.connectionString);url.searchParams.set('options','-c role=honocraft_web');env.MIGRATION_DATABASE_URL=url.href;const result=await run(['--enable=example-notes','--reason=Enable']);expect(result.code).toBe(4);expect(JSON.parse(result.stderr)).toMatchObject({code:'DEPENDENCY_UNAVAILABLE'});expect(result.stderr).not.toContain(database.connectionString);await expect(checkDatabaseCompatibility(database.pool,false)).resolves.toBeUndefined();
});
it.each([[],['--enable=example-notes'],['--enable=example-notes','--disable=example-notes','--reason=Invalid'],['--enable=users','--reason=Invalid'],['--enable=example-notes','--reason='],['--enable=example-notes','--reason=First','--reason=Second'],['--enable=example-notes','--reason=Reason','--force']].map(args=>({args})))('rejects invalid operator arguments $args before any changes',async({args})=>{
  const result=await run(args);expect(result.code).toBe(2);expect(JSON.parse(result.stderr).code).toBe('CONFIGURATION_INVALID');expect((await database.pool.query('SELECT example_notes_enabled FROM system_state')).rows[0].example_notes_enabled).toBe(false);
});
