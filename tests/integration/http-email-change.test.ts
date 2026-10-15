import type {AddressInfo} from 'node:net';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {startTestPostgres} from '../helpers/postgres.js';
import {identity,initializedDatabase,sessionFor} from '../helpers/identity.js';
import {migrate} from '../../apps/server/src/infrastructure/migrations.js';
import {createPasswordService} from '../../apps/server/src/infrastructure/passwords.js';
import {loadConfig} from '../../apps/server/src/infrastructure/config.js';
import {startHttpServer} from '../../apps/server/src/http/app.js';
import {csrfForSession,issueToken,decryptPayload} from '../../apps/server/src/infrastructure/crypto.js';
import {mailAad} from '../../apps/server/src/modules/mail/outbox.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>,web:pg.Pool,server:ReturnType<typeof startHttpServer>,base:string;
const origin='https://email.example.test',ring={activeKeyId:'v1',keys:new Map([['v1',Buffer.alloc(32,4)]])};
type Actor={userId:string;sessionId:string;token:string};
beforeAll(async()=>{
  database=await startTestPostgres();web=new pg.Pool({connectionString:database.connectionString,options:'-c role=honocraft_web'});
  const passwords=await createPasswordService({concurrency:2,blockedPasswords:new Set()});
  const config=loadConfig({NODE_ENV:'test',PUBLIC_ORIGIN:origin,DATABASE_URL:database.connectionString,MAIL_MODE:'capture',SMTP_HOST:'127.0.0.1',SMTP_PORT:'1025',MAIL_FROM:'test@example.test',FILE_STORAGE_ROOT:'.local/test-media',EXAMPLE_NOTES_ENABLED:'false',MAIL_PAYLOAD_KEYRING_FILE:'test-mail',DIGEST_KEY_FILE:'test-digest',CSRF_KEY_FILE:'test-csrf',CREDENTIAL_EPOCH_FILE:'test-epoch'});
  server=startHttpServer({pool:web,config,passwords,secrets:{epoch:'test-epoch',csrfKey:Buffer.alloc(32,3),digestKey:{id:'test-v1',key:Buffer.alloc(32,7)},mailKeyring:ring}},0);
  await new Promise<void>(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async()=>{await database.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await migrate(database.pool);await initializedDatabase(database.pool);});
afterAll(async()=>{server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await web?.end();await database?.close();});
const get=(path:string,actor:Actor)=>fetch(base+'/api/v1'+path,{headers:{cookie:`honocraft_dev_session=${actor.token}`}});
const write=(path:string,method:string,actor:Actor,body:unknown,key:string=randomUUID())=>fetch(base+'/api/v1'+path,{method,headers:{origin,'content-type':'application/json',cookie:`honocraft_dev_session=${actor.token}`,'x-csrf-token':csrfForSession(Buffer.alloc(32,3),actor.sessionId,'test-epoch'),'idempotency-key':key},body:JSON.stringify(body)});
const confirm=(token:string)=>fetch(base+'/api/v1/auth/email-change/confirm',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({token})});
const verify=(actor:Actor)=>database.pool.query("UPDATE sessions SET reauthenticated_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[actor.sessionId]);
const confirmation=(id:string,label?:string)=>({target_id:id,reason:'Correct account email',...(label?{typed_label:label}:{})});
async function start(actor:Actor,email:string,version=1,key=randomUUID()){
  const response=await write('/me/email-change','POST',actor,{expected_version:version,new_email:email},key);expect(response.status).toBe(202);return (await response.json()).data as {request_id:string;request_version:number;user_version:number;expires_at:string};
}
async function tokenFor(requestId:string){
  const task=(await database.pool.query("SELECT t.* FROM email_tasks t JOIN one_time_credentials c ON c.id=t.credential_id WHERE c.email_change_request_id=$1 AND t.status='queued' ORDER BY t.created_at DESC LIMIT 1",[requestId])).rows[0];
  const payload=JSON.parse(decryptPayload(ring,{keyId:task.key_id,ciphertext:task.payload_ciphertext,nonce:task.nonce,tag:task.auth_tag},mailAad(task.id,task.purpose,task.template_version)));
  return payload.token as string;
}
async function pending(){
  const id=randomUUID(),issued=issueToken(),email=id+'@example.test',credential=randomUUID();
  await database.pool.query("INSERT INTO users(id,email,normalized_email,display_name,password_hash,status,creation_source,registration_role_id) SELECT $1,$2,$2,'Waiting member','test-hash-not-for-login','pending','registration',id FROM roles WHERE code='user'",[id,email]);
  await database.pool.query("INSERT INTO one_time_credentials(id,purpose,user_id,token_hash,subject_version,target_email,normalized_target_email,credential_epoch,expires_at) VALUES($1,'email_verify',$2,$3,1,$4,$4,'test-epoch',clock_timestamp()+interval '1 hour')",[credential,id,issued.hash,email]);
  return {id,email,credential,token:issued.token};
}
it('requires recent authentication, keeps the old address until confirmation and invalidates old credentials on success',async()=>{
  const actor=await identity(database.pool),other=await sessionFor(database.pool,actor.userId),key=randomUUID(),body={expected_version:1,new_email:'New.Address@Example.Test'};
  const denied=await write('/me/email-change','POST',actor,body,key);expect(denied.status).toBe(403);expect((await denied.json()).error.code).toBe('REAUTH_REQUIRED');await verify(actor);
  const request=await start(actor,body.new_email,1,key),token=await tokenFor(request.request_id);
  expect(request).toMatchObject({request_version:1,user_version:2});expect(Object.keys(request).sort()).toEqual(['expires_at','request_id','request_version','user_version']);
  expect((await (await write('/me/email-change','POST',actor,body,key)).json()).replayed).toBe(true);
  expect((await database.pool.query('SELECT email,version,authorization_version FROM users WHERE id=$1',[actor.userId])).rows[0]).toEqual({email:actor.userId+'@example.test',version:2,authorization_version:1});
  expect((await (await get('/me',actor)).json()).data.pending_email_change).toMatchObject({id:request.request_id,new_email:'New.Address@example.test'});
  const reset=issueToken();await database.pool.query("INSERT INTO one_time_credentials(purpose,user_id,token_hash,subject_version,target_email,normalized_target_email,credential_epoch,expires_at) SELECT 'password_reset',id,$2,authorization_version,email,normalized_email,'test-epoch',clock_timestamp()+interval '1 hour' FROM users WHERE id=$1",[actor.userId,reset.hash]);
  const completed=await confirm(token);expect(completed.status).toBe(200);expect((await completed.json()).data).toEqual({changed:true,login_required:true});expect(completed.headers.get('set-cookie')).toContain('Max-Age=0');
  expect((await database.pool.query('SELECT email,normalized_email,status,version,authorization_version,password_version,password_hash FROM users WHERE id=$1',[actor.userId])).rows[0]).toEqual({email:'New.Address@example.test',normalized_email:'new.address@example.test',status:'active',version:3,authorization_version:2,password_version:1,password_hash:'test-hash-not-for-login'});
  expect((await get('/me',actor)).status).toBe(401);expect((await get('/me',{...actor,...other})).status).toBe(401);expect((await confirm(token)).status).toBe(400);
  expect((await database.pool.query('SELECT revoked_at FROM one_time_credentials WHERE token_hash=$1',[reset.hash])).rows[0].revoked_at).not.toBeNull();
  const mail=(await database.pool.query("SELECT purpose,recipient FROM email_tasks WHERE purpose IN ('email_change_started','email_changed') ORDER BY purpose")).rows;
  expect(mail).toEqual([{purpose:'email_change_started',recipient:actor.userId+'@example.test'},{purpose:'email_changed',recipient:actor.userId+'@example.test'}]);
});
it('replaces requests and supports versioned cancellation without recent authentication',async()=>{
  const actor=await identity(database.pool);await verify(actor);const first=await start(actor,'first@example.test'),oldToken=await tokenFor(first.request_id),second=await start(actor,'second@example.test',2),newToken=await tokenFor(second.request_id);
  expect(second).toMatchObject({user_version:3,request_version:1});expect((await confirm(oldToken)).status).toBe(400);
  expect((await database.pool.query('SELECT status,version FROM email_change_requests WHERE id=$1',[first.request_id])).rows[0]).toEqual({status:'cancelled',version:2});
  await database.pool.query('UPDATE sessions SET reauthenticated_at=NULL WHERE id=$1',[actor.sessionId]);
  const body={expected_version:3,request_id:second.request_id,request_version:1},key=randomUUID();
  expect((await write('/me/email-change','DELETE',actor,{...body,request_version:2})).status).toBe(409);
  const cancel=await write('/me/email-change','DELETE',actor,body,key);expect(cancel.status).toBe(200);expect((await cancel.json()).data).toEqual({cancelled:true,user_version:4});
  expect((await (await write('/me/email-change','DELETE',actor,body,key)).json()).replayed).toBe(true);
  expect((await confirm(newToken)).status).toBe(400);expect((await (await get('/me',actor)).json()).data.pending_email_change).toBeNull();
});
it('corrects a pending registration only after the new address and original role are validated',async()=>{
  const actor=await identity(database.pool,'admin'),target=await pending();await verify(actor);
  const response=await write('/users/'+target.id+'/email-change','POST',actor,{expected_version:1,new_email:'corrected@example.test',confirmation:confirmation(target.id)});expect(response.status).toBe(202);const request=(await response.json()).data,token=await tokenFor(request.request_id);
  expect((await database.pool.query('SELECT status,email FROM users WHERE id=$1',[target.id])).rows[0]).toEqual({status:'pending',email:target.email});
  expect((await database.pool.query('SELECT revoked_at FROM one_time_credentials WHERE id=$1',[target.credential])).rows[0].revoked_at).not.toBeNull();
  expect((await confirm(token)).status).toBe(200);
  expect((await database.pool.query('SELECT email,status,registration_role_id FROM users WHERE id=$1',[target.id])).rows[0]).toEqual({email:'corrected@example.test',status:'active',registration_role_id:null});
  expect((await database.pool.query('SELECT r.code FROM roles r JOIN user_roles ur ON r.id=ur.role_id WHERE ur.user_id=$1',[target.id])).rows).toEqual([{code:'user'}]);
});
it('limits admin cancellation to its authorized original issuer but lets the subject cancel',async()=>{
  const actor=await identity(database.pool,'admin'),other=await identity(database.pool,'admin'),target=await identity(database.pool);await verify(actor);
  const response=await write('/users/'+target.userId+'/email-change','POST',actor,{expected_version:1,new_email:'managed@example.test',confirmation:confirmation(target.userId)});expect(response.status).toBe(202);const request=(await response.json()).data,token=await tokenFor(request.request_id),body={expected_version:2,request_id:request.request_id,request_version:1};
  expect((await write('/users/'+target.userId+'/email-change','DELETE',other,body)).status).toBe(403);
  await database.pool.query("DELETE FROM role_permissions WHERE role_id=(SELECT id FROM roles WHERE code='admin') AND permission_id=(SELECT id FROM permissions WHERE code='user:update-email')");
  expect((await write('/users/'+target.userId+'/email-change','DELETE',actor,body)).status).toBe(403);expect((await confirm(token)).status).toBe(400);
  expect((await write('/me/email-change','DELETE',target,body)).status).toBe(200);
});
it('enforces protected target scope and explicit confirmation on high-risk email changes',async()=>{
  const admin=await identity(database.pool,'admin'),owner=await identity(database.pool,'super_admin'),target=await identity(database.pool,'admin'),path='/users/'+target.userId+'/email-change',body={expected_version:1,new_email:'privileged@example.test',confirmation:confirmation(target.userId)};
  await verify(admin);expect((await write(path,'POST',admin,body)).status).toBe(403);
  const first=await write(path,'POST',owner,body);expect(first.status).toBe(403);expect((await first.json()).error.code).toBe('REAUTH_REQUIRED');await verify(owner);
  expect((await write(path,'POST',owner,body)).status).toBe(422);
  expect((await write(path,'POST',owner,{...body,confirmation:confirmation(target.userId,target.userId+'@example.test')})).status).toBe(202);
});
it('does not reserve requested addresses and resolves concurrent confirmations atomically',async()=>{
  const one=await identity(database.pool),two=await identity(database.pool);await verify(one);await verify(two);
  const a=await start(one,'shared@example.test');
  await database.pool.query("UPDATE rate_limit_buckets SET last_accepted_at=clock_timestamp()-interval '2 minutes' WHERE scope='mail.target.email_change'");
  const b=await start(two,'shared@example.test'),ta=await tokenFor(a.request_id),tb=await tokenFor(b.request_id);
  const results=await Promise.all([confirm(ta),confirm(tb)]);expect(results.map(result=>result.status).sort()).toEqual([200,409]);
  expect((await database.pool.query("SELECT id FROM users WHERE normalized_email='shared@example.test'")).rowCount).toBe(1);
  const losing=results[0]!.status===409?one:two,request=results[0]!.status===409?a:b;
  expect((await database.pool.query('SELECT email,version FROM users WHERE id=$1',[losing.userId])).rows[0]).toEqual({email:losing.userId+'@example.test',version:2});
  expect((await database.pool.query('SELECT status FROM email_change_requests WHERE id=$1',[request.request_id])).rows[0].status).toBe('pending');expect((await get('/me',losing)).status).toBe(200);
});
it('rejects occupied or unchanged emails, invalid bodies and throttled replacements without side effects',async()=>{
  const actor=await identity(database.pool),occupied=await identity(database.pool);await verify(actor);
  for(const email of [actor.userId+'@example.test',occupied.userId+'@example.test'])expect((await write('/me/email-change','POST',actor,{expected_version:1,new_email:email})).status).toBe(email===actor.userId+'@example.test'?422:409);
  expect((await write('/me/email-change','POST',actor,{expected_version:1,new_email:'first@example.test',email_verified_at:'now'})).status).toBe(422);
  const request=await start(actor,'rate@example.test'),token=await tokenFor(request.request_id);
  expect((await write('/me/email-change','POST',actor,{expected_version:2,new_email:'rate@example.test'})).status).toBe(429);
  expect((await database.pool.query('SELECT version FROM users WHERE id=$1',[actor.userId])).rows[0].version).toBe(2);expect((await confirm(token)).status).toBe(200);
});
it('rejects expiry, disabled users and invalid original registration roles on confirmation',async()=>{
  const actor=await identity(database.pool),admin=await identity(database.pool,'admin');await verify(actor);const request=await start(actor,'expire@example.test'),token=await tokenFor(request.request_id);
  await database.pool.query("UPDATE email_change_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[request.request_id]);expect((await confirm(token)).status).toBe(400);
  const fresh=await start(actor,'disabled@example.test',2),freshToken=await tokenFor(fresh.request_id);
  expect((await write('/users/'+actor.userId+'/status','POST',admin,{expected_version:3,action:'suspend',confirmation:confirmation(actor.userId)})).status).toBe(200);expect((await confirm(freshToken)).status).toBe(400);
  const target=await pending();await verify(admin);const created=await write('/users/'+target.id+'/email-change','POST',admin,{expected_version:1,new_email:'ineligible@example.test',confirmation:confirmation(target.id)});expect(created.status).toBe(202);const pendingToken=await tokenFor((await created.json()).data.request_id);
  await database.pool.query("UPDATE roles SET is_registration_default_eligible=false WHERE code='user'");expect((await confirm(pendingToken)).status).toBe(400);
  expect((await database.pool.query('SELECT status,email FROM users WHERE id=$1',[target.id])).rows[0]).toEqual({status:'pending',email:target.email});
});
it('rolls back replacement and confirmation if audit persistence fails',async()=>{
  const actor=await identity(database.pool);await verify(actor);const request=await start(actor,'preserved@example.test'),token=await tokenFor(request.request_id);
  await database.pool.query("CREATE FUNCTION fail_email_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'users.email_change.%' AND NEW.result='success' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_email_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_email_audit()");
  expect((await write('/me/email-change','POST',actor,{expected_version:2,new_email:'rolled-back@example.test'})).status).toBe(500);expect((await confirm(token)).status).toBe(500);
  expect((await database.pool.query('SELECT email,version FROM users WHERE id=$1',[actor.userId])).rows[0]).toEqual({email:actor.userId+'@example.test',version:2});
  expect((await database.pool.query('SELECT status,version FROM email_change_requests WHERE id=$1',[request.request_id])).rows[0]).toEqual({status:'pending',version:1});expect((await get('/me',actor)).status).toBe(200);
  await database.pool.query('DROP TRIGGER fail_email_audit ON audit_events');expect((await confirm(token)).status).toBe(200);
});
