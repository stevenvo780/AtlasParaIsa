import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneWorld, createWorld, type World } from '../src/world/index.js';
import { IncrementalRegionHasher, diferenciaCanonica, digestoCanonico, type RegionHashCapture } from '../src/world/digesto.js';
import { paramsOf, setParams } from '../src/world/params.js';
import { recordChronicleEvent } from '../src/world/chronicle-journal.js';
import { generateChunk } from '../src/world/terrain.js';

function smallWorld(points: readonly (readonly [number, number])[] = [[0, 0], [1, 0], [16, 0], [256, 0]]): World {
  const world = createWorld(7), sample = world.tiles[0]!;
  world.tiles = points.map(([x, y]) => ({ ...sample, x, y }));
  return world;
}
function snapshot(capture: RegionHashCapture) {
  return { pageHashes: new Map(capture.pageHashes), regionHashes: new Map(capture.regionHashes), globalHash: capture.globalHash };
}
function equalCapture(left: RegionHashCapture, right: RegionHashCapture): void {
  assert.deepEqual(left.pageHashes, right.pageHashes);
  assert.deepEqual(left.regionHashes, right.regionHashes);
  assert.equal(left.globalHash, right.globalHash);
}

test('dirty mask visits only touched page values under a topology certificate', () => {
  const world = smallWorld(), reads = [0, 0, 0, 0];
  for (let i = 0; i < world.tiles.length; i++) {
    let food = world.tiles[i]!.food;
    Object.defineProperty(world.tiles[i]!, 'food', { enumerable: true, configurable: true,
      get: () => { reads[i]++; return food; }, set: value => { food = value; } });
  }
  const hasher = new IncrementalRegionHasher(256, { topologyOf: w => ({ tiles: w.tiles, revision: 0 }) });
  const initial = snapshot(hasher.update(world)); reads.fill(0);
  world.tiles[0]!.food += 0.25; reads.fill(0);
  const capture = hasher.update(world, [{ pageX: 0, pageY: 0 }, { pageX: 0, pageY: 0 }, { pageX: 999, pageY: 999 }]);
  assert.deepEqual(reads, [1, 1, 0, 0]);
  assert.equal(capture.updatedPages, 1); assert.equal(capture.rebuiltTopology, false);
  assert.equal(capture.topologyScannedTiles, 0);
  assert.deepEqual(capture.changedPages, ['0,0']); assert.deepEqual(capture.changedRegions, ['0,0']);
  assert.equal(capture.pageHashes.get('1,0'), initial.pageHashes.get('1,0'));
  assert.equal(capture.regionHashes.get('1,0'), initial.regionHashes.get('1,0'));
  equalCapture(capture, new IncrementalRegionHasher(256).update(world));
});

test('empty masks hash all globals without reading active Tile values or copying live maps', () => {
  const world = smallWorld(), hasher = new IncrementalRegionHasher(256, { topologyOf: w => ({ tiles: w.tiles, revision: 0 }) });
  const initial = hasher.update(world), pages = new Map(initial.pageHashes);
  for (const tile of world.tiles) Object.defineProperty(tile, 'food', {
    enumerable: true, configurable: true, get: () => { throw new Error('Untouched Tile read'); } });
  world.totals.testHarvest = 1;
  const capture = hasher.update(world, []);
  assert.equal(capture.updatedPages, 0); assert.equal(capture.topologyScannedTiles, 0);
  assert.equal(capture.pageHashes, initial.pageHashes); assert.equal(capture.regionHashes, initial.regionHashes);
  assert.deepEqual(capture.pageHashes, pages); assert.notEqual(capture.globalHash, initial.globalHash);
  assert.deepEqual(capture.changedPages, []); assert.deepEqual(capture.changedRegions, []);
});

test('same-value dirty pages do not rehash their unchanged regions', () => {
  const world = smallWorld(), hasher = new IncrementalRegionHasher(256);
  const initial = snapshot(hasher.update(world));
  const capture = hasher.update(world, [{ pageX: 1, pageY: 0 }]);
  assert.equal(capture.updatedPages, 1); assert.equal(capture.topologyScannedTiles, world.tiles.length);
  assert.equal(capture.rebuiltTopology, false);
  assert.deepEqual(capture.changedPages, []); assert.deepEqual(capture.changedRegions, []);
  assert.deepEqual(snapshot(capture), initial);
});

test('undefined refreshes all page values even when a dirty mask was incomplete', () => {
  const world = smallWorld(), hasher = new IncrementalRegionHasher(512);
  const initial = snapshot(hasher.update(world)); world.tiles[2]!.food += 0.5;
  assert.deepEqual(hasher.update(world, []).pageHashes, initial.pageHashes);
  const refresh = hasher.update(world);
  assert.equal(refresh.rebuiltTopology, true); assert.equal(refresh.updatedPages, 3);
  assert.deepEqual(refresh.changedPages, ['1,0']);
  equalCapture(refresh, new IncrementalRegionHasher(512).update(world));
});

test('uncertified topology detects same-length order, replacement, coordinate, clone, append and prune edits', () => {
  const world = smallWorld(), hasher = new IncrementalRegionHasher(256);
  hasher.update(world);
  const mutate = (operation: () => void): RegionHashCapture => {
    operation(); const capture = hasher.update(world, []);
    assert.equal(capture.rebuiltTopology, true);
    assert.ok(capture.topologyScannedTiles > 0);
    equalCapture(capture, new IncrementalRegionHasher(256).update(world));
    return capture;
  };
  mutate(() => { world.tiles.reverse(); });
  mutate(() => { world.tiles[0] = { ...world.tiles[0]!, food: world.tiles[0]!.food + 1 }; });
  mutate(() => { world.tiles[0]!.x = -257; });
  mutate(() => { world.tiles.push({ ...world.tiles[0]!, x: 1024 }); });
  const pruned = mutate(() => { world.tiles.pop(); });
  assert.ok(pruned.changedPages.includes('64,0')); assert.ok(pruned.changedRegions.includes('4,0'));
  assert.equal(pruned.pageHashes.has('64,0'), false); assert.equal(pruned.regionHashes.has('4,0'), false);
  const cloned = cloneWorld(world), capture = hasher.update(cloned, []);
  assert.equal(capture.rebuiltTopology, true);
  equalCapture(capture, new IncrementalRegionHasher(256).update(cloned));
});

test('certificate revision invalidates in-place topology and incorrect array certificates fail explicitly', () => {
  const world = smallWorld(); let revision = 0;
  const hasher = new IncrementalRegionHasher(256, { topologyOf: w => ({ tiles: w.tiles, revision }) });
  hasher.update(world); world.tiles.reverse(); revision++;
  const capture = hasher.update(world, []);
  assert.equal(capture.rebuiltTopology, true); assert.equal(capture.topologyScannedTiles, world.tiles.length);
  equalCapture(capture, new IncrementalRegionHasher(256).update(world));
  const wrong = new IncrementalRegionHasher(256, { topologyOf: () => ({ tiles: [], revision: 0 }) });
  assert.throws(() => wrong.update(world), /different Tile array/);
});

test('signed zero, own optional-key presence and extra keys all change page hashes', () => {
  const world = smallWorld([[0, 0]]), tile = world.tiles[0]!, hasher = new IncrementalRegionHasher(256);
  delete tile.life; const absent = hasher.update(world).pageHashes.get('0,0');
  tile.life = undefined; const undefinedValue = hasher.update(world, [{ pageX: 0, pageY: 0 }]).pageHashes.get('0,0');
  assert.notEqual(absent, undefinedValue);
  tile.life = 0; const positive = hasher.update(world, [{ pageX: 0, pageY: 0 }]).pageHashes.get('0,0');
  tile.life = -0; const negative = hasher.update(world, [{ pageX: 0, pageY: 0 }]).pageHashes.get('0,0');
  assert.notEqual(undefinedValue, positive); assert.notEqual(positive, negative);
  Object.assign(tile, { testMaterial: 0 });
  assert.notEqual(negative, hasher.update(world, [{ pageX: 0, pageY: 0 }]).pageHashes.get('0,0'));
});

test('record insertion order is canonical but original Tile slots affect hashes across pages', () => {
  const a = smallWorld([[0, 0], [1, 0], [256, 0]]), b = cloneWorld(a);
  b.tiles = b.tiles.map(tile => Object.fromEntries(Object.entries(tile).reverse()) as unknown as World['tiles'][number]);
  equalCapture(new IncrementalRegionHasher(256).update(a), new IncrementalRegionHasher(256).update(b));
  const before = snapshot(new IncrementalRegionHasher(256).update(b)); b.tiles.reverse();
  const after = new IncrementalRegionHasher(256).update(b);
  assert.notDeepEqual(before.pageHashes, after.pageHashes); assert.notDeepEqual(before.regionHashes, after.regionHashes);
});

test('256/512 geometries use floor division for negative page and region coordinates', () => {
  const world = smallWorld([[-513, -1], [-512, -1], [-257, -1], [-256, -1], [-1, -1], [0, 0], [256, 0], [512, 0]]);
  const small = new IncrementalRegionHasher(256).update(world), large = new IncrementalRegionHasher(512).update(world);
  assert.deepEqual(new Set(small.pageHashes.keys()), new Set(['-33,-1', '-32,-1', '-17,-1', '-16,-1', '-1,-1', '0,0', '16,0', '32,0']));
  assert.deepEqual(new Set(small.regionHashes.keys()), new Set(['-3,-1', '-2,-1', '-1,-1', '0,0', '1,0', '2,0']));
  assert.deepEqual(new Set(large.regionHashes.keys()), new Set(['-2,-1', '-1,-1', '0,0', '1,0']));
  assert.deepEqual(small.pageHashes, large.pageHashes); assert.equal(small.globalHash, large.globalHash);
});

test('globals cover ordered people/places/history, pending chronicle, dormant tiles and scalar state', () => {
  const world = smallWorld();
  for (let i = 0; i < 2; i++) recordChronicleEvent(world, { kind: 'learning', actors: [], source: 'simulation', text: `Witness ${i}`, cause: 'Control' });
  world.retiredChunks.push(generateChunk(world.seed, 100, 100));
  const hasher = new IncrementalRegionHasher(256); let previous = hasher.update(world);
  const mutations = [() => { world.people.reverse(); }, () => { world.places.reverse(); },
    () => { world.chronicleJournal!.pending.reverse(); }, () => { world.chronicleJournal!.pending[0]!.text += ' changed'; },
    () => { world.retiredChunks[0]!.tiles[0]!.food += 1; }, () => { world.tick++; }, () => { world.rng++; }];
  for (const mutate of mutations) {
    const pages = new Map(previous.pageHashes); mutate(); const next = hasher.update(world, []);
    assert.notEqual(next.globalHash, previous.globalHash); assert.deepEqual(next.pageHashes, pages); previous = next;
  }
});

test('FP64 tree accumulation confined to totals is detected even when every Tile hash is identical', () => {
  const a = smallWorld(), b = cloneWorld(a);
  a.totals.testHarvest = (1e16 + 1) + -1e16; b.totals.testHarvest = (1e16 + -1e16) + 1;
  const left = new IncrementalRegionHasher(256).update(a), right = new IncrementalRegionHasher(256).update(b);
  assert.deepEqual(left.pageHashes, right.pageHashes); assert.deepEqual(left.regionHashes, right.regionHashes);
  assert.notEqual(left.globalHash, right.globalHash);
  assert.equal(diferenciaCanonica(a, b)!.path, '$.world.totals.testHarvest');
});

test('execution normalization changes only hilos/orden/gpu/soaTerreno and preserves all laws', () => {
  const a = smallWorld(), b = cloneWorld(a), params = structuredClone(paramsOf(b));
  params.motor.hilos = 28; params.motor.orden = 'adversarial'; params.motor.gpu = [0, 1]; params.motor.soaTerreno = true;
  setParams(b, params);
  assert.notEqual(new IncrementalRegionHasher(256).update(a).globalHash, new IncrementalRegionHasher(256).update(b).globalHash);
  const options = { normalizeExecution: true };
  const reference = new IncrementalRegionHasher(256, options).update(a), hasher = new IncrementalRegionHasher(256, options);
  equalCapture(reference, hasher.update(b));
  params.genes.tasaMutacion *= 0.5; setParams(b, params);
  assert.notEqual(reference.globalHash, hasher.update(b, []).globalHash);
  params.genes.tasaMutacion = paramsOf(a).genes.tasaMutacion;
  params.motor.clonPorPaso = !paramsOf(a).motor.clonPorPaso; setParams(b, params);
  assert.notEqual(reference.globalHash, hasher.update(b, []).globalHash);
  assert.equal(paramsOf(b).motor.hilos, 28);
});

test('incremental captures do not mutate worlds and invalid values fail rather than hash silently', () => {
  const world = smallWorld(), before = digestoCanonico(world), hasher = new IncrementalRegionHasher(256);
  hasher.update(world); hasher.update(world, [{ pageX: 0, pageY: 0 }]);
  assert.equal(digestoCanonico(world), before);
  world.tiles[0]!.food = NaN;
  assert.throws(() => hasher.update(world, [{ pageX: 0, pageY: 0 }]), /Non-finite/);
  assert.throws(() => hasher.update(world, [{ pageX: 0.5, pageY: 0 }]), /safe integers/);
  assert.throws(() => new IncrementalRegionHasher(128 as 256).update(world), /256 or 512/);
});
