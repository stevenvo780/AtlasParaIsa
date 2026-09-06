import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld, cloneWorld } from '../src/world/index.js';
import { tileAt } from '../src/world/spatial.js';
import { demographicTraits } from '../src/world/demography.js';
import { BROKEN_CONDITION, constructionCost, constructionOpportunity } from '../src/world/inventions.js';

function scene(role: 'neighbor' | 'S' = 'neighbor') {
  const world = createWorld(42), person = world.people.find(p => p.role === role)!;
  // Isolate the actor's own consumption from a neighbor feeding it first.
  for (const p of world.people) { p.inventory = 0; p.hunger = .2; }
  Object.assign(person, { x: 25, y: 8, hunger: 1, thirst: .2, energy: .14, fatigue: .58,
    target: { x: 25, y: 8 }, action: 'rest', decisionAt: 0 });
  const tile = tileAt(world, person)!; tile.food = .1;
  return { world, person, tile };
}

for (const role of ['neighbor', 'S'] as const) test(`a hungry ${role} eats available food instead of resting for impossible energy recovery`, () => {
  const { world, person, tile } = scene(role), food = tile.food, energy = person.energy;
  stepWorld(world);
  assert.equal(person.action, 'eat');
  assert.ok(person.hunger < 1);
  assert.ok(tile.food < food, 'food must be removed from a physical source');
  assert.ok(person.energy > energy, 'the eaten meal actually improves readiness');
  assert.equal(person.command, null);
});

test('useful rest remains available on both sides of the existing nutritional recovery boundary', () => {
  for (const hunger of [.49, .5, .51]) {
    const { world, person } = scene();
    Object.assign(person, { hunger, fatigue: .9, energy: .1 });
    stepWorld(world);
    assert.equal(person.action, 'rest', `hunger ${hunger}`);
    assert.ok(person.energy > .1, `real readiness recovery at hunger ${hunger}`);
    assert.ok(person.fatigue < .9);
    assert.ok(person.hunger > hunger, 'rest cannot manufacture a meal');
  }
});

test('both sides of the existing physiological hunger stress threshold still permit a real meal', () => {
  for (const hunger of [.8499, .85, .8501]) {
    const { world, person, tile } = scene();
    Object.assign(person, { hunger, fatigue: .1, energy: .25 });
    stepWorld(world);
    assert.equal(person.action, 'eat', `hunger ${hunger}`);
    assert.ok(person.hunger < hunger);
    assert.ok(tile.food < .1);
  }
});

test('protected elders still respond to avoidable deprivation beyond their modeled lifespan', () => {
  const { world, person, tile } = scene('S');
  person.demography.age = demographicTraits(person.genome).maximumAge + 1;
  person.bornAt = -person.demography.age;
  stepWorld(world);
  assert.equal(person.action, 'eat');
  assert.ok(tile.food < .1);
  assert.ok(person.hunger < 1);
  assert.equal(person.demography.deathCause, null);
});

test('near-zero health does not create unbounded choices or prevent a physically unavoidable death', () => {
  const { world, person, tile } = scene();
  person.demography.health = 1e-12;
  stepWorld(world);
  assert.equal(person.action, 'eat');
  assert.ok(tile.food < .1, 'the last meal still has a debit');
  assert.equal(person.demography.deathCause, 'starvation');
  assert.equal(world.people.includes(person), false, 'priority cannot resurrect or immunize a mortal body');
});

/** Decision laboratory: all initial stocks/conditions are explicit, with no
 * replenishment, command or body intervention while the trial runs. */
function rainScene() {
  const { world, person } = scene();
  world.weather = 'rain';
  const roof = world.structures.find(s => s.x === 25 && s.y === 8)!;
  assert.ok(roof?.components.includes('roof'));
  Object.assign(person, { x: 24, y: 8, target: { x: 24, y: 8 }, hunger: .2, thirst: .2, fatigue: .05, energy: .95 });
  person.demography.health = .1;
  assert.notEqual(tileAt(world, person)!.terrain, 'water');
  return { world, person, roof };
}

test('a reachable roof motivates paid movement and reduces actual rain damage even without fatigue', () => {
  const { world, person, roof } = rainScene(), control = cloneWorld(world), other = control.people.find(p => p.id === person.id)!;
  control.shelterBenefitEnabled = false;
  const energy = person.energy;
  for (let i = 0; i < 6; i++) { stepWorld(world); stepWorld(control); }
  assert.deepEqual({ x: person.x, y: person.y }, { x: roof.x, y: roof.y });
  assert.equal(person.action, 'rest');
  assert.match(person.reason, /techo|lluvia/);
  assert.ok(person.energy < energy, 'travel and basal needs have real cost before resting');
  assert.ok(person.demography.health > other.demography.health, 'the demographic transition observes actual cover');
  assert.equal(person.command, null);
});

test('urgent local food and water still beat going to a roof', () => {
  for (const need of ['food', 'water'] as const) {
    const { world, person } = rainScene(), tile = tileAt(world, person)!;
    if (need === 'food') { person.hunger = 1; tile.food = .1; }
    else { person.thirst = 1; tile.drinkingWater = .1; }
    stepWorld(world);
    assert.equal(person.action, need === 'food' ? 'eat' : 'drink');
    assert.ok(need === 'food' ? tile.food < .1 && person.hunger < 1 : tile.drinkingWater! < .1 && person.thirst < 1);
  }
});

test('a roof does not extinguish severe thirst when no drinking reserve is perceived', () => {
  const { world, person, roof } = rainScene();
  person.thirst = 1; person.demography.health = .01;
  for (const tile of world.tiles) tile.drinkingWater = 0;
  for (const s of world.structures) s.water = 0;
  stepWorld(world);
  assert.equal(person.action, 'explore');
  assert.notDeepEqual(person.target, { x: roof.x, y: roof.y });
  assert.ok(Math.hypot(person.target.x - person.x, person.target.y - person.y) >= 3, 'a high autonomous score still selects a real search destination');
  assert.equal(person.thirst, 1, 'search does not invent water or hydration');
});

test('broken or unreachable roofs cannot create a protective destination', () => {
  for (const blocked of [false, true]) {
    const { world, person, roof } = rainScene();
    person.materials = { wood: 0, stone: 0 };
    for (const tile of world.tiles) { tile.wood = 0; tile.stone = 0; }
    if (blocked) for (const p of [{ x: 24, y: 8 }, { x: 26, y: 8 }, { x: 25, y: 7 }, { x: 25, y: 9 }]) {
      if (p.x === person.x && p.y === person.y) { person.x = 23; person.target = { x: 23, y: 8 }; }
      tileAt(world, p)!.terrain = 'water';
    }
    else roof.condition = BROKEN_CONDITION;
    stepWorld(world);
    assert.notDeepEqual(person.target, { x: roof.x, y: roof.y });
    assert.equal(person.action, 'explore');
    assert.match(person.reason, /lluvia|protección/);
  }
});

test('protected elders past maximum age still seek physical cover', () => {
  const { world, roof } = rainScene(), person = world.people.find(p => p.role === 'S')!;
  Object.assign(person, { x: 24, y: 8, target: { x: 24, y: 8 }, hunger: .2, thirst: .2, fatigue: .05, energy: .95, decisionAt: 0 });
  person.demography.health = .05; person.demography.age = demographicTraits(person.genome).maximumAge + 1; person.bornAt = -person.demography.age;
  stepWorld(world);
  assert.deepEqual(person.target, { x: roof.x, y: roof.y });
  assert.equal(person.demography.deathCause, null);
});

test('preparing cover requires admitted construction, reachable material and real work', () => {
  const { world, person, roof } = rainScene();
  roof.condition = 0;
  // The controlled site is outside every existing settlement's exclusion radius.
  Object.assign(person, { x: 36, y: 8, target: { x: 36, y: 8 }, materials: { wood: 0, stone: 0 } });
  const tile = tileAt(world, person)!; tile.terrain = 'meadow'; tile.moisture = .5; tile.vegetation = .5; tile.food = 0;
  for (const t of world.tiles) { t.wood = 0; t.stone = 0; }
  const cost = constructionCost(world, person); tile.wood = cost.wood; tile.stone = cost.stone;
  assert.ok(constructionOpportunity(world, person), 'the ordinary marginal-service gate admits this site');
  const energy = person.energy, structures = world.structures.length;
  for (let i = 0; i < 18; i++) stepWorld(world);
  assert.equal(person.action, 'gather');
  assert.ok(person.materials.wood > 0 && tile.wood! < cost.wood, 'a real gathered unit is removed from the site');
  assert.ok(person.energy < energy - 18 * .0003, 'gathering and basal energy are debited');
  assert.equal(world.structures.length, structures, 'a forecast does not create a building');
  for (let i = 18; i < 300 && !world.structures.some(s => s.builderId === person.id); i++) stepWorld(world);
  const built = world.structures.find(s => s.builderId === person.id);
  assert.ok(built, 'the autonomous collection continues into a paid construction');
  assert.ok(Math.hypot(built.x - 36, built.y - 8) <= 7, 'the paid work uses a perceived viable site after harvesting/trampling');
  assert.equal(tileAt(world, built)!.terrain, 'shelter');
  assert.ok((person.activity.gather ?? 0) >= cost.wood + cost.stone);
  assert.equal(person.materials.wood, 0); assert.equal(person.materials.stone, 0);
  assert.equal(built.water, 0); assert.equal(built.food, 0);
});

test('restoring a broken roof requires the actual repair debit before protection returns', () => {
  const { world, person, roof } = rainScene();
  roof.condition = 0; person.materials.wood = 2;
  const energy = person.energy;
  for (let i = 0; i < 34; i++) stepWorld(world);
  assert.equal(person.action, 'repair');
  assert.equal(roof.condition, 0, 'travel time is not credited as completed repair work');
  assert.equal(person.materials.wood, 2);
  stepWorld(world);
  assert.ok(roof.condition > BROKEN_CONDITION);
  assert.equal(person.materials.wood, 1);
  assert.ok(person.energy < energy - 30 * .0003);
});

test('remote roofs cannot direct protective exploration', () => {
  const { world, person, roof } = rainScene();
  roof.condition = 0; person.materials = { wood: 0, stone: 0 };
  for (const tile of world.tiles) { tile.wood = 0; tile.stone = 0; }
  const remote = world.structures.find(s => Math.hypot(s.x - person.x, s.y - person.y) > 10)!;
  const control = cloneWorld(world); control.structures.find(s => s.id === remote.id)!.condition = 0;
  stepWorld(world); stepWorld(control);
  const other = control.people.find(p => p.id === person.id)!;
  assert.deepEqual({ action: person.action, target: person.target, reason: person.reason }, { action: other.action, target: other.target, reason: other.reason });
  assert.equal(person.action, 'explore');
});

test('missing or unreachable building materials cannot finance protective work', () => {
  for (const unreachable of [false, true]) {
    const { world, person } = rainScene();
    Object.assign(person, { x: 36, y: 8, target: { x: 36, y: 8 }, materials: { wood: 0, stone: 0 } });
    for (const tile of world.tiles) { tile.wood = 0; tile.stone = 0; }
    if (unreachable) {
      const stock = tileAt(world, { x: 38, y: 8 })!, cost = constructionCost(world, person);
      stock.terrain = 'meadow'; stock.wood = cost.wood; stock.stone = cost.stone;
      for (const p of [{ x: 37, y: 8 }, { x: 39, y: 8 }, { x: 38, y: 7 }, { x: 38, y: 9 }]) tileAt(world, p)!.terrain = 'water';
      assert.ok(constructionOpportunity(world, person), 'the distance-only admission sees the stock; the real local route does not');
    }
    const count = world.structures.length;
    stepWorld(world);
    assert.equal(person.action, 'explore');
    assert.equal(person.work, 0);
    assert.deepEqual(person.materials, { wood: 0, stone: 0 });
    assert.equal(world.structures.length, count);
  }
});
