/**
 * Banco Dual-GPU de «mundo vivo»: ecología residente (`ResidentGpuBridge`, pasadas
 * `ecology_pass1` + `ecology_pass2` sobre el layout SoA por páginas de 256 celdas de
 * `TileStore`, el mismo núcleo que `stepEcosystem` despacha a GPU) Y política neuronal
 * residente (`PolicyGpuBatcher` + `ResidentPolicyRegistry`, tabla de pesos en VRAM) sobre
 * los dispositivos [0, 1] (RTX 5070 Ti + RTX 2060) durante 100 ticks consecutivos.
 *
 * En cada tick la política se LANZA primero (`begin`, ambas GPU), la ecología corre
 * mientras tanto en su propio subproceso (ambas GPU) y luego se recoge la política: los
 * dos subprocesos CUDA trabajan a la vez. Hay nacimientos y muertes en cada tick (los
 * genomas nuevos se suben una sola vez con `sync_weights`).
 *
 * Verificación: 0 diferencias `Object.is` en el tick final contra la referencia CPU
 * (`runParallelEcosystem` en `StaticWorkerPool` para los 13 campos de la ecología;
 * `evaluatePoliciesCpu` para las políticas). Durante la ejecución se muestrea
 * `nvidia-smi` (utilización por GPU cada 50 ms) y, a mitad de corrida, la lista de
 * procesos de cómputo por GPU para atribuir ambos subprocesos a ambas tarjetas.
 *
 * Uso: COMPUTE_NVRTC=/opt/cuda/lib64/libnvrtc.so npx tsx scripts/banco-dual-gpu-mundo-vivo.mts \
 *        [--cells 1048576,4194304] [--actors 4000,20000,50000] [--ticks 100] [--devices 0,1] [--workers 12] [--out fichero.json]
 */
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResidentGpuBridge, GPU_FIELDS } from '../src/world/gpu/puente.js';
import {
  PolicyGpuBatcher, ResidentPolicyRegistry, type ResidentPolicyActor,
} from '../src/world/gpu/politica-gpu.js';
import { evaluatePoliciesCpu, founderPolicy, POLICY_WEIGHTS } from '../src/world/politica.js';
import { StaticWorkerPool } from '../src/world/paralelo/piscina.js';
import { DEFAULT_PARAMS } from '../src/world/params.js';
import type { SharedTerrain } from '../src/world/soa/terreno.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1]!;
}
const CELLS = arg('--cells', '1048576,4194304').split(',').map(Number);
const ACTORS = arg('--actors', '4000,20000,50000').split(',').map(Number);
const TICKS = Number(arg('--ticks', '100'));
const DEVICES = arg('--devices', '0,1').split(',').map(Number);
const WORKERS = Number(arg('--workers', '12'));
const OUT = process.argv.includes('--out') ? arg('--out', '') : null;
const VERSION = 1;
const R = DEFAULT_PARAMS.recursos;

// ---------------------------------------------------------------- ecología (SoA)
interface BenchTerrain extends SharedTerrain { pages: number }
function hash01(i: number, salt: number): number {
  let h = (i * 2654435761 + salt * 40503 + 12345) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h % 10000) / 10000;
}
/** Mismo constructor que scripts/banco-escala-extrema-gpu.mts (páginas completas de 256). */
function buildTerrain(n: number): BenchTerrain {
  if (n % 256 !== 0) throw new RangeError(`cells=${n} debe ser múltiplo de 256`);
  const pages = n / 256, gridW = Math.ceil(Math.sqrt(pages));
  const sab = (bytes: number) => new SharedArrayBuffer(bytes);
  const cells = new Int32Array(sab(n * 4)); for (let i = 0; i < n; i++) cells[i] = i;
  const stamps = new Uint32Array(sab(n * 4)); stamps.fill(VERSION);
  const pageX = new Int32Array(sab(pages * 4)), pageY = new Int32Array(sab(pages * 4));
  for (let s = 0; s < pages; s++) { pageX[s] = s % gridW; pageY[s] = Math.floor(s / gridW); }
  const around = new Int32Array(sab(pages * 9 * 4));
  for (let s = 0; s < pages; s++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const nx = pageX[s]! + dx, ny = pageY[s]! + dy;
    around[s * 9 + (dy + 1) * 3 + (dx + 1)] = (nx < 0 || ny < 0 || nx >= gridW) ? -1 : (ny * gridW + nx < pages ? ny * gridW + nx : -1);
  }
  const buffers: Record<string, SharedArrayBuffer> = {
    cells: cells.buffer as SharedArrayBuffer, stamps: stamps.buffer as SharedArrayBuffer, around: around.buffer as SharedArrayBuffer,
    pageX: pageX.buffer as SharedArrayBuffer, pageY: pageY.buffer as SharedArrayBuffer,
    dirty: sab(pages), woodAdded: sab(pages), woodAddedQueue: sab((pages + 2) * 4),
  };
  let salt = 1;
  for (const f of GPU_FIELDS) {
    const front = f.bytes === 8 ? new Float64Array(sab(n * 8)) : new Uint8Array(sab(n));
    const back = f.bytes === 8 ? new Float64Array(sab(n * 8)) : new Uint8Array(sab(n));
    if (f.name === 'terrain') { (front as Uint8Array).fill(2); for (let i = 0; i < n; i += 89) front[i] = 1; }
    else if (f.name === 'biome') { (front as Uint8Array).fill(1); for (let i = 0; i < n; i += 7) front[i] = 2; }
    else if (f.name === 'feature') { (front as Uint8Array).fill(13); for (let i = 0; i < n; i += 53) front[i] = 1; }
    else for (let i = 0; i < n; i++) (front as Float64Array)[i] = hash01(i, salt);
    buffers[f.name] = front.buffer as SharedArrayBuffer;
    buffers[`${f.name}Back`] = back.buffer as SharedArrayBuffer;
    salt++;
  }
  const regions = [];
  for (let begin = 0; begin < n; begin += 262144) regions.push({ id: regions.length, begin, end: Math.min(n, begin + 262144) });
  return { regions, buffers, version: VERSION, pages };
}
function swapParity(t: BenchTerrain): void {
  for (const f of GPU_FIELDS) {
    const front = t.buffers[f.name]!;
    t.buffers[f.name] = t.buffers[`${f.name}Back`]!; t.buffers[`${f.name}Back`] = front;
  }
}
const sparsePages = (t: BenchTerrain) => [0, t.pages >> 1, t.pages - 1];
function markSparseDirty(t: BenchTerrain): void {
  const dirty = new Uint8Array(t.buffers.dirty!); dirty.fill(0);
  for (const s of sparsePages(t)) dirty[s] = 1;
}
function ecologyDiffs(a: BenchTerrain, b: BenchTerrain, n: number): number {
  let diffs = 0;
  for (const f of GPU_FIELDS) {
    if (f.bytes === 8) {
      const x = new Float64Array(a.buffers[f.name]!), y = new Float64Array(b.buffers[f.name]!);
      for (let i = 0; i < n; i++) if (!Object.is(x[i], y[i])) diffs++;
    } else {
      const x = new Uint8Array(a.buffers[f.name]!), y = new Uint8Array(b.buffers[f.name]!);
      for (let i = 0; i < n; i++) if (x[i] !== y[i]) diffs++;
    }
  }
  return diffs;
}
/** Clima y luz variables por tick (lluvia cada 7 ticks; día/crepúsculo/noche). */
function weatherOf(k: number) {
  const rain = k % 7 === 3, light = [1, 0.4, 0][k % 3]!, tick = 1000 + 10 * k;
  return {
    cpu1: { phase: 'ecologia' as const, weather: rain ? 'rain' as const : 'clear' as const, light, version: VERSION, recursos: R },
    cpu2: { tick, weather: rain ? 'rain' as const : 'clear' as const, light, decaimientoFertilidad: R.decaimientoFertilidad, seed: 7, cuencas: 1, version: VERSION },
    gpu1: { version: VERSION, rain: rain ? 1 : 0, light, capacidadBosque: R.capacidadBosque, capacidadPastizal: R.capacidadPastizal, capacidadOtros: R.capacidadOtros, velocidadRegeneracion: R.velocidadRegeneracion, decaimientoComida: R.decaimientoComida },
    gpu2: { tick, version: VERSION, rain: rain ? 1 : 0, light, decaimientoFertilidad: R.decaimientoFertilidad, seed: 7, cuencas: 1 },
  };
}

// ---------------------------------------------------------------- política (actores)
function observe(actor: ResidentPolicyActor, index: number, k: number): void {
  for (let j = 0; j < 12; j++) actor.obs[j] = hash01(index * 12 + j, 1000 + k) * 2 - 1;
}
function makeActor(serial: number): ResidentPolicyActor {
  const id = `h${serial}`;
  const bias = new Float64Array(12);
  for (let j = 0; j < 12; j++) bias[j] = hash01(serial * 12 + j, 77) - 0.5;
  return { id, weights: founderPolicy(20261121, id).weights, obs: new Float64Array(12), bias };
}
function cpuPolicies(actors: readonly ResidentPolicyActor[]): Float64Array {
  const n = actors.length, obs = new Float64Array(n * 12), w = new Float64Array(n * POLICY_WEIGHTS), b = new Float64Array(n * 12);
  actors.forEach((a, i) => { obs.set(a.obs, i * 12); w.set(a.weights, i * POLICY_WEIGHTS); b.set(a.bias, i * 12); });
  return evaluatePoliciesCpu(obs, w, b, n);
}

// ---------------------------------------------------------------- nvidia-smi
interface GpuSample { t: number; index: number; util: number; memMiB: number }
function startSampler(path: string): () => GpuSample[] {
  const fd = openSync(path, 'w');
  const child = spawn('nvidia-smi', ['--query-gpu=timestamp,index,utilization.gpu,memory.used', '--format=csv,noheader,nounits', '-lms', '50'],
    { stdio: ['ignore', fd, 'ignore'] });
  return () => {
    child.kill('SIGTERM'); closeSync(fd);
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => {
      const [ts, index, util, mem] = line.split(',').map(s => s.trim());
      return { t: Date.parse(ts!.replace(/\//g, '-')), index: Number(index), util: Number(util), memMiB: Number(mem) };
    }).filter(s => Number.isFinite(s.index) && Number.isFinite(s.util));
  };
}
function gpuUuids(): Map<string, number> {
  const out = execFileSync('nvidia-smi', ['--query-gpu=index,uuid', '--format=csv,noheader'], { encoding: 'utf8' });
  return new Map(out.trim().split('\n').map(l => { const [i, u] = l.split(',').map(s => s.trim()); return [u!, Number(i)]; }));
}
/** Subprocesos Python CUDA propios (hijos directos de este proceso) y en qué GPU están. */
function ownComputeApps(uuids: Map<string, number>): { ecology: number[]; policy: number[]; ecologyPids: number[]; policyPids: number[] } {
  const ps = execFileSync('ps', ['-o', 'pid=,args=', '--ppid', String(process.pid)], { encoding: 'utf8' });
  const ecologyPids: number[] = [], policyPids: number[] = [];
  for (const line of ps.trim().split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line); if (!m) continue;
    if (m[2]!.includes('compute-ecology-gpu-resident.py')) ecologyPids.push(Number(m[1]));
    if (m[2]!.includes('compute-policy-gpu.py')) policyPids.push(Number(m[1]));
  }
  const apps = execFileSync('nvidia-smi', ['--query-compute-apps=pid,gpu_uuid', '--format=csv,noheader'], { encoding: 'utf8' });
  const ecology = new Set<number>(), policy = new Set<number>();
  for (const line of apps.trim().split('\n')) {
    const [pid, uuid] = line.split(',').map(s => s.trim());
    const index = uuids.get(uuid!); if (index === undefined) continue;
    if (ecologyPids.includes(Number(pid))) ecology.add(index);
    if (policyPids.includes(Number(pid))) policy.add(index);
  }
  return { ecology: [...ecology].sort(), policy: [...policy].sort(), ecologyPids, policyPids };
}
const median = (xs: number[]) => xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : NaN;
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;

// ---------------------------------------------------------------- corrida
interface Row {
  cells: number; actors: number; ticks: number; devices: number[];
  tickMedianMs: number; tickMeanMs: number; ecologyMedianMs: number; policyBeginMedianMs: number; policyWaitMedianMs: number;
  ecologyAloneMedianMs: number; policyAloneMedianMs: number; overlapGainMs: number;
  policyUploadPerTick: number; weightSyncPerTick: number; weightBytesAvoidedPerTick: number;
  ecologyUploadPerTick: number; ecologyDownloadPerTick: number;
  births: number; deaths: number; policyShards: number[];
  policyDeviceMedianMs: number[]; policyShardMedian: number[]; policyWorkerMedianMs: number;
  ecologyDiffs: number; policyDiffs: number; policyBackend: string;
  appsOnGpu: { ecology: number[]; policy: number[] };
  util: Record<number, { samples: number; mean: number; max: number; busyFraction: number }>;
}

async function cpuReference(n: number): Promise<{ terrain: BenchTerrain; ms: number }> {
  const terrain = buildTerrain(n);
  const pool = new StaticWorkerPool({ workers: WORKERS, moduleURL: new URL('../src/world/ecosystem-kernel.ts', import.meta.url), exportName: 'runParallelEcosystem' });
  const started = performance.now();
  try {
    for (let k = 0; k < TICKS; k++) {
      const w = weatherOf(k);
      pool.run({ regions: terrain.regions, buffers: terrain.buffers, params: w.cpu1 }); swapParity(terrain);
      pool.run({ regions: terrain.regions, buffers: terrain.buffers, params: w.cpu2 }); swapParity(terrain);
    }
  } finally { await pool.close(); }
  return { terrain, ms: performance.now() - started };
}

async function runCombo(n: number, P: number, reference: BenchTerrain, uuids: Map<string, number>, dir: string): Promise<Row> {
  const terrain = buildTerrain(n);
  const bridge = new ResidentGpuBridge(DEVICES);
  const batcher = new PolicyGpuBatcher(DEVICES);
  const registry = new ResidentPolicyRegistry(batcher);
  let serial = 0;
  let actors = Array.from({ length: P }, () => makeActor(serial++));
  const churn = Math.max(1, Math.round(P * 0.005));
  let births = 0, deaths = 0;
  const tickMs: number[] = [], ecoMs: number[] = [], polWaitMs: number[] = [], polBeginMs: number[] = [];
  const polDeviceMs: number[][] = DEVICES.map(() => []), polWorkerMs: number[] = [], polShards: number[][] = DEVICES.map(() => []);
  let ecoUp = 0, ecoDown = 0;
  let apps = { ecology: [] as number[], policy: [] as number[] };
  let finalPolicy: Float64Array = new Float64Array(0);
  const samplesPath = join(dir, `smi-${n}-${P}.csv`);
  let stopSampler: (() => GpuSample[]) | null = null;
  let windowStart = 0, windowEnd = 0;
  try {
    if (batcher.backend !== 'gpu') throw new Error(`policy GPU unavailable: ${batcher.fallbackReason}`);
    // El tick 0 incluye la sincronización completa de la ecología y la subida única de
    // los P genomas: queda fuera de las medianas y de los bytes por tick.
    let afterFirst = batcher.residentStats;
    stopSampler = startSampler(samplesPath);
    await new Promise(resolve => setTimeout(resolve, 1500)); // nvidia-smi arranca y toma la línea base
    windowStart = Date.now();
    for (let k = 0; k < TICKS; k++) {
      if (k > 0) {
        // Muertes y nacimientos deterministas (0,5 %/tick): solo los genomas nuevos se suben.
        const dead = new Set<number>(); for (let d = 0; d < churn; d++) dead.add((k * 7919 + d * 104729) % actors.length);
        actors = actors.filter((_, i) => !dead.has(i)); deaths += dead.size;
        for (let b = 0; b < dead.size; b++) actors.push(makeActor(serial++));
        births += dead.size;
      }
      actors.forEach((a, i) => observe(a, i, k));
      const w = weatherOf(k);
      const t0 = performance.now();
      const pending = registry.begin(actors);           // política: ambas GPU, sin pesos conocidos
      markSparseDirty(terrain);
      const t1 = performance.now();
      const eco = bridge.runTick(terrain, 0, w.gpu1, w.gpu2, 256, { downloadSlots: sparsePages(terrain) }); // ecología: ambas GPU
      const t2 = performance.now();
      const scores = pending.wait();
      const t3 = performance.now();
      if (k > 0) {
        const st = batcher.residentStats;
        st.lastDeviceMs.forEach((ms, d) => polDeviceMs[d]!.push(ms));
        st.lastShards.forEach((rows, d) => polShards[d]!.push(rows));
        polWorkerMs.push(st.lastWorkerMs);
      }
      if (k > 0) { polBeginMs.push(t1 - t0); tickMs.push(t3 - t0); ecoMs.push(t2 - t1); polWaitMs.push(t3 - t2); ecoUp += eco.uploadedBytes; ecoDown += eco.downloadedBytes; }
      if (k === 0) afterFirst = batcher.residentStats;
      if (k === TICKS - 1) finalPolicy = scores;
      if (k === Math.floor(TICKS / 2)) apps = ownComputeApps(uuids);
    }
    windowEnd = Date.now();
    const samples = stopSampler(); stopSampler = null;
    const table = batcher.residentStats;
    // Verificación en el tick final.
    const policyDiffs = (() => { const cpu = cpuPolicies(actors); let d = 0; for (let i = 0; i < cpu.length; i++) if (!Object.is(cpu[i], finalPolicy[i])) d++; return d; })();
    bridge.flushToHost(terrain);
    const ecologyDiffsN = ecologyDiffs(reference, terrain, n);
    // Línea base sin solapamiento (después de verificar): cada carga sola, 20 ticks.
    const ecoAlone: number[] = [], polAlone: number[] = [];
    for (let k = 0; k < 20; k++) {
      const w = weatherOf(TICKS + k); markSparseDirty(terrain);
      let s = performance.now(); bridge.runTick(terrain, 0, w.gpu1, w.gpu2, 256, { downloadSlots: sparsePages(terrain) }); ecoAlone.push(performance.now() - s);
      actors.forEach((a, i) => observe(a, i, TICKS + k));
      s = performance.now(); registry.evaluate(actors); polAlone.push(performance.now() - s);
    }
    const util: Row['util'] = {};
    for (const d of DEVICES) {
      const xs = samples.filter(s => s.index === d && s.t >= windowStart - 1000 && s.t <= windowEnd + 1000).map(s => s.util);
      util[d] = { samples: xs.length, mean: mean(xs), max: xs.length ? Math.max(...xs) : NaN, busyFraction: xs.length ? xs.filter(u => u > 0).length / xs.length : NaN };
    }
    const measured = TICKS - 1;
    const row: Row = {
      cells: n, actors: P, ticks: TICKS, devices: DEVICES,
      tickMedianMs: median(tickMs), tickMeanMs: mean(tickMs), ecologyMedianMs: median(ecoMs), policyBeginMedianMs: median(polBeginMs), policyWaitMedianMs: median(polWaitMs),
      ecologyAloneMedianMs: median(ecoAlone), policyAloneMedianMs: median(polAlone),
      overlapGainMs: median(ecoAlone) + median(polAlone) - median(tickMs),
      policyUploadPerTick: (table.evaluateUploadedBytes - afterFirst.evaluateUploadedBytes) / measured,
      weightSyncPerTick: (table.syncUploadedBytes - afterFirst.syncUploadedBytes) / measured,
      weightBytesAvoidedPerTick: (table.weightBytesAvoided - afterFirst.weightBytesAvoided) / measured,
      ecologyUploadPerTick: ecoUp / measured, ecologyDownloadPerTick: ecoDown / measured,
      births, deaths, policyShards: table.lastShards,
      policyDeviceMedianMs: polDeviceMs.map(median), policyShardMedian: polShards.map(median), policyWorkerMedianMs: median(polWorkerMs),
      ecologyDiffs: ecologyDiffsN, policyDiffs, policyBackend: batcher.backend,
      appsOnGpu: { ecology: apps.ecology, policy: apps.policy }, util,
    };
    return row;
  } finally {
    if (stopSampler) stopSampler();
    batcher.close();
    await bridge.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'banco-dual-gpu-'));
  const uuids = gpuUuids();
  const rows: Row[] = [];
  const references: { cells: number; cpuMs: number }[] = [];
  console.log(`devices=[${DEVICES}] ticks=${TICKS} cells=${CELLS} actors=${ACTORS} cpuWorkers=${WORKERS}`);
  try {
    for (const n of CELLS) {
      const ref = await cpuReference(n);
      references.push({ cells: n, cpuMs: ref.ms });
      console.log(`referencia CPU cells=${n}: ${TICKS} ticks en ${(ref.ms / 1000).toFixed(1)} s (${WORKERS} workers)`);
      for (const P of ACTORS) {
        const r = await runCombo(n, P, ref.terrain, uuids, dir);
        rows.push(r);
        console.log(`cells=${n} P=${P}: tick mediana=${r.tickMedianMs.toFixed(2)} ms (lanzar política ${r.policyBeginMedianMs.toFixed(2)} + eco ${r.ecologyMedianMs.toFixed(2)} + espera política ${r.policyWaitMedianMs.toFixed(2)}) | solos: eco ${r.ecologyAloneMedianMs.toFixed(2)} política ${r.policyAloneMedianMs.toFixed(2)} | política por GPU ${r.policyShardMedian.join('/')} filas en ${r.policyDeviceMedianMs.map(x => x.toFixed(2)).join('/')} ms | diffs eco=${r.ecologyDiffs} política=${r.policyDiffs} | GPU eco=${r.appsOnGpu.ecology} política=${r.appsOnGpu.policy} | util ${JSON.stringify(r.util)}`);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  console.log('\n| Celdas | Actores | Tick mediana (ms) | Lanzar política (ms) | Ecología (ms) | Espera política (ms) | Eco sola (ms) | Política sola (ms) | Solape ganado (ms) | Subida política/tick (B) | Pesos sync/tick (B) | Pesos evitados/tick (B) | Reparto política (mediana filas) | GPU política ms/disp. | Diffs eco | Diffs política | GPU eco | GPU política | Util GPU0 media/máx/ocupada | Util GPU1 media/máx/ocupada |');
  console.log('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---:|---:|---|---|---|---|');
  for (const r of rows) {
    const u = (d: number) => r.util[d] ? `${r.util[d]!.mean.toFixed(1)} % / ${r.util[d]!.max} % / ${(100 * r.util[d]!.busyFraction).toFixed(0)} % (${r.util[d]!.samples} m.)` : '-';
    console.log(`| ${r.cells} | ${r.actors} | ${r.tickMedianMs.toFixed(2)} | ${r.policyBeginMedianMs.toFixed(2)} | ${r.ecologyMedianMs.toFixed(2)} | ${r.policyWaitMedianMs.toFixed(2)} | ${r.ecologyAloneMedianMs.toFixed(2)} | ${r.policyAloneMedianMs.toFixed(2)} | ${r.overlapGainMs.toFixed(2)} | ${Math.round(r.policyUploadPerTick)} | ${Math.round(r.weightSyncPerTick)} | ${Math.round(r.weightBytesAvoidedPerTick)} | ${r.policyShardMedian.join('/')} | ${r.policyDeviceMedianMs.map(x => x.toFixed(2)).join('/')} | ${r.ecologyDiffs} | ${r.policyDiffs} | [${r.appsOnGpu.ecology}] | [${r.appsOnGpu.policy}] | ${u(0)} | ${u(1)} |`);
  }
  const summary = { date: new Date().toISOString(), devices: DEVICES, ticks: TICKS, references, rows };
  if (OUT) writeFileSync(OUT, JSON.stringify(summary, null, 2));
  const bad = rows.filter(r => r.ecologyDiffs !== 0 || r.policyDiffs !== 0 || r.policyBackend !== 'gpu'
    || DEVICES.some(d => !r.appsOnGpu.ecology.includes(d) || !r.appsOnGpu.policy.includes(d))
    || r.policyShardMedian.some(rows => !(rows > 0)));
  if (bad.length) { console.error(`FALLO: paridad o uso dual-GPU no demostrado en ${bad.length} filas`); process.exitCode = 1; }
  else console.log(`\nOK: ${rows.length} combinaciones, 0 diffs Object.is (ecología y política) y ambos subprocesos CUDA presentes en las GPU [${DEVICES}].`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
