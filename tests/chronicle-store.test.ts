import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { createWorld, stepWorld, cloneWorld, assertWorld, type World } from '../src/world/index.js';
import { materializeAnimals, syncFauna } from '../src/world/animals.js';
import { DatabaseSync } from 'node:sqlite';
import { recordChronicleEvent, assertChronicleJournal, MAX_PENDING_CHRONICLE_EVENTS, EMPTY_CHRONICLE_DIGEST } from '../src/world/chronicle-journal.js';
import { type ConLimpieza, filaInstantanea, laboratorio, sha256 } from './lib/store.js';

function emit(world: World): void {
  const event = recordChronicleEvent(world, { kind: 'ecology', actors: [], text: 'Synthetic observation.', cause: 'Test fixture.', source: 'simulation' });
  world.events.push(event); if (world.events.length > 120) world.events.shift();
}
function tables(store: Store): unknown {
  const names = store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as { name: string }[];
  return names.map(({ name }) => [name, store.db.prepare(`SELECT * FROM "${name}"`).all()]);
}

const laboratory = (t: ConLimpieza) => laboratorio(t, 'atlas-chronicle-test-');
function burstWorld(): World {
  const world = createWorld(51926);
  for (const tile of world.tiles) tile.fauna = 0;
  for (const tile of world.tiles.filter(t => t.terrain !== 'water' && t.terrain !== 'shelter').slice(0, 22)) {
    tile.fauna = 6; tile.species = 'hare';
  }
  world.animals = materializeAnimals(world.seed, world.tiles, world.tick);
  syncFauna(world.tiles, world.animals);
  for (const animal of world.animals.slice(0, 128)) { animal.thirst = 1; animal.health = .0001; }
  assertWorld(world); return world;
}

test('one valid physical tick archives its full burst, beyond the visible120 events', t => {
  const { store } = laboratory(t), initial = burstWorld();
  store.save(initial);
  const world = cloneWorld(initial, store.context);
  stepWorld(world, [], store.context); assertWorld(world);
  assert.equal(world.animalDynamics.deaths - initial.animalDynamics.deaths, 128);
  assert.ok(world.eventCounter - initial.eventCounter > 120);
  assert.equal(world.events.length, 120);
  store.save(world);
  assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n), world.eventCounter);
  assert.deepEqual(store.load()!.world, world);
});

test('a failed commit preserves every queue and database row; clone and retry acknowledge only once', t => {
  const { store } = laboratory(t), initial = burstWorld(); store.save(initial);
  const before = tables(store), draft = cloneWorld(initial, store.context);
  stepWorld(draft, [], store.context);
  const expected = structuredClone(draft), pending = draft.chronicleJournal!.pending;
  assert.notEqual(pending, initial.chronicleJournal!.pending);
  const exec = store.db.exec.bind(store.db); let writesObserved = false;
  store.db.exec = (sql: string) => {
    if (sql === 'COMMIT') {
      writesObserved = Number(store.db.prepare('SELECT COUNT(*) n FROM events').get()!.n) === draft.eventCounter;
      if (writesObserved) throw new Error('injected before durable commit');
    }
    return exec(sql);
  };
  assert.throws(() => store.save(draft), /injected before durable commit/);
  store.db.exec = exec;
  assert.ok(writesObserved); assert.equal(store.db.isTransaction, false);
  assert.deepEqual(tables(store), before); assert.deepEqual(draft, expected);
  assert.equal(draft.chronicleJournal!.pending, pending);
  store.save(draft); const digest = draft.chronicleJournal!.committedDigest;
  assert.equal(draft.chronicleJournal!.pending.length, 0);
  assert.equal(draft.chronicleJournal!.committedThrough, draft.eventCounter);
  assert.deepEqual(store.load()!.world, draft);
  store.save(draft); assert.equal(draft.chronicleJournal!.committedDigest, digest);
  assert.equal(Number(store.db.prepare('SELECT COUNT(*) n FROM events').get()!.n), draft.eventCounter);
});

test('queue limit rejects before counter, ring or pending mutation', () => {
  const world = createWorld(42);
  while (world.chronicleJournal!.pending.length < MAX_PENDING_CHRONICLE_EVENTS) emit(world);
  assertChronicleJournal(world);
  const before = structuredClone(world);
  assert.throws(() => emit(world), /journal is full/);
  assert.deepEqual(world, before);
});

test('sparse actors are rejected before emitting an observation', () => {
  const world = createWorld(42), before = structuredClone(world);
  assert.throws(() => recordChronicleEvent(world, { kind: 'ecology', actors: Array<string>(1),
    text: 'Invalid sparse list.', cause: 'Test fixture.', source: 'simulation' }), /invalid event/);
  assert.deepEqual(world, before);
});

test('a sparse pending actor list outside the visible ring cannot be committed', t => {
  const { store } = laboratory(t), world = createWorld(42); store.save(world);
  const before = tables(store);
  emit(world); world.chronicleJournal!.pending[0]!.actors = Array<string>(1);
  for (let i = 0; i < 121; i++) emit(world);
  const draft = structuredClone(world);
  assert.throws(() => store.save(world), /invalid event/);
  assert.deepEqual(tables(store), before); assert.deepEqual(world, draft);
});

test('previous cannot erase certified coverage by stripping its checkpoint journal', t => {
  const { store, directory } = laboratory(t), world = createWorld(42);
  for (let i = 0; i < 180; i++) emit(world);
  store.save(world); emit(world); store.save(world);
  const checkpoint = JSON.parse(filaInstantanea(store, 1).body);
  delete checkpoint.chronicleJournal;
  const body = JSON.stringify(checkpoint), digest = sha256(body);
  store.db.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=1').run(body, digest);
  store.db.prepare("DELETE FROM events WHERE id='e2'").run();
  const before = tables(store), destination = join(directory, 'forged-previous.sqlite');
  assert.throws(() => store.load(), /coverage has a gap/);
  assert.throws(() => store.previous(destination), /durable origin disagrees/);
  assert.deepEqual(tables(store), before); assert.equal(existsSync(destination), false);
});

test('previous still recovers the authentic checkpoint that opened a journal epoch', t => {
  const { store, directory } = laboratory(t), world = createWorld(42);
  for (let i = 0; i < 180; i++) emit(world);
  store.save(world);
  const checkpoint = JSON.parse(filaInstantanea(store).body);
  delete checkpoint.chronicleJournal;
  const body = JSON.stringify(checkpoint), digest = sha256(body);
  store.db.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=0').run(body, digest);
  store.db.prepare("DELETE FROM metadata WHERE key='chronicle-origin-v1'").run();
  const adopted = store.load()!.world, opening = structuredClone(adopted);
  emit(adopted); store.save(adopted);
  const destination = join(directory, 'authentic-previous.sqlite'); store.previous(destination);
  const recovered = new Store(destination, { readOnly: true });
  try { assert.deepEqual(recovered.load()!.world, opening); } finally { recovered.close(); }
});

for (const corruption of ['delete', 'valid-body', 'invalid-body', 'tick'] as const) {
  test(`cold load and warm save reject external ${corruption} inside a declared prefix`, t => {
    const { store, path } = laboratory(t), world = createWorld(42);
    for (let i = 0; i < 180; i++) emit(world);
    store.save(world); const snapshot = filaInstantanea(store).body;
    const external = new DatabaseSync(path);
    if (corruption === 'delete') external.prepare("DELETE FROM events WHERE id='e2'").run();
    else if (corruption === 'tick') external.prepare("UPDATE events SET tick=1 WHERE id='e2'").run();
    else {
      const event = JSON.parse(String(external.prepare("SELECT body FROM events WHERE id='e2'").get()!.body));
      if (corruption === 'valid-body') event.text = 'Different valid text.'; else event.actors = 42;
      external.prepare("UPDATE events SET body=? WHERE id='e2'").run(JSON.stringify(event));
    }
    external.close();
    assert.throws(() => store.save(world), /Chronicle journal/);
    assert.equal(filaInstantanea(store).body, snapshot);
    const cold = new Store(path, { readOnly: true });
    try { assert.throws(() => cold.load(), /Chronicle journal/); } finally { cold.close(); }
  });
}

test('main and temporary triggers cannot acknowledge a mutated journal prefix', t => {
  for (const temporary of [false, true]) {
    const { store } = laboratory(t), world = createWorld(42);
    for (let i = 0; i < 130; i++) emit(world);
    store.save(world); const before = tables(store);
    store.db.exec(`CREATE ${temporary ? 'TEMP ' : ''}TRIGGER damage AFTER INSERT ON snapshots WHEN NEW.slot=0 BEGIN UPDATE events SET body='{}' WHERE id='e2'; END;`);
    emit(world); const pending = structuredClone(world.chronicleJournal);
    assert.throws(() => store.save(world), /Chronicle journal/);
    assert.deepEqual(world.chronicleJournal, pending); assert.deepEqual(tables(store), before);
    store.db.exec('DROP TRIGGER damage'); store.save(world);
    assert.deepEqual(store.load()!.world, world);
  }
});

test('old unknown gaps survive adoption and only subsequent observations become certified', t => {
  const { store } = laboratory(t), world = createWorld(42);
  for (let i = 0; i < 180; i++) emit(world);
  store.save(world);
  const snapshot = JSON.parse(filaInstantanea(store).body);
  delete snapshot.chronicleJournal;
  store.db.prepare("DELETE FROM metadata WHERE key='chronicle-origin-v1'").run();
  const body = JSON.stringify(snapshot), digest = sha256(body);
  store.db.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=0').run(body,digest);
  store.db.prepare("DELETE FROM events WHERE id='e2'").run();
  const migrated = store.load()!.world;
  assert.deepEqual(migrated.chronicleJournal, { version: 1, startsAfter: world.eventCounter,
    committedThrough: world.eventCounter, committedDigest: EMPTY_CHRONICLE_DIGEST, pending: [] });
  emit(migrated); store.save(migrated);
  assert.equal(store.db.prepare("SELECT 1 FROM events WHERE id='e2'").get(), undefined);
  assert.deepEqual(store.load()!.world, migrated);
});

test('warm saves are incremental, but raw transactions and host SQL changes invalidate proof', t => {
  const { store } = laboratory(t), world = createWorld(42);
  for (let i = 0; i < 200; i++) emit(world);
  store.save(world);
  const internal = store as unknown as { assertChronicleArchive: (world: World, allowLater?: boolean) => void };
  const original = internal.assertChronicleArchive.bind(store); let scans = 0;
  internal.assertChronicleArchive = (...args) => { scans++; return original(...args); };
  for (let i = 0; i < 10; i++) { emit(world); store.save(world); }
  assert.equal(scans, 0, 'ten ordinary commits need no prefix rescan');
  store.db.exec('BEGIN'); assert.deepEqual(store.load()!.world, world); store.db.exec('ROLLBACK');
  const rawScans = scans; emit(world); store.save(world); assert.ok(scans > rawScans);
  store.db.prepare("UPDATE events SET body='{}' WHERE id='e2'").run();
  assert.throws(() => store.save(world), /Chronicle journal/);
});

test('previous preserves all155 same-tick receipts, while cutting the later commit serials', t => {
  const { store, directory } = laboratory(t), initial = burstWorld(); store.save(initial);
  const world = cloneWorld(initial, store.context); stepWorld(world, [], store.context); store.save(world);
  const before = structuredClone(world); emit(world); store.save(world);
  const destination = join(directory, 'previous.sqlite'); store.previous(destination);
  const recovered = new Store(destination, { readOnly: true });
  try {
    assert.deepEqual(recovered.load()!.world, before);
    assert.equal(Number(recovered.db.prepare('SELECT COUNT(*) n FROM events').get()!.n), before.eventCounter);
  } finally { recovered.close(); }
});

for (const corruption of ['remove-snapshot-journal', 'remove-origin', 'forge-origin'] as const) {
  test(`${corruption} cannot disguise an already certified archive as old unknown history`, t => {
    const { store, path } = laboratory(t), world = createWorld(42); store.save(world);
    if (corruption === 'remove-snapshot-journal') {
      const snapshot = JSON.parse(filaInstantanea(store).body);
      delete snapshot.chronicleJournal;
      const body = JSON.stringify(snapshot), digest = sha256(body);
      store.db.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=0').run(body,digest);
    } else if (corruption === 'remove-origin') store.db.prepare("DELETE FROM metadata WHERE key='chronicle-origin-v1'").run();
    else store.db.prepare("UPDATE metadata SET value=? WHERE key='chronicle-origin-v1'").run(JSON.stringify({version:1,startsAfter:world.eventCounter}));
    assert.throws(() => store.save(world), /Chronicle journal/);
    const cold = new Store(path, { readOnly: true });
    try { assert.throws(() => cold.load(), /Chronicle journal/); } finally { cold.close(); }
  });
}

test('a marker-changing trigger fails before acknowledgement and preserves pending events', t => {
  const { store } = laboratory(t), world = createWorld(42); store.save(world);
  const before = tables(store);
  store.db.exec("CREATE TRIGGER corrupt_origin AFTER INSERT ON snapshots WHEN NEW.slot=0 BEGIN UPDATE metadata SET value='{}' WHERE key='chronicle-origin-v1'; END;");
  emit(world); const pending = structuredClone(world.chronicleJournal);
  assert.throws(() => store.save(world), /Chronicle journal/);
  assert.deepEqual(world.chronicleJournal, pending); assert.deepEqual(tables(store), before);
});

test('same-connection schema changes invalidate a warm prefix proof', t => {
  const { store } = laboratory(t), world = createWorld(42); store.save(world);
  store.db.exec('ALTER TABLE events RENAME TO displaced_events; CREATE TABLE events (id TEXT PRIMARY KEY,tick INTEGER,body TEXT);');
  assert.throws(() => store.save(world), /Chronicle journal/);
  assert.equal(Number(store.db.prepare('SELECT COUNT(*) n FROM events').get()!.n), 0);
});

test('matching rows cannot hide removal of event uniqueness behind a warm proof', t => {
  const { store } = laboratory(t), world = createWorld(42); store.save(world);
  store.db.exec('ALTER TABLE events RENAME TO displaced_events; CREATE TABLE events (id TEXT,tick INTEGER NOT NULL,body TEXT NOT NULL); INSERT INTO events SELECT * FROM displaced_events; INSERT INTO events SELECT * FROM displaced_events;');
  assert.throws(() => store.save(world), /Chronicle journal schema uniqueness/);
  assert.throws(() => store.load(), /Chronicle journal schema uniqueness/);
});

test('temporary tables cannot divert an acknowledged snapshot or event archive', t => {
  for (const name of ['events','metadata','snapshots']) {
    const { store } = laboratory(t), world = createWorld(42); store.save(world);
    store.db.exec(`CREATE TEMP TABLE ${name} AS SELECT * FROM main.${name};`);
    emit(world); assert.throws(() => store.save(world), /Chronicle journal temporary objects/);
    assert.equal(Number(store.db.prepare('SELECT COUNT(*) n FROM main.events').get()!.n), 1);
  }
});

test('a conflicting visible body is rejected without overwriting an immutable receipt', t => {
  const { store } = laboratory(t), world = createWorld(42); store.save(world);
  const before = tables(store); world.events[0]!.text = 'Changed after commitment.';
  assert.throws(() => store.save(world), /immutable event cannot be overwritten/);
  assert.deepEqual(tables(store), before);
});

test('losing the chronicle cache after COMMIT does not report a false transaction failure', t => {
  const { store } = laboratory(t), world = createWorld(42); store.save(world); emit(world);
  const internal = store as unknown as { chronicleStamp: () => unknown };
  const stamp = internal.chronicleStamp.bind(store), exec = store.db.exec.bind(store.db); let committed = false;
  internal.chronicleStamp = () => { if (committed) throw new Error('cache only'); return stamp(); };
  store.db.exec = (sql: string) => {
    const result = exec(sql);
    if (sql === 'COMMIT' && Number(store.db.prepare('SELECT COUNT(*) n FROM events').get()!.n) === world.eventCounter) committed = true;
    return result;
  };
  store.save(world); assert.ok(committed); assert.equal(world.chronicleJournal!.pending.length, 0);
  internal.chronicleStamp = stamp; store.db.exec = exec;
  assert.deepEqual(store.load()!.world, world);
});
