import {z} from 'zod';
import {AppError} from '@honocraft/contracts/errors';
import type {Tx} from '../../infrastructure/db.js';
import {tokenDigest} from '../../infrastructure/crypto.js';
import {credentialPurposes} from '../mail/templates.js';
import {loadAccess} from '../access/repository.js';
import {assertGrantableRoles,assertManageableTarget,assertRegistrationRole,can,isSuperAdmin,type RoleSnapshot} from '../access/policy.js';
export type CredentialPurpose=typeof credentialPurposes[number];
export type Credential={id:string;purpose:CredentialPurpose;user_id:string|null;invite_id:string|null;email_change_request_id:string|null;
  subject_version:number;target_email:string;normalized_target_email:string;expires_at:Date;purpose_metadata:unknown};
type User={id:string;normalized_email:string;status:string;creation_source:string;email_verified_at:Date|null;authorization_version:number;registration_role_id:string|null;has_password:boolean};
export const recoveryMetadataSchema=z.strictObject({restore_access:z.boolean(),operator_id:z.string().min(1).max(100),reason:z.string().min(1).max(500),evidence_ref:z.string().min(1).max(200)});
export async function readRoleSnapshots(tx:Tx,ids:readonly string[]):Promise<RoleSnapshot[]> {
  return (await tx.query<RoleSnapshot>(`SELECT r.id,r.code,r.is_builtin AS "isBuiltin",r.is_delegable AS "isDelegable",r.is_registration_default_eligible AS "isRegistrationDefaultEligible",r.version,
    COALESCE(array_agg(p.code ORDER BY p.code) FILTER(WHERE p.code IS NOT NULL),'{}') AS "permissionCodes"
    FROM roles r LEFT JOIN role_permissions rp ON rp.role_id=r.id LEFT JOIN permissions p ON p.id=rp.permission_id
    WHERE r.id=ANY($1::uuid[]) GROUP BY r.id ORDER BY r.id`,[ids])).rows;
}
async function eligibleRegistration(tx:Tx,user:User):Promise<boolean> {
  if(user.status!=='pending'||user.creation_source!=='registration'||!user.registration_role_id)return false;
  const role=(await readRoleSnapshots(tx,[user.registration_role_id]))[0];
  if(!role)return false;
  try{assertRegistrationRole(role);return true;}catch(error){if(error instanceof AppError)return false;throw error;}
}
/** Read-only authority check. Mutation consumers must lock security/users/roles/aggregate/credential before calling. */
export async function currentCredential(tx:Tx,ref:{id:string;purpose:string;token:string;epoch:string}):Promise<Credential|null> {
  if(!z.uuid().safeParse(ref.id).success||!z.enum(credentialPurposes).safeParse(ref.purpose).success)return null;
  let hash:Buffer;try{hash=tokenDigest(ref.token);}catch{return null;}
  const credential=(await tx.query<Credential>(`SELECT id,purpose,user_id,invite_id,email_change_request_id,subject_version,target_email,normalized_target_email,expires_at,purpose_metadata
    FROM one_time_credentials WHERE id=$1 AND token_hash=$2 AND purpose=$3 AND credential_epoch=$4
      AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp()`,[ref.id,hash,ref.purpose,ref.epoch])).rows[0];
  if(!credential)return null;
  try{return await subjectCurrent(tx,credential)?credential:null;}
  catch(error){if(error instanceof AppError)return null;throw error;}
}
async function subjectCurrent(tx:Tx,c:Credential):Promise<boolean> {
  if(c.purpose==='invite_accept') {
    const invite=(await tx.query<{inviter_id:string;version:number;normalized_email:string}>("SELECT inviter_id,version,normalized_email FROM invites WHERE id=$1 AND status='pending' AND expires_at>clock_timestamp()",[c.invite_id])).rows[0];
    if(!invite||invite.version!==c.subject_version||invite.normalized_email!==c.normalized_target_email)return false;
    if((await tx.query('SELECT id FROM users WHERE normalized_email=$1',[invite.normalized_email])).rowCount)return false;
    const issuer=await loadAccess(tx,invite.inviter_id);
    if(!issuer||!can(issuer,'invite:manage'))return false;
    const snapshots=(await tx.query<{role_id:string|null;role_version_at_issue:number}>('SELECT role_id,role_version_at_issue FROM invite_roles WHERE invite_id=$1',[c.invite_id])).rows;
    if(!snapshots.length||snapshots.some(role=>!role.role_id))return false;
    const roles=await readRoleSnapshots(tx,snapshots.map(role=>role.role_id!));
    if(roles.length!==snapshots.length||snapshots.some(snapshot=>roles.find(role=>role.id===snapshot.role_id)?.version!==snapshot.role_version_at_issue))return false;
    assertGrantableRoles(issuer,roles);
    if(roles.some(role=>['admin','super_admin'].includes(role.code))&&(!isSuperAdmin(issuer)||!can(issuer,'user:manage-privileged')))return false;
    return true;
  }
  const user=(await tx.query<User>(`SELECT id,normalized_email,status,creation_source,email_verified_at,authorization_version,
    registration_role_id,(password_hash IS NOT NULL) AS has_password FROM users WHERE id=$1`,[c.user_id])).rows[0];
  if(!user)return false;
  if(c.purpose==='email_change') {
    const request=(await tx.query<{version:number;requested_by:string;initiated_by_self:boolean;normalized_new_email:string}>(`SELECT version,requested_by,initiated_by_self,normalized_new_email
      FROM email_change_requests WHERE id=$1 AND user_id=$2 AND status='pending' AND expires_at>clock_timestamp()`,[c.email_change_request_id,user.id])).rows[0];
    if(!request||request.version!==c.subject_version||request.normalized_new_email!==c.normalized_target_email)return false;
    if(!(user.status==='active'&&user.email_verified_at)&&!await eligibleRegistration(tx,user))return false;
    if(!request.initiated_by_self){
      const issuer=await loadAccess(tx,request.requested_by);const target=await loadAccess(tx,user.id);
      if(!issuer||!target||!can(issuer,'user:update-email'))return false;
      assertManageableTarget(issuer,target);
    }else if(request.requested_by!==user.id)return false;
    return true;
  }
  if(user.normalized_email!==c.normalized_target_email)return false;
  if(c.purpose==='bootstrap') {
    const state=(await tx.query<{bootstrap_user_id:string|null;bootstrap_version:number;initialization_status:string}>('SELECT bootstrap_user_id,bootstrap_version,initialization_status FROM system_state WHERE id=1')).rows[0];
    return state?.initialization_status==='pending'&&state.bootstrap_user_id===user.id&&state.bootstrap_version===c.subject_version&&user.status==='pending'&&user.creation_source==='bootstrap'&&!user.has_password&&
      !(await tx.query('SELECT role_id FROM user_roles WHERE user_id=$1',[user.id])).rowCount;
  }
  if(user.authorization_version!==c.subject_version)return false;
  if(c.purpose==='email_verify') {
    if(!await eligibleRegistration(tx,user))return false;
    return !(await tx.query("SELECT id FROM email_change_requests WHERE user_id=$1 AND status='pending' AND expires_at>clock_timestamp()",[user.id])).rowCount;
  }
  if(c.purpose==='password_reset')return user.status==='active'&&!!user.email_verified_at&&user.has_password;
  if(c.purpose==='operator_recovery') {
    const metadata=recoveryMetadataSchema.safeParse(c.purpose_metadata);if(!metadata.success||user.status==='deleted')return false;
    if(metadata.data.restore_access)return !(await tx.query(`SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id
      WHERE u.status='active' AND u.email_verified_at IS NOT NULL AND u.password_hash IS NOT NULL AND r.code='super_admin' AND r.is_builtin LIMIT 1`)).rowCount;
    const actor=await loadAccess(tx,user.id);
    return !!actor&&user.status==='active'&&!!user.email_verified_at&&user.has_password&&isSuperAdmin(actor);
  }
  return false;
}
