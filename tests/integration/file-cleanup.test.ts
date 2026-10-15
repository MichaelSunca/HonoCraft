import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,symlink,writeFile,utimes} from 'node:fs/promises';
import {resolve} from 'node:path';
import pg from 'pg';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {startTestPostgres} from '../helpers/postgres.js';
import {identity,initializedDatabase} from '../helpers/identity.js';
import {migrate} from '../../apps/server/src/infrastructure/migrations.js';
import {createFileStorage} from '../../apps/server/src/modules/files/storage.js';
import {cleanupFiles,cleanupLooseFiles} from '../../apps/server/src/modules/files/cleanup.js';
import {withTransaction} from '../../apps/server/src/infrastructure/db.js';
import {appendAudit} from '../../apps/server/src/modules/audit/writer.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>,worker:pg.Pool,root:string;
beforeAll(async()=>{database=await startTestPostgres();worker=new pg.Pool({connectionString:database.connectionString,options:'-c role=honocraft_worker'});root=await mkdtemp(resolve('.local/tests/file-cleanup-'));});
beforeEach(async()=>{await database.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await migrate(database.pool);await initializedDatabase(database.pool);await rm(root,{recursive:true,force:true});await mkdir(root);});
afterAll(async()=>{await worker?.end();await database?.close();if(root)await rm(root,{recursive:true,force:true});});
async function file(purpose:'avatar'|'logo'|'favicon'='logo'){
  const actor=await identity(database.pool),png=purpose==='favicon';
  const id=await createFileStorage(database.pool,root).stage(actor.userId,purpose,[{bytes:Buffer.from('main'),contentType:png?'image/png':'image/webp',width:64,height:64,size:64},...(png?[{bytes:Buffer.from('variant'),contentType:'image/png' as const,width:32,height:32,size:32}]:[])]);
  const key=id+(png?'.png':'.webp');return {id,key,actor};
}
const old=async(id:string)=>{await database.pool.query("UPDATE file_objects SET updated_at=clock_timestamp()-interval '25 hours',created_at=clock_timestamp()-interval '3 days',lease_expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[id]);};
const exists=async(key:string)=>readFile(resolve(root,key)).then(()=>true,()=>false);
it('appends worker audit events without granting access to read audit history',async()=>{
  await expect(worker.query('SELECT id FROM audit_events')).rejects.toMatchObject({code:'42501'});
  const id=await withTransaction(worker,'independent',tx=>appendAudit(tx,{actor:{type:'worker'},action:'files.cleanup.started',target:{type:'file'},result:'success',meta:{requestId:randomUUID(),ip:'127.0.0.1',userAgent:'HonoCraft Worker'}}));
  expect((await database.pool.query('SELECT actor_type FROM audit_events WHERE id=$1',[id])).rows[0].actor_type).toBe('worker');
});
it('reclaims old unreferenced staged files with the restricted worker role and audits deletion',async()=>{
  const a=await file();await old(a.id);expect(await cleanupFiles(worker,root)).toEqual({claimed:1,deleted:1,failed:0});expect(await exists(a.key)).toBe(false);expect((await database.pool.query('SELECT id FROM file_objects WHERE id=$1',[a.id])).rowCount).toBe(0);
  const audit=(await database.pool.query("SELECT actor_type,action,changes FROM audit_events WHERE action LIKE 'files.%' ORDER BY created_at,id")).rows;
  expect(audit.map(row=>row.action)).toEqual(['files.cleanup.started','files.object.deleted','files.cleanup.completed']);expect(audit.every(row=>row.actor_type==='worker')).toBe(true);expect(audit.at(-1).changes).toEqual({affected_count:1});
});
it('keeps fresh or newly orphaned files, active leases, attached files and every current reference',async()=>{
  const fresh=await file(),recentOrphan=await file(),leased=await file(),attached=await file(),avatar=await file('avatar'),logo=await file(),favicon=await file('favicon');
  await database.pool.query("UPDATE file_objects SET created_at=clock_timestamp()-interval '3 days',state='orphaned',lease_expires_at=NULL WHERE id=$1",[recentOrphan.id]);
  for(const f of [leased,attached,avatar,logo,favicon])await old(f.id);
  await database.pool.query("UPDATE file_objects SET lease_expires_at=clock_timestamp()+interval '10 minutes' WHERE id=$1",[leased.id]);await database.pool.query("UPDATE file_objects SET state='attached' WHERE id=$1",[attached.id]);
  await database.pool.query('UPDATE users SET avatar_file_id=$1 WHERE id=$2',[avatar.id,avatar.actor.userId]);await database.pool.query("UPDATE system_settings SET typed_value=jsonb_set(jsonb_set(typed_value,'{logo_file_id}',to_jsonb($1::text)),'{favicon_file_id}',to_jsonb($2::text)) WHERE key='branding'",[logo.id,favicon.id]);
  expect(await cleanupFiles(worker,root)).toEqual({claimed:0,deleted:0,failed:0});for(const f of [fresh,recentOrphan,leased,attached,avatar,logo,favicon])expect(await exists(f.key)).toBe(true);
});
it('removes all favicon variants before deleting their parent metadata',async()=>{
  const a=await file('favicon');await old(a.id);await database.pool.query("UPDATE file_objects SET state='orphaned' WHERE id=$1",[a.id]);expect(await cleanupFiles(worker,root)).toEqual({claimed:1,deleted:1,failed:0});expect(await exists(a.key)).toBe(false);expect(await exists(a.id+'-32.png')).toBe(false);expect((await database.pool.query('SELECT * FROM file_variants')).rowCount).toBe(0);
});
it('resumes deleting records after a crash and treats absent physical files as success',async()=>{
  const a=await file('favicon');await database.pool.query("UPDATE file_objects SET state='deleting' WHERE id=$1",[a.id]);await rm(resolve(root,a.key));expect(await cleanupFiles(worker,root)).toEqual({claimed:1,deleted:1,failed:0});expect(await exists(a.id+'-32.png')).toBe(false);expect(await cleanupFiles(worker,root)).toEqual({claimed:0,deleted:0,failed:0});
});
it('retains deleting metadata after a filesystem error and completes a later retry',async()=>{
  const a=await file();await old(a.id);await rm(resolve(root,a.key));await mkdir(resolve(root,a.key));await writeFile(resolve(root,a.key,'keep'),'nested');expect(await cleanupFiles(worker,root)).toEqual({claimed:1,deleted:0,failed:1});expect((await database.pool.query('SELECT state FROM file_objects WHERE id=$1',[a.id])).rows[0].state).toBe('deleting');expect(await readFile(resolve(root,a.key,'keep'),'utf8')).toBe('nested');await rm(resolve(root,a.key),{recursive:true});expect(await cleanupFiles(worker,root)).toEqual({claimed:1,deleted:1,failed:0});
});
it('does not remove any file when the claim audit cannot commit',async()=>{
  const a=await file();await old(a.id);await database.pool.query("CREATE FUNCTION fail_cleanup_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'audit unavailable'; END$$; CREATE TRIGGER fail_cleanup_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_cleanup_audit()");await expect(cleanupFiles(worker,root)).rejects.toThrow();expect(await exists(a.key)).toBe(true);expect((await database.pool.query('SELECT state FROM file_objects WHERE id=$1',[a.id])).rows[0].state).toBe('staged');
});
it('keeps retryable metadata if the final transactional deletion audit fails',async()=>{
  const a=await file();await old(a.id);await database.pool.query("CREATE FUNCTION fail_cleanup_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.action='files.object.deleted' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END$$; CREATE TRIGGER fail_cleanup_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_cleanup_audit()");expect(await cleanupFiles(worker,root)).toEqual({claimed:1,deleted:0,failed:1});expect(await exists(a.key)).toBe(false);expect((await database.pool.query('SELECT state FROM file_objects WHERE id=$1',[a.id])).rows[0].state).toBe('deleting');await database.pool.query('DROP TRIGGER fail_cleanup_audit ON audit_events');expect(await cleanupFiles(worker,root)).toEqual({claimed:1,deleted:1,failed:0});
});
it('skips locked files and uses a bounded batch without locking users or global security state',async()=>{
  const a=await file(),b=await file(),c=await file();for(const f of [a,b,c])await old(f.id);const lock=await database.pool.connect();await lock.query('BEGIN');await lock.query('SELECT id FROM file_objects WHERE id=$1 FOR UPDATE',[a.id]);await lock.query('SELECT id FROM system_state FOR UPDATE');await lock.query('SELECT id FROM users FOR UPDATE');
  try{expect(await cleanupFiles(worker,root,{batchSize:1})).toEqual({claimed:1,deleted:1,failed:0});expect(await exists(a.key)).toBe(true);expect((await database.pool.query('SELECT id FROM file_objects')).rowCount).toBe(2);}finally{await lock.query('ROLLBACK');lock.release();}
});
it('allows concurrent workers to finish each metadata deletion exactly once',async()=>{
  const files=await Promise.all([file(),file(),file()]);for(const f of files)await old(f.id);const results=await Promise.all([cleanupFiles(worker,root),cleanupFiles(worker,root)]);expect(results.reduce((n,r)=>n+r.deleted,0)).toBe(3);expect((await database.pool.query("SELECT * FROM audit_events WHERE action='files.object.deleted'")).rowCount).toBe(3);expect((await database.pool.query('SELECT * FROM file_objects')).rowCount).toBe(0);
});
it('unlinks a stored symlink without following it outside the configured media directory',async()=>{
  const a=await file(),sentinel=resolve(root,'sentinel-'+randomUUID());await writeFile(sentinel,'keep');await rm(resolve(root,a.key));await symlink(sentinel,resolve(root,a.key));await old(a.id);expect(await cleanupFiles(worker,root)).toEqual({claimed:1,deleted:1,failed:0});expect(await readFile(sentinel,'utf8')).toBe('keep');
});
async function loose(key:string,stale=true){await writeFile(resolve(root,key),'abandoned');if(stale){const time=new Date(Date.now()-25*60*60_000);await utimes(resolve(root,key),time,time);}return key;}
it('collects old generated temporary and image files that have no remaining metadata',async()=>{
  const keys=[await loose(randomUUID()+'-'+randomUUID()+'.tmp'),await loose(randomUUID()+'.webp'),await loose(randomUUID()+'-32.png')];expect(await cleanupLooseFiles(worker,root)).toEqual({deleted:3,failed:0});for(const key of keys)expect(await exists(key)).toBe(false);expect((await database.pool.query("SELECT id FROM audit_events WHERE action='files.loose.deleted'")).rowCount).toBe(3);
});
it('preserves recent files, unknown names, directories, symlinks and temporary files belonging to known objects',async()=>{
  const a=await file(),keys=[await loose(randomUUID()+'-'+randomUUID()+'.tmp',false),await loose('operator-notes.tmp'),await loose(a.id+'-'+randomUUID()+'.tmp')],directory=randomUUID()+'-'+randomUUID()+'.tmp',link=randomUUID()+'.webp';await mkdir(resolve(root,directory));await symlink(resolve(root,keys[1]!),resolve(root,link));expect(await cleanupLooseFiles(worker,root)).toEqual({deleted:0,failed:0});for(const key of keys)expect(await exists(key)).toBe(true);expect(await exists(link)).toBe(true);
});
it('does not remove a loose image still referenced by branding even when its metadata is missing',async()=>{
  const id=randomUUID(),key=await loose(id+'.webp');await database.pool.query("UPDATE system_settings SET typed_value=jsonb_set(typed_value,'{logo_file_id}',to_jsonb($1::text)) WHERE key='branding'",[id]);expect(await cleanupLooseFiles(worker,root)).toEqual({deleted:0,failed:0});expect(await exists(key)).toBe(true);
});
it('limits loose-file deletion per batch and stops before any destructive work on an aborted signal',async()=>{
  await loose(randomUUID()+'-'+randomUUID()+'.tmp');await loose(randomUUID()+'-'+randomUUID()+'.tmp');expect(await cleanupLooseFiles(worker,root,{signal:AbortSignal.abort()})).toEqual({deleted:0,failed:0});expect(await cleanupLooseFiles(worker,root,{batchSize:1})).toEqual({deleted:1,failed:0});expect(await cleanupLooseFiles(worker,root)).toEqual({deleted:1,failed:0});
});
it('preserves loose files if the deletion intent audit fails',async()=>{
  const key=await loose(randomUUID()+'-'+randomUUID()+'.tmp');await database.pool.query("CREATE FUNCTION fail_loose_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'audit unavailable'; END$$; CREATE TRIGGER fail_loose_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_loose_audit()");expect(await cleanupLooseFiles(worker,root)).toEqual({deleted:0,failed:1});expect(await exists(key)).toBe(true);
});
