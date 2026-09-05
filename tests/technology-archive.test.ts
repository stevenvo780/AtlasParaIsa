import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TechnologyDefinition, TechnologyStats } from '../src/shared/technology-archive.js';
import type { TechnologyExecution, TechnologyProgram } from '../src/shared/technology.js';
import { TechnologyArchive } from '../src/server/technology-archive.js';
import { defaultTechnologyState, initialTechnologyKnowledge, programSignature, researchTechnology, technologyWorkCost,
  useTool, recordTechnologyBenefit, type TechnologyHost } from '../src/world/technology.js';

const digest = (body: string) => createHash('sha256').update(body).digest('hex');
function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN');
  try { const result = run(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'technology-archive-test-')), path = join(directory, 'archive.sqlite');
  const db = new DatabaseSync(path), archive = new TechnologyArchive(db);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  transaction(db, () => archive.installSchema());
  return { db, archive, path };
}
function definition(id = 1, tick = 10, parent?: TechnologyDefinition): TechnologyDefinition {
  const program: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }],
    steps: [{ op: 'form', intensity: id % 4 + 1, shape: id % 2 ? 'edge' : 'rod' }] };
  if (parent) program.inputs = [{ source: 'product', recipeId: parent.id, mass: 1000 }];
  return { lawsVersion: 1, id: `recipe-${id}`, name: `Design ${id}`, program, signature: programSignature(program),
    parents: parent ? [parent.id] : [], generation: parent ? parent.generation + 1 : 1, inventorId: 'inventor-1', tick, x: 0, y: 0,
    novelty: 'program', capacities: { cutting: 0.2, storage: 0, insulation: 0, cultivation: 0.1, binding: 0, abrasion: 0.2 } };
}
function execution(serial: number, tick = serial): TechnologyExecution {
  // Storage fixture: failed attempts carry no invented product or causal success.
  return { id: `process-${serial}`, kind: 'research', tick, actorId: 'inventor-1', recipeId: null, programSignature: 'failed-trial',
    inputs: [], outputs: [], residueMass: 0, energy: 0.001, work: 1, success: false, parentRecipeIds: [], catalysts: [], benefit: 0,
    balance: { opening: [], closing: [], externalInputs: [], externalLoss: [] } };
}
function stats(n: number): TechnologyStats { return { uses: n, utility: n / 10, manufactured: n }; }
const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test('schema installation is explicit, idempotent and owned by the caller transaction', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const archive = new TechnologyArchive(db);
    assert.equal(count(db, 'sqlite_master'), 0);
    assert.throws(() => archive.installSchema(), /host transaction/); assert.equal(count(db, 'sqlite_master'), 0);
    db.exec('BEGIN'); archive.installSchema(); assert.ok(db.isTransaction); db.exec('ROLLBACK');
    assert.equal(count(db, 'sqlite_master'), 0);
    transaction(db, () => { archive.installSchema(); archive.installSchema(); });
    for (const mutate of [() => archive.initializeHistory(0), () => archive.putDefinition(definition()), () => archive.putStats('recipe-1', 10, stats(1)),
      () => archive.putExecution(execution(1)), () => archive.truncateAfter(0)]) assert.throws(mutate, /host transaction/);
    assert.equal(count(db, 'technology_definitions'), 0);
  } finally { db.close(); }
});

test('history origin is explicit, immutable, transaction-owned and absent until initialized', t => {
  const { db, archive } = fixture(t);
  assert.equal(archive.getHistoryOrigin(), null); assert.equal(count(db, 'technology_origin'), 0);
  db.exec('BEGIN'); archive.initializeHistory(12); assert.deepEqual(archive.getHistoryOrigin(), { version: 1, startsAfter: 12 }); db.exec('ROLLBACK');
  assert.equal(archive.getHistoryOrigin(), null);
  transaction(db, () => { archive.initializeHistory(12); archive.initializeHistory(12); });
  for (const boundary of [0, 11, 13]) assert.throws(() => transaction(db, () => archive.initializeHistory(boundary)), /immutable history origin conflict/);
  assert.deepEqual(archive.getHistoryOrigin(), { version: 1, startsAfter: 12 });
  const second = fixture(t);
  transaction(second.db, () => second.archive.putDefinition(definition()));
  assert.throws(() => transaction(second.db, () => second.archive.initializeHistory(0)), /must precede archived records/);
});

test('missing nested references remain strict by default and are unknown only before the declared origin', t => {
  const { db, archive } = fixture(t), parent = { ...execution(3, 10), nestedExecutionIds: ['process-1'] };
  assert.throws(() => transaction(db, () => archive.putExecution(parent)), /missing nested execution/);
  transaction(db, () => { archive.initializeHistory(1); archive.putExecution(parent); });
  assert.deepEqual(archive.getExecution(parent.id), parent); assert.equal(archive.getExecution('process-1'), null);
  assert.deepEqual(archive.listExecutions(), [parent]);
  const coveredParent = { ...execution(4, 10), nestedExecutionIds: ['process-2'] };
  assert.throws(() => transaction(db, () => archive.putExecution(coveredParent)), /missing nested execution/);
  transaction(db, () => { archive.putExecution({ ...execution(2, 10), kind: 'use' }); archive.putExecution(coveredParent); });
  db.exec("DELETE FROM technology_executions WHERE id='process-2'");
  assert.throws(() => archive.getExecution(coveredParent.id), /missing nested execution/);
  assert.deepEqual(archive.getExecution(parent.id), parent);
});

test('an existing pre-origin child is validated and cannot hide malformed evidence behind the boundary', t => {
  const { db, archive } = fixture(t), parent = { ...execution(2, 10), nestedExecutionIds: ['process-1'] };
  transaction(db, () => { archive.initializeHistory(1); archive.putExecution({ ...execution(1, 10), kind: 'use' }); archive.putExecution(parent); });
  const body = JSON.stringify({ ...execution(1, 10), kind: 'use', energy: -1 });
  db.prepare("UPDATE technology_executions SET body=?,digest=? WHERE id='process-1'").run(body, digest(body));
  assert.throws(() => archive.getExecution(parent.id), /Invalid technology archive execution/);
});

test('origin checksum, strict shape, identity and numeric bounds are verified without read-side mutations', t => {
  const { db, archive, path } = fixture(t); transaction(db, () => archive.initializeHistory(1));
  for (const value of [null, { version: 2, startsAfter: 1 }, { version: 1, startsAfter: -1 },
    { version: 1, startsAfter: 0.5 }, { version: 1, startsAfter: '1' }, { version: 1, startsAfter: 1, extra: true }]) {
    db.exec('BEGIN'); const body = JSON.stringify(value); db.prepare('UPDATE technology_origin SET body=?,digest=?').run(body, digest(body));
    assert.throws(() => archive.getHistoryOrigin(), /history origin/); assert.throws(() => archive.listExecutions(), /history origin/); db.exec('ROLLBACK');
  }
  db.exec('BEGIN'); db.prepare('UPDATE technology_origin SET digest=?').run('0'.repeat(64));
  assert.throws(() => archive.getHistoryOrigin(), /checksum/); db.exec('ROLLBACK');
  db.exec('PRAGMA ignore_check_constraints=ON; BEGIN; UPDATE technology_origin SET id=2');
  assert.throws(() => archive.getHistoryOrigin(), /origin identity/); db.exec('ROLLBACK; PRAGMA ignore_check_constraints=OFF');
  const before = readFileSync(path), readOnly = new DatabaseSync(path, { readOnly: true });
  try { assert.deepEqual(new TechnologyArchive(readOnly).getHistoryOrigin(), { version: 1, startsAfter: 1 }); }
  finally { readOnly.close(); }
  assert.deepEqual(readFileSync(path), before);
});

test('an incompatible preexisting schema cannot silently remove uniqueness guarantees', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE technology_definitions (id TEXT PRIMARY KEY NOT NULL,tick INTEGER NOT NULL,signature TEXT NOT NULL,body TEXT NOT NULL,digest TEXT NOT NULL)');
    assert.throws(() => transaction(db, () => new TechnologyArchive(db).installSchema()), /schema uniqueness/);
    assert.equal(count(db, 'sqlite_master'), 2); // Original table and its PK index survive; the attempted installation rolled back.
  } finally { db.close(); }
});

test('partial unique indexes do not satisfy global signature or serial uniqueness', () => {
  for (const [table, fields, unique] of [
    ['technology_definitions', 'id TEXT PRIMARY KEY NOT NULL,tick INTEGER NOT NULL,signature TEXT NOT NULL,body TEXT NOT NULL,digest TEXT NOT NULL', 'signature'],
    ['technology_executions', 'id TEXT PRIMARY KEY NOT NULL,serial INTEGER NOT NULL,tick INTEGER NOT NULL,body TEXT NOT NULL,digest TEXT NOT NULL', 'serial'],
  ]) {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`CREATE TABLE ${table} (${fields}); CREATE UNIQUE INDEX partial_unique ON ${table}(${unique}) WHERE tick<0`);
      assert.throws(() => transaction(db, () => new TechnologyArchive(db).installSchema()), /schema uniqueness/);
    } finally { db.close(); }
  }
});

test('definitions are immutable, signature-unique and visible only at or after invention', t => {
  const { db, archive } = fixture(t), parent = definition(), child = definition(2, 20, parent);
  transaction(db, () => {
    archive.putDefinition(parent); archive.putDefinition(structuredClone(parent)); archive.putDefinition(child);
    assert.throws(() => archive.putDefinition({ ...parent, name: 'Rewritten' }), /immutable definition conflict/);
    assert.throws(() => archive.putDefinition({ ...parent, id: 'recipe-3' }), /duplicate definition signature/);
  });
  assert.equal(count(db, 'technology_definitions'), 2);
  assert.equal(archive.getDefinition(parent.id, 9), null); assert.deepEqual(archive.getDefinition(parent.id, 10), parent);
  assert.equal(archive.findDefinitionBySignature(child.signature, 19), null); assert.deepEqual(archive.findDefinitionBySignature(child.signature, 20), child);
  assert.equal(archive.getDefinition('recipe-99'), null);
  const loaded = archive.getDefinition(parent.id)!; loaded.program.steps[0]!.intensity = 4;
  assert.deepEqual(archive.getDefinition(parent.id), parent);
});

test('parents and product inputs must be existing topological references, not future or cyclic identities', t => {
  const { db, archive } = fixture(t), parent = definition(1, 20), child = definition(2, 21, parent);
  transaction(db, () => {
    assert.throws(() => archive.putDefinition(child), /missing definition parent/);
    archive.putDefinition(parent);
    assert.throws(() => archive.putDefinition({ ...child, tick: 19 }), /parent chronology/);
    assert.throws(() => archive.putDefinition({ ...child, generation: 3 }), /generation/);
    assert.throws(() => archive.putDefinition({ ...child, parents: [] }), /parents/);
    assert.throws(() => archive.putDefinition({ ...child, parents: [child.id] }), /parents/);
    archive.putDefinition(child);
  });
  assert.deepEqual(archive.getDefinition(child.id), child);
});

test('descendants reject broken ancestral provenance and allow a shared-ancestor DAG', t => {
  const { db, archive } = fixture(t), ancestor = definition(), left = definition(2, 20, ancestor), right = definition(3, 20, ancestor);
  const descendant = definition(4, 30, left); descendant.parents.push(right.id);
  transaction(db, () => { for (const value of [ancestor, left, right, descendant]) archive.putDefinition(value); });
  assert.deepEqual(archive.getDefinition(descendant.id), descendant);
  db.exec('BEGIN'); db.prepare('DELETE FROM technology_definitions WHERE id=?').run(ancestor.id);
  assert.throws(() => archive.getDefinition(descendant.id), /missing definition parent/); db.exec('ROLLBACK');
  db.exec('BEGIN');
  for (const value of [ancestor, left, right, descendant]) {
    const body = JSON.stringify({ ...value, generation: value.generation + 1 });
    db.prepare('UPDATE technology_definitions SET body=?,digest=? WHERE id=?').run(body, digest(body), value.id);
  }
  // Every edge still has a +1 generation step, but the founding definition is impossible.
  assert.throws(() => archive.getDefinition(descendant.id), /definition generation/); db.exec('ROLLBACK');
});

test('strict V1 definition shape rejects mutable counters and malformed programs even with valid signatures', t => {
  const { db, archive } = fixture(t);
  for (const change of [
    (d: any) => { d.uses = 1; }, (d: any) => { d.lawsVersion = 2; }, (d: any) => { d.generation = 0; },
    (d: any) => { d.capacities.magic = 1; }, (d: any) => { d.capacities.cutting = 1.01; },
    (d: any) => { d.program.inputs[0].recipeId = 'recipe-1'; }, (d: any) => { d.program.steps[0].unknown = 'ignored'; },
    (d: any) => { d.program.steps[0].requiredCatalyst = 'storage'; }, (d: any) => { d.program.inputs[0].mass = 31; },
    (d: any) => { d.inventorId = ''; }, (d: any) => { d.x = Infinity; },
  ]) {
    const value = definition(); change(value); value.signature = programSignature(value.program);
    assert.throws(() => transaction(db, () => archive.putDefinition(value)), /Invalid technology archive/);
  }
  assert.equal(count(db, 'technology_definitions'), 0);
});

test('cumulative statistics support historical insertion only between nondecreasing neighbors', t => {
  const { db, archive } = fixture(t), d = definition();
  transaction(db, () => {
    archive.putDefinition(d); archive.putStats(d.id, 10, stats(1)); archive.putStats(d.id, 30, stats(3));
    archive.putStats(d.id, 20, stats(2)); archive.putStats(d.id, 20, stats(2));
    assert.throws(() => archive.putStats(d.id, 25, stats(1)), /regression/);
    assert.throws(() => archive.putStats(d.id, 25, stats(4)), /regression/);
    assert.throws(() => archive.putStats(d.id, 40, stats(0)), /regression/);
    assert.throws(() => archive.putStats(d.id, 20, stats(3)), /immutable statistics conflict/);
    assert.throws(() => archive.putStats(d.id, 9, stats(0)), /reference/);
    for (const value of [{ ...stats(1), uses: -1 }, { ...stats(1), utility: NaN }, { ...stats(1), manufactured: 0.5 }]) {
      assert.throws(() => archive.putStats(d.id, 40, value), /statistics/);
    }
  });
  assert.equal(archive.getStats(d.id, 9), null); assert.deepEqual(archive.getStats(d.id, 29), { recipeId: d.id, tick: 20, ...stats(2) });
  assert.deepEqual(archive.getStats(d.id), { recipeId: d.id, tick: 30, ...stats(3) }); assert.equal(count(db, 'technology_stats'), 3);
});

test('more than 256 pending receipts survive one transaction and paginate independently from any runtime buffer', t => {
  const { db, archive } = fixture(t), pending = Array.from({ length: 700 }, (_, n) => execution(n + 1));
  transaction(db, () => { for (const receipt of pending) archive.putExecution(receipt); archive.putExecution(pending[0]!); });
  assert.equal(count(db, 'technology_executions'), 700);
  const restored: TechnologyExecution[] = []; let afterSerial = 0;
  while (true) {
    const page = archive.listExecutions({ afterSerial, limit: 127 }); if (!page.length) break;
    restored.push(...page); afterSerial = Number(page.at(-1)!.id.slice(8));
  }
  assert.deepEqual(restored, pending); assert.equal(archive.listExecutions({ asOfTick: 350, limit: 1000 }).length, 350);
  assert.equal(archive.getExecution('process-700', 699), null); assert.deepEqual(archive.getExecution('process-700', 700), pending[699]);
  assert.throws(() => archive.listExecutions({ limit: 10001 }), /limit/); assert.throws(() => archive.listExecutions({ afterSerial: -1 }), /tick/);
});

test('receipt identity conflicts, serial-time inversions and missing direct references are rejected', t => {
  const { db, archive } = fixture(t), one = execution(1, 10), three = execution(3, 30);
  transaction(db, () => {
    archive.putExecution(one); archive.putExecution(three);
    assert.throws(() => archive.putExecution({ ...one, benefit: 1 }), /immutable execution conflict/);
    assert.throws(() => archive.putExecution(execution(2, 9)), /chronology/);
    assert.throws(() => archive.putExecution(execution(2, 31)), /chronology/);
    assert.throws(() => archive.putExecution({ ...execution(2, 20), recipeId: 'recipe-1' }), /reference/);
    assert.throws(() => archive.putExecution({ ...execution(2, 20), id: 'process-02' }), /execution/);
    archive.putExecution(execution(2, 20));
  });
  assert.deepEqual(archive.listExecutions().map(e => e.id), ['process-1', 'process-2', 'process-3']);
});

test('recomputed digests do not excuse malformed definitions, statistics or receipts, including key/tick disagreement', t => {
  const { db, archive } = fixture(t), d = definition();
  transaction(db, () => { archive.putDefinition(d); archive.putStats(d.id, 10, stats(1)); archive.putExecution(execution(1, 10)); });
  const corrupt = (table: string, mutate: (value: any) => void, read: () => unknown) => {
    const original = db.prepare(`SELECT body FROM ${table}`).get() as { body: string };
    const value = JSON.parse(original.body); mutate(value); const body = JSON.stringify(value);
    db.exec('BEGIN');
    try { db.prepare(`UPDATE ${table} SET body=?,digest=?`).run(body, digest(body)); assert.throws(read, /Invalid technology archive/); }
    finally { db.exec('ROLLBACK'); }
  };
  for (const change of [(v: any) => { v.uses = 3; }, (v: any) => { v.tick++; }, (v: any) => { v.id = 'recipe-2'; }, (v: any) => { v.program.steps[0].intensity = 9; }]) {
    corrupt('technology_definitions', change, () => archive.getDefinition(d.id));
  }
  for (const change of [(v: any) => { v.utility = -1; }, (v: any) => { v.tick++; }, (v: any) => { v.recipeId = 'recipe-2'; }, (v: any) => { v.extra = 0; }]) {
    corrupt('technology_stats', change, () => archive.getStats(d.id));
  }
  for (const change of [(v: any) => { v.tick++; }, (v: any) => { v.id = 'process-2'; }, (v: any) => { v.balance.extra = []; },
    (v: any) => { v.balance.closing = [{ resourceId: 'raw:wood', mass: 1 }]; }, (v: any) => { v.energy = 'zero'; },
    (v: any) => { v.outputs = [{ resourceId: 'magic:food', mass: 1 }]; }]) {
    corrupt('technology_executions', change, () => archive.getExecution('process-1'));
  }
  db.exec('BEGIN'); db.prepare('UPDATE technology_executions SET serial=2').run();
  assert.throws(() => archive.listExecutions(), /serial/); db.exec('ROLLBACK');
  db.exec('BEGIN'); db.prepare('UPDATE technology_definitions SET digest=?').run('0'.repeat(64));
  assert.throws(() => archive.getDefinition(d.id), /checksum/); db.exec('ROLLBACK');
});

test('queries reject visible statistical and receipt time regressions without consulting future statistics', t => {
  const { db, archive } = fixture(t), d = definition();
  transaction(db, () => { archive.putDefinition(d); archive.putStats(d.id, 10, stats(1)); archive.putStats(d.id, 20, stats(2)); archive.putExecution(execution(1, 10)); archive.putExecution(execution(2, 20)); });
  const body = JSON.stringify({ recipeId: d.id, tick: 20, ...stats(0) });
  db.exec('BEGIN'); db.prepare('UPDATE technology_stats SET body=?,digest=? WHERE tick=20').run(body, digest(body));
  assert.deepEqual(archive.getStats(d.id, 10), { recipeId: d.id, tick: 10, ...stats(1) });
  assert.throws(() => archive.getStats(d.id, 20), /regression/); db.exec('ROLLBACK');
  const receipt = JSON.stringify(execution(2, 9));
  db.exec('BEGIN'); db.prepare('UPDATE technology_executions SET tick=9,body=?,digest=? WHERE serial=2').run(receipt, digest(receipt));
  assert.throws(() => archive.getExecution('process-1'), /chronology/); db.exec('ROLLBACK');
});

test('as-of reads never decode unrelated future rows, including invalid bodies with matching digests', t => {
  const { db, archive } = fixture(t), parent = definition(), child = definition(2, 20, parent);
  transaction(db, () => {
    archive.putDefinition(parent); archive.putDefinition(child); archive.putStats(parent.id, 10, stats(1)); archive.putStats(parent.id, 20, stats(2));
    archive.putExecution(execution(1, 10)); archive.putExecution(execution(2, 20));
  });
  transaction(db, () => {
    for (const table of ['technology_definitions', 'technology_stats', 'technology_executions']) db.prepare(`UPDATE ${table} SET body=?,digest=? WHERE tick=20`).run('null', digest('null'));
  });
  assert.deepEqual(archive.getDefinition(parent.id, 10), parent); assert.equal(archive.getDefinition(child.id, 10), null);
  assert.equal(archive.findDefinitionBySignature(child.signature, 10), null);
  assert.deepEqual(archive.getStats(parent.id, 10), { recipeId: parent.id, tick: 10, ...stats(1) });
  assert.deepEqual(archive.listExecutions({ asOfTick: 10 }), [execution(1, 10)]);
  assert.deepEqual(archive.getExecution('process-1', 10), execution(1, 10)); assert.equal(archive.getExecution('process-2', 10), null);
  for (const read of [() => archive.getDefinition(child.id, 20), () => archive.getStats(parent.id, 20), () => archive.getExecution('process-2', 20)]) assert.throws(read, /Invalid technology archive/);
});

test('external rollback controls definitions, statistics, receipts and failed writes atomically', t => {
  const { db, archive } = fixture(t), d = definition();
  db.exec('BEGIN'); archive.putDefinition(d); archive.putStats(d.id, 10, stats(1)); archive.putExecution(execution(1, 10));
  assert.throws(() => archive.putDefinition({ ...d, name: 'Conflict' }), /conflict/); assert.ok(db.isTransaction);
  assert.ok(archive.getDefinition(d.id)); db.exec('ROLLBACK');
  assert.equal(archive.getDefinition(d.id), null); assert.equal(archive.getStats(d.id), null); assert.equal(archive.getExecution('process-1'), null);
});

test('truncate removes future rows only, preserves references, and can itself be rolled back', t => {
  const { db, archive } = fixture(t), parent = definition(), child = definition(2, 20, parent);
  transaction(db, () => {
    archive.putDefinition(parent); archive.putDefinition(child);
    archive.putStats(parent.id, 10, stats(1)); archive.putStats(parent.id, 20, stats(2)); archive.putStats(child.id, 20, stats(1));
    archive.putExecution(execution(1, 10)); archive.putExecution(execution(2, 20));
  });
  db.exec('BEGIN'); archive.truncateAfter(10);
  assert.equal(archive.getDefinition(child.id), null); assert.equal(archive.getExecution('process-2'), null);
  assert.deepEqual(archive.getStats(parent.id), { recipeId: parent.id, tick: 10, ...stats(1) }); db.exec('ROLLBACK');
  assert.ok(archive.getDefinition(child.id)); assert.ok(archive.getExecution('process-2'));
  transaction(db, () => archive.truncateAfter(10));
  assert.deepEqual(archive.getDefinition(parent.id), parent); assert.equal(archive.getDefinition(child.id), null);
  assert.equal(count(db, 'technology_stats'), 1); assert.equal(count(db, 'technology_executions'), 1);
});

test('truncate refuses a corrupt retained reference before deleting any future row', t => {
  const { db, archive } = fixture(t), parent = definition(1, 20), child = definition(2, 30, parent);
  transaction(db, () => { archive.putDefinition(parent); archive.putDefinition(child); archive.putExecution(execution(1, 20)); });
  const body = JSON.stringify({ ...child, tick: 10 });
  db.exec('BEGIN'); db.prepare('UPDATE technology_definitions SET tick=10,body=?,digest=? WHERE id=?').run(body, digest(body), child.id);
  assert.throws(() => archive.truncateAfter(10), /parent chronology/);
  assert.equal(count(db, 'technology_definitions'), 2); assert.equal(count(db, 'technology_executions'), 1); db.exec('ROLLBACK');
});

test('recovery can discard corrupt future statistics and receipts without consulting their bodies', t => {
  const { db, archive } = fixture(t), d = definition();
  transaction(db, () => {
    archive.putDefinition(d); archive.putStats(d.id, 10, stats(1)); archive.putStats(d.id, 20, stats(2));
    archive.putExecution(execution(1, 10)); archive.putExecution(execution(2, 20));
  });
  transaction(db, () => {
    db.prepare('UPDATE technology_stats SET body=?,digest=? WHERE tick=20').run('null', digest('null'));
    db.prepare('UPDATE technology_executions SET body=?,digest=? WHERE tick=20').run('[]', digest('[]'));
    archive.truncateAfter(10);
  });
  assert.deepEqual(archive.getStats(d.id), { recipeId: d.id, tick: 10, ...stats(1) });
  assert.deepEqual(archive.listExecutions(), [execution(1, 10)]);
});

test('nested catalyst receipts require existing earlier same-tick evidence from the same actor', t => {
  const { db, archive } = fixture(t), d = definition();
  const child: TechnologyExecution = { ...execution(1, 10), kind: 'use', recipeId: d.id, programSignature: '', success: true };
  const parent: TechnologyExecution = { ...execution(2, 10), recipeId: d.id, programSignature: d.signature,
    nestedExecutionIds: [child.id], catalysts: [{ executionId: child.id, itemId: 'product-1', recipeId: d.id, wear: 0, required: false }] };
  transaction(db, () => {
    archive.putDefinition(d);
    assert.throws(() => archive.putExecution(parent), /missing nested execution/);
    archive.putExecution(child);
    assert.throws(() => archive.putExecution({ ...parent, tick: 11 }), /nested execution reference/);
    assert.throws(() => archive.putExecution({ ...parent, actorId: 'different' }), /nested execution reference/);
    assert.throws(() => archive.putExecution({ ...parent, nestedExecutionIds: [] }), /catalyst/);
    archive.putExecution(parent);
  });
  assert.deepEqual(archive.getExecution(parent.id), parent);
  // Local reference integrity is established; this fixture does not establish useful catalytic flux.
});

test('read-only connections load history without changes and reject actual writes', t => {
  const { db, archive, path } = fixture(t), d = definition();
  transaction(db, () => { archive.putDefinition(d); archive.putStats(d.id, 10, stats(1)); archive.putExecution(execution(1, 10)); });
  const before = readFileSync(path), reader = new DatabaseSync(path, { readOnly: true }), view = new TechnologyArchive(reader);
  try {
    assert.deepEqual(view.getDefinition(d.id), d); assert.equal(view.getStats(d.id)!.uses, 1); assert.equal(view.listExecutions().length, 1);
    assert.deepEqual(view.getExecution('process-1'), execution(1, 10));
    assert.equal((reader.prepare('SELECT total_changes() AS n').get() as { n: number }).n, 0);
    assert.throws(() => view.putExecution(execution(2, 20)), /host transaction/);
    reader.exec('BEGIN'); assert.throws(() => view.putExecution(execution(2, 20)), /readonly/i); reader.exec('ROLLBACK');
    assert.deepEqual(readFileSync(path), before);
  } finally { reader.close(); }
});

test('completed engine receipts and learned definitions round-trip without claiming causal validation', t => {
  const { db, archive } = fixture(t), state = defaultTechnologyState();
  const actor = { id: 'inventor-1', x: 0, y: 0, energy: 1, fatigue: 0, hunger: 0.1, thirst: 0.1, materials: { wood: 12, stone: 8 }, skills: {}, technology: initialTechnologyKnowledge() };
  const host: TechnologyHost = { seed: 1, tick: 0, people: [actor], technology: state };
  const program: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }], steps: [{ op: 'form', intensity: 4, shape: 'edge' }, { op: 'compress', intensity: 2 }] };
  actor.technology.project = { kind: 'research', program, parents: [], recipeId: null, progress: 0, requiredWork: technologyWorkCost(program), energyPaid: 0, startedAt: 0 };
  while (actor.technology.project) { host.tick++; researchTechnology(host, actor); }
  const use = useTool(host, actor, 'cutting', 4); recordTechnologyBenefit(host, actor, use, 0.03);
  transaction(db, () => {
    for (const recipe of state.recipes) { const { uses, utility, manufactured, ...immutable } = recipe; archive.putDefinition({ ...immutable, lawsVersion: 1 }); archive.putStats(recipe.id, host.tick, { uses, utility, manufactured }); }
    for (const receipt of state.history) archive.putExecution(receipt);
  });
  assert.equal(state.history.length, 2); assert.deepEqual(archive.listExecutions(), state.history);
  assert.equal(archive.getStats(state.recipes[0]!.id)!.utility, 0.03);
});
