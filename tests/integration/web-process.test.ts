import {spawn,type ChildProcess} from 'node:child_process';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it} from 'vitest';
import {startTestPostgres} from '../helpers/postgres.js';
import {migrate} from '../../apps/server/src/infrastructure/migrations.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>;
let directory:string,env:NodeJS.ProcessEnv,base:string;
let child:ChildProcess|undefined;
beforeAll(async()=>{database=await startTestPostgres();});
afterAll(async()=>{await database?.close();});
beforeEach(async()=>{
  await database.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await migrate(database.pool);
  directory=await mkdtemp(join(tmpdir(),'honocraft-web-'));
  const socket=createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const address=socket.address();if(!address||typeof address==='string')throw new Error('Test port missing');
  const port=address.port;await new Promise<void>(resolve=>socket.close(()=>resolve()));base=`http://127.0.0.1:${port}`;
  const secret=()=>randomBytes(32).toString('base64url');
  for(const name of ['digest','csrf','epoch'])await writeFile(join(directory,name),secret(),{mode:0o600});
  await writeFile(join(directory,'mail.json'),JSON.stringify({active_key_id:'v1',keys:{v1:secret()}}),{mode:0o600});
  const url=new URL(database.connectionString);url.searchParams.set('options','-c role=honocraft_web');
  env={NODE_ENV:'production',PORT:String(port),PUBLIC_ORIGIN:'https://app.example.test',DATABASE_URL:url.href,
    MIGRATION_DATABASE_URL:'invalid-unneeded-owner-credential',MAINTENANCE_DATABASE_URL:'invalid-unneeded-maintenance-credential',
    MAIL_MODE:'smtp',SMTP_HOST:'smtp.example.test',MAIL_FROM:'test@example.test',FILE_STORAGE_ROOT:join(directory,'media'),
    MAIL_PAYLOAD_KEYRING_FILE:join(directory,'mail.json'),DIGEST_KEY_FILE:join(directory,'digest'),
    CSRF_KEY_FILE:join(directory,'csrf'),CREDENTIAL_EPOCH_FILE:join(directory,'epoch')};
});
afterEach(async()=>{
  if(child&&child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child!.once('exit',resolve));child.kill('SIGTERM');await exited;}
  child=undefined;await rm(directory,{recursive:true,force:true});
});
function launch(){
  child=spawn(process.execPath,['--import',createRequire(import.meta.url).resolve('tsx'),resolve('apps/server/src/main.ts')],{cwd:directory,env,stdio:['ignore','pipe','pipe']});
  let output='';
  const exited=new Promise<number|null>((resolve,reject)=>{child!.once('error',reject);child!.once('exit',resolve);});
  const ready=new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Web startup timed out')),10000);
    child!.stdout!.on('data',chunk=>{output+=String(chunk);if(output.includes('Web ready')){clearTimeout(timer);resolve();}});
    child!.stderr!.on('data',chunk=>{output+=String(chunk);});
    child!.once('exit',()=>{clearTimeout(timer);reject(new Error(`Web exited before ready: ${output}`));});
  });
  // Failure-path tests observe the exit result, not readiness.
  void ready.catch(()=>undefined);
  return {ready,exited,output:()=>output};
}
it('starts using real secret files and the restricted role, then releases connections on SIGTERM',async()=>{
  const process=launch();await process.ready;
  const health=await fetch(base+'/health/ready');expect(health.status).toBe(200);
  const settings=await fetch(base+'/api/v1/public/settings');expect((await settings.json()).data.initialized).toBe(false);
  expect((await fetch(base+'/api/v1/me')).status).toBe(503);
  child!.kill('SIGTERM');expect(await process.exited).toBe(0);
  expect((await database.pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='honocraft'")).rows[0].n).toBe(0);
  expect(process.output()).not.toContain('credential');
});
it('fails safely on missing secrets before opening an HTTP listener',async()=>{
  await rm(join(directory,'csrf'));const process=launch();expect(await process.exited).toBe(2);
  expect(process.output()).toContain('CSRF_KEY_FILE');expect(process.output()).not.toContain(directory);
  await expect(fetch(base+'/health/live')).rejects.toThrow();
});
it('refuses an outdated database without applying migrations',async()=>{
  await database.pool.query('DELETE FROM migration_history WHERE name=(SELECT max(name) FROM migration_history)');
  const before=(await database.pool.query('SELECT count(*)::int n FROM migration_history')).rows[0].n;
  const process=launch();expect(await process.exited).toBe(3);expect(process.output()).toContain('DATABASE_SCHEMA_INCOMPATIBLE');
  expect((await database.pool.query('SELECT count(*)::int n FROM migration_history')).rows[0].n).toBe(before);
});
it('refuses module configuration mismatches without overwriting the database flag',async()=>{
  env.EXAMPLE_NOTES_ENABLED='true';const process=launch();expect(await process.exited).toBe(3);
  expect(process.output()).toContain('PERMISSION_CATALOG_INCOMPATIBLE');
  expect((await database.pool.query('SELECT example_notes_enabled FROM system_state')).rows[0].example_notes_enabled).toBe(false);
});
