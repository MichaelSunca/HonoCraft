import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,open,rename,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {Pool} from 'pg';
import {AppError} from '@honocraft/contracts/errors';
import {withTransaction} from '../../infrastructure/db.js';
import type {ImageOutput,ImagePurpose} from './images.js';
export type StoredFile={id:string;storage_key:string;purpose:'avatar'|'brand_logo'|'brand_favicon';owner_id:string|null;content_type:'image/webp'|'image/png';byte_size:string;width:number;height:number;state:string;lease_expires_at:Date|null};
const safeKey=(key:string)=>/^[a-zA-Z0-9_-]+\.(webp|png)$/.test(key);
export function createFileStorage(pool:Pool,root:string){
  async function orphan(id:string){await withTransaction(pool,'shared',tx=>tx.query("UPDATE file_objects SET state='orphaned',lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1 AND state='staged'",[id]));}
  async function stage(owner:string,purpose:ImagePurpose,outputs:ImageOutput[]){
    const id=randomUUID(),main=outputs[0]!,key=id+(main.contentType==='image/png'?'.png':'.webp'),kind=purpose==='avatar'?'avatar':purpose==='logo'?'brand_logo':'brand_favicon';
    await withTransaction(pool,'shared',async tx=>{
      await tx.query(`INSERT INTO file_objects(id,storage_key,owner_id,purpose,content_type,byte_size,width,height,lease_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '10 minutes')`,[id,key,purpose==='avatar'?owner:null,kind,main.contentType,main.bytes.length,main.width,main.height]);
      for(const variant of outputs.slice(1))await tx.query('INSERT INTO file_variants(file_id,size,storage_key,byte_size) VALUES($1,$2,$3,$4)',[id,variant.size,id+'-'+variant.size+'.png',variant.bytes.length]);
    });
    try{await mkdir(root,{recursive:true,mode:0o700});for(const [index,output] of outputs.entries()){
      const target=index===0?key:id+'-'+output.size+'.png',temporary=id+'-'+randomUUID()+'.tmp',path=resolve(root,temporary);
      const handle=await open(path,'wx',0o600);try{await handle.writeFile(output.bytes);await handle.sync();}finally{await handle.close();}
      try{await rename(path,resolve(root,target));}catch(error){await unlink(path).catch(()=>undefined);throw error;}
    }const directory=await open(root,constants.O_RDONLY|constants.O_DIRECTORY);try{await directory.sync();}finally{await directory.close();}}
    catch{await orphan(id).catch(()=>undefined);throw new AppError('STORAGE_UNAVAILABLE');}
    return id;
  }
  async function read(key:string){if(!safeKey(key))throw new AppError('STORAGE_UNAVAILABLE');try{const handle=await open(resolve(root,key),constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await handle.stat();if(!stat.isFile()||stat.size>3*1024*1024)throw new Error('Unexpected media');return await handle.readFile();}finally{await handle.close();}}catch{throw new AppError('STORAGE_UNAVAILABLE');}}
  return {stage,orphan,read};
}
