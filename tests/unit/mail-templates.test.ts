import {describe,expect,it} from 'vitest';
import {renderMail} from '../../apps/server/src/modules/mail/templates.js';
const base={purpose:'bootstrap' as const,recipient:'user@example.test',displayName:'<img src=x onerror=alert(1)>',instanceName:'HonoCraft',locale:'zh-CN' as const,timeZone:'Asia/Tokyo',token:'A'.repeat(43),expiresAt:'2026-10-10T01:00:00.000Z'};
describe('mail template boundaries',()=>{
  it('places credentials only in a trusted-origin fragment and escapes display content',()=>{
    const result=renderMail('https://app.example.test',base);
    expect(result.text).toContain('https://app.example.test/bootstrap#token='+base.token);
    expect(result.html).not.toContain('<img');expect(result.html).toContain('&lt;img');expect(result.subject).toContain('初始化');
  });
  it('provides an English template and a credential-free security notification',()=>{
    const result=renderMail('https://app.example.test',{purpose:'password_changed',recipient:'user@example.test',displayName:'Name',instanceName:'HonoCraft',locale:'en',timeZone:'UTC',occurredAt:'2026-10-10T01:00:00.000Z'});
    expect(result.subject).toContain('Password changed');expect(result.text).toContain('https://app.example.test/security');expect(result.text).not.toContain('#token');
  });
  it('rejects unknown payload fields and untrusted base URLs',()=>{
    expect(()=>renderMail('https://app.example.test',{...base,redirect:'https://evil.test'})).toThrow();
    expect(()=>renderMail('https://app.example.test/redirect',base)).toThrow();
  });
});
