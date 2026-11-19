import assert from 'node:assert/strict';
import { diferenciaCanonica, digestoCanonico, IncrementalRegionHasher,
  type RegionHashTopologyCertificate } from '../../src/world/digesto.js';
import { paramsOf, setParams } from '../../src/world/params.js';
import type { World } from '../../src/world/index.js';
import type { StaticWorkerDiagnostics } from '../../src/world/paralelo/piscina.js';

export interface HardwareBarrier {
  tick: number;
  phase: 'ecologia' | 'kernel';
  workers: number;
  dirtyPages: readonly { pageX: number; pageY: number }[] | undefined;
  diagnostics: StaticWorkerDiagnostics | null;
  topologyCertificate?: RegionHashTopologyCertificate;
  regionSide: 256 | 512;
  orden: 'natural' | 'inverso' | 'adversarial';
  gpu?: readonly number[];
  gpuStats?: { uploadedBytes: number; downloadedBytes: number } | unknown;
}
export type RegionDigest = ReturnType<IncrementalRegionHasher['update']>;
export interface BarrierSnapshot {
  tick: number;
  phase: HardwareBarrier['phase'] | 'fin-paso';
  pageHashes: Map<string, string>;
  regionHashes: Map<string, string>;
  globalHash: string;
}

/** Only the four admitted execution selectors differ. Do not normalize laws, limits,
 * population, chronology, ordering of simulation arrays, or other motor options. */
export function plainWorldCopy(world: World): World {
  // Active and pending dormant Tiles may be Proxies. Spread materializes their exact
  // enumerable keys/undefined/-0 values before structuredClone; JSON would lose them.
  return structuredClone({ ...world, tiles: world.tiles.map(tile => ({ ...tile })),
    retiredChunks: world.retiredChunks.map(chunk => ({ ...chunk,
      tiles: chunk.tiles.map(tile => ({ ...tile })) })) });
}
export function normalizedCopy(world: World): World {
  const copy = plainWorldCopy(world);
  const params = structuredClone(paramsOf(world));
  Object.assign(params.motor, { hilos: 1, orden: 'natural', gpu: [], soaTerreno: false });
  setParams(copy, params);
  return copy;
}
export const finalCanonicalDigest = (world: World): string => digestoCanonico(normalizedCopy(world));

export function snapshotBarrier(event: Pick<HardwareBarrier, 'tick' | 'phase'> | { tick: number; phase: 'fin-paso' }, digest: RegionDigest): BarrierSnapshot {
  // The hash API returns live views: historical references must copy them here, immediately.
  return { tick: event.tick, phase: event.phase, pageHashes: new Map(digest.pageHashes),
    regionHashes: new Map(digest.regionHashes), globalHash: digest.globalHash };
}
export function firstHashDisagreement(expected: BarrierSnapshot, actual: RegionDigest): string | null {
  if (expected.globalHash !== actual.globalHash) return 'global';
  for (const [page, hash] of expected.pageHashes) if (actual.pageHashes.get(page) !== hash) return page;
  for (const page of actual.pageHashes.keys()) if (!expected.pageHashes.has(page)) return page;
  for (const [region, hash] of expected.regionHashes) if (actual.regionHashes.get(region) !== hash) return `region:${region}`;
  for (const region of actual.regionHashes.keys()) if (!expected.regionHashes.has(region)) return `region:${region}`;
  return null;
}

export interface LocatedDifference {
  tick: number;
  phase: BarrierSnapshot['phase'];
  page: string;
  field: string;
  index: number | null;
  path: string;
  before: unknown;
  after: unknown;
}
/** Full canonical traversal is performed only after a hash disagreement (or final milestone).
 * The original full canonicalizer remains the independent diagnostic oracle. */
export function locateDifference(before: World, after: World, boundary: Pick<BarrierSnapshot, 'tick' | 'phase'>, changedPage = 'global'): LocatedDifference {
  const difference = diferenciaCanonica(normalizedCopy(before), normalizedCopy(after));
  assert.ok(difference, 'A reported hash disagreement must have an exact canonical difference.');
  const tile = /^\$\.world\.tiles\[(\d+)\](?:\.(.*))?$/.exec(difference.path);
  const index = tile ? Number(tile[1]) : null;
  const cell = index === null ? undefined : before.tiles[index] ?? after.tiles[index];
  return { ...boundary, page: cell ? `${Math.floor(cell.x / 16)},${Math.floor(cell.y / 16)}` : changedPage,
    field: tile ? tile[2] ?? 'tile' : difference.path.replace(/^\$\.world\./, ''), index,
    path: difference.path, before: difference.before, after: difference.after };
}
export function throwDifference(difference: LocatedDifference): never {
  throw new assert.AssertionError({ message: `T117 tick=${difference.tick} fase=${difference.phase}`
    + ` pagina=${difference.page} campo=${difference.field} indice=${difference.index ?? 'global'}`
    + ` ruta=${difference.path}; ${String(difference.before)} != ${String(difference.after)}`,
    actual: difference.after, expected: difference.before, operator: 'Object.is' });
}

export function assertPhysicalDispatch(event: HardwareBarrier, workers: number): { delays: number; multiRegionQueues: number } {
  assert.ok(event.phase === 'ecologia' || event.phase === 'kernel');
  assert.equal(event.workers, workers);
  const diagnostic = event.diagnostics;
  assert.ok(diagnostic, 'Both parallel ecology barriers require physical worker diagnostics.');
  assert.equal(diagnostic.workers, workers);
  assert.equal(diagnostic.threadIds.length, workers);
  assert.equal(new Set(diagnostic.threadIds).size, workers);
  assert.ok(diagnostic.threadIds.every(id => Number.isInteger(id) && id > 0));
  assert.ok(diagnostic.supervisorThreadId > 0);
  assert.ok(diagnostic.dispatches > 0);
  assert.equal(diagnostic.completedJobs.length, workers);
  assert.ok(diagnostic.completedJobs.every(count => count === diagnostic.dispatches), 'All real workers have completed the physical barrier, including empty queues.');
  if (event.orden === 'natural') return { delays: 0, multiRegionQueues: 0 };
  assert.equal(diagnostic.regionOrder.length, workers);
  assert.equal(diagnostic.adversarialDelayCounts.length, workers);
  assert.equal(diagnostic.adversarialDelaysMs.length, workers);
  let delays = 0, multiRegionQueues = 0;
  for (let worker = 0; worker < workers; worker++) {
    const order: (number | string)[] = diagnostic.regionOrder[worker]!;
    assert.equal(new Set(order).size, order.length, 'Every scheduled region is computed exactly once.');
    for (let i = 1; i < order.length; i++) {
      const previous = order[i - 1]!, current = order[i]!;
      assert.equal(typeof previous, typeof current);
      assert.ok(typeof previous === 'number' && typeof current === 'number'
        ? previous > current : String(previous) > String(current), 'The handler physically computes its static queue in reverse order.');
    }
    if (order.length > 1) multiRegionQueues++;
    if (event.orden === 'adversarial') {
      const count: number = diagnostic.adversarialDelayCounts[worker]!;
      const elapsed: number = diagnostic.adversarialDelaysMs[worker]!;
      assert.equal(count, Math.max(0, order.length - 1));
      assert.ok(count === 0 ? elapsed === 0 : elapsed > 0, 'Clock delays must have elapsed in the compute worker.');
      delays += count;
    }
  }
  return { delays, multiRegionQueues };
}
