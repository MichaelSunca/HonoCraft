import {useEffect,useRef,useState} from 'react';
import {useForm} from 'react-hook-form';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {useTranslation} from 'react-i18next';
import {z} from 'zod';
import {BrandingEditableSchema,BrandingUpdateSchema,BrandingSettingsSchema,SecurityValueSchema,SecurityUpdateSchema,SecuritySettingsSchema,SettingsSchema,BRANDING_SETTING_KEYS,SECURITY_SETTING_KEYS,type Settings} from '@honocraft/contracts/settings';
import {MeSchema,ReauthenticatedSchema,type Me} from '@honocraft/contracts/http';
import {ReauthenticateSchema} from '@honocraft/contracts/common';
import {RoleDtoSchema,RoleListSchema,type RoleDto} from '@honocraft/contracts/roles';
import {permissionDefinitions} from '@honocraft/contracts/permissions';
import {api,ApiError,errorMessage,mutationOutcomeUnknown} from './api.js';
import type {MessageKey} from './i18n.js';
import {useRoleLabel} from './user-role-picker.js';
import {BrandAssets} from './media.js';
type Group='branding'|'security';
type Fields=z.infer<typeof BrandingEditableSchema>&z.infer<typeof SecurityValueSchema>&{reason:string;typed_label:string};
const labels:Record<typeof BRANDING_SETTING_KEYS[number]|typeof SECURITY_SETTING_KEYS[number],MessageKey>={
  instance_name:'instanceName',copyright:'copyright',default_locale:'defaultLanguage',default_theme:'defaultAppearance',timezone:'instanceTimezone',
  registration_open:'registrationOpen',registration_default_role_id:'registrationRole',password_min_length:'minimumPassword',session_idle_minutes:'sessionIdle',session_absolute_minutes:'sessionAbsolute',email_verify_hours:'emailVerifyHours',password_reset_minutes:'resetMinutes',invite_hours:'inviteHours',email_change_hours:'emailChangeHours',login_ip_per_minute:'loginIpLimit',account_failures_per_window:'accountFailures',account_lock_minutes:'accountLock',mail_cooldown_seconds:'mailCooldown',mail_target_per_hour:'mailTargetLimit',mail_ip_per_hour:'mailIpLimit',
};
const numbers=[['password_min_length',15,64],['session_idle_minutes',5,30],['session_absolute_minutes',30,480],['email_verify_hours',1,48],['password_reset_minutes',10,60],['invite_hours',1,168],['email_change_hours',1,48],['login_ip_per_minute',1,20],['account_failures_per_window',1,5],['account_lock_minutes',15,60],['mail_cooldown_seconds',60,3600],['mail_target_per_hour',1,5],['mail_ip_per_hour',1,20]] as const;
const resultSchema=z.union([BrandingSettingsSchema,SecuritySettingsSchema,z.strictObject({outcome:z.enum(['branding_updated','security_updated']),resource_id:z.null(),version:z.number().int().positive(),completed_at:z.string()})]);
const settingKey=(me:Me)=>['actor',me.user.id,'settings'];
function RegistrationRoleName({me,id}:{me:Me;id:string}){
  const label=useRoleLabel(),role=useQuery({queryKey:['actor',me.user.id,'roles','detail',id],enabled:me.permission_codes.includes('role:read'),queryFn:({signal})=>api('/roles/'+id,RoleDtoSchema,{protected:true,signal})});
  return <span>{role.data?label(role.data):id}</span>;
}
function SettingsFacts({me,group,settings}:{me:Me;group:Group;settings:Settings}){
  const {t}=useTranslation(),values=settings[group],keys=group==='branding'?BRANDING_SETTING_KEYS:SECURITY_SETTING_KEYS;
  return <><p>{t('roleVersion',{version:values.version})}</p><dl className="session-details">{keys.map(key=>{const value=(values as Record<string,unknown>)[key];return <div key={key}><dt>{t(labels[key])}</dt><dd>{key==='registration_default_role_id'?<RegistrationRoleName me={me} id={String(value)}/>:typeof value==='boolean'?t(value?'yes':'no'):key==='default_theme'?t(String(value)):key==='default_locale'?(value==='en'?'English':'简体中文'):String(value)||'—'}</dd></div>;})}</dl></>;
}
export function SettingsPage({me,queryKey}:{me:Me;queryKey:(string|number)[]}){
  const {t}=useTranslation(),[selection,setSelection]=useState<{group:Group;snapshot:Settings}|null>(null),[saved,setSaved]=useState(false),allowed=me.permission_codes.includes('settings:read');
  const settings=useQuery({queryKey:settingKey(me),enabled:allowed,queryFn:({signal})=>api('/settings',SettingsSchema,{protected:true,signal})});
  if(!allowed)return <h1>{t('forbidden')}</h1>;
  return <><h1>{t('settings')}</h1><p className="muted">{t('settingsIntro')}</p>{saved&&<p className="notice" role="status">{t('settingsSaved')}</p>}
    {settings.isPending?<p role="status">{t('loading')}</p>:!settings.data?<div role="alert">{t(errorMessage(settings.error))}<button onClick={()=>void settings.refetch()}>{t('retry')}</button></div>:<div className="settings-grid">{(['branding','security'] as const).map(group=><section className="panel" key={group} aria-labelledby={group+'-title'}><h2 id={group+'-title'}>{t(group==='branding'?'branding':'securityPolicy')}</h2><p className="hint">{t(group==='branding'?'brandingHelp':'securitySettingsHelp')}</p><SettingsFacts me={me} group={group} settings={settings.data}/>{settings.data[group].allowed_actions.includes('update')&&<button onClick={()=>{setSaved(false);setSelection({group,snapshot:settings.data});}}>{t(group==='branding'?'editBranding':'editSecuritySettings')}</button>}{group==='branding'&&<BrandAssets me={me} branding={settings.data.branding} queryKey={queryKey}/>}</section>)}</div>}
    {selection&&<SettingsDialog me={me} queryKey={queryKey} group={selection.group} snapshot={selection.snapshot} close={()=>setSelection(null)} saved={()=>{setSelection(null);setSaved(true);}}/>}
  </>;
}
const eligible=(role:RoleDto)=>role.is_registration_default_eligible&&!['admin','super_admin'].includes(role.code)&&role.permission_codes.every(code=>{const definition=permissionDefinitions.find(p=>p.code===code);return !!definition?.selfAssignable&&definition.dependencies.every(required=>role.permission_codes.includes(required));});
function RegistrationRolePicker({me,id,onChange,onReady}:{me:Me;id:string;onChange:(id:string)=>void;onReady:(ready:boolean)=>void}){
  const {t}=useTranslation(),label=useRoleLabel(),[search,setSearch]=useState(''),[page,setPage]=useState(1),valid=search.trim().length===0||[...search.trim()].length>=2;
  const selected=useQuery({queryKey:['actor',me.user.id,'roles','registration-selection',id],queryFn:({signal})=>api('/roles/'+id,RoleDtoSchema,{protected:true,signal})});
  const list=useQuery({queryKey:['actor',me.user.id,'roles','registration-picker',search,page],enabled:valid,queryFn:({signal})=>api('/roles?'+new URLSearchParams({query:search,page:String(page),page_size:'20'}),RoleListSchema,{protected:true,signal})});
  const ready=!!selected.data&&eligible(selected.data);useEffect(()=>onReady(ready),[ready,onReady]);
  return <fieldset className="role-picker"><legend>{t('registrationRole')}</legend><p className="hint">{t('registrationRoleHelp')}</p><p className="wrap">{t('selectedRoles')}: {selected.data?label(selected.data):id}</p>
    {selected.isError?<p role="alert">{t(errorMessage(selected.error))}<button type="button" onClick={()=>void selected.refetch()}>{t('retry')}</button></p>:selected.data&&!ready?<p role="alert">{t('registrationRoleInvalid')}</p>:null}
    <div className="field"><label htmlFor="registration-role-search">{t('searchRegistrationRoles')}</label><input id="registration-role-search" value={search} onChange={event=>{setSearch(event.target.value);setPage(1);}}/></div>
    {!valid?<p>{t('invalidRoleFilters')}</p>:list.isPending?<p role="status">{t('loading')}</p>:list.isError?<p role="alert">{t(errorMessage(list.error))}<button type="button" onClick={()=>void list.refetch()}>{t('retry')}</button></p>:<>{!list.data.items.length&&<p>{t('noRoles')}</p>}{list.data.items.map(role=><label className="role-choice" key={role.id}><input type="radio" name="registration_role" checked={id===role.id} disabled={!eligible(role)} onChange={()=>onChange(role.id)}/><span>{label(role)} <code>{role.code}</code></span></label>)}<nav className="pagination" aria-label={t('registrationRole')}><button type="button" disabled={page===1} onClick={()=>setPage(page-1)}>{t('previous')}</button><span>{t('rolePageCount',{page,total:list.data.total})}</span><button type="button" disabled={page*20>=list.data.total} onClick={()=>setPage(page+1)}>{t('next')}</button></nav></>}
  </fieldset>;
}
function SettingsDialog({me,queryKey,group,snapshot,close,saved}:{me:Me;queryKey:(string|number)[];group:Group;snapshot:Settings;close:()=>void;saved:()=>void}){
  const {t}=useTranslation(),client=useQueryClient(),dialog=useRef<HTMLDialogElement>(null),operation=useRef<{key:string;body:unknown}|null>(null);
  const [target,setTarget]=useState(snapshot),[latest,setLatest]=useState<Settings|null>(null),[conflict,setConflict]=useState(false),[error,setError]=useState<unknown>(null),[unknown,setUnknown]=useState(false),[busy,setBusy]=useState(false),[confirmed,setConfirmed]=useState(false),[reauth,setReauth]=useState(false),[verified,setVerified]=useState(false),[roleReady,setRoleReady]=useState(false);
  const form=useForm<Fields>({defaultValues:{...BrandingEditableSchema.parse(Object.fromEntries(BRANDING_SETTING_KEYS.map(key=>[key,snapshot.branding[key]]))),...SecurityValueSchema.parse(Object.fromEntries(SECURITY_SETTING_KEYS.map(key=>[key,snapshot.security[key]]))),reason:'',typed_label:''}}),values=form.watch(),verification=useForm<{current_password:string}>({defaultValues:{current_password:''}});
  const security=group==='security',canSubmit=target[group].allowed_actions.includes('update')&&(!security||roleReady&&values.typed_label==='security'),frozen=busy||unknown||confirmed;
  useEffect(()=>{const focused=document.activeElement,element=dialog.current;element?.showModal();return()=>{element?.close();if(focused instanceof HTMLElement&&focused.isConnected)focused.focus();};},[]);
  function draft(){if(frozen)return;operation.current=null;setError(null);form.clearErrors();}
  async function loadLatest(){setBusy(true);try{const current=await api('/settings',SettingsSchema,{protected:true});setLatest(current);client.setQueryData(settingKey(me),current);}catch(cause){setError(cause);}finally{setBusy(false);}}
  async function refresh(){setBusy(true);setError(null);try{
    await client.cancelQueries({queryKey:settingKey(me),exact:true});await client.cancelQueries({queryKey,exact:true});
    const current=await api('/settings',SettingsSchema,{protected:true});client.setQueryData(settingKey(me),current);
    const currentMe=await api('/me',MeSchema,{protected:true});client.setQueryData(queryKey,currentMe);client.removeQueries({queryKey:['public','settings'],exact:true});saved();
  }catch(cause){setError(cause);}finally{setBusy(false);}}
  async function submit(fields:Fields){if(busy||confirmed||reauth||(!unknown&&(conflict||!canSubmit)))return;setBusy(true);setError(null);
    try{
      if(!operation.current){const keys=security?SECURITY_SETTING_KEYS:BRANDING_SETTING_KEYS,input={...Object.fromEntries(keys.map(key=>[key,fields[key]])),expected_version:target[group].version,...(security?{confirmation:{target_id:'security',typed_label:fields.typed_label,reason:fields.reason}}:{})};
        const parsed=(security?SecurityUpdateSchema:BrandingUpdateSchema).parse(input);operation.current={key:crypto.randomUUID(),body:parsed};}
      await api('/settings/'+group,resultSchema,{method:'PATCH',body:operation.current.body,csrf:me.csrf_token,idempotencyKey:operation.current.key,protected:true});
      operation.current=null;setUnknown(false);setConfirmed(true);await refresh();
    }catch(cause){
      if(cause instanceof z.ZodError){for(const issue of cause.issues){const key=(issue.path[0]==='confirmation'?issue.path[1]:issue.path[0]) as keyof Fields;if(key&&key in fields)form.setError(key,{message:t('settingFieldInvalid')});}setError(new ApiError('VALIDATION_ERROR'));}else setError(cause);
      const uncertain=mutationOutcomeUnknown(cause,unknown);setUnknown(uncertain);if(!uncertain)operation.current=null;
      if(cause instanceof ApiError&&cause.code==='REAUTH_REQUIRED'){setReauth(true);setVerified(false);}
      if(!uncertain&&cause instanceof ApiError&&['VERSION_CONFLICT','FORBIDDEN','REGISTRATION_ROLE_INVALID'].includes(cause.code)){setConflict(true);await loadLatest();if(cause.code==='REGISTRATION_ROLE_INVALID')void client.invalidateQueries({queryKey:['actor',me.user.id,'roles']});}
    }finally{setBusy(false);}
  }
  async function verify(fields:{current_password:string}){setBusy(true);setError(null);try{
    const input=ReauthenticateSchema.safeParse(fields);if(!input.success)throw new ApiError('VALIDATION_ERROR');await api('/auth/reauthenticate',ReauthenticatedSchema,{body:input.data,csrf:me.csrf_token,protected:true});setReauth(false);setVerified(true);
  }catch(cause){setError(cause);}finally{verification.reset();setBusy(false);}}
  function field(name:keyof Fields,caption:MessageKey,options:{min?:number;max?:number;multiline?:boolean;select?:readonly string[]}={}){
    const id='setting-'+name,message=form.formState.errors[name]?.message,attributes={id,...form.register(name,options.min===undefined?{}:{valueAsNumber:true}),'aria-invalid':!!message,'aria-describedby':id+'-help'+(message?' '+id+'-error':'')};
    return <div className="field" key={name}><label htmlFor={id}>{t(caption)}</label>{options.multiline?<textarea {...attributes}/>:options.select?<select {...attributes}>{options.select.map(value=><option key={value} value={value}>{value==='en'?'English':value==='zh-CN'?'简体中文':t(value)}</option>)}</select>:<input {...attributes} type={options.min===undefined?'text':'number'} {...(options.min===undefined?{}:{min:options.min,max:options.max,step:1})}/>}
      <p className="hint" id={id+'-help'}>{options.min!==undefined?t('settingRange',{min:options.min,max:options.max}):t(name==='instance_name'?'instanceNameHelp':name==='copyright'?'copyrightHelp':name==='timezone'?'timezoneHelp':name==='reason'?'roleReasonHelp':name==='typed_label'?'typeSecurityHelp':'settingDefaultHelp')}</p>{message&&<span className="field-error" id={id+'-error'}>{message}</span>}</div>;
  }
  return <dialog className="role-dialog" ref={dialog} aria-labelledby="settings-dialog-title" onCancel={event=>{event.preventDefault();if(!frozen)close();}}><h2 id="settings-dialog-title">{t(security?'editSecuritySettings':'editBranding')}</h2><p className="hint">{t(security?'securitySettingsHelp':'brandingHelp')}</p>
    <form noValidate onChange={draft} onSubmit={form.handleSubmit(submit)}><fieldset className="plain-fieldset" disabled={frozen}>
      {security?<><label className="role-choice"><input type="checkbox" {...form.register('registration_open')}/>{t('registrationOpen')}</label><RegistrationRolePicker me={me} id={values.registration_default_role_id} onChange={id=>{draft();form.setValue('registration_default_role_id',id);}} onReady={setRoleReady}/><div className="form-columns">{numbers.map(([name,min,max])=>field(name,labels[name],{min,max}))}</div>{field('reason','reason',{multiline:true})}{field('typed_label','typeSecurity')}</>:<>{field('instance_name','instanceName')}{field('copyright','copyright',{multiline:true})}<div className="form-columns">{field('default_locale','defaultLanguage',{select:['en','zh-CN']})}{field('default_theme','defaultAppearance',{select:['light','dark','system']})}</div>{field('timezone','instanceTimezone')}</>}
    </fieldset>
    {!!error&&<p className="notice error" role="alert">{t(confirmed?'settingsRefreshFailed':unknown?'settingsRetryHelp':error instanceof ApiError&&error.code==='VERSION_CONFLICT'?'settingsConflict':error instanceof ApiError&&error.code==='AUTH_FAILED'?'currentPasswordIncorrect':errorMessage(error),{seconds:error instanceof ApiError?error.retryAfter:60})}</p>}
    {conflict&&!confirmed&&<section className="notice"><h3>{t('currentSettings')}</h3><p>{t('settingsCompareHelp')}</p>{latest?<><SettingsFacts me={me} group={group} settings={latest}/><button type="button" disabled={busy} onClick={()=>{setTarget(latest);setLatest(null);setConflict(false);setError(null);operation.current=null;}}>{t('useLatest')}</button></>:<button type="button" disabled={busy} onClick={()=>void loadLatest()}>{t('reloadVersion')}</button>}</section>}
    {!target[group].allowed_actions.includes('update')&&<p role="alert">{t('forbidden')}</p>}{verified&&!confirmed&&<p role="status" className="notice">{t('settingsVerifiedAgain')}</p>}
    <div className="dialog-actions"><button type="button" disabled={frozen} onClick={close}>{t('close')}</button>{confirmed?<button className="primary" type="button" disabled={busy} onClick={()=>void refresh()}>{t('refreshSettings')}</button>:<button className="primary" disabled={busy||conflict||reauth||(!unknown&&!canSubmit)}>{t(busy?'submitBusy':unknown?'retrySame':'save')}</button>}</div></form>
    {reauth&&!confirmed&&<form className="reauth-form" noValidate onSubmit={verification.handleSubmit(verify)}><div className="field"><label htmlFor="settings-password">{t('currentPassword')}</label><input id="settings-password" type="password" autoComplete="current-password" disabled={busy} {...verification.register('current_password',{required:t('required')})}/>{verification.formState.errors.current_password&&<span className="field-error">{verification.formState.errors.current_password.message}</span>}</div><button className="primary" disabled={busy}>{t('verifyIdentity')}</button></form>}
  </dialog>;
}
