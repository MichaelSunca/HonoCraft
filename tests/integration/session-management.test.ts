import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {startTestPostgres} from '../helpers/postgres.js';
import {identity,initializedDatabase,sessionFor} from '../helpers/identity.js';
import {migrate} from '../../apps/server/src/infrastructure/migrations.js';
import {csrfForSession} from '../../apps/server/src/infrastructure/crypto.js';
import {createSessionManagement} from '../../apps/server/src/modules/auth/session-management.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>;
const secrets={epoch:'test-epoch',csrfKey:Buffer.alloc(32,3),digestKey:{id:'test-v1',key:Buffer.alloc(32,7)}};
const meta=()=>({requestId:randomUUID(),ip:'127.0.0.1',userAgent:'session management test'});
const ref=(user:{token:string;sessionId:string})=>({token:user.token,csrfToken:csrfForSession(secrets.csrfKey,user.sessionId,secrets.epoch)});
beforeAll(async()=>{database=await startTestPostgres();await migrate(database.pool);await initializedDatabase(database.pool);});
afterAll(async()=>{await database.close();});
const service=()=>createSessionManagement(database.pool,secrets);
it('lists only currently effective own sessions, with deterministic pagination and no credentials',async()=>{
  const actor=await identity(database.pool),other=await sessionFor(database.pool,actor.userId);await identity(database.pool);
  const expired=await sessionFor(database.pool,actor.userId),stale=await sessionFor(database.pool,actor.userId),revoked=await sessionFor(database.pool,actor.userId),oldEpoch=await sessionFor(database.pool,actor.userId);
  await database.pool.query("UPDATE sessions SET created_at=clock_timestamp()-interval '2 hours',last_seen_at=clock_timestamp()-interval '1 hour',idle_expires_at=clock_timestamp()-interval '30 minutes' WHERE id=$1",[expired.sessionId]);
  await database.pool.query('UPDATE sessions SET authorization_version=authorization_version+1 WHERE id=$1',[stale.sessionId]);await database.pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1',[revoked.sessionId]);await database.pool.query("UPDATE sessions SET credential_epoch='old' WHERE id=$1",[oldEpoch.sessionId]);
  const first=await service().list(ref(actor),{page:1,page_size:1});const second=await service().list(ref(actor),{page:2,page_size:1});
  expect(first.total).toBe(2);expect(first.items).toHaveLength(1);expect(second.items).toHaveLength(1);expect(new Set([...first.items,...second.items].map(x=>x.id))).toEqual(new Set([actor.sessionId,other.sessionId]));
  const current=[...first.items,...second.items].find(x=>x.id===actor.sessionId)!;expect(current.is_current).toBe(true);expect(current).toHaveProperty('ip','127.0.0.1');expect(JSON.stringify(first)).not.toMatch(/token|authorization_version|credential_epoch/);
});
it('applies tightened idle and absolute policy to the list before cleanup runs',async()=>{
  const actor=await identity(database.pool),old=await sessionFor(database.pool,actor.userId);
  await database.pool.query("UPDATE sessions SET created_at=clock_timestamp()-interval '40 minutes',last_seen_at=clock_timestamp()-interval '10 minutes' WHERE id=$1",[old.sessionId]);
  await database.pool.query("UPDATE system_settings SET typed_value=jsonb_set(typed_value,'{session_idle_minutes}','5') WHERE key='security'");
  try{expect((await service().list(ref(actor),{})).items.map(x=>x.id)).toEqual([actor.sessionId]);}finally{await database.pool.query("UPDATE system_settings SET typed_value=jsonb_set(typed_value,'{session_idle_minutes}','30') WHERE key='security'");}
});
it('revokes another own session, replays safely and refuses another user session',async()=>{
  const actor=await identity(database.pool),other=await sessionFor(database.pool,actor.userId),stranger=await identity(database.pool),key=randomUUID();
  const first=await service().revoke(ref(actor),{id:other.sessionId},meta(),key);expect(first.data).toEqual({revoked:true,is_current:false});
  const time=(await database.pool.query('SELECT revoked_at FROM sessions WHERE id=$1',[other.sessionId])).rows[0].revoked_at;
  expect((await service().revoke(ref(actor),{id:other.sessionId},meta(),key)).replayed).toBe(true);
  expect((await service().revoke(ref(actor),{id:other.sessionId},meta(),randomUUID())).data).toEqual({revoked:true,is_current:false});
  expect((await database.pool.query('SELECT revoked_at FROM sessions WHERE id=$1',[other.sessionId])).rows[0].revoked_at).toEqual(time);
  await expect(service().revoke(ref(actor),{id:stranger.sessionId},meta(),randomUUID())).rejects.toMatchObject({code:'NOT_FOUND'});
});
it('revokes all other sessions while preserving the current and other users',async()=>{
  const actor=await identity(database.pool),other=await sessionFor(database.pool,actor.userId),stranger=await identity(database.pool);
  const result=await service().revokeOthers(ref(actor),{},meta(),randomUUID());expect(result.data).toEqual({revoked_count:1});
  expect((await service().list(ref(actor),{})).items.map(x=>x.id)).toEqual([actor.sessionId]);expect((await service().list(ref(stranger),{})).items).toHaveLength(1);
  expect((await database.pool.query('SELECT revoked_at FROM sessions WHERE id=$1',[other.sessionId])).rows[0].revoked_at).not.toBeNull();
});
it('requires CSRF and an idempotency key; current-session revocation invalidates reads immediately',async()=>{
  const actor=await identity(database.pool);
  await expect(service().revokeOthers({...ref(actor),csrfToken:''},{},meta(),randomUUID())).rejects.toMatchObject({code:'CSRF_INVALID'});
  await expect(service().revokeOthers(ref(actor),{},meta(),undefined)).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  expect((await service().revoke(ref(actor),{id:actor.sessionId},meta(),randomUUID())).data).toEqual({revoked:true,is_current:true});
  await expect(service().list(ref(actor),{})).rejects.toMatchObject({code:'SESSION_INVALID'});
});
it('records successful revocations in the security history without credential material',async()=>{
  const actor=await identity(database.pool),other=await sessionFor(database.pool,actor.userId);
  await service().revoke(ref(actor),{id:other.sessionId},meta(),randomUUID());
  const events=(await database.pool.query("SELECT event_type,result FROM security_events WHERE user_id=$1",[actor.userId])).rows;
  expect(events).toEqual([{event_type:'auth.session_revoked',result:'success'}]);
});
it('returns a bounded device summary instead of reflecting the raw User-Agent',async()=>{
  const actor=await identity(database.pool),other=await sessionFor(database.pool,actor.userId);
  await database.pool.query("UPDATE sessions SET user_agent='Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0' WHERE id=$1",[actor.sessionId]);await database.pool.query("UPDATE sessions SET user_agent='<script>untrusted device description</script>' WHERE id=$1",[other.sessionId]);
  const result=await service().list(ref(actor),{});expect(result.items.find(row=>row.id===actor.sessionId)?.device).toEqual({category:'desktop',browser:'Firefox',os:'Linux'});expect(result.items.find(row=>row.id===other.sessionId)?.device).toEqual({category:'unknown',browser:'unknown',os:'unknown'});expect(JSON.stringify(result)).not.toContain('script');
});
