import type { PermissionCode } from '@honocraft/contracts/permissions';
import type { Tx } from '../../infrastructure/db.js';
import type { AccessSnapshot, RoleSnapshot } from './policy.js';

export type UserIdentity = AccessSnapshot & { version: number; passwordVersion: number; displayName: string };
/** No credential material is selected into the request principal. */
export async function loadAccess(tx: Tx, userId: string): Promise<UserIdentity | null> {
  const user = (await tx.query<{
    id: string; status: string; email_verified_at: Date | null; authorization_version: number;
    version: number; password_version: number; display_name: string;
  }>(`SELECT id,status,email_verified_at,authorization_version,version,password_version,display_name FROM users WHERE id=$1`, [userId])).rows[0];
  if (!user) return null;
  const roles = (await tx.query<RoleSnapshot>(`SELECT r.id,r.code,r.is_builtin AS "isBuiltin",r.is_delegable AS "isDelegable",
    r.is_registration_default_eligible AS "isRegistrationDefaultEligible",r.version,
    COALESCE(array_agg(p.code ORDER BY p.code) FILTER (WHERE p.code IS NOT NULL),'{}') AS "permissionCodes"
    FROM user_roles ur JOIN roles r ON r.id=ur.role_id
    LEFT JOIN role_permissions rp ON rp.role_id=r.id LEFT JOIN permissions p ON p.id=rp.permission_id
    WHERE ur.user_id=$1 GROUP BY r.id ORDER BY r.id`, [userId])).rows;
  return {userId:user.id,status:user.status,emailVerified:user.email_verified_at!==null,
    authorizationVersion:user.authorization_version,version:user.version,passwordVersion:user.password_version,
    displayName:user.display_name,roles};
}
export async function registeredPermissionCodes(tx: Tx): Promise<ReadonlySet<PermissionCode>> {
  const rows=(await tx.query<{code:PermissionCode}>(`SELECT p.code FROM permissions p CROSS JOIN system_state s
    WHERE s.id=1 AND (p.module<>'example-note' OR s.example_notes_enabled)`)).rows;
  return new Set(rows.map(row=>row.code));
}
/** Run only after the security coordination lock, before locking any sessions or aggregates. */
export async function lockIdentityRows(tx: Tx, userIds: readonly string[], roleIds: readonly string[] = []): Promise<void> {
  await tx.query('SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[...new Set(userIds)].sort()]);
  await tx.query(`SELECT id FROM roles WHERE id=ANY($1::uuid[]) OR id IN
    (SELECT role_id FROM user_roles WHERE user_id=ANY($2::uuid[])) ORDER BY id FOR SHARE`, [roleIds,userIds]);
}
