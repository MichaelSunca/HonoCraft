import {useEffect,useRef,useState} from 'react';
import {useForm} from 'react-hook-form';
import {useQueryClient} from '@tanstack/react-query';
import {useTranslation} from 'react-i18next';
import {z} from 'zod';
import {normalizeEmail,ReauthenticateSchema} from '@honocraft/contracts/common';
import {UserDetailSchema,UserProfileUpdateSchema,UserStatusUpdateSchema,UserDeleteSchema,UserRolesUpdateSchema,UserPasswordResetSchema,UserProfileResultSchema,UserStatusResultSchema,UserRolesResultSchema,UserPasswordResetResultSchema,type UserAction,type UserDetail} from '@honocraft/contracts/users';
import {AdminEmailChangeSchema,AdminEmailCancelSchema,EmailChangeStartedSchema,EmailChangeCancelledSchema} from '@honocraft/contracts/email-change';
import {ReauthenticatedSchema,type Me} from '@honocraft/contracts/http';
import {api,ApiError,errorMessage,mutationOutcomeUnknown} from './api.js';
import type {MessageKey} from './i18n.js';
import {UserRolePicker,useRoleLabel} from './user-role-picker.js';
export const userActionLabels:Record<UserAction,MessageKey>={update:'editUser',suspend:'suspendUser',enable:'enableUser',delete:'deleteUser','reset-password':'sendUserReset','change-email':'changeUserEmail','assign-roles':'assignUserRoles','cancel-email-change':'cancelUserEmail'};
type Fields={display_name:string;new_email:string;reason:string;typed_label:string;role_ids:string[]};
const resultSchema=z.union([UserProfileResultSchema,UserStatusResultSchema,UserRolesResultSchema,UserPasswordResetResultSchema,EmailChangeStartedSchema,EmailChangeCancelledSchema,z.object({outcome:z.enum(['user_profile_updated','user_status_changed','user_deleted','user_roles_assigned','user_password_reset_requested','email_change_requested','email_change_cancelled']),resource_id:z.uuid(),version:z.number().int().positive(),completed_at:z.string()})]);
export function UserDialog({me,user,kind,close,saved}:{me:Me;user:UserDetail;kind:UserAction;close:()=>void;saved:(kind:UserAction)=>void}){
  const {t}=useTranslation(),client=useQueryClient(),label=useRoleLabel(),dialog=useRef<HTMLDialogElement>(null),originalEmailRequest=useRef(user.pending_email_change?.id),operation=useRef<{key:string;path:string;method:string;body:unknown}|null>(null);
  const [target,setTarget]=useState(user),[latest,setLatest]=useState<UserDetail|null>(null),[conflict,setConflict]=useState(false),[gone,setGone]=useState(false),[busy,setBusy]=useState(false),[unknown,setUnknown]=useState(false),[error,setError]=useState<unknown>(null),[reauth,setReauth]=useState(false),[verified,setVerified]=useState(false),[scope,setScope]=useState({ready:false,high:false});
  const form=useForm<Fields>({defaultValues:{display_name:user.display_name,new_email:'',reason:'',typed_label:'',role_ids:user.roles.map(role=>role.id)}}),verification=useForm<{current_password:string}>({defaultValues:{current_password:''}}),values=form.watch();
  const assigning=kind==='assign-roles',typed=target.requires_typed_confirmation_actions.includes(kind)||(assigning&&scope.high),expectedLabel=target.email?normalizeEmail(target.email):'',reasonRequired=typed||!['update','cancel-email-change'].includes(kind);
  const available=target.allowed_actions.includes(kind)&&(kind!=='cancel-email-change'||!!target.pending_email_change&&target.pending_email_change.id===originalEmailRequest.current),canSubmit=!gone&&available&&(!assigning||scope.ready)&&(!typed||!!expectedLabel&&values.typed_label===expectedLabel),frozen=busy||unknown;
  useEffect(()=>{const focused=document.activeElement,element=dialog.current;element?.showModal();return()=>{element?.close();if(focused instanceof HTMLElement&&focused.isConnected)focused.focus();};},[]);
  function draft(){if(unknown)return;operation.current=null;setError(null);form.clearErrors();}
  async function loadLatest(){setBusy(true);try{const current=await api('/users/'+target.id,UserDetailSchema,{protected:true});setLatest(current);client.setQueryData(['actor',me.user.id,'users','detail',target.id],current);void client.invalidateQueries({queryKey:['actor',me.user.id,'users','list']});void client.invalidateQueries({queryKey:['actor',me.user.id,'roles']});}catch(cause){setError(cause);if(cause instanceof ApiError&&cause.status===404)setGone(true);}finally{setBusy(false);}}
  async function submit(fields:Fields){if(busy||reauth||!unknown&&(conflict||!canSubmit))return;setBusy(true);setError(null);
    try{
      if(!operation.current){
        const identity={id:target.id,expected_version:target.version},confirmation={target_id:target.id,reason:fields.reason,...(typed?{typed_label:fields.typed_label}:{})};let input:{id:string},suffix='',method='POST';
        if(kind==='update'){input=UserProfileUpdateSchema.parse({...identity,display_name:fields.display_name,...(fields.reason||typed?{confirmation}:{})});suffix='/profile';method='PATCH';}
        else if(kind==='suspend'||kind==='enable'){input=UserStatusUpdateSchema.parse({...identity,action:kind,confirmation});suffix='/status';}
        else if(kind==='delete'){input=UserDeleteSchema.parse({...identity,confirmation});method='DELETE';}
        else if(kind==='reset-password'){input=UserPasswordResetSchema.parse({...identity,confirmation});suffix='/password-reset';}
        else if(kind==='assign-roles'){input=UserRolesUpdateSchema.parse({...identity,role_ids:fields.role_ids,confirmation});suffix='/roles';method='PUT';}
        else if(kind==='change-email'){input=AdminEmailChangeSchema.parse({...identity,new_email:fields.new_email,confirmation});suffix='/email-change';}
        else{const pending=target.pending_email_change!;input=AdminEmailCancelSchema.parse({...identity,request_id:pending.id,request_version:pending.version,...(fields.reason||typed?{confirmation}:{})});suffix='/email-change';method='DELETE';}
        const {id,...body}=input;operation.current={key:crypto.randomUUID(),path:'/users/'+id+suffix,method,body};
      }
      const request=operation.current;await api(request.path,resultSchema,{method:request.method,body:request.body,csrf:me.csrf_token,protected:true,idempotencyKey:request.key});operation.current=null;saved(kind);
    }catch(cause){
      if(cause instanceof z.ZodError){for(const issue of cause.issues){const field=(issue.path[0]==='confirmation'?issue.path[1]:issue.path[0]) as keyof Fields;if(field in fields)form.setError(field,{message:t('invalid')});}setError(new ApiError('VALIDATION_ERROR'));}else setError(cause);
      const uncertain=mutationOutcomeUnknown(cause,unknown);setUnknown(uncertain);if(!uncertain)operation.current=null;
      if(cause instanceof ApiError&&cause.code==='REAUTH_REQUIRED'){setReauth(true);setVerified(false);}
      if(!uncertain&&cause instanceof ApiError&&['VERSION_CONFLICT','CHANGE_REQUEST_INVALID','FORBIDDEN','TARGET_NOT_MANAGEABLE','NOT_FOUND'].includes(cause.code)){setConflict(true);await loadLatest();}
    }finally{setBusy(false);}
  }
  async function verify(values:{current_password:string}){setBusy(true);setError(null);const input=ReauthenticateSchema.safeParse(values);
    try{if(!input.success)throw new ApiError('VALIDATION_ERROR');await api('/auth/reauthenticate',ReauthenticatedSchema,{body:input.data,csrf:me.csrf_token,protected:true});setReauth(false);setVerified(true);}catch(cause){setError(cause);}finally{verification.reset();setBusy(false);}}
  function textField(name:'display_name'|'new_email'|'reason'|'typed_label',caption:MessageKey,required=false){const message=form.formState.errors[name]?.message,id='user-'+name;
    return <div className="field"><label htmlFor={id}>{t(caption)}</label>{name==='reason'?<textarea id={id} {...form.register(name,{required:required?t('required'):false})} aria-invalid={!!message} aria-describedby={message?id+'-error':undefined}/>:<input id={id} type={name==='new_email'?'email':'text'} autoComplete={name==='new_email'?'email':undefined} {...form.register(name,{required:required?t('required'):false})} aria-invalid={!!message} aria-describedby={message?id+'-error':undefined}/>} {message&&<span className="field-error" id={id+'-error'}>{message}</span>}</div>;}
  return <dialog className="role-dialog" ref={dialog} aria-labelledby="user-action-title" onCancel={event=>{event.preventDefault();if(!frozen)close();}}><h2 id="user-action-title">{t(userActionLabels[kind])}</h2><p className="wrap">{target.display_name} · {target.email??target.masked_email} · {t('roleVersion',{version:target.version})}</p><p className="muted">{t(kind==='reset-password'?'userResetHelp':kind==='change-email'?'confirmEmailRequestHelp':kind==='cancel-email-change'?'cancelEmailRequestHelp':kind==='update'?'userProfileHelp':kind==='assign-roles'?'userRolesHelp':kind==='delete'?'userDeleteHelp':'userStatusHelp')}</p>
    <form noValidate onChange={draft} onSubmit={form.handleSubmit(submit)}><fieldset className="plain-fieldset" disabled={frozen}>
      {kind==='update'&&textField('display_name','displayName',true)}{kind==='change-email'&&textField('new_email','newEmail',true)}
      {kind==='cancel-email-change'&&<p className="wrap">{t('pendingEmail')}: {target.pending_email_change?.new_email??t('noPendingEmail')}</p>}
      {assigning&&<UserRolePicker me={me} ids={values.role_ids} names={Object.fromEntries(user.roles.map(role=>[role.id,label(role)]))} grantOnly onState={setScope} onChange={ids=>{draft();form.setValue('role_ids',ids);}}/>}
      {textField('reason','reason',reasonRequired)}{typed&&<>{textField('typed_label','typeUserEmail',true)}<p className="hint wrap">{expectedLabel}</p></>}
    </fieldset>
    {!!error&&<p className="notice error" role="alert">{t(unknown?'userRetryHelp':error instanceof ApiError&&error.code==='VERSION_CONFLICT'?'userConflict':error instanceof ApiError&&error.code==='AUTH_FAILED'?'currentPasswordIncorrect':error instanceof ApiError&&error.code==='EMAIL_CONFLICT'?'emailAddressOccupied':errorMessage(error),{seconds:error instanceof ApiError?error.retryAfter:60})}</p>}
    {gone&&<p>{t('userUnavailable')}</p>}{!available&&<p>{t('userActionUnavailable')}</p>}
    {conflict&&!gone&&<section className="notice"><h3>{t('currentAccount')}</h3>{latest?<><p className="wrap">{latest.display_name} · {latest.email??latest.masked_email} · {t('userStatus_'+latest.status)} · {t('roleVersion',{version:latest.version})}</p><p className="wrap">{t('roles')}: {latest.roles.map(label).join(', ')||t('noneSelected')}</p><p className="wrap">{t('pendingEmail')}: {latest.pending_email_change?.new_email??t('noPendingEmail')}</p><button type="button" onClick={()=>{setTarget(latest);setLatest(null);setConflict(false);setError(null);operation.current=null;}}>{t('useLatest')}</button></>:<button type="button" disabled={busy} onClick={()=>void loadLatest()}>{t('reloadVersion')}</button>}</section>}
    {verified&&<p className="notice" role="status">{t('userVerifiedAgain')}</p>}
    <div className="dialog-actions"><button type="button" disabled={frozen} onClick={close}>{t('close')}</button><button className="primary" disabled={busy||conflict||reauth||(!unknown&&!canSubmit)}>{t(busy?'submitBusy':unknown?'retrySame':kind==='update'?'save':userActionLabels[kind])}</button></div></form>
    {reauth&&<form className="reauth-form" noValidate onSubmit={verification.handleSubmit(verify)}><div className="field"><label htmlFor="user-password">{t('currentPassword')}</label><input id="user-password" type="password" autoComplete="current-password" disabled={busy} {...verification.register('current_password',{required:t('required')})} aria-invalid={!!verification.formState.errors.current_password} aria-describedby={verification.formState.errors.current_password?'user-password-error':undefined}/>{verification.formState.errors.current_password&&<span className="field-error" id="user-password-error">{verification.formState.errors.current_password.message}</span>}</div><button className="primary" disabled={busy}>{t('verifyIdentity')}</button></form>}
  </dialog>;
}
