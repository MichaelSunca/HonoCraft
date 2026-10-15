import {Worker} from 'node:worker_threads';
import {AppError} from '@honocraft/contracts/errors';
export type ImagePurpose='avatar'|'logo'|'favicon';
export type ImageOutput={size:number;bytes:Uint8Array;width:number;height:number;contentType:'image/webp'|'image/png'};
let active=0;
/** The slot remains occupied until exit, even when the caller's hard deadline has elapsed. */
export async function convertImage(bytes:Uint8Array,purpose:ImagePurpose,spawn?:()=>Worker):Promise<ImageOutput[]>{
  if(bytes.byteLength>2*1024*1024)throw new AppError('PAYLOAD_TOO_LARGE');
  const signature=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength),png=signature.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpeg=signature[0]===255&&signature[1]===216&&signature[2]===255,webp=signature.toString('ascii',0,4)==='RIFF'&&signature.toString('ascii',8,12)==='WEBP';
  if(!png&&!jpeg&&!webp)throw new AppError(signature.subarray(0,512).toString('utf8').trimStart().startsWith('<')||signature.toString('ascii',0,3)==='GIF'?'UNSUPPORTED_MEDIA_TYPE':'IMAGE_INVALID');
  if(active>=2)throw new AppError('BUSY_RETRY',{},2);active++;
  return new Promise((resolve,reject)=>{
    let worker:Worker;try{worker=spawn?spawn():new Worker(new URL('./image-worker.mjs',import.meta.url),{workerData:{bytes,purpose},resourceLimits:{maxOldGenerationSizeMb:64}});}catch{active--;reject(new AppError('DEPENDENCY_UNAVAILABLE'));return;}
    let settled=false,result:{outputs?:ImageOutput[];error?:'UNSUPPORTED_MEDIA_TYPE'|'IMAGE_INVALID'}|undefined;
    const timer=setTimeout(()=>{settled=true;reject(new AppError('IMAGE_INVALID'));void worker.terminate().catch(()=>undefined);},5000);
    worker.once('message',value=>{result=value;});
    worker.once('error',()=>{if(!settled){settled=true;clearTimeout(timer);reject(new AppError('DEPENDENCY_UNAVAILABLE'));}});
    worker.once('exit',code=>{active--;clearTimeout(timer);if(settled)return;settled=true;
      if(code!==0||!result)reject(new AppError('IMAGE_INVALID'));
      else if(result.error)reject(new AppError(result.error));
      else if(result.outputs?.length&&result.outputs.every(output=>output.bytes instanceof Uint8Array&&output.width>0&&output.height>0&&['image/png','image/webp'].includes(output.contentType)))resolve(result.outputs);
      else reject(new AppError('IMAGE_INVALID'));
    });
  });
}
