import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it} from 'vitest';
import {startTestPostgres} from '../helpers/postgres.js';
import {migrate} from '../../apps/server/src/infrastructure/migrations.js';
import {createPasswordService} from '../../apps/server/src/infrastructure/passwords.js';
import {decryptPayload} from '../../apps/server/src/infrastructure/crypto.js';
import {mailAad} from '../../apps/server/src/modules/mail/outbox.js';
import {completeBootstrap} from '../../apps/server/src/modules/auth/bootstrap.js';
const exec=promisify(execFile);const script=resolve('scripts/ops-init.ts');
let database:Awaited<ReturnType<typeof startTestPostgres>>,directory:string,env:NodeJS.ProcessEnv;
let mailKey:Buffer,digest:Buffer,epoch:string;
beforeAll(async()=>{database=await startTestPostgres();});
afterAll(async()=>{await database?.close();});
beforeEach(async()=>{
  await database.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await migrate(database.pool);
  directory=await mkdtemp(join(tmpdir(),'honocraft-ops-'));mailKey=randomBytes(32);digest=randomBytes(32);epoch=randomBytes(32).toString('base64url');
  await writeFile(join(directory,'mail.json'),JSON.stringify({active_key_id:'v1',keys:{v1:mailKey.toString('base64url')}}),{mode:0o600});
  for(const [name,value] of [['digest',digest.toString('base64url')],['csrf',randomBytes(32).toString('base64url')],['epoch',epoch]] as const)await writeFile(join(directory,name),value,{mode:0o600});
  env={NODE_ENV:'test',PUBLIC_ORIGIN:'http://localhost:3000',DATABASE_URL:'not-the-operator-database',MIGRATION_DATABASE_URL:database.connectionString,
    MAIL_MODE:'capture',SMTP_HOST:'127.0.0.1',SMTP_PORT:'1025',MAIL_FROM:'test@example.test',FILE_STORAGE_ROOT:join(directory,'media'),EXAMPLE_NOTES_ENABLED:'false',
    MAIL_PAYLOAD_KEYRING_FILE:join(directory,'mail.json'),DIGEST_KEY_FILE:join(directory,'digest'),CSRF_KEY_FILE:join(directory,'csrf'),CREDENTIAL_EPOCH_FILE:join(directory,'epoch')};
});
afterEach(async()=>{await rm(directory,{recursive:true,force:true});});
async function run(args:string[]){
  try{const result=await exec(process.execPath,['--import',createRequire(import.meta.url).resolve('tsx'),script,...args],{cwd:directory,env,timeout:15000});return {code:0,...result};}
  catch(error){const result=error as {code:number;stdout:string;stderr:string};if(typeof result.code!=='number')throw error;return result;}
}
it('queues initialization with a safe operation summary and repeats without issuing another credential',async()=>{
  const first=await run(['--','--email=owner@example.test']);expect(first.code).toBe(0);
  const result=JSON.parse(first.stdout);expect(result).toMatchObject({status:'pending',mail_queued:true,next_step:'CHECK_INITIALIZATION_EMAIL'});expect(result.operation_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(first.stdout).not.toContain('owner@example.test');expect(first.stdout).not.toContain(epoch);
  expect(JSON.parse((await run(['--email=owner@example.test'])).stdout)).toMatchObject({status:'pending',mail_queued:false});
  expect((await database.pool.query('SELECT id FROM email_tasks')).rowCount).toBe(1);
  const conflict=await run(['--email=another@example.test']);expect(conflict.code).toBe(3);expect(conflict.stderr).toContain('BOOTSTRAP_CLOSED');
});
it('reports retry delay, then accepts an explicit resend only after cooldown',async()=>{
  await run(['--email=owner@example.test']);
  const denied=await run(['--email=owner@example.test','--resend']);expect(denied.code).toBe(3);expect(denied.stderr).toContain('RATE_LIMITED');expect(JSON.parse(denied.stderr).retry_after).toBeGreaterThan(0);
  await database.pool.query("UPDATE rate_limit_buckets SET last_accepted_at=clock_timestamp()-interval '61 seconds'");
  expect((await run(['--email=owner@example.test','--resend'])).code).toBe(0);
  expect((await database.pool.query('SELECT bootstrap_version FROM system_state')).rows[0].bootstrap_version).toBe(2);
});
it('supports explicit cancellation with an audit reason before selecting a replacement address',async()=>{
  await run(['--email=owner@example.test']);const cancelled=await run(['--cancel','--reason=Incorrect initial address']);expect(cancelled.code).toBe(0);
  expect(JSON.parse(cancelled.stdout)).toMatchObject({status:'uninitialized',next_step:'RUN_OPS_INIT'});
  expect((await database.pool.query("SELECT reason FROM audit_events WHERE action='ops.bootstrap.cancelled'")).rows[0].reason).toBe('Incorrect initial address');
  expect((await run(['--email=replacement@example.test'])).code).toBe(0);
});
it('reports already initialized after real credential completion without creating a second administrator',async()=>{
  expect((await run(['--email=owner@example.test'])).code).toBe(0);const row=(await database.pool.query("SELECT * FROM email_tasks WHERE status='queued'")).rows[0];
  const mailKeyring={activeKeyId:'v1',keys:new Map([['v1',mailKey]])};
  const token=JSON.parse(decryptPayload(mailKeyring,{keyId:row.key_id,nonce:row.nonce,tag:row.auth_tag,ciphertext:row.payload_ciphertext},mailAad(row.id,row.purpose,row.template_version))).token;
  const passwords=await createPasswordService({concurrency:1,blockedPasswords:new Set()});
  await completeBootstrap(database.pool,{mailKeyring,digestKey:digest,epoch},passwords,{token,password:'An administrator secret passphrase',display_name:'Owner'},{requestId:randomUUID(),ip:'127.0.0.1',userAgent:'ops test'});
  const again=await run(['--email=another@example.test']);expect(again.code).toBe(0);expect(JSON.parse(again.stdout)).toMatchObject({status:'initialized',mail_queued:false,next_step:'SIGN_IN'});
  expect((await database.pool.query('SELECT id FROM users')).rowCount).toBe(1);
});
it.each([[],['--cancel'],['--cancel','--email=owner@example.test','--reason=No'],['--email=owner@example.test','--force']].map(args=>({args})))('rejects invalid arguments $args without changing the database',async({args})=>{
  const result=await run(args);expect(result.code).toBe(2);expect(result.stderr).not.toContain('owner@example.test');
  expect((await database.pool.query('SELECT id FROM users')).rowCount).toBe(0);
});
