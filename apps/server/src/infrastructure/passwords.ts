import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { AppError } from '@honocraft/contracts/errors';
import { PasswordSchema } from '@honocraft/contracts/common';

type QueueOptions=Readonly<{concurrency:number;queueLimit:number;queueTimeoutMs:number}>;
type WaitingJob={start:()=>void;timer:ReturnType<typeof setTimeout>};
/** Bounds active memory-heavy jobs AND waiting work; expired jobs are removed before they can run. */
export class BoundedExecutor {
  private active=0;
  private readonly waiting:WaitingJob[]=[];
  constructor(private readonly options:QueueOptions) {
    if(!Number.isInteger(options.concurrency)||options.concurrency<1||options.concurrency>16||
      !Number.isInteger(options.queueLimit)||options.queueLimit<0||!Number.isInteger(options.queueTimeoutMs)||options.queueTimeoutMs<=0)throw new Error('HASH_QUEUE_CONFIG_INVALID');
  }
  run<T>(work:()=>Promise<T>):Promise<T> {
    return new Promise<T>((resolve,reject)=>{
      const start=()=>{
        this.active++;
        void (async()=>{
          try {resolve(await work());} catch(error){reject(error);}
          finally {
            this.active--;
            const next=this.waiting.shift();
            if(next){clearTimeout(next.timer);next.start();}
          }
        })();
      };
      if(this.active<this.options.concurrency){start();return;}
      if(this.waiting.length>=this.options.queueLimit){reject(new AppError('AUTH_BUSY',{},2));return;}
      const entry:WaitingJob={start,timer:setTimeout(()=>{
        const index=this.waiting.indexOf(entry);
        if(index>=0)this.waiting.splice(index,1);
        reject(new AppError('AUTH_BUSY',{},2));
      },this.options.queueTimeoutMs)};
      this.waiting.push(entry);
    });
  }
}
const hashOptions=Object.freeze({type:argon2.argon2id,memoryCost:65_536,timeCost:3,parallelism:1,hashLength:32,version:0x13});
export type PasswordService=Readonly<{
  hash:(password:string,minimumLength?:number)=>Promise<string>;
  verify:(encoded:string|null,password:string)=>Promise<boolean>;
}>;
/** The caller loads and verifies the versioned blocklist before constructing this service. */
export async function createPasswordService(options:{concurrency:number;blockedPasswords:ReadonlySet<string>;queueLimit?:number}):Promise<PasswordService> {
  const executor=new BoundedExecutor({concurrency:options.concurrency,queueLimit:options.queueLimit??10,queueTimeoutMs:2000});
  const blocked=new Set([...options.blockedPasswords].map(value=>value.toLowerCase()));
  const dummy=await executor.run(()=>argon2.hash(randomBytes(32),hashOptions));
  return Object.freeze({
    hash:async(password:string,minimumLength=15)=>{
      if(!Number.isInteger(minimumLength)||minimumLength<15||minimumLength>128)throw new Error('PASSWORD_POLICY_INVALID');
      if(!PasswordSchema.safeParse(password).success||[...password].length<minimumLength||blocked.has(password.toLowerCase()))throw new AppError('PASSWORD_REJECTED');
      return executor.run(()=>argon2.hash(password,{...hashOptions,salt:randomBytes(16)}));
    },
    verify:async(encoded:string|null,password:string)=>executor.run(async()=>{
      // Runtime hashes are produced with this bounded format; reject corrupt cost parameters before allocating memory.
      if(encoded!==null&&!/^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/.test(encoded))throw new AppError('DEPENDENCY_UNAVAILABLE');
      const matches=await argon2.verify(encoded??dummy,password);
      return encoded!==null&&matches;
    }),
  });
}
