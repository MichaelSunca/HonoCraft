import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,beforeEach,expect,it} from 'vitest';
const exec=promisify(execFile);
const script=resolve('scripts/env-check.ts');
let directory:string,env:NodeJS.ProcessEnv;
beforeEach(async()=>{
  directory=await mkdtemp(join(tmpdir(),'honocraft-env-'));
  const secret=()=>randomBytes(32).toString('base64url');
  for(const name of ['digest','csrf','epoch'])await writeFile(join(directory,name),secret(),{mode:0o600});
  await writeFile(join(directory,'mail.json'),JSON.stringify({active_key_id:'v1',keys:{v1:secret()}}),{mode:0o600});
  env={NODE_ENV:'development',PUBLIC_ORIGIN:'http://localhost:3000',DATABASE_URL:'postgresql://test:private@localhost/test',
    MAIL_MODE:'capture',SMTP_HOST:'localhost',MAIL_FROM:'test@example.test',FILE_STORAGE_ROOT:join(directory,'media'),
    MAIL_PAYLOAD_KEYRING_FILE:join(directory,'mail.json'),DIGEST_KEY_FILE:join(directory,'digest'),
    CSRF_KEY_FILE:join(directory,'csrf'),CREDENTIAL_EPOCH_FILE:join(directory,'epoch')};
});
afterEach(async()=>{await rm(directory,{recursive:true,force:true});});
async function run(args:string[]=[]){
  try{const result=await exec(process.execPath,['--import',createRequire(import.meta.url).resolve('tsx'),script,...args],{cwd:directory,env,timeout:15000});return {code:0,...result};}
  catch(error){const result=error as {code:number;stdout:string;stderr:string};if(typeof result.code!=='number')throw error;return result;}
}
it('checks valid local secret files without contacting unavailable database or SMTP',async()=>{
  const result=await run(['--','--mode=development']);expect(result.code).toBe(0);expect(result.stdout).toContain('Configuration valid');
});
it('fails with a safe diagnostic when a required secret is absent',async()=>{
  await rm(join(directory,'csrf'));const result=await run();
  expect(result.code).toBe(2);expect(result.stderr).toContain('CSRF_KEY_FILE');
  expect(result.stderr).not.toContain(directory);expect(result.stderr).not.toContain('private');
});
it('enforces the requested production mode even if NODE_ENV says development',async()=>{
  const result=await run(['--mode=production']);expect(result.code).toBe(2);
  expect(result.stderr).toContain('PUBLIC_ORIGIN');expect(result.stderr).toContain('MAIL_MODE');
});
it('rejects unknown arguments instead of silently validating the wrong deployment',async()=>{
  const result=await run(['--mode=prod']);expect(result.code).toBe(2);expect(result.stderr).toContain('MODE');
});
