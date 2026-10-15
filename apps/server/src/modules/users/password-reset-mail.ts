import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {AppError} from '@honocraft/contracts/errors';
import {databaseNow,type Tx} from '../../infrastructure/db.js';
import {issueToken,keyedDigest,type Keyring} from '../../infrastructure/crypto.js';
import {consumeLimits} from '../../infrastructure/rate-limit.js';
import type {RequestMeta} from '../audit/writer.js';
import {appendSecurityEvent} from '../audit/security-writer.js';
import {cancelCredentialTasks} from '../mail/cancellation.js';
import {enqueueMail} from '../mail/outbox.js';
import {loadPublicSettings} from '../settings/public.js';

const policySchema=z.object({password_reset_minutes:z.number().int().min(10).max(60),mail_cooldown_seconds:z.number().int().min(60).max(3600),mail_target_per_hour:z.number().int().min(1).max(5),mail_ip_per_hour:z.number().int().min(1).max(20)});
type Recipient={id:string;email:string;normalized_email:string;display_name:string;locale:'en'|'zh-CN'|null};
/** Caller has locked and authorized the target; issuance does not alter password or sessions. */
export async function issueManagedPasswordReset(tx:Tx,user:Recipient,authorizationVersion:number,secrets:{epoch:string;digestKey:{key:Buffer};mailKeyring:Keyring},meta:RequestMeta){
  const row=(await tx.query<{typed_value:unknown}>("SELECT typed_value FROM system_settings WHERE key='security'")).rows[0];
  const parsed=policySchema.safeParse(row?.typed_value);if(!parsed.success)throw new AppError('DEPENDENCY_UNAVAILABLE');const policy=parsed.data;
  const limit=await consumeLimits(tx,secrets.digestKey.key,[
    {scope:'mail.source.ip',identifier:meta.ip,limit:policy.mail_ip_per_hour,windowMs:3600000,bucketMs:60000},
    {scope:'mail.target.password_reset',identifier:user.normalized_email,limit:policy.mail_target_per_hour,windowMs:3600000,bucketMs:60000,cooldownMs:policy.mail_cooldown_seconds*1000},
  ]);
  if(!limit.allowed)throw new AppError('RATE_LIMITED',{},limit.retryAfter);
  await tx.query("SELECT id FROM one_time_credentials WHERE user_id=$1 AND purpose='password_reset' ORDER BY id FOR UPDATE",[user.id]);
  const revoked=(await tx.query<{id:string}>("UPDATE one_time_credentials SET revoked_at=clock_timestamp() WHERE user_id=$1 AND purpose='password_reset' AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id",[user.id])).rows.map(row=>row.id);
  await cancelCredentialTasks(tx,revoked,'CREDENTIAL_REPLACED');
  const issued=issueToken(),id=randomUUID(),now=await databaseNow(tx),expires=new Date(now.getTime()+policy.password_reset_minutes*60000);
  await tx.query(`INSERT INTO one_time_credentials(id,purpose,token_hash,user_id,subject_version,target_email,normalized_target_email,credential_epoch,expires_at)
    VALUES($1,'password_reset',$2,$3,$4,$5,$6,$7,$8)`,[id,issued.hash,user.id,authorizationVersion,user.email,user.normalized_email,secrets.epoch,expires]);
  const settings=await loadPublicSettings(tx);
  await enqueueMail(tx,secrets.mailKeyring,{eventId:id,credentialId:id,purpose:'password_reset',token:issued.token,recipient:user.email,displayName:user.display_name,instanceName:settings.instance_name,locale:user.locale??settings.default_locale,timeZone:settings.timezone,expiresAt:expires.toISOString()});
  await appendSecurityEvent(tx,{userId:user.id,type:'auth.mail_request',result:'success',reasonCode:null,targetDigest:keyedDigest(secrets.digestKey.key,'honocraft.security-target.v1',user.normalized_email),meta});
}
