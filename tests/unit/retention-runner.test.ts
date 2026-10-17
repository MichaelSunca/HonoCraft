import type {Pool} from 'pg';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({prune:vi.fn(),delay:vi.fn()}));
vi.mock('../../apps/server/src/modules/maintenance/retention.js',()=>({pruneBatch:mocks.prune}));
vi.mock('node:timers/promises',()=>({setTimeout:mocks.delay}));
import {pruneRetainedRecords,runRetentionWorker,type RetentionEvent} from '../../apps/server/src/modules/maintenance/retention-runner.js';
const pool={} as Pool,hour=3_600_000,day=24*hour;
let controller:AbortController,events:RetentionEvent[],stamp:number;
beforeEach(()=>{
  controller=new AbortController();events=[];stamp=0;vi.spyOn(performance,'now').mockImplementation(()=>stamp);mocks.prune.mockReset().mockResolvedValue(0);mocks.delay.mockReset();
});
afterEach(()=>{controller.abort();vi.restoreAllMocks();});
it('drains full batches in dependency order, releasing each batch through pruneBatch',async()=>{
  mocks.prune.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
  expect(await pruneRetainedRecords(pool,'runtime',{batchSize:2},controller.signal)).toEqual({mail:3,task_links:0,credentials:0,sessions:0,idempotency:0,rate_limits:0,heartbeats:0});
  expect(mocks.prune.mock.calls.map(call=>call[1])).toEqual(['mail','mail','task_links','credentials','sessions','idempotency','rate_limits','heartbeats']);
});
it('finishes the in-flight batch and starts no new batch after an abort',async()=>{
  mocks.prune.mockImplementationOnce(async()=>{controller.abort();return 1000;});expect(await pruneRetainedRecords(pool,'runtime',{},controller.signal)).toEqual({mail:1000});expect(mocks.prune).toHaveBeenCalledTimes(1);
});
it('does no work on an already aborted signal and keeps log tasks separate',async()=>{
  controller.abort();expect(await pruneRetainedRecords(pool,'runtime',{},controller.signal)).toEqual({});expect(mocks.prune).not.toHaveBeenCalled();
  expect(await pruneRetainedRecords(pool,'logs',{auditDays:12,securityDays:5})).toEqual({audit:0,security:0});expect(mocks.prune.mock.calls.map(call=>call[1])).toEqual(['audit','security']);expect(mocks.prune.mock.calls.every(call=>call[2].auditDays===12&&call[2].securityDays===5)).toBe(true);
});
it('runs runtime hourly and logs daily from startup using monotonic time',async()=>{
  mocks.delay.mockImplementation(async(ms:number)=>{expect(ms).toBe(hour);stamp+=hour;if(stamp>day)controller.abort();});
  await runRetentionWorker(pool,{auditDays:180,securityDays:90},controller.signal,event=>events.push(event));
  expect(events.filter(e=>e.scope==='runtime'&&e.event==='completed')).toHaveLength(25);expect(events.filter(e=>e.scope==='logs'&&e.event==='completed')).toHaveLength(2);expect(events.some(e=>e.event==='failed')).toBe(false);
});
it('reports failures safely, still runs logs and retries failed logs on the next hourly pass',async()=>{
  let auditCalls=0;mocks.prune.mockImplementation(async(_pool:Pool,task:string)=>{if(task==='mail')throw new Error('private connection URL');if(task==='audit'&&auditCalls++===0)throw new Error('private log');return 0;});
  mocks.delay.mockImplementation(async()=>{stamp+=hour;if(stamp>hour)controller.abort();});
  await runRetentionWorker(pool,{},controller.signal,event=>events.push(event));
  expect(events.filter(e=>e.scope==='runtime'&&e.event==='failed')).toHaveLength(2);expect(events.filter(e=>e.scope==='logs'&&e.event==='failed')).toHaveLength(1);expect(events.filter(e=>e.scope==='logs'&&e.event==='completed')).toHaveLength(1);expect(JSON.stringify(events)).not.toContain('private');
});
