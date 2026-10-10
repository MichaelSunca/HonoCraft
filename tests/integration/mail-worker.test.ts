import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import {startSmtpFixture} from '../helpers/smtp.js';
import {startTestPostgres} from '../helpers/postgres.js';
import {identity,initializedDatabase} from '../helpers/identity.js';
import {migrate} from '../../apps/server/src/infrastructure/migrations.js';
import {withTransaction} from '../../apps/server/src/infrastructure/db.js';
import {issueToken} from '../../apps/server/src/infrastructure/crypto.js';
import {enqueueMail,claimTasks} from '../../apps/server/src/modules/mail/outbox.js';
import {createSmtpTransport} from '../../apps/server/src/modules/mail/smtp.js';
import {runDelivery} from '../../apps/server/src/modules/mail/worker.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>;let smtp:Awaited<ReturnType<typeof startSmtpFixture>>;
const keyring={activeKeyId:'v1',keys:new Map([['v1',Buffer.alloc(32,4)]])};
beforeAll(async()=>{database=await startTestPostgres();await migrate(database.pool);await initializedDatabase(database.pool);smtp=await startSmtpFixture();});
beforeEach(async()=>{await database.pool.query('DELETE FROM email_tasks');smtp.messages.splice(0);});
afterAll(async()=>{await smtp?.close();await database?.close();});
const transport=()=>createSmtpTransport({host:'127.0.0.1',port:smtp.port,secure:false,user:undefined,password:undefined,from:'noreply@example.test',mode:'capture'});
async function pendingMail(){
  const user=await identity(database.pool);const token=issueToken();const id=randomUUID();const recipient=`${user.userId}@example.test`;
  const row=(await database.pool.query(`INSERT INTO one_time_credentials(id,purpose,token_hash,user_id,subject_version,target_email,normalized_target_email,credential_epoch,expires_at)
    VALUES ($1,'password_reset',$2,$3,1,$4,$4,'test-epoch',clock_timestamp()+interval '30 minutes') RETURNING expires_at`,[id,token.hash,user.userId,recipient])).rows[0];
  const task=await withTransaction(database.pool,'shared',tx=>enqueueMail(tx,keyring,{eventId:randomUUID(),purpose:'password_reset',credentialId:id,token:token.token,expiresAt:row.expires_at.toISOString(),recipient,displayName:'User',instanceName:'HonoCraft',locale:'en',timeZone:'UTC'}));
  const [lease]=await claimTasks(database.pool,randomUUID(),1);
  return {user,credentialId:id,task,lease:lease!,token:token.token};
}
const deliver=(lease:Awaited<ReturnType<typeof pendingMail>>['lease'],ring=keyring)=>runDelivery(database.pool,{origin:'https://app.example.test',epoch:'test-epoch',keyring:ring},transport(),lease);
describe('mail worker delivery qualification',()=>{
  it('decrypts and sends an eligible credential without consuming it',async()=>{
    const pending=await pendingMail();expect(await deliver(pending.lease)).toBe('sent');expect(smtp.messages).toHaveLength(1);
    expect((await database.pool.query('SELECT consumed_at FROM one_time_credentials WHERE id=$1',[pending.credentialId])).rows[0].consumed_at).toBeNull();
    expect((await database.pool.query('SELECT status,recipient,payload_ciphertext FROM email_tasks WHERE id=$1',[pending.task])).rows[0]).toEqual({status:'sent',recipient:null,payload_ciphertext:null});
  });
  it.each(['revoked','consumed','expired','epoch','version','suspended','email'] as const)('cancels a %s credential without sending a message',async reason=>{
    const pending=await pendingMail();
    if(reason==='revoked')await database.pool.query('UPDATE one_time_credentials SET revoked_at=clock_timestamp() WHERE id=$1',[pending.credentialId]);
    if(reason==='consumed')await database.pool.query('UPDATE one_time_credentials SET consumed_at=clock_timestamp() WHERE id=$1',[pending.credentialId]);
    if(reason==='expired')await database.pool.query("UPDATE one_time_credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[pending.credentialId]);
    if(reason==='epoch')await database.pool.query("UPDATE one_time_credentials SET credential_epoch='previous-epoch' WHERE id=$1",[pending.credentialId]);
    if(reason==='version')await database.pool.query('UPDATE users SET authorization_version=authorization_version+1 WHERE id=$1',[pending.user.userId]);
    if(reason==='suspended')await database.pool.query("UPDATE users SET status='suspended' WHERE id=$1",[pending.user.userId]);
    if(reason==='email')await database.pool.query("UPDATE users SET email='changed-'||email,normalized_email='changed-'||normalized_email WHERE id=$1",[pending.user.userId]);
    expect(await deliver(pending.lease)).toBe('cancelled');expect(smtp.messages).toHaveLength(0);
  });
  it('fails closed when the keyring cannot authenticate the payload',async()=>{
    const pending=await pendingMail();expect(await deliver(pending.lease,{activeKeyId:'v1',keys:new Map([['v1',Buffer.alloc(32,5)]])})).toBe('failed');expect(smtp.messages).toHaveLength(0);
  });
  it('rejects tampering with the plaintext delivery address',async()=>{
    const pending=await pendingMail();await database.pool.query("UPDATE email_tasks SET recipient='attacker@example.test' WHERE id=$1",[pending.task]);
    expect(await deliver(pending.lease)).toBe('failed');expect(smtp.messages).toHaveLength(0);
  });
  it('discards an acknowledgement after cancellation wins the race',async()=>{
    const pending=await pendingMail();const real=transport();
    const outcome=await runDelivery(database.pool,{origin:'https://app.example.test',epoch:'test-epoch',keyring},{send:async message=>{
      const sent=await real.send(message);
      await database.pool.query(`UPDATE email_tasks SET status='cancelled',lease_version=lease_version+1,lease_owner=NULL,lease_expires_at=NULL,
        recipient=NULL,payload_ciphertext=NULL,nonce=NULL,auth_tag=NULL,key_id=NULL WHERE id=$1`,[pending.task]);
      await database.pool.query('UPDATE one_time_credentials SET revoked_at=clock_timestamp() WHERE id=$1',[pending.credentialId]);
      return sent;
    }},pending.lease);
    expect(outcome).toBe('lease_lost');expect(smtp.messages).toHaveLength(1);
    expect((await database.pool.query('SELECT status FROM email_tasks WHERE id=$1',[pending.task])).rows[0].status).toBe('cancelled');
  });
});
