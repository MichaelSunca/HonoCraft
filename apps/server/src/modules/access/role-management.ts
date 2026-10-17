import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import {AppError} from '@honocraft/contracts/errors';
import {PERMISSION_CODES,permissionDefinitions,type PermissionCode} from '@honocraft/contracts/permissions';
import {RoleCreateSchema,RoleUpdateSchema,RoleCopySchema,RoleDeleteSchema,RoleEligibilitySchema,RoleDtoSchema,RoleDeletedSchema} from '@honocraft/contracts/roles';
import {databaseNow,type Tx} from '../../infrastructure/db.js';
import {createMutationGateway,defineMutation} from './mutation-gateway.js';
import {assertPermissionDependencies,assertRegistrationRole,assertRoleCopyable,assertRoleEditable,isSuperAdmin,requireRecentAuthentication,type RoleSnapshot} from './policy.js';
import {registeredPermissionCodes} from './repository.js';
import {projectRole,readRoleRow,type RoleRow} from './queries.js';
import type {SessionContext} from '../auth/sessions.js';
import type {RequestMeta,AuditEvent} from '../audit/writer.js';
import {appendSecurityEvent} from '../audit/security-writer.js';

const schemas={create:RoleCreateSchema,update:RoleUpdateSchema,copy:RoleCopySchema,delete:RoleDeleteSchema,eligibility:RoleEligibilitySchema};
type Kind=keyof typeof schemas;
const InputSchema=z.discriminatedUnion('kind',[
  RoleCreateSchema.extend({kind:z.literal('create')}),RoleUpdateSchema.safeExtend({kind:z.literal('update')}),RoleCopySchema.extend({kind:z.literal('copy')}),
  RoleDeleteSchema.extend({kind:z.literal('delete')}),RoleEligibilitySchema.extend({kind:z.literal('eligibility')}),
]);
const SnapshotSchema=z.strictObject({id:z.uuid(),code:z.string(),isBuiltin:z.boolean(),isDelegable:z.boolean(),isRegistrationDefaultEligible:z.boolean(),permissionCodes:z.array(z.enum(PERMISSION_CODES)),version:z.number().int().positive()});
const StoredPolicy=z.strictObject({id:z.uuid(),before:SnapshotSchema.nullable(),after:SnapshotSchema.nullable(),assigned_to_privileged_before:z.boolean(),high_risk:z.boolean()});
type Input=z.infer<typeof InputSchema>;
type Ref={token:string;csrfToken:string};
type Secrets={epoch:string;csrfKey:Buffer;digestKey:{id:string;key:Buffer}};
const snapshot=(row:RoleRow)=>({id:row.id,code:row.code,isBuiltin:row.is_builtin,isDelegable:row.is_delegable,isRegistrationDefaultEligible:row.is_registration_default_eligible,permissionCodes:row.permission_codes,version:row.version});
const reserved=(codes:readonly PermissionCode[])=>codes.some(code=>permissionDefinitions.find(item=>item.code===code)?.reserved);
async function codesAllowed(tx:Tx,context:SessionContext,codes:readonly PermissionCode[]){
  const enabled=await registeredPermissionCodes(tx);if(codes.some(code=>!enabled.has(code)))throw new AppError('VALIDATION_ERROR');
  assertPermissionDependencies(codes);
  if(!isSuperAdmin(context.actor)&&codes.some(code=>!context.permissions.has(code)||!permissionDefinitions.find(item=>item.code===code)?.delegable||permissionDefinitions.find(item=>item.code===code)?.reserved))throw new AppError('FORBIDDEN');
}
function qualifications(role:RoleSnapshot,references:RoleRow['reference_counts']){
  const registrationUse=references.pending_registrations+references.registration_defaults>0;
  if(registrationUse&&!role.isRegistrationDefaultEligible)throw new AppError('REGISTRATION_ROLE_IN_USE');
  if(role.isRegistrationDefaultEligible||registrationUse)assertRegistrationRole(role);
  if(role.isDelegable&&role.permissionCodes.some(code=>!permissionDefinitions.find(item=>item.code===code)?.delegable))throw new AppError('VALIDATION_ERROR');
}
async function confirmation(tx:Tx,context:SessionContext,input:Input,code:string,high:boolean){
  if(high){if(!isSuperAdmin(context.actor))throw new AppError('FORBIDDEN');requireRecentAuthentication(context.reauthenticatedAt,await databaseNow(tx));}
  const value=input.confirmation;if(!value){if(high)throw new AppError('VALIDATION_ERROR');return;}
  if(input.kind==='create'){
    if(!('target_code' in value)||value.target_code!==code)throw new AppError('VALIDATION_ERROR');
  }else if(!('target_id' in value)||value.target_id!==input.id)throw new AppError('VALIDATION_ERROR');
  if((high||input.kind==='delete')&&value.typed_label!==code)throw new AppError('VALIDATION_ERROR');
}
function qualificationAuthority(context:SessionContext,before:RoleSnapshot,after:RoleSnapshot){
  if(!isSuperAdmin(context.actor))throw new AppError('FORBIDDEN');
  if(before.isDelegable!==after.isDelegable&&!context.permissions.has('role:delegate'))throw new AppError('FORBIDDEN');
  if(before.isRegistrationDefaultEligible!==after.isRegistrationDefaultEligible&&!context.permissions.has('settings:update-security'))throw new AppError('FORBIDDEN');
}
async function putPermissions(tx:Tx,id:string,codes:readonly PermissionCode[]){
  await tx.query('DELETE FROM role_permissions WHERE role_id=$1',[id]);
  await tx.query('INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code=ANY($2::text[])',[id,codes]);
}
async function mustRead(tx:Tx,id:string){const row=await readRoleRow(tx,id);if(!row)throw new AppError('NOT_FOUND');return row;}
async function historicalAuthority(tx:Tx,context:SessionContext,kind:Kind,stored:z.infer<typeof StoredPolicy>){
  if(kind==='eligibility'&&!isSuperAdmin(context.actor))throw new AppError('FORBIDDEN');
  if(kind==='eligibility'&&stored.before&&stored.after)qualificationAuthority(context,stored.before,stored.after);
  let high=stored.high_risk;
  for(const role of [stored.before,stored.after])if(role){await codesAllowed(tx,context,role.permissionCodes);high ||=reserved(role.permissionCodes);}
  if(stored.before){
    if(kind==='copy')assertRoleCopyable(context.actor,stored.before,stored.assigned_to_privileged_before);else assertRoleEditable(context.actor,stored.before,stored.assigned_to_privileged_before);
    const current=await readRoleRow(tx,stored.before.id);
    if(current){const role=snapshot(current);await codesAllowed(tx,context,role.permissionCodes);high ||=reserved(role.permissionCodes);
      if(kind==='copy')assertRoleCopyable(context.actor,role,current.assigned_to_privileged);else assertRoleEditable(context.actor,role,current.assigned_to_privileged);
    }else if(kind!=='delete')throw new AppError('NOT_FOUND');
  }
  if(stored.after){const current=await readRoleRow(tx,stored.after.id);if(current){await codesAllowed(tx,context,current.permission_codes);high ||=reserved(current.permission_codes);}}
  if(high&&!isSuperAdmin(context.actor))throw new AppError('FORBIDDEN');return high;
}
export async function authorizeRoleOperationResult(tx:Tx,context:SessionContext,kind:Kind,raw:unknown){
  const stored=StoredPolicy.parse(raw);
  if(kind==='create'?stored.before!==null||stored.after===null:kind==='delete'?stored.before===null||stored.after!==null:stored.before===null||stored.after===null)throw new AppError('NOT_FOUND');
  if(kind!=='copy'&&stored.before&&stored.before.id!==stored.id)throw new AppError('NOT_FOUND');
  if((stored.after?.id??stored.before?.id)!==stored.id)throw new AppError('NOT_FOUND');
  await historicalAuthority(tx,context,kind,stored);return stored.id;
}
export function createRoleManagement(pool:Pool,secrets:Secrets){
  function definition(kind:Kind,meta:RequestMeta){
    let before:RoleRow|undefined,after:RoleRow|undefined,high=false,affected:string[]=[];
    return defineMutation({input:InputSchema,output:z.union([RoleDtoSchema,RoleDeletedSchema]),mode:'exclusive',permission:'role:manage',recentAuth:false,
      auditAction:`access.role.${({create:'created',copy:'copied',update:'updated',delete:'deleted',eligibility:'qualified'} as const)[kind]}`,
      resolveLocks:async(tx,input)=>{
        if(input.kind==='create')return {userIds:[],roleIds:[]};
        const users=(await tx.query<{user_id:string}>('SELECT user_id FROM user_roles WHERE role_id=$1 ORDER BY user_id',[input.id])).rows.map(row=>row.user_id);
        const needsSessions=input.kind==='eligibility'||(input.kind==='update'&&input.permission_codes!==undefined);
        const sessions=needsSessions?(await tx.query<{id:string}>('SELECT id FROM sessions WHERE user_id=ANY($1::uuid[]) ORDER BY id',[users])).rows.map(row=>row.id):undefined;
        return {userIds:users,roleIds:[input.id],...(sessions?{sessionIds:sessions}:{})};
      },
      authorize:async(tx,context,input)=>{
        before=undefined;after=undefined;high=false;affected=[];
        if(input.kind==='eligibility'&&!isSuperAdmin(context.actor))throw new AppError('FORBIDDEN');
        if(input.kind==='create'){
          await codesAllowed(tx,context,input.permission_codes);high=reserved(input.permission_codes);await confirmation(tx,context,input,input.code,high);return;
        }
        before=await mustRead(tx,input.id);const current=snapshot(before);
        if(input.kind==='copy')assertRoleCopyable(context.actor,current,before.assigned_to_privileged);else assertRoleEditable(context.actor,current,before.assigned_to_privileged);
        const proposed:RoleSnapshot={...current,...(input.kind==='update'&&input.permission_codes!==undefined?{permissionCodes:input.permission_codes}:{}),
          ...(input.kind==='eligibility'?{isDelegable:input.is_delegable,isRegistrationDefaultEligible:input.is_registration_default_eligible}:{})};
        await codesAllowed(tx,context,current.permissionCodes);await codesAllowed(tx,context,proposed.permissionCodes);
        high=input.kind==='eligibility'||reserved(current.permissionCodes)||reserved(proposed.permissionCodes);
        await confirmation(tx,context,input,current.code,high);
        if(before.version!==input.expected_version)throw new AppError('VERSION_CONFLICT');
        if(input.kind==='update'||input.kind==='eligibility')qualifications(proposed,before.reference_counts);
        if(input.kind==='eligibility')qualificationAuthority(context,current,proposed);
        if(input.kind==='delete'&&Object.values(before.reference_counts).some(count=>count>0))throw new AppError('ROLE_IN_USE',Object.fromEntries(Object.entries(before.reference_counts).filter(([,count])=>count>0).map(([key,count])=>['reference_counts.'+key,[String(count)]])));
      },
      execute:async(tx,context,input)=>{
        let id:string;
        if(input.kind==='create'||input.kind==='copy'){
          id=randomUUID();const code=input.kind==='create'?input.code:input.new_code,name=input.kind==='create'?input.name:input.new_name;
          try{await tx.query('INSERT INTO roles(id,code,name,description) VALUES($1,$2,$3,$4)',[id,code,name,input.kind==='create'?input.description:before!.description]);}
          catch(error){if(typeof error==='object'&&error!==null&&'code' in error&&error.code==='23505'&&'constraint' in error&&error.constraint==='roles_code_key')throw new AppError('ROLE_CODE_CONFLICT');throw error;}
          await putPermissions(tx,id,input.kind==='create'?input.permission_codes:before!.permission_codes);
          after=await mustRead(tx,id);
        }else if(input.kind==='delete'){
          id=input.id;await tx.query('DELETE FROM role_permissions WHERE role_id=$1',[id]);await tx.query('DELETE FROM roles WHERE id=$1',[id]);
        }else{
          id=input.id;
          if(input.kind==='update'){
            await tx.query('UPDATE roles SET name=$2,description=$3,version=version+1,updated_at=clock_timestamp() WHERE id=$1',[id,input.name??before!.name,input.description??before!.description]);
            if(input.permission_codes!==undefined)await putPermissions(tx,id,input.permission_codes);
          }else await tx.query('UPDATE roles SET is_delegable=$2,is_registration_default_eligible=$3,version=version+1,updated_at=clock_timestamp() WHERE id=$1',[id,input.is_delegable,input.is_registration_default_eligible]);
          after=await mustRead(tx,id);
          const securityChanged=JSON.stringify(before!.permission_codes)!==JSON.stringify(after.permission_codes)||before!.is_delegable!==after.is_delegable||before!.is_registration_default_eligible!==after.is_registration_default_eligible;
          if(securityChanged){
            affected=(await tx.query<{id:string}>('UPDATE users SET authorization_version=authorization_version+1,version=version+1,updated_at=clock_timestamp() WHERE id IN (SELECT user_id FROM user_roles WHERE role_id=$1) RETURNING id',[id])).rows.map(row=>row.id);
            await tx.query("UPDATE sessions SET revoked_at=clock_timestamp(),revoked_reason='role_changed' WHERE user_id=ANY($1::uuid[]) AND revoked_at IS NULL",[affected]);
            await appendSecurityEvent(tx,{userId:context.actor.userId,type:'access.role.permissions_changed',result:'success',reasonCode:null,targetDigest:null,meta});
          }
        }
        const creating=input.kind==='create'||input.kind==='copy',oldPermissions=creating?[]:before?.permission_codes??[],newPermissions=after?.permission_codes??[];
        const changes:AuditEvent['changes']={...(before?{before_version:before.version}:{}),...(after?{after_version:after.version}:{}),affected_count:affected.length,
          permissions_added:newPermissions.filter(code=>!oldPermissions.includes(code)),permissions_removed:oldPermissions.filter(code=>!newPermissions.includes(code)),
          ...(before?{is_delegable_before:before.is_delegable,is_registration_default_eligible_before:before.is_registration_default_eligible}:{}),
          ...(after?{is_delegable_after:after.is_delegable,is_registration_default_eligible_after:after.is_registration_default_eligible}:{})};
        return {data:after?projectRole(context,after):{id,deleted:true as const},status:creating?201:200,
          audit:{target:{type:'role',id},changes,...(input.confirmation?{reason:input.confirmation.reason}:{})}};
      },
      idempotency:{policySchema:StoredPolicy,
        authorizeStored:async(tx,context,input,stored)=>{
          const historicalHigh=await historicalAuthority(tx,context,input.kind,stored);
          await confirmation(tx,context,input,stored.before?.code??stored.after!.code,historicalHigh);
        },
        summarize:(data,context)=>({outcome:`role_${({create:'created',copy:'copied',update:'updated',delete:'deleted',eligibility:'qualified'} as const)[kind]}`,resource_id:data.id,version:'version' in data?data.version:before!.version,completed_at:context.now.toISOString()}),
        policyContext:data=>({id:data.id,before:before?snapshot(before):null,after:after?snapshot(after):null,assigned_to_privileged_before:before?.assigned_to_privileged??false,high_risk:high}),
      },
    });
  }
  async function run(kind:Kind,ref:Ref,raw:unknown,meta:RequestMeta,key?:string,budget?:number){
    const parsed=schemas[kind].safeParse(raw);if(!parsed.success)throw new AppError('VALIDATION_ERROR');
    return createMutationGateway(pool,secrets,{[`roles.${kind}`]:definition(kind,meta)})(`roles.${kind}`,ref,{...parsed.data,kind},meta,key,budget);
  }
  return {
    create:(ref:Ref,input:unknown,meta:RequestMeta,key?:string,budget?:number)=>run('create',ref,input,meta,key,budget),
    update:(ref:Ref,input:unknown,meta:RequestMeta,key?:string,budget?:number)=>run('update',ref,input,meta,key,budget),
    copy:(ref:Ref,input:unknown,meta:RequestMeta,key?:string,budget?:number)=>run('copy',ref,input,meta,key,budget),
    delete:(ref:Ref,input:unknown,meta:RequestMeta,key?:string,budget?:number)=>run('delete',ref,input,meta,key,budget),
    eligibility:(ref:Ref,input:unknown,meta:RequestMeta,key?:string,budget?:number)=>run('eligibility',ref,input,meta,key,budget),
  };
}
