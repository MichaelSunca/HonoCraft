import {useEffect,useRef,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {useSearchParams} from 'react-router';
import {useTranslation} from 'react-i18next';
import {z} from 'zod';
import {InvitationDtoSchema,InvitationListSchema,InvitationQuerySchema,InvitationCreateSchema,InvitationActionSchema,InvitationSentSchema,InvitationRevokedSchema,defaultInvitationRoleId} from '@honocraft/contracts/invitations';
import {RoleDtoSchema,RoleListSchema} from '@honocraft/contracts/roles';
import {ReauthenticatedSchema,type Me} from '@honocraft/contracts/http';
import {normalizeEmail} from '@honocraft/contracts/common';
import {api,ApiError,errorMessage} from './api.js';
type Invitation=z.infer<typeof InvitationDtoSchema>;
type Selection={kind:'create'|'view'|'resend'|'revoke'|'reinvite';invitation?:Invitation};
const replay=z.object({outcome:z.enum(['invite_created','invite_resent','invite_revoked']),resource_id:z.uuid(),version:z.number().int(),completed_at:z.string()});
const resultSchema=z.union([InvitationSentSchema,InvitationRevokedSchema,replay]);
const time=(value:string,locale:string,zone:string)=>new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short',timeZone:zone}).format(new Date(value));
export function InvitationsPage({me}:{me:Me}){
  const {t,i18n}=useTranslation(),client=useQueryClient(),[search,setSearch]=useSearchParams(),[selection,setSelection]=useState<Selection|null>(null),[saved,setSaved]=useState(false);
  const parsed=InvitationQuerySchema.safeParse(Object.fromEntries(search)),canRead=me.permission_codes.includes('invite:read');
  const list=useQuery({queryKey:['actor',me.user.id,'invites',search.toString()],enabled:canRead&&parsed.success,
    queryFn:({signal})=>api('/invites?'+search,InvitationListSchema,{protected:true,signal})});
  if(!canRead)return <h1>{t('forbidden')}</h1>;
  const page=parsed.success?parsed.data.page:1;
  function select(value:Selection){setSaved(false);setSelection(value);}
  const changePage=(value:number)=>{const next=new URLSearchParams(search);next.set('page',String(value));setSearch(next);};
  return <><h1>{t('invitations')}</h1><p className="muted">{t('invitationsIntro')}</p>{me.permission_codes.includes('invite:manage')&&<button className="primary" onClick={()=>select({kind:'create'})}>{t('createInvitation')}</button>}
    <form className="panel invitation-filters" key={search.toString()} onSubmit={event=>{event.preventDefault();const form=new FormData(event.currentTarget),next=new URLSearchParams();for(const key of ['query','status','sort','direction']){const value=String(form.get(key)??'').trim();if(value)next.set(key,value);}for(const key of ['created_from','created_to']){const value=String(form.get(key)??'');if(value)next.set(key,value+'T00:00:00Z');}if(search.has('inviter_id'))next.set('inviter_id',search.get('inviter_id')!);setSearch(next);}}>
      <div className="form-columns"><div className="field"><label htmlFor="invite-search">{t('searchEmail')}</label><input id="invite-search" name="query" defaultValue={search.get('query')??''}/></div><div className="field"><label htmlFor="invite-status">{t('invitationStatus')}</label><select id="invite-status" name="status" defaultValue={search.get('status')??''}><option value="">{t('allStatuses')}</option>{(['pending','accepted','expired','revoked'] as const).map(value=><option key={value} value={value}>{t('inviteStatus_'+value)}</option>)}</select></div></div>
      <details><summary>{t('moreFilters')}</summary><div className="form-columns">{(['created_from','created_to'] as const).map(key=><div className="field" key={key}><label htmlFor={key}>{t(key==='created_from'?'createdFrom':'createdTo')}</label><input type="date" name={key} id={key} defaultValue={search.get(key)?.slice(0,10)??''}/></div>)}<div className="field"><label htmlFor="invite-sort">{t('sortBy')}</label><select id="invite-sort" name="sort" defaultValue={search.get('sort')??'created_at'}><option value="created_at">{t('createdAt')}</option><option value="email">{t('email')}</option><option value="expires_at">{t('expiresAt')}</option></select></div><div className="field"><label htmlFor="invite-direction">{t('sortOrder')}</label><select id="invite-direction" name="direction" defaultValue={search.get('direction')??'desc'}><option value="desc">{t('descending')}</option><option value="asc">{t('ascending')}</option></select></div></div></details>
      <div className="action-row"><button>{t('applyFilters')}</button><button type="button" onClick={()=>setSearch({})}>{t('clearFilters')}</button>{search.has('inviter_id')&&<span className="badge">{t('inviterFilter')}</span>}</div></form>
    {saved&&<p role="status" className="notice">{t('invitationSaved')}</p>}
    {!parsed.success?<p role="alert">{t('invalidFilters')}</p>:list.isPending?<p role="status">{t('loading')}</p>:list.isError?<div role="alert">{t(errorMessage(list.error))}<button onClick={()=>void list.refetch()}>{t('retry')}</button></div>:<><div className="session-list">{list.data.items.map(item=><article className="panel" key={item.id}><div className="session-heading"><h2 className="wrap">{item.email}</h2><span className="badge">{t('inviteStatus_'+item.status)}</span></div><p>{item.roles.map(role=>role.name).join(', ')}</p><dl className="session-details"><div><dt>{t('invitedBy')}</dt><dd><button onClick={()=>{const next=new URLSearchParams(search);next.set('inviter_id',item.inviter.id);next.delete('page');setSearch(next);}}>{item.inviter.display_name}</button></dd></div><div><dt>{t('expiresAt')}</dt><dd>{time(item.expires_at,i18n.language,me.instance.timezone)}</dd></div><div><dt>{t('mailStatus')}</dt><dd>{item.mail?t('mail_'+item.mail.status):t('noMail')}</dd></div></dl><div className="action-row"><button onClick={()=>select({kind:'view',invitation:item})}>{t('details')}</button>{item.allowed_actions.map(action=><button key={action} onClick={()=>select({kind:action,invitation:item})}>{t(action==='reinvite'?'inviteAgain':action==='resend'?'resendInvitation':'revoke')}</button>)}</div></article>)}</div>{!list.data.items.length&&<p>{t('noInvitations')}</p>}<nav className="pagination" aria-label={t('invitations')}><button disabled={page===1} onClick={()=>changePage(page-1)}>{t('previous')}</button><span>{t('invitationPageCount',{page,total:list.data.total})}</span><button disabled={page*list.data.page_size>=list.data.total} onClick={()=>changePage(page+1)}>{t('next')}</button></nav></>}
    {selection&&<InvitationDialog me={me} selection={selection} close={()=>setSelection(null)} saved={()=>{setSelection(null);setSaved(true);void client.invalidateQueries({queryKey:['actor',me.user.id,'invites']});}}/>}
  </>;
}
function InvitationDialog({me,selection,close,saved}:{me:Me;selection:Selection;close:()=>void;saved:()=>void}){
  const {t,i18n}=useTranslation(),client=useQueryClient(),dialog=useRef<HTMLDialogElement>(null),create=selection.kind==='create'||selection.kind==='reinvite',view=selection.kind==='view';
  const [target,setTarget]=useState(selection.invitation),[email,setEmail]=useState(selection.invitation?.email??''),[reason,setReason]=useState(''),[typed,setTyped]=useState('');
  const [ids,setIds]=useState<string[]>(selection.invitation?.roles.map(role=>role.id)??[defaultInvitationRoleId]);
  const [names,setNames]=useState<Record<string,string>>(()=>Object.fromEntries(selection.invitation?.roles.map(role=>[role.id,role.name])??[[defaultInvitationRoleId,t('roleUser')]]));
  const [roleSearch,setRoleSearch]=useState(''),[rolePage,setRolePage]=useState(1),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null),[unknown,setUnknown]=useState(false),[conflict,setConflict]=useState(false),[latest,setLatest]=useState<Invitation|null>(null);
  const [reauth,setReauth]=useState(false),[password,setPassword]=useState(''),[verified,setVerified]=useState(false);
  const operation=useRef<{key:string;path:string;body:unknown}|null>(null);
  useEffect(()=>{const focused=document.activeElement;dialog.current?.showModal();return()=>{dialog.current?.close();if(focused instanceof HTMLElement)focused.focus();};},[]);
  const roles=useQuery({queryKey:['actor',me.user.id,'roles',roleSearch,rolePage],enabled:create,
    queryFn:({signal})=>api(`/roles?${new URLSearchParams({query:roleSearch,page:String(rolePage),page_size:'20'})}`,RoleListSchema,{protected:true,signal})});
  const selected=useQuery({queryKey:['actor',me.user.id,'invite-role-selection',[...ids].sort().join(',')],enabled:create,
    queryFn:({signal})=>Promise.all(ids.map(id=>api('/roles/'+id,RoleDtoSchema,{protected:true,signal})))});
  const detail=useQuery({queryKey:['actor',me.user.id,'invite-detail',target?.id],enabled:view&&!!target,queryFn:({signal})=>api('/invites/'+target!.id,InvitationDtoSchema,{protected:true,signal})});
  const high=create?selected.data?.some(role=>role.requires_reauth_actions.includes('invite')):target?.requires_reauth_actions.includes(selection.kind as 'resend'|'revoke');
  const canSubmit=create?!!selected.data&&ids.length>0&&selected.data.every(role=>role.allowed_actions.includes('invite')):target?.allowed_actions.includes(selection.kind as 'resend'|'revoke');
  const frozen=busy||unknown;
  function draft(){operation.current=null;setError(null);}
  async function loadLatest(){if(!target)return;setBusy(true);try{setLatest(await api('/invites/'+target.id,InvitationDtoSchema,{protected:true}));void client.invalidateQueries({queryKey:['actor',me.user.id,'invites']});}catch(cause){setError(cause);}finally{setBusy(false);}}
  async function submit(){setError(null);setBusy(true);
    try{
      if(!operation.current){
        let body:unknown,path:string;
        if(create){const normalized=normalizeEmail(email);body=InvitationCreateSchema.parse({email:normalized,role_ids:ids,...(high?{confirmation:{target_email:normalized,typed_label:typed,reason}}:{})});path='/invites';}
        else{const {id,...input}=InvitationActionSchema.parse({id:target!.id,expected_version:target!.version,confirmation:{target_id:target!.id,reason,...(high?{typed_label:typed}:{})}});body=input;path=`/invites/${id}/${selection.kind}`;}
        operation.current={key:crypto.randomUUID(),path,body};
      }
      const value=operation.current;await api(value.path,resultSchema,{body:value.body,csrf:me.csrf_token,protected:true,idempotencyKey:value.key});operation.current=null;saved();
    }catch(cause){
      if(cause instanceof z.ZodError){setError(new ApiError('VALIDATION_ERROR'));return;}
      setError(cause);const uncertain=cause instanceof ApiError&&(cause.code==='NETWORK'||cause.code==='INTERNAL_ERROR'||cause.status>=500);setUnknown(uncertain);
      if(!uncertain)operation.current=null;
      if(cause instanceof ApiError&&cause.code==='REAUTH_REQUIRED'){setReauth(true);setVerified(false);}
      if(cause instanceof ApiError&&['VERSION_CONFLICT','INVITE_TERMINAL'].includes(cause.code)){setConflict(true);await loadLatest();}
    }finally{setBusy(false);}
  }
  async function verify(){setBusy(true);setError(null);try{await api('/auth/reauthenticate',ReauthenticatedSchema,{body:{current_password:password},csrf:me.csrf_token,protected:true});setReauth(false);setVerified(true);}catch(cause){setError(cause);}finally{setPassword('');setBusy(false);}}
  const display=detail.data??target;
  return <dialog ref={dialog} aria-labelledby="invitation-dialog-title" onCancel={event=>{event.preventDefault();if(!frozen)close();}}><h2 id="invitation-dialog-title">{t(view?'invitationDetails':create?'createInvitation':selection.kind==='revoke'?'revoke':'resendInvitation')}</h2>
    {view?<>{detail.isPending?<p role="status">{t('loading')}</p>:detail.isError?<p role="alert">{t(errorMessage(detail.error))}<button onClick={()=>void detail.refetch()}>{t('retry')}</button></p>:display&&<><p className="wrap">{display.email}</p><dl><dt>{t('invitationStatus')}</dt><dd>{t('inviteStatus_'+display.status)}</dd><dt>{t('createdAt')}</dt><dd>{time(display.created_at,i18n.language,me.instance.timezone)}</dd><dt>{t('expiresAt')}</dt><dd>{time(display.expires_at,i18n.language,me.instance.timezone)}</dd><dt>{t('assignedRoles')}</dt><dd>{display.roles.map(role=>role.name).join(', ')}</dd><dt>{t('mailStatus')}</dt><dd>{display.mail?t('mail_'+display.mail.status):t('noMail')}</dd></dl></>}<button onClick={close}>{t('close')}</button></>:<>
      <form onSubmit={event=>{event.preventDefault();void submit();}}>
        <fieldset disabled={frozen} className="plain-fieldset">{create?<><div className="field"><label htmlFor="invitation-email">{t('email')}</label><input id="invitation-email" type="email" required value={email} onChange={event=>{draft();setEmail(event.target.value);}}/></div><fieldset className="role-picker"><legend>{t('assignedRoles')}</legend><label htmlFor="role-query">{t('searchRoles')}</label><input id="role-query" value={roleSearch} onChange={event=>{setRoleSearch(event.target.value);setRolePage(1);}}/>
          {roles.isPending?<p role="status">{t('loading')}</p>:roles.isError?<p role="alert">{t(errorMessage(roles.error))}<button type="button" onClick={()=>void roles.refetch()}>{t('retry')}</button></p>:<>{roles.data.items.map(role=><label key={role.id} className="role-choice"><input type="checkbox" checked={ids.includes(role.id)} disabled={!role.allowed_actions.includes('invite')&&!ids.includes(role.id)} onChange={event=>{draft();setNames(current=>({...current,[role.id]:role.name}));setIds(current=>event.target.checked?[...current,role.id]:current.filter(id=>id!==role.id));}}/>{role.name} ({role.code})</label>)}<div className="pagination"><button type="button" disabled={rolePage===1} onClick={()=>setRolePage(rolePage-1)}>{t('previous')}</button><span>{rolePage}</span><button type="button" disabled={rolePage*20>=roles.data.total} onClick={()=>setRolePage(rolePage+1)}>{t('next')}</button></div></>}
          {selected.isError?<p role="alert">{t(errorMessage(selected.error))}<button type="button" onClick={()=>void selected.refetch()}>{t('retry')}</button></p>:<p className="hint">{t('selectedRoles')}</p>}<ul className="selected-roles">{ids.map(id=><li key={id}><button type="button" onClick={()=>{draft();setIds(current=>current.filter(value=>value!==id));}}>{t('removeRole',{name:selected.data?.find(role=>role.id===id)?.name??names[id]??t('unavailableRole')})}</button></li>)}</ul>{!ids.length&&<p>{t('noneSelected')}</p>}</fieldset></>:<p className="wrap">{target?.email}</p>}
          {(!create||high)&&<div className="field"><label htmlFor="invitation-reason">{t('reason')}</label><textarea id="invitation-reason" required maxLength={500} value={reason} onChange={event=>{draft();setReason(event.target.value);}}/></div>}
          {high&&<div className="field"><label htmlFor="invitation-typed">{t('typeEmail')}</label><input id="invitation-typed" required value={typed} onChange={event=>{draft();setTyped(event.target.value);}}/><p className="hint">{t('highInvitationHelp')}</p></div>}
        </fieldset>
        {!!error&&<div role="alert" className="notice error">{t(conflict?'invitationConflict':error instanceof ApiError&&error.code==='AUTH_FAILED'?'currentPasswordIncorrect':errorMessage(error),{seconds:error instanceof ApiError?error.retryAfter:60})}</div>}
        {unknown&&<p className="hint">{t('retrySameHelp')}</p>}
        {conflict&&<div className="notice">{latest?<><p>{t('currentInvitation',{status:t('inviteStatus_'+latest.status),version:latest.version})}</p><p>{latest.roles.map(role=>role.name).join(', ')}</p><button type="button" disabled={busy} onClick={()=>{setTarget(latest);setLatest(null);setConflict(false);setError(null);operation.current=null;}}>{t('useLatest')}</button></>:<button type="button" disabled={busy} onClick={()=>void loadLatest()}>{t('reloadVersion')}</button>}</div>}
        {verified&&<p role="status" className="notice">{t('verifiedConfirmAgain')}</p>}
        <div className="dialog-actions"><button type="button" disabled={frozen} onClick={close}>{t('cancel')}</button><button className="primary" disabled={busy||conflict||reauth||(!unknown&&!canSubmit)}>{t(busy?'submitBusy':unknown?'retrySame':create?'sendInvitation':'confirm')}</button></div>
      </form>
      {reauth&&<form className="reauth-form" onSubmit={event=>{event.preventDefault();void verify();}}><div className="field"><label htmlFor="invitation-password">{t('currentPassword')}</label><input id="invitation-password" type="password" autoComplete="current-password" required disabled={busy} value={password} onChange={event=>setPassword(event.target.value)}/></div><button className="primary" disabled={busy}>{t('verifyIdentity')}</button></form>}
    </>}
  </dialog>;
}
