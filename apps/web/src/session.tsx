import {createContext,useContext,useEffect,useState,type ReactNode} from 'react';
import {useNavigate} from 'react-router';
import {useQueryClient} from '@tanstack/react-query';
import {discardSession,sessionEvents} from './api.js';
import type {MessageKey} from './i18n.js';
type SessionState={generation:number;notice:MessageKey|null;end:(notice?:MessageKey,broadcast?:boolean)=>void;begin:()=>void;announce:(notice:MessageKey)=>void};
const Context=createContext<SessionState|null>(null);
export function SessionProvider({children}:{children:ReactNode}){
  const query=useQueryClient(),navigate=useNavigate();const [generation,setGeneration]=useState(0),[notice,setNotice]=useState<MessageKey|null>(null);
  const [channel]=useState(()=>typeof BroadcastChannel==='undefined'?null:new BroadcastChannel('honocraft-session'));
  function clear(){discardSession();void query.cancelQueries();query.clear();setGeneration(value=>value+1);}
  function end(message:MessageKey='sessionEnded',broadcast=true){clear();setNotice(message);navigate('/login',{replace:true});if(broadcast)channel?.postMessage('session-invalidated');}
  function begin(){clear();setNotice(null);channel?.postMessage('session-invalidated');navigate('/',{replace:true});}
  useEffect(()=>{const invalidate=()=>end();const receive=(event:MessageEvent)=>{if(event.data==='session-invalidated')end('sessionEnded',false);};
    sessionEvents.addEventListener('invalid',invalidate);channel?.addEventListener('message',receive);
    return()=>{sessionEvents.removeEventListener('invalid',invalidate);channel?.removeEventListener('message',receive);};
  });
  useEffect(()=>()=>channel?.close(),[channel]);
  return <Context.Provider value={{generation,notice,end,begin,announce:setNotice}}>{children}</Context.Provider>;
}
export function useSession(){const context=useContext(Context);if(!context)throw new Error('SESSION_CONTEXT_MISSING');return context;}
