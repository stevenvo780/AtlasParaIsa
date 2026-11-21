/**
 * Sync incremental de páginas del puente GPU residente (v15).
 *
 * Un mundo vivo que explora activa o retira chunks de 16 × 16 (una página de 256 celdas) unas 60 veces
 * por día simulado. Antes, cualquier cambio de `version`/`pageSetVersion`/`totalCells` liberaba y
 * reasignaba toda la VRAM y re-subía los 13 campos de TODAS las páginas a cada GPU. Ahora un chunk que
 * entra sin redimensionar la arena sube solo sus páginas, las vecindades tocadas y los tramos de `cells`.
 *
 * La arena de esta prueba imita a `TileStore` (`src/world/soa/terreno.ts` + `arena.ts`): reutiliza
 * ranuras LIFO, crece ×1,25 reasignando todos los SharedArrayBuffer, sella la presencia con una versión
 * nueva en cada carga, recalcula `around` y ordena `cells` por región (256 × 256) → página → offset.
 * Las páginas nuevas NO se marcan sucias: el puente debe detectarlas solo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GPU_FIELDS, ResidentGpuBridge, gpuNvrtcAvailable, gpuNvrtcSkipReason } from '../src/world/gpu/puente.js';
import { runParallelEcosystem } from '../src/world/ecosystem-kernel.js';
import { DEFAULT_PARAMS } from '../src/world/params.js';
import type { SharedTerrain } from '../src/world/soa/terreno.js';

const skip = gpuNvrtcAvailable() ? false : gpuNvrtcSkipReason();
const R = DEFAULT_PARAMS.recursos;
const sab = (bytes: number) => new SharedArrayBuffer(bytes);
type Arr = Float64Array | Uint8Array;
const FIELD_BYTES_PER_CELL = GPU_FIELDS.reduce((s, f) => s + f.bytes, 0);
/** Bytes de una página en un sync incremental (13 campos + sellos + pageX/Y + 9 `around` + 256 `cells`). */
const PAGE_SYNC_BYTES = 256 * FIELD_BYTES_PER_CELL + 256 * 4 + 8 + 9 * 36 + 256 * 4;

function hash(x: number, y: number, salt: number): number {
  let v = (Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77) ^ Math.imul(salt + 1, 0xc2b2ae3d)) >>> 0;
  v = Math.imul(v ^ (v >>> 16), 0x7feb352d) >>> 0; v = Math.imul(v ^ (v >>> 15), 0x846ca68b) >>> 0;
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
}

interface Twin { front: Record<string, Arr>; back: Record<string, Arr>; dirty: Uint8Array; woodAdded: Uint8Array; queue: Int32Array; }

/** Arena de páginas con dos gemelos de campos (CPU de referencia y GPU) sobre la misma topología. */
class MiniArena {
  cap = 0; highWater = 0; resizes = 0; version = 0; pageSetVersion = 0;
  readonly free: number[] = [];
  readonly regions = new Map<string, number>();
  readonly masks = new Map<number, Uint8Array>();
  stamps: Uint32Array = new Uint32Array(0); pageX: Int32Array = new Int32Array(0); pageY: Int32Array = new Int32Array(0); around: Int32Array = new Int32Array(0);
  cells = new Int32Array(sab(0));
  readonly twins: Twin[] = [0, 1].map(() => ({ front: {}, back: {}, dirty: new Uint8Array(0), woodAdded: new Uint8Array(0), queue: new Int32Array(0) }));
  constructor(initialCap: number) { this.grow(initialCap); this.resizes = 0; }

  private grow(n: number): void {
    const re = <T extends Arr | Uint32Array | Int32Array>(old: T, make: (len: number) => T, len: number, fill?: number): T => {
      const next = make(len); if (fill !== undefined) (next as Int32Array).fill(fill); (next as Int32Array).set(old as Int32Array); return next;
    };
    this.stamps = re(this.stamps, l => new Uint32Array(sab(l * 4)), n * 256);
    this.pageX = re(this.pageX, l => new Int32Array(sab(l * 4)), n);
    this.pageY = re(this.pageY, l => new Int32Array(sab(l * 4)), n);
    this.around = re(this.around, l => new Int32Array(sab(l * 4)), n * 9, -1);
    for (const t of this.twins) {
      for (const f of GPU_FIELDS) for (const side of [t.front, t.back]) {
        const old = side[f.name] ?? (f.bytes === 8 ? new Float64Array(0) : new Uint8Array(0));
        side[f.name] = f.bytes === 8 ? re(old as Float64Array, l => new Float64Array(sab(l * 8)), n * 256) : re(old as Uint8Array, l => new Uint8Array(sab(l)), n * 256);
      }
      t.dirty = re(t.dirty, l => new Uint8Array(sab(l)), n);
      t.woodAdded = re(t.woodAdded, l => new Uint8Array(sab(l)), n);
      t.queue = new Int32Array(sab((n + 2) * 4));
    }
    this.cap = n; this.resizes++;
  }
  private reserve(): number {
    const reused = this.free.pop();
    if (reused !== undefined) return reused;
    if (this.highWater === this.cap) this.grow(Math.max(this.cap + 1, Math.ceil(this.cap * 1.25)));
    return this.highWater++;
  }
  private initCell(cell: number, gx: number, gy: number, salt: number): void {
    const h = (k: number) => hash(gx, gy, salt * 31 + k);
    const v: Record<string, number> = {
      moisture: 0.1 + 0.85 * h(0), vegetation: h(1), food: h(2),
      wood: h(3) < 0.25 ? Number.NaN : 12 * h(4), growth: h(5) < 0.1 ? Number.NaN : 0.4 + 0.6 * h(6),
      fertility: 0.2 + 0.8 * h(7), cultivation: h(8) < 0.2 ? Number.NaN : 0.5 * h(9),
      traffic: h(10) < 0.2 ? Number.NaN : 0.45 * h(11), drinkingWater: h(12) < 0.15 ? Number.NaN : h(13),
      terrain: h(14) < 0.08 ? 1 : 2 + Math.floor(h(15) * 3), biome: 1 + Math.floor(h(16) * 6),
      feature: 1 + Math.floor(h(17) * 13), life: h(18) < 0.1 ? Number.NaN : h(19),
    };
    for (const t of this.twins) for (const f of GPU_FIELDS) t.front[f.name]![cell] = v[f.name]!;
  }
  /** Carga una topología nueva (como `TileStore.map` + `sweep`): sella, reserva, libera y reordena. */
  load(desired: Map<string, { px: number; py: number; mask: Uint8Array }>, salt: number): void {
    const before = new Set(this.regions.keys());
    this.version = (this.version + 1) >>> 0;
    let reserved = false;
    const entries = [...desired.entries()].sort((a, b) => a[1].py - b[1].py || a[1].px - b[1].px);
    for (const [key, page] of entries) {
      let slot = this.regions.get(key); let prev: Uint8Array | undefined;
      if (slot === undefined) {
        slot = this.reserve(); reserved = true; this.regions.set(key, slot);
        this.pageX[slot] = page.px; this.pageY[slot] = page.py;
      } else prev = this.masks.get(slot);
      for (let o = 0; o < 256; o++) if (page.mask[o]) {
        const cell = slot * 256 + o; this.stamps[cell] = this.version;
        if (!prev || !prev[o]) this.initCell(cell, page.px * 16 + (o & 15), page.py * 16 + (o >> 4), salt);
      }
      this.masks.set(slot, page.mask.slice());
    }
    for (const [key, slot] of [...this.regions.entries()]) if (!desired.has(key)) { this.regions.delete(key); this.masks.delete(slot); this.free.push(slot); }
    for (const slot of this.regions.values()) {
      const px = this.pageX[slot]!, py = this.pageY[slot]!;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) this.around[slot * 9 + (dy + 1) * 3 + dx + 1] = this.regions.get(`${px + dx},${py + dy}`) ?? -1;
    }
    if (reserved || before.size !== this.regions.size || [...before].some(k => !this.regions.has(k))) this.pageSetVersion = (this.pageSetVersion + 1) >>> 0;
    const ordered: number[] = [];
    const slotsSorted = [...this.regions.values()].sort((a, b) => {
      const ra = [Math.floor(this.pageY[a]! / 16), Math.floor(this.pageX[a]! / 16)], rb = [Math.floor(this.pageY[b]! / 16), Math.floor(this.pageX[b]! / 16)];
      return ra[0]! - rb[0]! || ra[1]! - rb[1]! || this.pageY[a]! - this.pageY[b]! || this.pageX[a]! - this.pageX[b]!;
    });
    for (const slot of slotsSorted) for (let o = 0; o < 256; o++) if (this.stamps[slot * 256 + o] === this.version) ordered.push(slot * 256 + o);
    this.cells = new Int32Array(sab(ordered.length * 4)); this.cells.set(ordered);
  }
  terrain(twin: Twin): SharedTerrain {
    const buffers: Record<string, SharedArrayBuffer> = {
      cells: this.cells.buffer as SharedArrayBuffer, stamps: this.stamps.buffer as SharedArrayBuffer, around: this.around.buffer as SharedArrayBuffer,
      pageX: this.pageX.buffer as SharedArrayBuffer, pageY: this.pageY.buffer as SharedArrayBuffer, dirty: twin.dirty.buffer as SharedArrayBuffer,
      woodAdded: twin.woodAdded.buffer as SharedArrayBuffer, woodAddedQueue: twin.queue.buffer as SharedArrayBuffer,
    };
    for (const f of GPU_FIELDS) { buffers[f.name] = twin.front[f.name]!.buffer as SharedArrayBuffer; buffers[`${f.name}Back`] = twin.back[f.name]!.buffer as SharedArrayBuffer; }
    return { regions: [{ id: 0, begin: 0, end: this.cells.length }], buffers, version: this.version };
  }
  swap(twin: Twin): void { for (const f of GPU_FIELDS) { const x = twin.front[f.name]!; twin.front[f.name] = twin.back[f.name]!; twin.back[f.name] = x; } }
  /** Diferencias `Object.is` en los 13 campos de todas las celdas presentes. */
  diffs(): { count: number; first: string | null } {
    let count = 0, first: string | null = null;
    const [cpu, gpu] = this.twins as [Twin, Twin];
    for (const f of GPU_FIELDS) {
      const a = cpu.front[f.name]!, b = gpu.front[f.name]!;
      for (let i = 0; i < this.cells.length; i++) {
        const c = this.cells[i]!;
        if (!Object.is(a[c], b[c])) { count++; first ??= `${f.name}@${c}: cpu=${a[c]} gpu=${b[c]}`; }
      }
    }
    return { count, first };
  }
}

/** Páginas por anillos de Chebyshev alrededor del origen: un territorio compacto que crece por su frontera. */
function ringOrder(n: number): [number, number][] {
  const out: [number, number][] = [[0, 0]];
  for (let r = 1; out.length < n; r++) {
    for (let x = -r; x <= r && out.length < n; x++) out.push([x, -r]);
    for (let y = -r + 1; y <= r && out.length < n; y++) out.push([r, y]);
    for (let x = r - 1; x >= -r && out.length < n; x--) out.push([x, r]);
    for (let y = r - 1; y > -r && out.length < n; y--) out.push([-r, y]);
  }
  return out;
}
const fullMask = () => new Uint8Array(256).fill(1);

interface Scenario { desired: Map<string, { px: number; py: number; mask: Uint8Array }>; queue: [number, number][]; retired: [number, number][]; }
function scenario(initial: number): Scenario {
  const order = ringOrder(4096);
  const desired = new Map<string, { px: number; py: number; mask: Uint8Array }>();
  for (const [px, py] of order.slice(0, initial)) {
    const mask = fullMask();
    // Bordes parciales, como un mundo que no está alineado a 16.
    if ((px + py) % 5 === 0) for (let o = 0; o < 256; o += 37) mask[o] = 0;
    desired.set(`${px},${py}`, { px, py, mask });
  }
  return { desired, queue: order.slice(initial), retired: [] };
}

function stepBoth(arena: MiniArena, bridge: ResidentGpuBridge, tick: number) {
  const [cpu, gpu] = arena.twins as [Twin, Twin];
  const weather = (tick / 10) % 3 === 0 ? 'rain' : 'clear';
  const light = (tick / 10) % 4 === 3 ? 0.4 : 1;
  const version = arena.version;
  const p1Cpu = { phase: 'ecologia' as const, weather: weather as 'rain' | 'clear', light, version, recursos: R };
  const p1Gpu = { version, rain: weather === 'rain' ? 1 : 0, light, capacidadBosque: R.capacidadBosque, capacidadPastizal: R.capacidadPastizal,
    capacidadOtros: R.capacidadOtros, velocidadRegeneracion: R.velocidadRegeneracion, decaimientoComida: R.decaimientoComida };
  const p2Cpu = { tick, weather: weather as 'rain' | 'clear', light, decaimientoFertilidad: R.decaimientoFertilidad, seed: 7, cuencas: 0.55, version };
  const p2Gpu = { tick, version, rain: weather === 'rain' ? 1 : 0, light, decaimientoFertilidad: R.decaimientoFertilidad, seed: 7, cuencas: 0.55 };
  const tCpu = arena.terrain(cpu);
  runParallelEcosystem({ regions: tCpu.regions, buffers: tCpu.buffers, params: p1Cpu, workerIndex: 0 }); arena.swap(cpu);
  const tCpu2 = arena.terrain(cpu);
  runParallelEcosystem({ regions: tCpu2.regions, buffers: tCpu2.buffers, params: p2Cpu, workerIndex: 0 }); arena.swap(cpu);
  const eco = bridge.run(arena.terrain(gpu), arena.pageSetVersion, 'ecologia', p1Gpu, 256); arena.swap(gpu);
  const ker = bridge.run(arena.terrain(gpu), arena.pageSetVersion, 'kernel', p2Gpu, 256); arena.swap(gpu);
  // Altas de wood: mismo conjunto de páginas en ambos gemelos; luego se consumen (como commitParallel).
  const woodPages = (t: Twin) => { const n = t.queue[1]!; return [...t.queue.subarray(2, 2 + n)].sort((a, b) => a - b); };
  const woodCpu = woodPages(cpu), woodGpu = woodPages(gpu);
  for (const t of [cpu, gpu]) { t.woodAdded.fill(0); t.queue.fill(0); t.dirty.fill(0); }
  return { eco, ker, woodCpu, woodGpu };
}

/** Mutaciones de actores CPU entre ticks: mismas escrituras en ambos gemelos; el GPU marca la página sucia. */
function mutate(arena: MiniArena, salt: number): void {
  const n = arena.cells.length;
  for (let k = 0; k < 7; k++) {
    const cell = arena.cells[Math.floor(hash(salt, k, 99) * n)]!;
    for (const [ti, t] of arena.twins.entries()) {
      (t.front.moisture as Float64Array)[cell] = hash(cell, salt, 1);
      (t.front.life as Float64Array)[cell] = k % 3 === 0 ? Number.NaN : hash(cell, salt, 2);
      (t.front.terrain as Uint8Array)[cell] = k % 2 ? 1 : 3;
      (t.front.feature as Uint8Array)[cell] = 1 + (k % 13);
      (t.front.wood as Float64Array)[cell] = k % 2 ? Number.NaN : 3.5;
      if (ti === 1) t.dirty[cell >>> 8] = 1;
    }
  }
}

type Op = 'add' | 'retire' | 'partial' | 'dirty';
const BAND_OPS: Op[] = ['add', 'add', 'retire', 'add', 'partial', 'add', 'dirty', 'retire', 'add', 'partial', 'add', 'add'];

function applyOp(arena: MiniArena, sc: Scenario, op: Op, i: number): void {
  if (op === 'dirty') { mutate(arena, i); return; }
  if (op === 'add') {
    // Cada tres altas, vuelve un chunk retirado (otra ranura); el resto avanza la frontera
    // y reutiliza la ranura que liberó la última salida (ranura reutilizada con otras coordenadas).
    const back = i % 3 === 0 ? sc.retired.shift() : undefined;
    const [px, py] = back ?? sc.queue.shift()!;
    sc.desired.set(`${px},${py}`, { px, py, mask: fullMask() });
  } else if (op === 'retire') {
    const keys = [...sc.desired.keys()];
    const key = keys[Math.floor(hash(i, 3, 5) * keys.length)]!;
    const page = sc.desired.get(key)!; sc.desired.delete(key); sc.retired.push([page.px, page.py]);
  } else {
    const keys = [...sc.desired.keys()];
    const page = sc.desired.get(keys[Math.floor(hash(i, 7, 11) * keys.length)]!)!;
    const mask = page.mask.slice();
    for (const o of [3, 77, 200, 255]) mask[o] = mask[o] ? 0 : 1;
    if (!mask.some(Boolean)) mask[0] = 1;
    page.mask = mask;
  }
  arena.load(sc.desired, i);
}

const CONFIGS: { name: string; devices: number[]; options?: { sharded?: boolean; weights?: number[] }; bands: number[] }[] = [
  { name: 'GPU [0]', devices: [0], bands: [64, 125, 247] },
  { name: 'GPU [1]', devices: [1], bands: [64, 125, 247] },
  { name: 'Dual-GPU [0,1] replicado', devices: [0, 1], bands: [64, 125, 247, 484, 512] },
  { name: 'Dual-GPU [0,1] repartido (sharded 70/30)', devices: [0, 1], options: { sharded: true, weights: [0.7, 0.3] }, bands: [64, 125, 247, 484, 512] },
];

for (const cfg of CONFIGS) {
  test(`v15 sync incremental ${cfg.name}: 0 diferencias Object.is en 13 campos al activar/retirar chunks (64→${cfg.bands.at(-1)} páginas, redimensiones, costura)`, { skip, timeout: 600_000 }, async t => {
    const arena = new MiniArena(64);
    const sc = scenario(64);
    arena.load(sc.desired, 0);
    const bridge = new ResidentGpuBridge(cfg.devices, cfg.options);
    let tick = 100, steps = 0, totalDiffs = 0, deltaAdds = 0;
    const deltaBytes: number[] = [];
    try {
      const check = (label: string, r: ReturnType<typeof stepBoth>) => {
        const d = arena.diffs();
        totalDiffs += d.count;
        assert.equal(d.count, 0, `${cfg.name} ${label} tick=${tick}: ${d.count} diferencias (primera: ${d.first})`);
        assert.deepEqual(r.woodGpu, r.woodCpu, `${cfg.name} ${label}: altas de wood`);
      };
      check('inicio', stepBoth(arena, bridge, tick)); tick += 10; steps++;
      for (const band of cfg.bands) {
        // Salto de banda: muchos chunks a la vez (incluye redimensiones de la arena).
        if (sc.desired.size < band) {
          while (sc.desired.size < band) { const [px, py] = sc.queue.shift()!; sc.desired.set(`${px},${py}`, { px, py, mask: fullMask() }); }
          arena.load(sc.desired, steps);
          check(`banda ${band}`, stepBoth(arena, bridge, tick)); tick += 10; steps++;
        }
        for (const [j, op] of BAND_OPS.entries()) {
          const resizesBefore = arena.resizes;
          applyOp(arena, sc, op, steps);
          const r = stepBoth(arena, bridge, tick);
          check(`banda ${band} op ${j} ${op}`, r);
          if (op !== 'dirty' && arena.resizes === resizesBefore) {
            // Un chunk sin redimensionar la arena: incremental y acotado por las páginas tocadas.
            assert.equal(r.eco.syncKind, 'delta', `${cfg.name} banda ${band} op ${j} ${op}: se esperaba sync incremental`);
            const bound = cfg.devices.length * 10 * PAGE_SYNC_BYTES;
            assert.ok(r.eco.syncUploadedBytes <= bound, `${cfg.name} banda ${band} op ${op}: syncUploadedBytes=${r.eco.syncUploadedBytes} > ${bound}`);
            if (op === 'add') { deltaAdds++; deltaBytes.push(r.eco.syncUploadedBytes); }
          }
          if (op !== 'dirty' && arena.resizes !== resizesBefore) assert.equal(r.eco.syncKind, 'full', 'redimensionar la arena resincroniza entero');
          tick += 10; steps++;
        }
      }
      // Ticks extra sin cambios de topología, con mutaciones (incluye tick % 100 de wood).
      for (let k = 0; k < 10; k++) { mutate(arena, 1000 + k); check(`cola ${k}`, stepBoth(arena, bridge, tick)); tick += 10; steps++; }
    } finally { await bridge.close(); }
    assert.equal(totalDiffs, 0);
    assert.ok(deltaAdds >= cfg.bands.length * 4, `altas incrementales: ${deltaAdds}`);
    t.diagnostic(`${cfg.name}: ${steps} ticks eco+kernel, ${arena.cells.length} celdas finales (${arena.regions.size} páginas, cap ${arena.cap}), `
      + `${arena.resizes} redimensiones; syncs ${JSON.stringify(bridge.syncCounts)}; bytes de sync por alta de 1 chunk: máx ${Math.max(...deltaBytes)} B; 0 diferencias Object.is`);
  });
}

/** Mundo lleno de `pages` páginas completas, con holgura para `reps` altas sin redimensionar la arena. */
function benchWorld(pages: number, reps: number) {
  const arena = new MiniArena(pages + reps + 8);
  arena.resizes = 0;
  const sc = scenario(pages);
  for (const page of sc.desired.values()) page.mask.fill(1);
  arena.load(sc.desired, 0);
  return { arena, sc };
}

test('v15 sync incremental: banco de 1 chunk en 256 y 1024 páginas, Dual-GPU [0,1] (antes = sync completo, ahora = delta)', { skip, timeout: 600_000 }, async t => {
  const results: Record<string, { ms: number; uploaded: number; sync: number }> = {};
  const bridge = new ResidentGpuBridge([0, 1]);
  try {
    for (const pages of [256, 1024]) {
      for (const mode of ['completo', 'delta'] as const) {
        const reps = 15;
        const { arena, sc } = benchWorld(pages, reps);
        assert.equal(arena.cells.length, pages * 256);
        bridge.invalidate();
        const [, gpu] = arena.twins as [Twin, Twin];
        const p1 = (version: number) => ({ version, rain: 0, light: 1, capacidadBosque: R.capacidadBosque, capacidadPastizal: R.capacidadPastizal,
          capacidadOtros: R.capacidadOtros, velocidadRegeneracion: R.velocidadRegeneracion, decaimientoComida: R.decaimientoComida });
        const p2 = (tick: number, version: number) => ({ tick, version, rain: 0, light: 1, decaimientoFertilidad: R.decaimientoFertilidad, seed: 7, cuencas: 1 });
        let tick = 110;
        for (let w = 0; w < 3; w++) {
          bridge.run(arena.terrain(gpu), arena.pageSetVersion, 'ecologia', p1(arena.version)); arena.swap(gpu);
          bridge.run(arena.terrain(gpu), arena.pageSetVersion, 'kernel', p2(tick, arena.version)); arena.swap(gpu); tick += 10;
        }
        const ms: number[] = [], up: number[] = [], sy: number[] = [];
        for (let r = 0; r < reps; r++) {
          const [px, py] = sc.queue.shift()!; sc.desired.set(`${px},${py}`, { px, py, mask: fullMask() });
          arena.load(sc.desired, r + 1);
          if (mode === 'completo') bridge.invalidate();
          const started = performance.now();
          const eco = bridge.run(arena.terrain(gpu), arena.pageSetVersion, 'ecologia', p1(arena.version));
          ms.push(performance.now() - started);
          up.push(eco.uploadedBytes); sy.push(eco.syncUploadedBytes);
          assert.equal(eco.syncKind, mode === 'completo' ? 'full' : 'delta');
          arena.swap(gpu);
          bridge.run(arena.terrain(gpu), arena.pageSetVersion, 'kernel', p2(tick, arena.version)); arena.swap(gpu); tick += 10;
          for (const tw of arena.twins) { tw.woodAdded.fill(0); tw.dirty.fill(0); }
        }
        assert.equal(arena.resizes, 0, 'el banco no redimensiona la arena');
        const med = (a: number[]) => a.slice().sort((x, y) => x - y)[a.length >> 1]!;
        results[`${pages}/${mode}`] = { ms: med(ms), uploaded: med(up), sync: med(sy) };
      }
    }
  } finally { await bridge.close(); }
  for (const pages of [256, 1024]) {
    const full = results[`${pages}/completo`]!, delta = results[`${pages}/delta`]!;
    t.diagnostic(`${pages} páginas (${pages * 256} celdas) Dual-GPU [0,1], alta de 1 chunk: antes (sync completo) mediana ${full.ms.toFixed(2)} ms, `
      + `uploadedBytes=${full.uploaded} (sync ${full.sync}); ahora (delta) mediana ${delta.ms.toFixed(2)} ms, uploadedBytes=${delta.uploaded} (sync ${delta.sync}); `
      + `×${(full.ms / delta.ms).toFixed(1)} en tiempo, ×${(full.uploaded / delta.uploaded).toFixed(0)} en bytes`);
    assert.ok(delta.sync <= 2 * 10 * PAGE_SYNC_BYTES, `sync incremental acotado por páginas tocadas: ${delta.sync}`);
    assert.ok(delta.uploaded * 10 < full.uploaded, `el delta sube mucho menos que el sync completo: ${delta.uploaded} vs ${full.uploaded}`);
  }
  // O(páginas tocadas), no O(mundo): cuadruplicar el mundo no cambia los bytes de sync de un chunk.
  const s256 = results['256/delta']!.sync, s1024 = results['1024/delta']!.sync;
  assert.ok(s1024 <= s256 * 1.5 + 4096, `bytes de sync de 1 chunk no escalan con el mundo: 256→${s256}, 1024→${s1024}`);
});
