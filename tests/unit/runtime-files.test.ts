import { randomBytes } from 'node:crypto';
import { mkdtemp,writeFile,rm,chmod,link,copyFile,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { loadSecrets } from '../../apps/server/src/infrastructure/secrets.js';
import { loadPasswordBlocklist,DEFAULT_PASSWORD_DIRECTORY } from '../../apps/server/src/infrastructure/password-blocklist.js';

let directory:string;
let config:{environment:'production';mailKeyringFile:string;digestKeyFile:string;csrfKeyFile:string;credentialEpochFile:string};
let active:string,old:string,digest:string,csrf:string,epoch:string;
beforeEach(async()=>{
  directory=await mkdtemp(join(tmpdir(),'honocraft-files-'));
  config={environment:'production',mailKeyringFile:join(directory,'mail.json'),digestKeyFile:join(directory,'digest'),csrfKeyFile:join(directory,'csrf'),credentialEpochFile:join(directory,'epoch')};
  [active,old,digest,csrf,epoch]=Array.from({length:5},()=>randomBytes(32).toString('base64url')) as [string,string,string,string,string];
  await writeFile(config.mailKeyringFile,JSON.stringify({active_key_id:'v2',keys:{v1:old,v2:active}}),{mode:0o600});
  await writeFile(config.digestKeyFile,digest+'\n',{mode:0o600});
  await writeFile(config.csrfKeyFile,csrf+'\r\n',{mode:0o600});
  await writeFile(config.credentialEpochFile,epoch,{mode:0o600});
});
afterEach(async()=>{await rm(directory,{recursive:true,force:true});});

describe('deployment secret files',()=>{
  it('loads active and retained mail keys and keeps an externally supplied epoch stable',async()=>{
    const result=await loadSecrets(config);
    expect(result.mailKeyring.activeKeyId).toBe('v2');
    expect(result.mailKeyring.keys.get('v1')?.toString('base64url')).toBe(old);
    expect(result.mailKeyring.keys.get('v2')?.toString('base64url')).toBe(active);
    expect(result.digestKey.key.toString('base64url')).toBe(digest);
    expect(result.csrfKey.toString('base64url')).toBe(csrf);
    expect(result.epoch).toBe(epoch);
    expect((await loadSecrets(config)).epoch).toBe(epoch);
    expect(result.digestKey.id).not.toContain(digest);
  });
  it('rejects missing files with field names only',async()=>{
    await rm(config.csrfKeyFile);
    await expect(loadSecrets(config)).rejects.toThrow('Invalid configuration: CSRF_KEY_FILE');
    await expect(loadSecrets(config)).rejects.not.toThrow(directory);
  });
  it.each(['not-a-key', ' '.repeat(43), 'A'.repeat(43), 'x'.repeat(100_000)])('rejects malformed or placeholder key material %#',async value=>{
    await writeFile(config.digestKeyFile,value);
    await expect(loadSecrets(config)).rejects.toThrow('DIGEST_KEY_FILE');
  });
  it('rejects an active mail key absent from the retained keyring',async()=>{
    await writeFile(config.mailKeyringFile,JSON.stringify({active_key_id:'v3',keys:{v1:old}}));
    await expect(loadSecrets(config)).rejects.toThrow('MAIL_PAYLOAD_KEYRING_FILE');
  });
  it('rejects reused key material even when files have different names',async()=>{
    await writeFile(config.csrfKeyFile,digest);
    await expect(loadSecrets(config)).rejects.toThrow('SECRET_FILE_SEPARATION');
  });
  it('rejects aliases to the same secret inode',async()=>{
    await rm(config.csrfKeyFile);await link(config.digestKeyFile,config.csrfKeyFile);
    await expect(loadSecrets(config)).rejects.toThrow('SECRET_FILE_SEPARATION');
  });
  it('rejects public read or group write permissions in production',async()=>{
    await chmod(config.digestKeyFile,0o644);
    await expect(loadSecrets(config)).rejects.toThrow('DIGEST_KEY_FILE');
    await chmod(config.digestKeyFile,0o660);
    await expect(loadSecrets(config)).rejects.toThrow('DIGEST_KEY_FILE');
  });
});

describe('bundled offline password blocklist',()=>{
  it('loads the pinned dataset and blocks known leaked passwords without trimming them',async()=>{
    const result=await loadPasswordBlocklist();
    expect(result.entries).toBe(100000);
    expect(result.passwords.has('password')).toBe(true);
    expect(result.passwords.has('123456')).toBe(true);
    expect(result.passwords.has(' password ')).toBe(false);
  });
  it('refuses a missing dataset rather than silently running without protection',async()=>{
    await expect(loadPasswordBlocklist(directory)).rejects.toThrow('PASSWORD_BLOCKLIST');
  });
  it('detects a damaged dataset',async()=>{
    for(const name of ['manifest.json','common-100000.txt','LICENSE.SecLists'])await copyFile(join(DEFAULT_PASSWORD_DIRECTORY,name),join(directory,name));
    await writeFile(join(directory,'common-100000.txt'),'corrupted\n');
    await expect(loadPasswordBlocklist(directory)).rejects.toThrow('PASSWORD_BLOCKLIST');
  });
  it.each([{version:2},{file:'../outside.txt'},{entries:99999}])('rejects unsupported versions, path escapes and wrong counts: %j',async override=>{
    for(const name of ['manifest.json','common-100000.txt','LICENSE.SecLists'])await copyFile(join(DEFAULT_PASSWORD_DIRECTORY,name),join(directory,name));
    const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
    await writeFile(join(directory,'manifest.json'),JSON.stringify({...manifest,...override}));
    await expect(loadPasswordBlocklist(directory)).rejects.toThrow('PASSWORD_BLOCKLIST');
  });
});
