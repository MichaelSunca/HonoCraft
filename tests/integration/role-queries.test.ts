import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {startTestPostgres} from '../helpers/postgres.js';
import {identity,initializedDatabase} from '../helpers/identity.js';
import {invitation} from '../helpers/invitation.js';
import {migrate} from '../../apps/server/src/infrastructure/migrations.js';
import {createRoleQueries} from '../../apps/server/src/modules/access/queries.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>,web:pg.Pool;
const reader=()=>createRoleQueries(web,'test-epoch');
beforeAll(async()=>{database=await startTestPostgres();web=new pg.Pool({connectionString:database.connectionString,options:'-c role=honocraft_web'});});
beforeEach(async()=>{await database.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await migrate(database.pool);await initializedDatabase(database.pool);});
afterAll(async()=>{await web?.end();await database?.close();});
async function custom(code:string,permissions:string[]=[],delegable=true){
  const id=randomUUID();await database.pool.query('INSERT INTO roles(id,code,name,is_delegable) VALUES($1,$2,$2,$3)',[id,code,delegable]);
  await database.pool.query('INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code=ANY($2::text[])',[id,permissions]);return id;
}
it('lists custom roles through literal search, stable pagination and strict boolean filters',async()=>{
  const actor=await identity(database.pool,'admin');await custom('custom_one');await custom('custom_two');await custom('customxone');
  expect(await reader().list(actor,{query:'custom_',page_size:1,page:2})).toMatchObject({total:2,items:[{code:'custom_two'}]});
  expect(await reader().list(actor,{is_builtin:'false'})).toMatchObject({total:3});
  expect(await reader().list(actor,{is_builtin:'true'})).toMatchObject({total:3});
  expect(await reader().list(actor,{code:'custom_one'})).toMatchObject({total:1,items:[{code:'custom_one'}]});
  expect(await reader().list(actor,{query:' '.repeat(100)+'custom_one'+' '.repeat(100)})).toMatchObject({total:1});
  for(const query of [{is_builtin:'yes'},{page:0},{page_size:101},{sort:'email'},{query:'a'}])await expect(reader().list(actor,query)).rejects.toMatchObject({code:'VALIDATION_ERROR'});
});
it('counts all blocking references without exposing identities or granting built-in edits',async()=>{
  const actor=await identity(database.pool,'admin'),member=await identity(database.pool),invite=await invitation(database.pool);
  await database.pool.query("INSERT INTO users(email,normalized_email,display_name,status,creation_source,registration_role_id) SELECT 'waiting@example.test','waiting@example.test','Waiting','pending','registration',id FROM roles WHERE code='user'");
  const role=(await reader().list(actor,{code:'user'})).items[0]!;
  expect(role.reference_counts).toEqual({users:1,pending_registrations:1,registration_defaults:1,pending_invites:1});
  expect(role.allowed_actions).toEqual(['invite','copy']);expect(role.requires_reauth_actions).toEqual([]);
  for(const privateValue of [member.userId,invite.email,'waiting@example.test'])expect(JSON.stringify(role)).not.toContain(privateValue);
});
it('restricts edit and copy for own roles, privileged assignments and out-of-scope permissions',async()=>{
  const actor=await identity(database.pool,'admin'),superAdmin=await identity(database.pool,'super_admin');
  const ordinary=await custom('ordinary',['invite:read']),own=await custom('own_role'),assigned=await custom('assigned_role'),reserved=await custom('reserved_role',['role:delegate']);
  await database.pool.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2),($3,$4)',[actor.userId,own,superAdmin.userId,assigned]);
  expect((await reader().get(actor,ordinary)).allowed_actions).toEqual(['invite','copy','update','delete']);
  for(const id of [own,assigned])expect((await reader().get(actor,id)).allowed_actions).toEqual(['invite']);
  expect((await reader().get(actor,reserved)).allowed_actions).toEqual([]);
  expect((await reader().list(actor,{code:'admin'})).items[0]!.allowed_actions).toEqual([]);
});
it('describes high-risk invitation and role operations only for a real super administrator',async()=>{
  const actor=await identity(database.pool,'super_admin'),reserved=await custom('protected_role',['role:delegate'],false);
  const role=await reader().get(actor,reserved);
  expect(role.allowed_actions).toEqual(['invite','copy','update','delete','eligibility']);
  expect(role.requires_reauth_actions).toEqual(role.allowed_actions);
  const builtin=(await reader().list(actor,{code:'admin'})).items[0]!;
  expect(builtin.allowed_actions).toEqual(['invite','copy']);expect(builtin.requires_reauth_actions).toEqual(['invite']);
  const hiddenIdentity=await custom('false_super',['role:read','invite:read','invite:manage','user:manage-privileged','role:delegate','role:manage','permission:read']);
  const member=await identity(database.pool);await database.pool.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',[member.userId,hiddenIdentity]);
  expect((await reader().get(member,reserved)).allowed_actions).toEqual([]);
});
it('withholds delete for live references and distinguishes invitation authority from role management',async()=>{
  const inviter=await custom('inviter',['role:read','invite:read','invite:manage']),actor=await identity(database.pool),target=await custom('target_role');
  await database.pool.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',[actor.userId,inviter]);
  expect((await reader().get(actor,target)).allowed_actions).toEqual(['invite']);
  const superAdmin=await identity(database.pool,'super_admin');await database.pool.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',[actor.userId,target]);
  expect((await reader().get(superAdmin,target)).allowed_actions).not.toContain('delete');
});
it('checks role read permission before revealing target existence and honors current scope changes',async()=>{
  const member=await identity(database.pool),actor=await identity(database.pool,'admin'),id=await custom('changing_role');
  await expect(reader().get(member,id)).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(reader().get(member,randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(reader().get(actor,randomUUID())).rejects.toMatchObject({code:'NOT_FOUND'});
  expect((await reader().get(actor,id)).allowed_actions).toContain('invite');
  await database.pool.query('UPDATE roles SET is_delegable=false,version=version+1 WHERE id=$1',[id]);
  expect(await reader().get(actor,id)).toMatchObject({version:2,allowed_actions:[]});
});
