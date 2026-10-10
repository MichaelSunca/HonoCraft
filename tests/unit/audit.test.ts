import { describe,expect,it } from 'vitest';
import { sanitizeAuditText } from '../../apps/server/src/modules/audit/writer.js';
describe('audit free text minimization',()=>{
  it('removes header controls and redacts email addresses and labelled credentials',()=>{
    const text=sanitizeAuditText('password=secret123\nContact user@example.test\u0000');
    expect(text).not.toContain('secret123'); expect(text).not.toContain('user@example.test'); expect(text).not.toContain('\n'); expect(text).not.toContain(String.fromCharCode(0));
  });
  it('redacts raw token-shaped strings even without a label',()=>{
    expect(sanitizeAuditText('please check '+ 'A'.repeat(43))).not.toContain('A'.repeat(43));
  });
});
