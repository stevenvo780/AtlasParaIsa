import type { Feature, Tile } from '../shared/types.js';

type Species = 'hare' | 'deer' | 'boar' | 'fish';
const clamp = (n: number, maximum = 1): number => Math.max(0, Math.min(maximum, n));
const key = (x: number, y: number): string => `${x},${y}`;
const TREE_FEATURES = new Set<Feature>(['tree', 'pine', 'palm', 'cactus', 'reeds', 'stump']);
const FOOD_PER_ANIMAL: Record<Species, number> = { hare: 0.12, deer: 0.25, boar: 0.22, fish: 0.1 };

function hash(seed: number, x: number, y: number, salt: number): number {
  let n = seed ^ Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77) ^ salt;
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
  n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
  return (n ^ (n >>> 16)) >>> 0;
}

/** New fields only: a saved zero means depleted, never permission to refill a patch. */
export function initializeEcosystem(seed: number, tile: Tile): Tile {
  const result: Tile = { ...tile };
  const patch = hash(seed, Math.floor(tile.x / 8), Math.floor(tile.y / 8), 1201);
  const local = hash(seed, tile.x, tile.y, 1202);
  const wet = tile.biome === 'wetland';
  const ocean = tile.biome === 'ocean';
  const water = tile.terrain === 'water';
  const spring = !water && tile.moisture > 0.4 && patch % 5 === 0
    && tile.x - Math.floor(tile.x / 8) * 8 === (patch >>> 3) % 8
    && tile.y - Math.floor(tile.y / 8) * 8 === (patch >>> 6) % 8;
  const depression = hash(seed, Math.floor(tile.x / 4), Math.floor(tile.y / 4), 1203);
  const pool = !water && !wet && tile.moisture > 0.18 && (tile.elevation ?? 0) < 0.72 && depression % 2 === 0
    && tile.x - Math.floor(tile.x / 4) * 4 === (depression >>> 3) % 4
    && tile.y - Math.floor(tile.y / 4) * 4 === (depression >>> 5) % 4;
  if (result.wood === undefined) result.wood = water ? 0 : tile.biome === 'forest' ? Math.floor(tile.vegetation * 10) : 0;
  if (result.stone === undefined) result.stone = tile.biome === 'mountain' ? 4 + local % 5 : 0;
  if (result.feature === undefined) {
    result.feature = water ? 'none' : spring ? 'spring' : pool ? 'pool'
      : tile.biome === 'forest' && result.wood > 0 ? (tile.moisture > 0.75 && (tile.elevation ?? 0) < 0.6 && local % 4 === 0 ? 'palm' : (tile.elevation ?? 0) > 0.64 || local % 3 === 0 ? 'pine' : 'tree')
      : tile.biome === 'forest' && result.wood === 0 ? 'stump'
      : tile.biome === 'desert' ? (local % 5 === 0 ? 'cactus' : result.stone > 0 ? 'rock' : 'none')
      : wet ? (local % 4 === 0 ? 'clay' : 'reeds')
      : tile.biome === 'mountain' ? (result.stone > 0 ? 'rock' : 'none')
      : result.wood > 0 ? (tile.moisture > 0.68 ? 'palm' : 'tree')
      : result.stone > 0 && local % 4 === 0 ? 'rock'
      : tile.food > 0.15 && local % 3 === 0 ? 'berries' : local % 3 === 1 ? 'flowers' : 'none';
  }
  if (result.variety === undefined) result.variety = local % 4;
  if (result.growth === undefined) result.growth = water ? 0.15 + (local % 20) / 100 : tile.vegetation;
  if (result.fertility === undefined) result.fertility = clamp(water ? 0.35 : 0.12 + tile.moisture * 0.55 + tile.vegetation * 0.25);
  if (result.cultivation === undefined) result.cultivation = 0;
  if (result.traffic === undefined) result.traffic = 0;
  if (result.drinkingWater === undefined) result.drinkingWater = ocean ? 0 : result.feature === 'spring' ? 0.65
    : result.feature === 'pool' ? 0.22 + tile.moisture * 0.2 : wet ? 0.25 + tile.moisture * 0.35 : water ? 0.7 : 0;
  if (result.life === undefined) result.life = local % 5 === 0 ? 0.65 : 0.03;
  if (result.fauna === undefined) {
    const viable = water || (tile.vegetation > 0.15 && tile.moisture > 0.3 && tile.terrain !== 'shelter');
    result.fauna = viable && patch % 7 === 0 && local % 6 === 0 ? 1 + (local >>> 8) % 3 : 0;
  }
  if (result.species === undefined && result.fauna > 0) result.species = water ? 'fish'
    : tile.biome === 'forest' ? (patch % 3 === 0 ? 'boar' : 'deer')
    : wet ? 'boar' : 'hare';
  return result;
}

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
export function stepEcosystem(tiles: Tile[], tick: number, weather: 'clear' | 'rain', phase: string): void {
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
  if (tick % 50 === 0) stepFauna(tiles, tick);
}

function animalWater(cell: CellState, species: Species): number {
  // Herbivores also get a small amount of water from moist plants; humans cannot drink this soil.
  return species === 'fish' ? cell.moisture : cell.drinkingWater + cell.moisture * 0.1;
}

function stepFauna(tiles: Tile[], tick: number): void {
  const cells = tiles.map(state).sort((a, b) => a.y - b.y || a.x - b.x);
  const byPosition = new Map(cells.map(cell => [key(cell.x, cell.y), cell]));
  const populations = new Map(cells.map(cell => [cell, cell.fauna]));
  const speciesAt = new Map(cells.map(cell => [cell, cell.species]));
  const proposals: { source: CellState; target: CellState; species: Species; improvement: number }[] = [];
  for (const source of cells) {
    if (source.fauna === 0 || !source.species) continue;
    const species = source.species;
    if (source.growth >= 0.12 && animalWater(source, species) >= 0.015) continue;
    const sourceQuality = source.growth + animalWater(source, species) * 0.8;
    const targets: { cell: CellState; quality: number }[] = [];
    for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]] as const) {
      const target = byPosition.get(key(source.x + dx, source.y + dy));
      if (!target || target.fauna >= 6 || (target.fauna > 0 && target.species !== species)
        || (species === 'fish' ? target.tile.terrain !== 'water' : target.tile.terrain === 'water' || target.tile.terrain === 'shelter')) continue;
      const quality = target.growth + animalWater(target, species) * 0.8;
      if (quality > sourceQuality + 0.05) targets.push({ cell: target, quality });
    }
    targets.sort((a, b) => b.quality - a.quality || a.cell.y - b.cell.y || a.cell.x - b.cell.x);
    const choice = targets[0];
    if (choice) proposals.push({ source, target: choice.cell, species, improvement: choice.quality - sourceQuality });
  }
  // Competing arrivals resolve from a canonical proposal order; every accepted move has one debit and credit.
  proposals.sort((a, b) => b.improvement - a.improvement || a.source.y - b.source.y || a.source.x - b.source.x);
  for (const proposal of proposals) {
    const destinationCount = populations.get(proposal.target)!;
    if (destinationCount >= 6 || (destinationCount > 0 && speciesAt.get(proposal.target) !== proposal.species)) continue;
    populations.set(proposal.source, populations.get(proposal.source)! - 1);
    populations.set(proposal.target, destinationCount + 1); speciesAt.set(proposal.target, proposal.species);
  }
  for (const cell of cells) {
    const tile = cell.tile, species = speciesAt.get(cell);
    let count = populations.get(cell)!;
    if (!species || count === 0) { tile.fauna = 0; delete tile.species; continue; }
    let growth = tile.growth ?? 0;
    const availableWater = animalWater(cell, species);
    let water = availableWater;
    const survivors = Math.min(count, Math.floor(growth / 0.004), Math.floor(water / 0.0015));
    if (survivors < count) tile.fertility = clamp((tile.fertility ?? 0) + (count - survivors) * 0.015);
    count = survivors; growth = clamp(growth - count * 0.004); water = Math.max(0, water - count * 0.0015);
    if (tile.terrain !== 'water') tile.vegetation = clamp(tile.vegetation - count * 0.002);
    if (tick % 200 === 0 && count >= 2 && count < 6 && growth >= 0.12 && water >= 0.025) {
      growth -= 0.12; water -= 0.025; count++;
    }
    tile.growth = growth; tile.fauna = count;
    if (species === 'fish') tile.moisture = water;
    else {
      const consumed = availableWater - water;
      const potable = Math.min(cell.drinkingWater, consumed);
      tile.drinkingWater = clamp(cell.drinkingWater - potable);
      tile.moisture = clamp(cell.moisture - (consumed - potable) / 0.1);
    }
    if (count === 0) delete tile.species; else tile.species = species;
  }
}

export function harvestAnimal(tile: Tile): number {
  if (!tile.species || !Number.isInteger(tile.fauna) || tile.fauna! <= 0) return 0;
  const food = FOOD_PER_ANIMAL[tile.species];
  tile.fauna = tile.fauna! - 1;
  if (tile.fauna === 0) delete tile.species;
  return food;
}

export function harvestMaterial(tile: Tile, material: 'wood' | 'stone', amount: number): number {
  if (!Number.isFinite(amount) || amount < 0) throw new RangeError('La extracción requiere una cantidad finita no negativa.');
  const harvested = Math.min(tile[material] ?? 0, amount);
  tile[material] = Math.max(0, (tile[material] ?? 0) - harvested);
  if (harvested <= 0) return 0;
  if (material === 'wood') {
    tile.growth = clamp((tile.growth ?? tile.vegetation) - harvested * 0.035);
    tile.vegetation = clamp(tile.vegetation - harvested * 0.025);
    if (tile.wood === 0 && TREE_FEATURES.has(tile.feature ?? 'none')) tile.feature = tile.feature === 'reeds' || tile.feature === 'cactus' ? 'none' : 'stump';
  } else if (tile.stone === 0 && (tile.feature === 'rock' || tile.feature === 'clay')) tile.feature = 'none';
  return harvested;
}

export function cultivateTile(tile: Tile): boolean {
  if (tile.terrain === 'water' || tile.terrain === 'shelter' || tile.moisture <= 0.25 || (tile.cultivation ?? 0) >= 0.95) return false;
  tile.cultivation = clamp((tile.cultivation ?? 0) + 0.18);
  tile.fertility = clamp((tile.fertility ?? 0) + 0.06);
  tile.growth = clamp((tile.growth ?? tile.vegetation) + 0.03);
  tile.vegetation = clamp(tile.vegetation + 0.04);
  if (tile.feature === 'none' || tile.feature === 'stump') tile.feature = 'flowers';
  return true;
}

export function trampleTile(tile: Tile): void {
  if (tile.terrain === 'water') return;
  tile.traffic = clamp((tile.traffic ?? 0) + 0.025);
  tile.growth = clamp((tile.growth ?? tile.vegetation) - 0.006);
  tile.vegetation = clamp(tile.vegetation - 0.003);
  tile.life = clamp((tile.life ?? 0) - 0.01);
}
