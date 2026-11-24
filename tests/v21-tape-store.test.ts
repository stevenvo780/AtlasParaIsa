import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { TapeReader, TapeWriter, tapePathForWorld } from '../src/server/tape-store.js';
import type { ITapeReader, ITapeWriter, TapeWriterOptions } from '../src/shared/tape.js';
import type { AnimalView, BlueprintView, PersonView, StructureView, Tile, WorldView } from '../src/shared/types.js';

function fixture(t: TestContext, options: Partial<TapeWriterOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'v21-tape-'));
  const path = join(dir, 'tape.sqlite');
  const handles: { close(): void }[] = [];
  t.after(() => {
    for (const handle of handles.reverse()) handle.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const writer = (extra: Partial<TapeWriterOptions> = {}): ITapeWriter => {
    const result = new TapeWriter({ path, flushIntervalMs: 1e9, ...options, ...extra });
    handles.push(result); return result;
  };
  const reader = (): ITapeReader => {
    const result = new TapeReader({ path, observerOnly: true, turbo: true });
    handles.push(result); return result;
  };
  const sql = (): DatabaseSync => { const db = new DatabaseSync(path); handles.push(db); return db; };
  return { path, writer, reader, sql };
}

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const blob = (db: DatabaseSync, table: 'tape_frames' | 'tape_keyframes', tick: number): Record<string, any> =>
  JSON.parse(gunzipSync(db.prepare(`SELECT data FROM ${table} WHERE tick=?`).get(tick)!.data as Uint8Array).toString());

function person(id: string, x = 0, y = 0): PersonView {
  return {
    id, name: `Habitante ${id}`, role: 'neighbor', x, y, color: '#ffc080', action: 'rest', reason: 'Reposo',
    energy: 0.8, hunger: 0.2, fatigue: 0.1, thirst: 0.15, need: 'rest', recentMemory: null,
    health: 0.95, age: 1000, materials: { wood: 2, stone: 1 }, skills: { farm: 0.25 },
  };
}

function animal(id: string, x = 0, y = 0): AnimalView {
  return { id, species: 'deer', x, y, action: 'graze', reason: 'Hierba', energy: 0.6,
    hunger: 0.3, thirst: 0.2, fatigue: 0.1, health: 1, generation: 1, parents: [], age: 800,
    genes: { speed: 1, perception: 1, metabolism: 1, carnivory: 0, waterEfficiency: 1, camouflage: 0.5 } };
}

function structure(id: string, x = 0, y = 0): StructureView {
  return { id, x, y, name: `Refugio ${id}`, blueprintId: `bp-${id}`, components: ['frame', 'roof'],
    condition: 0.8, water: 2, food: 3, uses: 1, builtAt: 0, builderId: 'p0' };
}

function blueprint(id: string): BlueprintView {
  return { id, name: `Plano ${id}`, components: ['frame', 'roof'], generation: 1, parents: [],
    inventorId: 'p0', tick: 0, uses: 1, usefulness: 0.5, cost: { wood: 2, stone: 1, work: 4 } };
}

const tile = (x: number, y: number): Tile => ({ x, y, terrain: 'meadow', moisture: 0.4, vegetation: 0.7, food: 0.3 });

/** Every public category changes, including removals, optional fields, ordering and rolling events. */
function viewAt(tick: number): WorldView {
  const era = Math.floor(tick / 10);
  const people = [person('p0', tick / 100, -1), person('p1', 5, 5)];
  people[0] = { ...people[0], energy: 0.8 - tick / 10000, age: 1000 + tick, action: tick % 2 ? 'farm' : 'rest',
    working: tick % 2 === 1, workProgress: tick % 10 / 10, health: 0.9 + tick / 10000,
    need: `necesidad-${era}`, reason: `causa-${era}`, materials: { wood: era, stone: 2 },
    compounds: [], recentMemory: `recuerdo-${era}`, skills: { farm: era / 20 },
    genome: { generation: 2, parents: ['a', 'b'], learningRate: 0.5, cooperation: 0.8, mutations: era } };
  if (era % 3 === 1) people.push(person('new', -2, 0));
  if (era % 3 === 2) people.splice(1, 1);
  if (tick % 7 === 0) people.reverse();
  const animals = [animal('a0', 1, 1), animal('a1', 8, 8)];
  animals[0].age += tick; animals[0].energy += tick / 1000;
  animals[0].x = tick / 50; animals[0].reason = `fauna-${era}`;
  if (era % 2) animals.pop();
  const structures = [structure('s0', 0, 0)];
  structures[0].condition = 1 - tick / 1000;
  structures[0].storedCompounds = [];
  structures[0].site = { requiredWood: 2, requiredStone: 1, depositedWood: era,
    depositedStone: 0, requiredWork: 10, completedWork: tick / 10 };
  if (era % 2) structures.unshift(structure('s1', -2, -2));
  const tiles = Array.from({ length: 16 }, (_, i) => tile(i % 4 - 2, Math.floor(i / 4) - 2));
  tiles[0].cultivation = tick / 1000; tiles[1].traffic = tick / 500;
  tiles[2].food = era / 10;
  if (era % 2) tiles[3].paved = 1;
  if (tick % 9 === 0) tiles.reverse();
  if (tick % 11 === 0) tiles.pop();
  const latestEvent = Math.floor(tick / 3);
  const events: WorldView['events'] = Array.from({ length: Math.min(4, latestEvent + 1) }, (_, i) => {
    const n = latestEvent - i;
    return { id: `e${n}`, tick: n * 3, kind: 'ecology', actors: ['p0'], text: `Evento ${n}`,
      cause: 'Prueba sintética', source: 'simulation' };
  });
  const capacities = { cutting: 1, storage: 2, insulation: 0, cultivation: 0, binding: 0, abrasion: 0 };
  return {
    version: 10, sequence: tick * 2, tick, day: 1 + Math.floor(tick / 24),
    phase: (['dawn', 'day', 'dusk', 'night'] as const)[Math.floor(tick / 6) % 4],
    weather: era % 2 ? 'rain' : 'clear', width: 4, height: 4, originX: -2, originY: -2, infinite: true,
    geologyKey: 12345, instanceId: 'synthetic-world', activeChunks: era + 1, discoveredChunks: era + 5,
    settlementCount: era, regionesVivas: [`${era},0`], tiles, people, animals, structures,
    places: [{ id: 'place', x: 0, y: 0, name: 'Claro', description: `Día ${era}`, gatherings: era }],
    blueprints: structures.map(s => ({ ...blueprint(s.blueprintId), uses: era })),
    communities: [{ id: 'c', name: `Comunidad ${era}`, x: 0, y: 0, color: '#ff0000',
      members: people.map(p => p.id), memberCount: people.length, culture: { sharing: 0.5, stewardship: 0.4, openness: 0.3 },
      formedAt: 0, cooperation: era, disputes: 0 }],
    events, memories: [{ id: 'm', title: 'Recuerdo', text: `Memoria ${era}`, source: 'sample', placeId: 'place' }],
    ...(era % 2 ? { paused: false, pauseReason: 'Prueba' } : {}),
    demography: { deaths: era, causes: { age: era }, recent: [] },
    chemistry: { formulas: [], totalFormulas: era, totalLots: era * 2, maxTemperatureTier: 1,
      byOperator: { grind: era, wash: 0, heat: 0, bind: 0 } },
    stats: { population: people.length, meanEnergy: 0.8, meanHunger: 0.2, meanFatigue: 0.1, meanThirst: 0.1,
      materials: { wood: era, stone: 2 }, actions: { rest: 1 }, biomes: {}, features: {}, totals: { births: era },
      generations: {}, history: [], scope: 'active-regions', wildlife: {}, freshWater: 2,
      cultivatedTiles: era, trailTiles: era, pavedTiles: era, chemicalFormulas: era, statsTick: era * 10 },
    performance: { stepMs: tick / 100, p95StepMs: 2, saveMs: 1, projectionMs: 0.1, snapshotBytes: 200,
      activeTiles: 16, processRssMiB: 10, tickHz: 60, fraccionSerial: 1,
      fases: { maintainRegions: 0, ecologia: 0, kernel: 0, fauna: 0, personas: 0, encuentros: 0,
        demografia: 0, comunidades: 0, reproduccion: 0, checkpoint: 0, muestreo: 0, save: 0, broadcast: 0 } },
    technology: { recipes: [{ id: 'r', name: 'Cuenco', generation: 1, capacities }],
      items: people.map(p => ({ id: `i-${p.id}`, ownerId: p.id, x: p.x, y: p.y, recipeId: 'r', mass: era + 1, generation: 1, capacities })),
      knowledge: people.map(p => ({ actorId: p.id, recipeIds: ['r'] })),
      dynamics: { attempts: era, failures: 0, recipes: 1, products: 2, generations: 1, toolUses: era,
        observedUtility: 1, shared: 0, importedMass: 2, productMass: 2, residueMass: 0, massError: 0,
        work: 1, energy: 1, programDiversity: 1, functionalDiversity: 1, reusedProducts: 0, historyDropped: 0, estateLostMass: 0 },
      budgets: { maxRecipes: 256, maxSteps: 12, maxInputs: 4, maxItems: 16, maxHistory: 256, maxGeneration: 32, maxMassPerInput: 4000 } },
  };
}

function recordRange(writer: ITapeWriter, start: number, end: number): WorldView[] {
  const expected: WorldView[] = [];
  for (let tick = start; tick < end; tick++) {
    const view = viewAt(tick); expected.push(wire(view)); writer.record(view, 100 + tick);
    // Inputs belong to the caller; mutations after record must not modify a pending row or baseline.
    view.people[0].materials!.wood = -999;
    view.tiles[0].food = -999;
  }
  return expected;
}

test('paths, lazy missing/empty DB, WAL schema and frozen shared interfaces', t => {
  assert.equal(tapePathForWorld('/tmp/world.sqlite'), '/tmp/world.tape.sqlite');
  assert.equal(tapePathForWorld('/tmp/world'), '/tmp/world.tape.sqlite');
  const f = fixture(t);
  const reader = f.reader();
  assert.equal(reader.readMeta().totalFrames, 0);
  assert.deepEqual(reader.readChunk(9, 10).frames, []);
  assert.equal(existsSync(f.path), false, 'a read must never create a missing database');
  writeFileSync(f.path, '');
  assert.equal(reader.readMeta().totalFrames, 0);
  const writer = f.writer();
  assert.equal(writer.latestTick, -1); assert.equal(writer.frameCount, 0);
  const db = f.sql();
  assert.equal(db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 1);
  assert.equal(reader.readMeta().observerOnly, true); assert.equal(reader.readMeta().turbo, true);
  writer.record(viewAt(0), 42); writer.flush();
  assert.equal(reader.readMeta().totalFrames, 1);
  assert.deepEqual(reader.readChunk(0, 1).frames, [viewAt(0)]);
  const meta = Object.fromEntries((db.prepare('SELECT key,value FROM tape_meta').all() as { key: string; value: string }[]).map(r => [r.key, r.value]));
  assert.equal(meta.keyframeInterval, '60'); assert.equal(meta.maxFrames, '50000');
  assert.equal(meta.worldInstanceId, 'synthetic-world'); assert.equal(meta.geologyKey, '12345');
});

test('150 ticks: exact full-view parity, keyframe payloads and genuinely incremental deltas', t => {
  const f = fixture(t); const writer = f.writer(); const reader = f.reader();
  const expected = recordRange(writer, 0, 150); writer.flush();
  assert.equal(writer.frameCount, 150); assert.equal(writer.latestTick, 149);
  assert.deepEqual(reader.readChunk(0, 240).frames, expected);
  const db = f.sql();
  assert.deepEqual(blob(db, 'tape_frames', 60), { keyframe: true });
  assert.equal(blob(db, 'tape_keyframes', 60).modifiedTiles.length, expected[60].tiles.length);
  const delta = blob(db, 'tape_frames', 2);
  for (const full of ['people', 'animals', 'structures', 'tiles', 'events', 'stats', 'chemistry', 'blueprints', 'communities']) {
    assert.equal(full in delta, false, `${full} must not be duplicated on an unchanged summary tick`);
  }
  assert.equal(delta.peoplePatch.upserts.length, 1);
  assert.equal(delta.animalsPatch.upserts.length, 1);
  assert.equal(delta.structuresPatch.upserts.length, 1);
  assert.deepEqual(delta.newEvents, []);
  assert.ok(delta.tilesPatch.length < expected[2].tiles.length);
  const removed = blob(db, 'tape_frames', 20);
  assert.ok(removed.peoplePatch.removed.includes('p1'));
  assert.deepEqual(reader.readMeta(9).keyframeTicks, [0, 60, 120]);
});

test('arbitrary seeks, keyframe crossings, endpoint sampling, gaps, count clamps and sequential chunks', t => {
  const f = fixture(t); const writer = f.writer(); const reader = f.reader();
  const expected = recordRange(writer, 0, 300); writer.flush();
  for (const tick of [0, 37, 60, 125, 299, 500]) {
    const result = reader.readChunk(tick, 17);
    assert.deepEqual(result.frames, expected.slice(tick, tick + 17));
    assert.equal(result.hasMore, tick < 283);
    assert.equal(result.simHz, 399);
  }
  const streamed: WorldView[] = [];
  for (let tick = 0; tick < 300; tick += 17) streamed.push(...reader.readChunk(tick, 17).frames);
  assert.deepEqual(streamed, expected);
  assert.equal(reader.readChunk(0, -3).frames.length, 1);
  assert.equal(reader.readChunk(0, 999).frames.length, 240);
  assert.equal(reader.readChunk(0, NaN).frames.length, 1);
  for (const cap of [1, 2, 9, 240, 999]) {
    const meta = reader.readMeta(cap);
    assert.equal(meta.timeline[0].tick, 0); assert.equal(meta.timeline.at(-1)!.tick, 299);
    assert.equal(meta.timeline.length, Math.min(300, Math.max(2, cap)));
    const ticks = meta.timeline.map(p => p.tick);
    assert.equal(new Set(ticks).size, ticks.length);
    assert.equal(meta.latestDay, expected.at(-1)!.day);
    assert.equal(meta.totalFrames, 300); assert.equal(meta.minTick, 0); assert.equal(meta.maxTick, 299);
    for (const point of meta.timeline) {
      const view = expected[point.tick];
      assert.equal(point.pop, view.stats!.population); assert.equal(point.births, view.stats!.totals.births);
      assert.equal(point.deaths, view.demography!.deaths); assert.equal(point.formulas, view.chemistry!.totalFormulas);
      assert.equal(point.structures, view.structures!.length); assert.equal(point.paved, view.stats!.pavedTiles);
      assert.equal(point.simHz, 100 + point.tick);
    }
  }
  const output = reader.readChunk(37, 1).frames[0]; output.people[0].name = 'Mutated output'; output.tiles[0].food = -9;
  assert.deepEqual(reader.readChunk(37, 1).frames[0], expected[37], 'cache and later frames must be detached from results');
});

test('viewport clips margins, absolute polyomino cells, rectangular footprints and ownership; background uses frame tick', t => {
  const f = fixture(t); const writer = f.writer(); const reader = f.reader();
  const view = viewAt(0);
  view.tiles = [{ ...tile(-1, -1), terrain: 'shelter' }];
  view.people = [person('inside', -1, -1), person('margin', -2, 1), person('outside', -3, 0)];
  view.animals = [animal('inside', -1, -1), animal('outside', -2, -1)];
  view.structures = [structure('inside', 0, 0), structure('outside', 8, 8),
    { ...structure('poly', -4, -1), cells: [{ x: -4, y: -1 }, { x: -3, y: -1 }, { x: -2, y: -1 }, { x: -1, y: -1 }] },
    { ...structure('rectangle', -3, 0), footprint: { width: 2, height: 1 } }];
  view.blueprints = view.structures.map(s => blueprint(s.blueprintId));
  view.places = [{ ...view.places[0], id: 'inside', x: -1, y: -1 }, { ...view.places[0], id: 'outside', x: -2, y: 0 }];
  view.communities![0].members = view.people.map(p => p.id); view.communities![0].memberCount = 3;
  const item = view.technology!.items[0];
  view.technology!.items = view.people.map(p => ({ ...item, id: p.id, ownerId: p.id }));
  view.technology!.knowledge = view.people.map(p => ({ actorId: p.id, recipeIds: ['r'] }));
  (view as WorldView & { seed: number }).seed = 777;
  writer.record(view, 10);
  const next = structuredClone(view); next.tick = 1; next.sequence = 1;
  writer.record(next, 10); writer.flush();
  const calls: number[][] = [];
  const frames = reader.readChunk(0, 2, { x: -1, y: -1, width: 2, height: 2 }, (x, y, tick) => {
    calls.push([x, y, tick]); return { ...tile(x, y), food: tick };
  }).frames;
  for (const frame of frames) {
    assert.deepEqual(frame.tiles.map(t => [t.x, t.y]), [[-1, -1], [0, -1], [-1, 0], [0, 0]]);
    assert.equal(frame.tiles[0].terrain, 'shelter'); assert.equal(frame.tiles[1].food, frame.tick);
    assert.deepEqual(frame.people.map(p => p.id), ['inside', 'margin']);
    assert.deepEqual(frame.animals!.map(a => a.id), ['inside']);
    assert.deepEqual(frame.structures!.map(s => s.id), ['inside', 'poly', 'rectangle']);
    assert.deepEqual(frame.blueprints!.map(b => b.id), ['bp-inside', 'bp-poly', 'bp-rectangle']);
    assert.deepEqual(frame.places.map(p => p.id), ['inside']);
    assert.deepEqual(frame.communities![0].members, ['inside', 'margin']);
    assert.equal(frame.communities![0].memberCount, 3);
    assert.deepEqual(frame.technology!.items.map(i => i.ownerId), ['inside', 'margin']);
    assert.deepEqual(frame.technology!.knowledge!.map(k => k.actorId), ['inside', 'margin']);
    assert.equal('seed' in frame, false); assert.equal(frame.geologyKey, view.geologyKey);
  }
  assert.equal(calls.length, 6);
  assert.equal('seed' in reader.readChunk(0, 1).frames[0], false);
  assert.equal('seed' in blob(f.sql(), 'tape_keyframes', 0), false);
});

test('batch commits, explicit flush, close flush and restart force an independent keyframe', t => {
  const f = fixture(t, { batchSize: 5 }); const reader = f.reader(); const writer = f.writer();
  const expected = recordRange(writer, 0, 4);
  assert.equal(writer.frameCount, 4); assert.equal(reader.readMeta().totalFrames, 0);
  writer.record(viewAt(4), 104); expected.push(viewAt(4));
  assert.equal(reader.readMeta().totalFrames, 5);
  expected.push(...recordRange(writer, 5, 7)); writer.flush();
  assert.deepEqual(reader.readChunk(0, 20).frames, expected);
  expected.push(...recordRange(writer, 7, 8)); writer.close(); writer.close();
  assert.equal(reader.readMeta().totalFrames, 8);
  const reopened = f.writer();
  assert.equal(reopened.frameCount, 8); assert.equal(reopened.latestTick, 7);
  expected.push(...recordRange(reopened, 8, 11)); reopened.flush();
  assert.deepEqual(reader.readMeta().keyframeTicks, [0, 8]);
  assert.deepEqual(reader.readChunk(0, 30).frames, expected);
  assert.deepEqual(reader.readChunk(9, 1).frames, [expected[9]]);
  reopened.record(viewAt(10), 99); reopened.record(viewAt(4), 99);
  assert.equal(reopened.frameCount, 11); assert.equal(reopened.latestTick, 10);
});

test('elapsed flush deadline commits the entire pending batch on the next record', t => {
  const f = fixture(t); let clock = 1000;
  t.mock.method(Date, 'now', () => clock);
  const writer = f.writer({ batchSize: 25, flushIntervalMs: 250 }); const reader = f.reader();
  writer.record(viewAt(0), 1); clock = 1249; writer.record(viewAt(1), 1);
  assert.equal(reader.readMeta().totalFrames, 0);
  clock = 1250; writer.record(viewAt(2), 1);
  assert.equal(reader.readMeta().totalFrames, 3);
});

test('failed batched transaction is invisible and can be retried without losing buffered frames', t => {
  const f = fixture(t); const writer = f.writer(); const reader = f.reader(); const db = f.sql();
  const expected = recordRange(writer, 0, 3);
  db.exec("CREATE TRIGGER fail_batch BEFORE INSERT ON tape_frames WHEN NEW.tick=1 BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  assert.throws(() => writer.flush(), /injected failure/);
  assert.equal(reader.readMeta().totalFrames, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tape_keyframes').get()!.n, 0);
  db.exec('DROP TRIGGER fail_batch'); writer.flush();
  assert.deepEqual(reader.readChunk(0, 3).frames, expected);
});

test('rolling ring keeps exactly 40 frames and a reconstructible non-orphaned oldest anchor through repeated pruning', t => {
  const f = fixture(t, { maxFrames: 40, keyframeInterval: 15, batchSize: 7 });
  const writer = f.writer(); const reader = f.reader(); const db = f.sql();
  const expected: WorldView[] = [];
  for (let tick = 0; tick < 150; tick++) {
    const view = viewAt(tick); expected.push(view); writer.record(view, tick);
    if (tick % 7 === 6 || tick === 149) {
      writer.flush(); const meta = reader.readMeta();
      assert.equal(meta.totalFrames, Math.min(tick + 1, 40));
      assert.equal(meta.minTick, Math.max(0, tick - 39));
      assert.equal(writer.frameCount, meta.totalFrames);
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM tape_frames f LEFT JOIN tape_keyframes k
        ON f.keyframe_tick=k.tick WHERE k.tick IS NULL`).get()!.n, 0);
      assert.deepEqual(reader.readChunk(meta.minTick, 240).frames, expected.slice(meta.minTick));
    }
  }
  assert.deepEqual(reader.readChunk(0, 1).frames, [expected[110]]);
  writer.close(); const reopened = f.writer(); reopened.record(viewAt(150), 150); reopened.flush();
  assert.deepEqual(reader.readChunk(111, 240).frames, [...expected.slice(111), viewAt(150)]);
});

test('retention counts rows rather than tick distance, handles maxFrames=1, and survives gaps', t => {
  const f = fixture(t, { maxFrames: 1, keyframeInterval: 60, batchSize: 1 });
  const writer = f.writer(); const reader = f.reader();
  for (const tick of [0, 7, 37, 125, 400]) {
    writer.record(viewAt(tick), 1);
    assert.equal(reader.readMeta().totalFrames, 1);
    assert.deepEqual(reader.readChunk(tick - 1, 3).frames, [viewAt(tick)]);
  }
});

test('WAL permits commits and pruning while another connection holds its old read snapshot', t => {
  const f = fixture(t, { maxFrames: 5 }); const writer = f.writer(); const reader = f.reader();
  recordRange(writer, 0, 5); writer.flush();
  const snapshot = f.sql(); snapshot.exec('BEGIN');
  assert.equal(snapshot.prepare('SELECT MIN(tick) AS n FROM tape_frames').get()!.n, 0);
  recordRange(writer, 5, 15); writer.flush();
  assert.equal(snapshot.prepare('SELECT MIN(tick) AS n FROM tape_frames').get()!.n, 0);
  assert.equal(reader.readMeta().minTick, 10);
  assert.deepEqual(reader.readChunk(10, 5).frames, Array.from({ length: 5 }, (_, i) => viewAt(i + 10)));
  snapshot.exec('COMMIT');
  assert.equal(snapshot.prepare('SELECT MIN(tick) AS n FROM tape_frames').get()!.n, 10);
});

test('actual worker writer and read-only gateway concurrently stream WAL with no partial frames or broken chains', { timeout: 30_000 }, async t => {
  const f = fixture(t); const reader = f.reader();
  const expected = Array.from({ length: 150 }, (_, i) => viewAt(i));
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { tsImport } = await import('tsx/esm/api');
      const { TapeWriter } = await tsImport(workerData.module, workerData.parent);
      const writer = new TapeWriter({ path: workerData.path, batchSize: 3, maxFrames: 40, keyframeInterval: 15 });
      parentPort.postMessage('ready');
      for (const view of workerData.views) {
        writer.record(view, view.tick + 100); writer.flush();
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      writer.close(); parentPort.postMessage('done');
    })().catch(error => { throw error; });
  `, { eval: true, workerData: { path: f.path, module: new URL('../src/server/tape-store.ts', import.meta.url).href,
    parent: import.meta.url, views: expected } });
  t.after(async () => { await worker.terminate(); });
  const exited = once(worker, 'exit');
  await once(worker, 'message');
  let done = false; worker.on('message', message => { if (message === 'done') done = true; });
  let reads = 0;
  while (!done) {
    const meta = reader.readMeta(5);
    if (meta.totalFrames) {
      assert.ok(meta.totalFrames <= 40); assert.equal(meta.timeline[0].tick, meta.minTick);
      const chunk = reader.readChunk(meta.minTick, 7);
      assert.deepEqual(chunk.frames, expected.slice(chunk.fromTick, chunk.toTick + 1));
      reads++;
    }
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.deepEqual(await exited, [0]);
  assert.ok(reads > 2, 'reader ran while the worker was still producing commits');
  assert.equal(reader.readMeta().minTick, 110);
  assert.deepEqual(reader.readChunk(110, 240).frames, expected.slice(110));
});

test('optional collection disappearance, restoration and mutable event IDs preserve full view parity', t => {
  const f = fixture(t); const writer = f.writer(); const reader = f.reader();
  const expected = [viewAt(0), viewAt(1), viewAt(2), viewAt(3)];
  delete expected[1].animals; delete expected[1].structures; delete expected[1].chemistry;
  delete expected[1].technology; delete expected[1].communities; delete expected[1].stats;
  expected[2].events[0].text = 'Edited existing event';
  for (const view of expected) writer.record(view, 1);
  writer.flush();
  assert.deepEqual(reader.readChunk(0, 4).frames, expected);
});

test('metadata reads do not decompress any blobs', t => {
  const f = fixture(t); const writer = f.writer(); recordRange(writer, 0, 3); writer.flush();
  f.sql().exec("UPDATE tape_frames SET data=X'00'; UPDATE tape_keyframes SET data=X'00'");
  const meta = f.reader().readMeta(2);
  assert.equal(meta.totalFrames, 3); assert.deepEqual(meta.timeline.map(p => p.tick), [0, 2]);
});

test('benchmark: sparse 500k-tile keyframes, persistent changed cells, compact deltas and sequential seeks', t => {
  const f = fixture(t, { keyframeInterval: 60 }); const writer = f.writer(); const reader = f.reader();
  const view = viewAt(0);
  view.tiles = Array.from({ length: 500_000 }, (_, i) => tile(i % 1000, Math.floor(i / 1000)));
  view.tiles[10].terrain = 'shelter'; view.tiles[11].cultivation = 0.8;
  view.tiles[12].paved = 1; view.tiles[13].traffic = 0.3; view.tiles[14].wood = 2;
  view.people = Array.from({ length: 1500 }, (_, i) => ({ ...person(`p${i}`, i % 100, Math.floor(i / 100)),
    name: `Habitante-${Math.imul(i, 2654435761) >>> 0}`, recentMemory: `memoria-${i * 7919}` }));
  const started = performance.now();
  writer.record(view, 100);
  for (const tick of [1, 2, 60, 61, 120, 121]) {
    view.tick = tick; view.sequence = tick;
    if (tick === 1) view.tiles[20].food = 0.9;
    if (tick === 2) view.tiles[20].food = 0.3; // Returning to baseline still overrides generated background.
    view.people[0].x = 10 + tick / 20;
    writer.record(view, 100);
  }
  writer.flush(); const writeMs = performance.now() - started;
  const db = f.sql();
  const sizes = db.prepare(`SELECT (SELECT length(data) FROM tape_keyframes WHERE tick=0) AS keyframe,
    (SELECT length(data) FROM tape_frames WHERE tick=1) AS delta`).get() as { keyframe: number; delta: number };
  assert.ok(sizes.keyframe < 100_000, `keyframe ${sizes.keyframe} bytes exceeds sparse budget`);
  assert.ok(sizes.delta < sizes.keyframe / 10, `delta ${sizes.delta} vs keyframe ${sizes.keyframe}`);
  assert.equal(blob(db, 'tape_keyframes', 0).modifiedTiles.length, 5);
  assert.equal(blob(db, 'tape_keyframes', 60).modifiedTiles.length, 6);
  const viewport = { x: 9, y: 0, width: 13, height: 1 };
  const seekStart = performance.now();
  for (const tick of [0, 1, 2, 60, 61, 120, 121]) {
    const frame = reader.readChunk(tick, 1, viewport, (x, y) => ({ ...tile(x, y), food: -1 })).frames[0];
    assert.equal(frame.tiles.length, 13);
    if (tick > 0) assert.equal(frame.people.find(p => p.id === 'p0')!.x, 10 + tick / 20);
    assert.equal(frame.tiles.find(t => t.x === 10)!.terrain, 'shelter');
    assert.equal(frame.tiles.find(t => t.x === 20)!.food, tick === 0 ? -1 : tick === 1 ? 0.9 : 0.3);
  }
  t.diagnostic(`500k tiles / 1500 people: write ${writeMs.toFixed(1)} ms; seeks ${(performance.now() - seekStart).toFixed(1)} ms; keyframe ${sizes.keyframe} B; delta ${sizes.delta} B (${(sizes.keyframe / sizes.delta).toFixed(1)}x smaller)`);
});

test('partialTiles delta frames preserve unchanged resident tiles while recording changed chunks', t => {
  const f = fixture(t, { keyframeInterval: 60 }); const writer = f.writer(); const reader = f.reader();
  const base = viewAt(0);
  base.tiles = [
    { ...tile(0, 0), terrain: 'shelter' },
    { ...tile(1, 0), paved: 1 },
    { ...tile(2, 0), cultivation: 0.6, food: 0.4 },
  ];
  writer.record(base, 50, false);
  // Tick 1: only tile (2,0) changed; unchanged tiles (0,0) and (1,0) are omitted via partialTiles=true.
  const t1 = viewAt(1);
  t1.tiles = [{ ...tile(2, 0), cultivation: 0.9, food: 0.8 }];
  writer.record(t1, 60, true);
  // Tick 2: empty changed-chunk list on an idle tick still keeps all prior modified tiles intact.
  const t2 = viewAt(2);
  t2.tiles = [];
  writer.record(t2, 70, true);
  // Tick 3: full keyframe refresh retires (1,0) cleanly when partialTiles=false.
  const t3 = viewAt(3);
  t3.tiles = [
    { ...tile(0, 0), terrain: 'shelter' },
    { ...tile(2, 0), cultivation: 0.9, food: 0.8 },
  ];
  writer.record(t3, 80, false);
  writer.flush();

  const frames = reader.readChunk(0, 4).frames;
  assert.equal(frames.length, 4);
  for (const tick of [0, 1, 2]) {
    const byKey = new Map(frames[tick].tiles.map(cell => [`${cell.x},${cell.y}`, cell]));
    assert.equal(byKey.get('0,0')?.terrain, 'shelter', `tick ${tick} keeps shelter`);
    assert.equal(byKey.get('1,0')?.paved, 1, `tick ${tick} keeps paved road`);
    assert.equal(byKey.get('2,0')?.cultivation, tick === 0 ? 0.6 : 0.9, `tick ${tick} tracks updated crop`);
  }
  const byKey3 = new Map(frames[3].tiles.map(cell => [`${cell.x},${cell.y}`, cell]));
  assert.equal(byKey3.has('0,0'), true);
  assert.equal(byKey3.has('1,0'), false, 'full frame retires omitted tiles');
  assert.equal(byKey3.get('2,0')?.food, 0.8);
});

test('field-level entity patches omit unchanged heavy fields while preserving exact reconstruction and key removal', t => {
  const f = fixture(t, { keyframeInterval: 60 }); const writer = f.writer(); const reader = f.reader();
  const v0 = viewAt(0);
  v0.people[0] = { ...v0.people[0], thirst: 0.25, recentMemory: 'orilla calma' };
  const v1 = structuredClone(v0);
  v1.tick = 1; v1.sequence = 1;
  v1.people[0].hunger = 0.42;
  delete v1.people[0].thirst;
  v1.animals![0].energy = 0.77;
  writer.record(v0, 100);
  writer.record(v1, 100);
  writer.flush();

  const delta = blob(f.sql(), 'tape_frames', 1);
  assert.equal(delta.peoplePatch.upserts.length, 1);
  assert.equal(delta.peoplePatch.upserts[0]._p, 1);
  assert.equal(delta.peoplePatch.upserts[0].hunger, 0.42);
  assert.deepEqual(delta.peoplePatch.upserts[0]._u, ['thirst']);
  assert.equal('name' in delta.peoplePatch.upserts[0], false, 'unchanged person fields are omitted');
  assert.equal('recentMemory' in delta.peoplePatch.upserts[0], false, 'unchanged heavy person fields are omitted');
  assert.equal(delta.animalsPatch.upserts[0]._p, 1);
  assert.equal('genes' in delta.animalsPatch.upserts[0], false, 'unchanged animal genes are omitted');
  assert.deepEqual(reader.readChunk(0, 2).frames, [v0, v1]);
});

test('incremental techPatch/statsPatch/blueprintsPatch/communitiesPatch and sparse micro-drift suppression', t => {
  const f = fixture(t, { keyframeInterval: 60 }); const writer = f.writer(); const reader = f.reader();
  const v0 = viewAt(0);
  v0.tiles = Array.from({ length: 5000 }, (_, i) => tile(i % 100, Math.floor(i / 100)));
  v0.tiles[0].terrain = 'shelter';
  writer.record(v0, 100);
  const v1 = structuredClone(v0);
  v1.tick = 1; v1.sequence = 1;
  // Micro-drift on 4999 ambient tiles must NOT trigger tilesPatch in sparseMode (>4096 tiles):
  for (let i = 1; i < 5000; i++) v1.tiles[i].moisture += 0.002;
  // One genuine visual shift MUST register:
  v1.tiles[5].food = 0.85;
  // Changing one item + one stat must NOT resend recipes or stats.history:
  v1.technology!.items[0].x += 1;
  v1.stats!.population += 1;
  v1.blueprints![0].uses += 1;
  v1.communities![0].cooperation += 1;
  writer.record(v1, 100);
  writer.flush();

  const delta = blob(f.sql(), 'tape_frames', 1);
  assert.equal(delta.tilesPatch.length, 1, 'only the genuinely changed tile entered tilesPatch');
  assert.equal(delta.tilesPatch[0].x, 5);
  assert.equal('technology' in delta, false);
  assert.ok(delta.techPatch && delta.techPatch.itemsPatch && !delta.techPatch.recipesPatch);
  assert.equal('stats' in delta, false);
  assert.ok(delta.statsPatch && delta.statsPatch.set.population === v1.stats!.population && !('history' in delta.statsPatch.set));
  assert.equal('blueprints' in delta, false);
  assert.ok(delta.blueprintsPatch && delta.blueprintsPatch.upserts.length === 1);
  assert.equal('communities' in delta, false);
  assert.ok(delta.communitiesPatch && delta.communitiesPatch.upserts.length === 1);
  const reconstructed = reader.readChunk(1, 1).frames[0];
  assert.equal(reconstructed.technology!.items[0].x, v1.technology!.items[0].x);
  assert.deepEqual(reconstructed.technology!.recipes, v1.technology!.recipes);
  assert.deepEqual(reconstructed.stats, v1.stats);
  assert.deepEqual(reconstructed.blueprints, v1.blueprints);
  assert.deepEqual(reconstructed.communities, v1.communities);
});
