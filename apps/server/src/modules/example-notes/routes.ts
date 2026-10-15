import {Hono,type Context} from 'hono';
import {getCookie} from 'hono/cookie';
import type {ContentfulStatusCode} from 'hono/utils/http-status';
import {AppError} from '@honocraft/contracts/errors';
import type {RequestMeta} from '../audit/writer.js';
import type {createNotesService} from './service.js';
export const exampleNotesModule=Object.freeze({key:'example-notes',permissionModule:'example-note',apiBase:'/api/v1/example-notes',ownerScoped:true});
type Environment={Variables:{requestId:string;meta:RequestMeta;startedAt:number}};
export function createNotesRoutes(service:ReturnType<typeof createNotesService>,config:{sessionCookieName:string;httpTimeoutMs:number}){
  const app=new Hono<Environment>();
  const actor=(c:Context<Environment>)=>({token:getCookie(c,config.sessionCookieName)??'',csrfToken:c.req.header('x-csrf-token')??''});
  app.get('/',async c=>c.json({data:await service.list(actor(c),c.req.query()),request_id:c.get('requestId')}));
  app.get('/:id',async c=>c.json({data:await service.get(actor(c),c.req.param('id')),request_id:c.get('requestId')}));
  for(const [method,path,operation] of [['POST','/','create'],['PATCH','/:id','update'],['DELETE','/:id','delete']] as const)app.on(method,path,async c=>{
    let body:unknown;try{body=await c.req.json();}catch{throw new AppError('VALIDATION_ERROR');}
    const result=await service.write(operation,actor(c),c.req.param('id'),body,c.get('meta'),c.req.header('idempotency-key'),config.httpTimeoutMs-(performance.now()-c.get('startedAt')));
    return c.json({data:result.data,replayed:result.replayed,request_id:c.get('requestId')},result.status as ContentfulStatusCode);
  });
  return app;
}
