import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { IncrementalRegionHasher } from '../src/world/digesto.js';
import { closeEcosystemWorkers } from '../src/world/ecosystem.js';
import { stepWorld } from '../src/world/index.js';
import { paramsOf, setParams } from '../src/world/params.js';
import { residentTopologyOwner, residentTopologyToken } from '../src/world/soa/topologia.js';
import { chunkKey } from '../src/world/terrain.js';
import { HARDWARE_SCENES, HARDWARE_SEEDS, buildHardwareScene, regionGroupedHarvestTotal,
  sequentialHarvestTotal } from './hardware/escenas.js';
import { firstHashDisagreement, locateDifference, normalizedCopy, plainWorldCopy,
  snapshotBarrier, throwDifference } from './hardware/contrato.js';
import { CPU_BACKENDS, adversarialWorkerCount, captureReference, compareCandidate, compareGpuCandidate, type ReferenceTrace } from './hardware/matriz.js';
import { HardwareTileChanges } from './hardware/cambios.js';

// The default npm test includes the complete literal 600-step CPU matrix. Opt-in replaces
// its duration with 2400 steps; it never relabels a shorter trajectory as the long gate.
const STEPS = process.env.ATLAS_T117_LONG === '1' ? 2400 : 600;
after(async () => { await closeEcosystemWorkers(); });
const referenceCache = new Map<string, ReferenceTrace>();
function cachedReference(seed: number, scene: (typeof HARDWARE_SCENES)[number]): ReferenceTrace {
  const key = `${seed}|${scene}|${STEPS}`;
  let trace = referenceCache.get(key);
  if (!trace) { trace = captureReference(seed, scene, STEPS); referenceCache.set(key, trace); }
  return trace;
}

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
  assert.deepEqual(copy, plainWorldCopy(world));
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

test('T120 tracker: owned set/delete/define touches one page and stable captures scan no topology', () => {
  const world = buildHardwareScene(7, 'compacta').world, tracker = new HardwareTileChanges(world);
  const initial = tracker.capture(), certificate = tracker.topologyCertificate;
  assert.ok(certificate); assert.ok(initial.fullRefresh);
  assert.equal(initial.digest.topologyScannedTiles, world.tiles.length);
  const tile = world.tiles.find(t => t.x === 9 && t.y === 9)!;
  tile.food += 0.03125; tile.stone = 0.25; tile.fauna = 1; tile.species = 'hare';
  delete tile.variety;
  Object.defineProperty(tile, 'cultivation', { value: -0, writable: true, configurable: true, enumerable: true });
  Object.defineProperty(tile, 'traffic', { value: undefined, writable: true, configurable: true, enumerable: true });
  const capture = tracker.capture();
  assert.equal(capture.fullRefresh, false); assert.equal(capture.changedTiles, 1);
  assert.equal(capture.digest.updatedPages, 1); assert.equal(capture.digest.topologyScannedTiles, 0);
  assert.strictEqual(tracker.topologyCertificate, certificate, 'Value/key writes keep the real topology token stable.');
  const fresh = new IncrementalRegionHasher(256, { normalizeExecution: true }).update(world);
  assert.deepEqual(capture.digest.pageHashes, fresh.pageHashes); assert.equal(capture.digest.globalHash, fresh.globalHash);
  const stable = tracker.capture();
  assert.deepEqual(stable.dirtyPages, []); assert.equal(stable.digest.updatedPages, 0);
  assert.equal(stable.digest.topologyScannedTiles, 0); assert.equal(stable.fullRefresh, false);
});

test('T120 tracker: array replacement/reorder/coordinates renew certificates before hashing', () => {
  const world = buildHardwareScene(7, 'compacta').world, owner = residentTopologyOwner(world.tiles)!;
  const tracker = new HardwareTileChanges(world); tracker.capture();
  let certificate = tracker.topologyCertificate;
  const tile = world.tiles[0]!;
  world.tiles = owner.tiles([...world.tiles]);
  let capture = tracker.capture();
  assert.ok(capture.digest.rebuiltTopology); assert.notStrictEqual(tracker.topologyCertificate, certificate);
  assert.strictEqual(tracker.topologyCertificate!.tiles, world.tiles); assert.strictEqual(world.tiles[0], tile);
  certificate = tracker.topologyCertificate;
  world.tiles.reverse(); capture = tracker.capture();
  assert.ok(capture.digest.rebuiltTopology); assert.notStrictEqual(tracker.topologyCertificate, certificate);
  certificate = tracker.topologyCertificate;
  const first = world.tiles[0]!, second = world.tiles[1]!, x = first.x;
  first.x = second.x; second.x = x;
  capture = tracker.capture();
  assert.ok(capture.digest.rebuiltTopology); assert.notStrictEqual(tracker.topologyCertificate, certificate);
  const fresh = new IncrementalRegionHasher(256, { normalizeExecution: true }).update(world);
  assert.deepEqual(capture.digest.pageHashes, fresh.pageHashes);
  assert.equal(tracker.capture().digest.topologyScannedTiles, 0);
});

test('T120 tracker: raw/getter revocation refreshes unobservable writes safely', () => {
  for (const mode of ['raw', 'getter'] as const) {
    const world = buildHardwareScene(7, 'compacta').world, tracker = new HardwareTileChanges(world);
    tracker.capture(); let food = world.tiles[0]!.food;
    if (mode === 'raw') world.tiles[0] = { ...world.tiles[0]! };
    else Object.defineProperty(world.tiles[0]!, 'food', { get: () => food, configurable: true, enumerable: true });
    assert.equal(residentTopologyToken(world.tiles), undefined);
    const capture = tracker.capture(); assert.ok(capture.fullRefresh);
    assert.equal(tracker.topologyCertificate, undefined);
    const previous = new Map(capture.digest.pageHashes);
    if (mode === 'raw') world.tiles[0]!.food += 0.03125; else food += 0.03125;
    const next = tracker.capture();
    assert.ok(next.fullRefresh); assert.ok(next.digest.topologyScannedTiles >= world.tiles.length);
    assert.notDeepEqual(next.digest.pageHashes, previous, 'A raw write/getter closure cannot hide behind an old certificate.');
  }
});

test('T120 canonical copy materializes active/dormant Proxies preserving keys, undefined and -0', () => {
  const world = buildHardwareScene(7, 'compacta').world, owner = residentTopologyOwner(world.tiles)!;
  const meta = Object.values(world.chunks)[0]!, cx = meta.cx + 256, cy = meta.cy + 256;
  const tiles = world.tiles.filter(tile => chunkKey(tile.x, tile.y) === meta.key)
    .map(tile => owner.tile({ ...tile, x: tile.x + 4096, y: tile.y + 4096 }));
  world.retiredChunks.push({ ...meta, key: `${cx},${cy}`, cx, cy, tiles, places: [], animals: [], structures: [], lifeVersion: 4, lastTick: world.tick });
  const active = world.tiles[0]!, dormant = tiles[0]!;
  for (const tile of [active, dormant]) { tile.wood = -0; tile.species = undefined; }
  const copy = normalizedCopy(world);
  for (const [before, after] of [[active, copy.tiles[0]!], [dormant, copy.retiredChunks[0]!.tiles[0]!]]) {
    assert.deepEqual(Object.keys(after!), Object.keys(before!));
    assert.ok(Object.hasOwn(after!, 'species')); assert.equal(after!.species, undefined);
    assert.ok(Object.is(after!.wood, -0)); assert.notStrictEqual(before, after);
  }
  assert.doesNotThrow(() => structuredClone(copy));
});

for (const seed of HARDWARE_SEEDS) for (const scene of HARDWARE_SCENES) {
  test(`T117 matrix seed=${seed} scene=${scene} steps=${STEPS}`, async t => {
    const started = performance.now(), reference = cachedReference(seed, scene);
    let actualDispatches = 0, actualEcologyDispatches = 0, actualDelays = 0, topologyScannedTiles = reference.topologyScannedTiles;
    let fullRefreshes = reference.fullRefreshes;
    let globalCaptures = reference.globalCaptures, logicalTileChanges = reference.logicalTileChanges,
      updatedPages = reference.updatedPages;
    for (const regionSide of [256, 512] as const) for (const backend of CPU_BACKENDS) {
      await t.test(`CPU=${backend} geometry=${regionSide}`, () => {
        const evidence = compareCandidate(reference, regionSide, backend);
        actualDispatches += evidence.actualKernelDispatches; actualDelays += evidence.delayCount;
        actualEcologyDispatches += evidence.actualEcologyDispatches;
        topologyScannedTiles += evidence.topologyScannedTiles; fullRefreshes += evidence.fullRefreshes;
        globalCaptures += evidence.globalCaptures; logicalTileChanges += evidence.logicalTileChanges;
        updatedPages += evidence.updatedPages;
      });
    }
    // Diagnostic measurements are evidence, never substituted for the global <=180s gate.
    t.diagnostic(`steps=${STEPS}; elapsedMs=${(performance.now() - started).toFixed(3)};`
      + ` physicalEcologyDispatches=${actualEcologyDispatches}; physicalKernelDispatches=${actualDispatches}; realDelayCount=${actualDelays};`
      + ` topologyScannedTiles=${topologyScannedTiles}; fullRefreshes=${fullRefreshes};`
      + ` logicalTileChanges=${logicalTileChanges}; updatedPages=${updatedPages}; globalCaptures=${globalCaptures}`);
  });
  for (const regionSide of [256, 512] as const) for (const gpu of [[0], [1], [0, 1]] as const) test(`T117 CUDA seed=${seed} scene=${scene} geometry=${regionSide} gpu=[${gpu.join(',')}]`,
    { skip: process.env.COMPUTE_NVRTC ? false : 'COMPUTE_NVRTC no está definido: backend GPU omitido (skip explícito, nunca pass).' }, t => {
      const reference = cachedReference(seed, scene);
      const evidence = compareGpuCandidate(reference, regionSide, gpu);
      t.diagnostic(`gpu=[${gpu.join(',')}]; elapsedMs=${evidence.elapsedMs.toFixed(3)};`
        + ` uploadedBytes=${evidence.uploadedBytes}; downloadedBytes=${evidence.downloadedBytes};`
        + ` ecologyDispatches=${evidence.actualEcologyDispatches}; kernelDispatches=${evidence.actualKernelDispatches}`);
    });
}
