import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {startTestPostgres} from '../helpers/postgres.js';
import {identity,initializedDatabase} from '../helpers/identity.js';
import {migrate} from '../../apps/server/src/infrastructure/migrations.js';
import {createPasswordService} from '../../apps/server/src/infrastructure/passwords.js';
import {decryptPayload,issueToken} from '../../apps/server/src/infrastructure/crypto.js';
import {mailAad} from '../../apps/server/src/modules/mail/outbox.js';
import {createPublicAuthService} from '../../apps/server/src/modules/auth/public-auth.js';
import {createLoginService} from '../../apps/server/src/modules/auth/login.js';
import {authenticateRead} from '../../apps/server/src/modules/auth/sessions.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>,web:pg.Pool,passwords:Awaited<ReturnType<typeof createPasswordService>>,auth:ReturnType<typeof createPublicAuthService>;
const secrets={epoch:'test-epoch',digestKey:Buffer.alloc(32,8),mailKeyring:{activeKeyId:'v1',keys:new Map([['v1',Buffer.alloc(32,4)]])}};
const password='My first long passphrase 测试';const replacement='My replacement long passphrase 测试';
const meta=()=>({requestId:randomUUID(),ip:'127.0.0.1',userAgent:'public auth test'});
beforeAll(async()=>{database=await startTestPostgres();web=new pg.Pool({connectionString:database.connectionString,options:'-c role=honocraft_web',max:5});passwords=await createPasswordService({concurrency:2,blockedPasswords:new Set(['a common weak password'])});auth=createPublicAuthService(web,secrets,passwords);});
beforeEach(async()=>{await database.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await migrate(database.pool);await initializedDatabase(database.pool);await database.pool.query("UPDATE system_settings SET typed_value=jsonb_set(typed_value,'{registration_open}','true') WHERE key='security'");});
afterAll(async()=>{await web?.end();await database?.close();});
const register=(email='new@example.test',other={})=>auth.register({email,password,display_name:'New user',...other},meta());
async function mail(purpose='email_verify'){
  const row=(await database.pool.query("SELECT * FROM email_tasks WHERE purpose=$1 AND status='queued' ORDER BY created_at DESC LIMIT 1",[purpose])).rows[0];
  if(!row)throw new Error('Expected queued test mail');
  return {task:row,payload:JSON.parse(decryptPayload(secrets.mailKeyring,{keyId:row.key_id,nonce:row.nonce,tag:row.auth_tag,ciphertext:row.payload_ciphertext},mailAad(row.id,row.purpose,row.template_version)))};
}
async function pending(){await register();return {id:(await database.pool.query("SELECT id FROM users WHERE normalized_email='new@example.test'")).rows[0].id as string,token:(await mail()).payload.token as string};}
const cool=()=>database.pool.query("UPDATE rate_limit_buckets SET last_accepted_at=clock_timestamp()-interval '61 seconds'");

describe('public registration and original-role verification',()=>{
  it('creates only a pending password account and returns no identity or token',async()=>{
    expect(await register()).toEqual({accepted:true});
    const row=(await database.pool.query('SELECT status,email_verified_at,password_hash,registration_role_id FROM users')).rows[0];
    expect(row.status).toBe('pending');expect(row.email_verified_at).toBeNull();expect(await passwords.verify(row.password_hash,password)).toBe(true);
    expect(row.registration_role_id).toBe('00000000-0000-4000-8000-000000000003');expect((await database.pool.query('SELECT user_id FROM user_roles')).rowCount).toBe(0);
    expect((await mail()).payload.purpose).toBe('email_verify');
  });
  it('checks registration policy and rejects privilege injection before creating a user',async()=>{
    await expect(register('new@example.test',{role_ids:['super_admin']})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    await database.pool.query("UPDATE system_settings SET typed_value=jsonb_set(typed_value,'{registration_open}','false') WHERE key='security'");
    await expect(register()).rejects.toMatchObject({code:'REGISTRATION_DISABLED'});expect((await database.pool.query('SELECT id FROM users')).rowCount).toBe(0);
  });
  it('rejects blocked passwords and accepts neither database writes nor email work',async()=>{
    await expect(register('new@example.test',{password:'a common weak password'})).rejects.toMatchObject({code:'PASSWORD_REJECTED'});
    expect((await database.pool.query('SELECT id FROM users')).rowCount).toBe(0);expect((await database.pool.query('SELECT id FROM email_tasks')).rowCount).toBe(0);
  });
  it('does not overwrite an existing account and serializes concurrent same-address registration',async()=>{
    const results=await Promise.all([register(),register('NEW@example.test',{password:replacement,display_name:'Other'})]);expect(results).toEqual([{accepted:true},{accepted:true}]);
    expect((await database.pool.query('SELECT id FROM users')).rowCount).toBe(1);expect((await database.pool.query('SELECT id FROM email_tasks')).rowCount).toBe(1);
    const before=(await database.pool.query('SELECT password_hash,display_name,version FROM users')).rows[0];await cool();await register('NEW@example.test',{password:'Yet another replacement password'});
    expect((await database.pool.query('SELECT password_hash,display_name,version FROM users')).rows[0]).toEqual(before);
  });
  it('activates with the captured role after registration is closed and the current default changes',async()=>{
    const user=await pending();const role=randomUUID();await database.pool.query("INSERT INTO roles(id,code,name,is_registration_default_eligible) VALUES($1,'new-default','New default',true)",[role]);
    await database.pool.query("UPDATE system_settings SET registration_default_role_id=$1,typed_value=jsonb_set(typed_value,'{registration_open}','false') WHERE key='security'",[role]);
    expect(await auth.verify({token:user.token},meta())).toEqual({verified:true,login_required:true});
    expect((await database.pool.query('SELECT role_id FROM user_roles WHERE user_id=$1',[user.id])).rows).toEqual([{role_id:'00000000-0000-4000-8000-000000000003'}]);
    expect((await database.pool.query('SELECT registration_role_id FROM users')).rows[0].registration_role_id).toBeNull();expect((await database.pool.query('SELECT id FROM sessions')).rowCount).toBe(0);
    expect((await createLoginService(web,secrets,passwords)({email:'new@example.test',password},meta())).token).toHaveLength(43);
  });
  it('rejects an original registration role that became ineligible without switching roles',async()=>{
    const user=await pending();await database.pool.query("UPDATE roles SET is_registration_default_eligible=false WHERE code='user'");
    await expect(auth.verify({token:user.token},meta())).rejects.toMatchObject({code:'REGISTRATION_ROLE_INVALID'});
    expect((await database.pool.query('SELECT status FROM users')).rows[0].status).toBe('pending');expect((await database.pool.query('SELECT consumed_at FROM one_time_credentials')).rows[0].consumed_at).toBeNull();
  });
  it('lets only one concurrent verifier consume the token',async()=>{
    const user=await pending();const results=await Promise.allSettled([auth.verify({token:user.token},meta()),auth.verify({token:user.token},meta())]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((await database.pool.query('SELECT user_id FROM user_roles')).rowCount).toBe(1);
  });
  it('replaces verification tokens only after cooldown, even when registration is now closed',async()=>{
    const user=await pending();expect(await auth.resend({email:'new@example.test'},meta())).toEqual({accepted:true});expect((await mail()).payload.token).toBe(user.token);
    await cool();await database.pool.query("UPDATE system_settings SET typed_value=jsonb_set(typed_value,'{registration_open}','false') WHERE key='security'");
    await auth.resend({email:'new@example.test'},meta());const fresh=(await mail()).payload.token;expect(fresh).not.toBe(user.token);
    await expect(auth.verify({token:user.token},meta())).rejects.toMatchObject({code:'CREDENTIAL_INVALID'});await expect(auth.verify({token:fresh},meta())).resolves.toHaveProperty('verified',true);
  });
  it('suppresses resend and verification while a live email correction is pending',async()=>{
    const user=await pending();await cool();
    await database.pool.query("INSERT INTO email_change_requests(user_id,requested_by,initiated_by_self,new_email,normalized_new_email,expires_at) VALUES($1,$1,true,'fixed@example.test','fixed@example.test',clock_timestamp()+interval '1 hour')",[user.id]);
    expect(await auth.resend({email:'new@example.test'},meta())).toEqual({accepted:true});expect((await database.pool.query('SELECT id FROM email_tasks')).rowCount).toBe(1);
    await expect(auth.verify({token:user.token},meta())).rejects.toMatchObject({code:'CREDENTIAL_INVALID'});
  });
  it('rolls back registration, mail and quota together if audit insertion fails',async()=>{
    await database.pool.query("CREATE FUNCTION fail_registration_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit'; END $$; CREATE TRIGGER fail_registration_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_registration_audit()");
    await expect(register()).rejects.toBeDefined();expect((await database.pool.query('SELECT id FROM users')).rowCount).toBe(0);expect((await database.pool.query('SELECT id FROM email_tasks')).rowCount).toBe(0);
    expect((await database.pool.query("SELECT scope FROM rate_limit_buckets WHERE scope LIKE 'mail.%'")).rowCount).toBe(0);
  });
});

describe('anonymous mail requests and password reset',()=>{
  it('returns the same response for unknown, pending, suspended and active accounts',async()=>{
    const active=await identity(database.pool);const suspended=await identity(database.pool);await database.pool.query("UPDATE users SET status='suspended' WHERE id=$1",[suspended.userId]);await pending();
    for(const email of ['absent@example.test','new@example.test',`${suspended.userId}@example.test`,`${active.userId}@example.test`])expect(await auth.forgot({email},meta())).toEqual({accepted:true});
    expect((await database.pool.query("SELECT id FROM email_tasks WHERE purpose='password_reset'")).rowCount).toBe(1);
    await expect(authenticateRead(web,{token:active.token,epoch:secrets.epoch})).resolves.toBeDefined();
  });
  it('hides per-address cooldown but exposes source IP exhaustion',async()=>{
    const active=await identity(database.pool);const email=`${active.userId}@example.test`;
    await auth.forgot({email},meta());expect(await auth.forgot({email},meta())).toEqual({accepted:true});expect((await database.pool.query('SELECT id FROM email_tasks')).rowCount).toBe(1);
    await database.pool.query("UPDATE system_settings SET typed_value=jsonb_set(typed_value,'{mail_ip_per_hour}','1') WHERE key='security'");
    await expect(auth.forgot({email:'absent@example.test'},meta())).rejects.toMatchObject({code:'RATE_LIMITED'});
  });
  it('atomically replaces the password, revokes all sessions and other reset/recovery credentials, and queues a notification',async()=>{
    const active=await identity(database.pool);const email=`${active.userId}@example.test`;await auth.forgot({email},meta());const reset=await mail('password_reset');
    const recovery=issueToken();await database.pool.query("INSERT INTO one_time_credentials(purpose,token_hash,user_id,subject_version,target_email,normalized_target_email,credential_epoch,expires_at) VALUES('operator_recovery',$1,$2,1,$3,$3,'test-epoch',clock_timestamp()+interval '30 minutes')",[recovery.hash,active.userId,email]);
    expect(await auth.reset({token:reset.payload.token,new_password:replacement},meta())).toEqual({reset:true,login_required:true});
    const row=(await database.pool.query('SELECT password_hash,password_version,authorization_version,version FROM users WHERE id=$1',[active.userId])).rows[0];expect(await passwords.verify(row.password_hash,replacement)).toBe(true);expect(row).toMatchObject({password_version:2,authorization_version:2,version:2});
    await expect(authenticateRead(web,{token:active.token,epoch:secrets.epoch})).rejects.toMatchObject({code:'SESSION_INVALID'});
    expect((await database.pool.query("SELECT revoked_at FROM one_time_credentials WHERE purpose='operator_recovery'")).rows[0].revoked_at).not.toBeNull();expect((await mail('password_changed')).payload).not.toHaveProperty('token');
    await expect(auth.reset({token:reset.payload.token,new_password:password},meta())).rejects.toMatchObject({code:'CREDENTIAL_INVALID'});
  });
  it.each(['suspended','epoch','expired','version'])('rejects a %s reset credential without changing a password or reactivating the account',async reason=>{
    const active=await identity(database.pool);await auth.forgot({email:`${active.userId}@example.test`},meta());const token=(await mail('password_reset')).payload.token;
    if(reason==='suspended')await database.pool.query("UPDATE users SET status='suspended' WHERE id=$1",[active.userId]);
    if(reason==='epoch')await database.pool.query("UPDATE one_time_credentials SET credential_epoch='old-epoch'");
    if(reason==='expired')await database.pool.query("UPDATE one_time_credentials SET expires_at=clock_timestamp()-interval '5 minutes'");
    if(reason==='version')await database.pool.query('UPDATE users SET authorization_version=authorization_version+1 WHERE id=$1',[active.userId]);
    await expect(auth.reset({token,new_password:replacement},meta())).rejects.toMatchObject({code:'CREDENTIAL_INVALID'});
    expect((await database.pool.query('SELECT password_hash FROM users WHERE id=$1',[active.userId])).rows[0].password_hash).toBe('test-hash-not-for-login');
  });
  it('rolls back password and session changes if the security notification cannot be enqueued',async()=>{
    const active=await identity(database.pool);await auth.forgot({email:`${active.userId}@example.test`},meta());const token=(await mail('password_reset')).payload.token;
    await database.pool.query("CREATE FUNCTION fail_notification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.purpose='password_changed' THEN RAISE EXCEPTION 'test notification'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_notification BEFORE INSERT ON email_tasks FOR EACH ROW EXECUTE FUNCTION fail_notification()");
    await expect(auth.reset({token,new_password:replacement},meta())).rejects.toBeDefined();
    expect((await database.pool.query('SELECT password_version FROM users WHERE id=$1',[active.userId])).rows[0].password_version).toBe(1);await expect(authenticateRead(web,{token:active.token,epoch:secrets.epoch})).resolves.toBeDefined();
    expect((await database.pool.query('SELECT consumed_at FROM one_time_credentials')).rows[0].consumed_at).toBeNull();
  });
});

describe('authority changes during password hashing',()=>{
  it('rechecks registration closure after hashing without holding a coordination lock',async()=>{
    const racing=createPublicAuthService(web,secrets,{verify:passwords.verify,hash:async(value,minimum)=>{
      const hash=await passwords.hash(value,minimum);
      const client=await database.pool.connect();
      try{await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='500ms'");await client.query('SELECT id FROM system_state WHERE id=1 FOR UPDATE');
        await client.query("UPDATE system_settings SET typed_value=jsonb_set(typed_value,'{registration_open}','false') WHERE key='security'");await client.query('COMMIT');
      }finally{await client.query('ROLLBACK');client.release();}
      return hash;
    }});
    await expect(racing.register({email:'race@example.test',password,display_name:'Race'},meta())).rejects.toMatchObject({code:'REGISTRATION_DISABLED'});
    expect((await database.pool.query('SELECT id FROM users')).rowCount).toBe(0);
  });
  it('rechecks account suspension after reset hashing and preserves existing credentials',async()=>{
    const active=await identity(database.pool);await auth.forgot({email:`${active.userId}@example.test`},meta());const token=(await mail('password_reset')).payload.token;
    const racing=createPublicAuthService(web,secrets,{verify:passwords.verify,hash:async(value,minimum)=>{
      const hash=await passwords.hash(value,minimum);await database.pool.query("UPDATE users SET status='suspended' WHERE id=$1",[active.userId]);return hash;
    }});
    await expect(racing.reset({token,new_password:replacement},meta())).rejects.toMatchObject({code:'CREDENTIAL_INVALID'});
    expect((await database.pool.query('SELECT status,password_version FROM users WHERE id=$1',[active.userId])).rows[0]).toEqual({status:'suspended',password_version:1});
  });
  it('allows only one concurrent password reset to update the user and enqueue a notification',async()=>{
    const active=await identity(database.pool);await auth.forgot({email:`${active.userId}@example.test`},meta());const token=(await mail('password_reset')).payload.token;
    const results=await Promise.allSettled([auth.reset({token,new_password:replacement},meta()),auth.reset({token,new_password:password},meta())]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect((await database.pool.query('SELECT password_version FROM users WHERE id=$1',[active.userId])).rows[0].password_version).toBe(2);
    expect((await database.pool.query("SELECT id FROM email_tasks WHERE purpose='password_changed'")).rowCount).toBe(1);
  });
});
