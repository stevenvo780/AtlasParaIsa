import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, SessionRevoked } from '../src/server/store.js';
import { decodeSnapshot, encodeSnapshot } from '../src/server/snapshot.js';
import { assertWorld, createWorld, stepWorld, tileAt, type Person, type World } from '../src/world/index.js';
import { hasTechnologyFunction, resolveTechnologyRecipe, technologyCatalogueTotals } from '../src/world/technology-catalogue.js';
import { advanceTechnologyCheckpoint } from '../src/world/technology-checkpoint.js';
import { assertTechnology, craftTechnology, maintainTechnologyMemory, projectTechnology, proposeTechnologyProgram,
  researchTechnology, technologyWorkCost, transferTechnologyItem, type TechnologyProgram, type TechnologyRecipe } from '../src/world/technology.js';
import type { Gesture } from '../src/shared/types.js';

interface Laboratory {
  directory: string;
  path: string;
  store: Store;
  world: World;
  inventorId: string;
  recipientId: string;
  session: string;
  supplied: { wood: number; stone: number; energy: number; fatigueRemoved: number };
  reload(): void;
}

/** Synthetic laboratory: the experimenter chooses programs, supplies raw stock
 * and restores work readiness. These tests do not claim autonomous discovery,
 * survival, or maintenance. Counters, products and receipts come from the engine. */
function laboratory(t: TestContext): Laboratory {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-technology-store-catalogue-'));
  const path = join(directory, 'world.sqlite'), store = new Store(path), world = createWorld(51926);
  const inventor = world.people[2]!, recipient = world.people[3]!;
  recipient.x = inventor.x; recipient.y = inventor.y; recipient.target = { x: recipient.x, y: recipient.y };
  world.reproductionEnabled = false;
  store.save(world);
  assert.ok(world.technology.catalogue, 'Store must enable and bind its durable catalogue');
  world.technology.budgets.maxRecipes = 2;
  world.technology.budgets.maxItems = 2;
  world.technology.catalogue.memoryCapacity = 2;
  for (const person of world.people) maintainTechnologyMemory(world, person);
  const session = 'synthetic-catalogue-session';
  store.addSession(session, Date.now() + 600_000);
  store.save(world, [], [session]);
  const lab: Laboratory = { directory, path, store, world, inventorId: inventor.id, recipientId: recipient.id, session,
    supplied: { wood: 0, stone: 0, energy: 0, fatigueRemoved: 0 },
    reload() {
      lab.store.close(); lab.store = new Store(path);
      lab.world = lab.store.load()!.world;
      assert.equal(lab.store.sessionValid(session), true, 'cold reload preserves the existing session');
    },
  };
  t.after(() => { lab.store.close(); rmSync(directory, { recursive: true, force: true }); });
  return lab;
}
const person = (lab: Laboratory, id = lab.inventorId): Person => {
  const found = lab.world.people.find(actor => actor.id === id); assert.ok(found); return found;
};
function supply(lab: Laboratory, actor: Person): void {
  lab.supplied.wood += 12 - actor.materials.wood; lab.supplied.stone += 8 - actor.materials.stone;
  lab.supplied.energy += 1 - actor.energy; lab.supplied.fatigueRemoved += actor.fatigue;
  actor.materials.wood = 12; actor.materials.stone = 8; actor.energy = 1; actor.fatigue = 0;
}
function tickLaboratory(world: World): void {
  world.tick++;
  // Advance identity age once; this laboratory does not execute an ecological trajectory.
  for (const actor of world.people) actor.demography.age = world.tick - actor.bornAt;
}
function finish(lab: Laboratory, actor: Person): TechnologyRecipe {
  const project = actor.technology.project; assert.ok(project);
  const workBefore = lab.world.technology.ledger.work, energyBefore = actor.energy;
  const required = project.requiredWork - project.progress;
  assert.ok(required > 0 && required <= 250);
  let succeeded = false, steps = 0;
  while (actor.technology.project && steps++ < 250) {
    tickLaboratory(lab.world);
    succeeded = project.kind === 'research' ? researchTechnology(lab.world, actor) : craftTechnology(lab.world, actor);
  }
  assert.equal(actor.technology.project, null); assert.equal(succeeded, true);
  assert.equal(lab.world.technology.ledger.work - workBefore, required);
  assert.ok(actor.energy < energyBefore);
  advanceTechnologyCheckpoint(lab.world.technology, lab.world.people, lab.world.tick);
  assertTechnology(lab.world);
  assert.ok(lab.world.technology.recipes.length <= 2);
  for (const p of lab.world.people) assert.ok(p.technology.knownRecipes.length <= 2);
  const item = actor.technology.items.at(-1)!;
  const recipe = resolveTechnologyRecipe(lab.world, item.recipeId!); assert.ok(recipe);
  const receipt = lab.world.technology.history.at(-1)!;
  assert.equal(receipt.success, true); assert.equal(receipt.work, project.requiredWork); assert.ok(receipt.energy > 0);
  assert.equal(receipt.recipeId, recipe.id);
  assert.equal(projectTechnology(lab.world).dynamics.massError, 0);
  return structuredClone(recipe);
}
function discover(lab: Laboratory, program: TechnologyProgram, parents: string[] = [], actorId = lab.inventorId): TechnologyRecipe {
  const actor = person(lab, actorId); supply(lab, actor);
  actor.technology.project = { kind: 'research', program: structuredClone(program), parents: [...parents], recipeId: null,
    progress: 0, requiredWork: technologyWorkCost(program), energyPaid: 0, startedAt: lab.world.tick };
  return finish(lab, actor);
}
function save(lab: Laboratory): void { lab.store.save(lab.world, [], [lab.session]); }
function count(store: Store, table: string): number {
  return Number(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
}
/** Same edge geometry with distinct paid instruction sequences. This deliberately
 * tests global signature storage, not 257 claims of a new physical function. */
function edgeProgram(index: number): TechnologyProgram {
  return { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }], steps: [
    { op: 'form', intensity: 4, shape: 'edge' },
    ...Array.from({ length: 5 }, (_, digit) => ({ op: 'cool' as const, intensity: 1 + Math.floor(index / 4 ** digit) % 4 })),
  ] };
}
function coldFirst(lab: Laboratory): void {
  resolveTechnologyRecipe(lab.world, 'recipe-2'); resolveTechnologyRecipe(lab.world, 'recipe-3');
  assert.equal(lab.world.technology.recipes.some(recipe => recipe.id === 'recipe-1'), false);
}

test('257 paid programs survive a two-entry cache, bounded memory, periodic commits and cold authenticated reloads', t => {
  const lab = laboratory(t); let totalWork = 0, first: TechnologyRecipe | undefined;
  for (let index = 0; index < 257; index++) {
    const program = edgeProgram(index), recipe = discover(lab, program);
    first ??= recipe; totalWork += technologyWorkCost(program);
    assert.equal(recipe.id, `recipe-${index + 1}`); assert.equal(recipe.manufactured, 1);
    assert.equal(recipe.generation, 1); assert.equal(recipe.novelty, index === 0 ? 'both' : 'program');
    assert.equal(lab.world.technology.recipeCounter, index + 1);
    assert.ok(lab.world.technology.catalogue!.pending.length <= 16);
    if ((index + 1) % 16 === 0 || index === 256) {
      save(lab); assert.equal(lab.world.technology.catalogue!.pending.length, 0);
      assert.equal(lab.world.technology.journal!.pending.length, 0);
    }
    if ((index + 1) % 64 === 0) lab.reload();
  }
  assert.equal(lab.world.technology.ledger.work, totalWork);
  assert.equal(lab.world.technology.ledger.imported.stone, 257_000);
  assert.equal(lab.world.technology.ledger.crafted, 257); assert.ok(lab.supplied.stone > 0 && lab.supplied.energy > 0);
  assert.equal(count(lab.store, 'technology_definitions'), 257);
  assert.ok(count(lab.store, 'technology_executions') > 256, 'recycling receipts are retained too');
  lab.reload();
  const beforeRead = structuredClone(person(lab, lab.recipientId).technology);
  const archived = lab.store.catalogueReader.resolve(first!.id, lab.world.tick); assert.ok(archived);
  assert.deepEqual(archived, first);
  assert.equal(lab.store.catalogueReader.resolve(first!.id, first!.tick - 1), null);
  assert.deepEqual(lab.store.catalogueReader.findBySignature(first!.signature, lab.world.tick), first);
  assert.deepEqual(person(lab, lab.recipientId).technology, beforeRead, 'lookup grants no instructions or experience');
  assert.equal(craftTechnology(lab.world, person(lab, lab.recipientId), first!.id), false);
  assert.deepEqual(person(lab, lab.recipientId).technology.knownRecipes, []);
  assert.equal(hasTechnologyFunction(lab.world, first!.capacities), true);
  assert.deepEqual(technologyCatalogueTotals(lab.world), { recipes: 257, maxGeneration: 1, manufactured: 257, uses: 0, utility: 0, functionalDiversity: 1 });
  assert.equal(projectTechnology(lab.world).dynamics.recipes, 257);
  assert.ok(proposeTechnologyProgram(lab.world, person(lab)), 'a full resident cache does not end future research');
  assert.ok(lab.world.technology.recipes.length <= 2); assertWorld(lab.world);
});

test('forty paid material generations consume their actual parent product and reload cold ancestors', t => {
  const lab = laboratory(t); let parent: TechnologyRecipe | undefined, parentItem: string | undefined;
  for (let generation = 1; generation <= 40; generation++) {
    if (generation >= 4) {
      resolveTechnologyRecipe(lab.world, 'recipe-1'); resolveTechnologyRecipe(lab.world, 'recipe-2');
      assert.equal(lab.world.technology.recipes.some(recipe => recipe.id === parent!.id), false);
    }
    // Keep one real parent-39 fragment for the later cold fabrication control.
    const inputMass = generation === 40 ? 1000 : 2000;
    const program: TechnologyProgram = { inputs: [parent ? { source: 'product', recipeId: parent.id, mass: inputMass }
      : { source: 'raw', material: 'stone', mass: inputMass }], steps: [{ op: 'compress', intensity: 1 }] };
    const recipe = discover(lab, program, parent ? [parent.id] : []);
    const output = person(lab).technology.items.at(-1)!;
    assert.equal(recipe.generation, generation); assert.equal(output.generation, generation);
    assert.equal(output.mass, inputMass); assert.equal(person(lab).technology.items.length, generation === 40 ? 2 : 1);
    if (parent) {
      assert.deepEqual(recipe.parents, [parent.id]); assert.ok(output.parentItems.includes(parentItem!));
      assert.ok(lab.world.technology.history.at(-1)!.inputs.some(input => input.resourceId === `recipe:${parent!.id}` && input.mass === inputMass));
    }
    parent = recipe; parentItem = output.id; save(lab); lab.reload();
  }
  assert.equal(lab.world.technology.ledger.imported.stone, 2000, 'the same paid stock is physically reused');
  assert.equal(count(lab.store, 'technology_definitions'), 40);
  assert.equal(lab.store.catalogueReader.resolve(parent!.id, lab.world.tick)!.generation, 40);
  assert.equal(technologyCatalogueTotals(lab.world).maxGeneration, 40);
  resolveTechnologyRecipe(lab.world, 'recipe-1'); resolveTechnologyRecipe(lab.world, 'recipe-2');
  assert.equal(lab.world.technology.recipes.some(recipe => recipe.id === parent!.id), false);
  supply(lab, person(lab));
  craftTechnology(lab.world, person(lab), parent!.id);
  const fabricated = finish(lab, person(lab)); assert.equal(fabricated.id, parent!.id); assert.equal(fabricated.manufactured, 2);
  assert.ok(person(lab).technology.items.every(item => item.generation === 40 && item.mass === 1000));
  assert.equal(lab.world.technology.ledger.crafted, 41); assert.equal(lab.world.technology.recipeCounter, 40);
  save(lab); lab.reload();
  craftTechnology(lab.world, person(lab), parent!.id);
  // The next copy must now fail: both real parent-39 fragments were consumed.
  assert.equal(person(lab).technology.project, null); assert.equal(lab.world.technology.ledger.crafted, 41);
  assert.equal(lab.world.technology.ledger.imported.stone, 2000); assertWorld(lab.world);
});

test('a cold owned tool earns persisted statistics only after actual finite harvesting, never through archive lookup', t => {
  const lab = laboratory(t), first = discover(lab, edgeProgram(0));
  assert.equal(transferTechnologyItem(lab.world, person(lab), person(lab, lab.recipientId), person(lab).technology.items[0]!.id), true);
  discover(lab, edgeProgram(1)); discover(lab, edgeProgram(2)); save(lab); lab.reload(); coldFirst(lab);
  const initialObservationTick = lab.world.tick;
  assert.equal(lab.store.catalogueReader.resolve(first.id, lab.world.tick)!.utility, 0);
  assert.deepEqual(person(lab, lab.recipientId).technology.knownRecipes, []);
  const worker = person(lab, lab.recipientId), tile = tileAt(lab.world, worker)!;
  lab.world.cooperationEnabled = false; lab.world.weather = 'clear';
  for (const p of lab.world.people) { p.action = 'approach'; p.target = { x: p.x, y: p.y }; p.decisionAt = lab.world.tick + 1000; }
  worker.action = 'gather'; worker.work = 0; worker.materials.wood = 0;
  worker.hunger = worker.thirst = worker.fatigue = 0.2; worker.energy = 0.8;
  tile.wood = 8;
  const previousUses = lab.world.technology.ledger.toolUses, beforeMass = worker.technology.items[0]!.mass;
  for (let steps = 0; steps < 24 && lab.world.technology.ledger.toolUses === previousUses; steps++) stepWorld(lab.world, [], lab.store.context);
  assert.equal(lab.world.technology.ledger.toolUses, previousUses + 1);
  const gained = worker.materials.wood; assert.ok(gained > 1 && gained <= 2);
  assert.ok(worker.technology.items[0]!.mass < beforeMass);
  const actual = resolveTechnologyRecipe(lab.world, first.id)!;
  assert.equal(actual.uses, 1); assert.equal(actual.utility, gained - 1);
  assert.deepEqual(worker.technology.knownRecipes, [], 'physical use still does not teach fabrication');
  const observedTick = lab.world.tick; coldFirst(lab);
  assert.ok(lab.world.technology.catalogue!.pending.some(recipe => recipe.id === first.id));
  save(lab); lab.reload();
  assert.equal(lab.store.catalogueReader.resolve(first.id, initialObservationTick)!.utility, 0);
  assert.equal(lab.store.catalogueReader.resolve(first.id, observedTick)!.utility, gained - 1);
  assert.equal(technologyCatalogueTotals(lab.world).uses, 1); assert.equal(technologyCatalogueTotals(lab.world).utility, gained - 1);
  assert.equal(count(lab.store, 'technology_stats'), 4); assertWorld(lab.world);
});

test('paid rediscovery keeps the archived deceased inventor after identity-cache eviction without teaching the reader', t => {
  const lab = laboratory(t), first = discover(lab, edgeProgram(0));
  discover(lab, edgeProgram(1)); discover(lab, edgeProgram(2)); save(lab);
  for (const p of lab.world.people) { p.action = 'approach'; p.target = { x: p.x, y: p.y }; p.decisionAt = lab.world.tick + 1000; }
  const inventor = person(lab);
  // Explicit induced-deprivation fixture: death itself, estate and identity record
  // must still be executed by the real post-action demography transition.
  inventor.thirst = 1; inventor.hunger = 0.5; inventor.demography.health = Number.MIN_VALUE;
  stepWorld(lab.world, [], lab.store.context);
  assert.equal(lab.world.people.some(p => p.id === inventor.id), false);
  assert.ok(lab.world.retiredLegacy.some(record => record.id === inventor.id));
  save(lab);
  assert.equal(lab.store.loadLegacy(inventor.id)!.cause, 'dehydration');
  lab.world.legacy = lab.world.legacy.filter(record => record.id !== inventor.id); // Evict only an already durable read-cache entry.
  save(lab); lab.reload(); coldFirst(lab);
  assert.equal(lab.world.legacy.some(record => record.id === inventor.id), false);
  const learner = person(lab, lab.recipientId), beforeKnowledge = structuredClone(learner.technology.knownRecipes);
  const lookup = lab.store.catalogueReader.resolve(first.id, lab.world.tick); assert.ok(lookup);
  assert.deepEqual(learner.technology.knownRecipes, beforeKnowledge);
  const counter = lab.world.technology.recipeCounter, imported = lab.world.technology.ledger.imported.stone;
  const rediscovered = discover(lab, edgeProgram(0), [], learner.id);
  for (const key of ['id', 'signature', 'inventorId', 'tick', 'generation', 'parents'] as const) assert.deepEqual(rediscovered[key], first[key]);
  assert.equal(lab.world.technology.recipeCounter, counter);
  assert.equal(lab.world.technology.ledger.imported.stone - imported, 1000);
  assert.ok(learner.technology.knownRecipes.includes(first.id)); assert.equal(rediscovered.manufactured, 2);
  save(lab); lab.reload();
  assert.equal(lab.store.catalogueReader.resolve(first.id, lab.world.tick)!.inventorId, inventor.id);
  assert.equal(lab.store.catalogueReader.resolve(first.id, lab.world.tick)!.manufactured, 2);
  assert.equal(count(lab.store, 'technology_definitions'), 3); assertWorld(lab.world);
});

test('SQL failure preserves both pending journals, rejects acknowledgement, and retries exactly once', t => {
  const lab = laboratory(t);
  discover(lab, edgeProgram(0)); discover(lab, edgeProgram(1)); discover(lab, edgeProgram(2)); save(lab);
  const baseline = lab.store.load()!.world;
  const tables = ['technology_definitions', 'technology_stats', 'technology_executions', 'inputs'];
  const counts = tables.map(table => count(lab.store, table));
  discover(lab, edgeProgram(3));
  const actor = person(lab, lab.recipientId);
  const gesture: Gesture = { id: 'synthetic-catalogue-order', kind: 'command', agentId: actor.id, order: 'rest', x: actor.x, y: actor.y };
  const result = stepWorld(lab.world, [gesture], lab.store.context)[0]!; assert.equal(result.accepted, true);
  const journal = lab.world.technology.journal!, catalogue = lab.world.technology.catalogue!;
  const pending = structuredClone({ journal, catalogue }), journalRef = journal.pending, catalogueRef = catalogue.pending;
  lab.store.db.exec("CREATE TRIGGER fail_catalogue_snapshot BEFORE INSERT ON snapshots WHEN NEW.slot=0 BEGIN SELECT RAISE(ABORT,'synthetic catalogue rollback'); END;");
  assert.throws(() => lab.store.save(lab.world, [{ gesture, result }], [lab.session]), /synthetic catalogue rollback/);
  assert.equal(lab.store.db.isTransaction, false);
  assert.deepEqual({ journal, catalogue }, pending); assert.equal(journal.pending, journalRef); assert.equal(catalogue.pending, catalogueRef);
  assert.deepEqual(tables.map(table => count(lab.store, table)), counts);
  assert.equal(lab.store.result(gesture), null); assert.deepEqual(lab.store.load()!.world, baseline);
  const cold = new Store(lab.path, { readOnly: true });
  try { assert.deepEqual(cold.load()!.world, baseline); assert.equal(cold.sessionValid(lab.session), true); assert.equal(cold.result(gesture), null); }
  finally { cold.close(); }
  lab.store.db.exec('DROP TRIGGER fail_catalogue_snapshot');
  lab.store.save(lab.world, [{ gesture, result }], [lab.session]);
  assert.equal(journal.pending.length, 0); assert.equal(catalogue.pending.length, 0);
  assert.equal(count(lab.store, 'technology_definitions'), counts[0]! + 1);
  assert.equal(count(lab.store, 'inputs'), counts[3]! + 1); assert.deepEqual(lab.store.result(gesture), result);
  lab.reload(); assert.equal(lab.world.technology.recipeCounter, 4); assert.deepEqual(lab.store.result(gesture), result);
});

test('a revoked session cannot commit pending catalogue state and a new allowed session can', t => {
  const lab = laboratory(t), baseline = lab.store.load()!.world;
  discover(lab, edgeProgram(0));
  const pending = structuredClone({ journal: lab.world.technology.journal, catalogue: lab.world.technology.catalogue });
  lab.store.revoke(lab.session);
  assert.throws(() => save(lab), SessionRevoked);
  assert.deepEqual({ journal: lab.world.technology.journal, catalogue: lab.world.technology.catalogue }, pending);
  assert.equal(count(lab.store, 'technology_definitions'), 0); assert.deepEqual(lab.store.load()!.world, baseline);
  lab.store.addSession(lab.session, Date.now() + 600_000); save(lab); lab.reload();
  assert.equal(lab.world.technology.recipeCounter, 1); assert.equal(lab.world.technology.catalogue!.pending.length, 0);
});

function pendingCommand(lab: Laboratory, suffix: string) {
  for (const p of lab.world.people) { p.action = 'approach'; p.target = { x: p.x, y: p.y }; p.decisionAt = lab.world.tick + 1000; }
  const actor = person(lab, lab.recipientId);
  const gesture: Gesture = { id: `synthetic-invalid-catalogue-${suffix}`, kind: 'command', agentId: actor.id,
    order: 'rest', x: actor.x, y: actor.y };
  const result = stepWorld(lab.world, [gesture], lab.store.context)[0]!;
  assert.equal(result.accepted, true); assert.equal(lab.world.technology.catalogue!.pending.length, 0);
  return { gesture, result };
}

test('resident statistics modified without a pending update cannot be acknowledged or silently repaired', t => {
  const lab = laboratory(t);
  discover(lab, edgeProgram(0)); discover(lab, edgeProgram(1)); discover(lab, edgeProgram(2)); save(lab);
  const baseline = lab.store.load()!.world, input = pendingCommand(lab, 'resident');
  const recipe = lab.world.technology.recipes.at(-1)!; recipe.utility += 0.5;
  const pending = structuredClone(lab.world.technology.catalogue);
  assert.throws(() => lab.store.save(lab.world, [input], [lab.session]));
  assert.deepEqual(lab.world.technology.catalogue, pending);
  assert.equal(recipe.utility, 0.5, 'validation does not overwrite the corrupted candidate with a database value');
  assert.equal(lab.store.result(input.gesture), null);
  assert.deepEqual(lab.store.load()!.world, baseline);
  assert.equal(count(lab.store, 'technology_definitions'), 3); assert.equal(count(lab.store, 'technology_stats'), 3);
});

test('lifetime utility and function-bit claims without pending records are rejected before acknowledgement', t => {
  for (const corruption of ['utility', 'functions'] as const) {
    const lab = laboratory(t);
    discover(lab, edgeProgram(0)); discover(lab, edgeProgram(1)); discover(lab, edgeProgram(2)); save(lab);
    const baseline = lab.store.load()!.world, input = pendingCommand(lab, corruption);
    const catalogue = lab.world.technology.catalogue!;
    if (corruption === 'utility') catalogue.totals.utility += 0.5;
    else {
      // Keep the bitmap count locally coherent: only comparison with real
      // archived/pending definitions can disprove this invented function.
      let code = 0;
      while (catalogue.functions[code >>> 5]! & (1 << (code & 31))) code++;
      catalogue.functions[code >>> 5] = (catalogue.functions[code >>> 5]! | (1 << (code & 31))) >>> 0;
      catalogue.totals.functionalDiversity++;
    }
    const pending = structuredClone(catalogue);
    assert.throws(() => lab.store.save(lab.world, [input], [lab.session]));
    assert.deepEqual(catalogue, pending); assert.equal(catalogue.pending.length, 0);
    assert.equal(lab.store.result(input.gesture), null); assert.deepEqual(lab.store.load()!.world, baseline);
    assert.equal(count(lab.store, 'technology_stats'), 3); assert.equal(count(lab.store, 'technology_definitions'), 3);
  }
});

test('missing cold definitions and checksum-consistent fabricated lifetime totals fail closed', t => {
  for (const corruption of ['definition', 'totals'] as const) {
    const lab = laboratory(t);
    discover(lab, edgeProgram(0)); discover(lab, edgeProgram(1)); discover(lab, edgeProgram(2)); save(lab); coldFirst(lab); save(lab);
    if (corruption === 'definition') lab.store.db.prepare('DELETE FROM technology_definitions WHERE id=?').run('recipe-1');
    else {
      const row = lab.store.db.prepare('SELECT body FROM snapshots WHERE slot=0').get() as { body: string };
      const world = decodeSnapshot(row.body) as World; world.technology.catalogue!.totals.utility += 1;
      const body = encodeSnapshot(world), digest = createHash('sha256').update(body).digest('hex');
      lab.store.db.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=0').run(body, digest);
    }
    assert.throws(() => lab.store.load());
    if (corruption === 'definition') assert.equal(count(lab.store, 'technology_definitions'), 2, 'load never regenerates the erased definition');
  }
});
