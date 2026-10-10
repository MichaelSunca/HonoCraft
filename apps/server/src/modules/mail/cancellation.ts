import type {Tx} from '../../infrastructure/db.js';
export async function cancelCredentialTasks(tx:Tx,credentialIds:readonly string[],reason:'CREDENTIAL_REPLACED'|'CREDENTIAL_CONSUMED'|'USER_STATE_CHANGED'):Promise<void> {
  if(!credentialIds.length)return;
  await tx.query(`UPDATE email_tasks SET status='cancelled',error_code=$2,lease_owner=NULL,lease_expires_at=NULL,lease_version=lease_version+1,
    recipient=NULL,payload_ciphertext=NULL,nonce=NULL,auth_tag=NULL,key_id=NULL,updated_at=clock_timestamp()
    WHERE credential_id=ANY($1::uuid[]) AND status IN ('queued','sending')`,[credentialIds,reason]);
}
