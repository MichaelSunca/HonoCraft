import {useEffect,useState} from 'react';
import type {PublicSettings} from '@honocraft/contracts/http';
type Branding=Pick<PublicSettings,'instance_name'|'logo_url'|'favicon_url'>;
const fallbackIcon='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1d6550"/><text x="32" y="46" text-anchor="middle" font-family="sans-serif" font-size="44" fill="white">H</text></svg>');
export function useBranding(instance:Branding|undefined){useEffect(()=>{
  if(!instance)return;document.title=instance.instance_name;document.querySelectorAll('link[data-honocraft-icon]').forEach(element=>element.remove());
  for(const size of instance.favicon_url?[32,64]:[0]){const link=document.createElement('link');link.rel='icon';link.dataset.honocraftIcon='';link.type=size?'image/png':'image/svg+xml';link.sizes.value=size?size+'x'+size:'any';link.href=size?instance.favicon_url+'?size='+size:fallbackIcon;document.head.append(link);}
},[instance?.instance_name,instance?.favicon_url]);}
export function BrandMark({instance}:{instance:Branding|undefined}){const [failed,setFailed]=useState<string|null>(null);return instance?.logo_url&&failed!==instance.logo_url?<img className="brand-logo" src={instance.logo_url} alt="" onError={()=>setFailed(instance.logo_url)}/>:<span className="brand-mark" aria-hidden="true">H</span>;}
