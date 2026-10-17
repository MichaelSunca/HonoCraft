import {AppError} from '@honocraft/contracts/errors';
import {permissionDefinitions} from '@honocraft/contracts/permissions';
import type {Tx} from '../../infrastructure/db.js';
import type {SessionContext} from '../auth/sessions.js';
import {readRoleSnapshots} from '../auth/credentials.js';
import {loadAccess} from './repository.js';
import {assertManageableTarget,isSuperAdmin,type RoleSnapshot} from './policy.js';
/** Check both recorded and current scope; deleted users retain identity and historical scope. */
export async function assertHistoricalUserScope(tx:Tx,context:SessionContext,id:string,recorded:readonly RoleSnapshot[],forcedHigh=false):Promise<boolean>{
  const target=await loadAccess(tx,id);if(!target)throw new AppError('NOT_FOUND');
  const registration=(await tx.query<{registration_role_id:string|null}>('SELECT registration_role_id FROM users WHERE id=$1',[id])).rows[0]?.registration_role_id;
  if(registration&&!target.roles.some(role=>role.id===registration))target.roles=[...target.roles,...await readRoleSnapshots(tx,[registration])];
  const currentHistorical=await readRoleSnapshots(tx,[...new Set(recorded.map(role=>role.id))]);
  for(const roles of [target.roles,recorded,currentHistorical])assertManageableTarget(context.actor,{...target,roles});
  const high=forcedHigh||[...target.roles,...recorded,...currentHistorical].some(role=>!role.isDelegable||['admin','super_admin'].includes(role.code)||role.permissionCodes.some(code=>permissionDefinitions.find(p=>p.code===code)?.reserved));
  if(high&&(!isSuperAdmin(context.actor)||!context.permissions.has('user:manage-privileged')))throw new AppError('TARGET_NOT_MANAGEABLE');
  return high;
}
