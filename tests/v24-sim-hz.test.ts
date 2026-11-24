/**
 * V24 engine frequency: the publish path of the simulation worker records less without losing anything.
 * - The tile observer reports exactly the tiles whose public projection changed (ground truth: a fresh
 *   projection of every resident tile on every scan), serially and with the parallel SoA kernel.
 * - The tape writer normalizes an owned structured clone in place instead of a JSON round trip and
 *   compares structurally: same rows, byte for byte, as the copying writer.
 * - Turbo frames between live mirror posts carry the slow summaries: every tick is still on the tape,
 *   in order, and each reconstructed frame has its summaries.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { createWorld, stepWorld, type World } from '../src/world/index.js';
import { paramsOf, parseParams } from '../src/world/params.js';
import { bindWorldContext, worldContext } from '../src/world/spatial.js';
import { ResidentTopologyOwner, residentBackingArray } from '../src/world/soa/topologia.js';
import { residentFastAccess } from '../src/world/soa/terreno.js';
import { createTileObserver, projectMirrorTile, projectTapeFrame } from '../src/server/sim-worker.js';
import { TapeReader, TapeWriter, tapePathForWorld, tileEqual } from '../src/server/tape-store.js';
import { CARRIED_VIEW_FIELDS, withCarriedFields } from '../src/server/tape-worker.js';
import { cerrarPiscinasDeComputo } from '../src/server/app.js';
import { createWorkerGateway } from '../src/server/gateway.js';
import type { Tile, WorldView } from '../src/shared/types.js';

function directory(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'v24-sim-hz-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The simulation worker's own setup: resident Proxy tiles whenever the motor is parallel. */
function residentWorld(hilos: number): World {
  const world = createWorld(51926, parseParams(`motor.hilos=${hilos},motor.soaTerreno=true`));
  for (let i = 0; i < 12; i++) stepWorld(world);
  const owner = new ResidentTopologyOwner();
  world.tiles = owner.tiles(world.tiles.map(tile => owner.tile(tile)));
  bindWorldContext(world, { ...worldContext(world), tileOwnership: owner });
  return world;
}

const key = (tile: { x: number; y: number }) => `${tile.x},${tile.y}`;

for (const hilos of [1, 4]) {
  test(`tile observer (${hilos} hilo${hilos > 1 ? 's' : ''}): reports exactly the tiles whose projection changed`, async t => {
    t.after(() => cerrarPiscinasDeComputo());
    const world = residentWorld(hilos);
    assert.equal(paramsOf(world).motor.hilos, hilos);
    const observer = createTileObserver();
    const truth = () => new Map(residentBackingArray(world.tiles).map(tile => {
      const projected = projectMirrorTile(tile, residentFastAccess(world.tiles));
      return [key(projected), projected] as const;
    }));
    let previous = truth();
    const first = observer.scan(world);
    assert.equal(first.force, true);
    assert.equal(first.changed.length, previous.size, 'the first scan reports every resident tile');
    let reported = 0, scans = 0;
    for (let step = 0; step < 60; step++) {
      stepWorld(world);
      // Scan on a sparse cadence too, as the turbo publish does (several steps between two scans).
      if (step % 3 === 1) continue;
      if (step === 30) { const tile = world.tiles[5]!; tile.stone = (tile.stone ?? 0) + 0.5; }
      const current = truth();
      const observation = observer.scan(world);
      const expected = [...current].filter(([id, tile]) => !tileEqual(previous.get(id), tile)).map(([id]) => id).sort();
      assert.deepEqual(observation.changed.map(key).sort(), expected, `step ${step}: changed tiles`);
      // The cache is the projection: every chunk page equals a fresh projection, field for field.
      let cached = 0;
      for (const [chunk, tiles] of observation.chunks) for (const tile of tiles) {
        assert.equal(chunk, `${Math.floor(tile.x / 16)},${Math.floor(tile.y / 16)}`);
        assert.deepEqual(tile, current.get(key(tile)), `step ${step}: cached projection of ${key(tile)}`);
        cached++;
      }
      assert.equal(cached, current.size);
      assert.deepEqual([...observation.dirty].sort(), [...new Set(observation.changed.map(tile => `${Math.floor(tile.x / 16)},${Math.floor(tile.y / 16)}`))].sort());
      if (step === 30) assert.ok(observation.changed.some(tile => key(tile) === key(world.tiles[5]!)), 'a Proxy-held field is seen');
      reported += observation.changed.length; scans++;
      previous = current;
    }
    t.diagnostic(`${hilos} hilo(s): ${(reported / scans).toFixed(0)} of ${previous.size} tiles changed per scan`);
    // A scan with nothing written in between reports nothing and allocates no page.
    const idle = observer.scan(world);
    assert.equal(idle.changed.length, 0);
    assert.equal(idle.dirty.size, 0);
  });
}

test('tile observer: a different resident set regroups and keeps what did not change', () => {
  const world = residentWorld(1);
  const observer = createTileObserver();
  observer.scan(world);
  const before = observer.scan(world).chunks;
  // A tile object replaced by an equal copy (same coordinates, same values) is not a change.
  const raw = world.tiles[0]!;
  world.tiles[0] = { ...raw } as Tile;
  const regrouped = observer.scan(world);
  assert.notEqual(regrouped.chunks, before, 'regrouped');
  assert.equal(regrouped.changed.length, 0, 'an equal replacement is not reported');
  // A replacement with another value is.
  world.tiles[0] = { ...raw, food: (raw.food ?? 0) + 0.25 } as Tile;
  assert.deepEqual(observer.scan(world).changed.map(key), [key(raw)]);
  // Dropping the last tile regroups; the survivors keep their cached projection.
  const last = world.tiles.pop()!;
  const shrunk = observer.scan(world);
  assert.equal(shrunk.changed.length, 0);
  assert.equal([...shrunk.chunks.values()].reduce((n, tiles) => n + tiles.length, 0), world.tiles.length);
  assert.ok(![...shrunk.chunks.values()].some(tiles => tiles.some(tile => key(tile) === key(last))));
});

/** Rows of a tape, decompressed, without wall-clock columns. */
function rows(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const text = (data: Uint8Array) => gunzipSync(data).toString();
    return {
      frames: (db.prepare('SELECT tick,keyframe_tick,day,phase,weather,pop,births,deaths,structures,formulas,paved,sim_hz,data FROM tape_frames ORDER BY tick').all() as Record<string, unknown>[])
        .map(row => ({ ...row, data: text(row.data as Uint8Array) })),
      keyframes: (db.prepare('SELECT tick,day,pop,data FROM tape_keyframes ORDER BY tick').all() as Record<string, unknown>[])
        .map(row => ({ ...row, data: text(row.data as Uint8Array) })),
    };
  } finally { db.close(); }
}

test('owned tape frames: in-place normalization and structural equality write the same rows as the JSON copy', t => {
  const dir = directory(t);
  const world = createWorld(42, parseParams('motor.hilos=1'));
  const copying = new TapeWriter({ path: join(dir, 'copy.tape.sqlite'), keyframeInterval: 20, maxFrames: 50 });
  const owning = new TapeWriter({ path: join(dir, 'own.tape.sqlite'), keyframeInterval: 20, maxFrames: 50 });
  const observer = createTileObserver();
  let previousView: WorldView | undefined;
  for (let i = 0; i < 90; i++) {
    stepWorld(world);
    const { chunks, changed } = observer.scan(world);
    const keyframe = i % 20 === 0;
    const tiles = keyframe ? [...chunks.values()].flat() : changed;
    const view = projectTapeFrame(world, { stepMs: i } as never, 'instance', tiles);
    // What JSON drops or rewrites must be dropped or rewritten in place too.
    const person = view.people[0]! as unknown as Record<string, unknown>;
    person.probe = i % 4 === 0 ? undefined : i % 4 === 1 ? -0 : i % 4 === 2 ? Number.NaN : [undefined, -0, Infinity, { nested: undefined, kept: 1 }];
    if (i % 5 === 0) (view as unknown as Record<string, unknown>).extra = { at: new Date(0), list: [1, undefined] };
    // The tape thread receives a structured clone; a carried frame keeps the previous summaries by identity.
    let owned = structuredClone(view);
    if (previousView && !keyframe && i % 3) {
      for (const field of CARRIED_VIEW_FIELDS) {
        delete (owned as unknown as Record<string, unknown>)[field];
        // The copying writer sees the same carried values, as its own copy.
        (view as unknown as Record<string, unknown>)[field] = structuredClone((previousView as unknown as Record<string, unknown>)[field]);
      }
      owned = withCarriedFields(owned, previousView);
      for (const field of CARRIED_VIEW_FIELDS) assert.equal((owned as unknown as Record<string, unknown>)[field], (previousView as unknown as Record<string, unknown>)[field]);
    }
    copying.record(view, 5, !keyframe);
    owning.record(owned, 5, !keyframe, true);
    previousView = owned;
  }
  copying.close(); owning.close();
  const a = rows(join(dir, 'copy.tape.sqlite')), b = rows(join(dir, 'own.tape.sqlite'));
  assert.equal(a.frames.length, 50);
  assert.deepEqual(b.frames, a.frames);
  assert.deepEqual(b.keyframes, a.keyframes);
});

test('carried fields: completed in the previous key order, new fields appended, dropped fields gone', () => {
  const previous = { version: 1, tick: 1, people: [], places: ['p'], stats: { population: 3 }, whispers: [1], chemistry: { c: 1 } } as unknown as WorldView;
  const current = { version: 1, tick: 2, people: [{ id: 'x' }], weather: 'rain' } as unknown as WorldView;
  const merged = withCarriedFields(current, previous) as unknown as Record<string, unknown>;
  // `places` is projected on every frame (never carried): a frame without it does not inherit it.
  assert.deepEqual(Object.keys(merged), ['version', 'tick', 'people', 'stats', 'chemistry', 'weather']);
  assert.equal(merged.stats, (previous as unknown as Record<string, unknown>).stats);
  assert.equal(merged.tick, 2);
});

test('turbo gateway: every tick on the tape in order, summaries on every frame, live mirror at its cadence', { timeout: 120_000 }, async t => {
  const dir = directory(t);
  const worldPath = join(dir, 'world.sqlite');
  const gateway = createWorkerGateway({ worldPath, origin: 'https://carta.test', secure: true, password: 'private-v24-hz-password',
    seed: 42, params: parseParams('motor.hilos=1,persistencia.cadaTicks=200'), manual: true, turbo: true, tape: true, tapeKeyframeInterval: 30 });
  t.after(() => gateway.close());
  let mirrorTick = -1;
  gateway.events.on('mirror', (tick: number) => { mirrorTick = tick; });
  await gateway.ready;
  const start = await gateway.flushTape();
  gateway.start();
  await new Promise(resolve => setTimeout(resolve, 3000));
  const end = await gateway.flushTape();
  const ticks = end.latestTick - start.latestTick;
  t.diagnostic(`turbo: ${ticks} ticks in 3 s`);
  assert.ok(ticks > 10, `the world advanced (${ticks} ticks)`);
  const reader = new TapeReader({ path: tapePathForWorld(worldPath) });
  try {
    const meta = reader.readMeta();
    // The world keeps running after the flush: the tape holds at least the flushed frames, one per tick.
    assert.ok(meta.totalFrames >= end.frames);
    assert.equal(meta.totalFrames, meta.maxTick - meta.minTick + 1);
    let expected = meta.minTick, read = 0;
    while (expected <= meta.maxTick) {
      const chunk = reader.readChunk(expected, 120);
      assert.ok(chunk.frames.length > 0);
      for (const frame of chunk.frames) {
        // Frames written after readMeta are past this snapshot.
        if (frame.tick > meta.maxTick) break;
        assert.equal(frame.tick, expected, 'no tick is missing or repeated');
        for (const field of ['stats', 'technology', 'organization', 'demography', 'places', 'memories'] as const) assert.ok(frame[field] !== undefined, `${field} at tick ${frame.tick}`);
        assert.ok(frame.people.length > 0 && frame.tiles.length > 0);
        expected++; read++;
      }
    }
    assert.equal(read, meta.totalFrames);
  } finally { reader.close(); }
  // The live mirror follows the world (throttled, never stalled).
  assert.ok(mirrorTick >= start.latestTick + 1, `mirror tick ${mirrorTick} moved past ${start.latestTick}`);
});

test('carried frames still project per tick what must agree with that tick\'s people', () => {
  const world = createWorld(51926, parseParams('motor.hilos=1'));
  for (let i = 0; i < 3; i++) stepWorld(world);
  const frame = projectTapeFrame(world, {} as WorldView['performance'] & object, 'instance', [], true) as unknown as Record<string, unknown>;
  for (const field of CARRIED_VIEW_FIELDS) assert.equal(Object.hasOwn(frame, field), false, `${field} is carried`);
  for (const field of ['communities', 'demography', 'places', 'memories']) assert.ok(frame[field] !== undefined, `${field} on every frame`);
});

test('turbo gateway: the first frame a reopened tape accepts is a full keyframe (terrain not lost after a restart)', { timeout: 180_000 }, async t => {
  const dir = directory(t);
  const worldPath = join(dir, 'world.sqlite');
  const options = { worldPath, origin: 'https://carta.test', secure: true, password: 'private-v24-hz-password', seed: 42,
    params: parseParams('motor.hilos=1,persistencia.cadaTicks=200'), manual: true, turbo: true, tape: true, tapeKeyframeInterval: 100_000 };
  const tilesAt = (tick: number) => {
    const reader = new TapeReader({ path: tapePathForWorld(worldPath) });
    try { return reader.readChunk(tick, 1).frames.find(frame => frame.tick === tick)?.tiles.length ?? -1; } finally { reader.close(); }
  };
  let gateway = createWorkerGateway(options);
  await gateway.ready;
  gateway.start();
  await new Promise(resolve => setTimeout(resolve, 1500));
  await gateway.close();
  const first = new TapeReader({ path: tapePathForWorld(worldPath) });
  const before = first.readMeta();
  first.close();
  const fullBefore = tilesAt(before.maxTick);
  assert.ok(fullBefore > 100, `resident terrain on the tape before the restart (${fullBefore})`);
  gateway = createWorkerGateway(options);
  t.after(() => gateway.close());
  await gateway.ready;
  gateway.start();
  let after = await gateway.flushTape();
  for (let i = 0; i < 100 && after.latestTick <= before.maxTick + 2; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    after = await gateway.flushTape();
  }
  const resumed = tilesAt(before.maxTick + 1);
  t.diagnostic(`tiles at ${before.maxTick} (before restart): ${fullBefore}; at ${before.maxTick + 1} (first frame after): ${resumed}`);
  assert.ok(resumed >= fullBefore * 0.9, `the first frame after the restart keeps the whole terrain (${resumed} vs ${fullBefore})`);
});
