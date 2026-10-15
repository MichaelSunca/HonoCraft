import type {AddressInfo} from 'node:net';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {startTestPostgres} from '../helpers/postgres.js';
import {identity,initializedDatabase} from '../helpers/identity.js';
import {migrate} from '../../apps/server/src/infrastructure/migrations.js';
import {createPasswordService} from '../../apps/server/src/infrastructure/passwords.js';
import {loadConfig} from '../../apps/server/src/infrastructure/config.js';
import {startHttpServer} from '../../apps/server/src/http/app.js';
import {csrfForSession} from '../../apps/server/src/infrastructure/crypto.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>,web:pg.Pool,server:ReturnType<typeof startHttpServer>,base:string;
type Actor=Awaited<ReturnType<typeof identity>>;
const origin='https://settings.example.test',defaultRole='00000000-0000-4000-8000-000000000003';
const branding={instance_name:'Example workbench',copyright:'Contact security@example.test password=do-not-log',default_locale:'en',default_theme:'dark',timezone:'Asia/Tokyo'};
const security={registration_open:false,registration_default_role_id:defaultRole,password_min_length:15,session_idle_minutes:30,session_absolute_minutes:480,email_verify_hours:24,password_reset_minutes:30,invite_hours:72,email_change_hours:24,login_ip_per_minute:20,account_failures_per_window:5,account_lock_minutes:15,mail_cooldown_seconds:60,mail_target_per_hour:5,mail_ip_per_hour:20};
const confirmation={target_id:'security',typed_label:'security',reason:'Review instance security'};
beforeAll(async()=>{
  database=await startTestPostgres();web=new pg.Pool({connectionString:database.connectionString,options:'-c role=honocraft_web'});
  const passwords=await createPasswordService({concurrency:2,blockedPasswords:new Set()}),config=loadConfig({NODE_ENV:'test',PUBLIC_ORIGIN:origin,DATABASE_URL:database.connectionString,MAIL_MODE:'capture',SMTP_HOST:'127.0.0.1',SMTP_PORT:'1025',MAIL_FROM:'test@example.test',FILE_STORAGE_ROOT:'.local/test-media',EXAMPLE_NOTES_ENABLED:'false',MAIL_PAYLOAD_KEYRING_FILE:'test-mail',DIGEST_KEY_FILE:'test-digest',CSRF_KEY_FILE:'test-csrf',CREDENTIAL_EPOCH_FILE:'test-epoch'});
  server=startHttpServer({pool:web,config,passwords,secrets:{epoch:'test-epoch',csrfKey:Buffer.alloc(32,3),digestKey:{id:'test-v1',key:Buffer.alloc(32,7)},mailKeyring:{activeKeyId:'v1',keys:new Map([['v1',Buffer.alloc(32,4)]])}}},0);await new Promise<void>(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async()=>{await database.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await migrate(database.pool);await initializedDatabase(database.pool);});
afterAll(async()=>{server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await web?.end();await database?.close();});
const get=(path:string,actor?:Actor)=>fetch(base+'/api/v1'+path,{headers:actor?{cookie:'honocraft_dev_session='+actor.token}:{}});
const headers=(actor:Actor)=>({origin,'content-type':'application/json',cookie:'honocraft_dev_session='+actor.token,'x-csrf-token':csrfForSession(Buffer.alloc(32,3),actor.sessionId,'test-epoch'),'idempotency-key':randomUUID()});
const patch=(group:string,actor:Actor,body:unknown,key?:string)=>fetch(base+'/api/v1/settings/'+group,{method:'PATCH',headers:{...headers(actor),...(key?{'idempotency-key':key}:{})},body:JSON.stringify(body)});
const verify=(actor:Actor)=>database.pool.query("UPDATE sessions SET reauthenticated_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[actor.sessionId]);
it('returns safe versioned groups and capabilities without deployment secrets',async()=>{
  const actor=await identity(database.pool,'admin'),member=await identity(database.pool),owner=await identity(database.pool,'super_admin');
  expect((await get('/settings')).status).toBe(401);expect((await get('/settings',member)).status).toBe(403);
  const response=await get('/settings',actor);expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');const data=(await response.json()).data;
  expect(data.branding).toMatchObject({instance_name:'HonoCraft',version:1,logo_file_id:null,favicon_file_id:null,allowed_actions:['update'],requires_reauth_actions:[]});expect(data.security).toMatchObject({...security,version:1,allowed_actions:[],requires_reauth_actions:[]});
  for(const secret of ['smtp','keyring','database_url','password_hash','test-v1'])expect(JSON.stringify(data).toLowerCase()).not.toContain(secret);
  expect((await (await get('/settings',owner)).json()).data.security).toMatchObject({allowed_actions:['update'],requires_reauth_actions:['update']});expect((await get('/settings?key=secrets',actor)).status).toBe(422);
});
it('updates branding once, preserves asset references and sanitizes free-text audit content',async()=>{
  const actor=await identity(database.pool,'admin'),asset=randomUUID(),key=randomUUID(),body={...branding,expected_version:1};
  await database.pool.query("INSERT INTO file_objects(id,storage_key,purpose,state,content_type,byte_size,width,height) VALUES($1,$2,'brand_logo','attached','image/webp',10,1,1)",[asset,asset+'.webp']);await database.pool.query("UPDATE system_settings SET typed_value=jsonb_set(typed_value,'{logo_file_id}',to_jsonb($1::text)) WHERE key='branding'",[asset]);
  const response=await patch('branding',actor,body,key);expect(response.status).toBe(200);expect((await response.json()).data).toMatchObject({...branding,version:2,logo_file_id:asset});expect((await (await get('/public/settings')).json()).data).toMatchObject(branding);
  const replay=await patch('branding',actor,body,key);expect(replay.status).toBe(200);expect(await replay.json()).toMatchObject({replayed:true,data:{outcome:'branding_updated',resource_id:null,version:2}});
  expect((await patch('branding',actor,{...body,instance_name:'Changed'},key)).status).toBe(409);expect((await patch('branding',actor,body)).status).toBe(409);
  const events=(await database.pool.query("SELECT changes FROM audit_events WHERE action='settings.branding.updated' AND result='success'")).rows;expect(events).toHaveLength(1);expect(events[0].changes.setting_keys).toContain('instance_name');expect(JSON.stringify(events)).not.toContain('do-not-log');expect(JSON.stringify(events)).not.toContain('security@example.test');
});
it('rejects partial or unsafe branding fields and enforces Origin and CSRF',async()=>{
  const actor=await identity(database.pool,'admin'),body={...branding,expected_version:1};
  for(const changed of [{logo_file_id:randomUUID()},{favicon_url:'https://external.test/icon.png'},{smtp_password:'never'},{instance_name:' '},{instance_name:'<script>alert(1)</script>'},{timezone:'Not/AZone'},{timezone:'+09:00'},{copyright:'x'.repeat(201)},{expected_version:0}])expect((await patch('branding',actor,{...body,...changed})).status).toBe(422);
  expect((await patch('branding',actor,{expected_version:1,instance_name:'Partial'})).status).toBe(422);
  for(const changed of [{origin:'https://other.test'},{'x-csrf-token':'invalid'}])expect((await fetch(base+'/api/v1/settings/branding',{method:'PATCH',headers:{...headers(actor),...changed},body:JSON.stringify(body)})).status).toBe(403);
  const raw=headers(actor);delete (raw as Partial<typeof raw>)['idempotency-key'];expect((await fetch(base+'/api/v1/settings/branding',{method:'PATCH',headers:raw,body:JSON.stringify(body)})).status).toBe(422);
});
it('requires real super identity, recent verification and the security confirmation label',async()=>{
  const actor=await identity(database.pool,'super_admin'),admin=await identity(database.pool,'admin'),body={...security,expected_version:1,confirmation};
  expect((await patch('security',admin,body)).status).toBe(403);const denied=await patch('security',actor,body);expect(denied.status).toBe(403);expect((await denied.json()).error.code).toBe('REAUTH_REQUIRED');await verify(actor);
  expect((await patch('security',actor,{...body,confirmation:{...confirmation,typed_label:'branding'}})).status).toBe(422);expect((await patch('security',actor,{...body,confirmation:{...confirmation,target_id:'branding'}})).status).toBe(422);
  const response=await patch('security',actor,{...body,password_min_length:20,session_absolute_minutes:120});expect(response.status).toBe(200);expect((await response.json()).data).toMatchObject({password_min_length:20,session_absolute_minutes:120,version:2});
  expect((await (await get('/me',actor)).json()).data.instance.password_min_length).toBe(20);expect((await database.pool.query("SELECT typed_value FROM system_settings WHERE key='security'")).rows[0].typed_value.registration_default_role_id).toBeUndefined();
});
it('applies every security boundary and dependency without accepting deployment settings',async()=>{
  const actor=await identity(database.pool,'super_admin');await verify(actor);const body={...security,expected_version:1,confirmation};
  for(const change of [{password_min_length:14},{password_min_length:65},{session_idle_minutes:4},{session_idle_minutes:31},{session_absolute_minutes:29},{session_absolute_minutes:481},{email_verify_hours:49},{password_reset_minutes:9},{invite_hours:169},{email_change_hours:49},{login_ip_per_minute:21},{account_failures_per_window:6},{account_lock_minutes:14},{mail_cooldown_seconds:59},{mail_target_per_hour:6},{mail_ip_per_hour:21},{cookie_secure:false},{registration_open:'true'}])expect((await patch('security',actor,{...body,...change})).status,JSON.stringify(change)).toBe(422);
  expect((await patch('security',actor,{...body,registration_default_role_id:'00000000-0000-4000-8000-000000000002'})).status).toBe(422);
  expect((await database.pool.query("SELECT version FROM system_settings WHERE key='security'")).rows[0].version).toBe(1);
});
it('changes the registration default for future users while preserving pending registration references',async()=>{
  const actor=await identity(database.pool,'super_admin'),role=randomUUID();await verify(actor);
  await database.pool.query("INSERT INTO roles(id,code,name,is_registration_default_eligible) VALUES($1,'new_member','New member',true)",[role]);await database.pool.query("INSERT INTO users(email,normalized_email,display_name,password_hash,creation_source,registration_role_id) VALUES('old@example.test','old@example.test','Old registration','fixture','registration',$1)",[defaultRole]);
  const response=await patch('security',actor,{...security,registration_open:true,registration_default_role_id:role,expected_version:1,confirmation});expect(response.status).toBe(200);
  const registration=await fetch(base+'/api/v1/auth/register',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email:'new@example.test',display_name:'New registration',password:'A new sufficiently long password'})});expect(registration.status).toBe(202);
  expect((await database.pool.query('SELECT normalized_email,registration_role_id FROM users WHERE normalized_email IN ($1,$2) ORDER BY normalized_email',['new@example.test','old@example.test'])).rows).toEqual([{normalized_email:'new@example.test',registration_role_id:role},{normalized_email:'old@example.test',registration_role_id:defaultRole}]);
});
it('never revives absolute or idle deadlines when tightening is followed by relaxation without an intervening request',async()=>{
  const actor=await identity(database.pool,'super_admin'),absolute=await identity(database.pool),idle=await identity(database.pool);await verify(actor);
  await database.pool.query("UPDATE sessions SET created_at=clock_timestamp()-interval '1 hour',last_seen_at=clock_timestamp()-interval '1 minute',idle_expires_at=clock_timestamp()+interval '20 minutes',absolute_expires_at=clock_timestamp()+interval '7 hours' WHERE id=$1",[absolute.sessionId]);expect((await get('/me',absolute)).status).toBe(200);
  expect((await patch('security',actor,{...security,session_idle_minutes:5,session_absolute_minutes:30,expected_version:1,confirmation})).status).toBe(200);
  expect((await patch('security',actor,{...security,expected_version:2,confirmation})).status).toBe(200);expect((await get('/me',absolute)).status).toBe(401);
  expect(Number((await database.pool.query('SELECT extract(epoch FROM absolute_expires_at-created_at)*1000 AS duration FROM sessions WHERE id=$1',[absolute.sessionId])).rows[0].duration)).toBe(1800000);
  await database.pool.query("UPDATE sessions SET created_at=clock_timestamp()-interval '20 minutes',last_seen_at=clock_timestamp()-interval '10 minutes',idle_expires_at=clock_timestamp()+interval '20 minutes',absolute_expires_at=clock_timestamp()+interval '7 hours' WHERE id=$1",[idle.sessionId]);
  expect((await patch('security',actor,{...security,session_idle_minutes:5,expected_version:3,confirmation})).status).toBe(200);expect((await patch('security',actor,{...security,expected_version:4,confirmation})).status).toBe(200);expect((await get('/me',idle)).status).toBe(401);
});
it('reauthorizes historical security results and never repeats audit or changes on replay',async()=>{
  const actor=await identity(database.pool,'super_admin'),key=randomUUID(),body={...security,expected_version:1,confirmation};await verify(actor);expect((await patch('security',actor,body,key)).status).toBe(200);
  await database.pool.query("UPDATE sessions SET reauthenticated_at=clock_timestamp()-interval '6 minutes' WHERE id=$1",[actor.sessionId]);const stale=await patch('security',actor,body,key);expect(stale.status).toBe(403);expect((await stale.json()).error.code).toBe('REAUTH_REQUIRED');await verify(actor);expect((await (await patch('security',actor,body,key)).json()).replayed).toBe(true);
  await database.pool.query("INSERT INTO roles(code,name) VALUES('fake_security','Fake security'); INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code='fake_security' AND p.code IN ('settings:read','settings:update-security')");await database.pool.query('DELETE FROM user_roles WHERE user_id=$1',[actor.userId]);await database.pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='fake_security'",[actor.userId]);expect((await patch('security',actor,body,key)).status).toBe(403);
  expect((await database.pool.query("SELECT 1 FROM audit_events WHERE action='settings.security.updated' AND result='success'")).rowCount).toBe(1);expect((await database.pool.query("SELECT version FROM system_settings WHERE key='security'")).rows[0].version).toBe(2);
});
it.each(['audit','security'])('rolls back settings and deadline changes if the %s event fails',async source=>{
  const actor=await identity(database.pool,'super_admin'),member=await identity(database.pool);await verify(actor);const before=(await database.pool.query('SELECT absolute_expires_at,idle_expires_at FROM sessions WHERE id=$1',[member.sessionId])).rows[0];
  const table=source==='audit'?'audit_events':'security_events',condition=source==='audit'?"NEW.action='settings.security.updated' AND NEW.result='success'":"NEW.event_type='settings.security_changed'";
  await database.pool.query(`CREATE FUNCTION fail_setting_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'event unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_setting_event BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_setting_event()`);
  expect((await patch('security',actor,{...security,session_idle_minutes:5,session_absolute_minutes:30,expected_version:1,confirmation})).status).toBe(500);
  expect((await database.pool.query("SELECT version,typed_value FROM system_settings WHERE key='security'")).rows[0]).toMatchObject({version:1,typed_value:{session_idle_minutes:30,session_absolute_minutes:480}});expect((await database.pool.query('SELECT absolute_expires_at,idle_expires_at FROM sessions WHERE id=$1',[member.sessionId])).rows[0]).toEqual(before);expect((await database.pool.query('SELECT 1 FROM idempotency_records')).rowCount).toBe(0);
});
