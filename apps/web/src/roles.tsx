import {useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {Link,useLocation,useNavigate,useParams,useSearchParams} from 'react-router';
import {useTranslation} from 'react-i18next';
import type {Me} from '@honocraft/contracts/http';
import {RoleDtoSchema,RoleListSchema,RoleQuerySchema,type RoleDto} from '@honocraft/contracts/roles';
import {PermissionModuleSchema,PermissionQuerySchema} from '@honocraft/contracts/permission-catalog';
import {api,errorMessage} from './api.js';
import {PermissionView,usePermissionCatalog} from './permission-view.js';
import {RoleDialog,type RoleOperation} from './role-dialog.js';

export function RoleFacts({role}:{role:RoleDto}){
  const {t}=useTranslation();
  return <><p className="wrap"><code>{role.code}</code> · {t('roleVersion',{version:role.version})}</p>{role.description&&<p className="wrap">{role.description}</p>}
    <dl className="session-details"><div><dt>{t('roleDelegable')}</dt><dd>{t(role.is_delegable?'yes':'no')}</dd></div><div><dt>{t('roleRegistrationEligible')}</dt><dd>{t(role.is_registration_default_eligible?'yes':'no')}</dd></div></dl>
    <h3>{t('roleReferences')}</h3><dl className="session-details">{Object.entries(role.reference_counts).map(([key,count])=><div key={key}><dt>{t('roleRef_'+key)}</dt><dd>{count}</dd></div>)}</dl></>;
}
export function RolesPage({me}:{me:Me}){
  const {t}=useTranslation(),{id}=useParams(),[search,setSearch]=useSearchParams(),navigate=useNavigate(),location=useLocation(),client=useQueryClient();
  const [selection,setSelection]=useState<{kind:RoleOperation;role?:RoleDto}|null>(null);
  const parsed=RoleQuerySchema.safeParse(Object.fromEntries(search)),canRead=me.permission_codes.includes('role:read');
  const list=useQuery({queryKey:['actor',me.user.id,'roles','list',search.toString()],enabled:canRead&&!id&&parsed.success,queryFn:({signal})=>api('/roles?'+search,RoleListSchema,{protected:true,signal})});
  const detail=useQuery({queryKey:['actor',me.user.id,'roles','detail',id],enabled:canRead&&!!id,queryFn:({signal})=>api('/roles/'+id,RoleDtoSchema,{protected:true,signal})});
  const catalog=usePermissionCatalog(me);
  if(!canRead)return <h1>{t('forbidden')}</h1>;
  const label=(role:RoleDto)=>role.is_builtin?t(({user:'roleUser',admin:'roleAdmin',super_admin:'roleSuper'} as const)[role.code as 'user'|'admin'|'super_admin']??role.name):role.name;
  function saved(roleId:string,created:boolean,deleted:boolean){
    setSelection(null);void client.invalidateQueries({queryKey:['actor',me.user.id]});void client.invalidateQueries({queryKey:['session']});
    navigate(deleted?'/roles':'/roles/'+roleId,{state:{roleSaved:true,roleCreated:created}});
  }
  const notice=location.state as {roleSaved?:boolean;roleCreated?:boolean}|null;
  const modal=selection&&<RoleDialog key={selection.kind+selection.role?.id} me={me} kind={selection.kind} {...(selection.role?{role:selection.role}:{})} close={()=>setSelection(null)} saved={saved}/>;
  if(id){const role=detail.data;return <><Link to="/roles">{t('backRoles')}</Link>{detail.isPending?<p role="status">{t('loading')}</p>:detail.isError?<div role="alert">{t(errorMessage(detail.error))}<button onClick={()=>void detail.refetch()}>{t('retry')}</button></div>:role&&<>
    <h1 className="wrap">{label(role)}</h1>{notice?.roleSaved&&<p role="status" className="notice">{t(notice.roleCreated?'roleCreatedHelp':'roleSaved')}</p>}
    <section className="panel"><span className="badge">{t(role.is_builtin?'builtInRole':'customRole')}</span><RoleFacts role={role}/>{role.is_builtin&&<p className="hint">{t('builtInHelp')}</p>}
      <div className="action-row">{(['update','copy','delete'] as const).filter(action=>role.allowed_actions.includes(action)).map(action=><button key={action} onClick={()=>setSelection({kind:action,role})}>{t(action==='update'?'editRole':action==='copy'?'copyRole':'deleteRole')}</button>)}</div>
    </section><section className="panel role-section"><h2>{t('rolePermissions')}</h2>{role.permission_codes.length===0?<p>{t('noPermissions')}</p>:!me.permission_codes.includes('permission:read')?<ul>{role.permission_codes.map(code=><li key={code}><code>{code}</code></li>)}</ul>:catalog.isPending?<p role="status">{t('loading')}</p>:catalog.isError?<p role="alert">{t(errorMessage(catalog.error))}<button onClick={()=>void catalog.refetch()}>{t('retry')}</button></p>:<PermissionView catalog={catalog.data} selected={role.permission_codes}/>}</section>
    {role.allowed_actions.includes('eligibility')&&<section className="panel role-section"><h2>{t('roleQualifications')}</h2><p>{t('qualificationsHelp')}</p><button onClick={()=>setSelection({kind:'eligibility',role})}>{t('setQualifications')}</button></section>}
  </>}{modal}</>;}
  const changePage=(page:number)=>{const next=new URLSearchParams(search);next.set('page',String(page));setSearch(next);};
  return <><h1>{t('roleManagement')}</h1><p className="muted">{t('rolesIntro')}</p>{me.permission_codes.includes('role:manage')&&<button className="primary" onClick={()=>setSelection({kind:'create'})}>{t('createRole')}</button>}
    {notice?.roleSaved&&<p role="status" className="notice">{t('roleSaved')}</p>}
    <form className="panel invitation-filters" key={search.toString()} onSubmit={event=>{event.preventDefault();const values=new FormData(event.currentTarget),next=new URLSearchParams();for(const key of ['query','code','is_builtin']){const value=String(values.get(key)??'').trim();if(value)next.set(key,value);}setSearch(next);}}>
      <div className="form-columns"><div className="field"><label htmlFor="role-filter-query">{t('searchRoles')}</label><input id="role-filter-query" name="query" defaultValue={search.get('query')??''}/></div><div className="field"><label htmlFor="role-filter-type">{t('roleType')}</label><select id="role-filter-type" name="is_builtin" defaultValue={search.get('is_builtin')??''}><option value="">{t('allRoles')}</option><option value="true">{t('builtInRole')}</option><option value="false">{t('customRole')}</option></select></div></div>
      <details><summary>{t('moreFilters')}</summary><div className="field"><label htmlFor="role-filter-code">{t('roleCode')}</label><input id="role-filter-code" name="code" defaultValue={search.get('code')??''}/></div></details><div className="action-row"><button>{t('applyFilters')}</button><button type="button" onClick={()=>setSearch({})}>{t('clearFilters')}</button></div>
    </form>
    {!parsed.success?<p role="alert">{t('invalidRoleFilters')}</p>:list.isPending?<p role="status">{t('loading')}</p>:list.isError?<p role="alert">{t(errorMessage(list.error))}<button onClick={()=>void list.refetch()}>{t('retry')}</button></p>:<><div className="session-list">{list.data.items.map(role=><article className="panel" key={role.id}><div className="session-heading"><h2 className="wrap">{label(role)}</h2><span className="badge">{t(role.is_builtin?'builtInRole':'customRole')}</span></div><p className="wrap"><code>{role.code}</code></p><p className="hint">{t('roleDelegable')}: {t(role.is_delegable?'yes':'no')} · {t('roleRegistrationEligible')}: {t(role.is_registration_default_eligible?'yes':'no')}</p><Link to={'/roles/'+role.id}>{t('details')}</Link></article>)}</div>{list.data.total===0&&<p>{t('noRoles')}</p>}<nav className="pagination" aria-label={t('roleManagement')}><button disabled={list.data.page<=1} onClick={()=>changePage(list.data.page-1)}>{t('previous')}</button><span>{t('rolePageCount',{page:list.data.page,total:list.data.total})}</span><button disabled={list.data.page*list.data.page_size>=list.data.total} onClick={()=>changePage(list.data.page+1)}>{t('next')}</button></nav></>}{modal}</>;
}
export function PermissionsPage({me}:{me:Me}){
  const {t}=useTranslation(),[search,setSearch]=useSearchParams(),parsed=PermissionQuerySchema.safeParse(Object.fromEntries(search));
  const catalog=usePermissionCatalog(me,parsed.success?parsed.data.module:undefined);
  if(!me.permission_codes.includes('permission:read'))return <h1>{t('forbidden')}</h1>;
  return <><h1>{t('permissionCatalog')}</h1><p className="muted">{t('permissionsIntro')}</p><div className="field"><label htmlFor="permission-module">{t('moduleFilter')}</label><select id="permission-module" value={search.get('module')??''} onChange={event=>setSearch(event.target.value?{module:event.target.value}:{})}><option value="">{t('allModules')}</option>{PermissionModuleSchema.options.map(module=><option key={module} value={module}>{t('permissionModule_'+module)}</option>)}</select></div>
    {!parsed.success?<p role="alert">{t('invalidRoleFilters')}</p>:catalog.isPending?<p role="status">{t('loading')}</p>:catalog.isError?<p role="alert">{t(errorMessage(catalog.error))}<button onClick={()=>void catalog.refetch()}>{t('retry')}</button></p>:<><p className="hint">{t('catalogVersion',{version:catalog.data.catalog_version})}</p>{catalog.data.modules.length?<PermissionView catalog={catalog.data}/>:<p>{t('noPermissions')}</p>}</>}</>;
}
