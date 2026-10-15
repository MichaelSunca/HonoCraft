import type {Pool} from 'pg';
import {z} from 'zod';
import {AppError} from '@honocraft/contracts/errors';
import {NoteDtoSchema,NoteListSchema,NoteQuerySchema,NoteInputSchema,NoteUpdateSchema,NoteDeleteInputSchema,NoteDeleteResultSchema} from '@honocraft/contracts/notes';
import {withTransaction,type Tx} from '../../infrastructure/db.js';
import type {DigestKey} from '../../infrastructure/idempotency.js';
import type {RequestMeta} from '../audit/writer.js';
import {authenticateRead,type SessionContext} from '../auth/sessions.js';
import {createMutationGateway,defineMutation} from '../access/mutation-gateway.js';
import {ownedNote,ownedNotes,type NoteRow} from './repository.js';
type Ref={token:string;csrfToken:string};
type Secrets={epoch:string;csrfKey:Buffer;digestKey:DigestKey};
const policySchema=z.strictObject({owner_id:z.uuid(),note_id:z.uuid()});
async function enabled(tx:Tx){if(!(await tx.query<{example_notes_enabled:boolean}>('SELECT example_notes_enabled FROM system_state WHERE id=1')).rows[0]?.example_notes_enabled)throw new AppError('NOT_FOUND');}
function readable(context:SessionContext){if(!context.permissions.has('example-note:read'))throw new AppError('FORBIDDEN');}
function dto(row:NoteRow,context:SessionContext){return NoteDtoSchema.parse({...row,created_at:row.created_at.toISOString(),updated_at:row.updated_at.toISOString(),allowed_actions:[...(context.permissions.has('example-note:update')?['update']:[]),...(context.permissions.has('example-note:delete')?['delete']:[])]});}
export function createNotesService(pool:Pool,secrets:Secrets){
  const preflight=()=>withTransaction(pool,'read',enabled);
  const create=defineMutation({input:NoteInputSchema,output:NoteDtoSchema,mode:'shared',permission:'example-note:create',recentAuth:false,auditAction:'example.notes.created',
    resolveLocks:async()=>({userIds:[],roleIds:[]}),authorize:async(tx,context)=>{await enabled(tx);readable(context);},
    execute:async(tx,context,input)=>{const row=(await tx.query<NoteRow>('INSERT INTO example_notes(owner_id,title,body) VALUES($1,$2,$3) RETURNING id,title,body,version,created_at,updated_at',[context.actor.userId,input.title,input.body])).rows[0]!;return {data:dto(row,context),status:201,audit:{target:{type:'note',id:row.id},changes:{after_version:row.version}}};},
    idempotency:{policySchema,authorizeStored:async(tx,context,_input,stored)=>{await enabled(tx);readable(context);if(stored.owner_id!==context.actor.userId)throw new AppError('NOT_FOUND');},summarize:(data,context)=>({outcome:'note_created',resource_id:data.id,version:data.version,completed_at:context.now.toISOString()}),policyContext:(data,context)=>({owner_id:context.actor.userId,note_id:data.id})},
  });
  const update=defineMutation({input:NoteUpdateSchema.extend({id:z.uuid()}),output:NoteDtoSchema,mode:'shared',permission:'example-note:update',recentAuth:false,auditAction:'example.notes.updated',
    resolveLocks:async()=>({userIds:[],roleIds:[]}),authorize:async(tx,context,input)=>{await enabled(tx);readable(context);const note=await ownedNote(tx,input.id,context.actor.userId,true);if(!note)throw new AppError('NOT_FOUND');if(note.version!==input.expected_version)throw new AppError('VERSION_CONFLICT');},
    execute:async(tx,context,input)=>{const row=(await tx.query<NoteRow>('UPDATE example_notes SET title=$3,body=$4,version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 AND version=$5 RETURNING id,title,body,version,created_at,updated_at',[input.id,context.actor.userId,input.title,input.body,input.expected_version])).rows[0];if(!row)throw new AppError('VERSION_CONFLICT');return {data:dto(row,context),audit:{target:{type:'note',id:row.id},changes:{before_version:input.expected_version,after_version:row.version}}};},
    idempotency:{policySchema,authorizeStored:async(tx,context,input,stored)=>{await enabled(tx);readable(context);if(stored.owner_id!==context.actor.userId||stored.note_id!==input.id)throw new AppError('NOT_FOUND');},summarize:(data,context)=>({outcome:'note_updated',resource_id:data.id,version:data.version,completed_at:context.now.toISOString()}),policyContext:(data,context)=>({owner_id:context.actor.userId,note_id:data.id})},
  });
  const remove=defineMutation({input:NoteDeleteInputSchema.extend({id:z.uuid()}),output:NoteDeleteResultSchema,mode:'shared',permission:'example-note:delete',recentAuth:false,auditAction:'example.notes.deleted',
    resolveLocks:async()=>({userIds:[],roleIds:[]}),authorize:async(tx,context,input)=>{await enabled(tx);readable(context);const note=await ownedNote(tx,input.id,context.actor.userId,true);if(!note)throw new AppError('NOT_FOUND');if(note.version!==input.expected_version)throw new AppError('VERSION_CONFLICT');},
    execute:async(tx,context,input)=>{const row=(await tx.query<{id:string;version:number}>('DELETE FROM example_notes WHERE id=$1 AND owner_id=$2 AND version=$3 RETURNING id,version',[input.id,context.actor.userId,input.expected_version])).rows[0];if(!row)throw new AppError('VERSION_CONFLICT');return {data:{...row,deleted:true as const},audit:{target:{type:'note',id:row.id},changes:{before_version:row.version}}};},
    idempotency:{policySchema,authorizeStored:async(tx,context,input,stored)=>{await enabled(tx);readable(context);if(stored.owner_id!==context.actor.userId||stored.note_id!==input.id)throw new AppError('NOT_FOUND');},summarize:(data,context)=>({outcome:'note_deleted',resource_id:data.id,version:data.version,completed_at:context.now.toISOString()}),policyContext:(data,context)=>({owner_id:context.actor.userId,note_id:data.id})},
  });
  const mutate=createMutationGateway(pool,secrets,{'example.notes.create':create,'example.notes.update':update,'example.notes.delete':remove});
  async function read<T>(ref:Ref,handler:(tx:Tx,context:SessionContext)=>Promise<T>){await preflight();const context=await authenticateRead(pool,{token:ref.token,epoch:secrets.epoch});readable(context);return withTransaction(pool,'read',async tx=>{await enabled(tx);return handler(tx,context);});}
  return {
    list:(ref:Ref,raw:unknown)=>read(ref,async(tx,context)=>{const parsed=NoteQuerySchema.safeParse(raw);if(!parsed.success)throw new AppError('VALIDATION_ERROR');const page=await ownedNotes(tx,context.actor.userId,parsed.data);return NoteListSchema.parse({items:page.rows.map(row=>dto(row,context)),page:parsed.data.page,page_size:parsed.data.page_size,total:page.total});}),
    get:(ref:Ref,id:unknown)=>read(ref,async(tx,context)=>{const parsed=z.uuid().safeParse(id);if(!parsed.success)throw new AppError('VALIDATION_ERROR');const note=await ownedNote(tx,parsed.data,context.actor.userId);if(!note)throw new AppError('NOT_FOUND');return dto(note,context);}),
    async write(operation:'create'|'update'|'delete',ref:Ref,id:unknown,raw:unknown,meta:RequestMeta,key?:string,budget?:number){const started=performance.now();await preflight();let input:unknown=raw;if(operation!=='create'){const parsed=(operation==='update'?NoteUpdateSchema:NoteDeleteInputSchema).safeParse(raw);if(!parsed.success)throw new AppError('VALIDATION_ERROR');input={...parsed.data,id};}return mutate(('example.notes.'+operation) as 'example.notes.create'|'example.notes.update'|'example.notes.delete',ref,input,meta,key,budget===undefined?undefined:budget-(performance.now()-started));},
  };
}
