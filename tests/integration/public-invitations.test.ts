import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {startTestPostgres} from '../helpers/postgres.js';
import {initializedDatabase} from '../helpers/identity.js';
import {invitation} from '../helpers/invitation.js';
import {migrate} from '../../apps/server/src/infrastructure/migrations.js';
import {createPasswordService} from '../../apps/server/src/infrastructure/passwords.js';
import {createPublicInvitationService} from '../../apps/server/src/modules/invitations/public.js';
import {withTransaction} from '../../apps/server/src/infrastructure/db.js';
import {enqueueMail} from '../../apps/server/src/modules/mail/outbox.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>,web:pg.Pool,passwords:Awaited<ReturnType<typeof createPasswordService>>;
const secrets={epoch:'test-epoch',digestKey:Buffer.alloc(32,8)};
const password='An invitation test secret passphrase',meta=()=>({requestId:randomUUID(),ip:'127.0.0.1',userAgent:'invitation test'});
const service=()=>createPublicInvitationService(web,secrets,passwords);
const accept=(token:string)=>service().accept({token,password,display_name:'Invited member'},meta());
beforeAll(async()=>{database=await startTestPostgres();web=new pg.Pool({connectionString:database.connectionString,options:'-c role=honocraft_web'});passwords=await createPasswordService({concurrency:2,blockedPasswords:new Set(['a common weak password'])});});
beforeEach(async()=>{await database.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await migrate(database.pool);await initializedDatabase(database.pool);});
afterAll(async()=>{await web?.end();await database?.close();});

it('previews only instance, email and expiry without consuming a credential or creating a user',async()=>{
  const invite=await invitation(database.pool),result=await service().preview({token:invite.token},meta());
  expect(result).toEqual({instance_name:'HonoCraft',email:invite.email,expires_at:expect.any(String)});
  expect((await database.pool.query('SELECT consumed_at FROM one_time_credentials WHERE id=$1',[invite.credentialId])).rows[0].consumed_at).toBeNull();
  expect((await database.pool.query('SELECT id FROM users WHERE normalized_email=$1',[invite.email])).rowCount).toBe(0);
});
it('accepts with registration closed, assigns every captured role, consumes mail and requires explicit login',async()=>{
  const invite=await invitation(database.pool,{roles:['user','admin'],inviterRole:'super_admin'});
  const keyring={activeKeyId:'v1',keys:new Map([['v1',Buffer.alloc(32,4)]])};
  const expires=(await database.pool.query('SELECT expires_at FROM one_time_credentials WHERE id=$1',[invite.credentialId])).rows[0].expires_at as Date;
  const task=await withTransaction(database.pool,'shared',tx=>enqueueMail(tx,keyring,{eventId:invite.credentialId,credentialId:invite.credentialId,purpose:'invite_accept',recipient:invite.email,displayName:'Member',instanceName:'HonoCraft',locale:'en',timeZone:'UTC',token:invite.token,expiresAt:expires.toISOString()}));
  // Invitation authority outlives the issuer's five-minute reauthentication window and session.
  await database.pool.query('DELETE FROM sessions WHERE user_id=$1',[invite.inviter.userId]);
  expect(await accept(invite.token)).toEqual({accepted:true,login_required:true});
  const user=(await database.pool.query('SELECT * FROM users WHERE normalized_email=$1',[invite.email])).rows[0];
  expect(user).toMatchObject({status:'active',creation_source:'invitation',display_name:'Invited member'});expect(user.email_verified_at).not.toBeNull();expect(await passwords.verify(user.password_hash,password)).toBe(true);
  expect((await database.pool.query('SELECT r.code FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE user_id=$1 ORDER BY r.code',[user.id])).rows).toEqual([{code:'admin'},{code:'user'}]);
  expect((await database.pool.query('SELECT id FROM sessions WHERE user_id=$1',[user.id])).rowCount).toBe(0);
  expect((await database.pool.query('SELECT status,version,accepted_by FROM invites WHERE id=$1',[invite.id])).rows[0]).toEqual({status:'accepted',version:2,accepted_by:user.id});
  expect((await database.pool.query('SELECT role_id FROM invite_roles WHERE invite_id=$1',[invite.id])).rows.every(row=>row.role_id===null)).toBe(true);
  expect((await database.pool.query('SELECT status,payload_ciphertext FROM email_tasks WHERE id=$1',[task])).rows[0]).toEqual({status:'cancelled',payload_ciphertext:null});
  await expect(accept(invite.token)).rejects.toMatchObject({code:'CREDENTIAL_INVALID'});
});
it.each(['epoch','expired','revoked','version','email'])('rejects an invalid %s envelope without changing any user or invite',async reason=>{
  const invite=await invitation(database.pool);
  if(reason==='epoch')await database.pool.query("UPDATE one_time_credentials SET credential_epoch='old'");
  if(reason==='expired')await database.pool.query("UPDATE invites SET expires_at=clock_timestamp()-interval '1 minute'");
  if(reason==='revoked')await database.pool.query('UPDATE one_time_credentials SET revoked_at=clock_timestamp()');
  if(reason==='version')await database.pool.query('UPDATE invites SET version=2');
  if(reason==='email')await database.pool.query("UPDATE invites SET email='other@example.test',normalized_email='other@example.test'");
  await expect(accept(invite.token)).rejects.toMatchObject({code:'CREDENTIAL_INVALID'});
  expect((await database.pool.query('SELECT consumed_at FROM one_time_credentials')).rows[0].consumed_at).toBeNull();
  expect((await database.pool.query('SELECT status FROM invites')).rows[0].status).toBe('pending');
});
it.each(['role-version','issuer-disabled','issuer-permissions','missing-role','privileged-role'])('requires reissue when %s changes while the envelope stays valid',async reason=>{
  const invite=await invitation(database.pool);
  if(reason==='role-version')await database.pool.query("UPDATE roles SET name='Renamed member',version=version+1 WHERE code='user'");
  if(reason==='issuer-disabled')await database.pool.query("UPDATE users SET status='suspended' WHERE id=$1",[invite.inviter.userId]);
  if(reason==='issuer-permissions')await database.pool.query('DELETE FROM user_roles WHERE user_id=$1',[invite.inviter.userId]);
  if(reason==='missing-role')await database.pool.query('UPDATE invite_roles SET role_id=NULL');
  if(reason==='privileged-role')await database.pool.query("UPDATE invite_roles SET role_id=(SELECT id FROM roles WHERE code='admin'),role_id_at_issue=(SELECT id FROM roles WHERE code='admin')");
  await expect(service().preview({token:invite.token},meta())).rejects.toMatchObject({code:'CREDENTIAL_INVALID'});
  await expect(accept(invite.token)).rejects.toMatchObject({code:'INVITE_REISSUE_REQUIRED'});
  expect((await database.pool.query('SELECT id FROM users WHERE normalized_email=$1',[invite.email])).rowCount).toBe(0);
});
it('rejects an occupied email including a soft-deleted account without overwriting it',async()=>{
  const invite=await invitation(database.pool);
  await database.pool.query("UPDATE users SET email=$2,normalized_email=$2,status='deleted',deleted_at=clock_timestamp() WHERE id=$1",[invite.inviter.userId,invite.email]);
  await expect(accept(invite.token)).rejects.toMatchObject({code:'EMAIL_CONFLICT'});
  expect((await database.pool.query('SELECT status,password_hash FROM users WHERE id=$1',[invite.inviter.userId])).rows[0]).toEqual({status:'deleted',password_hash:'test-hash-not-for-login'});
});
it('allows only one concurrent acceptance and records one audit with no raw credential',async()=>{
  const invite=await invitation(database.pool),results=await Promise.allSettled([accept(invite.token),accept(invite.token)]);
  expect(results.filter(item=>item.status==='fulfilled')).toHaveLength(1);expect(results.filter(item=>item.status==='rejected')).toHaveLength(1);
  const audit=await database.pool.query("SELECT * FROM audit_events WHERE action='invitations.invite.accepted'");expect(audit.rowCount).toBe(1);expect(JSON.stringify(audit.rows)).not.toContain(invite.token);expect(JSON.stringify(audit.rows)).not.toContain(password);
  expect((await database.pool.query('SELECT id FROM users WHERE normalized_email=$1',[invite.email])).rowCount).toBe(1);
});
it('rolls back user, role assignments, credential and invite when success audit insertion fails',async()=>{
  const invite=await invitation(database.pool);
  await database.pool.query("CREATE FUNCTION fail_invite_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='invitations.invite.accepted' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_invite_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_invite_audit()");
  await expect(accept(invite.token)).rejects.toThrow('test audit failure');
  expect((await database.pool.query('SELECT id FROM users WHERE normalized_email=$1',[invite.email])).rowCount).toBe(0);
  expect((await database.pool.query('SELECT consumed_at FROM one_time_credentials')).rows[0].consumed_at).toBeNull();
  expect((await database.pool.query('SELECT status,version FROM invites')).rows[0]).toEqual({status:'pending',version:1});
  expect((await database.pool.query('SELECT role_id FROM invite_roles')).rows[0].role_id).not.toBeNull();
});
it('rechecks role version after hashing without holding the security coordination lock',async()=>{
  const invite=await invitation(database.pool);
  const racing=createPublicInvitationService(web,secrets,{verify:passwords.verify,hash:async(value:string,minimum?:number)=>{
    const hash=await passwords.hash(value,minimum);await withTransaction(database.pool,'exclusive',async tx=>{await tx.query("UPDATE roles SET version=version+1 WHERE code='user'");});return hash;
  }});
  await expect(racing.accept({token:invite.token,password,display_name:'Race'},meta())).rejects.toMatchObject({code:'INVITE_REISSUE_REQUIRED'});
  expect((await database.pool.query('SELECT id FROM users WHERE normalized_email=$1',[invite.email])).rowCount).toBe(0);
});
it('rechecks a tightened password policy after hashing',async()=>{
  const invite=await invitation(database.pool);
  const racing=createPublicInvitationService(web,secrets,{verify:passwords.verify,hash:async(value:string,minimum?:number)=>{
    const hash=await passwords.hash(value,minimum);await database.pool.query("UPDATE system_settings SET typed_value=jsonb_set(typed_value,'{password_min_length}','64') WHERE key='security'");return hash;
  }});
  await expect(racing.accept({token:invite.token,password,display_name:'Race'},meta())).rejects.toMatchObject({code:'PASSWORD_REJECTED'});
});
it('rejects blocked passwords and privilege injection without consuming the invitation',async()=>{
  const invite=await invitation(database.pool);
  await expect(service().accept({token:invite.token,password:'a common weak password',display_name:'Member'},meta())).rejects.toMatchObject({code:'PASSWORD_REJECTED'});
  await expect(service().accept({token:invite.token,password,display_name:'Member',role_ids:['super_admin']},meta())).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  expect((await database.pool.query('SELECT consumed_at FROM one_time_credentials')).rows[0].consumed_at).toBeNull();
});
it('commits source quotas independently when an invitation is invalid',async()=>{
  const token='A'.repeat(43);for(let i=0;i<20;i++)await expect(accept(token)).rejects.toMatchObject({code:'CREDENTIAL_INVALID'});
  await expect(accept(token)).rejects.toMatchObject({code:'RATE_LIMITED'});
  expect((await database.pool.query("SELECT id FROM security_events WHERE event_type='auth.credential_rejected'")).rowCount).toBe(20);
});
