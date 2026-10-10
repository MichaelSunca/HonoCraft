import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '@honocraft/contracts/errors';
export type Keyring = { activeKeyId: string; keys: ReadonlyMap<string, Buffer> };
export type Ciphertext = { keyId: string; nonce: Buffer; tag: Buffer; ciphertext: Buffer };

export function issueToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: tokenDigest(token) };
}
export function tokenDigest(token: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError('CREDENTIAL_INVALID');
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== token) throw new AppError('CREDENTIAL_INVALID');
  return createHash('sha256').update(bytes).digest();
}
function assertKey(key: Buffer | undefined): asserts key is Buffer {
  if (!key || key.length !== 32) throw new Error('INVALID_CRYPTO_KEY');
}
export function encryptPayload(ring: Keyring, plaintext: string, aad: string): Ciphertext {
  const key = ring.keys.get(ring.activeKeyId);
  assertKey(key);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { keyId: ring.activeKeyId, nonce, tag: cipher.getAuthTag(), ciphertext };
}
export function decryptPayload(ring: Keyring, value: Ciphertext, aad: string): string {
  try {
    const key = ring.keys.get(value.keyId);
    assertKey(key);
    if (value.nonce.length !== 12 || value.tag.length !== 16) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, value.nonce);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(value.tag);
    return Buffer.concat([decipher.update(value.ciphertext), decipher.final()]).toString('utf8');
  } catch { throw new Error('MAIL_PAYLOAD_INVALID'); }
}
export function keyedDigest(key: Buffer, purpose: string, value: string): Buffer {
  assertKey(key);
  return createHmac('sha256', key).update(JSON.stringify([purpose, value])).digest();
}
export function csrfForSession(key: Buffer, sessionId: string, epoch: string): string {
  return keyedDigest(key, 'honocraft.csrf.v1', JSON.stringify([sessionId, epoch])).toString('base64url');
}
export function verifyCsrf(key: Buffer, sessionId: string, epoch: string, candidate: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(candidate)) return false;
  const expected = Buffer.from(csrfForSession(key, sessionId, epoch), 'ascii');
  return timingSafeEqual(expected, Buffer.from(candidate, 'ascii'));
}
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null && [null, Object.prototype].includes(Object.getPrototypeOf(value))) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  throw new Error('REQUEST_DIGEST_INPUT_INVALID');
}
/** Callers normalize email and sort set-valued fields before hashing a validated DTO. */
export function requestDigest(key: Buffer, operation: string, value: unknown): Buffer {
  return keyedDigest(key, 'honocraft.operation.v1', canonical({ operation, value }));
}
