import { createConnection,type Socket } from 'node:net';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import { z } from 'zod';
import { EmailSchema } from '@honocraft/contracts/common';
import type { AppConfig } from '../../infrastructure/config.js';
import type { DeliveryOutcome } from './outbox.js';
const messageSchema=z.strictObject({
  to:EmailSchema,subject:z.string().max(250).refine(value=>!/[\r\n]/.test(value)),text:z.string().max(20_000),html:z.string().max(30_000),
  messageId:z.string().regex(/^<[0-9a-f-]{36}@honocraft\.invalid>$/),
});
export type MailMessage=z.infer<typeof messageSchema>;
export type MailTransport=Readonly<{send:(message:MailMessage)=>Promise<DeliveryOutcome>}>;
/** Each attempt owns its TCP connection so the total deadline can stop DNS/connect/TLS/SMTP work. */
export function createSmtpTransport(config:AppConfig['smtp'],deadlineMs=20_000):MailTransport {
  if(!Number.isInteger(deadlineMs)||deadlineMs<1||deadlineMs>20_000)throw new Error('SMTP_DEADLINE_INVALID');
  return {async send(raw){
    const message=messageSchema.parse(raw);
    return new Promise<DeliveryOutcome>(resolve=>{
      let socket:Socket|undefined;let completed=false;
      const transport=nodemailer.createTransport({
        host:config.host,port:config.port,secure:config.secure,requireTLS:config.mode==='smtp'&&!config.secure,
        ignoreTLS:config.mode==='capture'&&!config.secure,tls:{rejectUnauthorized:true},
        ...(config.user&&config.password?{auth:{user:config.user,pass:config.password}}:{}),
        logger:false,debug:false,disableFileAccess:true,disableUrlAccess:true,
        connectionTimeout:deadlineMs,greetingTimeout:deadlineMs,socketTimeout:deadlineMs,
        getSocket(_options,callback){
          if(completed){callback(new Error('SMTP_ATTEMPT_CLOSED'),false);return;}
          socket=createConnection({host:config.host,port:config.port});
          let handedOff=false;
          socket.once('error',error=>{if(!handedOff){handedOff=true;callback(error,false);}});
          socket.once('connect',()=>{
            if(completed){socket?.destroy();if(!handedOff){handedOff=true;callback(new Error('SMTP_ATTEMPT_CLOSED'),false);}return;}
            if(!handedOff){handedOff=true;callback(null,{connection:socket});}
          });
        },
      } satisfies SMTPTransport.Options);
      const finish=(outcome:DeliveryOutcome)=>{
        if(completed)return;
        completed=true;clearTimeout(timer);
        // Nodemailer's ordinary close() alone does not interrupt an in-flight SMTP attempt.
        socket?.destroy();transport.close();resolve(outcome);
      };
      const timer=setTimeout(()=>finish({kind:'retry',code:'SMTP_TIMEOUT'}),deadlineMs);
      transport.sendMail({from:config.from,to:message.to,subject:message.subject,text:message.text,html:message.html,messageId:message.messageId},(error,info)=>{
        if(error){
          const failure=error as Error&{responseCode?:number;code?:string};
          if(failure.responseCode&&failure.responseCode>=500||failure.code==='EAUTH')finish({kind:'failed',code:'SMTP_REJECTED'});
          else if(failure.responseCode&&failure.responseCode>=400)finish({kind:'retry',code:'SMTP_TEMPORARY'});
          else finish({kind:'retry',code:failure.code==='ETIMEDOUT'?'SMTP_TIMEOUT':'SMTP_CONNECTION'});
        }else if(info.accepted.length===1&&info.rejected.length===0)finish({kind:'sent',messageId:message.messageId});
        else finish({kind:'failed',code:'SMTP_REJECTED'});
      });
    });
  }};
}
