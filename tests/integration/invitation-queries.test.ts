import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {startTestPostgres} from '../helpers/postgres.js';
import {identity,initializedDatabase} from '../helpers/identity.js';
import {invitation} from '../helpers/invitation.js';
import {migrate} from '../../apps/server/src/infrastructure/migrations.js';
import {createInvitationQueries} from '../../apps/server/src/modules/invitations/queries.js';
import {createInvitationManagement} from '../../apps/server/src/modules/invitations/management.js';
import {csrfForSession} from '../../apps/server/src/infrastructure/crypto.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>;
const secrets={epoch:'test-epoch',csrfKey:Buffer.alloc(32,3),digestKey:{id:'test-v1',key:Buffer.alloc(32,7)},mailKeyring:{activeKeyId:'v1',keys:new Map([['v1',Buffer.alloc(32,4)]])}};
const reader=()=>createInvitationQueries(database.pool,secrets.epoch);
const ref=(actor:Awaited<ReturnType<typeof identity>>)=>({token:actor.token,csrfToken:csrfForSession(secrets.csrfKey,actor.sessionId,secrets.epoch)});
beforeAll(async()=>{database=await startTestPostgres();});
beforeEach(async()=>{await database.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await migrate(database.pool);await initializedDatabase(database.pool);});
afterAll(async()=>{await database?.close();});
it('lists and counts in stable order with literal email filtering and distinct expired status',async()=>{
  const actor=await identity(database.pool,'admin');
  const a=await invitation(database.pool,{email:'a_%@example.test'}),b=await invitation(database.pool,{email:'abc@example.test'});await invitation(database.pool,{email:'zzz@example.test'});
  await database.pool.query("UPDATE invites SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[b.id]);
  expect(await reader().list(ref(actor),{query:'a_%',sort:'email',direction:'asc'})).toMatchObject({total:1,items:[{id:a.id,email:'a_%@example.test',status:'pending'}]});
  expect(await reader().list(ref(actor),{query:' '.repeat(60)+'abc'+' '.repeat(60)})).toMatchObject({total:1,items:[{id:b.id}]});
  expect(await reader().list(ref(actor),{status:'expired'})).toMatchObject({total:1,items:[{id:b.id,status:'expired',allowed_actions:['reinvite']}]});
  expect(await reader().list(ref(actor),{sort:'email',direction:'asc',page_size:'1',page:'2'})).toMatchObject({page:2,page_size:1,total:3,items:[{id:b.id}]});
  expect((await database.pool.query('SELECT status FROM invites WHERE id=$1',[b.id])).rows[0].status).toBe('pending');
});
it('filters inviter and inclusive-from/exclusive-to timestamps',async()=>{
  const a=await invitation(database.pool),b=await invitation(database.pool);
  await database.pool.query("UPDATE invites SET created_at='2026-10-01T00:00:00Z' WHERE id=$1",[a.id]);
  await database.pool.query("UPDATE invites SET created_at='2026-10-02T00:00:00Z' WHERE id=$1",[b.id]);
  expect(await reader().list(ref(a.inviter),{created_from:'2026-10-01T00:00:00Z',created_to:'2026-10-02T00:00:00Z'})).toMatchObject({total:1,items:[{id:a.id}]});
  expect(await reader().list(ref(a.inviter),{inviter_id:b.inviter.userId})).toMatchObject({total:1,items:[{id:b.id}]});
});
it('requires invite:read even for a known or nonexistent target',async()=>{
  const user=await identity(database.pool),invite=await invitation(database.pool);
  await expect(reader().list(ref(user),{})).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(reader().get(ref(user),invite.id)).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(reader().get(ref(user),randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
});
it('returns role snapshots and mail status without credential or transport payload',async()=>{
  const actor=await identity(database.pool,'admin');
  await createInvitationManagement(database.pool,secrets).create(ref(actor),{email:'private@example.test'},{requestId:randomUUID(),ip:'127.0.0.1',userAgent:'reader test'},randomUUID());
  const id=(await database.pool.query('SELECT id FROM invites')).rows[0].id;
  expect(await reader().get(ref(actor),id)).toMatchObject({id,email:'private@example.test',roles:[{code:'user',version:1}],mail:{status:'queued',attempts:0},allowed_actions:['resend','revoke'],requires_reauth_actions:[]});
  const value=JSON.stringify(await reader().get(ref(actor),id));for(const secret of ['token_hash','payload_ciphertext','recipient','provider_message_id'])expect(value).not.toContain(secret);
});
it('keeps historical role names and differentiates read permission from current grant scope',async()=>{
  const actor=await identity(database.pool,'admin'),invite=await invitation(database.pool,{inviterRole:'super_admin',roles:['admin']});
  expect(await reader().get(ref(actor),invite.id)).toMatchObject({allowed_actions:[],requires_reauth_actions:[]});
  expect(await reader().get(ref(invite.inviter),invite.id)).toMatchObject({allowed_actions:['resend','revoke'],requires_reauth_actions:['resend','revoke']});
  await database.pool.query("UPDATE roles SET name='New administrator name',version=version+1 WHERE code='admin'");
  const detail=await reader().get(ref(invite.inviter),invite.id);expect(detail).toMatchObject({roles:[{code:'admin',version:1}]});expect(JSON.stringify(detail)).not.toContain('New administrator name');
});
it('rejects unsupported filters, unbounded pages, invalid date ranges and malformed IDs',async()=>{
  const actor=await identity(database.pool,'admin');
  for(const query of [{query:'a'},{sort:'password_hash'},{page_size:'101'},{unexpected:'true'},{created_from:'2026-10-03T00:00:00Z',created_to:'2026-10-02T00:00:00Z'}])await expect(reader().list(ref(actor),query)).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  await expect(reader().get(ref(actor),'invalid')).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  await expect(reader().get(ref(actor),randomUUID())).rejects.toMatchObject({code:'NOT_FOUND'});
});
