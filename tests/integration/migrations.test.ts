import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, appendFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, DEFAULT_MIGRATION_DIRECTORY } from '../../apps/server/src/infrastructure/migrations.js';
import { startTestPostgres } from '../helpers/postgres.js';

let database: Awaited<ReturnType<typeof startTestPostgres>>;
beforeAll(async () => { database = await startTestPostgres(); await migrate(database.pool); });
afterAll(async () => { await database?.close(); });
const addUser = (email: string, status = 'pending') => database.pool.query(
  `INSERT INTO users (id,email,normalized_email,display_name,status,creation_source,deleted_at) VALUES ($1,$2,$2,'Test',$3,'registration',CASE WHEN $3='deleted' THEN clock_timestamp() ELSE NULL END) RETURNING id`, [randomUUID(), email, status],
);

describe('PostgreSQL migrations enforce security invariants', () => {
  it('applies twice without creating accounts or duplicating built-in roles', async () => {
    await migrate(database.pool);
    const { rows } = await database.pool.query('SELECT code FROM roles ORDER BY code');
    expect(rows.map(row => row.code)).toEqual(['admin', 'super_admin', 'user']);
    expect((await database.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(0);
  });
  it('rejects an edited already-applied migration without rerunning it', async () => {
    const directory=await mkdtemp(resolve('.local/tests/migrations-'));
    try {
      await cp(DEFAULT_MIGRATION_DIRECTORY,directory,{recursive:true});
      await appendFile(resolve(directory,'0001_core.sql'),'\n-- unauthorized history change\n');
      await expect(migrate(database.pool,directory)).rejects.toThrow('MIGRATION_CHECKSUM_MISMATCH');
      expect((await database.pool.query('SELECT count(*)::int AS n FROM roles')).rows[0].n).toBe(3);
    } finally { await rm(directory,{recursive:true,force:true}); }
  });
  it('rejects inserting a new migration before an already-applied version', async () => {
    const directory=await mkdtemp(resolve('.local/tests/migrations-order-'));
    try {
      await cp(DEFAULT_MIGRATION_DIRECTORY,directory,{recursive:true});
      await writeFile(resolve(directory,'0000_inserted.sql'),'SELECT 1;');
      await expect(migrate(database.pool,directory)).rejects.toThrow('MIGRATION_ORDER_MISMATCH');
    } finally {
      await database.pool.query("DELETE FROM migration_history WHERE name='0000_inserted.sql'");
      await rm(directory,{recursive:true,force:true});
    }
  });
  it('reserves a deleted account email with a database unique constraint', async () => {
    await addUser('deleted@example.test', 'deleted');
    await expect(addUser('deleted@example.test')).rejects.toMatchObject({ code: '23505' });
  });
  it('rejects active users without verified email and local credentials', async () => {
    await expect(addUser('unverified@example.test', 'active')).rejects.toMatchObject({ code: '23514' });
  });
  it('permits a replacement invite only after the old pending row becomes terminal', async () => {
    const owner = (await addUser('inviter@example.test')).rows[0].id;
    const insert = () => database.pool.query(`INSERT INTO invites(id,email,normalized_email,inviter_id,expires_at) VALUES ($1,'invite@example.test','invite@example.test',$2,clock_timestamp()+interval '1 hour')`, [randomUUID(), owner]);
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: '23505' });
    await database.pool.query("UPDATE invites SET status='revoked' WHERE normalized_email='invite@example.test'");
    await expect(insert()).resolves.toHaveProperty('rowCount', 1);
  });
  it('enforces token hash length and purpose/subject combinations', async () => {
    const owner = (await addUser('credential@example.test')).rows[0].id;
    const insert = (hash: Buffer, purpose: string) => database.pool.query(`INSERT INTO one_time_credentials(id,purpose,token_hash,user_id,subject_version,target_email,normalized_target_email,credential_epoch,expires_at) VALUES ($1,$2,$3,$4,1,'credential@example.test','credential@example.test','test-epoch',clock_timestamp()+interval '1 hour')`, [randomUUID(), purpose, hash, owner]);
    await expect(insert(Buffer.alloc(10), 'email_verify')).rejects.toMatchObject({ code: '23514' });
    await expect(insert(Buffer.alloc(32), 'invite_accept')).rejects.toMatchObject({ code: '23514' });
    await expect(insert(Buffer.alloc(32), 'email_verify')).resolves.toHaveProperty('rowCount', 1);
  });
  it('lets the web role acquire the security coordination lock without editing initialization state', async () => {
    const client = await database.pool.connect();
    try {
      await client.query('SET ROLE honocraft_web');
      await expect(client.query('SELECT id FROM system_state WHERE id=1 FOR UPDATE')).resolves.toHaveProperty('rowCount', 1);
      await expect(client.query("UPDATE system_state SET initialization_status='pending'")).rejects.toMatchObject({ code: '42501' });
    } finally { await client.query('RESET ROLE'); client.release(); }
  });
  it('rejects queued mail with missing authenticated encryption metadata', async () => {
    await expect(database.pool.query(`INSERT INTO email_tasks(event_key,purpose,recipient,recipient_masked,payload_ciphertext,key_id,locale)
      VALUES ('malformed-mail','email_verify','test@example.test','t***@example.test',decode('ab','hex'),'v1','en')`))
      .rejects.toMatchObject({ code: '23514' });
  });
  it('rejects partial lease state on a queued message', async () => {
    await expect(database.pool.query(`INSERT INTO email_tasks(event_key,purpose,recipient,recipient_masked,payload_ciphertext,nonce,auth_tag,key_id,locale,lease_owner)
      VALUES ('partial-lease','email_verify','test@example.test','t***@example.test',decode('ab','hex'),$1,$2,'v1','en',$3)`, [Buffer.alloc(12),Buffer.alloc(16),randomUUID()]))
      .rejects.toMatchObject({ code: '23514' });
  });
  it('does not allow the web role to delete or rewrite audit history', async () => {
    const client = await database.pool.connect();
    try {
      await client.query('SET ROLE honocraft_web');
      await expect(client.query('DELETE FROM audit_events')).rejects.toMatchObject({ code: '42501' });
      await expect(client.query("UPDATE audit_events SET action='forged'")).rejects.toMatchObject({ code: '42501' });
      await expect(client.query("INSERT INTO audit_events(actor_type,action,target_type,result,request_id) VALUES ('anonymous','test.event','test','success',$1)", [randomUUID()])).resolves.toHaveProperty('rowCount', 1);
    } finally { await client.query('RESET ROLE'); client.release(); }
  });
});
