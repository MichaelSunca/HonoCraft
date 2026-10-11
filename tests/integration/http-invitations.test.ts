import type {AddressInfo} from 'node:net';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {startTestPostgres} from '../helpers/postgres.js';
import {initializedDatabase} from '../helpers/identity.js';
import {invitation} from '../helpers/invitation.js';
import {migrate} from '../../apps/server/src/infrastructure/migrations.js';
import {createPasswordService} from '../../apps/server/src/infrastructure/passwords.js';
import {loadConfig} from '../../apps/server/src/infrastructure/config.js';
import {startHttpServer} from '../../apps/server/src/http/app.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>,server:ReturnType<typeof startHttpServer>,base:string;
const origin='https://invites.example.test',password='An invitation HTTP testing secret';
beforeAll(async()=>{
  database=await startTestPostgres();await migrate(database.pool);await initializedDatabase(database.pool);
  const passwords=await createPasswordService({concurrency:2,blockedPasswords:new Set()});
  const config=loadConfig({NODE_ENV:'test',PUBLIC_ORIGIN:origin,DATABASE_URL:database.connectionString,MAIL_MODE:'capture',SMTP_HOST:'127.0.0.1',SMTP_PORT:'1025',MAIL_FROM:'test@example.test',FILE_STORAGE_ROOT:'.local/test-media',EXAMPLE_NOTES_ENABLED:'false',MAIL_PAYLOAD_KEYRING_FILE:'test-mail',DIGEST_KEY_FILE:'test-digest',CSRF_KEY_FILE:'test-csrf',CREDENTIAL_EPOCH_FILE:'test-epoch'});
  const secrets={epoch:'test-epoch',csrfKey:Buffer.alloc(32,3),digestKey:{id:'test-v1',key:Buffer.alloc(32,7)},mailKeyring:{activeKeyId:'v1',keys:new Map([['v1',Buffer.alloc(32,4)]])}};
  server=startHttpServer({pool:database.pool,config,passwords,secrets},0);await new Promise<void>(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await database.close();});
const write=(body:unknown)=>({method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
it('previews then accepts without a session and permits an explicit login with the chosen password',async()=>{
  const invite=await invitation(database.pool);
  const preview=await fetch(base+'/api/v1/auth/invites/preview',write({token:invite.token}));expect(preview.status).toBe(200);
  expect((await preview.json()).data).toEqual({instance_name:'HonoCraft',email:invite.email,expires_at:expect.any(String)});expect(preview.headers.get('cache-control')).toBe('no-store');expect(preview.headers.get('referrer-policy')).toBe('no-referrer');
  const response=await fetch(base+'/api/v1/auth/invites/accept',write({token:invite.token,password,display_name:'HTTP member'}));expect(response.status).toBe(200);expect((await response.json()).data).toEqual({accepted:true,login_required:true});expect(response.headers.get('set-cookie')).toBeNull();
  const login=await fetch(base+'/api/v1/auth/login',write({email:invite.email,password}));expect(login.status).toBe(200);expect(login.headers.get('set-cookie')).toContain('HttpOnly');
  const duplicate=await fetch(base+'/api/v1/auth/invites/accept',write({token:invite.token,password,display_name:'Another'}));expect(duplicate.status).toBe(400);expect((await duplicate.json()).error.code).toBe('CREDENTIAL_INVALID');
});
it('requires Origin and strict JSON, with no GET credential consumption route',async()=>{
  const invite=await invitation(database.pool),input={token:invite.token,password,display_name:'Member'};
  const foreign=await fetch(base+'/api/v1/auth/invites/accept',{...write(input),headers:{origin:'https://foreign.example.test','content-type':'application/json'}});expect(foreign.status).toBe(403);
  expect((await fetch(base+'/api/v1/auth/invites/accept')).status).toBe(404);
  const forged=await fetch(base+'/api/v1/auth/invites/accept',write({...input,role_ids:['super_admin']}));expect(forged.status).toBe(422);
  expect((await database.pool.query('SELECT consumed_at FROM one_time_credentials WHERE id=$1',[invite.credentialId])).rows[0].consumed_at).toBeNull();
});
it('reports a changed invitation without exposing its roles or inviter details',async()=>{
  const invite=await invitation(database.pool);await database.pool.query('UPDATE invite_roles SET role_version_at_issue=role_version_at_issue+1 WHERE invite_id=$1',[invite.id]);
  const response=await fetch(base+'/api/v1/auth/invites/accept',write({token:invite.token,password,display_name:'Member'}));expect(response.status).toBe(409);const body=await response.json();expect(body.error.code).toBe('INVITE_REISSUE_REQUIRED');expect(body).not.toHaveProperty('data');expect(JSON.stringify(body)).not.toContain(invite.inviter.userId);
});
