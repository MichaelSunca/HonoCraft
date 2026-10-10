import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { startTestPostgres } from '../helpers/postgres.js';
import { identity,initializedDatabase } from '../helpers/identity.js';
import { migrate } from '../../apps/server/src/infrastructure/migrations.js';
import { loadConfig } from '../../apps/server/src/infrastructure/config.js';
import { createPasswordService } from '../../apps/server/src/infrastructure/passwords.js';
import { startHttpServer } from '../../apps/server/src/http/app.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>;
let server:ReturnType<typeof startHttpServer>;let base:string;let email:string;let userId:string;
let cookie:string;let csrf:string;const origin='https://app.example.test';const password='A long secret passphrase 测试';
const json=(body:unknown,extra:Record<string,string>={})=>({method:'POST',headers:{'content-type':'application/json',origin,...extra},body:JSON.stringify(body)});
beforeAll(async()=>{
  database=await startTestPostgres();await migrate(database.pool);await initializedDatabase(database.pool);
  const passwords=await createPasswordService({concurrency:2,blockedPasswords:new Set<string>()});
  const user=await identity(database.pool);userId=user.userId;email=`${userId}@example.test`;
  await database.pool.query('UPDATE users SET password_hash=$2 WHERE id=$1',[userId,await passwords.hash(password)]);
  const config=loadConfig({NODE_ENV:'production',PUBLIC_ORIGIN:origin,DATABASE_URL:database.connectionString,
    SMTP_HOST:'smtp.example.test',SMTP_PORT:'587',MAIL_MODE:'smtp',MAIL_FROM:'noreply@example.test',FILE_STORAGE_ROOT:'.local/media',
    MAIL_PAYLOAD_KEYRING_FILE:'.local/secrets/mail.json',DIGEST_KEY_FILE:'.local/secrets/digest',CSRF_KEY_FILE:'.local/secrets/csrf',CREDENTIAL_EPOCH_FILE:'.local/secrets/epoch'});
  server=startHttpServer({pool:database.pool,config,passwords,secrets:{epoch:'test-epoch',csrfKey:Buffer.alloc(32,3),digestKey:{id:'test-v1',key:Buffer.alloc(32,7)}}},0);
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
    expect(body.data.user).toMatchObject({id:userId,email,status:'active'});expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
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
});
