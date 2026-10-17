import {spawn,type ChildProcess} from 'node:child_process';
import {createRequire} from 'node:module';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm,mkdir,readFile,utimes} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it} from 'vitest';
import {startTestPostgres} from '../helpers/postgres.js';
import {startSmtpFixture} from '../helpers/smtp.js';
import {migrate} from '../../apps/server/src/infrastructure/migrations.js';
import {withTransaction} from '../../apps/server/src/infrastructure/db.js';
import {enqueueMail,claimTasks} from '../../apps/server/src/modules/mail/outbox.js';
import {identity} from '../helpers/identity.js';
import {issueToken} from '../../apps/server/src/infrastructure/crypto.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>,smtp:Awaited<ReturnType<typeof startSmtpFixture>>;
let directory:string,env:NodeJS.ProcessEnv,mailKey:Buffer,epoch:string,child:ChildProcess|undefined;
beforeAll(async()=>{database=await startTestPostgres();});
afterAll(async()=>{await database?.close();});
beforeEach(async()=>{
  await database.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await migrate(database.pool);
  directory=await mkdtemp(join(tmpdir(),'honocraft-worker-'));smtp=await startSmtpFixture('held');mailKey=randomBytes(32);epoch=randomBytes(32).toString('base64url');
  for(const name of ['digest','csrf'])await writeFile(join(directory,name),randomBytes(32).toString('base64url'),{mode:0o600});
  await writeFile(join(directory,'epoch'),epoch,{mode:0o600});
  await writeFile(join(directory,'mail.json'),JSON.stringify({active_key_id:'v1',keys:{v1:mailKey.toString('base64url')}}),{mode:0o600});
  const url=new URL(database.connectionString);url.searchParams.set('options','-c role=honocraft_worker');
  env={NODE_ENV:'test',PUBLIC_ORIGIN:'http://localhost:3000',DATABASE_URL:'not-the-worker-database',WORKER_DATABASE_URL:url.href,
    MAIL_MODE:'capture',SMTP_HOST:'127.0.0.1',SMTP_PORT:String(smtp.port),MAIL_FROM:'test@example.test',FILE_STORAGE_ROOT:join(directory,'media'),EXAMPLE_NOTES_ENABLED:'false',
    MAIL_PAYLOAD_KEYRING_FILE:join(directory,'mail.json'),DIGEST_KEY_FILE:join(directory,'digest'),CSRF_KEY_FILE:join(directory,'csrf'),CREDENTIAL_EPOCH_FILE:join(directory,'epoch')};
});
afterEach(async()=>{
  smtp.release();if(child&&child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child!.once('exit',resolve));child.kill('SIGTERM');await exited;}
  child=undefined;await smtp?.close();await rm(directory,{recursive:true,force:true});
});
async function enqueue(){return withTransaction(database.pool,'shared',async tx=>{
  const id=await enqueueMail(tx,{activeKeyId:'v1',keys:new Map([['v1',mailKey]])},{eventId:randomUUID(),purpose:'password_changed',recipient:`${randomUUID()}@example.test`,displayName:'User',instanceName:'HonoCraft',locale:'en',timeZone:'UTC',occurredAt:new Date().toISOString()});
  // These process tests exercise already-due work. Scheduling boundaries have dedicated outbox tests.
  await tx.query("UPDATE email_tasks SET next_attempt_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[id]);return id;
});}
async function until(predicate:()=>boolean|Promise<boolean>){const deadline=performance.now()+5000;while(!await predicate()){if(performance.now()>deadline)throw new Error('Worker observation timed out');await delay(25);}}
function launch(){
  child=spawn(process.execPath,['--import',createRequire(import.meta.url).resolve('tsx'),resolve('apps/server/src/worker-main.ts')],{cwd:directory,env,stdio:['ignore','pipe','pipe']});
  let output='';const exited=new Promise<number|null>((resolve,reject)=>{child!.once('error',reject);child!.once('exit',resolve);});
  child.stdout!.on('data',chunk=>{output+=String(chunk);});child.stderr!.on('data',chunk=>{output+=String(chunk);});
  return {ready:()=>until(()=>{if(child!.exitCode!==null)throw new Error('Worker exited: '+output);return output.includes('Worker ready');}),exited,output:()=>output};
}
it('caps active deliveries at two, records a safe heartbeat and drains only claimed work on SIGTERM',async()=>{
  for(let i=0;i<4;i++)await enqueue();let process=launch();try{await process.ready();await until(()=>smtp.messages.length===2);}catch(error){console.info('initial worker diagnostic',process.output(),(await database.pool.query('SELECT status,attempts,error_code,next_attempt_at,clock_timestamp() FROM email_tasks')).rows);throw error;}
  const states=(await database.pool.query('SELECT status,count(*)::int n FROM email_tasks GROUP BY status ORDER BY status')).rows;
  expect(states).toEqual([{status:'queued',n:2},{status:'sending',n:2}]);
  const beat=(await database.pool.query('SELECT app_version,credential_epoch_digest FROM worker_heartbeats')).rows;
  expect(beat).toHaveLength(1);expect(beat[0].credential_epoch_digest).toMatch(/^[a-f0-9]{64}$/);expect(beat[0].credential_epoch_digest).not.toBe(epoch);
  child!.kill('SIGTERM');await delay(100);expect(child!.exitCode).toBeNull();smtp.release();expect(await process.exited).toBe(0);
  expect(smtp.messages).toHaveLength(2);expect((await database.pool.query("SELECT id FROM email_tasks WHERE status='queued'")).rowCount).toBe(2);
  process=launch();try{await process.ready();await until(()=>smtp.messages.length===4);}catch(error){console.info('worker diagnostic',process.output(),(await database.pool.query('SELECT status,attempts,error_code,next_attempt_at,clock_timestamp() FROM email_tasks')).rows);throw error;}await until(async()=>(await database.pool.query("SELECT id FROM email_tasks WHERE status='sent'")).rowCount===4);
  child!.kill('SIGTERM');expect(await process.exited).toBe(0);
});
it('recovers leases abandoned by an old process before starting new work',async()=>{
  const task=await enqueue();await claimTasks(database.pool,randomUUID(),1);
  await database.pool.query("UPDATE email_tasks SET lease_expires_at=clock_timestamp()-interval '5 minutes' WHERE id=$1",[task]);
  const process=launch();await process.ready();
  const row=(await database.pool.query('SELECT status,attempts,error_code,next_attempt_at>clock_timestamp() future FROM email_tasks WHERE id=$1',[task])).rows[0];
  expect(row).toEqual({status:'queued',attempts:1,error_code:'LEASE_EXPIRED',future:true});expect(smtp.messages).toHaveLength(0);
});
it('requires a separate worker connection instead of falling back to web credentials',async()=>{
  delete env.WORKER_DATABASE_URL;const process=launch();expect(await process.exited).toBe(2);expect(process.output()).toContain('WORKER_DATABASE_URL');
});
it('refuses incompatible catalogs before claiming mail',async()=>{
  const task=await enqueue();await database.pool.query('UPDATE system_state SET catalog_version=99');
  const process=launch();expect(await process.exited).toBe(3);expect(process.output()).toContain('PERMISSION_CATALOG_INCOMPATIBLE');
  expect((await database.pool.query('SELECT attempts FROM email_tasks WHERE id=$1',[task])).rows[0].attempts).toBe(0);
});
it('reclaims expired staged media while SMTP deliveries remain in flight',async()=>{
  const id=randomUUID(),key=id+'.webp',root=join(directory,'media');await mkdir(root);await writeFile(join(root,key),'old image');
  const temporary=join(root,randomUUID()+'-'+randomUUID()+'.tmp'),old=new Date(Date.now()-25*60*60_000);await writeFile(temporary,'interrupted');await utimes(temporary,old,old);
  await database.pool.query("INSERT INTO file_objects(id,storage_key,purpose,content_type,byte_size,width,height,updated_at) VALUES($1,$2,'brand_logo','image/webp',9,1,1,clock_timestamp()-interval '25 hours')",[id,key]);
  await enqueue();await enqueue();const process=launch();await process.ready();await until(()=>smtp.messages.length===2);await until(async()=>(await database.pool.query('SELECT id FROM file_objects WHERE id=$1',[id])).rowCount===0);await expect(readFile(join(root,key))).rejects.toThrow();expect((await database.pool.query("SELECT id FROM email_tasks WHERE status='sending'")).rowCount).toBe(2);
  await until(async()=>readFile(temporary).then(()=>false,()=>true));child!.kill('SIGTERM');smtp.release();expect(await process.exited).toBe(0);expect(process.output()).toContain('files.cleanup_completed');expect(process.output()).toContain('files.loose_cleanup_completed');
});
it('expires due invitations, email requests and credentials while existing SMTP work remains in flight',async()=>{
  await enqueue();await enqueue();const actor=await identity(database.pool,'admin'),invite=randomUUID(),change=randomUUID(),credential=randomUUID(),issued=issueToken(),email=randomUUID()+'@example.test';
  await database.pool.query("INSERT INTO invites(id,email,normalized_email,inviter_id,expires_at) VALUES($1,$2,$2,$3,clock_timestamp()-interval '5 minutes')",[invite,email,actor.userId]);await database.pool.query("INSERT INTO invite_roles(invite_id,role_id,role_id_at_issue,role_code,role_name,role_version_at_issue) SELECT $1,id,id,code,name,version FROM roles WHERE code='user'",[invite]);
  await database.pool.query("INSERT INTO email_change_requests(id,user_id,requested_by,initiated_by_self,new_email,normalized_new_email,expires_at) VALUES($1,$2,$2,true,$3,$3,clock_timestamp()-interval '5 minutes')",[change,actor.userId,email]);
  const expires=(await database.pool.query<{expires_at:Date}>("INSERT INTO one_time_credentials(id,purpose,token_hash,user_id,subject_version,target_email,normalized_target_email,credential_epoch,expires_at) VALUES($1,'password_reset',$2,$3,1,$4,$4,$5,clock_timestamp()-interval '5 minutes') RETURNING expires_at",[credential,issued.hash,actor.userId,actor.userId+'@example.test',epoch])).rows[0]!.expires_at;
  const task=await withTransaction(database.pool,'shared',tx=>enqueueMail(tx,{activeKeyId:'v1',keys:new Map([['v1',mailKey]])},{eventId:credential,credentialId:credential,purpose:'password_reset',recipient:actor.userId+'@example.test',displayName:'User',instanceName:'HonoCraft',locale:'en',timeZone:'UTC',token:issued.token,expiresAt:expires.toISOString()}));
  const process=launch();await process.ready();await until(()=>smtp.messages.length===2);await until(()=>process.output().includes('expiry.completed'));expect((await database.pool.query('SELECT status,version FROM invites WHERE id=$1',[invite])).rows[0]).toEqual({status:'expired',version:2});expect((await database.pool.query('SELECT status,version FROM email_change_requests WHERE id=$1',[change])).rows[0]).toEqual({status:'expired',version:2});expect((await database.pool.query('SELECT revoked_at FROM one_time_credentials WHERE id=$1',[credential])).rows[0].revoked_at).not.toBeNull();expect((await database.pool.query('SELECT status,recipient,payload_ciphertext FROM email_tasks WHERE id=$1',[task])).rows[0]).toEqual({status:'cancelled',recipient:null,payload_ciphertext:null});
  expect((await database.pool.query("SELECT id FROM email_tasks WHERE status='sending'")).rowCount).toBe(2);child!.kill('SIGTERM');smtp.release();expect(await process.exited).toBe(0);expect(process.output()).not.toContain(issued.token);expect(process.output()).not.toContain(email);
});
