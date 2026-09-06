import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { decodeSnapshot, encodeSnapshot } from '../src/server/snapshot.js';
import { assertWorld, createWorld, stepWorld, type World } from '../src/world/index.js';
import { researchTechnology, technologyWorkCost, type TechnologyProgram } from '../src/world/technology.js';
import type { Gesture } from '../src/shared/types.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-technology-store-review-')), path = join(directory, 'world.sqlite');
  const store = new Store(path), world = createWorld(51926);
  let closed = false;
  const close = () => { if (!closed) { store.close(); closed = true; } };
  t.after(() => { close(); rmSync(directory, { recursive: true, force: true }); });
  store.save(world);
  return { directory, path, store, world, close };
}

/** A selected laboratory experiment pays real work, energy and substrate. Identity
 * age follows its clock; this fixture does not claim an autonomous ecological run. */
function paidResearch(world: World) {
  const actor = world.people[2]!;
  actor.materials = { wood: 12, stone: 8 }; actor.energy = 1; actor.fatigue = 0;
  const program: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }],
    steps: [{ op: 'form', intensity: 4, shape: 'edge' }, { op: 'compress', intensity: 2 }] };
  actor.technology.project = { kind: 'research', program, parents: [], recipeId: null, progress: 0,
    requiredWork: technologyWorkCost(program), energyPaid: 0, startedAt: world.tick };
  const before = { energy: actor.energy, stone: actor.materials.stone, work: world.technology.ledger.work };
  let succeeded = false, steps = 0;
  while (actor.technology.project && steps++ < 250) {
    world.tick++;
    for (const person of world.people) person.demography.age = world.tick - person.bornAt;
    succeeded = researchTechnology(world, actor);
  }
  assert.equal(actor.technology.project, null); assert.equal(succeeded, true); assert.equal(before.stone - actor.materials.stone, 1);
  assert.ok(actor.energy < before.energy); assert.equal(world.technology.ledger.work - before.work, technologyWorkCost(program));
  assertWorld(world);
  const recipe = world.technology.catalogue!.pending.at(-1)!;
  assert.equal(recipe.inventorId, actor.id); assert.equal(world.technology.history.at(-1)!.recipeId, recipe.id);
  return { actor, recipe };
}

test('a paid new recipe with a forged author cannot overwrite the snapshot or acknowledge either pending queue', t => {
  const lab = fixture(t), baseline = lab.store.load()!.world;
  const { actor, recipe } = paidResearch(lab.world);
  recipe.inventorId = 'missing-inventor';
  assert.equal(lab.world.technology.recipes.find(record => record.id === recipe.id), recipe);
  const journal = lab.world.technology.journal!, catalogue = lab.world.technology.catalogue!;
  const before = structuredClone({ journal, catalogue }), journalRef = journal.pending, catalogueRef = catalogue.pending;
  const durable = lab.store.db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get();
  assert.throws(() => lab.store.save(lab.world), /definition author disagrees with world history/);
  assert.equal(lab.store.db.isTransaction, false);
  assert.deepEqual({ journal, catalogue }, before); assert.equal(journal.pending, journalRef); assert.equal(catalogue.pending, catalogueRef);
  assert.deepEqual(lab.store.db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get(), durable);
  for (const table of ['technology_definitions', 'technology_stats', 'technology_executions']) {
    assert.equal(Number(lab.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n), 0);
  }
  assert.deepEqual(lab.store.load()!.world, baseline);
  recipe.inventorId = actor.id;
  lab.store.save(lab.world);
  const restored = lab.store.load()!.world;
  assert.equal(restored.technology.recipeCounter, 1); assert.equal(restored.technology.ledger.crafted, 1);
  assert.equal(restored.technology.recipes[0]!.inventorId, actor.id);
  assert.equal(journal.pending.length, 0); assert.equal(catalogue.pending.length, 0);
});

test('a failed post-COMMIT cache refresh still reports success and a reopened database contains the tick, history and accepted input', t => {
  const lab = fixture(t), { actor, recipe } = paidResearch(lab.world);
  const gesture: Gesture = { id: 'post-commit-cache-review', kind: 'command', agentId: actor.id, order: 'rest', x: actor.x, y: actor.y };
  const result = stepWorld(lab.world, [gesture], lab.store.context)[0]!;
  assert.equal(result.accepted, true);
  const expectedTick = lab.world.tick, expectedHistory = structuredClone(lab.world.technology.history);
  const acknowledge = lab.store.technologyArchive.acknowledgeHostCommit.bind(lab.store.technologyArchive);
  let committed = 0;
  // This hook runs strictly after the real SQL COMMIT. Closing the connection
  // forces the subsequent PRAGMA optimization to fail without undoing persistence.
  lab.store.technologyArchive.acknowledgeHostCommit = () => { acknowledge(); committed++; lab.close(); };
  assert.doesNotThrow(() => lab.store.save(lab.world, [{ gesture, result }]));
  assert.equal(committed, 1); assert.equal(lab.world.technology.journal!.pending.length, 0);
  assert.equal(lab.world.technology.catalogue!.pending.length, 0);
  const reopened = new Store(lab.path, { readOnly: true });
  try {
    const restored = reopened.load()!.world;
    assert.equal(restored.tick, expectedTick); assert.deepEqual(restored.technology.history, expectedHistory);
    assert.deepEqual(restored, lab.world); assert.deepEqual(reopened.result(gesture), result);
    assert.equal(reopened.catalogueReader.resolve(recipe.id, restored.tick)!.manufactured, 1);
    assert.ok(reopened.technologyArchive.getExecution(expectedHistory.at(-1)!.id, restored.tick));
  } finally { reopened.close(); }
});

test('previous rejects a checksum-consistent uncommitted catalogue boundary before creating a destination', t => {
  const lab = fixture(t); paidResearch(lab.world); lab.store.save(lab.world);
  stepWorld(lab.world); lab.store.save(lab.world);
  const row = lab.store.db.prepare('SELECT body FROM snapshots WHERE slot=1').get() as { body: string };
  const previous = decodeSnapshot(row.body) as World;
  assert.equal(previous.technology.recipeCounter, 1);
  previous.technology.catalogue!.committedThrough = 0;
  previous.technology.catalogue!.pending = [structuredClone(previous.technology.recipes[0]!)];
  assertWorld(previous, 5, lab.store.context); // Physically valid; only its claimed durable boundary is false.
  const body = encodeSnapshot(previous), digest = createHash('sha256').update(body).digest('hex');
  lab.store.db.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=1').run(body, digest);
  const snapshots = lab.store.db.prepare('SELECT slot,body,digest FROM snapshots ORDER BY slot').all();
  const destinationDirectory = join(lab.directory, 'recovery'), destination = join(destinationDirectory, 'world.sqlite');
  assert.throws(() => lab.store.previous(destination), /previous snapshot contains uncommitted definitions/);
  assert.equal(existsSync(destination), false); assert.equal(existsSync(destinationDirectory), false);
  assert.deepEqual(lab.store.db.prepare('SELECT slot,body,digest FROM snapshots ORDER BY slot').all(), snapshots);
  assert.deepEqual(lab.store.load()!.world, lab.world);
});
