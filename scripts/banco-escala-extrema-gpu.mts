/**
 * Banco de escala extrema GPU (T122) — tick ecológico íntegro (pasada 1 `ecologia` +
 * pasada 2 `kernel`) sobre buffers SoA fabricados directamente, sin crear millones de
 * objetos `Tile` ni proxies: se mide el despacho `TileStore`/`ResidentGpuBridge`/
 * `StaticWorkerPool` sobre el mismo layout por páginas de 256 celdas.
 *
 * Uso: COMPUTE_NVRTC=/opt/cuda/lib64/libnvrtc.so npx tsx scripts/banco-escala-extrema-gpu.mts [--sizes=65536,1048576] [--reps=N]
 * Estado estacionario: tras la sincronización inicial, cada tick marca 3 páginas sucias
 * dispersas (3 × 19 200 B = 57 600 B de subida ≤ 1 MB). Paridad `Object.is` bit a bit
 * entre CPU 1 hilo y GPU sobre los 13 campos tras los ticks medidos (1 M y 4 M).
 */
import { ResidentGpuBridge, GPU_FIELDS } from '../src/world/gpu/puente.js';
import { StaticWorkerPool } from '../src/world/paralelo/piscina.js';
import { runParallelEcosystem } from '../src/world/ecosystem-kernel.js';
import { DEFAULT_PARAMS } from '../src/world/params.js';
import type { SharedTerrain } from '../src/world/soa/terreno.js';

const VERSION = 1;
const TICK = 100;
const FLOAT_FIELDS = GPU_FIELDS.filter(f => f.bytes === 8).map(f => f.name);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}
const SIZES = (arg('--sizes') ?? '65536,1048576,4194304,8388608,18432000').split(',').map(Number);
const REPS_ARG = arg('--reps') ? Number(arg('--reps')) : undefined;

function hash01(i: number, salt: number): number {
  let h = (i * 2654435761 + salt * 40503 + 12345) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h % 10000) / 10000;
}

interface BenchTerrain extends SharedTerrain { pages: number }

function buildTerrain(n: number): BenchTerrain {
  if (n % 256 !== 0) throw new RangeError(`N=${n} debe ser múltiplo de 256 (páginas completas).`);
  const pages = n / 256;
  const gridW = Math.ceil(Math.sqrt(pages));
  const sab = (bytes: number) => new SharedArrayBuffer(bytes);
  const cells = new Int32Array(sab(n * 4));
  for (let i = 0; i < n; i++) cells[i] = i;
  const stamps = new Uint32Array(sab(n * 4)); stamps.fill(VERSION);
  const pageX = new Int32Array(sab(pages * 4)), pageY = new Int32Array(sab(pages * 4));
  for (let s = 0; s < pages; s++) { pageX[s] = s % gridW; pageY[s] = Math.floor(s / gridW); }
  const around = new Int32Array(sab(pages * 9 * 4));
  for (let s = 0; s < pages; s++) {
    const px = pageX[s]!, py = pageY[s]!;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = px + dx, ny = py + dy;
      around[s * 9 + (dy + 1) * 3 + (dx + 1)] = (nx < 0 || ny < 0 || nx >= gridW) ? -1 : (ny * gridW + nx < pages ? ny * gridW + nx : -1);
    }
  }
  const buffers: Record<string, SharedArrayBuffer> = {
    cells: cells.buffer as SharedArrayBuffer, stamps: stamps.buffer as SharedArrayBuffer,
    around: around.buffer as SharedArrayBuffer, pageX: pageX.buffer as SharedArrayBuffer,
    pageY: pageY.buffer as SharedArrayBuffer,
    dirty: sab(pages), woodAdded: sab(pages), woodAddedQueue: sab((pages + 2) * 4),
  };
  let salt = 1;
  for (const f of GPU_FIELDS) {
    const front = f.bytes === 8 ? new Float64Array(sab(n * 8)) : new Uint8Array(sab(n));
    const back = f.bytes === 8 ? new Float64Array(sab(n * 8)) : new Uint8Array(sab(n));
    if (f.name === 'terrain') (front as Uint8Array).fill(2);
    else if (f.name === 'biome') (front as Uint8Array).fill(1);
    else if (f.name === 'feature') (front as Uint8Array).fill(13);
    else for (let i = 0; i < n; i++) (front as Float64Array)[i] = hash01(i, salt);
    if (f.name === 'terrain') for (let i = 0; i < n; i += 89) (front as Uint8Array)[i] = 1;
    if (f.name === 'biome') for (let i = 0; i < n; i += 7) (front as Uint8Array)[i] = 2;
    if (f.name === 'feature') for (let i = 0; i < n; i += 53) (front as Uint8Array)[i] = 1;
    buffers[f.name] = front.buffer as SharedArrayBuffer;
    buffers[`${f.name}Back`] = back.buffer as SharedArrayBuffer;
    salt++;
  }
  const regions = [];
  const REGION_CELLS = 262144;
  for (let begin = 0; begin < n; begin += REGION_CELLS) regions.push({ id: regions.length, begin, end: Math.min(n, begin + REGION_CELLS) });
  return { regions, buffers, version: VERSION, pages };
}

function swapParity(t: BenchTerrain): void {
  for (const f of GPU_FIELDS) {
    const front = t.buffers[f.name]!;
    t.buffers[f.name] = t.buffers[`${f.name}Back`]!;
    t.buffers[`${f.name}Back`] = front;
  }
}
function markSparseDirty(t: BenchTerrain): void {
  const dirty = new Uint8Array(t.buffers.dirty!);
  dirty.fill(0);
  for (const s of [0, t.pages >> 1, t.pages - 1]) dirty[s] = 1;
}
function countDiffs(a: BenchTerrain, b: BenchTerrain, n: number): number {
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

const R = DEFAULT_PARAMS.recursos;
const pass1CpuParams = { phase: 'ecologia' as const, weather: 'clear' as const, light: 1, version: VERSION, recursos: R };
const pass2CpuParams = { tick: TICK, weather: 'clear' as const, light: 1, decaimientoFertilidad: R.decaimientoFertilidad, seed: 7, cuencas: 1, version: VERSION };
const pass1GpuParams = { version: VERSION, rain: 0, light: 1, capacidadBosque: R.capacidadBosque, capacidadPastizal: R.capacidadPastizal, capacidadOtros: R.capacidadOtros, velocidadRegeneracion: R.velocidadRegeneracion, decaimientoComida: R.decaimientoComida };
const pass2GpuParams = { tick: TICK, version: VERSION, rain: 0, light: 1, decaimientoFertilidad: R.decaimientoFertilidad, seed: 7, cuencas: 1 };

interface Row {
  cells: number; backend: string; reps: number; medianMs: number; meanMs: number;
  kernelMs: number; uploadedPerTick: number; downloadedPerTick: number; diffsVsCpu1: number | null; error?: string;
}

async function main(): Promise<void> {
  const rows: Row[] = [];
  const backends: { name: string; kind: 'cpu1' | 'pool' | 'gpu'; workers?: number; devices?: number[] }[] = [
    { name: 'CPU 1 hilo', kind: 'cpu1' },
    { name: 'CPU 8 workers', kind: 'pool', workers: 8 },
    { name: 'CPU 28 workers', kind: 'pool', workers: 28 },
    { name: 'GPU [0] RTX 5070 Ti', kind: 'gpu', devices: [0] },
    { name: 'GPU [0,1] RTX 5070 Ti + RTX 2060', kind: 'gpu', devices: [0, 1] },
  ];
  for (const n of SIZES) {
    const reps = REPS_ARG ?? (n <= 1048576 ? 5 : n <= 4194304 ? 3 : 2);
    let cpu1Terrain: BenchTerrain | null = null;
    for (const backend of backends) {
      const row: Row = { cells: n, backend: backend.name, reps, medianMs: NaN, meanMs: NaN, kernelMs: 0, uploadedPerTick: 0, downloadedPerTick: 0, diffsVsCpu1: null };
      let pool: StaticWorkerPool | null = null;
      let bridge: ResidentGpuBridge | null = null;
      try {
        const t = buildTerrain(n);
        if (backend.kind === 'pool') {
          pool = new StaticWorkerPool({ workers: backend.workers!, moduleURL: new URL('../src/world/ecosystem-kernel.ts', import.meta.url), exportName: 'runParallelEcosystem' });
        }
        if (backend.kind === 'gpu') bridge = new ResidentGpuBridge(backend.devices!);
        const runTick = (): { kernelMs: number; up: number; down: number } => {
          markSparseDirty(t);
          if (backend.kind === 'gpu') {
            const a = bridge!.run(t, 0, 'ecologia', pass1GpuParams); swapParity(t);
            const b = bridge!.run(t, 0, 'kernel', pass2GpuParams); swapParity(t);
            return { kernelMs: a.kernelMs + b.kernelMs, up: a.uploadedBytes + b.uploadedBytes, down: a.downloadedBytes + b.downloadedBytes };
          }
          if (backend.kind === 'pool') {
            pool!.run({ regions: t.regions, buffers: t.buffers, params: pass1CpuParams }); swapParity(t);
            pool!.run({ regions: t.regions, buffers: t.buffers, params: pass2CpuParams }); swapParity(t);
            return { kernelMs: 0, up: 0, down: 0 };
          }
          runParallelEcosystem({ regions: t.regions, buffers: t.buffers, params: pass1CpuParams, workerIndex: 0 }); swapParity(t);
          runParallelEcosystem({ regions: t.regions, buffers: t.buffers, params: pass2CpuParams, workerIndex: 0 }); swapParity(t);
          return { kernelMs: 0, up: 0, down: 0 };
        };
        runTick(); // calentamiento + sincronización GPU (fuera de la medición)
        const times: number[] = [];
        let up = 0, down = 0, kern = 0;
        for (let r = 0; r < reps; r++) {
          const started = performance.now();
          const s = runTick();
          times.push(performance.now() - started);
          up += s.up; down += s.down; kern += s.kernelMs;
        }
        times.sort((a, b) => a - b);
        row.medianMs = times[Math.floor(times.length / 2)]!;
        row.meanMs = times.reduce((s, v) => s + v, 0) / times.length;
        row.kernelMs = kern / reps; row.uploadedPerTick = up / reps; row.downloadedPerTick = down / reps;
        if (backend.kind === 'cpu1') cpu1Terrain = t;
        else if (cpu1Terrain && (n === 1048576 || n === 4194304)) row.diffsVsCpu1 = countDiffs(cpu1Terrain, t, n);
        console.log(`cells=${n} backend=${backend.name} medianMs=${row.medianMs.toFixed(2)} meanMs=${row.meanMs.toFixed(2)} kernelMs=${row.kernelMs.toFixed(2)} up=${row.uploadedPerTick} down=${row.downloadedPerTick} diffs=${row.diffsVsCpu1 ?? '-'}`);
      } catch (error) {
        row.error = (error as Error).message.slice(0, 300);
        console.log(`cells=${n} backend=${backend.name} ERROR ${row.error}`);
      } finally {
        if (bridge) await bridge.close().catch(() => undefined);
        if (pool) await pool.close().catch(() => undefined);
      }
      rows.push(row);
    }
  }
  console.log('\n| Celdas | Backend | Mediana tick (ms) | Media (ms) | Kernel GPU (ms) | Subida/tick (B) | Bajada/tick (B) | Diffs vs CPU1 |');
  console.log('|---:|---|---:|---:|---:|---:|---:|---:|');
  for (const r of rows) {
    console.log(r.error
      ? `| ${r.cells} | ${r.backend} | ERROR: ${r.error} | | | | | |`
      : `| ${r.cells} | ${r.backend} | ${r.medianMs.toFixed(2)} | ${r.meanMs.toFixed(2)} | ${r.kernelMs.toFixed(2)} | ${Math.round(r.uploadedPerTick)} | ${Math.round(r.downloadedPerTick)} | ${r.diffsVsCpu1 ?? '-'} |`);
  }
  const badParity = rows.filter(r => r.diffsVsCpu1 !== null && r.diffsVsCpu1 !== 0);
  if (badParity.length) { console.error(`PARIDAD ROTA: ${JSON.stringify(badParity)}`); process.exitCode = 1; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
