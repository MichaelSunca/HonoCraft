import {setTimeout as delay} from 'node:timers/promises';
import type {Pool} from 'pg';
import {withTransaction} from '../../infrastructure/db.js';
export type ExpiryCounts={invites:number;email_changes:number;credentials:number};
type ExpiryEvent={event:'started'|'failed'}|({event:'completed'}&ExpiryCounts);
const commands=[
  ['invites','SELECT expire_pending_invites(100) AS count'],
  ['email_changes','SELECT expire_email_change_requests(100) AS count'],
  ['credentials','SELECT expire_one_time_credentials(100) AS count'],
] as const;
/** Functions own the coordinator and subject locks; release the transaction between bounded batches. */
export async function expireDueObjects(pool:Pool,signal?:AbortSignal):Promise<ExpiryCounts>{
  const counts:ExpiryCounts={invites:0,email_changes:0,credentials:0};
  for(const [kind,command] of commands){
    let count:number;
    do{
      if(signal?.aborted)return counts;
      count=await withTransaction(pool,'independent',async tx=>(await tx.query<{count:number}>(command)).rows[0]!.count);
      counts[kind]+=count;
    }while(count===100);
  }
  return counts;
}
export async function runExpiryWorker(pool:Pool,signal:AbortSignal,onEvent:(event:ExpiryEvent)=>void):Promise<void>{
  while(!signal.aborted){
    onEvent({event:'started'});
    try{onEvent({event:'completed',...await expireDueObjects(pool,signal)});}catch{onEvent({event:'failed'});}
    if(!signal.aborted)await delay(60_000,undefined,{signal}).catch(error=>{if(!signal.aborted)throw error;});
  }
}
