import { randomUUID } from 'node:crypto';
import { Server as HttpServer } from 'node:http';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie,setCookie,deleteCookie } from 'hono/cookie';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AppError } from '@honocraft/contracts/errors';
import type { AppConfig } from '../infrastructure/config.js';
import type { PasswordService } from '../infrastructure/passwords.js';
import type { Keyring } from '../infrastructure/crypto.js';
import {withTransaction} from '../infrastructure/db.js';
import {completeBootstrap} from '../modules/auth/bootstrap.js';
import {loadPublicSettings} from '../modules/settings/public.js';
import type { DigestKey } from '../infrastructure/idempotency.js';
import type { RequestMeta } from '../modules/audit/writer.js';
import { createLoginService } from '../modules/auth/login.js';
import { logoutMutation } from '../modules/auth/logout.js';
import { createMutationGateway } from '../modules/access/mutation-gateway.js';
import { profileMutation } from '../modules/users/profile.js';
import { getMe } from '../modules/users/me.js';
import { createClientIpResolver } from './security.js';

type HttpEnvironment={Variables:{requestId:string;meta:RequestMeta;startedAt:number}};
export type AppDependencies={pool:Pool;config:AppConfig;passwords:PasswordService;secrets:{epoch:string;csrfKey:Buffer;digestKey:DigestKey;mailKeyring:Keyring}};
export function createHttpApp({pool,config,passwords,secrets}:AppDependencies) {
  const app=new Hono<HttpEnvironment>();
  const resolveIp=createClientIpResolver(config.trustedProxyCidrs);
  const login=createLoginService(pool,{epoch:secrets.epoch,digestKey:secrets.digestKey.key},passwords);
  const mutate=createMutationGateway(pool,secrets,{'me.profile.update':profileMutation,'auth.logout':logoutMutation});
  const cookieOptions={path:'/',httpOnly:true,secure:config.secureCookies,sameSite:'Lax' as const};
  app.use('*',async(c,next)=>{
    c.set('requestId',randomUUID());c.set('startedAt',performance.now());
    c.header('X-Request-Id',c.get('requestId'));c.header('Cache-Control','no-store');c.header('Referrer-Policy','no-referrer');
    c.header('X-Content-Type-Options','nosniff');c.header('X-Frame-Options','DENY');
    c.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if(config.secureCookies)c.header('Strict-Transport-Security','max-age=31536000');
    const peer=getConnInfo(c).remote.address;
    if(!peer)throw new AppError('DEPENDENCY_UNAVAILABLE');
    c.set('meta',{requestId:c.get('requestId'),ip:resolveIp(peer,c.req.header('x-forwarded-for')),userAgent:(c.req.header('user-agent')??'').slice(0,512)});
    await next();
  });
  app.use('/api/*',async(c,next)=>{
    if(!['GET','HEAD','OPTIONS'].includes(c.req.method)){
      if(c.req.header('origin')!==config.origin)throw new AppError('ORIGIN_INVALID');
      if(c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase()!=='application/json'||
        !['identity',undefined].includes(c.req.header('content-encoding')))throw new AppError('UNSUPPORTED_MEDIA_TYPE');
    }
    await next();
  });
  app.use('/api/*',bodyLimit({maxSize:64*1024,onError:()=>{throw new AppError('PAYLOAD_TOO_LARGE');}}));
  app.use('/api/*',async(c,next)=>{
    if(!['/api/v1/public/settings','/api/v1/auth/bootstrap/complete'].includes(c.req.path)){
      const state=(await pool.query<{initialization_status:string}>('SELECT initialization_status FROM system_state WHERE id=1')).rows[0];
      if(state?.initialization_status!=='initialized')throw new AppError('SYSTEM_NOT_INITIALIZED');
    }
    await next();
  });
  app.onError((error,c)=>{
    const safe=error instanceof AppError?error:new AppError('INTERNAL_ERROR');
    if(safe.retryAfter)c.header('Retry-After',String(safe.retryAfter));
    if(safe.code==='SESSION_INVALID')deleteCookie(c,config.sessionCookieName,cookieOptions);
    return c.json({error:{code:safe.code,message:safe.code,field_errors:safe.fieldErrors},request_id:c.get('requestId')},safe.status);
  });
  app.notFound(c=>c.json({error:{code:'NOT_FOUND',message:'NOT_FOUND',field_errors:{}},request_id:c.get('requestId')},404));
  app.get('/health/live',c=>c.json({data:{status:'alive'},request_id:c.get('requestId')}));
  app.get('/health/ready',async c=>{
    try{await pool.query('SELECT 1 FROM system_state WHERE id=1');}
    catch{throw new AppError('DEPENDENCY_UNAVAILABLE');}
    return c.json({data:{status:'ready'},request_id:c.get('requestId')});
  });
  app.get('/api/v1/public/settings',async c=>{
    const data=await withTransaction(pool,'read',loadPublicSettings);
    return c.json({data,request_id:c.get('requestId')});
  });
  app.post('/api/v1/auth/bootstrap/complete',async c=>{
    const data=await completeBootstrap(pool,{epoch:secrets.epoch,digestKey:secrets.digestKey.key,mailKeyring:secrets.mailKeyring},passwords,
      await parseJson(()=>c.req.json()),c.get('meta'),config.httpTimeoutMs-(performance.now()-c.get('startedAt')));
    return c.json({data,request_id:c.get('requestId')});
  });
  app.post('/api/v1/auth/login',async c=>{
    const input=await parseJson(()=>c.req.json());
    const result=await login(input,c.get('meta'),config.httpTimeoutMs-(performance.now()-c.get('startedAt')));
    setCookie(c,config.sessionCookieName,result.token,cookieOptions);
    return c.json({data:{authenticated:true},request_id:c.get('requestId')});
  });
  app.get('/api/v1/me',async c=>{
    const data=await getMe(pool,{token:getCookie(c,config.sessionCookieName)??'',epoch:secrets.epoch},secrets.csrfKey);
    return c.json({data,request_id:c.get('requestId')});
  });
  app.patch('/api/v1/me',async c=>{
    const result=await mutate('me.profile.update',{token:getCookie(c,config.sessionCookieName)??'',csrfToken:c.req.header('x-csrf-token')??''},
      await parseJson(()=>c.req.json()),c.get('meta'),undefined,config.httpTimeoutMs-(performance.now()-c.get('startedAt')));
    return c.json({data:result.data,request_id:c.get('requestId')},result.status as ContentfulStatusCode);
  });
  app.post('/api/v1/auth/logout',async c=>{
    const input=await parseJson(()=>c.req.json());
    if(!z.strictObject({}).safeParse(input).success)throw new AppError('VALIDATION_ERROR');
    const token=getCookie(c,config.sessionCookieName);
    if(token){
      try {await mutate('auth.logout',{token,csrfToken:c.req.header('x-csrf-token')??''},input,c.get('meta'),undefined,config.httpTimeoutMs-(performance.now()-c.get('startedAt')));}
      catch(error){if(!(error instanceof AppError&&error.code==='SESSION_INVALID'))throw error;}
    }
    deleteCookie(c,config.sessionCookieName,cookieOptions);
    return c.json({data:{logged_out:true},request_id:c.get('requestId')});
  });
  return app;
}
async function parseJson(read:()=>Promise<unknown>) {
  try{return await read();}catch{throw new AppError('VALIDATION_ERROR');}
}
export function startHttpServer(dependencies:AppDependencies,port=dependencies.config.port) {
  const app=createHttpApp(dependencies);
  const server=serve({fetch:app.fetch,port,hostname:'127.0.0.1'});
  if(!(server instanceof HttpServer))throw new Error('HTTP_SERVER_TYPE_UNSUPPORTED');
  server.requestTimeout=dependencies.config.httpTimeoutMs;
  server.headersTimeout=Math.min(10_000,dependencies.config.httpTimeoutMs);
  return server;
}
