import { describe, expect, it } from 'vitest';
import { can, assertManageableTarget, assertGrantableRoles, assertRoleEditable, assertPermissionDependencies, assertRegistrationRole, requireRecentAuthentication, assertSelfManagementAllowed, type RoleSnapshot, type AccessSnapshot } from '../../apps/server/src/modules/access/policy.js';
const userRole: RoleSnapshot = { id: 'user-role', code: 'user', isBuiltin: true, isDelegable: true, isRegistrationDefaultEligible: true, permissionCodes: [], version: 1 };
const managerRole: RoleSnapshot = { ...userRole, id: 'manager-role', code: 'custom_manager', isBuiltin: false, isRegistrationDefaultEligible: false, permissionCodes: ['user:read','user:update','user:assign-role','role:read'] };
const manager: AccessSnapshot = { userId: 'manager', status: 'active', emailVerified: true, authorizationVersion: 1, roles: [managerRole] };
const target: AccessSnapshot = { ...manager, userId: 'target', roles: [userRole] };
const superAdmin: AccessSnapshot = { ...manager, userId: 'super', roles: [{...userRole, id: 'super-role', code: 'super_admin', isDelegable: false}] };

describe('backend authorization policies', () => {
  it('grants ordinary capabilities only from current role permissions', () => {
    expect(can(manager, 'user:update')).toBe(true);
    expect(can(target, 'user:update')).toBe(false);
  });
  it('allows the real super administrator every registered permission but not unknown strings', () => {
    expect(can(superAdmin, 'settings:update-security')).toBe(true);
    expect(can(superAdmin, 'made-up:permission')).toBe(false);
  });
  it('never grants a disabled or unverified actor even when it holds the super role', () => {
    expect(can({ ...superAdmin, status: 'suspended' }, 'user:read')).toBe(false);
    expect(can({ ...superAdmin, emailVerified: false }, 'user:read')).toBe(false);
  });
  it('allows a custom manager to manage an ordinary target', () => {
    expect(() => assertManageableTarget(manager, target)).not.toThrow();
  });
  it.each(['admin','super_admin'])('protects built-in privileged target %s from custom managers', code => {
    expect(() => assertManageableTarget(manager, { ...target, roles: [{ ...userRole, code }] })).toThrow('TARGET_NOT_MANAGEABLE');
  });
  it('checks all current target roles, including an empty nondelegable role', () => {
    expect(() => assertManageableTarget(manager, { ...target, roles: [userRole, { ...userRole, id:'protected', isDelegable:false }] })).toThrow('TARGET_NOT_MANAGEABLE');
  });
  it('prevents taking over a user holding a permission outside the manager scope', () => {
    expect(() => assertManageableTarget(manager, { ...target, roles: [{ ...userRole, permissionCodes: ['audit:read'] }] })).toThrow('TARGET_NOT_MANAGEABLE');
  });
  it('rejects a whole role grant when one member is out of scope', () => {
    expect(() => assertGrantableRoles(manager, [userRole, { ...userRole, permissionCodes: ['settings:update-security'] }])).toThrow('FORBIDDEN');
  });
  it('prevents changing one own custom role or a role assigned to an administrator', () => {
    expect(() => assertRoleEditable(manager, managerRole, false)).toThrow('FORBIDDEN');
    expect(() => assertRoleEditable(manager, { ...managerRole, id:'other' }, true)).toThrow('FORBIDDEN');
  });
  it('rejects editing built-in roles even for super administrators', () => {
    expect(() => assertRoleEditable(superAdmin, userRole, false)).toThrow('FORBIDDEN');
  });
  it('requires the complete dependency closure without silently granting it', () => {
    expect(() => assertPermissionDependencies(['user:assign-role','user:read'])).toThrow('PERMISSION_DEPENDENCY_MISSING');
    expect(() => assertPermissionDependencies(['user:assign-role','user:read','role:read'])).not.toThrow();
  });
  it('rejects management permission injection into registration default roles', () => {
    expect(() => assertRegistrationRole({ ...userRole, permissionCodes:['user:read'] })).toThrow('REGISTRATION_ROLE_INVALID');
    expect(() => assertRegistrationRole({ ...userRole, isRegistrationDefaultEligible:false })).toThrow('REGISTRATION_ROLE_INVALID');
    expect(() => assertRegistrationRole(userRole)).not.toThrow();
  });
  it('requires this session to have authenticated within the half-open five minute window', () => {
    const now = new Date('2026-10-10T00:05:00Z');
    expect(() => requireRecentAuthentication(null, now)).toThrow('REAUTH_REQUIRED');
    expect(() => requireRecentAuthentication(new Date('2026-10-10T00:00:00Z'), now)).toThrow('REAUTH_REQUIRED');
    expect(() => requireRecentAuthentication(new Date('2026-10-10T00:05:01Z'), now)).toThrow('REAUTH_REQUIRED');
    expect(() => requireRecentAuthentication(new Date('2026-10-10T00:00:01Z'), now)).not.toThrow();
  });
  it('does not allow administrative self-demotion or self-disable even for super administrators', () => {
    expect(() => assertSelfManagementAllowed('super','super')).toThrow('SELF_MANAGEMENT_FORBIDDEN');
  });
});
