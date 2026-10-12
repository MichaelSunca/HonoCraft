import pg from 'pg';
import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {startTestPostgres} from '../helpers/postgres.js';
import {identity,initializedDatabase} from '../helpers/identity.js';
import {migrate} from '../../apps/server/src/infrastructure/migrations.js';
import {createPermissionQueries} from '../../apps/server/src/modules/access/permission-queries.js';
import {permissionDefinitions} from '../../packages/contracts/src/permissions.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>,web:pg.Pool;
const reader=()=>createPermissionQueries(web,'test-epoch');
beforeAll(async()=>{database=await startTestPostgres();web=new pg.Pool({connectionString:database.connectionString,options:'-c role=honocraft_web'});});
beforeEach(async()=>{await database.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await migrate(database.pool);await initializedDatabase(database.pool);});
afterAll(async()=>{await web?.end();await database?.close();});
it('reads the registered catalog through a restricted connection with exact attributes and dependencies',async()=>{
  const actor=await identity(database.pool,'admin'),catalog=await reader().list(actor,{});
  expect(catalog.catalog_version).toBe(1);expect(catalog.modules.map(group=>group.module)).toEqual(['audit','email-task','invite','permission','role','security-log','settings','user']);
  const permissions=catalog.modules.flatMap(group=>group.permissions);expect(permissions).toHaveLength(20);
  for(const permission of permissions){
    const definition=permissionDefinitions.find(item=>item.code===permission.code)!;
    expect(permission).toEqual({code:definition.code,module:definition.code.split(':')[0],name_key:'permissions.'+definition.code,description_key:'permissions.'+definition.code+'.description',
      is_reserved:definition.reserved,is_delegable:definition.delegable,is_self_assignable:definition.selfAssignable,catalog_version:1,dependencies:[...definition.dependencies].sort()});
  }
});
it('uses current permission:read independently of role:read and denies expired sessions',async()=>{
  const actor=await identity(database.pool,'admin'),member=await identity(database.pool);
  await expect(reader().list(member,{})).rejects.toMatchObject({code:'FORBIDDEN'});
  await database.pool.query("DELETE FROM role_permissions WHERE role_id=(SELECT id FROM roles WHERE code='admin') AND permission_id=(SELECT id FROM permissions WHERE code='role:read')");
  expect((await reader().list(actor,{module:'role'})).modules).toHaveLength(1);
  await database.pool.query("DELETE FROM role_permissions WHERE role_id=(SELECT id FROM roles WHERE code='admin') AND permission_id=(SELECT id FROM permissions WHERE code='permission:read')");
  await expect(reader().list(actor,{})).rejects.toMatchObject({code:'FORBIDDEN'});
  await database.pool.query("UPDATE sessions SET created_at=clock_timestamp()-interval '2 hours',last_seen_at=clock_timestamp()-interval '90 minutes',idle_expires_at=clock_timestamp()-interval '1 hour',absolute_expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[actor.sessionId]);
  await expect(reader().list(actor,{})).rejects.toMatchObject({code:'SESSION_INVALID'});
});
it('omits a disabled module even if catalog rows exist and exposes it only when enabled',async()=>{
  const actor=await identity(database.pool,'super_admin');
  await database.pool.query("INSERT INTO permissions(code,module,name_key,description_key,is_delegable) VALUES('example-note:read','example-note','permissions.example-note:read','permissions.example-note:read.description',true)");
  expect((await reader().list(actor,{module:'example-note'})).modules).toEqual([]);
  await database.pool.query('UPDATE system_state SET example_notes_enabled=true WHERE id=1');
  expect(await reader().list(actor,{module:'example-note'})).toMatchObject({catalog_version:1,modules:[{module:'example-note',permissions:[{code:'example-note:read'}]}]});
});
