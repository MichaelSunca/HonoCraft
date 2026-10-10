export const PERMISSION_CODES = [
  'user:read','user:update','user:update-email','user:change-status','user:delete','user:reset-password','user:assign-role','user:manage-privileged',
  'invite:read','invite:manage','role:read','role:manage','role:delegate','permission:read','audit:read','security-log:read','email-task:read','settings:read','settings:update-branding','settings:update-security',
  'example-note:read','example-note:create','example-note:update','example-note:delete',
] as const;
export type PermissionCode = typeof PERMISSION_CODES[number];
export type PermissionDefinition = Readonly<{ code: PermissionCode; reserved: boolean; delegable: boolean; selfAssignable: boolean; dependencies: readonly PermissionCode[] }>;
const dependencies: Partial<Record<PermissionCode, readonly PermissionCode[]>> = {
  'user:update':['user:read'], 'user:update-email':['user:read'], 'user:change-status':['user:read'], 'user:delete':['user:read'], 'user:reset-password':['user:read'], 'user:assign-role':['user:read','role:read'],
  'invite:manage':['invite:read','role:read'], 'role:manage':['role:read','permission:read'], 'settings:update-branding':['settings:read'], 'settings:update-security':['settings:read'],
  'example-note:create':['example-note:read'], 'example-note:update':['example-note:read'], 'example-note:delete':['example-note:read'],
};
const reserved = new Set<PermissionCode>(['user:manage-privileged','role:delegate','settings:update-security']);
export const permissionDefinitions: readonly PermissionDefinition[] = Object.freeze(PERMISSION_CODES.map(code => Object.freeze({
  code, reserved: reserved.has(code), delegable: !reserved.has(code), selfAssignable: false, dependencies: Object.freeze(dependencies[code] ?? []),
})));
export function enabledPermissions(exampleNotesEnabled: boolean): readonly PermissionDefinition[] {
  return permissionDefinitions.filter(p => exampleNotesEnabled || !p.code.startsWith('example-note:'));
}
