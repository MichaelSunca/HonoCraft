import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {ConfigurationError,loadConfig} from './infrastructure/config.js';
import {loadSecrets} from './infrastructure/secrets.js';
import {loadPasswordBlocklist} from './infrastructure/password-blocklist.js';
import {createPasswordService} from './infrastructure/passwords.js';
import {createDatabase,type Database} from './infrastructure/db.js';
import {checkDatabaseCompatibility} from './infrastructure/startup.js';
import {startHttpServer} from './http/app.js';

let database:Database|undefined;
let server:ReturnType<typeof startHttpServer>|undefined;
try {
  if(existsSync('.env')){try{process.loadEnvFile('.env');}catch{throw new ConfigurationError(['ENV_FILE']);}}
  // Runtime configuration never uses migration, maintenance or worker connection credentials.
  const config=loadConfig({...process.env,MIGRATION_DATABASE_URL:undefined,MAINTENANCE_DATABASE_URL:undefined,WORKER_DATABASE_URL:undefined});
  const secrets=await loadSecrets(config);
  const blocklist=await loadPasswordBlocklist();
  database=createDatabase(config.databaseUrl,config.dbPoolMax);
  await checkDatabaseCompatibility(database.pool,config.exampleNotesEnabled);
  const passwords=await createPasswordService({concurrency:config.hashConcurrency,blockedPasswords:blocklist.passwords});
  const webRoot=fileURLToPath(new URL('../../web/dist/',import.meta.url));
  server=startHttpServer({pool:database.pool,config,secrets,passwords,...(existsSync(webRoot+'index.html')?{webRoot}:{})});
  if(!server.listening)await once(server,'listening');
  const liveServer=server,liveDatabase=database;
  let stopping=false;
  const stop=()=>{
    if(stopping)return;stopping=true;
    const deadline=setTimeout(()=>{console.error('Web shutdown deadline exceeded');process.exit(1);},30_000).unref();
    const drain=setTimeout(()=>liveServer.closeAllConnections(),25_000).unref();
    void (async()=>{
      try{
        await new Promise<void>((resolve,reject)=>liveServer.close(error=>error?reject(error):resolve()));
        await liveDatabase.close();
      }catch{console.error('Web shutdown failed');process.exitCode=1;}
      finally{clearTimeout(deadline);clearTimeout(drain);}
    })();
  };
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  liveServer.on('error',()=>{console.error('Web listener failed');process.exitCode=1;stop();});
  console.log('Web ready');
}catch(error){
  if(server?.listening){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}
  if(database)await database.close().catch(()=>undefined);
  const safe=error instanceof ConfigurationError?error.message:
    error instanceof Error&&['DATABASE_SCHEMA_INCOMPATIBLE','PERMISSION_CATALOG_INCOMPATIBLE'].includes(error.message)?error.message:'WEB_STARTUP_FAILED';
  console.error(safe);process.exitCode=error instanceof ConfigurationError?2:3;
}
