import pg, { type Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

export type LockMode = 'shared' | 'exclusive' | 'read' | 'independent';
export type Tx = Readonly<{
  query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>>;
}>;
export function createDatabase(connectionString: string, max = 10) {
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000, application_name: 'honocraft' });
  const disconnects=new Set<Promise<void>>();
  pool.on('connect',client=>{
    const ended=new Promise<void>(resolve=>client.once('end',resolve));
    disconnects.add(ended);void ended.then(()=>disconnects.delete(ended));
  });
  pool.on('error', () => { console.error('Database idle connection failed'); });
  return { pool, orm: drizzle(pool), close: async () => {
    await pool.end();
    // Keep the process shutdown deadline active until sockets, not just pool entries, are gone.
    await Promise.all([...disconnects]);
  } };
}
export type Database = ReturnType<typeof createDatabase>;

/** Independent mode is only for short session-read, rate-limit, failure-event, queue and file-cleanup transactions.
 * Fixed retention batches also use independent mode; expiry functions acquire coordination inside PostgreSQL.
 * Protected business writes must use shared or exclusive.
 * No password hashing, SMTP, image conversion or other external work belongs inside this callback. */
export async function withTransaction<T>(pool: Pool, mode: LockMode, handler: (tx: Tx) => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  let broken: Error | undefined;
  const onError = (error: Error) => { broken = error; };
  client.on('error', onError);
  try {
    await client.query(mode === 'read' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'; SET LOCAL transaction_timeout='8s'; SET LOCAL idle_in_transaction_session_timeout='8s'");
    if (mode === 'shared' || mode === 'exclusive') {
      const result = await client.query(`SELECT id FROM system_state WHERE id=1 FOR ${mode === 'shared' ? 'SHARE' : 'UPDATE'}`);
      if (result.rowCount !== 1) throw new Error('SYSTEM_STATE_MISSING');
    }
    const tx: Tx = Object.freeze({ query: <Row extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]) => client.query<Row>(text, values ? [...values] : undefined) });
    const result = await handler(tx);
    if (broken) throw broken;
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) { broken = rollbackError instanceof Error ? rollbackError : new Error('Rollback failed'); }
    throw error;
  } finally {
    client.off('error', onError);
    client.release(broken);
  }
}

/** Call after acquiring subject locks; transaction_timestamp() is not the current wall clock. */
export async function databaseNow(tx: Tx): Promise<Date> {
  const result = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  const row = result.rows[0];
  if (!row) throw new Error('DATABASE_TIME_UNAVAILABLE');
  return row.now;
}
