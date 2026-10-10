import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueToken, tokenDigest, encryptPayload, decryptPayload, csrfForSession, verifyCsrf, requestDigest, type Keyring } from '../../apps/server/src/infrastructure/crypto.js';
const key=randomBytes(32);
const ring: Keyring={activeKeyId:'v1',keys:new Map([['v1',key]])};
describe('authentication and outbox cryptography', () => {
  it('issues independent 256-bit tokens and stores only their digest', () => {
    const a=issueToken(),b=issueToken();
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toHaveLength(32);
    expect(tokenDigest(a.token)).toEqual(a.hash);
    expect(a.hash.toString('hex')).not.toContain(a.token);
  });
  it('rejects token input aliases and malformed lengths', () => {
    expect(() => tokenDigest('not-a-token')).toThrow('CREDENTIAL_INVALID');
    const token=issueToken().token;
    expect(() => tokenDigest(token+'=')).toThrow('CREDENTIAL_INVALID');
  });
  it('authenticates ciphertext and binds it to the exact task and purpose', () => {
    const value=encryptPayload(ring,'sensitive link #token=secret','task-id:password_reset:1');
    expect(value.ciphertext.toString('utf8')).not.toContain('secret');
    expect(decryptPayload(ring,value,'task-id:password_reset:1')).toBe('sensitive link #token=secret');
    expect(() => decryptPayload(ring,value,'other-task:password_reset:1')).toThrow();
    const altered=Buffer.from(value.ciphertext); altered[0]=(altered[0] ?? 0)^1;
    expect(() => decryptPayload(ring,{...value,ciphertext:altered},'task-id:password_reset:1')).toThrow();
  });
  it('keeps old keys decryptable during rotation and rejects a missing key', () => {
    const value=encryptPayload(ring,'old job','task');
    const rotated: Keyring={activeKeyId:'v2',keys:new Map([['v1',key],['v2',randomBytes(32)]])};
    expect(decryptPayload(rotated,value,'task')).toBe('old job');
    expect(() => decryptPayload({activeKeyId:'v2',keys:new Map([['v2',randomBytes(32)]])},value,'task')).toThrow();
  });
  it('binds csrf to both session and credential epoch', () => {
    const token=csrfForSession(key,'session-a','epoch-1');
    expect(verifyCsrf(key,'session-a','epoch-1',token)).toBe(true);
    expect(verifyCsrf(key,'session-b','epoch-1',token)).toBe(false);
    expect(verifyCsrf(key,'session-a','epoch-2',token)).toBe(false);
    expect(verifyCsrf(key,'session-a','epoch-1','short')).toBe(false);
  });
  it('canonicalizes object order but distinguishes changed content and operations', () => {
    const a=requestDigest(key,'user.update',{id:'a',expected_version:1,name:'Alice'});
    expect(requestDigest(key,'user.update',{name:'Alice',expected_version:1,id:'a'})).toEqual(a);
    expect(requestDigest(key,'user.update',{id:'a',expected_version:1,name:'Bob'})).not.toEqual(a);
    expect(requestDigest(key,'user.delete',{id:'a',expected_version:1,name:'Alice'})).not.toEqual(a);
    expect(requestDigest(key,'order',[1,2])).not.toEqual(requestDigest(key,'order',[2,1]));
  });
});
