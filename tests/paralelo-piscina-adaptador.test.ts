import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { setTimeout as wait } from 'node:timers/promises';
import { partitionRegions, type StaticRegion } from '../src/world/paralelo/particion.js';
import { StaticWorkerPool } from '../src/world/paralelo/piscina.js';

const WORKERS = 4, REGION_COUNT = 16, CELLS_PER_REGION = 4;
const regions: StaticRegion[] = Array.from({ length: REGION_COUNT }, (_, id) => ({
  id, begin: id * CELLS_PER_REGION, end: (id + 1) * CELLS_PER_REGION,
})).reverse();

// El módulo escribe su propia traza; no usa los diagnósticos del pool para verificarlos.
const physicalModule = new URL(`data:text/javascript,${encodeURIComponent(`
  import { threadId } from 'node:worker_threads';
  export async function calculate(job) {
    const { regions, buffers, params, workerIndex } = job;
    if (Object.keys(job).sort().join(',') !== 'buffers,params,regions,workerIndex') {
      throw new Error('La firma natural del handler ha cambiado.');
    }
    const input = new Float64Array(buffers.input), output = new Float64Array(buffers.output);
    const owners = new Int32Array(buffers.owners), order = new Int32Array(buffers.order);
    const regionCounts = new Int32Array(buffers.regionCounts), callCounts = new Int32Array(buffers.callCounts);
    Atomics.add(callCounts, workerIndex, 1);
    for (const region of regions) {
      const position = Atomics.add(regionCounts, workerIndex, 1);
      order[workerIndex * params.traceStride + position] = region.id;
      for (let index = region.begin; index < region.end; index++) {
        output[index] = (input[index] * 0.5 + input[index] * 0.25) * params.factor;
        owners[index] = threadId;
      }
      if (region.id === params.failRegion) throw new Error('fallo real en región ' + region.id);
      if (params.asyncPauseMs) await new Promise(resolve => setTimeout(resolve, params.asyncPauseMs));
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
  for (let index = 0; index < count; index++) {
    input[index] = index === 0 ? -0 : index === 1 ? Number.MIN_VALUE : (index / 13 - 2) * 1e-9;
  }
  return {
    input, output, owners, order, regionCounts, callCounts,
    buffers: {
      input: input.buffer, output: output.buffer, owners: owners.buffer, order: order.buffer,
      regionCounts: regionCounts.buffer, callCounts: callCounts.buffer,
    },
    reset() {
      output.fill(NaN); owners.fill(0); order.fill(-1); regionCounts.fill(0); callCounts.fill(0);
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

test('el bootstrap autocontenido que viaja al supervisor y a compute tiene sintaxis Node válida', () => {
  const source = readFileSync(new URL('../src/world/paralelo/piscina.ts', import.meta.url), 'utf8');
  const bootstrap = /const WORKER_BOOTSTRAP = String\.raw`([\s\S]*?)`;/.exec(source)?.[1];
  assert.ok(bootstrap, 'el bootstrap procede del código que se ejecuta, no de una copia del test');
  assert.doesNotThrow(() => new Script(bootstrap));
});

test('cuatro workers persistentes calculan FP64 idéntico, una llamada por cola y despacho', async t => {
  const pool = new StaticWorkerPool({ workers: WORKERS, moduleURL: physicalModule, exportName: 'calculate' });
  t.after(() => pool.close());
  const state = physicalState();
  const colas = partitionRegions(regions, WORKERS).map(queue => queue.map(region => region.id));
  const initialThreadIds = pool.diagnostics().threadIds;
  for (let despacho = 0; despacho < 4; despacho++) {
    state.reset();
    pool.run({ regions, buffers: state.buffers, params: { factor: 1, traceStride: REGION_COUNT } });
    const diagnostics = pool.diagnostics();
    assert.deepEqual(state.observedOrder(), colas, 'cada worker recorre su tramo en el orden de entrada');
    assert.deepEqual([...state.callCounts], Array(WORKERS).fill(1));
    assert.deepEqual(diagnostics.threadIds, initialThreadIds, 'ningún despacho recrea el pool');
    const actualThreadIds = [...new Set(state.owners)].sort((a, b) => a - b);
    assert.equal(actualThreadIds.length, WORKERS);
    assert.ok(actualThreadIds.every(id => id > 0), 'threadId proviene físicamente de worker_threads');
    assert.deepEqual([...diagnostics.threadIds].sort((a, b) => a - b), actualThreadIds);
    assert.deepEqual(Buffer.from(state.output.buffer), fp64Bytes(state, 1), 'identidad de bytes incluso con -0 y subnormales');
  }
  assert.equal(pool.diagnostics().dispatches, 4);
  assert.deepEqual(pool.diagnostics().completedJobs, Array(WORKERS).fill(4));

  state.reset();
  pool.run({ regions: [], buffers: state.buffers, params: {} });
  assert.deepEqual(pool.diagnostics().completedJobs, Array(WORKERS).fill(5), 'colas vacías también cruzan la barrera');
  pool.run({ regions: [{ id: 0, begin: 0, end: 0 }], buffers: state.buffers, params: { factor: 1, traceStride: REGION_COUNT } });
  assert.equal(state.regionCounts.reduce((sum, count) => sum + count, 0), 1, 'un rango vacío sí es una región real');
  assert.equal(state.owners.reduce((sum, count) => sum + count, 0), 0, 'el rango vacío no escribe celdas');
});

test('un throw por región espera a todos los handlers async antes de retornar y permite reintentar', async t => {
  const pool = new StaticWorkerPool({ workers: WORKERS, moduleURL: physicalModule, exportName: 'calculate' });
  t.after(() => pool.close());
  const state = physicalState();
  const colas = partitionRegions(regions, WORKERS).map(queue => queue.map(region => region.id));
  const fallida = colas.findIndex(cola => cola.includes(3));
  state.reset();
  assert.throws(() => pool.run({
    regions, buffers: state.buffers, params: { factor: 1, traceStride: REGION_COUNT, failRegion: 3, asyncPauseMs: 3 },
  }), /fallo real en región 3/);
  assert.deepEqual([...state.regionCounts], colas.map((cola, w) => w === fallida ? cola.indexOf(3) + 1 : cola.length),
    'las otras colas terminaron físicamente antes del error');
  const observedCounts = [...state.regionCounts], outputAfterError = Buffer.from(Buffer.from(state.output.buffer));
  await wait(15); // Sólo el test; el motor no usa este plazo ni lo convierte en quiescencia.
  assert.deepEqual([...state.regionCounts], observedCounts);
  assert.deepEqual(Buffer.from(state.output.buffer), outputAfterError, 'no quedan escrituras tardías de handlers async');
  state.reset();
  pool.run({ regions, buffers: state.buffers, params: { factor: 2, traceStride: REGION_COUNT } });
  assert.deepEqual(Buffer.from(state.output.buffer), fp64Bytes(state, 2));
  assert.deepEqual(pool.diagnostics().completedJobs, Array(WORKERS).fill(2));
});
