import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tile } from '../src/shared/types.js';
import { exactJsonNumber, stringifyExact } from '../src/shared/exact-json.js';
import { encodeSnapshotTileRows, SNAPSHOT_TILE_FIELDS } from '../src/server/snapshot.js';
import { Store } from '../src/server/store.js';
import { bindWorldContext, createWorld, worldContext } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { activate } from '../src/world/spatial.js';
import { ResidentTopologyOwner, residentBackingArray, residentTopologyToken } from '../src/world/soa/topologia.js';
import { residentFastAccess, TileStore } from '../src/world/soa/terreno.js';

const exact = (_key: string, value: unknown): unknown =>
  typeof value === 'number' && value === 0 && 1 / value < 0 ? exactJsonNumber(value) : value;
const genericJSON = (value: unknown): string => JSON.stringify(value, exact);

/** Previous 8 ms scan, retained only as the synthetic metadata benchmark control. */
function previousStringify(value: unknown): string {
  if (typeof value === 'number') return Object.is(value, -0) ? genericJSON(value) : JSON.stringify(value);
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  const stack: object[] = [value];
  let visits = 0, started = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (++visits === 512) started = performance.now();
    else if (started !== 0 && visits % 512 === 0 && performance.now() - started > 8) return genericJSON(value);
    if (typeof (current as { toJSON?: unknown }).toJSON === 'function') return genericJSON(value);
    if (Array.isArray(current)) {
      for (let i = 0; i < current.length; i++) {
        const v: unknown = current[i];
        if (typeof v === 'number') { if (Object.is(v, -0)) return genericJSON(value); }
        else if (typeof v === 'object' && v !== null) stack.push(v);
      }
    } else {
      const record = current as Record<string, unknown>;
      for (const key in record) {
        const v = record[key];
        if (typeof v === 'number') { if (Object.is(v, -0)) return genericJSON(value); }
        else if (typeof v === 'object' && v !== null) stack.push(v);
      }
    }
  }
  return JSON.stringify(value);
}

/** Independent historical tuple writer, including its validation/error order. */
function genericRows(tiles: readonly Tile[], offset = 0, count = tiles.length - offset): unknown[][] {
  const rows: unknown[][] = new Array(count);
  for (let n = 0; n < count; n++) {
    const t = tiles[offset + n]!;
    const row: unknown[] = [t.x,t.y,t.terrain,t.moisture,t.vegetation,t.food,t.biome,t.elevation,t.wood,t.stone,t.feature,t.variety,t.growth,t.fertility,t.cultivation,t.traffic,t.drinkingWater,t.species,t.fauna,t.life,t.paved];
    for (let i = 0; i < row.length; i++) {
      const value = row[i];
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
          if (i < 6 && i !== 2) throw new Error('Invalid required numeric tile value. Snapshot was not written.');
          if (i >= 6) throw new Error('Invalid optional tile value. Snapshot was not written.');
        } else if (Object.is(value, -0)) row[i] = exactJsonNumber(value);
      } else if (i < 6 && i !== 2) throw new Error('Invalid required numeric tile value. Snapshot was not written.');
      else if (i >= 6 && value === null) throw new Error('Invalid optional tile value. Snapshot was not written.');
    }
    rows[n] = row;
  }
  return rows;
}
function tile(x = 0, y = 0): Tile {
  return { x, y, terrain: 'meadow', moisture: 0.11, vegetation: 0.12, food: 0.13,
    biome: 'forest', elevation: 0.14, wood: 1.5, stone: 2.5, feature: 'spring', variety: 0.15,
    growth: 0.16, fertility: 0.17, cultivation: 0.18, traffic: 0.19, drinkingWater: 0.21,
    species: 'deer', fauna: 4, life: 0.22 };
}
function resident(source: Tile[]) {
  const owner = new ResidentTopologyOwner(), tiles = owner.tiles(source.map(t => owner.tile(t)));
  const soa = new TileStore();
  soa.prepareParallel(tiles);
  assert.ok(residentTopologyToken(tiles));
  assert.ok(residentFastAccess(tiles));
  return { owner, tiles, soa };
}
function parity(tiles: Tile[], offset = 0, count = tiles.length - offset): void {
  assert.equal(JSON.stringify(encodeSnapshotTileRows(tiles, offset, count)), JSON.stringify(genericRows(tiles, offset, count)));
}

test('V18: resident tuples preserve every scalar, optional absence and signed zero', () => {
  const complete = tile(), omitted: Tile = { x: 1, y: 0, terrain: 'soil', moisture: -0, vegetation: 0, food: 0 };
  const undefinedKeys = { ...tile(2), wood: undefined, biome: undefined, feature: undefined, life: undefined,
    species: undefined, fauna: undefined };
  const signed = tile(3);
  for (const key of SNAPSHOT_TILE_FIELDS) if (typeof signed[key] === 'number' && key !== 'x')
    (signed as unknown as Record<string, unknown>)[key] = -0;
  const { tiles } = resident([complete, omitted, undefinedKeys, signed]);
  parity(tiles);
  parity(tiles, 1, 2);
  assert.equal(JSON.stringify(encodeSnapshotTileRows(tiles)), genericJSON(genericRows(tiles)));
  const parsed = JSON.parse(JSON.stringify(encodeSnapshotTileRows(tiles))) as unknown[][];
  assert.ok(Object.is(parsed[3]![19], -0));
  assert.equal(parsed[1]![17], null);
  assert.equal(parsed[0]![17], 'deer');
  assert.equal(parsed[0]![18], 4);
});

test('V18: custom order, extras and tile.toJSON retain the historical tuple projection', () => {
  let calls = 0;
  const custom = Object.fromEntries(Object.entries(tile()).reverse()) as unknown as Tile;
  Object.assign(custom, { extra: -0, toJSON() { calls++; return { custom: -0 }; } });
  const { tiles } = resident([custom]);
  parity(tiles);
  assert.equal(calls, 0, 'the tuple codec has never called tile.toJSON');
  const ordinary = { z: 2, ...custom, absent: undefined, a: -0 };
  assert.equal(stringifyExact(ordinary), genericJSON(ordinary));
});

test('V18: mixed bound/new chunks and reordered resident arrays use binding identity', () => {
  const world = createWorld(42), owner = new ResidentTopologyOwner();
  world.tiles = owner.tiles(world.tiles.map(t => owner.tile(t)));
  bindWorldContext(world, { ...worldContext(world), tileOwnership: owner });
  const soa = new TileStore(); soa.prepareParallel(world.tiles);
  const before = world.tiles.length;
  activate(world, 160, 0);
  assert.ok(world.tiles.length > before);
  const fast = residentFastAccess(world.tiles)!;
  assert.ok(fast);
  assert.ok(fast.cellOf(world.tiles[0]!) >= 0);
  assert.equal(fast.cellOf(world.tiles.at(-1)!), -1);
  parity(world.tiles);
  const reordered = owner.tiles([...residentBackingArray(world.tiles)].reverse());
  parity(reordered);
});

test('V18: reflection, custom getters and busy stores fall back with the same values/errors', () => {
  for (const mutate of [
    (t: Tile) => Object.defineProperty(t, 'food', { value: -0, enumerable: false }),
    (t: Tile) => Object.defineProperty(t, 'wood', { get: () => -0, configurable: true }),
    (t: Tile) => { delete t.feature; },
    (t: Tile) => Object.setPrototypeOf(t, { wood: -0 }),
    (t: Tile) => Object.defineProperty(t, 'species', { get: () => 'hare' }),
  ]) {
    const { tiles } = resident([tile()]);
    mutate(tiles[0]!);
    parity(tiles);
  }
  const { tiles, soa } = resident([tile()]);
  soa.beginParallel();
  try { assert.equal(residentFastAccess(tiles), undefined); parity(tiles); }
  finally { soa.abortParallel(); }
  const publicTiles = resident([tile()]).tiles;
  const expected = publicTiles[0]!;
  Object.defineProperty(publicTiles, '0', { configurable: true, get() {
    assert.equal(this, publicTiles, 'array getters keep their original receiver');
    return expected;
  } });
  assert.equal(residentTopologyToken(publicTiles), undefined);
  parity(publicTiles);
});

test('V18: NaN/Infinity/null rejection matches the generic writer, including error precedence', () => {
  for (const key of SNAPSHOT_TILE_FIELDS.filter(k => typeof tile()[k] === 'number')) {
    for (const invalid of [NaN, Infinity, -Infinity, null]) {
      const { tiles } = resident([tile()]);
      // defineProperty permits invalid values without the resident setter itself rejecting them.
      Object.defineProperty(tiles[0], key, { value: invalid, writable: true, enumerable: true, configurable: true });
      let expected: Error | undefined;
      try { genericRows(tiles); } catch (error) { expected = error as Error; }
      assert.ok(expected, `${key}=${invalid} rejected by baseline`);
      assert.throws(() => encodeSnapshotTileRows(tiles), { name: expected.name, message: expected.message });
    }
  }
  for (const key of ['food', 'wood', 'life'] as const) {
    const { tiles } = resident([tile()]);
    tiles[0]![key] = Infinity;
    assert.ok(residentFastAccess(tiles), 'Infinity must be rejected by the fast writer too');
    assert.throws(() => encodeSnapshotTileRows(tiles), { message: key === 'food'
      ? 'Invalid required numeric tile value. Snapshot was not written.'
      : 'Invalid optional tile value. Snapshot was not written.' });
  }
});

test('V18: exact JSON preserves legacy getters, toJSON, proxies, cycles and unusual prototypes', () => {
  let reads = 0;
  const value = { get signed() { reads++; return reads === 1 ? -0 : 1; } };
  assert.equal(stringifyExact(value), '{"signed":1}');
  assert.equal(reads, 2, 'preserve the historical scan read followed by the serializer read');
  const cases: unknown[] = [
    { toJSON() { return { signed: -0 }; } },
    { get toJSON() { return () => -0; } },
    new Proxy({ signed: 0 }, { get(target, key) { return key === 'signed' ? -0 : Reflect.get(target, key); } }),
    Object.assign(Object.create({ inherited: -0 }), { b: 2, a: -0 }),
    Object.assign(Object.create(null), { b: 2, a: -0 }),
    { values: [NaN, Infinity, -Infinity, -0, undefined], absent: undefined },
    { boxed: new Number(-0), date: new Date(0) },
    Object.assign(() => {}, { toJSON: () => -0 }),
    { a: { value: 1 }, b: undefined },
    [, -0],
  ];
  for (const current of cases) assert.equal(stringifyExact(current), previousStringify(current));
  const shared = { ordinary: 1 };
  assert.equal(stringifyExact([shared, shared]), genericJSON([shared, shared]));
  const cycle: unknown[] = []; cycle.push(cycle);
  assert.throws(() => stringifyExact(cycle), { name: 'TypeError', message: (() => {
    try { genericJSON(cycle); } catch (error) { return (error as Error).message; }
    throw new Error('baseline must reject cycle');
  })() });
  assert.throws(() => stringifyExact({ large: 1n }), TypeError);
});

for (const snapshotInlineTileLimit of [0, 32768]) {
  test(`V18: Store.save/load byte parity and warm round-trip (inline limit ${snapshotInlineTileLimit})`, t => {
    const directory = mkdtempSync(join(tmpdir(), 'atlas-v18-save-'));
    const path = join(directory, 'resident.sqlite'), control = new Store(join(directory, 'plain.sqlite'), { snapshotInlineTileLimit });
    let store = new Store(path, { snapshotInlineTileLimit });
    t.after(() => { store.close(); control.close(); rmSync(directory, { recursive: true, force: true }); });
    const world = createWorld(42), owner = new ResidentTopologyOwner();
    world.tiles[0]!.food = -0; world.people[0]!.inventory = -0;
    const plain = createWorld(42); plain.tiles[0]!.food = -0; plain.people[0]!.inventory = -0;
    world.tiles = owner.tiles(world.tiles.map(t => owner.tile(t)));
    bindWorldContext(world, { ...worldContext(world), tileOwnership: owner });
    const soa = new TileStore(); soa.prepareParallel(world.tiles);
    for (let round = 0; round < 3; round++) {
      if (round === 2) { activate(world, 160, 0); activate(plain, 160, 0); }
      store.save(world); control.save(plain);
      const bytes = (s: Store) => s.db.prepare('SELECT body,digest FROM snapshots ORDER BY slot').all();
      assert.deepEqual(bytes(store), bytes(control));
      assert.deepEqual(store.db.prepare('SELECT * FROM snapshot_parts ORDER BY digest').all(),
        control.db.prepare('SELECT * FROM snapshot_parts ORDER BY digest').all());
    }
    const digest = digestoCanonico(world);
    store.close(); store = new Store(path, { snapshotInlineTileLimit });
    const loaded = store.load()!.world;
    assert.equal(digestoCanonico(loaded), digest);
    assert.ok(Object.is(loaded.tiles[0]!.food, -0));
    assert.ok(Object.is(loaded.people[0]!.inventory, -0));
  });
}

/** Opt-in, no timing gate: run V18_SAVE_BENCH=1 with this test file in isolation. */
test('V18: synthetic 440064-tile / 30 MB metadata benchmark', { skip: !process.env.V18_SAVE_BENCH }, t => {
  const source = Array.from({ length: 440064 }, (_, i) => tile(i % 1024, Math.floor(i / 1024)));
  const { tiles } = resident(source);
  const metadata = { tiles: null, people: Array.from({ length: 5000 }, (_, i) => ({ id: i,
    memories: Array.from({ length: 120 }, (_, j) => ({ tick: j, x: i, y: j, emotion: 0, salience: 1 })) })) };
  const median = (times: number[]) => times.sort((a, b) => a - b)[times.length >> 1]!;
  function bench(label: string, before: () => string, after: () => string): void {
    assert.equal(after(), before(), `${label} bytes`);
    const oldTimes: number[] = [], newTimes: number[] = [];
    for (let round = 0; round < 3; round++) {
      for (const [write, samples] of round % 2 ? [[after, newTimes], [before, oldTimes]] as const
        : [[before, oldTimes], [after, newTimes]] as const) {
        const start = performance.now(); write(); samples.push(performance.now() - start);
      }
    }
    const oldMs = median(oldTimes), newMs = median(newTimes);
    t.diagnostic(`${label}: ${oldMs.toFixed(2)} -> ${newMs.toFixed(2)} ms, ${(oldMs / newMs).toFixed(2)}x`);
  }
  const oldEncoding: number[] = [], newEncoding: number[] = [];
  for (let round = 0; round < 4; round++) {
    const start = performance.now(); genericRows(tiles);
    const middle = performance.now(); encodeSnapshotTileRows(tiles);
    const end = performance.now();
    if (round) { oldEncoding.push(middle - start); newEncoding.push(end - middle); }
  }
  t.diagnostic(`440064 resident tiles (encode only): ${median(oldEncoding).toFixed(2)} -> ${median(newEncoding).toFixed(2)} ms, `
    + `${(median(oldEncoding) / median(newEncoding)).toFixed(2)}x`);
  bench('440064 resident tiles (encode + JSON)', () => JSON.stringify(genericRows(tiles)), () => JSON.stringify(encodeSnapshotTileRows(tiles)));
  t.diagnostic(`metadata bytes: ${Buffer.byteLength(JSON.stringify(metadata))}`);
  bench('metadata (previous 8 ms scan vs optimized scan)', () => previousStringify(metadata), () => stringifyExact(metadata));
  const original = JSON.stringify;
  let replacerUsed = false;
  JSON.stringify = ((value: unknown, replacer?: never, space?: string | number) => {
    replacerUsed ||= replacer !== undefined;
    return original(value, replacer, space);
  }) as typeof JSON.stringify;
  try { stringifyExact(metadata); }
  finally { JSON.stringify = original; }
  t.diagnostic(`metadata completed native fast path: ${!replacerUsed}`);
});
