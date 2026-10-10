import { beforeAll,describe,expect,it } from 'vitest';
import { BoundedExecutor,createPasswordService } from '../../apps/server/src/infrastructure/passwords.js';
function barrier(){let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return {promise,release};}
describe('bounded password work',()=>{
  it('runs at most two jobs and rejects excess waiting work',async()=>{
    const executor=new BoundedExecutor({concurrency:2,queueLimit:1,queueTimeoutMs:2000});
    const gate=barrier();let running=0;let maximum=0;let started=0;
    const job=async()=>{running++;started++;maximum=Math.max(maximum,running);await gate.promise;running--;return 'done';};
    const first=executor.run(job);const second=executor.run(job);const third=executor.run(job);
    const overflow=executor.run(job).then(value=>({value}),error=>({error}));
    const initiallyStarted=started;
    gate.release();
    await Promise.all([first,second,third]);
    expect(initiallyStarted).toBe(2);expect(await overflow).toMatchObject({error:{code:'AUTH_BUSY'}});expect(maximum).toBe(2);
  });
  it('drops timed-out waiting work instead of running it later',async()=>{
    const executor=new BoundedExecutor({concurrency:1,queueLimit:1,queueTimeoutMs:20});
    const gate=barrier();const active=executor.run(()=>gate.promise);let unwanted=false;
    const queued=executor.run(async()=>{unwanted=true;}).catch(error=>error);
    expect(await queued).toMatchObject({code:'AUTH_BUSY'});gate.release();await active;
    expect(unwanted).toBe(false);expect(await executor.run(async()=>42)).toBe(42);
  });
});
let passwords:Awaited<ReturnType<typeof createPasswordService>>;
beforeAll(async()=>{passwords=await createPasswordService({concurrency:2,blockedPasswords:new Set(['this is a leaked password'])});});
describe('password hashing and verification',()=>{
  it('uses independently salted Argon2id hashes and preserves the exact password',async()=>{
    const value='  Correct horse 电池 staple  ';
    const a=await passwords.hash(value);const b=await passwords.hash(value);
    expect(a).not.toBe(b);expect(a).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(await passwords.verify(a,value)).toBe(true);expect(await passwords.verify(a,value.trim())).toBe(false);
  });
  it('rejects short or blocked passwords before hashing',async()=>{
    await expect(passwords.hash('short')).rejects.toMatchObject({code:'PASSWORD_REJECTED'});
    await expect(passwords.hash('this is a leaked password')).rejects.toMatchObject({code:'PASSWORD_REJECTED'});
  });
  it('spends a bounded hash slot on unknown accounts instead of returning before doing password work',async()=>{
    const limited=await createPasswordService({concurrency:1,queueLimit:0,blockedPasswords:new Set<string>()});
    const unknown=limited.verify(null,'a valid length password');
    try { await expect(limited.hash('another valid password')).rejects.toMatchObject({code:'AUTH_BUSY'}); }
    finally { expect(await unknown).toBe(false); }
  });
});
