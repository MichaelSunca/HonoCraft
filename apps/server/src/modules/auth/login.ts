import type { Pool } from 'pg';
import { z } from 'zod';
import { LoginSchema, normalizeEmail } from '@honocraft/contracts/common';
import { AppError } from '@honocraft/contracts/errors';
import { databaseNow, withTransaction, type Tx } from '../../infrastructure/db.js';
import { issueToken, keyedDigest } from '../../infrastructure/crypto.js';
import type { PasswordService } from '../../infrastructure/passwords.js';
import { accountFailureState, consumeLimits } from '../../infrastructure/rate-limit.js';
import { lockIdentityRows } from '../access/repository.js';
import { appendAudit, requestMetaSchema, type RequestMeta } from '../audit/writer.js';
import { appendSecurityEvent } from '../audit/security-writer.js';

const policySchema=z.object({
  session_idle_minutes:z.number().int().min(5).max(30),session_absolute_minutes:z.number().int().min(30).max(480),
  login_ip_per_minute:z.number().int().min(1).max(20),account_failures_per_window:z.number().int().min(1).max(5),
  account_lock_minutes:z.number().int().min(15).max(60),
});
async function policyAt(tx:Tx) {
  const row=(await tx.query<{typed_value:unknown;initialization_status:string}>(`SELECT typed_value,initialization_status
    FROM system_settings CROSS JOIN system_state WHERE key='security' AND id=1`)).rows[0];
  if(row?.initialization_status!=='initialized')throw new AppError('SYSTEM_NOT_INITIALIZED');
  const parsed=policySchema.safeParse(row.typed_value);
  if(!parsed.success)throw new AppError('DEPENDENCY_UNAVAILABLE');
  return parsed.data;
}
type Candidate={id:string;password_hash:string|null;password_version:number};
type CurrentUser=Candidate&{status:string;email_verified_at:Date|null;authorization_version:number;creation_source:string;normalized_email:string};
export function createLoginService(pool:Pool,secrets:{epoch:string;digestKey:Buffer},passwords:PasswordService) {
  return async function login(raw:unknown,metadata:RequestMeta,remainingBudgetMs=15_000):Promise<{token:string;sessionId:string}> {
    const deadline=performance.now()+Math.min(15_000,remainingBudgetMs);
    const parsed=LoginSchema.safeParse(raw);
    if(!parsed.success)throw new AppError('VALIDATION_ERROR');
    const input=parsed.data;const email=normalizeEmail(input.email);const meta=requestMetaSchema.parse(metadata);
    const targetDigest=keyedDigest(secrets.digestKey,'honocraft.security-target.v1',email);
    const initialPolicy=await withTransaction(pool,'independent',async tx=>{
      const policy=await policyAt(tx);
      const limit=await consumeLimits(tx,secrets.digestKey,[{scope:'login.ip',identifier:meta.ip,limit:policy.login_ip_per_minute,windowMs:60_000,bucketMs:1000}]);
      return {policy,limit};
    });
    // The source debit is already committed and is not rolled back by a failed password check.
    if(!initialPolicy.limit.allowed)throw new AppError('RATE_LIMITED',{},initialPolicy.limit.retryAfter);
    const candidate=(await pool.query<Candidate>('SELECT id,password_hash,password_version FROM users WHERE normalized_email=$1',[email])).rows[0];
    if(deadline-performance.now()<8_000)throw new AppError('BUSY_RETRY',{},2);
    const matches=await passwords.verify(candidate?.password_hash??null,input.password);
    if(deadline-performance.now()<8_000)throw new AppError('BUSY_RETRY',{},2);
    if(!matches) {
      await withTransaction(pool,'shared',async tx=>{
        if(candidate)await lockIdentityRows(tx,[candidate.id]);
        const policy=await policyAt(tx);
        const failure=await accountFailureState(tx,secrets.digestKey,email,'failure',{
          limit:policy.account_failures_per_window,windowMs:900_000,lockMs:policy.account_lock_minutes*60_000,
        });
        if(candidate)await tx.query('UPDATE users SET locked_until=$2 WHERE id=$1',[candidate.id,failure.lockedUntil]);
        await appendSecurityEvent(tx,{userId:candidate?.id??null,type:'auth.login',result:'denied',reasonCode:'AUTH_FAILED',targetDigest,meta});
      });
      throw new AppError('AUTH_FAILED');
    }
    if(!candidate)throw new AppError('AUTH_FAILED');
    try {
      return await withTransaction(pool,'shared',async tx=>{
        await lockIdentityRows(tx,[candidate.id]);
        const policy=await policyAt(tx);
        const current=(await tx.query<CurrentUser>(`SELECT id,password_hash,password_version,status,email_verified_at,
          authorization_version,creation_source,normalized_email FROM users WHERE id=$1`,[candidate.id])).rows[0];
        if(!current||current.password_hash!==candidate.password_hash||current.password_version!==candidate.password_version||current.normalized_email!==email)throw new AppError('AUTH_FAILED');
        const accountPolicy={limit:policy.account_failures_per_window,windowMs:900_000,lockMs:policy.account_lock_minutes*60_000};
        const state=await accountFailureState(tx,secrets.digestKey,email,'inspect',accountPolicy);
        if(state.lockedUntil)throw new AppError('AUTH_FAILED');
        if(current.status==='pending'&&current.creation_source==='registration')throw new AppError('EMAIL_VERIFICATION_REQUIRED');
        if(current.status!=='active'||!current.email_verified_at)throw new AppError('AUTH_FAILED');
        const now=await databaseNow(tx);
        const issued=issueToken();
        const session=(await tx.query<{id:string}>(`INSERT INTO sessions(user_id,token_hash,authorization_version,credential_epoch,
          created_at,last_seen_at,idle_expires_at,absolute_expires_at,ip,user_agent) VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9) RETURNING id`,[
          current.id,issued.hash,current.authorization_version,secrets.epoch,now,new Date(now.getTime()+policy.session_idle_minutes*60_000),
          new Date(now.getTime()+policy.session_absolute_minutes*60_000),meta.ip,meta.userAgent,
        ])).rows[0]!;
        await tx.query('UPDATE users SET last_login_at=$2,locked_until=NULL WHERE id=$1',[current.id,now]);
        await accountFailureState(tx,secrets.digestKey,email,'success',accountPolicy);
        await appendSecurityEvent(tx,{userId:current.id,type:'auth.login',result:'success',reasonCode:null,targetDigest,meta});
        await appendAudit(tx,{actor:{type:'user',id:current.id},action:'auth.session.created',target:{type:'session',id:session.id},result:'success',meta});
        return {token:issued.token,sessionId:session.id};
      });
    } catch(error) {
      if(error instanceof AppError&&(error.code==='AUTH_FAILED'||error.code==='EMAIL_VERIFICATION_REQUIRED')) {
        try {
          await withTransaction(pool,'independent',tx=>appendSecurityEvent(tx,{userId:candidate.id,type:'auth.login',result:'denied',reasonCode:error.code as 'AUTH_FAILED'|'EMAIL_VERIFICATION_REQUIRED',targetDigest,meta}));
        } catch {console.error('Failed to persist sanitized login failure event');}
      }
      throw error;
    }
  };
}
