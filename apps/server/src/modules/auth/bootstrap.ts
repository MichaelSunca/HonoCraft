import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import {AppError} from '@honocraft/contracts/errors';
import {EmailSchema,normalizeEmail,CompleteInvitationSchema,text} from '@honocraft/contracts/common';
import {databaseNow,withTransaction,type Tx} from '../../infrastructure/db.js';
import {issueToken,tokenDigest,type Keyring} from '../../infrastructure/crypto.js';
import type {PasswordService} from '../../infrastructure/passwords.js';
import {consumeLimits} from '../../infrastructure/rate-limit.js';
import {appendAudit,requestMetaSchema,type RequestMeta} from '../audit/writer.js';
import {lockIdentityRows} from '../access/repository.js';
import {enqueueMail} from '../mail/outbox.js';
import {cancelCredentialTasks} from '../mail/cancellation.js';
import {currentCredential} from './credentials.js';
const superRole='00000000-0000-4000-8000-000000000001';
type BootstrapSecrets={epoch:string;digestKey:Buffer;mailKeyring:Keyring};
const initializeSchema=z.strictObject({email:EmailSchema,resend:z.boolean().default(false)});
async function passwordMinimum(tx:Tx):Promise<number> {
  const value=(await tx.query<{minimum:number}>("SELECT (typed_value->>'password_min_length')::int AS minimum FROM system_settings WHERE key='security'")).rows[0]?.minimum;
  if(!value||value<15||value>128)throw new AppError('DEPENDENCY_UNAVAILABLE');return value;
}
/** Local operator only. This is deliberately absent from the HTTP route registry. */
export async function initializeBootstrap(pool:Pool,secrets:BootstrapSecrets,raw:unknown,metadata:RequestMeta) {
  const parsed=initializeSchema.safeParse(raw);if(!parsed.success)throw new AppError('VALIDATION_ERROR');
  const input=parsed.data;const normalized=normalizeEmail(input.email);const meta=requestMetaSchema.parse(metadata);
  return withTransaction(pool,'exclusive',async tx=>{
    const state=(await tx.query<{initialization_status:string;bootstrap_user_id:string|null;bootstrap_version:number}>('SELECT initialization_status,bootstrap_user_id,bootstrap_version FROM system_state WHERE id=1')).rows[0]!;
    if(state.initialization_status==='initialized')return {status:'initialized' as const,mail_queued:false,operation_id:meta.requestId};
    let userId=state.bootstrap_user_id;let version=state.bootstrap_version;
    if(state.initialization_status==='pending') {
      const user=(await tx.query<{normalized_email:string;status:string;creation_source:string}>('SELECT normalized_email,status,creation_source FROM users WHERE id=$1 FOR UPDATE',[userId])).rows[0];
      if(!user||user.normalized_email!==normalized||user.status!=='pending'||user.creation_source!=='bootstrap')throw new AppError('BOOTSTRAP_CLOSED');
      if(!input.resend)return {status:'pending' as const,mail_queued:false,operation_id:meta.requestId};
      version++;
      await tx.query('UPDATE system_state SET bootstrap_version=$1 WHERE id=1',[version]);
    }else{
      if((await tx.query('SELECT id FROM users WHERE normalized_email=$1',[normalized])).rowCount)throw new AppError('EMAIL_CONFLICT');
      userId=randomUUID();
      await tx.query(`INSERT INTO users(id,email,normalized_email,display_name,creation_source) VALUES ($1,$2,$3,'Administrator','bootstrap')`,[userId,input.email,normalized]);
      await tx.query("UPDATE system_state SET initialization_status='pending',bootstrap_user_id=$1 WHERE id=1",[userId]);
    }
    const settings=(await tx.query<{typed_value:unknown}>("SELECT typed_value FROM system_settings WHERE key='security'")).rows[0]?.typed_value;
    const policy=z.object({mail_cooldown_seconds:z.number().int().min(60).max(3600),mail_target_per_hour:z.number().int().min(1).max(5),mail_ip_per_hour:z.number().int().min(1).max(20)}).safeParse(settings);
    if(!policy.success)throw new AppError('DEPENDENCY_UNAVAILABLE');
    const quota=await consumeLimits(tx,secrets.digestKey,[
      {scope:'mail.bootstrap.target',identifier:normalized,limit:policy.data.mail_target_per_hour,windowMs:3_600_000,bucketMs:60_000,cooldownMs:policy.data.mail_cooldown_seconds*1000},
      {scope:'mail.operator.ip',identifier:meta.ip,limit:policy.data.mail_ip_per_hour,windowMs:3_600_000,bucketMs:60_000},
    ]);
    if(!quota.allowed)throw new AppError('RATE_LIMITED',{},quota.retryAfter);
    const replaced=(await tx.query<{id:string}>(`UPDATE one_time_credentials SET revoked_at=clock_timestamp()
      WHERE user_id=$1 AND purpose='bootstrap' AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id`,[userId])).rows.map(row=>row.id);
    const token=issueToken();const credentialId=randomUUID();const now=await databaseNow(tx);const expiresAt=new Date(now.getTime()+30*60_000);
    await tx.query(`INSERT INTO one_time_credentials(id,purpose,token_hash,user_id,subject_version,target_email,normalized_target_email,credential_epoch,expires_at)
      VALUES ($1,'bootstrap',$2,$3,$4,$5,$6,$7,$8)`,[credentialId,token.hash,userId,version,input.email,normalized,secrets.epoch,expiresAt]);
    await cancelCredentialTasks(tx,replaced,'CREDENTIAL_REPLACED');
    const branding=(await tx.query<{typed_value:{instance_name:string;default_locale:'zh-CN'|'en';timezone:string}}>("SELECT typed_value FROM system_settings WHERE key='branding'")).rows[0]!.typed_value;
    await enqueueMail(tx,secrets.mailKeyring,{eventId:credentialId,purpose:'bootstrap',credentialId,token:token.token,expiresAt:expiresAt.toISOString(),recipient:input.email,
      displayName:'Administrator',instanceName:branding.instance_name,locale:branding.default_locale,timeZone:branding.timezone});
    await appendAudit(tx,{actor:{type:'operator'},action:'ops.bootstrap.requested',target:{type:'user',id:userId!},result:'success',meta,changes:{after_version:version}});
    return {status:'pending' as const,mail_queued:true,operation_id:meta.requestId};
  });
}
/** Completes only a pre-issued local bootstrap; password hashing happens before the authority transaction. */
export async function completeBootstrap(pool:Pool,secrets:BootstrapSecrets,passwords:PasswordService,raw:unknown,metadata:RequestMeta,remainingBudgetMs=15_000) {
  const deadline=performance.now()+Math.min(15_000,remainingBudgetMs);
  const parsed=CompleteInvitationSchema.safeParse(raw);if(!parsed.success)throw new AppError('VALIDATION_ERROR');
  const input=parsed.data;const meta=requestMetaSchema.parse(metadata);
  const rate=await withTransaction(pool,'independent',tx=>consumeLimits(tx,secrets.digestKey,[{scope:'credential.bootstrap.ip',identifier:meta.ip,limit:20,windowMs:60_000,bucketMs:1000}]));
  if(!rate.allowed)throw new AppError('RATE_LIMITED',{},rate.retryAfter);
  const candidate=(await pool.query<{id:string;user_id:string}>("SELECT id,user_id FROM one_time_credentials WHERE purpose='bootstrap' AND token_hash=$1",[tokenDigest(input.token)])).rows[0];
  if(!candidate)throw new AppError('CREDENTIAL_INVALID');
  const minimum=await withTransaction(pool,'independent',passwordMinimum);
  const hash=await passwords.hash(input.password,minimum);
  if(deadline-performance.now()<8_000)throw new AppError('BUSY_RETRY',{},2);
  return withTransaction(pool,'exclusive',async tx=>{
    await lockIdentityRows(tx,[candidate.user_id],[superRole]);
    await tx.query('SELECT id FROM one_time_credentials WHERE id=$1 FOR UPDATE',[candidate.id]);
    const credential=await currentCredential(tx,{id:candidate.id,purpose:'bootstrap',token:input.token,epoch:secrets.epoch});
    if(!credential)throw new AppError('CREDENTIAL_INVALID');
    if([...input.password].length<await passwordMinimum(tx))throw new AppError('PASSWORD_REJECTED');
    const now=await databaseNow(tx);
    await tx.query(`UPDATE users SET status='active',email_verified_at=$2,password_hash=$3,password_version=password_version+1,
      authorization_version=authorization_version+1,version=version+1,display_name=$4,updated_at=$2 WHERE id=$1`,[candidate.user_id,now,hash,input.display_name]);
    await tx.query('INSERT INTO user_roles(user_id,role_id) VALUES ($1,$2)',[candidate.user_id,superRole]);
    const consumed=await tx.query(`UPDATE one_time_credentials SET consumed_at=$2 WHERE id=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp()`,[credential.id,now]);
    if(consumed.rowCount!==1)throw new AppError('CREDENTIAL_INVALID');
    const state=(await tx.query<{initialized:boolean}>('SELECT complete_bootstrap_state($1,$2,$3) AS initialized',[candidate.user_id,credential.id,credential.subject_version])).rows[0];
    if(!state?.initialized)throw new AppError('BOOTSTRAP_CLOSED');
    await cancelCredentialTasks(tx,[credential.id],'CREDENTIAL_CONSUMED');
    await appendAudit(tx,{actor:{type:'user',id:candidate.user_id},action:'ops.bootstrap.completed',target:{type:'user',id:candidate.user_id},result:'success',meta,changes:{role_ids_after:[superRole],status_before:'pending',status_after:'active'}});
    return {initialized:true as const,login_required:true as const};
  });
}

/** Cancels only a passwordless, unactivated local bootstrap and preserves its audit history. */
export async function cancelBootstrap(pool:Pool,raw:unknown,metadata:RequestMeta) {
  const parsed=z.strictObject({reason:text(1,500).refine(value=>value.trim().length>0)}).safeParse(raw);
  if(!parsed.success)throw new AppError('VALIDATION_ERROR');
  const meta=requestMetaSchema.parse(metadata);
  return withTransaction(pool,'exclusive',async tx=>{
    const state=(await tx.query<{initialization_status:string;bootstrap_user_id:string|null}>('SELECT initialization_status,bootstrap_user_id FROM system_state WHERE id=1')).rows[0]!;
    if(state.initialization_status==='initialized')throw new AppError('BOOTSTRAP_CLOSED');
    if(state.initialization_status==='uninitialized')return {status:'uninitialized' as const,operation_id:meta.requestId};
    const user=(await tx.query<{id:string}>(`SELECT id FROM users WHERE id=$1 AND status='pending' AND creation_source='bootstrap'
      AND password_hash IS NULL AND email_verified_at IS NULL FOR UPDATE`,[state.bootstrap_user_id])).rows[0];
    if(!user||(await tx.query('SELECT user_id FROM user_roles WHERE user_id=$1',[user.id])).rowCount||
      (await tx.query('SELECT user_id FROM sessions WHERE user_id=$1',[user.id])).rowCount)throw new AppError('BOOTSTRAP_CLOSED');
    const credentials=(await tx.query<{id:string}>('SELECT id FROM one_time_credentials WHERE user_id=$1 ORDER BY id FOR UPDATE',[user.id])).rows.map(row=>row.id);
    await cancelCredentialTasks(tx,credentials,'CREDENTIAL_REPLACED');
    await tx.query('UPDATE email_tasks SET credential_id=NULL WHERE credential_id=ANY($1::uuid[])',[credentials]);
    await tx.query('DELETE FROM one_time_credentials WHERE user_id=$1',[user.id]);
    await tx.query("UPDATE system_state SET initialization_status='uninitialized',bootstrap_user_id=NULL,bootstrap_version=bootstrap_version+1 WHERE id=1");
    await tx.query('DELETE FROM users WHERE id=$1',[user.id]);
    await appendAudit(tx,{actor:{type:'operator'},action:'ops.bootstrap.cancelled',target:{type:'user',id:user.id},result:'success',reason:parsed.data.reason,meta});
    return {status:'uninitialized' as const,operation_id:meta.requestId};
  });
}
