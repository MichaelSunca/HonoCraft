import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {z} from 'zod';
import {ConfigurationError,type AppConfig} from './config.js';
import type {Keyring} from './crypto.js';
import type {DigestKey} from './idempotency.js';

export type RuntimeSecrets=Readonly<{mailKeyring:Keyring;digestKey:DigestKey;csrfKey:Buffer;epoch:string}>;
type SecretConfig=Pick<AppConfig,'environment'|'mailKeyringFile'|'digestKeyFile'|'csrfKeyFile'|'credentialEpochFile'>;
const keyId=z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const ringSchema=z.strictObject({active_key_id:keyId,keys:z.record(keyId,z.string())});
function decodeKey(value:string):Buffer {
  if(!/^[A-Za-z0-9_-]{43}$/.test(value))throw new Error();
  const bytes=Buffer.from(value,'base64url');
  if(bytes.length!==32||bytes.toString('base64url')!==value||bytes.every(byte=>byte===bytes[0]))throw new Error();
  return bytes;
}
/** Reads once through a file descriptor so checks apply to the exact content loaded. Never creates secrets. */
export async function loadSecrets(config:SecretConfig):Promise<RuntimeSecrets> {
  const inodes=new Set<string>();
  const material=new Set<string>();
  const read=async(path:string,field:string):Promise<string>=>{
    try {
      const file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);
      try {
        const stat=await file.stat();
        if(!stat.isFile()||stat.size<1||stat.size>16_384||(config.environment==='production'&&(stat.mode&0o027)!==0))throw new Error();
        const inode=`${stat.dev}:${stat.ino}`;
        if(inodes.has(inode))throw new ConfigurationError(['SECRET_FILE_SEPARATION']);
        inodes.add(inode);
        const bytes=Buffer.alloc(16_385);
        let count=0;
        while(count<bytes.length){const result=await file.read(bytes,count,bytes.length-count,null);if(!result.bytesRead)break;count+=result.bytesRead;}
        if(count>16_384)throw new Error();
        return new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,count));
      } finally {await file.close();}
    } catch(error){if(error instanceof ConfigurationError)throw error;throw new ConfigurationError([field]);}
  };
  const unique=(value:string,field:string):Buffer=>{
    let bytes:Buffer;
    try{bytes=decodeKey(value);}catch{throw new ConfigurationError([field]);}
    if(material.has(value))throw new ConfigurationError(['SECRET_FILE_SEPARATION']);
    material.add(value);return bytes;
  };
  const rawMail=await read(config.mailKeyringFile,'MAIL_PAYLOAD_KEYRING_FILE');
  let parsed:z.infer<typeof ringSchema>;
  try {
    parsed=ringSchema.parse(JSON.parse(rawMail));
    if(!Object.hasOwn(parsed.keys,parsed.active_key_id)||Object.keys(parsed.keys).length>32)throw new Error();
  }catch{throw new ConfigurationError(['MAIL_PAYLOAD_KEYRING_FILE']);}
  const keys=new Map<string,Buffer>();
  for(const [id,value] of Object.entries(parsed.keys))keys.set(id,unique(value,'MAIL_PAYLOAD_KEYRING_FILE'));
  const loadKey=async(path:string,field:string)=>unique((await read(path,field)).replace(/\r?\n$/,''),field);
  const digest=await loadKey(config.digestKeyFile,'DIGEST_KEY_FILE');
  const csrf=await loadKey(config.csrfKeyFile,'CSRF_KEY_FILE');
  const epoch=await loadKey(config.credentialEpochFile,'CREDENTIAL_EPOCH_FILE');
  return Object.freeze({mailKeyring:{activeKeyId:parsed.active_key_id,keys},
    digestKey:{id:createHash('sha256').update(digest).digest('hex').slice(0,16),key:digest},
    csrfKey:csrf,epoch:epoch.toString('base64url')});
}
