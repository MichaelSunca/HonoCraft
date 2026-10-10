import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { startTestPostgres } from '../helpers/postgres.js';
import { identity,initializedDatabase } from '../helpers/identity.js';
import { migrate } from '../../apps/server/src/infrastructure/migrations.js';
import { loadConfig } from '../../apps/server/src/infrastructure/config.js';
import { createPasswordService } from '../../apps/server/src/infrastructure/passwords.js';
import { initializeBootstrap } from '../../apps/server/src/modules/auth/bootstrap.js';
import { decryptPayload } from '../../apps/server/src/infrastructure/crypto.js';
import { mailAad } from '../../apps/server/src/modules/mail/outbox.js';
import { startHttpServer } from '../../apps/server/src/http/app.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>;
let server:ReturnType<typeof startHttpServer>;let base:string;let email:string;let userId:string;
let cookie:string;let csrf:string;const mailKeyring={activeKeyId:'v1',keys:new Map([['v1',Buffer.alloc(32,4)]])};
const origin='https://app.example.test';const password='A long secret passphrase 测试';
const json=(body:unknown,extra:Record<string,string>={})=>({method:'POST',headers:{'content-type':'application/json',origin,...extra},body:JSON.stringify(body)});
beforeAll(async()=>{
  database=await startTestPostgres();await migrate(database.pool);await initializedDatabase(database.pool);
  const passwords=await createPasswordService({concurrency:2,blockedPasswords:new Set<string>()});
  const user=await identity(database.pool);userId=user.userId;email=`${userId}@example.test`;
  await database.pool.query('UPDATE users SET password_hash=$2 WHERE id=$1',[userId,await passwords.hash(password)]);
  const config=loadConfig({NODE_ENV:'production',PUBLIC_ORIGIN:origin,DATABASE_URL:database.connectionString,
    SMTP_HOST:'smtp.example.test',SMTP_PORT:'587',MAIL_MODE:'smtp',MAIL_FROM:'noreply@example.test',FILE_STORAGE_ROOT:'.local/media',
    MAIL_PAYLOAD_KEYRING_FILE:'.local/secrets/mail.json',DIGEST_KEY_FILE:'.local/secrets/digest',CSRF_KEY_FILE:'.local/secrets/csrf',CREDENTIAL_EPOCH_FILE:'.local/secrets/epoch'});
  server=startHttpServer({pool:database.pool,config,passwords,secrets:{mailKeyring,epoch:'test-epoch',csrfKey:Buffer.alloc(32,3),digestKey:{id:'test-v1',key:Buffer.alloc(32,7)}}},0);
  if(!server.listening)await new Promise<void>(resolve=>server.once('listening',resolve));
  base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async()=>{if(server)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await database?.close();});

describe('HTTP authentication and request security',()=>{
  it('logs in over HTTP and sets a host-only secure session cookie after commit',async()=>{
    const response=await fetch(base+'/api/v1/auth/login',json({email,password}));
    expect(response.status).toBe(200);const body=await response.json();expect(body.data).toEqual({authenticated:true});
    const header=response.headers.get('set-cookie')!;
    expect(header).toContain('__Host-honocraft_session=');expect(header).toContain('HttpOnly');expect(header).toContain('Secure');expect(header).toContain('SameSite=Lax');expect(header).toContain('Path=/');expect(header).not.toMatch(/Domain=|Max-Age=/i);
    cookie=header.split(';')[0]!;
    expect(JSON.stringify(body)).not.toContain(cookie.split('=')[1]);
  });
  it('returns only safe identity fields and a session-bound CSRF value',async()=>{
    const supplied=randomUUID();
    const response=await fetch(base+'/api/v1/me',{headers:{cookie,'x-request-id':supplied}});
    expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const body=await response.json();csrf=body.data.csrf_token;
    expect(body.data.instance).toMatchObject({instance_name:'HonoCraft'});expect(body.data.user).toMatchObject({id:userId,email,status:'active'});expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.request_id).not.toBe(supplied);expect(JSON.stringify(body)).not.toMatch(/password_hash|password_version|token_hash|credential_epoch/);
  });
  it('rejects missing or foreign origins for authenticated writes',async()=>{
    for(const value of [undefined,'https://evil.example.test']){
      const headers:Record<string,string>={'content-type':'application/json',cookie,'x-csrf-token':csrf};if(value)headers.origin=value;
      const response=await fetch(base+'/api/v1/me',{method:'PATCH',headers,body:JSON.stringify({expected_version:1,theme:'dark'})});
      expect(response.status).toBe(403);expect((await response.json()).error.code).toBe('ORIGIN_INVALID');
    }
  });
  it('rejects a missing CSRF token and then permits the authorized profile update',async()=>{
    const denied=await fetch(base+'/api/v1/me',{...json({expected_version:1,theme:'dark'},{cookie}),method:'PATCH'});
    expect(denied.status).toBe(403);expect((await denied.json()).error.code).toBe('CSRF_INVALID');
    const response=await fetch(base+'/api/v1/me',{...json({expected_version:1,theme:'dark'},{cookie,'x-csrf-token':csrf}),method:'PATCH'});
    expect(response.status).toBe(200);expect((await response.json()).data).toMatchObject({theme:'dark',version:2});
  });
  it('rejects non-JSON and malformed JSON without echoing request secrets',async()=>{
    const response=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{origin,'content-type':'text/plain'},body:password});
    expect(response.status).toBe(415);expect(await response.text()).not.toContain(password);
    const bad=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{secret'});
    expect(bad.status).toBe(422);expect(await bad.text()).not.toContain('{secret');
  });
  it('bounds streamed JSON bodies without relying on Content-Length',async()=>{
    const result=await new Promise<{status:number;body:string}>((resolve,reject)=>{
      const request=httpRequest(base+'/api/v1/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'}},response=>{
        let body='';response.on('data',chunk=>{body+=chunk;});response.on('end',()=>resolve({status:response.statusCode!,body}));
      });request.on('error',reject);request.write('"');request.write('x'.repeat(70_000));request.end('"');
    });
    expect(result.status).toBe(413);expect(JSON.parse(result.body).error.code).toBe('PAYLOAD_TOO_LARGE');
  });
  it('returns JSON for unknown API routes and retains security headers on errors',async()=>{
    const response=await fetch(base+'/api/v1/does-not-exist');expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");expect((await response.json()).error.code).toBe('NOT_FOUND');
  });
  it('requires CSRF on valid logout, revokes the session, and permits an expired logout to clear the cookie',async()=>{
    const denied=await fetch(base+'/api/v1/auth/logout',json({},{cookie}));expect(denied.status).toBe(403);expect(denied.headers.get('set-cookie')).toBeNull();
    const response=await fetch(base+'/api/v1/auth/logout',json({},{cookie,'x-csrf-token':csrf}));expect(response.status).toBe(200);expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await fetch(base+'/api/v1/me',{headers:{cookie}})).status).toBe(401);
    const again=await fetch(base+'/api/v1/auth/logout',json({},{cookie}));expect(again.status).toBe(200);expect(again.headers.get('set-cookie')).toContain('Max-Age=0');
  });
  it('exposes minimal public settings and permits bootstrap completion while other APIs are gated',async()=>{
    await database.pool.query("UPDATE system_state SET initialization_status='uninitialized',initialized_at=NULL WHERE id=1");
    try {
      const settings=await fetch(base+'/api/v1/public/settings');expect(settings.status).toBe(200);
      expect((await settings.json()).data).toMatchObject({initialized:false,registration_open:false,instance_name:'HonoCraft',password_min_length:15});
      expect((await fetch(base+'/api/v1/auth/login',json({email,password}))).status).toBe(503);
      await initializeBootstrap(database.pool,{mailKeyring,epoch:'test-epoch',digestKey:Buffer.alloc(32,7)},{email:'bootstrap-http@example.test'}, {requestId:randomUUID(),ip:'127.0.0.1',userAgent:'test'});
      const task=(await database.pool.query("SELECT * FROM email_tasks WHERE purpose='bootstrap'")).rows[0];
      const token=JSON.parse(decryptPayload(mailKeyring,{keyId:task.key_id,nonce:task.nonce,tag:task.auth_tag,ciphertext:task.payload_ciphertext},mailAad(task.id,task.purpose,task.template_version))).token;
      const response=await fetch(base+'/api/v1/auth/bootstrap/complete',json({token,password,display_name:'HTTP administrator'}));
      expect(response.status).toBe(200);expect((await response.json()).data).toEqual({initialized:true,login_required:true});expect(response.headers.get('set-cookie')).toBeNull();
      expect((await fetch(base+'/api/v1/auth/bootstrap/create',json({email:'forged@example.test'}))).status).toBe(404);
    }finally{await initializedDatabase(database.pool);}
  });

  it('supports registration, verification and password recovery over the public HTTP routes',async()=>{
    await database.pool.query("UPDATE system_settings SET typed_value=jsonb_set(typed_value,'{registration_open}','true') WHERE key='security'");
    const account='public-http@example.test';
    const issuedToken=async(purpose:string)=>{
      const task=(await database.pool.query("SELECT * FROM email_tasks WHERE purpose=$1 AND recipient=$2 AND status='queued' ORDER BY created_at DESC LIMIT 1",[purpose,account])).rows[0];
      return JSON.parse(decryptPayload(mailKeyring,{keyId:task.key_id,nonce:task.nonce,tag:task.auth_tag,ciphertext:task.payload_ciphertext},mailAad(task.id,task.purpose,task.template_version))).token;
    };
    const registration=await fetch(base+'/api/v1/auth/register',json({email:account,password,display_name:'Public user'}));
    expect(registration.status).toBe(202);expect((await registration.json()).data).toEqual({accepted:true});expect(registration.headers.get('set-cookie')).toBeNull();
    const pendingLogin=await fetch(base+'/api/v1/auth/login',json({email:account,password}));expect(pendingLogin.status).toBe(403);
    const verification=await fetch(base+'/api/v1/auth/email/verify',json({token:await issuedToken('email_verify')}));
    expect(verification.status).toBe(200);expect((await verification.json()).data).toEqual({verified:true,login_required:true});
    const login=await fetch(base+'/api/v1/auth/login',json({email:account,password}));expect(login.status,JSON.stringify({response:await login.clone().json(),buckets:(await database.pool.query('SELECT scope,count,last_accepted_at,clock_timestamp() FROM rate_limit_buckets')).rows})).toBe(200);const ownCookie=login.headers.get('set-cookie')!.split(';')[0]!;
    const forgotten=await fetch(base+'/api/v1/auth/password/forgot',json({email:account}));expect(forgotten.status).toBe(202);expect((await forgotten.json()).data).toEqual({accepted:true});
    expect((await fetch(base+'/api/v1/me',{headers:{cookie:ownCookie}})).status).toBe(200);
    const freshPassword='Public HTTP replacement passphrase';
    const reset=await fetch(base+'/api/v1/auth/password/reset',json({token:await issuedToken('password_reset'),new_password:freshPassword},{cookie:ownCookie}));
    expect(reset.status).toBe(200);expect((await reset.json()).data).toEqual({reset:true,login_required:true});expect(reset.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await fetch(base+'/api/v1/me',{headers:{cookie:ownCookie}})).status).toBe(401);
    expect((await fetch(base+'/api/v1/auth/login',json({email:account,password:freshPassword}))).status).toBe(200);
  });
  it('uses uniform resend responses and applies Origin and strict-body checks to public auth',async()=>{
    const absent=await fetch(base+'/api/v1/auth/email/resend',json({email:'not-present@example.test'}));expect(absent.status,JSON.stringify({response:await absent.clone().json(),buckets:(await database.pool.query('SELECT scope,count,last_accepted_at,clock_timestamp() FROM rate_limit_buckets')).rows})).toBe(202);expect((await absent.json()).data).toEqual({accepted:true});
    const forged=await fetch(base+'/api/v1/auth/password/forgot',json({email:'not-present@example.test'},{origin:'https://foreign.example.test'}));expect(forged.status).toBe(403);
    const extra=await fetch(base+'/api/v1/auth/register',json({email:'not-present@example.test',password,display_name:'No',role_ids:['super_admin']}));expect(extra.status).toBe(422);
    const get=await fetch(base+'/api/v1/auth/email/verify');expect(get.status).toBe(404);
  });

});
