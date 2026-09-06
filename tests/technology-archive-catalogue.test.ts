import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TechnologyArchive } from '../src/server/technology-archive.js';
import type { TechnologyDefinition } from '../src/shared/technology-archive.js';
import type { Capability, TechnologyProgram } from '../src/shared/technology.js';
import { applyPhysicalOperation, materialCapacities, programSignature, rawMaterial, technologyWorkCost, validTechnologyProgram } from '../src/world/technology.js';
import { TECHNOLOGY_FUNCTION_WORDS, technologyFunctionCode, technologyFunctionCount } from '../src/world/technology-catalogue.js';

const checksum = (body: string) => createHash('sha256').update(body).digest('hex');
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'archive-catalogue-')), path = join(dir, 'archive.sqlite');
  const db = new DatabaseSync(path), archive = new TechnologyArchive(db);
  db.exec('PRAGMA journal_mode=WAL; BEGIN'); archive.installSchema(); db.exec('COMMIT');
  t.after(() => { db.close(); rmSync(dir, { force: true, recursive: true }); });
  return { db, archive, path };
}
function host<T>(db: DatabaseSync, archive: TechnologyArchive, callback: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    archive.beginHostTransaction(); const result = callback(); db.exec('COMMIT'); archive.acknowledgeHostCommit(); return result;
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); archive.invalidateVerification(); throw error; }
}
function definition(id: number): TechnologyDefinition {
  const program: TechnologyProgram = { inputs: [id === 1 ? { source: 'raw', material: 'stone', mass: 1000 }
    : { source: 'product', recipeId: `recipe-${id - 1}`, mass: 1000 }], steps: [{ op: 'form', intensity: 2, shape: 'edge' }] };
  const capacities = { cutting: 0, storage: 0, insulation: 0, cultivation: 0, binding: 0, abrasion: 0 };
  let code = id - 1;
  for (const key of Object.keys(capacities) as Capability[]) { capacities[key] = code % 6 / 5; code = Math.floor(code / 6); }
  return { lawsVersion: 1, id: `recipe-${id}`, name: `Practice ${id}`, program, signature: programSignature(program),
    parents: id === 1 ? [] : [`recipe-${id - 1}`], generation: id, inventorId: 'inventor-original', tick: id, x: 0, y: 0, novelty: 'both', capacities };
}
function populate(db: DatabaseSync, archive: TechnologyArchive, count: number): void {
  host(db, archive, () => {
    for (let id = 1; id <= count; id++) {
      archive.putDefinition(definition(id)); archive.putStats(`recipe-${id}`, id, { uses: id, manufactured: id, utility: id });
    }
  });
}
function rewrite(db: DatabaseSync, id: number, mutate: (definition: TechnologyDefinition) => void): void {
  const value = definition(id); mutate(value); const body = JSON.stringify(value);
  db.prepare('UPDATE technology_definitions SET body=?,digest=? WHERE id=?').run(body, checksum(body), value.id);
}
function countQueries(db: DatabaseSync) {
  const original = db.prepare.bind(db); let count = 0;
  db.prepare = sql => { count++; return original(sql); };
  return { reset() { count = 0; }, get count() { return count; } };
}

function physicalDefinitions(): TechnologyDefinition[] {
  let tick = 0;
  return ([1, 2, 3] as const).map((intensity, index) => {
    const program: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }], steps: [{ op: 'compress', intensity }] };
    assert.ok(validTechnologyProgram(program));
    const result = applyPhysicalOperation(program.steps[0]!, [rawMaterial('stone', 1000)]);
    assert.ok(result.success && result.product); tick += technologyWorkCost(program);
    return { ...definition(index + 1), program, signature: programSignature(program), generation: 1, parents: [], tick,
      capacities: materialCapacities(result.product!), novelty: index === 1 ? 'program' : 'both' };
  });
}

test('novelty admission derives its label from earlier functions before any insert or proof mutation', t => {
  const { db, archive } = fixture(t), [first, repeated, different] = physicalDefinitions();
  assert.notEqual(first!.signature, repeated!.signature);
  assert.equal(technologyFunctionCode(first!.capacities), technologyFunctionCode(repeated!.capacities));
  assert.notEqual(technologyFunctionCode(first!.capacities), technologyFunctionCode(different!.capacities));
  host(db, archive, () => {
    assert.throws(() => archive.putDefinition({ ...first!, novelty: 'program' }), /definition novelty/);
    archive.putDefinition(first!); archive.putStats(first!.id, first!.tick, { manufactured: 0, uses: 0, utility: 0 });
  });
  const opening = archive.summarizeDefinitions(first!.tick);
  for (const novelty of ['both', 'function'] as const) {
    host(db, archive, () => {
      assert.throws(() => archive.putDefinition({ ...repeated!, novelty }), /definition novelty/);
      assert.equal(archive.getDefinition(repeated!.id), null);
      assert.deepEqual(archive.summarizeDefinitions(repeated!.tick), opening);
    });
  }
  host(db, archive, () => {
    archive.putDefinition(repeated!); archive.putStats(repeated!.id, repeated!.tick, { manufactured: 0, uses: 0, utility: 0 });
    assert.throws(() => archive.putDefinition({ ...different!, novelty: 'program' }), /definition novelty/);
    archive.putDefinition(different!); archive.putStats(different!.id, different!.tick, { manufactured: 0, uses: 0, utility: 0 });
    // Replaying a definition is not a second discovery. Its existing byte representation stays immutable.
    for (const value of [first!, repeated!, different!]) archive.putDefinition(structuredClone(value));
  });
  const summary = archive.summarizeDefinitions(different!.tick);
  assert.equal(summary.recipes, 3); assert.equal(summary.functionalDiversity, 2);
});

test('novelty prefix validation rejects a forged repeated-function label even after its digest is recomputed', t => {
  for (const novelty of ['both', 'function'] as const) {
    const { db, archive } = fixture(t), [first, repeated] = physicalDefinitions();
    host(db, archive, () => {
      for (const value of [first!, repeated!]) {
        archive.putDefinition(value); archive.putStats(value.id, value.tick, { manufactured: 0, uses: 0, utility: 0 });
      }
    });
    const opening = archive.summarizeDefinitions(first!.tick);
    assert.equal(archive.summarizeDefinitions(repeated!.tick).functionalDiversity, 1);
    const body = JSON.stringify({ ...repeated!, novelty });
    db.prepare('UPDATE technology_definitions SET body=?,digest=? WHERE id=?').run(body, checksum(body), repeated!.id);
    assert.deepEqual(archive.summarizeDefinitions(first!.tick), opening, 'a future false label cannot rewrite a valid past prefix');
    assert.throws(() => archive.summarizeDefinitions(repeated!.tick), /definition novelty/);
    assert.throws(() => archive.getDefinition(repeated!.id), /definition novelty/);
    assert.throws(() => archive.getStats(repeated!.id), /definition novelty/);
    assert.equal((db.prepare('SELECT body FROM technology_definitions WHERE id=?').get(repeated!.id) as { body: string }).body, body,
      'validation reports corruption without rewriting historical labels');
  }
});

test('legacy function novelty is preserved only for the first occurrence of its function', t => {
  const { db, archive } = fixture(t), [original, repeated] = physicalDefinitions(), first = { ...original!, novelty: 'function' as const };
  host(db, archive, () => {
    for (const value of [first, repeated!]) {
      archive.putDefinition(value); archive.putStats(value.id, value.tick, { manufactured: 0, uses: 0, utility: 0 });
    }
  });
  assert.deepEqual(archive.getDefinition(first.id), first);
  assert.equal(archive.getDefinition(repeated!.id)!.novelty, 'program');
  assert.equal(archive.summarizeDefinitions(repeated!.tick).functionalDiversity, 1);
  const body = JSON.stringify({ ...first, novelty: 'program' });
  db.prepare('UPDATE technology_definitions SET body=?,digest=? WHERE id=?').run(body, checksum(body), first.id);
  assert.throws(() => archive.summarizeDefinitions(first.tick), /definition novelty/);
});

test('streaming summary spans 257 definitions and a lineage beyond 32, uses latest actual statistics and inspects every author', t => {
  const { db, archive } = fixture(t); populate(db, archive, 257);
  host(db, archive, () => archive.putStats('recipe-1', 300, { uses: 5, manufactured: 9, utility: 3 }));
  let inspected = 0;
  const summary = archive.summarizeDefinitions(300, value => { assert.equal(value.id, `recipe-${++inspected}`); assert.equal(value.inventorId, 'inventor-original'); });
  assert.equal(inspected, 257); assert.equal(summary.recipes, 257); assert.equal(summary.maxGeneration, 257);
  const sum = 257 * 258 / 2;
  assert.equal(summary.uses, sum + 4); assert.equal(summary.manufactured, sum + 8); assert.equal(summary.utility, sum + 2);
  assert.equal(summary.functions.length, TECHNOLOGY_FUNCTION_WORDS); assert.equal(summary.functionalDiversity, 257);
  assert.equal(technologyFunctionCount(summary.functions), 257);
  for (let id = 1; id <= 257; id++) {
    const code = technologyFunctionCode(definition(id).capacities);
    assert.ok(summary.functions[code >>> 5]! & (1 << (code & 31)));
  }
  assert.equal(archive.summarizeDefinitions(256).recipes, 256);
  assert.equal(archive.summarizeDefinitions(299).uses, sum);
  summary.functions.fill(0); summary.recipes = 0;
  assert.equal(archive.summarizeDefinitions(300).recipes, 257); assert.equal(archive.summarizeDefinitions(300).functionalDiversity, 257);
  inspected = 0; archive.summarizeDefinitions(300, () => inspected++); assert.equal(inspected, 257, 'cached proofs cannot suppress caller-owned identity inspection');
});

test('cold old definitions survive visiting more than a resident cache and warmed deep lookups use bounded database work', t => {
  const { db, archive } = fixture(t); populate(db, archive, 257); archive.summarizeDefinitions(300);
  for (let id = 1; id <= 257; id++) assert.equal(archive.getDefinition(`recipe-${id}`)!.id, `recipe-${id}`);
  const queries = countQueries(db); queries.reset();
  assert.deepEqual(archive.getDefinition('recipe-257'), definition(257));
  assert.ok(queries.count < 25, `warm lookup performed ${queries.count} statements instead of bounded work`);
  queries.reset(); assert.equal(archive.getStats('recipe-257')!.uses, 257);
  assert.ok(queries.count < 30, `warm statistics performed ${queries.count} statements`);
  assert.deepEqual(archive.getDefinition('recipe-1'), definition(1));
});

test('known host writes and committed statistics preserve a complete summary without rescanning history', t => {
  const { db, archive } = fixture(t); populate(db, archive, 40);
  db.exec('CREATE TABLE host_notes (body TEXT)'); archive.summarizeDefinitions(40);
  const queries = countQueries(db); queries.reset();
  host(db, archive, () => archive.observeHostWrites(() => db.prepare('INSERT INTO host_notes VALUES (?)').run('tick')));
  const afterHost = archive.summarizeDefinitions(41);
  assert.equal(afterHost.recipes, 40); assert.ok(queries.count < 35, `unrelated host write caused ${queries.count} statements`);
  queries.reset();
  host(db, archive, () => {
    archive.putStats('recipe-40', 42, { uses: 43, manufactured: 42, utility: 44 });
    archive.observeHostWrites(() => db.prepare('INSERT INTO host_notes VALUES (?)').run('next tick'));
  });
  queries.reset();
  const next = archive.summarizeDefinitions(42);
  assert.equal(next.uses, afterHost.uses + 3); assert.equal(next.manufactured, afterHost.manufactured + 2); assert.equal(next.utility, afterHost.utility + 4);
  assert.ok(queries.count < 15, `reading the incrementally updated summary caused ${queries.count} statements`);
});

test('same-connection edits invalidate the proof and forged distant ancestry cannot hide behind a valid descendant digest', t => {
  const { db, archive } = fixture(t); populate(db, archive, 40); archive.summarizeDefinitions(40);
  db.exec('BEGIN');
  for (let id = 1; id <= 40; id++) rewrite(db, id, value => value.generation++);
  db.exec('COMMIT');
  assert.throws(() => archive.getDefinition('recipe-40'), /definition generation/);
  assert.throws(() => archive.getStats('recipe-40'), /definition generation/);
  assert.throws(() => archive.summarizeDefinitions(40), /definition generation/);
});

test('external connection commits invalidate warm proofs even though local total_changes stays unchanged', t => {
  const { db, archive, path } = fixture(t); populate(db, archive, 40); archive.getDefinition('recipe-40');
  const changes = db.prepare('SELECT total_changes() AS n').get();
  const other = new DatabaseSync(path);
  try { rewrite(other, 1, value => value.generation++); }
  finally { other.close(); }
  assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), changes);
  assert.throws(() => archive.getDefinition('recipe-40'), /definition generation|parent chronology/);
});

test('schema-only changes invalidate proofs even without any counted row mutation', t => {
  const { db, archive } = fixture(t); populate(db, archive, 4); archive.getDefinition('recipe-4');
  const changes = db.prepare('SELECT total_changes() AS n').get();
  db.exec('ALTER TABLE technology_definitions ADD COLUMN unexpected TEXT');
  assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), changes);
  assert.throws(() => archive.getDefinition('recipe-4'), /schema/);
});

test('incremental aggregate counters remain exact at the safe integer boundary', t => {
  const { db, archive } = fixture(t); populate(db, archive, 1);
  host(db, archive, () => archive.putStats('recipe-1', 2, { uses: Number.MAX_SAFE_INTEGER - 1, manufactured: Number.MAX_SAFE_INTEGER - 1, utility: 1 }));
  assert.equal(archive.summarizeDefinitions(2).uses, Number.MAX_SAFE_INTEGER - 1);
  host(db, archive, () => archive.putStats('recipe-1', 3, { uses: Number.MAX_SAFE_INTEGER, manufactured: Number.MAX_SAFE_INTEGER, utility: 1 }));
  const summary = archive.summarizeDefinitions(3);
  assert.equal(summary.uses, Number.MAX_SAFE_INTEGER); assert.equal(summary.manufactured, Number.MAX_SAFE_INTEGER);
});

test('host observation never opens or commits a transaction on the caller behalf', t => {
  const { db, archive } = fixture(t); populate(db, archive, 1); db.exec('CREATE TABLE host_notes(body TEXT)');
  assert.throws(() => archive.beginHostTransaction(), /host transaction/);
  assert.throws(() => archive.observeHostWrites(() => db.exec("INSERT INTO host_notes VALUES ('outside')")), /host transaction/);
  db.exec('BEGIN'); archive.beginHostTransaction(); archive.observeHostWrites(() => db.exec("INSERT INTO host_notes VALUES ('inside')"));
  assert.equal(db.isTransaction, true); db.exec('ROLLBACK'); archive.invalidateVerification();
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM host_notes').get() as { n: number }).n, 0);
});

test('raw rollback followed immediately by another transaction cannot preserve a temporary repaired proof', t => {
  const { db, archive } = fixture(t); populate(db, archive, 40);
  rewrite(db, 1, value => value.generation++);
  db.exec('BEGIN'); rewrite(db, 1, () => {});
  assert.equal(archive.getDefinition('recipe-40')!.generation, 40);
  assert.equal(archive.summarizeDefinitions(40).recipes, 40);
  const before = db.prepare('SELECT total_changes() AS n').get();
  db.exec('ROLLBACK; BEGIN');
  assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), before, 'the cumulative counter cannot detect this transaction boundary');
  assert.throws(() => archive.getDefinition('recipe-40'), /definition generation|parent chronology/);
  db.exec('ROLLBACK');
});

test('host rollback invalidation discards uncommitted statistics and COMMIT without acknowledgement revalidates', t => {
  const { db, archive } = fixture(t); populate(db, archive, 4); const original = archive.summarizeDefinitions(4);
  db.exec('BEGIN'); archive.beginHostTransaction(); archive.putStats('recipe-4', 5, { uses: 9, manufactured: 9, utility: 9 });
  assert.equal(archive.summarizeDefinitions(5).uses, original.uses + 5);
  db.exec('ROLLBACK'); archive.invalidateVerification();
  assert.deepEqual(archive.summarizeDefinitions(5), original);
  db.exec('BEGIN'); archive.beginHostTransaction(); archive.putStats('recipe-4', 5, { uses: 6, manufactured: 6, utility: 6 }); db.exec('COMMIT');
  const queries = countQueries(db); queries.reset();
  assert.equal(archive.summarizeDefinitions(5).uses, original.uses + 2); assert.ok(queries.count > 25, 'a raw commit cannot implicitly acknowledge a proof');
});

for (const scope of ['main', 'temp'] as const) test(`${scope} triggers prevent non-technology host SQL from hiding archive changes`, t => {
  const { db, archive } = fixture(t); populate(db, archive, 4);
  db.exec('CREATE TABLE host_notes (body TEXT)');
  db.exec(`CREATE ${scope === 'temp' ? 'TEMP ' : ''}TRIGGER corrupt_after_note AFTER INSERT ON main.host_notes BEGIN UPDATE technology_definitions SET body='null', digest='${checksum('null')}' WHERE id='recipe-1'; END`);
  assert.equal(archive.summarizeDefinitions(4).recipes, 4);
  assert.doesNotThrow(() => host(db, archive, () => archive.observeHostWrites(() => db.prepare('INSERT INTO host_notes VALUES (?)').run('tick'))));
  assert.throws(() => archive.getDefinition('recipe-4'), /Invalid technology archive/);
});

test('historical summaries exclude future bodies but reject any corrupt statistics in the selected prefix', t => {
  const { db, archive } = fixture(t); populate(db, archive, 4);
  host(db, archive, () => {
    archive.putStats('recipe-1', 10, { uses: 3, manufactured: 3, utility: 3 });
    archive.putStats('recipe-1', 20, { uses: 5, manufactured: 5, utility: 5 });
    archive.putStats('recipe-1', 30, { uses: 7, manufactured: 7, utility: 7 });
  });
  const past = archive.summarizeDefinitions(4);
  const invalid = JSON.stringify({ recipeId: 'recipe-1', tick: 10, uses: 100, manufactured: 100, utility: 100 });
  db.prepare('UPDATE technology_stats SET body=?,digest=? WHERE recipeId=? AND tick=?').run(invalid, checksum(invalid), 'recipe-1', 10);
  assert.deepEqual(archive.summarizeDefinitions(4), past);
  assert.throws(() => archive.summarizeDefinitions(30), /statistics regression/);
  db.prepare('UPDATE technology_stats SET body=?,digest=? WHERE tick=?').run('null', checksum('null'), 30);
  assert.deepEqual(archive.summarizeDefinitions(4), past); assert.throws(() => archive.summarizeDefinitions(30), /Invalid technology archive/);
});

test('missing definitions, missing statistics, malformed costs and unsafe generations cannot produce a certified summary', t => {
  for (const variant of ['definition', 'stats', 'cost', 'generation', 'gap'] as const) {
    const { db, archive } = fixture(t); populate(db, archive, 4); archive.summarizeDefinitions(4);
    if (variant === 'definition') db.exec("DELETE FROM technology_definitions WHERE id='recipe-2'");
    if (variant === 'stats') db.exec("DELETE FROM technology_stats WHERE recipeId='recipe-2'");
    if (variant === 'cost') rewrite(db, 1, value => { value.program.inputs[0]!.mass = 31; value.signature = programSignature(value.program); });
    if (variant === 'generation') rewrite(db, 1, value => { value.generation = Number.MAX_SAFE_INTEGER + 1; });
    if (variant === 'gap') {
      const value = definition(4); value.id = 'recipe-5'; const body = JSON.stringify(value);
      db.prepare("UPDATE technology_definitions SET id=?,body=?,digest=? WHERE id='recipe-4'").run(value.id, body, checksum(body));
    }
    assert.throws(() => archive.summarizeDefinitions(4), /Invalid technology archive/, variant);
  }
});

test('SQLite affinity cannot hide an undatable row outside every otherwise valid historical prefix', t => {
  for (const table of ['technology_definitions', 'technology_stats']) {
    const { db, archive } = fixture(t); populate(db, archive, 4); archive.summarizeDefinitions(4);
    db.exec(`UPDATE ${table} SET tick='not-a-tick' WHERE tick=4`);
    assert.throws(() => archive.summarizeDefinitions(3), /tick/);
  }
});

test('an inspector that writes during enumeration cannot certify a mixed archive snapshot', t => {
  const { db, archive } = fixture(t); populate(db, archive, 4);
  assert.throws(() => archive.summarizeDefinitions(4, async () => {}), /asynchronous definition inspector/);
  assert.throws(() => archive.summarizeDefinitions(4, value => {
    if (value.id === 'recipe-4') rewrite(db, 1, parent => parent.generation++);
  }), /changed during verified read/);
  assert.throws(() => archive.getDefinition('recipe-4'), /definition generation|parent chronology/);
});

test('post-commit acknowledgement is non-throwing even when the connection is no longer available', () => {
  const db = new DatabaseSync(':memory:'), archive = new TechnologyArchive(db);
  db.exec('BEGIN'); archive.installSchema(); db.exec('COMMIT');
  db.exec('BEGIN'); archive.beginHostTransaction(); archive.putDefinition(definition(1)); db.exec('COMMIT'); db.close();
  assert.doesNotThrow(() => archive.acknowledgeHostCommit());
});
