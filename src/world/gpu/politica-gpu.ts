import { Worker } from 'node:worker_threads';
import { closeSync, existsSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPolicyBatch, evaluatePoliciesCpu, POLICY_WEIGHTS } from '../politica.js';

// Like puente.ts: main thread waits on a SAB; a JS worker owns asynchronous
// binary stdio to one persistent Python/NVRTC process. No per-batch process/JIT.
const WORKER_CODE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const control = new Int32Array(workerData.control);
const errors = new Uint16Array(workerData.errors);
const reply = new Float64Array(workerData.reply);
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
  const raw=Buffer.from(JSON.stringify(header)), prefix=Buffer.allocUnsafe(4); prefix.writeUInt32LE(raw.length);
  const parts=[prefix, raw];
  for(const a of arrays) parts.push(Buffer.from(a.buffer,a.byteOffset,a.byteLength));
  const payload=Buffer.concat(parts);
  // Honour pipe backpressure: large batches must not queue unbounded writes.
  await new Promise((resolve,reject)=>child.stdin.write(payload,e=>e?reject(e):resolve()));
}
async function stop(force=false) {
  if(!child) return;
  if(force) child.kill('SIGKILL');
  else { await send({kind:'close'}); child.stdin.end(); }
  await exited;
}
async function start() {
  const argv=[workerData.script,'--nvrtc',workerData.nvrtc,'--devices',workerData.devices.join(',')];
  if(workerData.shmPath) argv.push('--shm',workerData.shmPath);
  child=spawn('python3',argv,{stdio:['pipe','pipe','pipe']});
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
  reply[2]=ready.resident===true ? 1 : 0; reply[3]=ready.shm===true ? 1 : 0;
}
const ready=start();
ready.then(()=>signal(),async e=>{await stop(true); signal(e); parentPort.close();});
// Resident commands: inputs are already in the shared file (shm) or in a SAB the
// host filled once; they are streamed from there without Buffer.concat copies.
async function sendViews(header, views) {
  const raw=Buffer.from(JSON.stringify(header)), prefix=Buffer.allocUnsafe(4); prefix.writeUInt32LE(raw.length);
  const parts=[Buffer.concat([prefix, raw]), ...views.filter(v=>v.length>0)];
  let last;
  for(const p of parts) last=new Promise((resolve,reject)=>child.stdin.write(p,e=>e?reject(e):resolve()));
  await last;
}
parentPort.on('message',async job=>{
  try {
    await ready;
    if(job.kind==='close') { await stop(); parentPort.close(); signal(); return; }
    if(job.kind==='sync' || job.kind==='resident') {
      const views=job.shm ? [] : [Buffer.from(job.input,0,job.inBytes)];
      const header=job.kind==='sync'
        ? {kind:'sync_weights',count:job.count,capacity:job.capacity,reset:job.reset,shm:job.shm}
        : {kind:'evaluate_resident',count:job.count,biases:job.biases,shm:job.shm,shares:job.shares};
      await sendViews(header, views);
      const h=await reader.frame();
      if(job.kind==='sync') {
        if(h.ok!==true || !(h.capacity>=job.capacity)) throw new Error('Invalid policy GPU sync reply');
      } else {
        const expected=job.count*12*8;
        const shards=Array.isArray(h.shards) ? h.shards : [];
        reply[4]=Math.min(shards.length, reply.length-5);
        const ms=Array.isArray(h.deviceMs) ? h.deviceMs : [];
        for(let i=0;i<reply[4];i++) { reply[5+i]=shards[i]; reply[21+i]=typeof ms[i]==='number' ? ms[i] : NaN; }
        reply[37]=typeof h.serverMs==='number' ? h.serverMs : NaN;
        if(job.shm) {
          if(h.shmBytes!==expected || h.bytes!==0 || !Number.isSafeInteger(h.offset) || h.offset<job.inBytes)
            throw new Error('Invalid policy GPU resident reply');
          reply[0]=h.offset; reply[1]=h.shmBytes;
        } else {
          if(h.bytes!==expected) throw new Error('Invalid policy GPU output size');
          const body=await reader.read(h.bytes);
          new Uint8Array(job.output,0,h.bytes).set(body);
          reply[0]=-1; reply[1]=h.bytes;
        }
      }
      signal(); return;
    }
    const arrays=[job.observations,job.weights]; if(job.biases!==null) arrays.push(job.biases);
    await send({kind:'evaluate',count:job.count,biases:job.biases!==null},arrays);
    const h=await reader.frame();
    if(h.bytes!==job.count*12*8) throw new Error('Invalid policy GPU output size');
    const body=await reader.read(h.bytes);
    new Uint8Array(job.output, 0, h.bytes).set(body);
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
  /** Frame exchange of the resident commands: `'shm'` (default) uses a file on
   * /dev/shm that both processes map/pwrite (unlinked right after start-up, so it
   * never leaks); `'pipe'` streams the same binary frames over stdio. */
  transport?: 'shm' | 'pipe';
  /** Fixed relative work share per device for `evaluateResident`. Default: the
   * worker balances contiguous shards by each device's measured throughput.
   * Shards never change results: one CUDA thread = one actor. */
  shares?: readonly number[];
}
function resolveScript(): string {
  for (const path of ['../../../scripts/compute-policy-gpu.py', '../../../../scripts/compute-policy-gpu.py']) {
    const candidate = fileURLToPath(new URL(path, import.meta.url));
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('compute-policy-gpu.py not found');
}

const ROW = 12; // POLICY_INPUTS === POLICY_ACTIONS.length
const ROW_BYTES = ROW * 8;
const WEIGHT_BYTES = POLICY_WEIGHTS * 8;
const MAX_RESIDENT_ROWS = 1 << 26;
const align = (n: number, a: number): number => Math.ceil(n / a) * a;

const shmPaths = new Set<string>();
let shmExitHook = false;
function createShmFile(): { fd: number; path: string } | null {
  const dir = existsSync('/dev/shm') ? '/dev/shm' : tmpdir();
  const path = join(dir, `atlas-policy-${process.pid}-${randomBytes(6).toString('hex')}.shm`);
  try {
    const fd = openSync(path, 'wx+', 0o600);
    shmPaths.add(path);
    if (!shmExitHook) {
      shmExitHook = true;
      process.on('exit', () => { for (const p of shmPaths) { try { unlinkSync(p); } catch {} } });
    }
    return { fd, path };
  } catch { return null; }
}
function unlinkShm(path: string | null): void {
  if (path !== null && shmPaths.delete(path)) { try { unlinkSync(path); } catch {} }
}
function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}
function writeAll(fd: number, view: ArrayBufferView, position: number): void {
  const bytes = bytesOf(view);
  for (let off = 0; off < bytes.length;) off += writeSync(fd, bytes, off, bytes.length - off, position + off);
}
function readAll(fd: number, view: ArrayBufferView, position: number): void {
  const bytes = bytesOf(view);
  for (let off = 0; off < bytes.length;) {
    const got = readSync(fd, bytes, off, bytes.length - off, position + off);
    if (got <= 0) throw new Error('Policy GPU shm: short read');
    off += got;
  }
}
/** Same acceptance as politica.ts `vector`: exact length, finite, bounded (NaN fails). */
function checkRows(values: unknown, length: number, lo: number, hi: number, label: string): asserts values is Float64Array {
  if (!(values instanceof Float64Array)) throw new TypeError(`Policy ${label} require Float64Array`);
  if (values.length !== length) throw new RangeError(`Invalid ${label} length`);
  for (let i = 0; i < length; i++) {
    const v = values[i]!;
    if (!(v >= lo && v <= hi)) throw new RangeError(`Invalid ${label}`);
  }
}

/** Handle of an in-flight resident evaluation. Inputs must stay unmodified until
 * `wait()` returns (a CPU recomputation after a GPU failure reads them again). */
export interface PendingPolicyEvaluation {
  readonly count: number;
  wait(): Float64Array;
}
interface PendingResident {
  slots: Uint32Array; observations: Float64Array; biases: Float64Array | null;
  count: number; fallbackWeights: Float64Array | undefined; result: Float64Array | null;
  /** Fresh output, allocated (and page-faulted) while the devices compute. */
  output: Float64Array | null;
}
export interface PolicyResidentStats {
  /** Rows the host (and every device table) can address by slot. */
  capacity: number;
  syncCalls: number; syncedRows: number; syncUploadedBytes: number;
  evaluateCalls: number; evaluatedRows: number; evaluateUploadedBytes: number;
  /** Weight bytes a full-upload `evaluate` would have sent for the same batches. */
  weightBytesAvoided: number;
  transport: 'shm' | 'pipe' | 'cpu';
  /** Actors per device in the last GPU `evaluateResident` (device order), as reported by the worker. */
  lastShards: number[];
  /** Wall ms of each device's upload+kernel+download in that call (worker clock). */
  lastDeviceMs: number[];
  /** Wall ms of the whole command inside the worker (validation, shards, devices). */
  lastWorkerMs: number;
}

/** Synchronous, reusable FP64 batch evaluator. backend/fallbackReason expose
 * actual execution: a CPU fallback must never be reported as GPU evidence.
 * Device membership and contiguous index partitions are explicitly configured.
 * A failed accelerator is discarded, and the entire batch is recomputed on CPU.
 *
 * Resident mode: `syncResidentWeights` writes genome rows once into a slot-indexed
 * weight table that every configured device keeps in VRAM; `evaluateResident`
 * then ships only slots + observations (+ lifetime biases): zero weight bytes per
 * tick. A host mirror of the table keeps the CPU fallback exact (`Object.is`). */
export class PolicyGpuBatcher {
  readonly devices: readonly number[];
  private worker: Worker | null = null;
  private readonly control = new Int32Array(new SharedArrayBuffer(12));
  private readonly errors = new Uint16Array(new SharedArrayBuffer(8192));
  /** [shm reply offset (-1: pipe), reply bytes, resident protocol, shm accepted, nShards,
   *  shards[16] at 5.., per-device wall ms[16] at 21.., worker command ms at 37]. */
  private readonly reply = new Float64Array(new SharedArrayBuffer(8 * 38));
  private sharedOutput = new SharedArrayBuffer(64 * 12 * 8);
  private sharedInput = new SharedArrayBuffer(0);
  private readonly timeoutMs: number;
  private readonly shares: readonly number[] | undefined;
  private closed = false;
  private reason: string | null = null;
  private shmFd: number | null = null;
  private shmPath: string | null = null;
  private residentProtocol = false;
  private mirror = new Float64Array(0);
  private valid = new Uint8Array(0);
  private capacityRows = 0;
  private pending: PendingResident | null = null;
  readonly #stats: PolicyResidentStats = {
    capacity: 0, syncCalls: 0, syncedRows: 0, syncUploadedBytes: 0, evaluateCalls: 0, evaluatedRows: 0,
    evaluateUploadedBytes: 0, weightBytesAvoided: 0, transport: 'cpu', lastShards: [], lastDeviceMs: [], lastWorkerMs: NaN,
  };
  get backend(): 'cpu' | 'gpu' { return this.worker === null ? 'cpu' : 'gpu'; }
  get fallbackReason(): string | null { return this.reason; }
  /** Snapshot of the resident-table counters (copies; never live references). */
  get residentStats(): PolicyResidentStats {
    return { ...this.#stats, capacity: this.capacityRows, transport: this.worker === null ? 'cpu' : this.#stats.transport,
      lastShards: [...this.#stats.lastShards], lastDeviceMs: [...this.#stats.lastDeviceMs] };
  }

  constructor(devices: readonly number[] = [0], options: PolicyGpuOptions = {}) {
    if (!devices.length || devices.some(d => !Number.isSafeInteger(d) || d < 0)
      || new Set(devices).size !== devices.length) throw new RangeError('Invalid policy GPU devices');
    this.devices = Object.freeze([...devices]);
    this.timeoutMs = options.timeoutMs ?? 60_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new RangeError('Invalid GPU timeout');
    if (options.shares !== undefined && (options.shares.length !== devices.length
      || options.shares.some(s => !Number.isFinite(s) || s <= 0))) throw new RangeError('Invalid policy GPU shares');
    this.shares = options.shares ? Object.freeze([...options.shares]) : undefined;
    const transport = options.transport ?? 'shm';
    if (transport !== 'shm' && transport !== 'pipe') throw new RangeError('Invalid policy GPU transport');
    const nvrtc = options.nvrtc ?? process.env.COMPUTE_NVRTC
      ?? (existsSync('/opt/cuda/lib64/libnvrtc.so') ? '/opt/cuda/lib64/libnvrtc.so' : null);
    if (nvrtc === null) { this.reason = 'NVRTC unavailable'; return; }
    try {
      if (transport === 'shm') {
        const shm = createShmFile();
        if (shm) { this.shmFd = shm.fd; this.shmPath = shm.path; }
      }
      this.worker = new Worker(WORKER_CODE, { eval: true, execArgv: [], name: 'atlas-policy-gpu',
        workerData: { script: options.scriptPath ?? resolveScript(), nvrtc, devices: this.devices,
          control: this.control.buffer, errors: this.errors.buffer, reply: this.reply.buffer, shmPath: this.shmPath } });
      // A worker error must not become an unhandled host exception. The shared
      // wait also bounds bootstrap errors while the main event loop is blocked.
      this.worker.on('error', () => {});
      this.worker.unref();
      this.wait();
      this.residentProtocol = this.reply[2] === 1;
      // Python mapped the file during bootstrap: the name is no longer needed.
      if (this.shmFd !== null && this.reply[3] !== 1) this.closeShm();
      unlinkShm(this.shmPath);
      this.#stats.transport = this.shmFd !== null ? 'shm' : 'pipe';
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
  private closeShm(): void {
    if (this.shmFd !== null) { try { closeSync(this.shmFd); } catch {} }
    this.shmFd = null;
    unlinkShm(this.shmPath);
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
    this.closeShm();
  }
  /** Completes an in-flight resident evaluation before any other command. */
  private drain(): void { if (this.pending) this.finish(this.pending); }
  /** Completes the in-flight resident evaluation, if any (its handle keeps the result). */
  settle(): void { if (!this.closed) this.drain(); }
  private input(bytes: number): Uint8Array {
    if (this.sharedInput.byteLength < bytes)
      this.sharedInput = new SharedArrayBuffer(Math.max(bytes, this.sharedInput.byteLength * 2, 1 << 16));
    return new Uint8Array(this.sharedInput);
  }
  private output(bytes: number): void {
    if (this.sharedOutput.byteLength < bytes)
      this.sharedOutput = new SharedArrayBuffer(Math.max(bytes, this.sharedOutput.byteLength * 2));
  }

  evaluate(observations: Float64Array, weights: Float64Array,
    plasticityBiases: Float64Array | null, count: number): Float64Array {
    if (this.closed) throw new Error('PolicyGpuBatcher closed');
    assertPolicyBatch(observations, weights, plasticityBiases, count);
    this.drain();
    if (this.worker === null || count === 0) return evaluatePoliciesCpu(observations, weights, plasticityBiases, count);
    this.output(count * 12 * 8);
    try {
      Atomics.store(this.control, 0, 0);
      this.worker.postMessage({ kind: 'evaluate', observations, weights, biases: plasticityBiases, count, output: this.sharedOutput });
      this.wait();
      return new Float64Array(new Float64Array(this.sharedOutput, 0, count * 12));
    } catch (e) {
      this.fallback(e);
      return evaluatePoliciesCpu(observations, weights, plasticityBiases, count);
    }
  }

  /**
   * Writes `slots.length` genome rows (`weights`, 212 FP64 each, in slot order of
   * `slots`) into the resident table of every configured device and of the host
   * mirror. `totalCapacity` is the number of addressable slots required (growth is
   * geometric on device); with `reset` the table is re-created with exactly that
   * capacity and every previous slot becomes invalid (compaction).
   */
  syncResidentWeights(slots: Uint32Array, weights: Float64Array, totalCapacity: number, reset = false): void {
    if (this.closed) throw new Error('PolicyGpuBatcher closed');
    if (!(slots instanceof Uint32Array)) throw new TypeError('Resident slots require Uint32Array');
    if (!Number.isSafeInteger(totalCapacity) || totalCapacity < 1 || totalCapacity > MAX_RESIDENT_ROWS)
      throw new RangeError('Invalid resident policy capacity');
    if (typeof reset !== 'boolean') throw new TypeError('Invalid resident reset flag');
    const k = slots.length;
    checkRows(weights, k * POLICY_WEIGHTS, -1, 1, 'resident weights');
    const rows = reset ? totalCapacity : Math.max(totalCapacity, this.capacityRows);
    const sorted = Uint32Array.from(slots).sort();
    for (let i = 0; i < k; i++) {
      if (sorted[i]! >= rows) throw new RangeError('Resident policy slot beyond capacity');
      if (i > 0 && sorted[i] === sorted[i - 1]) throw new RangeError('Duplicated resident policy slot');
    }
    this.drain();
    // Host mirror first: it is the exact CPU source whatever the accelerator does.
    if (reset) {
      this.mirror = new Float64Array(rows * POLICY_WEIGHTS); this.valid = new Uint8Array(rows);
    } else if (this.valid.length < rows) {
      const grown = Math.max(rows, this.valid.length * 2);
      const mirror = new Float64Array(grown * POLICY_WEIGHTS); mirror.set(this.mirror); this.mirror = mirror;
      const valid = new Uint8Array(grown); valid.set(this.valid); this.valid = valid;
    }
    for (let i = 0; i < k; i++) {
      const slot = slots[i]!;
      this.mirror.set(weights.subarray(i * POLICY_WEIGHTS, (i + 1) * POLICY_WEIGHTS), slot * POLICY_WEIGHTS);
      this.valid[slot] = 1;
    }
    this.capacityRows = rows;
    this.#stats.syncCalls++; this.#stats.syncedRows += k;
    if (this.worker === null) return;
    try {
      if (!this.residentProtocol) throw new Error('Policy GPU worker lacks the resident protocol');
      const slotBytes = align(k * 4, 8), inBytes = slotBytes + k * WEIGHT_BYTES;
      const shm = this.shmFd !== null;
      if (shm) {
        writeAll(this.shmFd!, slots, 0); writeAll(this.shmFd!, weights, slotBytes);
      } else {
        const input = this.input(inBytes);
        input.set(bytesOf(slots), 0); input.set(bytesOf(weights), slotBytes);
      }
      Atomics.store(this.control, 0, 0);
      this.worker.postMessage({ kind: 'sync', count: k, capacity: rows, reset, shm, input: this.sharedInput, inBytes });
      this.wait();
      this.#stats.syncUploadedBytes += inBytes * this.devices.length;
    } catch (e) { this.fallback(e); }
  }

  /** `beginEvaluateResident(...).wait()`. */
  evaluateResident(slots: Uint32Array, observations: Float64Array, plasticityBiases: Float64Array | null,
    count: number, fallbackWeights?: Float64Array): Float64Array {
    return this.beginEvaluateResident(slots, observations, plasticityBiases, count, fallbackWeights).wait();
  }

  /**
   * Starts a resident evaluation and returns at once, so the host can drive other
   * accelerator work (e.g. the resident ecology bridge) while both GPUs crunch the
   * policy batch. Only slots/observations/biases travel: zero weight bytes. Output
   * row i is the policy of the actor resident at `slots[i]`. `fallbackWeights`
   * (optional, `count × 212`, the same rows) saves the mirror gather on CPU.
   */
  beginEvaluateResident(slots: Uint32Array, observations: Float64Array, plasticityBiases: Float64Array | null,
    count: number, fallbackWeights?: Float64Array): PendingPolicyEvaluation {
    if (this.closed) throw new Error('PolicyGpuBatcher closed');
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Invalid policy count');
    if (!(slots instanceof Uint32Array)) throw new TypeError('Resident slots require Uint32Array');
    if (slots.length !== count) throw new RangeError('Invalid resident slots length');
    checkRows(observations, count * ROW, -1, 1, 'observations');
    if (plasticityBiases !== null) checkRows(plasticityBiases, count * ROW, -0.5, 0.5, 'plasticity biases');
    for (let i = 0; i < count; i++) {
      const slot = slots[i]!;
      if (slot >= this.capacityRows || this.valid[slot] !== 1) throw new RangeError('Unsynchronised resident policy slot');
    }
    if (fallbackWeights !== undefined) assertPolicyBatch(observations, fallbackWeights, plasticityBiases, count);
    this.drain();
    const pending: PendingResident = { slots, observations, biases: plasticityBiases, count, fallbackWeights, result: null, output: null };
    const handle: PendingPolicyEvaluation = { count, wait: () => this.finish(pending) };
    if (this.worker === null || count === 0) { pending.result = this.cpuResident(pending); return handle; }
    try {
      if (!this.residentProtocol) throw new Error('Policy GPU worker lacks the resident protocol');
      const slotBytes = align(count * 4, 8);
      const inBytes = slotBytes + count * ROW_BYTES * (plasticityBiases === null ? 1 : 2);
      const shm = this.shmFd !== null;
      if (shm) {
        writeAll(this.shmFd!, slots, 0); writeAll(this.shmFd!, observations, slotBytes);
        if (plasticityBiases !== null) writeAll(this.shmFd!, plasticityBiases, slotBytes + count * ROW_BYTES);
      } else {
        const input = this.input(inBytes);
        input.set(bytesOf(slots), 0); input.set(bytesOf(observations), slotBytes);
        if (plasticityBiases !== null) input.set(bytesOf(plasticityBiases), slotBytes + count * ROW_BYTES);
        this.output(count * ROW_BYTES);
      }
      Atomics.store(this.control, 0, 0);
      this.worker.postMessage({ kind: 'resident', count, biases: plasticityBiases !== null, shm, shares: this.shares,
        input: this.sharedInput, inBytes, output: this.sharedOutput });
      this.pending = pending;
      this.#stats.evaluateUploadedBytes += inBytes;
      pending.output = new Float64Array(count * ROW);
    } catch (e) {
      this.fallback(e);
      pending.result = this.cpuResident(pending);
    }
    return handle;
  }

  private finish(pending: PendingResident): Float64Array {
    if (pending.result !== null) return pending.result;
    let result: Float64Array;
    try {
      this.wait();
      result = pending.output ?? new Float64Array(pending.count * ROW);
      if (this.reply[0]! >= 0 && this.shmFd !== null) readAll(this.shmFd, result, this.reply[0]);
      else result.set(new Float64Array(this.sharedOutput, 0, pending.count * ROW));
      this.#stats.evaluateCalls++; this.#stats.evaluatedRows += pending.count;
      this.#stats.weightBytesAvoided += pending.count * WEIGHT_BYTES;
      this.#stats.lastShards = Array.from(this.reply.subarray(5, 5 + this.reply[4]!));
      this.#stats.lastDeviceMs = Array.from(this.reply.subarray(21, 21 + this.reply[4]!));
      this.#stats.lastWorkerMs = this.reply[37]!;
    } catch (e) {
      this.fallback(e);
      result = this.cpuResident(pending);
    } finally {
      if (this.pending === pending) this.pending = null;
    }
    pending.result = result;
    return result;
  }
  private cpuResident(p: PendingResident): Float64Array {
    if (p.fallbackWeights !== undefined) return evaluatePoliciesCpu(p.observations, p.fallbackWeights, p.biases, p.count);
    const weights = new Float64Array(p.count * POLICY_WEIGHTS);
    for (let i = 0; i < p.count; i++) {
      const slot = p.slots[i]!;
      weights.set(this.mirror.subarray(slot * POLICY_WEIGHTS, (slot + 1) * POLICY_WEIGHTS), i * POLICY_WEIGHTS);
    }
    return evaluatePoliciesCpu(p.observations, weights, p.biases, p.count);
  }

  close(): void {
    if (this.closed) return;
    try { this.drain(); } catch {}
    this.closed = true;
    if (this.worker === null) { this.closeShm(); return; }
    try {
      Atomics.store(this.control, 0, 0);
      this.worker.postMessage({ kind: 'close' });
      this.wait();
    } catch (e) {
      this.fallback(e);
    } finally {
      if (this.worker) void this.worker.terminate();
      this.worker = null;
      this.closeShm();
    }
  }
}

/** Actor of a resident batch. `weights` must be the actor's (immutable) genome
 * array: residency is keyed by `id` AND array identity, so a new array (another
 * genome, a cloned world) is re-synchronised, while the same array is never
 * re-uploaded. Mutating a genome array in place is not supported. */
export interface ResidentPolicyActor {
  id: string;
  weights: readonly number[];
  obs: Float64Array;
  bias: Float64Array;
}
export interface ResidentPolicyRegistryStats {
  calls: number; residentActors: number; highWater: number; freeSlots: number;
  syncedRows: number; lastSyncedRows: number; evictedRows: number; compactions: number;
}
interface ResidentEntry { slot: number; weights: readonly number[]; seen: number; mark: number }

/**
 * Slot registry of one `PolicyGpuBatcher`: new (or re-genomed) actors are synced
 * once with `sync_weights`; every later batch only ships slots + observations.
 * Memory is bounded: an actor not seen for `STALE_CALLS` batches is dead; dead
 * entries are evicted (slots reused) once the registry exceeds twice the live
 * set (checked on growth and every `SCAN_EVERY` batches), and the slot range is
 * compacted (one full re-upload) once it exceeds twice the resident set.
 */
export class ResidentPolicyRegistry {
  static readonly STALE_CALLS = 64;
  static readonly MIN_COMPACT_ROWS = 1024;
  static readonly SCAN_EVERY = 16;
  private readonly entries = new Map<string, ResidentEntry>();
  private free: number[] = [];
  private highWater = 0;
  private calls = 0;
  private liveAtScan = 0;
  private lastScan = 0;
  private stamps = 0;
  private found: (ResidentEntry | undefined)[] = [];
  private scratchSlots = new Uint32Array(0);
  private scratchObs = new Float64Array(0);
  private scratchBias = new Float64Array(0);
  private readonly counters = { syncedRows: 0, lastSyncedRows: 0, evictedRows: 0, compactions: 0 };
  constructor(readonly batcher: PolicyGpuBatcher) {}
  get stats(): ResidentPolicyRegistryStats {
    return { calls: this.calls, residentActors: this.entries.size, highWater: this.highWater,
      freeSlots: this.free.length, ...this.counters };
  }
  evaluate(actors: readonly ResidentPolicyActor[]): Float64Array { return this.begin(actors).wait(); }

  begin(actors: readonly ResidentPolicyActor[]): PendingPolicyEvaluation {
    const count = actors.length;
    // The previous batch is completed first: its inputs live in the scratch
    // buffers reused below (and a CPU recomputation would read them).
    this.batcher.settle();
    // Eviction/compaction before the lookups, so no cached entry can be evicted.
    this.maintain(count);
    // Validate everything before touching registry state, so a rejected batch
    // can never leave an entry that claims an unsynchronised slot. Duplicates are
    // detected with a per-batch stamp on known entries (no Set of every id).
    const stamp = ++this.stamps;
    const found = this.found.length >= count ? this.found : (this.found = new Array<ResidentEntry | undefined>(count));
    let newIds: Set<string> | null = null;
    for (let i = 0; i < count; i++) {
      const actor = actors[i]!;
      if (typeof actor.id !== 'string') throw new TypeError('Resident policy actor id must be a string');
      if (!(actor.obs instanceof Float64Array) || actor.obs.length !== ROW) throw new RangeError('Invalid observations length');
      if (!(actor.bias instanceof Float64Array) || actor.bias.length !== ROW) throw new RangeError('Invalid plasticity biases length');
      const entry = this.entries.get(actor.id);
      found[i] = entry;
      if (entry !== undefined) {
        if (entry.mark === stamp) throw new RangeError('Duplicated actor id in resident policy batch');
        entry.mark = stamp;
      } else {
        newIds ??= new Set<string>();
        if (newIds.has(actor.id)) throw new RangeError('Duplicated actor id in resident policy batch');
        newIds.add(actor.id);
      }
      if (entry === undefined || entry.weights !== actor.weights) {
        const w = actor.weights;
        if (!Array.isArray(w) || w.length !== POLICY_WEIGHTS) throw new RangeError('Invalid policy weights length');
        for (let j = 0; j < POLICY_WEIGHTS; j++) if (!(w[j]! >= -1 && w[j]! <= 1)) throw new RangeError('Invalid policy weights');
      }
    }
    const call = ++this.calls;
    if (this.scratchSlots.length < count) {
      const cap = Math.max(count, this.scratchSlots.length * 2, 64);
      this.scratchSlots = new Uint32Array(cap); this.scratchObs = new Float64Array(cap * ROW); this.scratchBias = new Float64Array(cap * ROW);
    }
    const slots = this.scratchSlots.subarray(0, count), obs = this.scratchObs.subarray(0, count * ROW), bias = this.scratchBias.subarray(0, count * ROW);
    const newSlots: number[] = [], newWeights: (readonly number[])[] = [];
    for (let i = 0; i < count; i++) {
      const actor = actors[i]!;
      let entry = found[i];
      found[i] = undefined;
      if (entry === undefined || entry.weights !== actor.weights) {
        const slot = entry !== undefined ? entry.slot : (this.free.pop() ?? this.highWater++);
        entry = { slot, weights: actor.weights, seen: call, mark: stamp };
        this.entries.set(actor.id, entry);
        newSlots.push(slot); newWeights.push(actor.weights);
      } else entry.seen = call;
      slots[i] = entry.slot;
      // Plain indexed copy: measurably cheaper than 2 × count small TypedArray.set calls.
      const o = actor.obs, b = actor.bias, k = i * ROW;
      for (let j = 0; j < ROW; j++) { obs[k + j] = o[j]!; bias[k + j] = b[j]!; }
    }
    if (newSlots.length > 0) {
      const rows = new Float64Array(newSlots.length * POLICY_WEIGHTS);
      for (let i = 0; i < newWeights.length; i++) rows.set(newWeights[i]!, i * POLICY_WEIGHTS);
      this.batcher.syncResidentWeights(Uint32Array.from(newSlots), rows, Math.max(1, this.highWater));
    }
    this.counters.syncedRows += newSlots.length; this.counters.lastSyncedRows = newSlots.length;
    return this.batcher.beginEvaluateResident(slots, obs, bias, count);
  }

  /** Eviction and compaction happen BEFORE a batch is built: a slot freed here was
   * last referenced by an already-drained batch, never by the one in flight. */
  private maintain(count: number): void {
    // Scan when the registry outgrows twice the last live estimate, and at least
    // every SCAN_EVERY batches so a die-off is noticed even without growth.
    const due = this.calls - this.lastScan >= ResidentPolicyRegistry.SCAN_EVERY;
    if (!due && this.entries.size <= 2 * Math.max(this.liveAtScan, count, 1)) return;
    this.lastScan = this.calls;
    const horizon = this.calls - ResidentPolicyRegistry.STALE_CALLS;
    let live = 0;
    for (const entry of this.entries.values()) if (entry.seen > horizon) live++;
    if (this.entries.size > 2 * live) {
      for (const [id, entry] of this.entries) {
        if (entry.seen > horizon) continue;
        this.entries.delete(id); this.free.push(entry.slot); this.counters.evictedRows++;
      }
    }
    this.liveAtScan = Math.max(live, this.entries.size);
    if (this.highWater > ResidentPolicyRegistry.MIN_COMPACT_ROWS && this.highWater > 2 * this.entries.size) this.compact();
  }
  private compact(): void {
    const ordered = [...this.entries.values()].sort((a, b) => a.slot - b.slot);
    const n = ordered.length;
    const slots = new Uint32Array(n), rows = new Float64Array(n * POLICY_WEIGHTS);
    for (let i = 0; i < n; i++) { ordered[i]!.slot = i; slots[i] = i; rows.set(ordered[i]!.weights, i * POLICY_WEIGHTS); }
    this.batcher.syncResidentWeights(slots, rows, Math.max(1, n), true);
    this.free = []; this.highWater = n;
    this.counters.compactions++; this.counters.syncedRows += n;
  }
}

const cachedPolicyBatchers = new Map<string, PolicyGpuBatcher>();
const residentRegistries = new WeakMap<PolicyGpuBatcher, ResidentPolicyRegistry>();
function cachedBatcher(devices: readonly number[]): PolicyGpuBatcher {
  const key = devices.join(',');
  let batcher = cachedPolicyBatchers.get(key);
  if (!batcher) {
    batcher = new PolicyGpuBatcher(devices);
    cachedPolicyBatchers.set(key, batcher);
  }
  return batcher;
}

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
  return cachedBatcher(devices).evaluate(observations, weights, plasticityBiases, count);
}

/**
 * Igual que `evaluatePoliciesBatch`, pero con la tabla de pesos RESIDENTE en VRAM: cada actor
 * nuevo (o con genoma nuevo) se sube una sola vez (`sync_weights`) y los pasos siguientes solo
 * envían slots + observaciones + sesgos. Salida en el orden de `actors`. Sin dispositivos o sin
 * NVRTC: `evaluatePoliciesCpu` con paridad `Object.is` exacta.
 */
export function evaluatePoliciesResidentBatch(
  actors: readonly ResidentPolicyActor[],
  devices: readonly number[],
): Float64Array {
  if (devices.length === 0) {
    const count = actors.length;
    const obs = new Float64Array(count * ROW), weights = new Float64Array(count * POLICY_WEIGHTS), bias = new Float64Array(count * ROW);
    for (let i = 0; i < count; i++) {
      const a = actors[i]!;
      if (a.obs.length !== ROW || a.bias.length !== ROW || a.weights.length !== POLICY_WEIGHTS) throw new RangeError('Invalid resident policy actor');
      obs.set(a.obs, i * ROW); weights.set(a.weights, i * POLICY_WEIGHTS); bias.set(a.bias, i * ROW);
    }
    return evaluatePoliciesCpu(obs, weights, bias, count);
  }
  return residentPolicyRegistry(devices).evaluate(actors);
}

/** Registro de slots residentes del batcher persistente de `devices` (para bancos y diagnóstico). */
export function residentPolicyRegistry(devices: readonly number[]): ResidentPolicyRegistry {
  const batcher = cachedBatcher(devices);
  let registry = residentRegistries.get(batcher);
  if (!registry) { registry = new ResidentPolicyRegistry(batcher); residentRegistries.set(batcher, registry); }
  return registry;
}

/** Diagnóstico de los batchers GPU de políticas actualmente abiertos (solo lectura). */
export function policyGpuBatcherStatus(devices: readonly number[]): { backend: 'cpu' | 'gpu'; fallbackReason: string | null } | null {
  const batcher = cachedPolicyBatchers.get(devices.join(','));
  return batcher ? { backend: batcher.backend, fallbackReason: batcher.fallbackReason } : null;
}

/** Diagnóstico residente (tabla de pesos y registro) del batcher de `devices`, si existe. */
export function policyGpuResidentStatus(devices: readonly number[]): {
  backend: 'cpu' | 'gpu'; fallbackReason: string | null; table: PolicyResidentStats; registry: ResidentPolicyRegistryStats | null;
} | null {
  const batcher = cachedPolicyBatchers.get(devices.join(','));
  if (!batcher) return null;
  return { backend: batcher.backend, fallbackReason: batcher.fallbackReason, table: batcher.residentStats,
    registry: residentRegistries.get(batcher)?.stats ?? null };
}

/** Cierra todos los batchers GPU persistentes de políticas (tests y cierre ordenado del servidor). */
export function closePolicyGpuBatchers(): void {
  for (const batcher of cachedPolicyBatchers.values()) batcher.close();
  cachedPolicyBatchers.clear();
}
