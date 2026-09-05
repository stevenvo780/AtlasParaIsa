import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceBody, assimilateFood, exertBody, hydrateBody, restBody, type BodyState, type BodyRates } from '../src/world/body.js';
import { advanceNeeds } from '../src/world/needs.js';
import { materializeAnimals, stepAnimals, syncFauna, type Animal, type AnimalWorld } from '../src/world/animals.js';
import { createWorld, stepWorld, tileAt, type World } from '../src/world/index.js';
import type { AnimalSpecies } from '../src/shared/life.js';
import type { Tile } from '../src/shared/types.js';
import { demographicTraits } from '../src/world/demography.js';

const clamp = (n: number) => Math.max(0, Math.min(1, n));
const bars = (b: BodyState): BodyState => ({ hunger: b.hunger, thirst: b.thirst, energy: b.energy, fatigue: b.fatigue });
const initial = (): BodyState => ({ hunger: 0.8499, thirst: 0.8499, energy: 0.65, fatigue: 0.4 });

// Frozen pre-refactor formulas, including the original expression ordering. This oracle does not call body.ts.
function previousBasal(body: BodyState, rates: BodyRates, dt = 1): void {
  body.hunger = clamp(body.hunger + rates.hunger * dt);
  body.thirst = clamp(body.thirst + rates.thirst * dt);
  body.energy = clamp(body.energy - (rates.energy + (body.hunger > 0.85 ? rates.stressEnergy : 0)
    + (body.thirst > 0.85 ? rates.stressEnergy : 0)) * dt);
  body.fatigue = clamp(body.fatigue + rates.fatigue * dt);
}

test('shared laws retain the exact human, herbivore and predator arithmetic over repeated mixed activity', () => {
  for (const kind of ['human', 'grazer', 'predator'] as const) {
    const actual = initial(), expected = initial();
    const rates = kind === 'human'
      ? { hunger: 0.00027 * 1.13, thirst: 0.00065 * 0.92, energy: 0.00007, stressEnergy: 0.00015, fatigue: 0.00019 }
      : { hunger: 0.00042 * 1.17, thirst: 0.00048 * (1.3 - 0.71 * 0.6), energy: 0.00008 * 1.17, stressEnergy: 0.0002, fatigue: 0.00012 };
    for (let tick = 1; tick <= 1200; tick++) {
      advanceNeeds(actual, rates); previousBasal(expected, rates);
      const cost = kind === 'human' ? { energy: 0.0008, fatigue: 0.0007 * (1.2 - 0.71 * 0.4) }
        : { energy: tick % 3 ? 0.0015 : 0.003, fatigue: tick % 3 ? 0.002 : 0.004 };
      if (tick % 6 === 0) {
        exertBody(actual, cost);
        expected.energy = clamp(expected.energy - cost.energy); expected.fatigue = clamp(expected.fatigue + cost.fatigue);
      }
      const consumed = tick % 11 * 0.0001;
      if (kind === 'human') {
        assimilateFood(actual, consumed, { hungerPerUnit: 4.8, energyPerUnit: 1.2 });
        expected.hunger = clamp(expected.hunger - consumed * 4.8); expected.energy = clamp(expected.energy + consumed * 1.2);
      } else if (kind === 'grazer') {
        assimilateFood(actual, consumed, { hungerPerUnit: 4, assimilation: 1 - 0.1937, energyPerUnit: 0.8 });
        expected.hunger = clamp(expected.hunger - consumed * 4 * (1 - 0.1937)); expected.energy = clamp(expected.energy + consumed * 0.8);
      } else {
        assimilateFood(actual, consumed, { hungerPerUnit: 4.8, assimilation: 0.9123, energyPerUnit: 0.5 });
        expected.hunger = clamp(expected.hunger - consumed * 4.8 * 0.9123); expected.energy = clamp(expected.energy + consumed * 0.5);
      }
      const water = tick % 7 * 0.0001;
      hydrateBody(actual, water); expected.thirst = clamp(expected.thirst - water * 3);
      if (tick % 4 === 0) {
        if (kind === 'human') {
          const quality = tick % 8 === 0 ? 0.2 : 0.55;
          restBody(actual, { fatigue: 0.0018, energy: 0.0011 }, quality);
          expected.fatigue = clamp(expected.fatigue - 0.0018 * quality);
          expected.energy = clamp(expected.energy + 0.0011 * quality * clamp((1 - Math.max(expected.hunger, expected.thirst)) / 0.5));
        } else {
          restBody(actual, { fatigue: 0.002, energy: 0.0015 });
          expected.fatigue = clamp(expected.fatigue - 0.002);
          expected.energy = clamp(expected.energy + 0.0015 * clamp((1 - Math.max(expected.hunger, expected.thirst)) / 0.5));
        }
      }
      assert.deepEqual(actual, expected, `${kind}, tick ${tick}`);
    }
  }
});

test('deprivation stress sees newly crossed thresholds and rest cannot erase hunger or thirst', () => {
  const body = initial();
  advanceBody(body, { hunger: 0.00027, thirst: 0.00045, energy: 0.00007, stressEnergy: 0.00015, fatigue: 0.00009 });
  assert.equal(body.energy, 0.65 - (0.00007 + 0.00015 + 0.00015));
  for (const need of ['hunger', 'thirst'] as const) {
    const deprived = { hunger: 0.2, thirst: 0.2, energy: 0.3, fatigue: 0.8, [need]: 1 };
    restBody(deprived, { fatigue: 0.002, energy: 0.0015 });
    assert.equal(deprived.energy, 0.3); assert.equal(deprived[need], 1); assert.equal(deprived.fatigue, 0.8 - 0.002);
  }
});

test('zero actual intake cannot create recovery and invalid inputs fail before any bodily mutation', () => {
  const body = initial(), original = structuredClone(body);
  assimilateFood(body, 0, { hungerPerUnit: 4.8, energyPerUnit: 1.2 }); hydrateBody(body, 0);
  exertBody(body, { energy: 0, fatigue: 0 }); restBody(body, { fatigue: 0.002, energy: 0.0015 }, 0);
  assert.deepEqual(body, original);
  const rates = { hunger: 0.001, thirst: 0.001, energy: 0.001, stressEnergy: 0.001, fatigue: 0.001 };
  const cases = [
    () => advanceBody(body, { ...rates, stressEnergy: NaN }),
    () => advanceBody(body, rates, -1),
    () => advanceBody(body, { ...rates, energy: Number.MAX_VALUE, stressEnergy: Number.MAX_VALUE }, NaN),
    () => advanceBody(body, { ...rates, fatigue: undefined } as unknown as BodyRates),
    () => exertBody(body, { energy: 0.1, fatigue: -0.1 }),
    () => restBody(body, { energy: Infinity, fatigue: 0.1 }),
    () => restBody(body, { energy: 0.1, fatigue: 0.1 }, 2),
    () => assimilateFood(body, -1, { hungerPerUnit: 4.8, energyPerUnit: 1.2 }),
    () => assimilateFood(body, 0.1, { hungerPerUnit: 4.8, energyPerUnit: NaN }),
    () => assimilateFood(body, 0.1, { hungerPerUnit: 4.8, energyPerUnit: 1.2, assimilation: -1 }),
    () => assimilateFood(body, 0.1, { hungerPerUnit: 4.8, energyPerUnit: 1.2, assimilation: null! }),
    () => assimilateFood(body, Number.MAX_VALUE, { hungerPerUnit: Number.MAX_VALUE, energyPerUnit: 1, assimilation: 0 }),
    () => hydrateBody(body, 0.1, Infinity),
  ];
  for (const invalid of cases) { assert.throws(invalid, RangeError); assert.deepEqual(body, original); }
  const malformed = { ...body, fatigue: NaN }, before = structuredClone(malformed);
  assert.throws(() => exertBody(malformed, { energy: 0.1, fatigue: 0.1 }), RangeError); assert.deepEqual(malformed, before);
  const extreme = { ...body, hunger: 0.9, thirst: 0.9 }, originalExtreme = structuredClone(extreme);
  assert.throws(() => advanceBody(extreme, { ...rates, energy: Number.MAX_VALUE, stressEnergy: Number.MAX_VALUE }, 0), RangeError);
  assert.deepEqual(extreme, originalExtreme);
});

function tile(x = 0, overrides: Partial<Tile> = {}): Tile {
  return { x, y: 0, terrain: 'meadow', biome: 'grassland', moisture: 0.8, vegetation: 0.8, growth: 0.8,
    food: 0.2, fauna: 0, drinkingWater: 0.8, fertility: 0.6, ...overrides };
}
function scene(species: AnimalSpecies, overrides: Partial<Animal> = {}, patches: Tile[] = [tile()]): AnimalWorld {
  const animal = materializeAnimals(42, [tile(0, { fauna: 1, species })], 0)[0]!;
  Object.assign(animal, { hunger: 0.3, thirst: 0.3, energy: 0.6, fatigue: 0.2, lastDecision: 0 }, overrides);
  syncFauna(patches, [animal]);
  return { seed: 42, tick: 0, animals: [animal], tiles: patches, animalCounter: 0, reproductionEnabled: false,
    animalDynamics: { births: 0, deaths: 0, predations: 0, humanHunts: 0, waterConsumed: 0, plantConsumed: 0 } };
}
function next(w: AnimalWorld): void { w.tick++; stepAnimals(w); }
function previousAnimalBasal(a: Animal, patch: Tile): BodyState {
  const result = bars(a), metabolism = 0.6 + a.genes.metabolism * 0.8;
  previousBasal(result, { hunger: 0.00042 * metabolism, thirst: 0.00048 * (1.3 - a.genes.waterEfficiency * 0.6)
    + (patch.biome === 'desert' ? 0.00015 : 0), energy: 0.00008 * metabolism, stressEnergy: 0.0002, fatigue: 0.00012 });
  return result;
}

test('real grazer bodies assimilate exactly the scarce growth and plant moisture debited from their cell', () => {
  for (const species of ['hare', 'boar'] as const) {
    const w = scene(species, { action: 'graze', hunger: 0.7 }, [tile(0, { growth: 0.0007, moisture: 0.0002 })]);
    const a = w.animals[0]!, expected = previousAnimalBasal(a, w.tiles[0]!);
    expected.hunger = clamp(expected.hunger - 0.0007 * 4 * (1 - a.genes.carnivory));
    expected.energy = clamp(expected.energy + 0.0007 * 0.8); expected.thirst = clamp(expected.thirst - 0.0002 * 0.3);
    next(w); assert.deepEqual(bars(a), expected); assert.equal(w.tiles[0]!.growth, 0); assert.equal(w.tiles[0]!.moisture, 0);
    assert.equal(w.animalDynamics.plantConsumed, 0.0007);
    const empty = previousAnimalBasal(a, w.tiles[0]!);
    // Keep this paid action for one further turn to exercise a genuinely empty local source.
    a.lastDecision = w.tick; next(w); assert.deepEqual(bars(a), empty); assert.equal(w.animalDynamics.plantConsumed, 0.0007);
  }
});

test('terrestrial and aquatic hydration share bodily conversion but debit their actual distinct local stocks', () => {
  for (const species of ['deer', 'fish'] as const) {
    const aquatic = species === 'fish';
    const w = scene(species, { action: 'drink', thirst: 0.7 }, [tile(0, { terrain: aquatic ? 'water' : 'meadow',
      biome: aquatic ? 'ocean' : 'grassland', drinkingWater: aquatic ? 0 : 0.0007, moisture: aquatic ? 0.0007 : 0.8 })]);
    const a = w.animals[0]!, expected = previousAnimalBasal(a, w.tiles[0]!);
    expected.thirst = clamp(expected.thirst - 0.0007 * 3);
    next(w); assert.deepEqual(bars(a), expected); assert.equal(w.animalDynamics.waterConsumed, 0.0007);
    assert.equal(w.tiles[0]![aquatic ? 'moisture' : 'drinkingWater'], 0);
    const exhausted = previousAnimalBasal(a, w.tiles[0]!); a.lastDecision = w.tick; next(w);
    assert.deepEqual(bars(a), exhausted); assert.equal(w.animalDynamics.waterConsumed, 0.0007);
  }
});

test('successful movement pays extra work, a blocked path does not, and exhaustion changes the chosen destination', () => {
  for (const species of ['hare', 'deer'] as const) {
    const mobile = scene(species, { action: 'roam', target: { x: 1, y: 0 } }, [tile(), tile(1)]);
    const blocked = scene(species, { action: 'roam', target: { x: 1, y: 0 } });
    const a = mobile.animals[0]!, b = blocked.animals[0]!, expected = previousAnimalBasal(a, mobile.tiles[0]!);
    expected.energy = clamp(expected.energy - 0.0015); expected.fatigue = clamp(expected.fatigue + 0.002);
    next(mobile); next(blocked); assert.deepEqual(bars(a), expected); assert.equal(a.x, 1); assert.equal(b.x, 0);
    assert.equal(a.energy, b.energy - 0.0015); assert.equal(a.fatigue, b.fatigue + 0.002);
    const tired = scene(species, { action: 'roam', target: { x: 1, y: 0 }, energy: 0.2, fatigue: 0.8, lastDecision: -12 }, [tile(), tile(1)]);
    next(tired); const rest = tired.animals[0]!;
    assert.equal(rest.action, 'rest'); assert.deepEqual(rest.target, { x: 0, y: 0 }); assert.equal(rest.x, 0);
    assert.ok(rest.energy > 0.2); assert.ok(rest.fatigue < 0.8); assert.ok(rest.hunger > 0.3 && rest.thirst > 0.3);
  }
});

function humanScene(action: 'approach' | 'eat' | 'drink' | 'rest' | 'forage') {
  const world = createWorld(51926), person = world.people[2]!;
  world.reproductionEnabled = false; world.cooperationEnabled = false; world.shelterBenefitEnabled = false;
  world.weather = 'clear';
  for (const p of world.people) {
    p.action = 'approach'; p.target = { x: p.x, y: p.y }; p.decisionAt = 10000;
    p.hunger = p.thirst = p.fatigue = 0.3; p.energy = 0.6;
  }
  person.x = 36; person.y = 12; person.target = { x: person.x, y: person.y }; person.action = action; person.work = 0; person.inventory = 0;
  const patch = tileAt(world, person)!; patch.terrain = 'meadow'; patch.biome = 'grassland'; patch.food = 0.5; patch.drinkingWater = 0.5;
  return { world, person, patch };
}
function previousHumanBasal(w: World): BodyState {
  const a = w.people[2]!, result = bars(a), traits = demographicTraits(a.genome), patch = tileAt(w, a)!;
  previousBasal(result, { hunger: 0.00027 * traits.foodDemand,
    thirst: (0.00045 + (patch.biome === 'desert' ? 0.0002 : 0)) * traits.waterDemand,
    energy: 0.00007, stressEnergy: 0.00015, fatigue: 0.00009 });
  return result;
}

test('real human eating partitions finite food before bodily assimilation; drinking and work preserve their existing costs', () => {
  const eating = humanScene('eat'), fed = previousHumanBasal(eating.world);
  const harvested = 0.0035, stored = harvested * 0.25, consumed = harvested - stored;
  fed.hunger = clamp(fed.hunger - consumed * 4.8); fed.energy = clamp(fed.energy + consumed * 1.2);
  stepWorld(eating.world); assert.deepEqual(bars(eating.person), fed);
  assert.equal(eating.patch.food, 0.5 - harvested); assert.equal(eating.person.inventory, stored);
  const drinking = humanScene('drink'), hydrated = previousHumanBasal(drinking.world);
  hydrated.thirst = clamp(hydrated.thirst - 0.006 * 3);
  stepWorld(drinking.world); assert.deepEqual(bars(drinking.person), hydrated); assert.equal(drinking.patch.drinkingWater, 0.5 - 0.006);
  const working = humanScene('forage'), paid = previousHumanBasal(working.world);
  paid.energy = clamp(paid.energy - 0.0003); paid.fatigue = clamp(paid.fatigue + 0.00025 * (1.2 - working.person.traits.resilience * 0.4));
  stepWorld(working.world); assert.deepEqual(bars(working.person), paid); assert.equal(working.person.work, 1);
  assert.equal(working.patch.food, 0.5); assert.equal(working.person.inventory, 0, 'partial work produces no food');
});

test('real human rest retains the old per-tick law over repeated steps without satiating needs', () => {
  const { world, person } = humanScene('rest');
  for (let tick = 0; tick < 24; tick++) {
    const expected = previousHumanBasal(world);
    expected.fatigue = clamp(expected.fatigue - 0.0018 * 0.55);
    expected.energy = clamp(expected.energy + 0.0011 * 0.55 * clamp((1 - Math.max(expected.hunger, expected.thirst)) / 0.5));
    stepWorld(world); assert.deepEqual(bars(person), expected);
  }
  assert.ok(person.hunger > 0.3 && person.thirst > 0.3); assert.ok(person.energy > 0.6); assert.ok(person.fatigue < 0.3);
});

test('a real human pays the inherited movement cost only after one local step', () => {
  const { world, person } = humanScene('approach');
  for (let tick = 0; tick < 5; tick++) {
    const expected = previousHumanBasal(world); stepWorld(world); assert.deepEqual(bars(person), expected);
  }
  person.target = { x: person.x + 1, y: person.y };
  tileAt(world, person.target)!.terrain = 'meadow';
  const start = { x: person.x, y: person.y }, expected = previousHumanBasal(world);
  expected.energy = clamp(expected.energy - 0.0008);
  expected.fatigue = clamp(expected.fatigue + 0.0007 * (1.2 - person.traits.resilience * 0.4));
  stepWorld(world);
  assert.deepEqual({ x: person.x, y: person.y }, { x: start.x + 1, y: start.y });
  assert.deepEqual(bars(person), expected);
});
