import {useEffect,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {useTranslation} from 'react-i18next';
import type {Me} from '@honocraft/contracts/http';
import {RoleDtoSchema,RoleListSchema,type RoleDto} from '@honocraft/contracts/roles';
import {permissionDefinitions} from '@honocraft/contracts/permissions';
import {api,ApiError,errorMessage} from './api.js';
export function useRoleLabel(){const {t}=useTranslation();return (role:{code:string;name:string})=>role.code==='user'?t('roleUser'):role.code==='admin'?t('roleAdmin'):role.code==='super_admin'?t('roleSuper'):role.name;}
const highRole=(role:RoleDto)=>!role.is_delegable||['admin','super_admin'].includes(role.code)||role.permission_codes.some(code=>permissionDefinitions.find(p=>p.code===code)?.reserved);
export function UserRolePicker({me,ids,onChange,names={},grantOnly=false,multiple=true,onState}:{me:Me;ids:string[];onChange:(ids:string[])=>void;names?:Record<string,string>;grantOnly?:boolean;multiple?:boolean;onState?:(state:{ready:boolean;high:boolean})=>void}){
  const {t}=useTranslation(),label=useRoleLabel(),[search,setSearch]=useState(''),[page,setPage]=useState(1),valid=search.trim().length===0||[...search.trim()].length>=2;
  const list=useQuery({queryKey:['actor',me.user.id,'roles','user-picker',search,page],enabled:valid,queryFn:({signal})=>api('/roles?'+new URLSearchParams({query:search,page:String(page),page_size:'20'}),RoleListSchema,{protected:true,signal})});
  const selected=useQuery({queryKey:['actor',me.user.id,'roles','user-selection',[...ids].sort().join(',')],queryFn:({signal})=>Promise.all(ids.map(async id=>{try{return {id,role:await api('/roles/'+id,RoleDtoSchema,{protected:true,signal})};}catch(cause){if(cause instanceof ApiError&&cause.status===404)return {id,role:null};throw cause;}}))});
  const superAdmin=me.roles.some(role=>role.code==='super_admin');
  const grantable=(role:RoleDto)=>superAdmin||(role.is_delegable&&!highRole(role)&&role.permission_codes.every(code=>{const p=permissionDefinitions.find(p=>p.code===code);return !!p&&p.delegable&&!p.reserved&&me.permission_codes.includes(code)&&p.dependencies.every(required=>role.permission_codes.includes(required));}));
  const ready=!!selected.data&&selected.data.every(item=>item.role&&(!grantOnly||grantable(item.role))),high=selected.data?.some(item=>item.role&&highRole(item.role))??false;
  useEffect(()=>{onState?.({ready,high});},[ready,high,onState]);
  function toggle(id:string,checked:boolean){onChange(checked?(multiple?[...new Set([...ids,id])]:[id]):ids.filter(value=>value!==id));}
  return <fieldset className="role-picker"><legend>{t(grantOnly?'assignedRoles':'filterRole')}</legend><div className="field"><label htmlFor={grantOnly?'user-role-search':'filter-role-search'}>{t('searchRoles')}</label><input id={grantOnly?'user-role-search':'filter-role-search'} value={search} onChange={event=>{setSearch(event.target.value);setPage(1);}}/></div>
    {!!ids.length&&<div><p>{t('selectedRoles')}</p>{ids.map(id=>{const role=selected.data?.find(item=>item.id===id)?.role,name=role?label(role):names[id]??t('unavailableRole');return <div className="action-row" key={id}><span className="wrap">{name}</span><button type="button" onClick={()=>toggle(id,false)}>{t('removeRole',{name})}</button></div>;})}</div>}
    {selected.isError&&<p role="alert">{t(errorMessage(selected.error))}<button type="button" onClick={()=>void selected.refetch()}>{t('retry')}</button></p>}{grantOnly&&selected.data&&!ready&&<p role="alert">{t('unavailableUserRoles')}</p>}
    {!valid?<p>{t('invalidRoleFilters')}</p>:list.isPending?<p role="status">{t('loading')}</p>:list.isError?<p role="alert">{t(errorMessage(list.error))}<button type="button" onClick={()=>void list.refetch()}>{t('retry')}</button></p>:<>{list.data.items.map(role=><label className="role-choice" key={role.id}><input type={multiple?'checkbox':'radio'} name={multiple?'role_ids':'role_filter'} checked={ids.includes(role.id)} disabled={grantOnly&&!ids.includes(role.id)&&!grantable(role)} onChange={event=>toggle(role.id,event.target.checked)}/><span>{label(role)} <code>{role.code}</code></span></label>)}<nav className="pagination" aria-label={t('roles')}><button type="button" disabled={page===1} onClick={()=>setPage(page-1)}>{t('previous')}</button><span>{t('rolePageCount',{page,total:list.data.total})}</span><button type="button" disabled={page*20>=list.data.total} onClick={()=>setPage(page+1)}>{t('next')}</button></nav></>}
  </fieldset>;
}
