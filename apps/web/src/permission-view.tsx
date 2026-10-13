import {useQuery} from '@tanstack/react-query';
import {useTranslation} from 'react-i18next';
import {PermissionCatalogSchema,type PermissionCatalog,type PermissionDto} from '@honocraft/contracts/permission-catalog';
import type {PermissionCode} from '@honocraft/contracts/permissions';
import type {Me} from '@honocraft/contracts/http';
import {api} from './api.js';

export function usePermissionCatalog(me:Me,module?:string){
  return useQuery({queryKey:['actor',me.user.id,'permissions',module??''],enabled:me.permission_codes.includes('permission:read'),
    queryFn:({signal})=>api('/permissions'+(module?'?module='+encodeURIComponent(module):''),PermissionCatalogSchema,{protected:true,signal})});
}
export function PermissionView({catalog,selected,onChange,canGrant}:Readonly<{
  catalog:PermissionCatalog;selected?:readonly PermissionCode[];onChange?:(codes:PermissionCode[])=>void;canGrant?:(permission:PermissionDto)=>boolean;
}>){
  const {t}=useTranslation();
  return <div className="permission-groups">{catalog.modules.map(group=>{
    const permissions=group.permissions.filter(permission=>onChange||selected===undefined||selected.includes(permission.code));
    if(!permissions.length)return null;
    return <section className="permission-group" key={group.module}><h3>{t('permissionModule_'+group.module)}</h3>{permissions.map(permission=>{
      const checked=selected?.includes(permission.code)??false;
      return <div className="permission-item" key={permission.code}>
        <div className="permission-heading">{onChange?<label className="role-choice"><input type="checkbox" aria-label={t(permission.name_key,{nsSeparator:false,keySeparator:false,defaultValue:permission.code})+' '+permission.code} checked={checked} disabled={!checked&&canGrant?.(permission)===false}
          onChange={event=>onChange(event.target.checked?[...(selected??[]),permission.code]:(selected??[]).filter(code=>code!==permission.code))}/><strong>{t(permission.name_key,{nsSeparator:false,keySeparator:false,defaultValue:permission.code})}</strong></label>:<strong>{t(permission.name_key,{nsSeparator:false,keySeparator:false,defaultValue:permission.code})}</strong>}<code>{permission.code}</code></div>
        <p>{t(permission.description_key,{nsSeparator:false,keySeparator:false,defaultValue:permission.code})}</p><div className="permission-badges">{permission.is_reserved&&<span className="badge">{t('permissionReserved')}</span>}{permission.is_delegable&&<span className="badge">{t('permissionDelegable')}</span>}<span className="badge">{t(permission.is_self_assignable?'permissionSelfAssignable':'permissionNotSelfAssignable')}</span></div>
        {!!permission.dependencies.length&&<p className="hint">{t('permissionDependencies',{codes:permission.dependencies.join(', ')})}</p>}
      </div>;
    })}</section>;
  })}</div>;
}
