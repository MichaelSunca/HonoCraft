import { randomInt,randomUUID,timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { normalizeEmail } from '@honocraft/contracts/common';
import { databaseNow,withTransaction,type Tx } from '../../infrastructure/db.js';
import { encryptPayload,tokenDigest,type Keyring } from '../../infrastructure/crypto.js';
import { mailPayloadSchema,type MailPayload } from './templates.js';
export type MailLease=Readonly<{id:string;leaseOwner:string;leaseVersion:number;attempts:number}>;
export type ClaimedTask={id:string;purpose:MailPayload['purpose'];recipient:string;credential_id:string|null;locale:string;template_version:number;payload_ciphertext:Buffer;nonce:Buffer;auth_tag:Buffer;key_id:string};
export const mailAad=(id:string,purpose:string,version:number)=>JSON.stringify(['honocraft.mail.v1',id,purpose,version]);
export async function enqueueMail(tx:Tx,keyring:Keyring,input:unknown):Promise<string> {
  const {eventId,credentialId,...raw}=z.record(z.string(),z.unknown()).parse(input);
  const eventKey=`${z.uuid().parse(eventId)}:${String(raw.purpose)}`;
  const payload=mailPayloadSchema.parse(raw);
  if('token' in payload){
    const id=z.uuid().parse(credentialId);
    const credential=(await tx.query<{token_hash:Buffer;purpose:string;normalized_target_email:string;expires_at:Date}>(`SELECT token_hash,purpose,normalized_target_email,expires_at FROM one_time_credentials WHERE id=$1`,[id])).rows[0];
    if(!credential||credential.purpose!==payload.purpose||credential.normalized_target_email!==normalizeEmail(payload.recipient)||credential.expires_at.getTime()!==new Date(payload.expiresAt).getTime()||!timingSafeEqual(credential.token_hash,tokenDigest(payload.token)))throw new Error('MAIL_CREDENTIAL_MISMATCH');
  }else if(credentialId!==undefined)throw new Error('MAIL_CREDENTIAL_UNEXPECTED');
  const id=randomUUID();const encrypted=encryptPayload(keyring,JSON.stringify(payload),mailAad(id,payload.purpose,1));
  const [local,domain]=payload.recipient.split('@');
  const inserted=await tx.query<{id:string}>(`INSERT INTO email_tasks(id,event_key,purpose,recipient,recipient_masked,credential_id,payload_ciphertext,nonce,auth_tag,key_id,locale)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(event_key) DO NOTHING RETURNING id`,[
    id,eventKey,payload.purpose,payload.recipient,`${local!.slice(0,1)}***@${domain}`,credentialId??null,encrypted.ciphertext,encrypted.nonce,encrypted.tag,encrypted.keyId,payload.locale,
  ]);
  return inserted.rows[0]?.id??(await tx.query<{id:string}>('SELECT id FROM email_tasks WHERE event_key=$1',[eventKey])).rows[0]!.id;
}
export async function claimTasks(pool:Pool,owner:string,availableSlots:number):Promise<MailLease[]> {
  z.uuid().parse(owner);
  if(!Number.isInteger(availableSlots)||availableSlots<0||availableSlots>2)throw new Error('MAIL_CONCURRENCY_INVALID');
  if(availableSlots===0)return [];
  return withTransaction(pool,'independent',async tx=>{
    const result=await tx.query<MailLease>(`WITH candidates AS (SELECT id FROM email_tasks WHERE status='queued' AND attempts<3
      AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)
      UPDATE email_tasks t SET status='sending',attempts=attempts+1,lease_owner=$1,lease_version=lease_version+1,
        lease_expires_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp()
      FROM candidates c WHERE t.id=c.id RETURNING t.id,t.lease_owner AS "leaseOwner",t.lease_version AS "leaseVersion",t.attempts`,[owner,availableSlots]);
    return result.rows;
  });
}
export async function readClaimedTask(pool:Pool,lease:MailLease):Promise<ClaimedTask|null> {
  return (await pool.query<ClaimedTask>(`SELECT id,purpose,recipient,credential_id,locale,template_version,payload_ciphertext,nonce,auth_tag,key_id
    FROM email_tasks WHERE id=$1 AND status='sending' AND lease_owner=$2 AND lease_version=$3 AND lease_expires_at>clock_timestamp()`,[lease.id,lease.leaseOwner,lease.leaseVersion])).rows[0]??null;
}
export type DeliveryOutcome={kind:'sent';messageId:string}|{kind:'retry';code:'SMTP_TEMPORARY'|'SMTP_TIMEOUT'|'SMTP_CONNECTION'}|
  {kind:'failed';code:'SMTP_REJECTED'|'PAYLOAD_INVALID'}|{kind:'cancelled';code:'CREDENTIAL_INVALID'};
export async function finishTask(pool:Pool,lease:MailLease,outcome:DeliveryOutcome):Promise<boolean> {
  return withTransaction(pool,'independent',async tx=>{
    const row=(await tx.query<{status:string;lease_owner:string|null;lease_version:number;lease_expires_at:Date|null;attempts:number}>('SELECT status,lease_owner,lease_version,lease_expires_at,attempts FROM email_tasks WHERE id=$1 FOR UPDATE',[lease.id])).rows[0];
    const now=await databaseNow(tx);
    if(!row||row.status!=='sending'||row.lease_owner!==lease.leaseOwner||row.lease_version!==lease.leaseVersion||!row.lease_expires_at||row.lease_expires_at<=now)return false;
    const retry=outcome.kind==='retry'&&row.attempts<3;
    const status=retry?'queued':outcome.kind==='retry'?'failed':outcome.kind;
    const code=outcome.kind==='sent'?null:outcome.kind==='retry'&&!retry?(outcome.code==='SMTP_TIMEOUT'?'DELIVERY_UNKNOWN':'RETRY_EXHAUSTED'):outcome.code;
    const next=retry?new Date(now.getTime()+(row.attempts===1?60+randomInt(11):300+randomInt(31))*1000):now;
    const messageId=outcome.kind==='sent'&&/^[A-Za-z0-9_.@<>-]{1,200}$/.test(outcome.messageId)?outcome.messageId:null;
    const result=await tx.query(`UPDATE email_tasks SET status=$4,error_code=$5,provider_message_id=$6,next_attempt_at=$7,
      updated_at=$8,lease_owner=NULL,lease_expires_at=NULL,
      recipient=CASE WHEN $9 THEN recipient ELSE NULL END,payload_ciphertext=CASE WHEN $9 THEN payload_ciphertext ELSE NULL END,
      nonce=CASE WHEN $9 THEN nonce ELSE NULL END,auth_tag=CASE WHEN $9 THEN auth_tag ELSE NULL END,key_id=CASE WHEN $9 THEN key_id ELSE NULL END
      WHERE id=$1 AND status='sending' AND lease_owner=$2 AND lease_version=$3 AND lease_expires_at>clock_timestamp()`,
    [lease.id,lease.leaseOwner,lease.leaseVersion,status,code,messageId,next,now,retry]);
    return result.rowCount===1;
  });
}
export async function recoverExpiredLeases(pool:Pool):Promise<number> {
  return withTransaction(pool,'independent',async tx=>{
    const result=await tx.query(`WITH expired AS (SELECT id FROM email_tasks WHERE status='sending' AND lease_expires_at<=clock_timestamp()
      ORDER BY lease_expires_at,id LIMIT 100 FOR UPDATE SKIP LOCKED)
      UPDATE email_tasks t SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,
      error_code=CASE WHEN attempts>=3 THEN 'DELIVERY_UNKNOWN' ELSE 'LEASE_EXPIRED' END,
      next_attempt_at=clock_timestamp()+make_interval(secs=>CASE WHEN attempts=1 THEN 60+floor(random()*11)::int ELSE 300+floor(random()*31)::int END),
      updated_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL,lease_version=lease_version+1,
      recipient=CASE WHEN attempts>=3 THEN NULL ELSE recipient END,payload_ciphertext=CASE WHEN attempts>=3 THEN NULL ELSE payload_ciphertext END,
      nonce=CASE WHEN attempts>=3 THEN NULL ELSE nonce END,auth_tag=CASE WHEN attempts>=3 THEN NULL ELSE auth_tag END,key_id=CASE WHEN attempts>=3 THEN NULL ELSE key_id END
      FROM expired e WHERE t.id=e.id`);
    return result.rowCount??0;
  });
}
