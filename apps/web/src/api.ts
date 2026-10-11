import {z} from 'zod';
import type {MessageKey} from './i18n.js';
export class ApiError extends Error{
  constructor(readonly code:string,readonly status=0,readonly retryAfter=60){super(code);}
}
let generation=0;
export function discardSession(){generation++;}
export const sessionEvents=new EventTarget();
export async function api<T>(path:string,schema:z.ZodType<T>,options:{body?:unknown;method?:string;csrf?:string;idempotencyKey?:string;protected?:boolean;signal?:AbortSignal}={}):Promise<T>{
  const started=generation;
  let response:Response;
  try{
    response=await fetch('/api/v1'+path,{method:options.method??(options.body===undefined?'GET':'POST'),credentials:'same-origin',cache:'no-store',
      headers:{...(options.body===undefined?{}:{'Content-Type':'application/json'}),...(options.csrf?{'X-CSRF-Token':options.csrf}:{}),...(options.idempotencyKey?{'Idempotency-Key':options.idempotencyKey}:{})},
      ...(options.body===undefined?{}:{body:JSON.stringify(options.body)}),...(options.signal?{signal:options.signal}:{})});
  }catch(error){if(error instanceof DOMException&&error.name==='AbortError')throw error;throw new ApiError('NETWORK');}
  if(options.protected&&started!==generation)throw new DOMException('Session changed','AbortError');
  let payload:unknown;try{payload=await response.json();}catch{if(response.status===401&&options.protected)sessionEvents.dispatchEvent(new Event('invalid'));throw new ApiError('INTERNAL_ERROR',response.status);}
  if(options.protected&&started!==generation)throw new DOMException('Session changed','AbortError');
  if(!response.ok){const error=z.object({error:z.object({code:z.string()})}).safeParse(payload);if(response.status===401&&options.protected&&(!error.success||error.data.error.code!=='AUTH_FAILED'))sessionEvents.dispatchEvent(new Event('invalid'));const seconds=Number(response.headers.get('Retry-After'));throw new ApiError(error.success?error.data.error.code:'INTERNAL_ERROR',response.status,Number.isFinite(seconds)&&seconds>0?Math.ceil(seconds):60);}
  if(options.protected&&started!==generation)throw new DOMException('Session changed','AbortError');
  const result=z.object({data:schema}).safeParse(payload);if(!result.success)throw new ApiError('INTERNAL_ERROR');return result.data.data;
}
const errors:Record<string,MessageKey>={AUTH_FAILED:'authFailed',SESSION_INVALID:'sessionEnded',CREDENTIAL_INVALID:'credentialInvalid',RATE_LIMITED:'rateLimited',PASSWORD_REJECTED:'passwordRejected',
  INVITE_REISSUE_REQUIRED:'invitationReissue',EMAIL_CONFLICT:'emailConflict',
  EMAIL_VERIFICATION_REQUIRED:'pending',REGISTRATION_DISABLED:'registrationClosed',SYSTEM_NOT_INITIALIZED:'uninitialized',BOOTSTRAP_CLOSED:'bootstrapClosed',VERSION_CONFLICT:'conflict',
  VALIDATION_ERROR:'invalid',FORBIDDEN:'forbidden',ORIGIN_INVALID:'forbidden',CSRF_INVALID:'csrfInvalid',AUTH_BUSY:'busy',BUSY_RETRY:'busy',DEPENDENCY_UNAVAILABLE:'unavailableIntro',NETWORK:'network'};
export function errorMessage(error:unknown):MessageKey{return error instanceof ApiError?errors[error.code]??'internal':'network';}
export const accepted=z.object({accepted:z.literal(true)});
