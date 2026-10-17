import {z} from 'zod';
import {AppError} from '@honocraft/contracts/errors';
import type {OperationName} from '@honocraft/contracts/operations';
import type {PermissionCode} from '@honocraft/contracts/permissions';
import type {Tx} from '../../infrastructure/db.js';
import type {SessionContext} from '../auth/sessions.js';
import {isSuperAdmin} from '../access/policy.js';
import {authorizeRoleOperationResult} from '../access/role-management.js';
import {authorizeUserOperationResult} from '../users/management.js';
import {authorizeEmailOperationResult} from '../users/email-change.js';
import {authorizeInvitationOperationResult} from '../invitations/management.js';
type Binding={targetId:string|null;resourceId:string|null};
type Policy={permissions:readonly PermissionCode[];outcome:string;targetType:string;authorize:(tx:Tx,context:SessionContext,raw:unknown)=>Promise<Binding>};
const entity=(id:string):Binding=>({targetId:id,resourceId:id});
const owner=z.strictObject({user_id:z.uuid()});
const ownUser:Policy['authorize']=async(_tx,context,raw)=>{const stored=owner.parse(raw);if(stored.user_id!==context.actor.userId)throw new AppError('NOT_FOUND');return entity(stored.user_id);};
function user(kind:Parameters<typeof authorizeUserOperationResult>[2],permission:PermissionCode,outcome:string):Policy{return {permissions:[permission,'user:read'],outcome,targetType:'user',authorize:async(tx,context,raw)=>entity(await authorizeUserOperationResult(tx,context,kind,raw))};}
function role(kind:Parameters<typeof authorizeRoleOperationResult>[2],outcome:string):Policy{return {permissions:['role:manage','role:read'],outcome,targetType:'role',authorize:async(tx,context,raw)=>entity(await authorizeRoleOperationResult(tx,context,kind,raw))};}
function invitation(outcome:string):Policy{return {permissions:['invite:manage','invite:read'],outcome,targetType:'invite',authorize:async(tx,context,raw)=>entity(await authorizeInvitationOperationResult(tx,context,raw))};}
function email(kind:Parameters<typeof authorizeEmailOperationResult>[2]):Policy{return {permissions:kind.startsWith('admin')?['user:update-email','user:read']:[],outcome:kind.endsWith('start')?'email_change_requested':'email_change_cancelled',targetType:'user',authorize:(tx,context,raw)=>authorizeEmailOperationResult(tx,context,kind,raw)};}
function settings(group:'branding'|'security'):Policy{return {permissions:['settings:read',group==='branding'?'settings:update-branding':'settings:update-security'],outcome:group+'_updated',targetType:'settings',authorize:async(_tx,context,raw)=>{
  const stored=z.strictObject({group:z.enum(['branding','security'])}).parse(raw);if(stored.group!==group||(group==='security'&&!isSuperAdmin(context.actor)))throw new AppError('NOT_FOUND');return {targetId:null,resourceId:null};
}};}
function media(asset:'avatar'|'logo'|'favicon',remove:boolean):Policy{return {permissions:asset==='avatar'?[]:['settings:update-branding','settings:read'],outcome:(asset==='avatar'?'avatar':'branding_asset')+(remove?'_removed':'_updated'),targetType:asset==='avatar'?'user':'settings',authorize:async(_tx,context,raw)=>{
  const stored=z.strictObject({asset:z.enum(['avatar','logo','favicon']),owner_id:z.uuid()}).parse(raw);if(stored.asset!==asset||stored.owner_id!==context.actor.userId)throw new AppError('NOT_FOUND');return asset==='avatar'?entity(stored.owner_id):{targetId:null,resourceId:null};
}};}
function note(kind:'create'|'update'|'delete',outcome:string):Policy{return {permissions:['example-note:read',('example-note:'+kind) as PermissionCode],outcome,targetType:'note',authorize:async(tx,context,raw)=>{
  const stored=z.strictObject({owner_id:z.uuid(),note_id:z.uuid()}).parse(raw),state=(await tx.query<{example_notes_enabled:boolean}>('SELECT example_notes_enabled FROM system_state WHERE id=1')).rows[0];
  if(!state?.example_notes_enabled||stored.owner_id!==context.actor.userId)throw new AppError('NOT_FOUND');return entity(stored.note_id);
}};}
/** Server-owned whitelist. A prefix or a stored operation string never grants query authority. */
export const operationPolicies={
  'auth.session.revoke':{permissions:[],outcome:'session_revoked',targetType:'session',authorize:async(tx,context,raw)=>{const stored=z.strictObject({id:z.uuid()}).parse(raw);if(!(await tx.query('SELECT id FROM sessions WHERE id=$1 AND user_id=$2',[stored.id,context.actor.userId])).rowCount)throw new AppError('NOT_FOUND');return {targetId:stored.id,resourceId:null};}},
  'auth.sessions.revoke_others':{permissions:[],outcome:'other_sessions_revoked',targetType:'user',authorize:ownUser},
  'me.password.change':{permissions:[],outcome:'password_changed',targetType:'user',authorize:ownUser},
  'me.avatar.update':media('avatar',false),'me.avatar.delete':media('avatar',true),
  'settings.branding.logo.update':media('logo',false),'settings.branding.logo.delete':media('logo',true),
  'settings.branding.favicon.update':media('favicon',false),'settings.branding.favicon.delete':media('favicon',true),
  'settings.branding':settings('branding'),'settings.security':settings('security'),
  'invitations.create':invitation('invite_created'),'invitations.resend':invitation('invite_resent'),'invitations.revoke':invitation('invite_revoked'),
  'roles.create':role('create','role_created'),'roles.update':role('update','role_updated'),'roles.copy':role('copy','role_copied'),'roles.delete':role('delete','role_deleted'),'roles.eligibility':role('eligibility','role_qualified'),
  'users.profile':user('profile','user:update','user_profile_updated'),'users.status':user('status','user:change-status','user_status_changed'),'users.delete':user('delete','user:delete','user_deleted'),'users.roles':user('roles','user:assign-role','user_roles_assigned'),'users.reset':user('reset','user:reset-password','user_password_reset_requested'),
  'email-change.self-start':email('self-start'),'email-change.self-cancel':email('self-cancel'),'email-change.admin-start':email('admin-start'),'email-change.admin-cancel':email('admin-cancel'),
  'example.notes.create':note('create','note_created'),'example.notes.update':note('update','note_updated'),'example.notes.delete':note('delete','note_deleted'),
} satisfies Record<OperationName,Policy>;
