import {existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {AppError} from '@honocraft/contracts/errors';
import {EmailSchema,text} from '@honocraft/contracts/common';
import {ConfigurationError,loadConfig} from './infrastructure/config.js';
import {loadSecrets} from './infrastructure/secrets.js';
import {createDatabase,type Database} from './infrastructure/db.js';
import {checkDatabaseCompatibility} from './infrastructure/startup.js';
import {initializeBootstrap,cancelBootstrap} from './modules/auth/bootstrap.js';
const operationId=randomUUID();
let database:Database|undefined;
try{
  const args=process.argv.slice(2);if(args[0]==='--')args.shift();
  const values=new Map<string,string|boolean>();
  for(const arg of args){
    const matched=/^--(email|reason)=(.*)$/s.exec(arg);
    const name=matched?.[1]??(arg==='--cancel'?'cancel':arg==='--resend'?'resend':null);
    if(!name||values.has(name))throw new ConfigurationError(['OPS_INIT_ARGUMENTS']);
    values.set(name,matched?matched[2]!:true);
  }
  const cancel=values.has('cancel');
  const email=EmailSchema.safeParse(values.get('email'));
  const reason=text(1,500).refine(value=>value.trim().length>0).safeParse(values.get('reason'));
  if(cancel?(!reason.success||values.has('email')||values.has('resend')):(!email.success||values.has('reason')))throw new ConfigurationError(['OPS_INIT_ARGUMENTS']);
  if(existsSync('.env')){try{process.loadEnvFile('.env');}catch{throw new ConfigurationError(['ENV_FILE']);}}
  if(!process.env.MIGRATION_DATABASE_URL)throw new ConfigurationError(['MIGRATION_DATABASE_URL']);
  const config=loadConfig({...process.env,DATABASE_URL:process.env.MIGRATION_DATABASE_URL,
    MIGRATION_DATABASE_URL:undefined,MAINTENANCE_DATABASE_URL:undefined,WORKER_DATABASE_URL:undefined});
  const secrets=await loadSecrets(config);
  database=createDatabase(config.databaseUrl,2);await checkDatabaseCompatibility(database.pool,config.exampleNotesEnabled);
  const meta={requestId:operationId,ip:'127.0.0.1',userAgent:'honocraft-ops:init'};
  const result=cancel?await cancelBootstrap(database.pool,{reason:reason.data},meta):
    await initializeBootstrap(database.pool,{epoch:secrets.epoch,digestKey:secrets.digestKey.key,mailKeyring:secrets.mailKeyring},{email:email.data,resend:values.has('resend')},meta);
  console.log(JSON.stringify({...result,summary:result.status==='initialized'?'ALREADY_INITIALIZED':result.status==='pending'?'INITIALIZATION_PENDING':'INITIALIZATION_CANCELLED',
    next_step:result.status==='initialized'?'SIGN_IN':result.status==='pending'?'CHECK_INITIALIZATION_EMAIL':'RUN_OPS_INIT'}));
}catch(error){
  const code=error instanceof ConfigurationError?'CONFIGURATION_INVALID':error instanceof AppError?error.code:
    error instanceof Error&&['DATABASE_SCHEMA_INCOMPATIBLE','PERMISSION_CATALOG_INCOMPATIBLE'].includes(error.message)?error.message:'DEPENDENCY_UNAVAILABLE';
  console.error(JSON.stringify({operation_id:operationId,status:'failed',code,
    ...(error instanceof ConfigurationError?{fields:error.fields}:{}),...(error instanceof AppError&&error.retryAfter?{retry_after:error.retryAfter}:{}),
    next_step:error instanceof ConfigurationError?'FIX_CONFIGURATION':error instanceof AppError&&error.code==='RATE_LIMITED'?'WAIT_AND_RETRY':'CHECK_LOCAL_DEPENDENCIES_AND_STATE'}));
  process.exitCode=error instanceof ConfigurationError?2:code==='DEPENDENCY_UNAVAILABLE'?4:3;
}finally{await database?.close().catch(()=>{process.exitCode=4;});}
