import {parentPort,workerData} from 'node:worker_threads';
import {Buffer} from 'node:buffer';
import sharp from 'sharp';
sharp.concurrency(1);sharp.cache(false);
try{
  const input=Buffer.from(workerData.bytes),options={limitInputPixels:16_000_000,animated:true,failOn:'warning'};
  const metadata=await sharp(input,options).timeout({seconds:5}).metadata();
  if(!['jpeg','png','webp'].includes(metadata.format))throw new Error('UNSUPPORTED_MEDIA_TYPE');
  if((metadata.pages??1)!==1)throw new Error('IMAGE_INVALID');
  const encode=async(size)=>{
    let pipeline=sharp(input,options).rotate().timeout({seconds:5});
    pipeline=workerData.purpose==='logo'?pipeline.resize({width:512,height:512,fit:'inside',withoutEnlargement:true}):pipeline.resize(size,size,{fit:'cover'});
    const result=await (workerData.purpose==='favicon'?pipeline.png():pipeline.webp({quality:85})).toBuffer({resolveWithObject:true});
    return {size,bytes:result.data,width:result.info.width,height:result.info.height,contentType:workerData.purpose==='favicon'?'image/png':'image/webp'};
  };
  const outputs=workerData.purpose==='favicon'?[await encode(64),await encode(32)]:[await encode(workerData.purpose==='avatar'?256:512)];
  parentPort.postMessage({outputs});
}catch(error){parentPort.postMessage({error:error?.message==='UNSUPPORTED_MEDIA_TYPE'?'UNSUPPORTED_MEDIA_TYPE':'IMAGE_INVALID'});}
parentPort.close();
