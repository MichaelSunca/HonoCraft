import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import {AppError} from '@honocraft/contracts/errors';
import {normalizeEmail} from '@honocraft/contracts/common';
import {InvitationCreateSchema,InvitationActionSchema,InvitationSentSchema,InvitationRevokedSchema} from '@honocraft/contracts/invitations';
import {databaseNow,type Tx} from '../../infrastructure/db.js';
import {issueToken,type Keyring} from '../../infrastructure/crypto.js';
import {consumeLimits} from '../../infrastructure/rate-limit.js';
import {createMutationGateway,defineMutation} from '../access/mutation-gateway.js';
import {assertGrantableRoles,isSuperAdmin,requireRecentAuthentication,type RoleSnapshot} from '../access/policy.js';
import {permissionDefinitions} from '@honocraft/contracts/permissions';
import type {SessionContext} from '../auth/sessions.js';
import {readRoleSnapshots} from '../auth/credentials.js';
import {appendAudit,type RequestMeta} from '../audit/writer.js';
import {enqueueMail} from '../mail/outbox.js';
import {cancelCredentialTasks} from '../mail/cancellation.js';
import {loadPublicSettings} from '../settings/public.js';

type Ref={token:string;csrfToken:string};
type Secrets={epoch:string;csrfKey:Buffer;digestKey:{id:string;key:Buffer};mailKeyring:Keyring};
type Invite={id:string;email:string;normalized_email:string;inviter_id:string;status:string;version:number;expires_at:Date};
type Scope={roles:RoleSnapshot[];high:boolean};
const StoredPolicy=z.strictObject({id:z.uuid(),role_ids:z.array(z.uuid()).min(1).max(100),high_risk:z.boolean()});
const securitySchema=z.object({invite_hours:z.number().int().min(1).max(168),mail_cooldown_seconds:z.number().int().min(60).max(3600),mail_target_per_hour:z.number().int().min(1).max(5),mail_ip_per_hour:z.number().int().min(1).max(20)});
async function inviteAt(tx:Tx,id:string,lock=false){
  const row=(await tx.query<Invite>(`SELECT id,email,normalized_email,inviter_id,status,version,expires_at FROM invites WHERE id=$1${lock?' FOR UPDATE':''}`,[id])).rows[0];
  if(!row)throw new AppError('NOT_FOUND');return row;
}
async function roleIdsAt(tx:Tx,id:string){return (await tx.query<{role_id_at_issue:string}>('SELECT role_id_at_issue FROM invite_roles WHERE invite_id=$1 ORDER BY role_id_at_issue',[id])).rows.map(row=>row.role_id_at_issue);}
export function invitationHighRisk(roles:RoleSnapshot[]){return roles.some(role=>!role.isDelegable||['admin','super_admin'].includes(role.code)||role.permissionCodes.some(code=>permissionDefinitions.find(item=>item.code===code)?.reserved));}
async function authorizeScope(tx:Tx,context:SessionContext,ids:string[],forcedHigh=false):Promise<Scope>{
  const roles=await readRoleSnapshots(tx,ids);if(!ids.length||roles.length!==ids.length)throw new AppError('VALIDATION_ERROR');
  assertGrantableRoles(context.actor,roles);const high=forcedHigh||invitationHighRisk(roles);
  if(high){if(!isSuperAdmin(context.actor)||!context.permissions.has('user:manage-privileged'))throw new AppError('FORBIDDEN');requireRecentAuthentication(context.reauthenticatedAt,await databaseNow(tx));}
  return {roles,high};
}
function confirmTarget(confirmation:{target_id?:string|undefined;target_email?:string|undefined;typed_label?:string|undefined}|undefined,id:string|null,email:string,high:boolean){
  if(!confirmation){if(high)throw new AppError('VALIDATION_ERROR');return;}
  if((id?confirmation.target_id!==id:confirmation.target_email!==email)||(high&&confirmation.typed_label!==email))throw new AppError('VALIDATION_ERROR');
}
async function revokeCredentials(tx:Tx,id:string){
  await tx.query('SELECT id FROM one_time_credentials WHERE invite_id=$1 ORDER BY id FOR UPDATE',[id]);
  const rows=(await tx.query<{id:string}>('UPDATE one_time_credentials SET revoked_at=clock_timestamp() WHERE invite_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id',[id])).rows;
  await cancelCredentialTasks(tx,rows.map(row=>row.id),'CREDENTIAL_REPLACED');
}
async function terminate(tx:Tx,invite:Invite,status:'revoked'|'expired'){
  await revokeCredentials(tx,invite.id);
  await tx.query('UPDATE invites SET status=$2,version=version+1,terminal_reason=$3,updated_at=clock_timestamp() WHERE id=$1',[invite.id,status,status==='expired'?'EXPIRED':'ADMIN_REVOKED']);
  await tx.query('UPDATE invite_roles SET role_id=NULL WHERE invite_id=$1',[invite.id]);
}
export function createInvitationManagement(pool:Pool,secrets:Secrets){
  async function sendQuota(tx:Tx,email:string,meta:RequestMeta){
    const row=(await tx.query<{typed_value:unknown}>("SELECT typed_value FROM system_settings WHERE key='security'")).rows[0];
    const parsed=securitySchema.safeParse(row?.typed_value);if(!parsed.success)throw new AppError('DEPENDENCY_UNAVAILABLE');const policy=parsed.data;
    const limit=await consumeLimits(tx,secrets.digestKey.key,[{scope:'mail.source.ip',identifier:meta.ip,limit:policy.mail_ip_per_hour,windowMs:3600000,bucketMs:60000},
      {scope:'mail.target.invite_accept',identifier:email,limit:policy.mail_target_per_hour,windowMs:3600000,bucketMs:60000,cooldownMs:policy.mail_cooldown_seconds*1000}]);
    if(!limit.allowed)throw new AppError('RATE_LIMITED',{},limit.retryAfter);return policy;
  }
  async function issue(tx:Tx,invite:Invite){
    const issued=issueToken(),id=randomUUID(),settings=await loadPublicSettings(tx);
    await tx.query(`INSERT INTO one_time_credentials(id,purpose,token_hash,invite_id,subject_version,target_email,normalized_target_email,credential_epoch,expires_at)
      VALUES($1,'invite_accept',$2,$3,$4,$5,$6,$7,$8)`,[id,issued.hash,invite.id,invite.version,invite.email,invite.normalized_email,secrets.epoch,invite.expires_at]);
    await enqueueMail(tx,secrets.mailKeyring,{eventId:id,credentialId:id,purpose:'invite_accept',recipient:invite.email,displayName:'',instanceName:settings.instance_name,locale:settings.default_locale,timeZone:settings.timezone,token:issued.token,expiresAt:invite.expires_at.toISOString()});
    return {id:invite.id,version:invite.version,status:'pending' as const,expires_at:invite.expires_at.toISOString(),mail_status:'queued' as const};
  }
  async function authorizeStored(tx:Tx,context:SessionContext,stored:z.infer<typeof StoredPolicy>,confirmation:Parameters<typeof confirmTarget>[0],creating:boolean){
    const invite=await inviteAt(tx,stored.id);const scope=await authorizeScope(tx,context,stored.role_ids,stored.high_risk);
    confirmTarget(confirmation,creating?null:invite.id,invite.normalized_email,scope.high);
  }
  function createDefinition(meta:RequestMeta){
    let scope:Scope;
    return defineMutation({input:InvitationCreateSchema,output:InvitationSentSchema,mode:'exclusive',permission:'invite:manage',recentAuth:false,auditAction:'invitations.invite.created',
      resolveLocks:async(tx,input)=>{
        const email=normalizeEmail(input.email),old=(await tx.query<{id:string;inviter_id:string}>("SELECT id,inviter_id FROM invites WHERE normalized_email=$1 AND status='pending'",[email])).rows[0];
        const occupied=(await tx.query<{id:string}>('SELECT id FROM users WHERE normalized_email=$1',[email])).rows;
        return {userIds:[...occupied.map(user=>user.id),...(old?[old.inviter_id]:[])],roleIds:[...input.role_ids,...(old?await roleIdsAt(tx,old.id):[])]};
      },
      authorize:async(tx,context,input)=>{scope=await authorizeScope(tx,context,input.role_ids);confirmTarget(input.confirmation,null,normalizeEmail(input.email),scope.high);},
      execute:async(tx,context,input)=>{
        const email=normalizeEmail(input.email);
        if((await tx.query('SELECT id FROM users WHERE normalized_email=$1',[email])).rowCount)throw new AppError('ACCOUNT_EXISTS');
        const previous=(await tx.query<Invite>("SELECT id,email,normalized_email,inviter_id,status,version,expires_at FROM invites WHERE normalized_email=$1 AND status='pending' FOR UPDATE",[email])).rows[0];
        if(previous){if(previous.expires_at>await databaseNow(tx))throw new AppError('INVITE_EXISTS');await terminate(tx,previous,'expired');
          await appendAudit(tx,{actor:{type:'user',id:context.actor.userId},action:'invitations.invite.expired',target:{type:'invite',id:previous.id},result:'success',meta,changes:{status_before:'pending',status_after:'expired',before_version:previous.version,after_version:previous.version+1}});}
        const policy=await sendQuota(tx,email,meta),now=await databaseNow(tx),id=randomUUID(),expires=new Date(now.getTime()+policy.invite_hours*3600000);
        await tx.query('INSERT INTO invites(id,email,normalized_email,inviter_id,expires_at) VALUES($1,$2,$3,$4,$5)',[id,input.email,email,context.actor.userId,expires]);
        await tx.query('INSERT INTO invite_roles(invite_id,role_id,role_id_at_issue,role_code,role_name,role_version_at_issue) SELECT $1,id,id,code,name,version FROM roles WHERE id=ANY($2::uuid[])',[id,input.role_ids]);
        const data=await issue(tx,{id,email:input.email,normalized_email:email,inviter_id:context.actor.userId,status:'pending',version:1,expires_at:expires});
        return {data,status:202,audit:{target:{type:'invite',id},...(input.confirmation?{reason:input.confirmation.reason}:{}),changes:{after_version:1,status_after:'pending' as const,role_ids_after:input.role_ids}}};
      },
      idempotency:{policySchema:StoredPolicy,authorizeStored:(tx,context,input,stored)=>authorizeStored(tx,context,stored,input.confirmation,true),
        summarize:(data,context)=>({outcome:'invite_created',resource_id:data.id,version:data.version,completed_at:context.now.toISOString()}),
        policyContext:(data,_context,input)=>({id:data.id,role_ids:input.role_ids,high_risk:scope.high})},
    });
  }
  function actionDefinition(kind:'resend'|'revoke',meta:RequestMeta){
    let scope:Scope,invite:Invite,ids:string[];
    return defineMutation({input:InvitationActionSchema,output:z.union([InvitationSentSchema,InvitationRevokedSchema]),mode:'exclusive',permission:'invite:manage',recentAuth:false,auditAction:kind==='resend'?'invitations.invite.resent':'invitations.invite.revoked',
      resolveLocks:async(tx,input)=>{const target=(await tx.query<{inviter_id:string}>('SELECT inviter_id FROM invites WHERE id=$1',[input.id])).rows[0];return {userIds:target?[target.inviter_id]:[],roleIds:await roleIdsAt(tx,input.id)};},
      authorize:async(tx,context,input)=>{
        invite=await inviteAt(tx,input.id,true);ids=await roleIdsAt(tx,input.id);scope=await authorizeScope(tx,context,ids);
        confirmTarget(input.confirmation,invite.id,invite.normalized_email,scope.high);
        if(invite.status!=='pending'||invite.expires_at<=await databaseNow(tx))throw new AppError('INVITE_TERMINAL');
        if(invite.version!==input.expected_version)throw new AppError('VERSION_CONFLICT');
      },
      execute:async(tx,context,input)=>{
        let data:z.infer<typeof InvitationSentSchema>|z.infer<typeof InvitationRevokedSchema>;
        if(kind==='revoke'){await terminate(tx,invite,'revoked');data={id:invite.id,version:invite.version+1,status:'revoked'};}
        else{
          if((await tx.query('SELECT id FROM users WHERE normalized_email=$1',[invite.normalized_email])).rowCount)throw new AppError('ACCOUNT_EXISTS');
          const policy=await sendQuota(tx,invite.normalized_email,meta),now=await databaseNow(tx);await revokeCredentials(tx,invite.id);
          const expires=new Date(now.getTime()+policy.invite_hours*3600000);
          await tx.query('UPDATE invites SET inviter_id=$2,version=version+1,expires_at=$3,updated_at=clock_timestamp() WHERE id=$1',[invite.id,context.actor.userId,expires]);
          await tx.query('UPDATE invite_roles ir SET role_id=r.id,role_code=r.code,role_name=r.name,role_version_at_issue=r.version FROM roles r WHERE ir.invite_id=$1 AND ir.role_id_at_issue=r.id',[invite.id]);
          data=await issue(tx,{...invite,inviter_id:context.actor.userId,version:invite.version+1,expires_at:expires});
        }
        return {data,status:kind==='resend'?202:200,audit:{target:{type:'invite',id:invite.id},reason:input.confirmation.reason,changes:{before_version:invite.version,after_version:invite.version+1,status_before:'pending' as const,status_after:kind==='resend'?'pending' as const:'revoked' as const}}};
      },
      idempotency:{policySchema:StoredPolicy,authorizeStored:(tx,context,input,stored)=>authorizeStored(tx,context,stored,input.confirmation,false),
        summarize:(data,context)=>({outcome:kind==='resend'?'invite_resent':'invite_revoked',resource_id:data.id,version:data.version,completed_at:context.now.toISOString()}),
        policyContext:data=>({id:data.id,role_ids:ids,high_risk:scope.high})},
    });
  }
  return {
    create:(ref:Ref,input:unknown,meta:RequestMeta,key?:string,budget?:number)=>createMutationGateway(pool,secrets,{'invitations.create':createDefinition(meta)})('invitations.create',ref,input,meta,key,budget),
    resend:(ref:Ref,input:unknown,meta:RequestMeta,key?:string,budget?:number)=>createMutationGateway(pool,secrets,{'invitations.resend':actionDefinition('resend',meta)})('invitations.resend',ref,input,meta,key,budget),
    revoke:(ref:Ref,input:unknown,meta:RequestMeta,key?:string,budget?:number)=>createMutationGateway(pool,secrets,{'invitations.revoke':actionDefinition('revoke',meta)})('invitations.revoke',ref,input,meta,key,budget),
  };
}
