import test from 'node:test';
import assert from 'node:assert/strict';
import type { Feature, Tile } from '../src/shared/types.js';
import { EcosystemKernel, type EcosystemOptions } from '../src/world/ecosystem-kernel.js';
import { enCuenca } from '../src/world/agua.js';
import { StaticWorkerPool } from '../src/world/paralelo/piscina.js';
import { createWorld } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';

const clone = (tiles: readonly Tile[]): Tile[] => tiles.map(tile => ({ ...tile }));
const clamp = (value: number): number => Math.max(0, Math.min(1, value));
const trees = new Set<Feature>(['tree', 'pine', 'palm', 'cactus', 'reeds', 'stump']);

// Oráculo del camino de objetos en 2e5c0bf, independiente de arrays, particiones y workers.
function referenceStep(tiles: Tile[], tick: number, weather: 'clear' | 'rain', phase: string, options: EcosystemOptions = {}): void {
  if (tick % 10 !== 0) return;
  const cells = tiles.map(tile => ({ ...tile }));
  const byPosition = new Map(cells.map(tile => [`${tile.x},${tile.y}`, tile]));
  if (byPosition.size !== cells.length) throw new Error('El ecosistema requiere coordenadas únicas.');
  const light = phase === 'day' ? 1 : phase === 'night' ? 0 : 0.4;
  for (let i = 0; i < cells.length; i++) {
    const old = cells[i]!, tile = tiles[i]!;
    const life = old.life ?? 0, fertility = old.fertility ?? 0, growth = old.growth ?? old.vegetation;
    const traffic = old.traffic ?? 0, cultivation = old.cultivation ?? 0;
    let living = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      if ((byPosition.get(`${old.x + dx},${old.y + dy}`)?.life ?? 0) >= 0.45) living++;
    }
    const fertilePattern = living === 3 || (life >= 0.45 && living === 2);
    const cellularEnergy = light * old.moisture * (0.6 + fertility * 0.4);
    tile.life = clamp(life + ((fertilePattern ? 1 : 0) - life) * 0.2 * cellularEnergy
      - (old.moisture < 0.15 ? 0.015 : 0) - traffic * 0.004);
    tile.fertility = clamp(fertility + life * 0.0012 - traffic * 0.0007 - cultivation * 0.0002
      - (options.decaimientoFertilidad ?? 0) * fertility);
    const produced = light * old.moisture * fertility * (0.25 + life * 0.75)
      * (1 - growth) * (1 - traffic * 0.9) * 0.005;
    tile.growth = clamp(growth + produced - 0.0002 - traffic * 0.002 - (old.moisture < 0.15 ? 0.001 : 0));
    if (old.terrain !== 'water') tile.vegetation = clamp(old.vegetation + produced * 0.25 - traffic * 0.001);
    tile.traffic = clamp(traffic - 0.0005);
    tile.cultivation = clamp(cultivation - 0.00002);
    const reservoirSource = old.feature === 'pool' || old.feature === 'spring' || old.biome === 'wetland' || old.terrain === 'water';
    const reservoir = reservoirSource && (old.terrain === 'water' || enCuenca(options.seed ?? 0, old.x, old.y, options.cuencas ?? 1));
    tile.drinkingWater = old.biome === 'ocean' ? 0 : clamp((old.drinkingWater ?? 0)
      + (reservoir && weather === 'rain' ? 0.008 * (0.4 + fertility * 0.6) : 0)
      + (reservoir && old.feature === 'spring' ? 0.002 : 0) - (light ? 0.00015 : 0.00003));
    if (old.terrain === 'water') tile.moisture = clamp(old.moisture + (old.biome === 'ocean' ? 0.003 : 0) + (weather === 'rain' ? 0.008 : 0));
    if (tick % 100 === 0 && trees.has(old.feature ?? 'none') && growth > 0.65
      && fertility > 0.4 && old.moisture > 0.35 && traffic < 0.35 && light > 0) {
      const capacity = old.feature === 'reeds' || old.feature === 'cactus' ? 2 : old.feature === 'palm' ? 6 : 12;
      const regrowth = Math.min(capacity - (old.wood ?? 0), 0.025 * light * old.moisture * fertility);
      if (regrowth > 0) {
        tile.wood = (old.wood ?? 0) + regrowth;
        tile.growth = clamp(tile.growth! - regrowth * 0.05);
        if (old.feature === 'stump' && tile.wood >= 1) tile.feature = old.biome === 'mountain' ? 'pine' : 'tree';
      }
    }
  }
}

function cell(x: number, y: number, variant = 0): Tile {
  const features: Feature[] = ['none', 'spring', 'pool', 'stump', 'pine', 'reeds', 'cactus', 'palm'];
  return {
    x, y, terrain: variant % 11 === 0 ? 'water' : variant % 13 === 0 ? 'shelter' : 'meadow',
    biome: variant % 11 === 0 ? 'ocean' : variant % 5 === 0 ? 'wetland' : 'forest',
    moisture: [0.14, 0.15, 0.9, 1][variant % 4]!, vegetation: variant % 7 ? 0.7 : -0,
    food: variant % 3 ? 0.5 : -0, feature: features[variant % features.length],
    life: [0, 0.44, 0.45, 0.46, 0.9, 1][variant % 6]!, fertility: variant % 2 ? 0.9 : 0.4,
    growth: variant % 3 ? 0.9 : 0.65, drinkingWater: variant % 4 ? 0.2 : 0,
    traffic: variant % 2 ? 0.03 : -0, cultivation: variant % 3 ? 0.2 : 0,
    wood: variant % 4 ? 0.999 : 12, fauna: variant % 3, species: 'hare', variety: variant % 4,
  };
}

function fixture(): Tile[] {
  const byPosition = new Map<string, Tile>();
  const add = (tile: Tile): void => { byPosition.set(`${tile.x},${tile.y}`, tile); };
  // Más de 28 regiones con huecos: cada hilo puede calcular una región distinta.
  for (let region = 0; region < 32; region++) {
    const originX = (region - 16) * 256, originY = (region % 3 - 1) * 512;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      if ((dx + dy + region) % 7 === 0) continue;
      add(cell(originX + dx, originY + dy, byPosition.size));
    }
  }
  for (const x of [-49, -48, -25, -24, -17, -16, -1, 0, 1, 15, 16, 23, 24, 25, 255, 256, 257])
    for (const y of [-25, -24, -1, 0, 23, 24, 255, 256]) add(cell(x, y, byPosition.size));
  const optional = cell(-700, -700);
  delete optional.life; delete optional.fertility; delete optional.growth; delete optional.feature;
  delete optional.drinkingWater; delete optional.traffic; delete optional.cultivation; delete optional.wood;
  add(optional);
  add({ ...cell(-700, -701), feature: undefined, wood: undefined, species: undefined });
  add({ ...cell(-701, -700), feature: 'stump', wood: 0.999, growth: 0.9, fertility: 0.9, moisture: 0.9, traffic: 0 });
  return [...byPosition.values()];
}

function tileBytes(tiles: readonly Tile[]): Buffer {
  const doubles = tiles.flatMap(tile => Object.values(tile).filter((value): value is number => typeof value === 'number'));
  return Buffer.from(new Float64Array(doubles).buffer);
}

function assertTiles(actual: readonly Tile[], expected: readonly Tile[], label: string): void {
  assert.equal(actual.length, expected.length, label);
  for (let i = 0; i < actual.length; i++) {
    const left = actual[i]!, right = expected[i]!;
    assert.deepEqual(Object.keys(left), Object.keys(right), `${label}: presencia y orden de claves, tesela ${i}`);
    for (const key of Object.keys(right) as (keyof Tile)[])
      assert.ok(Object.is(left[key], right[key]), `${label}: tesela ${i}, campo ${key}, ${left[key]} != ${right[key]}`);
  }
  assert.deepEqual(tileBytes(actual), tileBytes(expected), `${label}: bytes FP64`);
}

test('motor.hilos=1 conserva exactamente el algoritmo actual, incluidos campos opcionales y -0', () => {
  const kernel = new EcosystemKernel();
  for (const cuencas of [1, 0.4]) for (const decaimientoFertilidad of [0, 0.001]) {
    const actual = fixture(), expected = clone(actual);
    const options = { hilos: 1, seed: 51926, cuencas, decaimientoFertilidad, soaTerreno: false };
    for (let update = 1; update <= 12; update++) {
      const tick = update * 10, weather = update % 3 === 0 ? 'rain' : 'clear';
      const phase = ['day', 'night', 'dawn', 'dusk'][update % 4]!;
      referenceStep(expected, tick, weather, phase, options);
      kernel.step(actual, tick, weather, phase, options);
      assertTiles(actual, expected, `${cuencas}/${decaimientoFertilidad}, tick ${tick}`);
    }
    assert.equal(actual.find(tile => tile.x === -701 && tile.y === -700)?.feature, 'tree', 'se ejerce el rebrote del tocón');
  }
  assert.equal(kernel.soaStore, null, 'un hilo no activa la SoA cuando el parámetro la revierte');
  assert.ok(kernel.cachedTopologyCount > 0, 'se recorre el camino actual de objetos');
  assert.equal(kernel.parallelDiagnostics, null, 'el parámetro de reversión no crea workers');
});

for (const hilos of [1, 2, 4, 8, 28]) {
  test(`kernel cableado con ${hilos} hilos: bytes exactos, regiones dispersas y cuatro cuadrantes T013/T035`, async t => {
    const kernel = new EcosystemKernel();
    t.after(() => kernel.closeParallelPool());
    let threadIds: readonly number[] | undefined;
    for (const soaTerreno of [false, true]) for (const cuencas of [1, 0.4]) for (const decaimientoFertilidad of [0, 0.001]) {
      let actual = fixture(), expected = clone(actual);
      const options: EcosystemOptions = { hilos, soaTerreno, cuencas, decaimientoFertilidad, seed: 51926 };
      for (let update = 1; update <= 12; update++) {
        if (update === 4) { actual = clone(actual).reverse(); expected = clone(expected).reverse(); }
        if (update === 8) { actual = actual.filter((_, i) => i % 5 !== 2); expected = expected.filter((_, i) => i % 5 !== 2); }
        if (update === 10) { actual.push(cell(12000, -12000, 3)); expected.push(cell(12000, -12000, 3)); }
        const tick = update * 10, weather = update % 3 === 0 ? 'rain' : 'clear';
        const phase = ['day', 'night', 'dawn', 'dusk'][update % 4]!;
        const dispatches = kernel.parallelDiagnostics?.dispatches ?? 0;
        referenceStep(expected, tick, weather, phase, options);
        kernel.step(actual, tick, weather, phase, options);
        assertTiles(actual, expected, `hilos=${hilos}, soa=${soaTerreno}, cuencas=${cuencas}, decaimiento=${decaimientoFertilidad}, tick=${tick}`);
        const diagnostics = kernel.parallelDiagnostics;
        if (hilos === 1) assert.equal(diagnostics, null, 'el camino serial no pasa por un pool');
        else {
          assert.ok(diagnostics, 'aceptar el parámetro no basta: el motor despacha realmente');
          assert.equal(diagnostics.workers, hilos);
          assert.equal(diagnostics.threadIds.length, hilos);
          assert.ok(diagnostics.threadIds.every(id => id > 0));
          assert.equal(new Set(diagnostics.threadIds).size, hilos);
          assert.equal(diagnostics.dispatches, dispatches + 1, 'cada actualización entra en la barrera física');
          assert.ok(diagnostics.completedJobs.every(count => count > 0));
          if (threadIds) assert.deepEqual(diagnostics.threadIds, threadIds, 'el pool persiste aunque los objetos y la topología cambien');
          threadIds = diagnostics.threadIds;
        }
      }
    }
    const options: EcosystemOptions = { hilos, soaTerreno: true, seed: 51926, cuencas: 0.4, decaimientoFertilidad: 0.001 };
    const empty: Tile[] = [];
    kernel.step(empty, 130, 'rain', 'day', options);
    assertTiles(empty, [], 'conjunto vacío después de un conjunto disperso');
    const singleton = [cell(0, 0, 2)], expectedSingleton = clone(singleton);
    referenceStep(expectedSingleton, 140, 'rain', 'day', options);
    kernel.step(singleton, 140, 'rain', 'day', options);
    assertTiles(singleton, expectedSingleton, 'celdas vecinas retiradas no reaparecen al recargar la página');
    const noUpdate = clone(singleton), dispatches = kernel.parallelDiagnostics?.dispatches ?? 0;
    kernel.step(singleton, 149, 'rain', 'day', options);
    assertTiles(singleton, noUpdate, 'un tick sin ecología no toca los campos');
    assert.equal(kernel.parallelDiagnostics?.dispatches ?? 0, dispatches, 'un tick sin ecología no inventa un despacho');
  });
}

const physicalModule = new URL(`data:text/javascript,${encodeURIComponent(`
  import { threadId } from 'node:worker_threads';
  export function calculate({ regions, buffers, params, workerIndex }) {
    const input = new Float64Array(buffers.input), output = new Float64Array(buffers.output);
    const owners = new Int32Array(buffers.owners), completed = new Int32Array(buffers.completed);
    for (const region of regions) {
      for (let i = region.begin; i < region.end; i++) {
        output[i] = (input[i] + params.offset) * 2;
        owners[i] = threadId;
        if (region.id === params.failRegion) throw new Error('fallo real de cálculo');
      }
      Atomics.add(completed, workerIndex, 1);
    }
  }
`)}`);

function physicalBuffers(workers: number, count: number) {
  const input = new Float64Array(new SharedArrayBuffer(count * 8));
  const output = new Float64Array(new SharedArrayBuffer(count * 8));
  const owners = new Int32Array(new SharedArrayBuffer(count * 4));
  const completed = new Int32Array(new SharedArrayBuffer(workers * 4));
  for (let i = 0; i < count; i++) input[i] = i / 13 - 2;
  output.fill(-99);
  return { input, output, owners, completed, buffers: {
    input: input.buffer as SharedArrayBuffer, output: output.buffer as SharedArrayBuffer,
    owners: owners.buffer as SharedArrayBuffer, completed: completed.buffer as SharedArrayBuffer,
  } };
}

for (const workers of [2, 4, 8, 28]) {
  test(`pool persistente: ${workers} workers calculan físicamente cada salida de su cola estática`, async t => {
    const pool = new StaticWorkerPool({ workers, moduleURL: physicalModule, exportName: 'calculate' });
    t.after(() => pool.close());
    const state = physicalBuffers(workers, 96);
    const regions = Array.from({ length: 32 }, (_, id) => ({ id, begin: id * 3, end: id * 3 + 3 }));
    let firstOwners: number[] | undefined;
    for (const offset of [0.125, -0.5]) {
      state.output.fill(-99); state.owners.fill(0); state.completed.fill(0);
      pool.run({ regions: [...regions].reverse(), buffers: state.buffers, params: { offset } });
      for (let i = 0; i < state.output.length; i++) {
        assert.ok(Object.is(state.output[i], (state.input[i]! + offset) * 2), `cálculo real de la celda ${i}`);
        assert.ok(state.owners[i]! > 0, 'el módulo obtiene threadId de worker_threads, nunca del coordinador');
      }
      const actualIds = [...new Set(state.owners)].sort((a, b) => a - b);
      assert.equal(actualIds.length, workers, 'todos los hilos pedidos hacen trabajo con resultado observable');
      assert.deepEqual([...pool.diagnostics().threadIds].sort((a, b) => a - b), actualIds);
      assert.equal(state.completed.reduce((sum, count) => sum + count, 0), regions.length);
      assert.ok([...state.completed].every(count => count > 0), 'cada cola termina regiones reales');
      if (firstOwners) assert.deepEqual([...state.owners], firstOwners, 'mismos hilos y colas entre pasos');
      firstOwners = [...state.owners];
    }
    assert.equal(pool.diagnostics().workers, workers);
    assert.equal(pool.diagnostics().dispatches, 2);
  });
}

test('28 workers: colas y regiones vacías completan la barrera sin escribir celdas ausentes', async t => {
  const pool = new StaticWorkerPool({ workers: 28, moduleURL: physicalModule, exportName: 'calculate' });
  t.after(() => pool.close());
  const state = physicalBuffers(28, 4);
  pool.run({ regions: [{ id: 2, begin: 0, end: 1 }, { id: 8, begin: 1, end: 1 }, { id: 80, begin: 3, end: 4 }],
    buffers: state.buffers, params: { offset: 0.25 } });
  assert.ok(Object.is(state.output[0], (state.input[0]! + 0.25) * 2));
  assert.ok(Object.is(state.output[3], (state.input[3]! + 0.25) * 2));
  assert.equal(state.output[1], -99); assert.equal(state.output[2], -99);
  const before = Buffer.from(state.output.buffer).subarray().slice();
  pool.run({ regions: [], buffers: state.buffers, params: { offset: 1000 } });
  assert.deepEqual(Buffer.from(state.output.buffer), before, 'el despacho vacío no contiene trabajo inventado');
});

test('una excepción auténtica de worker aborta el despacho y permite el siguiente', async t => {
  const pool = new StaticWorkerPool({ workers: 4, moduleURL: physicalModule, exportName: 'calculate' });
  t.after(() => pool.close());
  const state = physicalBuffers(4, 12);
  const regions = Array.from({ length: 4 }, (_, id) => ({ id, begin: id * 3, end: id * 3 + 3 }));
  assert.throws(() => pool.run({ regions, buffers: state.buffers, params: { offset: 0.25, failRegion: 2 } }), /fallo real de cálculo/);
  assert.ok(state.owners[6]! > 0, 'el fallo viene del módulo tras escribir scratch en un hilo real');
  pool.run({ regions, buffers: state.buffers, params: { offset: -0.25 } });
  for (let i = 0; i < state.output.length; i++) assert.ok(Object.is(state.output[i], (state.input[i]! - 0.25) * 2));
});

const guardedModule = new URL(`data:text/javascript,${encodeURIComponent(`
  import { threadId } from 'node:worker_threads';
  import { runParallelEcosystem } from ${JSON.stringify(new URL('../src/world/ecosystem-kernel.ts', import.meta.url).href)};
  export function calculate(job) {
    runParallelEcosystem(job);
    const control = new Int32Array(job.buffers.__testControl);
    if (job.workerIndex === 0 && Atomics.load(control, 0) === 1) {
      Atomics.store(control, 1, threadId);
      throw new Error('fallo de worker tras escribir el fondo');
    }
  }
`)}`);

test('fallo de worker tras calcular el fondo conserva el frente y el mundo completos, y reintenta exactamente', async t => {
  const control = new Int32Array(new SharedArrayBuffer(8));
  class GuardedPool extends StaticWorkerPool {
    override run(job: Parameters<StaticWorkerPool['run']>[0]): void {
      super.run({ ...job, buffers: { ...job.buffers, __testControl: control.buffer as SharedArrayBuffer } });
    }
  }
  const kernel = new EcosystemKernel({ createPool: workers => new GuardedPool({ workers, moduleURL: guardedModule, exportName: 'calculate' }) });
  t.after(() => kernel.closeParallelPool());
  const world = createWorld(42);
  const options: EcosystemOptions = { hilos: 4, soaTerreno: true, seed: world.seed, cuencas: 0.4, decaimientoFertilidad: 0.001 };
  kernel.step(world.tiles, 90, 'clear', 'day', options);
  const store = kernel.soaStore;
  assert.ok(store);
  const front = store.lifeFront;
  const frontBytes = Buffer.from(front.buffer, front.byteOffset, front.byteLength).slice();
  const tiles = clone(world.tiles), references = world.tiles.slice(), digest = digestoCanonico(world);
  Atomics.store(control, 0, 1);
  assert.throws(() => kernel.step(world.tiles, 100, 'rain', 'day', options), /fallo de worker tras escribir el fondo/);
  assert.ok(Atomics.load(control, 1) > 0, 'la excepción proviene de un worker real después del cálculo');
  assert.equal(store.lifeFront, front, 'la barrera fallida no intercambia frente y fondo');
  assert.deepEqual(Buffer.from(store.lifeFront.buffer, store.lifeFront.byteOffset, store.lifeFront.byteLength), frontBytes);
  assertTiles(world.tiles, tiles, 'fallo antes del commit');
  assert.ok(world.tiles.every((tile, i) => tile === references[i]), 'los objetos autorizativos conservan identidad');
  assert.equal(digestoCanonico(world), digest, 'ningún campo del mundo queda parcialmente confirmado');
  Atomics.store(control, 0, 0);
  referenceStep(tiles, 100, 'rain', 'day', options);
  kernel.step(world.tiles, 100, 'rain', 'day', options);
  assertTiles(world.tiles, tiles, 'misma actualización después del fallo');
});

test('un motor que ya usó workers revierte a hilos=1 sin despachar y conserva el algoritmo anterior', async t => {
  const kernel = new EcosystemKernel();
  t.after(() => kernel.closeParallelPool());
  const actual = fixture(), expected = clone(actual);
  const options: EcosystemOptions = { hilos: 4, soaTerreno: false, seed: 51926, cuencas: 0.4, decaimientoFertilidad: 0.001 };
  referenceStep(expected, 10, 'rain', 'day', options);
  kernel.step(actual, 10, 'rain', 'day', options);
  assertTiles(actual, expected, 'paso previo paralelo');
  const dispatches = kernel.parallelDiagnostics!.dispatches;
  referenceStep(expected, 20, 'clear', 'night', options);
  kernel.step(actual, 20, 'clear', 'night', { ...options, hilos: 1 });
  assertTiles(actual, expected, 'reversión al camino actual');
  assert.equal(kernel.parallelDiagnostics?.dispatches ?? dispatches, dispatches);
  assert.ok(kernel.cachedTopologyCount > 0, 'el motor reutiliza el camino de objetos después de revertir');
});

for (const soaTerreno of [false, true]) {
  test(`paralelo A → serial B → paralelo B no cambia A con las mismas coordenadas, soa=${soaTerreno}`, async t => {
    const kernel = new EcosystemKernel();
    t.after(() => kernel.closeParallelPool());
    const options: EcosystemOptions = { hilos: 2, soaTerreno, seed: 51926, cuencas: 0.4, decaimientoFertilidad: 0.001 };
    const a = [cell(-1, -1, 1), cell(0, -1, 2), cell(-1, 0, 3), cell(0, 0, 4)];
    a[0]!.food = -0; a[0]!.feature = undefined; a[0]!.species = undefined;
    const expectedA = clone(a);
    referenceStep(expectedA, 10, 'rain', 'day', options);
    kernel.step(a, 10, 'rain', 'day', options);
    assertTiles(a, expectedA, 'A paralelo');
    const frozenA = clone(a);
    const b = clone(a).map((tile, i) => ({ ...tile, life: i / 10 + 0.02, wood: undefined, traffic: -0 }));
    const expectedB = clone(b), dispatches = kernel.parallelDiagnostics!.dispatches;
    referenceStep(expectedB, 20, 'clear', 'night', options);
    kernel.step(b, 20, 'clear', 'night', { ...options, hilos: 1 });
    assertTiles(b, expectedB, 'B serial con life diferente');
    assertTiles(a, frozenA, 'A no lee la foto de life de B');
    assert.equal(Object.getOwnPropertyDescriptor(a[0]!, 'life')?.get, undefined, 'A vuelve a campos ordinarios antes de cargar B');
    assert.equal(kernel.parallelDiagnostics!.dispatches, dispatches, 'la reversión no despacha');
    referenceStep(expectedB, 30, 'rain', 'day', options);
    kernel.step(b, 30, 'rain', 'day', options);
    assertTiles(b, expectedB, 'B vuelve a paralelo');
    assertTiles(a, frozenA, 'A sigue inerte al confirmar B');
    assert.equal(kernel.parallelDiagnostics!.dispatches, dispatches + 1);
    const frozenB = clone(b);
    referenceStep(expectedA, 40, 'clear', 'day', options);
    kernel.step(a, 40, 'clear', 'day', { ...options, hilos: 1 });
    assertTiles(a, expectedA, 'A vuelve al camino serial');
    assertTiles(b, frozenB, 'B no cambia al recargar A');
    referenceStep(expectedA, 50, 'rain', 'dawn', options);
    kernel.step(a, 50, 'rain', 'dawn', options);
    assertTiles(a, expectedA, 'A vuelve a paralelo');
    assertTiles(b, frozenB, 'B permanece independiente después del ciclo completo');
  });

  test(`wood ausente → serial tick100 crea wood → paralelo tick200 conserva el valor, soa=${soaTerreno}`, async t => {
    const kernel = new EcosystemKernel();
    t.after(() => kernel.closeParallelPool());
    const tile = { ...cell(-1, -1, 3), terrain: 'meadow' as const, biome: 'forest' as const, feature: 'tree' as const,
      life: 0.5, growth: 0.9, fertility: 0.9, moisture: 0.9, traffic: -0, cultivation: 0, food: -0, species: undefined };
    delete tile.wood;
    const actual: Tile[] = [tile], expected = clone(actual);
    const options: EcosystemOptions = { hilos: 2, soaTerreno, seed: 51926, cuencas: 0.4, decaimientoFertilidad: 0.001 };
    referenceStep(expected, 90, 'clear', 'day', options);
    kernel.step(actual, 90, 'clear', 'day', options);
    assertTiles(actual, expected, 'wood sigue ausente después del primer paso paralelo');
    assert.equal(Object.hasOwn(tile, 'wood'), false);
    referenceStep(expected, 100, 'clear', 'day', options);
    kernel.step(actual, 100, 'clear', 'day', { ...options, hilos: 1 });
    assertTiles(actual, expected, 'el camino serial crea wood');
    assert.ok(Object.hasOwn(tile, 'wood') && tile.wood! > 0);
    assert.equal(Object.getOwnPropertyDescriptor(tile, 'wood')?.get, undefined, 'wood es una nueva propiedad ordinaria');
    const serialWood = tile.wood!;
    referenceStep(expected, 200, 'rain', 'day', options);
    kernel.step(actual, 200, 'rain', 'day', options);
    assertTiles(actual, expected, 'desligar y volver a enlazar conserva la madera creada');
    assert.ok(tile.wood! > serialWood, 'el segundo rebrote parte de la madera del paso serial');
    assert.ok(Object.is(tile.food, -0) && Object.hasOwn(tile, 'species') && tile.species === undefined);
  });
}

test('retirar teselas materializa los objetos dormidos antes de reutilizar su ranura en otra región', async t => {
  const kernel = new EcosystemKernel();
  t.after(() => kernel.closeParallelPool());
  const active = [cell(-16, -16, 1), cell(-15, -16, 2), cell(-16, -15, 3)];
  active[0]!.food = -0; active[0]!.feature = undefined; active[0]!.species = undefined;
  const expected = clone(active);
  const options: EcosystemOptions = { hilos: 2, soaTerreno: true, seed: 51926, cuencas: 0.4, decaimientoFertilidad: 0.001 };
  referenceStep(expected, 10, 'rain', 'day', options);
  kernel.step(active, 10, 'rain', 'day', options);
  assertTiles(active, expected, 'conjunto que luego duerme');
  const slot = kernel.soaStore!.cells[0]! >>> 8;
  const dormant = { tiles: active }, dormantSnapshot = clone(active);
  kernel.step([], 20, 'clear', 'day', options);
  assert.equal(kernel.soaStore!.pages, 0, 'la página retirada queda libre');
  assertTiles(dormant.tiles, dormantSnapshot, 'retirar no cambia los campos dormidos');
  const other = [cell(512, -512, 4), cell(513, -512, 5), cell(512, -511, 6)], expectedOther = clone(other);
  referenceStep(expectedOther, 30, 'rain', 'day', options);
  kernel.step(other, 30, 'rain', 'day', options);
  assert.equal(kernel.soaStore!.cells[0]! >>> 8, slot, 'se ejerce un reuso real de la misma ranura');
  assertTiles(other, expectedOther, 'otra región ocupa la ranura');
  assertTiles(dormant.tiles, dormantSnapshot, 'los objetos dormidos no leen campos de otra región');
  assert.equal(Object.getOwnPropertyDescriptor(dormant.tiles[0]!, 'life')?.get, undefined);
  dormant.tiles[0]!.life = 0.321; expected[0]!.life = 0.321;
  assertTiles(other, expectedOther, 'una escritura al objeto dormido tampoco altera la nueva región');
  const otherSnapshot = clone(other);
  referenceStep(expected, 40, 'clear', 'day', options);
  kernel.step(dormant.tiles, 40, 'clear', 'day', options);
  assertTiles(dormant.tiles, expected, 'el conjunto dormido vuelve con sus propios valores');
  assertTiles(other, otherSnapshot, 'la región retirada después conserva su último estado');
});
