import type {Pool} from 'pg';
import {z} from 'zod';
import {AppError} from '@honocraft/contracts/errors';
import {BrandingValueSchema,SecurityValueSchema,BrandingSettingsSchema,SecuritySettingsSchema,SettingsSchema,BrandingUpdateSchema,SecurityUpdateSchema,BRANDING_SETTING_KEYS,SECURITY_SETTING_KEYS} from '@honocraft/contracts/settings';
import {withTransaction,type Tx} from '../../infrastructure/db.js';
import {authenticateRead,type SessionContext} from '../auth/sessions.js';
import {createMutationGateway,defineMutation} from '../access/mutation-gateway.js';
import {assertRegistrationRole,isSuperAdmin} from '../access/policy.js';
import {readRoleSnapshots} from '../auth/credentials.js';
import type {AuditEvent,RequestMeta} from '../audit/writer.js';
import {appendSecurityEvent} from '../audit/security-writer.js';
type Group='branding'|'security';
type Row={key:Group;typed_value:Record<string,unknown>;registration_default_role_id:string|null;version:number};
type Ref={token:string;csrfToken:string};
type Secrets={epoch:string;csrfKey:Buffer;digestKey:{id:string;key:Buffer}};
const InputSchema=z.discriminatedUnion('kind',[BrandingUpdateSchema.extend({kind:z.literal('branding')}),SecurityUpdateSchema.safeExtend({kind:z.literal('security')})]);
async function rowAt(tx:Tx,group:Group,lock=false){const row=(await tx.query<Row>(`SELECT key,typed_value,registration_default_role_id,version FROM system_settings WHERE key=$1${lock?' FOR UPDATE':''}`,[group])).rows[0];if(!row)throw new AppError('DEPENDENCY_UNAVAILABLE');return row;}
function brandingValue(row:Row){const parsed=BrandingValueSchema.safeParse(row.typed_value);if(!parsed.success)throw new AppError('DEPENDENCY_UNAVAILABLE');return parsed.data;}
function securityValue(row:Row){const parsed=SecurityValueSchema.safeParse({...row.typed_value,registration_default_role_id:row.registration_default_role_id});if(!parsed.success)throw new AppError('DEPENDENCY_UNAVAILABLE');return parsed.data;}
function projected(row:Row,context:SessionContext){
  const allowed=context.permissions.has(row.key==='branding'?'settings:update-branding':'settings:update-security')&&(row.key==='branding'||isSuperAdmin(context.actor));
  const meta={version:row.version,allowed_actions:allowed?['update']:[],requires_reauth_actions:allowed&&row.key==='security'?['update']:[]};
  return row.key==='branding'?BrandingSettingsSchema.parse({...brandingValue(row),...meta}):SecuritySettingsSchema.parse({...securityValue(row),...meta});
}
export function createSettingsManagement(pool:Pool,secrets:Secrets){
  async function read(ref:{token:string},query:unknown={}){const context=await authenticateRead(pool,{token:ref.token,epoch:secrets.epoch});if(!context.permissions.has('settings:read'))throw new AppError('FORBIDDEN');if(!z.strictObject({}).safeParse(query).success)throw new AppError('VALIDATION_ERROR');
    return withTransaction(pool,'read',async tx=>SettingsSchema.parse({branding:projected(await rowAt(tx,'branding'),context),security:projected(await rowAt(tx,'security'),context)}));
  }
  function definition(group:Group,meta:RequestMeta){let before:Row;
    return defineMutation({input:InputSchema,output:z.union([BrandingSettingsSchema,SecuritySettingsSchema]),mode:group==='branding'?'shared':'exclusive',permission:group==='branding'?'settings:update-branding':'settings:update-security',recentAuth:group==='security',auditAction:`settings.${group}.updated`,
      resolveLocks:async(tx,input)=>{
        if(input.kind==='branding')return {userIds:[],roleIds:[]};const row=await rowAt(tx,'security');
        const sessions=(await tx.query<{id:string}>('SELECT id FROM sessions WHERE revoked_at IS NULL ORDER BY id')).rows.map(row=>row.id);
        return {userIds:[],roleIds:[input.registration_default_role_id,...(row.registration_default_role_id?[row.registration_default_role_id]:[])],sessionIds:sessions};
      },
      authorize:async(tx,context,input)=>{
        if(input.kind!==group)throw new AppError('VALIDATION_ERROR');if(group==='security'&&!isSuperAdmin(context.actor))throw new AppError('FORBIDDEN');before=await rowAt(tx,group,true);
        if(before.version!==input.expected_version)throw new AppError('VERSION_CONFLICT');
        if(input.kind==='security'){const role=(await readRoleSnapshots(tx,[input.registration_default_role_id]))[0];if(!role)throw new AppError('REGISTRATION_ROLE_INVALID');assertRegistrationRole(role);}
      },
      execute:async(tx,context,input)=>{
        const changes:AuditEvent['changes']={before_version:before.version,after_version:before.version+1,changed_fields:[group]};
        if(input.kind==='branding'){
          const old=brandingValue(before),{kind:_,expected_version:__,...editable}=input,after={...old,...editable};changes.setting_keys=BRANDING_SETTING_KEYS.filter(key=>old[key]!==after[key]);
          await tx.query("UPDATE system_settings SET typed_value=$1,version=version+1,updated_by=$2,updated_at=clock_timestamp() WHERE key='branding'",[after,context.actor.userId]);
        }else{
          const old=securityValue(before),{kind:_,expected_version:__,confirmation:___,registration_default_role_id,...json}=input,after={...json,registration_default_role_id};
          changes.setting_keys=SECURITY_SETTING_KEYS.filter(key=>old[key]!==after[key]);changes.settings_before=old;changes.settings_after=after;
          await tx.query("UPDATE system_settings SET typed_value=$1,registration_default_role_id=$2,version=version+1,updated_by=$3,updated_at=clock_timestamp() WHERE key='security'",[json,registration_default_role_id,context.actor.userId]);
          // Persist only tighter issued deadlines, including sessions that never request while the policy is tight.
          await tx.query(`UPDATE sessions SET absolute_expires_at=LEAST(absolute_expires_at,created_at+make_interval(mins=>$1)),
            idle_expires_at=LEAST(idle_expires_at,last_seen_at+make_interval(mins=>$2),absolute_expires_at,created_at+make_interval(mins=>$1)) WHERE revoked_at IS NULL`,[after.session_absolute_minutes,after.session_idle_minutes]);
          await appendSecurityEvent(tx,{userId:context.actor.userId,type:'settings.security_changed',result:'success',reasonCode:null,targetDigest:null,meta});
        }
        return {data:projected(await rowAt(tx,group),context),audit:{target:{type:'settings'},changes,...(input.kind==='security'?{reason:input.confirmation.reason}:{})}};
      },
      idempotency:{policySchema:z.strictObject({group:z.enum(['branding','security'])}),authorizeStored:async(_tx,context,input,stored)=>{if(stored.group!==group||input.kind!==group)throw new AppError('FORBIDDEN');if(group==='security'&&!isSuperAdmin(context.actor))throw new AppError('FORBIDDEN');},
        summarize:(data,context)=>({outcome:group==='branding'?'branding_updated':'security_updated',resource_id:null,version:data.version,completed_at:context.now.toISOString()}),policyContext:()=>({group})},
    });
  }
  async function update(group:Group,ref:Ref,raw:unknown,meta:RequestMeta,key?:string,budget?:number){const parsed=(group==='branding'?BrandingUpdateSchema:SecurityUpdateSchema).safeParse(raw);if(!parsed.success)throw new AppError('VALIDATION_ERROR');
    return createMutationGateway(pool,secrets,{[`settings.${group}`]:definition(group,meta)})(`settings.${group}`,ref,{...parsed.data,kind:group},meta,key,budget);}
  return {read,branding:(ref:Ref,input:unknown,meta:RequestMeta,key?:string,budget?:number)=>update('branding',ref,input,meta,key,budget),security:(ref:Ref,input:unknown,meta:RequestMeta,key?:string,budget?:number)=>update('security',ref,input,meta,key,budget)};
}
