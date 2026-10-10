import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {Pool} from 'pg';
import {claimTasks,recoverExpiredLeases} from './outbox.js';
import {runDelivery,type DeliveryResult} from './worker.js';
import type {MailTransport} from './smtp.js';
export type WorkerEvent='ready'|'poll_failed'|'delivery_failed'|DeliveryResult;
/** A process owns two slots. All cross-process authority remains in PostgreSQL. */
export async function runMailWorker(pool:Pool,config:Parameters<typeof runDelivery>[1],transport:MailTransport,
  signal:AbortSignal,onEvent:(event:WorkerEvent)=>void):Promise<void> {
  const owner=randomUUID();
  const epochDigest=createHash('sha256').update(config.epoch).digest('hex');
  const heartbeat=()=>pool.query(`INSERT INTO worker_heartbeats(worker_id,last_seen_at,app_version,credential_epoch_digest)
    VALUES ($1,clock_timestamp(),'0.1.0',$2) ON CONFLICT(worker_id) DO UPDATE SET last_seen_at=clock_timestamp()`,[owner,epochDigest]);
  await recoverExpiredLeases(pool);await heartbeat();onEvent('ready');
  let nextHeartbeat=performance.now()+30_000,nextRecovery=performance.now()+60_000;
  const running=new Set<Promise<void>>();
  try {
    while(!signal.aborted){
      try{
        if(performance.now()>=nextHeartbeat){await heartbeat();nextHeartbeat=performance.now()+30_000;}
        if(performance.now()>=nextRecovery){await recoverExpiredLeases(pool);nextRecovery=performance.now()+60_000;}
        if(signal.aborted)break;
        const leases=await claimTasks(pool,owner,2-running.size);
        for(const lease of leases){
          const work=runDelivery(pool,config,transport,lease).then(result=>{onEvent(result);},()=>{onEvent('delivery_failed');});
          running.add(work);void work.finally(()=>running.delete(work));
        }
      }catch{onEvent('poll_failed');}
      if(!signal.aborted)await delay(1000,undefined,{signal}).catch(error=>{if(!signal.aborted)throw error;});
    }
  }finally{await Promise.allSettled(running);}
}
