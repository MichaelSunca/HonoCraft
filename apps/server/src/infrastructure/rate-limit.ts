import { normalizeEmail } from '@honocraft/contracts/common';
import { databaseNow, type Tx } from './db.js';
import { keyedDigest } from './crypto.js';
const sentinel=new Date(0);
export type LimitRule=Readonly<{scope:string;identifier:string;limit:number;windowMs:number;bucketMs:number;cooldownMs?:number}>;
export type LimitDecision={allowed:true}|{allowed:false;scope:string;retryAfter:number};
type LockedBucket={count:number;locked_until:Date|null;last_accepted_at:Date|null;failure_window_started_at:Date|null};

async function lockSentinel(tx:Tx,scope:string,digest:Buffer):Promise<LockedBucket> {
  // One statement owns the row before cleanup can select it; quota fields stay unchanged on conflict.
  return (await tx.query<LockedBucket>(`INSERT INTO rate_limit_buckets AS state(scope,key_digest,window_start,expires_at)
    VALUES ($1,$2,$3,clock_timestamp()+interval '1 day') ON CONFLICT(scope,key_digest,window_start)
    DO UPDATE SET scope=state.scope RETURNING count,locked_until,last_accepted_at,failure_window_started_at`,[scope,digest,sentinel])).rows[0]!;
}
/** Debit every rule, or none. Anonymous callers decide whether a denied target quota is a uniform 202. */
export async function consumeLimits(tx:Tx,key:Buffer,rules:readonly LimitRule[]):Promise<LimitDecision> {
  const prepared=rules.map(rule=>{
    if(!/^[a-zA-Z0-9_.-]{1,100}$/.test(rule.scope)||![rule.limit,rule.windowMs,rule.bucketMs].every(n=>Number.isSafeInteger(n)&&n>0)||
      rule.windowMs%rule.bucketMs!==0||!Number.isSafeInteger(rule.cooldownMs??0)||(rule.cooldownMs??0)<0)throw new Error('RATE_LIMIT_RULE_INVALID');
    return {...rule,digest:keyedDigest(key,'honocraft.rate-limit.v1',JSON.stringify([rule.scope,rule.identifier]))};
  }).sort((a,b)=>a.scope.localeCompare(b.scope)||Buffer.compare(a.digest,b.digest));
  if(new Set(prepared.map(r=>r.scope+':'+r.digest.toString('hex'))).size!==prepared.length)throw new Error('RATE_LIMIT_RULE_DUPLICATE');
  const states:LockedBucket[]=[];
  // Acquire every sentinel in one stable order, then sample time and examine the rolling windows.
  for(const rule of prepared)states.push(await lockSentinel(tx,rule.scope,rule.digest));
  const now=await databaseNow(tx);
  for(const [index,rule] of prepared.entries()) {
    const state=states[index]!;
    const cooldownEnd=(state.last_accepted_at?.getTime()??0)+(rule.cooldownMs??0);
    if((rule.cooldownMs??0)>0&&cooldownEnd>now.getTime())return {allowed:false,scope:rule.scope,retryAfter:Math.ceil((cooldownEnd-now.getTime())/1000)};
    const boundary=new Date(Math.floor((now.getTime()-rule.windowMs)/rule.bucketMs)*rule.bucketMs);
    const buckets=(await tx.query<{count:number;window_start:Date}>(`SELECT count,window_start FROM rate_limit_buckets
      WHERE scope=$1 AND key_digest=$2 AND window_start>=$3 AND window_start<>$4 ORDER BY window_start`,[rule.scope,rule.digest,boundary,sentinel])).rows;
    if(buckets.reduce((sum,b)=>sum+b.count,0)>=rule.limit) {
      const earliest=buckets[0]!.window_start.getTime()+rule.windowMs+rule.bucketMs;
      return {allowed:false,scope:rule.scope,retryAfter:Math.max(1,Math.ceil((earliest-now.getTime())/1000))};
    }
  }
  for(const rule of prepared) {
    const bucketStart=new Date(Math.floor(now.getTime()/rule.bucketMs)*rule.bucketMs);
    const expires=new Date(bucketStart.getTime()+rule.windowMs+rule.bucketMs);
    await tx.query(`INSERT INTO rate_limit_buckets(scope,key_digest,window_start,count,expires_at) VALUES ($1,$2,$3,1,$4)
      ON CONFLICT(scope,key_digest,window_start) DO UPDATE SET count=rate_limit_buckets.count+1,expires_at=EXCLUDED.expires_at`,[rule.scope,rule.digest,bucketStart,expires]);
    await tx.query(`UPDATE rate_limit_buckets SET last_accepted_at=$4,expires_at=$5
      WHERE scope=$1 AND key_digest=$2 AND window_start=$3`,[rule.scope,rule.digest,sentinel,now,new Date(now.getTime()+Math.max(rule.windowMs,rule.cooldownMs??0)+rule.bucketMs)]);
  }
  return {allowed:true};
}
export type AccountFailurePolicy=Readonly<{limit:number;windowMs:number;lockMs:number}>;
export async function accountFailureState(tx:Tx,key:Buffer,email:string,event:'failure'|'success'|'inspect',
  policy:AccountFailurePolicy={limit:5,windowMs:900_000,lockMs:900_000}):Promise<{failures:number;lockedUntil:Date|null}> {
  if(![policy.limit,policy.windowMs,policy.lockMs].every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('ACCOUNT_LIMIT_RULE_INVALID');
  const scope='login.account';
  const digest=keyedDigest(key,'honocraft.rate-limit.v1',JSON.stringify([scope,normalizeEmail(email)]));
  const state=await lockSentinel(tx,scope,digest);
  const now=await databaseNow(tx);
  // Neither additional failures nor a password checked before this lock may extend or clear it.
  if(state.locked_until&&state.locked_until>now)return {failures:state.count,lockedUntil:state.locked_until};
  if(event==='inspect')return {failures:state.count,lockedUntil:null};
  let failures=0;let start:Date|null=null;let lockedUntil:Date|null=null;
  if(event==='failure') {
    const continuing=!state.locked_until&&state.failure_window_started_at!==null&&now.getTime()<state.failure_window_started_at.getTime()+policy.windowMs;
    failures=continuing?state.count+1:1;
    start=continuing?state.failure_window_started_at:now;
    if(failures>=policy.limit)lockedUntil=new Date(now.getTime()+policy.lockMs);
  }
  await tx.query(`UPDATE rate_limit_buckets SET count=$4,failure_window_started_at=$5,locked_until=$6,expires_at=$7
    WHERE scope=$1 AND key_digest=$2 AND window_start=$3`,[scope,digest,sentinel,failures,start,lockedUntil,
    new Date(now.getTime()+Math.max(policy.windowMs,policy.lockMs)+60_000)]);
  return {failures,lockedUntil};
}
