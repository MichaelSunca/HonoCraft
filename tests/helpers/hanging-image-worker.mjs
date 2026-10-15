import {parentPort} from 'node:worker_threads';
import {setTimeout} from 'node:timers';
setTimeout(()=>{parentPort.postMessage({error:'IMAGE_INVALID'});parentPort.close();},10_000);
