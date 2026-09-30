import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { setTimeout as wait } from 'node:timers/promises';
import { partitionRegions, type StaticRegion, type StaticRegionOrder } from '../src/world/paralelo/particion.js';
import { StaticWorkerPool } from '../src/world/paralelo/piscina.js';

const WORKERS = 4, REGION_COUNT = 16, CELLS_PER_REGION = 4;
const regions: StaticRegion[] = Array.from({ length: REGION_COUNT }, (_, id) => ({
  id, begin: id * CELLS_PER_REGION, end: (id + 1) * CELLS_PER_REGION,
})).reverse();

// El módulo escribe su propia traza y sus tiempos; no usa los diagnósticos del pool para verificarlos.
const physicalModule = new URL(`data:text/javascript,${encodeURIComponent(`
  import { threadId } from 'node:worker_threads';
  import { performance } from 'node:perf_hooks';
  export async function calculate(job) {
    const { regions, buffers, params, workerIndex } = job;
    if (Object.keys(job).sort().join(',') !== 'buffers,params,regions,workerIndex') {
      throw new Error('La firma natural del handler ha cambiado.');
    }
    const input = new Float64Array(buffers.input), output = new Float64Array(buffers.output);
    const owners = new Int32Array(buffers.owners), order = new Int32Array(buffers.order);
    const regionCounts = new Int32Array(buffers.regionCounts), callCounts = new Int32Array(buffers.callCounts);
    const starts = new Float64Array(buffers.starts), ends = new Float64Array(buffers.ends);
    Atomics.add(callCounts, workerIndex, 1);
    for (const region of regions) {
      starts[region.id] = performance.now();
      const position = Atomics.add(regionCounts, workerIndex, 1);
      order[workerIndex * params.traceStride + position] = region.id;
      for (let index = region.begin; index < region.end; index++) {
        output[index] = (input[index] * 0.5 + input[index] * 0.25) * params.factor;
        owners[index] = threadId;
      }
      if (region.id === params.failRegion) throw new Error('fallo adversarial real en región ' + region.id);
      if (params.asyncPauseMs) await new Promise(resolve => setTimeout(resolve, params.asyncPauseMs));
      ends[region.id] = performance.now();
    }
  }
`)}`);

function physicalState() {
  const count = REGION_COUNT * CELLS_PER_REGION;
  const input = new Float64Array(new SharedArrayBuffer(count * 8));
  const output = new Float64Array(new SharedArrayBuffer(count * 8));
  const owners = new Int32Array(new SharedArrayBuffer(count * 4));
  const order = new Int32Array(new SharedArrayBuffer(WORKERS * REGION_COUNT * 4));
  const regionCounts = new Int32Array(new SharedArrayBuffer(WORKERS * 4));
  const callCounts = new Int32Array(new SharedArrayBuffer(WORKERS * 4));
  const starts = new Float64Array(new SharedArrayBuffer(REGION_COUNT * 8));
  const ends = new Float64Array(new SharedArrayBuffer(REGION_COUNT * 8));
  for (let index = 0; index < count; index++) {
    input[index] = index === 0 ? -0 : index === 1 ? Number.MIN_VALUE : (index / 13 - 2) * 1e-9;
  }
  return {
    input, output, owners, order, regionCounts, callCounts, starts, ends,
    buffers: {
      input: input.buffer, output: output.buffer, owners: owners.buffer, order: order.buffer,
      regionCounts: regionCounts.buffer, callCounts: callCounts.buffer, starts: starts.buffer, ends: ends.buffer,
    },
    reset() {
      output.fill(NaN); owners.fill(0); order.fill(-1); regionCounts.fill(0); callCounts.fill(0);
      starts.fill(NaN); ends.fill(NaN);
    },
    observedOrder() {
      return Array.from({ length: WORKERS }, (_, index) => Array.from(
        order.subarray(index * REGION_COUNT, index * REGION_COUNT + Atomics.load(regionCounts, index)),
      ));
    },
  };
}

function fp64Bytes(state: ReturnType<typeof physicalState>, factor: number): Buffer {
  const expected = new Float64Array(state.input.length);
  for (let index = 0; index < expected.length; index++) {
    expected[index] = (state.input[index]! * 0.5 + state.input[index]! * 0.25) * factor;
  }
  return Buffer.from(expected.buffer);
}

test('el orden físico invierte cada cola estática sin cambiar rangos, propietarios ni entradas', () => {
  const original = structuredClone(regions);
  const natural = partitionRegions(regions, WORKERS);
  for (const orden of ['inverso', 'adversarial'] as const) {
    assert.deepEqual(partitionRegions(regions, WORKERS, orden), natural.map(queue => [...queue].reverse()));
    assert.deepEqual(partitionRegions(regions, 28, orden), partitionRegions(regions, 28).map(queue => [...queue].reverse()));
  }
  assert.deepEqual(regions, original, 'el caller conserva su orden y sus rangos');
  assert.deepEqual(partitionRegions([], WORKERS, 'adversarial'), [[], [], [], []]);
  assert.throws(() => partitionRegions(regions, WORKERS, 'aleatorio' as StaticRegionOrder), /orden debe ser/);
  for (const orden of ['natural', 'inverso', 'adversarial'] as const) {
    assert.throws(() => partitionRegions([
      { id: 'left', begin: 0, end: 3 }, { id: 'right', begin: 2, end: 4 },
    ], WORKERS, orden), /Rangos solapados/);
  }
});

test('el bootstrap autocontenido que viaja al supervisor y a compute tiene sintaxis Node válida', () => {
  const source = readFileSync(new URL('../src/world/paralelo/piscina.ts', import.meta.url), 'utf8');
  const bootstrap = /const WORKER_BOOTSTRAP = String\.raw`([\s\S]*?)`;/.exec(source)?.[1];
  assert.ok(bootstrap, 'el bootstrap procede del código que se ejecuta, no de una copia del test');
  assert.doesNotThrow(() => new Script(bootstrap));
});

test('cuatro workers persistentes calculan FP64 idéntico e invierten llamadas con retardos físicos medidos', async t => {
  const pool = new StaticWorkerPool({ workers: WORKERS, moduleURL: physicalModule, exportName: 'calculate' });
  t.after(() => pool.close());
  const state = physicalState();
  const naturalOrder = partitionRegions(regions, WORKERS).map(queue => queue.map(region => region.id));
  const initialThreadIds = pool.diagnostics().threadIds;
  let baseline: Buffer | undefined;
  for (const options of [
    {}, { orden: 'inverso' }, { orden: 'adversarial', retardoMs: 8 }, { orden: 'adversarial' },
  ] as const) {
    state.reset();
    pool.run({ regions, buffers: state.buffers, params: { factor: 1, traceStride: REGION_COUNT }, ...options });
    const diagnostics = pool.diagnostics();
    const orden = 'orden' in options ? options.orden : 'natural';
    const expectedOrder = orden === 'natural' ? naturalOrder : naturalOrder.map(queue => [...queue].reverse());
    assert.deepEqual(state.observedOrder(), expectedOrder, 'la traza la escribe el handler al recorrer sus regiones');
    assert.deepEqual([...state.callCounts], Array(WORKERS).fill(orden === 'natural' ? 1 : 4));
    assert.deepEqual(diagnostics.regionOrder, orden === 'natural' ? [[], [], [], []] : state.observedOrder());
    assert.deepEqual(diagnostics.threadIds, initialThreadIds, 'ningún despacho recrea el pool');
    const actualThreadIds = [...new Set(state.owners)].sort((a, b) => a - b);
    assert.equal(actualThreadIds.length, WORKERS);
    assert.ok(actualThreadIds.every(id => id > 0), 'threadId proviene físicamente de worker_threads');
    assert.deepEqual([...diagnostics.threadIds].sort((a, b) => a - b), actualThreadIds);
    assert.deepEqual(Buffer.from(state.output.buffer), fp64Bytes(state, 1));
    if (baseline) assert.deepEqual(Buffer.from(state.output.buffer), baseline, 'identidad de bytes incluso con -0 y subnormales');
    baseline ??= Buffer.from(Buffer.from(state.output.buffer));
    if (orden === 'adversarial') {
      const delay = 'retardoMs' in options ? options.retardoMs : 1;
      assert.ok(typeof delay === 'number', 'el caso adversarial tiene un retardo explícito o el default de 1 ms');
      assert.deepEqual(diagnostics.adversarialDelayCounts, Array(WORKERS).fill(3));
      for (let workerIndex = 0; workerIndex < WORKERS; workerIndex++) {
        assert.ok(diagnostics.adversarialDelaysMs[workerIndex]! >= 3 * delay - 0.5,
          'duración monotónica observada: no retardoMs multiplicado por un contador');
        const queue = expectedOrder[workerIndex]! as number[];
        for (let position = 1; position < queue.length; position++) {
          const gap = state.starts[queue[position]!]! - state.ends[queue[position - 1]!]!;
          assert.ok(gap >= delay - 0.25, `el reloj del handler confirma la espera entre regiones: ${gap} ms`);
        }
      }
    } else {
      assert.deepEqual(diagnostics.adversarialDelayCounts, Array(WORKERS).fill(0));
      assert.deepEqual(diagnostics.adversarialDelaysMs, Array(WORKERS).fill(0));
    }
  }
  assert.equal(pool.diagnostics().dispatches, 4);
  assert.deepEqual(pool.diagnostics().completedJobs, Array(WORKERS).fill(4));

  for (const retardoMs of [NaN, Infinity, -1]) {
    assert.throws(() => pool.run({ regions, buffers: state.buffers, params: {}, orden: 'adversarial', retardoMs }), /retardoMs/);
  }
  assert.throws(() => pool.run({ regions, buffers: state.buffers, params: {}, orden: 'desconocido' as StaticRegionOrder }), /orden debe ser/);
  assert.equal(pool.diagnostics().dispatches, 4, 'las opciones inválidas no llegan a workers');

  state.reset();
  pool.run({ regions: [], buffers: state.buffers, params: {}, orden: 'adversarial' });
  assert.deepEqual([...state.callCounts], Array(WORKERS).fill(0), 'colas vacías no inventan llamadas por región');
  assert.deepEqual(pool.diagnostics().regionOrder, [[], [], [], []]);
  assert.deepEqual(pool.diagnostics().adversarialDelaysMs, Array(WORKERS).fill(0));
  assert.deepEqual(pool.diagnostics().adversarialDelayCounts, Array(WORKERS).fill(0));
  assert.deepEqual(pool.diagnostics().completedJobs, Array(WORKERS).fill(5));

  pool.run({ regions: [{ id: 0, begin: 0, end: 0 }], buffers: state.buffers,
    params: { factor: 1, traceStride: REGION_COUNT }, orden: 'adversarial' });
  assert.equal(state.callCounts.reduce((sum, count) => sum + count, 0), 1, 'un rango vacío sí es una región real');
  assert.equal(state.owners.reduce((sum, count) => sum + count, 0), 0, 'el rango vacío no escribe celdas');
  assert.deepEqual(pool.diagnostics().adversarialDelayCounts, Array(WORKERS).fill(0), 'nunca se espera antes de la primera región');

  state.reset();
  pool.run({ regions, buffers: state.buffers, params: { factor: 1, traceStride: REGION_COUNT } });
  assert.deepEqual(pool.diagnostics().regionOrder, [[], [], [], []], 'natural elimina la observación del despacho anterior');
  assert.deepEqual(pool.diagnostics().adversarialDelayCounts, Array(WORKERS).fill(0));
  assert.deepEqual(pool.diagnostics().threadIds, initialThreadIds);
});

test('un throw por región espera a todos los handlers async antes de retornar y permite reintentar', async t => {
  const pool = new StaticWorkerPool({ workers: WORKERS, moduleURL: physicalModule, exportName: 'calculate' });
  t.after(() => pool.close());
  const state = physicalState();
  state.reset();
  assert.throws(() => pool.run({
    regions, buffers: state.buffers, params: { factor: 1, traceStride: REGION_COUNT, failRegion: 3, asyncPauseMs: 3 },
    orden: 'adversarial', retardoMs: 1,
  }), /fallo adversarial real en región 3/);
  assert.deepEqual([...state.regionCounts], [1, 4, 4, 4], 'las otras colas terminaron físicamente antes del error');
  assert.deepEqual(pool.diagnostics().regionOrder, [[3], [7, 6, 5, 4], [11, 10, 9, 8], [15, 14, 13, 12]]);
  const observedCounts = [...state.regionCounts], outputAfterError = Buffer.from(Buffer.from(state.output.buffer));
  await wait(15); // Sólo el test; el motor no usa este plazo ni lo convierte en quiescencia.
  assert.deepEqual([...state.regionCounts], observedCounts);
  assert.deepEqual(Buffer.from(state.output.buffer), outputAfterError, 'no quedan escrituras tardías de handlers async');
  state.reset();
  pool.run({ regions, buffers: state.buffers, params: { factor: 2, traceStride: REGION_COUNT }, orden: 'adversarial' });
  assert.deepEqual(Buffer.from(state.output.buffer), fp64Bytes(state, 2));
  assert.deepEqual(pool.diagnostics().completedJobs, Array(WORKERS).fill(2));
});
