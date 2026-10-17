import {setTimeout as delay} from 'node:timers/promises';
import type {Pool} from 'pg';
import {pruneBatch,type RetentionOptions,type RetentionTask} from './retention.js';
export type RetentionScope='runtime'|'logs';
export type RetentionCounts=Partial<Record<RetentionTask,number>>;
export type RetentionEvent={scope:RetentionScope;event:'started'|'failed'}|{scope:RetentionScope;event:'completed';counts:RetentionCounts;interrupted:boolean};
const tasks={runtime:['mail','task_links','credentials','sessions','idempotency','rate_limits','heartbeats'],logs:['audit','security']} as const;
const hour=3_600_000,day=24*hour;
/** Every batch commits and releases its connection before the next one starts. */
export async function pruneRetainedRecords(pool:Pool,scope:RetentionScope,options:RetentionOptions={},signal?:AbortSignal):Promise<RetentionCounts>{
  const counts:RetentionCounts={};
  for(const task of tasks[scope]){
    let count:number;
    do{
      if(signal?.aborted)return counts;
      count=await pruneBatch(pool,task,options);counts[task]=(counts[task]??0)+count;
    }while(count===(options.batchSize??1000));
  }
  return counts;
}
export async function runRetentionWorker(pool:Pool,options:RetentionOptions,signal:AbortSignal,onEvent:(event:RetentionEvent)=>void):Promise<void>{
  let nextLogs=0;
  while(!signal.aborted){
    for(const scope of ['runtime','logs'] as const){
      if(signal.aborted)break;
      if(scope==='logs'&&performance.now()<nextLogs)continue;
      onEvent({scope,event:'started'});
      try{
        const counts=await pruneRetainedRecords(pool,scope,options,signal);
        onEvent({scope,event:'completed',counts,interrupted:signal.aborted});
        if(scope==='logs'&&!signal.aborted)nextLogs=performance.now()+day;
      }catch{onEvent({scope,event:'failed'});}
    }
    if(!signal.aborted)await delay(hour,undefined,{signal}).catch(error=>{if(!signal.aborted)throw error;});
  }
}
