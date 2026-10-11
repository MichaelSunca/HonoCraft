import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {startTestPostgres} from '../helpers/postgres.js';
import {identity,initializedDatabase} from '../helpers/identity.js';
import {invitation} from '../helpers/invitation.js';
import {migrate} from '../../apps/server/src/infrastructure/migrations.js';
import {csrfForSession,decryptPayload} from '../../apps/server/src/infrastructure/crypto.js';
import {mailAad} from '../../apps/server/src/modules/mail/outbox.js';
import {createInvitationManagement} from '../../apps/server/src/modules/invitations/management.js';
import {createPublicInvitationService} from '../../apps/server/src/modules/invitations/public.js';
import {createPasswordService} from '../../apps/server/src/infrastructure/passwords.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>,web:pg.Pool,passwords:Awaited<ReturnType<typeof createPasswordService>>;
const secrets={epoch:'test-epoch',csrfKey:Buffer.alloc(32,3),digestKey:{id:'test-v1',key:Buffer.alloc(32,7)},mailKeyring:{activeKeyId:'v1',keys:new Map([['v1',Buffer.alloc(32,4)]])}};
const userRole='00000000-0000-4000-8000-000000000003',adminRole='00000000-0000-4000-8000-000000000002';
const meta=()=>({requestId:randomUUID(),ip:'127.0.0.1',userAgent:'invitation management tests'});
const ref=(actor:Awaited<ReturnType<typeof identity>>)=>({token:actor.token,csrfToken:csrfForSession(secrets.csrfKey,actor.sessionId,secrets.epoch)});
const service=()=>createInvitationManagement(web,secrets);
const publicService=()=>createPublicInvitationService(web,{epoch:secrets.epoch,digestKey:secrets.digestKey.key},passwords);
const confirmation=(id:string)=>({target_id:id,reason:'Manage this invitation'});
beforeAll(async()=>{database=await startTestPostgres();web=new pg.Pool({connectionString:database.connectionString,options:'-c role=honocraft_web'});passwords=await createPasswordService({concurrency:2,blockedPasswords:new Set()});});
beforeEach(async()=>{await database.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await migrate(database.pool);await initializedDatabase(database.pool);});
afterAll(async()=>{await web?.end();await database?.close();});
async function created(actor:Awaited<ReturnType<typeof identity>>,email='guest@example.test',extra:Record<string,unknown>={}){
  return service().create(ref(actor),{email,...extra},meta(),randomUUID());
}
async function mail(){
  const row=(await database.pool.query("SELECT * FROM email_tasks WHERE status='queued' ORDER BY created_at DESC,id DESC LIMIT 1")).rows[0];
  if(!row)throw new Error('Missing queued invitation');
  return {row,payload:JSON.parse(decryptPayload(secrets.mailKeyring,{keyId:row.key_id,nonce:row.nonce,tag:row.auth_tag,ciphertext:row.payload_ciphertext},mailAad(row.id,row.purpose,row.template_version))) as {token:string}};
}
const cool=()=>database.pool.query("UPDATE rate_limit_buckets SET last_accepted_at=clock_timestamp()-interval '2 minutes'");
it('creates only an invitation with default user role and encrypted mail using the restricted web role',async()=>{
  const actor=await identity(database.pool,'admin'),result=await created(actor,'Guest@Example.TEST');
  expect(result).toMatchObject({status:202,replayed:false,data:{version:1,status:'pending',mail_status:'queued'}});
  const invite=(await database.pool.query('SELECT * FROM invites')).rows[0];expect(invite.normalized_email).toBe('guest@example.test');expect(invite.inviter_id).toBe(actor.userId);
  expect((await database.pool.query('SELECT role_id,role_version_at_issue FROM invite_roles')).rows).toEqual([{role_id:userRole,role_version_at_issue:1}]);
  expect((await database.pool.query("SELECT id FROM users WHERE normalized_email='guest@example.test'")).rowCount).toBe(0);
  const queued=await mail();expect(queued.row.payload_ciphertext).not.toBeNull();expect(JSON.stringify(result)).not.toContain(queued.payload.token);
  expect(await publicService().preview({token:queued.payload.token},meta())).toMatchObject({email:'Guest@example.test'});
});
it('replays creation without sending twice or charging quota, but rejects a different body',async()=>{
  const actor=await identity(database.pool,'admin'),key=randomUUID(),input={email:'same@example.test',role_ids:[userRole,userRole]};
  await service().create(ref(actor),input,meta(),key);const before=(await database.pool.query('SELECT sum(count)::int n FROM rate_limit_buckets')).rows[0].n;
  const replay=await service().create(ref(actor),{...input,role_ids:[userRole]},meta(),key);expect(replay.replayed).toBe(true);expect(replay.data).toHaveProperty('outcome','invite_created');
  expect((await database.pool.query('SELECT id FROM invites')).rowCount).toBe(1);expect((await database.pool.query('SELECT id FROM email_tasks')).rowCount).toBe(1);expect((await database.pool.query('SELECT sum(count)::int n FROM rate_limit_buckets')).rows[0].n).toBe(before);
  await expect(service().create(ref(actor),{...input,email:'different@example.test'},meta(),key)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
});
it('requires permission, CSRF, idempotency and a nonempty valid role collection',async()=>{
  const user=await identity(database.pool),admin=await identity(database.pool,'admin');
  await expect(created(user)).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(service().create({...ref(admin),csrfToken:''},{email:'new@example.test'},meta(),randomUUID())).rejects.toMatchObject({code:'CSRF_INVALID'});
  await expect(service().create(ref(admin),{email:'new@example.test'},meta())).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  await expect(created(admin,'new@example.test',{role_ids:[]})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  await expect(created(admin,'new@example.test',{role_ids:[randomUUID()]})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  expect((await database.pool.query('SELECT id FROM invites')).rowCount).toBe(0);
});
it('rejects existing accounts including soft-deleted ones and live pending invitations',async()=>{
  const actor=await identity(database.pool,'admin'),user=await identity(database.pool);
  await database.pool.query("UPDATE users SET status='deleted',deleted_at=clock_timestamp() WHERE id=$1",[user.userId]);
  await expect(created(actor,`${user.userId}@example.test`)).rejects.toMatchObject({code:'ACCOUNT_EXISTS'});
  await created(actor);await expect(created(actor)).rejects.toMatchObject({code:'INVITE_EXISTS'});expect((await database.pool.query('SELECT id FROM email_tasks')).rowCount).toBe(1);
});
it('expires an old pending invitation before creating a fresh ID and preserves terminal role snapshots',async()=>{
  const old=await invitation(database.pool,{email:'guest@example.test'}),actor=await identity(database.pool,'admin');
  await database.pool.query("UPDATE invites SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[old.id]);
  const result=await created(actor);expect(result.data).not.toHaveProperty('id',old.id);
  expect((await database.pool.query('SELECT status,version FROM invites WHERE id=$1',[old.id])).rows[0]).toEqual({status:'expired',version:2});
  expect((await database.pool.query('SELECT role_id,role_id_at_issue,role_code FROM invite_roles WHERE invite_id=$1',[old.id])).rows[0]).toEqual({role_id:null,role_id_at_issue:userRole,role_code:'user'});
  expect((await database.pool.query('SELECT revoked_at FROM one_time_credentials WHERE id=$1',[old.credentialId])).rows[0].revoked_at).not.toBeNull();
});
it('refuses admin grants from an ordinary administrator',async()=>{
  const actor=await identity(database.pool,'admin');await expect(created(actor,'power@example.test',{role_ids:[adminRole]})).rejects.toMatchObject({code:'FORBIDDEN'});
});
it('requires recent authentication and a server-checked label for privileged invitations',async()=>{
  const actor=await identity(database.pool,'super_admin'),email='power@example.test';
  const confirm={target_email:email,typed_label:email,reason:'Add another administrator'};
  await expect(created(actor,email,{role_ids:[adminRole],confirmation:confirm})).rejects.toMatchObject({code:'REAUTH_REQUIRED'});
  await database.pool.query("UPDATE sessions SET reauthenticated_at=clock_timestamp()-interval '30 seconds' WHERE id=$1",[actor.sessionId]);
  await expect(created(actor,email,{role_ids:[adminRole],confirmation:{...confirm,typed_label:'wrong@example.test'}})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  expect((await created(actor,email,{role_ids:[adminRole],confirmation:confirm})).status).toBe(202);
});
it('treats a nondelegable custom role as privileged and rechecks current scope on replay',async()=>{
  const actor=await identity(database.pool,'super_admin'),role=randomUUID(),email='custom@example.test',key=randomUUID();
  await database.pool.query("INSERT INTO roles(id,code,name) VALUES($1,'private_role','Private role')",[role]);
  const input={email,role_ids:[role],confirmation:{target_email:email,typed_label:email,reason:'Approved scope'}};
  await expect(service().create(ref(actor),input,meta(),key)).rejects.toMatchObject({code:'REAUTH_REQUIRED'});
  await database.pool.query("UPDATE sessions SET reauthenticated_at=clock_timestamp()-interval '30 seconds' WHERE id=$1",[actor.sessionId]);await service().create(ref(actor),input,meta(),key);
  await database.pool.query("UPDATE user_roles SET role_id=$2 WHERE user_id=$1",[actor.userId,adminRole]);
  await expect(service().create(ref(actor),input,meta(),key)).rejects.toMatchObject({code:'FORBIDDEN'});
});
it('enforces resend cooldown without revoking the previous credential or changing version',async()=>{
  const actor=await identity(database.pool,'admin');await created(actor);const invite=(await database.pool.query('SELECT id FROM invites')).rows[0],first=await mail();
  await expect(service().resend(ref(actor),{id:invite.id,expected_version:1,confirmation:confirmation(invite.id)},meta(),randomUUID())).rejects.toMatchObject({code:'RATE_LIMITED'});
  expect((await database.pool.query('SELECT version FROM invites')).rows[0].version).toBe(1);expect((await database.pool.query('SELECT revoked_at FROM one_time_credentials')).rows[0].revoked_at).toBeNull();
  expect(await publicService().preview({token:first.payload.token},meta())).toHaveProperty('email','guest@example.test');
});
it('resends with the current issuer and role versions while cancelling the old token and mail',async()=>{
  const actor=await identity(database.pool,'admin');await created(actor);const first=await mail(),id=(await database.pool.query('SELECT id FROM invites')).rows[0].id;
  await database.pool.query("UPDATE roles SET name='Renamed user',version=version+1 WHERE code='user'");await cool();const next=await identity(database.pool,'admin');
  const result=await service().resend(ref(next),{id,expected_version:1,confirmation:confirmation(id)},meta(),randomUUID());expect(result).toMatchObject({status:202,data:{id,version:2,mail_status:'queued'}});
  expect((await database.pool.query('SELECT inviter_id FROM invites WHERE id=$1',[id])).rows[0].inviter_id).toBe(next.userId);
  expect((await database.pool.query('SELECT role_name,role_version_at_issue FROM invite_roles')).rows[0]).toEqual({role_name:'Renamed user',role_version_at_issue:2});
  expect((await database.pool.query('SELECT status,payload_ciphertext FROM email_tasks WHERE id=$1',[first.row.id])).rows[0]).toEqual({status:'cancelled',payload_ciphertext:null});
  await expect(publicService().preview({token:first.payload.token},meta())).rejects.toMatchObject({code:'CREDENTIAL_INVALID'});
  expect(await publicService().accept({token:(await mail()).payload.token,password:'A management invitation passphrase',display_name:'New member'},meta())).toEqual({accepted:true,login_required:true});
});
it('rejects stale versions, wrong confirmation targets and expired resend requests',async()=>{
  const invite=await invitation(database.pool),actor=await identity(database.pool,'admin');
  await expect(service().resend(ref(actor),{id:invite.id,expected_version:2,confirmation:confirmation(invite.id)},meta(),randomUUID())).rejects.toMatchObject({code:'VERSION_CONFLICT'});
  await expect(service().revoke(ref(actor),{id:invite.id,expected_version:1,confirmation:confirmation(randomUUID())},meta(),randomUUID())).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  await database.pool.query("UPDATE invites SET expires_at=clock_timestamp()-interval '1 minute'");
  await expect(service().resend(ref(actor),{id:invite.id,expected_version:1,confirmation:confirmation(invite.id)},meta(),randomUUID())).rejects.toMatchObject({code:'INVITE_TERMINAL'});
});
it('revokes credentials, cancels mail and releases live role references once',async()=>{
  const actor=await identity(database.pool,'admin');await created(actor);const id=(await database.pool.query('SELECT id FROM invites')).rows[0].id,key=randomUUID(),input={id,expected_version:1,confirmation:confirmation(id)};
  expect(await service().revoke(ref(actor),input,meta(),key)).toMatchObject({status:200,data:{id,version:2,status:'revoked'}});
  expect((await service().revoke(ref(actor),input,meta(),key)).replayed).toBe(true);
  expect((await database.pool.query('SELECT role_id FROM invite_roles')).rows[0].role_id).toBeNull();expect((await database.pool.query('SELECT status,payload_ciphertext FROM email_tasks')).rows[0]).toEqual({status:'cancelled',payload_ciphertext:null});
  expect((await database.pool.query("SELECT id FROM audit_events WHERE action='invitations.invite.revoked' AND result='success'")).rowCount).toBe(1);
});
it('does not revoke an already accepted invitation or its account',async()=>{
  const actor=await identity(database.pool,'admin');await created(actor);const id=(await database.pool.query('SELECT id FROM invites')).rows[0].id;
  await publicService().accept({token:(await mail()).payload.token,password:'An accepted invitation password',display_name:'New member'},meta());
  await expect(service().revoke(ref(actor),{id,expected_version:2,confirmation:confirmation(id)},meta(),randomUUID())).rejects.toMatchObject({code:'INVITE_TERMINAL'});
  expect((await database.pool.query("SELECT status FROM users WHERE normalized_email='guest@example.test'")).rows[0].status).toBe('active');
});
it('rolls back invitation, mail, quota and idempotency when success audit fails',async()=>{
  const actor=await identity(database.pool,'admin');
  await database.pool.query("CREATE FUNCTION fail_created_invite() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='invitations.invite.created' AND NEW.result='success' THEN RAISE EXCEPTION 'test create audit'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_created_invite BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_created_invite()");
  await expect(created(actor)).rejects.toThrow('test create audit');
  for(const table of ['invites','invite_roles','one_time_credentials','email_tasks','idempotency_records','rate_limit_buckets'])expect((await database.pool.query(`SELECT * FROM ${table}`)).rowCount).toBe(0);
});
it('creates one invitation and one mail task when two administrators race for the same email',async()=>{
  const a=await identity(database.pool,'admin'),b=await identity(database.pool,'admin');
  const results=await Promise.allSettled([created(a),created(b)]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect(results.filter(result=>result.status==='rejected')).toMatchObject([{reason:{code:'INVITE_EXISTS'}}]);
  expect((await database.pool.query('SELECT id FROM invites')).rowCount).toBe(1);expect((await database.pool.query('SELECT id FROM email_tasks')).rowCount).toBe(1);
});
it.each(['source','target'])('enforces the current %s hourly quota without replacing the accepted mail',async dimension=>{
  const actor=await identity(database.pool,'admin');
  await database.pool.query("UPDATE system_settings SET typed_value=jsonb_set(typed_value,$1::text[],'1') WHERE key='security'",[[dimension==='source'?'mail_ip_per_hour':'mail_target_per_hour']]);
  await created(actor);const id=(await database.pool.query('SELECT id FROM invites')).rows[0].id;await cool();
  if(dimension==='source')await expect(created(actor,'second@example.test')).rejects.toMatchObject({code:'RATE_LIMITED'});
  else await expect(service().resend(ref(actor),{id,expected_version:1,confirmation:confirmation(id)},meta(),randomUUID())).rejects.toMatchObject({code:'RATE_LIMITED'});
  expect((await database.pool.query('SELECT id FROM email_tasks')).rowCount).toBe(1);expect((await database.pool.query('SELECT revoked_at FROM one_time_credentials')).rows[0].revoked_at).toBeNull();
});
it('requires recent authentication for a historical privileged replay even after its role becomes delegable',async()=>{
  const actor=await identity(database.pool,'super_admin'),id=randomUUID(),email='high@example.test',key=randomUUID();
  await database.pool.query("INSERT INTO roles(id,code,name) VALUES($1,'was_privileged','Private role')",[id]);
  await database.pool.query("UPDATE sessions SET reauthenticated_at=clock_timestamp()-interval '30 seconds' WHERE id=$1",[actor.sessionId]);
  const input={email,role_ids:[id],confirmation:{target_email:email,typed_label:email,reason:'Confirmed high access'}};
  await service().create(ref(actor),input,meta(),key);
  await database.pool.query('UPDATE roles SET is_delegable=true,version=version+1 WHERE id=$1',[id]);
  await database.pool.query("UPDATE sessions SET reauthenticated_at=clock_timestamp()-interval '6 minutes' WHERE id=$1",[actor.sessionId]);
  await expect(service().create(ref(actor),input,meta(),key)).rejects.toMatchObject({code:'REAUTH_REQUIRED'});
});
it('checks operation permission before revealing whether a mutation target exists',async()=>{
  const actor=await identity(database.pool),invite=await invitation(database.pool);
  for(const id of [invite.id,randomUUID()])await expect(service().revoke(ref(actor),{id,expected_version:1,confirmation:confirmation(id)},meta(),randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
});
