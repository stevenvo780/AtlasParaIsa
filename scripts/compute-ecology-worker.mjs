import { parentPort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { stepArrays } from './compute-ecology-core.mjs';
let buffers;
parentPort.on('message', request => {
  try {
    if(request.kind==='initialize') {
      buffers={input:new Float64Array(request.input),output:new Float64Array(request.output),neighbors:new Int32Array(request.neighbors),n:request.n};
      parentPort.postMessage({ready:true}); return;
    }
    const start=performance.now();
    stepArrays(buffers.input,buffers.output,buffers.neighbors,buffers.n,request.tick,request.rain,request.light,request.begin,request.end);
    parentPort.postMessage({computeMs:performance.now()-start});
  } catch(error) { parentPort.postMessage({error:String(error)}); }
});
