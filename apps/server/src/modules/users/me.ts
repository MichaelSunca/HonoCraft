import type { Pool } from 'pg';
import {loadPublicSettings} from '../settings/public.js';
import { withTransaction } from '../../infrastructure/db.js';
import { csrfForSession } from '../../infrastructure/crypto.js';
import { authenticateLockedSession,locateSession, type SessionRef } from '../auth/sessions.js';

export async function getMe(pool:Pool,ref:SessionRef,csrfKey:Buffer) {
  return withTransaction(pool,'independent',async tx=>{
    const context=await authenticateLockedSession(tx,await locateSession(tx,ref.token),ref.epoch);
    const user=(await tx.query<{id:string;email:string;display_name:string;status:string;email_verified_at:Date;avatar_url:string|null;locale:string|null;theme:string|null;version:number}>(`SELECT id,email,display_name,status,email_verified_at,
      CASE WHEN avatar_file_id IS NULL THEN NULL ELSE '/api/v1/media/avatars/'||avatar_file_id::text END AS avatar_url,locale,theme,version
      FROM users WHERE id=$1`,[context.actor.userId])).rows[0]!;
    const roles=(await tx.query<{id:string;code:string;name:string}>(`SELECT r.id,r.code,r.name FROM roles r JOIN user_roles ur ON ur.role_id=r.id WHERE ur.user_id=$1 ORDER BY r.code`,[user.id])).rows;
    const session=(await tx.query<{absolute_expires_at:Date}>('SELECT absolute_expires_at FROM sessions WHERE id=$1',[context.sessionId])).rows[0]!;
    const pending=(await tx.query(`SELECT id,version,new_email,expires_at FROM email_change_requests
      WHERE user_id=$1 AND status='pending' AND expires_at>$2`,[user.id,context.now])).rows[0]??null;
    return {user,roles,instance:await loadPublicSettings(tx),permission_codes:[...context.permissions].sort(),csrf_token:csrfForSession(csrfKey,context.sessionId,ref.epoch),
      session:{id:context.sessionId,reauthenticated_at:context.reauthenticatedAt,absolute_expires_at:session.absolute_expires_at},pending_email_change:pending};
  });
}
