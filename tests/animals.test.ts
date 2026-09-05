import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tile, ChronicleEvent } from '../src/shared/types.js';
import type { AnimalSpecies } from '../src/shared/life.js';
import { advanceNeeds } from '../src/world/needs.js';
import { assertAnimal, assertAnimals, harvestAt, materializeAnimals, MAX_ACTIVE_ANIMALS, MAX_STORED_ANIMALS, MAX_ANIMAL_DECISIONS_PER_TICK, MAX_ANIMAL_MEMORY, projectAnimal, stepAnimals, syncFauna, type Animal, type AnimalWorld } from '../src/world/animals.js';

function tile(x = 0, y = 0, overrides: Partial<Tile> = {}): Tile {
  return { x, y, terrain: 'meadow', biome: 'grassland', moisture: 0.8, vegetation: 0.8, growth: 0.8,
    food: 0.2, fauna: 0, drinkingWater: 0.8, fertility: 0.6, ...overrides };
}
function animal(species: AnimalSpecies, x = 0, y = 0, suffix = ''): Animal {
  const a = materializeAnimals(42, [tile(x, y, { fauna: 1, species })], 0)[0]!;
  a.id += `-${species}${suffix ? `-${suffix}` : ''}`;
  a.hunger = 0.25; a.thirst = 0.2;
  return a;
}
function world(tiles: Tile[], animals: Animal[]): AnimalWorld {
  syncFauna(tiles, animals);
  return { seed: 42, tick: 0, tiles, animals, animalCounter: 0, reproductionEnabled: false,
    animalDynamics: { births: 0, deaths: 0, predations: 0, humanHunts: 0, waterConsumed: 0, plantConsumed: 0 } };
}
function run(w: AnimalWorld, ticks: number, events: Omit<ChronicleEvent, 'id' | 'tick'>[] = []): void {
  for (let n = 0; n < ticks; n++) { w.tick++; stepAnimals(w, e => events.push(e)); }
}
function normalized(w: AnimalWorld): unknown {
  return { ...w, animals: [...w.animals].sort((a, b) => a.id.localeCompare(b.id)), tiles: [...w.tiles].sort((a, b) => a.y - b.y || a.x - b.x) };
}

test('shared physiological engine preserves human costs, clamps and charges both deprivation causes', () => {
  const body = { hunger: 0.8499, thirst: 0.8499, energy: 0.8, fatigue: 0.2 };
  advanceNeeds(body, { hunger: 0.00027, thirst: 0.00045, energy: 0.00007, stressEnergy: 0.00015, fatigue: 0.00009 });
  assert.equal(body.hunger, 0.8499 + 0.00027); assert.equal(body.thirst, 0.8499 + 0.00045);
  assert.ok(Math.abs(body.energy - (0.8 - 0.00007 - 0.00015 - 0.00015)) < 1e-15);
  assert.equal(body.fatigue, 0.2 + 0.00009);
  advanceNeeds(body, { hunger: 10, thirst: 10, energy: 10, stressEnergy: 10, fatigue: 10 });
  assert.deepEqual(body, { hunger: 1, thirst: 1, energy: 0, fatigue: 1 });
  assert.throws(() => advanceNeeds(body, { hunger: -1, thirst: 0, energy: 0, stressEnergy: 0, fatigue: 0 }), RangeError);
});

test('V3 stock materialization preserves exact species/count, stable identities and source data under permutation', () => {
  const tiles = [tile(-2, 3, { fauna: 3, species: 'hare' }), tile(0, 0, { fauna: 2, species: 'deer' }), tile(1, 0)];
  const before = structuredClone(tiles), first = materializeAnimals(42, tiles, 120);
  assert.equal(first.length, 5); assert.deepEqual(tiles, before);
  assert.deepEqual(first, materializeAnimals(42, [...tiles].reverse(), 120));
  assert.equal(new Set(first.map(a => a.id)).size, 5);
  assert.equal(first.filter(a => a.species === 'hare').length, 3);
  assert.equal(materializeAnimals(42, [tile(1, 0)], 120).length, 0);
  assert.throws(() => materializeAnimals(42, [tile(0, 0, { fauna: 7, species: 'hare' })], 0));
});

test('grazing and drinking debit local finite resources and alter the individual body', () => {
  const grazer = animal('hare'), dry = animal('hare', 3, 0);
  grazer.hunger = 0.7; dry.hunger = 0.7;
  const fed = world([tile()], [grazer]), empty = world([tile(3, 0, { growth: 0, vegetation: 0, drinkingWater: 0, moisture: 0 })], [dry]);
  const initialGrowth = fed.tiles[0]!.growth!, initialMoisture = fed.tiles[0]!.moisture;
  run(fed, 20); run(empty, 20);
  assert.ok(grazer.hunger < 0.7 && dry.hunger > 0.7);
  assert.ok(fed.tiles[0]!.growth! < initialGrowth && fed.tiles[0]!.moisture < initialMoisture);
  assert.ok(Math.abs(initialGrowth - fed.tiles[0]!.growth! - fed.animalDynamics.plantConsumed) < 1e-12);
  assert.equal(empty.animalDynamics.plantConsumed, 0); assert.equal(empty.animalDynamics.waterConsumed, 0);
  const drinker = animal('deer'); drinker.thirst = 0.8;
  const drinking = world([tile()], [drinker]), water = drinking.tiles[0]!.drinkingWater!;
  run(drinking, 20);
  assert.ok(drinker.thirst < 0.8); assert.ok(drinking.tiles[0]!.drinkingWater! < water);
  assert.ok(Math.abs(water - drinking.tiles[0]!.drinkingWater! - drinking.animalDynamics.waterConsumed) < 1e-12);
});

test('rest reduces fatigue with resource-limited energy recovery and cannot erase needs', () => {
  const rested = animal('deer'); rested.energy = 0.2; rested.fatigue = 0.8;
  const w = world([tile()], [rested]); run(w, 50);
  assert.ok(rested.energy > 0.2 && rested.fatigue < 0.8);
  assert.ok(rested.hunger > 0.25 && rested.thirst > 0.2);
  const starved = animal('deer'); starved.hunger = 1; starved.thirst = 1; starved.energy = 0.2; starved.fatigue = 0.8;
  const barren = world([tile(0, 0, { growth: 0, drinkingWater: 0, moisture: 0 })], [starved]); run(barren, 50);
  assert.ok(starved.energy < 0.2, 'rest cannot manufacture energy when both needs are maximal');
});

test('exploration is physical, bounded to active habitat, and short memory records real visits', () => {
  const tiles = Array.from({ length: 13 }, (_, x) => tile(x - 6, 0));
  tiles.push(tile(0, 1, { terrain: 'water' }), tile(0, -1, { terrain: 'shelter' }));
  const a = animal('hare'), w = world(tiles, [a]), visited = new Set<string>();
  for (let n = 0; n < 140; n++) {
    const p = { x: a.x, y: a.y }; run(w, 1);
    assert.ok(Math.abs(a.x - p.x) + Math.abs(a.y - p.y) <= 1);
    assert.equal(a.y, 0); assert.ok(a.x >= -6 && a.x <= 6); visited.add(`${a.x},${a.y}`);
    assert.ok(a.memory.length <= MAX_ANIMAL_MEMORY);
  }
  assert.ok(visited.size >= 4); assert.ok(a.memory.some(m => m.visited)); assert.equal(w.tiles.length, 15);
  const far = animal('hare'); far.thirst = 0.8; far.genes.perception = 0;
  far.memory = [{ x: 6, y: 0, tick: 0, food: 0, water: 0.8, visited: true }];
  const remembered = world(Array.from({ length: 7 }, (_, x) => tile(x, 0, { drinkingWater: x === 6 ? 0.8 : 0, growth: 0 })), [far]);
  run(remembered, 1); assert.equal(far.action, 'drink'); assert.deepEqual(far.target, { x: 6, y: 0 }); assert.equal(far.x, 1);
});

test('local perception does not discover unseen distant water and fish cannot cross land', () => {
  const a = animal('hare'); a.thirst = 0.8; a.genes.perception = 0;
  const w = world(Array.from({ length: 10 }, (_, x) => tile(x, 0, { drinkingWater: x === 9 ? 0.8 : 0 })), [a]); run(w, 1);
  assert.equal(a.action, 'roam'); assert.notDeepEqual(a.target, { x: 9, y: 0 });
  const fish = animal('fish'), pond = world([tile(0, 0, { terrain: 'water', biome: 'ocean', drinkingWater: 0 }), tile(1, 0)], [fish]);
  fish.thirst = 0.8; run(pond, 40);
  assert.equal(fish.x, 0); assert.equal(fish.y, 0); assert.ok(fish.thirst < 0.8); assert.equal(pond.tiles[0]!.drinkingWater, 0);
  assert.ok(pond.tiles[0]!.moisture < 0.8);
});

test('predation transfers only a real prey identity once, even with two competing predators', () => {
  const prey = animal('hare'); prey.energy = 0.04; prey.health = 0.25;
  const wolves = [animal('wolf', 0, 0, 'one'), animal('wolf', 0, 0, 'two')]; wolves.forEach(a => { a.hunger = 0.8; });
  const w = world([tile()], [prey, ...wolves]), events: Omit<ChronicleEvent, 'id' | 'tick'>[] = [];
  run(w, 16, events);
  assert.equal(w.animals.length, 2); assert.ok(!w.animals.some(a => a.id === prey.id));
  assert.equal(w.animalDynamics.predations, 1); assert.equal(w.animalDynamics.deaths, 1);
  assert.equal(events.filter(e => e.cause === 'depredación').length, 1);
  assert.equal(events[0]!.actors[1], prey.id);
  assert.equal(wolves.filter(a => a.hunger < 0.7).length, 1, 'only the successful hunter receives biomass');
  run(w, 50, events); assert.equal(w.animalDynamics.predations, 1);
});

test('fleeing changes survival in paired contact-predation experiments', () => {
  const predator = animal('wolf'), prey = animal('hare'); predator.hunger = 0.8; predator.genes.speed = 0;
  prey.genes.speed = 1; prey.health = 0.5;
  const mobile = world(Array.from({ length: 25 }, (_, x) => tile(x, 0)), [predator, prey]);
  const noFlee = structuredClone(mobile), victimId = prey.id;
  for (let n = 0; n < 100; n++) {
    run(mobile, 1);
    noFlee.tick++;
    const pinned = noFlee.animals.find(a => a.id === victimId);
    // Controlled behavioral ablation: suppress the prey's flight decision; its initial genes/body/resources are identical.
    if (pinned) { pinned.action = 'rest'; pinned.target = { x: pinned.x, y: pinned.y }; pinned.lastDecision = noFlee.tick; }
    stepAnimals(noFlee);
  }
  assert.ok(mobile.animals.some(a => a.id === victimId)); assert.ok(prey.x > 0);
  assert.ok(!noFlee.animals.some(a => a.id === victimId)); assert.equal(noFlee.animalDynamics.predations, 1);
  assert.equal(mobile.animalDynamics.predations, 0);
});

test('mating needs two mature same-species bodies, debits parents/patch and transmits bounded genes', () => {
  const a = animal('deer', 0, 0, 'one'), b = animal('deer', 0, 0, 'two');
  for (const k of Object.keys(a.genes) as (keyof Animal['genes'])[]) { a.genes[k] = 0.2; b.genes[k] = 0.7; }
  const breeding = world([tile()], [a, b]); breeding.tick = 99; breeding.reproductionEnabled = true;
  const control = structuredClone(breeding); control.reproductionEnabled = false;
  run(breeding, 1); run(control, 1);
  assert.equal(breeding.animals.length, 3); assert.equal(control.animals.length, 2); assert.equal(breeding.animalDynamics.births, 1);
  const child = breeding.animals.find(c => c.generation === 1)!;
  assert.deepEqual(child.parents, [a.id, b.id].sort()); assert.equal(child.age, 0); assert.equal(child.bornAt, 100);
  for (const gene of Object.values(child.genes)) assert.ok(gene >= 0.42 && gene <= 0.48);
  for (const parent of [a, b]) {
    const baseline = control.animals.find(c => c.id === parent.id)!;
    assert.ok(Math.abs(baseline.energy - parent.energy - 0.18) < 1e-12);
    assert.ok(Math.abs(parent.hunger - baseline.hunger - 0.12) < 1e-12);
  }
  assert.ok(Math.abs(control.tiles[0]!.growth! - breeding.tiles[0]!.growth! - 0.06) < 1e-12);
  assert.ok(Math.abs(control.tiles[0]!.drinkingWater! - breeding.tiles[0]!.drinkingWater! - 0.012) < 1e-12);
  assertAnimal(child, breeding.tick);
  run(breeding, 100); assert.equal(breeding.animalDynamics.births, 1, 'cooldown and immature child prevent another birth');
});

test('zero food, absent mate, immaturity and full local population prevent reproduction', () => {
  for (const variant of ['zero', 'alone', 'young', 'full', 'species'] as const) {
    const a = animal('hare', 0, 0, 'one'), b = animal(variant === 'species' ? 'deer' : 'hare', 0, 0, 'two');
    const animals = variant === 'alone' ? [a] : [a, b];
    if (variant === 'young') { a.bornAt = 0; b.bornAt = 0; a.age = 0; b.age = 0; }
    if (variant === 'full') for (let n = 0; n < 4; n++) animals.push(animal('hare', 0, 0, `extra${n}`));
    const w = world([tile(0, 0, { growth: variant === 'zero' ? 0 : 0.8 })], animals); w.reproductionEnabled = true; w.tick = 99;
    run(w, 1); assert.equal(w.animalDynamics.births, 0, variant);
  }
});

test('starvation and dehydration cause actual mortality with named causes and no repopulation', () => {
  for (const cause of ['inanición', 'deshidratación'] as const) {
    const a = animal('hare'); a.health = 0.001; a.energy = 0.4;
    if (cause === 'inanición') a.hunger = 1; else a.thirst = 1;
    const w = world([tile(0, 0, { growth: 0, vegetation: 0, drinkingWater: 0, moisture: 0 })], [a]);
    const events: Omit<ChronicleEvent, 'id' | 'tick'>[] = []; run(w, 3, events);
    assert.equal(w.animals.length, 0); assert.equal(w.animalDynamics.deaths, 1); assert.equal(events[0]!.cause, cause);
    run(w, 100); assert.equal(w.animals.length, 0); assert.equal(w.tiles[0]!.fauna, 0);
  }
  const hungry = animal('hare'), w = world([tile(0, 0, { growth: 0, vegetation: 0, drinkingWater: 0, moisture: 0 })], [hungry]);
  run(w, 4000); assert.equal(w.animals.length, 0, 'a healthy animal cannot survive forever in a zero-resource cell');
});

test('human hunting removes a real local ID once and emits the actual victim', () => {
  const deer = animal('deer'), distant = animal('hare', 2, 0);
  const w = world([tile(), tile(2, 0)], [deer, distant]), events: Omit<ChronicleEvent, 'id' | 'tick'>[] = [];
  assert.equal(harvestAt(w, { x: 0, y: 0 }, 'human-one', e => events.push(e)), 0.25);
  assert.equal(harvestAt(w, { x: 0, y: 0 }, 'human-one', e => events.push(e)), 0);
  assert.deepEqual(events[0]!.actors, ['human-one', deer.id]); assert.equal(events[0]!.cause, 'caza humana');
  assert.equal(w.animals.length, 1); assert.equal(w.animals[0]!.id, distant.id);
  assert.equal(w.animalDynamics.humanHunts, 1); assert.equal(w.animalDynamics.deaths, 1);
  assert.equal(w.tiles[0]!.fauna, 0); assert.equal(w.tiles[0]!.species, undefined);
});

test('mixed-species projection is deterministic and cannot exceed six local animals', () => {
  const animals = [animal('hare', 0, 0, 'a'), animal('deer', 0, 0, 'b')], tiles = [tile()];
  syncFauna(tiles, animals); assert.equal(tiles[0]!.fauna, 2); assert.equal(tiles[0]!.species, 'deer');
  const reverse = [tile()]; syncFauna(reverse, [...animals].reverse()); assert.deepEqual(reverse, tiles);
  const crowded = Array.from({ length: 7 }, (_, n) => animal('hare', 0, 0, `n${n}`));
  assert.throws(() => syncFauna(tiles, crowded)); assert.throws(() => assertAnimals(crowded, 0, tiles));
  const a = animal('hare', -1, 0), b = animal('hare', 1, 0);
  const w = world([tile(-1, 0), tile(), tile(1, 0)], [...crowded.slice(0, 5), a, b]);
  for (let n = 0; n < 100; n++) { run(w, 1); assert.ok(w.tiles.every(t => t.fauna! <= 6)); assert.equal(w.animals.length, 7); }
});

test('simulation decisions, mating and encounters are invariant under both animal and tile permutation', () => {
  const tiles = Array.from({ length: 9 }, (_, n) => tile(n % 3, Math.floor(n / 3)));
  const a = animal('deer', 0, 0, 'a'), b = animal('deer', 0, 0, 'b'), wolf = animal('wolf', 2, 2); wolf.hunger = 0.8;
  const original = world(tiles, [a, b, wolf, animal('hare', 1, 1)]); original.reproductionEnabled = true;
  const reversed = structuredClone(original); reversed.tiles.reverse(); reversed.animals.reverse();
  const firstEvents: Omit<ChronicleEvent, 'id' | 'tick'>[] = [], secondEvents: Omit<ChronicleEvent, 'id' | 'tick'>[] = [];
  run(original, 300, firstEvents); run(reversed, 300, secondEvents);
  assert.deepEqual(normalized(original), normalized(reversed)); assert.deepEqual(firstEvents, secondEvents); assertAnimals(original.animals, original.tick, original.tiles);
});

test('archive validation rejects corrupt physiology, duplicate IDs, oversized memory and unloaded positions', () => {
  const original = animal('hare'); assertAnimal(original, 0);
  for (const mutate of [
    (a: Animal) => { a.genes.speed = NaN; }, (a: Animal) => { a.health = 0; }, (a: Animal) => { a.hunger = 2; },
    (a: Animal) => { a.target.x = Infinity; }, (a: Animal) => { a.parents = [a.id]; }, (a: Animal) => { a.bornAt = 1; },
    (a: Animal) => { a.lastBirthAge = -1; }, (a: Animal) => { a.lastBirthAge = a.age + 1; },
    (a: Animal) => { a.memory = Array.from({ length: MAX_ANIMAL_MEMORY + 1 }, (_, x) => ({ x, y: 0, tick: 0, food: 0, water: 0, visited: true })); },
  ]) { const bad = structuredClone(original); mutate(bad); assert.throws(() => assertAnimal(bad, 0)); }
  assert.throws(() => assertAnimals([original, structuredClone(original)], 0));
  assert.throws(() => assertAnimals([original], 0, [tile(1, 0)]));
  assert.throws(() => assertAnimals(Array(MAX_STORED_ANIMALS + 1).fill(original), 0));
  const view = projectAnimal(original, 100); view.genes.speed = 0; view.parents.push('fake');
  assert.notEqual(original.genes.speed, 0); assert.equal(original.parents.length, 0); assert.equal(view.age, 600);
});

test('decision work is bounded while deferred individuals still metabolize and receive a later turn', () => {
  const tiles = Array.from({ length: MAX_ANIMAL_DECISIONS_PER_TICK + 1 }, (_, x) => tile(x * 3, 0, { fauna: 1, species: 'hare' }));
  const animals = materializeAnimals(42, tiles, 0), w = world(tiles, animals);
  const before = new Map(animals.map(a => [a.id, a.hunger]));
  run(w, 1);
  assert.equal(w.animals.filter(a => a.lastDecision === 1).length, MAX_ANIMAL_DECISIONS_PER_TICK);
  const deferred = w.animals.find(a => a.lastDecision !== 1)!;
  assert.ok(deferred.hunger > before.get(deferred.id)!);
  run(w, 1); assert.equal(deferred.lastDecision, 2);
  assert.equal(w.animals.length, MAX_ANIMAL_DECISIONS_PER_TICK + 1);
});

test('8210 regional identities survive work-budget rotation without dropping stock and every body gets a turn', () => {
  const count = MAX_ACTIVE_ANIMALS + 18;
  const tiles = Array.from({ length: count }, (_, x) => tile(x * 8, 0, { fauna: 1, species: 'hare' }));
  const animals = materializeAnimals(42, tiles, 0);
  animals.forEach(a => { a.hunger = 0.25; });
  const w = world(tiles, animals), reversed = structuredClone(w); reversed.animals.reverse(); reversed.tiles.reverse();
  const ids = animals.map(a => a.id), before = new Map(animals.map(a => [a.id, structuredClone(a)]));
  run(w, 1); run(reversed, 1);
  assert.equal(w.animals.length, count); assert.deepEqual(w.animals.map(a => a.id), ids);
  assert.equal(w.animals.filter(a => a.age === 601).length, MAX_ACTIVE_ANIMALS);
  const deferred = w.animals.filter(a => a.age === 600); assert.equal(deferred.length, 18);
  for (const a of deferred) assert.deepEqual(a, before.get(a.id), 'a deferred animal retains its body and memory exactly');
  assert.equal(w.tiles.reduce((sum, t) => sum + t.fauna!, 0), count);
  run(w, 1); run(reversed, 1);
  assert.equal(w.animals.length, count); assert.ok(w.animals.every(a => a.age >= 601));
  assert.equal(w.animals.reduce((sum, a) => sum + a.age - 600, 0), MAX_ACTIVE_ANIMALS * 2);
  assert.equal(w.animalDynamics.deaths, 0); assert.equal(w.animalDynamics.births, 0);
  assert.deepEqual(normalized(w), normalized(reversed)); assertAnimals(w.animals, w.tick, w.tiles);
});

test('calendar dormancy cannot age animals into senescence, maturity or another reproductive cooldown', () => {
  const a = animal('hare'), w = world([tile()], [a]);
  const before = structuredClone(a); w.tick = 1_000_000;
  assert.equal(projectAnimal(a, w.tick).age, 600); assert.deepEqual(a, before);
  run(w, 1); assert.equal(a.age, 601); assert.equal(a.health, 1); assert.equal(a.bornAt, before.bornAt);
  const parents = [animal('deer', 0, 0, 'one'), animal('deer', 0, 0, 'two')];
  const dormant = world([tile()], parents); dormant.reproductionEnabled = true; dormant.tick = 99_999;
  parents.forEach(p => { p.age = 20; p.lastBirthAge = 0; });
  run(dormant, 1); assert.equal(dormant.animalDynamics.births, 0, 'calendar age cannot mature dormant offspring');
  parents.forEach(p => { p.age = 600; p.lastBirthAge = 590; }); dormant.tick = 100_099;
  run(dormant, 1); assert.equal(dormant.animalDynamics.births, 0, 'calendar time cannot clear biological birth cooldown');
  parents.forEach(p => { p.age = 1190; }); dormant.tick = 100_199;
  run(dormant, 1); assert.equal(dormant.animalDynamics.births, 1);
  assert.ok(parents.every(p => p.lastBirthAge === p.age)); assertAnimals(dormant.animals, dormant.tick, dormant.tiles);
});

test('biological reproduction eligibility is not locked to a global calendar phase or rotating cohort', () => {
  const parents = [animal('deer', 0, 0, 'one'), animal('deer', 0, 0, 'two')];
  const w = world([tile()], parents); w.reproductionEnabled = true; w.tick = 1000;
  run(w, 1); assert.equal(w.animalDynamics.births, 1); assert.equal(w.animals.length, 3);
  assert.ok(parents.every(a => a.lastBirth === 1001 && a.lastBirthAge === a.age));
});

function opposingCohorts(): AnimalWorld {
  const tiles = Array.from({ length: MAX_ACTIVE_ANIMALS * 2 }, (_, x) => tile(x * 8, 0, { fauna: 1, species: 'hare' }));
  const animals = materializeAnimals(42, tiles, 0);
  animals.forEach((a, i) => { a.id = `animal-n${String(i).padStart(5, '0')}`; a.x = i * 8; a.y = 0; a.target = { x: a.x, y: 0 }; a.hunger = 0.25; });
  return world(tiles, animals);
}

test('opposite scheduling cohorts can reproduce through a resident partner without giving that partner extra physiology', () => {
  const w = opposingCohorts(), first = w.animals[0]!, second = w.animals[MAX_ACTIVE_ANIMALS]!;
  second.x = first.x; second.target = { x: first.x, y: first.y }; syncFauna(w.tiles, w.animals); w.reproductionEnabled = true;
  const control = structuredClone(w);
  [control.animals[1]!.id, control.animals[MAX_ACTIVE_ANIMALS]!.id] = [control.animals[MAX_ACTIVE_ANIMALS]!.id, control.animals[1]!.id];
  const passive = structuredClone(first), unrelated = structuredClone(w.animals[1]!);
  run(w, 1); run(control, 1);
  assert.equal(w.animalDynamics.births, 1, 'the active parent can mate with its physically adjacent passive partner');
  assert.equal(first.age, passive.age); assert.equal(first.lastDecision, passive.lastDecision); assert.equal(first.lastMove, passive.lastMove);
  assert.ok(Math.abs(first.energy - (passive.energy - 0.18)) < 1e-12);
  assert.ok(Math.abs(first.hunger - (passive.hunger + 0.12)) < 1e-12);
  assert.ok(Math.abs(first.thirst - (passive.thirst + 0.07)) < 1e-12);
  assert.ok(Math.abs(first.fatigue - (passive.fatigue + 0.1)) < 1e-12);
  assert.equal(first.lastBirthAge, passive.age); assert.deepEqual(w.animals.find(a => a.id === unrelated.id), unrelated);
  assert.equal(w.animals.filter(a => a.generation === 0 && a.age === 601).length, MAX_ACTIVE_ANIMALS);
  assert.ok(Math.abs(w.animalDynamics.plantConsumed - 0.06) < 1e-12); assert.ok(Math.abs(w.animalDynamics.waterConsumed - 0.012) < 1e-12);
  run(w, 1); run(control, 1);
  assert.equal(w.animalDynamics.births, 1); assert.equal(control.animalDynamics.births, 1, 'renaming an unrelated identity cannot make the pair sterile');
  assertAnimals(w.animals, w.tick, w.tiles); assertAnimals(control.animals, control.tick, control.tiles);
});

test('two active predators can reach one resident prey in the opposite cohort without double killing or extra prey physiology', () => {
  const w = opposingCohorts(), prey = w.animals[0]!, wolves = [w.animals[MAX_ACTIVE_ANIMALS]!, w.animals[MAX_ACTIVE_ANIMALS + 1]!];
  prey.health = 0.1;
  for (const wolf of wolves) {
    wolf.species = 'wolf'; wolf.genes = structuredClone(animal('wolf').genes); wolf.x = prey.x; wolf.y = prey.y;
    wolf.target = { x: prey.x, y: prey.y }; wolf.action = 'hunt'; wolf.preyId = prey.id; wolf.work = 3; wolf.lastDecision = 0; wolf.hunger = 0.8;
  }
  syncFauna(w.tiles, w.animals);
  const before = structuredClone(prey), events: Omit<ChronicleEvent, 'id' | 'tick'>[] = [];
  run(w, 1, events);
  assert.equal(w.animals.length, MAX_ACTIVE_ANIMALS * 2 - 1); assert.equal(w.animalDynamics.predations, 1); assert.equal(w.animalDynamics.deaths, 1);
  assert.equal(events.filter(e => e.cause === 'depredación').length, 1); assert.equal(events[0]!.actors[1], prey.id);
  assert.equal(prey.age, before.age); assert.equal(prey.hunger, before.hunger); assert.equal(prey.thirst, before.thirst);
  assert.equal(prey.energy, before.energy); assert.equal(prey.fatigue, before.fatigue);
  assert.equal(w.animals.filter(a => a.age === 601).length, MAX_ACTIVE_ANIMALS);
  assert.equal(wolves.filter(a => a.hunger < 0.7).length, 1, 'only the killer receives prey biomass');
  run(w, 1, events); assert.equal(w.animalDynamics.predations, 1); assertAnimals(w.animals, w.tick, w.tiles);
});

test('materializing and processing in the same tick cannot advance biological age beyond its calendar provenance', () => {
  const tiles = [tile(0, 0, { fauna: 1, species: 'hare' })], animals = materializeAnimals(42, tiles, 21), w = world(tiles, animals);
  const a = animals[0]!; w.tick = 21; stepAnimals(w);
  assert.equal(a.age, 600); assert.equal(a.bornAt, -579); assertAnimals(w.animals, w.tick, w.tiles);
  run(w, 1); assert.equal(a.age, 601); assertAnimals(w.animals, w.tick, w.tiles);
  w.tick = 1_000_000; run(w, 1); assert.equal(a.age, 602, 'a large calendar gap still allows only one biological interval');
  assertAnimals(w.animals, w.tick, w.tiles);
});
