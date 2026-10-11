import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import {CompleteInvitationSchema,TokenRequestSchema} from '@honocraft/contracts/common';
import {AppError} from '@honocraft/contracts/errors';
import {withTransaction,type Tx} from '../../infrastructure/db.js';
import {tokenDigest} from '../../infrastructure/crypto.js';
import {consumeLimits} from '../../infrastructure/rate-limit.js';
import type {PasswordService} from '../../infrastructure/passwords.js';
import {lockIdentityRows} from '../access/repository.js';
import {appendAudit,requestMetaSchema,type RequestMeta} from '../audit/writer.js';
import {appendSecurityEvent} from '../audit/security-writer.js';
import {currentCredential} from '../auth/credentials.js';
import {cancelCredentialTasks} from '../mail/cancellation.js';
import {loadPublicSettings} from '../settings/public.js';

type Envelope={id:string;invite_id:string;inviter_id:string;email:string;normalized_email:string;version:number;expires_at:Date};
function parse<S extends z.ZodType>(schema:S,raw:unknown):z.output<S>{const value=schema.safeParse(raw);if(!value.success)throw new AppError('VALIDATION_ERROR');return value.data;}
function checkBudget(deadline:number){if(deadline-performance.now()<8000)throw new AppError('BUSY_RETRY',{},2);}

export function createPublicInvitationService(pool:Pool,secrets:{epoch:string;digestKey:Buffer},passwords:PasswordService){
  async function settingsAt(tx:Tx){const settings=await loadPublicSettings(tx);if(!settings.initialized)throw new AppError('SYSTEM_NOT_INITIALIZED');return settings;}
  async function preflight(operation:'preview'|'accept',meta:RequestMeta){
    const result=await withTransaction(pool,'independent',async tx=>({settings:await settingsAt(tx),limit:await consumeLimits(tx,secrets.digestKey,[{scope:`auth.invite_${operation}.ip`,identifier:meta.ip,limit:20,windowMs:60000,bucketMs:1000}])}));
    if(!result.limit.allowed)throw new AppError('RATE_LIMITED',{},result.limit.retryAfter);return result.settings;
  }
  // This checks only the bearer envelope. Detailed rejection reasons must never precede it.
  async function envelope(tx:Tx,token:string):Promise<Envelope>{
    const row=(await tx.query<Envelope>(`SELECT c.id,c.invite_id,i.inviter_id,i.email,i.normalized_email,i.version,i.expires_at
      FROM one_time_credentials c JOIN invites i ON i.id=c.invite_id
      WHERE c.token_hash=$1 AND c.purpose='invite_accept' AND c.credential_epoch=$2
        AND c.consumed_at IS NULL AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp()
        AND c.subject_version=i.version AND c.normalized_target_email=i.normalized_email
        AND i.status='pending' AND i.expires_at>clock_timestamp()`,[tokenDigest(token),secrets.epoch])).rows[0];
    if(!row)throw new AppError('CREDENTIAL_INVALID');return row;
  }
  async function rejected<T>(meta:RequestMeta,work:()=>Promise<T>):Promise<T>{
    try{return await work();}catch(error){
      if(error instanceof AppError&&(error.code==='CREDENTIAL_INVALID'||error.code==='INVITE_REISSUE_REQUIRED'||error.code==='EMAIL_CONFLICT')){
        const code=error.code;
        try{await withTransaction(pool,'independent',tx=>appendSecurityEvent(tx,{userId:null,type:'auth.credential_rejected',result:'denied',reasonCode:code,targetDigest:null,meta}));}
        catch{console.error('Failed to persist sanitized invitation rejection');}
      }
      throw error;
    }
  }
  async function preview(raw:unknown,metadata:RequestMeta,remaining=15000){
    const deadline=performance.now()+Math.min(15000,remaining),input=parse(TokenRequestSchema,raw),meta=requestMetaSchema.parse(metadata);
    return rejected(meta,async()=>{
      await preflight('preview',meta);checkBudget(deadline);
      return withTransaction(pool,'read',async tx=>{
        const settings=await settingsAt(tx),found=await envelope(tx,input.token);
        if(!await currentCredential(tx,{id:found.id,purpose:'invite_accept',token:input.token,epoch:secrets.epoch}))throw new AppError('CREDENTIAL_INVALID');
        return {instance_name:settings.instance_name,email:found.email,expires_at:found.expires_at.toISOString()};
      });
    });
  }
  async function accept(raw:unknown,metadata:RequestMeta,remaining=15000){
    const deadline=performance.now()+Math.min(15000,remaining),input=parse(CompleteInvitationSchema,raw),meta=requestMetaSchema.parse(metadata);
    return rejected(meta,async()=>{
      const initial=await preflight('accept',meta);
      // Invalid links do not spend a password-hashing slot; this read is never final authorization.
      await withTransaction(pool,'read',tx=>envelope(tx,input.token));checkBudget(deadline);
      const hash=await passwords.hash(input.password,initial.password_min_length);checkBudget(deadline);
      try{return await withTransaction(pool,'exclusive',async tx=>{
        const found=await envelope(tx,input.token);
        const roleIds=(await tx.query<{role_id:string|null}>('SELECT role_id FROM invite_roles WHERE invite_id=$1 ORDER BY role_id',[found.invite_id])).rows.flatMap(row=>row.role_id?[row.role_id]:[]);
        const occupied=(await tx.query<{id:string}>('SELECT id FROM users WHERE normalized_email=$1',[found.normalized_email])).rows[0];
        await lockIdentityRows(tx,[found.inviter_id,...(occupied?[occupied.id]:[])],roleIds);
        await tx.query('SELECT id FROM invites WHERE id=$1 FOR UPDATE',[found.invite_id]);
        await tx.query('SELECT id FROM one_time_credentials WHERE invite_id=$1 ORDER BY id FOR UPDATE',[found.invite_id]);
        await envelope(tx,input.token);
        if(occupied)throw new AppError('EMAIL_CONFLICT');
        if(!await currentCredential(tx,{id:found.id,purpose:'invite_accept',token:input.token,epoch:secrets.epoch}))throw new AppError('INVITE_REISSUE_REQUIRED');
        const settings=await settingsAt(tx);if([...input.password].length<settings.password_min_length)throw new AppError('PASSWORD_REJECTED');
        const id=randomUUID();
        await tx.query(`INSERT INTO users(id,email,normalized_email,display_name,password_hash,status,email_verified_at,creation_source)
          VALUES($1,$2,$3,$4,$5,'active',clock_timestamp(),'invitation')`,[id,found.email,found.normalized_email,input.display_name,hash]);
        await tx.query('INSERT INTO user_roles(user_id,role_id) SELECT $1,role_id FROM invite_roles WHERE invite_id=$2',[id,found.invite_id]);
        const consumed=await tx.query('UPDATE one_time_credentials SET consumed_at=clock_timestamp() WHERE id=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp()',[found.id]);
        if(consumed.rowCount!==1)throw new AppError('CREDENTIAL_INVALID');
        const accepted=await tx.query(`UPDATE invites SET status='accepted',version=version+1,accepted_by=$2,accepted_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE id=$1 AND status='pending' AND version=$3 AND expires_at>clock_timestamp()`,[found.invite_id,id,found.version]);
        if(accepted.rowCount!==1)throw new AppError('CREDENTIAL_INVALID');
        await tx.query('UPDATE invite_roles SET role_id=NULL WHERE invite_id=$1',[found.invite_id]);
        const revoked=await tx.query<{id:string}>('UPDATE one_time_credentials SET revoked_at=clock_timestamp() WHERE invite_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id',[found.invite_id]);
        await cancelCredentialTasks(tx,[found.id,...revoked.rows.map(row=>row.id)],'CREDENTIAL_CONSUMED');
        await appendAudit(tx,{actor:{type:'user',id},action:'invitations.invite.accepted',target:{type:'invite',id:found.invite_id},result:'success',meta,changes:{before_version:found.version,after_version:found.version+1,status_before:'pending',status_after:'accepted',role_ids_after:roleIds}});
        return {accepted:true as const,login_required:true as const};
      });}catch(error){
        if(error&&typeof error==='object'&&'code' in error&&error.code==='23505'&&'constraint' in error&&error.constraint==='users_normalized_email_key')throw new AppError('EMAIL_CONFLICT');
        throw error;
      }
    });
  }
  return {preview,accept};
}
