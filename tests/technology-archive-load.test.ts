import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TechnologyArchive } from '../src/server/technology-archive.js';
import type { TechnologyDefinition } from '../src/shared/technology-archive.js';
import type { TechnologyProgram } from '../src/shared/technology.js';
import { programSignature } from '../src/world/technology.js';

const digest = (body: string) => createHash('sha256').update(body).digest('hex');
function definition(id: number, atTick = id * 10): TechnologyDefinition {
  const program: TechnologyProgram = { inputs: [id === 1 ? { source: 'raw', material: 'stone', mass: 1000 }
    : { source: 'product', recipeId: `recipe-${id - 1}`, mass: 1000 }], steps: [{ op: 'form', intensity: 2, shape: 'edge' }] };
  // Synthetic archive lineage: repeated function, distinct programs. This tests
  // storage validation and cost, not discovery or empirical material properties.
  return { lawsVersion: 1, id: `recipe-${id}`, name: `Stored practice ${id}`, program, signature: programSignature(program),
    parents: id === 1 ? [] : [`recipe-${id - 1}`], generation: id, inventorId: 'synthetic-inventor', tick: atTick,
    x: 0, y: 0, novelty: id === 1 ? 'both' : 'program',
    capacities: { cutting: 0.2, storage: 0, insulation: 0, cultivation: 0, binding: 0, abrasion: 0.2 } };
}
function host<T>(db: DatabaseSync, archive: TechnologyArchive, run: () => T): T {
  db.exec('BEGIN');
  try { archive.beginHostTransaction(); const result = run(); db.exec('COMMIT'); archive.acknowledgeHostCommit(); return result; }
  catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); archive.invalidateVerification(); throw error; }
}
function fixture(t: TestContext, count: number, tickFor = (id: number) => id * 10) {
  const directory = mkdtempSync(join(tmpdir(), 'archive-load-')), path = join(directory, 'archive.sqlite');
  const db = new DatabaseSync(path), archive = new TechnologyArchive(db);
  db.exec('PRAGMA journal_mode=WAL; BEGIN'); archive.installSchema(); db.exec('COMMIT');
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  host(db, archive, () => {
    for (let id = 1; id <= count; id++) {
      archive.putDefinition(definition(id, tickFor(id)));
      archive.putStats(`recipe-${id}`, tickFor(id), { uses: 0, manufactured: 0, utility: 0 });
    }
  });
  archive.invalidateVerification();
  return { db, archive, path };
}
function decodingWork(archive: TechnologyArchive) {
  const observed = archive as unknown as { definition(row: unknown): unknown }, original = observed.definition;
  let count = 0;
  observed.definition = function (row) { count++; return original.call(this, row); };
  return { get count() { return count; }, reset() { count = 0; } };
}
function rewrite(db: DatabaseSync, id: number, mutate: (value: TechnologyDefinition) => void): void {
  const row = db.prepare('SELECT body FROM technology_definitions WHERE id=?').get(`recipe-${id}`) as { body: string };
  const value: TechnologyDefinition = JSON.parse(row.body); mutate(value); const body = JSON.stringify(value);
  db.prepare('UPDATE technology_definitions SET body=?,digest=? WHERE id=?').run(body, digest(body), value.id);
}

test('851 increasing definition windows require linear decoding work with or without a declared read transaction', t => {
  for (const managed of [false, true]) {
    const { db, archive } = fixture(t, 851), work = decodingWork(archive);
    const read = () => {
      for (let id = 1; id <= 851; id++) assert.deepEqual(archive.getDefinition(`recipe-${id}`, id * 10), definition(id));
    };
    if (managed) host(db, archive, read); else read();
    assert.ok(work.count <= 4 * 851, `growing windows decoded ${work.count} definitions for 851 rows`);
    work.reset();
    for (const id of [851, 1, 425, 17, 850]) assert.equal(archive.getDefinition(`recipe-${id}`, id * 10)!.generation, id);
    assert.equal(work.count, 5, 'out-of-order lookups reuse only an unchanged verified prefix');
  }
});

test('an extension covers all definitions sharing its endpoint and never inspects validly dated future content', t => {
  const { db, archive } = fixture(t, 6, id => Math.ceil(id / 2) * 10);
  rewrite(db, 6, value => { value.generation = 1; });
  assert.equal(archive.getDefinition('recipe-1', 10)!.id, 'recipe-1');
  assert.equal(archive.getDefinition('recipe-4', 20)!.id, 'recipe-4');
  assert.equal(archive.getDefinition('recipe-6', 20), null);
  assert.throws(() => archive.getDefinition('recipe-5', 30), /definition parent chronology|definition generation/,
    'another definition at the same tick must be checked before that tick is certified');
  assert.equal(archive.getDefinition('recipe-4', 20)!.generation, 4, 'a rejected extension cannot destroy the valid historical prefix');
});

test('a failed suffix cannot leave a usable partial certificate or mutate its novelty bitmap', t => {
  const { db, archive } = fixture(t, 5);
  rewrite(db, 4, value => { value.novelty = 'both'; });
  assert.equal(archive.getDefinition('recipe-2')!.generation, 2);
  for (let n = 0; n < 2; n++) assert.throws(() => archive.getDefinition('recipe-5'), /definition novelty/);
  assert.equal(archive.getDefinition('recipe-2')!.generation, 2);
  rewrite(db, 4, value => { value.novelty = 'program'; });
  assert.equal(archive.getDefinition('recipe-5')!.generation, 5);
});

test('streaming inspectors still visit every author and validate statistics after incremental lookups', t => {
  const { db, archive } = fixture(t, 40);
  for (let id = 1; id <= 40; id++) archive.getDefinition(`recipe-${id}`);
  host(db, archive, () => archive.putStats('recipe-20', 500, { uses: 2, manufactured: 1, utility: 0.5 }));
  for (let pass = 0; pass < 2; pass++) {
    const inspected: string[] = [];
    const summary = archive.summarizeDefinitions(500, value => { assert.equal(value.inventorId, 'synthetic-inventor'); inspected.push(value.id); });
    assert.deepEqual(inspected, Array.from({ length: 40 }, (_, i) => `recipe-${i + 1}`));
    assert.equal(summary.recipes, 40); assert.equal(summary.maxGeneration, 40); assert.equal(summary.functionalDiversity, 1);
    assert.equal(summary.uses, 2); assert.equal(summary.manufactured, 1); assert.equal(summary.utility, 0.5);
  }
  assert.throws(() => archive.summarizeDefinitions(500, () => { throw new Error('author rejected'); }), /author rejected/);
  const body = JSON.stringify({ recipeId: 'recipe-20', tick: 200, uses: 3, manufactured: 0, utility: 0 });
  db.prepare('UPDATE technology_stats SET body=?,digest=? WHERE recipeId=? AND tick=200').run(body, digest(body), 'recipe-20');
  assert.throws(() => archive.summarizeDefinitions(500), /statistics regression/);
});

test('same-connection writes, external commits and schema changes invalidate an incrementally warmed deep prefix', t => {
  for (const kind of ['same', 'external', 'schema'] as const) {
    const { db, archive, path } = fixture(t, 40);
    for (let id = 1; id <= 40; id++) archive.getDefinition(`recipe-${id}`);
    if (kind === 'schema') {
      db.exec('ALTER TABLE technology_definitions ADD COLUMN extra TEXT');
      assert.throws(() => archive.getDefinition('recipe-40'), /schema/);
    } else {
      const writer = kind === 'external' ? new DatabaseSync(path) : db;
      try { rewrite(writer, 1, value => { value.generation = 2; }); }
      finally { if (writer !== db) writer.close(); }
      assert.throws(() => archive.getDefinition('recipe-40'), /definition generation/);
    }
  }
});

test('raw transactions remain untrusted, including rollback and begin with unchanged cumulative mutation counters', t => {
  const { db, archive } = fixture(t, 12), work = decodingWork(archive);
  db.exec('BEGIN');
  archive.getDefinition('recipe-12'); const first = work.count; archive.getDefinition('recipe-12');
  assert.equal(work.count, first * 2, 'raw transaction lookups still perform complete validation');
  db.exec('ROLLBACK');
  rewrite(db, 1, value => { value.generation = 2; });
  db.exec('BEGIN'); rewrite(db, 1, value => { value.generation = 1; });
  assert.equal(archive.getDefinition('recipe-12')!.generation, 12);
  const changes = db.prepare('SELECT total_changes() AS n').get()!.n;
  db.exec('ROLLBACK; BEGIN');
  assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n, changes);
  assert.throws(() => archive.getDefinition('recipe-12'), /definition generation/);
  db.exec('ROLLBACK');
});

test('undatable future rows cannot be hidden by an already warmed prefix', t => {
  const { db, archive } = fixture(t, 4); archive.getDefinition('recipe-1', 10);
  db.prepare('UPDATE technology_definitions SET tick=? WHERE id=?').run('not-a-tick', 'recipe-4');
  assert.throws(() => archive.getDefinition('recipe-2', 20), /definition tick/);
});
