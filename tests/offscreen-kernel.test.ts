import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, type World } from '../src/world/index.js';
import { generateChunk, type Chunk } from '../src/world/terrain.js';
import { materializeAnimals, stepAnimals, syncFauna } from '../src/world/animals.js';
import { advanceColdGroup } from '../src/world/offscreen-kernel.js';
import { updateEcosystemResources } from '../src/world/ecology-resources.js';
import { stepEcosystem } from '../src/world/ecosystem.js';
import { stepStructures } from '../src/world/inventions.js';
import { phaseAt } from '../src/world/time.js';

function chunk(cx = 0, cy = 0, tick = 0): Chunk {
  const result = generateChunk(42, cx, cy);
  result.lastTick = tick; result.discovered = true; result.lifeVersion = 4;
  result.animals = []; result.structures = [];
  for (const tile of result.tiles) {
    Object.assign(tile, { terrain: 'meadow', biome: 'grassland', moisture: 0.8, vegetation: 0.8,
      food: 0.2, growth: 0.8, fertility: 0.6, life: 0.1, wood: 0, stone: 0, fauna: 0, drinkingWater: 0.8, feature: 'none' });
    delete tile.species;
  }
  return result;
}
function populate(region: Chunk, x: number, y: number, count = 1) {
  const tile = region.tiles.find(tile => tile.x === x && tile.y === y)!;
  tile.fauna = count; tile.species = 'hare';
  const animals = materializeAnimals(42, [tile], region.lastTick);
  region.animals!.push(...animals); syncFauna(region.tiles, region.animals!);
  return animals;
}
function host(tick: number) {
  const world = createWorld(42); world.tick = tick; world.reproductionEnabled = false;
  return world;
}

test('bounded cold work uses fine resource, animal and structure laws with the historical weather at each tick', () => {
  const region = chunk(0, 0, 595), world = host(800);
  populate(region, 8, 8)[0]!.thirst = 0.8;
  const roof = region.tiles.find(tile => tile.x === 4 && tile.y === 4)!; roof.terrain = 'shelter';
  region.structures!.push({ id: 'structure-legacy-4-4', x: 4, y: 4, blueprintId: 'blueprint-base', name: 'Refugio',
    components: ['frame', 'roof'], condition: 1, water: 0, food: 0, uses: 0, builtAt: 0, builderId: null });
  const before = structuredClone(region), originalRng = world.rng;
  const result = advanceColdGroup(world, [region], [{ tick: 0, weather: 'rain' }, { tick: 600, weather: 'clear' }], 8);
  const exact: World = { ...world, tick: 595, people: [], tiles: structuredClone(region.tiles), animals: structuredClone(region.animals!),
    structures: structuredClone(region.structures!), animalDynamics: { ...world.animalDynamics }, inventionDynamics: { ...world.inventionDynamics } };
  for (let tick = 596; tick <= 603; tick++) {
    exact.tick = tick; exact.weather = tick < 600 ? 'rain' : 'clear';
    updateEcosystemResources(exact.tiles, tick, exact.weather, phaseAt(tick)); stepEcosystem(exact.tiles, tick, exact.weather, phaseAt(tick), false);
    stepAnimals(exact); stepStructures(exact, () => { throw new Error('Unexpected human event.'); });
  }
  assert.equal(result.chunkTicks, 8); assert.equal(result.chunks[0]!.lastTick, 603);
  assert.deepEqual(result.chunks[0]!.tiles, exact.tiles); assert.deepEqual(result.chunks[0]!.animals, exact.animals);
  assert.deepEqual(result.chunks[0]!.structures, exact.structures); assert.deepEqual(result.animalDynamics, exact.animalDynamics);
  assert.deepEqual(region, before); assert.equal(world.rng, originalRng); assert.equal(world.tick, 800);
  assert.ok(result.chunks[0]!.structures![0]!.condition < 1);
});

test('cold animals debit finite water and food; an empty patch grants neither consumption nor relief', () => {
  for (const need of ['thirst', 'hunger'] as const) {
    const full = chunk(), empty = chunk(), world = host(8);
    const fed = populate(full, 8, 8)[0]!, hungry = populate(empty, 8, 8)[0]!;
    fed[need] = hungry[need] = 0.8;
    for (const tile of empty.tiles) { tile.drinkingWater = tile.moisture = tile.vegetation = tile.growth = 0; }
    const supplied = advanceColdGroup(world, [full], [{ tick: 0, weather: 'clear' }], 8);
    const depleted = advanceColdGroup(world, [empty], [{ tick: 0, weather: 'clear' }], 8);
    assert.ok(supplied.chunks[0]!.animals![0]![need] < 0.8); assert.ok(depleted.chunks[0]!.animals![0]![need] > 0.8);
    assert.ok(supplied.animalDynamics.waterConsumed > 0); assert.equal(depleted.animalDynamics.waterConsumed, 0);
    assert.equal(depleted.animalDynamics.plantConsumed, 0);
    const total = (r: Chunk, field: 'growth' | 'drinkingWater') => r.tiles.reduce((n, tile) => n + tile[field]!, 0);
    const field = need === 'hunger' ? 'growth' : 'drinkingWater', consumed = need === 'hunger' ? supplied.animalDynamics.plantConsumed : supplied.animalDynamics.waterConsumed;
    assert.ok(Math.abs(total(full, field) - total(supplied.chunks[0]!, field) - consumed) < 1e-10);
  }
});

test('births and deaths retain their historical tick, pay parental and habitat costs, and close the population balance', () => {
  const region = chunk(), world = host(1000); world.reproductionEnabled = true;
  const parents = populate(region, 8, 8, 2);
  for (const parent of parents) {
    parent.hunger = parent.thirst = 0.2; parent.action = 'rest'; parent.lastDecision = parent.lastMove = 0;
    parent.target = { x: parent.x, y: parent.y };
  }
  const dying = populate(region, 13, 13)[0]!; dying.thirst = 1; dying.health = 0.001;
  const result = advanceColdGroup(world, [region], [{ tick: 0, weather: 'clear' }], 1);
  assert.equal(result.animalDynamics.births, 1); assert.equal(result.animalDynamics.deaths, 1);
  assert.equal(result.chunks[0]!.animals!.length, region.animals!.length + 1 - 1);
  const child = result.chunks[0]!.animals!.find(animal => animal.generation > 0)!;
  assert.equal(child.bornAt, 1); assert.equal(child.age, 0); assert.equal(result.animalCounter, world.animalCounter + 1);
  assert.deepEqual(child.parents, parents.map(parent => parent.id).sort());
  assert.ok(result.animalDynamics.waterConsumed >= 0.012); assert.ok(result.animalDynamics.plantConsumed >= 0.06);
  for (const parent of parents) assert.ok(result.chunks[0]!.animals!.find(animal => animal.id === parent.id)!.energy < parent.energy - 0.17);
  assert.equal(result.events.length, 2); assert.ok(result.events.every(event => event.tick === 1 && event.observedAt === 1000));
  assert.equal(world.animalCounter, 0); assert.equal(world.animalDynamics.births, 0);
});

test('equal-time neighboring regions allow a single identity to cross their boundary with movement cost', () => {
  const left = chunk(), right = chunk(1), world = host(1);
  const traveler = populate(left, 15, 8)[0]!;
  for (const tile of left.tiles) tile.drinkingWater = 0;
  traveler.thirst = 0.8;
  const result = advanceColdGroup(world, [left, right], [{ tick: 0, weather: 'clear' }], 8);
  assert.equal(result.chunkTicks, 2); assert.equal(result.migrations, 1);
  assert.equal(result.chunks[0]!.animals!.length, 0); assert.equal(result.chunks[1]!.animals!.length, 1);
  const arrived = result.chunks[1]!.animals![0]!;
  assert.equal(arrived.id, traveler.id); assert.equal(arrived.x, 16); assert.equal(arrived.y, 8);
  assert.ok(arrived.energy < traveler.energy - 0.0015); assert.equal(result.animalCounter, 0);
  const closed = advanceColdGroup(world, [left], [{ tick: 0, weather: 'clear' }], 8);
  assert.equal(closed.migrations, 0); assert.ok(closed.chunks[0]!.animals!.every(animal => animal.x < 16));
});

test('rain storage and irrigation apply the same finite-reservoir law while no absent humans can deposit food', () => {
  const region = chunk(0, 0, 9), world = host(10), tile = region.tiles.find(tile => tile.x === 8 && tile.y === 8)!;
  tile.terrain = 'shelter';
  region.structures!.push({ id: 'structure-1', x: 8, y: 8, blueprintId: 'blueprint-1', name: 'Reserva existente',
    components: ['frame', 'roof', 'cistern', 'garden'], condition: 1, water: 0, food: 0, uses: 0, builtAt: 0, builderId: null });
  const granaryTile = region.tiles.find(tile => tile.x === 12 && tile.y === 12)!; granaryTile.terrain = 'shelter';
  region.structures!.push({ id: 'structure-2', x: 12, y: 12, blueprintId: 'blueprint-2', name: 'Granero existente',
    components: ['frame', 'roof', 'granary'], condition: 1, water: 0, food: 0.2, uses: 0, builtAt: 0, builderId: null });
  for (const tile of region.tiles) tile.moisture = 0.3;
  const result = advanceColdGroup(world, [region], [{ tick: 0, weather: 'rain' }], 8), stored = result.chunks[0]!.structures![0]!;
  assert.ok(stored.condition < 1); assert.ok(stored.water > 0); assert.equal(result.chunks[0]!.structures![1]!.food, 0.2);
  assert.ok(result.inventionDynamics.waterCollected > stored.water); assert.equal(result.inventionDynamics.foodStored, 0);
  assert.equal(stored.uses, 0, 'rain and storage cannot earn human utility');
});

test('future neighbors, duplicate identities, missing weather and invalid budgets reject before mutating opening state', () => {
  const left = chunk(), right = chunk(1), world = host(20); populate(left, 15, 8);
  const before = structuredClone([left, right]);
  for (const budget of [0, -1, 1.5, 65, Infinity]) assert.throws(() => advanceColdGroup(world, [left], [{ tick: 0, weather: 'clear' }], budget));
  const future = structuredClone(right); future.lastTick = 1;
  assert.throws(() => advanceColdGroup(world, [left, future], [{ tick: 0, weather: 'clear' }], 8));
  const duplicate = structuredClone(right), copy = structuredClone(left.animals![0]!); copy.x = 16; copy.target.x = 16;
  duplicate.animals!.push(copy); syncFauna(duplicate.tiles, duplicate.animals!);
  assert.throws(() => advanceColdGroup(world, [left, duplicate], [{ tick: 0, weather: 'clear' }], 8));
  const gap = chunk(0, 0, 599);
  assert.throws(() => advanceColdGroup(host(608), [gap], [{ tick: 0, weather: 'clear' }], 8));
  gap.lastTick = 600;
  assert.throws(() => advanceColdGroup(host(608), [gap], [{ tick: 0, weather: 'clear' }], 8));
  assert.deepEqual([left, right], before);
});
