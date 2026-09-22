import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorld, cloneWorld, createWorld, stepWorld, type World } from '../src/world/index.js';
import { maintainRegions, tileAt } from '../src/world/spatial.js';

/** A finite land corridor ends east of the actor. The only water starts outside
 * perception; other inhabitants rest and cannot satisfy the actor's counters. */
function corridor() {
  const world = createWorld(4);
  world.reproductionEnabled = world.cooperationEnabled = false;
  for (const person of world.people) {
    person.x = 28; person.y = 12; person.action = 'rest'; person.target = { x: 28, y: 12 };
    person.decisionAt = 1_000_000; person.hunger = person.thirst = .1; person.energy = 1; person.fatigue = 0;
  }
  maintainRegions(world);
  for (const tile of world.tiles) {
    tile.terrain = tile.y === 12 && tile.x >= 8 && tile.x <= 28 ? 'meadow' : 'water';
    tile.drinkingWater = tile.food = tile.wood = tile.stone = tile.fauna = 0; tile.feature = 'none';
  }
  world.structures = []; world.animals = []; world.weather = 'clear';
  const actor = world.people[2]!;
  actor.thirst = .95; actor.heading = 0; actor.action = 'explore'; actor.decisionAt = 0; actor.visited = [];
  tileAt(world, { x: 17, y: 12 })!.drinkingWater = .5;
  assertWorld(world);
  return world;
}
const actorOf = (world: World) => world.people[2]!;
const sourceOf = (world: World) => tileAt(world, { x: 17, y: 12 })!;
function advance(world: World, ticks: number) { for (let n = 0; n < ticks; n++) stepWorld(world); }

test('urgent water search finishes local waypoints, perceives the source and pays for real drinking', () => {
  const world = corridor(), dry = cloneWorld(world), withoutNovelty = cloneWorld(world);
  sourceOf(dry).drinkingWater = 0; withoutNovelty.noveltyEnabled = false;
  const actor = actorOf(world), openingEnergy = actor.energy;
  const path = new Set<string>();
  for (let n = 0; n < 120; n++) {
    stepWorld(world); stepWorld(dry); stepWorld(withoutNovelty);
    path.add(`${actor.x},${actor.y}`);
    if (actor.x > 24) assert.notEqual(actor.action, 'drink', 'a source beyond perception cannot select a remote drinking target');
    if (world.totals.waterConsumed > 0) assert.deepEqual({ x: actor.x, y: actor.y }, { x: 17, y: 12 }, 'hydration requires physical arrival');
  }
  assert.ok(path.size >= 11, 'search must leave the two-cell replanning loop');
  assert.ok(world.totals.waterConsumed > .1);
  assert.ok(actor.thirst < .7); assert.ok(actor.energy < openingEnergy, 'travel and basal needs remain paid');
  assert.equal(dry.totals.waterConsumed, 0); assert.equal(actorOf(dry).thirst, 1, 'searching empty land creates no hydration');
  assert.equal(withoutNovelty.totals.waterConsumed, 0, 'waypoint commitment does not replace the local novelty motive');
  assert.equal(actorOf(withoutNovelty).thirst, 1);
  assert.ok(Math.abs(sourceOf(withoutNovelty).drinkingWater! - sourceOf(world).drinkingWater! - world.totals.waterConsumed) < 1e-10,
    'matched environmental losses leave precisely the physically consumed difference');
  assertWorld(world); assertWorld(dry); assertWorld(withoutNovelty);
});

test('newly perceived water interrupts a committed search before its waypoint', () => {
  const world = corridor(), actor = actorOf(world);
  advance(world, 6);
  assert.equal(actor.x, 27); assert.equal(actor.target.x, 25);
  const local = tileAt(world, { x: 26, y: 12 })!; local.drinkingWater = .1;
  stepWorld(world);
  assert.equal(actor.action, 'drink'); assert.deepEqual(actor.target, { x: 26, y: 12 });
  assert.equal(world.totals.waterConsumed, 0, 'seeing the source does not consume it remotely');
  advance(world, 5);
  assert.equal(actor.x, 26); assert.ok(world.totals.waterConsumed > 0); assert.ok(local.drinkingWater < .1);
});

test('a blocked waypoint is discarded and visible water across the barrier is not treated as reachable', () => {
  const world = corridor(), actor = actorOf(world);
  advance(world, 6);
  tileAt(world, { x: 26, y: 12 })!.terrain = 'water';
  tileAt(world, { x: 25, y: 12 })!.drinkingWater = .5;
  stepWorld(world);
  assert.notEqual(actor.action, 'drink');
  assert.notEqual(actor.target.x, 25, 'a formerly reachable target must not persist behind a new barrier');
  advance(world, 30);
  assert.equal(world.totals.waterConsumed, 0); assert.ok(actor.x >= 27); assertWorld(world);
});

test('water search still reconsiders fatigue and a human order rather than locking the actor into travel', () => {
  const tired = corridor(), ordered = cloneWorld(tired);
  advance(tired, 6); advance(ordered, 6);
  const actor = actorOf(tired); actor.thirst = .61; actor.fatigue = 1; actor.energy = .01; actor.decisionAt = tired.tick;
  stepWorld(tired);
  assert.equal(actor.action, 'rest'); assert.equal(tired.totals.waterConsumed, 0);
  const directed = actorOf(ordered); directed.thirst = .7;
  stepWorld(ordered, [{ id: 'water-search-rest-control', kind: 'command', agentId: directed.id, order: 'rest', x: directed.x, y: directed.y }]);
  assert.equal(directed.action, 'rest'); assert.equal(directed.controlMode, 'directed');
});
