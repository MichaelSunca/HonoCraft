import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import {AppError} from '@honocraft/contracts/errors';
import {RegisterSchema,EmailRequestSchema,TokenRequestSchema,ResetPasswordSchema,normalizeEmail} from '@honocraft/contracts/common';
import {databaseNow,withTransaction,type Tx} from '../../infrastructure/db.js';
import {issueToken,tokenDigest,keyedDigest,type Keyring} from '../../infrastructure/crypto.js';
import type {PasswordService} from '../../infrastructure/passwords.js';
import {consumeLimits} from '../../infrastructure/rate-limit.js';
import {appendAudit,requestMetaSchema,type RequestMeta} from '../audit/writer.js';
import {appendSecurityEvent} from '../audit/security-writer.js';
import {lockIdentityRows} from '../access/repository.js';
import {assertRegistrationRole} from '../access/policy.js';
import {currentCredential,readRoleSnapshots} from './credentials.js';
import {enqueueMail} from '../mail/outbox.js';
import {cancelCredentialTasks} from '../mail/cancellation.js';
const accepted={accepted:true as const};
const policySchema=z.object({registration_open:z.boolean(),password_min_length:z.number().int().min(15).max(64),
  email_verify_hours:z.number().int().min(1).max(48),password_reset_minutes:z.number().int().min(10).max(60),
  mail_cooldown_seconds:z.number().int().min(60).max(3600),mail_target_per_hour:z.number().int().min(1).max(5),mail_ip_per_hour:z.number().int().min(1).max(20)});
type Policy=z.infer<typeof policySchema>&{defaultRoleId:string};
type User={id:string;email:string;normalized_email:string;display_name:string;locale:'en'|'zh-CN'|null;status:string;creation_source:string;
  registration_role_id:string|null;authorization_version:number;version:number;email_verified_at:Date|null;has_password:boolean};
const userColumns='id,email,normalized_email,display_name,locale,status,creation_source,registration_role_id,authorization_version,version,email_verified_at,(password_hash IS NOT NULL) AS has_password';
async function policyAt(tx:Tx):Promise<Policy>{
  const row=(await tx.query<{typed_value:unknown;registration_default_role_id:string;initialization_status:string}>(`SELECT typed_value,registration_default_role_id,initialization_status
    FROM system_settings CROSS JOIN system_state WHERE key='security' AND id=1`)).rows[0];
  if(row?.initialization_status!=='initialized')throw new AppError('SYSTEM_NOT_INITIALIZED');
  const policy=policySchema.safeParse(row.typed_value);if(!policy.success)throw new AppError('DEPENDENCY_UNAVAILABLE');
  return {...policy.data,defaultRoleId:row.registration_default_role_id};
}
async function registrationRole(tx:Tx,id:string|null){
  const role=id?(await readRoleSnapshots(tx,[id]))[0]:undefined;
  if(!role)throw new AppError('REGISTRATION_ROLE_INVALID');assertRegistrationRole(role);return role;
}
async function registrationEligible(tx:Tx,user:User|undefined){
  if(!user||user.status!=='pending'||user.creation_source!=='registration'||!user.has_password)return false;
  try{await registrationRole(tx,user.registration_role_id);}catch(error){if(error instanceof AppError)return false;throw error;}
  return !(await tx.query("SELECT id FROM email_change_requests WHERE user_id=$1 AND status='pending' AND expires_at>clock_timestamp()",[user.id])).rowCount;
}
async function mailCommon(tx:Tx,user:User){
  const branding=(await tx.query<{typed_value:{instance_name:string;default_locale:'en'|'zh-CN';timezone:string}}>("SELECT typed_value FROM system_settings WHERE key='branding'")).rows[0]?.typed_value;
  if(!branding)throw new AppError('DEPENDENCY_UNAVAILABLE');
  return {recipient:user.email,displayName:user.display_name,instanceName:branding.instance_name,locale:user.locale??branding.default_locale,timeZone:branding.timezone};
}
function parse<S extends z.ZodType>(schema:S,raw:unknown):z.output<S>{const result=schema.safeParse(raw);if(!result.success)throw new AppError('VALIDATION_ERROR');return result.data;}
function checkBudget(deadline:number){if(deadline-performance.now()<8000)throw new AppError('BUSY_RETRY',{},2);}

export function createPublicAuthService(pool:Pool,secrets:{epoch:string;digestKey:Buffer;mailKeyring:Keyring},passwords:PasswordService){
  async function preflight(operation:string,meta:RequestMeta){
    const result=await withTransaction(pool,'independent',async tx=>{
      const policy=await policyAt(tx);
      if(operation==='register'&&!policy.registration_open)throw new AppError('REGISTRATION_DISABLED');
      const limit=await consumeLimits(tx,secrets.digestKey,[{scope:`auth.${operation}.ip`,identifier:meta.ip,limit:20,windowMs:60000,bucketMs:1000}]);return {policy,limit};
    });
    if(!result.limit.allowed)throw new AppError('RATE_LIMITED',{},result.limit.retryAfter);return result.policy;
  }
  const targetDigest=(email:string)=>keyedDigest(secrets.digestKey,'honocraft.security-target.v1',email);
  async function suppressed(tx:Tx,email:string,meta:RequestMeta,reason:'RATE_LIMITED'|'CREDENTIAL_INVALID'|'ACCOUNT_EXISTS'){
    await appendSecurityEvent(tx,{userId:null,type:'auth.mail_request',result:'denied',reasonCode:reason,targetDigest:targetDigest(email),meta});
  }
  async function mailQuota(tx:Tx,purpose:'email_verify'|'password_reset',email:string,meta:RequestMeta,policy:Policy){
    const result=await consumeLimits(tx,secrets.digestKey,[
      {scope:'mail.source.ip',identifier:meta.ip,limit:policy.mail_ip_per_hour,windowMs:3600000,bucketMs:60000},
      {scope:`mail.target.${purpose}`,identifier:email,limit:policy.mail_target_per_hour,windowMs:3600000,bucketMs:60000,cooldownMs:policy.mail_cooldown_seconds*1000},
    ]);
    if(result.allowed)return true;
    if(result.scope==='mail.source.ip')throw new AppError('RATE_LIMITED',{},result.retryAfter);
    await suppressed(tx,email,meta,'RATE_LIMITED');return false;
  }
  async function revoke(tx:Tx,userId:string,purposes:readonly string[]){
    const ids=(await tx.query<{id:string}>(`UPDATE one_time_credentials SET revoked_at=clock_timestamp()
      WHERE user_id=$1 AND purpose=ANY($2::text[]) AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id`,[userId,purposes])).rows.map(row=>row.id);
    await cancelCredentialTasks(tx,ids,'CREDENTIAL_REPLACED');
  }
  async function issueMail(tx:Tx,user:User,purpose:'email_verify'|'password_reset',policy:Policy,meta:RequestMeta){
    await revoke(tx,user.id,[purpose]);
    const issued=issueToken(),id=randomUUID(),now=await databaseNow(tx);
    const expires=new Date(now.getTime()+(purpose==='email_verify'?policy.email_verify_hours*3600000:policy.password_reset_minutes*60000));
    await tx.query(`INSERT INTO one_time_credentials(id,purpose,token_hash,user_id,subject_version,target_email,normalized_target_email,credential_epoch,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,purpose,issued.hash,user.id,user.authorization_version,user.email,user.normalized_email,secrets.epoch,expires]);
    await enqueueMail(tx,secrets.mailKeyring,{...await mailCommon(tx,user),eventId:id,credentialId:id,purpose,token:issued.token,expiresAt:expires.toISOString()});
    await appendSecurityEvent(tx,{userId:user.id,type:'auth.mail_request',result:'success',reasonCode:null,targetDigest:targetDigest(user.normalized_email),meta});
  }
  async function register(raw:unknown,metadata:RequestMeta,remainingBudgetMs=15000){
    const deadline=performance.now()+Math.min(15000,remainingBudgetMs),input=parse(RegisterSchema,raw),meta=requestMetaSchema.parse(metadata),email=normalizeEmail(input.email);
    const initial=await preflight('register',meta);checkBudget(deadline);
    const hash=await passwords.hash(input.password,initial.password_min_length);checkBudget(deadline);
    return withTransaction(pool,'exclusive',async tx=>{
      const policy=await policyAt(tx);if(!policy.registration_open)throw new AppError('REGISTRATION_DISABLED');
      if([...input.password].length<policy.password_min_length)throw new AppError('PASSWORD_REJECTED');
      const existing=(await tx.query<{id:string}>('SELECT id FROM users WHERE normalized_email=$1',[email])).rows[0];
      await lockIdentityRows(tx,existing?[existing.id]:[],[policy.defaultRoleId]);await registrationRole(tx,policy.defaultRoleId);
      if(!await mailQuota(tx,'email_verify',email,meta,policy))return accepted;
      if(existing){await suppressed(tx,email,meta,'ACCOUNT_EXISTS');return accepted;}
      const id=randomUUID();
      await tx.query(`INSERT INTO users(id,email,normalized_email,display_name,password_hash,creation_source,registration_role_id)
        VALUES($1,$2,$3,$4,$5,'registration',$6)`,[id,input.email,email,input.display_name,hash,policy.defaultRoleId]);
      const user=(await tx.query<User>(`SELECT ${userColumns} FROM users WHERE id=$1`,[id])).rows[0]!;
      await issueMail(tx,user,'email_verify',policy,meta);
      await appendAudit(tx,{actor:{type:'anonymous'},action:'auth.user.registered',target:{type:'user',id},result:'success',meta});
      return accepted;
    });
  }
  function requestMail(purpose:'email_verify'|'password_reset'){
    return async(raw:unknown,metadata:RequestMeta,remainingBudgetMs=15000)=>{
      const deadline=performance.now()+Math.min(15000,remainingBudgetMs),input=parse(EmailRequestSchema,raw),meta=requestMetaSchema.parse(metadata),email=normalizeEmail(input.email);
      await preflight(purpose==='email_verify'?'email_resend':'password_forgot',meta);checkBudget(deadline);
      return withTransaction(pool,'exclusive',async tx=>{
        const policy=await policyAt(tx),user=(await tx.query<User>(`SELECT ${userColumns} FROM users WHERE normalized_email=$1`,[email])).rows[0];
        if(user)await lockIdentityRows(tx,[user.id],user.registration_role_id?[user.registration_role_id]:[]);
        if(!await mailQuota(tx,purpose,email,meta,policy))return accepted;
        const eligible=purpose==='email_verify'?await registrationEligible(tx,user):user?.status==='active'&&!!user.email_verified_at&&user.has_password;
        if(!eligible||!user){await suppressed(tx,email,meta,'CREDENTIAL_INVALID');return accepted;}
        await issueMail(tx,user,purpose,policy,meta);return accepted;
      });
    };
  }
  async function credentialAction<T>(meta:RequestMeta,work:()=>Promise<T>):Promise<T>{
    try{return await work();}catch(error){
      if(error instanceof AppError&&['CREDENTIAL_INVALID','REGISTRATION_ROLE_INVALID'].includes(error.code)){
        try{await withTransaction(pool,'independent',tx=>appendSecurityEvent(tx,{userId:null,type:'auth.credential_rejected',result:'denied',reasonCode:error.code as 'CREDENTIAL_INVALID'|'REGISTRATION_ROLE_INVALID',targetDigest:null,meta}));}
        catch{console.error('Failed to persist sanitized credential rejection');}
      }
      throw error;
    }
  }
  async function candidate(token:string,purpose:string){
    const row=(await pool.query<{id:string;user_id:string}>('SELECT id,user_id FROM one_time_credentials WHERE token_hash=$1 AND purpose=$2',[tokenDigest(token),purpose])).rows[0];
    if(!row)throw new AppError('CREDENTIAL_INVALID');return row;
  }
  async function lockCredential(tx:Tx,id:string,userId:string,reset=false){
    const user=(await tx.query<User>(`SELECT ${userColumns} FROM users WHERE id=$1`,[userId])).rows[0];
    if(!user)throw new AppError('CREDENTIAL_INVALID');
    await lockIdentityRows(tx,[user.id],user.registration_role_id?[user.registration_role_id]:[]);
    if(reset)await tx.query('SELECT id FROM sessions WHERE user_id=$1 ORDER BY id FOR UPDATE',[user.id]);
    await tx.query('SELECT id FROM one_time_credentials WHERE user_id=$1 ORDER BY id FOR UPDATE',[user.id]);
    return {user,id};
  }
  async function consume(tx:Tx,id:string){
    const result=await tx.query('UPDATE one_time_credentials SET consumed_at=clock_timestamp() WHERE id=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp()',[id]);
    if(result.rowCount!==1)throw new AppError('CREDENTIAL_INVALID');await cancelCredentialTasks(tx,[id],'CREDENTIAL_CONSUMED');
  }
  async function verify(raw:unknown,metadata:RequestMeta,remainingBudgetMs=15000){
    const deadline=performance.now()+Math.min(15000,remainingBudgetMs),input=parse(TokenRequestSchema,raw),meta=requestMetaSchema.parse(metadata);
    return credentialAction(meta,async()=>{
      await preflight('email_verify',meta);const found=await candidate(input.token,'email_verify');checkBudget(deadline);
      return withTransaction(pool,'exclusive',async tx=>{
        await policyAt(tx);const {user}=await lockCredential(tx,found.id,found.user_id);
        // Only an otherwise-valid token holder may learn that their original role is no longer eligible.
        const envelope=await tx.query(`SELECT id FROM one_time_credentials WHERE id=$1 AND purpose='email_verify' AND token_hash=$2
          AND credential_epoch=$3 AND subject_version=$4 AND normalized_target_email=$5 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp()`,
        [found.id,tokenDigest(input.token),secrets.epoch,user.authorization_version,user.normalized_email]);
        if(!envelope.rowCount||user.status!=='pending'||user.creation_source!=='registration')throw new AppError('CREDENTIAL_INVALID');
        const role=await registrationRole(tx,user.registration_role_id);
        if(!await currentCredential(tx,{id:found.id,purpose:'email_verify',token:input.token,epoch:secrets.epoch}))throw new AppError('CREDENTIAL_INVALID');
        await tx.query(`UPDATE users SET status='active',email_verified_at=clock_timestamp(),registration_role_id=NULL,version=version+1,
          authorization_version=authorization_version+1,updated_at=clock_timestamp() WHERE id=$1`,[user.id]);
        await tx.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',[user.id,role.id]);await consume(tx,found.id);await revoke(tx,user.id,['email_verify']);
        await appendAudit(tx,{actor:{type:'user',id:user.id},action:'auth.email.verified',target:{type:'user',id:user.id},result:'success',meta,changes:{role_ids_after:[role.id],status_before:'pending',status_after:'active'}});
        return {verified:true as const,login_required:true as const};
      });
    });
  }
  async function reset(raw:unknown,metadata:RequestMeta,remainingBudgetMs=15000){
    const deadline=performance.now()+Math.min(15000,remainingBudgetMs),input=parse(ResetPasswordSchema,raw),meta=requestMetaSchema.parse(metadata);
    return credentialAction(meta,async()=>{
      const policy=await preflight('password_reset',meta),found=await candidate(input.token,'password_reset');checkBudget(deadline);
      const hash=await passwords.hash(input.new_password,policy.password_min_length);checkBudget(deadline);
      return withTransaction(pool,'exclusive',async tx=>{
        const currentPolicy=await policyAt(tx),{user}=await lockCredential(tx,found.id,found.user_id,true);
        if(!await currentCredential(tx,{id:found.id,purpose:'password_reset',token:input.token,epoch:secrets.epoch}))throw new AppError('CREDENTIAL_INVALID');
        if([...input.new_password].length<currentPolicy.password_min_length)throw new AppError('PASSWORD_REJECTED');
        await tx.query(`UPDATE users SET password_hash=$2,password_version=password_version+1,version=version+1,
          authorization_version=authorization_version+1,updated_at=clock_timestamp() WHERE id=$1`,[user.id,hash]);
        await tx.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL',[user.id]);
        await consume(tx,found.id);await revoke(tx,user.id,['password_reset','operator_recovery']);
        await enqueueMail(tx,secrets.mailKeyring,{...await mailCommon(tx,user),eventId:found.id,purpose:'password_changed',occurredAt:(await databaseNow(tx)).toISOString()});
        await appendAudit(tx,{actor:{type:'user',id:user.id},action:'auth.password.reset',target:{type:'user',id:user.id},result:'success',meta,changes:{changed_fields:['password'],before_version:user.version,after_version:user.version+1}});
        return {reset:true as const,login_required:true as const};
      });
    });
  }
  return {register,resend:requestMail('email_verify'),forgot:requestMail('password_reset'),verify,reset};
}
