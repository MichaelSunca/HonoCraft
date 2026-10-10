import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { startTestPostgres } from '../helpers/postgres.js';
import { migrate } from '../../apps/server/src/infrastructure/migrations.js';
import { withTransaction } from '../../apps/server/src/infrastructure/db.js';
import { consumeLimits,accountFailureState } from '../../apps/server/src/infrastructure/rate-limit.js';
let database:Awaited<ReturnType<typeof startTestPostgres>>;
const key=Buffer.alloc(32,9);
beforeAll(async()=>{database=await startTestPostgres();await migrate(database.pool);});
afterAll(async()=>{await database?.close();});
const rule=(identifier:string)=>({scope:'mail.target',identifier,limit:5,windowMs:3_600_000,bucketMs:60_000});
const consume=(identifier:string)=>withTransaction(database.pool,'independent',tx=>consumeLimits(tx,key,[rule(identifier)]));

describe('PostgreSQL shared rate limits',()=>{
  it('serializes separate connections so concurrent attempts cannot overspend one quota',async()=>{
    const email=`${randomUUID()}@example.test`;
    const results=await Promise.all(Array.from({length:12},()=>consume(email)));
    expect(results.filter(result=>result.allowed)).toHaveLength(5);
    expect(results.filter(result=>!result.allowed)).toHaveLength(7);
    const raw=JSON.stringify((await database.pool.query('SELECT * FROM rate_limit_buckets')).rows);
    expect(raw).not.toContain(email);
  });
  it('rolls back a mail quota debit when the surrounding business operation fails',async()=>{
    const email=`${randomUUID()}@example.test`;
    await expect(withTransaction(database.pool,'shared',async tx=>{
      expect((await consumeLimits(tx,key,[{...rule(email),limit:1}])).allowed).toBe(true);
      throw new Error('business rejected');
    })).rejects.toThrow('business rejected');
    expect((await withTransaction(database.pool,'independent',tx=>consumeLimits(tx,key,[{...rule(email),limit:1}]))).allowed).toBe(true);
  });
  it('checks all scopes before debiting any accepted-mail quota',async()=>{
    const email=`${randomUUID()}@example.test`;const ip=randomUUID();
    const source={...rule(ip),scope:'mail.ip',limit:1};
    await withTransaction(database.pool,'independent',tx=>consumeLimits(tx,key,[source]));
    const rejected=await withTransaction(database.pool,'independent',tx=>consumeLimits(tx,key,[{...rule(email),limit:1},source]));
    expect(rejected).toMatchObject({allowed:false,scope:'mail.ip'});
    expect((await withTransaction(database.pool,'independent',tx=>consumeLimits(tx,key,[{...rule(email),limit:1}]))).allowed).toBe(true);
  });
  it('enforces cooldown independently of the hourly allowance',async()=>{
    const scope=`cooldown.${randomUUID()}`;const limited={...rule('address'),scope,cooldownMs:60_000};
    const take=()=>withTransaction(database.pool,'independent',tx=>consumeLimits(tx,key,[limited]));
    expect((await take()).allowed).toBe(true);
    expect(await take()).toMatchObject({allowed:false,retryAfter:60,scope});
    await database.pool.query("UPDATE rate_limit_buckets SET last_accepted_at=clock_timestamp()-interval '61 seconds' WHERE scope=$1",[scope]);
    expect((await take()).allowed).toBe(true);
  });
  it('does not invent a cooldown for a source quota after a wall-clock correction',async()=>{
    const scope=`source.${randomUUID()}`;const limited={...rule('source'),scope,limit:2};
    const take=()=>withTransaction(database.pool,'independent',tx=>consumeLimits(tx,key,[limited]));
    expect((await take()).allowed).toBe(true);
    await database.pool.query("UPDATE rate_limit_buckets SET last_accepted_at=clock_timestamp()+interval '5 seconds' WHERE scope=$1",[scope]);
    expect((await take()).allowed).toBe(true);
    expect((await take()).allowed).toBe(false);
  });
  it('counts the boundary bucket conservatively instead of resetting at the hour',async()=>{
    const scope=`rolling.${randomUUID()}`;const limited={...rule('address'),scope,limit:1};
    const take=()=>withTransaction(database.pool,'independent',tx=>consumeLimits(tx,key,[limited]));
    await take();
    await database.pool.query("UPDATE rate_limit_buckets SET window_start=date_trunc('minute',clock_timestamp())-interval '60 minutes' WHERE scope=$1 AND window_start<>'1970-01-01T00:00:00Z'::timestamptz",[scope]);
    expect((await take()).allowed).toBe(false);
    await database.pool.query("UPDATE rate_limit_buckets SET window_start=window_start-interval '1 minute' WHERE scope=$1 AND window_start<>'1970-01-01T00:00:00Z'::timestamptz",[scope]);
    expect((await take()).allowed).toBe(true);
  });
  it('locks an account on its fifth failure without extending an existing lock',async()=>{
    const email=`${randomUUID()}@example.test`;
    const failure=()=>withTransaction(database.pool,'independent',tx=>accountFailureState(tx,key,email,'failure'));
    for(let i=0;i<4;i++)expect((await failure()).lockedUntil).toBeNull();
    const fifth=await failure();expect(fifth.lockedUntil).toBeInstanceOf(Date);
    const repeated=await failure();expect(repeated.lockedUntil).toEqual(fifth.lockedUntil);expect(repeated.failures).toBe(5);
  });
  it('starts a new window after a lock expires and clears counters only on a full successful authentication',async()=>{
    const email=`${randomUUID()}@example.test`;
    const change=(event:'failure'|'success'|'inspect')=>withTransaction(database.pool,'independent',tx=>accountFailureState(tx,key,email,event));
    for(let i=0;i<5;i++)await change('failure');
    await database.pool.query("UPDATE rate_limit_buckets SET locked_until=clock_timestamp()-interval '1 second' WHERE scope='login.account' AND locked_until IS NOT NULL");
    expect(await change('failure')).toMatchObject({lockedUntil:null,failures:1});
    expect(await change('success')).toMatchObject({lockedUntil:null,failures:0});
    expect(await change('inspect')).toMatchObject({lockedUntil:null,failures:0});
  });
});
