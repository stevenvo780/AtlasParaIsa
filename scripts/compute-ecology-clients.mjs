import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { FIELDS } from './compute-ecology-core.mjs';

function requestWorker(worker, message) {
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{clearTimeout(timer);worker.off('message',messageHandler);worker.off('error',errorHandler);};
    const messageHandler=value=>{cleanup();value.error?reject(new Error(value.error)):resolve(value);};
    const errorHandler=error=>{cleanup();reject(error);};
    const timer=setTimeout(()=>errorHandler(new Error('CPU worker deadline exceeded')),60000);
    worker.once('message',messageHandler);worker.once('error',errorHandler);worker.postMessage(message);
  });
}

export class CPUWorkers {
  static async create(n,neighbors,count) {
    const started=performance.now(), result=new CPUWorkers(); result.n=n;
    result.input=new Float64Array(new SharedArrayBuffer(n*FIELDS*8));
    result.output=new Float64Array(new SharedArrayBuffer(n*FIELDS*8));
    const sharedNeighbors=new Int32Array(new SharedArrayBuffer(neighbors.byteLength)); sharedNeighbors.set(neighbors);
    result.workers=Array.from({length:count},()=>new Worker(new URL('./compute-ecology-worker.mjs',import.meta.url)));
    try {
      await Promise.all(result.workers.map(worker=>requestWorker(worker,{kind:'initialize',n,input:result.input.buffer,output:result.output.buffer,neighbors:sharedNeighbors.buffer})));
      result.startupMs=performance.now()-started; return result;
    } catch(error) { await result.close();throw error; }
  }
  async step(tick,rain,light) {
    const start=performance.now(), count=this.workers.length;
    const phases=await Promise.all(this.workers.map((worker,j)=>requestWorker(worker,{kind:'step',tick,rain,light,begin:Math.floor(this.n*j/count),end:Math.floor(this.n*(j+1)/count)})));
    return {data:this.output,phases:{dispatchAndComputeMs:performance.now()-start,workerComputeMs:phases.map(x=>x.computeMs)}};
  }
  async close() { await Promise.all(this.workers.map(worker=>worker.terminate())); }
}

class BinaryReader {
  constructor(stream) {
    this.chunks=[];this.offset=0;this.available=0;this.done=false;this.waiter=null;
    stream.on('data',chunk=>{this.chunks.push(chunk);this.available+=chunk.length;this.wake();});
    stream.on('end',()=>{this.done=true;this.wake();});
    stream.on('error',error=>{this.error=error;this.done=true;this.wake();});
  }
  wake(){if(this.waiter){const wake=this.waiter;this.waiter=null;wake();}}
  async read(n) {
    while(this.available<n) {
      if(this.done) throw this.error??new Error('GPU worker closed before reply');
      await new Promise(resolve=>{this.waiter=resolve;});
    }
    const result=Buffer.allocUnsafe(n);let copied=0;
    while(copied<n) {
      const head=this.chunks[0],amount=Math.min(n-copied,head.length-this.offset);
      head.copy(result,copied,this.offset,this.offset+amount);copied+=amount;this.offset+=amount;
      if(this.offset===head.length){this.chunks.shift();this.offset=0;}
    }
    this.available-=n;return result;
  }
  async frame() {
    const size=(await this.read(4)).readUInt32LE();if(size>65536)throw new Error('Oversized reply header');
    const header=JSON.parse((await this.read(size)).toString());
    if(header.error)throw new Error(header.error);
    if(!Number.isSafeInteger(header.bytes)||header.bytes<0||header.bytes>120000000)throw new Error('Oversized reply');
    const body=await this.read(header.bytes);
    return {header,data:new Float64Array(body.buffer,body.byteOffset,body.byteLength/8)};
  }
}

export class GPUWorker {
  static async create(devices,nvrtc) {
    const result=new GPUWorker(),started=performance.now();
    result.process=spawn('python3',[new URL('./compute-ecology-gpu.py',import.meta.url).pathname,'--devices',devices,'--nvrtc',nvrtc],{stdio:['pipe','pipe','pipe']});
    result.stderr='';result.process.stderr.on('data',chunk=>{result.stderr=(result.stderr+chunk.toString()).slice(-4096);});
    result.reader=new BinaryReader(result.process.stdout);
    // A failed spawn emits error/close without exit (for example absent Python).
    // close also waits for the child's pipes, so failure cleanup cannot hang here.
    result.completion=new Promise(resolve=>result.process.once('close',(code,signal)=>resolve({code,signal})));
    result.process.once('error',error=>{result.reader.error=error;result.reader.done=true;result.reader.wake();});
    result.process.stdin.on('error',error=>{result.reader.error=error;result.reader.done=true;result.reader.wake();});
    try {result.initialization=(await result.deadline(result.reader.frame())).header;result.startupMs=performance.now()-started;return result;}
    catch(error){await result.close();throw error;}
  }
  async deadline(promise, timeoutMs=60000) {
    let timer;
    try {return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>{this.process.kill('SIGTERM');reject(new Error('Owned GPU worker deadline exceeded'));},timeoutMs);})]);}
    finally {clearTimeout(timer);}
  }
  async send(header,body) {
    const payload=body?Buffer.from(body.buffer,body.byteOffset,body.byteLength):Buffer.alloc(0);
    const raw=Buffer.from(JSON.stringify({...header,bytes:payload.length})),prefix=Buffer.alloc(4);prefix.writeUInt32LE(raw.length);
    this.process.stdin.write(prefix);this.process.stdin.write(raw);
    if(!this.process.stdin.write(payload))await once(this.process.stdin,'drain');
  }
  async setup(n,neighbors) {
    const start=performance.now();
    const reply=await this.deadline((async()=>{await this.send({kind:'setup',n},neighbors);return this.reader.frame();})());
    return {...reply.header,nodeSetupMs:performance.now()-start};
  }
  async step(data,tick,rain,light) {
    const start=performance.now();
    const result=await this.deadline((async()=>{await this.send({kind:'step',tick,rain,light},data);return this.reader.frame();})());
    return {data:result.data,phases:{...result.header,nodeIPCRoundTripMs:performance.now()-start}};
  }
  async close() {
    if(!this.process)return;
    this.closing??=this.finishClose();return this.closing;
  }
  async waitClosed(milliseconds) {
    let timer;
    try{return await Promise.race([this.completion.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),milliseconds);})]);}
    finally{clearTimeout(timer);}
  }
  async finishClose() {
    if(this.process.exitCode===null && this.process.signalCode===null){this.process.stdin.end();}
    if(await this.waitClosed(1000))return;
    this.process.kill('SIGTERM');
    if(await this.waitClosed(1000))return;
    this.process.kill('SIGKILL');
    if(!await this.waitClosed(1000))throw new Error('Owned GPU worker did not close after SIGKILL');
  }
}
