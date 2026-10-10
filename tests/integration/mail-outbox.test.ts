import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { startTestPostgres } from '../helpers/postgres.js';
import { migrate } from '../../apps/server/src/infrastructure/migrations.js';
import { withTransaction } from '../../apps/server/src/infrastructure/db.js';
import { enqueueMail,claimTasks,finishTask,recoverExpiredLeases,readClaimedTask } from '../../apps/server/src/modules/mail/outbox.js';
const keyring={activeKeyId:'v1',keys:new Map([['v1',Buffer.alloc(32,4)]])};
let database:Awaited<ReturnType<typeof startTestPostgres>>;
beforeAll(async()=>{database=await startTestPostgres();await migrate(database.pool);});
beforeEach(async()=>{await database.pool.query('DELETE FROM email_tasks');});
afterAll(async()=>{await database?.close();});
const event=(eventId=randomUUID())=>({eventId,purpose:'password_changed' as const,recipient:'recipient@example.test',displayName:'Test',instanceName:'HonoCraft',locale:'en' as const,timeZone:'Asia/Tokyo',occurredAt:new Date().toISOString()});
const enqueue=(input=event())=>withTransaction(database.pool,'shared',tx=>enqueueMail(tx,keyring,input));

describe('encrypted mail outbox with fenced delivery leases',()=>{
  it('deduplicates business events and never stores template data in plaintext',async()=>{
    const input=event();const id=await enqueue(input);expect(await enqueue(input)).toBe(id);
    const row=(await database.pool.query('SELECT * FROM email_tasks WHERE id=$1',[id])).rows[0];
    expect(row.payload_ciphertext).toBeInstanceOf(Buffer);expect(row.payload_ciphertext.toString()).not.toContain('HonoCraft');
    expect(row.recipient_masked).not.toContain('recipient@');expect(row.attempts).toBe(0);
  });
  it('rolls back an enqueued mail when its enclosing business transaction fails',async()=>{
    await expect(withTransaction(database.pool,'shared',async tx=>{await enqueueMail(tx,keyring,event());throw new Error('reject');})).rejects.toThrow('reject');
    expect((await database.pool.query('SELECT id FROM email_tasks')).rowCount).toBe(0);
  });
  it('allows only one concurrent worker to claim a task',async()=>{
    const id=await enqueue();const results=await Promise.all([claimTasks(database.pool,randomUUID(),1),claimTasks(database.pool,randomUUID(),1)]);
    expect(results.flat()).toHaveLength(1);expect(results.flat()[0]).toMatchObject({id,attempts:1,leaseVersion:1});
    const lease=results.flat()[0]!;expect(await readClaimedTask(database.pool,lease)).not.toBeNull();
  });
  it('clears sensitive data on accepted delivery and prevents a stale worker from overwriting it',async()=>{
    const id=await enqueue();const [lease]=await claimTasks(database.pool,randomUUID(),1);
    expect(await finishTask(database.pool,lease!,{kind:'sent',messageId:`<${id}@honocraft.invalid>`})).toBe(true);
    expect(await finishTask(database.pool,lease!,{kind:'retry',code:'SMTP_TEMPORARY'})).toBe(false);
    const row=(await database.pool.query('SELECT status,recipient,payload_ciphertext,nonce,auth_tag,key_id,lease_owner FROM email_tasks WHERE id=$1',[id])).rows[0];
    expect(row).toEqual({status:'sent',recipient:null,payload_ciphertext:null,nonce:null,auth_tag:null,key_id:null,lease_owner:null});
  });
  it('retries twice with bounded backoff and permanently fails the third attempt',async()=>{
    const id=await enqueue();
    for(let attempt=1;attempt<=3;attempt++){
      const [lease]=await claimTasks(database.pool,randomUUID(),1);expect(lease?.attempts).toBe(attempt);
      await finishTask(database.pool,lease!,{kind:'retry',code:'SMTP_TEMPORARY'});
      const row=(await database.pool.query('SELECT status,payload_ciphertext,error_code,extract(epoch FROM next_attempt_at-updated_at)::float AS delay FROM email_tasks WHERE id=$1',[id])).rows[0];
      if(attempt<3){expect(row.status).toBe('queued');expect(row.delay).toBeGreaterThanOrEqual(attempt===1?60:300);expect(row.delay).toBeLessThanOrEqual(attempt===1?70:330);await database.pool.query('UPDATE email_tasks SET next_attempt_at=clock_timestamp() WHERE id=$1',[id]);}
      else {expect(row).toMatchObject({status:'failed',payload_ciphertext:null,error_code:'RETRY_EXHAUSTED'});}
    }
    expect(await claimTasks(database.pool,randomUUID(),1)).toEqual([]);
  });
  it('recovers an expired lease with backoff and fences the old owner after another worker claims it',async()=>{
    const id=await enqueue();const [old]=await claimTasks(database.pool,randomUUID(),1);
    await database.pool.query("UPDATE email_tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);
    expect(await readClaimedTask(database.pool,old!)).toBeNull();
    expect(await finishTask(database.pool,old!,{kind:'sent',messageId:'old'})).toBe(false);
    expect(await recoverExpiredLeases(database.pool)).toBe(1);expect(await claimTasks(database.pool,randomUUID(),1)).toEqual([]);
    await database.pool.query('UPDATE email_tasks SET next_attempt_at=clock_timestamp() WHERE id=$1',[id]);
    const [next]=await claimTasks(database.pool,randomUUID(),1);expect(next!.leaseVersion).toBeGreaterThan(old!.leaseVersion);
    expect(await finishTask(database.pool,old!,{kind:'sent',messageId:'old'})).toBe(false);
    expect(await finishTask(database.pool,next!,{kind:'sent',messageId:'new'})).toBe(true);
  });
  it('records unknown delivery and clears payload if a third lease expires',async()=>{
    const id=await enqueue();await database.pool.query('UPDATE email_tasks SET attempts=2 WHERE id=$1',[id]);
    await claimTasks(database.pool,randomUUID(),1);
    await database.pool.query("UPDATE email_tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);
    await recoverExpiredLeases(database.pool);
    expect((await database.pool.query('SELECT status,error_code,recipient FROM email_tasks WHERE id=$1',[id])).rows[0]).toEqual({status:'failed',error_code:'DELIVERY_UNKNOWN',recipient:null});
  });
});
