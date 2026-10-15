import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {open,unlink,opendir,lstat} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {Pool} from 'pg';
import {withTransaction,type Tx} from '../../infrastructure/db.js';
import {appendAudit,type RequestMeta} from '../audit/writer.js';
type Candidate={id:string;storage_key:string};
export type CleanupResult={claimed:number;deleted:number;failed:number};
type Options={batchSize?:number;signal?:AbortSignal};
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const generatedKey=new RegExp(`^(${uuid})(?:\\.(?:webp|png)|-32\\.png|-${uuid}\\.tmp)$`);
function batchLimit(options:Options){const value=options.batchSize??100;if(!Number.isInteger(value)||value<1||value>100)throw new Error('INVALID_CLEANUP_BATCH_SIZE');return value;}
function fileAudit(meta:RequestMeta){return (tx:Tx,action:string,id?:string,count?:number,result:'success'|'failed'='success')=>appendAudit(tx,{actor:{type:'worker'},action,target:{type:'file',...(id?{id}:{})},result,meta,changes:count===undefined?{}:{affected_count:count}});}
// Recheck references in a fresh statement after acquiring the file lock. Never lock users or settings here.
const unreferenced=`NOT EXISTS(SELECT 1 FROM users u WHERE u.avatar_file_id=f.id)
  AND NOT EXISTS(SELECT 1 FROM system_settings b WHERE b.key='branding'
    AND (b.typed_value->>'logo_file_id'=f.id::text OR b.typed_value->>'favicon_file_id'=f.id::text))`;
const eligible=`(f.state='deleting' OR (f.state IN ('staged','orphaned')
  AND f.updated_at<clock_timestamp()-interval '24 hours'
  AND (f.lease_expires_at IS NULL OR f.lease_expires_at<=clock_timestamp())))`;
const missing=(error:unknown)=>(error as NodeJS.ErrnoException)?.code==='ENOENT';
async function removeFile(root:string,key:string){
  if(!/^[a-zA-Z0-9_-]+\.(webp|png)$/.test(key)&&!generatedKey.test(key))throw new Error('INVALID_STORAGE_KEY');
  try{await unlink(resolve(root,key));return true;}catch(error){if(!missing(error))throw error;return false;}
}
async function syncDirectory(root:string){
  let directory;try{directory=await open(root,constants.O_RDONLY|constants.O_DIRECTORY);}catch(error){if(missing(error))return;throw error;}
  try{await directory.sync();}finally{await directory.close();}
}
/** Only the worker pool may call this. Physical IO stays outside every transaction. */
export async function cleanupFiles(pool:Pool,root:string,options:Options={}):Promise<CleanupResult>{
  const batchSize=batchLimit(options);
  const result:CleanupResult={claimed:0,deleted:0,failed:0};if(options.signal?.aborted)return result;
  const meta={requestId:randomUUID(),ip:'127.0.0.1',userAgent:'HonoCraft Worker'};
  const audit=fileAudit(meta);
  const files=await withTransaction(pool,'independent',async tx=>{
    const locked=(await tx.query<{id:string}>(`SELECT f.id FROM file_objects f WHERE ${eligible} AND ${unreferenced}
      ORDER BY f.updated_at,f.id LIMIT $1 FOR UPDATE OF f SKIP LOCKED`,[batchSize])).rows.map(row=>row.id);
    if(!locked.length)return [];
    const candidates=(await tx.query<Candidate>(`UPDATE file_objects f SET state='deleting',lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE f.id=ANY($1::uuid[]) AND ${eligible} AND ${unreferenced} RETURNING f.id,f.storage_key`,[locked])).rows;
    const variants=(await tx.query<{file_id:string;storage_key:string}>('SELECT file_id,storage_key FROM file_variants WHERE file_id=ANY($1::uuid[]) ORDER BY file_id,size',[candidates.map(file=>file.id)])).rows;
    if(candidates.length)await audit(tx,'files.cleanup.started',undefined,candidates.length);
    return candidates.map(file=>({...file,keys:[file.storage_key,...variants.filter(variant=>variant.file_id===file.id).map(variant=>variant.storage_key)]}));
  });
  result.claimed=files.length;
  for(const file of files){
    if(options.signal?.aborted)break;
    try{
      for(const key of file.keys)await removeFile(root,key);
      // Persist directory changes before dropping the only retryable metadata.
      await syncDirectory(root);
      const deleted=await withTransaction(pool,'independent',async tx=>{
        const row=(await tx.query<{id:string}>("SELECT id FROM file_objects WHERE id=$1 AND state='deleting' FOR UPDATE",[file.id])).rows[0];
        if(!row)return false;
        const removed=await tx.query(`DELETE FROM file_objects f WHERE f.id=$1 AND f.state='deleting' AND ${unreferenced} RETURNING f.id`,[file.id]);
        if(!removed.rowCount)return false;
        await audit(tx,'files.object.deleted',file.id);return true;
      });
      if(deleted)result.deleted++;
    }catch{
      result.failed++;
      await withTransaction(pool,'independent',tx=>audit(tx,'files.object.failed',file.id,undefined,'failed')).catch(()=>undefined);
    }
  }
  if(files.length)await withTransaction(pool,'independent',tx=>audit(tx,'files.cleanup.completed',undefined,result.deleted));
  return result;
}

/** Recover generated artifacts left after a crash. Known metadata always wins over a directory scan. */
export async function cleanupLooseFiles(pool:Pool,root:string,options:Options={}):Promise<{deleted:number;failed:number}>{
  const limit=batchLimit(options),result={deleted:0,failed:0};if(options.signal?.aborted)return result;
  const now=(await pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now.getTime();
  let directory;try{directory=await opendir(root);}catch(error){if(missing(error))return result;throw error;}
  const audit=fileAudit({requestId:randomUUID(),ip:'127.0.0.1',userAgent:'HonoCraft Worker'});
  let attempted=0;
  for await(const entry of directory){
    if(options.signal?.aborted||attempted>=limit)break;
    const match=generatedKey.exec(entry.name);if(!entry.isFile()||!match)continue;
    let counted=false;
    try{
      const stat=await lstat(resolve(root,entry.name));if(!stat.isFile()||stat.mtimeMs>=now-24*60*60_000)continue;
      const allowed=await withTransaction(pool,'independent',async tx=>{
        // A recorded parent may have an active upload, or be retrying a partial physical deletion.
        if((await tx.query('SELECT id FROM file_objects WHERE id=$1 FOR UPDATE',[match[1]])).rowCount)return false;
        const referenced=(await tx.query<{present:boolean}>(`SELECT EXISTS(SELECT 1 FROM users WHERE avatar_file_id=$1)
          OR EXISTS(SELECT 1 FROM system_settings WHERE key='branding'
            AND (typed_value->>'logo_file_id'=$1::text OR typed_value->>'favicon_file_id'=$1::text)) AS present`,[match[1]])).rows[0]!.present;
        if(referenced)return false;
        await audit(tx,'files.loose.started',match[1],1);return true;
      });
      if(!allowed)continue;attempted++;counted=true;
      const removed=await removeFile(root,entry.name);await syncDirectory(root);
      await withTransaction(pool,'independent',tx=>audit(tx,'files.loose.deleted',match[1],removed?1:0));if(removed)result.deleted++;
    }catch(error){
      if(missing(error))continue;
      if(!counted)attempted++;
      result.failed++;
      await withTransaction(pool,'independent',tx=>audit(tx,'files.loose.failed',match[1],undefined,'failed')).catch(()=>undefined);
    }
  }
  return result;
}
