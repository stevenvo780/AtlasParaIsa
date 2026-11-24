/**
 * V22 frente 1: ecología local ESTACIONAL (`ecologia.amplitudEstacional > 0`, reglas de mundo abierto
 * `CARTA_OPEN_WORLD=1`) despachada al pool de hilos y a la GPU dual [0,1] con paridad 0 ULP frente al
 * bucle serie de `ecology()`.
 *
 * El forzamiento `regionalClimateFactor` depende solo de la página 16×16 (centro `px*16+8, py*16+8`):
 * el kernel lo calcula en JS una vez por página y lo aplica con el mismo orden aritmético en el worker
 * (`runParallelEcology`) y en CUDA FP64 `--fmad=false` (`ecology_pass1_seasonal`).
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { Tile } from '../src/shared/types.js';
import { hostOpenWorldParams } from '../src/server/hardware-limits.js';
import { regionalClimateFactor } from '../src/world/clima.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { closeEcosystemWorkers, ecosystemGpuDiagnostics } from '../src/world/ecosystem.js';
import { ResidentGpuBridge, gpuNvrtcAvailable, gpuNvrtcSkipReason } from '../src/world/gpu/puente.js';
import { cloneWorld, createWorld, ecology, phaseAt, stepWorld, type World } from '../src/world/index.js';
import { DEFAULT_PARAMS, paramsOf, setParams, type WorldParams } from '../src/world/params.js';
import { TileStore } from '../src/world/soa/terreno.js';

const SEED = 51926;
const GPU_SKIP = gpuNvrtcAvailable() ? false : gpuNvrtcSkipReason();
const FIELDS = ['moisture', 'vegetation', 'food', 'wood', 'growth', 'fertility', 'cultivation',
  'traffic', 'drinkingWater', 'life', 'terrain', 'biome', 'feature'] as const satisfies readonly (keyof Tile)[];

after(async () => { await closeEcosystemWorkers(); });

// Reglas de mundo abierto (las de `CARTA_OPEN_WORLD=1`); el despacho se fija por brazo. Sondeo fijo:
// la prueba no depende de lo que tenga la máquina, solo del motor que cada brazo pide.
const OPEN = hostOpenWorldParams(DEFAULT_PARAMS, {
  cpuCount: () => 32, totalRamBytes: () => 125 * 1024 ** 3, gpuIndices: () => [0, 1], nvrtcAvailable: () => true,
} as unknown as Parameters<typeof hostOpenWorldParams>[1]);

interface Arm { name: string; hilos: number; gpu: number[] }
const SERIAL: Arm = { name: 'serie JS (hilos 1, gpu [])', hilos: 1, gpu: [] };
const CPU4: Arm = { name: 'CPU paralela (hilos 4, gpu [])', hilos: 4, gpu: [] };
const CPU28: Arm = { name: 'CPU paralela (hilos 28, gpu [])', hilos: 28, gpu: [] };
const GPU01: Arm = { name: 'GPU dual (gpu [0,1])', hilos: 1, gpu: [0, 1] };

function armParams(arm: Arm, amplitud = OPEN.ecologia.amplitudEstacional): WorldParams {
  const params = structuredClone(OPEN);
  params.ecologia = { ...params.ecologia, amplitudEstacional: amplitud };
  params.motor = { ...DEFAULT_PARAMS.motor, hilos: arm.hilos, gpu: arm.gpu, orden: 'natural', soaTerreno: arm.hilos > 1 || arm.gpu.length > 0 };
  return params;
}

/** Generador entero local de la prueba (sin RNG del mundo, sin reloj). */
function hash(x: number, y: number, salt: number): number {
  let v = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(salt + 1, 0x9e3779b1);
  v = Math.imul(v ^ (v >>> 15), 0x85ebca6b); v = Math.imul(v ^ (v >>> 13), 0xc2b2ae35);
  return ((v ^ (v >>> 16)) >>> 0) / 0x1_0000_0000;
}

const BIOMES = ['forest', 'grassland', 'desert', 'mountain', 'wetland', undefined] as const;
/** `chunksX × chunksY` chunks 16×16 completos con coordenadas negativas, agua dispersa y ríos en costuras. */
function seasonalGrid(chunksX: number, chunksY: number): Tile[] {
  const tiles: Tile[] = [];
  const x0 = -Math.floor(chunksX / 2) * 16, y0 = -Math.floor(chunksY / 2) * 16;
  for (let y = y0; y < y0 + chunksY * 16; y++) for (let x = x0; x < x0 + chunksX * 16; x++) {
    const water = hash(x, y, 1) < 0.12 || x === 15 || x === 16 || y === -1;
    const biome = water ? (hash(x, y, 2) < 0.5 ? 'ocean' : 'wetland') : BIOMES[Math.floor(hash(x, y, 3) * BIOMES.length)];
    const m = hash(x, y, 4);
    tiles.push({
      x, y, terrain: water ? 'water' : hash(x, y, 5) < 0.8 ? 'meadow' : 'soil', biome: biome as Tile['biome'],
      elevation: hash(x, y, 6),
      // Humedad a ambos lados del umbral 0.15 y cerca de 0/1 para ejercer los dos `clamp`.
      moisture: m < 0.1 ? 0.149 + m * 0.01 : m > 0.95 ? 0.999 : m,
      vegetation: hash(x, y, 7), food: hash(x, y, 8) * 0.8, wood: hash(x, y, 9) * 6, stone: hash(x, y, 10),
      feature: water ? 'none' : hash(x, y, 11) < 0.3 ? 'tree' : 'none', variety: Math.floor(hash(x, y, 12) * 4),
      growth: hash(x, y, 13), fertility: hash(x, y, 14), cultivation: hash(x, y, 15) * 0.3,
      traffic: hash(x, y, 16) * 0.2, drinkingWater: hash(x, y, 17) * 0.3, fauna: 0, life: hash(x, y, 18),
    } as Tile);
  }
  return tiles;
}

function gridWorld(chunksX: number, chunksY: number): World {
  const world = createWorld(SEED);
  world.tiles = seasonalGrid(chunksX, chunksY);
  return world;
}

/**
 * Pasos ecológicos (`tick % 10 === 0`, nunca múltiplo de 600 para que el tiempo lo fije la prueba):
 * alba, día, crepúsculo y noche; lluvia y cielo abierto; y fases estacionales distintas del año de 20 días.
 */
const SCHEDULE: readonly { tick: number; weather: 'clear' | 'rain' }[] = [
  { tick: 10, weather: 'rain' }, { tick: 420, weather: 'clear' }, { tick: 1510, weather: 'rain' },
  { tick: 1900, weather: 'clear' }, { tick: 2410, weather: 'rain' }, { tick: 12_010, weather: 'clear' },
  { tick: 13_000, weather: 'rain' }, { tick: 37_210, weather: 'clear' }, { tick: 47_990, weather: 'rain' },
];

function runSchedule(base: World, arm: Arm, amplitud?: number): World {
  const world = cloneWorld(base);
  setParams(world, armParams(arm, amplitud));
  for (const { tick, weather } of SCHEDULE) {
    world.tick = tick; world.weather = weather;
    ecology(world, { regionSide: 256 });
  }
  return world;
}

function plainTiles(tiles: readonly Tile[]): Record<string, unknown>[] {
  return tiles.map(tile => { const out: Record<string, unknown> = {}; for (const key of Object.keys(tile)) out[key] = tile[key as keyof Tile]; return out; });
}

function assertTilesExact(actual: readonly Tile[], expected: readonly Tile[], label: string): void {
  assert.equal(actual.length, expected.length, `${label}: cantidad`);
  let compared = 0;
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i]!, e = expected[i]!;
    assert.ok(Object.is(a.x, e.x) && Object.is(a.y, e.y), `${label}: orden ${i}`);
    for (const key of FIELDS) {
      compared++;
      if (!Object.is(a[key], e[key])) {
        const ulp = typeof a[key] === 'number' && typeof e[key] === 'number'
          ? ` (Δ=${(a[key] as number) - (e[key] as number)})` : '';
        assert.fail(`${label}: tesela ${i} (${e.x},${e.y}).${key}: ${String(a[key])} !== ${String(e[key])}${ulp}`);
      }
    }
  }
  assert.ok(compared > 0);
}

function normalizedDigest(world: World): string {
  const copy = cloneWorld(world);
  const params = structuredClone(paramsOf(copy));
  params.motor = { ...DEFAULT_PARAMS.motor };
  setParams(copy, params);
  return digestoCanonico(copy);
}

test('V22 los parámetros de mundo abierto activan la estacionalidad regional (0.25 / 20 días / 64 celdas)', () => {
  assert.equal(OPEN.ecologia.amplitudEstacional, 0.25);
  assert.equal(OPEN.ecologia.periodoEstacionalDias, 20);
  assert.equal(OPEN.ecologia.escalaClimaticaCeldas, 64);
  const phases = new Set(SCHEDULE.map(s => phaseAt(s.tick)));
  assert.deepEqual([...phases].sort(), ['dawn', 'day', 'dusk', 'night']);
  assert.deepEqual([...new Set(SCHEDULE.map(s => s.weather))].sort(), ['clear', 'rain']);
});

test('V22 ecology() estacional: serie, CPU 4/28 hilos y GPU dual [0,1] coinciden a 0 ULP en 80 chunks', async t => {
  const base = gridWorld(10, 8);
  assert.equal(base.tiles.length, 20_480);
  // El forzamiento varía de verdad entre páginas en este mapa (si no, la prueba no distinguiría nada).
  const growth = new Set<number>();
  for (let cy = -4; cy < 4; cy++) for (let cx = -5; cx < 5; cx++)
    growth.add(regionalClimateFactor(SEED, 13_000, cx * 16 + 8, cy * 16 + 8, 0.25, 20, 64).growthScale);
  assert.ok(growth.size > 10, `factores distintos por página: ${growth.size}`);

  const expected = runSchedule(base, SERIAL);
  // Control: la estacionalidad cambia el resultado frente a amplitud 0 (la rama estacional sí se ejerce).
  const flat = runSchedule(base, SERIAL, 0);
  assert.ok(expected.tiles.some((tile, i) => !Object.is(tile.food, flat.tiles[i]!.food)), 'la estación debe cambiar el alimento');

  for (const arm of [CPU4, CPU28]) await t.test(arm.name, () => {
    const actual = runSchedule(base, arm);
    assertTilesExact(actual.tiles, expected.tiles, arm.name);
    assert.equal(actual.rng, expected.rng);
  });
  await t.test(GPU01.name, { skip: GPU_SKIP }, () => {
    const actual = runSchedule(base, GPU01);
    assert.ok(ecosystemGpuDiagnostics(), 'la pasada debe haber ido a la GPU');
    assert.equal(ecosystemGpuDiagnostics()!.lastPass, 'ecologia');
    assertTilesExact(actual.tiles, expected.tiles, GPU01.name);
  });
  // Amplitud 0 en paralelo sigue siendo el cuerpo de siempre, bit a bit.
  await t.test('amplitud 0: CPU 4 hilos y GPU idénticas a la serie', async t2 => {
    assertTilesExact(runSchedule(base, CPU4, 0).tiles, flat.tiles, 'hilos 4 / amplitud 0');
    await t2.test('GPU [0,1] amplitud 0', { skip: GPU_SKIP }, () => {
      assertTilesExact(runSchedule(base, GPU01, 0).tiles, flat.tiles, 'gpu [0,1] / amplitud 0');
    });
  });
});

test('V22 GPU dual repartida (sharded 70/30): el clima por ranura se mapea global→local sin perder un bit', { skip: GPU_SKIP }, async () => {
  const base = gridWorld(10, 8), expected = cloneWorld(base);
  setParams(expected, armParams(SERIAL));
  const actual = cloneWorld(base);
  const store = new TileStore();
  const bridge = new ResidentGpuBridge([0, 1], { sharded: true, weights: [0.7, 0.3] });
  const R = OPEN.recursos;
  try {
    for (const { tick, weather } of SCHEDULE) {
      expected.tick = tick; expected.weather = weather;
      ecology(expected, { regionSide: 256 });
      const terrain = store.prepareParallel(actual.tiles, 256);
      // Derivación independiente del campo (no llama al kernel): mismo centro de página que `ecology()`.
      const pageX = new Int32Array(terrain.buffers.pageX!), pageY = new Int32Array(terrain.buffers.pageY!);
      const climate = new Float64Array(pageX.length * 3).fill(Number.NaN);
      const cells = new Int32Array(terrain.buffers.cells!);
      for (let i = 0; i < cells.length; i++) {
        const slot = cells[i]! >>> 8;
        const f = regionalClimateFactor(SEED, tick, pageX[slot]! * 16 + 8, pageY[slot]! * 16 + 8, 0.25, 20, 64);
        climate.set([f.rainScale, f.evapScale, f.growthScale], slot * 3);
      }
      const phase = phaseAt(tick);
      store.beginParallel();
      try {
        bridge.run(terrain, store.pageSetVersion, 'ecologia', {
          version: terrain.version, rain: weather === 'rain' ? 1 : 0, light: phase === 'day' ? 1 : phase === 'night' ? 0 : 0.4,
          capacidadBosque: R.capacidadBosque, capacidadPastizal: R.capacidadPastizal, capacidadOtros: R.capacidadOtros,
          velocidadRegeneracion: R.velocidadRegeneracion, decaimientoComida: R.decaimientoComida,
        }, 256, { climate });
        store.commitParallel('ecologia');
      } catch (error) { store.abortParallel(); throw error; }
    }
  } finally { await bridge.close(); }
  assertTilesExact(actual.tiles, expected.tiles, 'gpu [0,1] sharded 70/30');
});

test('V22 stepWorld de mundo abierto (semilla 51926, 620 pasos, 62 ciclos ecológicos): mismo digesto en serie, 4 hilos y GPU [0,1]', async t => {
  const STEPS = 620;
  const run = (arm: Arm): World => {
    const world = createWorld(SEED, armParams(arm));
    for (let i = 0; i < STEPS; i++) stepWorld(world);
    return world;
  };
  const expected = run(SERIAL);
  assert.equal(paramsOf(expected).ecologia.amplitudEstacional, 0.25);
  const digest = normalizedDigest(expected), tiles = plainTiles(expected.tiles);
  for (const arm of [CPU4, GPU01]) await t.test(arm.name, { skip: arm.gpu.length ? GPU_SKIP : false }, () => {
    const actual = run(arm);
    assertTilesExact(actual.tiles, expected.tiles, arm.name);
    assert.deepEqual(plainTiles(actual.tiles), tiles);
    assert.equal(normalizedDigest(actual), digest, `${arm.name}: digesto canónico`);
  });
});

test('V22 diagnóstico de rendimiento: ecology() estacional a 20 480 teselas (80 chunks)', async t => {
  const base = gridWorld(10, 8);
  const ITER = 12, WARM = 3;
  const results: Record<string, number> = {};
  for (const arm of [SERIAL, CPU4, CPU28, GPU01]) {
    if (arm.gpu.length && GPU_SKIP) continue;
    const world = cloneWorld(base);
    setParams(world, armParams(arm));
    const samples: number[] = [];
    for (let i = 0; i < WARM + ITER; i++) {
      world.tick = 1000 + i * 10; world.weather = i % 2 ? 'rain' : 'clear';
      const started = performance.now();
      ecology(world, { regionSide: 256 });
      if (i >= WARM) samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    results[arm.name] = samples[Math.floor(samples.length / 2)]!;
    t.diagnostic(`${arm.name}: mediana ${results[arm.name]!.toFixed(2)} ms, p95 ${samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)]!.toFixed(2)} ms`);
  }
  console.log('[V22 perf ecology estacional 20480 teselas, mediana ms]', JSON.stringify(results));
  for (const value of Object.values(results)) assert.ok(Number.isFinite(value) && value > 0);
});
