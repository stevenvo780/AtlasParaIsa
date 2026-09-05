import type { WorldStats, WorldSample } from '../shared/types.js';
import type { World } from './index.js';

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
export function worldStatistics(world: World): WorldStats {
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
  return { population: current.population, meanEnergy: current.energy, meanHunger: current.hunger, meanFatigue: current.fatigue, meanThirst: current.thirst, materials, actions, biomes, features, totals: { ...world.totals }, generations, history: world.history.map(s => ({ ...s })), scope: 'active-regions', wildlife, freshWater, cultivatedTiles, trailTiles, animalDynamics:{...world.animalDynamics}, structures,blueprints:world.blueprints.length,inventionDynamics:{...world.inventionDynamics} };
}
