import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {startTestPostgres} from '../helpers/postgres.js';
import {identity,initializedDatabase} from '../helpers/identity.js';
import {invitation} from '../helpers/invitation.js';
import {migrate} from '../../apps/server/src/infrastructure/migrations.js';
import {csrfForSession} from '../../apps/server/src/infrastructure/crypto.js';
import {withTransaction} from '../../apps/server/src/infrastructure/db.js';
import {currentCredential} from '../../apps/server/src/modules/auth/credentials.js';
import {createRoleManagement} from '../../apps/server/src/modules/access/role-management.js';
import {RoleDtoSchema} from '../../packages/contracts/src/roles.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>,web:pg.Pool;
const secrets={epoch:'test-epoch',csrfKey:Buffer.alloc(32,3),digestKey:{id:'test-v1',key:Buffer.alloc(32,7)}};
const service=()=>createRoleManagement(web,secrets);
const meta=()=>({requestId:randomUUID(),ip:'127.0.0.1',userAgent:'role management tests'});
const ref=(actor:Awaited<ReturnType<typeof identity>>)=>({token:actor.token,csrfToken:csrfForSession(secrets.csrfKey,actor.sessionId,secrets.epoch)});
const confirm=(id:string,code?:string)=>({target_id:id,...(code?{typed_label:code}:{}),reason:'Configure this role'});
const verify=(actor:Awaited<ReturnType<typeof identity>>)=>database.pool.query("UPDATE sessions SET reauthenticated_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[actor.sessionId]);
async function role(code:string,permissions:string[]=[],delegable=true){
  const id=randomUUID();await database.pool.query('INSERT INTO roles(id,code,name,is_delegable) VALUES($1,$2,$2,$3)',[id,code,delegable]);
  await database.pool.query('INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code=ANY($2::text[])',[id,permissions]);return id;
}
beforeAll(async()=>{database=await startTestPostgres();web=new pg.Pool({connectionString:database.connectionString,options:'-c role=honocraft_web'});});
beforeEach(async()=>{await database.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await migrate(database.pool);await initializedDatabase(database.pool);});
afterAll(async()=>{await web?.end();await database?.close();});
it('creates with immutable identity, false qualifications, deduplicated permissions and a single replayable audit',async()=>{
  const actor=await identity(database.pool,'admin'),input={code:'support',name:'Support',permission_codes:['invite:read','invite:read']},key=randomUUID();
  const result=await service().create(ref(actor),input,meta(),key),dto=RoleDtoSchema.parse(result.data);
  expect(result.status).toBe(201);expect(dto).toMatchObject({code:'support',version:1,is_builtin:false,is_delegable:false,is_registration_default_eligible:false,permission_codes:['invite:read'],allowed_actions:[]});
  expect(await service().create(ref(actor),input,meta(),key)).toMatchObject({replayed:true,data:{outcome:'role_created',resource_id:dto.id,version:1}});
  expect((await database.pool.query("SELECT id FROM audit_events WHERE action='access.role.created' AND result='success'")).rowCount).toBe(1);
  await expect(service().create(ref(actor),{...input,name:'Different'},meta(),key)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  await expect(service().create(ref(actor),input,meta(),randomUUID())).rejects.toMatchObject({code:'ROLE_CODE_CONFLICT'});
});
it('rejects unsupported fields, missing dependencies, disabled permissions and unauthorized grants',async()=>{
  const actor=await identity(database.pool,'admin'),member=await identity(database.pool),input={code:'support',name:'Support',permission_codes:[]};
  await expect(service().create(ref(member),input,meta(),randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(service().create({...ref(actor),csrfToken:'invalid'},input,meta(),randomUUID())).rejects.toMatchObject({code:'CSRF_INVALID'});
  await expect(service().create(ref(actor),input,meta())).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  await expect(service().create(ref(actor),{...input,is_builtin:true},meta(),randomUUID())).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  await expect(service().create(ref(actor),{...input,permission_codes:['invite:manage']},meta(),randomUUID())).rejects.toMatchObject({code:'PERMISSION_DEPENDENCY_MISSING',fieldErrors:{permission_codes:expect.arrayContaining(['invite:read','role:read'])}});
  await expect(service().create(ref(actor),{...input,permission_codes:['example-note:read']},meta(),randomUUID())).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  await expect(service().create(ref(actor),{...input,permission_codes:['role:delegate']},meta(),randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
});
it('requires real super identity, recent authentication and code confirmation for reserved permissions',async()=>{
  const actor=await identity(database.pool,'super_admin'),input={code:'protected_support',name:'Protected',permission_codes:['role:delegate']};
  await expect(service().create(ref(actor),input,meta(),randomUUID())).rejects.toMatchObject({code:'REAUTH_REQUIRED'});await verify(actor);
  await expect(service().create(ref(actor),input,meta(),randomUUID())).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  await expect(service().create(ref(actor),{...input,confirmation:{target_code:input.code,typed_label:'wrong',reason:'Create'}},meta(),randomUUID())).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  expect(await service().create(ref(actor),{...input,confirmation:{target_code:input.code,typed_label:input.code,reason:'Create'}},meta(),randomUUID())).toMatchObject({data:{is_delegable:false,is_registration_default_eligible:false}});
});
it('metadata edits increment role version and invalidate invitations without revoking assigned sessions',async()=>{
  const actor=await identity(database.pool,'admin'),member=await identity(database.pool),id=await role('support');await database.pool.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',[member.userId,id]);const invite=await invitation(database.pool,{roles:['support']});
  const result=await service().update(ref(actor),{id,expected_version:1,name:'Renamed',confirmation:confirm(id)},meta(),randomUUID());expect(result).toMatchObject({data:{version:2,name:'Renamed'}});
  expect((await database.pool.query('SELECT authorization_version FROM users WHERE id=$1',[member.userId])).rows[0].authorization_version).toBe(1);expect((await database.pool.query('SELECT revoked_at FROM sessions WHERE id=$1',[member.sessionId])).rows[0].revoked_at).toBeNull();
  expect(await withTransaction(web,'read',tx=>currentCredential(tx,{id:invite.credentialId,purpose:'invite_accept',token:invite.token,epoch:secrets.epoch}))).toBeNull();
});
it('permission changes revoke every assigned session and increment authorization once in the same commit',async()=>{
  const actor=await identity(database.pool,'admin'),a=await identity(database.pool),b=await identity(database.pool),id=await role('support');await database.pool.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$3),($2,$3)',[a.userId,b.userId,id]);const input={id,expected_version:1,permission_codes:['invite:read'],confirmation:confirm(id)},key=randomUUID();
  expect(await service().update(ref(actor),input,meta(),key)).toMatchObject({data:{version:2,permission_codes:['invite:read']}});
  expect((await database.pool.query('SELECT authorization_version FROM users WHERE id=ANY($1::uuid[])',[ [a.userId,b.userId] ])).rows).toEqual([{authorization_version:2},{authorization_version:2}]);
  expect((await database.pool.query('SELECT id FROM sessions WHERE user_id=ANY($1::uuid[]) AND revoked_at IS NULL',[[a.userId,b.userId]])).rowCount).toBe(0);
  expect(await service().update(ref(actor),input,meta(),key)).toMatchObject({replayed:true});expect((await database.pool.query('SELECT authorization_version FROM users WHERE id=$1',[a.userId])).rows[0].authorization_version).toBe(2);
});
it('rejects built-in edits, stale versions, self-assigned roles and roles held by privileged users',async()=>{
  const actor=await identity(database.pool,'admin'),superAdmin=await identity(database.pool,'super_admin'),id=await role('support');
  await expect(service().update(ref(superAdmin),{id:'00000000-0000-4000-8000-000000000003',expected_version:1,name:'Changed',confirmation:confirm('00000000-0000-4000-8000-000000000003')},meta(),randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(service().update(ref(actor),{id,expected_version:2,name:'Changed',confirmation:confirm(id)},meta(),randomUUID())).rejects.toMatchObject({code:'VERSION_CONFLICT'});
  await database.pool.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',[actor.userId,id]);
  await expect(service().update(ref(actor),{id,expected_version:1,name:'Changed',confirmation:confirm(id)},meta(),randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
  await database.pool.query('DELETE FROM user_roles WHERE user_id=$1 AND role_id=$2',[actor.userId,id]);await database.pool.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',[superAdmin.userId,id]);
  await expect(service().copy(ref(actor),{id,expected_version:1,new_code:'copy_support',new_name:'Copy'},meta(),randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
});
it('copies permitted built-ins into distinct non-built-in roles without copying qualifications',async()=>{
  const actor=await identity(database.pool,'admin'),id='00000000-0000-4000-8000-000000000003';
  const result=await service().copy(ref(actor),{id,expected_version:1,new_code:'copy_user',new_name:'Copy'},meta(),randomUUID());expect(result.status).toBe(201);expect(result.data).toMatchObject({code:'copy_user',is_builtin:false,is_delegable:false,is_registration_default_eligible:false,version:1});expect(RoleDtoSchema.parse(result.data).id).not.toBe(id);
});
it('copies the effective super-admin permission catalog without copying the protected identity',async()=>{
  const actor=await identity(database.pool,'super_admin'),id='00000000-0000-4000-8000-000000000001',input={id,expected_version:1,new_code:'protected_copy',new_name:'Protected copy',confirmation:confirm(id,'super_admin')};
  await expect(service().copy(ref(actor),input,meta(),randomUUID())).rejects.toMatchObject({code:'REAUTH_REQUIRED'});await verify(actor);
  const result=RoleDtoSchema.parse((await service().copy(ref(actor),input,meta(),randomUUID())).data);expect(result).toMatchObject({is_builtin:false,is_delegable:false,is_registration_default_eligible:false});expect(result.permission_codes).toContain('settings:update-security');expect(result.permission_codes).toContain('role:delegate');expect(result.permission_codes).toHaveLength(20);
});
it('qualification changes require a real verified super administrator and invalidate assigned sessions',async()=>{
  const actor=await identity(database.pool,'super_admin'),member=await identity(database.pool),id=await role('support'),input={id,expected_version:1,is_delegable:false,is_registration_default_eligible:true,confirmation:confirm(id,'support')};
  await expect(service().eligibility(ref(actor),input,meta(),randomUUID())).rejects.toMatchObject({code:'REAUTH_REQUIRED'});await verify(actor);await database.pool.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',[member.userId,id]);
  expect(await service().eligibility(ref(actor),input,meta(),randomUUID())).toMatchObject({data:{version:2,is_delegable:false,is_registration_default_eligible:true}});
  expect((await database.pool.query('SELECT revoked_at FROM sessions WHERE id=$1',[member.sessionId])).rows[0].revoked_at).not.toBeNull();
  const fakeId=await role('fake_super',['role:read','role:manage','role:delegate','permission:read','settings:read','settings:update-security'],false),fake=await identity(database.pool,'fake_super');await verify(fake);
  await expect(service().eligibility(ref(fake),{...input,id:fakeId,confirmation:confirm(fakeId,'fake_super')},meta(),randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
});
it('preserves registration defaults and pending registration references against qualification or permission changes',async()=>{
  const actor=await identity(database.pool,'super_admin'),id=await role('registration_role');await verify(actor);await database.pool.query('UPDATE roles SET is_registration_default_eligible=true WHERE id=$1',[id]);await database.pool.query("UPDATE system_settings SET registration_default_role_id=$1 WHERE key='security'",[id]);
  await expect(service().eligibility(ref(actor),{id,expected_version:1,is_delegable:true,is_registration_default_eligible:false,confirmation:confirm(id,'registration_role')},meta(),randomUUID())).rejects.toMatchObject({code:'REGISTRATION_ROLE_IN_USE'});
  await expect(service().update(ref(actor),{id,expected_version:1,permission_codes:['invite:read'],confirmation:confirm(id)},meta(),randomUUID())).rejects.toMatchObject({code:'REGISTRATION_ROLE_INVALID'});
  await database.pool.query("UPDATE system_settings SET registration_default_role_id='00000000-0000-4000-8000-000000000003' WHERE key='security'; INSERT INTO users(email,normalized_email,display_name,creation_source,registration_role_id) SELECT 'pending@example.test','pending@example.test','Pending','registration',id FROM roles WHERE code='registration_role'");
  await expect(service().eligibility(ref(actor),{id,expected_version:1,is_delegable:false,is_registration_default_eligible:false,confirmation:confirm(id,'registration_role')},meta(),randomUUID())).rejects.toMatchObject({code:'REGISTRATION_ROLE_IN_USE'});
});
it('rejects delegable or self-assignable qualifications for a reserved-permission role',async()=>{
  const actor=await identity(database.pool,'super_admin'),id=await role('reserved_role',['role:delegate'],false);await verify(actor);
  await expect(service().eligibility(ref(actor),{id,expected_version:1,is_delegable:true,is_registration_default_eligible:false,confirmation:confirm(id,'reserved_role')},meta(),randomUUID())).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  await expect(service().eligibility(ref(actor),{id,expected_version:1,is_delegable:false,is_registration_default_eligible:true,confirmation:confirm(id,'reserved_role')},meta(),randomUUID())).rejects.toMatchObject({code:'REGISTRATION_ROLE_INVALID'});
});
it('reports blocking references without deleting relationships or silently terminating invitations',async()=>{
  const actor=await identity(database.pool,'super_admin'),id=await role('support'),invite=await invitation(database.pool,{roles:['support']});
  await expect(service().delete(ref(actor),{id,expected_version:1,confirmation:confirm(id)},meta(),randomUUID())).rejects.toMatchObject({code:'ROLE_IN_USE',fieldErrors:{'reference_counts.pending_invites':['1']}});
  expect((await database.pool.query('SELECT status FROM invites WHERE id=$1',[invite.id])).rows[0].status).toBe('pending');expect((await database.pool.query('SELECT role_id FROM invite_roles WHERE invite_id=$1',[invite.id])).rows[0].role_id).toBe(id);
});
it('deletes unreferenced roles once and reauthorizes minimal historical results after deletion',async()=>{
  const actor=await identity(database.pool,'admin'),id=await role('support'),input={id,expected_version:1,confirmation:confirm(id)},key=randomUUID();
  expect(await service().delete(ref(actor),input,meta(),key)).toMatchObject({data:{deleted:true,id}});expect(await service().delete(ref(actor),input,meta(),key)).toMatchObject({replayed:true,data:{outcome:'role_deleted',resource_id:id}});
  await database.pool.query("DELETE FROM role_permissions WHERE role_id=(SELECT id FROM roles WHERE code='admin') AND permission_id=(SELECT id FROM permissions WHERE code='role:manage')");
  await expect(service().delete(ref(actor),input,meta(),key)).rejects.toMatchObject({code:'FORBIDDEN'});
});
it('historical reserved scope still requires recent authentication after permissions are removed',async()=>{
  const actor=await identity(database.pool,'super_admin'),id=await role('reserved_role',['role:delegate'],false);await verify(actor);const input={id,expected_version:1,permission_codes:[],confirmation:confirm(id,'reserved_role')},key=randomUUID();
  await service().update(ref(actor),input,meta(),key);await database.pool.query('UPDATE sessions SET reauthenticated_at=NULL WHERE id=$1',[actor.sessionId]);await expect(service().update(ref(actor),input,meta(),key)).rejects.toMatchObject({code:'REAUTH_REQUIRED'});
});
it('rolls back role permissions, user versions, sessions and idempotency when success audit fails',async()=>{
  const actor=await identity(database.pool,'admin'),member=await identity(database.pool),id=await role('support');await database.pool.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',[member.userId,id]);
  await database.pool.query("CREATE FUNCTION fail_role_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='access.role.updated' AND NEW.result='success' THEN RAISE EXCEPTION 'role audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_role_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_role_audit()");
  await expect(service().update(ref(actor),{id,expected_version:1,permission_codes:['invite:read'],confirmation:confirm(id)},meta(),randomUUID())).rejects.toThrow('role audit failure');
  expect((await database.pool.query('SELECT version FROM roles WHERE id=$1',[id])).rows[0].version).toBe(1);expect((await database.pool.query('SELECT id FROM permissions p JOIN role_permissions rp ON p.id=rp.permission_id WHERE rp.role_id=$1',[id])).rowCount).toBe(0);expect((await database.pool.query('SELECT authorization_version FROM users WHERE id=$1',[member.userId])).rows[0].authorization_version).toBe(1);expect((await database.pool.query('SELECT revoked_at FROM sessions WHERE id=$1',[member.sessionId])).rows[0].revoked_at).toBeNull();expect((await database.pool.query("SELECT id FROM idempotency_records WHERE operation='roles.update'")).rowCount).toBe(0);
});
it('serializes simultaneous updates so only one expected version can commit',async()=>{
  const actor=await identity(database.pool,'admin'),other=await identity(database.pool,'admin'),id=await role('support');
  const results=await Promise.allSettled([actor,other].map(user=>service().update(ref(user),{id,expected_version:1,name:randomUUID(),confirmation:confirm(id)},meta(),randomUUID())));
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(results.find(result=>result.status==='rejected')).toMatchObject({reason:{code:'VERSION_CONFLICT'}});expect((await database.pool.query('SELECT version FROM roles WHERE id=$1',[id])).rows[0].version).toBe(2);
});
