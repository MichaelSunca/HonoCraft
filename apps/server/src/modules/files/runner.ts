import {setTimeout as delay} from 'node:timers/promises';
import type {Pool} from 'pg';
import {cleanupFiles,cleanupLooseFiles,type CleanupResult} from './cleanup.js';
type CleanupEvent=({event:'cleanup_completed'}&CleanupResult)|({event:'loose_cleanup_completed';deleted:number;failed:number})|{event:'cleanup_failed'};
/** Startup recovery and hourly collection run separately from the SMTP delivery loop. */
export async function runFileCleanup(pool:Pool,root:string,signal:AbortSignal,onEvent:(event:CleanupEvent)=>void):Promise<void>{
  while(!signal.aborted){
    try{
      let result:CleanupResult;
      do{result=await cleanupFiles(pool,root,{signal});onEvent({event:'cleanup_completed',...result});}
      while(!signal.aborted&&result.claimed===100&&result.deleted>0);
      if(!signal.aborted){const loose=await cleanupLooseFiles(pool,root,{signal});onEvent({event:'loose_cleanup_completed',...loose});}
    }catch{onEvent({event:'cleanup_failed'});}
    if(!signal.aborted)await delay(60*60_000,undefined,{signal}).catch(error=>{if(!signal.aborted)throw error;});
  }
}
