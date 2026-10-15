import type {Pool} from 'pg';
import {z} from 'zod';
import {AppError} from '@honocraft/contracts/errors';
import {UserQuerySchema,UserListSchema,UserListItemSchema,UserDetailSchema,type UserAction} from '@honocraft/contracts/users';
import {permissionDefinitions,type PermissionCode} from '@honocraft/contracts/permissions';
import {databaseNow,withTransaction,type Tx} from '../../infrastructure/db.js';
import {authenticateRead,type SessionContext} from '../auth/sessions.js';
import {readRoleSnapshots} from '../auth/credentials.js';
import {assertManageableTarget,isSuperAdmin,type RoleSnapshot} from '../access/policy.js';

type Row={id:string;email:string;display_name:string;status:'pending'|'active'|'suspended'|'deleted';creation_source:string;registration_role_id:string|null;
  avatar_url:string|null;version:number;email_verified_at:Date|null;created_at:Date;updated_at:Date;last_login_at:Date|null;
  roles:Array<{id:string;code:string;name:string}>};
type Pending={id:string;user_id:string;requested_by:string;version:number;new_email:string;expires_at:Date};
const projection=`u.id,u.email,u.display_name,u.status,u.creation_source,u.registration_role_id,u.version,u.email_verified_at,u.created_at,u.updated_at,u.last_login_at,
  CASE WHEN u.avatar_file_id IS NULL THEN NULL ELSE '/api/v1/media/avatars/'||u.avatar_file_id::text END AS avatar_url,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'code',r.code,'name',r.name) ORDER BY r.code,r.id)
    FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id),'[]'::jsonb) AS roles`;
function scope(context:SessionContext,row:Row,roles:RoleSnapshot[]){
  const high=roles.some(role=>!role.isDelegable||['admin','super_admin'].includes(role.code)||role.permissionCodes.some(code=>permissionDefinitions.find(p=>p.code===code)?.reserved));
  let manageable=true;
  try{assertManageableTarget(context.actor,{userId:row.id,status:row.status,emailVerified:row.email_verified_at!==null,authorizationVersion:0,roles});}
  catch(error){if(!(error instanceof AppError))throw error;manageable=false;}
  if(high&&(!isSuperAdmin(context.actor)||!context.permissions.has('user:manage-privileged')))manageable=false;
  return {high,manageable};
}
async function project(tx:Tx,context:SessionContext,rows:Row[],detail:boolean){
  const roles=await readRoleSnapshots(tx,[...new Set(rows.flatMap(row=>[...row.roles.map(role=>role.id),...(row.registration_role_id?[row.registration_role_id]:[])]))]);
  const pending=detail?(await tx.query<Pending>(`SELECT id,user_id,requested_by,version,new_email,expires_at FROM email_change_requests
    WHERE user_id=ANY($1::uuid[]) AND status='pending' AND expires_at>$2`,[rows.map(row=>row.id),await databaseNow(tx)])).rows:[];
  return rows.map(row=>{
    const snapshots=roles.filter(role=>row.roles.some(assigned=>assigned.id===role.id)||role.id===row.registration_role_id);
    const {high,manageable}=scope(context,row,snapshots),self=row.id===context.actor.userId,visible=self||manageable;
    const actions:UserAction[]=[],recent:UserAction[]=[];
    const add=(action:UserAction,permission:PermissionCode,eligible=true,alwaysRecent=false)=>{if(manageable&&eligible&&context.permissions.has(permission)){actions.push(action);if(high||alwaysRecent)recent.push(action);}};
    if(row.status!=='deleted'){
      add('update','user:update');
      add('suspend','user:change-status',!self&&(row.status==='active'||row.status==='pending'));
      add('enable','user:change-status',!self&&row.status==='suspended');
      add('delete','user:delete',!self);
      add('reset-password','user:reset-password',row.status==='active');
      add('change-email','user:update-email',row.status==='active'||(row.status==='pending'&&row.creation_source==='registration'),true);
      add('assign-roles','user:assign-role',!self&&row.status==='active');
    }
    const request=pending.find(request=>request.user_id===row.id);
    const visibleRequest=request&&(self||(manageable&&context.permissions.has('user:update-email')&&request.requested_by===context.actor.userId))?request:null;
    if(visibleRequest&&row.status!=='deleted'&&row.status!=='suspended'&&visibleRequest.requested_by===context.actor.userId)add('cancel-email-change','user:update-email');
    const dto=UserListItemSchema.parse({id:row.id,display_name:row.display_name,email:visible?row.email:null,masked_email:visible?null:maskEmail(row.email),email_visibility:visible?'full':'masked',
      avatar_url:row.id===context.actor.userId||manageable?row.avatar_url:null,roles:row.roles,status:row.status,created_at:row.created_at.toISOString(),last_login_at:row.last_login_at?.toISOString()??null,version:row.version,allowed_actions:actions,requires_reauth_actions:recent,requires_typed_confirmation_actions:actions.filter(action=>high||action==='delete')});
    return detail?UserDetailSchema.parse({...dto,verified:row.email_verified_at!==null,updated_at:row.updated_at.toISOString(),can_read_audit:context.permissions.has('audit:read'),
      pending_email_change:visibleRequest?{id:visibleRequest.id,version:visibleRequest.version,new_email:visibleRequest.new_email,expires_at:visibleRequest.expires_at.toISOString()}:null}):dto;
  });
}
function maskEmail(email:string){const at=email.lastIndexOf('@');return email.slice(0,1)+'***'+email.slice(at);}
export function createUserQueries(pool:Pool,epoch:string){
  async function authenticate(ref:{token:string}){const context=await authenticateRead(pool,{token:ref.token,epoch});if(!context.permissions.has('user:read'))throw new AppError('FORBIDDEN');return context;}
  async function list(ref:{token:string},raw:unknown){
    const context=await authenticate(ref),parsed=UserQuerySchema.safeParse(raw);if(!parsed.success)throw new AppError('VALIDATION_ERROR');const input=parsed.data;
    return withTransaction(pool,'read',async tx=>{
      const pattern=input.query?`%${input.query.replace(/[\\%_]/g,'\\$&')}%`:null;
      const parameters=[pattern,input.status??null,input.role_id??null,input.created_from??null,input.created_to??null,
        context.actor.userId,isSuperAdmin(context.actor)&&context.permissions.has('user:manage-privileged'),[...context.permissions]];
      // Filtering and sorting must not turn masked email fields into an oracle. This predicate
      // mirrors the full role scope check, including a pending registration's reserved role.
      const source=`WITH visible_users AS (SELECT u.*,CASE WHEN u.id=$6::uuid OR $7::boolean OR NOT EXISTS(
        SELECT 1 FROM roles r WHERE (r.id=u.registration_role_id OR EXISTS(SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id AND ur.role_id=r.id))
        AND (NOT r.is_delegable OR r.code IN ('admin','super_admin') OR EXISTS(
          SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=r.id
          AND (NOT p.is_delegable OR p.is_reserved OR NOT (p.code=ANY($8::text[]))))))
        THEN u.email ELSE left(u.email,1)||'***@'||split_part(u.email,'@',2) END AS visible_email FROM users u)`;
      const where=`($1::text IS NULL OR u.display_name ILIKE $1 OR u.visible_email ILIKE $1)
        AND (($2::text IS NULL AND u.status<>'deleted') OR u.status=$2)
        AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id AND ur.role_id=$3))
        AND ($4::timestamptz IS NULL OR u.created_at>=$4) AND ($5::timestamptz IS NULL OR u.created_at<$5)`;
      const total=(await tx.query<{total:number}>(`${source} SELECT count(*)::int AS total FROM visible_users u WHERE ${where}`,parameters)).rows[0]!.total;
      // Sort identifiers are strict enums; count and rows share the same repeatable-read snapshot.
      const sort=input.sort==='email'?'visible_email':input.sort;
      const rows=(await tx.query<Row>(`${source} SELECT ${projection} FROM visible_users u WHERE ${where} ORDER BY u.${sort} ${input.direction},u.id ${input.direction} LIMIT $9 OFFSET $10`,[...parameters,input.page_size,(input.page-1)*input.page_size])).rows;
      return UserListSchema.parse({items:await project(tx,context,rows,false),page:input.page,page_size:input.page_size,total});
    });
  }
  async function get(ref:{token:string},id:unknown){
    const context=await authenticate(ref),parsed=z.uuid().safeParse(id);if(!parsed.success)throw new AppError('VALIDATION_ERROR');
    return withTransaction(pool,'read',async tx=>{
      const row=(await tx.query<Row>(`SELECT ${projection} FROM users u WHERE u.id=$1`,[parsed.data])).rows[0];if(!row)throw new AppError('NOT_FOUND');
      return UserDetailSchema.parse((await project(tx,context,[row],true))[0]);
    });
  }
  return {list,get};
}
