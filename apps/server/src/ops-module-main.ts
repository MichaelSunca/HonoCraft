import {existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {AppError} from '@honocraft/contracts/errors';
import {text} from '@honocraft/contracts/common';
import {ConfigurationError,loadConfig} from './infrastructure/config.js';
import {createDatabase,type Database} from './infrastructure/db.js';
import {checkDatabaseCompatibility} from './infrastructure/startup.js';
import {setExampleNotesEnabled} from './modules/example-notes/catalog.js';
const operationId=randomUUID();let database:Database|undefined;
try{
  const args=process.argv.slice(2);if(args[0]==='--')args.shift();
  let enabled:boolean|undefined,reason:string|undefined;
  for(const arg of args){
    if(arg==='--enable=example-notes'||arg==='--disable=example-notes'){
      if(enabled!==undefined)throw new ConfigurationError(['OPS_MODULE_ARGUMENTS']);enabled=arg==='--enable=example-notes';
    }else if(arg.startsWith('--reason=')&&reason===undefined)reason=arg.slice('--reason='.length);
    else throw new ConfigurationError(['OPS_MODULE_ARGUMENTS']);
  }
  const parsed=text(1,500).refine(value=>value.trim().length>0).safeParse(reason);
  if(enabled===undefined||!parsed.success)throw new ConfigurationError(['OPS_MODULE_ARGUMENTS']);
  if(existsSync('.env')){try{process.loadEnvFile('.env');}catch{throw new ConfigurationError(['ENV_FILE']);}}
  if(!process.env.MIGRATION_DATABASE_URL)throw new ConfigurationError(['MIGRATION_DATABASE_URL']);
  const config=loadConfig({...process.env,DATABASE_URL:process.env.MIGRATION_DATABASE_URL,MIGRATION_DATABASE_URL:undefined,MAINTENANCE_DATABASE_URL:undefined,WORKER_DATABASE_URL:undefined});
  database=createDatabase(config.databaseUrl,2);
  const state=(await database.pool.query<{example_notes_enabled:boolean}>('SELECT example_notes_enabled FROM system_state WHERE id=1')).rows[0];
  if(!state)throw new Error('DATABASE_SCHEMA_INCOMPATIBLE');
  // Validate the installed state, then transition explicitly; never infer a catalog write from env.
  await checkDatabaseCompatibility(database.pool,state.example_notes_enabled);
  const result=await setExampleNotesEnabled(database.pool,{enabled,reason:parsed.data},{requestId:operationId,ip:'127.0.0.1',userAgent:'honocraft-ops:module'});
  console.log(JSON.stringify({operation_id:operationId,module:'example-notes',...result,data_preserved:true,next_step:'SET_MODULE_FLAG_AND_RESTART'}));
}catch(error){
  const code=error instanceof ConfigurationError?'CONFIGURATION_INVALID':error instanceof AppError?error.code:error instanceof Error&&['DATABASE_SCHEMA_INCOMPATIBLE','PERMISSION_CATALOG_INCOMPATIBLE'].includes(error.message)?error.message:'DEPENDENCY_UNAVAILABLE';
  console.error(JSON.stringify({operation_id:operationId,status:'failed',code,...(error instanceof ConfigurationError?{fields:error.fields}:{}),next_step:error instanceof ConfigurationError?'FIX_CONFIGURATION':'CHECK_LOCAL_DEPENDENCIES_AND_STATE'}));
  process.exitCode=error instanceof ConfigurationError?2:code==='DEPENDENCY_UNAVAILABLE'?4:3;
}finally{await database?.close().catch(()=>{process.exitCode=4;});}
