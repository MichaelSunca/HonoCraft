import {existsSync} from 'node:fs';
import {ConfigurationError,loadConfig} from './infrastructure/config.js';
import {loadSecrets} from './infrastructure/secrets.js';
import {createDatabase,type Database} from './infrastructure/db.js';
import {checkDatabaseCompatibility} from './infrastructure/startup.js';
import {createSmtpTransport} from './modules/mail/smtp.js';
import {runMailWorker} from './modules/mail/runner.js';
import {runFileCleanup} from './modules/files/runner.js';
import {runExpiryWorker} from './modules/maintenance/expiry.js';
import {assertMaintenanceRole} from './modules/maintenance/retention.js';
import {runRetentionWorker} from './modules/maintenance/retention-runner.js';
let database:Database|undefined,maintenance:Database|undefined;
const controller=new AbortController();
let deadline:ReturnType<typeof setTimeout>|undefined;
const stop=()=>{
  if(controller.signal.aborted)return;
  controller.abort();
  deadline=setTimeout(()=>{console.error('Worker shutdown deadline exceeded');process.exit(1);},30_000).unref();
};
try{
  if(existsSync('.env')){try{process.loadEnvFile('.env');}catch{throw new ConfigurationError(['ENV_FILE']);}}
  if(!process.env.WORKER_DATABASE_URL)throw new ConfigurationError(['WORKER_DATABASE_URL']);
  if(!process.env.MAINTENANCE_DATABASE_URL)throw new ConfigurationError(['MAINTENANCE_DATABASE_URL']);
  const config=loadConfig({...process.env,DATABASE_URL:process.env.WORKER_DATABASE_URL,
    MIGRATION_DATABASE_URL:undefined,WORKER_DATABASE_URL:undefined});
  const secrets=await loadSecrets(config);
  database=createDatabase(config.databaseUrl,4);
  maintenance=createDatabase(config.maintenanceDatabaseUrl!,1);
  await checkDatabaseCompatibility(database.pool,config.exampleNotesEnabled);
  await checkDatabaseCompatibility(maintenance.pool,config.exampleNotesEnabled);
  await assertMaintenanceRole(maintenance.pool);
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  const jobs=[runMailWorker(database.pool,{origin:config.origin,epoch:secrets.epoch,keyring:secrets.mailKeyring,digestKey:secrets.digestKey.key},
    createSmtpTransport(config.smtp),controller.signal,event=>{
      if(event==='ready')console.log('Worker ready');
      else console.log(JSON.stringify({event:`mail.${event}`}));
    }),runFileCleanup(database.pool,config.fileStorageRoot,controller.signal,({event,...counts})=>console.log(JSON.stringify({event:`files.${event}`,...counts}))),
    runExpiryWorker(database.pool,controller.signal,({event,...counts})=>console.log(JSON.stringify({event:`expiry.${event}`,...counts}))),
    runRetentionWorker(maintenance.pool,{auditDays:config.auditRetentionDays,securityDays:config.securityRetentionDays},controller.signal,
      ({scope,event,...details})=>console.log(JSON.stringify({event:`retention.${scope}.${event}`,...details})))];
  try{await Promise.all(jobs);}finally{controller.abort();await Promise.allSettled(jobs);}
}catch(error){
  const safe=error instanceof ConfigurationError?error.message:
    error instanceof Error&&['DATABASE_SCHEMA_INCOMPATIBLE','PERMISSION_CATALOG_INCOMPATIBLE','MAINTENANCE_ROLE_INCOMPATIBLE'].includes(error.message)?error.message:'WORKER_STARTUP_FAILED';
  console.error(safe);process.exitCode=error instanceof ConfigurationError?2:3;
}finally{
  await Promise.all([database,maintenance].map(connection=>connection?.close().catch(()=>{console.error('Worker shutdown failed');process.exitCode=1;})));
  if(deadline)clearTimeout(deadline);
  process.off('SIGINT',stop);process.off('SIGTERM',stop);
}
