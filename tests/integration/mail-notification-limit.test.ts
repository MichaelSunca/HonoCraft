import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {startTestPostgres} from '../helpers/postgres.js';
import {startSmtpFixture} from '../helpers/smtp.js';
import {migrate} from '../../apps/server/src/infrastructure/migrations.js';
import {withTransaction} from '../../apps/server/src/infrastructure/db.js';
import {enqueueMail,claimTasks,type MailLease} from '../../apps/server/src/modules/mail/outbox.js';
import {createSmtpTransport} from '../../apps/server/src/modules/mail/smtp.js';
import {runDelivery} from '../../apps/server/src/modules/mail/worker.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>,smtp:Awaited<ReturnType<typeof startSmtpFixture>>,worker:pg.Pool;
const config={origin:'https://app.example.test',epoch:'test-epoch',digestKey:Buffer.alloc(32,7),keyring:{activeKeyId:'v1',keys:new Map([['v1',Buffer.alloc(32,4)]])}};
beforeAll(async()=>{database=await startTestPostgres();await migrate(database.pool);smtp=await startSmtpFixture();worker=new pg.Pool({connectionString:database.connectionString,options:'-c role=honocraft_worker',max:5});});
beforeEach(async()=>{await database.pool.query('DELETE FROM email_tasks; DELETE FROM rate_limit_buckets');smtp.messages.splice(0);});
afterAll(async()=>{await worker?.end();await smtp?.close();await database?.close();});
const transport=()=>createSmtpTransport({host:'127.0.0.1',port:smtp.port,secure:false,user:undefined,password:undefined,from:'noreply@example.test',mode:'capture'});
async function enqueue(recipient='recipient@example.test'){
  return withTransaction(database.pool,'shared',tx=>enqueueMail(tx,config.keyring,{eventId:randomUUID(),purpose:'password_changed',recipient,displayName:'User',instanceName:'HonoCraft',locale:'en',timeZone:'UTC',occurredAt:new Date().toISOString()}));
}
async function claimAll(){const leases:MailLease[]=[];for(;;){const batch=await claimTasks(worker,randomUUID(),2);if(!batch.length)return leases;leases.push(...batch);}}
const deliver=(lease:MailLease)=>runDelivery(worker,config,transport(),lease);
it('shares a five-message rolling quota across worker owners and delays surplus without losing payload or attempts',async()=>{
  for(let i=0;i<7;i++)await enqueue(i%2?'Recipient@example.test':'recipient@example.test');
  const leases=await claimAll();const results=await Promise.all(leases.map(deliver));
  expect(results.filter(value=>value==='sent')).toHaveLength(5);expect(results.filter(value=>value==='queued')).toHaveLength(2);expect(smtp.messages).toHaveLength(5);
  const delayed=(await database.pool.query("SELECT attempts,recipient,payload_ciphertext,lease_owner,next_attempt_at>clock_timestamp() AS future FROM email_tasks WHERE status='queued'")).rows;
  expect(delayed).toHaveLength(2);for(const row of delayed){expect(row.attempts).toBe(0);expect(row.recipient).not.toBeNull();expect(row.payload_ciphertext).not.toBeNull();expect(row.lease_owner).toBeNull();expect(row.future).toBe(true);}
  const buckets=(await database.pool.query('SELECT scope,key_digest FROM rate_limit_buckets')).rows;
  expect(buckets.length).toBeGreaterThan(0);expect(JSON.stringify(buckets)).not.toContain('recipient');
});
it('resumes delayed notifications after the window and does not rate-limit another address',async()=>{
  for(let i=0;i<6;i++)await enqueue();await Promise.all((await claimAll()).map(deliver));
  await enqueue('other@example.test');await Promise.all((await claimAll()).map(deliver));expect(smtp.messages).toHaveLength(6);
  await database.pool.query("UPDATE rate_limit_buckets SET window_start=window_start-interval '62 seconds' WHERE window_start<>'1970-01-01 00:00:00+00'");
  await database.pool.query("UPDATE email_tasks SET next_attempt_at=clock_timestamp() WHERE status='queued'");
  await Promise.all((await claimAll()).map(deliver));expect(smtp.messages).toHaveLength(7);
  expect((await database.pool.query("SELECT id FROM email_tasks WHERE status<>'sent'")).rowCount).toBe(0);
});
it('does not grant the worker general access to login or user-action rate limits',async()=>{
  await expect(worker.query('DELETE FROM rate_limit_buckets')).rejects.toMatchObject({code:'42501'});
});
it('rejects a missing or stale lease version without charging a notification quota',async()=>{
  await enqueue();const [lease]=await claimTasks(worker,randomUUID(),1);
  for(const version of [null,lease!.leaseVersion-1]){
    const result=await worker.query('SELECT reserve_notification_delivery($1,$2,$3,$4) decision',[lease!.id,lease!.leaseOwner,version,Buffer.alloc(32,1)]);
    expect(result.rows[0].decision).toBe('lease_lost');
  }
  expect((await database.pool.query('SELECT scope FROM rate_limit_buckets')).rowCount).toBe(0);
});
