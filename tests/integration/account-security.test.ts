import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {startTestPostgres} from '../helpers/postgres.js';
import {identity,initializedDatabase,sessionFor} from '../helpers/identity.js';
import {migrate} from '../../apps/server/src/infrastructure/migrations.js';
import {createPasswordService,type PasswordService} from '../../apps/server/src/infrastructure/passwords.js';
import {csrfForSession,issueToken,tokenDigest} from '../../apps/server/src/infrastructure/crypto.js';
import {createAccountSecurity} from '../../apps/server/src/modules/auth/account-security.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>,passwords:PasswordService,hash:string;
const currentPassword='A valid current password phrase',newPassword='A different newly chosen secret phrase';
const secrets={epoch:'test-epoch',csrfKey:Buffer.alloc(32,3),digestKey:{id:'test-v1',key:Buffer.alloc(32,7)},mailKeyring:{activeKeyId:'v1',keys:new Map([['v1',Buffer.alloc(32,4)]])}};
let source=1;const meta=()=>({requestId:randomUUID(),ip:`127.0.1.${source++}`,userAgent:'account security test'});
const ref=(user:{token:string;sessionId:string})=>({token:user.token,csrfToken:csrfForSession(secrets.csrfKey,user.sessionId,secrets.epoch)});
beforeAll(async()=>{database=await startTestPostgres();await migrate(database.pool);await initializedDatabase(database.pool);passwords=await createPasswordService({concurrency:2,blockedPasswords:new Set(['blocked password phrase'])});hash=await passwords.hash(currentPassword);});
afterAll(async()=>{await database.close();});
async function actor(){const user=await identity(database.pool);await database.pool.query('UPDATE users SET password_hash=$2 WHERE id=$1',[user.userId,hash]);return user;}
async function diagnose<T>(token:string,run:()=>Promise<T>):Promise<T>{
  try{return await run();}catch(error){
    if(error instanceof Error&&'code' in error&&error.code==='SESSION_INVALID')console.info('account security clock diagnostic',(await database.pool.query('SELECT last_seen_at,clock_timestamp() observed_at,extract(epoch FROM (last_seen_at-clock_timestamp()))*1000 AS future_ms,revoked_at,idle_expires_at,absolute_expires_at FROM sessions WHERE token_hash=$1',[tokenDigest(token)])).rows);
    throw error;
  }
}
function service(p=passwords){const value=createAccountSecurity(database.pool,secrets,p);return {
  reauthenticate:(...args:Parameters<typeof value.reauthenticate>)=>diagnose(args[0].token,()=>value.reauthenticate(...args)),
  changePassword:(...args:Parameters<typeof value.changePassword>)=>diagnose(args[0].token,()=>value.changePassword(...args)),
};}
it('reauthenticates only the current session for exactly five minutes',async()=>{
  const user=await actor(),other=await sessionFor(database.pool,user.userId);const result=await service().reauthenticate(ref(user),{current_password:currentPassword},meta());
  expect(new Date(result.data.valid_until).getTime()-new Date(result.data.reauthenticated_at).getTime()).toBe(300000);
  expect((await database.pool.query('SELECT reauthenticated_at FROM sessions WHERE id=$1',[user.sessionId])).rows[0].reauthenticated_at).not.toBeNull();
  expect((await database.pool.query('SELECT reauthenticated_at FROM sessions WHERE id=$1',[other.sessionId])).rows[0].reauthenticated_at).toBeNull();
});
it('does not refresh successful verification on failure and enforces the shared account lock',async()=>{
  const user=await actor();const stamp=new Date(Date.now()-60000);await database.pool.query('UPDATE sessions SET reauthenticated_at=$2 WHERE id=$1',[user.sessionId,stamp]);
  for(let i=0;i<5;i++)await expect(service().reauthenticate(ref(user),{current_password:'incorrect password'},meta())).rejects.toMatchObject({code:'AUTH_FAILED'});
  await expect(service().reauthenticate(ref(user),{current_password:currentPassword},meta())).rejects.toMatchObject({code:'AUTH_FAILED'});
  expect((await database.pool.query('SELECT reauthenticated_at FROM sessions WHERE id=$1',[user.sessionId])).rows[0].reauthenticated_at).toEqual(stamp);
  expect((await database.pool.query('SELECT locked_until FROM users WHERE id=$1',[user.userId])).rows[0].locked_until).not.toBeNull();
  expect((await database.pool.query("SELECT id FROM security_events WHERE user_id=$1 AND event_type='auth.reauthenticate' AND result='denied'",[user.userId])).rowCount).toBeGreaterThanOrEqual(5);
});
it('requires CSRF before invoking a password hash verifier',async()=>{
  const user=await actor();let checked=false;const p={...passwords,verify:async()=>{checked=true;return true;}};
  await expect(service(p).reauthenticate({...ref(user),csrfToken:''},{current_password:currentPassword},meta())).rejects.toMatchObject({code:'CSRF_INVALID'});expect(checked).toBe(false);
});
it('rechecks password version after verification outside database locks',async()=>{
  const user=await actor();const p={...passwords,verify:async(encoded:string|null,password:string)=>{
    const verified=await passwords.verify(encoded,password);const client=await database.pool.connect();try{await client.query('BEGIN');await client.query('SELECT id FROM system_state WHERE id=1 FOR UPDATE NOWAIT');await client.query('UPDATE users SET password_version=password_version+1 WHERE id=$1',[user.userId]);await client.query('COMMIT');}finally{client.release();}return verified;
  }};
  await expect(service(p).reauthenticate(ref(user),{current_password:currentPassword},meta())).rejects.toMatchObject({code:'AUTH_FAILED'});
  expect((await database.pool.query('SELECT reauthenticated_at FROM sessions WHERE id=$1',[user.sessionId])).rows[0].reauthenticated_at).toBeNull();
});
it('changes the password, revokes all sessions and pending recovery credentials, and queues one notification',async()=>{
  const user=await actor();await sessionFor(database.pool,user.userId);const token=issueToken();
  await database.pool.query("INSERT INTO one_time_credentials(purpose,token_hash,credential_epoch,user_id,target_email,normalized_target_email,subject_version,expires_at) SELECT 'password_reset',$2,'test-epoch',id,email,normalized_email,authorization_version,clock_timestamp()+interval '30 minutes' FROM users WHERE id=$1",[user.userId,token.hash]);
  const result=await service().changePassword(ref(user),{expected_version:1,current_password:currentPassword,new_password:newPassword},meta(),randomUUID());expect(result.data).toEqual({changed:true,login_required:true});
  const row=(await database.pool.query('SELECT password_hash,password_version,authorization_version,version FROM users WHERE id=$1',[user.userId])).rows[0];expect(row).toMatchObject({password_version:2,authorization_version:2,version:2});expect(await passwords.verify(row.password_hash,newPassword)).toBe(true);expect(await passwords.verify(row.password_hash,currentPassword)).toBe(false);
  expect((await database.pool.query('SELECT id FROM sessions WHERE user_id=$1 AND revoked_at IS NULL',[user.userId])).rowCount).toBe(0);
  expect((await database.pool.query('SELECT revoked_at FROM one_time_credentials WHERE user_id=$1',[user.userId])).rows[0].revoked_at).not.toBeNull();
  expect((await database.pool.query("SELECT id FROM email_tasks WHERE purpose='password_changed'")).rowCount).toBe(1);
  const audit=(await database.pool.query("SELECT changes FROM audit_events WHERE actor_id=$1 AND action='auth.password.changed'",[user.userId])).rows;expect(audit).toHaveLength(1);expect(JSON.stringify(audit)).not.toContain(newPassword);
});
it('rejects a stale editing version without changing the password or revoking sessions',async()=>{
  const user=await actor();await expect(service().changePassword(ref(user),{expected_version:2,current_password:currentPassword,new_password:newPassword},meta(),randomUUID())).rejects.toMatchObject({code:'VERSION_CONFLICT'});
  expect((await database.pool.query('SELECT password_hash,version FROM users WHERE id=$1',[user.userId])).rows[0]).toEqual({password_hash:hash,version:1});expect((await database.pool.query('SELECT revoked_at FROM sessions WHERE id=$1',[user.sessionId])).rows[0].revoked_at).toBeNull();
});
it('rejects blocked new passwords and missing idempotency keys',async()=>{
  const user=await actor();await expect(service().changePassword(ref(user),{expected_version:1,current_password:currentPassword,new_password:'blocked password phrase'},meta(),randomUUID())).rejects.toMatchObject({code:'PASSWORD_REJECTED'});
  await expect(service().changePassword(ref(user),{expected_version:1,current_password:currentPassword,new_password:newPassword},meta(),undefined)).rejects.toMatchObject({code:'VALIDATION_ERROR'});
});
it('rechecks a tightened password policy after hashing outside the transaction',async()=>{
  const user=await actor();const p={...passwords,hash:async(password:string,minimum?:number)=>{const encoded=await passwords.hash(password,minimum);await database.pool.query("UPDATE system_settings SET typed_value=jsonb_set(typed_value,'{password_min_length}','100') WHERE key='security'");return encoded;}};
  try{await expect(service(p).changePassword(ref(user),{expected_version:1,current_password:currentPassword,new_password:newPassword},meta(),randomUUID())).rejects.toMatchObject({code:'PASSWORD_REJECTED'});}finally{await database.pool.query("UPDATE system_settings SET typed_value=jsonb_set(typed_value,'{password_min_length}','15') WHERE key='security'");}
  expect((await database.pool.query('SELECT password_hash FROM users WHERE id=$1',[user.userId])).rows[0].password_hash).toBe(hash);
});
it('commits IP limits independently and refuses excess checks before hashing',async()=>{
  const user=await actor(),request=meta();let checks=0;const p={...passwords,verify:async(encoded:string|null,password:string)=>{checks++;return passwords.verify(encoded,password);}};
  await database.pool.query("UPDATE system_settings SET typed_value=jsonb_set(typed_value,'{login_ip_per_minute}','2') WHERE key='security'");
  try{for(let i=0;i<2;i++)await expect(service(p).reauthenticate(ref(user),{current_password:'incorrect'},request)).rejects.toMatchObject({code:'AUTH_FAILED'});await expect(service(p).reauthenticate(ref(user),{current_password:currentPassword},request)).rejects.toMatchObject({code:'RATE_LIMITED'});expect(checks).toBe(2);}
  finally{await database.pool.query("UPDATE system_settings SET typed_value=jsonb_set(typed_value,'{login_ip_per_minute}','20') WHERE key='security'");}
});
it('rolls back password, session revocation, notification and idempotency when success audit fails',async()=>{
  const user=await actor();const before=(await database.pool.query('SELECT count(*)::int n FROM email_tasks')).rows[0].n;
  await database.pool.query("CREATE FUNCTION reject_password_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='auth.password.changed' AND NEW.result='success' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_password_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_password_audit()");
  try{await expect(service().changePassword(ref(user),{expected_version:1,current_password:currentPassword,new_password:newPassword},meta(),randomUUID())).rejects.toThrow();}
  finally{await database.pool.query('DROP TRIGGER reject_password_audit ON audit_events; DROP FUNCTION reject_password_audit()');}
  expect((await database.pool.query('SELECT password_hash,version FROM users WHERE id=$1',[user.userId])).rows[0]).toEqual({password_hash:hash,version:1});expect((await database.pool.query('SELECT revoked_at FROM sessions WHERE id=$1',[user.sessionId])).rows[0].revoked_at).toBeNull();
  expect((await database.pool.query('SELECT count(*)::int n FROM email_tasks')).rows[0].n).toBe(before);expect((await database.pool.query('SELECT id FROM idempotency_records WHERE actor_id=$1',[user.userId])).rowCount).toBe(0);
});
it('supports reauthentication and password change with the restricted web database role',async()=>{
  const user=await actor(),{default:pg}=await import('pg');const url=new URL(database.connectionString);url.searchParams.set('options','-c role=honocraft_web');const restricted=new pg.Pool({connectionString:url.href,max:2});
  try{const secure=createAccountSecurity(restricted,secrets,passwords);expect((await secure.reauthenticate(ref(user),{current_password:currentPassword},meta())).data).toHaveProperty('valid_until');expect((await secure.changePassword(ref(user),{expected_version:1,current_password:currentPassword,new_password:newPassword},meta(),randomUUID())).data).toEqual({changed:true,login_required:true});}finally{await restricted.end();}
});
it('does not let an idempotent password-change replay bypass a newly active account lock',async()=>{
  const user=await actor(),key=randomUUID(),input={expected_version:1,current_password:currentPassword,new_password:currentPassword};
  await service().changePassword(ref(user),input,meta(),key);
  const next=await sessionFor(database.pool,user.userId);
  for(let i=0;i<5;i++)await expect(service().reauthenticate(ref(next),{current_password:'incorrect'},meta())).rejects.toMatchObject({code:'AUTH_FAILED'});
  await expect(service().changePassword(ref(next),input,meta(),key)).rejects.toMatchObject({code:'AUTH_FAILED'});
});
