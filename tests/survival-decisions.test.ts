import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, cloneWorld, stepWorld } from '../src/world/index.js';
import { tileAt } from '../src/world/spatial.js';

/** Controlled decision laboratory. Stocks are specified before the trial; no replenishment
 * or command is introduced during it. Natural multi-seed runs are separate evidence. */
function dryLaboratory() {
  const world = createWorld(51926), person = world.people.find(p => p.role === 'neighbor')!;
  for (const tile of world.tiles) tile.drinkingWater = 0;
  for (const structure of world.structures) structure.water = 0;
  Object.assign(person, { hunger: .2, thirst: .95, energy: .5, fatigue: 0, action: 'rest', decisionAt: 0,
    target: { x: person.x, y: person.y } });
  return { world, person };
}

test('severe thirst without a visible reserve motivates a paid local search', () => {
  const { world, person } = dryLaboratory(), start = { x: person.x, y: person.y }, energy = person.energy;
  for (let tick = 0; tick < 6; tick++) stepWorld(world);
  assert.equal(person.action, 'explore');
  assert.match(person.reason, /sed|agua/i);
  assert.equal(Math.abs(person.x - start.x) + Math.abs(person.y - start.y), 1, 'one physical land step at the existing movement cadence');
  assert.ok(person.energy < energy - .0008, 'movement and basal needs both debit readiness');
  assert.ok(person.thirst > .95, 'search alone cannot relieve thirst');
  assert.equal(person.command, null);
});

test('water beyond perception cannot steer the first search step', () => {
  const { world, person } = dryLaboratory(), other = cloneWorld(world);
  const remote = other.tiles.find(t => t.terrain !== 'water' && Math.hypot(t.x-person.x,t.y-person.y)>12)!;
  remote.drinkingWater = 1;
  stepWorld(world); stepWorld(other);
  const counterpart = other.people.find(p => p.id === person.id)!;
  assert.deepEqual({ action: person.action, target: person.target, reason: person.reason },
    { action: counterpart.action, target: counterpart.target, reason: counterpart.reason });
  assert.equal(person.action, 'explore');
  assert.ok(Math.hypot(person.target.x-person.x,person.target.y-person.y)<=7);
});

test('a locally available reserve is consumed with its matching thirst relief', () => {
  const { world, person } = dryLaboratory(), tile = tileAt(world, person)!;
  tile.drinkingWater = .1;
  stepWorld(world);
  assert.equal(person.action, 'drink');
  assert.ok(tile.drinkingWater! < .1);
  assert.ok(person.thirst < .95);
  assert.ok(Math.abs(world.totals.waterConsumed - (.1 - tile.drinkingWater!)) < 1e-12);
});

test('water search still permits urgent food and recovery from exhaustion', () => {
  const food = dryLaboratory();
  Object.assign(food.person, { thirst: .65, hunger: .98, fatigue: .1, energy: .8 });
  // Keep this control about the actor's own meal; neighbors cannot feed it first.
  for (const other of food.world.people) other.inventory = 0;
  tileAt(food.world, food.person)!.food = .5;
  stepWorld(food.world);
  assert.equal(food.person.action, 'eat');
  assert.ok(food.person.hunger < .98);
  const rest = dryLaboratory();
  Object.assign(rest.person, { thirst: .9, fatigue: .96, energy: .08 });
  const here = tileAt(rest.world, rest.person)!;
  for (const tile of rest.world.tiles) if (tile.terrain === 'shelter') tile.terrain = 'meadow';
  here.terrain = 'shelter';
  stepWorld(rest.world);
  assert.equal(rest.person.action, 'rest');
  assert.ok(rest.person.fatigue < .96);
  assert.ok(rest.person.thirst > .9, 'rest does not create drinking water');
});
