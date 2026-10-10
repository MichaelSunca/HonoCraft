import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import {startTestPostgres} from '../helpers/postgres.js';
import {migrate} from '../../apps/server/src/infrastructure/migrations.js';
import {decryptPayload} from '../../apps/server/src/infrastructure/crypto.js';
import {createPasswordService} from '../../apps/server/src/infrastructure/passwords.js';
import {mailAad} from '../../apps/server/src/modules/mail/outbox.js';
import {initializeBootstrap,completeBootstrap,cancelBootstrap} from '../../apps/server/src/modules/auth/bootstrap.js';
import {createLoginService} from '../../apps/server/src/modules/auth/login.js';
import {authenticateRead} from '../../apps/server/src/modules/auth/sessions.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>;let web:pg.Pool;let passwords:Awaited<ReturnType<typeof createPasswordService>>;
const mailKeyring={activeKeyId:'v1',keys:new Map([['v1',Buffer.alloc(32,4)]])};
const secrets={epoch:'test-epoch',digestKey:Buffer.alloc(32,8),mailKeyring};
const meta=()=>({requestId:randomUUID(),ip:'127.0.0.1',userAgent:'bootstrap test'});
const password='First administrator passphrase 测试';
beforeAll(async()=>{
  database=await startTestPostgres();passwords=await createPasswordService({concurrency:2,blockedPasswords:new Set<string>()});
  web=new pg.Pool({connectionString:database.connectionString,options:'-c role=honocraft_web'});
});
beforeEach(async()=>{await database.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await migrate(database.pool);});
afterAll(async()=>{await web?.end();await database?.close();});
async function tokenFromMail(){
  const task=(await database.pool.query("SELECT * FROM email_tasks WHERE status='queued' ORDER BY created_at DESC LIMIT 1")).rows[0];
  return JSON.parse(decryptPayload(mailKeyring,{keyId:task.key_id,nonce:task.nonce,tag:task.auth_tag,ciphertext:task.payload_ciphertext},mailAad(task.id,task.purpose,task.template_version))).token as string;
}
const initialize=(email='admin@example.test',resend=false)=>initializeBootstrap(database.pool,secrets,{email,resend},meta());
const complete=(token:string,request=meta())=>completeBootstrap(web,secrets,passwords,{token,password,display_name:'Administrator'},request);
describe('local bootstrap followed by public one-time completion',()=>{
  it('creates a passwordless pending account and encrypted email without granting access or returning a token',async()=>{
    const result=await initialize();expect(result).toMatchObject({status:'pending',mail_queued:true});
    const users=(await database.pool.query('SELECT status,password_hash,email_verified_at FROM users')).rows;
    expect(users).toEqual([{status:'pending',password_hash:null,email_verified_at:null}]);
    expect((await database.pool.query('SELECT * FROM user_roles')).rowCount).toBe(0);expect((await database.pool.query('SELECT * FROM sessions')).rowCount).toBe(0);
    const token=await tokenFromMail();expect(JSON.stringify(result)).not.toContain(token);expect(JSON.stringify(result)).not.toContain('admin@example.test');
  });
  it('does not issue another credential for an ordinary repeated initialization',async()=>{
    await initialize();expect(await initialize()).toMatchObject({status:'pending',mail_queued:false});
    expect((await database.pool.query('SELECT id FROM email_tasks')).rowCount).toBe(1);
    await expect(initialize('different@example.test')).rejects.toMatchObject({code:'BOOTSTRAP_CLOSED'});
  });
  it('resends with a new version and invalidates the original link',async()=>{
    await initialize();const old=await tokenFromMail();await database.pool.query("UPDATE rate_limit_buckets SET last_accepted_at=clock_timestamp()-interval '61 seconds'");await initialize('admin@example.test',true);const replacement=await tokenFromMail();expect(replacement).not.toBe(old);
    await expect(complete(old)).rejects.toMatchObject({code:'CREDENTIAL_INVALID'});
    expect((await database.pool.query("SELECT status,recipient FROM email_tasks WHERE status='cancelled'")).rows).toEqual([{status:'cancelled',recipient:null}]);
    expect(await complete(replacement)).toEqual({initialized:true,login_required:true});
  });
  it('atomically activates the administrator via the restricted web role and requires a separate login',async()=>{
    await initialize();const token=await tokenFromMail();expect(await complete(token)).toEqual({initialized:true,login_required:true});
    expect((await database.pool.query('SELECT initialization_status FROM system_state')).rows[0].initialization_status).toBe('initialized');
    expect((await database.pool.query('SELECT id FROM sessions')).rowCount).toBe(0);
    const result=await createLoginService(web,secrets,passwords)({email:'admin@example.test',password},meta());
    const session=await authenticateRead(web,{token:result.token,epoch:secrets.epoch});expect(session.permissions.has('role:delegate')).toBe(true);
    await expect(complete(token)).rejects.toMatchObject({code:'CREDENTIAL_INVALID'});
    expect(await initialize('different-after-activation@example.test')).toMatchObject({status:'initialized',mail_queued:false});
    expect((await database.pool.query('SELECT id FROM users')).rowCount).toBe(1);
    await expect(web.query("UPDATE system_state SET initialization_status='uninitialized',initialized_at=NULL")).rejects.toMatchObject({code:'42501'});
  });
  it('cancels only an unfinished bootstrap and allows a different email to start again',async()=>{
    await initialize();const old=await tokenFromMail();
    expect(await cancelBootstrap(database.pool,{reason:'Wrong initial address'},meta())).toMatchObject({status:'uninitialized'});
    expect((await database.pool.query('SELECT id FROM users')).rowCount).toBe(0);
    expect((await database.pool.query("SELECT recipient,payload_ciphertext,credential_id FROM email_tasks")).rows).toEqual([{recipient:null,payload_ciphertext:null,credential_id:null}]);
    await expect(complete(old)).rejects.toMatchObject({code:'CREDENTIAL_INVALID'});
    await initialize('replacement@example.test');await complete(await tokenFromMail());
    await expect(cancelBootstrap(database.pool,{reason:'Cannot undo activation'},meta())).rejects.toMatchObject({code:'BOOTSTRAP_CLOSED'});
  });
  it('protects operator resend with cooldown without invalidating the last accepted credential',async()=>{
    await initialize();const token=await tokenFromMail();
    await expect(initialize('admin@example.test',true)).rejects.toMatchObject({code:'RATE_LIMITED'});
    expect(await tokenFromMail()).toBe(token);
    expect((await database.pool.query('SELECT bootstrap_version FROM system_state')).rows[0].bootstrap_version).toBe(1);
    expect((await database.pool.query('SELECT id FROM email_tasks')).rowCount).toBe(1);
  });
  it('enforces the rolling hourly operator target quota even after cooldown has elapsed',async()=>{
    await initialize();
    for(let i=0;i<4;i++){
      await database.pool.query("UPDATE rate_limit_buckets SET last_accepted_at=clock_timestamp()-interval '61 seconds'");
      await initialize('admin@example.test',true);
    }
    await database.pool.query("UPDATE rate_limit_buckets SET last_accepted_at=clock_timestamp()-interval '61 seconds'");
    await expect(initialize('admin@example.test',true)).rejects.toMatchObject({code:'RATE_LIMITED'});
    expect((await database.pool.query('SELECT id FROM email_tasks')).rowCount).toBe(5);
  });
  it('allows only one concurrent completion to consume the bootstrap credential',async()=>{
    await initialize();const token=await tokenFromMail();const results=await Promise.allSettled([complete(token),complete(token)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
    expect((await database.pool.query("SELECT id FROM audit_events WHERE action='ops.bootstrap.completed'")).rowCount).toBe(1);
  });
  it('rolls back activation and token consumption when completion audit fails',async()=>{
    await initialize();const token=await tokenFromMail();const request=meta();
    await database.pool.query(`CREATE FUNCTION fail_completion_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.request_id='${request.requestId}' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_completion_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_completion_audit()`);
    await expect(complete(token,request)).rejects.toBeDefined();
    expect((await database.pool.query('SELECT initialization_status FROM system_state')).rows[0].initialization_status).toBe('pending');
    expect((await database.pool.query('SELECT password_hash,status FROM users')).rows).toEqual([{password_hash:null,status:'pending'}]);
    expect((await database.pool.query('SELECT consumed_at FROM one_time_credentials')).rows[0].consumed_at).toBeNull();
  });
});
