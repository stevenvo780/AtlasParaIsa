import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { IncrementalRegionHasher } from '../src/world/digesto.js';
import { closeEcosystemWorkers } from '../src/world/ecosystem.js';
import { stepWorld } from '../src/world/index.js';
import { paramsOf, setParams } from '../src/world/params.js';
import { HARDWARE_SCENES, HARDWARE_SEEDS, buildHardwareScene, regionGroupedHarvestTotal,
  sequentialHarvestTotal } from './hardware/escenas.js';
import { firstHashDisagreement, locateDifference, normalizedCopy,
  snapshotBarrier, throwDifference } from './hardware/contrato.js';
import { CPU_BACKENDS, adversarialWorkerCount, captureReference, compareCandidate } from './hardware/matriz.js';

// The default npm test includes the complete literal 600-step CPU matrix. Opt-in replaces
// its duration with 2400 steps; it never relabels a shorter trajectory as the long gate.
const STEPS = process.env.ATLAS_T117_LONG === '1' ? 2400 : 600;
after(async () => { await closeEcosystemWorkers(); });

test('T117 fixtures: the 28 private scenes establish actual biological and geometric witnesses', () => {
  for (const seed of HARDWARE_SEEDS) for (const scene of HARDWARE_SCENES) {
    const fixture = buildHardwareScene(seed, scene);
    for (let step = 1; step <= 10; step++) { stepWorld(fixture.world); fixture.afterStep(step); }
    fixture.assertWitness();
  }
});

test('T117 schedule changes workers every tick, including every consecutive ecology tick', () => {
  const counts = new Set<number>();
  for (let tick = 1; tick <= 2400; tick++) {
    const count = adversarialWorkerCount(tick); counts.add(count);
    if (tick > 1) assert.notEqual(count, adversarialWorkerCount(tick - 1));
    if (tick % 10 === 0 && tick > 10) assert.notEqual(count, adversarialWorkerCount(tick - 10));
  }
  assert.deepEqual([...counts].sort((a, b) => a - b), [2, 4, 8, 28]);
});

test('T117 normalization preserves every law and every execution option outside the four selectors', () => {
  const world = buildHardwareScene(7, 'compacta').world;
  const params = structuredClone(paramsOf(world));
  Object.assign(params.motor, { hilos: 28, orden: 'adversarial', gpu: [0, 1], soaTerreno: true });
  setParams(world, params);
  const copy = normalizedCopy(world), expected = structuredClone(params);
  Object.assign(expected.motor, { hilos: 1, orden: 'natural', gpu: [], soaTerreno: false });
  assert.deepEqual(paramsOf(copy), expected);
  assert.deepEqual(copy, structuredClone(world));
  assert.deepEqual(paramsOf(copy).recursos, params.recursos);
  assert.deepEqual(paramsOf(copy).poblacion, params.poblacion);
});

test('T117 negativo FP64: a synthetic tree sum fails and locates the first tile/field/index', () => {
  const reference = buildHardwareScene(7, 'compacta').world;
  const candidate = normalizedCopy(reference);
  // Both final stocks are valid nonnegative states. The arithmetic counterexample is
  // intentionally synthetic, outside the world laws; no implementation gets patched.
  const values = [2 ** 39, 0.00003, -(2 ** 39), 0.00003];
  let serial = 0;
  for (const value of values) serial += value;
  const tree = (values[0]! + values[1]!) + (values[2]! + values[3]!);
  assert.notEqual(serial, tree);
  const index = reference.tiles.findIndex(tile => tile.x === 9 && tile.y === 9);
  assert.ok(index >= 0);
  reference.tiles[index]!.food = serial; candidate.tiles[index]!.food = tree;
  const left = new IncrementalRegionHasher(256, { normalizeExecution: true });
  const right = new IncrementalRegionHasher(256, { normalizeExecution: true });
  const boundary = { tick: reference.tick, phase: 'kernel' as const };
  const expected = snapshotBarrier(boundary, left.update(reference));
  const actual = right.update(candidate);
  const page = firstHashDisagreement(expected, actual);
  assert.equal(page, '0,0');
  const difference = locateDifference(reference, candidate, boundary, page);
  assert.deepEqual({ tick: difference.tick, phase: difference.phase, page: difference.page,
    field: difference.field, index: difference.index }, { tick: 0, phase: 'kernel', page: '0,0', field: 'food', index });
  assert.throws(() => throwDifference(difference), error => error instanceof assert.AssertionError
    && /tick=0 fase=kernel pagina=0,0 campo=food indice=\d+/.test(error.message));
});

for (const regionSide of [256, 512] as const) test(`T117 negativo totals: real two-region harvest detects grouped FP64 accumulation geometry=${regionSide}`, () => {
  const fixture = buildHardwareScene(51926, 'cosecha-dos-regiones');
  stepWorld(fixture.world); fixture.afterStep(1); fixture.assertWitness();
  const reference = fixture.world, candidate = normalizedCopy(reference);
  assert.ok(Object.is(reference.totals.foodHarvested, sequentialHarvestTotal()));
  candidate.totals.foodHarvested = regionGroupedHarvestTotal(regionSide);
  const boundary = { tick: reference.tick, phase: 'fin-paso' as const };
  const expected = snapshotBarrier(boundary, new IncrementalRegionHasher(256, { normalizeExecution: true }).update(reference));
  const actual = new IncrementalRegionHasher(256, { normalizeExecution: true }).update(candidate);
  assert.deepEqual(actual.pageHashes, expected.pageHashes, 'Physical tile harvest is identical; only totals can diagnose this mutation.');
  assert.deepEqual(actual.regionHashes, expected.regionHashes);
  assert.equal(firstHashDisagreement(expected, actual), 'global');
  const difference = locateDifference(reference, candidate, boundary);
  assert.equal(difference.field, 'totals.foodHarvested'); assert.equal(difference.page, 'global');
  assert.equal(difference.index, null); assert.equal(difference.tick, 1); assert.equal(difference.phase, 'fin-paso');
  assert.throws(() => throwDifference(difference), error => error instanceof assert.AssertionError
    && /tick=1 fase=fin-paso pagina=global campo=totals.foodHarvested indice=global/.test(error.message));
});

test('T117 negativo fin-paso: food/stone/fauna mutations outside ecology fail on the same tick', () => {
  const reference = captureReference(7, 'cosecha-dos-regiones', 10);
  assert.equal(reference.startTick, 0);
  const firstBoundary = reference.barriers[0]!;
  assert.equal(firstBoundary.tick, 1); assert.equal(firstBoundary.phase, 'fin-paso');
  // The reference itself must include the real first-tick harvest. This independently
  // checks that its step-end path did not retain the pre-action page hashes with [].
  const actualFirstStep = buildHardwareScene(7, 'cosecha-dos-regiones');
  stepWorld(actualFirstStep.world); actualFirstStep.afterStep(1); actualFirstStep.assertWitness();
  const fresh = new IncrementalRegionHasher(256, { normalizeExecution: true }).update(actualFirstStep.world);
  assert.equal(firstHashDisagreement(firstBoundary, fresh), null);
  for (const field of ['food', 'stone', 'fauna'] as const) {
    let injected = false;
    assert.throws(() => compareCandidate(reference, 256, 1, { afterStep(world, step) {
      if (step !== 1) return;
      assert.equal(world.tick, 1); assert.notEqual(world.tick % 10, 0);
      const tile = world.tiles.find(t => t.x === 9 && t.y === 9)!;
      assert.ok(tile); tile[field] = (tile[field] ?? 0) + (field === 'fauna' ? 1 : 0.03125);
      injected = true;
    } }), error => error instanceof assert.AssertionError
      && error.message.includes(`tick=1 fase=fin-paso pagina=0,0 campo=${field} indice=`));
    assert.ok(injected, `${field} must be mutated after the real first step, before any ecology dispatch.`);
  }
});

for (const seed of HARDWARE_SEEDS) for (const scene of HARDWARE_SCENES) {
  test(`T117 matrix seed=${seed} scene=${scene} steps=${STEPS}`, async t => {
    const started = performance.now(), reference = captureReference(seed, scene, STEPS);
    let actualDispatches = 0, actualDelays = 0, topologyScannedTiles = reference.topologyScannedTiles;
    let fullRefreshes = reference.fullRefreshes;
    for (const regionSide of [256, 512] as const) for (const backend of CPU_BACKENDS) {
      await t.test(`CPU=${backend} geometry=${regionSide}`, () => {
        const evidence = compareCandidate(reference, regionSide, backend);
        actualDispatches += evidence.actualKernelDispatches; actualDelays += evidence.delayCount;
        topologyScannedTiles += evidence.topologyScannedTiles; fullRefreshes += evidence.fullRefreshes;
      });
    }
    // Diagnostic measurements are evidence, never substituted for the global <=180s gate.
    t.diagnostic(`steps=${STEPS}; elapsedMs=${(performance.now() - started).toFixed(3)};`
      + ` physicalKernelDispatches=${actualDispatches}; realDelayCount=${actualDelays};`
      + ` topologyScannedTiles=${topologyScannedTiles}; fullRefreshes=${fullRefreshes}`);
  });
  for (const regionSide of [256, 512]) for (const gpu of [[0], [1], [0, 1]]) test(`T117 CUDA seed=${seed} scene=${scene} geometry=${regionSide} gpu=[${gpu.join(',')}]`,
    { skip: 'Etapa C pending: no CUDA ecology backend implemented or certified; this is SKIP, never CPU/GPU PASS.' }, () => {});
}
