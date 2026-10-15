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
import {csrfForSession,issueToken,decryptPayload} from '../../apps/server/src/infrastructure/crypto.js';
import {withTransaction} from '../../apps/server/src/infrastructure/db.js';
import {enqueueMail,mailAad} from '../../apps/server/src/modules/mail/outbox.js';
import {invitation} from '../helpers/invitation.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>,web:pg.Pool,server:ReturnType<typeof startHttpServer>,base:string;
beforeAll(async()=>{
  database=await startTestPostgres();web=new pg.Pool({connectionString:database.connectionString,options:'-c role=honocraft_web'});
  const passwords=await createPasswordService({concurrency:2,blockedPasswords:new Set()});
  const config=loadConfig({NODE_ENV:'test',PUBLIC_ORIGIN:'https://users.example.test',DATABASE_URL:database.connectionString,MAIL_MODE:'capture',SMTP_HOST:'127.0.0.1',SMTP_PORT:'1025',MAIL_FROM:'test@example.test',FILE_STORAGE_ROOT:'.local/test-media',EXAMPLE_NOTES_ENABLED:'false',MAIL_PAYLOAD_KEYRING_FILE:'test-mail',DIGEST_KEY_FILE:'test-digest',CSRF_KEY_FILE:'test-csrf',CREDENTIAL_EPOCH_FILE:'test-epoch'});
  const secrets={epoch:'test-epoch',csrfKey:Buffer.alloc(32,3),digestKey:{id:'test-v1',key:Buffer.alloc(32,7)},mailKeyring:{activeKeyId:'v1',keys:new Map([['v1',Buffer.alloc(32,4)]])}};
  server=startHttpServer({pool:web,config,passwords,secrets},0);await new Promise<void>(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async()=>{await database.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await migrate(database.pool);await initializedDatabase(database.pool);});
afterAll(async()=>{server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await web?.end();await database?.close();});
const get=(path:string,actor?:{token:string})=>fetch(base+'/api/v1'+path,{headers:actor?{cookie:`honocraft_dev_session=${actor.token}`}:{}});
const confirmation=(id:string,label?:string)=>({target_id:id,reason:'Review account access',...(label?{typed_label:label}:{})});
const verify=(actor:{sessionId:string})=>database.pool.query("UPDATE sessions SET reauthenticated_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[actor.sessionId]);
const write=(path:string,method:string,actor:{token:string;sessionId:string},body:unknown,key:string=randomUUID())=>fetch(base+'/api/v1'+path,{method,headers:{origin:'https://users.example.test','content-type':'application/json',cookie:`honocraft_dev_session=${actor.token}`,'x-csrf-token':csrfForSession(Buffer.alloc(32,3),actor.sessionId,'test-epoch'),'idempotency-key':key},body:JSON.stringify(body)});
async function custom(actor:{userId:string},permissions:string[],delegable=true){const id=randomUUID();await database.pool.query('INSERT INTO roles(id,code,name,is_delegable) VALUES($1,$2,$2,$3)',[id,'custom_'+id.slice(0,8),delegable]);await database.pool.query('INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code=ANY($2::text[])',[id,permissions]);await database.pool.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',[actor.userId,id]);return id;}
it('serves strict paginated user queries through the restricted web database role',async()=>{
  const actor=await identity(database.pool,'admin'),one=await identity(database.pool),two=await identity(database.pool),decoy=await identity(database.pool);
  await database.pool.query("UPDATE users SET display_name=CASE id WHEN $1 THEN 'Person_one' WHEN $2 THEN 'Person_two' ELSE 'PersonXone' END,created_at='2026-01-02T00:00:00Z' WHERE id=ANY($3::uuid[])",[one.userId,two.userId,[one.userId,two.userId,decoy.userId]]);
  const response=await get('/users?query=Person_&sort=display_name&direction=asc&page_size=1&page=2',actor);expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
  expect((await response.json()).data).toMatchObject({total:2,page:2,page_size:1,items:[{id:two.userId,display_name:'Person_two',status:'active',email_visibility:'full',version:1}]});
  const role=(await database.pool.query("SELECT id FROM roles WHERE code='user'")).rows[0].id;
  expect((await (await get(`/users?role_id=${role}&created_from=2026-01-02T00:00:00Z&created_to=2026-01-03T00:00:00Z`,actor)).json()).data.total).toBe(3);
  expect((await (await get('/users?created_to=2026-01-02T00:00:00Z',actor)).json()).data.total).toBe(0);
  for(const query of ['query=x','page=0','page_size=101','status=enabled','role_id=no','sort=password_hash','direction=sideways','extra=true','created_from=tomorrow','created_from=2026-02-01T00:00:00Z&created_to=2026-01-01T00:00:00Z'])expect((await get('/users?'+query,actor)).status,query).toBe(422);
});
it('masks protected targets and hides secret fields while retaining own email visibility',async()=>{
  const actor=await identity(database.pool,'admin'),target=await identity(database.pool,'super_admin'),ordinary=await identity(database.pool);
  await database.pool.query("UPDATE users SET email='private-admin@example.test',normalized_email='private-admin@example.test' WHERE id=$1",[target.userId]);
  const response=await get('/users/'+target.userId,actor);expect(response.status).toBe(200);const data=(await response.json()).data;
  expect(data).toMatchObject({id:target.userId,email:null,email_visibility:'masked',masked_email:'p***@example.test',allowed_actions:[],requires_reauth_actions:[],verified:true,can_read_audit:true});
  for(const secret of ['private-admin@','password_hash','password_version','authorization_version','test-hash-not-for-login','token_hash','sessionId'])expect(JSON.stringify(data)).not.toContain(secret);
  expect((await (await get('/users/'+actor.userId,actor)).json()).data).toMatchObject({email_visibility:'full',email:actor.userId+'@example.test'});
  const member=(await (await get('/users/'+ordinary.userId,actor)).json()).data;
  expect(member.allowed_actions).toEqual(['update','suspend','delete','reset-password','change-email','assign-roles']);expect(member.requires_reauth_actions).toEqual(['change-email']);
});
it('bases capabilities on current full role scope and real super administrator identity',async()=>{
  const actor=await identity(database.pool,'admin'),target=await identity(database.pool),superAdmin=await identity(database.pool,'super_admin');
  await custom(target,['role:delegate'],false);
  expect((await (await get('/users/'+target.userId,actor)).json()).data).toMatchObject({email_visibility:'masked',allowed_actions:[]});
  const high=(await (await get('/users/'+target.userId,superAdmin)).json()).data;
  expect(high.email_visibility).toBe('full');expect(high.requires_reauth_actions).toEqual(high.allowed_actions);
  await custom(actor,['user:manage-privileged']);
  expect((await (await get('/users/'+target.userId,actor)).json()).data).toMatchObject({email_visibility:'masked',allowed_actions:[]});
  const own=(await (await get('/users/'+superAdmin.userId,superAdmin)).json()).data;
  for(const action of ['suspend','enable','delete','assign-roles'])expect(own.allowed_actions).not.toContain(action);
});
it('separates read authority from writes and respects current state eligibility',async()=>{
  const reader=await identity(database.pool),admin=await identity(database.pool,'admin'),target=await identity(database.pool);await custom(reader,['user:read']);
  expect((await (await get('/users/'+target.userId,reader)).json()).data).toMatchObject({allowed_actions:[],can_read_audit:false});
  await database.pool.query("UPDATE users SET status='pending',email_verified_at=NULL,creation_source='registration',registration_role_id=(SELECT id FROM roles WHERE code='user') WHERE id=$1",[target.userId]);
  expect((await (await get('/users/'+target.userId,admin)).json()).data.allowed_actions).toEqual(['update','suspend','delete','change-email']);
  await database.pool.query("UPDATE users SET status='suspended' WHERE id=$1",[target.userId]);
  expect((await (await get('/users/'+target.userId,admin)).json()).data.allowed_actions).toEqual(['update','enable','delete']);
  await database.pool.query("UPDATE users SET status='deleted',deleted_at=clock_timestamp() WHERE id=$1",[target.userId]);
  expect((await (await get('/users?status=deleted',admin)).json()).data).toMatchObject({total:1,items:[{id:target.userId,allowed_actions:[]}]});
  expect((await (await get('/users',admin)).json()).data.items.map((item:{id:string})=>item.id)).not.toContain(target.userId);
});
it('exposes pending email requests only to the subject or currently authorized requester',async()=>{
  const actor=await identity(database.pool,'admin'),other=await identity(database.pool,'admin'),target=await identity(database.pool),id=randomUUID();
  await database.pool.query("INSERT INTO email_change_requests(id,user_id,requested_by,initiated_by_self,new_email,normalized_new_email,status,expires_at) VALUES($1,$2,$3,false,'new-private@example.test','new-private@example.test','pending',clock_timestamp()+interval '1 hour')",[id,target.userId,actor.userId]);
  const data=(await (await get('/users/'+target.userId,actor)).json()).data;
  expect(data.pending_email_change).toMatchObject({id,version:1,new_email:'new-private@example.test'});expect(data.allowed_actions).toContain('cancel-email-change');
  const hidden=(await (await get('/users/'+target.userId,other)).json()).data;
  expect(hidden.pending_email_change).toBeNull();expect(hidden.allowed_actions).not.toContain('cancel-email-change');expect(JSON.stringify(hidden)).not.toContain('new-private');
  await database.pool.query("UPDATE email_change_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);
  const expired=(await (await get('/users/'+target.userId,actor)).json()).data;
  expect(expired.pending_email_change).toBeNull();expect(expired.allowed_actions).not.toContain('cancel-email-change');
});
it('checks current permission and session before revealing user existence',async()=>{
  const member=await identity(database.pool),admin=await identity(database.pool,'admin'),missing=randomUUID();
  expect((await get('/users')).status).toBe(401);
  for(const path of ['/users','/users/'+member.userId,'/users/'+missing])expect((await get(path,member)).status).toBe(403);
  expect((await get('/users/'+missing,admin)).status).toBe(404);expect((await get('/users/not-uuid',admin)).status).toBe(422);
  await database.pool.query('DELETE FROM role_permissions WHERE role_id=(SELECT id FROM roles WHERE code=$1) AND permission_id=(SELECT id FROM permissions WHERE code=$2)',['admin','user:read']);
  expect((await get('/users',admin)).status).toBe(403);
  await database.pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1',[admin.sessionId]);expect((await get('/users',admin)).status).toBe(401);
});
it('does not reveal masked email characters through search or ordering',async()=>{
  const actor=await identity(database.pool,'admin'),first=await identity(database.pool,'super_admin'),second=await identity(database.pool,'super_admin');
  const ordered=[first.userId,second.userId].sort();
  await database.pool.query("UPDATE users SET email=CASE id WHEN $1 THEN 'az-secret@example.test' ELSE 'aa-secret@example.test' END,normalized_email=CASE id WHEN $1 THEN 'az-secret@example.test' ELSE 'aa-secret@example.test' END WHERE id=ANY($2::uuid[])",[ordered[0],ordered]);
  const hidden=await get('/users?query=az-secret',actor);expect(hidden.status).toBe(200);expect((await hidden.json()).data.total).toBe(0);
  const superRole=(await database.pool.query("SELECT id FROM roles WHERE code='super_admin'")).rows[0].id;
  const list=(await (await get(`/users?role_id=${superRole}&sort=email&direction=asc`,actor)).json()).data;
  expect(list.items.map((item:{id:string})=>item.id)).toEqual(ordered);
  for(const item of list.items)expect(item).toMatchObject({email:null,masked_email:'a***@example.test',email_visibility:'masked'});
  expect((await (await get('/users?query=az-secret',first)).json()).data.total).toBe(1);
});
it('requires every target role permission to be in the reader management scope',async()=>{
  const reader=await identity(database.pool),admin=await identity(database.pool,'admin'),target=await identity(database.pool);
  await custom(reader,['user:read','user:update']);await custom(target,['invite:read','invite:manage']);
  await database.pool.query("UPDATE users SET email='scope-secret@example.test',normalized_email='scope-secret@example.test' WHERE id=$1",[target.userId]);
  expect((await (await get('/users/'+target.userId,reader)).json()).data).toMatchObject({email_visibility:'masked',allowed_actions:[]});
  expect((await (await get('/users?query=scope-secret',reader)).json()).data.total).toBe(0);
  const managed=(await (await get('/users?query=scope-secret',admin)).json()).data;
  expect(managed).toMatchObject({total:1,items:[{id:target.userId,email_visibility:'full'}]});expect(managed.items[0].allowed_actions).toContain('update');
  const role=await custom(target,[],false);
  expect((await (await get('/users/'+target.userId,admin)).json()).data.allowed_actions).toEqual([]);
  await database.pool.query('UPDATE roles SET is_delegable=true WHERE id=$1',[role]);
  expect((await (await get('/users/'+target.userId,admin)).json()).data.allowed_actions).toContain('update');
});
it('updates only display name with version control and replay without invalidating sessions',async()=>{
  const actor=await identity(database.pool,'admin'),target=await identity(database.pool),path='/users/'+target.userId+'/profile',body={expected_version:1,display_name:'Corrected member'},key=randomUUID();
  const response=await write(path,'PATCH',actor,body,key);expect(response.status).toBe(200);expect((await response.json()).data).toEqual({id:target.userId,display_name:'Corrected member',version:2});
  expect((await (await write(path,'PATCH',actor,body,key)).json())).toMatchObject({replayed:true,data:{outcome:'user_profile_updated',version:2}});
  expect((await write(path,'PATCH',actor,{...body,display_name:'Changed again'},key)).status).toBe(409);
  expect((await write(path,'PATCH',actor,body)).status).toBe(409);
  expect((await write(path,'PATCH',actor,{...body,expected_version:2,email:'new@example.test'})).status).toBe(422);
  expect((await get('/me',target)).status).toBe(200);
  expect((await database.pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='users.profile.updated' AND result='success'")).rows[0].n).toBe(1);
});
it('replaces the full role set, revokes sessions once and rechecks historical grants on replay',async()=>{
  const actor=await identity(database.pool,'admin'),target=await identity(database.pool),path='/users/'+target.userId+'/roles',key=randomUUID();
  const role=await custom(await identity(database.pool),['invite:read']);
  const body={expected_version:1,role_ids:[role,role],confirmation:confirmation(target.userId)};
  const result=await write(path,'PUT',actor,body,key);expect(result.status).toBe(200);expect((await result.json()).data).toEqual({id:target.userId,role_ids:[role],version:2,login_required:true});
  expect((await get('/me',target)).status).toBe(401);
  expect((await (await write(path,'PUT',actor,body,key)).json()).replayed).toBe(true);
  expect((await database.pool.query('SELECT version,authorization_version FROM users WHERE id=$1',[target.userId])).rows[0]).toEqual({version:2,authorization_version:2});
  expect((await write(path,'PUT',actor,{expected_version:2,role_ids:[],confirmation:confirmation(target.userId)})).status).toBe(200);
  await database.pool.query("DELETE FROM role_permissions WHERE role_id=(SELECT id FROM roles WHERE code='admin') AND permission_id=(SELECT id FROM permissions WHERE code='invite:read')");
  expect((await write(path,'PUT',actor,body,key)).status).toBe(403);
});
it('denies protected old and new role sets, missing dependencies, inactive targets and self management',async()=>{
  const actor=await identity(database.pool,'admin'),target=await identity(database.pool),high=await identity(database.pool,'admin'),path='/users/'+target.userId+'/roles';
  const superRole=(await database.pool.query("SELECT id FROM roles WHERE code='super_admin'")).rows[0].id;
  expect((await write(path,'PUT',actor,{expected_version:1,role_ids:[superRole],confirmation:confirmation(target.userId)})).status).toBe(403);
  expect((await write('/users/'+high.userId+'/roles','PUT',actor,{expected_version:1,role_ids:[],confirmation:confirmation(high.userId)})).status).toBe(403);
  const malformed=await custom(await identity(database.pool),['invite:manage']);
  const dependency=await write(path,'PUT',actor,{expected_version:1,role_ids:[malformed],confirmation:confirmation(target.userId)});expect(dependency.status).toBe(422);expect((await dependency.json()).error.code).toBe('PERMISSION_DEPENDENCY_MISSING');
  await database.pool.query("UPDATE users SET status='suspended' WHERE id=$1",[target.userId]);
  expect((await write(path,'PUT',actor,{expected_version:1,role_ids:[],confirmation:confirmation(target.userId)})).status).toBe(422);
  for(const [method,suffix,extra] of [['PUT','/roles',{role_ids:[]}],['POST','/status',{action:'suspend'}],['DELETE','',{}]] as const){const result=await write('/users/'+actor.userId+suffix,method,actor,{expected_version:1,...extra,confirmation:confirmation(actor.userId,actor.userId+'@example.test')});expect(result.status).toBe(403);expect((await result.json()).error.code).toBe('SELF_MANAGEMENT_FORBIDDEN');}
});
it('requires recent authentication and a normalized target label for privileged changes',async()=>{
  const actor=await identity(database.pool,'super_admin'),target=await identity(database.pool,'admin'),path='/users/'+target.userId+'/profile',body={expected_version:1,display_name:'Privileged member',confirmation:confirmation(target.userId,target.userId+'@example.test')};
  const result=await write(path,'PATCH',actor,body);expect(result.status).toBe(403);expect((await result.json()).error.code).toBe('REAUTH_REQUIRED');await verify(actor);
  expect((await write(path,'PATCH',actor,{...body,confirmation:confirmation(target.userId,'wrong@example.test')})).status).toBe(422);
  expect((await write(path,'PATCH',actor,body)).status).toBe(200);
  const user=await identity(database.pool),superRole=(await database.pool.query("SELECT id FROM roles WHERE code='super_admin'")).rows[0].id;
  expect((await write('/users/'+user.userId+'/roles','PUT',actor,{expected_version:1,role_ids:[superRole],confirmation:confirmation(user.userId,user.userId+'@example.test')})).status).toBe(200);
});
it('suspends all access artifacts atomically and enabling never revives old sessions or credentials',async()=>{
  const actor=await identity(database.pool,'super_admin'),invite=await invitation(database.pool),target=invite.inviter,email=target.userId+'@example.test';await verify(actor);
  const credential=randomUUID(),issued=issueToken(),request=randomUUID();
  await database.pool.query("INSERT INTO one_time_credentials(id,purpose,user_id,token_hash,subject_version,target_email,normalized_target_email,credential_epoch,expires_at) VALUES($1,'password_reset',$2,$3,1,$4,$4,'test-epoch',clock_timestamp()+interval '1 hour')",[credential,target.userId,issued.hash,email]);
  await database.pool.query("INSERT INTO email_change_requests(id,user_id,requested_by,initiated_by_self,new_email,normalized_new_email,expires_at) VALUES($1,$2,$2,true,'pending-new@example.test','pending-new@example.test',clock_timestamp()+interval '1 hour')",[request,target.userId]);
  const expiry=(await database.pool.query('SELECT expires_at FROM one_time_credentials WHERE id=$1',[credential])).rows[0].expires_at.toISOString();
  await withTransaction(database.pool,'shared',tx=>enqueueMail(tx,{activeKeyId:'v1',keys:new Map([['v1',Buffer.alloc(32,4)]])},{eventId:randomUUID(),credentialId:credential,purpose:'password_reset',token:issued.token,recipient:email,displayName:'Test user',instanceName:'HonoCraft',locale:'en',timeZone:'UTC',expiresAt:expiry}));
  const path='/users/'+target.userId+'/status',body={expected_version:1,action:'suspend',confirmation:confirmation(target.userId,email)},key=randomUUID();
  const response=await write(path,'POST',actor,body,key);expect(response.status).toBe(200);expect((await response.json()).data).toMatchObject({status:'suspended',version:2});
  expect((await (await write(path,'POST',actor,body,key)).json()).replayed).toBe(true);
  expect((await database.pool.query('SELECT status FROM invites WHERE id=$1',[invite.id])).rows[0].status).toBe('revoked');
  expect((await database.pool.query('SELECT role_id FROM invite_roles WHERE invite_id=$1',[invite.id])).rows[0].role_id).toBeNull();
  expect((await database.pool.query('SELECT status FROM email_change_requests WHERE id=$1',[request])).rows[0].status).toBe('cancelled');
  for(const id of [credential,invite.credentialId])expect((await database.pool.query('SELECT revoked_at FROM one_time_credentials WHERE id=$1',[id])).rows[0].revoked_at).not.toBeNull();
  expect((await database.pool.query('SELECT status,payload_ciphertext FROM email_tasks WHERE credential_id=$1',[credential])).rows[0]).toEqual({status:'cancelled',payload_ciphertext:null});
  expect((await database.pool.query("SELECT count(*)::int AS n FROM email_tasks WHERE purpose='account_suspended'")).rows[0].n).toBe(1);
  expect((await write(path,'POST',actor,{expected_version:2,action:'enable',confirmation:confirmation(target.userId,email)})).status).toBe(200);
  expect((await database.pool.query('SELECT status,version,authorization_version FROM users WHERE id=$1',[target.userId])).rows[0]).toEqual({status:'active',version:3,authorization_version:3});
  expect((await get('/me',target)).status).toBe(401);
});
it('enables unverified registrations as pending and soft deletion retains email but releases roles and avatar',async()=>{
  const actor=await identity(database.pool,'admin'),target=await identity(database.pool),email=target.userId+'@example.test';
  await database.pool.query("UPDATE users SET status='suspended',email_verified_at=NULL,creation_source='registration',registration_role_id=(SELECT id FROM roles WHERE code='user') WHERE id=$1",[target.userId]);
  const enable=await write('/users/'+target.userId+'/status','POST',actor,{expected_version:1,action:'enable',confirmation:confirmation(target.userId)});expect(enable.status).toBe(200);expect((await enable.json()).data.status).toBe('pending');
  const file=randomUUID();await database.pool.query("INSERT INTO file_objects(id,storage_key,owner_id,purpose,state,content_type,byte_size,width,height) VALUES($1,$2,$3,'avatar','attached','image/webp',10,1,1)",[file,file+'.webp',target.userId]);await database.pool.query('UPDATE users SET avatar_file_id=$2 WHERE id=$1',[target.userId,file]);
  const body={expected_version:2,confirmation:confirmation(target.userId,email)},key=randomUUID();
  expect((await write('/users/'+target.userId,'DELETE',actor,{...body,confirmation:confirmation(target.userId)})).status).toBe(422);
  expect((await write('/users/'+target.userId,'DELETE',actor,body,key)).status).toBe(200);
  expect((await (await write('/users/'+target.userId,'DELETE',actor,body,key)).json()).replayed).toBe(true);
  expect((await database.pool.query('SELECT status,email,avatar_file_id,registration_role_id,version FROM users WHERE id=$1',[target.userId])).rows[0]).toEqual({status:'deleted',email,avatar_file_id:null,registration_role_id:null,version:3});
  expect((await database.pool.query('SELECT role_id FROM user_roles WHERE user_id=$1',[target.userId])).rowCount).toBe(0);
  expect((await database.pool.query('SELECT state FROM file_objects WHERE id=$1',[file])).rows[0].state).toBe('orphaned');
});
it('rolls back user state, session revocation and mail when success audit persistence fails',async()=>{
  const actor=await identity(database.pool,'admin'),target=await identity(database.pool);
  await database.pool.query("CREATE FUNCTION fail_user_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='users.status.changed' AND NEW.result='success' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_user_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_user_audit()");
  const response=await write('/users/'+target.userId+'/status','POST',actor,{expected_version:1,action:'suspend',confirmation:confirmation(target.userId)});expect(response.status).toBe(500);
  expect((await database.pool.query('SELECT status,version,authorization_version FROM users WHERE id=$1',[target.userId])).rows[0]).toEqual({status:'active',version:1,authorization_version:1});
  expect((await get('/me',target)).status).toBe(200);expect((await database.pool.query('SELECT 1 FROM email_tasks')).rowCount).toBe(0);expect((await database.pool.query('SELECT 1 FROM idempotency_records')).rowCount).toBe(0);
});
it('serializes cross-super-admin demotions and preserves a usable administrator',async()=>{
  const first=await identity(database.pool,'super_admin'),second=await identity(database.pool,'super_admin');await verify(first);await verify(second);
  const results=await Promise.all([write('/users/'+second.userId+'/roles','PUT',first,{expected_version:1,role_ids:[],confirmation:confirmation(second.userId,second.userId+'@example.test')}),write('/users/'+first.userId+'/roles','PUT',second,{expected_version:1,role_ids:[],confirmation:confirmation(first.userId,first.userId+'@example.test')})]);
  expect(results.map(result=>result.status).sort()).toEqual([200,401]);
  expect((await database.pool.query("SELECT count(*)::int AS n FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id WHERE r.code='super_admin' AND u.status='active' AND u.email_verified_at IS NOT NULL AND u.password_hash IS NOT NULL")).rows[0].n).toBe(1);
});
it('enforces each write permission, Origin, CSRF, idempotency key and strict path identity',async()=>{
  const actor=await identity(database.pool),target=await identity(database.pool);await custom(actor,['user:read','user:update']);
  const path='/users/'+target.userId,body={expected_version:1,display_name:'Scoped edit'};
  expect((await write(path+'/profile','PATCH',actor,body)).status).toBe(200);
  expect((await write(path+'/status','POST',actor,{expected_version:2,action:'suspend',confirmation:confirmation(target.userId)})).status).toBe(403);
  const headers={origin:'https://users.example.test','content-type':'application/json',cookie:`honocraft_dev_session=${actor.token}`,'x-csrf-token':csrfForSession(Buffer.alloc(32,3),actor.sessionId,'test-epoch'),'idempotency-key':randomUUID()};
  for(const override of [{'x-csrf-token':'invalid'},{origin:'https://foreign.example.test'}])expect((await fetch(base+'/api/v1'+path+'/profile',{method:'PATCH',headers:{...headers,...override},body:JSON.stringify({...body,expected_version:2})})).status).toBe(403);
  expect((await write(path+'/profile','PATCH',actor,{...body,expected_version:2},'not-a-uuid')).status).toBe(422);
  expect((await write(path+'/profile','PATCH',actor,{...body,expected_version:2,id:randomUUID()})).status).toBe(422);
  expect((await database.pool.query('SELECT display_name,version FROM users WHERE id=$1',[target.userId])).rows[0]).toEqual({display_name:'Scoped edit',version:2});
});
it('retains privileged reauthentication requirements after a successful demotion',async()=>{
  const actor=await identity(database.pool,'super_admin'),target=await identity(database.pool,'admin'),key=randomUUID(),body={expected_version:1,role_ids:[],confirmation:confirmation(target.userId,target.userId+'@example.test')};await verify(actor);
  expect((await write('/users/'+target.userId+'/roles','PUT',actor,body,key)).status).toBe(200);
  await database.pool.query("UPDATE sessions SET reauthenticated_at=clock_timestamp()-interval '6 minutes' WHERE id=$1",[actor.sessionId]);
  const replay=await write('/users/'+target.userId+'/roles','PUT',actor,body,key);expect(replay.status).toBe(403);expect((await replay.json()).error.code).toBe('REAUTH_REQUIRED');
  expect((await database.pool.query("SELECT count(*)::int AS n FROM security_events WHERE user_id=$1 AND event_type='users.roles_changed'",[target.userId])).rows[0].n).toBe(1);
});
it('rolls back role membership and sessions when the security event cannot be written',async()=>{
  const actor=await identity(database.pool,'admin'),target=await identity(database.pool);
  await database.pool.query("CREATE FUNCTION fail_user_security() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='users.roles_changed' THEN RAISE EXCEPTION 'security event unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_user_security BEFORE INSERT ON security_events FOR EACH ROW EXECUTE FUNCTION fail_user_security()");
  expect((await write('/users/'+target.userId+'/roles','PUT',actor,{expected_version:1,role_ids:[],confirmation:confirmation(target.userId)})).status).toBe(500);
  expect((await database.pool.query('SELECT role_id FROM user_roles WHERE user_id=$1',[target.userId])).rowCount).toBe(1);expect((await get('/me',target)).status).toBe(200);
  expect((await database.pool.query('SELECT version,authorization_version FROM users WHERE id=$1',[target.userId])).rows[0]).toEqual({version:1,authorization_version:1});
  expect((await database.pool.query("SELECT 1 FROM audit_events WHERE action='users.roles.assigned' AND result='success'")).rowCount).toBe(0);
  expect((await database.pool.query('SELECT 1 FROM idempotency_records')).rowCount).toBe(0);
});
it('permits only one conflicting full role replacement at a user version',async()=>{
  const actor=await identity(database.pool,'admin'),target=await identity(database.pool),role=await custom(await identity(database.pool),[]),body={expected_version:1,confirmation:confirmation(target.userId)};
  const results=await Promise.all([write('/users/'+target.userId+'/roles','PUT',actor,{...body,role_ids:[]}),write('/users/'+target.userId+'/roles','PUT',actor,{...body,role_ids:[role]})]);
  expect(results.map(result=>result.status).sort()).toEqual([200,409]);
  expect((await database.pool.query('SELECT version,authorization_version FROM users WHERE id=$1',[target.userId])).rows[0]).toEqual({version:2,authorization_version:2});
});
it('allows ordinary profile correction alongside other shared security transactions',async()=>{
  const actor=await identity(database.pool,'admin'),target=await identity(database.pool),connection=await database.pool.connect();
  try{
    await connection.query('BEGIN');await connection.query('SELECT id FROM system_state WHERE id=1 FOR SHARE');
    const response=await write('/users/'+target.userId+'/profile','PATCH',actor,{expected_version:1,display_name:'Concurrent correction'});
    expect(response.status).toBe(200);
  }finally{await connection.query('ROLLBACK');connection.release();}
});
it('issues an administrator password reset once without changing the password, versions or current sessions',async()=>{
  const actor=await identity(database.pool,'admin'),target=await identity(database.pool),path='/users/'+target.userId+'/password-reset',body={expected_version:1,confirmation:confirmation(target.userId)},key=randomUUID();
  const response=await write(path,'POST',actor,body,key);expect(response.status).toBe(202);expect((await response.json()).data).toEqual({accepted:true});
  const replay=await write(path,'POST',actor,body,key);expect(replay.status).toBe(202);expect((await replay.json())).toMatchObject({replayed:true,data:{outcome:'user_password_reset_requested',resource_id:target.userId,version:1}});
  expect((await database.pool.query('SELECT version,authorization_version,password_hash FROM users WHERE id=$1',[target.userId])).rows[0]).toEqual({version:1,authorization_version:1,password_hash:'test-hash-not-for-login'});expect((await get('/me',target)).status).toBe(200);
  const tasks=await database.pool.query("SELECT t.* FROM email_tasks t JOIN one_time_credentials c ON c.id=t.credential_id WHERE c.user_id=$1 AND c.purpose='password_reset'",[target.userId]);expect(tasks.rowCount).toBe(1);
  const task=tasks.rows[0],payload=JSON.parse(decryptPayload({activeKeyId:'v1',keys:new Map([['v1',Buffer.alloc(32,4)]])},{keyId:task.key_id,ciphertext:task.payload_ciphertext,nonce:task.nonce,tag:task.auth_tag},mailAad(task.id,task.purpose,task.template_version)));
  expect(payload).toMatchObject({purpose:'password_reset',recipient:target.userId+'@example.test'});
  const reset=await fetch(base+'/api/v1/auth/password/reset',{method:'POST',headers:{origin:'https://users.example.test','content-type':'application/json'},body:JSON.stringify({token:payload.token,new_password:'A sufficiently long new password'})});expect(reset.status).toBe(200);expect((await get('/me',target)).status).toBe(401);
});
it('shares reset mail cooldown with anonymous recovery and does not replace a credential on throttling',async()=>{
  const actor=await identity(database.pool,'admin'),target=await identity(database.pool),path='/users/'+target.userId+'/password-reset',body={expected_version:1,confirmation:confirmation(target.userId)};
  expect((await write(path,'POST',actor,body)).status).toBe(202);
  const original=(await database.pool.query("SELECT id FROM one_time_credentials WHERE user_id=$1 AND purpose='password_reset'",[target.userId])).rows[0].id;
  const throttled=await write(path,'POST',actor,body);expect(throttled.status).toBe(429);expect(Number(throttled.headers.get('retry-after'))).toBeGreaterThan(0);
  const anonymous=await fetch(base+'/api/v1/auth/password/forgot',{method:'POST',headers:{origin:'https://users.example.test','content-type':'application/json'},body:JSON.stringify({email:target.userId+'@example.test'})});expect(anonymous.status).toBe(202);
  expect((await database.pool.query('SELECT id,revoked_at FROM one_time_credentials WHERE user_id=$1',[target.userId])).rows).toEqual([{id:original,revoked_at:null}]);
  await database.pool.query("UPDATE rate_limit_buckets SET last_accepted_at=clock_timestamp()-interval '2 minutes' WHERE scope='mail.target.password_reset'");
  expect((await write(path,'POST',actor,body)).status).toBe(202);
  expect((await database.pool.query('SELECT revoked_at FROM one_time_credentials WHERE id=$1',[original])).rows[0].revoked_at).not.toBeNull();
  expect((await database.pool.query('SELECT status,payload_ciphertext FROM email_tasks WHERE credential_id=$1',[original])).rows[0]).toEqual({status:'cancelled',payload_ciphertext:null});
});
it('rejects reset requests outside current authority, version or active-account eligibility',async()=>{
  const actor=await identity(database.pool,'admin'),target=await identity(database.pool),high=await identity(database.pool,'super_admin'),member=await identity(database.pool),path='/users/'+target.userId+'/password-reset',body={expected_version:1,confirmation:confirmation(target.userId)};
  expect((await write(path,'POST',member,body)).status).toBe(403);
  expect((await write('/users/'+high.userId+'/password-reset','POST',actor,{expected_version:1,confirmation:confirmation(high.userId)})).status).toBe(403);
  expect((await write(path,'POST',actor,{...body,expected_version:2})).status).toBe(409);
  expect((await write(path,'POST',actor,{...body,new_password:'Do not accept direct passwords'})).status).toBe(422);
  for(const state of ['pending','suspended','deleted']){
    await database.pool.query("UPDATE users SET status=$2,deleted_at=CASE WHEN $2='deleted' THEN clock_timestamp() ELSE NULL END WHERE id=$1",[target.userId,state]);
    expect((await write(path,'POST',actor,body)).status).toBe(422);
  }
  expect((await database.pool.query('SELECT 1 FROM email_tasks')).rowCount).toBe(0);
});
it('requires privileged reset confirmation and rolls back reset issuance when audit fails',async()=>{
  const actor=await identity(database.pool,'super_admin'),target=await identity(database.pool,'admin'),path='/users/'+target.userId+'/password-reset',body={expected_version:1,confirmation:confirmation(target.userId,target.userId+'@example.test')};
  const denied=await write(path,'POST',actor,body);expect(denied.status).toBe(403);expect((await denied.json()).error.code).toBe('REAUTH_REQUIRED');await verify(actor);
  expect((await write(path,'POST',actor,{...body,confirmation:confirmation(target.userId,'wrong@example.test')})).status).toBe(422);
  await database.pool.query("CREATE FUNCTION fail_reset_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='users.password.reset_requested' AND NEW.result='success' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_reset_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_reset_audit()");
  expect((await write(path,'POST',actor,body)).status).toBe(500);
  for(const table of ['email_tasks','one_time_credentials','rate_limit_buckets','idempotency_records'])expect((await database.pool.query('SELECT 1 FROM '+table)).rowCount).toBe(0);
  expect((await get('/me',target)).status).toBe(200);
});
