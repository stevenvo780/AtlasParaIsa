import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld } from '../src/world/index.js';
import { tileAt } from '../src/world/spatial.js';
import { demographicTraits } from '../src/world/demography.js';

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
