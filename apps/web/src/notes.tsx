import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Link,useLocation,useNavigate,useSearchParams} from 'react-router';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {useTranslation} from 'react-i18next';
import {z} from 'zod';
import type {Me} from '@honocraft/contracts/http';
import {NoteQuerySchema,NoteDtoSchema,NoteListSchema,NoteInputSchema,NoteDeleteResultSchema,type NoteDto} from '@honocraft/contracts/notes';
import {api,ApiError,errorMessage,mutationOutcomeUnknown} from './api.js';
type Selection={kind:'create'|'update'|'delete';note:NoteDto|null};
const base='/example-notes';
const summary=z.strictObject({outcome:z.enum(['note_created','note_updated','note_deleted']),resource_id:z.uuid(),version:z.number().int().positive(),completed_at:z.iso.datetime()});
const resultSchema=z.union([NoteDtoSchema,NoteDeleteResultSchema,summary]);
const prefix=(me:Me)=>['actor',me.user.id,'notes'];
const suffix=(search:URLSearchParams)=>search.size?'?'+search.toString():'';
function NoteText({note}:{note:NoteDto}){const {t}=useTranslation();return <><p>{t('roleVersion',{version:note.version})}</p><pre className="note-body">{note.body}</pre></>;}
export function NotesPage({me}:{me:Me}){
  const {t,i18n}=useTranslation(),location=useLocation(),navigate=useNavigate(),[search,setSearch]=useSearchParams(),client=useQueryClient();
  const [selection,setSelection]=useState<Selection|null>(null),[notice,setNotice]=useState<'noteSaved'|'noteDeleted'|null>(null);
  const id=location.pathname===base?null:location.pathname.slice(base.length+1),canRead=me.permission_codes.includes('example-note:read'),parsed=NoteQuerySchema.safeParse(Object.fromEntries(search)),validId=id!==null&&z.uuid().safeParse(id).success;
  const list=useQuery({queryKey:[...prefix(me),'list',search.toString()],enabled:canRead&&id===null&&parsed.success,queryFn:({signal})=>api(base+suffix(search),NoteListSchema,{protected:true,signal})});
  const detail=useQuery({queryKey:[...prefix(me),'detail',id],enabled:canRead&&validId,queryFn:({signal})=>api(base+'/'+id,NoteDtoSchema,{protected:true,signal})});
  if(!canRead)return <h1>{t('forbidden')}</h1>;
  function apply(event:FormEvent<HTMLFormElement>){event.preventDefault();const values=new FormData(event.currentTarget),next=new URLSearchParams();for(const name of ['query','sort','direction']){const value=String(values.get(name)??'').trim();if(value)next.set(name,value);}setSearch(next);}
  function page(number:number){const next=new URLSearchParams(search);next.set('page',String(number));setSearch(next);}
  const error=(cause:unknown)=>cause instanceof ApiError&&cause.code==='NOT_FOUND'?'noteUnavailable':errorMessage(cause);
  return <>{id!==null?<><Link to={base+suffix(search)}>{t('backNotes')}</Link>{!validId?<p role="alert">{t('noteUnavailable')}</p>:detail.isPending?<p role="status">{t('loading')}</p>:detail.isError?<div role="alert">{t(error(detail.error))}<button onClick={()=>void detail.refetch()}>{t('retry')}</button></div>:<><h1 id="notes-page-title" tabIndex={-1} className="wrap">{detail.data.title}</h1><NoteText note={detail.data}/><div className="action-row">{detail.data.allowed_actions.includes('update')&&<button onClick={()=>{setNotice(null);setSelection({kind:'update',note:detail.data});}}>{t('editNote')}</button>}{detail.data.allowed_actions.includes('delete')&&<button onClick={()=>{setNotice(null);setSelection({kind:'delete',note:detail.data});}}>{t('deleteNote')}</button>}<button disabled={detail.isFetching} onClick={()=>void detail.refetch()}>{t('reloadCurrentNote')}</button></div></>}</>:<>
    <h1 id="notes-page-title" tabIndex={-1}>{t('personalNotes')}</h1><p className="muted">{t('notesIntro')}</p><div className="action-row">{me.permission_codes.includes('example-note:create')&&<button className="primary" onClick={()=>{setNotice(null);setSelection({kind:'create',note:null});}}>{t('createNote')}</button>}<button disabled={!parsed.success||list.isFetching} onClick={()=>void list.refetch()}>{t('notesRefresh')}</button></div>
    <form className="panel filters" key={search.toString()} onSubmit={apply}><div className="filter-grid"><div className="field"><label htmlFor="notes-search">{t('searchNotes')}</label><input id="notes-search" name="query" defaultValue={search.get('query')??''}/></div><div className="field"><label htmlFor="notes-sort">{t('sortBy')}</label><select id="notes-sort" name="sort" defaultValue={search.get('sort')??'created_at'}><option value="created_at">{t('createdAt')}</option><option value="updated_at">{t('noteUpdated')}</option><option value="title">{t('noteTitle')}</option></select></div><div className="field"><label htmlFor="notes-direction">{t('sortOrder')}</label><select id="notes-direction" name="direction" defaultValue={search.get('direction')??'desc'}><option value="desc">{t('descending')}</option><option value="asc">{t('ascending')}</option></select></div></div><div className="action-row"><button>{t('applyFilters')}</button><button type="button" onClick={()=>setSearch(new URLSearchParams())}>{t('clearFilters')}</button></div></form>
    {!parsed.success?<p role="alert" className="notice error">{t('invalidNoteFilters')}</p>:list.isPending?<p role="status">{t('loading')}</p>:list.isError?<div role="alert">{t(errorMessage(list.error))}<button onClick={()=>void list.refetch()}>{t('retry')}</button></div>:<><div className="session-list">{list.data.items.map(note=><article className="panel note-card" key={note.id}><h2 className="wrap"><Link to={base+'/'+note.id+suffix(search)}>{note.title}</Link></h2><p className="muted">{new Intl.DateTimeFormat(i18n.language,{dateStyle:'medium',timeStyle:'short',timeZone:me.instance.timezone}).format(new Date(note.updated_at))} ({me.instance.timezone}) · {t('roleVersion',{version:note.version})}</p></article>)}</div>{!list.data.items.length&&<p className="notice">{t('noNotes')}</p>}<nav className="pagination" aria-label={t('personalNotes')}><button disabled={list.isFetching||list.data.page<=1} onClick={()=>page(list.data.page-1)}>{t('previous')}</button><span>{t('notePageCount',{page:list.data.page,total:list.data.total})}</span><button disabled={list.isFetching||list.data.page*list.data.page_size>=list.data.total} onClick={()=>page(list.data.page+1)}>{t('next')}</button></nav></>}
    </>}{notice&&<p role="status" className="notice success">{t(notice)}</p>}{selection&&<NoteDialog me={me} selection={selection} search={search} close={()=>setSelection(null)} completed={(noteId,removed)=>{setSelection(null);setNotice(removed?'noteDeleted':'noteSaved');if(removed){client.removeQueries({queryKey:[...prefix(me),'detail',noteId]});navigate(base+suffix(search));}else navigate(base+'/'+noteId+suffix(search));}}/>}</>;
}
type Attempt={key:string;body:unknown;path:string;method:'POST'|'PATCH'|'DELETE'};
function NoteDialog({me,selection,search,close,completed}:{me:Me;selection:Selection;search:URLSearchParams;close:()=>void;completed:(id:string,removed:boolean)=>void}){
  const {t}=useTranslation(),client=useQueryClient(),dialog=useRef<HTMLDialogElement>(null),attempt=useRef<Attempt|null>(null),{kind}=selection;
  const [target,setTarget]=useState(selection.note),[title,setTitle]=useState(selection.note?.title??''),[body,setBody]=useState(selection.note?.body??''),[fields,setFields]=useState<{title?:boolean;body?:boolean}>({});
  const [busy,setBusy]=useState(false),[unknown,setUnknown]=useState(false),[confirmed,setConfirmed]=useState<string|null>(null),[error,setError]=useState<unknown>(null),[conflict,setConflict]=useState(false),[latest,setLatest]=useState<NoteDto|null>(null),[latestError,setLatestError]=useState<unknown>(null);
  const frozen=busy||unknown,heading=kind==='create'?'createNote':kind==='update'?'editNote':'deleteNote';
  useEffect(()=>{const focused=document.activeElement,element=dialog.current;element?.showModal();return()=>{element?.close();if(focused instanceof HTMLElement&&focused.isConnected&&!focused.matches(':disabled'))focused.focus();else document.getElementById('notes-page-title')?.focus();};},[]);
  async function loadLatest(){setBusy(true);setLatestError(null);try{setLatest(await api(base+'/'+target!.id,NoteDtoSchema,{protected:true}));}catch(cause){setLatestError(cause);}finally{setBusy(false);}}
  async function refresh(id=confirmed!){
    setBusy(true);setError(null);
    try{
      await client.cancelQueries({queryKey:prefix(me)});
      if(kind==='delete'){const validSearch=NoteQuerySchema.safeParse(Object.fromEntries(search)).success?search:new URLSearchParams(),data=await api(base+suffix(validSearch),NoteListSchema,{protected:true});client.setQueryData([...prefix(me),'list',validSearch.toString()],data);}
      else client.setQueryData([...prefix(me),'detail',id],await api(base+'/'+id,NoteDtoSchema,{protected:true}));
      await client.invalidateQueries({queryKey:prefix(me),refetchType:'none'});completed(id,kind==='delete');
    }catch(cause){setError(cause);}finally{setBusy(false);}
  }
  async function submit(event:FormEvent){
    event.preventDefault();if(busy||conflict)return;if(confirmed){await refresh();return;}
    if(!attempt.current){
      let data:unknown;
      if(kind==='delete')data={expected_version:target!.version};
      else{const parsed=NoteInputSchema.safeParse({title,body});if(!parsed.success){const invalid={title:parsed.error.issues.some(issue=>issue.path[0]==='title'),body:parsed.error.issues.some(issue=>issue.path[0]==='body')};setFields(invalid);dialog.current?.querySelector<HTMLElement>(invalid.title?'#note-title':'#note-body')?.focus();return;}data=kind==='create'?parsed.data:{...parsed.data,expected_version:target!.version};}
      attempt.current={key:crypto.randomUUID(),body:data,path:kind==='create'?base:base+'/'+target!.id,method:kind==='create'?'POST':kind==='update'?'PATCH':'DELETE'};
    }
    const operation=attempt.current;setBusy(true);setError(null);setFields({});let result:z.infer<typeof resultSchema>;
    try{result=await api(operation.path,resultSchema,{method:operation.method,body:operation.body,csrf:me.csrf_token,idempotencyKey:operation.key,protected:true});}
    catch(cause){setError(cause);const uncertain=mutationOutcomeUnknown(cause,unknown);setUnknown(uncertain);if(!uncertain){attempt.current=null;if(cause instanceof ApiError&&['VERSION_CONFLICT','FORBIDDEN'].includes(cause.code)&&target){setConflict(true);await loadLatest();}}setBusy(false);return;}
    const id='outcome' in result?result.resource_id:result.id;attempt.current=null;setUnknown(false);setConfirmed(id);await refresh(id);
  }
  const message=confirmed?'noteRefreshFailed':unknown?'noteRetryHelp':conflict?'noteConflict':error instanceof ApiError&&error.code==='NOT_FOUND'?'noteUnavailable':errorMessage(error);
  const adoptedAllowed=kind==='create'||!!target?.allowed_actions.includes(kind==='update'?'update':'delete');
  return <dialog className="role-dialog note-dialog" ref={dialog} aria-labelledby="note-dialog-title" onCancel={event=>{event.preventDefault();if(!frozen)close();}}><h2 id="note-dialog-title">{t(heading)}</h2><form onSubmit={event=>void submit(event)}>
    {kind==='delete'?<><p>{t('noteDeleteHelp')}</p><h3 className="wrap">{target?.title}</h3>{target&&<NoteText note={target}/>}</>:<><div className="field"><label htmlFor="note-title">{t('noteTitle')}</label><input autoFocus id="note-title" value={title} onChange={event=>setTitle(event.target.value)} disabled={frozen||!!confirmed} aria-invalid={!!fields.title} aria-describedby="note-title-help"/><p className={fields.title?'field-error':'muted'} id="note-title-help">{t('noteTitleHelp')}</p></div><div className="field"><label htmlFor="note-body">{t('noteBody')}</label><textarea id="note-body" rows={8} value={body} onChange={event=>setBody(event.target.value)} disabled={frozen||!!confirmed} aria-invalid={!!fields.body} aria-describedby="note-body-help"/><p className={fields.body?'field-error':'muted'} id="note-body-help">{t('noteBodyHelp')}</p></div></>}
    {error!==null&&<p className="notice error" role="alert">{t(message)}</p>}
    {conflict&&!confirmed&&<section className="notice"><h3>{t('currentNote')}</h3><p>{t('noteAdoptHelp')}</p>{latest?<><h4 className="wrap">{latest.title}</h4><NoteText note={latest}/>{latest.allowed_actions.includes(kind==='delete'?'delete':'update')?<button type="button" disabled={busy} onClick={()=>{setTarget(latest);setLatest(null);setConflict(false);setError(null);attempt.current=null;}}>{t('useLatest')}</button>:<p>{t('forbidden')}</p>}</>:<>{latestError!==null&&<p>{t(errorMessage(latestError))}</p>}<button type="button" disabled={busy} onClick={()=>void loadLatest()}>{t('reloadCurrentNote')}</button></>}</section>}
    <div className="dialog-actions"><button type="button" disabled={frozen} onClick={close}>{t('close')}</button><button className="primary" disabled={busy||conflict||!unknown&&!confirmed&&!adoptedAllowed}>{t(busy?'submitBusy':confirmed?'refreshNoteStatus':unknown?'retrySame':kind==='create'?'createNote':kind==='update'?'saveNote':'confirmNoteDeletion')}</button></div>
  </form></dialog>;
}
