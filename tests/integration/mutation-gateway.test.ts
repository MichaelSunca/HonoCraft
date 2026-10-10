import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { AppError } from '../../packages/contracts/src/errors.js';
import { startTestPostgres } from '../helpers/postgres.js';
import { identity,initializedDatabase } from '../helpers/identity.js';
import { migrate } from '../../apps/server/src/infrastructure/migrations.js';
import { csrfForSession } from '../../apps/server/src/infrastructure/crypto.js';
import { createMutationGateway,defineMutation } from '../../apps/server/src/modules/access/mutation-gateway.js';
import { profileMutation } from '../../apps/server/src/modules/users/profile.js';
import { assertManageableTarget } from '../../apps/server/src/modules/access/policy.js';
import { loadAccess } from '../../apps/server/src/modules/access/repository.js';

let database:Awaited<ReturnType<typeof startTestPostgres>>;
const csrfKey=Buffer.alloc(32,3);
const credentials={epoch:'test-epoch',csrfKey,digestKey:{id:'test-v1',key:Buffer.alloc(32,7)}};
const meta=()=>({requestId:randomUUID(),ip:'127.0.0.1',userAgent:'gateway tests'});
const ref=(actor:Awaited<ReturnType<typeof identity>>)=>({token:actor.token,csrfToken:csrfForSession(csrfKey,actor.sessionId,'test-epoch')});
// Internal registry fixture exercises the real gateway and PostgreSQL, never HTTP-supplied callbacks.
const managedMutation=defineMutation({
  input:z.strictObject({id:z.uuid(),expected_version:z.number().int().positive()}),output:z.strictObject({id:z.uuid(),version:z.number().int().positive()}),
  mode:'exclusive',permission:'user:update',recentAuth:true,auditAction:'users.user.profile_updated',
  resolveLocks:async (_tx,input)=>({userIds:[input.id],roleIds:[]}),
  authorize:async(tx,context,input)=>{
    const target=await loadAccess(tx,input.id); if(!target) throw new AppError('NOT_FOUND'); assertManageableTarget(context.actor,target);
  },
  idempotency:{policySchema:z.strictObject({target_id:z.uuid()}),authorizeStored:async(tx,context,_input,stored)=>{
    const target=await loadAccess(tx,stored.target_id); if(!target) throw new AppError('FORBIDDEN'); assertManageableTarget(context.actor,target);
  },summarize:(data,context)=>({outcome:'completed',resource_id:data.id,version:data.version,completed_at:context.now.toISOString()}),
  policyContext:(_data,_context,input)=>({target_id:input.id})},
  execute:async(tx,_context,input)=>{
    const row=(await tx.query<{id:string;version:number}>('UPDATE users SET version=version+1 WHERE id=$1 AND version=$2 RETURNING id,version',[input.id,input.expected_version])).rows[0];
    if(!row) throw new AppError('VERSION_CONFLICT');
    return {data:row,audit:{target:{type:'user',id:row.id},changes:{after_version:row.version}}};
  },
});
const registry={'me.profile.update':profileMutation,'users.profile.update':managedMutation};
const gateway=()=>createMutationGateway(database.pool,credentials,registry);
beforeAll(async()=>{database=await startTestPostgres();await migrate(database.pool);await initializedDatabase(database.pool);});
afterAll(async()=>{await database?.close();});

describe('registered authenticated mutation gateway',()=>{
  it('updates only the authenticated profile and commits one safe audit',async()=>{
    const actor=await identity(database.pool);
    const response=await gateway()('me.profile.update',ref(actor),{expected_version:1,display_name:'New name'},meta());
    expect(response.data).toMatchObject({id:actor.userId,display_name:'New name',version:2});
    const row=(await database.pool.query('SELECT changes FROM audit_events WHERE actor_id=$1 AND result=\'success\'',[actor.userId])).rows[0];
    expect(row.changes).toEqual({before_version:1,after_version:2,changed_fields:['display_name']});
    expect(JSON.stringify(row)).not.toContain('New name');
  });
  it('rejects unknown input fields without updating the profile',async()=>{
    const actor=await identity(database.pool);
    await expect(gateway()('me.profile.update',ref(actor),{expected_version:1,display_name:'Bad',status:'active'},meta())).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    expect((await database.pool.query('SELECT version FROM users WHERE id=$1',[actor.userId])).rows[0].version).toBe(1);
  });
  it('requires CSRF and rolls back session renewal on rejection',async()=>{
    const actor=await identity(database.pool);
    const before=(await database.pool.query('SELECT last_seen_at FROM sessions WHERE id=$1',[actor.sessionId])).rows[0].last_seen_at;
    await expect(gateway()('me.profile.update',{token:actor.token,csrfToken:''},{expected_version:1,theme:'dark'},meta())).rejects.toMatchObject({code:'CSRF_INVALID'});
    expect((await database.pool.query('SELECT last_seen_at FROM sessions WHERE id=$1',[actor.sessionId])).rows[0].last_seen_at).toEqual(before);
    expect((await database.pool.query("SELECT reason_code FROM audit_events WHERE actor_id=$1 AND result='denied'",[actor.userId])).rows[0].reason_code).toBe('CSRF_INVALID');
  });
  it('checks the editing version after authorization and preserves existing data on conflict',async()=>{
    const actor=await identity(database.pool);
    await expect(gateway()('me.profile.update',ref(actor),{expected_version:2,display_name:'Stale'},meta())).rejects.toMatchObject({code:'VERSION_CONFLICT'});
    expect((await database.pool.query('SELECT display_name FROM users WHERE id=$1',[actor.userId])).rows[0].display_name).toBe('Test user');
  });
  it('replays a completed operation before testing its obsolete expected version',async()=>{
    const actor=await identity(database.pool,'admin');const target=await identity(database.pool);
    await database.pool.query('UPDATE sessions SET reauthenticated_at=clock_timestamp() WHERE id=$1',[actor.sessionId]);
    const key=randomUUID();const input={id:target.userId,expected_version:1};
    const first=await gateway()('users.profile.update',ref(actor),input,meta(),key);
    const again=await gateway()('users.profile.update',ref(actor),input,meta(),key);
    expect(first.data).toMatchObject({version:2});expect(again.data).toMatchObject({version:2,resource_id:target.userId});expect(again.replayed).toBe(true);
    expect((await database.pool.query('SELECT version FROM users WHERE id=$1',[target.userId])).rows[0].version).toBe(2);
    await database.pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1',[actor.sessionId]);
    await expect(gateway()('users.profile.update',ref(actor),input,meta(),key)).rejects.toMatchObject({code:'SESSION_INVALID'});
  });
  it('checks current target scope again when replaying a previous success',async()=>{
    const actor=await identity(database.pool,'admin');const target=await identity(database.pool);
    await database.pool.query('UPDATE sessions SET reauthenticated_at=clock_timestamp() WHERE id=$1',[actor.sessionId]);
    const key=randomUUID();const input={id:target.userId,expected_version:1};
    await gateway()('users.profile.update',ref(actor),input,meta(),key);
    await database.pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='super_admin'",[target.userId]);
    await expect(gateway()('users.profile.update',ref(actor),input,meta(),key)).rejects.toMatchObject({code:'TARGET_NOT_MANAGEABLE'});
  });
  it('requires permission and current-session recent authentication before a sensitive write',async()=>{
    const ordinary=await identity(database.pool);const admin=await identity(database.pool,'admin');const target=await identity(database.pool);
    const input={id:target.userId,expected_version:1};
    await expect(gateway()('users.profile.update',ref(ordinary),input,meta(),randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(gateway()('users.profile.update',ref(admin),input,meta(),randomUUID())).rejects.toMatchObject({code:'REAUTH_REQUIRED'});
  });
  it('rechecks identity after waiting behind a committed revocation',async()=>{
    const actor=await identity(database.pool);
    const blocker=await database.pool.connect();
    await blocker.query('BEGIN');await blocker.query('SELECT id FROM system_state WHERE id=1 FOR UPDATE');
    const attempt=gateway()('me.profile.update',ref(actor),{expected_version:1,theme:'dark'},meta());
    const settled=attempt.then(value=>({value}),error=>({error}));
    try {
      const until=Date.now()+1400;let blocked=false;
      while(Date.now()<until&&!blocked){
        blocked=(await database.pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%system_state%'")).rowCount!>0;
        if(!blocked)await delay(10);
      }
      expect(blocked).toBe(true);
      await blocker.query('UPDATE users SET authorization_version=authorization_version+1 WHERE id=$1',[actor.userId]);
      await blocker.query('COMMIT');
    } finally {await blocker.query('ROLLBACK');blocker.release();await settled;}
    expect(await settled).toMatchObject({error:{code:'SESSION_INVALID'}});
    expect((await database.pool.query('SELECT version FROM users WHERE id=$1',[actor.userId])).rows[0].version).toBe(1);
  });
  it('rolls back the update if PostgreSQL rejects its success audit',async()=>{
    const actor=await identity(database.pool);const request=meta();
    await database.pool.query(`CREATE FUNCTION fail_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.request_id='${request.requestId}' AND NEW.result='success' THEN RAISE EXCEPTION 'test audit unavailable'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_test_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_test_audit()`);
    try {await expect(gateway()('me.profile.update',ref(actor),{expected_version:1,theme:'dark'},request)).rejects.toBeDefined();}
    finally {await database.pool.query('DROP TRIGGER fail_test_audit ON audit_events; DROP FUNCTION fail_test_audit()');}
    expect((await database.pool.query('SELECT version FROM users WHERE id=$1',[actor.userId])).rows[0].version).toBe(1);
    expect((await database.pool.query("SELECT result FROM audit_events WHERE request_id=$1",[request.requestId])).rows).toEqual([{result:'failed'}]);
  });
});
