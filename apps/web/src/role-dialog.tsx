import {useEffect,useRef,useState} from 'react';
import {useForm} from 'react-hook-form';
import {useQueryClient} from '@tanstack/react-query';
import {useTranslation} from 'react-i18next';
import {z} from 'zod';
import {RoleCreateSchema,RoleUpdateSchema,RoleCopySchema,RoleDeleteSchema,RoleEligibilitySchema,RoleDtoSchema,RoleDeletedSchema,type RoleDto} from '@honocraft/contracts/roles';
import {ReauthenticatedSchema,type Me} from '@honocraft/contracts/http';
import {permissionDefinitions,type PermissionCode} from '@honocraft/contracts/permissions';
import type {PermissionDto} from '@honocraft/contracts/permission-catalog';
import {api,ApiError,errorMessage,mutationOutcomeUnknown} from './api.js';
import {PermissionView,usePermissionCatalog} from './permission-view.js';
export type RoleOperation='create'|'update'|'copy'|'delete'|'eligibility';
type Fields={code:string;name:string;description:string;permission_codes:PermissionCode[];is_delegable:boolean;is_registration_default_eligible:boolean;reason:string;typed_label:string};
type Request={key:string;path:string;method:string;body:unknown};
const resultSchema=z.union([RoleDtoSchema,RoleDeletedSchema,z.object({outcome:z.enum(['role_created','role_updated','role_copied','role_deleted','role_qualified']),resource_id:z.uuid(),version:z.number().int(),completed_at:z.string()})]);
export function RoleDialog({me,kind,role,close,saved}:{me:Me;kind:RoleOperation;role?:RoleDto;close:()=>void;saved:(id:string,created:boolean,deleted:boolean)=>void}){
  const {t}=useTranslation(),client=useQueryClient(),dialog=useRef<HTMLDialogElement>(null),operation=useRef<Request|null>(null);
  const [target,setTarget]=useState(role),[latest,setLatest]=useState<RoleDto|null>(null),[conflict,setConflict]=useState(false),[gone,setGone]=useState(false);
  const [error,setError]=useState<unknown>(null),[busy,setBusy]=useState(false),[unknown,setUnknown]=useState(false),[reauth,setReauth]=useState(false),[password,setPassword]=useState(''),[verified,setVerified]=useState(false);
  const form=useForm<Fields>({defaultValues:{code:kind==='copy'?'':role?.code??'',name:kind==='copy'?role!.name+' copy':role?.name??'',description:role?.description??'',permission_codes:role?.permission_codes??[],is_delegable:role?.is_delegable??false,is_registration_default_eligible:role?.is_registration_default_eligible??false,reason:'',typed_label:''}});
  const values=form.watch(),catalog=usePermissionCatalog(me),permissions=catalog.data?.modules.flatMap(group=>group.permissions)??[];
  const creating=kind==='create',copying=kind==='copy',editing=kind==='update',qualifying=kind==='eligibility',deleting=kind==='delete',choosesPermissions=creating||editing;
  const superAdmin=me.roles.some(item=>item.code==='super_admin');
  const canGrant=(permission:PermissionDto)=>superAdmin||(me.permission_codes.includes(permission.code)&&permission.is_delegable&&!permission.is_reserved);
  const selected=choosesPermissions?values.permission_codes:target?.permission_codes??[];
  const missing=[...new Set(permissions.filter(p=>selected.includes(p.code)).flatMap(p=>p.dependencies.filter(code=>!selected.includes(code))))];
  const unavailable=choosesPermissions?selected.filter(code=>!permissions.some(p=>p.code===code&&canGrant(p))):[];
  const high=qualifying||!!target?.requires_reauth_actions.includes(kind==='create'?'copy':kind)||selected.some(code=>permissionDefinitions.find(p=>p.code===code)?.reserved);
  const typedRequired=high||deleting,expectedLabel=creating?values.code:target?.code;
  const validQualifications=!qualifying||(!values.is_delegable||selected.every(code=>permissions.find(p=>p.code===code)?.is_delegable))&&(!values.is_registration_default_eligible||selected.every(code=>permissions.find(p=>p.code===code)?.is_self_assignable));
  const canSubmit=!gone&&(creating?me.permission_codes.includes('role:manage'):!!target?.allowed_actions.includes(kind))&&
    (!choosesPermissions||!!catalog.data&&!missing.length&&!unavailable.length)&&validQualifications&&(!typedRequired||values.typed_label===expectedLabel);
  const frozen=busy||unknown;
  const title=creating?'createRole':editing?'editRole':copying?'copyRole':deleting?'deleteRole':'setQualifications';
  const fieldMessages={code:'roleCodeHelp',name:'roleNameHelp',description:'roleDescriptionHelp',reason:'roleReasonHelp'} as const;
  function textField(field:keyof typeof fieldMessages,multiline=false){
    const labels={code:'roleCode',name:'roleName',description:'roleDescription',reason:'reason'} as const,error=form.formState.errors[field];
    const attributes={id:'role-'+field,...form.register(field),'aria-invalid':!!error,'aria-describedby':error?'role-'+field+'-error':field==='code'?'role-code-help':undefined};
    return <div className="field"><label htmlFor={attributes.id}>{t(labels[field])}</label>{multiline?<textarea {...attributes}/>:<input {...attributes} disabled={field==='code'&&editing}/>}
      {error?<span className="field-error" id={'role-'+field+'-error'}>{t(fieldMessages[field])}</span>:field==='code'?<p className="hint" id="role-code-help">{t('roleCodeHelp')}</p>:null}</div>;
  }
  useEffect(()=>{const focused=document.activeElement,element=dialog.current;element?.showModal();return()=>{element?.close();if(focused instanceof HTMLElement)focused.focus();};},[]);
  function draft(){if(unknown)return;operation.current=null;setError(null);form.clearErrors();}
  async function loadLatest(){if(!target)return;setBusy(true);try{setLatest(await api('/roles/'+target.id,RoleDtoSchema,{protected:true}));void client.invalidateQueries({queryKey:['actor',me.user.id,'roles']});}catch(cause){setError(cause);if(cause instanceof ApiError&&cause.status===404)setGone(true);}finally{setBusy(false);}}
  async function submit(input:Fields){
    if(busy||reauth||conflict||!unknown&&!canSubmit)return;setBusy(true);setError(null);
    try{
      if(!operation.current){
        const confirmation={target_id:target?.id,reason:input.reason,...(typedRequired?{typed_label:input.typed_label}:{})};
        let data:unknown,path='/roles',method='POST';
        if(creating)data=RoleCreateSchema.parse({code:input.code,name:input.name,description:input.description,permission_codes:input.permission_codes,
          ...(input.reason||high?{confirmation:{target_code:input.code,reason:input.reason,...(typedRequired?{typed_label:input.typed_label}:{})}}:{})});
        else{
          const identity={id:target!.id,expected_version:target!.version};let parsed:{id:string};
          if(copying)parsed=RoleCopySchema.parse({...identity,new_code:input.code,new_name:input.name,...(input.reason||high?{confirmation}:{})});
          else if(editing)parsed=RoleUpdateSchema.parse({...identity,name:input.name,description:input.description,permission_codes:input.permission_codes,confirmation});
          else if(qualifying)parsed=RoleEligibilitySchema.parse({...identity,is_delegable:input.is_delegable,is_registration_default_eligible:input.is_registration_default_eligible,confirmation});
          else parsed=RoleDeleteSchema.parse({...identity,confirmation});
          const {id,...body}=parsed;data=body;path='/roles/'+id+(copying?'/copy':qualifying?'/eligibility':'');method=copying?'POST':qualifying?'PUT':deleting?'DELETE':'PATCH';
        }
        operation.current={key:crypto.randomUUID(),path,method,body:data};
      }
      const request=operation.current,result=await api(request.path,resultSchema,{method:request.method,body:request.body,csrf:me.csrf_token,idempotencyKey:request.key,protected:true});
      operation.current=null;saved('id' in result?result.id:result.resource_id,creating||copying,deleting);
    }catch(cause){
      if(cause instanceof z.ZodError){for(const issue of cause.issues){const path=issue.path[0]==='confirmation'?issue.path[1]:issue.path[0],key=(path==='new_code'?'code':path==='new_name'?'name':path) as keyof Fields;if(key&&key in input)form.setError(key,{message:t('invalid')});}setError(new ApiError('VALIDATION_ERROR'));}
      else setError(cause);
      const uncertain=mutationOutcomeUnknown(cause,unknown);setUnknown(uncertain);if(!uncertain)operation.current=null;
      if(cause instanceof ApiError&&cause.code==='REAUTH_REQUIRED'){setReauth(true);setVerified(false);}
      if(!uncertain&&cause instanceof ApiError&&['VERSION_CONFLICT','ROLE_IN_USE','FORBIDDEN','REGISTRATION_ROLE_IN_USE','REGISTRATION_ROLE_INVALID'].includes(cause.code)&&target){setConflict(true);await loadLatest();}
      if(cause instanceof ApiError&&cause.status===404)setGone(true);
    }finally{setBusy(false);}
  }
  async function verify(){setBusy(true);setError(null);try{await api('/auth/reauthenticate',ReauthenticatedSchema,{body:{current_password:password},csrf:me.csrf_token,protected:true});setReauth(false);setVerified(true);}catch(cause){setError(cause);}finally{setPassword('');setBusy(false);}}
  return <dialog className="role-dialog" ref={dialog} aria-labelledby="role-dialog-title" onCancel={event=>{event.preventDefault();if(!frozen)close();}}><h2 id="role-dialog-title">{t(title)}</h2>
    <p className="hint">{t(creating||copying?'roleCreatedHelp':deleting?'roleDeleteHelp':qualifying?'qualificationsHelp':'roleSecurityImpact')}</p>
    <form noValidate onSubmit={form.handleSubmit(submit)} onChange={draft}>
      <fieldset disabled={frozen} className="plain-fieldset">
        {(creating||editing||copying)?<>{textField('code')}{textField('name')}{!copying&&textField('description',true)}</>:<p className="wrap">{target?.name} · <code>{target?.code}</code></p>}
        {choosesPermissions&&<fieldset className="role-picker"><legend>{t('rolePermissions')}</legend>{!superAdmin&&<p className="hint">{t('roleScopeHelp')}</p>}{catalog.isPending?<p role="status">{t('loading')}</p>:catalog.isError?<div role="alert">{t(errorMessage(catalog.error))}<button type="button" onClick={()=>void catalog.refetch()}>{t('retry')}</button></div>:<PermissionView catalog={catalog.data} selected={values.permission_codes} canGrant={canGrant} onChange={codes=>{draft();form.setValue('permission_codes',codes);}}/>}
          {!!missing.length&&<p role="alert" className="notice error">{t('missingDependencies',{codes:missing.join(', ')})}</p>}
          {!!unavailable.length&&catalog.data&&<div role="alert" className="notice error">{t('unavailablePermissions',{codes:unavailable.join(', ')})}{unavailable.map(code=><button type="button" key={code} onClick={()=>{draft();form.setValue('permission_codes',values.permission_codes.filter(value=>value!==code));}}>{t('removeRole',{name:code})}</button>)}</div>}
        </fieldset>}
        {copying&&<p className="wrap">{t('rolePermissions')}: {selected.join(', ')||t('noPermissions')}</p>}
        {qualifying&&<><label className="role-choice"><input type="checkbox" {...form.register('is_delegable')}/>{t('roleDelegable')}</label><label className="role-choice"><input type="checkbox" {...form.register('is_registration_default_eligible')}/>{t('roleRegistrationEligible')}</label>{!validQualifications&&<p role="alert" className="notice error">{t('registrationRoleInvalid')}</p>}<p className="hint">{t('roleSecurityImpact')}</p></>}
        {(!creating&&!copying||high)&&textField('reason',true)}
        {typedRequired&&<div className="field"><label htmlFor="role-typed">{t('typeRoleCode')}</label><input id="role-typed" {...form.register('typed_label')}/><p className="hint"><code>{expectedLabel}</code></p></div>}
      </fieldset>
      {!!error&&<p role="alert" className="notice error">{t(error instanceof ApiError&&error.code==='VERSION_CONFLICT'?'roleConflict':error instanceof ApiError&&error.code==='AUTH_FAILED'?'currentPasswordIncorrect':errorMessage(error),{seconds:error instanceof ApiError?error.retryAfter:60})}</p>}
      {gone&&<p role="alert">{t('roleUnavailable')}</p>}{unknown&&<p>{t('roleRetryHelp')}</p>}
      {conflict&&!gone&&<section className="notice"><h3>{t('currentRole')}</h3>{latest?<><p className="wrap">{latest.name} · {latest.code} · {t('roleVersion',{version:latest.version})}</p><p className="wrap">{latest.description}</p><p className="wrap">{t('rolePermissions')}: {latest.permission_codes.join(', ')||t('noPermissions')}</p><p>{t('roleDelegable')}: {t(latest.is_delegable?'yes':'no')} · {t('roleRegistrationEligible')}: {t(latest.is_registration_default_eligible?'yes':'no')}</p><dl>{Object.entries(latest.reference_counts).map(([key,count])=><div key={key}><dt>{t('roleRef_'+key)}</dt><dd>{count}</dd></div>)}</dl><button type="button" onClick={()=>{setTarget(latest);setLatest(null);setConflict(false);setError(null);operation.current=null;}}>{t('useLatest')}</button></>:<button type="button" disabled={busy} onClick={()=>void loadLatest()}>{t('reloadVersion')}</button>}</section>}
      {verified&&<p role="status" className="notice">{t('roleVerifiedAgain')}</p>}
      <div className="dialog-actions"><button type="button" disabled={frozen} onClick={close}>{t('cancel')}</button><button className="primary" disabled={busy||conflict||reauth||(!unknown&&!canSubmit)}>{t(busy?'submitBusy':unknown?'retrySame':editing?'save':qualifying?'confirm':title)}</button></div>
    </form>
    {reauth&&<form className="reauth-form" onSubmit={event=>{event.preventDefault();void verify();}}><div className="field"><label htmlFor="role-password">{t('currentPassword')}</label><input id="role-password" type="password" autoComplete="current-password" required disabled={busy} value={password} onChange={event=>setPassword(event.target.value)}/></div><button className="primary" disabled={busy}>{t('verifyIdentity')}</button></form>}
  </dialog>;
}
