import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import pg from 'pg';
import sharp from 'sharp';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {startTestPostgres} from '../helpers/postgres.js';
import {identity,initializedDatabase,sessionFor} from '../helpers/identity.js';
import {migrate} from '../../apps/server/src/infrastructure/migrations.js';
import {withTransaction} from '../../apps/server/src/infrastructure/db.js';
import {runIdempotent} from '../../apps/server/src/infrastructure/idempotency.js';
import {createPasswordService} from '../../apps/server/src/infrastructure/passwords.js';
import {loadConfig} from '../../apps/server/src/infrastructure/config.js';
import {csrfForSession} from '../../apps/server/src/infrastructure/crypto.js';
import {startHttpServer} from '../../apps/server/src/http/app.js';
import {setExampleNotesEnabled} from '../../apps/server/src/modules/example-notes/catalog.js';
import {OPERATION_NAMES,type OperationName} from '../../packages/contracts/src/operations.js';
import {createOperationQueries} from '../../apps/server/src/modules/operations/queries.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>,web:pg.Pool,server:ReturnType<typeof startHttpServer>,base:string,root:string,image:Buffer,passwords:Awaited<ReturnType<typeof createPasswordService>>;
type Actor=Awaited<ReturnType<typeof identity>>;
const origin='https://operations.example.test',digestKey={id:'v1',key:Buffer.alloc(32,7)};
beforeAll(async()=>{
  database=await startTestPostgres();web=new pg.Pool({connectionString:database.connectionString,options:'-c role=honocraft_web'});root=await mkdtemp(resolve('.local/tests/operation-media-'));image=await sharp({create:{width:8,height:8,channels:3,background:'#224466'}}).png().toBuffer();passwords=await createPasswordService({concurrency:2,blockedPasswords:new Set<string>()});
  const config=loadConfig({NODE_ENV:'test',PUBLIC_ORIGIN:origin,DATABASE_URL:database.connectionString,MAIL_MODE:'capture',SMTP_HOST:'127.0.0.1',SMTP_PORT:'1025',MAIL_FROM:'test@example.test',FILE_STORAGE_ROOT:root,EXAMPLE_NOTES_ENABLED:'true',MAIL_PAYLOAD_KEYRING_FILE:'test-mail',DIGEST_KEY_FILE:'test-digest',CSRF_KEY_FILE:'test-csrf',CREDENTIAL_EPOCH_FILE:'test-epoch'});
  server=startHttpServer({pool:web,config,passwords,secrets:{epoch:'test-epoch',csrfKey:Buffer.alloc(32,3),digestKey,mailKeyring:{activeKeyId:'v1',keys:new Map([['v1',Buffer.alloc(32,4)]])}}},0);
  await once(server,'listening');base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
});
beforeEach(async()=>{await database.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await migrate(database.pool);await initializedDatabase(database.pool);});
afterAll(async()=>{server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await web?.end();await database?.close();if(root)await rm(root,{recursive:true,force:true});});
const get=(actor:Actor|undefined,operation:string,key:string,query='')=>fetch(base+'/api/v1/operations/'+encodeURIComponent(operation)+'/'+encodeURIComponent(key)+query,{headers:actor?{cookie:'honocraft_dev_session='+actor.token}:{}});
const write=(actor:Actor,path:string,method:string,body:unknown,key:string=randomUUID())=>fetch(base+'/api/v1'+path,{method,headers:{origin,'content-type':'application/json',cookie:'honocraft_dev_session='+actor.token,'x-csrf-token':csrfForSession(Buffer.alloc(32,3),actor.sessionId,'test-epoch'),'idempotency-key':key},body:JSON.stringify(body)});
async function saved(actor:Actor,operation='me.password.change',key=randomUUID(),policy:unknown={user_id:actor.userId}){
  const result=await withTransaction(database.pool,'shared',tx=>runIdempotent(tx,{actorId:actor.userId,operation,key,input:{private:'request marker'},digestKey,policySchema:z.unknown(),authorizeStored:async()=>{},execute:async()=>({summary:{outcome:'password_changed',resource_id:actor.userId,version:2,completed_at:new Date().toISOString()},status:200,target:{type:'user',id:actor.userId},policyContext:policy})}));
  return {key,summary:result.summary};
}
async function missing(response:Response){expect(response.status).toBe(404);expect((await response.json()).error.code).toBe('OPERATION_NOT_FOUND');}
it('requires a live current session even when operation or key is unknown',async()=>{
  expect((await get(undefined,'unknown','invalid')).status).toBe(401);const actor=await identity(database.pool),item=await saved(actor);await database.pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1',[actor.sessionId]);expect((await get(actor,'me.password.change',item.key)).status).toBe(401);
});
it('returns only a minimal successful summary without replaying, writing audit or extending retention',async()=>{
  const actor=await identity(database.pool),item=await saved(actor),before=(await database.pool.query('SELECT expires_at FROM idempotency_records')).rows;
  const response=await get(actor,'me.password.change',item.key.toUpperCase());expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');const body=await response.json();expect(body.data).toEqual(item.summary);expect(Object.keys(body.data).sort()).toEqual(['completed_at','outcome','resource_id','version']);expect(JSON.stringify(body)).not.toContain('request marker');expect(body).not.toHaveProperty('replayed');expect((await database.pool.query('SELECT expires_at FROM idempotency_records')).rows).toEqual(before);expect((await database.pool.query('SELECT id FROM audit_events')).rowCount).toBe(0);
});
it('isolates keys by actor, including real super administrators',async()=>{
  const actor=await identity(database.pool),other=await identity(database.pool),superAdmin=await identity(database.pool,'super_admin'),item=await saved(actor);for(const candidate of [other,superAdmin])await missing(await get(candidate,'me.password.change',item.key));const own=await saved(other,'me.password.change',item.key);expect((await (await get(other,'me.password.change',item.key)).json()).data).toEqual(own.summary);
});
it('keeps the same actor key separate across distinct registered operations',async()=>{
  const actor=await identity(database.pool),item=await saved(actor);await checked(await write(actor,'/me/sessions/revoke-others','POST',{},item.key));expect((await (await get(actor,'me.password.change',item.key)).json()).data.outcome).toBe('password_changed');expect((await (await get(actor,'auth.sessions.revoke_others',item.key)).json()).data.outcome).toBe('other_sessions_revoked');expect((await database.pool.query('SELECT id FROM idempotency_records')).rowCount).toBe(2);
});
it('returns uniform not-found for unknown, non-idempotent and malformed operation/key pairs',async()=>{
  const actor=await identity(database.pool);for(const operation of ['unknown','__proto__','constructor','me.profile.update','auth.logout','users.profile;SELECT']){const item=await saved(actor,operation);await missing(await get(actor,operation,item.key));}for(const key of ['not-a-uuid',randomUUID()])await missing(await get(actor,'me.password.change',key));
});
it('hides expired records without deleting them or treating expiration as success',async()=>{
  const actor=await identity(database.pool),item=await saved(actor);await database.pool.query("UPDATE idempotency_records SET expires_at=clock_timestamp()-interval '1 hour'");await missing(await get(actor,'me.password.change',item.key));expect((await database.pool.query('SELECT id FROM idempotency_records')).rowCount).toBe(1);
});
it('rejects actor selectors and extra query fields instead of reading another identity',async()=>{
  const actor=await identity(database.pool),item=await saved(actor);for(const query of ['actor_id='+actor.userId,'owner_id='+actor.userId,'include=policy']){const response=await get(actor,'me.password.change',item.key,'?'+query);expect(response.status).toBe(422);expect((await response.json()).error.code).toBe('VALIDATION_ERROR');}
});
it('fails closed for mismatched credential key generation, policy, outcome or target metadata',async()=>{
  const actor=await identity(database.pool),item=await saved(actor),row=(await database.pool.query('SELECT * FROM idempotency_records')).rows[0];
  for(const change of [{digest_key_id:'old'},{policy_context:{user_id:randomUUID()}},{result_summary:{...item.summary,outcome:'unrelated'}},{result_summary:{...item.summary,password:'must never escape'}},{target_id:randomUUID()},{target_type:'settings'}]){
    await database.pool.query('UPDATE idempotency_records SET digest_key_id=$1,policy_context=$2,result_summary=$3,target_id=$4,target_type=$5',[row.digest_key_id,row.policy_context,row.result_summary,row.target_id,row.target_type]);
    const [field,value]=Object.entries(change)[0]!;await database.pool.query('UPDATE idempotency_records SET '+field+'=$1',[value]);await missing(await get(actor,'me.password.change',item.key));
  }
});
it('serves actual created, edited and deleted note results after the resource is gone',async()=>{
  await setExampleNotesEnabled(database.pool,{enabled:true,reason:'Query tests'},{requestId:randomUUID(),ip:'127.0.0.1',userAgent:'test'});const actor=await identity(database.pool,'super_admin'),createKey=randomUUID();
  const created=await write(actor,'/example-notes','POST',{title:'Private title',body:'Private body'},createKey);expect(created.status).toBe(201);const note=(await created.json()).data,updateKey=randomUUID(),deleteKey=randomUUID();expect((await write(actor,'/example-notes/'+note.id,'PATCH',{title:'Edited',body:'',expected_version:1},updateKey)).status).toBe(200);expect((await write(actor,'/example-notes/'+note.id,'DELETE',{expected_version:2},deleteKey)).status).toBe(200);
  for(const [operation,key,outcome,version] of [['create',createKey,'note_created',1],['update',updateKey,'note_updated',2],['delete',deleteKey,'note_deleted',2]] as const){const response=await get(actor,'example.notes.'+operation,key);expect(response.status).toBe(200);expect((await response.json()).data).toMatchObject({outcome,resource_id:note.id,version});}
});
it('does not revive a stale session to expose a completed password-change result',async()=>{
  const actor=await identity(database.pool),item=await saved(actor);await database.pool.query('UPDATE users SET authorization_version=authorization_version+1 WHERE id=$1',[actor.userId]);expect((await get(actor,'me.password.change',item.key)).status).toBe(401);const next={userId:actor.userId,...await sessionFor(database.pool,actor.userId)};expect((await get(next,'me.password.change',item.key)).status).toBe(200);
});
const confirmation=(id:string,label?:string)=>({target_id:id,reason:'Review result query',...(label?{typed_label:label}:{})});
async function checked(response:Response){const value=await response.json();expect(response.status,JSON.stringify(value.error)).toBeLessThan(300);return value.data;}
async function perform(operation:OperationName,key:string):Promise<Actor>{
  if(operation.startsWith('example.notes.'))await setExampleNotesEnabled(database.pool,{enabled:true,reason:'Operation coverage'},{requestId:randomUUID(),ip:'127.0.0.1',userAgent:'test'});
  const actor=await identity(database.pool,'super_admin');await database.pool.query("UPDATE sessions SET reauthenticated_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[actor.sessionId]);
  if(operation==='auth.session.revoke'){const other=await sessionFor(database.pool,actor.userId);await checked(await write(actor,'/me/sessions/'+other.sessionId,'DELETE',{},key));}
  else if(operation==='auth.sessions.revoke_others'){await sessionFor(database.pool,actor.userId);await checked(await write(actor,'/me/sessions/revoke-others','POST',{},key));}
  else if(operation==='me.password.change'){
    const old='A long original passphrase 7391',next='A different new passphrase 4826';await database.pool.query('UPDATE users SET password_hash=$2 WHERE id=$1',[actor.userId,await passwords.hash(old)]);await checked(await write(actor,'/me/password','POST',{expected_version:1,current_password:old,new_password:next},key));return {userId:actor.userId,...await sessionFor(database.pool,actor.userId)};
  }else if(operation.startsWith('me.avatar.')||operation.startsWith('settings.branding.logo.')||operation.startsWith('settings.branding.favicon.')){
    const asset=operation.startsWith('me.avatar.')?'avatar':operation.includes('.logo.')?'logo':'favicon',path=asset==='avatar'?'/me/avatar':'/settings/branding/'+asset;
    if(operation.endsWith('.delete'))await checked(await write(actor,path,'DELETE',{expected_version:1},key));
    else{const form=new FormData();form.set('expected_version','1');form.set('file',new File([new Uint8Array(image)],'image.png',{type:'image/png'}));await checked(await fetch(base+'/api/v1'+path,{method:'PUT',headers:{origin,cookie:'honocraft_dev_session='+actor.token,'x-csrf-token':csrfForSession(Buffer.alloc(32,3),actor.sessionId,'test-epoch'),'idempotency-key':key},body:form}));}
  }else if(operation==='settings.branding')await checked(await write(actor,'/settings/branding','PATCH',{instance_name:'Result test',copyright:'',default_locale:'en',default_theme:'light',timezone:'UTC',expected_version:1},key));
  else if(operation==='settings.security'){
    const data=await checked(await fetch(base+'/api/v1/settings',{headers:{cookie:'honocraft_dev_session='+actor.token}})),{version,allowed_actions:_,requires_reauth_actions:__,...fields}=data.security;await checked(await write(actor,'/settings/security','PATCH',{...fields,expected_version:version,confirmation:{target_id:'security',typed_label:'security',reason:'Test result query'}},key));
  }else if(operation.startsWith('roles.')){
    const kind=operation.slice('roles.'.length),body={code:'result_role',name:'Result role',permission_codes:[]};
    if(kind==='create')await checked(await write(actor,'/roles','POST',body,key));
    else{const role=await checked(await write(actor,'/roles','POST',body));const suffix=kind==='copy'?'/copy':kind==='eligibility'?'/eligibility':'';
      await checked(await write(actor,'/roles/'+role.id+suffix,kind==='copy'?'POST':kind==='eligibility'?'PUT':kind==='delete'?'DELETE':'PATCH',{expected_version:1,confirmation:confirmation(role.id,role.code),...(kind==='copy'?{new_code:'copied_role',new_name:'Copied'}:kind==='eligibility'?{is_delegable:true,is_registration_default_eligible:false}:kind==='update'?{name:'Updated'}:{})},key));}
  }else if(operation.startsWith('users.')){
    const target=await identity(database.pool),kind=operation.slice('users.'.length),suffix=kind==='profile'?'/profile':kind==='status'?'/status':kind==='roles'?'/roles':kind==='reset'?'/password-reset':'';
    await checked(await write(actor,'/users/'+target.userId+suffix,kind==='profile'?'PATCH':kind==='roles'?'PUT':kind==='delete'?'DELETE':'POST',{expected_version:1,confirmation:confirmation(target.userId,target.userId+'@example.test'),...(kind==='profile'?{display_name:'Updated'}:kind==='status'?{action:'suspend'}:kind==='roles'?{role_ids:[]}:{})},key));
  }else if(operation.startsWith('email-change.')){
    const admin=operation.includes('.admin-'),target=admin?await identity(database.pool):actor,path=admin?'/users/'+target.userId+'/email-change':'/me/email-change',body={expected_version:1,new_email:randomUUID()+'@example.test',...(admin?{confirmation:confirmation(target.userId)}:{})};
    if(operation.endsWith('start'))await checked(await write(actor,path,'POST',body,key));else{const started=await checked(await write(actor,path,'POST',body));await checked(await write(actor,path,'DELETE',{expected_version:started.user_version,request_id:started.request_id,request_version:started.request_version,...(admin?{confirmation:confirmation(target.userId)}:{})},key));}
  }else if(operation.startsWith('invitations.')){
    const id=(await database.pool.query("SELECT id FROM roles WHERE code='user'")).rows[0].id,body={email:randomUUID()+'@example.test',role_ids:[id]};
    if(operation.endsWith('.create'))await checked(await write(actor,'/invites','POST',body,key));else{const invite=await checked(await write(actor,'/invites','POST',body));
      // The cooldown itself has dedicated tests; make this fixture's first acceptance old enough.
      await database.pool.query("UPDATE rate_limit_buckets SET last_accepted_at=clock_timestamp()-interval '61 seconds' WHERE scope='mail.target.invite_accept'");
      await checked(await write(actor,'/invites/'+invite.id+(operation.endsWith('.resend')?'/resend':'/revoke'),'POST',{expected_version:invite.version,confirmation:confirmation(invite.id)},key));}
  }else if(operation.startsWith('example.notes.')){
    const body={title:'Private note',body:'Body must not escape'};if(operation.endsWith('.create'))await checked(await write(actor,'/example-notes','POST',body,key));else{const note=await checked(await write(actor,'/example-notes','POST',body));await checked(await write(actor,'/example-notes/'+note.id,operation.endsWith('.delete')?'DELETE':'PATCH',{expected_version:1,...(operation.endsWith('.update')?body:{})},key));}
  }else throw new Error('Missing actual-write scenario: '+operation);
  return actor;
}
it.each(OPERATION_NAMES)('queries %s results emitted by the real registered HTTP write',async operation=>{
  const key=randomUUID(),actor=await perform(operation,key),expected=(await database.pool.query('SELECT result_summary FROM idempotency_records WHERE actor_id=$1 AND operation=$2',[actor.userId,operation])).rows;
  expect(expected).toHaveLength(1);const response=await get(actor,operation,key),body=await response.json();expect(response.status,JSON.stringify(body.error)).toBe(200);expect(body.data).toEqual(expected[0].result_summary);expect(Object.keys(body.data).sort()).toEqual(['completed_at','outcome','resource_id','version']);
});
it('preserves legitimate results when the original target UUID used uppercase letters',async()=>{
  const actor=await identity(database.pool,'admin'),target=await identity(database.pool),key=randomUUID();await checked(await write(actor,'/users/'+target.userId.toUpperCase()+'/profile','PATCH',{expected_version:1,display_name:'Updated'},key));expect((await get(actor,'users.profile',key)).status).toBe(200);
});
it('does not allow a differently cased own UUID to bypass the self-management prohibition',async()=>{
  const actor=await identity(database.pool,'super_admin');await identity(database.pool,'super_admin');await database.pool.query("UPDATE sessions SET reauthenticated_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[actor.sessionId]);
  const response=await write(actor,'/users/'+actor.userId.toUpperCase()+'/status','POST',{expected_version:1,action:'suspend',confirmation:confirmation(actor.userId,actor.userId+'@example.test')});expect(response.status).toBe(403);expect((await response.json()).error.code).toBe('SELF_MANAGEMENT_FORBIDDEN');expect((await database.pool.query('SELECT status FROM users WHERE id=$1',[actor.userId])).rows[0].status).toBe('active');
});
async function deletedRole(actor:Actor,key=randomUUID()){
  const id=randomUUID();await database.pool.query("INSERT INTO roles(id,code,name,is_delegable) VALUES($1,'query_role','Query role',true)",[id]);await checked(await write(actor,'/roles/'+id,'DELETE',{expected_version:1,confirmation:confirmation(id,'query_role')},key));return key;
}
it('keeps deleted-role summaries readable only while the actor retains the operation permission',async()=>{
  const actor=await identity(database.pool,'admin'),key=await deletedRole(actor);expect((await get(actor,'roles.delete',key)).status).toBe(200);
  await database.pool.query("DELETE FROM role_permissions WHERE role_id=(SELECT id FROM roles WHERE code='admin') AND permission_id=(SELECT id FROM permissions WHERE code='role:manage')");await missing(await get(actor,'roles.delete',key));
});
it('refuses a deleted-role result whose metadata cannot prove its historical target scope',async()=>{
  const actor=await identity(database.pool,'admin'),key=await deletedRole(actor),stored=(await database.pool.query("SELECT policy_context FROM idempotency_records WHERE operation='roles.delete'")).rows[0].policy_context;
  await database.pool.query("UPDATE idempotency_records SET policy_context=$1 WHERE operation='roles.delete'",[{...stored,before:null,after:stored.before}]);await missing(await get(actor,'roles.delete',key));
});
it('hides user history after the current target becomes privileged',async()=>{
  const actor=await identity(database.pool,'admin'),target=await identity(database.pool),key=randomUUID();await checked(await write(actor,'/users/'+target.userId+'/profile','PATCH',{expected_version:1,display_name:'Updated'},key));expect((await get(actor,'users.profile',key)).status).toBe(200);await database.pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='admin'",[target.userId]);await missing(await get(actor,'users.profile',key));
});
it('retains privileged historical scope after a target was deleted and the actor was demoted',async()=>{
  const actor=await identity(database.pool,'super_admin'),target=await identity(database.pool,'admin'),key=randomUUID();await identity(database.pool,'super_admin');await database.pool.query("UPDATE sessions SET reauthenticated_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[actor.sessionId]);await checked(await write(actor,'/users/'+target.userId,'DELETE',{expected_version:1,confirmation:confirmation(target.userId,target.userId+'@example.test')},key));expect((await get(actor,'users.delete',key)).status).toBe(200);
  await database.pool.query('DELETE FROM user_roles WHERE user_id=$1',[actor.userId]);await database.pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='admin'",[actor.userId]);await database.pool.query('UPDATE users SET authorization_version=authorization_version+1 WHERE id=$1',[actor.userId]);const next={userId:actor.userId,...await sessionFor(database.pool,actor.userId)};await missing(await get(next,'users.delete',key));
});
it('checks present definitions of removed historical roles for queries and mutation replays',async()=>{
  const actor=await identity(database.pool,'admin'),target=await identity(database.pool),role=randomUUID(),key=randomUUID(),body={expected_version:1,role_ids:[],confirmation:confirmation(target.userId)};
  await database.pool.query("INSERT INTO roles(id,code,name,is_delegable) VALUES($1,'previous_role','Previous role',true)",[role]);await database.pool.query('DELETE FROM user_roles WHERE user_id=$1',[target.userId]);await database.pool.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',[target.userId,role]);await checked(await write(actor,'/users/'+target.userId+'/roles','PUT',body,key));expect((await get(actor,'users.roles',key)).status).toBe(200);
  await database.pool.query('UPDATE roles SET is_delegable=false WHERE id=$1',[role]);await missing(await get(actor,'users.roles',key));expect((await write(actor,'/users/'+target.userId+'/roles','PUT',body,key)).status).toBe(403);
});
it('rejects notes results when configuration or the current catalog disables the module',async()=>{
  const key=randomUUID(),actor=await perform('example.notes.create',key),query=createOperationQueries(web,{epoch:'test-epoch',digestKey},false);await expect(query(actor,'example.notes.create',key)).rejects.toMatchObject({code:'OPERATION_NOT_FOUND'});
  await setExampleNotesEnabled(database.pool,{enabled:false,reason:'Test result shutdown'},{requestId:randomUUID(),ip:'127.0.0.1',userAgent:'test'});const next={userId:actor.userId,...await sessionFor(database.pool,actor.userId)};await missing(await get(next,'example.notes.create',key));
});
it('rechecks revocation after waiting for a coordinated security mutation to commit',async()=>{
  const actor=await identity(database.pool),item=await saved(actor),client=await database.pool.connect();let pending:Promise<Response>|undefined;
  try{
    await client.query('BEGIN');await client.query('SELECT id FROM system_state WHERE id=1 FOR UPDATE');await client.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1',[actor.sessionId]);pending=get(actor,'me.password.change',item.key);
    const deadline=performance.now()+1000;let waiting=false;while(performance.now()<deadline){waiting=(await database.pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FROM system_state WHERE id=1 FOR SHARE%') AS waiting")).rows[0].waiting;if(waiting)break;await delay(10);}expect(waiting).toBe(true);await client.query('COMMIT');expect((await pending).status).toBe(401);
  }finally{await client.query('ROLLBACK');client.release();await pending?.catch(()=>undefined);}
});
it('reports bounded contention as retryable rather than an absent operation',async()=>{
  const actor=await identity(database.pool),item=await saved(actor),client=await database.pool.connect();try{await client.query('BEGIN');await client.query('SELECT id FROM system_state WHERE id=1 FOR UPDATE');const response=await get(actor,'me.password.change',item.key);expect(response.status).toBe(503);expect(response.headers.get('retry-after')).toBe('2');expect((await response.json()).error.code).toBe('BUSY_RETRY');}finally{await client.query('ROLLBACK');client.release();}
});
it('does not disguise database failures as not-found or expose SQL and connection details',async()=>{
  const actor=await identity(database.pool),item=await saved(actor);await database.pool.query('REVOKE SELECT ON idempotency_records FROM honocraft_web');const response=await get(actor,'me.password.change',item.key),body=await response.json();expect(response.status).toBe(500);expect(body.error.code).toBe('INTERNAL_ERROR');for(const value of ['postgresql','SELECT','permission denied','idempotency_records','request marker'])expect(JSON.stringify(body)).not.toContain(value);
});
