import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import {AppError} from '@honocraft/contracts/errors';
import {PERMISSION_CODES,permissionDefinitions,type PermissionCode} from '@honocraft/contracts/permissions';
import {UserProfileUpdateSchema,UserStatusUpdateSchema,UserDeleteSchema,UserRolesUpdateSchema,UserProfileResultSchema,UserStatusResultSchema,UserRolesResultSchema,UserPasswordResetSchema,UserPasswordResetResultSchema} from '@honocraft/contracts/users';
import {databaseNow,type Tx} from '../../infrastructure/db.js';
import type {Keyring} from '../../infrastructure/crypto.js';
import {createMutationGateway,defineMutation} from '../access/mutation-gateway.js';
import {assertManageableTarget,assertGrantableRoles,assertPermissionDependencies,assertSelfManagementAllowed,isSuperAdmin,requireRecentAuthentication,type RoleSnapshot} from '../access/policy.js';
import {loadAccess,registeredPermissionCodes,type UserIdentity} from '../access/repository.js';
import {readRoleSnapshots} from '../auth/credentials.js';
import type {SessionContext} from '../auth/sessions.js';
import type {RequestMeta,AuditEvent} from '../audit/writer.js';
import {appendSecurityEvent} from '../audit/security-writer.js';
import {cancelCredentialTasks} from '../mail/cancellation.js';
import {enqueueMail} from '../mail/outbox.js';
import {loadPublicSettings} from '../settings/public.js';
import {issueManagedPasswordReset} from './password-reset-mail.js';
import {assertHistoricalUserScope} from '../access/history.js';

const schemas={profile:UserProfileUpdateSchema,status:UserStatusUpdateSchema,delete:UserDeleteSchema,roles:UserRolesUpdateSchema,reset:UserPasswordResetSchema};
type Kind=keyof typeof schemas;
const InputSchema=z.discriminatedUnion('kind',[
  UserProfileUpdateSchema.extend({kind:z.literal('profile')}),UserStatusUpdateSchema.extend({kind:z.literal('status')}),
  UserDeleteSchema.extend({kind:z.literal('delete')}),UserRolesUpdateSchema.extend({kind:z.literal('roles')}),
  UserPasswordResetSchema.extend({kind:z.literal('reset')}),
]);
type Input=z.infer<typeof InputSchema>;
const RoleSchema=z.strictObject({id:z.uuid(),code:z.string(),isBuiltin:z.boolean(),isDelegable:z.boolean(),isRegistrationDefaultEligible:z.boolean(),permissionCodes:z.array(z.enum(PERMISSION_CODES)),version:z.number().int().positive()});
const StoredPolicy=z.strictObject({id:z.uuid(),role_scope:z.array(RoleSchema),high_risk:z.boolean()});
type Row={id:string;normalized_email:string;email:string;display_name:string;locale:'en'|'zh-CN'|null;status:'pending'|'active'|'suspended'|'deleted';email_verified_at:Date|null;version:number;registration_role_id:string|null;avatar_file_id:string|null;has_password:boolean};
type Target={user:Row;identity:UserIdentity};
type Ref={token:string;csrfToken:string};
type Secrets={epoch:string;csrfKey:Buffer;digestKey:{id:string;key:Buffer};mailKeyring:Keyring};
const permissions:Record<Kind,PermissionCode>={profile:'user:update',status:'user:change-status',delete:'user:delete',roles:'user:assign-role',reset:'user:reset-password'};
const actions={profile:'users.profile.updated',status:'users.status.changed',delete:'users.account.deleted',roles:'users.roles.assigned',reset:'users.password.reset_requested'} as const;
const outcomes={profile:'user_profile_updated',status:'user_status_changed',delete:'user_deleted',roles:'user_roles_assigned',reset:'user_password_reset_requested'} as const;
function highRisk(roles:readonly RoleSnapshot[]){return roles.some(role=>!role.isDelegable||['admin','super_admin'].includes(role.code)||role.permissionCodes.some(code=>permissionDefinitions.find(p=>p.code===code)?.reserved));}
async function targetAt(tx:Tx,id:string):Promise<Target>{
  const user=(await tx.query<Row>('SELECT id,normalized_email,email,display_name,locale,status,email_verified_at,version,registration_role_id,avatar_file_id,(password_hash IS NOT NULL) AS has_password FROM users WHERE id=$1',[id])).rows[0];
  const identity=await loadAccess(tx,id);if(!user||!identity)throw new AppError('NOT_FOUND');
  if(user.registration_role_id&&!identity.roles.some(role=>role.id===user.registration_role_id))identity.roles=[...identity.roles,...await readRoleSnapshots(tx,[user.registration_role_id])];
  return {user,identity};
}
export async function authorizeUserOperationResult(tx:Tx,context:SessionContext,kind:Kind,raw:unknown){
  const stored=StoredPolicy.parse(raw);
  if(kind!=='profile'&&kind!=='reset')assertSelfManagementAllowed(context.actor.userId,stored.id);
  await assertHistoricalUserScope(tx,context,stored.id,stored.role_scope,stored.high_risk);return stored.id;
}
async function confirm(tx:Tx,context:SessionContext,input:Input,target:Target,high:boolean){
  if(high){if(!isSuperAdmin(context.actor)||!context.permissions.has('user:manage-privileged'))throw new AppError('TARGET_NOT_MANAGEABLE');requireRecentAuthentication(context.reauthenticatedAt,await databaseNow(tx));}
  const value=input.confirmation;
  if(!value){if(high||input.kind!=='profile')throw new AppError('VALIDATION_ERROR');return;}
  if(value.target_id!==target.user.id||((high||input.kind==='delete')&&value.typed_label!==target.user.normalized_email))throw new AppError('VALIDATION_ERROR');
}
async function keepSuperAdmin(tx:Tx,target:Target,input:Input,proposed:RoleSnapshot[]){
  const shrinking=target.user.status==='active'&&target.user.email_verified_at&&isSuperAdmin(target.identity)&&
    (input.kind==='delete'||(input.kind==='status'&&input.action==='suspend')||(input.kind==='roles'&&!proposed.some(role=>role.isBuiltin&&role.code==='super_admin')));
  if(!shrinking)return;
  const remaining=(await tx.query<{total:number}>(`SELECT count(*)::int AS total FROM users u WHERE u.id<>$1 AND u.status='active'
    AND u.email_verified_at IS NOT NULL AND u.password_hash IS NOT NULL AND EXISTS(
      SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id AND r.is_builtin AND r.code='super_admin')`,[target.user.id])).rows[0]!.total;
  if(remaining<1)throw new AppError('LAST_SUPER_ADMIN_REQUIRED');
}
async function revokeAccess(tx:Tx,target:Target,deleting:boolean){
  const id=target.user.id;
  const invites=(await tx.query<{id:string}>(`SELECT id FROM invites WHERE status='pending' AND
    (inviter_id=$1 OR ($2::boolean AND normalized_email=$3)) ORDER BY id FOR UPDATE`,[id,deleting,target.user.normalized_email])).rows.map(row=>row.id);
  await tx.query("SELECT id FROM email_change_requests WHERE user_id=$1 AND status='pending' ORDER BY id FOR UPDATE",[id]);
  await tx.query('SELECT id FROM one_time_credentials WHERE user_id=$1 OR invite_id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',[id,invites]);
  const credentials=(await tx.query<{id:string}>(`UPDATE one_time_credentials SET revoked_at=clock_timestamp()
    WHERE (user_id=$1 OR invite_id=ANY($2::uuid[])) AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id`,[id,invites])).rows.map(row=>row.id);
  await tx.query("UPDATE email_change_requests SET status='cancelled',version=version+1,terminal_reason='USER_STATE_CHANGED',updated_at=clock_timestamp() WHERE user_id=$1 AND status='pending'",[id]);
  await tx.query("UPDATE invites SET status='revoked',version=version+1,terminal_reason='INVITER_STATE_CHANGED',updated_at=clock_timestamp() WHERE id=ANY($1::uuid[])",[invites]);
  await tx.query('UPDATE invite_roles SET role_id=NULL WHERE invite_id=ANY($1::uuid[])',[invites]);
  await cancelCredentialTasks(tx,credentials,'USER_STATE_CHANGED');
}
export function createUserManagement(pool:Pool,secrets:Secrets){
  function definition(kind:Kind,meta:RequestMeta){
    let before:Target,proposed:RoleSnapshot[]=[],historical:RoleSnapshot[]=[],high=false;
    return defineMutation({input:InputSchema,output:z.union([UserProfileResultSchema,UserStatusResultSchema,UserRolesResultSchema,UserPasswordResetResultSchema]),mode:kind==='profile'?'shared':'exclusive',permission:permissions[kind],recentAuth:false,auditAction:actions[kind],
      resolveLocks:async(tx,input)=>{
        const registration=(await tx.query<{registration_role_id:string|null}>('SELECT registration_role_id FROM users WHERE id=$1',[input.id])).rows[0]?.registration_role_id;
        const sessions=input.kind==='profile'||input.kind==='reset'?undefined:(await tx.query<{id:string}>('SELECT id FROM sessions WHERE user_id=$1 ORDER BY id',[input.id])).rows.map(row=>row.id);
        return {userIds:[input.id],roleIds:[...(input.kind==='roles'?input.role_ids:[]),...(registration?[registration]:[])],...(sessions?{sessionIds:sessions}:{})};
      },
      authorize:async(tx,context,input)=>{
        proposed=[];historical=[];high=false;
        if(input.kind!=='profile'&&input.kind!=='reset')assertSelfManagementAllowed(context.actor.userId,input.id);
        before=await targetAt(tx,input.id);assertManageableTarget(context.actor,before.identity);
        if(input.kind==='roles'){
          proposed=await readRoleSnapshots(tx,input.role_ids);if(proposed.length!==input.role_ids.length)throw new AppError('VALIDATION_ERROR');
          assertGrantableRoles(context.actor,proposed);const enabled=await registeredPermissionCodes(tx);
          for(const role of proposed){if(role.permissionCodes.some(code=>!enabled.has(code)))throw new AppError('VALIDATION_ERROR');assertPermissionDependencies(role.permissionCodes);}
        }
        historical=[...before.identity.roles,...proposed];high=highRisk(historical);await confirm(tx,context,input,before,high);
        if(before.user.version!==input.expected_version)throw new AppError('VERSION_CONFLICT');
        if(before.user.status==='deleted'||(input.kind==='roles'&&before.user.status!=='active')||(input.kind==='reset'&&(before.user.status!=='active'||!before.user.email_verified_at||!before.user.has_password))||
          (input.kind==='status'&&((input.action==='enable'&&before.user.status!=='suspended')||(input.action==='suspend'&&!['pending','active'].includes(before.user.status)))))throw new AppError('VALIDATION_ERROR');
        await keepSuperAdmin(tx,before,input,proposed);
      },
      execute:async(tx,context,input)=>{
        const id=input.id,version=before.user.version+1;
        if(input.kind==='reset'){
          await issueManagedPasswordReset(tx,before.user,before.identity.authorizationVersion,secrets,meta);
          return {data:{accepted:true as const},status:202,audit:{target:{type:'user',id},reason:input.confirmation.reason,changes:{before_version:before.user.version,after_version:before.user.version,affected_count:1}}};
        }
        if(input.kind==='profile'){
          await tx.query('UPDATE users SET display_name=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1',[id,input.display_name]);
          return {data:{id,display_name:input.display_name,version},audit:{target:{type:'user',id},changes:{before_version:before.user.version,after_version:version,changed_fields:['display_name' as const]},...(input.confirmation?{reason:input.confirmation.reason}:{})}};
        }
        await tx.query("UPDATE sessions SET revoked_at=clock_timestamp(),revoked_reason=$2 WHERE user_id=$1 AND revoked_at IS NULL",[id,input.kind==='roles'?'roles_changed':'user_state_changed']);
        let status=before.user.status;
        if(input.kind==='roles'){
          await tx.query('DELETE FROM user_roles WHERE user_id=$1',[id]);
          await tx.query('INSERT INTO user_roles(user_id,role_id,assigned_by) SELECT $1,unnest($2::uuid[]),$3',[id,input.role_ids,context.actor.userId]);
        }else if(input.kind==='delete'||input.action==='suspend'){
          await revokeAccess(tx,before,input.kind==='delete');status=input.kind==='delete'?'deleted':'suspended';
          if(input.kind==='delete'){
            await tx.query('DELETE FROM user_roles WHERE user_id=$1',[id]);
            await tx.query("UPDATE file_objects SET state='orphaned',updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 AND purpose='avatar' AND state='attached'",[before.user.avatar_file_id,id]);
          }else{
            const settings=await loadPublicSettings(tx);
            await enqueueMail(tx,secrets.mailKeyring,{eventId:randomUUID(),purpose:'account_suspended',recipient:before.user.email,displayName:before.user.display_name,instanceName:settings.instance_name,locale:before.user.locale??settings.default_locale,timeZone:settings.timezone,occurredAt:context.now.toISOString()});
          }
        }else status=before.user.email_verified_at?'active':'pending';
        await tx.query(`UPDATE users SET status=$2,version=version+1,authorization_version=authorization_version+1,updated_at=clock_timestamp(),
          deleted_at=CASE WHEN $2='deleted' THEN clock_timestamp() ELSE deleted_at END,
          registration_role_id=CASE WHEN $2='deleted' THEN NULL ELSE registration_role_id END,
          avatar_file_id=CASE WHEN $2='deleted' THEN NULL ELSE avatar_file_id END WHERE id=$1`,[id,status]);
        await appendSecurityEvent(tx,{userId:id,type:input.kind==='roles'?'users.roles_changed':'users.state_changed',result:'success',reasonCode:null,targetDigest:null,meta});
        const changes:AuditEvent['changes']={before_version:before.user.version,after_version:version,
          ...(input.kind==='roles'?{role_ids_before:before.identity.roles.map(role=>role.id),role_ids_after:input.role_ids,changed_fields:['roles' as const]}:{status_before:before.user.status,status_after:status,changed_fields:['status' as const]})};
        return {data:input.kind==='roles'?{id,role_ids:input.role_ids,version,login_required:true as const}:{id,status,version},audit:{target:{type:'user',id},reason:input.confirmation.reason,changes}};
      },
      idempotency:{policySchema:StoredPolicy,
        authorizeStored:async(tx,context,input,stored)=>{
          if(stored.id!==input.id)throw new AppError('FORBIDDEN');
          if(input.kind!=='profile'&&input.kind!=='reset')assertSelfManagementAllowed(context.actor.userId,input.id);
          const current=await targetAt(tx,input.id),historicalHigh=await assertHistoricalUserScope(tx,context,input.id,stored.role_scope,stored.high_risk);
          await confirm(tx,context,input,current,historicalHigh);
        },
        summarize:(data,context)=>({outcome:outcomes[kind],resource_id:'id' in data?data.id:before.user.id,version:'version' in data?data.version:before.user.version,completed_at:context.now.toISOString()}),
        policyContext:data=>({id:'id' in data?data.id:before.user.id,role_scope:historical.map(role=>({...role,permissionCodes:[...role.permissionCodes]})),high_risk:high}),
      },
    });
  }
  async function run(kind:Kind,ref:Ref,raw:unknown,meta:RequestMeta,key?:string,budget?:number){
    const parsed=schemas[kind].safeParse(raw);if(!parsed.success)throw new AppError('VALIDATION_ERROR');
    return createMutationGateway(pool,secrets,{[`users.${kind}`]:definition(kind,meta)})(`users.${kind}`,ref,{...parsed.data,kind},meta,key,budget);
  }
  return {
    profile:(ref:Ref,input:unknown,meta:RequestMeta,key?:string,budget?:number)=>run('profile',ref,input,meta,key,budget),
    status:(ref:Ref,input:unknown,meta:RequestMeta,key?:string,budget?:number)=>run('status',ref,input,meta,key,budget),
    delete:(ref:Ref,input:unknown,meta:RequestMeta,key?:string,budget?:number)=>run('delete',ref,input,meta,key,budget),
    roles:(ref:Ref,input:unknown,meta:RequestMeta,key?:string,budget?:number)=>run('roles',ref,input,meta,key,budget),
    reset:(ref:Ref,input:unknown,meta:RequestMeta,key?:string,budget?:number)=>run('reset',ref,input,meta,key,budget),
  };
}
