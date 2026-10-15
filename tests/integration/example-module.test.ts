import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {startTestPostgres} from '../helpers/postgres.js';
import {identity,initializedDatabase,sessionFor} from '../helpers/identity.js';
import {migrate} from '../../apps/server/src/infrastructure/migrations.js';
import {checkDatabaseCompatibility} from '../../apps/server/src/infrastructure/startup.js';
import {setExampleNotesEnabled} from '../../apps/server/src/modules/example-notes/catalog.js';
import {createNotesService} from '../../apps/server/src/modules/example-notes/service.js';
import {issueToken,csrfForSession} from '../../apps/server/src/infrastructure/crypto.js';
import {withTransaction} from '../../apps/server/src/infrastructure/db.js';
import {enqueueMail} from '../../apps/server/src/modules/mail/outbox.js';
import {currentCredential} from '../../apps/server/src/modules/auth/credentials.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>,web:pg.Pool;
const meta=()=>({requestId:randomUUID(),ip:'127.0.0.1',userAgent:'module test'});
const change=(enabled:boolean,pool=database.pool)=>setExampleNotesEnabled(pool,{enabled,reason:'Explicit example module maintenance'},meta());
beforeAll(async()=>{database=await startTestPostgres();web=new pg.Pool({connectionString:database.connectionString,options:'-c role=honocraft_web'});});
beforeEach(async()=>{await database.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await migrate(database.pool);});
afterAll(async()=>{await web?.end();await database?.close();});
it('enables a complete catalog before initialization without granting notes to built-in users or administrators',async()=>{
  expect(await change(true)).toMatchObject({changed:true,enabled:true,permissions_changed:4});await expect(checkDatabaseCompatibility(web,true)).resolves.toBeUndefined();await expect(checkDatabaseCompatibility(web,false)).rejects.toThrow('PERMISSION_CATALOG_INCOMPATIBLE');
  expect((await database.pool.query("SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE p.module='example-note'")).rowCount).toBe(0);expect((await database.pool.query("SELECT initialization_status FROM system_state")).rows[0].initialization_status).toBe('uninitialized');
});
it('makes repeated and concurrent enable/disable requests idempotent with no extra version changes',async()=>{
  const results=await Promise.all([change(true),change(true)]);expect(results.filter(r=>r.changed)).toHaveLength(1);const version=(await database.pool.query("SELECT version FROM roles WHERE code='super_admin'")).rows[0].version;expect(await change(true)).toMatchObject({changed:false,roles_affected:0,users_affected:0});expect((await database.pool.query("SELECT version FROM roles WHERE code='super_admin'")).rows[0].version).toBe(version);await change(false);expect(await change(false)).toMatchObject({changed:false,permissions_changed:0});expect((await database.pool.query("SELECT action FROM audit_events WHERE action LIKE 'ops.module.%'")).rowCount).toBe(2);
});
it('revises implicit super administrator permissions and sessions but preserves unrelated user identities',async()=>{
  await initializedDatabase(database.pool);const superAdmin=await identity(database.pool,'super_admin'),member=await identity(database.pool);expect(await change(true)).toMatchObject({roles_affected:1,users_affected:1});const users=(await database.pool.query('SELECT id,version,authorization_version FROM users WHERE id=ANY($1::uuid[])',[[superAdmin.userId,member.userId]])).rows;
  expect(users.find(u=>u.id===superAdmin.userId)).toMatchObject({version:2,authorization_version:2});expect(users.find(u=>u.id===member.userId)).toMatchObject({version:1,authorization_version:1});expect((await database.pool.query('SELECT revoked_reason FROM sessions WHERE id=$1',[superAdmin.sessionId])).rows[0].revoked_reason).toBe('module_enabled');expect((await database.pool.query('SELECT revoked_at FROM sessions WHERE id=$1',[member.sessionId])).rows[0].revoked_at).toBeNull();
});
async function scenario(){
  await change(true);await initializedDatabase(database.pool);await database.pool.query("INSERT INTO roles(code,name) VALUES('module_author','Author'); INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code='module_author' AND (p.module='example-note' OR p.code='user:read')");
  const actor=await identity(database.pool,'module_author'),issuer=await identity(database.pool,'super_admin'),unrelated=await identity(database.pool);
  const roleId=(await database.pool.query("SELECT id FROM roles WHERE code='module_author'")).rows[0].id;await database.pool.query("INSERT INTO example_notes(owner_id,title,body) VALUES($1,'Keep this note','Private retained text')",[actor.userId]);
  return {actor,issuer,unrelated,roleId};
}
async function invitation(issuer:string,roleId:string){
  const id=randomUUID(),credential=randomUUID(),issued=issueToken(),email=randomUUID()+'@example.test';
  await database.pool.query("INSERT INTO invites(id,email,normalized_email,inviter_id,expires_at) VALUES($1,$2,$2,$3,clock_timestamp()+interval '1 day');",[id,email,issuer]);await database.pool.query('INSERT INTO invite_roles(invite_id,role_id,role_id_at_issue,role_code,role_name,role_version_at_issue) SELECT $1,id,id,code,name,version FROM roles WHERE id=$2',[id,roleId]);
  const expires=(await database.pool.query<{expires_at:Date}>("INSERT INTO one_time_credentials(id,purpose,token_hash,invite_id,subject_version,target_email,normalized_target_email,credential_epoch,expires_at) VALUES($1,'invite_accept',$2,$3,1,$4,$4,'test-epoch',clock_timestamp()+interval '1 day') RETURNING expires_at",[credential,issued.hash,id,email])).rows[0]!.expires_at;
  const task=await withTransaction(database.pool,'shared',tx=>enqueueMail(tx,{activeKeyId:'v1',keys:new Map([['v1',Buffer.alloc(32,4)]])},{eventId:credential,credentialId:credential,purpose:'invite_accept',recipient:email,displayName:'',instanceName:'HonoCraft',locale:'en',timeZone:'UTC',token:issued.token,expiresAt:expires.toISOString()}));
  return {id,credential,token:issued.token,task};
}
it('disables grants atomically, retains data and revokes only invitations with affected role snapshots',async()=>{
  const s=await scenario(),userRole=(await database.pool.query("SELECT id FROM roles WHERE code='user'")).rows[0].id,affected=await invitation(s.issuer.userId,s.roleId),unrelated=await invitation(s.issuer.userId,userRole);
  await expect(withTransaction(database.pool,'read',tx=>currentCredential(tx,{id:affected.credential,purpose:'invite_accept',token:affected.token,epoch:'test-epoch'}))).resolves.not.toBeNull();const before=(await database.pool.query('SELECT name,checksum FROM migration_history ORDER BY name')).rows;
  expect(await change(false)).toMatchObject({changed:true,roles_affected:2,users_affected:2,invites_revoked:1,permissions_changed:4});await expect(checkDatabaseCompatibility(web,false)).resolves.toBeUndefined();expect((await database.pool.query("SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=$1",[s.roleId])).rows).toEqual([{code:'user:read'}]);expect((await database.pool.query('SELECT version FROM roles WHERE id=$1',[s.roleId])).rows[0].version).toBe(2);
  expect((await database.pool.query('SELECT revoked_reason FROM sessions WHERE id=$1',[s.actor.sessionId])).rows[0].revoked_reason).toBe('module_disabled');expect((await database.pool.query('SELECT revoked_at FROM sessions WHERE id=$1',[s.unrelated.sessionId])).rows[0].revoked_at).toBeNull();expect((await database.pool.query('SELECT version,authorization_version FROM users WHERE id=$1',[s.actor.userId])).rows[0]).toEqual({version:2,authorization_version:2});
  expect((await database.pool.query('SELECT status,version,terminal_reason FROM invites WHERE id=$1',[affected.id])).rows[0]).toEqual({status:'revoked',version:2,terminal_reason:'MODULE_DISABLED'});expect((await database.pool.query('SELECT revoked_at FROM one_time_credentials WHERE id=$1',[affected.credential])).rows[0].revoked_at).not.toBeNull();expect((await database.pool.query('SELECT status,payload_ciphertext,recipient FROM email_tasks WHERE id=$1',[affected.task])).rows[0]).toEqual({status:'cancelled',payload_ciphertext:null,recipient:null});
  await expect(withTransaction(database.pool,'read',tx=>currentCredential(tx,{id:affected.credential,purpose:'invite_accept',token:affected.token,epoch:'test-epoch'}))).resolves.toBeNull();await expect(withTransaction(database.pool,'read',tx=>currentCredential(tx,{id:unrelated.credential,purpose:'invite_accept',token:unrelated.token,epoch:'test-epoch'}))).resolves.not.toBeNull();expect((await database.pool.query('SELECT title,body FROM example_notes')).rows).toEqual([{title:'Keep this note',body:'Private retained text'}]);expect((await database.pool.query('SELECT name,checksum FROM migration_history ORDER BY name')).rows).toEqual(before);
});
it('does not silently restore removed grants after re-enabling and exposes only the re-authorized owner data',async()=>{
  const s=await scenario();await change(false);await change(true);const session=await sessionFor(database.pool,s.actor.userId),ref={...session,csrfToken:csrfForSession(Buffer.alloc(32,3),session.sessionId,'test-epoch')},notes=createNotesService(web,{epoch:'test-epoch',csrfKey:Buffer.alloc(32,3),digestKey:{id:'v1',key:Buffer.alloc(32,7)}});await expect(notes.list(ref,{})).rejects.toMatchObject({code:'FORBIDDEN'});await database.pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code='example-note:read'",[s.roleId]);expect(await notes.list(ref,{})).toMatchObject({total:1,items:[{title:'Keep this note',allowed_actions:[]}]});
});
it('rolls back permission deletion, versions, revoked invitations and mail cancellation when audit fails',async()=>{
  const s=await scenario(),invite=await invitation(s.issuer.userId,s.roleId);await database.pool.query("CREATE FUNCTION fail_module_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.action='ops.module.disabled' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END$$; CREATE TRIGGER fail_module_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_module_audit()");await expect(change(false)).rejects.toThrow();await expect(checkDatabaseCompatibility(web,true)).resolves.toBeUndefined();expect((await database.pool.query('SELECT version,authorization_version FROM users WHERE id=$1',[s.actor.userId])).rows[0]).toEqual({version:1,authorization_version:1});expect((await database.pool.query('SELECT revoked_at FROM sessions WHERE id=$1',[s.actor.sessionId])).rows[0].revoked_at).toBeNull();expect((await database.pool.query('SELECT status,version FROM invites WHERE id=$1',[invite.id])).rows[0]).toEqual({status:'pending',version:1});expect((await database.pool.query('SELECT status,payload_ciphertext IS NOT NULL encrypted FROM email_tasks WHERE id=$1',[invite.task])).rows[0]).toEqual({status:'queued',encrypted:true});
});
it('refuses inconsistent catalogs rather than silently repairing undeclared permissions',async()=>{
  await database.pool.query("INSERT INTO permissions(code,module,name_key,description_key) VALUES('unexpected:read','unexpected','unexpected','unexpected')");await expect(change(true)).rejects.toThrow('PERMISSION_CATALOG_INCOMPATIBLE');expect((await database.pool.query('SELECT example_notes_enabled FROM system_state')).rows[0].example_notes_enabled).toBe(false);
});
it('requires operator privileges and cannot be executed by the web role',async()=>{
  await expect(change(true,web)).rejects.toMatchObject({code:'42501'});await expect(checkDatabaseCompatibility(web,false)).resolves.toBeUndefined();expect((await database.pool.query('SELECT action FROM audit_events')).rowCount).toBe(0);
});
it('rejects invalid or extra operator input without changing the catalog',async()=>{
  for(const input of [{enabled:true,reason:''},{enabled:true,reason:'  '},{enabled:true,reason:'Reason',sql:'DROP TABLE users'}])await expect(setExampleNotesEnabled(database.pool,input,meta())).rejects.toMatchObject({code:'VALIDATION_ERROR'});await expect(checkDatabaseCompatibility(web,false)).resolves.toBeUndefined();
});
