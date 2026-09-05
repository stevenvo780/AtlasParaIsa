import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, SessionRevoked } from '../src/server/store.js';
import { decodeSnapshot, encodeSnapshot } from '../src/server/snapshot.js';
import { assertWorld, createWorld, type World } from '../src/world/index.js';
import { researchTechnology, technologyWorkCost, useTool, recordTechnologyBenefit, cancelTechnologyProject } from '../src/world/technology.js';
import { enableTechnologyJournal } from '../src/world/technology-journal.js';
import type { TechnologyProgram } from '../src/shared/technology.js';

const digest = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');
const count = (store: Store, table: string) => Number(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-store-technology-')), path = join(directory, 'world.sqlite');
  const store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, directory, path };
}
function nextTick(world: World): void {
  world.tick++;
  for (const person of world.people) person.demography.age = world.tick - person.bornAt;
}
function makeTool(world: World, parent?: string) {
  const person = world.people[2]!;
  person.materials.stone = 8; person.energy = 1; person.fatigue = 0.1;
  const program: TechnologyProgram = parent
    ? { inputs: [{ source: 'product', recipeId: parent, mass: 1000 }], steps: [{ op: 'form', shape: 'rod', intensity: 2 }] }
    : { inputs: [{ source: 'raw', material: 'stone', mass: 4000 }], steps: [{ op: 'form', shape: 'edge', intensity: 4 }, { op: 'compress', intensity: 2 }] };
  person.technology.project = { kind: 'research', program, parents: parent ? [parent] : [], recipeId: null,
    progress: 0, requiredWork: technologyWorkCost(program), energyPaid: 0, startedAt: world.tick };
  for (let n = 0; n < 100 && person.technology.project; n++) { nextTick(world); researchTechnology(world, person); }
  assert.equal(person.technology.project, null); assert.ok(person.technology.items.length); assertWorld(world);
  return person;
}
function useMany(world: World, amount: number) {
  const person = world.people[2]!, receipts = [];
  for (let n = 0; n < amount; n++) {
    const receipt = useTool(world, person, 'cutting', 0.01); assert.ok(receipt); receipts.push(receipt);
  }
  return receipts;
}
function rewriteSnapshot(store: Store, slot: number, change: (world: World) => void) {
  const row = store.db.prepare('SELECT body FROM snapshots WHERE slot=?').get(slot) as { body: string };
  const world = decodeSnapshot(row.body) as World; change(world);
  const body = encodeSnapshot(world); store.db.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=?').run(body, digest(body), slot);
}
/** A synthetic old Store schema with real engine state, rather than a production database. */
function oldDatabase(path: string, version: 1 | 2 | 3, worlds: World[]) {
  const store = new Store(path);
  try {
    for (const world of worlds) {
      const old = structuredClone(world); delete old.technology.journal;
      const body = encodeSnapshot(old);
      store.db.exec('INSERT OR REPLACE INTO snapshots SELECT 1,body,digest,saved_at FROM snapshots WHERE slot=0');
      store.db.prepare('INSERT OR REPLACE INTO snapshots VALUES (0,?,?,?)').run(body, digest(body), 123);
    }
    store.db.prepare("INSERT INTO metadata VALUES ('initialized','1')").run();
    store.addSession('old-session', Date.now() + 60_000);
    store.db.exec(`DROP TABLE technology_executions; DROP TABLE technology_stats; DROP TABLE technology_definitions; PRAGMA user_version=${version};`);
    if (version < 3) store.db.exec('DROP TABLE legacy');
    if (version < 2) store.db.exec('DROP TABLE chunks');
  } finally { store.close(); }
}

test('new stores install SQLite schema 4 and initial coverage zero in the first atomic snapshot', t => {
  const { store } = fixture(t), world = createWorld(51926);
  assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 4);
  store.save(world);
  assert.deepEqual(world.technology.journal, { version: 1, startsAfter: 0, committedThrough: 0, pending: [] });
  assert.equal(count(store, 'technology_executions'), 0); assert.equal(count(store, 'technology_definitions'), 0);
  assert.deepEqual(store.load()!.world, world);
});

test('one transaction archives 700 actual same-tick uses, including a late benefit outside the 256 ring', t => {
  const { store, directory } = fixture(t), world = createWorld(51926); store.save(world);
  makeTool(world); nextTick(world); const receipts = useMany(world, 700);
  recordTechnologyBenefit(world, world.people[2]!, receipts[0], 0.25);
  assert.equal(world.technology.history.length, 256); assert.equal(world.technology.journal!.pending.length, 701);
  const journal = world.technology.journal!;
  store.save(world);
  assert.equal(journal.pending.length, 0); assert.equal(journal.committedThrough, 701);
  assert.equal(count(store, 'technology_executions'), 701);
  assert.equal(store.technologyArchive.getExecution(receipts[0]!.executionId)!.benefit, 0.25);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM technology_executions WHERE tick=?").get(world.tick)!.n, 700);
  assert.deepEqual(store.load()!.world, world);
  const path = join(directory, 'backup.sqlite'); store.backup(path); const reopened = new Store(path, { readOnly: true });
  try { assert.deepEqual(reopened.load()!.world, world); assert.equal(count(reopened, 'technology_executions'), 701); }
  finally { reopened.close(); }
});

test('definitions precede dependent receipts and statistics are appended only when final counters change', t => {
  const { store } = fixture(t), world = createWorld(51926); store.save(world); makeTool(world);
  const parent = world.technology.recipes[0]!; store.save(world); const firstTick = world.tick;
  nextTick(world); store.save(world); assert.equal(count(store, 'technology_stats'), 1);
  const receipt = useMany(world, 1)[0]!; recordTechnologyBenefit(world, world.people[2]!, receipt, 0.125);
  // A changed observation requires its own final tick (the preceding save was quiet).
  nextTick(world); store.save(world); const usedTick = world.tick;
  assert.equal(count(store, 'technology_stats'), 2);
  assert.equal(store.technologyArchive.getStats(parent.id, firstTick)!.uses, 0);
  assert.equal(store.technologyArchive.getStats(parent.id, usedTick)!.utility, 0.125);
  makeTool(world, parent.id); store.save(world);
  assert.equal(count(store, 'technology_definitions'), 2);
  assert.deepEqual(store.technologyArchive.getDefinition('recipe-2')!.parents, [parent.id]);
  assert.deepEqual(store.load()!.world, world);
});

test('a final statistics version cannot be rewritten at the same tick and a retry at a later tick succeeds', t => {
  const { store } = fixture(t), world = createWorld(51926); store.save(world); makeTool(world); store.save(world);
  const before = store.load()!.world; useMany(world, 1); const queue = structuredClone(world.technology.journal);
  assert.throws(() => store.save(world), /immutable statistics conflict/);
  assert.deepEqual(world.technology.journal, queue); assert.deepEqual(store.load()!.world, before);
  nextTick(world); store.save(world); assert.equal(count(store, 'technology_executions'), 2);
});

test('a failure after archive inserts rolls back snapshot, inputs and every receipt while retaining the queue for retry', t => {
  const { store } = fixture(t), world = createWorld(51926); store.save(world); const before = store.load()!.world;
  makeTool(world); nextTick(world); useMany(world, 700); const queue = structuredClone(world.technology.journal);
  store.db.exec("CREATE TRIGGER reject_snapshot BEFORE INSERT ON snapshots WHEN NEW.slot=0 BEGIN SELECT RAISE(ABORT,'injected snapshot failure'); END;");
  assert.throws(() => store.save(world), /injected snapshot failure/);
  assert.equal(store.db.isTransaction, false); assert.equal(count(store, 'technology_executions'), 0);
  assert.equal(count(store, 'technology_definitions'), 0); assert.equal(count(store, 'technology_stats'), 0);
  assert.deepEqual(world.technology.journal, queue); assert.deepEqual(store.load()!.world, before);
  store.db.exec('DROP TRIGGER reject_snapshot'); store.save(world);
  assert.equal(count(store, 'technology_executions'), 701); assert.equal(world.technology.journal!.pending.length, 0);
});

test('session revocation keeps technology pending and commits neither physical state nor archive', t => {
  const { store } = fixture(t), world = createWorld(51926); store.save(world); const before = store.load()!.world;
  makeTool(world); const queue = structuredClone(world.technology.journal);
  assert.throws(() => store.save(world, [], ['revoked']), SessionRevoked);
  assert.deepEqual(world.technology.journal, queue); assert.equal(count(store, 'technology_executions'), 0);
  assert.deepEqual(store.load()!.world, before);
  store.addSession('allowed', Date.now() + 60_000); store.save(world, [], ['allowed']);
  assert.equal(count(store, 'technology_executions'), 1); assert.ok(store.sessionValid('allowed'));
});

test('schema 1, 2 and 3 migrate in a transaction; old journal coverage starts exactly at surviving history', t => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-technology-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const world = createWorld(51926); makeTool(world); nextTick(world); useMany(world, 700);
  for (const version of [1, 2, 3] as const) {
    const path = join(directory, `v${version}.sqlite`); oldDatabase(path, version, [world]);
    const store = new Store(path);
    try {
      assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 4);
      assert.equal(count(store, 'technology_executions'), 0); assert.ok(store.sessionValid('old-session'));
      const loaded = store.load()!.world, dropped = loaded.technology.historyDropped;
      assert.equal(loaded.technology.journal!.startsAfter, dropped);
      assert.equal(loaded.technology.journal!.committedThrough, dropped); assert.equal(loaded.technology.journal!.pending.length, 256);
      assert.equal(count(store, 'technology_executions'), 0, 'load does not claim or write archive receipts');
      store.save(loaded); assert.equal(count(store, 'technology_executions'), 256);
      assert.equal(store.technologyArchive.getExecution(`process-${dropped}`), null);
      assert.deepEqual(store.load()!.world, loaded);
    } finally { store.close(); }
  }
});

test('read-only V3 load leaves bytes/schema unchanged and previous creates a migrated, honestly covered copy', t => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-technology-readonly-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const world = createWorld(51926); makeTool(world); nextTick(world); useMany(world, 700);
  const previous = structuredClone(world); nextTick(world); useMany(world, 1);
  const path = join(directory, 'v3.sqlite'); oldDatabase(path, 3, [previous, world]); const before = digest(readFileSync(path));
  const source = new Store(path, { readOnly: true });
  try {
    assert.equal(source.load()!.world.technology.journal!.pending.length, 256);
    assert.equal(source.db.prepare('PRAGMA user_version').get()!.user_version, 3);
    assert.equal(source.db.prepare("SELECT name FROM sqlite_master WHERE name='technology_executions'").get(), undefined);
    const destination = join(directory, 'previous.sqlite'); source.previous(destination);
    const recovered = new Store(destination, { readOnly: true });
    try {
      const loaded = recovered.load()!.world;
      assert.equal(loaded.tick, previous.tick); assert.equal(loaded.technology.journal!.startsAfter, previous.technology.historyDropped);
      assert.equal(loaded.technology.journal!.committedThrough, previous.technology.executionCounter);
      assert.equal(count(recovered, 'technology_executions'), 256); assert.equal(recovered.sessionValid('old-session'), false);
    } finally { recovered.close(); }
    assert.equal(digest(readFileSync(path)), before);
  } finally { source.close(); }
});

test('a missing declared receipt outside the recent ring fails current load and is never regenerated from the cache', t => {
  const { store } = fixture(t), world = createWorld(51926); store.save(world); makeTool(world); nextTick(world); useMany(world, 700); store.save(world);
  store.db.prepare('DELETE FROM technology_executions WHERE id=?').run('process-2');
  assert.throws(() => store.load(), /coverage has a gap/);
  assert.equal(count(store, 'technology_executions'), 700);
});

test('archive checksums and strict receipt shapes are rechecked outside the recent ring', t => {
  for (const recompute of [false, true]) {
    const { store } = fixture(t), world = createWorld(51926); store.save(world); makeTool(world); nextTick(world); useMany(world, 700); store.save(world);
    const row = store.db.prepare("SELECT body,digest FROM technology_executions WHERE id='process-2'").get() as { body: string; digest: string };
    const body = JSON.stringify({ ...JSON.parse(row.body), energy: -1 });
    store.db.prepare("UPDATE technology_executions SET body=?,digest=? WHERE id='process-2'").run(body, recompute ? digest(body) : row.digest);
    assert.throws(() => store.load(), /Invalid technology archive/);
  }
});

test('checksum-consistent cache definition, statistics and recent execution disagreements fail closed', t => {
  for (const part of ['definition', 'stats', 'history'] as const) {
    const { store } = fixture(t), world = createWorld(51926); store.save(world); makeTool(world); nextTick(world); useMany(world, 1); store.save(world);
    rewriteSnapshot(store, 0, value => {
      if (part === 'definition') value.technology.recipes[0]!.name = 'Altered cache';
      if (part === 'stats') value.technology.recipes[0]!.utility = 0.5;
      if (part === 'history') value.technology.history.at(-1)!.benefit = 0.5;
    });
    assert.throws(() => store.load(), /disagree/);
  }
});

test('a snapshot cannot claim pending receipts as already archived or evade a missing declared prefix', t => {
  const { store } = fixture(t), world = createWorld(51926); store.save(world); makeTool(world); store.save(world);
  rewriteSnapshot(store, 0, value => { value.technology.journal!.committedThrough = 0; value.technology.journal!.pending = [...value.technology.history]; });
  assert.throws(() => store.load(), /uncommitted executions/);
  assert.equal(count(store, 'technology_executions'), 1);
});

test('previous recovery truncates future archive only in its copy, ignores corrupt future bodies and revokes copied sessions', t => {
  const { store, directory } = fixture(t), world = createWorld(51926); store.save(world); makeTool(world); store.save(world);
  const previous = structuredClone(world); nextTick(world); useMany(world, 1); store.save(world); store.addSession('active', Date.now() + 60_000);
  store.db.prepare("UPDATE technology_executions SET body='{}' WHERE id='process-2'").run();
  const oldBody = store.db.prepare("SELECT body,digest FROM technology_executions WHERE id='process-2'").get();
  assert.throws(() => store.load(), /checksum/);
  const path = join(directory, 'recovered.sqlite'); store.previous(path); const recovered = new Store(path, { readOnly: true });
  try {
    assert.deepEqual(recovered.load()!.world, previous); assert.equal(count(recovered, 'technology_executions'), 1);
    assert.equal(recovered.technologyArchive.getExecution('process-2'), null); assert.equal(recovered.sessionValid('active'), false);
  } finally { recovered.close(); }
  assert.deepEqual(store.db.prepare("SELECT body,digest FROM technology_executions WHERE id='process-2'").get(), oldBody);
  assert.ok(store.sessionValid('active')); assert.throws(() => store.load(), /checksum/);
});

test('previous rejects a missing already-declared receipt without repairing or modifying the source', t => {
  const { store, directory } = fixture(t), world = createWorld(51926); store.save(world); makeTool(world); store.save(world);
  nextTick(world); store.save(world); store.db.exec("DELETE FROM technology_executions WHERE id='process-1'");
  const before = store.db.prepare('SELECT slot,body,digest FROM snapshots ORDER BY slot').all();
  assert.throws(() => store.previous(join(directory, 'refused.sqlite')), /coverage is incomplete/);
  assert.deepEqual(store.db.prepare('SELECT slot,body,digest FROM snapshots ORDER BY slot').all(), before);
  assert.equal(count(store, 'technology_executions'), 0);
});

test('read-only schema 4 rejects missing technology tables without installing replacements', t => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-technology-schema-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'invalid.sqlite'), store = new Store(path); store.save(createWorld(51926));
  store.db.exec('DROP TABLE technology_stats'); store.close(); const before = digest(readFileSync(path));
  assert.throws(() => new Store(path, { readOnly: true }), /schema is incomplete/);
  assert.equal(digest(readFileSync(path)), before);
  const check = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='technology_stats'").get(), undefined); }
  finally { check.close(); }
});

test('a standalone save must prove its claimed committed prefix before writing a snapshot', t => {
  const { store } = fixture(t), world = createWorld(51926); enableTechnologyJournal(world.technology); makeTool(world);
  world.technology.journal!.committedThrough = world.technology.executionCounter; world.technology.journal!.pending = [];
  assert.throws(() => store.save(world), /coverage is incomplete/);
  assert.equal(count(store, 'snapshots'), 0); assert.equal(count(store, 'technology_executions'), 0);
});

test('same-connection and external archive corruption invalidate the save cache without silently restoring deleted rows', t => {
  for (const external of [false, true]) for (const table of ['technology_stats', 'technology_definitions', 'technology_executions']) {
    const { store, path } = fixture(t), world = createWorld(51926); store.save(world); makeTool(world); store.save(world);
    const mutator = external ? new DatabaseSync(path) : store.db;
    try { mutator.exec(`DELETE FROM ${table}`); } finally { if (external) mutator.close(); }
    nextTick(world); const before = store.db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get();
    const pending = structuredClone(world.technology.journal);
    assert.throws(() => store.save(world), /[Tt]echnology archive/);
    assert.equal(count(store, table), 0, `${table} must remain missing after the refused save`);
    assert.deepEqual(store.db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get(), before);
    assert.deepEqual(world.technology.journal, pending);
  }
});

test('a new Store saving without load still validates its declared durable baseline before inserting anything', t => {
  const { store, path } = fixture(t), world = createWorld(51926); store.save(world); makeTool(world); store.save(world);
  store.db.exec('DELETE FROM technology_stats'); nextTick(world);
  const reopened = new Store(path);
  try {
    assert.throws(() => reopened.save(world), /statistics disagree/);
    assert.equal(count(reopened, 'technology_stats'), 0);
  } finally { reopened.close(); }
});

test('legitimate session changes invalidate the cache and still allow the next complete transaction', t => {
  const { store } = fixture(t), world = createWorld(51926); store.save(world); makeTool(world); store.save(world);
  store.addSession('new-session', Date.now() + 60_000); nextTick(world); useMany(world, 1);
  store.save(world, [], ['new-session']); assert.equal(count(store, 'technology_executions'), 2);
  assert.deepEqual(store.load()!.world, world);
});

test('previous recovery honors serial boundaries even when two checkpoints share a tick', t => {
  const { store, directory } = fixture(t), world = createWorld(51926); store.save(world); const previous = structuredClone(world);
  const actor = world.people[2]!, program: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }], steps: [{ op: 'form', shape: 'edge', intensity: 4 }] };
  actor.technology.project = { kind: 'research', program, parents: [], recipeId: null, progress: 0,
    requiredWork: technologyWorkCost(program), energyPaid: 0, startedAt: world.tick };
  cancelTechnologyProject(world, actor); assert.equal(world.technology.executionCounter, 1); store.save(world);
  const path = join(directory, 'same-tick.sqlite'); store.previous(path); const recovered = new Store(path, { readOnly: true });
  try { assert.deepEqual(recovered.load()!.world, previous); assert.equal(count(recovered, 'technology_executions'), 0); }
  finally { recovered.close(); }
  assert.equal(count(store, 'technology_executions'), 1);
});

test('a late input failure rolls back technology, events and snapshot together', t => {
  const { store } = fixture(t), world = createWorld(51926); store.save(world);
  const gesture = { id: 'duplicate-input', kind: 'plant' as const, x: 17, y: 13 };
  const result = { id: gesture.id, accepted: true, tick: 0, order: 0, message: 'Storage transaction fixture' };
  store.save(world, [{ gesture, result }]); const before = store.db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get();
  makeTool(world); const queue = structuredClone(world.technology.journal), events = count(store, 'events');
  assert.throws(() => store.save(world, [{ gesture, result }]), /UNIQUE constraint failed: inputs.id/);
  assert.equal(count(store, 'technology_executions'), 0); assert.equal(count(store, 'technology_definitions'), 0);
  assert.equal(count(store, 'events'), events); assert.equal(count(store, 'inputs'), 1);
  assert.deepEqual(store.db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get(), before);
  assert.deepEqual(world.technology.journal, queue); store.save(world); assert.equal(count(store, 'technology_executions'), 1);
});
