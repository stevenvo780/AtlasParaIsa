import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChronicleEvent } from '../src/shared/types.js';
import { assertChronicleEvent } from '../src/world/chronicle-journal.js';
import { createWorld, deathContext, type Person, type World } from '../src/world/index.js';
import { initialDemography } from '../src/world/demography.js';
import { advancePopulation } from '../src/world/lineage.js';

/** Mirrors the lightweight recorder used by tests/lineage.test.ts: assigns id/tick and appends,
 * without the SQLite-journal bookkeeping of the production `addEvent`. */
function emitFor(world: World) {
  return (event: Omit<ChronicleEvent, 'id' | 'tick'>): ChronicleEvent => {
    const result = { ...event, id: `e${++world.eventCounter}`, tick: world.tick }; world.events.push(result); return result;
  };
}

/** `world.people[0]`/`[1]` are the protected 'S'/'I' identities; a 'neighbor' is required for an
 * unprevented death. */
function scene() {
  const world = createWorld(73201); world.weather = 'clear'; world.people = world.people.slice(0, 3); world.communities = [];
  for (const person of world.people) {
    person.inventory = 0; person.materials = { wood: 0, stone: 0 }; person.hunger = 0.1; person.thirst = 0.1; person.fatigue = 0.1; person.energy = 0.9;
    person.demography = initialDemography(world.tick - person.bornAt); person.communityId = null; person.bonds = {};
  }
  return { world, victim: world.people[2]! };
}

/** Same forcing technique as tests/lineage.test.ts's `fatal`: near-zero health plus a saturated
 * need drives `updateDemography` to an immediate, deterministic death this tick. Full thirst zeroes
 * `nourishment`, so no healing offsets the forced health floor; hunger stays low so `dehydration`
 * dominates the sorted damage and no other cause can win the tie. */
function fatalThirst(person: Person): void {
  person.thirst = 1; person.demography = { ...person.demography, health: 1e-8, vitality: 0.1 };
}

/** Registers `advancePopulation`'s emitted events exactly as `stepWorld` wires them in
 * src/world/index.ts: a 'death' event is passed through `deathContext` before being recorded. */
function wiredEmit(world: World) {
  const record = emitFor(world);
  return (event: Omit<ChronicleEvent, 'id' | 'tick'>): ChronicleEvent => record(event.kind === 'death' ? deathContext(world, event) : event);
}

test('a death by dehydration records place, tick and prior events, both narrated and structured (FR-006)', () => {
  const { world, victim } = scene();
  const emit = wiredEmit(world);
  world.tick = 10; emit({ kind: 'discovery', actors: [victim.id], x: 3, y: 4, source: 'simulation', text: 'Encontró un rincón nuevo del territorio.', cause: 'Exploración libre.' });
  world.tick = 40; emit({ kind: 'meeting', actors: [victim.id], x: 6, y: 6, source: 'simulation', text: 'Compartió un momento con un vecino.', cause: 'Cercanía casual.' });
  world.tick = 70; emit({ kind: 'learning', actors: [victim.id], x: 7, y: 6, source: 'simulation', text: 'Practicó una técnica nueva.', cause: 'Repetición deliberada.' });

  fatalThirst(victim); world.tick = 100;
  advancePopulation(world, { emit });

  assert.equal(world.demographyDynamics.deaths, 1);
  assert.equal(world.demographyDynamics.causes.dehydration, 1);
  assert.ok(!world.people.includes(victim));

  const death = world.events.find(event => event.kind === 'death' && event.actors.includes(victim.id));
  assert.ok(death, 'the death event must be in the chronicle');
  assert.ok(death!.death, 'the structured death field must be present');
  const info = death!.death!;
  assert.equal(info.cause, 'dehydration');
  assert.equal(info.tick, 100);
  assert.equal(info.x, death!.x); assert.equal(info.y, death!.y);
  assert.equal(death!.x, victim.x); assert.equal(death!.y, victim.y);
  assert.deepEqual(info.previous, ['Encontró un rincón nuevo del territorio.', 'Compartió un momento con un vecino.', 'Practicó una técnica nueva.']);
  assert.match(death!.text, /paso 100/);
  assert.match(death!.text, new RegExp(`\\(${victim.x}, ${victim.y}\\)`));
  assert.match(death!.text, /Practicó una técnica nueva\./);

  // The structured field is not a decoration; it must also pass the chronicle's own invariant.
  assert.doesNotThrow(() => assertChronicleEvent(death, world.tick));
});

test('a death with no prior chronicle episodes reports an empty, honest history (no hidden rescue)', () => {
  const { world, victim } = scene();
  const emit = wiredEmit(world);
  fatalThirst(victim); world.tick = 5;
  advancePopulation(world, { emit });
  const death = world.events.find(event => event.kind === 'death')!;
  assert.deepEqual(death.death!.previous, []);
  assert.match(death.text, /Sin episodios previos/);
});

test('the chronicle invariant refutes a death field with more than 3 prior events or a mismatched place', () => {
  const { world, victim } = scene();
  fatalThirst(victim); world.tick = 5;
  advancePopulation(world, { emit: emitFor(world) });
  const raw = world.events.find(event => event.kind === 'death')!;

  const tooMany = { ...raw, death: { cause: 'dehydration', tick: world.tick, x: raw.x!, y: raw.y!, previous: ['a', 'b', 'c', 'd'] } };
  assert.throws(() => assertChronicleEvent(tooMany, world.tick), /Chronicle journal/);

  const wrongPlace = { ...raw, death: { cause: 'dehydration', tick: world.tick, x: (raw.x ?? 0) + 1, y: raw.y!, previous: [] } };
  assert.throws(() => assertChronicleEvent(wrongPlace, world.tick), /Chronicle journal/);
});
