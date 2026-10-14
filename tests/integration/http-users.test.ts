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
