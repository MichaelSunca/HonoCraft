import {test as base} from '@playwright/test';
import type {Pool} from 'pg';
import {resolve} from 'node:path';
import {once} from 'node:events';
import {writeFile,mkdtemp,rm} from 'node:fs/promises';
import {startTestPostgres,availablePort} from '../helpers/postgres.js';
import {migrate} from '../../apps/server/src/infrastructure/migrations.js';
import {loadConfig} from '../../apps/server/src/infrastructure/config.js';
import {createPasswordService} from '../../apps/server/src/infrastructure/passwords.js';
import {loadPasswordBlocklist} from '../../apps/server/src/infrastructure/password-blocklist.js';
import {decryptPayload} from '../../apps/server/src/infrastructure/crypto.js';
import {mailAad} from '../../apps/server/src/modules/mail/outbox.js';
import {createPublicAuthService} from '../../apps/server/src/modules/auth/public-auth.js';
import {initializeBootstrap} from '../../apps/server/src/modules/auth/bootstrap.js';
import {startHttpServer} from '../../apps/server/src/http/app.js';
import {randomUUID} from 'node:crypto';
const secrets={epoch:'browser-test-epoch',csrfKey:Buffer.alloc(32,3),digestKey:{id:'browser-v1',key:Buffer.alloc(32,7)},mailKeyring:{activeKeyId:'v1',keys:new Map([['v1',Buffer.alloc(32,4)]])}};
const meta=()=>({requestId:randomUUID(),ip:'127.0.0.1',userAgent:'browser fixture'});
export const password='A browser testing secret passphrase';
type Backend={pool:Pool;origin:string;initialize:()=>Promise<string>;account:()=>Promise<void>;token:(purpose:string)=>Promise<string>};
export const test=base.extend<{backend:Backend}>({backend:async({page},use,testInfo)=>{
  const responses:Array<{path:string;status:number;code?:string;sessionTimes?:unknown}>=[],diagnostics:Promise<void>[]=[];
  page.on('response',response=>{const path=new URL(response.url()).pathname;if(!path.startsWith('/api/'))return;const record:{path:string;status:number;code?:string;sessionTimes?:unknown}={path,status:response.status()};responses.push(record);if(response.status()>=400)diagnostics.push(response.json().then(async body=>{record.code=body.error?.code;if(record.code==='SESSION_INVALID')record.sessionTimes=(await database.pool.query('SELECT created_at,last_seen_at,clock_timestamp() observed_at,extract(epoch FROM last_seen_at-clock_timestamp())*1000 AS future_ms FROM sessions')).rows;}).catch(()=>undefined));});
  const database=await startTestPostgres();let server:ReturnType<typeof startHttpServer>|undefined,mediaRoot:string|undefined;
  try{
    await migrate(database.pool);await database.pool.query("UPDATE system_settings SET typed_value=jsonb_set(typed_value,'{default_locale}','\"en\"') WHERE key='branding'");
    mediaRoot=await mkdtemp(resolve('.local/tests/browser-media-'));
    const port=await availablePort(),origin=`http://127.0.0.1:${port}`;
    const config=loadConfig({NODE_ENV:'test',PUBLIC_ORIGIN:origin,PORT:String(port),DATABASE_URL:database.connectionString,
      MAIL_MODE:'capture',SMTP_HOST:'127.0.0.1',SMTP_PORT:'1025',MAIL_FROM:'test@example.test',FILE_STORAGE_ROOT:mediaRoot,EXAMPLE_NOTES_ENABLED:'false',
      MAIL_PAYLOAD_KEYRING_FILE:'.local/test-mail',DIGEST_KEY_FILE:'.local/test-digest',CSRF_KEY_FILE:'.local/test-csrf',CREDENTIAL_EPOCH_FILE:'.local/test-epoch'});
    const passwords=await createPasswordService({concurrency:2,blockedPasswords:(await loadPasswordBlocklist()).passwords});
    server=startHttpServer({pool:database.pool,config,passwords,secrets,webRoot:resolve('apps/web/dist')});if(!server.listening)await once(server,'listening');
    const token=async(purpose:string)=>{
      const row=(await database.pool.query("SELECT * FROM email_tasks WHERE purpose=$1 AND status='queued' ORDER BY created_at DESC LIMIT 1",[purpose])).rows[0];
      if(!row)throw new Error('Browser fixture expected queued mail');
      return JSON.parse(decryptPayload(secrets.mailKeyring,{keyId:row.key_id,nonce:row.nonce,tag:row.auth_tag,ciphertext:row.payload_ciphertext},mailAad(row.id,row.purpose,row.template_version))).token as string;
    };
    const initialize=async()=>{await initializeBootstrap(database.pool,{epoch:secrets.epoch,digestKey:secrets.digestKey.key,mailKeyring:secrets.mailKeyring},{email:'owner@example.test'},meta());return token('bootstrap');};
    const account=async()=>{
      await database.pool.query("UPDATE system_state SET initialization_status='initialized',initialized_at=clock_timestamp() WHERE id=1; UPDATE system_settings SET typed_value=jsonb_set(typed_value,'{registration_open}','true') WHERE key='security'");
      const auth=createPublicAuthService(database.pool,{epoch:secrets.epoch,digestKey:secrets.digestKey.key,mailKeyring:secrets.mailKeyring},passwords);
      await auth.register({email:'member@example.test',password,display_name:'Test member'},meta());await auth.verify({token:await token('email_verify')},meta());
    };
    await use({pool:database.pool,origin,initialize,account,token});
  }finally{
    if(testInfo.status!==testInfo.expectedStatus){
      await Promise.allSettled(diagnostics);
      const sessions=await database.pool.query('SELECT created_at,last_seen_at,idle_expires_at,absolute_expires_at,revoked_at,clock_timestamp() observed_at FROM sessions').catch(()=>({rows:[]}));
      const diagnosticPath=testInfo.outputPath('safe-runtime-diagnostic.json');
      await writeFile(diagnosticPath,JSON.stringify({responses,sessions:sessions.rows}));
      await testInfo.attach('safe-runtime-diagnostic',{path:diagnosticPath,contentType:'application/json'});
    }
    if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}if(mediaRoot)await rm(mediaRoot,{recursive:true,force:true});await database.close();}
}});
export {expect} from '@playwright/test';
