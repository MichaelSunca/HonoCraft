import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestPostgres } from '../helpers/postgres.js';
import { identity, initializedDatabase, sessionFor } from '../helpers/identity.js';
import { migrate } from '../../apps/server/src/infrastructure/migrations.js';
import { authenticateRead } from '../../apps/server/src/modules/auth/sessions.js';
let database: Awaited<ReturnType<typeof startTestPostgres>>;
beforeAll(async () => { database=await startTestPostgres(); await migrate(database.pool); await initializedDatabase(database.pool); });
afterAll(async () => { await database?.close(); });
const read = (token: string, epoch='test-epoch') => authenticateRead(database.pool, {token,epoch});

describe('database-backed session authentication', () => {
  it('returns current permissions and renews a valid session without granting recent authentication', async () => {
    const actor=await identity(database.pool,'admin');
    const result=await read(actor.token);
    expect(result.actor.userId).toBe(actor.userId);
    expect(result.permissions.has('user:update')).toBe(true);
    expect(result.permissions.has('role:delegate')).toBe(false);
    expect(result.reauthenticatedAt).toBeNull();
    expect(result.sessionId).toBe(actor.sessionId);
    const row=(await database.pool.query('SELECT last_seen_at,idle_expires_at FROM sessions WHERE id=$1',[actor.sessionId])).rows[0];
    expect(row.last_seen_at).toEqual(result.now);
    expect(row.idle_expires_at.getTime()-result.now.getTime()).toBe(30*60_000);
  });
  it('restricts super administrators to permissions registered for enabled modules', async () => {
    const actor=await identity(database.pool,'super_admin');
    const result=await read(actor.token);
    expect(result.permissions.has('settings:update-security')).toBe(true);
    expect(result.permissions.has('example-note:read')).toBe(false);
  });
  it.each(['bad', '', 'a'.repeat(43)])('rejects malformed or unknown token %s as SESSION_INVALID', async token => {
    await expect(read(token)).rejects.toMatchObject({code:'SESSION_INVALID'});
  });
  it('rejects a session from an earlier credential epoch', async () => {
    const actor=await identity(database.pool);
    await expect(read(actor.token,'new-epoch')).rejects.toMatchObject({code:'SESSION_INVALID'});
  });
  it.each(['suspended','pending','deleted'])('rejects the current user status %s', async status => {
    const actor=await identity(database.pool);
    await database.pool.query("UPDATE users SET status=$2,deleted_at=CASE WHEN $2='deleted' THEN clock_timestamp() ELSE NULL END WHERE id=$1",[actor.userId,status]);
    await expect(read(actor.token)).rejects.toMatchObject({code:'SESSION_INVALID'});
  });
  it('rejects an authorization version mismatch even without an explicit session revocation', async () => {
    const actor=await identity(database.pool);
    await database.pool.query('UPDATE users SET authorization_version=authorization_version+1 WHERE id=$1',[actor.userId]);
    await expect(read(actor.token)).rejects.toMatchObject({code:'SESSION_INVALID'});
  });
  it('never revives a revoked session', async () => {
    const actor=await identity(database.pool);
    await database.pool.query("UPDATE sessions SET revoked_at=clock_timestamp(),revoked_reason='manual' WHERE id=$1",[actor.sessionId]);
    await expect(read(actor.token)).rejects.toMatchObject({code:'SESSION_INVALID'});
  });
  it('checks the previous idle deadline before renewal', async () => {
    const actor=await identity(database.pool);
    await database.pool.query("UPDATE sessions SET created_at=clock_timestamp()-interval '2 hours',last_seen_at=clock_timestamp()-interval '1 hour',idle_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[actor.sessionId]);
    await expect(read(actor.token)).rejects.toMatchObject({code:'SESSION_INVALID'});
  });
  it('applies a shortened policy immediately and never extends an existing absolute deadline', async () => {
    const actor=await identity(database.pool);
    await database.pool.query("UPDATE sessions SET created_at=clock_timestamp()-interval '2 hours',last_seen_at=clock_timestamp()-interval '10 minutes' WHERE id=$1",[actor.sessionId]);
    await database.pool.query("UPDATE system_settings SET typed_value=jsonb_set(typed_value,'{session_idle_minutes}','5') WHERE key='security'");
    try { await expect(read(actor.token)).rejects.toMatchObject({code:'SESSION_INVALID'}); }
    finally { await database.pool.query("UPDATE system_settings SET typed_value=jsonb_set(typed_value,'{session_idle_minutes}','30') WHERE key='security'"); }
    const other=await identity(database.pool);
    const fixed=(await database.pool.query("UPDATE sessions SET absolute_expires_at=clock_timestamp()+interval '10 minutes' WHERE id=$1 RETURNING absolute_expires_at",[other.sessionId])).rows[0].absolute_expires_at;
    await read(other.token);
    const after=(await database.pool.query('SELECT absolute_expires_at,idle_expires_at FROM sessions WHERE id=$1',[other.sessionId])).rows[0];
    expect(after.absolute_expires_at).toEqual(fixed);
    expect(after.idle_expires_at).toEqual(fixed);
  });
  it('does not share recent authentication between sessions', async () => {
    const actor=await identity(database.pool);
    const other=await sessionFor(database.pool,actor.userId);
    await database.pool.query('UPDATE sessions SET reauthenticated_at=clock_timestamp() WHERE id=$1',[actor.sessionId]);
    expect((await read(actor.token)).reauthenticatedAt).toBeInstanceOf(Date);
    expect((await read(other.token)).reauthenticatedAt).toBeNull();
  });
  it('rejects authentication until initialization has completed', async () => {
    const actor=await identity(database.pool);
    await database.pool.query("UPDATE system_state SET initialization_status='pending',initialized_at=NULL WHERE id=1");
    try { await expect(read(actor.token)).rejects.toMatchObject({code:'SYSTEM_NOT_INITIALIZED'}); }
    finally { await initializedDatabase(database.pool); }
  });
});
