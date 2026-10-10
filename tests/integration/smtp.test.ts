import { randomUUID } from 'node:crypto';
import { describe,expect,it } from 'vitest';
import {startSmtpFixture} from '../helpers/smtp.js';
import {createSmtpTransport} from '../../apps/server/src/modules/mail/smtp.js';
const message=()=>({to:'recipient@example.test',subject:'Test',text:'Hello',html:'<p>Hello</p>',messageId:`<${randomUUID()}@honocraft.invalid>`});
const config=(port:number)=>({mode:'capture' as const,host:'127.0.0.1',port,secure:false,from:'HonoCraft <noreply@example.test>',user:undefined,password:undefined});
describe('SMTP transport with a total attempt deadline',()=>{
  it('returns accepted only after SMTP acknowledgement',async()=>{
    const smtp=await startSmtpFixture();
    try{const input=message();expect(await createSmtpTransport(config(smtp.port)).send(input)).toEqual({kind:'sent',messageId:input.messageId});expect(smtp.messages).toHaveLength(1);expect(smtp.messages[0]).toContain('Hello');}
    finally{await smtp.close();}
  });
  it.each([['reject','failed','SMTP_REJECTED'],['temporary','retry','SMTP_TEMPORARY']] as const)('classifies %s without exposing provider responses',async(mode,kind,code)=>{
    const smtp=await startSmtpFixture(mode);
    try{expect(await createSmtpTransport(config(smtp.port)).send(message())).toEqual({kind,code});expect(smtp.messages).toHaveLength(0);}
    finally{await smtp.close();}
  });
  it.each(['silent','unknown'] as const)('destroys the underlying connection at the deadline for %s delivery',async mode=>{
    const smtp=await startSmtpFixture(mode);
    try{
      expect(await createSmtpTransport(config(smtp.port),200).send(message())).toEqual({kind:'retry',code:'SMTP_TIMEOUT'});
      expect(await smtp.waitForDisconnect()).toBe(true);
      if(mode==='unknown')expect(smtp.messages).toHaveLength(1);
    }finally{await smtp.close();}
  });
  it('refuses plaintext SMTP in provider mode when STARTTLS is unavailable',async()=>{
    const smtp=await startSmtpFixture();
    try{const result=await createSmtpTransport({...config(smtp.port),mode:'smtp'}).send(message());expect(result.kind).not.toBe('sent');expect(smtp.messages).toHaveLength(0);}
    finally{await smtp.close();}
  });
});
