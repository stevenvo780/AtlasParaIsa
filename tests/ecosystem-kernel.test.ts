import test from 'node:test';
import assert from 'node:assert/strict';
import type { Feature, Species, Tile } from '../src/shared/types.js';
import { EcosystemKernel } from '../src/world/ecosystem-kernel.js';
import { stepEcosystem } from '../src/world/ecosystem.js';
import { generateChunk } from '../src/world/terrain.js';
import { cloneWorld, createWorld } from '../src/world/index.js';

// Frozen pre-optimization object/Map oracle from ecosystem.ts at 3ada669.
// Keep its snapshot objects and string neighbor lookups independent of the kernel.
const clamp = (n: number, maximum = 1): number => Math.max(0, Math.min(maximum, n));
const key = (x: number, y: number): string => `${x},${y}`;
const TREE_FEATURES = new Set<Feature>(['tree', 'pine', 'palm', 'cactus', 'reeds', 'stump']);

interface CellState {
  tile: Tile; x: number; y: number; growth: number; fertility: number; life: number;
  moisture: number; drinkingWater: number; cultivation: number; traffic: number;
  fauna: number; species?: Species;
}

function state(tile: Tile): CellState {
  return { tile, x: tile.x, y: tile.y, growth: tile.growth ?? tile.vegetation, fertility: tile.fertility ?? 0,
    life: tile.life ?? 0, moisture: tile.moisture, drinkingWater: tile.drinkingWater ?? 0,
    cultivation: tile.cultivation ?? 0, traffic: tile.traffic ?? 0, fauna: tile.fauna ?? 0, species: tile.species };
}

/** Soft neighbor rule inspired by cellular automata, not an implementation of Conway or Lenia. */
function referenceStep(tiles: Tile[], tick: number, weather: 'clear' | 'rain', phase: string): void {
  if (tick % 10 !== 0) return;
  const cells = tiles.map(state);
  const previous = new Map(cells.map(cell => [key(cell.x, cell.y), cell]));
  if (previous.size !== cells.length) throw new Error('El ecosistema requiere coordenadas únicas.');
  const light = phase === 'day' ? 1 : phase === 'night' ? 0 : 0.4;
  for (const cell of cells) {
    const tile = cell.tile;
    let livingNeighbors = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      if ((previous.get(key(cell.x + dx, cell.y + dy))?.life ?? 0) >= 0.45) livingNeighbors++;
    }
    const fertilePattern = livingNeighbors === 3 || (cell.life >= 0.45 && livingNeighbors === 2);
    const cellularEnergy = light * cell.moisture * (0.6 + cell.fertility * 0.4);
    tile.life = clamp(cell.life + ((fertilePattern ? 1 : 0) - cell.life) * 0.2 * cellularEnergy
      - (cell.moisture < 0.15 ? 0.015 : 0) - cell.traffic * 0.004);
    tile.fertility = clamp(cell.fertility + cell.life * 0.0012 - cell.traffic * 0.0007 - cell.cultivation * 0.0002);
    const produced = light * cell.moisture * cell.fertility * (0.25 + cell.life * 0.75)
      * (1 - cell.growth) * (1 - cell.traffic * 0.9) * 0.005;
    tile.growth = clamp(cell.growth + produced - 0.0002 - cell.traffic * 0.002 - (cell.moisture < 0.15 ? 0.001 : 0));
    if (tile.terrain !== 'water') tile.vegetation = clamp(tile.vegetation + produced * 0.25 - cell.traffic * 0.001);
    tile.traffic = clamp(cell.traffic - 0.0005);
    tile.cultivation = clamp(cell.cultivation - 0.00002);
    // Rain collects only in visible reservoirs; ordinary moist soil is not a drinking source.
    const reservoir = tile.feature === 'pool' || tile.feature === 'spring' || tile.biome === 'wetland' || tile.terrain === 'water';
    tile.drinkingWater = tile.biome === 'ocean' ? 0 : clamp(cell.drinkingWater
      + (reservoir && weather === 'rain' ? 0.008 * (0.4 + cell.fertility * 0.6) : 0)
      + (tile.feature === 'spring' ? 0.002 : 0) - (light ? 0.00015 : 0.00003));
    // Ocean water exchanges slowly with the surrounding saline reservoir. Nutrients remain local.
    if (tile.terrain === 'water') tile.moisture = clamp(cell.moisture + (tile.biome === 'ocean' ? 0.003 : 0) + (weather === 'rain' ? 0.008 : 0));
    // Wood regrows slowly by consuming local growth; rock never regenerates.
    if (tick % 100 === 0 && TREE_FEATURES.has(tile.feature ?? 'none') && cell.growth > 0.65
      && cell.fertility > 0.4 && cell.moisture > 0.35 && cell.traffic < 0.35 && light > 0) {
      const capacity = tile.feature === 'reeds' || tile.feature === 'cactus' ? 2 : tile.feature === 'palm' ? 6 : 12;
      const regrowth = Math.min(capacity - (tile.wood ?? 0), 0.025 * light * cell.moisture * cell.fertility);
      if (regrowth > 0) {
        tile.wood = (tile.wood ?? 0) + regrowth;
        tile.growth = clamp(tile.growth! - regrowth * 0.05);
        if (tile.feature === 'stump' && tile.wood >= 1) tile.feature = tile.biome === 'mountain' ? 'pine' : 'tree';
      }
    }
  }
}

function cell(x = 0, y = 0, changes: Partial<Tile> = {}): Tile {
  return { x, y, terrain: 'meadow', biome: 'grassland', moisture: 0.8, vegetation: 0.5, food: 0.2, ...changes };
}
const cloneTiles = (tiles: Tile[]): Tile[] => tiles.map(tile => ({ ...tile }));
const canonical = (tiles: Tile[]): Tile[] => [...tiles].sort((a, b) => a.y - b.y || a.x - b.x);

for (const [seed, chunkCount] of [[51926, 13], [42, 18], [2026, 64]] as const) {
  test(`Float64 kernel matches the independent object oracle for 120 cloned updates: ${chunkCount} chunks`, () => {
    let actual: Tile[] = [];
    for (let n = 0; n < chunkCount; n++) actual.push(...generateChunk(seed, n % 8 - 4, Math.floor(n / 8) - 4).tiles);
    let expected = cloneTiles(actual);
    const kernel = new EcosystemKernel();
    for (let n = 0; n < 120; n++) {
      // This is the same tile-array replacement performed by cloneWorld.
      actual = cloneTiles(actual); expected = cloneTiles(expected);
      const tick = (n + 1) * 10, weather = n % 3 ? 'clear' : 'rain';
      const phase = ['day', 'night', 'dawn', 'dusk'][n % 4];
      kernel.step(actual, tick, weather, phase);
      referenceStep(expected, tick, weather, phase);
      assert.deepStrictEqual(actual, expected, `update ${n}`);
      assert.equal(kernel.cachedTopologyCount, 1);
    }
  });
}

test('stepEcosystem preserves two independent cloned worlds with different seeds in alternation', () => {
  const worlds = [createWorld(42), createWorld(51926)];
  const expected = worlds.map(cloneWorld);
  for (let n = 0; n < 60; n++) for (let i = 0; i < worlds.length; i++) {
    worlds[i] = cloneWorld(worlds[i]); expected[i] = cloneWorld(expected[i]);
    worlds[i].tick = expected[i].tick = (n + 1) * 10;
    const weather = i ? 'rain' : 'clear', phase = n % 2 ? 'night' : 'day';
    stepEcosystem(worlds[i].tiles, worlds[i].tick, weather, phase, false);
    referenceStep(expected[i].tiles, expected[i].tick, weather, phase);
    assert.deepStrictEqual(worlds[i], expected[i]);
  }
});

test('missing fields, sparse borders, seawater, and stump regrowth preserve exact old behavior', () => {
  const actual = [cell(-1, -1, { life: 1 }), cell(0, -1, { life: 1 }), cell(-1, 0, { life: 1 }),
    cell(0, 0, { feature: 'stump', wood: 0.999, growth: 0.9, fertility: 0.9 }),
    cell(2, 0, { terrain: 'water', biome: 'ocean', drinkingWater: 0.9 }),
    cell(999_999, -999_999, { feature: 'spring', drinkingWater: 0 })];
  const expected = cloneTiles(actual), kernel = new EcosystemKernel();
  kernel.step(actual, 100, 'rain', 'day'); referenceStep(expected, 100, 'rain', 'day');
  assert.deepStrictEqual(actual, expected);
  assert.equal(actual[3].feature, 'tree'); assert.equal(actual[4].drinkingWater, 0);
  assert.ok(actual[5].drinkingWater! > 0);
});

test('coordinate mutation in an existing array rebuilds neighbor relationships', () => {
  const actual = [cell(), cell(-1, 0, { life: 1 }), cell(0, -1, { life: 1 }), cell(1, 0, { life: 1 })];
  const kernel = new EcosystemKernel();
  kernel.step(actual, 10, 'clear', 'day');
  actual[3].x = 20;
  const expected = cloneTiles(actual), staleCoordinates = cloneTiles(actual);
  staleCoordinates[3].x = 1;
  kernel.step(actual, 20, 'clear', 'day'); referenceStep(expected, 20, 'clear', 'day'); referenceStep(staleCoordinates, 20, 'clear', 'day');
  assert.deepStrictEqual(actual, expected);
  assert.notEqual(actual[0].life, staleCoordinates[0].life, 'fixture requires genuinely changed neighbor influence');
  assert.equal(kernel.cachedTopologyCount, 2);
});

test('reordering, removals, and newly activated cells cannot reuse a stale ordered index', () => {
  let actual = [cell(), cell(-1, 0, { life: 1 }), cell(0, -1, { life: 1 }), cell(1, 0, { life: 1 })];
  const kernel = new EcosystemKernel();
  kernel.step(actual, 10, 'clear', 'day');
  for (let n = 0; n < 3; n++) {
    if (n === 0) actual.reverse();
    if (n === 1) actual.splice(1, 1);
    if (n === 2) actual.push(cell(1, 1, { life: 1 }));
    const expected = cloneTiles(actual);
    kernel.step(actual, (n + 2) * 10, 'rain', 'day'); referenceStep(expected, (n + 2) * 10, 'rain', 'day');
    assert.deepStrictEqual(actual, expected);
  }
  const reverse = cloneTiles(actual).reverse(), expected = cloneTiles(actual);
  kernel.step(reverse, 100, 'rain', 'day'); referenceStep(expected, 100, 'rain', 'day');
  assert.deepStrictEqual(canonical(reverse), canonical(expected));
  assert.equal(kernel.cachedTopologyCount, 4);
});

test('duplicate coordinates after a warm cache reject atomically without changing tiles or cache', () => {
  const kernel = new EcosystemKernel(), actual = [cell(), cell(1, 0)];
  kernel.step(actual, 10, 'rain', 'day');
  actual[1].x = 0;
  const before = cloneTiles(actual), cacheSize = kernel.cachedTopologyCount;
  assert.throws(() => kernel.step(actual, 20, 'rain', 'day'), /coordenadas únicas/);
  assert.deepStrictEqual(actual, before); assert.equal(kernel.cachedTopologyCount, cacheSize);
  actual[1].x = 2;
  const expected = cloneTiles(actual);
  kernel.step(actual, 20, 'rain', 'day'); referenceStep(expected, 20, 'rain', 'day');
  assert.deepStrictEqual(actual, expected);
});

test('eviction after more than four ordered topologies affects allocation only', () => {
  const kernel = new EcosystemKernel();
  for (let n = 0; n < 12; n++) {
    const actual = [cell(n * 2, 0, { life: n / 20 }), cell(n * 2 + 1, 0, { life: 0.8 })], expected = cloneTiles(actual);
    kernel.step(actual, 10, 'rain', 'day'); referenceStep(expected, 10, 'rain', 'day');
    assert.deepStrictEqual(actual, expected);
    assert.equal(kernel.cachedTopologyCount, Math.min(n + 1, 4));
  }
  const revisited = [cell(), cell(1, 0)], expected = cloneTiles(revisited);
  kernel.step(revisited, 100, 'clear', 'day'); referenceStep(expected, 100, 'clear', 'day');
  assert.deepStrictEqual(revisited, expected); assert.equal(kernel.cachedTopologyCount, 4);
});

test('same coordinates refresh every mutable field from current tiles, including deleted optional values', () => {
  const kernel = new EcosystemKernel();
  const old = [cell(0, 0, { life: 1, growth: 1, fertility: 1, cultivation: 1, traffic: 1, drinkingWater: 1 })];
  kernel.step(old, 10, 'rain', 'day');
  const actual = [cell(0, 0, { moisture: 0.05, vegetation: 0.2, feature: 'pool', wood: 0.1 })], expected = cloneTiles(actual);
  kernel.step(actual, 100, 'clear', 'night'); referenceStep(expected, 100, 'clear', 'night');
  assert.deepStrictEqual(actual, expected); assert.equal(kernel.cachedTopologyCount, 1);
});

test('non-update ticks do not allocate or validate and empty update sets remain valid', () => {
  const kernel = new EcosystemKernel(), duplicate = [cell(), cell()], before = cloneTiles(duplicate);
  kernel.step(duplicate, 9, 'rain', 'day');
  assert.deepStrictEqual(duplicate, before); assert.equal(kernel.cachedTopologyCount, 0);
  kernel.step([], 10, 'rain', 'day'); assert.equal(kernel.cachedTopologyCount, 1);
});

