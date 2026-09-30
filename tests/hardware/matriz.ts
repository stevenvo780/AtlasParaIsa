import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { assertWorld, stepWorld, type World, type WorldContext } from '../../src/world/index.js';
import { paramsOf, setParams } from '../../src/world/params.js';
import { buildHardwareScene, type HardwareSceneName } from './escenas.js';
import { HardwareTileChanges, type HardwareTrackedCapture } from './cambios.js';
import { assertPhysicalDispatch, finalCanonicalDigest, firstHashDisagreement, locateDifference,
  normalizedCopy, snapshotBarrier, throwDifference, type BarrierSnapshot, type HardwareBarrier } from './contrato.js';

export const CPU_BACKENDS = [1, 2, 4, 8, 28, 'adversarial'] as const;
export type CpuBackend = typeof CPU_BACKENDS[number];
const ADVERSARIAL_WORKERS = [2, 4, 8, 28] as const;
/** Unlike (tick%4), this changes also between consecutive ecological ticks 10 apart. */
export function adversarialWorkerCount(tick: number): number {
  return ADVERSARIAL_WORKERS[(tick + Math.floor(tick / 10)) % ADVERSARIAL_WORKERS.length]!;
}

interface Milestone { digest: string; world: World; }
export interface ReferenceTrace {
  seed: number;
  scene: HardwareSceneName;
  steps: number;
  startTick: number;
  barriers: BarrierSnapshot[];
  milestones: Map<number, Milestone>;
  elapsedMs: number;
  topologyScannedTiles: number;
  fullRefreshes: number;
  globalCaptures: number;
  logicalTileChanges: number;
  updatedPages: number;
}
interface CaptureCosts {
  topologyScannedTiles: number; fullRefreshes: number; globalCaptures: number;
  logicalTileChanges: number; updatedPages: number;
}
function countCapture(costs: CaptureCosts, capture: HardwareTrackedCapture): void {
  costs.topologyScannedTiles += capture.digest.topologyScannedTiles;
  if (capture.fullRefresh) costs.fullRefreshes++;
  costs.globalCaptures++; costs.logicalTileChanges += capture.changedTiles;
  costs.updatedPages += capture.digest.updatedPages;
}
function selectors(world: World, backend: CpuBackend, tick: number): void {
  const params = structuredClone(paramsOf(world));
  params.motor.hilos = backend === 'adversarial' ? adversarialWorkerCount(tick) : backend;
  params.motor.orden = backend === 'adversarial' ? 'adversarial' : 'natural';
  params.motor.gpu = []; params.motor.soaTerreno = false;
  setParams(world, params);
}
const isMilestone = (step: number, steps: number) => step === steps || step === 1200 || step === 2400;

/** One serial trajectory per seed/scene, reused by all twelve CPU/geometry candidates.
 * The maps are copied only for the small historical reference; candidates use live hash views. */
export function captureReference(seed: number, scene: HardwareSceneName, steps: number): ReferenceTrace {
  const started = performance.now(), fixture = buildHardwareScene(seed, scene), world = fixture.world;
  const trace: ReferenceTrace = { seed, scene, steps, startTick: world.tick, barriers: [], milestones: new Map(),
    elapsedMs: 0, topologyScannedTiles: 0, fullRefreshes: 0, globalCaptures: 0,
    logicalTileChanges: 0, updatedPages: 0 };
  let actualEcologyBarriers = 0, actualKernelBarriers = 0;
  let nextPhase: HardwareBarrier['phase'] = 'ecologia';
  const tracker = new HardwareTileChanges(world);
  selectors(world, 1, world.tick + 1);
  // Capture once before the first real barrier; never copy or canonicalize World per barrier.
  countCapture(trace, tracker.capture());
  const context: WorldContext = { ecologyExecution: { regionSide: 256, onBarrier(event: HardwareBarrier) {
    assert.equal(event.phase, nextPhase);
    nextPhase = event.phase === 'ecologia' ? 'kernel' : 'ecologia';
    assert.equal(event.regionSide, 256); assert.equal(event.orden, 'natural');
    assert.equal(event.workers, 1);
    assert.equal(event.tick % 10, 0);
    if (event.phase === 'ecologia') actualEcologyBarriers++; else actualKernelBarriers++;
    assert.equal(event.diagnostics, null, 'The reference physically uses the old serial path.');
    const capture = tracker.capture(event.dirtyPages);
    countCapture(trace, capture);
    trace.barriers.push(snapshotBarrier(event, capture.digest));
  } } };
  for (let step = 1; step <= steps; step++) {
    stepWorld(world, [], context); fixture.afterStep(step);
    // World.step's ordered body/totals transitions also matter on the nine non-ecology ticks.
    assert.equal(nextPhase, 'ecologia', 'Both ordered ecology phases complete before body-step capture.');
    // Every owned setter/delete/define is drained, including non-SoA fields and body/fauna writes.
    // Generic/raw/getter trajectories retain the conservative full-refresh fallback.
    const capture = tracker.capture();
    countCapture(trace, capture);
    trace.barriers.push(snapshotBarrier({ tick: world.tick, phase: 'fin-paso' }, capture.digest));
    if (isMilestone(step, steps)) trace.milestones.set(step, { digest: finalCanonicalDigest(world), world: normalizedCopy(world) });
  }
  fixture.assertWitness(); assertWorld(world);
  const expectedEcologyTicks = Math.floor((trace.startTick + steps) / 10) - Math.floor(trace.startTick / 10);
  assert.equal(actualEcologyBarriers, expectedEcologyTicks);
  assert.equal(actualKernelBarriers, expectedEcologyTicks);
  assert.equal(trace.barriers.length, steps + 2 * expectedEcologyTicks);
  trace.elapsedMs = performance.now() - started;
  return trace;
}

/** Reconstruct only the failing serial boundary. It is never paid during a passing run. */
function referenceAt(trace: ReferenceTrace, boundary: Pick<BarrierSnapshot, 'tick' | 'phase'>): World {
  const fixture = buildHardwareScene(trace.seed, trace.scene), world = fixture.world;
  selectors(world, 1, world.tick + 1);
  const stop = new Error('captured-reference-boundary');
  const context: WorldContext = { ecologyExecution: { regionSide: 256, onBarrier(event: HardwareBarrier) {
    if (event.tick === boundary.tick && event.phase === boundary.phase) throw stop;
  } } };
  try {
    while (world.tick < boundary.tick) {
      stepWorld(world, [], context);
      if (world.tick === boundary.tick && boundary.phase === 'fin-paso') return world;
    }
  } catch (error) { if (error === stop) return world; throw error; }
  throw new Error(`Missing reference barrier ${boundary.tick}/${boundary.phase}`);
}

export interface CandidateEvidence {
  elapsedMs: number;
  actualKernelDispatches: number;
  actualEcologyDispatches: number;
  workerCounts: number[];
  delayCount: number;
  multiRegionQueues: number;
  topologyScannedTiles: number;
  fullRefreshes: number;
  globalCaptures: number;
  logicalTileChanges: number;
  updatedPages: number;
}
export interface CandidateFaultInjection {
  /** Private negative tests only: inject after real actions and before the exact step-end check. */
  afterStep?: (world: World, step: number) => void;
}
export function compareCandidate(trace: ReferenceTrace, regionSide: 256 | 512, backend: CpuBackend,
  fault?: CandidateFaultInjection): CandidateEvidence {
  const started = performance.now(), fixture = buildHardwareScene(trace.seed, trace.scene), world = fixture.world;
  const evidence: CandidateEvidence = { elapsedMs: 0, actualKernelDispatches: 0, actualEcologyDispatches: 0,
    workerCounts: [], delayCount: 0, multiRegionQueues: 0, topologyScannedTiles: 0, fullRefreshes: 0,
    globalCaptures: 0, logicalTileChanges: 0, updatedPages: 0 };
  const actualCounts = new Set<number>();
  const firstRegionCount = new Set(world.tiles.map(tile =>
    `${Math.floor(tile.x / regionSide)},${Math.floor(tile.y / regionSide)}`)).size;
  let cursor = 0, actualEcologyTicks = 0;
  let previousWorkers: number | undefined, previousDispatchWorkers: number | undefined;
  let nextPhase: HardwareBarrier['phase'] = 'ecologia';
  let pendingEcology: { tick: number; workers: number; diagnostics: NonNullable<HardwareBarrier['diagnostics']> } | undefined;
  const tracker = new HardwareTileChanges(world);
  selectors(world, backend, world.tick + 1); countCapture(evidence, tracker.capture());
  const compare = (boundary: Pick<BarrierSnapshot, 'tick' | 'phase'>, dirtyPages: HardwareBarrier['dirtyPages'], forceFull = false) => {
    const expected = trace.barriers[cursor++];
    assert.ok(expected, 'No extra or fabricated barriers are accepted.');
    assert.equal(boundary.tick, expected.tick); assert.equal(boundary.phase, expected.phase);
    const capture = tracker.capture(dirtyPages, forceFull);
    countCapture(evidence, capture);
    const page = firstHashDisagreement(expected, capture.digest);
    if (page !== null) throwDifference(locateDifference(referenceAt(trace, boundary), world, boundary, page));
  };
  const context: WorldContext = { ecologyExecution: { regionSide, onBarrier(event: HardwareBarrier) {
    assert.equal(event.phase, nextPhase);
    nextPhase = event.phase === 'ecologia' ? 'kernel' : 'ecologia';
    assert.equal(event.regionSide, regionSide, 'The actual kernel must honor the requested physical geometry.');
    assert.equal(event.orden, backend === 'adversarial' ? 'adversarial' : 'natural');
    assert.equal(event.tick % 10, 0, 'Only actual ecology barriers are counted.');
    if (event.phase === 'ecologia') actualEcologyTicks++;
    const workers = paramsOf(world).motor.hilos;
    if (workers > 1) {
      const physical = assertPhysicalDispatch(event, workers), diagnostics = event.diagnostics!;
      if (event.phase === 'ecologia') {
        assert.equal(pendingEcology, undefined);
        if (backend === 'adversarial' && evidence.actualEcologyDispatches === 0) {
          const invokedRegions = event.diagnostics!.regionOrder.reduce((sum, ids) => sum + ids.length, 0);
          assert.equal(invokedRegions, firstRegionCount,
            'Physical handler invocations must match the requested geometry, not an event label.');
        }
        if (backend === 'adversarial' && previousDispatchWorkers !== undefined) {
          assert.notEqual(workers, previousDispatchWorkers, 'Consecutive physical ecological dispatches must use different worker counts.');
        }
        pendingEcology = { tick: event.tick, workers, diagnostics };
        evidence.actualEcologyDispatches++;
      } else {
        assert.ok(pendingEcology, 'A real first-pass dispatch must precede the life kernel.');
        assert.equal(pendingEcology.tick, event.tick); assert.equal(pendingEcology.workers, workers);
        assert.deepEqual(diagnostics.threadIds, pendingEcology.diagnostics.threadIds, 'Both passes use the same physical pool.');
        assert.equal(diagnostics.supervisorThreadId, pendingEcology.diagnostics.supervisorThreadId);
        assert.equal(diagnostics.dispatches, pendingEcology.diagnostics.dispatches + 1, 'The second barrier completes one real subsequent dispatch.');
        assert.deepEqual(diagnostics.regionOrder, pendingEcology.diagnostics.regionOrder);
        evidence.actualKernelDispatches++; previousDispatchWorkers = workers; pendingEcology = undefined;
      }
      actualCounts.add(workers);
      evidence.delayCount += physical.delays; evidence.multiRegionQueues += physical.multiRegionQueues;
    } else {
      assert.equal(event.workers, 1);
      assert.equal(event.diagnostics, null, 'hilos1 must use the original serial algorithm.');
    }
    // SAB writes bypass Proxy traps, so their real mask is mandatory in parallel captures.
    compare(event, event.dirtyPages, workers > 1 && event.dirtyPages === undefined);
  } } };
  for (let step = 1; step <= trace.steps; step++) {
    // selectors() installed a private params object before this loop. Change only the admitted
    // worker selector each tick; avoid cloning every unchanged law on every candidate tick.
    paramsOf(world).motor.hilos = backend === 'adversarial' ? adversarialWorkerCount(world.tick + 1) : backend;
    const workers = paramsOf(world).motor.hilos;
    if (backend === 'adversarial' && previousWorkers !== undefined) assert.notEqual(workers, previousWorkers);
    previousWorkers = workers;
    stepWorld(world, [], context); fixture.afterStep(step);
    assert.equal(nextPhase, 'ecologia'); assert.equal(pendingEcology, undefined);
    fault?.afterStep?.(world, step);
    compare({ tick: world.tick, phase: 'fin-paso' }, undefined);
    if (isMilestone(step, trace.steps)) {
      const expected = trace.milestones.get(step)!;
      if (finalCanonicalDigest(world) !== expected.digest) throwDifference(locateDifference(expected.world, world,
        { tick: world.tick, phase: 'fin-paso' }));
    }
  }
  fixture.assertWitness(); assertWorld(world);
  assert.equal(cursor, trace.barriers.length);
  const expectedEcologyTicks = Math.floor((trace.startTick + trace.steps) / 10) - Math.floor(trace.startTick / 10);
  assert.equal(actualEcologyTicks, expectedEcologyTicks, 'Every actual first-pass ecology barrier is observed.');
  assert.equal(evidence.actualKernelDispatches, backend === 1 ? 0 : expectedEcologyTicks);
  assert.equal(evidence.actualEcologyDispatches, backend === 1 ? 0 : expectedEcologyTicks);
  if (backend === 'adversarial') {
    assert.deepEqual([...actualCounts].sort((a, b) => a - b), [2, 4, 8, 28]);
    if (trace.scene === 'dispersas') assert.ok(evidence.delayCount > 0 && evidence.multiRegionQueues > 0,
      'Sparse scenes must actually reverse a multi-region queue and wait on a real clock.');
  } else if (backend > 1) assert.deepEqual([...actualCounts], [backend]);
  evidence.workerCounts = [...actualCounts].sort((a, b) => a - b);
  evidence.elapsedMs = performance.now() - started;
  return evidence;
}
