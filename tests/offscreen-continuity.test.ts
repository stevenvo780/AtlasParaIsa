import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { decodeSnapshot, encodeSnapshot } from '../src/server/snapshot.js';
import { assertWorld, cloneWorld, createWorld, projectWorld, stepWorld, type World } from '../src/world/index.js';
import { activate } from '../src/world/spatial.js';
import { enableContinuousEcology } from '../src/world/offscreen-state.js';
import { prepareEcology } from '../src/world/offscreen.js';
import type { Gesture } from '../src/shared/types.js';

function fixture(t: TestContext, regions = 12, budget = 8) {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-offscreen-test-')), path = join(directory, 'world.sqlite');
  const store = new Store(path); let closed = false;
  const close = () => { if (!closed) { store.close(); closed = true; } };
  t.after(() => { close(); rmSync(directory, { recursive: true, force: true }); });
  let world = createWorld(42); enableContinuousEcology(world, { chunkTicksPerJob: budget }); store.save(world);
  const pulse = (mutate?: (draft: World) => void, advance = true) => {
    const draft = cloneWorld(world, store.context); mutate?.(draft);
    const result = prepareEcology(draft, store.context);
    if (result.ready && advance) stepWorld(draft, [], store.context);
    store.save(draft); world = draft; return result;
  };
  pulse(draft => {
    for (let n = 0; n < regions; n++) activate(draft, (10 + n) * 16, 160, store.context);
  });
  return { directory, path, store, close, pulse, get world() { return world; } };
}

test('real bounded work continues outside human regions and camera queries have no causal effect', t => {
  const a = fixture(t), b = fixture(t);
  const opening = a.store.ecologyArchive.read('13,10', a.world.ecology!.revision)!;
  const initialAnimals = opening.animals!.map(animal => ({ id: animal.id, age: animal.age }));
  for (let pulse = 0; pulse < 24; pulse++) {
    const before = structuredClone(a.world), rows = a.store.db.prepare('SELECT total_changes() AS n').get();
    projectWorld(a.world, { x: 160 + pulse * 7, y: 150, width: 32, height: 24 }, a.store.context);
    projectWorld(a.world, { x: -320 - pulse * 16, y: -320, width: 16, height: 16 }, a.store.context);
    assert.deepEqual(a.world, before); assert.deepEqual(a.store.db.prepare('SELECT total_changes() AS n').get(), rows);
    const result = a.pulse(); b.pulse(); assert.ok(result.work <= 16);
    assert.deepEqual(a.world, b.world);
  }
  const revision = a.world.ecology!.revision, cold = a.store.ecologyArchive.read('13,10', revision)!;
  assert.ok(cold.lastTick > opening.lastTick); assert.notDeepEqual(cold.tiles, opening.tiles);
  assert.ok(initialAnimals.length > 0);
  for (const animal of cold.animals!) {
    const original = initialAnimals.find(before => before.id === animal.id);
    if (original) assert.equal(animal.age, original.age + cold.lastTick - opening.lastTick);
  }
  assert.ok(a.world.animalDynamics.waterConsumed > 0); assert.ok(a.world.ecology!.workedChunkTicks > 0);
  const view = projectWorld(a.world, { x: 208, y: 160, width: 16, height: 16 }, a.store.context);
  assert.equal(view.ecology!.regions[0]!.asOfTick, cold.lastTick); assert.equal(view.ecology!.regions[0]!.status, 'cold');
  assert.equal(view.sequence, revision); assert.equal(view.ecology!.debtChunkTicks,
    a.world.ecology!.summary.regions * a.world.tick - a.world.ecology!.summary.sumTicks);
  assertWorld(a.world); assert.deepEqual(a.store.load()!.world, a.world);
});

test('the persistent oldest-first reservation services every region and explicitly retains excess demand', t => {
  const lab = fixture(t, 40, 2);
  for (let n = 0; n < 35; n++) lab.pulse();
  const headers = lab.store.ecologyArchive.oldest(lab.world.ecology!.revision, 100, [], null);
  assert.equal(headers.length, 40); assert.ok(headers.every(head => head.asOfTick > 0));
  assert.ok(lab.world.ecology!.summary.regions * lab.world.tick - lab.world.ecology!.summary.sumTicks > 0,
    'finite service capacity must expose its accumulating debt');
  const state = structuredClone(lab.world.ecology), loaded = lab.store.load()!.world;
  assert.deepEqual(loaded.ecology, state); assert.equal(loaded.ecology!.chunkTicksPerJob, 2);
  // Maintenance without advancing the human clock is genuine durable work.
  const tick = lab.world.tick, before = lab.world.ecology!.workedChunkTicks;
  for (let n = 0; n < 40; n++) { const work = lab.pulse(undefined, false).work; assert.ok(work > 0 && work <= 4); }
  assert.equal(lab.world.tick, tick); assert.ok(lab.world.ecology!.workedChunkTicks > before);
  assert.ok(lab.store.ecologyArchive.oldest(lab.world.ecology!.revision, 100, [], null).every(head => head.asOfTick >= headers.find(old => old.key === head.key)!.asOfTick));
});

test('a promotion barrier persists progress at the same tick and consumes no queued human order', t => {
  const lab = fixture(t, 40, 2);
  lab.pulse(draft => activate(draft, 48, 0, lab.store.context));
  for (let n = 0; n < 25; n++) lab.pulse();
  let world = cloneWorld(lab.world, lab.store.context);
  const actor = world.people[0]!, place = world.tiles.find(tile => tile.x === 40 && tile.y === 8)!;
  place.terrain = 'meadow'; actor.x = place.x; actor.y = place.y; actor.target = { x: actor.x, y: actor.y };
  const gesture: Gesture = { id: 'queued-during-ecology', kind: 'command', agentId: actor.id, order: 'rest', x: actor.x, y: actor.y };
  const before = structuredClone(actor), tick = world.tick, first = prepareEcology(world, lab.store.context);
  const unrelatedBefore = lab.store.ecologyArchive.oldest(world.ecology!.committedRevision, 100, ['3,0'], null).reduce((sum, head) => sum + head.asOfTick, 0);
  assert.equal(first.ready, false); assert.ok(world.ecology!.preparing.includes('3,0'));
  assert.throws(() => stepWorld(world, [gesture], lab.store.context), /Prepare and commit/);
  assert.deepEqual(actor, before); assert.equal(world.tick, tick); assert.equal(lab.store.result(gesture), null);
  lab.store.save(world);
  world = lab.store.load()!.world;
  assert.equal(world.tick, tick); assert.ok(world.ecology!.preparing.length);
  let pulses = 1;
  for (; pulses < 100; pulses++) {
    const draft = cloneWorld(world, lab.store.context), result = prepareEcology(draft, lab.store.context);
    if (result.ready) {
      const results = stepWorld(draft, [gesture], lab.store.context);
      assert.equal(results.length, 1); assert.equal(results[0]!.accepted, true);
      lab.store.save(draft, [{ gesture, result: results[0]! }]); world = draft; break;
    }
    assert.equal(draft.tick, tick); assert.deepEqual(draft.people[0], before);
    lab.store.save(draft); world = draft;
  }
  assert.ok(pulses < 100); assert.equal(world.tick, tick + 1); assert.ok(lab.store.result(gesture)?.accepted);
  assert.equal(world.chunks['3,0']!.lastTick, world.tick);
  const unrelatedAfter = lab.store.ecologyArchive.oldest(world.ecology!.revision, 100, ['3,0'], null).reduce((sum, head) => sum + head.asOfTick, 0);
  assert.ok(unrelatedAfter > unrelatedBefore, 'promotion pressure cannot take away the reserved background job');
  const ids = [...world.animals.map(animal => animal.id)];
  assert.equal(new Set(ids).size, ids.length); assert.equal(lab.store.ecologyArchive.read('3,0', world.ecology!.revision), null);
});

test('a failed SQL commit leaves cold inventories, weather and metadata pending for an identical retry', t => {
  const lab = fixture(t); for (let n = 0; n < 4; n++) lab.pulse();
  const draft = cloneWorld(lab.world, lab.store.context), result = prepareEcology(draft, lab.store.context);
  assert.ok(result.work > 0); if (result.ready) stepWorld(draft, [], lab.store.context);
  const pending = structuredClone(draft.ecology), row = lab.store.db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get();
  const archived = lab.store.db.prepare('SELECT * FROM ecology_heads ORDER BY key').all();
  const exec = lab.store.db.exec.bind(lab.store.db); let stagedWrites = 0;
  lab.store.db.exec = sql => {
    if (sql === 'COMMIT') {
      assert.notDeepEqual(lab.store.db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get(), row);
      assert.notDeepEqual(lab.store.db.prepare('SELECT * FROM ecology_heads ORDER BY key').all(), archived);
      stagedWrites++; throw new Error('forced ecology rollback');
    }
    return exec(sql);
  };
  assert.throws(() => lab.store.save(draft), /forced ecology rollback/);
  assert.equal(stagedWrites, 1); lab.store.db.exec = exec;
  assert.deepEqual(draft.ecology, pending); assert.deepEqual(lab.store.db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get(), row);
  assert.deepEqual(lab.store.db.prepare('SELECT * FROM ecology_heads ORDER BY key').all(), archived);
  lab.store.save(draft);
  assert.equal(draft.ecology!.pending.length, 0); assert.deepEqual(lab.store.load()!.world, draft);
});

test('current and previous resolve distinct ecological revisions sharing a tick, and reject older reads', t => {
  const lab = fixture(t, 24, 2); for (let n = 0; n < 12; n++) lab.pulse();
  lab.pulse(undefined, false);
  const previous = structuredClone(lab.world), beforeHeads = lab.store.db.prepare('SELECT * FROM ecology_heads ORDER BY key').all();
  lab.pulse(undefined, false); const current = lab.world;
  assert.equal(current.tick, previous.tick); assert.equal(current.ecology!.revision, previous.ecology!.revision + 1);
  assert.notDeepEqual(lab.store.db.prepare('SELECT * FROM ecology_heads ORDER BY key').all(), beforeHeads);
  for (const row of beforeHeads as {key:string;body:string}[])
    assert.deepEqual(lab.store.ecologyArchive.read(row.key, previous.ecology!.revision), JSON.parse(row.body));
  assert.throws(() => lab.store.ecologyArchive.read('10,10', previous.ecology!.revision - 1), /retained revision/);
  const destination = join(lab.directory, 'previous.sqlite'); lab.store.previous(destination);
  const recovered = new Store(destination, { readOnly: true });
  try { assert.deepEqual(recovered.load()!.world, previous); assert.deepEqual(recovered.db.prepare('SELECT * FROM ecology_heads ORDER BY key').all(), beforeHeads); }
  finally { recovered.close(); }
  assert.deepEqual(lab.store.load()!.world, current);
});

test('forged archive clocks fail before restoration or acknowledgement even with recomputed digest', t => {
  const lab = fixture(t); for (let n = 0; n < 5; n++) lab.pulse();
  const row = lab.store.db.prepare('SELECT * FROM ecology_heads LIMIT 1').get() as { key:string;body:string };
  const invalid = JSON.parse(row.body); invalid.lastTick = lab.world.tick + 1;
  const body = JSON.stringify(invalid), digest = createHash('sha256').update(body).digest('hex');
  lab.store.db.prepare('UPDATE ecology_heads SET body=?,digest=?,tick=? WHERE key=?').run(body, digest, invalid.lastTick, row.key);
  assert.throws(() => lab.store.load(), /integrity|region|inválido/i);
  const destination = join(lab.directory, 'forged.sqlite');
  assert.throws(() => lab.store.previous(destination)); assert.equal(existsSync(destination), false);
});

test('an uncommitted previous ecological snapshot cannot create a recovery destination', t => {
  const lab = fixture(t); lab.pulse();
  const row = lab.store.db.prepare('SELECT body FROM snapshots WHERE slot=1').get() as {body:string};
  const world = decodeSnapshot(row.body) as World;
  world.ecology!.revision++;
  const body = encodeSnapshot(world), digest = createHash('sha256').update(body).digest('hex');
  lab.store.db.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=1').run(body, digest);
  const destination = join(lab.directory, 'uncommitted.sqlite');
  assert.throws(() => lab.store.previous(destination), /Ecology archive/); assert.equal(existsSync(destination), false);
});

test('structured climate records every draw, survives restart, and rejects a missing interval', t => {
  const lab = fixture(t, 2);
  for (let n = 0; n < 602; n++) lab.pulse();
  const revision = lab.world.ecology!.revision;
  const window = lab.store.ecologyArchive.climate(599, 603, revision);
  assert.deepEqual(window.map(observation => observation.tick), [0, 600]);
  assert.equal(window[1]!.weather, lab.world.weather);
  const reader = new Store(lab.path, { readOnly: true });
  try { assert.deepEqual(reader.load()!.world, lab.world); assert.deepEqual(reader.ecologyArchive.climate(599, 603, revision), window); }
  finally { reader.close(); }
  lab.store.db.exec('DELETE FROM ecology_climate WHERE tick=600');
  assert.throws(() => lab.store.ecologyArchive.climate(599, 603, revision), /missing/);
  assert.throws(() => lab.store.load(), /Ecology archive/);
});

test('the durable identity index cannot lose a living cold animal unnoticed', t => {
  const lab = fixture(t, 8); lab.pulse();
  const row = lab.store.db.prepare("SELECT id FROM ecology_identities WHERE kind='animal' LIMIT 1").get() as { id:string };
  assert.ok(row);
  lab.store.db.prepare('DELETE FROM ecology_identities WHERE id=?').run(row.id);
  assert.throws(() => lab.store.load(), /Ecology archive/);
});

test('a forced placement outside active terrain cannot materialize a stale region or run preparation work', t => {
  const lab = fixture(t), draft = cloneWorld(lab.world, lab.store.context);
  draft.people[0]!.x = 160; draft.people[0]!.y = 160;
  const before = structuredClone(draft);
  assert.throws(() => prepareEcology(draft, lab.store.context), /Physical placement/);
  assert.deepEqual(draft, before);
});
