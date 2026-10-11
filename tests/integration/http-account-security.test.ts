import type {AddressInfo} from 'node:net';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {startTestPostgres} from '../helpers/postgres.js';
import {identity,initializedDatabase,sessionFor} from '../helpers/identity.js';
import {migrate} from '../../apps/server/src/infrastructure/migrations.js';
import {createPasswordService} from '../../apps/server/src/infrastructure/passwords.js';
import {csrfForSession} from '../../apps/server/src/infrastructure/crypto.js';
import {loadConfig} from '../../apps/server/src/infrastructure/config.js';
import {startHttpServer} from '../../apps/server/src/http/app.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>,server:ReturnType<typeof startHttpServer>,base:string,hash:string;
const origin='https://workspace.example.test',password='The current security test password';
const secrets={epoch:'test-epoch',csrfKey:Buffer.alloc(32,3),digestKey:{id:'test-v1',key:Buffer.alloc(32,7)},mailKeyring:{activeKeyId:'v1',keys:new Map([['v1',Buffer.alloc(32,4)]])}};
beforeAll(async()=>{
  database=await startTestPostgres();await migrate(database.pool);await initializedDatabase(database.pool);
  const passwords=await createPasswordService({concurrency:2,blockedPasswords:new Set()});hash=await passwords.hash(password);
  const config=loadConfig({NODE_ENV:'test',PUBLIC_ORIGIN:origin,DATABASE_URL:database.connectionString,MAIL_MODE:'capture',SMTP_HOST:'127.0.0.1',SMTP_PORT:'1025',MAIL_FROM:'test@example.test',FILE_STORAGE_ROOT:'.local/test-media',EXAMPLE_NOTES_ENABLED:'false',MAIL_PAYLOAD_KEYRING_FILE:'test-mail',DIGEST_KEY_FILE:'test-digest',CSRF_KEY_FILE:'test-csrf',CREDENTIAL_EPOCH_FILE:'test-epoch'});
  server=startHttpServer({pool:database.pool,config,passwords,secrets},0);await new Promise<void>(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await database.close();});
async function actor(){const user=await identity(database.pool);await database.pool.query('UPDATE users SET password_hash=$2 WHERE id=$1',[user.userId,hash]);return {...user,cookie:`honocraft_dev_session=${user.token}`,csrf:csrfForSession(secrets.csrfKey,user.sessionId,secrets.epoch)};}
function write(user:{cookie:string;csrf:string},body:unknown,method='POST'){return {method,headers:{origin,cookie:user.cookie,'x-csrf-token':user.csrf,'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify(body)};}
it('serves session pages and revokes a selected session through authenticated JSON DELETE',async()=>{
  const user=await actor(),other=await sessionFor(database.pool,user.userId);
  const list=await fetch(base+'/api/v1/me/sessions?page=1&page_size=1',{headers:{cookie:user.cookie}});expect(list.status).toBe(200);expect((await list.json()).data).toMatchObject({total:2,page:1,page_size:1});
  const response=await fetch(base+'/api/v1/me/sessions/'+other.sessionId,write(user,{},'DELETE'));expect(response.status).toBe(200);expect((await response.json()).data).toEqual({revoked:true,is_current:false});
  expect((await fetch(base+'/api/v1/me',{headers:{cookie:`honocraft_dev_session=${other.token}`}})).status).toBe(401);
  const current=await fetch(base+'/api/v1/me/sessions/'+user.sessionId,write(user,{},'DELETE'));expect(current.status).toBe(200);expect(current.headers.get('set-cookie')).toContain('Max-Age=0');
});
it('reauthenticates without changing cookies and keeps wrong-password failures distinct from expired sessions',async()=>{
  const user=await actor();const failed=await fetch(base+'/api/v1/auth/reauthenticate',write(user,{current_password:'incorrect'}));expect(failed.status).toBe(401);expect((await failed.json()).error.code).toBe('AUTH_FAILED');expect(failed.headers.get('set-cookie')).toBeNull();
  expect((await fetch(base+'/api/v1/me',{headers:{cookie:user.cookie}})).status).toBe(200);
  const response=await fetch(base+'/api/v1/auth/reauthenticate',write(user,{current_password:password}));expect(response.status).toBe(200);expect((await response.json()).data).toHaveProperty('valid_until');expect(response.headers.get('set-cookie')).toBeNull();
});
it('changes the password and clears cookies only after commit',async()=>{
  const user=await actor();const request=write(user,{expected_version:1,current_password:password,new_password:'My new security test passphrase'});
  const denied=await fetch(base+'/api/v1/me/password',{...request,headers:{...request.headers,'x-csrf-token':''}});expect(denied.status).toBe(403);expect(denied.headers.get('set-cookie')).toBeNull();
  const response=await fetch(base+'/api/v1/me/password',request);expect(response.status).toBe(200);expect((await response.json()).data).toEqual({changed:true,login_required:true});expect(response.headers.get('set-cookie')).toContain('Max-Age=0');expect((await fetch(base+'/api/v1/me',{headers:{cookie:user.cookie}})).status).toBe(401);
});
it('requires idempotency and Origin and rejects unexpected revoke body fields',async()=>{
  const user=await actor();const request=write(user,{});
  const missing=await fetch(base+'/api/v1/me/sessions/revoke-others',{...request,headers:{...request.headers,'idempotency-key':''}});expect(missing.status).toBe(422);
  const foreign=await fetch(base+'/api/v1/me/sessions/revoke-others',{...request,headers:{...request.headers,origin:'https://evil.example.test'}});expect(foreign.status).toBe(403);
  const forged=await fetch(base+'/api/v1/me/sessions/'+user.sessionId,write(user,{id:randomUUID()},'DELETE'));expect(forged.status).toBe(422);
  const valid=await fetch(base+'/api/v1/me/sessions/revoke-others',request);expect(valid.status).toBe(200);expect((await valid.json()).data).toEqual({revoked_count:0});
});
