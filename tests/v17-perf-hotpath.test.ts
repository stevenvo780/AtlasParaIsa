import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bindWorldContext, closeFaunaParallelPools, closePersonasParallelPools, closePolicyGpuBatchers,
  createWorld, stepWorld, worldContext,
} from '../src/world/index.js';
import { closeEcosystemWorkers } from '../src/world/ecosystem.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { primero, primeroConFiltroCaro, primeroPorClave, primeroPorClaveConFiltroCaro } from '../src/world/orden.js';
import { DEFAULT_PARAMS, parseParams, setParams } from '../src/world/params.js';
import { EstadoPersonasCompartido, PersonasParallelPool } from '../src/world/paralelo/personas-motor.js';
import { ResidentTopologyOwner } from '../src/world/soa/topologia.js';
import { activate, maintainRegions } from '../src/world/spatial.js';
import { hostOpenWorldParams } from '../src/server/hardware-limits.js';
import { gpuNvrtcAvailable } from '../src/world/gpu/puente.js';
import { gpuParitySession } from '../src/world/gpu/autoprueba.js';

test('V17 perf: primeroPorClave y primeroPorClaveConFiltroCaro coinciden exactamente con primero*', () => {
  const items = [
    { id: 'a', v: 3.5, ok: false },
    { id: 'b', v: 2.0, ok: true },
    { id: 'c', v: -0, ok: true },
    { id: 'd', v: +0, ok: true },
    { id: 'e', v: -2.25, ok: true },
    { id: 'f', v: -2.25, ok: true },
  ];
  const key = (x: typeof items[number]) => x.v;
  const keep = (x: typeof items[number]) => x.ok;
  assert.equal(primeroPorClave(items, key, keep), primero(items, (a, b) => key(a) - key(b), keep));
  assert.equal(primeroPorClaveConFiltroCaro(items, key, keep), primeroConFiltroCaro(items, (a, b) => key(a) - key(b), keep));
  assert.equal(primeroPorClave(items.slice(1, 4), key, keep)?.id, 'c');
  assert.equal(primeroPorClave([], key, keep), undefined);
  assert.equal(primeroPorClaveConFiltroCaro([], key, keep), undefined);
});

test('V17 perf: #walkCache incremental en personas-motor coincide bit a bit tras activate, maintainRegions, cambio de terreno y mutación in-place', async () => {
  const params = parseParams({
    motor: { ...DEFAULT_PARAMS.motor, hilos: 1, soaTerreno: true, particionarPersonas: true },
  });
  const world = createWorld(51926, params);
  const owner = new ResidentTopologyOwner();
  world.tiles = owner.tiles(world.tiles.map(t => owner.tile(t)));
  bindWorldContext(world, { ...worldContext(world), tileOwnership: owner });

  const incremental = new EstadoPersonasCompartido();
  const pool = new PersonasParallelPool({ hilos: 1 });
  const compare = (label: string): void => {
    const fresh = new EstadoPersonasCompartido();
    incremental.empaquetarSoloMovimiento(world, { movimiento: true });
    fresh.empaquetarSoloMovimiento(world, { movimiento: true });
    pool.stepPhaseB(incremental);
    const incOut = new Int32Array(incremental.buffers.salidaI32).slice();
    pool.stepPhaseB(fresh);
    const freshOut = new Int32Array(fresh.buffers.salidaI32).slice();
    assert.deepEqual(incOut, freshOut, `divergencia en ${label}`);
  };

  // 1. Arranque en frío + hit exacto.
  compare('cold');
  compare('exact-hit');

  // 2. Alta de chunk nuevo (`activate` → push al final).
  activate(world, 96, 96, worldContext(world));
  compare('after-activate');

  // 3. Mover una persona lejos y retirar chunks fríos (`maintainRegions` → splitTileBlocks).
  for (const p of world.people) { p.x = 96; p.y = 96; p.target = { x: 100, y: 100 }; }
  maintainRegions(world, worldContext(world));
  compare('after-maintainRegions');

  // 4. Mutación de terreno (`terrainRev` invalida la caché de caminabilidad).
  const targetTile = world.tiles.find(t => t.x === 97 && t.y === 96)!;
  targetTile.terrain = 'water';
  compare('after-terrain-change');

  // 5. Mutación in-place de un elemento existente (`inPlaceRev` invalida la caché).
  const idx = world.tiles.findIndex(t => t.x === 98 && t.y === 96);
  const replacement = owner.tile({ ...world.tiles[idx]!, terrain: 'water' });
  world.tiles[idx] = replacement;
  compare('after-inplace-overwrite');

  await pool.close();
});

test('V17 perf: paridad exacta 1T vs 4T residente con chunks dinámicos (activate + maintainRegions + ecologia + fauna + personas)', async () => {
  const base = hostOpenWorldParams(DEFAULT_PARAMS, {
    cpuThreads: () => 4,
    totalRamBytes: () => 32 * 1024 ** 3,
    nvrtcAvailable: () => false,
  });
  const run = (hilos: number, resident: boolean) => {
    const params = parseParams({
      motor: { ...base.motor, hilos, gpu: [], soaTerreno: true, particionarPersonas: hilos > 1 },
    }, base);
    const world = createWorld(42, params);
    if (resident) {
      const owner = new ResidentTopologyOwner();
      world.tiles = owner.tiles(world.tiles.map(t => owner.tile(t)));
      bindWorldContext(world, { ...worldContext(world), tileOwnership: owner });
    }
    for (let t = 0; t < 180; t++) stepWorld(world, [], worldContext(world));
    setParams(world, base);
    return digestoCanonico(world);
  };
  const d1 = run(1, false);
  const d4 = run(4, true);
  assert.equal(d4, d1, '1T no residente y 4T residente deben producir exactamente el mismo digestoCanonico');
  await closePolicyGpuBatchers();
  await closeFaunaParallelPools();
  await closePersonasParallelPools();
  await closeEcosystemWorkers();
});

test('V17 perf: paridad exacta 1T CPU vs 4T + GPU residente en 60 pasos', async t => {
  if (!gpuNvrtcAvailable()) { t.skip('NVRTC no disponible'); return; }
  const parity = await gpuParitySession.initialize(0, { budgetMs: 5000 });
  if (!parity.enabled) { t.skip('GPU 0 no habilitada'); return; }
  const base = hostOpenWorldParams(DEFAULT_PARAMS, {
    cpuThreads: () => 4,
    totalRamBytes: () => 32 * 1024 ** 3,
    nvrtcAvailable: () => false,
  });
  const run = (hilos: number, gpu: number[]) => {
    const params = parseParams({
      motor: { ...base.motor, hilos, gpu, soaTerreno: true, particionarPersonas: hilos > 1 },
    }, base);
    const world = createWorld(7, params);
    const owner = new ResidentTopologyOwner();
    world.tiles = owner.tiles(world.tiles.map(t => owner.tile(t)));
    bindWorldContext(world, { ...worldContext(world), tileOwnership: owner });
    for (let i = 0; i < 60; i++) stepWorld(world, [], worldContext(world));
    setParams(world, base);
    return digestoCanonico(world);
  };
  assert.equal(run(4, [0]), run(1, []));
  await closePolicyGpuBatchers();
  await closeFaunaParallelPools();
  await closePersonasParallelPools();
  await closeEcosystemWorkers();
});
