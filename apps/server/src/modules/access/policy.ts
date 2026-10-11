import { AppError } from '@honocraft/contracts/errors';
import { permissionDefinitions, type PermissionCode, type PermissionDefinition } from '@honocraft/contracts/permissions';
export type RoleSnapshot = { id: string; code: string; isBuiltin: boolean; isDelegable: boolean; isRegistrationDefaultEligible: boolean; permissionCodes: readonly PermissionCode[]; version: number };
export type AccessSnapshot = { userId: string; status: string; emailVerified: boolean; authorizationVersion: number; roles: readonly RoleSnapshot[] };

export function isSuperAdmin(actor: AccessSnapshot): boolean {
  return actor.roles.some(role => role.isBuiltin && role.code === 'super_admin');
}
function isActive(actor: AccessSnapshot): boolean { return actor.status === 'active' && actor.emailVerified; }
function assertActive(actor: AccessSnapshot): void { if (!isActive(actor)) throw new AppError('SESSION_INVALID'); }
export function effectivePermissions(actor: AccessSnapshot, catalog: readonly PermissionDefinition[] = permissionDefinitions): ReadonlySet<PermissionCode> {
  if (!isActive(actor)) return new Set();
  const registered = new Set(catalog.map(item => item.code));
  if (isSuperAdmin(actor)) return registered;
  return new Set(actor.roles.flatMap(role => role.permissionCodes).filter(code => registered.has(code)));
}
export function can(actor: AccessSnapshot, code: string, catalog: readonly PermissionDefinition[] = permissionDefinitions): boolean {
  return effectivePermissions(actor, catalog).has(code as PermissionCode);
}
export function assertPermission(actor: AccessSnapshot, code: PermissionCode): void {
  assertActive(actor);
  if (!can(actor, code)) throw new AppError('FORBIDDEN');
}
function roleInDelegableScope(actor: AccessSnapshot, role: RoleSnapshot): boolean {
  const owned = effectivePermissions(actor);
  return role.isDelegable && !['admin','super_admin'].includes(role.code) && role.permissionCodes.every(code => {
    const definition = permissionDefinitions.find(item => item.code === code);
    return definition?.delegable === true && !definition.reserved && owned.has(code);
  });
}
export function assertManageableTarget(actor: AccessSnapshot, target: AccessSnapshot): void {
  assertActive(actor);
  if (isSuperAdmin(actor)) return;
  if (!target.roles.every(role => roleInDelegableScope(actor, role))) throw new AppError('TARGET_NOT_MANAGEABLE');
}
export function assertGrantableRoles(actor: AccessSnapshot, roles: readonly RoleSnapshot[]): void {
  assertActive(actor);
  if (isSuperAdmin(actor)) return;
  if (!roles.every(role => roleInDelegableScope(actor, role))) throw new AppError('FORBIDDEN');
}
export function assertRoleEditable(actor: AccessSnapshot, role: RoleSnapshot, assignedToPrivileged: boolean): void {
  assertActive(actor);
  if (role.isBuiltin) throw new AppError('FORBIDDEN');
  assertRoleCopyable(actor,role,assignedToPrivileged);
}
export function assertRoleCopyable(actor: AccessSnapshot, role: RoleSnapshot, assignedToPrivileged: boolean): void {
  assertActive(actor);
  if (isSuperAdmin(actor)) return;
  if (assignedToPrivileged || actor.roles.some(own => own.id === role.id) || !roleInDelegableScope(actor, role)) throw new AppError('FORBIDDEN');
}
export function assertPermissionDependencies(codes: readonly PermissionCode[]): void {
  const selected = new Set(codes);
  for (const code of codes) {
    const definition = permissionDefinitions.find(item => item.code === code);
    if (!definition) throw new AppError('VALIDATION_ERROR');
    if (definition.dependencies.some(dependency => !selected.has(dependency))) throw new AppError('PERMISSION_DEPENDENCY_MISSING');
  }
}
export function assertRegistrationRole(role: RoleSnapshot): void {
  if (!role.isRegistrationDefaultEligible || ['admin','super_admin'].includes(role.code) || role.permissionCodes.some(code => !permissionDefinitions.find(item => item.code === code)?.selfAssignable)) throw new AppError('REGISTRATION_ROLE_INVALID');
  assertPermissionDependencies(role.permissionCodes);
}
export function requireRecentAuthentication(at: Date | null, now: Date): void {
  const age = at ? now.getTime() - at.getTime() : Number.NaN;
  if (!Number.isFinite(age) || age < 0 || age >= 300_000) throw new AppError('REAUTH_REQUIRED');
}
export function assertSelfManagementAllowed(actorId: string, targetId: string): void {
  if (actorId === targetId) throw new AppError('SELF_MANAGEMENT_FORBIDDEN');
}
