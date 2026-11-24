import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SharedTerrain } from '../soa/terreno.js';
import type { WorldParams } from '../params.js';
import {
  ErrorDispositivo, type Dispositivo, type FrentePublico, type LotePercepcion,
  type Percepcion, type Percibidor, type Plan, type Terreno,
} from '../motor/contratos.js';
import { CanalCompartido } from './canal.js';
import { PercibidorGpu } from './percibir-gpu.js';

interface TransferenciaPercepcion {
  subidos: number;
  bajados: number;
  ms: number;
}
export interface LoteGpuMedido extends TransferenciaPercepcion {
  dispositivo: Dispositivo;
  actores: number;
}
interface TarjetaPercepcion {
  percibidor: Percibidor & { readonly ultimasTransferencias: TransferenciaPercepcion };
  cerrar(): void;
}
interface TramoPercepcion {
  desde: number;
  lote: LotePercepcion;
  tarjeta?: number;
}

/** F0 despacha, B2 reúne. Sólo el dueño puede confirmar los efectos de las propuestas. */
export class PuentePercepcion implements Percibidor {
  readonly dispositivo = 'cpu' as const;
  readonly #tasas: number[];
  readonly #apagadas = new Set<number>();
  #pendiente?: { tramos: TramoPercepcion[]; planes: readonly Plan[]; actores: number };
  #ultimos: LoteGpuMedido[] = [];
  #cerrado = false;

  constructor(private readonly cpu: Percibidor, private readonly tarjetas: readonly TarjetaPercepcion[]) {
    // Arranque de la torre según el spike. Cada tarjeta corrige la estimación con sus propios lotes.
    this.#tasas = tarjetas.map(({ percibidor }, i) => percibidor.dispositivo === 'gpu0' ? 16
      : percibidor.dispositivo === 'gpu1' ? 1 : 1 / (i + 1));
  }

  get ultimosLotes(): readonly LoteGpuMedido[] { return this.#ultimos; }

  #apagar(i: number): void {
    if (this.#apagadas.has(i)) return;
    this.#apagadas.add(i);
    this.tarjetas[i]!.cerrar();
  }

  #cancelar(tramos: readonly TramoPercepcion[]): void {
    for (const { tarjeta } of tramos) if (tarjeta !== undefined) this.#apagar(tarjeta);
  }

  lanzar(lote: LotePercepcion, planes: readonly Plan[]): void {
    if (this.#cerrado || this.#pendiente) throw new Error('El puente está cerrado o tiene un lote pendiente.');
    if (lote.slots.length !== lote.plan.length) throw new RangeError('Planes y slots desalineados.');
    const actores = lote.slots.length;
    const activas = this.#tasas.map((_, i) => i).filter(i => !this.#apagadas.has(i));
    const pesoTotal = activas.reduce((total, i) => total + this.#tasas[i]!, 0);
    let desde = 0, peso = 0;
    const tramos: TramoPercepcion[] = [];
    try {
      for (const i of activas) {
        peso += this.#tasas[i]!;
        const hasta = Math.round(actores * peso / pesoTotal);
        if (hasta <= desde) continue;
        const tramo = { tick: lote.tick, slots: lote.slots.subarray(desde, hasta), plan: lote.plan.subarray(desde, hasta) };
        try {
          this.tarjetas[i]!.percibidor.lanzar(tramo, planes);
          tramos.push({ desde, lote: tramo, tarjeta: i });
        } catch (error) {
          if (!(error instanceof ErrorDispositivo)) throw error;
          this.#apagar(i);
          tramos.push({ desde, lote: tramo });
        }
        desde = hasta;
      }
    } catch (error) {
      this.#cancelar(tramos);
      throw error;
    }
    if (!tramos.length) tramos.push({ desde: 0, lote });
    this.#pendiente = { tramos, planes, actores };
  }

  esperar(plazoMs: number): Percepcion {
    if (!Number.isFinite(plazoMs) || plazoMs < 0) throw new RangeError('Plazo de percepción inválido.');
    const pendiente = this.#pendiente;
    if (!pendiente) throw new Error('No hay lote de percepción pendiente.');
    this.#pendiente = undefined;
    try { return this.#reunir(pendiente, plazoMs); }
    catch (error) { this.#cancelar(pendiente.tramos); throw error; }
  }

  #reunir(pendiente: { tramos: TramoPercepcion[]; planes: readonly Plan[]; actores: number }, plazoMs: number): Percepcion {
    const fin = performance.now() + plazoMs;
    const { tramos, planes, actores } = pendiente;
    this.#ultimos = [];
    let reunida: Percepcion | undefined;
    for (const tramo of tramos) {
      const { desde, lote, tarjeta } = tramo;
      let percepcion: Percepcion | undefined;
      if (tarjeta !== undefined) {
        const gpu = this.tarjetas[tarjeta]!.percibidor;
        try {
          percepcion = gpu.esperar(Math.max(0, fin - performance.now()));
          const datos = gpu.ultimasTransferencias;
          const tasa = lote.slots.length / Math.max(0.001, datos.ms);
          this.#tasas[tarjeta] = 0.75 * this.#tasas[tarjeta]! + 0.25 * tasa;
          this.#ultimos.push({ dispositivo: gpu.dispositivo, actores: lote.slots.length, ...datos });
        } catch (error) {
          if (!(error instanceof ErrorDispositivo)) throw error;
          this.#apagar(tarjeta);
        }
      }
      if (!percepcion) {
        const inicio = performance.now();
        this.cpu.lanzar(lote, planes);
        percepcion = this.cpu.esperar(0);
        this.#ultimos.push({ dispositivo: 'cpu', actores: lote.slots.length,
          subidos: 0, bajados: 0, ms: performance.now() - inicio });
      }
      if (tramos.length === 1) {
        reunida = percepcion;
        break;
      }
      const { q, v, a } = percepcion;
      reunida ??= { q, v, a, celda: new Int32Array(actores * q), pasos: new Int16Array(actores * q),
        valor: new Float32Array(actores * q), organismo: new Float64Array(actores * v), utilidad: new Float32Array(actores * a) };
      reunida.celda.set(percepcion.celda, desde * q);
      reunida.pasos.set(percepcion.pasos, desde * q);
      reunida.valor.set(percepcion.valor, desde * q);
      reunida.organismo.set(percepcion.organismo, desde * v);
      reunida.utilidad.set(percepcion.utilidad, desde * a);
    }
    return reunida!;
  }

  cerrar(): void {
    if (this.#cerrado) return;
    this.#cerrado = true;
    this.#pendiente = undefined;
    this.tarjetas.forEach((_, i) => this.#apagar(i));
  }
}

/** El coordinador actualiza las fuentes de su percibidor CPU junto con las de las tarjetas. */
export function crearPuentePercepcion(dispositivos: readonly number[], frente: FrentePublico, terreno: Terreno, cpu: Percibidor) {
  if (new Set(dispositivos).size !== dispositivos.length || dispositivos.some(d => !Number.isSafeInteger(d) || d < 0))
    throw new RangeError('Se requieren índices GPU no negativos y sin repetir.');
  const tarjetas: { percibidor: PercibidorGpu; activa: boolean; cerrar: () => void }[] = [];
  if (process.env.COMPUTE_NVRTC) for (const dispositivo of dispositivos) {
    try {
      const canal = new CanalCompartido(dispositivo);
      tarjetas.push({
        percibidor: new PercibidorGpu(canal, frente, terreno), activa: true,
        cerrar() { this.activa = false; canal.cerrar(); },
      });
    } catch (error) {
      if (!(error instanceof ErrorDispositivo)) {
        tarjetas.forEach(t => t.cerrar());
        throw error;
      }
    }
  }
  const puente = new PuentePercepcion(cpu, tarjetas);
  return {
    puente,
    fuentes(siguiente: FrentePublico, suelo: Terreno): void {
      for (const tarjeta of tarjetas) if (tarjeta.activa) tarjeta.percibidor.fuentes(siguiente, suelo);
    },
  };
}

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
  /** Cómo se llevó la VRAM a la topología de este paso: completo, incremental (`delta`), nada que subir (`noop`) o sin cambio (`null`). */
  syncKind: 'full' | 'delta' | 'noop' | null;
}
export interface GpuRunResult extends GpuBridgeStats {
  dirtyPages: readonly { pageX: number; pageY: number }[];
}
interface TopologyKey { version: number; pageSetVersion: number; residentEpoch: number; capacityCells: number; slots: number; totalCells: number; regionSide: number; }

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
let child = null, reader = null, readyPromise = null, dead = null, childClosed = false;
let shmFd = null, cachedBuffers = null;
const MAX_IO_CHUNK = 1 << 29; // 512 MiB (< 2 GiB limit of Node fs.writeSync/readSync)
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
  child.on('close', (code,signal)=>{ childClosed=true; if(!workerData.closing){ dead=new Error('GPU resident subprocess exited code='+code+' signal='+signal+' '+stderr); if(reader){reader.error=dead; reader.done=true; reader.wake();} } });
  child.stdin.on('error', e=>{ if(reader){reader.error=e; reader.done=true; reader.wake();} });
  readyPromise = reader.frame().then(f=>{ if(!f.header.ready) throw new Error('GPU resident worker not ready');
    // Abierto por ambos lados, el nombre sobra: se borra ya, así ni un SIGKILL deja el fichero en /dev/shm
    // (Python solo usa su descriptor: ftruncate y mmap).
    if(f.header.shmPath) { try { shmFd = fs.openSync(f.header.shmPath, 'r+'); } catch(e) { throw new Error('GPU shm: no se pudo abrir '+f.header.shmPath+': '+e.message); } finally { try{fs.unlinkSync(f.header.shmPath);}catch{} } }
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
function bytesOf(buffers,name){ const buf=buffers[name]; return new Uint8Array(buf); }
// Bajada directa: fs.readSync escribe en la vista del SharedArrayBuffer destino (sin copia intermedia).
function readInto(dst, start, len, reply, boff){
  if(!len) return;
  if(reply.shmBytes){
    let off=0;
    while(off<len){ const chunk=Math.min(MAX_IO_CHUNK, len-off); const r=fs.readSync(shmFd, dst, start+off, chunk, boff+off); if(r<=0) throw new Error('GPU shm: lectura corta'); off+=r; }
  } else dst.set(reply.body.subarray(boff, boff+len), start);
}
function expandRuns(runs, touched){ for(const [s0,c] of runs) for(let s=s0;s<s0+c;s++) touched.add(s); }
async function fullSync(job, buffers){
  const parts=[];
  const push=(u8)=>parts.push(Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength));
  push(new Uint8Array(buffers.stamps)); push(new Uint8Array(buffers.around)); push(new Uint8Array(buffers.pageX)); push(new Uint8Array(buffers.pageY));
  for(const f of FIELDS) push(bytesOf(buffers,f.name));
  const specs=[];
  for(const d of job.full.devices){
    if(!d.identity) push(new Uint8Array(d.l2g.buffer, d.l2g.byteOffset, d.l2g.byteLength));
    push(new Uint8Array(d.cells.buffer, d.cells.byteOffset, d.cells.byteLength));
    specs.push({identity:d.identity, localSlots:d.identity?0:d.l2g.length, localCap:d.localCap, cellsCap:d.cellsCap, nCells:d.cells.length});
  }
  const reply=await send({kind:'sync', capacityCells:job.capacityCells, slots:job.slots, version:job.full.version, devices:specs}, parts);
  if(!reply.header.ok) throw new Error('GPU sync failed');
  return reply.header.uploadedBytes||0;
}
async function deltaSync(job, buffers){
  const dl=job.delta, pages=dl.pages, P=pages.length;
  const perPage=FIELDS.reduce((s,f)=>s+256*f.bytes,0);
  let size=P*perPage + P*256*4 + P*8;
  const ops=[]; const tails=[];
  for(const op of dl.devices){
    const o={...op}; delete o.aroundData; delete o.cellsData;
    o.aroundOff=size; size+=op.aroundData.byteLength; o.cellsOff=size; size+=op.cellsData.byteLength;
    ops.push(o); tails.push(op.aroundData, op.cellsData);
  }
  const body=Buffer.alloc(size); let off=0;
  const pageRuns=runsOf(pages);
  for(const f of FIELDS){ const src=bytesOf(buffers,f.name); for(const [s0,c] of pageRuns){ const a=s0*256*f.bytes, n=c*256*f.bytes; body.set(src.subarray(a,a+n),off); off+=n; } }
  body.set(new Uint8Array(dl.stamps.buffer, dl.stamps.byteOffset, dl.stamps.byteLength), off); off+=dl.stamps.byteLength;
  body.set(new Uint8Array(dl.pageX.buffer, dl.pageX.byteOffset, dl.pageX.byteLength), off); off+=dl.pageX.byteLength;
  body.set(new Uint8Array(dl.pageY.buffer, dl.pageY.byteOffset, dl.pageY.byteLength), off); off+=dl.pageY.byteLength;
  for(const t of tails){ body.set(new Uint8Array(t.buffer, t.byteOffset, t.byteLength), off); off+=t.byteLength; }
  const reply=await send({kind:'delta', pages:P, devices:ops}, body);
  if(!reply.header.ok) throw new Error('GPU delta sync failed');
  return reply.header.uploadedBytes||0;
}
async function handle(job){
  await readyPromise;
  if(dead) throw dead;
  if(job.buffers) cachedBuffers = job.buffers;
  const buffers = cachedBuffers;
  let uploaded=0, downloaded=0;
  if(job.full) uploaded += await fullSync(job, buffers);
  else if(job.delta) uploaded += await deltaSync(job, buffers);
  stats[2]=uploaded;
  const syncUploaded = uploaded;
  const perPage = FIELDS.reduce((s,f)=>s+256*f.bytes,0);
  if(job.kind==='tick'){
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
      kind: 'tick', dirtySlots: job.dirtySlots,
      haloSlotsPerDevice: job.haloSlotsPerDevice || [], downloadSlots: job.downloadSlots || [],
      pass1Params: job.pass1Params, pass2Params: job.pass2Params,
    }, body);
    if(!reply.header.ok) throw new Error('GPU tick failed');
    uploaded += reply.header.uploadedBytes || 0; downloaded += reply.header.downloadedBytes || 0;
    let boff = 0;
    const perDevice = reply.header.downloadRunsPerDevice || [];
    const touched = new Set();
    for(let di = 0; di < perDevice.length; di++){
      const deviceRuns = perDevice[di];
      if(!deviceRuns || !deviceRuns.length) continue;
      expandRuns(deviceRuns, touched);
      for(const f of FIELDS){
        const dst = bytesOf(buffers, f.name);
        for(const [startSlot, count] of deviceRuns){
          const start = startSlot * 256 * f.bytes; const len = count * 256 * f.bytes;
          readInto(dst, start, len, reply, boff); boff += len;
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
    const reply=await send({kind:'flush'}, null);
    if(!reply.header.ok) throw new Error('GPU flush failed');
    let boff=0;
    const perDeviceRuns = reply.header.downloadRunsPerDevice || [];
    for(let di=0; di<perDeviceRuns.length; di++){
      const deviceRuns = perDeviceRuns[di];
      for(const f of FIELDS){
        const dst=bytesOf(buffers,f.name);
        for(const [startSlot,count] of deviceRuns){
          const start=startSlot*256*f.bytes; const len=count*256*f.bytes;
          readInto(dst, start, len, reply, boff); boff+=len;
        }
      }
    }
    return {touched:[]};
  }
  // step body: dirty chunks
  const slots = job.slots;
  const haloField = job.pass===1 ? 'terrain' : 'life';
  const haloSpec = FIELD_BY_NAME[haloField];
  const haloBytes = (job.haloSlotsPerDevice||[]).reduce((s,l)=>s+l.length*256*haloSpec.bytes,0);
  // V22: campo climático por ranura (3 dobles), solo pasada 1 estacional; va al final del cuerpo.
  const climate = job.pass===1 && job.climate ? job.climate : null;
  if(climate && climate.length !== slots*3) throw new Error('GPU climate: longitud distinta de slots*3');
  const climateBytes = climate ? climate.byteLength : 0;
  const body=Buffer.alloc(job.dirtySlots.length*perPage + (job.pass===2 ? slots : 0) + haloBytes + climateBytes);
  let off=0;
  // Subida coalescida: por campo y por tramo contiguo de dirtySlots (ordenados).
  const dirtyRuns = runsOf(job.dirtySlots);
  for(const f of FIELDS){ const src=bytesOf(buffers,f.name); for(const [startSlot,count] of dirtyRuns){ const start=startSlot*256*f.bytes; const len=count*256*f.bytes; body.set(src.subarray(start,start+len),off); off+=len; } }
  if(job.pass===2){ body.set(bytesOf(buffers,'woodAdded').subarray(0,slots),off); off+=slots; }
  { const src=bytesOf(buffers,haloField); const hb=256*haloSpec.bytes;
    for(const lst of (job.haloSlotsPerDevice||[])){ for(const [s0,c] of runsOf(lst)){ body.set(src.subarray(s0*hb,(s0+c)*hb),off); off+=c*hb; } } }
  if(climate){ body.set(new Uint8Array(climate.buffer, climate.byteOffset, climate.byteLength), off); off+=climate.byteLength; }
  const reply=await send({kind:'step', pass:job.pass, dirtySlots:job.dirtySlots, haloSlotsPerDevice:job.haloSlotsPerDevice||[], haloField, downloadSlots:job.downloadSlots, params:job.params, climate:!!climate}, body);
  if(!reply.header.ok) throw new Error('GPU step failed');
  uploaded += reply.header.uploadedBytes||0; downloaded += reply.header.downloadedBytes||0;
  // Bajada selectiva coalescida: solo los campos de la pasada, por campo y por tramo.
  // Los campos no descargados se copian front->back en RAM local para los tramos tocados.
  let boff=0;
  const perDevice = reply.header.downloadRunsPerDevice||[];
  const dlKey = (job.downloadSlots !== undefined && job.downloadSlots !== null && job.pass === 2) ? '2_halo' : job.pass;
  const dlNames = DOWNLOAD_FIELDS[dlKey] || FIELDS.map(f=>f.name);
  const dlSet = new Set(dlNames);
  const touched=new Set();
  for(let di=0; di<perDevice.length; di++){
    const deviceRuns = perDevice[di];
    if(!deviceRuns || !deviceRuns.length) continue;
    expandRuns(deviceRuns, touched);
    for(const name of dlNames){ const f=FIELD_BY_NAME[name]; const dst=bytesOf(buffers,name+'Back'); for(const [startSlot,count] of deviceRuns){ const start=startSlot*256*f.bytes; const len=count*256*f.bytes; readInto(dst, start, len, reply, boff); boff+=len; } }
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
  if(job.kind==='close'){
    // EOF por stdin: Python libera la VRAM y sale; si no sale en 500 ms, SIGKILL. El worker termina
    // cuando el subproceso ya no existe.
    workerData.closing=true;
    if(shmFd!==null){ try{fs.closeSync(shmFd);}catch{} shmFd=null; }
    if(!child || childClosed) process.exit(0);
    const killer=setTimeout(()=>{ try{child.kill('SIGKILL');}catch{} },500);
    child.once('close',()=>{ clearTimeout(killer); process.exit(0); });
    try{ child.stdin.end(); }catch{}
    return;
  }
  if(job.kind==='kill'){ try{ if(child) child.kill('SIGKILL'); }catch{} Atomics.store(control,0,2); const msg='GPU resident subprocess killed by test'; for(let i=0;i<msg.length;i++) errors[i]=msg.charCodeAt(i); errors[msg.length]=0; Atomics.notify(control,0); return; }
  try{ const result=await handle(job); workerData.lastTouched=result.touched; Atomics.store(control,0,1); }
  catch(e){ const msg=(e&&e.stack||String(e)).slice(0,4000); for(let i=0;i<msg.length;i++) errors[i]=msg.charCodeAt(i); errors[msg.length]=0; Atomics.store(control,0,2); }
  Atomics.notify(control,0);
});
// La causa de un arranque fallido la recibe el primer job (await readyPromise); sin este catch,
// un fallo antes del primer job sería un rechazo no observado que mataría el worker en silencio.
start().catch(()=>{});
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

/** Una página entra, sale o cambia de presencia: lo que hay que subir a un dispositivo. */
interface DeviceDeltaOp {
  unmap: number[]; map: [number, number][]; ownedAdd: number[]; ownedRemove: number[]; nCells: number;
  pageUploads: [number, number][]; aroundSlots: number[]; cellRuns: [number, number][];
  aroundData: Int32Array; cellsData: Int32Array;
}
interface DeltaPlan { pages: Int32Array; stamps: Uint32Array; pageX: Int32Array; pageY: Int32Array; devices: DeviceDeltaOp[]; }
interface FullPlan { version: number; devices: { identity: boolean; l2g: Int32Array; cells: Int32Array; localCap: number; cellsCap: number }[]; }
interface DeviceMirror {
  /** Ranura global → local (-1: no residente en este dispositivo). Identidad en modo replicado. */
  g2l: Int32Array; l2g: Int32Array; free: number[]; localCap: number; cellsCap: number;
  /** Lista de celdas (ids GLOBALES) que calcula este dispositivo; en VRAM viven como ids locales. */
  cellsGlobal: Int32Array; nCells: number;
  /** Espejo del `around` LOCAL residente en VRAM (-2: desconocido). */
  around: Int32Array;
  halo: Uint8Array;
}

const popcount32 = (v: number): number => { v -= (v >>> 1) & 0x55555555; v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };

/**
 * Espejo exacto de la topología residente en VRAM (sync incremental). Cada página presente tiene un
 * dispositivo propietario estable; cada dispositivo calcula SU lista de celdas (borrado por intercambio
 * con la última: O(celdas que cambian)). La presencia viaja como máscara de 256 bits por página, de modo
 * que un cambio de `version` del anfitrión no reescribe sellos en VRAM. El resultado por celda no depende
 * del dispositivo ni del orden de `cells` (FP64, --fmad=false, sin reducciones entre celdas): mover la
 * propiedad no cambia ningún bit, solo qué GPU lo calcula.
 */
class ResidentTopology {
  readonly owner: Int8Array; readonly px: Int32Array; readonly py: Int32Array; readonly present: Uint8Array;
  readonly mask: Uint32Array; readonly around: Int32Array; readonly posOf: Int32Array;
  readonly devs: DeviceMirror[] = [];
  private readonly scratchMask: Uint32Array; private readonly scratchFlag: Uint8Array;
  private haloCache: number[][] | null = null;
  constructor(readonly identity: boolean, readonly slots: number, readonly capacityCells: number, readonly weights: readonly number[]) {
    this.owner = new Int8Array(slots).fill(-1); this.px = new Int32Array(slots); this.py = new Int32Array(slots);
    this.present = new Uint8Array(slots); this.mask = new Uint32Array(slots * 8); this.around = new Int32Array(slots * 9).fill(-1);
    this.posOf = new Int32Array(capacityCells).fill(-1);
    this.scratchMask = new Uint32Array(slots * 8); this.scratchFlag = new Uint8Array(slots);
  }

  /** Sync completo: propiedad inicial por tramos contiguos del orden del anfitrión (como antes). */
  static full(identity: boolean, weights: readonly number[], ranges: readonly [number, number][], cells: Int32Array, total: number,
    hostAround: Int32Array, hostPX: Int32Array, hostPY: Int32Array, slots: number, capacityCells: number, version: number): { topo: ResidentTopology; plan: FullPlan } {
    const topo = new ResidentTopology(identity, slots, capacityCells, weights);
    const nDev = weights.length;
    for (let d = 0; d < ranges.length; d++) for (let i = ranges[d]![0]; i < ranges[d]![1]; i++) { const s = cells[i]! >>> 8; if (topo.owner[s]! < 0) topo.owner[s] = d; }
    for (let i = 0; i < total; i++) { const c = cells[i]!; topo.mask[(c >>> 8) * 8 + ((c >>> 5) & 7)]! |= 1 << (c & 31); }
    topo.px.set(hostPX.subarray(0, slots)); topo.py.set(hostPY.subarray(0, slots)); topo.around.set(hostAround.subarray(0, slots * 9));
    const counts = new Array<number>(nDev).fill(0);
    for (let s = 0; s < slots; s++) if (topo.owner[s]! >= 0) topo.present[s] = 1;
    for (let i = 0; i < total; i++) counts[topo.owner[cells[i]! >>> 8]!]!++;
    for (let d = 0; d < nDev; d++) {
      let g2l: Int32Array, l2g: Int32Array, localCap: number, cellsCap: number; const free: number[] = [];
      if (identity) {
        g2l = new Int32Array(slots); for (let s = 0; s < slots; s++) g2l[s] = s; l2g = g2l; localCap = slots; cellsCap = capacityCells;
      } else {
        const need = new Uint8Array(slots);
        for (let s = 0; s < slots; s++) if (topo.owner[s] === d) { need[s] = 1; for (let k = 0; k < 9; k++) { const nb = hostAround[s * 9 + k]!; if (nb >= 0 && topo.present[nb]) need[nb] = 1; } }
        let n = 0; for (let s = 0; s < slots; s++) if (need[s]) n++;
        localCap = n + Math.max(16, Math.ceil(n / 4)); cellsCap = localCap * 256;
        g2l = new Int32Array(slots).fill(-1); l2g = new Int32Array(localCap).fill(-1);
        let l = 0; for (let s = 0; s < slots; s++) if (need[s]) { g2l[s] = l; l2g[l] = s; l++; }
        for (let f = localCap - 1; f >= n; f--) free.push(f);
      }
      const around = new Int32Array(localCap * 9).fill(-2);
      const dev: DeviceMirror = { g2l, l2g, free, localCap, cellsCap, cellsGlobal: new Int32Array(Math.max(cellsCap, counts[d]!)), nCells: 0, around, halo: new Uint8Array(slots) };
      topo.devs.push(dev);
    }
    for (let i = 0; i < total; i++) { const c = cells[i]!, dev = topo.devs[topo.owner[c >>> 8]!]!; topo.posOf[c] = dev.nCells; dev.cellsGlobal[dev.nCells++] = c; }
    for (let s = 0; s < slots; s++) if (topo.present[s]) { topo.refreshHalo(s, hostAround); for (const dev of topo.devs) { const l = dev.g2l[s]!; if (l >= 0) topo.localAround(dev, s, hostAround, dev.around, l * 9); } }
    const plan: FullPlan = { version, devices: topo.devs.map(dev => ({
      identity, l2g: identity ? new Int32Array(0) : dev.l2g.slice(0, dev.localCap - dev.free.length),
      cells: topo.localCells(dev, 0, dev.nCells), localCap: dev.localCap, cellsCap: dev.cellsCap,
    })) };
    return { topo, plan };
  }

  get nDev(): number { return this.devs.length; }
  private localCells(dev: DeviceMirror, from: number, to: number): Int32Array {
    const out = new Int32Array(to - from);
    for (let p = from; p < to; p++) { const c = dev.cellsGlobal[p]!; out[p - from] = this.identity ? c : (dev.g2l[c >>> 8]! << 8) | (c & 255); }
    return out;
  }
  private localAround(dev: DeviceMirror, s: number, hostAround: Int32Array, out: Int32Array, at: number): void {
    for (let k = 0; k < 9; k++) { const nb = hostAround[s * 9 + k]!; out[at + k] = nb < 0 ? -1 : this.identity ? nb : dev.g2l[nb]!; }
  }
  /** ¿Necesita el dispositivo `d` la página `s` (propia o vecina de una propia)? */
  private needs(d: number, s: number, hostAround: Int32Array): boolean {
    if (!this.present[s]) return false;
    if (this.owner[s] === d) return true;
    for (let k = 0; k < 9; k++) { const nb = hostAround[s * 9 + k]!; if (nb >= 0 && this.present[nb] && this.owner[nb] === d) return true; }
    return false;
  }
  private refreshHalo(s: number, hostAround: Int32Array): boolean {
    let changed = false;
    for (let d = 0; d < this.nDev; d++) {
      const h = this.nDev > 1 && this.owner[s] !== d && this.needs(d, s, hostAround) ? 1 : 0;
      if (this.devs[d]!.halo[s] !== h) { this.devs[d]!.halo[s] = h; changed = true; }
    }
    if (changed) this.haloCache = null;
    return changed;
  }
  haloLists(): number[][] {
    if (this.haloCache) return this.haloCache;
    this.haloCache = this.devs.map(dev => { const out: number[] = []; if (this.nDev > 1) for (let s = 0; s < this.slots; s++) if (dev.halo[s]) out.push(s); return out; });
    return this.haloCache;
  }

  /**
   * Sync incremental. `null` ⇒ hace falta un sync completo (sin holgura local o reparto desequilibrado);
   * en ese caso el llamador descarta este espejo. `'noop'` ⇒ la VRAM ya representa la topología nueva
   * (p. ej. solo cambió la `version` del anfitrión o el orden de `cells`).
   */
  delta(cells: Int32Array, total: number, hostAround: Int32Array, hostPX: Int32Array, hostPY: Int32Array): DeltaPlan | 'noop' | null {
    const S = this.slots, nDev = this.nDev, newMask = this.scratchMask;
    newMask.fill(0);
    for (let i = 0; i < total; i++) { const c = cells[i]!; newMask[(c >>> 8) * 8 + ((c >>> 5) & 7)]! |= 1 << (c & 31); }
    const retired: number[] = [], added: number[] = [], presChanged: number[] = [], aroundChanged: number[] = [];
    for (let s = 0; s < S; s++) {
      const b = s * 8;
      const isP = (newMask[b]! | newMask[b + 1]! | newMask[b + 2]! | newMask[b + 3]! | newMask[b + 4]! | newMask[b + 5]! | newMask[b + 6]! | newMask[b + 7]!) !== 0;
      const wasP = this.present[s] === 1;
      if (!wasP && !isP) continue;
      if (wasP && isP && this.px[s] === hostPX[s] && this.py[s] === hostPY[s]) {
        for (let w = 0; w < 8; w++) if (newMask[b + w] !== this.mask[b + w]) { presChanged.push(s); break; }
        for (let k = 0; k < 9; k++) if (hostAround[s * 9 + k] !== this.around[s * 9 + k]) { aroundChanged.push(s); break; }
      } else { if (wasP) retired.push(s); if (isP) added.push(s); }
    }
    if (!retired.length && !added.length && !presChanged.length && !aroundChanged.length) return 'noop';
    // Conjunto afectado: páginas cambiadas y sus vecindades vieja (espejo) y nueva (anfitrión).
    const flag = this.scratchFlag; flag.fill(0);
    const affected: number[] = [];
    const touch = (s: number) => { if (s >= 0 && s < S && !flag[s]) { flag[s] = 1; affected.push(s); } };
    for (const list of [retired, added, presChanged, aroundChanged]) for (const s of list) touch(s);
    for (const s of retired) for (let k = 0; k < 9; k++) touch(this.around[s * 9 + k]!);
    for (const s of added) for (let k = 0; k < 9; k++) touch(hostAround[s * 9 + k]!);
    const mods = this.devs.map(() => new Set<number>());
    const ops: DeviceDeltaOp[] = this.devs.map(() => ({ unmap: [], map: [], ownedAdd: [], ownedRemove: [], nCells: 0, pageUploads: [], aroundSlots: [], cellRuns: [], aroundData: new Int32Array(0), cellsData: new Int32Array(0) }));
    const removeCell = (d: number, c: number) => {
      const dev = this.devs[d]!, p = this.posOf[c]!, last = --dev.nCells;
      if (p !== last) { const moved = dev.cellsGlobal[last]!; dev.cellsGlobal[p] = moved; this.posOf[moved] = p; mods[d]!.add(p); }
      this.posOf[c] = -1;
    };
    const appendCell = (d: number, c: number): boolean => {
      const dev = this.devs[d]!;
      if (dev.nCells >= dev.cellsCap) return false;
      dev.cellsGlobal[dev.nCells] = c; this.posOf[c] = dev.nCells; mods[d]!.add(dev.nCells); dev.nCells++; return true;
    };
    const unmap = (d: number, s: number) => {
      const dev = this.devs[d]!, l = dev.g2l[s]!;
      if (this.identity || l < 0) return;
      dev.g2l[s] = -1; dev.l2g[l] = -1; dev.free.push(l); dev.around.fill(-2, l * 9, l * 9 + 9); ops[d]!.unmap.push(s);
    };
    const forEachBit = (s: number, m: Uint32Array, fn: (c: number) => void, other?: Uint32Array, wantSet = true) => {
      for (let w = 0; w < 8; w++) {
        let bits = m[s * 8 + w]!; if (other) bits = wantSet ? bits & ~other[s * 8 + w]! : bits;
        while (bits) { const t = bits & -bits; fn((s << 8) | (w << 5) | (31 - Math.clz32(t))); bits ^= t; }
      }
    };
    // 1) Salidas (también una ranura reutilizada por otro chunk: sale la vieja y entra la nueva).
    for (const s of retired) {
      const d = this.owner[s]!;
      forEachBit(s, this.mask, c => removeCell(d, c));
      this.owner[s] = -1; this.present[s] = 0; ops[d]!.ownedRemove.push(s);
      for (let e = 0; e < nDev; e++) unmap(e, s);
      this.mask.fill(0, s * 8, s * 8 + 8);
    }
    // 2) Presencia parcial cambiada dentro de una página que se queda.
    for (const s of presChanged) {
      const d = this.owner[s]!;
      forEachBit(s, this.mask, c => removeCell(d, c), newMask);
    }
    for (const s of presChanged) {
      const d = this.owner[s]!;
      let ok = true; forEachBit(s, newMask, c => { ok = appendCell(d, c) && ok; }, this.mask);
      if (!ok) return null;
      this.mask.set(newMask.subarray(s * 8, s * 8 + 8), s * 8);
    }
    // 3) Entradas: propietario estable elegido por vecindad y por el peso de cada GPU.
    const slackAssign = Math.max(4 * 256, Math.ceil(0.02 * total));
    for (const s of added) {
      let k = 0; for (let w = 0; w < 8; w++) k += popcount32(newMask[s * 8 + w]!);
      const d = this.chooseOwner(s, k, total, hostAround, slackAssign);
      this.mask.set(newMask.subarray(s * 8, s * 8 + 8), s * 8);
      this.owner[s] = d; this.present[s] = 1; this.px[s] = hostPX[s]!; this.py[s] = hostPY[s]!;
      let ok = true; forEachBit(s, newMask, c => { ok = appendCell(d, c) && ok; });
      if (!ok) return null;
      ops[d]!.ownedAdd.push(s);
    }
    // 4) Residencia local (modo repartido) y halos, solo en el conjunto afectado.
    affected.sort((a, b) => a - b);
    const newlyLocal = this.devs.map(() => new Set<number>());
    for (const s of added) for (let d = 0; d < nDev; d++) if (this.identity) newlyLocal[d]!.add(s);
    if (!this.identity) {
      for (const q of affected) for (let d = 0; d < nDev; d++) {
        const dev = this.devs[d]!, should = this.needs(d, q, hostAround), l = dev.g2l[q]!;
        if (should && l < 0) {
          const nl = dev.free.pop(); if (nl === undefined) return null;
          dev.g2l[q] = nl; dev.l2g[nl] = q; ops[d]!.map.push([q, nl]); newlyLocal[d]!.add(q);
        } else if (!should && l >= 0) unmap(d, q);
      }
    }
    for (const q of affected) this.refreshHalo(q, hostAround);
    // 5) Páginas a subir por dispositivo: nuevas, con presencia cambiada o recién residentes.
    const pageSet = new Set<number>();
    const perDevPages: number[][] = this.devs.map((dev, d) => {
      const out = new Set<number>(newlyLocal[d]);
      for (const s of presChanged) if (dev.g2l[s]! >= 0) out.add(s);
      for (const s of added) if (dev.g2l[s]! >= 0) out.add(s);
      const sorted = [...out].sort((a, b) => a - b); for (const s of sorted) pageSet.add(s); return sorted;
    });
    const pages = Int32Array.from([...pageSet].sort((a, b) => a - b));
    const pageIdx = new Map<number, number>(); pages.forEach((s, i) => pageIdx.set(s, i));
    const stamps = new Uint32Array(pages.length * 256), pageX = new Int32Array(pages.length), pageY = new Int32Array(pages.length);
    pages.forEach((s, i) => { pageX[i] = hostPX[s]!; pageY[i] = hostPY[s]!; forEachBit(s, this.mask, c => { stamps[i * 256 + (c & 255)] = 1; }); });
    // 6) Vecindades: afectadas y sus vecinas (cambia `around` o el mapa local de una vecina).
    const check: number[] = [];
    flag.fill(0);
    const touch2 = (s: number) => { if (s >= 0 && s < S && !flag[s] && this.present[s]) { flag[s] = 1; check.push(s); } };
    for (const q of affected) { touch2(q); if (this.present[q]) for (let k = 0; k < 9; k++) touch2(hostAround[q * 9 + k]!); }
    check.sort((a, b) => a - b);
    const vec = new Int32Array(9);
    for (let d = 0; d < nDev; d++) {
      const dev = this.devs[d]!, op = ops[d]!;
      op.pageUploads = perDevPages[d]!.map(s => [dev.g2l[s]!, pageIdx.get(s)!] as [number, number]);
      const aroundVals: number[] = [];
      for (const q of check) {
        const l = dev.g2l[q]!; if (l < 0) continue;
        this.localAround(dev, q, hostAround, vec, 0);
        let differs = false; for (let k = 0; k < 9; k++) if (dev.around[l * 9 + k] !== vec[k]) { differs = true; break; }
        if (!differs) continue;
        dev.around.set(vec, l * 9); op.aroundSlots.push(l); for (let k = 0; k < 9; k++) aroundVals.push(vec[k]!);
      }
      op.aroundData = Int32Array.from(aroundVals);
      const positions = [...mods[d]!].filter(p => p < dev.nCells).sort((a, b) => a - b);
      const runs: [number, number][] = [];
      for (const p of positions) { const last = runs[runs.length - 1]; if (last && p === last[0] + last[1]) last[1]++; else runs.push([p, 1]); }
      op.cellRuns = runs;
      const data = new Int32Array(positions.length); let o = 0;
      for (const [p0, c] of runs) { data.set(this.localCells(dev, p0, p0 + c), o); o += c; }
      op.cellsData = data; op.nCells = dev.nCells;
    }
    for (const s of affected) if (this.present[s]) this.around.set(hostAround.subarray(s * 9, s * 9 + 9), s * 9);
    // Reparto: si una GPU se aleja demasiado de su peso (muchas salidas), se reparte de nuevo con un sync completo.
    if (nDev > 1) {
      const slack = Math.max(32 * 256, Math.ceil(0.08 * total));
      for (let d = 0; d < nDev; d++) if (Math.abs(this.devs[d]!.nCells - this.weights[d]! * total) > slack) return null;
    }
    return { pages, stamps, pageX, pageY, devices: ops };
  }

  private chooseOwner(s: number, k: number, total: number, hostAround: Int32Array, slack: number): number {
    const nDev = this.nDev; if (nDev === 1) return 0;
    const counts = new Array<number>(nDev).fill(0);
    for (let j = 0; j < 9; j++) { if (j === 4) continue; const nb = hostAround[s * 9 + j]!; if (nb >= 0 && nb !== s && this.present[nb]) { const o = this.owner[nb]!; if (o >= 0) counts[o]!++; } }
    let best = -1;
    for (let d = 0; d < nDev; d++) if (counts[d]! > 0 && (best < 0 || counts[d]! > counts[best]!)) best = d;
    if (best >= 0 && this.devs[best]!.nCells + k <= this.weights[best]! * total + slack) return best;
    let arg = 0;
    for (let d = 1; d < nDev; d++) if (this.weights[d]! * total - this.devs[d]!.nCells > this.weights[arg]! * total - this.devs[arg]!.nCells) arg = d;
    return arg;
  }
}

/** Puente GPU persistente (T122): un worker JS que posee un subproceso Python con VRAM residente. */
export class ResidentGpuBridge {
  readonly devices: readonly number[];
  private readonly worker: Worker;
  private readonly control = new Int32Array(new SharedArrayBuffer(4 * 8));
  private readonly statsArr = new Float64Array(new SharedArrayBuffer(8 * 8));
  private readonly errorArr = new Uint16Array(new SharedArrayBuffer(4096 * 2));
  private synced: TopologyKey | null = null;
  private syncedDirtyBuffer: SharedArrayBuffer | null = null;
  private topo: ResidentTopology | null = null;
  /** La VRAM va por delante del anfitrión (runTick o bajada parcial): un cambio de topología resincroniza entero. */
  private vramAhead = false;
  private broken: Error | null = null;
  private closed = false;
  private readonly customWeights?: readonly number[];
  private readonly shardedOption?: boolean;
  #last: GpuBridgeStats;
  #cumulative = { uploadedBytes: 0, downloadedBytes: 0 };
  #syncCounts = { full: 0, delta: 0, noop: 0 };
  readonly #exited: Promise<void>;

  constructor(devices: readonly number[], options?: { weights?: readonly number[]; sharded?: boolean }) {
    if (!devices.length || devices.some(d => !Number.isSafeInteger(d) || d < 0) || new Set(devices).size !== devices.length)
      throw new RangeError('gpu debe ser una lista no vacía de dispositivos enteros sin duplicados.');
    this.devices = [...devices];
    this.customWeights = options?.weights;
    this.shardedOption = options?.sharded;
    this.#last = { uploadedBytes: 0, downloadedBytes: 0, syncUploadedBytes: 0, kernelMs: 0, devices: this.devices, lastPass: null, syncKind: null };
    this.worker = new Worker(WORKER_CODE, {
      eval: true, execArgv: [], name: 'atlas-gpu-resident',
      workerData: {
        scriptPath: resolveScript(), nvrtc: resolveNvrtc(), devices: this.devices,
        control: this.control.buffer, stats: this.statsArr.buffer, errors: this.errorArr.buffer,
        fields: GPU_FIELDS.map(f => ({ name: f.name, bytes: f.bytes })),
      },
    });
    this.worker.unref();
    // Un fallo o una salida inesperada del worker no tumba el anfitrión: el siguiente paso falla al
    // instante (`broken`) en vez de agotar la espera de 120 s.
    const romper = (error: Error): void => { this.broken ??= error; this.synced = null; this.syncedDirtyBuffer = null; this.topo = null; };
    this.worker.on('error', error => romper(error instanceof Error ? error : new Error(String(error))));
    this.#exited = new Promise(resolve => this.worker.once('exit', code => {
      if (!this.closed) romper(new Error(`El worker GPU residente terminó (code=${code}).`));
      resolve();
    }));
  }
  get lastStats(): GpuBridgeStats { return this.#last; }
  get cumulativeStats(): Readonly<{ uploadedBytes: number; downloadedBytes: number }> { return this.#cumulative; }
  /** Cuántos cambios de topología se resolvieron con sync completo, incremental o sin subir nada. */
  get syncCounts(): Readonly<{ full: number; delta: number; noop: number }> { return this.#syncCounts; }
  /** Fuerza una resincronización completa en el próximo paso (tras un fallo o un cambio externo). */
  invalidate(): void { this.synced = null; this.syncedDirtyBuffer = null; this.topo = null; }

  private weights(): number[] {
    // Peso medido en la torre: 5070 Ti ≈79%, 2060 ≈21% (T122/T124). Con otros pares, a partes iguales.
    const raw = (this.customWeights && this.customWeights.length === this.devices.length)
      ? [...this.customWeights]
      : this.devices.map(d => this.devices.includes(0) && this.devices.includes(1) ? (d === 0 ? 0.79 : d === 1 ? 0.21 : 1 / this.devices.length) : 1 / this.devices.length);
    const sum = raw.reduce((a, b) => a + b, 0);
    return raw.map(w => w / sum);
  }

  private ranges(cells: Int32Array, total: number, weights: readonly number[]): [number, number][] {
    if (this.devices.length === 1 || total === 0) return this.devices.map((_, i) => (i === 0 ? [0, total] : [total, total]) as [number, number]);
    const ranges: [number, number][] = []; let begin = 0; let acc = 0;
    for (let i = 0; i < this.devices.length; i++) {
      acc += weights[i]!;
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

  /** Decide cómo llevar la VRAM a la topología del anfitrión: completo, incremental o nada. */
  private planTopology(terrain: SharedTerrain, key: TopologyKey, sharded: boolean, allowIncremental: boolean): { full?: FullPlan; delta?: DeltaPlan; kind: 'full' | 'delta' | 'noop' } {
    const buffers = terrain.buffers;
    const cells = new Int32Array(buffers.cells!), around = new Int32Array(buffers.around!);
    const pageX = new Int32Array(buffers.pageX!), pageY = new Int32Array(buffers.pageY!);
    const identity = !sharded;
    const topo = this.topo;
    if (allowIncremental && topo && this.synced && this.syncedDirtyBuffer === buffers.dirty
      && this.synced.residentEpoch === key.residentEpoch
      && topo.identity === identity && topo.slots === key.slots && topo.capacityCells === key.capacityCells) {
      const delta = topo.delta(cells, key.totalCells, around, pageX, pageY);
      if (delta === 'noop') return { kind: 'noop' };
      if (delta) return { delta, kind: 'delta' };
    }
    const weights = this.weights();
    const { topo: next, plan } = ResidentTopology.full(identity, weights, this.ranges(cells, key.totalCells, weights), cells, key.totalCells,
      around, pageX, pageY, key.slots, key.capacityCells, terrain.version);
    this.topo = next;
    return { full: plan, kind: 'full' };
  }

  private transferables(full?: FullPlan, delta?: DeltaPlan): ArrayBuffer[] {
    const out: ArrayBuffer[] = [];
    if (full) for (const d of full.devices) { if (d.l2g.byteLength) out.push(d.l2g.buffer as ArrayBuffer); out.push(d.cells.buffer as ArrayBuffer); }
    if (delta) {
      out.push(delta.pages.buffer as ArrayBuffer, delta.stamps.buffer as ArrayBuffer, delta.pageX.buffer as ArrayBuffer, delta.pageY.buffer as ArrayBuffer);
      for (const d of delta.devices) out.push(d.aroundData.buffer as ArrayBuffer, d.cellsData.buffer as ArrayBuffer);
    }
    return out.filter((b, i, all) => b.byteLength > 0 && all.indexOf(b) === i);
  }

  private wait(label: string, limitMs: number): void {
    // Espera síncrona (mismo patrón que StaticWorkerPool): el worker hace el IPC async con Python.
    const waitStarted = Date.now();
    for (;;) {
      const status = Atomics.load(this.control, 0);
      if (status === 1) return;
      if (status === 2 || Date.now() - waitStarted > limitMs) {
        let msg = ''; for (let i = 0; i < this.errorArr.length && this.errorArr[i]; i++) msg += String.fromCharCode(this.errorArr[i]!);
        this.synced = null; this.syncedDirtyBuffer = null; this.topo = null; this.broken = new Error(`${label}: ${msg || 'timeout esperando al subproceso GPU'}`);
        throw this.broken;
      }
      Atomics.wait(this.control, 0, 0, 5000);
    }
  }

  private dirtySlotsOf(dirtyArr: Uint8Array): number[] {
    const dirtySlots: number[] = [];
    for (let s = 0; s < dirtyArr.length; s++) if (dirtyArr[s]) dirtySlots.push(s);
    return dirtySlots;
  }

  private finish(buffers: Record<string, SharedArrayBuffer>, dirtyArr: Uint8Array, pass: 'ecologia' | 'kernel', syncKind: GpuBridgeStats['syncKind']): GpuRunResult {
    const uploadedBytes = this.statsArr[0]!, downloadedBytes = this.statsArr[1]!, syncUploadedBytes = this.statsArr[2]!;
    // `uploadedBytes` ya incluye la subida de sincronización (`syncUploadedBytes`).
    this.#last = { uploadedBytes, downloadedBytes, syncUploadedBytes, kernelMs: this.statsArr[3]!, devices: this.devices, lastPass: pass, syncKind };
    this.#cumulative.uploadedBytes += uploadedBytes; this.#cumulative.downloadedBytes += downloadedBytes;
    if (syncKind) this.#syncCounts[syncKind]++;
    // Páginas tocadas para la barrera, y limpieza: los actores re-marcarán solo lo que toquen.
    const dirtyPages: { pageX: number; pageY: number }[] = [];
    const pageX = new Int32Array(buffers.pageX!), pageY = new Int32Array(buffers.pageY!);
    // dirty fue marcado por el worker para las páginas descargadas; capturarlo antes de limpiar.
    for (let s = 0; s < dirtyArr.length; s++) if (dirtyArr[s]) dirtyPages.push({ pageX: pageX[s]!, pageY: pageY[s]! });
    dirtyArr.fill(0);
    return { ...this.#last, dirtyPages };
  }

  private topologyKey(terrain: SharedTerrain, pageSetVersion: number, regionSide: number): TopologyKey {
    const buffers = terrain.buffers;
    const cells = new Int32Array(buffers.cells!);
    const capacityCells = buffers.stamps!.byteLength / 4, slots = new Int32Array(buffers.pageX!).length, totalCells = cells.length;
    if (capacityCells > 134_217_728) throw new RangeError('Capacidad por encima de MAX_CELLS (134_217_728).');
    return { version: terrain.version, pageSetVersion, residentEpoch: terrain.residentEpoch ?? 0, capacityCells, slots, totalCells, regionSide };
  }
  private changed(key: TopologyKey, buffers: Record<string, SharedArrayBuffer>): boolean {
    const s = this.synced;
    return !s || this.syncedDirtyBuffer !== buffers.dirty || s.residentEpoch !== key.residentEpoch
      || s.version !== key.version || s.pageSetVersion !== key.pageSetVersion || s.capacityCells !== key.capacityCells
      || s.slots !== key.slots || s.totalCells !== key.totalCells || s.regionSide !== key.regionSide;
  }

  /**
   * `options.climate` (V22, solo `ecologia`): `regionalClimateFactor` por ranura de página
   * (`slots*3` dobles, calculados en JS); con él se lanza `ecology_pass1_seasonal` en vez de `ecology_pass1`.
   */
  run(terrain: SharedTerrain, pageSetVersion: number, pass: 'ecologia' | 'kernel', params: Record<string, unknown>, regionSide: number = 256, options?: { downloadSlots?: readonly number[]; climate?: Float64Array }): GpuRunResult {
    if (this.closed) throw new Error('ResidentGpuBridge cerrado.');
    if (this.broken) throw this.broken;
    const buffers = terrain.buffers;
    const key = this.topologyKey(terrain, pageSetVersion, regionSide);
    const sharded = this.devices.length > 1 && (this.shardedOption ?? (key.capacityCells > 16_000_000));
    if (options?.climate && (pass !== 'ecologia' || options.climate.length !== key.slots * 3))
      throw new RangeError('climate requiere la pasada ecologia y slots*3 dobles.');
    let plan: ReturnType<ResidentGpuBridge['planTopology']> | null = null;
    // Incremental solo si el anfitrión es autoritativo (el último paso bajó todas las páginas propias).
    if (this.changed(key, buffers)) plan = this.planTopology(terrain, key, sharded, !this.vramAhead);
    const topo = this.topo!;
    const dirtyArr = new Uint8Array(buffers.dirty!);
    const dirtySlots = this.dirtySlotsOf(dirtyArr);
    const haloSlotsPerDevice = topo.haloLists();
    let downloadSlots: number[] | undefined;
    if (options?.downloadSlots !== undefined) {
      const set = new Set<number>(options.downloadSlots);
      if (pass === 'kernel') for (const lst of haloSlotsPerDevice) for (const s of lst) set.add(s);
      downloadSlots = [...set].sort((a, b) => a - b);
    }
    Atomics.store(this.control, 0, 0);
    this.statsArr.fill(0);
    try {
      this.worker.postMessage({
        kind: 'step', pass: pass === 'ecologia' ? 1 : 2, buffers, dirtySlots, haloSlotsPerDevice,
        downloadSlots, capacityCells: key.capacityCells, slots: key.slots, full: plan?.full, delta: plan?.delta, params,
        climate: options?.climate,
      }, this.transferables(plan?.full, plan?.delta));
    } catch (error) { this.synced = null; this.syncedDirtyBuffer = null; this.topo = null; throw error; }
    this.wait('ResidentGpuBridge', 120000);
    this.synced = key; this.syncedDirtyBuffer = buffers.dirty!;
    if (plan?.full) this.vramAhead = false;
    if (options?.downloadSlots !== undefined) this.vramAhead = true;
    return this.finish(buffers, dirtyArr, pass, plan?.kind ?? null);
  }

  /**
   * T122 opción (b): ejecuta las dos pasadas del tick ecológico (`ecology_pass1` + `ecology_pass2`)
   * en VRAM sobre la misma cola CUDA y descarga solo los halos de consumidores CPU activos
   * (`downloadSlots`), manteniendo el resto del mundo autoritativo en VRAM hasta `flushToHost()`.
   * Con la VRAM autoritativa, un cambio de topología resincroniza entero desde el anfitrión (como antes).
   */
  runTick(terrain: SharedTerrain, pageSetVersion: number, pass1Params: Record<string, unknown>, pass2Params: Record<string, unknown>, regionSide: number = 256, options?: { downloadSlots?: readonly number[] }): GpuRunResult {
    if (this.closed) throw new Error('ResidentGpuBridge cerrado.');
    if (this.broken) throw this.broken;
    const buffers = terrain.buffers;
    const key = this.topologyKey(terrain, pageSetVersion, regionSide);
    const sharded = this.devices.length > 1 && (this.shardedOption ?? (key.capacityCells > 16_000_000));
    const plan = this.changed(key, buffers) ? this.planTopology(terrain, key, sharded, false) : null;
    const topo = this.topo!;
    const dirtyArr = new Uint8Array(buffers.dirty!);
    const dirtySlots = this.dirtySlotsOf(dirtyArr);
    const downloadSlots = options?.downloadSlots ? [...options.downloadSlots].sort((a, b) => a - b) : [];
    Atomics.store(this.control, 0, 0);
    this.statsArr.fill(0);
    try {
      this.worker.postMessage({
        kind: 'tick', buffers: plan ? buffers : undefined, dirtySlots,
        haloSlotsPerDevice: topo.haloLists(), downloadSlots, capacityCells: key.capacityCells, slots: key.slots,
        full: plan?.full, pass1Params, pass2Params,
      }, this.transferables(plan?.full));
    } catch (error) { this.synced = null; this.syncedDirtyBuffer = null; this.topo = null; throw error; }
    this.wait('ResidentGpuBridge tick', 120000);
    this.synced = key; this.syncedDirtyBuffer = buffers.dirty!; this.vramAhead = true;
    return this.finish(buffers, dirtyArr, 'kernel', plan?.kind ?? null);
  }

  /** Materializa en RAM del anfitrión todas las páginas autoritativas residentes en VRAM (T122 opción b). */
  flushToHost(terrain: SharedTerrain): void {
    if (this.closed) throw new Error('ResidentGpuBridge cerrado.');
    if (this.broken) throw this.broken;
    if (!this.synced) return;
    Atomics.store(this.control, 0, 0);
    this.worker.postMessage({ kind: 'flush', buffers: terrain.buffers });
    this.wait('ResidentGpuBridge flush', 60000);
    this.vramAhead = false;
  }

  /** Mata el subproceso Python (para la prueba de aborto); el siguiente run() debe fallar antes del swap. */
  killSubprocessForTest(): void {
    Atomics.store(this.control, 0, 0);
    this.worker.postMessage({ kind: 'kill' });
    // La muerte se observa en el siguiente run(), no en el hook: una espera breve para que SIGKILL llegue.
    this.synced = null; this.syncedDirtyBuffer = null; this.topo = null;
    Atomics.wait(this.control, 0, 0, 50);
    this.broken = null;
  }

  /** Espera a que el subproceso Python salga (≤ 2 s) antes de terminar el worker que lo posee. */
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    try { this.worker.postMessage({ kind: 'close' }); } catch { /* worker ya muerto */ }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.#exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]);
    clearTimeout(timer);
    await this.worker.terminate().catch(() => undefined);
  }
}

export function gpuNvrtcAvailable(): boolean {
  return !!process.env.COMPUTE_NVRTC || existsSync('/opt/cuda/lib64/libnvrtc.so');
}
export function gpuNvrtcSkipReason(): string {
  return 'COMPUTE_NVRTC no está definido y /opt/cuda/lib64/libnvrtc.so no existe: backend GPU omitido (skip, nunca pass).';
}
