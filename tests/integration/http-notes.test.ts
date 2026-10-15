import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import pg from 'pg';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {permissionDefinitions} from '../../packages/contracts/src/permissions.js';
import {startTestPostgres} from '../helpers/postgres.js';
import {identity,initializedDatabase} from '../helpers/identity.js';
import {migrate} from '../../apps/server/src/infrastructure/migrations.js';
import {createPasswordService} from '../../apps/server/src/infrastructure/passwords.js';
import {loadConfig} from '../../apps/server/src/infrastructure/config.js';
import {csrfForSession} from '../../apps/server/src/infrastructure/crypto.js';
import {startHttpServer} from '../../apps/server/src/http/app.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>,web:pg.Pool,server:ReturnType<typeof startHttpServer>,disabled:ReturnType<typeof startHttpServer>,base:string,disabledBase:string;
type Actor=Awaited<ReturnType<typeof identity>>;
const origin='https://notes.example.test',path='/api/v1/example-notes';
beforeAll(async()=>{
  database=await startTestPostgres();web=new pg.Pool({connectionString:database.connectionString,options:'-c role=honocraft_web'});
  const config=loadConfig({NODE_ENV:'test',PUBLIC_ORIGIN:origin,DATABASE_URL:database.connectionString,MAIL_MODE:'capture',SMTP_HOST:'127.0.0.1',SMTP_PORT:'1025',MAIL_FROM:'test@example.test',FILE_STORAGE_ROOT:'.local/tests/unused-notes-media',EXAMPLE_NOTES_ENABLED:'true',MAIL_PAYLOAD_KEYRING_FILE:'test-mail',DIGEST_KEY_FILE:'test-digest',CSRF_KEY_FILE:'test-csrf',CREDENTIAL_EPOCH_FILE:'test-epoch'});
  const dependencies={pool:web,config,passwords:await createPasswordService({concurrency:2,blockedPasswords:new Set<string>()}),secrets:{epoch:'test-epoch',csrfKey:Buffer.alloc(32,3),digestKey:{id:'v1',key:Buffer.alloc(32,7)},mailKeyring:{activeKeyId:'v1',keys:new Map([['v1',Buffer.alloc(32,4)]])}}};
  server=startHttpServer(dependencies,0);await once(server,'listening');base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  disabled=startHttpServer({...dependencies,config:{...config,exampleNotesEnabled:false}},0);await once(disabled,'listening');disabledBase='http://127.0.0.1:'+(disabled.address() as AddressInfo).port;
});
beforeEach(async()=>{
  await database.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await migrate(database.pool);await initializedDatabase(database.pool);
  for(const p of permissionDefinitions.filter(p=>p.code.startsWith('example-note:')))await database.pool.query("INSERT INTO permissions(code,module,name_key,description_key,is_delegable) VALUES($1,'example-note',$2,$3,true)",[p.code,'permissions.'+p.code,'permissions.'+p.code+'.description']);
  await database.pool.query("INSERT INTO permission_dependencies(permission_id,required_permission_id) SELECT p.id,r.id FROM permissions p CROSS JOIN permissions r WHERE p.code IN ('example-note:create','example-note:update','example-note:delete') AND r.code='example-note:read'; UPDATE system_state SET example_notes_enabled=true WHERE id=1; INSERT INTO roles(code,name) VALUES('note_author','Note author'); INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code='note_author' AND p.module='example-note'");
});
afterAll(async()=>{for(const s of [server,disabled]){s?.closeAllConnections();if(s)await new Promise<void>(resolve=>s.close(()=>resolve()));}await web?.end();await database?.close();});
const author=()=>identity(database.pool,'note_author');
function headers(actor?:Actor,key:string=randomUUID()){return {...(actor?{cookie:'honocraft_dev_session='+actor.token,'x-csrf-token':csrfForSession(Buffer.alloc(32,3),actor.sessionId,'test-epoch')}:{ }),origin,'content-type':'application/json','idempotency-key':key};}
const request=(actor:Actor|undefined,method:string,suffix='',body?:unknown,key?:string,target=base)=>fetch(target+path+suffix,{method,headers:headers(actor,key),...(body===undefined?{}:{body:JSON.stringify(body)})});
const create=(actor:Actor,title='My note',body='Private body',key?:string)=>request(actor,'POST','',{title,body},key);
it('does not register disabled module routes and rejects a disabled database flag',async()=>{
  const actor=await author();for(const [method,suffix,body] of [['GET','',undefined],['POST','',{title:'Note',body:''}],['GET','/'+randomUUID(),undefined]] as const)expect((await request(actor,method,suffix,body,undefined,disabledBase)).status).toBe(404);
  await database.pool.query('UPDATE system_state SET example_notes_enabled=false WHERE id=1');expect((await request(actor,'GET')).status).toBe(404);expect((await create(actor)).status).toBe(404);
});
it('requires current authentication and per-operation permission',async()=>{
  expect((await request(undefined,'GET')).status).toBe(401);const member=await identity(database.pool);expect((await request(member,'GET')).status).toBe(403);expect((await create(member)).status).toBe(403);const actor=await author();expect((await create(actor)).status).toBe(201);
});
it('creates plaintext notes with trimmed titles and server-owned identity, then reads versioned detail',async()=>{
  const actor=await author(),response=await create(actor,'  A title  ','\n<script>kept as plain text</script>\n');expect(response.status).toBe(201);const note=(await response.json()).data;expect(note).toMatchObject({title:'A title',body:'\n<script>kept as plain text</script>\n',version:1,allowed_actions:['update','delete']});expect(note).not.toHaveProperty('owner_id');expect((await (await request(actor,'GET','/'+note.id)).json()).data).toEqual(note);expect((await database.pool.query('SELECT owner_id FROM example_notes WHERE id=$1',[note.id])).rows[0].owner_id).toBe(actor.userId);
});
it('isolates list and all detail writes by owner even for the real super administrator',async()=>{
  const owner=await author(),other=await author(),superAdmin=await identity(database.pool,'super_admin'),note=(await (await create(owner)).json()).data;
  for(const actor of [other,superAdmin]){expect((await (await request(actor,'GET')).json()).data.total).toBe(0);for(const method of ['GET','PATCH','DELETE'])expect((await request(actor,method,'/'+note.id,method==='GET'?undefined:method==='PATCH'?{title:'Stolen',body:'',expected_version:1}:{expected_version:1})).status).toBe(404);}
  expect((await database.pool.query('SELECT version,title FROM example_notes WHERE id=$1',[note.id])).rows[0]).toEqual({version:1,title:'My note'});
});
it('supports bounded literal search and stable paging without accepting owner filters or arbitrary sort SQL',async()=>{
  const actor=await author();for(const title of ['Needle%_','NeedleXX','Other'])expect((await create(actor,title)).status).toBe(201);
  const filtered=(await (await request(actor,'GET','?query=%25_&page_size=1')).json()).data;expect(filtered.total).toBe(1);expect(filtered.items[0].title).toBe('Needle%_');const first=(await (await request(actor,'GET','?page_size=1')).json()).data,second=(await (await request(actor,'GET','?page_size=1&page=2')).json()).data;expect(first.total).toBe(3);expect(first.items[0].id).not.toBe(second.items[0].id);
  for(const query of ['owner_id='+actor.userId,'sort=title;DROP TABLE users','page_size=101','direction=sideways','query=x'])expect((await request(actor,'GET','?'+query)).status).toBe(422);
});
it('updates a complete owned note using the current version and rejects stale edits or removals',async()=>{
  const actor=await author(),note=(await (await create(actor)).json()).data;const response=await request(actor,'PATCH','/'+note.id,{title:'Updated',body:' Body\n',expected_version:1});expect(response.status).toBe(200);expect((await response.json()).data).toMatchObject({title:'Updated',body:' Body\n',version:2});
  for(const method of ['PATCH','DELETE'])expect((await request(actor,method,'/'+note.id,method==='PATCH'?{title:'Stale',body:'',expected_version:1}:{expected_version:1})).status).toBe(409);
  expect((await request(actor,'DELETE','/'+note.id,{expected_version:2})).status).toBe(200);expect((await request(actor,'GET','/'+note.id)).status).toBe(404);
});
it('replays create, update and deleted-note results using minimal summaries without duplicating audit or content',async()=>{
  const actor=await author(),key=randomUUID(),first=await create(actor,'Secret title','Secret body',key);expect(first.status).toBe(201);const note=(await first.json()).data,replay=await create(actor,'Secret title','Secret body',key);expect(replay.status).toBe(201);expect(await replay.json()).toMatchObject({replayed:true,data:{outcome:'note_created',resource_id:note.id,version:1}});expect((await database.pool.query('SELECT id FROM example_notes')).rowCount).toBe(1);expect((await create(actor,'Different','Secret body',key)).status).toBe(409);
  const updateKey=randomUUID(),update={title:'Next',body:'Private update',expected_version:1};expect((await request(actor,'PATCH','/'+note.id,update,updateKey)).status).toBe(200);expect(await (await request(actor,'PATCH','/'+note.id,update,updateKey)).json()).toMatchObject({replayed:true,data:{outcome:'note_updated',version:2}});
  const deleteKey=randomUUID();expect((await request(actor,'DELETE','/'+note.id,{expected_version:2},deleteKey)).status).toBe(200);expect(await (await request(actor,'DELETE','/'+note.id,{expected_version:2},deleteKey)).json()).toMatchObject({replayed:true,data:{outcome:'note_deleted',resource_id:note.id}});
  const audits=(await database.pool.query("SELECT action,changes FROM audit_events WHERE action LIKE 'example.notes.%' AND result='success' ORDER BY created_at,id")).rows;expect(audits.map(a=>a.action)).toEqual(['example.notes.created','example.notes.updated','example.notes.deleted']);expect(JSON.stringify(audits)).not.toContain('Secret');expect(JSON.stringify(audits)).not.toContain('Private update');
});
it('rechecks current permission before replay and does not restore a revoked author ability',async()=>{
  const actor=await author(),key=randomUUID();expect((await create(actor,'Title','',key)).status).toBe(201);await database.pool.query("DELETE FROM role_permissions WHERE role_id=(SELECT id FROM roles WHERE code='note_author') AND permission_id=(SELECT id FROM permissions WHERE code='example-note:create')");expect((await create(actor,'Title','',key)).status).toBe(403);const page=(await (await request(actor,'GET')).json()).data;expect(page.items).toHaveLength(1);
});
it('rolls back content, resource version and idempotency when the success audit fails',async()=>{
  const actor=await author();await database.pool.query("CREATE FUNCTION fail_note_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.action LIKE 'example.notes.%' AND NEW.result='success' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END$$; CREATE TRIGGER fail_note_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_note_audit()");expect((await create(actor)).status).toBe(500);expect((await database.pool.query('SELECT id FROM example_notes')).rowCount).toBe(0);expect((await database.pool.query("SELECT id FROM idempotency_records WHERE operation LIKE 'example.notes.%'")).rowCount).toBe(0);
});
it('enforces strict owner-free input, Unicode limits and a bounded request size',async()=>{
  const actor=await author();for(const body of [{title:'   ',body:''},{title:'x'.repeat(121),body:''},{title:'Title',body:'🙂'.repeat(20001)},{title:'Title',body:'',owner_id:actor.userId},{title:'Title',body:'',version:1},{title:'Title',body:'\0'}])expect((await request(actor,'POST','',body)).status).toBe(422);
  const valid=await create(actor,'  '+'🙂'.repeat(120)+'  ','🙂'.repeat(20000));expect(valid.status).toBe(201);expect([...((await valid.json()).data.body as string)]).toHaveLength(20000);expect((await create(actor,'Huge','x'.repeat(128*1024))).status).toBe(413);
});
it('checks Origin, CSRF, valid IDs and idempotency keys for note writes',async()=>{
  const actor=await author();for(const extra of [{origin:'https://other.test'},{'x-csrf-token':'wrong'},{'idempotency-key':'wrong'}]){const response=await fetch(base+path,{method:'POST',headers:{...headers(actor),...extra},body:JSON.stringify({title:'Note',body:''})});expect(response.status).toBe('idempotency-key' in extra?422:403);}expect((await request(actor,'GET','/bad-id')).status).toBe(422);expect((await request(actor,'GET','/'+randomUUID())).status).toBe(404);
});
it('allows only one of two competing updates to adopt the same version',async()=>{
  const actor=await author(),note=(await (await create(actor)).json()).data,responses=await Promise.all(['A','B'].map(title=>request(actor,'PATCH','/'+note.id,{title,body:'',expected_version:1})));expect(responses.map(r=>r.status).sort()).toEqual([200,409]);expect((await database.pool.query('SELECT version FROM example_notes WHERE id=$1',[note.id])).rows[0].version).toBe(2);
});
