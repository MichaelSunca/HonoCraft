import {useEffect,useRef,useState} from 'react';
import {useForm} from 'react-hook-form';
import {useQueryClient} from '@tanstack/react-query';
import {useTranslation} from 'react-i18next';
import {z} from 'zod';
import {normalizeEmail,ReauthenticateSchema} from '@honocraft/contracts/common';
import {SelfEmailChangeSchema,SelfEmailCancelSchema,EmailChangeStartedSchema,EmailChangeCancelledSchema} from '@honocraft/contracts/email-change';
import {MeSchema,ReauthenticatedSchema,type Me} from '@honocraft/contracts/http';
import {api,ApiError,errorMessage} from './api.js';
type Selection={kind:'start';version:number;email:string}|{kind:'cancel';version:number;request:NonNullable<Me['pending_email_change']>};
type Operation={key:string;method:string;body:unknown};
const resultSchema=z.union([EmailChangeStartedSchema,EmailChangeCancelledSchema,z.object({outcome:z.enum(['email_change_requested','email_change_cancelled']),resource_id:z.uuid(),version:z.number().int().positive(),completed_at:z.string()})]);
export function SelfEmailPanel({me,queryKey}:{me:Me;queryKey:(string|number)[]}){
  const {t,i18n}=useTranslation(),client=useQueryClient(),dialog=useRef<HTMLDialogElement>(null),operation=useRef<Operation|null>(null),returnFocus=useRef<HTMLElement|null>(null);
  const form=useForm<{new_email:string}>({defaultValues:{new_email:''}}),verification=useForm<{current_password:string}>({defaultValues:{current_password:''}});
  const [selection,setSelection]=useState<Selection|null>(null),[busy,setBusy]=useState(false),[unknown,setUnknown]=useState(false),[reauth,setReauth]=useState(false),[verified,setVerified]=useState(false);
  const [error,setError]=useState<unknown>(null),[latest,setLatest]=useState<Me|null>(null),[conflict,setConflict]=useState(false),[gone,setGone]=useState(false),[saved,setSaved]=useState(false),[needsRefresh,setNeedsRefresh]=useState(false),[refreshError,setRefreshError]=useState<unknown>(null);
  const opened=selection!==null,frozen=busy||unknown;
  useEffect(()=>{if(!opened)return;const element=dialog.current;element?.showModal();return()=>element?.close();},[opened]);
  useEffect(()=>{if(opened||busy||needsRefresh||!returnFocus.current)return;const focused=returnFocus.current;returnFocus.current=null;
    if(focused.isConnected&&!focused.matches(':disabled'))focused.focus();else document.getElementById('new-email')?.focus();
  },[opened,busy,needsRefresh]);
  const format=(value:string)=>new Intl.DateTimeFormat(i18n.language,{dateStyle:'medium',timeStyle:'long',timeZone:me.instance.timezone}).format(new Date(value))+' ('+me.instance.timezone+')';
  function choose(value:Selection){returnFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;operation.current=null;setSelection(value);setError(null);setLatest(null);setConflict(false);setGone(false);setUnknown(false);setReauth(false);setVerified(false);setSaved(false);verification.reset();}
  function close(){if(frozen)return;if(latest)client.setQueryData(queryKey,latest);setSelection(null);setLatest(null);operation.current=null;verification.reset();}
  async function refresh(){setNeedsRefresh(true);setRefreshError(null);try{const current=await api('/me',MeSchema,{protected:true});client.setQueryData(queryKey,current);setNeedsRefresh(false);void client.invalidateQueries({queryKey:['actor',me.user.id]});}catch(cause){setRefreshError(cause);}}
  function begin(values:{new_email:string}){form.clearErrors();const parsed=SelfEmailChangeSchema.safeParse({expected_version:me.user.version,new_email:values.new_email});
    if(!parsed.success){form.setError('new_email',{message:t('invalid')});return;}if(normalizeEmail(parsed.data.new_email)===normalizeEmail(me.user.email)){form.setError('new_email',{message:t('emailUnchanged')});return;}
    choose({kind:'start',version:me.user.version,email:parsed.data.new_email});
  }
  async function loadLatest(){setBusy(true);try{setLatest(await api('/me',MeSchema,{protected:true}));}catch(cause){setError(cause);}finally{setBusy(false);}}
  function useLatest(){if(!latest||!selection)return;
    if(selection.kind==='cancel'&&latest.pending_email_change?.id!==selection.request.id)setGone(true);
    else setSelection(selection.kind==='start'?{...selection,version:latest.user.version}:{...selection,version:latest.user.version,request:latest.pending_email_change!});
    client.setQueryData(queryKey,latest);setLatest(null);setConflict(false);setError(null);operation.current=null;
  }
  async function submit(){if(!selection||(!unknown&&(conflict||gone||reauth)))return;setBusy(true);setError(null);
    try{
      operation.current??={key:crypto.randomUUID(),method:selection.kind==='start'?'POST':'DELETE',body:selection.kind==='start'?
        SelfEmailChangeSchema.parse({expected_version:selection.version,new_email:selection.email}):SelfEmailCancelSchema.parse({expected_version:selection.version,request_id:selection.request.id,request_version:selection.request.version})};
      const request=operation.current;await api('/me/email-change',resultSchema,{method:request.method,body:request.body,csrf:me.csrf_token,protected:true,idempotencyKey:request.key});
      operation.current=null;setUnknown(false);setSelection(null);setSaved(true);if(selection.kind==='start')form.reset();await refresh();
    }catch(cause){setError(cause);const uncertain=cause instanceof ApiError&&(cause.code==='NETWORK'||cause.code==='INTERNAL_ERROR'||cause.status>=500);setUnknown(uncertain);if(!uncertain)operation.current=null;
      if(cause instanceof ApiError&&cause.code==='REAUTH_REQUIRED'){setReauth(true);setVerified(false);}
      if(cause instanceof ApiError&&['VERSION_CONFLICT','CHANGE_REQUEST_INVALID','NOT_FOUND'].includes(cause.code)){setConflict(true);await loadLatest();}
    }finally{setBusy(false);}
  }
  async function verify(values:{current_password:string}){setBusy(true);setError(null);const parsed=ReauthenticateSchema.safeParse(values);if(!parsed.success){verification.reset();setError(new ApiError('VALIDATION_ERROR'));setBusy(false);return;}
    try{const result=await api('/auth/reauthenticate',ReauthenticatedSchema,{body:parsed.data,csrf:me.csrf_token,protected:true});client.setQueryData<Me>(queryKey,current=>current?{...current,session:{...current.session,reauthenticated_at:result.reauthenticated_at}}:current);setReauth(false);setVerified(true);}
    catch(cause){setError(cause);}finally{verification.reset();setBusy(false);}
  }
  return <section className="panel"><h2>{t('changeEmailTitle')}</h2><p className="muted">{t('changeEmailHelp')}</p><dl className="session-details"><div><dt>{t('currentEmail')}</dt><dd className="wrap">{me.user.email}</dd></div></dl>
    {me.pending_email_change&&<section className="notice"><h3>{t('pendingEmail')}</h3><p className="wrap">{me.pending_email_change.new_email}</p><p className="hint">{t('expiresAt')}: {format(me.pending_email_change.expires_at)}</p><button disabled={busy||opened||needsRefresh} onClick={()=>choose({kind:'cancel',version:me.user.version,request:me.pending_email_change!})}>{t('cancelEmailRequest')}</button></section>}
    <form aria-label={t('changeEmailTitle')} noValidate onSubmit={form.handleSubmit(begin)}><fieldset className="plain-fieldset" disabled={busy||opened||needsRefresh}><div className="field"><label htmlFor="new-email">{t('newEmail')}</label><input id="new-email" type="email" autoComplete="email" {...form.register('new_email',{required:t('required')})} aria-invalid={!!form.formState.errors.new_email} aria-describedby={form.formState.errors.new_email?'new-email-error':'new-email-help'}/>{form.formState.errors.new_email&&<span className="field-error" id="new-email-error">{form.formState.errors.new_email.message}</span>}</div><p className="hint" id="new-email-help">{t('emailRequestHelp')}</p><button className="primary">{t('sendEmailLink')}</button></fieldset></form>
    {saved&&<p className="notice" role="status">{t('emailRequestSaved')}</p>}{!!refreshError&&<p role="alert">{t(errorMessage(refreshError))}</p>}<button disabled={busy||opened} onClick={()=>void refresh()}>{t('refreshEmailRequest')}</button>
    {selection&&<dialog ref={dialog} aria-labelledby="self-email-title" onCancel={event=>{event.preventDefault();close();}}><h2 id="self-email-title">{t(selection.kind==='start'?'requestEmailChange':'cancelEmailRequest')}</h2><p>{t(selection.kind==='start'?'confirmEmailRequestHelp':'cancelEmailRequestHelp')}</p><dl><dt>{t('currentEmail')}</dt><dd className="wrap">{me.user.email}</dd><dt>{t('newEmail')}</dt><dd className="wrap">{selection.kind==='start'?selection.email:selection.request.new_email}</dd></dl>
      {selection.kind==='start'&&me.pending_email_change&&<p className="notice wrap">{t('replaceEmailRequest',{email:me.pending_email_change.new_email})}</p>}
      {!!error&&<div role="alert" className="notice error">{t(unknown?'emailRetryHelp':error instanceof ApiError&&['VERSION_CONFLICT','CHANGE_REQUEST_INVALID','NOT_FOUND'].includes(error.code)?'emailRequestConflict':error instanceof ApiError&&error.code==='AUTH_FAILED'?'currentPasswordIncorrect':error instanceof ApiError&&error.code==='EMAIL_CONFLICT'?'emailAddressOccupied':errorMessage(error),{seconds:error instanceof ApiError?error.retryAfter:60})}</div>}
      {conflict&&<section className="notice"><h3>{t('currentAccount')}</h3>{latest?<><p className="wrap">{latest.user.display_name} · {latest.user.email} · {t('roleVersion',{version:latest.user.version})}</p><p className="wrap">{t('pendingEmail')}: {latest.pending_email_change?.new_email??t('noPendingEmail')}</p><button onClick={useLatest}>{t('useLatest')}</button></>:<button disabled={busy} onClick={()=>void loadLatest()}>{t('reloadVersion')}</button>}</section>}
      {gone&&<p className="notice">{t('emailRequestGone')}</p>}{verified&&<p className="notice" role="status">{t('emailVerifiedAgain')}</p>}
      <div className="dialog-actions"><button disabled={frozen} onClick={close}>{t('close')}</button><button className="primary" disabled={busy||(!unknown&&(conflict||gone||reauth))} onClick={()=>void submit()}>{t(busy?'submitBusy':unknown?'retrySame':selection.kind==='start'?'sendEmailLink':'cancelEmailRequest')}</button></div>
      {reauth&&<form className="reauth-form" aria-label={t('verifyIdentityTitle')} noValidate onSubmit={verification.handleSubmit(verify)}><div className="field"><label htmlFor="email-password">{t('currentPassword')}</label><input id="email-password" type="password" autoComplete="current-password" disabled={busy} {...verification.register('current_password',{required:t('required')})} aria-invalid={!!verification.formState.errors.current_password} aria-describedby={verification.formState.errors.current_password?'email-password-error':undefined}/>{verification.formState.errors.current_password&&<span id="email-password-error" className="field-error">{verification.formState.errors.current_password.message}</span>}</div><button className="primary" disabled={busy}>{t('verifyIdentity')}</button></form>}
    </dialog>}
  </section>;
}
