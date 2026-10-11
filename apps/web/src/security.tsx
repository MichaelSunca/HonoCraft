import {useEffect,useRef,useState} from 'react';
import {useForm} from 'react-hook-form';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {useTranslation} from 'react-i18next';
import {useSearchParams} from 'react-router';
import {z} from 'zod';
import {ChangePasswordSchema,ReauthenticateSchema} from '@honocraft/contracts/common';
import {MeSchema,ReauthenticatedSchema,SessionListSchema,type Me} from '@honocraft/contracts/http';
import {api,ApiError,errorMessage} from './api.js';
import {useSession} from './session.js';
function time(value:string,locale:string,zone:string){return new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'long',timeZone:zone}).format(new Date(value));}
export function SecurityPage({me,queryKey}:{me:Me;queryKey:(string|number)[]}){
  const {t,i18n}=useTranslation(),client=useQueryClient(),session=useSession();
  const verification=useForm<{current_password:string}>({defaultValues:{current_password:''}});
  const change=useForm<{current_password:string;new_password:string;confirm:string}>({defaultValues:{current_password:'',new_password:'',confirm:''}});
  const [verificationError,setVerificationError]=useState<unknown>(null),[changeError,setChangeError]=useState<unknown>(null),[verifiedUntil,setVerifiedUntil]=useState<string|null>(null),[version,setVersion]=useState(me.user.version),[conflict,setConflict]=useState(false),[refreshing,setRefreshing]=useState(false);
  const changeKey=useRef<string|null>(null);
  async function verify(values:{current_password:string}){setVerificationError(null);setVerifiedUntil(null);const input=ReauthenticateSchema.safeParse(values);if(!input.success){setVerificationError(new ApiError('VALIDATION_ERROR'));return;}
    try{const result=await api('/auth/reauthenticate',ReauthenticatedSchema,{body:input.data,csrf:me.csrf_token,protected:true});setVerifiedUntil(result.valid_until);client.setQueryData<Me>(queryKey,old=>old?{...old,session:{...old.session,reauthenticated_at:result.reauthenticated_at}}:old);}
    catch(error){setVerificationError(error);}finally{verification.reset();}
  }
  async function update(values:{current_password:string;new_password:string;confirm:string}){setChangeError(null);
    if(values.new_password!==values.confirm){change.setError('confirm',{message:t('mismatch')});return;}
    if([...values.new_password].length<me.instance.password_min_length){change.setError('new_password',{message:t('passwordHint',{minimum:me.instance.password_min_length})});return;}
    const parsed=ChangePasswordSchema.safeParse({expected_version:version,current_password:values.current_password,new_password:values.new_password});if(!parsed.success){setChangeError(new ApiError('VALIDATION_ERROR'));return;}
    changeKey.current??=crypto.randomUUID();
    try{await api('/me/password',z.object({changed:z.literal(true),login_required:z.literal(true)}),{body:parsed.data,csrf:me.csrf_token,protected:true,idempotencyKey:changeKey.current});change.reset();changeKey.current=null;session.end('resetDone');}
    catch(error){setChangeError(error);if(error instanceof ApiError&&error.code==='VERSION_CONFLICT')setConflict(true);else if(!(error instanceof ApiError&&(error.code==='NETWORK'||error.code==='INTERNAL_ERROR'||error.status>=500))){change.reset();changeKey.current=null;}}
  }
  async function reloadVersion(){setRefreshing(true);try{const latest=await api('/me',MeSchema,{protected:true});client.setQueryData(queryKey,latest);setVersion(latest.user.version);changeKey.current=null;setConflict(false);setChangeError(null);}catch(error){setChangeError(error);}finally{setRefreshing(false);}}
  const describe=(error:unknown)=>t(error instanceof ApiError&&error.code==='AUTH_FAILED'?'currentPasswordIncorrect':errorMessage(error),{seconds:error instanceof ApiError?error.retryAfter:60});
  return <><h1>{t('security')}</h1><p className="muted">{t('securityIntro')}</p><div className="security-grid"><section className="panel"><h2>{t('verifyIdentityTitle')}</h2><form aria-label={t('verifyIdentityTitle')} noValidate onSubmit={verification.handleSubmit(verify)}><div className="field"><label htmlFor="verify-password">{t('currentPassword')}</label><input id="verify-password" type="password" autoComplete="current-password" {...verification.register('current_password',{required:t('required')})} aria-invalid={!!verification.formState.errors.current_password} aria-describedby={verification.formState.errors.current_password?'verification-password-error':undefined}/>{verification.formState.errors.current_password&&<span id="verification-password-error" className="field-error">{verification.formState.errors.current_password.message}</span>}</div>{!!verificationError&&<p role="alert" className="notice error">{describe(verificationError)}</p>}{verifiedUntil&&<p role="status" className="notice">{t('identityVerified',{time:time(verifiedUntil,i18n.language,me.instance.timezone)})}</p>}<button className="primary" disabled={verification.formState.isSubmitting}>{t(verification.formState.isSubmitting?'submitBusy':'verifyIdentity')}</button></form></section>
    <section className="panel"><h2>{t('changePassword')}</h2><p className="muted">{t('changePasswordHelp')}</p><form aria-label={t('changePassword')} noValidate onChange={()=>{changeKey.current=null;}} onSubmit={change.handleSubmit(update)}>
      {(['current_password','new_password','confirm'] as const).map(name=><div className="field" key={name}><label htmlFor={'change-'+name}>{t(name==='current_password'?'currentPassword':name==='new_password'?'newPassword':'confirmPassword')}</label><input id={'change-'+name} type="password" autoComplete={name==='current_password'?'current-password':'new-password'} {...change.register(name,{required:t('required')})} aria-invalid={!!change.formState.errors[name]} aria-describedby={change.formState.errors[name]?'error-'+name:undefined}/>{change.formState.errors[name]&&<span id={'error-'+name} className="field-error">{change.formState.errors[name]?.message}</span>}</div>)}
      <p className="hint">{t('passwordHint',{minimum:me.instance.password_min_length})}</p>{!!changeError&&<div role="alert" className="notice error">{conflict?t('passwordVersionConflict'):describe(changeError)}{conflict&&<button type="button" disabled={refreshing} onClick={()=>void reloadVersion()}>{t('reloadVersion')}</button>}</div>}<button className="primary" disabled={change.formState.isSubmitting||conflict||refreshing}>{t(change.formState.isSubmitting?'submitBusy':'changePassword')}</button>
    </form></section></div></>;
}
const replay=z.object({outcome:z.enum(['session_revoked','other_sessions_revoked']),resource_id:z.uuid().nullable(),version:z.number().nullable(),completed_at:z.string()});
const revocation=z.union([z.object({revoked:z.literal(true),is_current:z.boolean()}),z.object({revoked_count:z.number().int().nonnegative()}),replay]);
type Selection={id:string;current:boolean};
export function SessionsPage({me}:{me:Me}){
  const {t,i18n}=useTranslation(),client=useQueryClient(),session=useSession(),[search,setSearch]=useSearchParams();
  const raw=Number(search.get('page')??1),page=Number.isSafeInteger(raw)&&raw>0&&raw<=1000000?raw:1;
  const queryKey=['actor',me.user.id,'sessions',page];
  const list=useQuery({queryKey,queryFn:({signal})=>api(`/me/sessions?page=${page}&page_size=20`,SessionListSchema,{protected:true,signal}),retry:false});
  const [selection,setSelection]=useState<Selection|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null),[updated,setUpdated]=useState(false);
  const keys=useRef(new Map<string,string>()),dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(selection){const focused=document.activeElement;dialog.current?.showModal();return()=>{dialog.current?.close();if(focused instanceof HTMLElement)focused.focus();};}},[selection]);
  function select(value:Selection){setError(null);setUpdated(false);setSelection(value);}
  async function revoke(){if(!selection)return;setBusy(true);setError(null);const key=keys.current.get(selection.id)??crypto.randomUUID();keys.current.set(selection.id,key);
    try{const result=await api(selection.id==='others'?'/me/sessions/revoke-others':`/me/sessions/${selection.id}`,revocation,{method:selection.id==='others'?'POST':'DELETE',body:{},csrf:me.csrf_token,protected:true,idempotencyKey:key});keys.current.delete(selection.id);
      if('is_current' in result&&result.is_current){session.end('sessionEnded');return;}
      setSelection(null);setUpdated(true);await client.invalidateQueries({queryKey:['actor',me.user.id,'sessions']});
    }catch(cause){setError(cause);}finally{setBusy(false);}
  }
  return <><h1>{t('sessions')}</h1><p className="muted">{t('sessionsIntro')}</p><button onClick={()=>select({id:'others',current:false})} disabled={busy||!list.data||list.data.total<2}>{t('signOutOthers')}</button>{updated&&<p role="status" className="notice">{t('sessionRevoked')}</p>}
    {list.isPending?<p role="status">{t('loading')}</p>:list.isError?<div role="alert" className="notice error">{t(errorMessage(list.error))}<button onClick={()=>void list.refetch()}>{t('retry')}</button></div>:<><div className="session-list">{list.data.items.map(item=><article key={item.id} className="panel"><div className="session-heading"><h2>{t(item.device.category)} · {item.device.browser==='unknown'?t('unknown'):item.device.browser} · {item.device.os==='unknown'?t('unknown'):item.device.os}</h2>{item.is_current&&<span className="badge">{t('thisDevice')}</span>}</div><dl className="session-details"><div><dt>{t('sourceIp')}</dt><dd>{item.ip}</dd></div><div><dt>{t('loggedInAt')}</dt><dd>{time(item.created_at,i18n.language,me.instance.timezone)}</dd></div><div><dt>{t('lastActive')}</dt><dd>{time(item.last_seen_at,i18n.language,me.instance.timezone)}</dd></div><div><dt>{t('expiresAt')}</dt><dd>{time(item.absolute_expires_at,i18n.language,me.instance.timezone)}</dd></div></dl><button onClick={()=>select({id:item.id,current:item.is_current})}>{t(item.is_current?'signOutThis':'signOutDevice')}</button></article>)}</div>{!list.data.items.length&&<p>{t('noSessions')}</p>}<nav className="pagination" aria-label={t('sessions')}><button disabled={page===1} onClick={()=>setSearch({page:String(page-1)})}>{t('previous')}</button><span>{t('pageCount',{page,total:list.data.total})}</span><button disabled={page*20>=list.data.total} onClick={()=>setSearch({page:String(page+1)})}>{t('next')}</button></nav></>}
    {selection&&<dialog ref={dialog} aria-labelledby="revoke-title" aria-describedby="revoke-description" onCancel={event=>{event.preventDefault();if(!busy)setSelection(null);}}><h2 id="revoke-title">{t(selection.id==='others'?'confirmOthers':'confirmDevice')}</h2><p id="revoke-description">{t(selection.id==='others'?'confirmOthersHelp':'confirmDeviceHelp')}</p>{!!error&&<p role="alert" className="notice error">{t(errorMessage(error),{seconds:error instanceof ApiError?error.retryAfter:60})}</p>}<div className="dialog-actions"><button disabled={busy} onClick={()=>setSelection(null)}>{t('cancel')}</button><button className="primary" disabled={busy} onClick={()=>void revoke()}>{t(busy?'submitBusy':'confirmSignOut')}</button></div></dialog>}
  </>;
}
