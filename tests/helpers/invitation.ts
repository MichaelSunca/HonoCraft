import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {identity} from './identity.js';
import {issueToken} from '../../apps/server/src/infrastructure/crypto.js';

/** Persist an issued invitation without exercising the management use case under test. */
export async function invitation(pool:Pool,options:{epoch?:string;roles?:string[];inviterRole?:string;email?:string}={}){
  const inviter=await identity(pool,options.inviterRole??'admin'),id=randomUUID(),credentialId=randomUUID(),issued=issueToken();
  const email=options.email??`${id}@example.test`,epoch=options.epoch??'test-epoch';
  await pool.query("INSERT INTO invites(id,email,normalized_email,inviter_id,expires_at) VALUES($1,$2::text,lower($2::text),$3,clock_timestamp()+interval '1 day')",[id,email,inviter.userId]);
  await pool.query(`INSERT INTO invite_roles(invite_id,role_id,role_id_at_issue,role_code,role_name,role_version_at_issue)
    SELECT $1,id,id,code,name,version FROM roles WHERE code=ANY($2::text[])`,[id,options.roles??['user']]);
  await pool.query(`INSERT INTO one_time_credentials(id,purpose,token_hash,invite_id,subject_version,target_email,normalized_target_email,credential_epoch,expires_at)
    SELECT $1,'invite_accept',$2,id,version,email,normalized_email,$4,expires_at FROM invites WHERE id=$3`,[credentialId,issued.hash,id,epoch]);
  return {id,credentialId,token:issued.token,email,inviter};
}
