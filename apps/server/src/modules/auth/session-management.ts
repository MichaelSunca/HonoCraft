import type {Pool} from 'pg';
import {z} from 'zod';
import {AppError} from '@honocraft/contracts/errors';
import {PaginationSchema} from '@honocraft/contracts/common';
import {DeviceSchema,SessionListSchema} from '@honocraft/contracts/http';
import {withTransaction} from '../../infrastructure/db.js';
import {createMutationGateway,defineMutation} from '../access/mutation-gateway.js';
import {authenticateLockedSession,locateSession} from './sessions.js';
import type {RequestMeta} from '../audit/writer.js';
import {appendSecurityEvent} from '../audit/security-writer.js';
type Ref={token:string;csrfToken:string};
type Secrets={epoch:string;csrfKey:Buffer;digestKey:{id:string;key:Buffer}};
function device(agent:string|null):z.infer<typeof DeviceSchema>{
  const ua=agent??'';
  return {category:/iPad|Tablet/i.test(ua)?'tablet':/Mobile|Android|iPhone/i.test(ua)?'mobile':/Windows|Macintosh|X11|Linux/i.test(ua)?'desktop':'unknown',
    browser:/Edg\//.test(ua)?'Edge':/Firefox\//.test(ua)?'Firefox':/Chrome\//.test(ua)?'Chrome':/Version\/.+Safari\//.test(ua)?'Safari':'unknown',
    os:/iPad|iPhone/.test(ua)?'iOS':/Android/.test(ua)?'Android':/Windows/.test(ua)?'Windows':/Macintosh/.test(ua)?'macOS':/Linux/.test(ua)?'Linux':'unknown'};
}
const target=z.strictObject({id:z.uuid()});
const revokeMutation=(meta:RequestMeta)=>defineMutation({
  input:target,output:z.strictObject({revoked:z.literal(true),is_current:z.boolean()}),mode:'exclusive',permission:null,recentAuth:false,auditAction:'auth.session.revoked',
  resolveLocks:async()=>({userIds:[],roleIds:[]}),
  authorize:async(tx,context,input)=>{if(!(await tx.query('SELECT id FROM sessions WHERE id=$1 AND user_id=$2',[input.id,context.actor.userId])).rowCount)throw new AppError('NOT_FOUND');},
  execute:async(tx,context,input)=>{
    const changed=await tx.query("UPDATE sessions SET revoked_at=$3,revoked_reason='user_revoked' WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL",[input.id,context.actor.userId,context.now]);
    if(changed.rowCount)await appendSecurityEvent(tx,{userId:context.actor.userId,type:'auth.session_revoked',result:'success',reasonCode:null,targetDigest:null,meta});
    return {data:{revoked:true as const,is_current:input.id===context.sessionId},audit:{target:{type:'session',id:input.id},changes:{affected_count:changed.rowCount??0}}};
  },
  idempotency:{policySchema:target,
    authorizeStored:async(tx,context,_input,stored)=>{if(!(await tx.query('SELECT id FROM sessions WHERE id=$1 AND user_id=$2',[stored.id,context.actor.userId])).rowCount)throw new AppError('NOT_FOUND');},
    summarize:(_data,context)=>({outcome:'session_revoked',resource_id:null,version:null,completed_at:context.now.toISOString()}),policyContext:(_data,_context,input)=>input,
  },
});
const revokeOthersMutation=(meta:RequestMeta)=>defineMutation({
  input:z.strictObject({}),output:z.strictObject({revoked_count:z.number().int().nonnegative()}),mode:'exclusive',permission:null,recentAuth:false,auditAction:'auth.sessions.others_revoked',
  resolveLocks:async()=>({userIds:[],roleIds:[]}),authorize:async()=>{},
  execute:async(tx,context)=>{
    const result=await tx.query("UPDATE sessions SET revoked_at=$3,revoked_reason='other_devices_revoked' WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL",[context.actor.userId,context.sessionId,context.now]);
    if(result.rowCount)await appendSecurityEvent(tx,{userId:context.actor.userId,type:'auth.session_revoked',result:'success',reasonCode:null,targetDigest:null,meta});
    return {data:{revoked_count:result.rowCount??0},audit:{target:{type:'user',id:context.actor.userId},changes:{affected_count:result.rowCount??0}}};
  },
  idempotency:{policySchema:z.strictObject({user_id:z.uuid()}),authorizeStored:async(_tx,context,_input,stored)=>{if(stored.user_id!==context.actor.userId)throw new AppError('FORBIDDEN');},
    summarize:(_data,context)=>({outcome:'other_sessions_revoked',resource_id:context.actor.userId,version:null,completed_at:context.now.toISOString()}),policyContext:(_data,context)=>({user_id:context.actor.userId})},
});
export function createSessionManagement(pool:Pool,secrets:Secrets){
  const mutate=(meta:RequestMeta)=>createMutationGateway(pool,secrets,{'auth.session.revoke':revokeMutation(meta),'auth.sessions.revoke_others':revokeOthersMutation(meta)});
  return {
    async list(ref:Ref,raw:unknown){
      const parsed=PaginationSchema.safeParse(raw);if(!parsed.success)throw new AppError('VALIDATION_ERROR');const {page,page_size}=parsed.data;
      return withTransaction(pool,'independent',async tx=>{
        const context=await authenticateLockedSession(tx,await locateSession(tx,ref.token),secrets.epoch);
        const row=(await tx.query<{total:number;items:Array<{id:string;user_agent:string|null;ip:string;created_at:string;last_seen_at:string;absolute_expires_at:string}>}>(`WITH valid AS (
          SELECT s.id,s.user_agent,host(s.ip) AS ip,s.created_at,s.last_seen_at,
            LEAST(s.absolute_expires_at,s.created_at+make_interval(mins=>(p.typed_value->>'session_absolute_minutes')::int)) AS absolute_expires_at
          FROM sessions s CROSS JOIN system_settings p WHERE p.key='security' AND s.user_id=$1 AND s.revoked_at IS NULL
          AND s.authorization_version=$2 AND s.credential_epoch=$3 AND s.last_seen_at<=$4
          AND $4<LEAST(s.idle_expires_at,s.last_seen_at+make_interval(mins=>(p.typed_value->>'session_idle_minutes')::int))
          AND $4<LEAST(s.absolute_expires_at,s.created_at+make_interval(mins=>(p.typed_value->>'session_absolute_minutes')::int))
        ), page AS (SELECT * FROM valid ORDER BY created_at DESC,id LIMIT $5 OFFSET $6)
        SELECT (SELECT count(*)::int FROM valid) AS total,COALESCE((SELECT jsonb_agg(page ORDER BY created_at DESC,id) FROM page),'[]'::jsonb) AS items`,
          [context.actor.userId,context.actor.authorizationVersion,secrets.epoch,context.now,page_size,(page-1)*page_size])).rows[0]!;
        return SessionListSchema.parse({page,page_size,total:row.total,items:row.items.map(({user_agent,...session})=>({...session,is_current:session.id===context.sessionId,device:device(user_agent)}))});
      });
    },
    revoke:(ref:Ref,raw:unknown,meta:RequestMeta,key?:string,budget?:number)=>mutate(meta)('auth.session.revoke',ref,raw,meta,key,budget),
    revokeOthers:(ref:Ref,raw:unknown,meta:RequestMeta,key?:string,budget?:number)=>mutate(meta)('auth.sessions.revoke_others',ref,raw,meta,key,budget),
  };
}
