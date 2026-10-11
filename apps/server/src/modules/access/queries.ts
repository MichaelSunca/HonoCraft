import type {Pool} from 'pg';
import {z} from 'zod';
import {AppError} from '@honocraft/contracts/errors';
import {RoleDtoSchema,RoleListSchema,RoleQuerySchema,type RoleDto} from '@honocraft/contracts/roles';
import {permissionDefinitions} from '@honocraft/contracts/permissions';
import {withTransaction} from '../../infrastructure/db.js';
import {authenticateRead,type SessionContext} from '../auth/sessions.js';
import {assertGrantableRoles,assertRoleCopyable,assertRoleEditable,isSuperAdmin,type RoleSnapshot} from './policy.js';

type RoleRow=Omit<RoleDto,'allowed_actions'|'requires_reauth_actions'>&{assigned_to_privileged:boolean};
const projection=`r.id,r.code,r.name,r.description,r.version,r.is_builtin,r.is_delegable,r.is_registration_default_eligible,
  COALESCE((SELECT array_agg(p.code ORDER BY p.code) FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=r.id),'{}') AS permission_codes,
  jsonb_build_object(
    'users',(SELECT count(*) FROM user_roles ur WHERE ur.role_id=r.id),
    'pending_registrations',(SELECT count(*) FROM users u WHERE u.registration_role_id=r.id),
    'registration_defaults',(SELECT count(*) FROM system_settings s WHERE s.registration_default_role_id=r.id),
    'pending_invites',(SELECT count(*) FROM invite_roles ir WHERE ir.role_id=r.id)
  ) AS reference_counts,
  EXISTS(SELECT 1 FROM user_roles ur JOIN user_roles privileged ON privileged.user_id=ur.user_id
    JOIN roles identity_role ON identity_role.id=privileged.role_id
    WHERE ur.role_id=r.id AND identity_role.is_builtin AND identity_role.code IN ('admin','super_admin')) AS assigned_to_privileged`;
function permitted(check:()=>void){try{check();return true;}catch(error){if(!(error instanceof AppError))throw error;return false;}}
function project(context:SessionContext,row:RoleRow):RoleDto{
  const role:RoleSnapshot={id:row.id,code:row.code,isBuiltin:row.is_builtin,isDelegable:row.is_delegable,
    isRegistrationDefaultEligible:row.is_registration_default_eligible,permissionCodes:row.permission_codes,version:row.version};
  const actor=context.actor,superAdmin=isSuperAdmin(actor),reserved=role.permissionCodes.some(code=>permissionDefinitions.find(p=>p.code===code)?.reserved);
  const highInvitation=!role.isDelegable||['admin','super_admin'].includes(role.code)||reserved;
  const allowed:RoleDto['allowed_actions']=[],recent:RoleDto['requires_reauth_actions']=[];
  if(context.permissions.has('invite:manage')&&permitted(()=>assertGrantableRoles(actor,[role]))&&(!highInvitation||(superAdmin&&context.permissions.has('user:manage-privileged')))){
    allowed.push('invite');if(highInvitation)recent.push('invite');
  }
  if(context.permissions.has('role:manage')){
    if(permitted(()=>assertRoleCopyable(actor,role,row.assigned_to_privileged))){allowed.push('copy');if(reserved)recent.push('copy');}
    if(permitted(()=>assertRoleEditable(actor,role,row.assigned_to_privileged))){
      allowed.push('update');if(reserved)recent.push('update');
      if(Object.values(row.reference_counts).every(count=>count===0)){allowed.push('delete');if(reserved)recent.push('delete');}
    }
  }
  if(!role.isBuiltin&&superAdmin&&context.permissions.has('role:delegate')&&context.permissions.has('settings:update-security')){allowed.push('eligibility');recent.push('eligibility');}
  const {assigned_to_privileged:_,...dto}=row;
  return RoleDtoSchema.parse({...dto,allowed_actions:allowed,requires_reauth_actions:recent});
}
export function createRoleQueries(pool:Pool,epoch:string){
  async function authenticate(ref:{token:string}){const context=await authenticateRead(pool,{token:ref.token,epoch});if(!context.permissions.has('role:read'))throw new AppError('FORBIDDEN');return context;}
  async function list(ref:{token:string},raw:unknown){
    const parsed=RoleQuerySchema.safeParse(raw);if(!parsed.success)throw new AppError('VALIDATION_ERROR');const input=parsed.data,context=await authenticate(ref);
    return withTransaction(pool,'read',async tx=>{
      const pattern=input.query?`%${input.query.replace(/[\\%_]/g,'\\$&')}%`:null;
      const parameters=[pattern,input.code??null,input.is_builtin??null];
      const where=`($1::text IS NULL OR r.code ILIKE $1 OR r.name ILIKE $1) AND ($2::text IS NULL OR r.code=$2) AND ($3::boolean IS NULL OR r.is_builtin=$3)`;
      const total=(await tx.query<{total:number}>(`SELECT count(*)::int AS total FROM roles r WHERE ${where}`,parameters)).rows[0]!.total;
      const rows=(await tx.query<RoleRow>(`SELECT ${projection} FROM roles r WHERE ${where} ORDER BY r.code,r.id LIMIT $4 OFFSET $5`,[...parameters,input.page_size,(input.page-1)*input.page_size])).rows;
      return RoleListSchema.parse({items:rows.map(row=>project(context,row)),page:input.page,page_size:input.page_size,total});
    });
  }
  async function get(ref:{token:string},id:unknown){
    const parsed=z.uuid().safeParse(id);if(!parsed.success)throw new AppError('VALIDATION_ERROR');const context=await authenticate(ref);
    return withTransaction(pool,'read',async tx=>{
      const row=(await tx.query<RoleRow>(`SELECT ${projection} FROM roles r WHERE r.id=$1`,[parsed.data])).rows[0];
      if(!row)throw new AppError('NOT_FOUND');return project(context,row);
    });
  }
  return {list,get};
}
