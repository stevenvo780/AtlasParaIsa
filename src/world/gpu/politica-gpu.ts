import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertPolicyBatch, evaluatePoliciesCpu } from '../politica.js';

// Like puente.ts: main thread waits on a SAB; a JS worker owns asynchronous
// binary stdio to one persistent Python/NVRTC process. No per-batch process/JIT.
const WORKER_CODE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const control = new Int32Array(workerData.control);
const errors = new Uint16Array(workerData.errors);
let child, exited, reader;
function signal(error) {
  if (error) {
    const s = String(error.stack || error).slice(0, errors.length - 1);
    errors.fill(0); for (let i=0; i<s.length; i++) errors[i]=s.charCodeAt(i);
  }
  Atomics.store(control, 0, error ? 2 : 1); Atomics.notify(control, 0);
}
class Reader {
  constructor(stream) {
    this.chunks=[]; this.offset=0; this.size=0; this.error=null; this.waiter=null;
    stream.on('data', c=>{ this.chunks.push(c); this.size+=c.length; this.wake(); });
    stream.on('end', ()=>this.fail(new Error('Policy GPU stream closed')));
    stream.on('error', e=>this.fail(e));
  }
  wake() { if(this.waiter) { const w=this.waiter; this.waiter=null; w(); } }
  fail(e) { this.error=e; this.wake(); }
  async read(n) {
    while(this.size<n) { if(this.error) throw this.error; await new Promise(r=>this.waiter=r); }
    const b=Buffer.allocUnsafe(n); let off=0;
    while(off<n) {
      const head=this.chunks[0], amount=Math.min(n-off,head.length-this.offset);
      head.copy(b,off,this.offset,this.offset+amount); off+=amount; this.offset+=amount;
      if(this.offset===head.length) { this.chunks.shift(); this.offset=0; }
    }
    this.size-=n; return b;
  }
  async frame() {
    const n=(await this.read(4)).readUInt32LE();
    if(n>65536) throw new Error('Invalid policy GPU header size');
    const h=JSON.parse((await this.read(n)).toString());
    if(h.error) throw new Error(h.error);
    return h;
  }
}
async function send(header, arrays=[]) {
  const raw=Buffer.from(JSON.stringify(header)), prefix=Buffer.alloc(4); prefix.writeUInt32LE(raw.length);
  // Honour pipe backpressure: large batches must not queue unbounded writes.
  async function write(b) { await new Promise((resolve,reject)=>child.stdin.write(b,e=>e?reject(e):resolve())); }
  await write(prefix); await write(raw);
  for(const a of arrays) await write(Buffer.from(a.buffer,a.byteOffset,a.byteLength));
}
async function stop(force=false) {
  if(!child) return;
  if(force) child.kill('SIGKILL');
  else { await send({kind:'close'}); child.stdin.end(); }
  await exited;
}
async function start() {
  child=spawn('python3',[workerData.script,'--nvrtc',workerData.nvrtc,'--devices',workerData.devices.join(',')],{stdio:['pipe','pipe','pipe']});
  Atomics.store(control, 1, child.pid || 0);
  process.on('exit', ()=>{ try { child.kill('SIGKILL'); } catch {} });
  reader=new Reader(child.stdout);
  let stderr=''; child.stderr.on('data',c=>stderr=(stderr+c.toString()).slice(-4096));
  child.stdin.on('error',e=>reader.fail(e));
  exited=new Promise(resolve=>{
    child.on('error',e=>{reader.fail(e); resolve();});
    child.on('close',(code,signal)=>{
      Atomics.store(control,1,0); Atomics.store(control,2,1); Atomics.notify(control,2);
      reader.fail(new Error('Policy GPU exited '+code+' '+signal+' '+stderr)); resolve();
    });
  });
  const ready=await reader.frame();
  if(!ready.ready) throw new Error('Policy GPU not ready');
}
const ready=start();
ready.then(()=>signal(),async e=>{await stop(true); signal(e); parentPort.close();});
parentPort.on('message',async job=>{
  try {
    await ready;
    if(job.kind==='close') { await stop(); parentPort.close(); signal(); return; }
    const arrays=[job.observations,job.weights]; if(job.biases!==null) arrays.push(job.biases);
    await send({kind:'evaluate',count:job.count,biases:job.biases!==null},arrays);
    const h=await reader.frame();
    if(h.bytes!==job.count*12*8) throw new Error('Invalid policy GPU output size');
    const body=await reader.read(h.bytes);
    new Uint8Array(job.output).set(body);
    signal();
  } catch(e) { await stop(true); signal(e); parentPort.close(); }
});
`;

export interface PolicyGpuOptions {
  /** Explicit overrides also allow deterministic failure-path tests. */
  nvrtc?: string;
  scriptPath?: string;
  /** Host wait bound only; timeout selects the mathematically identical CPU path. */
  timeoutMs?: number;
}
function resolveScript(): string {
  for (const path of ['../../../scripts/compute-policy-gpu.py', '../../../../scripts/compute-policy-gpu.py']) {
    const candidate = fileURLToPath(new URL(path, import.meta.url));
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('compute-policy-gpu.py not found');
}

/** Synchronous, reusable FP64 batch evaluator. backend/fallbackReason expose
 * actual execution: a CPU fallback must never be reported as GPU evidence.
 * Device membership and contiguous index partitions are explicitly configured.
 * A failed accelerator is discarded, and the entire batch is recomputed on CPU. */
export class PolicyGpuBatcher {
  readonly devices: readonly number[];
  private worker: Worker | null = null;
  private readonly control = new Int32Array(new SharedArrayBuffer(12));
  private readonly errors = new Uint16Array(new SharedArrayBuffer(8192));
  private readonly timeoutMs: number;
  private closed = false;
  private reason: string | null = null;
  get backend(): 'cpu' | 'gpu' { return this.worker === null ? 'cpu' : 'gpu'; }
  get fallbackReason(): string | null { return this.reason; }

  constructor(devices: readonly number[] = [0], options: PolicyGpuOptions = {}) {
    if (!devices.length || devices.some(d => !Number.isSafeInteger(d) || d < 0)
      || new Set(devices).size !== devices.length) throw new RangeError('Invalid policy GPU devices');
    this.devices = Object.freeze([...devices]);
    this.timeoutMs = options.timeoutMs ?? 60_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new RangeError('Invalid GPU timeout');
    const nvrtc = options.nvrtc ?? process.env.COMPUTE_NVRTC
      ?? (existsSync('/opt/cuda/lib64/libnvrtc.so') ? '/opt/cuda/lib64/libnvrtc.so' : null);
    if (nvrtc === null) { this.reason = 'NVRTC unavailable'; return; }
    try {
      this.worker = new Worker(WORKER_CODE, { eval: true, execArgv: [], name: 'atlas-policy-gpu',
        workerData: { script: options.scriptPath ?? resolveScript(), nvrtc, devices: this.devices,
          control: this.control.buffer, errors: this.errors.buffer } });
      // A worker error must not become an unhandled host exception. The shared
      // wait also bounds bootstrap errors while the main event loop is blocked.
      this.worker.on('error', () => {});
      this.worker.unref();
      this.wait();
    } catch (e) { this.fallback(e); }
  }
  private wait(): void {
    if (Atomics.wait(this.control, 0, 0, this.timeoutMs) === 'timed-out')
      throw new Error('Policy GPU wait timed out');
    if (Atomics.load(this.control, 0) !== 1) {
      const end = this.errors.indexOf(0);
      throw new Error(String.fromCharCode(...this.errors.subarray(0, end < 0 ? undefined : end)));
    }
  }
  private fallback(error: unknown): void {
    this.reason = error instanceof Error ? error.message : String(error);
    // terminate() alone does not terminate a worker's subprocess on timeout.
    const pid = Atomics.load(this.control, 1);
    if (pid > 0) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
      // Reap the child before terminating its owner worker, including timeout.
      Atomics.wait(this.control, 2, 0, 5000);
    }
    if (this.worker) void this.worker.terminate();
    this.worker = null;
  }
  evaluate(observations: Float64Array, weights: Float64Array,
    plasticityBiases: Float64Array | null, count: number): Float64Array {
    if (this.closed) throw new Error('PolicyGpuBatcher closed');
    assertPolicyBatch(observations, weights, plasticityBiases, count);
    if (this.worker === null || count === 0) return evaluatePoliciesCpu(observations, weights, plasticityBiases, count);
    const output = new SharedArrayBuffer(count * 12 * 8);
    try {
      Atomics.store(this.control, 0, 0);
      this.worker.postMessage({ kind: 'evaluate', observations, weights, biases: plasticityBiases, count, output });
      this.wait();
      return new Float64Array(output);
    } catch (e) {
      this.fallback(e);
      return evaluatePoliciesCpu(observations, weights, plasticityBiases, count);
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.worker === null) return;
    try {
      Atomics.store(this.control, 0, 0);
      this.worker.postMessage({ kind: 'close' });
      this.wait();
    } catch (e) {
      this.fallback(e);
    } finally {
      if (this.worker) void this.worker.terminate();
      this.worker = null;
    }
  }
}

const cachedPolicyBatchers = new Map<string, PolicyGpuBatcher>();

/**
 * Evalúa un lote de políticas 12→8→12 usando un `PolicyGpuBatcher` persistente por tupla de
 * dispositivos CUDA (sin recrear procesos ni recompilar NVRTC por paso). Si `devices` está vacío
 * o NVRTC no está disponible, corre `evaluatePoliciesCpu` con paridad FP64 exacta (`Object.is`).
 */
export function evaluatePoliciesBatch(
  observations: Float64Array,
  weights: Float64Array,
  plasticityBiases: Float64Array | null,
  count: number,
  devices: readonly number[],
): Float64Array {
  if (count === 0 || devices.length === 0) return evaluatePoliciesCpu(observations, weights, plasticityBiases, count);
  const key = devices.join(',');
  let batcher = cachedPolicyBatchers.get(key);
  if (!batcher) {
    batcher = new PolicyGpuBatcher(devices);
    cachedPolicyBatchers.set(key, batcher);
  }
  return batcher.evaluate(observations, weights, plasticityBiases, count);
}

/** Diagnóstico de los batchers GPU de políticas actualmente abiertos (solo lectura). */
export function policyGpuBatcherStatus(devices: readonly number[]): { backend: 'cpu' | 'gpu'; fallbackReason: string | null } | null {
  const batcher = cachedPolicyBatchers.get(devices.join(','));
  return batcher ? { backend: batcher.backend, fallbackReason: batcher.fallbackReason } : null;
}

/** Cierra todos los batchers GPU persistentes de políticas (tests y cierre ordenado del servidor). */
export function closePolicyGpuBatchers(): void {
  for (const batcher of cachedPolicyBatchers.values()) batcher.close();
  cachedPolicyBatchers.clear();
}
