import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { startTestPostgres } from '../helpers/postgres.js';
import { identity,initializedDatabase } from '../helpers/identity.js';
import { migrate } from '../../apps/server/src/infrastructure/migrations.js';
import { createPasswordService } from '../../apps/server/src/infrastructure/passwords.js';
import { createLoginService } from '../../apps/server/src/modules/auth/login.js';
import { authenticateRead } from '../../apps/server/src/modules/auth/sessions.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>;
let passwords:Awaited<ReturnType<typeof createPasswordService>>;
let login:ReturnType<typeof createLoginService>;
const password='Correct horse battery staple 登录';let hash:string;let ip=1;
const meta=()=>({requestId:randomUUID(),ip:`192.0.2.${ip++}`,userAgent:'login test'});
beforeAll(async()=>{
  database=await startTestPostgres();await migrate(database.pool);await initializedDatabase(database.pool);
  passwords=await createPasswordService({concurrency:2,blockedPasswords:new Set<string>()});hash=await passwords.hash(password);
  login=createLoginService(database.pool,{epoch:'test-epoch',digestKey:Buffer.alloc(32,8)},passwords);
});
afterAll(async()=>{await database?.close();});
async function account(status='active') {
  const user=await identity(database.pool);
  await database.pool.query("UPDATE users SET password_hash=$2,status=$3,email_verified_at=CASE WHEN $3='pending' THEN NULL ELSE email_verified_at END,creation_source='registration' WHERE id=$1",[user.userId,hash,status]);
  return {...user,email:`${user.userId}@example.test`};
}

describe('password login with authoritative database state',()=>{
  it('issues a new session after password verification without marking recent authentication',async()=>{
    const user=await account();const request=meta();
    const result=await login({email:user.email.toUpperCase(),password},request);
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(result.token).not.toBe(user.token);
    const authenticated=await authenticateRead(database.pool,{token:result.token,epoch:'test-epoch'});
    expect(authenticated.actor.userId).toBe(user.userId);expect(authenticated.reauthenticatedAt).toBeNull();
    const events=(await database.pool.query('SELECT event_type,result FROM security_events WHERE request_id=$1',[request.requestId])).rows;
    expect(events).toContainEqual({event_type:'auth.login',result:'success'});
    expect((await database.pool.query('SELECT id FROM audit_events WHERE request_id=$1',[request.requestId])).rowCount).toBe(1);
  });
  it('gives the same generic error for a wrong password and a missing account',async()=>{
    const user=await account();
    await expect(login({email:user.email,password:'incorrect password'},meta())).rejects.toMatchObject({code:'AUTH_FAILED'});
    await expect(login({email:'unknown@example.test',password:'incorrect password'},meta())).rejects.toMatchObject({code:'AUTH_FAILED'});
  });
  it('reveals pending verification only after the correct password',async()=>{
    const user=await account('pending');
    await expect(login({email:user.email,password:'incorrect password'},meta())).rejects.toMatchObject({code:'AUTH_FAILED'});
    await expect(login({email:user.email,password},meta())).rejects.toMatchObject({code:'EMAIL_VERIFICATION_REQUIRED'});
    expect((await database.pool.query('SELECT id FROM sessions WHERE user_id=$1',[user.userId])).rowCount).toBe(1);
  });
  it('does not create a session for a suspended account even with a correct password',async()=>{
    const user=await account('suspended');
    await expect(login({email:user.email,password},meta())).rejects.toMatchObject({code:'AUTH_FAILED'});
  });
  it('prevents a correct password from bypassing an account lock after five failures',async()=>{
    const user=await account();
    for(let i=0;i<5;i++)await expect(login({email:user.email,password:'incorrect password'},meta())).rejects.toMatchObject({code:'AUTH_FAILED'});
    await expect(login({email:user.email,password},meta())).rejects.toMatchObject({code:'AUTH_FAILED'});
    expect((await database.pool.query('SELECT locked_until FROM users WHERE id=$1',[user.userId])).rows[0].locked_until).toBeInstanceOf(Date);
  });
  it('rejects an obsolete password verification if a concurrent change commits during hashing',async()=>{
    const user=await account();let checked=false;
    // Intercept only the slow boundary; use the real Argon2 verifier before committing a concurrent password change.
    const concurrent=createLoginService(database.pool,{epoch:'test-epoch',digestKey:Buffer.alloc(32,8)},{
      ...passwords,verify:async(encoded,value)=>{
        const result=await passwords.verify(encoded,value);
        await database.pool.query('UPDATE users SET password_version=password_version+1 WHERE id=$1',[user.userId]);checked=true;return result;
      },
    });
    await expect(concurrent({email:user.email,password},meta())).rejects.toMatchObject({code:'AUTH_FAILED'});
    expect(checked).toBe(true);
    expect((await database.pool.query('SELECT id FROM sessions WHERE user_id=$1',[user.userId])).rowCount).toBe(1);
  });
  it('enforces the shared source quota independently of a failed login transaction',async()=>{
    const request={...meta(),ip:'198.51.100.42'};
    await database.pool.query("UPDATE system_settings SET typed_value=jsonb_set(typed_value,'{login_ip_per_minute}','1') WHERE key='security'");
    try {
      await expect(login({email:'missing-limit@example.test',password},request)).rejects.toMatchObject({code:'AUTH_FAILED'});
      await expect(login({email:'another-missing@example.test',password},request)).rejects.toMatchObject({code:'RATE_LIMITED'});
    } finally {await database.pool.query("UPDATE system_settings SET typed_value=jsonb_set(typed_value,'{login_ip_per_minute}','20') WHERE key='security'");}
  });
});
