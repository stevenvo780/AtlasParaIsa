import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tile } from '../src/shared/types.js';
import { generateChunk, generateTile } from '../src/world/terrain.js';
import { initializeEcosystem, stepEcosystem, harvestAnimal, harvestMaterial, cultivateTile, trampleTile } from '../src/world/ecosystem.js';

function cell(x = 0, y = 0, overrides: Partial<Tile> = {}): Tile {
  return { x, y, terrain: 'meadow', biome: 'grassland', moisture: 0.8, vegetation: 0.5, food: 0.2,
    wood: 0, stone: 0, feature: 'none', variety: 0, growth: 0.8, fertility: 0.5, cultivation: 0,
    traffic: 0, drinkingWater: 0.8, life: 0, fauna: 0, ...overrides };
}
const sorted = (tiles: Tile[]): Tile[] => [...tiles].sort((a, b) => a.y - b.y || a.x - b.x);
const fauna = (tiles: Tile[]): number => tiles.reduce((sum, tile) => sum + (tile.fauna ?? 0), 0);

test('initialization is pure and deterministic and never refills explicitly depleted fields', () => {
  const original: Tile = { x: -19, y: 37, terrain: 'soil', biome: 'forest', moisture: 0.7, vegetation: 0,
    food: 0, wood: 0, stone: 0, feature: 'stump', growth: 0, fertility: 0, cultivation: 0, traffic: 0,
    drinkingWater: 0, life: 0, fauna: 0 };
  const before = structuredClone(original);
  const enriched = initializeEcosystem(42, original);
  assert.deepEqual(original, before);
  for (const [field, value] of Object.entries(before)) assert.deepEqual(enriched[field as keyof Tile], value);
  assert.equal(enriched.species, undefined);
  assert.deepEqual(initializeEcosystem(42, enriched), enriched);
  assert.deepEqual(initializeEcosystem(42, original), enriched);
  assert.notEqual(enriched, original);
});

test('procedural biomes contain varied features, finite fresh water and all four sparse animal species', () => {
  const features = new Set<string>(), species = new Set<string>();
  let occupied = 0, fresh = 0, salt = 0, samples = 0;
  for (let y = -1000; y <= 1000; y += 20) for (let x = -1000; x <= 1000; x += 20) {
    const tile = generateTile(51926, x, y); samples++;
    features.add(tile.feature!);
    if (tile.species) { species.add(tile.species); occupied++; }
    if (tile.drinkingWater! > 0) {
      fresh++;
      assert.ok(tile.feature === 'pool' || tile.feature === 'spring' || tile.biome === 'wetland' || tile.terrain === 'water');
    }
    if (tile.biome === 'ocean') { salt++; assert.equal(tile.drinkingWater, 0); }
    assert.ok(Number.isInteger(tile.variety) && tile.variety! >= 0 && tile.variety! <= 3);
    assert.ok(Number.isInteger(tile.fauna) && tile.fauna! >= 0 && tile.fauna! <= 6);
  }
  for (const feature of ['tree', 'pine', 'palm', 'cactus', 'reeds', 'berries', 'flowers', 'rock', 'clay', 'spring', 'pool']) assert.ok(features.has(feature), `${feature} needs a real procedural example`);
  assert.deepEqual([...species].sort(), ['boar', 'deer', 'fish', 'hare']);
  assert.ok(occupied > 30 && occupied / samples < 0.1, 'fauna is sparse, not a full tile overlay');
  assert.ok(fresh > 0 && salt > 0);
});

test('temperate starting regions have visible water while arid regions retain resource scarcity', () => {
  const reservesBySeed = new Map<number, number>();
  for (const seed of [1, 42, 2026, 51926, 98765]) {
    let reserves = 0, ordinarySoil = 0;
    for (let y = 0; y < 28; y++) for (let x = 0; x < 40; x++) {
      const tile = generateTile(seed, x, y);
      if (tile.drinkingWater! > 0) reserves++;
      else if (tile.terrain !== 'water') ordinarySoil++;
    }
    reservesBySeed.set(seed, reserves);
    if (seed !== 98765) assert.ok(reserves >= 8, `seed ${seed} needs distributed visible water`);
    assert.ok(ordinarySoil > 100, `seed ${seed} must retain non-potable soil`);
  }
  assert.ok(reservesBySeed.get(98765)! > 0);
  assert.ok(reservesBySeed.get(98765)! < reservesBySeed.get(51926)! / 4, 'arid landscapes cannot receive invisible free water');
});

test('cellular neighbors are read from the old buffer and the layer changes soil and future plant growth', () => {
  const colony = [cell(0, 0), cell(-1, 0, { life: 1 }), cell(0, -1, { life: 1 }), cell(1, 0, { life: 1 })];
  const reverse = structuredClone(colony).reverse();
  const twoNeighbors = structuredClone(colony); twoNeighbors[3]!.life = 0;
  stepEcosystem(colony, 10, 'clear', 'day'); stepEcosystem(reverse, 10, 'clear', 'day'); stepEcosystem(twoNeighbors, 10, 'clear', 'day');
  assert.deepEqual(sorted(colony), sorted(reverse));
  assert.ok(colony[0]!.life! > twoNeighbors[0]!.life!);
  stepEcosystem(colony, 20, 'clear', 'day'); stepEcosystem(twoNeighbors, 20, 'clear', 'day');
  assert.ok(colony[0]!.fertility! > twoNeighbors[0]!.fertility!);
  assert.ok(colony[0]!.growth! > twoNeighbors[0]!.growth!);
  assert.equal(colony[0]!.food, 0.2, 'cellular production must not add a second independent food source');
});

test('rain and spring recharge have bounded explicit rates while seawater stays non-potable', () => {
  const dry = cell(0, 0, { drinkingWater: 0, feature: 'pool' }), rain = structuredClone(dry);
  const spring = cell(1, 0, { drinkingWater: 0, feature: 'spring' });
  const ocean = cell(2, 0, { terrain: 'water', biome: 'ocean', drinkingWater: 0 });
  const moistSoil = cell(3, 0, { drinkingWater: 0 });
  stepEcosystem([dry], 10, 'clear', 'day'); stepEcosystem([rain, spring, ocean, moistSoil], 10, 'rain', 'day');
  assert.equal(dry.drinkingWater, 0);
  assert.equal(moistSoil.drinkingWater, 0);
  assert.ok(rain.drinkingWater! > 0 && rain.drinkingWater! < 0.008);
  assert.ok(spring.drinkingWater! > rain.drinkingWater! && spring.drinkingWater! < 0.01);
  for (let tick = 20; tick <= 1000; tick += 10) stepEcosystem([ocean], tick, 'rain', 'day');
  assert.equal(ocean.drinkingWater, 0);
  const clearSpring = cell(3, 0, { feature: 'spring', drinkingWater: 0 });
  stepEcosystem([clearSpring], 10, 'clear', 'night');
  assert.ok(clearSpring.drinkingWater! > 0 && clearSpring.drinkingWater! <= 0.002);
});

test('material harvest removes actual stocks and changes exhausted trees and rocks', () => {
  const tree = cell(0, 0, { feature: 'tree', wood: 2, stone: 0 });
  assert.equal(harvestMaterial(tree, 'wood', 1), 1); assert.equal(tree.wood, 1);
  assert.equal(tree.feature, 'tree');
  assert.equal(harvestMaterial(tree, 'wood', 20), 1); assert.equal(tree.wood, 0);
  assert.equal(tree.feature, 'stump'); assert.equal(harvestMaterial(tree, 'wood', 1), 0);
  assert.equal(initializeEcosystem(42, tree).wood, 0);
  const rock = cell(0, 0, { feature: 'rock', stone: 1.5 });
  assert.equal(harvestMaterial(rock, 'stone', 3), 1.5); assert.equal(rock.stone, 0); assert.equal(rock.feature, 'none');
  assert.throws(() => harvestMaterial(rock, 'stone', -1), RangeError);
  assert.throws(() => harvestMaterial(tree, 'wood', Infinity), RangeError);
  assert.throws(() => harvestMaterial(tree, 'wood', NaN), RangeError);
});

test('wood recovery requires light, moisture and living growth; stone never regrows', () => {
  const viable = cell(0, 0, { feature: 'stump', growth: 0.9, fertility: 0.8, wood: 0, stone: 0 });
  const dark = structuredClone(viable), barren = structuredClone(viable);
  barren.growth = 0;
  stepEcosystem([viable], 100, 'clear', 'day'); stepEcosystem([dark], 100, 'clear', 'night'); stepEcosystem([barren], 100, 'clear', 'day');
  assert.ok(viable.wood! > 0 && viable.wood! < 0.025);
  assert.equal(dark.wood, 0); assert.equal(barren.wood, 0);
  assert.equal(viable.stone, 0);
});

test('cultivation changes the soil without instant food; repeated footsteps suppress plant recovery', () => {
  const farm = cell(0, 0, { growth: 0.3, vegetation: 0.3 });
  assert.equal(cultivateTile(farm), true); assert.ok(farm.cultivation! > 0); assert.ok(farm.fertility! > 0.5); assert.equal(farm.food, 0.2);
  const dry = cell(0, 0, { moisture: 0.1 }); const before = structuredClone(dry);
  assert.equal(cultivateTile(dry), false); assert.deepEqual(dry, before);
  const meadow = cell(), trail = structuredClone(meadow);
  for (let n = 0; n < 20; n++) trampleTile(trail);
  assert.ok(trail.traffic! > meadow.traffic!); assert.ok(trail.growth! < meadow.growth!);
  stepEcosystem([trail], 10, 'clear', 'day'); stepEcosystem([meadow], 10, 'clear', 'day');
  assert.ok(trail.growth! < meadow.growth!); assert.ok(trail.vegetation < meadow.vegetation);
});

test('hunting yields only actual bounded animal biomass and depletion never silently repopulates', () => {
  const animals = cell(0, 0, { fauna: 2, species: 'deer' });
  assert.equal(harvestAnimal(animals), 0.25); assert.equal(animals.fauna, 1);
  assert.equal(harvestAnimal(animals), 0.25); assert.equal(animals.fauna, 0); assert.equal(animals.species, undefined);
  assert.equal(harvestAnimal(animals), 0); assert.equal(animals.food, 0.2);
  assert.equal(initializeEcosystem(42, animals).fauna, 0);
  for (let tick = 10; tick <= 1000; tick += 10) stepEcosystem([animals], tick, 'rain', 'day');
  assert.equal(animals.fauna, 0);
  for (const species of ['hare', 'boar', 'fish'] as const) {
    const specimen = cell(0, 0, { fauna: 1, species });
    const yieldFood = harvestAnimal(specimen);
    assert.ok(yieldFood > 0 && yieldFood <= 0.25); assert.equal(specimen.fauna, 0);
  }
});

test('competing migrations preserve biomass, respect six-animal capacity and are permutation independent', () => {
  const tiles = [cell(0, 0, { fauna: 5, species: 'hare' }),
    cell(-1, 0, { fauna: 1, species: 'hare', growth: 0.08 }),
    cell(1, 0, { fauna: 1, species: 'hare', growth: 0.08 }),
    cell(0, -1, { fauna: 1, species: 'hare', growth: 0.08 })];
  const reverse = structuredClone(tiles).reverse(), before = fauna(tiles);
  stepEcosystem(tiles, 50, 'clear', 'night'); stepEcosystem(reverse, 50, 'clear', 'night');
  assert.equal(fauna(tiles), before); assert.equal(tiles[0]!.fauna, 6);
  assert.deepEqual(sorted(tiles), sorted(reverse));
  assert.ok(tiles.every(t => t.fauna! <= 6 && t.fauna! >= 0));
});

test('species conflicts and unloaded boundaries cannot erase or clone rejected migrants', () => {
  const competition = [cell(0, 0), cell(-1, 0, { fauna: 1, species: 'hare', growth: 0.08 }), cell(1, 0, { fauna: 1, species: 'boar', growth: 0.08 })];
  const reverse = structuredClone(competition).reverse();
  stepEcosystem(competition, 50, 'clear', 'night'); stepEcosystem(reverse, 50, 'clear', 'night');
  assert.equal(fauna(competition), 2); assert.equal(competition[0]!.fauna, 1);
  assert.deepEqual(sorted(competition), sorted(reverse));
  assert.equal(competition.filter(t => t.species === 'hare').reduce((sum, t) => sum + t.fauna!, 0), 1);
  assert.equal(competition.filter(t => t.species === 'boar').reduce((sum, t) => sum + t.fauna!, 0), 1);
  const edge = [cell(999, -999, { fauna: 2, species: 'deer', growth: 0.08 })];
  stepEcosystem(edge, 50, 'clear', 'night');
  assert.equal(edge.length, 1); assert.equal(edge[0]!.fauna, 2);
});

test('each birth consumes additional growth and water, cannot occur from zero population or exceed capacity', () => {
  const breeding = cell(0, 0, { fauna: 2, species: 'hare' }), feedingOnly = structuredClone(breeding);
  stepEcosystem([breeding], 200, 'clear', 'night'); stepEcosystem([feedingOnly], 150, 'clear', 'night');
  assert.equal(breeding.fauna, 3); assert.equal(feedingOnly.fauna, 2);
  assert.ok(Math.abs(feedingOnly.growth! - breeding.growth! - 0.12) < 1e-12);
  assert.ok(Math.abs(feedingOnly.drinkingWater! - breeding.drinkingWater! - 0.025) < 1e-12);
  const full = cell(0, 0, { fauna: 6, species: 'hare' }); stepEcosystem([full], 200, 'clear', 'night'); assert.equal(full.fauna, 6);
  const scarce = cell(0, 0, { fauna: 2, species: 'hare', growth: 0.04 }); stepEcosystem([scarce], 200, 'clear', 'night'); assert.equal(scarce.fauna, 2);
  const thirst = cell(0, 0, { fauna: 2, species: 'hare', drinkingWater: 0.004, moisture: 0 }); stepEcosystem([thirst], 200, 'clear', 'night'); assert.equal(thirst.fauna, 2);
});

test('herbivores debit plant moisture when there is no potable reservoir, without creating drinking water', () => {
  const herbivore = cell(0, 0, { fauna: 2, species: 'hare', drinkingWater: 0 });
  const dry = cell(10, 10, { fauna: 2, species: 'hare', drinkingWater: 0, moisture: 0 });
  stepEcosystem([herbivore, dry], 50, 'clear', 'night');
  assert.equal(herbivore.fauna, 2); assert.equal(herbivore.drinkingWater, 0);
  assert.ok(Math.abs(herbivore.moisture - 0.77) < 1e-12);
  assert.equal(dry.fauna, 0); assert.equal(dry.drinkingWater, 0);
});

test('saline habitat exchanges with ambient ocean while fish consume finite local nutrients', () => {
  const fish = cell(1, 0, { terrain: 'water', biome: 'ocean', fauna: 2, species: 'fish', moisture: 0.8, drinkingWater: 0 });
  const land = cell(0, 0, { fauna: 1, species: 'hare', growth: 0.08 });
  stepEcosystem([fish, land], 50, 'clear', 'night');
  assert.equal(fish.drinkingWater, 0); assert.ok(Math.abs(fish.moisture - 0.8) < 1e-12); assert.equal(fish.species, 'fish');
  assert.ok(fish.growth! < 0.8);
  assert.equal(land.species, 'hare'); assert.equal(land.fauna, 1);
  for (let tick = 60; tick <= 1000; tick += 10) stepEcosystem([fish], tick, 'clear', 'night');
  assert.equal(fish.drinkingWater, 0); assert.ok(fish.moisture > 0.8);
  assert.ok(fish.growth! < 0.3, 'ambient seawater does not replace exhausted aquatic nutrients');
});

test('several cycles retain bounded fields and exact order invariance under rain and night', () => {
  const tiles = generateChunk(51926, -3, 4).tiles;
  const reverse = structuredClone(tiles).reverse();
  for (let tick = 10; tick <= 4800; tick += 10) {
    const weather = tick % 600 < 300 ? 'rain' : 'clear';
    const phase = tick % 2400 < 1500 ? 'day' : 'night';
    stepEcosystem(tiles, tick, weather, phase); stepEcosystem(reverse, tick, weather, phase);
  }
  assert.deepEqual(sorted(tiles), sorted(reverse));
  for (const tile of tiles) {
    for (const field of ['growth', 'fertility', 'cultivation', 'traffic', 'drinkingWater', 'life', 'moisture', 'vegetation', 'food'] as const) assert.ok(Number.isFinite(tile[field]) && tile[field]! >= 0 && tile[field]! <= 1, field);
    assert.ok(Number.isInteger(tile.fauna) && tile.fauna! >= 0 && tile.fauna! <= 6);
    assert.ok(tile.wood! >= 0 && tile.wood! <= 12); assert.ok(tile.stone! >= 0 && tile.stone! <= 8);
  }
});
