import { z } from 'zod';
import { EmailSchema,LocaleSchema,TokenSchema,text } from '@honocraft/contracts/common';
export const credentialPurposes=['email_verify','password_reset','invite_accept','email_change','bootstrap','operator_recovery'] as const;
export const notificationPurposes=['password_changed','email_change_started','email_changed','account_suspended'] as const;
const common={recipient:EmailSchema,displayName:text(0,80),instanceName:text(1,80),locale:LocaleSchema,
  timeZone:z.string().max(80).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}})};
export const mailPayloadSchema=z.discriminatedUnion('purpose',[
  z.strictObject({...common,purpose:z.enum(credentialPurposes),token:TokenSchema,expiresAt:z.iso.datetime()}),
  z.strictObject({...common,purpose:z.enum(notificationPurposes),occurredAt:z.iso.datetime()}),
]);
export type MailPayload=z.infer<typeof mailPayloadSchema>;
const pages:Record<typeof credentialPurposes[number],string>={email_verify:'/verify-email',password_reset:'/reset-password',invite_accept:'/accept-invite',email_change:'/change-email',bootstrap:'/bootstrap',operator_recovery:'/operator-recovery'};
const titles:Record<MailPayload['purpose'],{en:string;'zh-CN':string}>={
  email_verify:{en:'Verify your email','zh-CN':'验证邮箱'},password_reset:{en:'Reset your password','zh-CN':'重置密码'},invite_accept:{en:'Accept your invitation','zh-CN':'接受邀请'},
  email_change:{en:'Confirm your new email','zh-CN':'确认新邮箱'},bootstrap:{en:'Initialize your instance','zh-CN':'初始化实例'},operator_recovery:{en:'Recover administrator access','zh-CN':'恢复管理员访问'},
  password_changed:{en:'Password changed','zh-CN':'密码已修改'},email_change_started:{en:'Email change requested','zh-CN':'已发起邮箱变更'},email_changed:{en:'Email changed','zh-CN':'邮箱已变更'},account_suspended:{en:'Account suspended','zh-CN':'账号已停用'},
};
const escape=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
export function renderMail(origin:string,input:unknown):{subject:string;text:string;html:string} {
  const base=new URL(origin);
  if(!['https:','http:'].includes(base.protocol)||base.origin!==origin||base.username||base.password)throw new Error('MAIL_ORIGIN_INVALID');
  const payload=mailPayloadSchema.parse(input);const credential='token' in payload;
  const title=titles[payload.purpose][payload.locale];
  const url=new URL(credential?pages[payload.purpose]:'/security',base);
  if(credential)url.hash=`token=${payload.token}`;
  const instant=credential?payload.expiresAt:payload.occurredAt;
  const time=new Intl.DateTimeFormat(payload.locale,{dateStyle:'medium',timeStyle:'long',timeZone:payload.timeZone}).format(new Date(instant));
  const label=payload.locale==='en'?(credential?'This link expires at':'Event time'):(credential?'链接有效期至':'发生时间');
  const action=payload.locale==='en'?(credential?'Continue':'Review account security'):(credential?'继续操作':'查看账号安全');
  const warning=payload.locale==='en'?'If you did not request this action, contact your administrator.':'如果这不是您发起的操作，请联系管理员。';
  return {subject:`${payload.instanceName.replace(/[\p{Cc}\p{Cf}]/gu,' ')} — ${title}`,
    text:`${payload.instanceName}\n${payload.displayName}\n${title}\n${label}: ${time}\n${action}: ${url.href}\n${warning}`,
    html:`<!doctype html><html lang="${payload.locale}"><body><h1>${escape(title)}</h1><p>${escape(payload.instanceName)}</p><p>${escape(payload.displayName)}</p><p>${escape(label)}: ${escape(time)}</p><p><a href="${escape(url.href)}">${escape(action)}</a></p><p>${escape(warning)}</p></body></html>`};
}
