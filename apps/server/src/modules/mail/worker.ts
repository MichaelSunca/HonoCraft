import type {Pool} from 'pg';
import {withTransaction} from '../../infrastructure/db.js';
import {decryptPayload,type Keyring} from '../../infrastructure/crypto.js';
import {currentCredential} from '../auth/credentials.js';
import {mailPayloadSchema,renderMail,type MailPayload} from './templates.js';
import {mailAad,readClaimedTask,finishTask,type MailLease,type DeliveryOutcome} from './outbox.js';
import type {MailTransport} from './smtp.js';
export type DeliveryResult='sent'|'queued'|'failed'|'cancelled'|'lease_lost';
export async function runDelivery(pool:Pool,config:{origin:string;epoch:string;keyring:Keyring},transport:MailTransport,lease:MailLease):Promise<DeliveryResult> {
  const task=await readClaimedTask(pool,lease);if(!task)return 'lease_lost';
  const complete=async(outcome:DeliveryOutcome):Promise<DeliveryResult>=>{
    if(!await finishTask(pool,lease,outcome))return 'lease_lost';
    return outcome.kind==='retry'?(lease.attempts<3?'queued':'failed'):outcome.kind;
  };
  let payload:MailPayload;
  try{
    if(task.template_version!==1)throw new Error('TEMPLATE_UNSUPPORTED');
    payload=mailPayloadSchema.parse(JSON.parse(decryptPayload(config.keyring,{keyId:task.key_id,nonce:task.nonce,tag:task.auth_tag,ciphertext:task.payload_ciphertext},mailAad(task.id,task.purpose,task.template_version))));
    if(payload.purpose!==task.purpose||payload.recipient!==task.recipient||payload.locale!==task.locale||('token' in payload)!==(task.credential_id!==null))throw new Error('MAIL_ENVELOPE_MISMATCH');
  }catch{return complete({kind:'failed',code:'PAYLOAD_INVALID'});}
  if('token' in payload){
    const credentialPayload=payload;
    const valid=await withTransaction(pool,'read',tx=>currentCredential(tx,{id:task.credential_id!,purpose:task.purpose,token:credentialPayload.token,epoch:config.epoch}));
    if(!valid)return complete({kind:'cancelled',code:'CREDENTIAL_INVALID'});
  }
  let rendered:ReturnType<typeof renderMail>;
  try{rendered=renderMail(config.origin,payload);}catch{return complete({kind:'failed',code:'PAYLOAD_INVALID'});}
  if(!await readClaimedTask(pool,lease))return 'lease_lost';
  // All DB transactions have finished. SMTP must never hold authority or task locks.
  let outcome:DeliveryOutcome;
  try{outcome=await transport.send({to:payload.recipient,...rendered,messageId:`<${task.id}@honocraft.invalid>`});}
  catch{outcome={kind:'retry',code:'SMTP_CONNECTION'};}
  return complete(outcome);
}
