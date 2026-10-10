import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { issueToken } from '../../apps/server/src/infrastructure/crypto.js';

export async function initializedDatabase(pool: Pool) {
  await pool.query("UPDATE system_state SET initialization_status='initialized',initialized_at=clock_timestamp() WHERE id=1");
}
export async function identity(pool: Pool, role = 'user') {
  const userId = randomUUID();
  const email = `${userId}@example.test`;
  await pool.query(`INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at,password_hash,creation_source)
    VALUES ($1,$2,$2,'Test user','active',clock_timestamp(),'test-hash-not-for-login','invitation')`, [userId,email]);
  await pool.query('INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code=$2', [userId,role]);
  return { userId, ...await sessionFor(pool,userId) };
}
export async function sessionFor(pool: Pool, userId: string) {
  const {token,hash} = issueToken();
  const sessionId = randomUUID();
  await pool.query(`INSERT INTO sessions(id,user_id,token_hash,authorization_version,credential_epoch,idle_expires_at,absolute_expires_at,ip)
    SELECT $1,id,$2,authorization_version,'test-epoch',clock_timestamp()+interval '30 minutes',clock_timestamp()+interval '8 hours','127.0.0.1'
    FROM users WHERE id=$3`, [sessionId,hash,userId]);
  return {sessionId,token};
}
