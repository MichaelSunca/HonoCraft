import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startTestPostgres } from '../helpers/postgres.js';
import { identity, initializedDatabase } from '../helpers/identity.js';
import { migrate } from '../../apps/server/src/infrastructure/migrations.js';
import { withTransaction, type Tx } from '../../apps/server/src/infrastructure/db.js';
import { runIdempotent } from '../../apps/server/src/infrastructure/idempotency.js';
import { appendAudit } from '../../apps/server/src/modules/audit/writer.js';
let database: Awaited<ReturnType<typeof startTestPostgres>>;
let actor: Awaited<ReturnType<typeof identity>>;
const keyMaterial={id:'test-v1',key:Buffer.alloc(32,7)};
beforeAll(async () => { database=await startTestPostgres(); await migrate(database.pool); await initializedDatabase(database.pool); actor=await identity(database.pool,'admin'); });
afterAll(async () => { await database?.close(); });
const policySchema=z.strictObject({owner_id:z.uuid()});
const perform=(key:string,input:unknown={title:'Once'}, ownerId=actor.userId) => withTransaction(database.pool,'shared',async tx => runIdempotent(tx,{
  actorId:ownerId,operation:'notes.create',key,input,digestKey:keyMaterial,policySchema,
  authorizeStored:async context => { if(context.owner_id!==ownerId) throw new Error('SCOPE_DENIED'); },
  execute:async () => {
    const note=(await tx.query<{id:string;created_at:Date}>("INSERT INTO example_notes(owner_id,title,body) VALUES ($1,'Once','') RETURNING id,created_at",[ownerId])).rows[0]!;
    await appendAudit(tx,{actor:{type:'user',id:ownerId},action:'example.notes.created',target:{type:'note',id:note.id},
      result:'success',meta:{requestId:randomUUID(),ip:'127.0.0.1',userAgent:'test'},changes:{after_version:1}});
    return {summary:{outcome:'completed',resource_id:note.id,version:1,completed_at:note.created_at.toISOString()},status:201,
      target:{type:'note',id:note.id},policyContext:{owner_id:ownerId}};
  },
}));

describe('transactional idempotency and audit',()=>{
  it('serializes concurrent requests and records one business effect and one success audit',async()=>{
    const key=randomUUID();
    const results=await Promise.all([perform(key),perform(key)]);
    expect(results[0].summary).toEqual(results[1].summary);
    expect(results.map(r=>r.replayed).sort()).toEqual([false,true]);
    const id=results[0].summary.resource_id;
    expect((await database.pool.query('SELECT id FROM audit_events WHERE target_id=$1',[id])).rowCount).toBe(1);
    const saved=(await database.pool.query("SELECT * FROM idempotency_records WHERE target_id=$1",[id])).rows[0];
    expect(saved.result_summary).toEqual(results[0].summary);
    expect(saved.expires_at-saved.created_at).toBe(86_400_000);
    expect(JSON.stringify(saved)).not.toContain(key);
  });
  it('rejects same-key requests with changed input',async()=>{
    const key=randomUUID(); await perform(key);
    await expect(perform(key,{title:'Changed'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  });
  it('uses canonical object ordering for equivalent requests',async()=>{
    const key=randomUUID(); const first=await perform(key,{a:1,b:2});
    const second=await perform(key,{b:2,a:1});
    expect(second.summary).toEqual(first.summary); expect(second.replayed).toBe(true);
  });
  it('does not share results across actors',async()=>{
    const key=randomUUID(); const other=await identity(database.pool);
    const first=await perform(key); const second=await perform(key,{title:'Once'},other.userId);
    expect(second.summary.resource_id).not.toBe(first.summary.resource_id);
  });
  it('reauthorizes historical policy context before releasing a saved result',async()=>{
    const key=randomUUID(); const result=await perform(key);
    await database.pool.query('UPDATE idempotency_records SET policy_context=$2 WHERE target_id=$1',[result.summary.resource_id,{owner_id:randomUUID()}]);
    await expect(perform(key)).rejects.toThrow('SCOPE_DENIED');
  });
  it('rolls back a business write when audit validation fails',async()=>{
    const id=randomUUID();
    await expect(withTransaction(database.pool,'shared',async tx=>{
      await tx.query("INSERT INTO example_notes(id,owner_id,title,body) VALUES ($1,$2,'Rollback','')",[id,actor.userId]);
      await badAudit(tx,id);
    })).rejects.toBeDefined();
    expect((await database.pool.query('SELECT id FROM example_notes WHERE id=$1',[id])).rowCount).toBe(0);
    expect((await database.pool.query('SELECT id FROM audit_events WHERE target_id=$1',[id])).rowCount).toBe(0);
  });
  it('rejects an invalid idempotency key before executing any mutation',async()=>{
    await expect(perform('invalid')).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  });
});
async function badAudit(tx:Tx,id:string) {
  return appendAudit(tx,{actor:{type:'user',id:actor.userId},action:'example.notes.created',target:{type:'note',id},result:'success',
    meta:{requestId:randomUUID(),ip:'127.0.0.1',userAgent:'test'},changes:{password:'must never be stored'}});
}
