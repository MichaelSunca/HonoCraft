import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import {AppError} from '@honocraft/contracts/errors';
import {MediaVersionSchema,AvatarResultSchema,BrandingAssetResultSchema,MediaReadQuerySchema} from '@honocraft/contracts/media';
import {permissionDefinitions} from '@honocraft/contracts/permissions';
import {databaseNow,withTransaction} from '../../infrastructure/db.js';
import {verifyCsrf} from '../../infrastructure/crypto.js';
import type {DigestKey} from '../../infrastructure/idempotency.js';
import type {RequestMeta} from '../audit/writer.js';
import {authenticateRead} from '../auth/sessions.js';
import {loadAccess} from '../access/repository.js';
import {assertManageableTarget,isSuperAdmin} from '../access/policy.js';
import {createMutationGateway,defineMutation} from '../access/mutation-gateway.js';
import {createFileStorage,type StoredFile} from './storage.js';
import {convertImage,type ImagePurpose} from './images.js';
type Ref={token:string;csrfToken:string};
type Secrets={epoch:string;csrfKey:Buffer;digestKey:DigestKey};
const inputSchema=MediaVersionSchema.extend({source_sha256:z.string().regex(/^[a-f0-9]{64}$/).nullable()});
const purpose=(asset:ImagePurpose)=>asset==='avatar'?'avatar':asset==='logo'?'brand_logo':'brand_favicon';
const url=(asset:ImagePurpose,id:string|null)=>id?'/api/v1/media/'+(asset==='avatar'?'avatars/':'branding/')+id:null;
export function createMediaService(pool:Pool,secrets:Secrets,root:string){
  const storage=createFileStorage(pool,root);
  async function preflight(ref:Ref,asset:ImagePurpose){const context=await authenticateRead(pool,{token:ref.token,epoch:secrets.epoch});if(!verifyCsrf(secrets.csrfKey,context.sessionId,secrets.epoch,ref.csrfToken))throw new AppError('CSRF_INVALID');if(asset!=='avatar'&&!context.permissions.has('settings:update-branding'))throw new AppError('FORBIDDEN');return context;}
  async function mutate(ref:Ref,asset:ImagePurpose,version:unknown,bytes:Uint8Array|null,meta:RequestMeta,key?:string,budget?:number){
    const started=performance.now();
    if(budget!==undefined&&budget<8000)throw new AppError('BUSY_RETRY',{},2);
    const parsed=MediaVersionSchema.safeParse(version);if(!parsed.success)throw new AppError('VALIDATION_ERROR');if(!z.uuid().safeParse(key).success)throw new AppError('VALIDATION_ERROR');const actor=await preflight(ref,asset);
    const hash=bytes?createHash('sha256').update(bytes).digest('hex'):null;
    let candidate:string|null=null;if(bytes)candidate=await storage.stage(actor.actor.userId,asset,await convertImage(bytes,asset));
    let oldId:string|null=null,beforeVersion=0;
    const definition=defineMutation({input:inputSchema,output:z.union([AvatarResultSchema,BrandingAssetResultSchema]),mode:'shared',permission:asset==='avatar'?null:'settings:update-branding',recentAuth:false,auditAction:(asset==='avatar'?'users.avatar.':'settings.'+asset+'.')+(bytes?'updated':'removed'),
      resolveLocks:async()=>({userIds:[],roleIds:[]}),
      authorize:async(tx,context,input)=>{
        if(asset==='avatar'){const row=(await tx.query<{version:number;avatar_file_id:string|null}>('SELECT version,avatar_file_id FROM users WHERE id=$1',[context.actor.userId])).rows[0]!;beforeVersion=row.version;oldId=row.avatar_file_id;}
        else{const row=(await tx.query<{version:number;typed_value:{logo_file_id:string|null;favicon_file_id:string|null}}>("SELECT version,typed_value FROM system_settings WHERE key='branding' FOR UPDATE")).rows[0]!;beforeVersion=row.version;oldId=row.typed_value[asset==='logo'?'logo_file_id':'favicon_file_id'];}
        if(beforeVersion!==input.expected_version)throw new AppError('VERSION_CONFLICT');
        await tx.query('SELECT id FROM file_objects WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[[oldId,candidate].filter((id):id is string=>!!id)]);
        if(candidate){const file=(await tx.query<StoredFile>('SELECT * FROM file_objects WHERE id=$1',[candidate])).rows[0],now=await databaseNow(tx);if(!file||file.state!=='staged'||!file.lease_expires_at||file.lease_expires_at<=now||file.purpose!==purpose(asset)||(asset==='avatar'&&file.owner_id!==context.actor.userId))throw new AppError('IMAGE_INVALID');}
      },
      execute:async(tx,context,input)=>{
        if(candidate)await tx.query("UPDATE file_objects SET state='attached',lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1",[candidate]);
        if(oldId)await tx.query("UPDATE file_objects SET state='orphaned',lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1",[oldId]);
        if(asset==='avatar')await tx.query('UPDATE users SET avatar_file_id=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1',[context.actor.userId,candidate]);
        else await tx.query("UPDATE system_settings SET typed_value=jsonb_set(typed_value,ARRAY[$1],$2::jsonb),version=version+1,updated_by=$3,updated_at=clock_timestamp() WHERE key='branding'",[asset==='logo'?'logo_file_id':'favicon_file_id',JSON.stringify(candidate),context.actor.userId]);
        return {data:asset==='avatar'?{avatar_url:url(asset,candidate),user_version:input.expected_version+1}:{url:url(asset,candidate),version:input.expected_version+1},audit:{target:{type:asset==='avatar'?'user':'settings',...(asset==='avatar'?{id:context.actor.userId}:{})},changes:{before_version:beforeVersion,after_version:beforeVersion+1,changed_fields:[asset==='avatar'?'avatar':'branding']}}};
      },
      idempotency:{policySchema:z.strictObject({asset:z.enum(['avatar','logo','favicon']),owner_id:z.uuid()}),authorizeStored:async(_tx,context,_input,stored)=>{if(stored.asset!==asset||stored.owner_id!==context.actor.userId)throw new AppError('FORBIDDEN');},
        summarize:(data,context)=>({outcome:asset==='avatar'?(bytes?'avatar_updated':'avatar_removed'):(bytes?'branding_asset_updated':'branding_asset_removed'),resource_id:asset==='avatar'?context.actor.userId:null,version:'user_version' in data?data.user_version:data.version,completed_at:context.now.toISOString()}),policyContext:(_data,context)=>({asset,owner_id:context.actor.userId})},
    });
    const operation=(asset==='avatar'?'me.avatar':'settings.branding.'+asset)+(bytes?'.update':'.delete');
    try{return await createMutationGateway(pool,secrets,{[operation]:definition})(operation,ref,{...parsed.data,source_sha256:hash},meta,key,budget===undefined?undefined:budget-(performance.now()-started));}
    finally{if(candidate)await storage.orphan(candidate).catch(()=>undefined);}
  }
  async function read(asset:'avatar'|'branding',ref:Ref,id:unknown,rawQuery:unknown={}){
    const context=asset==='avatar'?await authenticateRead(pool,{token:ref.token,epoch:secrets.epoch}):null;
    const parsed=z.uuid().safeParse(id),query=(asset==='avatar'?z.strictObject({}):MediaReadQuerySchema).safeParse(rawQuery);if(!parsed.success||!query.success)throw new AppError('VALIDATION_ERROR');
    const result=await withTransaction(pool,'read',async tx=>{
      let file:StoredFile|undefined;
      if(asset==='avatar'){
        file=(await tx.query<StoredFile>("SELECT f.* FROM file_objects f JOIN users u ON u.avatar_file_id=f.id AND u.id=f.owner_id WHERE f.id=$1 AND f.purpose='avatar' AND f.state='attached' AND u.status<>'deleted'",[parsed.data])).rows[0];
        if(!file)throw new AppError('NOT_FOUND');
        if(file.owner_id!==context!.actor.userId){if(!context!.permissions.has('user:read'))throw new AppError('NOT_FOUND');const owner=await loadAccess(tx,file.owner_id!);if(!owner)throw new AppError('NOT_FOUND');try{assertManageableTarget(context!.actor,owner);if(owner.roles.some(role=>!role.isDelegable||['admin','super_admin'].includes(role.code)||role.permissionCodes.some(code=>permissionDefinitions.find(p=>p.code===code)?.reserved))&&(!isSuperAdmin(context!.actor)||!context!.permissions.has('user:manage-privileged')))throw new AppError('FORBIDDEN');}catch{throw new AppError('NOT_FOUND');}}
      }else file=(await tx.query<StoredFile>(`SELECT f.* FROM file_objects f CROSS JOIN system_settings b WHERE b.key='branding' AND f.id=$1 AND f.state='attached' AND ((f.purpose='brand_logo' AND b.typed_value->>'logo_file_id'=f.id::text) OR (f.purpose='brand_favicon' AND b.typed_value->>'favicon_file_id'=f.id::text))`,[parsed.data])).rows[0];
      if(!file)throw new AppError('NOT_FOUND');let storageKey=file.storage_key;
      const size='size' in query.data?query.data.size:undefined;if(size&&file.purpose!=='brand_favicon')throw new AppError('VALIDATION_ERROR');
      if(size==='32'){const variant=(await tx.query<{storage_key:string}>('SELECT storage_key FROM file_variants WHERE file_id=$1 AND size=32',[file.id])).rows[0];if(!variant)throw new AppError('NOT_FOUND');storageKey=variant.storage_key;}
      return {key:storageKey,contentType:file.content_type};
    });
    return {...result,bytes:await storage.read(result.key),cacheControl:asset==='avatar'?'no-store':'public, max-age=31536000, immutable'};
  }
  return {preflight,mutate,read};
}
