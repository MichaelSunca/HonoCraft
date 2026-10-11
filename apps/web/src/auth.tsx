import {useEffect,useState} from 'react';
import {useForm} from 'react-hook-form';
import {Link,useLocation,useNavigate} from 'react-router';
import {useTranslation} from 'react-i18next';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {z} from 'zod';
import {CompleteInvitationSchema,EmailRequestSchema,LoginSchema,RegisterSchema,ResetPasswordSchema,TokenRequestSchema} from '@honocraft/contracts/common';
import {InvitationPreviewSchema,MeSchema,PublicSettingsSchema} from '@honocraft/contracts/http';
import {accepted,api,ApiError,errorMessage} from './api.js';
import {discardCredential,pageCredential} from './credential.js';
import {useSession} from './session.js';
import {PreferenceControls,usePreferences} from './preferences.js';
import type {MessageKey} from './i18n.js';
type Mode='login'|'register'|'bootstrap'|'verify'|'forgot'|'reset'|'invite';
type Fields={email:string;display_name:string;password:string;confirm:string};
const intro:Record<Mode,MessageKey>={login:'loginIntro',register:'registerIntro',bootstrap:'bootstrapIntro',verify:'verifyIntro',forgot:'forgotIntro',reset:'resetIntro',invite:'inviteIntro'};
const submitLabel:Record<Mode,MessageKey>={login:'login',register:'register',bootstrap:'createAdmin',verify:'verify',forgot:'sendReset',reset:'reset',invite:'invite'};
const paths:Record<Mode,string>={login:'/auth/login',register:'/auth/register',bootstrap:'/auth/bootstrap/complete',verify:'/auth/email/verify',forgot:'/auth/password/forgot',reset:'/auth/password/reset',invite:'/auth/invites/accept'};
const responseSchemas={login:z.object({authenticated:z.literal(true)}),register:accepted,bootstrap:z.object({initialized:z.literal(true),login_required:z.literal(true)}),verify:z.object({verified:z.literal(true),login_required:z.literal(true)}),forgot:accepted,reset:z.object({reset:z.literal(true),login_required:z.literal(true)}),invite:z.object({accepted:z.literal(true),login_required:z.literal(true)})};
export function AuthPage({mode}:{mode:Mode}){
  const {t}=useTranslation(),location=useLocation(),navigate=useNavigate(),session=useSession(),preferences=usePreferences(),queryClient=useQueryClient();
  const [token]=useState(()=>pageCredential(location.pathname));
  const [error,setError]=useState<unknown>(null),[message,setMessage]=useState<MessageKey|null>(null),[pending,setPending]=useState(false),[extraBusy,setExtraBusy]=useState(false);
  const [preview,setPreview]=useState<z.infer<typeof InvitationPreviewSchema>|null>(null),[previewError,setPreviewError]=useState<unknown>(null),[previewAttempt,setPreviewAttempt]=useState(0);
  const settings=useQuery({queryKey:['public','settings'],queryFn:({signal})=>api('/public/settings',PublicSettingsSchema,{signal}),retry:false});
  const form=useForm<Fields>({defaultValues:{email:'',display_name:'',password:'',confirm:''}});
  useEffect(()=>()=>discardCredential(),[]);
  useEffect(()=>{
    if(mode!=='invite'||!token)return;
    const controller=new AbortController();setPreview(null);setPreviewError(null);
    void api('/auth/invites/preview',InvitationPreviewSchema,{body:{token},signal:controller.signal})
      .then(value=>{if(!controller.signal.aborted)setPreview(value);}).catch(cause=>{if(!controller.signal.aborted)setPreviewError(cause);});
    return()=>controller.abort();
  },[mode,token,previewAttempt]);
  useEffect(()=>{if(settings.data){preferences.defaults(settings.data);document.title=settings.data.instance_name;}},[settings.data]);
  const credential=['bootstrap','verify','reset','invite'].includes(mode),hasPassword=['login','register','bootstrap','reset','invite'].includes(mode);
  const hasEmail=['login','register','forgot'].includes(mode),hasName=['register','bootstrap','invite'].includes(mode),confirmation=hasPassword&&mode!=='login';
  async function submit(fields:Fields){
    setError(null);setMessage(null);setPending(false);
    if(confirmation&&fields.password!==fields.confirm){form.setError('confirm',{message:'mismatch'});return;}
    if(confirmation&&[...fields.password].length<(settings.data?.password_min_length??15)){form.setError('password',{message:'passwordRejected'});return;}
    const input=mode==='login'?LoginSchema.safeParse({email:fields.email,password:fields.password}):mode==='register'?RegisterSchema.safeParse({email:fields.email,password:fields.password,display_name:fields.display_name}):mode==='bootstrap'||mode==='invite'?CompleteInvitationSchema.safeParse({token,password:fields.password,display_name:fields.display_name}):mode==='verify'?TokenRequestSchema.safeParse({token}):mode==='forgot'?EmailRequestSchema.safeParse({email:fields.email}):ResetPasswordSchema.safeParse({token,new_password:fields.password});
    if(!input.success){for(const issue of input.error.issues){const name=issue.path[0];if(name==='email'||name==='display_name'||name==='password')form.setError(name,{message:'invalid'});else if(name==='new_password')form.setError('password',{message:'invalid'});}setError(new ApiError('VALIDATION_ERROR'));return;}
    try{
      await api(paths[mode],responseSchemas[mode] as z.ZodType<unknown>,{body:input.data});
      if(mode==='login'){session.begin();return;}
      if(mode==='register'||mode==='forgot'){setMessage('inbox');return;}
      discardCredential();
      if(mode==='reset'){session.end('resetDone');return;}
      if(mode==='bootstrap')queryClient.removeQueries({queryKey:['public','settings'],exact:true});
      session.announce(mode==='bootstrap'?'initialized':mode==='invite'?'invitationAccepted':'verified');navigate('/login',{replace:true});
    }catch(cause){setError(cause);if(cause instanceof ApiError&&cause.code==='EMAIL_VERIFICATION_REQUIRED')setPending(true);}
    finally{form.resetField('password');form.resetField('confirm');}
  }
  async function resend(){setExtraBusy(true);setError(null);try{const data=EmailRequestSchema.parse({email:form.getValues('email')});await api('/auth/email/resend',accepted,{body:data});setMessage('inbox');}catch(cause){setError(cause);}finally{setExtraBusy(false);}}
  async function retryLogout(){setExtraBusy(true);try{let csrf:string|undefined;try{csrf=(await api('/me',MeSchema)).csrf_token;}catch(cause){if(!(cause instanceof ApiError&&cause.status===401))throw cause;}await api('/auth/logout',z.object({logged_out:z.literal(true)}),{body:{},...(csrf?{csrf}:{})});session.end('sessionEnded');}catch{session.announce('logoutUnknown');}finally{setExtraBusy(false);}}
  const field=(name:keyof Fields,label:MessageKey,type='text')=><div className="field" key={name}><label htmlFor={name}>{t(label)}</label><input id={name} type={type} autoComplete={name==='confirm'?'new-password':name==='password'?(mode==='login'?'current-password':'new-password'):name==='email'?'email':'nickname'} aria-invalid={!!form.formState.errors[name]} aria-describedby={form.formState.errors[name]?name+'-error':name==='password'&&confirmation?'password-hint':undefined} {...form.register(name,{required:'required'})}/>{form.formState.errors[name]&&<span className="field-error" id={name+'-error'}>{t(form.formState.errors[name]?.message as MessageKey??'invalid')}</span>}</div>;
  const blocked=settings.data&&(!settings.data.initialized&&mode!=='bootstrap'||mode==='register'&&!settings.data.registration_open);
  return <div className="auth-shell"><header className="public-header"><Link className="brand" to="/login"><span className="brand-mark" aria-hidden="true">H</span>{settings.data?.instance_name??'HonoCraft'}</Link><PreferenceControls/></header><main id="main" className="auth-main"><section className="auth-intro"><span className="eyebrow">HONOCRAFT</span><p>{t('authIntro')}</p><div className="architectural-mark" aria-hidden="true"><span/><span/><span/></div></section><section className="auth-card"><h1>{t(mode)}</h1><p className="muted">{t(intro[mode])}</p>
    {settings.isPending?<p role="status">{t('loading')}</p>:settings.isError?<div role="alert">{t('unavailableIntro')}<button onClick={()=>void settings.refetch()}>{t('retry')}</button></div>:<>
      {mode==='login'&&session.notice&&<div role={session.notice==='logoutUnknown'?'alert':'status'} className="notice">{t(session.notice)}{session.notice==='logoutUnknown'&&<button disabled={extraBusy} onClick={()=>void retryLogout()}>{t('retryLogout')}</button>}</div>}
      {blocked?<p role="alert" className="notice">{t(!settings.data.initialized?'uninitialized':'registrationClosed')}</p>:credential&&!token?<p role="alert" className="notice">{t('linkMissing')}</p>:mode==='invite'&&!preview?<div>{previewError?<div role="alert" className="notice error">{t(errorMessage(previewError),{seconds:previewError instanceof ApiError?previewError.retryAfter:60})}<button onClick={()=>setPreviewAttempt(value=>value+1)}>{t('retry')}</button></div>:<p role="status">{t('loading')}</p>}</div>:<form noValidate onSubmit={form.handleSubmit(submit)}>
        {mode==='invite'&&preview&&<div className="notice invitation-preview"><p>{t('invitationFor',{instance:preview.instance_name})}</p><p className="invitation-email">{preview.email}</p><p>{t('expiresAt')}: {new Intl.DateTimeFormat(preferences.locale,{dateStyle:'medium',timeStyle:'short',timeZone:settings.data.timezone}).format(new Date(preview.expires_at))} ({settings.data.timezone})</p></div>}
        {hasName&&field('display_name','displayName')}{hasEmail&&field('email','email','email')}{hasPassword&&field('password',mode==='reset'?'newPassword':'password','password')}
        {confirmation&&<p id="password-hint" className="hint">{t('passwordHint',{minimum:settings.data.password_min_length})}</p>}{confirmation&&field('confirm','confirmPassword','password')}
        {!!error&&<div role="alert" className="notice error">{t(errorMessage(error),{seconds:error instanceof ApiError?error.retryAfter:60})}</div>}{message&&<div role="status" className="notice">{t(message)}</div>}
        <button className="primary" disabled={form.formState.isSubmitting||extraBusy} type="submit">{t(form.formState.isSubmitting?'submitBusy':submitLabel[mode])}</button>
        {pending&&<button disabled={extraBusy||form.formState.isSubmitting} type="button" onClick={()=>void resend()}>{t('resend')}</button>}
      </form>}
      <nav className="auth-links" aria-label={t('account')}>{mode==='login'?<><Link to="/forgot-password">{t('forgot')}</Link>{settings.data.registration_open&&<Link to="/register">{t('register')}</Link>}</>:<Link to="/login">{t('backLogin')}</Link>}</nav>
    </>}
  </section></main><footer>{settings.data?.copyright||t('copyrightFallback')}</footer></div>;
}
