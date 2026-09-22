import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneWorld, createWorld, stepWorld, tileAt, type Person, type World } from '../src/world/index.js';
import { cooperate, cooperationOpportunity } from '../src/world/society.js';
import { assertTechnology, craftTechnology, researchTechnology, shareTechnology, technologyStock, technologyWorkCost, transferTechnologyItem, type TechnologyProgram } from '../src/world/technology.js';
import { recordChronicleEvent } from '../src/world/chronicle-journal.js';
import type { ChronicleEvent } from '../src/shared/types.js';

const edge: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }], steps: [{ op: 'form', intensity: 4, shape: 'edge' }, { op: 'compress', intensity: 2 }] };
function scene() {
  const world = createWorld(51926), teacher = world.people[2]!, learner = world.people[3]!;
  for (const person of world.people) {
    person.x = 10; person.y = 20; person.target = { x: 10, y: 20 }; person.action = 'rest';
    person.skills = {}; person.materials = { wood: 0, stone: 0 }; person.lastSocial = -30;
    person.energy = 1; person.fatigue = person.hunger = person.thirst = 0;
    person.decisionAt = 1_000_000;
  }
  for (const person of [teacher, learner]) { person.x = 36; person.y = 12; person.target = { x: 36, y: 12 }; }
  teacher.materials = { wood: 12, stone: 8 };
  return { world, teacher, learner };
}
function emit(world: World) { return (event: Omit<ChronicleEvent, 'id' | 'tick'>) => {
  const result = recordChronicleEvent(world, event); world.events.push(result); return result;
}; }
function discover(world: World, person: Person, program = edge) {
  person.technology.project = { kind: 'research', program: structuredClone(program), parents: [], recipeId: null,
    progress: 0, requiredWork: technologyWorkCost(program), energyPaid: 0, startedAt: world.tick };
  while (person.technology.project) { world.tick++; researchTechnology(world, person); }
  return world.technology.recipes.at(-1)!;
}

test('recipe demonstrations stop for redundant variants without evicting useful local instructions or inflating counters', () => {
  const { world, teacher, learner } = scene(); const original = discover(world, teacher);
  assert.equal(cooperate(world, teacher, emit(world)), true);
  const variation = structuredClone(edge); variation.steps[1]!.intensity = 3;
  const redundant = discover(world, teacher, variation); assert.notEqual(original.id, redundant.id);
  world.tick += 30;
  const before = structuredClone({ knowledge: learner.technology, energy: teacher.energy, totals: world.totals });
  assert.equal(cooperationOpportunity(world, teacher), undefined);
  assert.equal(cooperate(world, teacher, emit(world)), false);
  assert.deepEqual({ knowledge: learner.technology, energy: teacher.energy, totals: world.totals }, before);
  assertTechnology(world);
});

test('recipe teaching requires observable feedstock, respects locality and does not grant the prospective supplies', () => {
  const { world, teacher, learner } = scene(); const recipe = discover(world, teacher);
  teacher.materials = { wood: 0, stone: 0 };
  for (const tile of world.tiles) tile.stone = 0;
  assert.equal(cooperationOpportunity(world, teacher), undefined);
  tileAt(world, { x: 28, y: 12 })!.stone = 1;
  assert.equal(cooperationOpportunity(world, teacher), undefined, 'distant material cannot justify a local lesson');
  tileAt(world, { x: 29, y: 12 })!.stone = 1;
  assert.equal(cooperationOpportunity(world, teacher)?.recipeId, recipe.id);
  const before = structuredClone({ materials: learner.materials, items: learner.technology.items, source: tileAt(world, { x: 29, y: 12 }) });
  assert.equal(cooperate(world, teacher, emit(world)), true);
  assert.deepEqual({ materials: learner.materials, items: learner.technology.items, source: tileAt(world, { x: 29, y: 12 }) }, before);
  assert.equal(learner.technology.competence[recipe.id], undefined);
  assertTechnology(world);
});

test('a complementary instruction remains teachable when its stronger known alternative has no local substrate', () => {
  const { world, teacher, learner } = scene(); const original = discover(world, teacher);
  assert.equal(shareTechnology(world, teacher, learner, undefined, original.id), true);
  const alternative = structuredClone(edge); alternative.inputs[0]!.material = 'wood';
  const replacement = discover(world, teacher, alternative);
  teacher.materials.stone = 0; for (const tile of world.tiles) tile.stone = 0;
  assert.equal(cooperationOpportunity(world, teacher)?.recipeId, replacement.id);
  assert.equal(cooperate(world, teacher, emit(world)), true);
  assert.deepEqual(learner.technology.knownRecipes, [original.id, replacement.id]);
  assertTechnology(world);
});

test('a local taught procedure can be reproduced and used with paid work, consumed stock and material benefit', () => {
  const { world, teacher, learner } = scene(); const recipe = discover(world, teacher);
  learner.materials.stone = 1;
  const disabled = cloneWorld(world); disabled.learningEnabled = false;
  assert.equal(cooperate(disabled, disabled.people[2]!, emit(disabled)), false);
  assert.equal(craftTechnology(disabled, disabled.people[3]!, recipe.id), false);
  assert.equal(cooperate(world, teacher, emit(world)), true);
  const work = world.technology.ledger.work, energy = learner.energy;
  craftTechnology(world, learner, recipe.id);
  while (learner.technology.project) { world.tick++; craftTechnology(world, learner, recipe.id); }
  assert.equal(learner.materials.stone, 0); assert.ok(learner.energy < energy);
  assert.equal(world.technology.ledger.work - work, technologyWorkCost(edge));
  assert.equal(learner.technology.items[0]!.recipeId, recipe.id);
  assert.equal(learner.technology.competence[recipe.id]!.successes, 1);
  const source = tileAt(world, learner)!; source.wood = 3;
  learner.action = 'gather'; learner.work = 17;
  const withoutTool = cloneWorld(world), controlLearner = withoutTool.people[3]!;
  assert.equal(transferTechnologyItem(withoutTool, controlLearner, withoutTool.people[2]!, controlLearner.technology.items[0]!.id), true);
  const stock = technologyStock(learner).reduce((total, entry) => total + entry.mass, 0);
  stepWorld(world); stepWorld(withoutTool);
  assert.ok(learner.materials.wood > controlLearner.materials.wood);
  assert.ok(source.wood < tileAt(withoutTool, learner)!.wood!);
  assert.ok(learner.technology.competence[recipe.id]!.benefit > 0);
  assert.equal(technologyStock(learner).reduce((total, entry) => total + entry.mass, 0), stock, 'tool wear becomes carried residue');
  assert.equal(learner.technology.learnedFrom[0]!.teacherId, teacher.id);
  assertTechnology(world);
});
