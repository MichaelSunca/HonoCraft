import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../apps/server/src/infrastructure/migrations.js';
import { withTransaction } from '../../apps/server/src/infrastructure/db.js';
import { startTestPostgres } from '../helpers/postgres.js';
let database: Awaited<ReturnType<typeof startTestPostgres>>;
let owner: string;
beforeAll(async () => {
  database = await startTestPostgres();
  await migrate(database.pool);
  owner = randomUUID();
  await database.pool.query("INSERT INTO users(id,email,normalized_email,display_name,creation_source) VALUES ($1,'owner@example.test','owner@example.test','Owner','registration')",[owner]);
});
afterAll(async () => { await database?.close(); });
function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release=resolve; }); return { promise, release }; }

describe('transaction authority and coordination', () => {
  it('rolls back the business write when its success audit cannot be stored', async () => {
    const id=randomUUID();
    await expect(withTransaction(database.pool,'shared',async tx => {
      await tx.query("INSERT INTO example_notes(id,owner_id,title,body) VALUES ($1,$2,'Atomic note','')",[id,owner]);
      await tx.query("INSERT INTO audit_events(actor_type,action,target_type,result,request_id) VALUES ('invalid_actor','note.created','note','success',$1)",[randomUUID()]);
    })).rejects.toMatchObject({code:'23514'});
    expect((await database.pool.query('SELECT id FROM example_notes WHERE id=$1',[id])).rowCount).toBe(0);
  });
  it('holds a shared security lock until the protected write commits before revocation', async () => {
    const entered=barrier(); const release=barrier();
    const order: string[]=[];
    const write=withTransaction(database.pool,'shared',async () => { entered.release(); await release.promise; order.push('write'); });
    await entered.promise;
    const revoke=withTransaction(database.pool,'exclusive',async () => { order.push('revoke'); });
    try {
      const deadline=Date.now()+1500;
      let observed=false;
      while (Date.now()<deadline && !observed) {
        const result=await database.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%system_state%'");
        observed=result.rowCount!>0;
        if (!observed && order.includes('revoke')) break;
        if (!observed) await delay(10);
      }
      expect(observed).toBe(true);
      expect(order).toEqual([]);
    } finally { release.release(); await Promise.all([write,revoke]); }
    expect(order).toEqual(['write','revoke']);
  });
  it('does not permit writes in a list/count snapshot', async () => {
    await expect(withTransaction(database.pool,'read',async tx => {
      await tx.query("INSERT INTO example_notes(owner_id,title,body) VALUES ($1,'Read-only bypass','')",[owner]);
    })).rejects.toMatchObject({code:'25006'});
  });
  it('cancels an over-budget transaction and rolls back its writes instead of committing late', async () => {
    const id=randomUUID();
    await expect(withTransaction(database.pool,'shared',async tx => {
      await tx.query("SET LOCAL statement_timeout='0'");
      await tx.query("INSERT INTO example_notes(id,owner_id,title,body) VALUES ($1,$2,'Must roll back','')",[id,owner]);
      await tx.query('SELECT pg_sleep(9)');
    })).rejects.toBeDefined();
    expect((await database.pool.query('SELECT id FROM example_notes WHERE id=$1',[id])).rowCount).toBe(0);
    await expect(database.pool.query('SELECT 1 AS healthy')).resolves.toHaveProperty('rows', [{healthy:1}]);
  });
});
