import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorld, bindWorldContext, cloneWorld, createWorld, migrateWorld, projectWorld, RULES_VERSION, stepWorld, worldContext,
  type World, type WorldContext } from '../src/world/index.js';
import { enableTechnologyCatalogue, resolveTechnologyRecipe } from '../src/world/technology-catalogue.js';
import { craftTechnology, maintainTechnologyMemory, projectTechnology, recordTechnologyBenefit, technologyWorkCost, useTool, type TechnologyProgram } from '../src/world/technology.js';
import { assertTechnologyCheckpoint, captureTechnologyCheckpoint } from '../src/world/technology-checkpoint.js';
import { observeTechnologyOrganization } from '../src/world/technology-organization.js';
import { cooperate, cooperationOpportunity } from '../src/world/society.js';
import type { LegacyRecord } from '../src/shared/demography.js';

const edge: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }], steps: [{ op: 'form', intensity: 4, shape: 'edge' }, { op: 'compress', intensity: 2 }] };
const programs: TechnologyProgram[] = [edge,
  { inputs: [{ source: 'raw', material: 'wood', mass: 1000 }], steps: [{ op: 'weave', intensity: 4 }] },
  { inputs: [{ source: 'raw', material: 'wood', mass: 1000 }], steps: [{ op: 'form', intensity: 4, shape: 'rod' }] },
];
function fixture() {
  const world = createWorld(51926), maker = world.people[2]!;
  world.reproductionEnabled = false;
  for (const person of world.people) { person.action = 'rest'; person.decisionAt = 100_000; person.target = { x: person.x, y: person.y }; person.hunger = person.thirst = 0.1; person.energy = 1; person.fatigue = 0; }
  maker.materials = { wood: 12, stone: 8 };
  for (const program of programs) {
    maker.action = 'research';
    maker.technology.project = { kind: 'research', program, parents: [], recipeId: null, progress: 0,
      requiredWork: technologyWorkCost(program), energyPaid: 0, startedAt: world.tick };
    while (maker.technology.project) stepWorld(world);
  }
  maker.action = 'rest';
  const receipt = useTool(world, maker, 'cutting')!; recordTechnologyBenefit(world, maker, receipt, 0.25);
  assert.equal(world.technology.recipeCounter, 3);
  const definitions = new Map(world.technology.recipes.map(recipe => [recipe.id, structuredClone(recipe)]));
  const identities = new Map<string, LegacyRecord>(), reads: { id: string; tick: number }[] = [];
  const context: WorldContext = {
    catalogueReader: {
      resolve(id, tick) { reads.push({ id, tick }); const recipe = definitions.get(id); return recipe && recipe.tick <= tick ? structuredClone(recipe) : null; },
      findBySignature(signature, tick) { const recipe = [...definitions.values()].find(recipe => recipe.signature === signature && recipe.tick <= tick); return recipe ? structuredClone(recipe) : null; },
    },
    loadLegacy(id, tick) { const record = identities.get(id); return record && record.diedAt <= tick ? structuredClone(record) : null; },
  };
  enableTechnologyCatalogue(world.technology, { committedThrough: world.technology.recipeCounter, memoryCapacity: 2 });
  world.technology.budgets.maxRecipes = 2;
  world.technology.recipes = world.technology.recipes.slice(-2);
  bindWorldContext(world, context);
  for (const person of world.people) maintainTechnologyMemory(world, person);
  assertWorld(world);
  assert.deepEqual(maker.technology.knownRecipes, ['recipe-3', 'recipe-1']);
  assert.deepEqual(world.technology.recipes.map(recipe => recipe.id), ['recipe-2', 'recipe-3']);
  return { world, maker, context, identities, reads };
}

test('world copies retain their host reader outside snapshot data while plain decoded snapshots require explicit rebinding', () => {
  const { world, context } = fixture(), before = structuredClone(world);
  const draft = cloneWorld(world);
  assert.equal(worldContext(draft).catalogueReader, context.catalogueReader);
  assertWorld(draft); assert.deepEqual(world, before);
  resolveTechnologyRecipe(draft, 'recipe-1');
  assert.deepEqual(world.technology.recipes.map(recipe => recipe.id), ['recipe-2', 'recipe-3']);
  const mapped = [world].map(cloneWorld)[0]!; assertWorld(mapped);
  const decoded: World = JSON.parse(JSON.stringify(world));
  assert.equal(worldContext(decoded).catalogueReader, undefined);
  assert.throws(() => assertWorld(decoded), /reader/);
  const remembered = structuredClone(decoded.people.map(person => person.technology.knownRecipes));
  const migrated = migrateWorld(decoded, context);
  assertWorld(migrated); assert.deepEqual(migrated.people.map(person => person.technology.knownRecipes), remembered);
  assert.equal(Object.keys(migrated).includes('catalogueReader'), false);
});

test('the technology view copies remembered cold identities and never mistakes an owned artifact for instructions', () => {
  const { world, maker, reads } = fixture(), before = structuredClone(world.technology), knowledge = structuredClone(maker.technology);
  reads.length = 0;
  const view = projectTechnology(world), remembered = view.knowledge!.find(person => person.actorId === maker.id)!;
  assert.deepEqual(remembered.recipeIds, ['recipe-3', 'recipe-1']);
  assert.equal(view.recipes.some(recipe => recipe.id === 'recipe-1'), false, 'a remembered identity need not have resident details');
  assert.ok(view.items.some(item => item.ownerId === maker.id && item.recipeId === 'recipe-2'));
  assert.equal(remembered.recipeIds.includes('recipe-2'), false, 'possessing the forgotten product does not restore instructions');
  assert.equal(view.knowledge!.length, world.people.length); assert.deepEqual(reads, []);
  assert.deepEqual(world.technology, before); assert.deepEqual(maker.technology, knowledge);
  remembered.recipeIds.push('recipe-999');
  assert.deepEqual(maker.technology, knowledge); assert.deepEqual(world.technology, before);
});

test('a cloned world can complete paid cold fabrication using its implicit bound context', () => {
  const { world, maker } = fixture(), draft = cloneWorld(world), actor = draft.people.find(person => person.id === maker.id)!;
  const before = { products: draft.technology.itemCounter, stone: actor.materials.stone, work: draft.technology.ledger.work };
  actor.action = 'craft'; craftTechnology(draft, actor, 'recipe-1');
  assert.equal(actor.technology.project?.recipeId, 'recipe-1');
  while (actor.technology.project) stepWorld(draft);
  assert.equal(draft.technology.itemCounter, before.products + 1); assert.equal(before.stone - actor.materials.stone, 1);
  assert.ok(draft.technology.ledger.work - before.work >= technologyWorkCost(edge));
  assert.equal(world.technology.itemCounter, before.products); assertWorld(draft);
});

test('local cooperation chooses a practiced cold recipe and teaches it with cost and no archived knowledge grant', () => {
  const { world, maker } = fixture(), learner = world.people[3]!;
  for (const person of world.people) { person.x = 10; person.y = 20; person.target = { x: 10, y: 20 }; person.materials = { wood: 0, stone: 0 }; }
  for (const person of [maker, learner]) { person.x = 36; person.y = 12; person.target = { x: 36, y: 12 }; }
  const energy = maker.energy, work = world.technology.ledger.work;
  assert.deepEqual(learner.technology.knownRecipes, []);
  const opportunity = cooperationOpportunity(world, maker)!;
  assert.equal(opportunity.kind, 'teach'); assert.equal(opportunity.recipeId, 'recipe-1');
  assert.deepEqual(learner.technology.knownRecipes, [], 'choosing an opportunity cannot teach');
  assert.equal(cooperate(world, maker, event => {
    const result = { ...event, id: `e${++world.eventCounter}`, tick: world.tick }; world.events.push(result); return result;
  }), true);
  assert.deepEqual(learner.technology.knownRecipes, ['recipe-1']); assert.equal(learner.technology.items.length, 0);
  assert.ok(Math.abs(energy - maker.energy - 0.003) < 1e-12); assert.equal(world.technology.ledger.work - work, 1);
  assertWorld(world);
});

test('checkpoint and organization verification resolve cold definitions without changing the cache or claiming older statistics', () => {
  const { world, reads } = fixture(), initialCache = structuredClone(world.technology.recipes);
  const observation = observeTechnologyOrganization(world.technology, world.people, world.tick);
  assert.equal(observation.diagnostics.some(message => message.startsWith('unverified-recipe:')), false);
  assert.ok(observation.observation.processes.length > 0);
  assert.deepEqual(world.technology.recipes, initialCache);
  world.technology.checkpoint = captureTechnologyCheckpoint(world.technology, world.people, world.tick, 'migration');
  stepWorld(world);
  const cache = structuredClone(world.technology.recipes), known = structuredClone(world.people.map(person => person.technology.knownRecipes));
  const cold = world.technology.checkpoint.inventories.flatMap(inventory => inventory.items).find(item => !cache.some(recipe => recipe.id === item.recipeId))!.recipeId;
  reads.length = 0; assertTechnologyCheckpoint(world.technology, world.tick);
  assert.ok(reads.some(read => read.id === cold)); assert.ok(reads.every(read => read.tick === world.tick));
  assert.deepEqual(world.technology.recipes, cache); assert.deepEqual(world.people.map(person => person.technology.knownRecipes), known);
  assertWorld(world);
  const view = projectWorld(world);
  assert.equal(view.technology!.dynamics.recipes, 3); assert.ok(view.technology!.recipes.length <= 2);
});

test('technology authors remain valid through a pending estate and a cold identity archive, with birth and death dates enforced', () => {
  const { world, maker, context, identities } = fixture();
  maker.demography.health = 0.000001; maker.demography.vitality = 0; maker.hunger = maker.thirst = 1; maker.energy = 0.01;
  stepWorld(world);
  assert.equal(world.people.some(person => person.id === maker.id), false);
  const record = world.retiredLegacy.find(person => person.id === maker.id)!; assert.ok(record);
  world.legacy = world.legacy.filter(person => person.id !== maker.id);
  assertWorld(world, RULES_VERSION, context);
  identities.set(record.id, structuredClone(record)); world.retiredLegacy = [];
  const original = structuredClone(world);
  assertWorld(world, RULES_VERSION, context); assert.deepEqual(world, original, 'archive identity resolution cannot grow a lifetime RAM cache');
  assertWorld(cloneWorld(world));
  const broken = cloneWorld(world, { ...context, loadLegacy: () => null });
  assert.throws(() => assertWorld(broken), /procedural/);
  for (const variation of ['before-birth', 'after-death'] as const) {
    const invalid = cloneWorld(world), forged = structuredClone(record);
    if (variation === 'before-birth') forged.bornAt = world.tick;
    else forged.diedAt = 0;
    bindWorldContext(invalid, { ...context, loadLegacy: () => forged });
    assert.throws(() => assertWorld(invalid));
  }
});
