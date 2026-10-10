import {describe,expect,it} from 'vitest';
import {createClientIpResolver} from '../../apps/server/src/http/security.js';
describe('trusted reverse proxy boundary',()=>{
  it('ignores forwarded headers from an untrusted peer',()=>{
    const resolve=createClientIpResolver(['10.0.0.0/8']);
    expect(resolve('192.0.2.1','203.0.113.1')).toBe('192.0.2.1');
  });
  it('walks from the trusted peer to the first untrusted hop, ignoring spoofed left entries',()=>{
    const resolve=createClientIpResolver(['10.0.0.0/8','2001:db8:1::/48']);
    expect(resolve('10.1.1.1','198.51.100.99, 192.0.2.1, 10.1.1.2')).toBe('192.0.2.1');
    expect(resolve('2001:db8:1::1','2001:db8:2::2')).toBe('2001:db8:2::2');
  });
  it('rejects malformed forwarded chains from trusted peers',()=>{
    expect(()=>createClientIpResolver(['127.0.0.1/32'])('127.0.0.1','not-an-ip')).toThrow();
  });
});
