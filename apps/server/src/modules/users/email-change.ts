import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import {AppError} from '@honocraft/contracts/errors';
import {normalizeEmail,TokenRequestSchema} from '@honocraft/contracts/common';
import {SelfEmailChangeSchema,AdminEmailChangeSchema,SelfEmailCancelSchema,AdminEmailCancelSchema,EmailChangeStartedSchema,EmailChangeCancelledSchema} from '@honocraft/contracts/email-change';
import {PERMISSION_CODES,permissionDefinitions} from '@honocraft/contracts/permissions';
import {databaseNow,withTransaction,type Tx} from '../../infrastructure/db.js';
import {issueToken,tokenDigest,keyedDigest,type Keyring} from '../../infrastructure/crypto.js';
import {consumeLimits} from '../../infrastructure/rate-limit.js';
import {createMutationGateway,defineMutation} from '../access/mutation-gateway.js';
import {loadAccess,lockIdentityRows,type UserIdentity} from '../access/repository.js';
import {assertManageableTarget,assertRegistrationRole,isSuperAdmin,requireRecentAuthentication,type RoleSnapshot} from '../access/policy.js';
import {currentCredential,readRoleSnapshots} from '../auth/credentials.js';
import type {SessionContext} from '../auth/sessions.js';
import {appendAudit,requestMetaSchema,type RequestMeta} from '../audit/writer.js';
import {appendSecurityEvent} from '../audit/security-writer.js';
import {enqueueMail} from '../mail/outbox.js';
import {cancelCredentialTasks} from '../mail/cancellation.js';
import {loadPublicSettings} from '../settings/public.js';

const schemas={'self-start':SelfEmailChangeSchema,'admin-start':AdminEmailChangeSchema,'self-cancel':SelfEmailCancelSchema,'admin-cancel':AdminEmailCancelSchema};
type Kind=keyof typeof schemas;
const InputSchema=z.discriminatedUnion('kind',[
  SelfEmailChangeSchema.extend({kind:z.literal('self-start')}),AdminEmailChangeSchema.extend({kind:z.literal('admin-start')}),
  SelfEmailCancelSchema.extend({kind:z.literal('self-cancel')}),AdminEmailCancelSchema.extend({kind:z.literal('admin-cancel')}),
]);
type Input=z.infer<typeof InputSchema>;
const RoleSchema=z.strictObject({id:z.uuid(),code:z.string(),isBuiltin:z.boolean(),isDelegable:z.boolean(),isRegistrationDefaultEligible:z.boolean(),permissionCodes:z.array(z.enum(PERMISSION_CODES)),version:z.number().int().positive()});
const StoredPolicy=z.strictObject({user_id:z.uuid(),request_id:z.uuid(),requested_by:z.uuid(),roles:z.array(RoleSchema),high:z.boolean()});
const policySchema=z.object({email_change_hours:z.number().int().min(1).max(48),mail_cooldown_seconds:z.number().int().min(60).max(3600),mail_target_per_hour:z.number().int().min(1).max(5),mail_ip_per_hour:z.number().int().min(1).max(20)});
type Secrets={epoch:string;csrfKey:Buffer;digestKey:{id:string;key:Buffer};mailKeyring:Keyring};
type Ref={token:string;csrfToken:string};
type User={id:string;email:string;normalized_email:string;display_name:string;locale:'en'|'zh-CN'|null;status:string;creation_source:string;registration_role_id:string|null;email_verified_at:Date|null;has_password:boolean;version:number};
type Request={id:string;user_id:string;requested_by:string;initiated_by_self:boolean;new_email:string;normalized_new_email:string;status:string;version:number;expires_at:Date};
const userColumns='id,email,normalized_email,display_name,locale,status,creation_source,registration_role_id,email_verified_at,(password_hash IS NOT NULL) AS has_password,version';
const requestColumns='id,user_id,requested_by,initiated_by_self,new_email,normalized_new_email,status,version,expires_at';
async function userAt(tx:Tx,id:string){const row=(await tx.query<User>(`SELECT ${userColumns} FROM users WHERE id=$1`,[id])).rows[0];if(!row)throw new AppError('NOT_FOUND');return row;}
async function accessAt(tx:Tx,user:User){const actor=await loadAccess(tx,user.id);if(!actor)throw new AppError('NOT_FOUND');
  if(user.registration_role_id&&!actor.roles.some(role=>role.id===user.registration_role_id))actor.roles=[...actor.roles,...await readRoleSnapshots(tx,[user.registration_role_id])];return actor;}
const highRisk=(roles:readonly RoleSnapshot[])=>roles.some(role=>!role.isDelegable||['admin','super_admin'].includes(role.code)||role.permissionCodes.some(code=>permissionDefinitions.find(p=>p.code===code)?.reserved));
function eligible(user:User){return user.has_password&&((user.status==='active'&&user.email_verified_at!==null)||(user.status==='pending'&&user.creation_source==='registration'&&user.registration_role_id!==null));}
const mask=(email:string)=>email[0]+'***@'+email.split('@')[1];
async function common(tx:Tx,user:User){const settings=await loadPublicSettings(tx);return {recipient:user.email,displayName:user.display_name,instanceName:settings.instance_name,locale:user.locale??settings.default_locale,timeZone:settings.timezone};}
async function revoke(tx:Tx,userId:string,requestIds:string[],pendingVerification=false){
  const ids=(await tx.query<{id:string}>(`UPDATE one_time_credentials SET revoked_at=clock_timestamp() WHERE user_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL
    AND (email_change_request_id=ANY($2::uuid[]) OR ($3::boolean AND purpose='email_verify')) RETURNING id`,[userId,requestIds,pendingVerification])).rows.map(row=>row.id);
  await cancelCredentialTasks(tx,ids,'CREDENTIAL_REPLACED');
}
async function authorizeAdmin(tx:Tx,context:SessionContext,input:Input,user:User,target:UserIdentity,forcedHigh=false){
  assertManageableTarget(context.actor,target);const high=forcedHigh||highRisk(target.roles);
  if(high&&(!isSuperAdmin(context.actor)||!context.permissions.has('user:manage-privileged')))throw new AppError('TARGET_NOT_MANAGEABLE');
  if(high||'new_email' in input)requireRecentAuthentication(context.reauthenticatedAt,await databaseNow(tx));
  const confirmation='confirmation' in input?input.confirmation:undefined;
  if(confirmation?.target_id!==user.id&&(confirmation||high))throw new AppError('VALIDATION_ERROR');
  if(high&&confirmation?.typed_label!==user.normalized_email)throw new AppError('VALIDATION_ERROR');return high;
}
export function createEmailChange(pool:Pool,secrets:Secrets){
  function definition(kind:Kind,meta:RequestMeta){
    let user:User,target:UserIdentity,request:Request|undefined,requestId:string,requester:string,high=false;
    return defineMutation({input:InputSchema,output:z.union([EmailChangeStartedSchema,EmailChangeCancelledSchema]),mode:'exclusive',permission:kind.startsWith('admin')?'user:update-email':null,recentAuth:kind.endsWith('start'),
      auditAction:kind.endsWith('start')?'users.email_change.requested':'users.email_change.cancelled',
      resolveLocks:async(tx,input,actorId)=>{
        const id='id' in input?input.id:actorId,row=(await tx.query<{registration_role_id:string|null}>('SELECT registration_role_id FROM users WHERE id=$1',[id])).rows[0];
        return {userIds:[id],roleIds:row?.registration_role_id?[row.registration_role_id]:[]};
      },
      authorize:async(tx,context,input)=>{
        request=undefined;high=false;const id='id' in input?input.id:context.actor.userId;user=await userAt(tx,id);target=await accessAt(tx,user);
        if('id' in input)high=await authorizeAdmin(tx,context,input,user,target);
        if(user.version!==input.expected_version)throw new AppError('VERSION_CONFLICT');
        if(!eligible(user))throw new AppError('CHANGE_REQUEST_INVALID');
        if('new_email' in input){
          const email=normalizeEmail(input.new_email);if(email===user.normalized_email)throw new AppError('VALIDATION_ERROR');
          if((await tx.query('SELECT id FROM users WHERE normalized_email=$1',[email])).rowCount)throw new AppError('EMAIL_CONFLICT');
        }else{
          request=(await tx.query<Request>(`SELECT ${requestColumns} FROM email_change_requests WHERE id=$1 AND user_id=$2 FOR UPDATE`,[input.request_id,id])).rows[0];
          if(!request)throw new AppError('NOT_FOUND');
          if('id' in input&&request.requested_by!==context.actor.userId)throw new AppError('FORBIDDEN');
          if(request.version!==input.request_version)throw new AppError('VERSION_CONFLICT');
          if(request.status!=='pending'||request.expires_at<=await databaseNow(tx))throw new AppError('CHANGE_REQUEST_INVALID');
        }
      },
      execute:async(tx,context,input)=>{
        let data:z.infer<typeof EmailChangeStartedSchema>|z.infer<typeof EmailChangeCancelledSchema>;
        const now=await databaseNow(tx);
        if('new_email' in input){
          const row=(await tx.query<{typed_value:unknown}>("SELECT typed_value FROM system_settings WHERE key='security'")).rows[0],parsed=policySchema.safeParse(row?.typed_value);if(!parsed.success)throw new AppError('DEPENDENCY_UNAVAILABLE');const policy=parsed.data;
          const email=normalizeEmail(input.new_email),limit=await consumeLimits(tx,secrets.digestKey.key,[
            {scope:'mail.source.ip',identifier:meta.ip,limit:policy.mail_ip_per_hour,windowMs:3600000,bucketMs:60000},
            {scope:'mail.target.email_change',identifier:email,limit:policy.mail_target_per_hour,windowMs:3600000,bucketMs:60000,cooldownMs:policy.mail_cooldown_seconds*1000},
          ]);if(!limit.allowed)throw new AppError('RATE_LIMITED',{},limit.retryAfter);
          const old=(await tx.query<{id:string}>("SELECT id FROM email_change_requests WHERE user_id=$1 AND status='pending' ORDER BY id FOR UPDATE",[user.id])).rows.map(row=>row.id);
          await tx.query('SELECT id FROM one_time_credentials WHERE user_id=$1 ORDER BY id FOR UPDATE',[user.id]);await revoke(tx,user.id,old,user.status==='pending');
          await tx.query("UPDATE email_change_requests SET status=CASE WHEN expires_at<=$2 THEN 'expired' ELSE 'cancelled' END,version=version+1,terminal_reason='REPLACED',updated_at=clock_timestamp() WHERE id=ANY($1::uuid[])",[old,now]);
          requestId=randomUUID();requester=context.actor.userId;const expires=new Date(now.getTime()+policy.email_change_hours*3600000),issued=issueToken(),credential=randomUUID();
          await tx.query('INSERT INTO email_change_requests(id,user_id,requested_by,initiated_by_self,new_email,normalized_new_email,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[requestId,user.id,requester,!('id' in input),input.new_email,email,expires]);
          await tx.query("INSERT INTO one_time_credentials(id,purpose,token_hash,user_id,email_change_request_id,subject_version,target_email,normalized_target_email,credential_epoch,expires_at) VALUES($1,'email_change',$2,$3,$4,1,$5,$6,$7,$8)",[credential,issued.hash,user.id,requestId,input.new_email,email,secrets.epoch,expires]);
          const mail=await common(tx,user);
          await enqueueMail(tx,secrets.mailKeyring,{...mail,recipient:input.new_email,eventId:credential,credentialId:credential,purpose:'email_change',token:issued.token,expiresAt:expires.toISOString()});
          await enqueueMail(tx,secrets.mailKeyring,{...mail,eventId:requestId,purpose:'email_change_started',occurredAt:now.toISOString()});
          await appendSecurityEvent(tx,{userId:user.id,type:'auth.mail_request',result:'success',reasonCode:null,targetDigest:keyedDigest(secrets.digestKey.key,'honocraft.security-target.v1',email),meta});
          data={request_id:requestId,request_version:1,user_version:user.version+1,expires_at:expires.toISOString()};
        }else{
          requestId=request!.id;requester=request!.requested_by;
          await tx.query('SELECT id FROM one_time_credentials WHERE user_id=$1 ORDER BY id FOR UPDATE',[user.id]);await revoke(tx,user.id,[requestId]);
          await tx.query("UPDATE email_change_requests SET status='cancelled',version=version+1,terminal_reason='CANCELLED',updated_at=clock_timestamp() WHERE id=$1",[requestId]);
          data={cancelled:true,user_version:user.version+1};
        }
        await tx.query('UPDATE users SET version=version+1,updated_at=clock_timestamp() WHERE id=$1',[user.id]);
        return {data,status:'new_email' in input?202:200,audit:{target:{type:'user',id:user.id},changes:{before_version:user.version,after_version:user.version+1},...('confirmation' in input&&input.confirmation?{reason:input.confirmation.reason}:{})}};
      },
      idempotency:{policySchema:StoredPolicy,
        authorizeStored:async(tx,context,input,stored)=>{
          if(stored.user_id!==('id' in input?input.id:context.actor.userId))throw new AppError('FORBIDDEN');
          if(!('new_email' in input)&&input.request_id!==stored.request_id)throw new AppError('FORBIDDEN');
          if('id' in input){
            if(kind==='admin-cancel'&&stored.requested_by!==context.actor.userId)throw new AppError('FORBIDDEN');
            const current=await userAt(tx,stored.user_id),access=await accessAt(tx,current);assertManageableTarget(context.actor,{...access,roles:stored.roles});
            await authorizeAdmin(tx,context,input,current,access,stored.high);
          }
        },
        summarize:(data,context)=>({outcome:kind.endsWith('start')?'email_change_requested':'email_change_cancelled',resource_id:requestId,version:data.user_version,completed_at:context.now.toISOString()}),
        policyContext:()=>({user_id:user.id,request_id:requestId,requested_by:requester,roles:target.roles.map(role=>({...role,permissionCodes:[...role.permissionCodes]})),high}),
      },
    });
  }
  async function run(kind:Kind,ref:Ref,raw:unknown,meta:RequestMeta,key?:string,budget?:number){const parsed=schemas[kind].safeParse(raw);if(!parsed.success)throw new AppError('VALIDATION_ERROR');
    return createMutationGateway(pool,secrets,{[`email-change.${kind}`]:definition(kind,meta)})(`email-change.${kind}`,ref,{...parsed.data,kind},meta,key,budget);}
  async function confirm(raw:unknown,metadata:RequestMeta,remaining=15000){
    const deadline=performance.now()+Math.min(remaining,15000),parsed=TokenRequestSchema.safeParse(raw);if(!parsed.success)throw new AppError('VALIDATION_ERROR');const input=parsed.data,meta=requestMetaSchema.parse(metadata);
    const quota=await withTransaction(pool,'independent',async tx=>{
      if((await tx.query<{initialization_status:string}>('SELECT initialization_status FROM system_state WHERE id=1')).rows[0]?.initialization_status!=='initialized')throw new AppError('SYSTEM_NOT_INITIALIZED');
      return consumeLimits(tx,secrets.digestKey.key,[{scope:'auth.email_change.ip',identifier:meta.ip,limit:20,windowMs:60000,bucketMs:1000}]);
    });if(!quota.allowed)throw new AppError('RATE_LIMITED',{},quota.retryAfter);
    try{
      const found=(await pool.query<{id:string;user_id:string;email_change_request_id:string}>("SELECT id,user_id,email_change_request_id FROM one_time_credentials WHERE purpose='email_change' AND token_hash=$1",[tokenDigest(input.token)])).rows[0];if(!found)throw new AppError('CREDENTIAL_INVALID');
      if(deadline-performance.now()<8000)throw new AppError('BUSY_RETRY',{},2);
      return await withTransaction(pool,'exclusive',async tx=>{
        const candidate=(await tx.query<Request>(`SELECT ${requestColumns} FROM email_change_requests WHERE id=$1 AND user_id=$2`,[found.email_change_request_id,found.user_id])).rows[0];if(!candidate)throw new AppError('CREDENTIAL_INVALID');
        const initial=await userAt(tx,found.user_id);await lockIdentityRows(tx,[initial.id,candidate.requested_by],initial.registration_role_id?[initial.registration_role_id]:[]);
        await tx.query('SELECT id FROM sessions WHERE user_id=$1 ORDER BY id FOR UPDATE',[initial.id]);
        await tx.query('SELECT id FROM email_change_requests WHERE id=$1 FOR UPDATE',[candidate.id]);await tx.query('SELECT id FROM one_time_credentials WHERE user_id=$1 ORDER BY id FOR UPDATE',[initial.id]);
        const user=await userAt(tx,initial.id);if(!eligible(user)||!await currentCredential(tx,{id:found.id,purpose:'email_change',token:input.token,epoch:secrets.epoch}))throw new AppError('CREDENTIAL_INVALID');
        if((await tx.query('SELECT id FROM users WHERE normalized_email=$1 AND id<>$2',[candidate.normalized_new_email,user.id])).rowCount)throw new AppError('EMAIL_CONFLICT');
        let registrationRole:RoleSnapshot|undefined;
        if(user.status==='pending'){registrationRole=(await readRoleSnapshots(tx,[user.registration_role_id!]))[0];if(!registrationRole)throw new AppError('CREDENTIAL_INVALID');assertRegistrationRole(registrationRole);}
        const consumed=await tx.query('UPDATE one_time_credentials SET consumed_at=clock_timestamp() WHERE id=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp()',[found.id]);if(consumed.rowCount!==1)throw new AppError('CREDENTIAL_INVALID');
        await tx.query("UPDATE users SET email=$2,normalized_email=$3,email_verified_at=clock_timestamp(),status='active',registration_role_id=NULL,version=version+1,authorization_version=authorization_version+1,updated_at=clock_timestamp() WHERE id=$1",[user.id,candidate.new_email,candidate.normalized_new_email]);
        if(registrationRole)await tx.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[user.id,registrationRole.id]);
        await tx.query("UPDATE sessions SET revoked_at=clock_timestamp(),revoked_reason='email_changed' WHERE user_id=$1 AND revoked_at IS NULL",[user.id]);
        const revoked=(await tx.query<{id:string}>('UPDATE one_time_credentials SET revoked_at=clock_timestamp() WHERE user_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id',[user.id])).rows.map(row=>row.id);
        await cancelCredentialTasks(tx,revoked,'USER_STATE_CHANGED');await cancelCredentialTasks(tx,[found.id],'CREDENTIAL_CONSUMED');
        await tx.query("UPDATE email_change_requests SET status='completed',version=version+1,updated_at=clock_timestamp() WHERE id=$1",[candidate.id]);
        const now=await databaseNow(tx);await enqueueMail(tx,secrets.mailKeyring,{...await common(tx,user),eventId:randomUUID(),purpose:'email_changed',occurredAt:now.toISOString()});
        await appendAudit(tx,{actor:{type:'user',id:user.id},action:'users.email_change.confirmed',target:{type:'user',id:user.id},result:'success',meta,changes:{before_version:user.version,after_version:user.version+1,email_before_masked:mask(user.email),email_after_masked:mask(candidate.new_email),changed_fields:['email']}});
        await appendSecurityEvent(tx,{userId:user.id,type:'users.email_changed',result:'success',reasonCode:null,targetDigest:null,meta});
        return {changed:true as const,login_required:true as const};
      });
    }catch(error){
      let failure=error;if(typeof error==='object'&&error!==null&&'code' in error&&error.code==='23505'&&'constraint' in error&&error.constraint==='users_normalized_email_key')failure=new AppError('EMAIL_CONFLICT');
      if(failure instanceof AppError&&['CREDENTIAL_INVALID','EMAIL_CONFLICT'].includes(failure.code)){
        try{await withTransaction(pool,'independent',tx=>appendSecurityEvent(tx,{userId:null,type:'auth.credential_rejected',result:'denied',reasonCode:(failure as AppError).code as 'CREDENTIAL_INVALID'|'EMAIL_CONFLICT',targetDigest:null,meta}));}catch{console.error('Failed to persist sanitized email credential rejection');}
      }throw failure;
    }
  }
  return {confirm,
    startSelf:(ref:Ref,input:unknown,meta:RequestMeta,key?:string,budget?:number)=>run('self-start',ref,input,meta,key,budget),
    cancelSelf:(ref:Ref,input:unknown,meta:RequestMeta,key?:string,budget?:number)=>run('self-cancel',ref,input,meta,key,budget),
    startAdmin:(ref:Ref,input:unknown,meta:RequestMeta,key?:string,budget?:number)=>run('admin-start',ref,input,meta,key,budget),
    cancelAdmin:(ref:Ref,input:unknown,meta:RequestMeta,key?:string,budget?:number)=>run('admin-cancel',ref,input,meta,key,budget),
  };
}
