import type { Tile, WorldStats, WorldSample } from '../shared/types.js';
import type { World } from './index.js';
import { CHUNK_SIZE, MAX_COORDINATE } from './terrain.js';

export interface WorldStatsRecursos extends WorldStats { giniRecursosPorRegion: number; fraccionCeldasConComida: number; distanciaMediaAgua: number }

// Claves enteras, no cadenas: estas tres estadisticas recorren todas las celdas cargadas en cada
// proyeccion y el coste se paga dentro del lazo de 100 ms del servidor. Empaquetar cabe de sobra en
// un entero seguro: |coordenada| < MAX_COORDINATE y |region| < MAX_COORDINATE / CHUNK_SIZE.
const POSITION_STRIDE = 2 * MAX_COORDINATE + 1, REGION_LIMIT = Math.ceil(MAX_COORDINATE / CHUNK_SIZE), REGION_STRIDE = 2 * REGION_LIMIT + 1;
const packPosition = (x: number, y: number): number => (x + MAX_COORDINATE) * POSITION_STRIDE + (y + MAX_COORDINATE);
const packRegion = (x: number, y: number): number => (Math.floor(x / CHUNK_SIZE) + REGION_LIMIT) * REGION_STRIDE + (Math.floor(y / CHUNK_SIZE) + REGION_LIMIT);
const NEIGHBORS: readonly (readonly [number, number])[] = [[0, -1], [-1, 0], [1, 0], [0, 1]];

/** Gini de la comida sumada por region (chunk de CHUNK_SIZE). Forma ordenada: O(n log n) en vez del
 * doble bucle O(n^2), identica por definicion y exacta en los ejemplos de prueba. */
export function giniRecursosPorRegion(tiles: readonly Tile[]): number {
  const totals = new Map<number, number>();
  for (const tile of tiles) { const region = packRegion(tile.x, tile.y); totals.set(region, (totals.get(region) ?? 0) + tile.food); }
  const values = [...totals.values()].sort((left, right) => left - right), n = values.length;
  if (n === 0) return 0;
  let sum = 0, weighted = 0;
  for (let i = 0; i < n; i++) { const value = values[i]!; sum += value; weighted += (i + 1) * value; }
  if (sum === 0) return 0;
  return 2 * weighted / (n * sum) - (n + 1) / n;
}

export function fraccionCeldasConComida(tiles: readonly Tile[], umbral = 0.1): number {
  let land = 0, withFood = 0;
  for (const tile of tiles) if (tile.terrain !== 'water') { land++; if (tile.food > umbral) withFood++; }
  return land === 0 ? 0 : withFood / land;
}

/** Distancia Manhattan media al agua por celdas cargadas; agua es terreno acuatico o una reserva
 * potable visible; sin ninguna fuente devuelve -1 (Infinity no sobrevive a JSON). BFS por indices
 * enteros sobre arrays tipados: sin objetos ni claves de cadena por celda visitada. */
export function distanciaMediaAgua(tiles: readonly Tile[]): number {
  const count = tiles.length, index = new Map<number, number>();
  for (let i = 0; i < count; i++) { const tile = tiles[i]!; index.set(packPosition(tile.x, tile.y), i); }
  const distances = new Int32Array(count).fill(-1), queue = new Int32Array(count);
  let tail = 0;
  for (let i = 0; i < count; i++) { const tile = tiles[i]!; if (tile.terrain === 'water' || (tile.drinkingWater ?? 0) > 0) { distances[i] = 0; queue[tail++] = i; } }
  if (tail === 0) return -1;
  for (let head = 0; head < tail; head++) {
    const tile = tiles[queue[head]!]!, next = distances[queue[head]!]! + 1;
    for (const [dx, dy] of NEIGHBORS) {
      const neighbor = index.get(packPosition(tile.x + dx, tile.y + dy));
      if (neighbor === undefined || distances[neighbor]! >= 0) continue;
      distances[neighbor] = next; queue[tail++] = neighbor;
    }
  }
  let land = 0, total = 0;
  for (let i = 0; i < count; i++) if (tiles[i]!.terrain !== 'water' && distances[i]! >= 0) { land++; total += distances[i]!; }
  return land === 0 ? 0 : total / land;
}

interface RecursosStats { giniRecursosPorRegion: number; fraccionCeldasConComida: number; distanciaMediaAgua: number }
const recursosViews = new WeakMap<World, { tick: number; tiles: readonly Tile[]; length: number; value: RecursosStats }>();
/** El servidor proyecta el mundo una vez por cliente y por mensaje de camara dentro del mismo tick
 * (src/server/app.ts): recorrer todas las celdas tres veces por proyeccion multiplicaba el coste por
 * cliente. Las celdas solo cambian dentro de stepWorld, que avanza el tick, y el array se reemplaza o
 * crece al activar y retirar chunks: (tick, identidad y longitud de world.tiles) fija el mismo criterio
 * que ya usa el indice de tileAt en spatial.ts. No hay estado oculto: el valor cacheado es el que
 * devolverian las tres funciones puras sobre esas mismas celdas. */
function recursosStatistics(world: World): RecursosStats {
  const cached = recursosViews.get(world);
  if (cached && cached.tick === world.tick && cached.tiles === world.tiles && cached.length === world.tiles.length) return cached.value;
  const value: RecursosStats = { giniRecursosPorRegion: giniRecursosPorRegion(world.tiles), fraccionCeldasConComida: fraccionCeldasConComida(world.tiles), distanciaMediaAgua: distanciaMediaAgua(world.tiles) };
  recursosViews.set(world, { tick: world.tick, tiles: world.tiles, length: world.tiles.length, value });
  return value;
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
  return { population: current.population, meanEnergy: current.energy, meanHunger: current.hunger, meanFatigue: current.fatigue, meanThirst: current.thirst, materials, actions, biomes, features, totals: { ...world.totals }, generations, history: world.history.map(s => ({ ...s })), scope: 'active-regions', wildlife, freshWater, cultivatedTiles, trailTiles, animalDynamics:{...world.animalDynamics}, structures,blueprints:world.blueprints.length,inventionDynamics:{...world.inventionDynamics}, ...recursosStatistics(world) };
}
