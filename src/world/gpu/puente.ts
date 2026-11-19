import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SharedTerrain } from '../soa/terreno.js';
import type { WorldParams } from '../params.js';

export const GPU_FIELDS = [
  { name: 'moisture', bytes: 8 }, { name: 'vegetation', bytes: 8 }, { name: 'food', bytes: 8 },
  { name: 'wood', bytes: 8 }, { name: 'growth', bytes: 8 }, { name: 'fertility', bytes: 8 },
  { name: 'cultivation', bytes: 8 }, { name: 'traffic', bytes: 8 }, { name: 'drinkingWater', bytes: 8 },
  { name: 'terrain', bytes: 1 }, { name: 'biome', bytes: 1 }, { name: 'feature', bytes: 1 },
  { name: 'life', bytes: 8 },
] as const;

export interface GpuBridgeStats {
  uploadedBytes: number; downloadedBytes: number; syncUploadedBytes: number;
  kernelMs: number; devices: readonly number[]; lastPass: 'ecologia' | 'kernel' | null;
}
export interface GpuRunResult extends GpuBridgeStats {
  dirtyPages: readonly { pageX: number; pageY: number }[];
}
interface TopologyKey { version: number; pageSetVersion: number; capacityCells: number; slots: number; totalCells: number; regionSide: number; }

const WORKER_CODE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const control = new Int32Array(workerData.control);
const stats = new Float64Array(workerData.stats);
const errors = new Uint16Array(workerData.errors);
const FIELDS = workerData.fields;
const FIELD_BY_NAME = Object.fromEntries(FIELDS.map(f => [f.name, f]));
const DOWNLOAD_FIELDS = {
  1: ['moisture', 'vegetation', 'food'],
  2: FIELDS.map(f => f.name).filter(n => n !== 'food' && n !== 'terrain' && n !== 'biome'),
  '2_halo': FIELDS.map(f => f.name).filter(n => n !== 'terrain' && n !== 'biome'),
};
function runsOf(sorted) {
  const runs = [];
  for (const s of sorted) {
    const last = runs[runs.length - 1];
    if (last && s === last[0] + last[1]) last[1]++;
    else runs.push([s, 1]);
  }
  return runs;
}
let child = null, reader = null, readyPromise = null, dead = null;
let shmFd = null, shmReadBuf = null, shmPath = null, cachedBuffers = null;
const MAX_IO_CHUNK = 1 << 29; // 512 MiB (< 2 GiB limit of Node fs.writeSync/readSync)
function shmWriteParts(parts) {
  let pos = 0;
  for (const part of parts) {
    let off = 0;
    while (off < part.byteLength) {
      const chunk = Math.min(MAX_IO_CHUNK, part.byteLength - off);
      off += fs.writeSync(shmFd, part, off, chunk, pos);
      pos = pos + chunk;
    }
  }
  return pos;
}
function shmReadRange(offset, n) {
  if (!shmReadBuf || shmReadBuf.length < n) shmReadBuf = Buffer.allocUnsafe(n);
  let off = 0;
  while (off < n) {
    const chunk = Math.min(MAX_IO_CHUNK, n - off);
    const r = fs.readSync(shmFd, shmReadBuf, off, chunk, offset + off);
    if (r <= 0) throw new Error('GPU shm: lectura corta');
    off += r;
  }
  return shmReadBuf.subarray(0, n);
}
class Reader {
  constructor(stream){ this.chunks=[]; this.offset=0; this.available=0; this.done=false; this.waiter=null; this.error=null;
    stream.on('data',c=>{this.chunks.push(c); this.available+=c.length; this.wake();});
    stream.on('end',()=>{this.done=true; this.wake();});
    stream.on('error',e=>{this.error=e; this.done=true; this.wake();}); }
  wake(){ if(this.waiter){ const w=this.waiter; this.waiter=null; w(); } }
  async read(n){ while(this.available<n){ if(this.done) throw this.error||new Error('GPU resident worker closed before reply'); await new Promise(r=>{this.waiter=r;}); }
    const out=Buffer.allocUnsafe(n); let copied=0;
    while(copied<n){ const head=this.chunks[0]; const amt=Math.min(n-copied, head.length-this.offset); head.copy(out,copied,this.offset,this.offset+amt); copied+=amt; this.offset+=amt; if(this.offset===head.length){this.chunks.shift(); this.offset=0;} }
    this.available-=n; return out; }
  async frame(){ const size=(await this.read(4)).readUInt32LE(); if(size>16777216) throw new Error('Oversized GPU reply header');
    const header=JSON.parse((await this.read(size)).toString()); if(header.error) throw new Error(header.error);
    if(header.shmBytes) { if(shmFd===null) throw new Error('GPU shm: respuesta shmBytes sin canal abierto'); return {header, body: null, shmBytes: header.shmBytes}; }
    const body=await this.read(header.bytes||0); return {header, body}; }
}
function start(){
  child = spawn('python3', [workerData.scriptPath, '--devices', workerData.devices.join(','), '--nvrtc', workerData.nvrtc], {stdio:['pipe','pipe','pipe']});
  let stderr='';
  child.stderr.on('data',c=>{ stderr=(stderr+c.toString()).slice(-4096); });
  reader = new Reader(child.stdout);
  child.on('error', e=>{ dead=e; if(reader){reader.error=e; reader.done=true; reader.wake();} });
  child.on('close', (code,signal)=>{ if(shmPath){ try{fs.unlinkSync(shmPath);}catch{} } if(!workerData.closing){ dead=new Error('GPU resident subprocess exited code='+code+' signal='+signal+' '+stderr); if(reader){reader.error=dead; reader.done=true; reader.wake();} } });
  child.stdin.on('error', e=>{ if(reader){reader.error=e; reader.done=true; reader.wake();} });
  readyPromise = reader.frame().then(f=>{ if(!f.header.ready) throw new Error('GPU resident worker not ready'); workerData.readyInfo=f.header;
    if(f.header.shmPath) { shmPath = f.header.shmPath; try { shmFd = fs.openSync(f.header.shmPath, 'r+'); } catch(e) { throw new Error('GPU shm: no se pudo abrir '+f.header.shmPath+': '+e.message); } }
    return f.header; });
  return readyPromise;
}
async function send(header, body){
  if(dead) throw dead;
  if(!child || !child.stdin || !child.stdin.writable || child.stdin.destroyed) throw dead||new Error('GPU resident subprocess stdin is closed');
  const parts = Array.isArray(body) ? body : (body && body.byteLength ? [body] : []);
  const totalBytes = parts.reduce((s, p) => s + p.byteLength, 0);
  const useShm = shmFd !== null && totalBytes > 0;
  if(useShm) {
    let pos = 0;
    for (const part of parts) {
      let off = 0;
      while (off < part.byteLength) {
        const chunk = Math.min(MAX_IO_CHUNK, part.byteLength - off);
        const w = fs.writeSync(shmFd, part, off, chunk, pos + off);
        off += w;
      }
      pos += part.byteLength;
    }
  }
  const raw=Buffer.from(JSON.stringify(useShm ? {...header, bytes: 0, shmBytes: totalBytes} : {...header, bytes: totalBytes, shmBytes: 0})); const prefix=Buffer.alloc(4); prefix.writeUInt32LE(raw.length);
  child.stdin.write(prefix); child.stdin.write(raw);
  if(totalBytes && !useShm) { for (const part of parts) child.stdin.write(part); }
  return reader.frame();
}
function view(buffers, name, bytes){
  const buf=buffers[name]; if(!buf) throw new Error('Missing resident buffer '+name);
  return bytes===8 ? new Float64Array(buf) : new Uint8Array(buf);
}
function bytesOf(buffers,name){ const buf=buffers[name]; return new Uint8Array(buf); }
async function handle(job){
  await readyPromise;
  if(dead) throw dead;
  if(job.buffers) cachedBuffers = job.buffers;
  const buffers = cachedBuffers;
  let uploaded=0, downloaded=0;
  const capacity=job.capacityCells, slots=job.slots, total=job.totalCells;
  if(job.syncNeeded){
    const parts=[];
    const push=(u8)=>parts.push(Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength));
    push(new Uint8Array(buffers.cells)); push(new Uint8Array(buffers.stamps)); push(new Uint8Array(buffers.around)); push(new Uint8Array(buffers.pageX)); push(new Uint8Array(buffers.pageY));
    for(const f of FIELDS) push(bytesOf(buffers,f.name));
    const reply=await send({kind:'sync', capacityCells:capacity, slots, totalCells:total, shardRanges: job.sharded ? job.ranges : null}, parts);
    if(!reply.header.ok) throw new Error('GPU sync failed');
    uploaded += reply.header.uploadedBytes||0; stats[2]=uploaded;
  }
  const syncUploaded = uploaded;
  if(job.kind==='tick'){
    const perPage = FIELDS.reduce((s,f)=>s+256*f.bytes,0);
    const body = Buffer.alloc(job.dirtySlots.length * perPage);
    let off = 0;
    const dirtyRuns = runsOf(job.dirtySlots);
    for(const f of FIELDS){
      const src = bytesOf(buffers, f.name);
      for(const [startSlot, count] of dirtyRuns){
        const start = startSlot * 256 * f.bytes; const len = count * 256 * f.bytes;
        body.set(src.subarray(start, start + len), off); off += len;
      }
    }
    const reply = await send({
      kind: 'tick', dirtySlots: job.dirtySlots, ranges: job.ranges,
      haloSlotsPerDevice: job.haloSlotsPerDevice || [], downloadSlots: job.downloadSlots || [],
      pass1Params: job.pass1Params, pass2Params: job.pass2Params,
    }, body);
    if(!reply.header.ok) throw new Error('GPU tick failed');
    uploaded += reply.header.uploadedBytes || 0; downloaded += reply.header.downloadedBytes || 0;
    let boff = 0;
    const perDevice = reply.header.downloadSlotsPerDevice || [];
    const touched = new Set();
    for(let di = 0; di < perDevice.length; di++){
      const deviceSlots = perDevice[di];
      if(!deviceSlots || !deviceSlots.length) continue;
      for(const slot of deviceSlots) touched.add(slot);
      const deviceRuns = runsOf(deviceSlots);
      for(const f of FIELDS){
        const dst = bytesOf(buffers, f.name);
        for(const [startSlot, count] of deviceRuns){
          const start = startSlot * 256 * f.bytes; const len = count * 256 * f.bytes;
          const chunk = reply.shmBytes ? shmReadRange(boff, len) : reply.body.subarray(boff, boff + len);
          dst.set(chunk, start); boff += len;
        }
      }
    }
    const woodAdded = new Uint8Array(buffers.woodAdded); const queue = new Int32Array(buffers.woodAddedQueue); const dirty = new Uint8Array(buffers.dirty);
    const added = (reply.header.woodAddedSlots || []).slice().sort((a,b)=>a-b);
    for(const s of added) woodAdded[s] = 1;
    Atomics.store(queue, 0, 1); Atomics.store(queue, 1, added.length); added.forEach((s,i)=>Atomics.store(queue, 2+i, s));
    for(const s of touched) dirty[s] = 1;
    stats[0] = uploaded; stats[1] = downloaded; stats[2] = syncUploaded;
    const devs = reply.header.devices || []; stats[3] = devs.reduce((s,d)=>Math.max(s, d.kernelMs || 0), 0);
    return {touched: [...touched].sort((a,b)=>a-b)};
  }
  if(job.kind==='flush'){
    const reply=await send({kind:'flush', ranges:job.ranges}, null);
    if(!reply.header.ok) throw new Error('GPU flush failed');
    let boff=0;
    const perDeviceRuns = reply.header.downloadRunsPerDevice || (reply.header.downloadSlotsPerDevice||[]).map(slots=>runsOf(slots));
    for(let di=0; di<perDeviceRuns.length; di++){
      const deviceRuns = perDeviceRuns[di];
      for(const f of FIELDS){
        const dst=bytesOf(buffers,f.name);
        for(const [startSlot,count] of deviceRuns){
          const start=startSlot*256*f.bytes; const len=count*256*f.bytes;
          const chunk = reply.shmBytes ? shmReadRange(boff, len) : reply.body.subarray(boff,boff+len);
          dst.set(chunk,start); boff+=len;
        }
      }
    }
    return {touched:[]};
  }
  // step body: dirty chunks
  const perPage = FIELDS.reduce((s,f)=>s+256*f.bytes,0);
  const haloField = job.pass===1 ? 'terrain' : 'life';
  const haloSpec = FIELDS.find(f=>f.name===haloField);
  const haloBytes = (job.haloSlotsPerDevice||[]).reduce((s,l)=>s+l.length*256*haloSpec.bytes,0);
  const body=Buffer.alloc(job.dirtySlots.length*perPage + (job.pass===2 ? slots : 0) + haloBytes);
  let off=0;
  // Subida coalescida: por campo y por tramo contiguo de dirtySlots (ordenados).
  const dirtyRuns = runsOf(job.dirtySlots);
  for(const f of FIELDS){ const src=bytesOf(buffers,f.name); for(const [startSlot,count] of dirtyRuns){ const start=startSlot*256*f.bytes; const len=count*256*f.bytes; body.set(src.subarray(start,start+len),off); off+=len; } }
  if(job.pass===2){ body.set(bytesOf(buffers,'woodAdded').subarray(0,slots),off); off+=slots; }
  for(const lst of (job.haloSlotsPerDevice||[])){ for(const slot of lst){ const src=bytesOf(buffers,haloField); const start=slot*256*haloSpec.bytes; body.set(src.subarray(start,start+256*haloSpec.bytes),off); off+=256*haloSpec.bytes; } }
  const reply=await send({kind:'step', pass:job.pass, dirtySlots:job.dirtySlots, ranges:job.ranges, haloSlotsPerDevice:job.haloSlotsPerDevice||[], haloField, downloadSlots:job.downloadSlots, params:job.params}, body);
  if(!reply.header.ok) throw new Error('GPU step failed');
  uploaded += reply.header.uploadedBytes||0; downloaded += reply.header.downloadedBytes||0;
  // Bajada selectiva coalescida: solo los campos de la pasada, por campo y por tramo.
  // Los campos no descargados se copian front->back en RAM local para los tramos tocados.
  let boff=0;
  const perDevice = reply.header.downloadSlotsPerDevice||[];
  const dlKey = (job.downloadSlots !== undefined && job.downloadSlots !== null && job.pass === 2) ? '2_halo' : job.pass;
  const dlNames = DOWNLOAD_FIELDS[dlKey] || FIELDS.map(f=>f.name);
  const dlSet = new Set(dlNames);
  const touched=new Set();
  for(let di=0; di<perDevice.length; di++){
    const deviceSlots = perDevice[di];
    if(!deviceSlots || !deviceSlots.length) continue;
    for(const slot of deviceSlots) touched.add(slot);
    const deviceRuns = runsOf(deviceSlots);
    for(const name of dlNames){ const f=FIELD_BY_NAME[name]; const dst=bytesOf(buffers,name+'Back'); for(const [startSlot,count] of deviceRuns){ const start=startSlot*256*f.bytes; const len=count*256*f.bytes; const chunk = reply.shmBytes ? shmReadRange(boff, len) : reply.body.subarray(boff,boff+len); dst.set(chunk,start); boff+=len; } }
    for(const f of FIELDS){ if(dlSet.has(f.name)) continue; const src=bytesOf(buffers,f.name); const dst=bytesOf(buffers,f.name+'Back'); for(const [startSlot,count] of deviceRuns){ const start=startSlot*256*f.bytes; const len=count*256*f.bytes; dst.set(src.subarray(start,start+len),start); } }
  }
  // woodAdded + queue + dirty (CPU-side deterministic queue, slots ascending)
  const woodAdded=new Uint8Array(buffers.woodAdded); const queue=new Int32Array(buffers.woodAddedQueue); const dirty=new Uint8Array(buffers.dirty);
  if(job.pass===2){ const added=(reply.header.woodAddedSlots||[]).slice().sort((a,b)=>a-b); for(const s of added) woodAdded[s]=1; Atomics.store(queue,0,1); Atomics.store(queue,1,added.length); added.forEach((s,i)=>Atomics.store(queue,2+i,s)); }
  else { Atomics.store(queue,0,1); Atomics.store(queue,1,0); }
  for(const s of touched) dirty[s]=1;
  stats[0]=uploaded; stats[1]=downloaded; stats[2]=syncUploaded;
  const devs=reply.header.devices||[]; stats[3]=devs.reduce((s,d)=>Math.max(s,d.kernelMs||0),0);
  return {touched:[...touched].sort((a,b)=>a-b)};
}
parentPort.on('message', async job=>{
  if(job.kind==='close'){ try{ workerData.closing=true; if(child){ child.stdin.end(); setTimeout(()=>{ try{child.kill('SIGKILL');}catch{} },500); } if(shmFd!==null){ try{fs.closeSync(shmFd);}catch{} shmFd=null; } }catch{} Atomics.store(control,0,1); Atomics.notify(control,0); return; }
  if(job.kind==='kill'){ try{ if(child) child.kill('SIGKILL'); }catch{} Atomics.store(control,0,2); const msg='GPU resident subprocess killed by test'; for(let i=0;i<msg.length;i++) errors[i]=msg.charCodeAt(i); errors[msg.length]=0; Atomics.notify(control,0); return; }
  try{ const result=await handle(job); workerData.lastTouched=result.touched; Atomics.store(control,0,1); }
  catch(e){ const msg=(e&&e.stack||String(e)).slice(0,4000); for(let i=0;i<msg.length;i++) errors[i]=msg.charCodeAt(i); errors[msg.length]=0; Atomics.store(control,0,2); }
  Atomics.notify(control,0);
});
start();
`;

function resolveNvrtc(): string {
  const fromEnv = process.env.COMPUTE_NVRTC;
  if (fromEnv) return fromEnv;
  if (existsSync('/opt/cuda/lib64/libnvrtc.so')) return '/opt/cuda/lib64/libnvrtc.so';
  throw new Error('COMPUTE_NVRTC no está definido y /opt/cuda/lib64/libnvrtc.so no existe: backend GPU no disponible.');
}
function resolveScript(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    new URL('../../../scripts/compute-ecology-gpu-resident.py', import.meta.url),
    new URL('../../../../scripts/compute-ecology-gpu-resident.py', import.meta.url),
  ];
  for (const c of candidates) if (existsSync(fileURLToPath(c))) return fileURLToPath(c);
  throw new Error(`No se encontró compute-ecology-gpu-resident.py cerca de ${here}`);
}

/** Puente GPU persistente (T122): un worker JS que posee un subproceso Python con VRAM residente. */
export class ResidentGpuBridge {
  readonly devices: readonly number[];
  private readonly worker: Worker;
  private readonly control = new Int32Array(new SharedArrayBuffer(4 * 8));
  private readonly statsArr = new Float64Array(new SharedArrayBuffer(8 * 8));
  private readonly errorArr = new Uint16Array(new SharedArrayBuffer(4096 * 2));
  private synced: TopologyKey | null = null;
  private cachedRanges: [number, number][] = [];
  private cachedHaloSlotsPerDevice: number[][] = [];
  private cachedAllHaloSlots: number[] = [];
  private broken: Error | null = null;
  private closed = false;
  private readonly customWeights?: readonly number[];
  private readonly shardedOption?: boolean;
  #last: GpuBridgeStats;
  #cumulative = { uploadedBytes: 0, downloadedBytes: 0 };
  /** Test hook: last python ready header (devices/arch/compile). */
  readyInfo: unknown = null;

  constructor(devices: readonly number[], options?: { weights?: readonly number[]; sharded?: boolean }) {
    if (!devices.length || devices.some(d => !Number.isSafeInteger(d) || d < 0) || new Set(devices).size !== devices.length)
      throw new RangeError('gpu debe ser una lista no vacía de dispositivos enteros sin duplicados.');
    this.devices = [...devices];
    this.customWeights = options?.weights;
    this.shardedOption = options?.sharded;
    this.#last = { uploadedBytes: 0, downloadedBytes: 0, syncUploadedBytes: 0, kernelMs: 0, devices: this.devices, lastPass: null };
    this.worker = new Worker(WORKER_CODE, {
      eval: true, execArgv: [], name: 'atlas-gpu-resident',
      workerData: {
        scriptPath: resolveScript(), nvrtc: resolveNvrtc(), devices: this.devices,
        control: this.control.buffer, stats: this.statsArr.buffer, errors: this.errorArr.buffer,
        fields: GPU_FIELDS.map(f => ({ name: f.name, bytes: f.bytes })),
      },
    });
    this.worker.unref();
  }
  get lastStats(): GpuBridgeStats { return this.#last; }
  get cumulativeStats(): Readonly<{ uploadedBytes: number; downloadedBytes: number }> { return this.#cumulative; }
  /** Fuerza una resincronización completa en el próximo paso (tras un fallo o un cambio externo). */
  invalidate(): void { this.synced = null; }

  private ranges(cells: Int32Array, total: number): [number, number][] {
    if (this.devices.length === 1 || total === 0) return [[0, total]];
    // Peso medido en la torre: 5070 Ti ≈79%, 2060 ≈21% (T122/T124). Con otros pares, a partes iguales.
    const weights = (this.customWeights && this.customWeights.length === this.devices.length)
      ? [...this.customWeights]
      : this.devices.map(d => this.devices.includes(0) && this.devices.includes(1) ? (d === 0 ? 0.79 : d === 1 ? 0.21 : 1 / this.devices.length) : 1 / this.devices.length);
    const sum = weights.reduce((a, b) => a + b, 0);
    const ranges: [number, number][] = []; let begin = 0; let acc = 0;
    for (let i = 0; i < this.devices.length; i++) {
      acc += weights[i]! / sum;
      let end = i === this.devices.length - 1 ? total : Math.round(total * acc);
      if (i < this.devices.length - 1 && end > begin && end < total) {
        // Redondeo a páginas completas: ninguna página se parte entre dispositivos.
        let snapped = end;
        const slotAt = (idx: number) => cells[idx]! >>> 8;
        if (slotAt(end) === slotAt(end - 1)) {
          let fwd = end; while (fwd < total && slotAt(fwd) === slotAt(end - 1)) fwd++;
          let back = end; while (back > begin && slotAt(back - 1) === slotAt(end - 1)) back--;
          snapped = (fwd - end <= end - back && fwd < total) || back === begin ? fwd : back;
          if (snapped <= begin || snapped >= total) snapped = fwd < total ? fwd : back;
        }
        end = Math.min(total, Math.max(begin, snapped));
      }
      ranges.push([begin, end]); begin = end;
    }
    return ranges;
  }

  run(terrain: SharedTerrain, pageSetVersion: number, pass: 'ecologia' | 'kernel', params: Record<string, unknown>, regionSide: number = 256, options?: { downloadSlots?: readonly number[] }): GpuRunResult {
    if (this.closed) throw new Error('ResidentGpuBridge cerrado.');
    if (this.broken) throw this.broken;
    const buffers = terrain.buffers;
    const cells = new Int32Array(buffers.cells!);
    const stampsBuf = buffers.stamps!; const pageX = new Int32Array(buffers.pageX!);
    const capacityCells = stampsBuf.byteLength / 4, slots = pageX.length, totalCells = cells.length;
    if (capacityCells > 134_217_728) throw new RangeError('Capacidad por encima de MAX_CELLS (134_217_728).');
    const key: TopologyKey = { version: terrain.version, pageSetVersion, capacityCells, slots, totalCells, regionSide };
    const syncNeeded = !this.synced || this.synced.version !== key.version || this.synced.pageSetVersion !== key.pageSetVersion
      || this.synced.capacityCells !== key.capacityCells || this.synced.slots !== key.slots || this.synced.totalCells !== key.totalCells
      || this.synced.regionSide !== key.regionSide;
    const dirtyArr = new Uint8Array(buffers.dirty!);
    const dirtySlots: number[] = [];
    for (let s = 0; s < dirtyArr.length; s++) if (dirtyArr[s]) dirtySlots.push(s);
    if (syncNeeded) {
      this.cachedRanges = this.ranges(cells, totalCells);
      if (this.devices.length <= 1) {
        this.cachedHaloSlotsPerDevice = this.cachedRanges.map(() => []);
        this.cachedAllHaloSlots = [];
      } else {
        const around = new Int32Array(buffers.around!);
        this.cachedHaloSlotsPerDevice = this.cachedRanges.map(([begin, end]) => {
          const assigned = new Uint8Array(slots);
          for (let i = begin; i < end; i++) assigned[cells[i]! >>> 8] = 1;
          const halo = new Set<number>();
          for (let slot = 0; slot < slots; slot++) if (assigned[slot]) for (let k = 0; k < 9; k++) { const nb = around[slot * 9 + k]!; if (nb >= 0 && !assigned[nb]) halo.add(nb); }
          return [...halo].sort((a, b) => a - b);
        });
        const union = new Set<number>();
        for (const lst of this.cachedHaloSlotsPerDevice) for (const s of lst) union.add(s);
        this.cachedAllHaloSlots = [...union].sort((a, b) => a - b);
      }
    }
    const ranges = this.cachedRanges;
    const haloSlotsPerDevice = this.cachedHaloSlotsPerDevice;
    let downloadSlots: number[] | undefined;
    if (options?.downloadSlots !== undefined) {
      if (pass === 'kernel' && this.cachedAllHaloSlots.length > 0) {
        const set = new Set<number>(options.downloadSlots);
        for (const s of this.cachedAllHaloSlots) set.add(s);
        downloadSlots = [...set].sort((a, b) => a - b);
      } else {
        downloadSlots = [...options.downloadSlots].sort((a, b) => a - b);
      }
    }
    const sharded = this.devices.length > 1 && (this.shardedOption ?? (capacityCells > 16_000_000));
    Atomics.store(this.control, 0, 0);
    this.statsArr.fill(0);
    try {
      this.worker.postMessage({
        kind: 'step', pass: pass === 'ecologia' ? 1 : 2, buffers, dirtySlots, ranges, haloSlotsPerDevice,
        downloadSlots, capacityCells, slots, totalCells, syncNeeded, sharded, params,
      });
    } catch (error) { this.synced = null; throw error; }
    // Espera síncrona (mismo patrón que StaticWorkerPool): el worker hace el IPC async con Python.
    const waitStarted = Date.now();
    for (;;) {
      const status = Atomics.load(this.control, 0);
      if (status === 1) break;
      if (status === 2 || Date.now() - waitStarted > 120000) {
        let msg = ''; for (let i = 0; i < this.errorArr.length && this.errorArr[i]; i++) msg += String.fromCharCode(this.errorArr[i]!);
        this.synced = null; this.broken = new Error(`ResidentGpuBridge: ${msg || 'timeout esperando al subproceso GPU'}`);
        throw this.broken;
      }
      Atomics.wait(this.control, 0, 0, 5000);
    }
    const uploadedBytes = this.statsArr[0]!, downloadedBytes = this.statsArr[1]!, syncUploadedBytes = this.statsArr[2]!;
    this.#last = { uploadedBytes, downloadedBytes, syncUploadedBytes, kernelMs: this.statsArr[3]!, devices: this.devices, lastPass: pass };
    this.#cumulative.uploadedBytes += uploadedBytes; this.#cumulative.downloadedBytes += downloadedBytes;
    this.synced = key;
    // Páginas tocadas para la barrera, y limpieza: los actores re-marcarán solo lo que toquen.
    const dirtyPages: { pageX: number; pageY: number }[] = [];
    const pageY = new Int32Array(buffers.pageY!);
    // dirty fue marcado por el worker para las páginas descargadas; capturarlo antes de limpiar.
    for (let s = 0; s < dirtyArr.length; s++) if (dirtyArr[s]) dirtyPages.push({ pageX: pageX[s]!, pageY: pageY[s]! });
    dirtyArr.fill(0);
    return { ...this.#last, dirtyPages };
  }

  /**
   * T122 opción (b): ejecuta las dos pasadas del tick ecológico (`ecology_pass1` + `ecology_pass2`)
   * en VRAM sobre la misma cola CUDA y descarga solo los halos de consumidores CPU activos
   * (`downloadSlots`), manteniendo el resto del mundo autoritativo en VRAM hasta `flushToHost()`.
   */
  runTick(terrain: SharedTerrain, pageSetVersion: number, pass1Params: Record<string, unknown>, pass2Params: Record<string, unknown>, regionSide: number = 256, options?: { downloadSlots?: readonly number[] }): GpuRunResult {
    if (this.closed) throw new Error('ResidentGpuBridge cerrado.');
    if (this.broken) throw this.broken;
    const buffers = terrain.buffers;
    const cells = new Int32Array(buffers.cells!);
    const stampsBuf = buffers.stamps!; const pageX = new Int32Array(buffers.pageX!);
    const capacityCells = stampsBuf.byteLength / 4, slots = pageX.length, totalCells = cells.length;
    if (capacityCells > 134_217_728) throw new RangeError('Capacidad por encima de MAX_CELLS (134_217_728).');
    const key: TopologyKey = { version: terrain.version, pageSetVersion, capacityCells, slots, totalCells, regionSide };
    const syncNeeded = !this.synced || this.synced.version !== key.version || this.synced.pageSetVersion !== key.pageSetVersion
      || this.synced.capacityCells !== key.capacityCells || this.synced.slots !== key.slots || this.synced.totalCells !== key.totalCells
      || this.synced.regionSide !== key.regionSide;
    const dirtyArr = new Uint8Array(buffers.dirty!);
    const dirtySlots: number[] = [];
    for (let s = 0; s < dirtyArr.length; s++) if (dirtyArr[s]) dirtySlots.push(s);
    if (syncNeeded) {
      this.cachedRanges = this.ranges(cells, totalCells);
      if (this.devices.length <= 1) {
        this.cachedHaloSlotsPerDevice = this.cachedRanges.map(() => []);
        this.cachedAllHaloSlots = [];
      } else {
        const around = new Int32Array(buffers.around!);
        this.cachedHaloSlotsPerDevice = this.cachedRanges.map(([begin, end]) => {
          const assigned = new Uint8Array(slots);
          for (let i = begin; i < end; i++) assigned[cells[i]! >>> 8] = 1;
          const halo = new Set<number>();
          for (let slot = 0; slot < slots; slot++) if (assigned[slot]) for (let k = 0; k < 9; k++) { const nb = around[slot * 9 + k]!; if (nb >= 0 && !assigned[nb]) halo.add(nb); }
          return [...halo].sort((a, b) => a - b);
        });
        const union = new Set<number>();
        for (const lst of this.cachedHaloSlotsPerDevice) for (const s of lst) union.add(s);
        this.cachedAllHaloSlots = [...union].sort((a, b) => a - b);
      }
    }
    const downloadSlots = options?.downloadSlots ? [...options.downloadSlots].sort((a, b) => a - b) : [];
    const sharded = this.devices.length > 1 && (this.shardedOption ?? (capacityCells > 16_000_000));
    Atomics.store(this.control, 0, 0);
    this.statsArr.fill(0);
    try {
      this.worker.postMessage({
        kind: 'tick', buffers: syncNeeded ? buffers : undefined, dirtySlots,
        ranges: syncNeeded ? this.cachedRanges : undefined,
        haloSlotsPerDevice: syncNeeded ? this.cachedHaloSlotsPerDevice : undefined,
        downloadSlots, capacityCells, slots, totalCells, syncNeeded, sharded, pass1Params, pass2Params,
      });
    } catch (error) { this.synced = null; throw error; }
    const waitStarted = Date.now();
    for (;;) {
      const status = Atomics.load(this.control, 0);
      if (status === 1) break;
      if (status === 2 || Date.now() - waitStarted > 120000) {
        let msg = ''; for (let i = 0; i < this.errorArr.length && this.errorArr[i]; i++) msg += String.fromCharCode(this.errorArr[i]!);
        this.synced = null; this.broken = new Error(`ResidentGpuBridge tick: ${msg || 'timeout'}`);
        throw this.broken;
      }
      Atomics.wait(this.control, 0, 0, 5000);
    }
    const uploadedBytes = this.statsArr[0]!, downloadedBytes = this.statsArr[1]!, syncUploadedBytes = this.statsArr[2]!;
    this.#last = { uploadedBytes, downloadedBytes, syncUploadedBytes, kernelMs: this.statsArr[3]!, devices: this.devices, lastPass: 'kernel' };
    this.#cumulative.uploadedBytes += uploadedBytes; this.#cumulative.downloadedBytes += downloadedBytes;
    this.synced = key;
    const dirtyPages: { pageX: number; pageY: number }[] = [];
    const pageY = new Int32Array(buffers.pageY!);
    for (let s = 0; s < dirtyArr.length; s++) if (dirtyArr[s]) dirtyPages.push({ pageX: pageX[s]!, pageY: pageY[s]! });
    dirtyArr.fill(0);
    return { ...this.#last, dirtyPages };
  }

  /** Materializa en RAM del anfitrión todas las páginas autoritativas residentes en VRAM (T122 opción b). */
  flushToHost(terrain: SharedTerrain): void {
    if (this.closed) throw new Error('ResidentGpuBridge cerrado.');
    if (this.broken) throw this.broken;
    if (!this.synced) return;
    Atomics.store(this.control, 0, 0);
    this.worker.postMessage({
      kind: 'flush', buffers: terrain.buffers, ranges: this.cachedRanges,
      capacityCells: this.synced.capacityCells, slots: this.synced.slots, totalCells: this.synced.totalCells, syncNeeded: false,
    });
    const waitStarted = Date.now();
    for (;;) {
      const status = Atomics.load(this.control, 0);
      if (status === 1) break;
      if (status === 2 || Date.now() - waitStarted > 60000) {
        let msg = ''; for (let i = 0; i < this.errorArr.length && this.errorArr[i]; i++) msg += String.fromCharCode(this.errorArr[i]!);
        this.synced = null; this.broken = new Error(`ResidentGpuBridge flush: ${msg || 'timeout'}`);
        throw this.broken;
      }
      Atomics.wait(this.control, 0, 0, 5000);
    }
  }

  /** Mata el subproceso Python (para la prueba de aborto); el siguiente run() debe fallar antes del swap. */
  killSubprocessForTest(): void {
    Atomics.store(this.control, 0, 0);
    this.worker.postMessage({ kind: 'kill' });
    // No esperamos al worker: la muerte se observa en el siguiente run (o en este si el lector ya falló).
    this.synced = null;
    // Dar una oportunidad breve a que SIGKILL surta efecto sin bloquear el test indefinidamente.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (Atomics.load(this.control, 0) === 2) break;
      Atomics.wait(this.control, 0, 0, 50);
      // El worker marca error también cuando el lector de Python detecta el cierre; si no, el próximo run lo hará.
      break;
    }
    this.broken = null; // el fallo debe producirse en run(), no en el hook
  }

  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    try { this.worker.postMessage({ kind: 'close' }); } catch { /* worker ya muerto */ }
    await this.worker.terminate().catch(() => undefined);
  }
}

export function gpuNvrtcAvailable(): boolean {
  return !!process.env.COMPUTE_NVRTC || existsSync('/opt/cuda/lib64/libnvrtc.so');
}
export function gpuNvrtcSkipReason(): string {
  return 'COMPUTE_NVRTC no está definido y /opt/cuda/lib64/libnvrtc.so no existe: backend GPU omitido (skip, nunca pass).';
}
