import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import sharp from 'sharp';
import {expect,it} from 'vitest';
import {convertImage} from '../../apps/server/src/modules/files/images.js';
const picture=()=>sharp({create:{width:30,height:20,channels:3,background:'blue'}}).png().toBuffer();
it('limits the process to two active conversion jobs and releases completed slots',async()=>{
  const source=await picture(),first=convertImage(source,'avatar'),second=convertImage(source,'logo');try{await expect(convertImage(source,'favicon')).rejects.toMatchObject({code:'BUSY_RETRY'});}finally{await Promise.all([first,second]);}expect((await convertImage(source,'favicon')).map(output=>output.width)).toEqual([64,32]);
});
it('enforces the five-second wall deadline and stops an unresponsive codec worker',async()=>{
  const source=await picture();let worker:Worker|undefined,exited:Promise<unknown>|undefined;const run=convertImage;
  const started=performance.now();await expect(run(source,'avatar',()=>{worker=new Worker(new URL('../helpers/hanging-image-worker.mjs',import.meta.url));exited=once(worker,'exit');return worker;})).rejects.toMatchObject({code:'IMAGE_INVALID'});expect(performance.now()-started).toBeGreaterThanOrEqual(4500);expect(performance.now()-started).toBeLessThan(6500);await exited;expect(worker!.threadId).toBe(-1);
},10_000);
