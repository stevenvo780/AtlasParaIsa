import type { Tile, WorldStats, WorldSample } from '../shared/types.js';
import type { World } from './index.js';
import { CHUNK_SIZE } from './terrain.js';
import { indiceDiversidad } from './diversidad.js';

export interface WorldStatsRecursos extends WorldStats { giniRecursosPorRegion: number; fraccionCeldasConComida: number; distanciaMediaAgua: number }

export function giniRecursosPorRegion(tiles: readonly Tile[]): number {
  const totals = new Map<string, number>();
  for (const tile of tiles) { const region = `${Math.floor(tile.x / CHUNK_SIZE)},${Math.floor(tile.y / CHUNK_SIZE)}`; totals.set(region, (totals.get(region) ?? 0) + tile.food); }
  const values = [...totals].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, total]) => total), n = values.length;
  if (n === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  if (mean === 0) return 0;
  let difference = 0;
  for (const left of values) for (const right of values) difference += Math.abs(left - right);
  return difference / (2 * n * n * mean);
}

export function fraccionCeldasConComida(tiles: readonly Tile[], umbral = 0.1): number {
  let land = 0, withFood = 0;
  for (const tile of tiles) if (tile.terrain !== 'water') { land++; if (tile.food > umbral) withFood++; }
  return land === 0 ? 0 : withFood / land;
}

export function distanciaMediaAgua(tiles: readonly Tile[]): number {
  const byPosition = new Map(tiles.map(tile => [`${tile.x},${tile.y}`, tile])), distances = new Map<string, number>();
  const queue: [number, number][] = [];
  for (const tile of tiles) if (tile.terrain === 'water' || (tile.drinkingWater ?? 0) > 0) { const position = `${tile.x},${tile.y}`; distances.set(position, 0); queue.push([tile.x, tile.y]); }
  // Distancia Manhattan por celdas cargadas; agua es terreno acuático o una reserva potable visible; sin ninguna fuente devuelve -1.
  if (queue.length === 0) return -1;
  for (let head = 0; head < queue.length; head++) {
    const [x, y] = queue[head]!, distance = distances.get(`${x},${y}`)!;
    for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]] as const) {
      const next: [number, number] = [x + dx, y + dy], position = `${next[0]},${next[1]}`;
      if (!byPosition.has(position) || distances.has(position)) continue;
      distances.set(position, distance + 1); queue.push(next);
    }
  }
  let land = 0, total = 0;
  for (const tile of tiles) if (tile.terrain !== 'water') { const distance = distances.get(`${tile.x},${tile.y}`); if (distance !== undefined) { land++; total += distance; } }
  return land === 0 ? 0 : total / land;
}

export const TOTAL_KEYS = ['foodHarvested','woodGathered','stoneGathered','hunts','waterConsumed','cooperation','teaching','trade','conflicts','births','cultivations','constructionHelp'] as const;
export function emptyTotals(): Record<string, number> { return Object.fromEntries(TOTAL_KEYS.map(key => [key, 0])); }
export function count(world: World, key: typeof TOTAL_KEYS[number], amount = 1): void { world.totals[key] = Math.min(1e12, (world.totals[key] ?? 0) + amount); }
function sample(world: World): WorldSample {
  const n = Math.max(1, world.people.length), mean = (key: 'hunger' | 'energy' | 'fatigue' | 'thirst') => world.people.reduce((sum, p) => sum + p[key], 0) / n;
  return { tick: world.tick, population: world.people.length, hunger: mean('hunger'), energy: mean('energy'), fatigue: mean('fatigue'), thirst: mean('thirst'), discoveries: world.discoveredChunks, settlements: world.settlementCount, cooperation: world.totals.cooperation ?? 0, births: world.totals.births ?? 0 };
}
export function recordSample(world: World): void {
  if (world.tick % 60 !== 0) return;
  world.history.push(sample(world)); world.history = world.history.slice(-96);
}
export function worldStatistics(world: World): WorldStatsRecursos {
  const current = sample(world), actions: Record<string, number> = {}, biomes: Record<string, number> = {}, features: Record<string, number> = {}, generations: Record<string, number> = {}, wildlife: Record<string, number> = {};
  const materials = { wood: 0, stone: 0 }; let freshWater = 0, cultivatedTiles = 0, trailTiles = 0;
  for (const p of world.people) { actions[p.action] = (actions[p.action] ?? 0) + 1; generations[p.genome.generation] = (generations[p.genome.generation] ?? 0) + 1; materials.wood += p.materials.wood; materials.stone += p.materials.stone; }
  for (const tile of world.tiles) {
    const biome = tile.biome ?? 'grassland', feature = tile.feature ?? 'none';
    biomes[biome] = (biomes[biome] ?? 0) + 1; features[feature] = (features[feature] ?? 0) + 1;
    freshWater += tile.drinkingWater ?? 0; if ((tile.cultivation ?? 0) > 0.1) cultivatedTiles++; if ((tile.traffic ?? 0) > 0.15) trailTiles++;
  }
  for(const animal of world.animals) wildlife[animal.species]=(wildlife[animal.species]??0)+1;
  const structures:Record<string,number>={}; for(const structure of world.structures){freshWater+=structure.water;for(const component of structure.components)structures[component]=(structures[component]??0)+1;}
  return { population: current.population, meanEnergy: current.energy, meanHunger: current.hunger, meanFatigue: current.fatigue, meanThirst: current.thirst, materials, actions, biomes, features, totals: { ...world.totals }, generations, history: world.history.map(s => ({ ...s })), scope: 'active-regions', wildlife, freshWater, cultivatedTiles, trailTiles, animalDynamics:{...world.animalDynamics}, structures,blueprints:world.blueprints.length,inventionDynamics:{...world.inventionDynamics}, giniRecursosPorRegion: giniRecursosPorRegion(world.tiles), fraccionCeldasConComida: fraccionCeldasConComida(world.tiles), distanciaMediaAgua: distanciaMediaAgua(world.tiles), diversidad: indiceDiversidad(world) };
}
