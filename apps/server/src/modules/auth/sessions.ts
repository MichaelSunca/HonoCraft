import type { Pool } from 'pg';
import { AppError } from '@honocraft/contracts/errors';
import { permissionDefinitions, type PermissionCode } from '@honocraft/contracts/permissions';
import { tokenDigest } from '../../infrastructure/crypto.js';
import { databaseNow, withTransaction, type Tx } from '../../infrastructure/db.js';
import { effectivePermissions } from '../access/policy.js';
import { loadAccess, registeredPermissionCodes, type UserIdentity } from '../access/repository.js';

export type SessionRef = Readonly<{token: string; epoch: string}>;
export type SessionLocator = Readonly<{id:string; userId:string}>;
export type SessionContext = Readonly<{
  actor: UserIdentity; sessionId: string; now: Date; reauthenticatedAt: Date | null;
  permissions: ReadonlySet<PermissionCode>;
}>;
type SessionRow = {
  id:string; user_id:string; authorization_version:number; credential_epoch:string;
  created_at:Date; last_seen_at:Date; idle_expires_at:Date; absolute_expires_at:Date;
  reauthenticated_at:Date|null; revoked_at:Date|null;
};
export async function locateSession(tx: Tx, token: string): Promise<SessionLocator> {
  let hash: Buffer;
  try { hash=tokenDigest(token); } catch { throw new AppError('SESSION_INVALID'); }
  const row=(await tx.query<{id:string;user_id:string}>('SELECT id,user_id FROM sessions WHERE token_hash=$1',[hash])).rows[0];
  if (!row) throw new AppError('SESSION_INVALID');
  return {id:row.id,userId:row.user_id};
}
/** The write gateway locks users/roles first; read authentication never takes those locks. */
export async function authenticateLockedSession(tx: Tx, locator: SessionLocator, epoch: string): Promise<SessionContext> {
  const session=(await tx.query<SessionRow>(`SELECT id,user_id,authorization_version,credential_epoch,created_at,last_seen_at,
    idle_expires_at,absolute_expires_at,reauthenticated_at,revoked_at FROM sessions WHERE id=$1 AND user_id=$2 FOR UPDATE`,[locator.id,locator.userId])).rows[0];
  if (!session) throw new AppError('SESSION_INVALID');
  const now=await databaseNow(tx);
  const state=(await tx.query<{initialization_status:string}>("SELECT initialization_status FROM system_state WHERE id=1")).rows[0];
  if (state?.initialization_status!=='initialized') throw new AppError('SYSTEM_NOT_INITIALIZED');
  const actor=await loadAccess(tx,locator.userId);
  if (!actor || actor.status!=='active' || !actor.emailVerified || session.revoked_at ||
      session.authorization_version!==actor.authorizationVersion || session.credential_epoch!==epoch) throw new AppError('SESSION_INVALID');
  const policy=(await tx.query<{typed_value:Record<string,unknown>}>("SELECT typed_value FROM system_settings WHERE key='security'")).rows[0]?.typed_value;
  const idle=policy?.session_idle_minutes;
  const absolute=policy?.session_absolute_minutes;
  if (typeof idle!=='number' || !Number.isSafeInteger(idle) || idle<=0 || typeof absolute!=='number' || !Number.isSafeInteger(absolute) || absolute<=0) throw new AppError('DEPENDENCY_UNAVAILABLE');
  const absoluteDeadline=Math.min(session.absolute_expires_at.getTime(),session.created_at.getTime()+absolute*60_000);
  const idleDeadline=Math.min(session.idle_expires_at.getTime(),session.last_seen_at.getTime()+idle*60_000);
  if (now.getTime()>=absoluteDeadline || now.getTime()>=idleDeadline || now<session.last_seen_at) throw new AppError('SESSION_INVALID');
  const codes=await registeredPermissionCodes(tx);
  const permissions=effectivePermissions(actor,permissionDefinitions.filter(p=>codes.has(p.code)));
  await tx.query('UPDATE sessions SET last_seen_at=$2,idle_expires_at=$3,absolute_expires_at=$4 WHERE id=$1',
    [session.id,now,new Date(Math.min(now.getTime()+idle*60_000,absoluteDeadline)),new Date(absoluteDeadline)]);
  return {actor,sessionId:session.id,permissions,now,reauthenticatedAt:session.reauthenticated_at};
}
export async function authenticateRead(pool: Pool, ref: SessionRef): Promise<SessionContext> {
  return withTransaction(pool,'independent',async tx=>authenticateLockedSession(tx,await locateSession(tx,ref.token),ref.epoch));
}
