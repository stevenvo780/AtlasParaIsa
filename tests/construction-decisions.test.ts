import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld, tileAt } from '../src/world/index.js';
import { completeConstruction, constructionCost } from '../src/world/inventions.js';

/** Decision comparison with identical bodily state and stocks, changing only
 * the presence/condition of a real paid roof six cells away. */
function scene(condition?: number) {
  const world = createWorld(51926), person = world.people[2]!;
  world.people = [person]; world.structures = []; world.places = []; world.animals = [];
  world.noveltyEnabled = world.cooperationEnabled = world.reproductionEnabled = false;
  world.learningEnabled = world.adaptationEnabled = false; world.tick = 600;
  for (const tile of world.tiles) Object.assign(tile, { terrain: 'meadow', biome: 'grassland',
    food: .25, moisture: .5, drinkingWater: .4, vegetation: .85, wood: 10, stone: 8, fauna: 0 });
  Object.assign(person, { x: 36, y: 12, target: { x: 36, y: 12 }, materials: { wood: 12, stone: 8 },
    energy: 1, hunger: .1, thirst: .1, fatigue: .1, curiosity: .1, values: {}, blueprintId: null,
    command: null, decisionAt: 0, work: 0 });
  person.traits.industriousness = 1;
  if (condition !== undefined) {
    person.x = 30; person.target = { x: 30, y: 12 }; person.work = constructionCost(world, person).work;
    const structure = completeConstruction(world, person, tileAt(world, person)!, event =>
      ({ ...event, id: 'fixture', tick: world.tick }));
    assert.ok(structure); structure.condition = condition;
    person.x = 36; person.target = { x: 36, y: 12 }; person.materials = { wood: 12, stone: 8 }; person.work = 0;
  }
  return { world, person };
}

test('autonomous construction serves a missing roof but does not duplicate an equivalent perceived one', () => {
  const absent = scene(), present = scene(1);
  stepWorld(absent.world); stepWorld(present.world);
  assert.equal(absent.person.action, 'build');
  assert.notEqual(present.person.action, 'build');
  assert.equal(present.world.structures.length, 1);
  assert.equal(present.person.command, null);
});

test('moderate wear selects a paid repair within perception rather than a duplicate roof', () => {
  const { world, person } = scene(.9);
  stepWorld(world);
  assert.equal(person.action, 'repair');
  assert.deepEqual(person.target, { x: 30, y: 12 });
  assert.equal(world.structures[0]!.condition, .9, 'selecting a distant repair does not restore it');
  assert.deepEqual(person.materials, { wood: 12, stone: 8 });
});

test('removing redundant construction does not prevent gathering the wood needed for a repair', () => {
  const { world, person } = scene(.9);
  person.materials.wood = 0;
  stepWorld(world);
  assert.equal(person.action, 'gather');
  assert.equal(world.structures[0]!.condition, .9);
  const opening = tileAt(world, person)!.wood!;
  for (let step = 0; step < 18; step++) stepWorld(world);
  assert.ok(person.materials.wood > 0);
  assert.ok(tileAt(world, person)!.wood! < opening);
  assert.equal(world.structures.length, 1);
});
