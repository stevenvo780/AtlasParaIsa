import type { PlaceView, Tile, Viewport } from '../shared/types.js';
import { CHUNK_SIZE, MAX_COORDINATE, chunkCoords, chunkKey, generateChunk, generateTile, legacyStructures, type Chunk } from './terrain.js';
import type { World } from './index.js';
import { initializeEcosystem } from './ecosystem.js';
import { materializeAnimals } from './animals.js';
import type { AnimalView, StructureView } from '../shared/life.js';
import { projectAnimal } from './animals.js';
import type { LegacyRecord } from '../shared/demography.js';
import { bindTechnologyCatalogue, type TechnologyCatalogueReader } from './technology-catalogue.js';

export interface WorldContext {
  loadChunk?: (key: string, atTick: number) => Chunk | null;
  catalogueReader?: TechnologyCatalogueReader;
  loadLegacy?: (id: string, atTick: number) => LegacyRecord | null;
}
const contexts = new WeakMap<World, WorldContext>();
/** Host capabilities live outside serialized worlds and never become inhabitants' knowledge. */
export function bindWorldContext(world: World, context: WorldContext): void {
  const bound = { ...contexts.get(world), ...context };
  contexts.set(world, bound);
  if (world.technology && bound.catalogueReader) bindTechnologyCatalogue(world.technology, bound.catalogueReader);
}
export function worldContext(world: World): WorldContext { return contexts.get(world) ?? {}; }
export type ChunkMeta = Omit<Chunk, 'tiles' | 'animals' | 'structures'>;
export const validCoordinate = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= -MAX_COORDINATE && n < MAX_COORDINATE;
const indexes = new WeakMap<World, { tiles: Tile[]; length: number; map: Map<string, Tile> }>();
export function tileAt(world: World, p: { x: number; y: number }): Tile | undefined {
  let index = indexes.get(world);
  if (!index || index.tiles !== world.tiles || index.length !== world.tiles.length) {
    index = { tiles: world.tiles, length: world.tiles.length, map: new Map(world.tiles.map(t => [`${t.x},${t.y}`, t])) };
    indexes.set(world, index);
  }
  return index.map.get(`${p.x},${p.y}`);
}
export function activate(world: World, x: number, y: number, context: WorldContext = worldContext(world)): void {
  if (!validCoordinate(x) || !validCoordinate(y)) return;
  const key = chunkKey(x, y);
  if (world.chunks[key]) return;
  const pending = world.retiredChunks.findIndex(c => c.key === key);
  const { cx, cy } = chunkCoords(x, y);
  const chunk = pending >= 0 ? world.retiredChunks.splice(pending, 1)[0]! : context.loadChunk?.(key, world.tick) ?? generateChunk(world.seed, cx, cy);
  const { tiles, animals, structures, ...meta } = chunk;
  world.chunks[key] = meta;
  const initialized=tiles.map(tile => initializeEcosystem(world.seed, tile));
  world.tiles.push(...initialized);
  world.animals.push(...(animals ?? materializeAnimals(world.seed, initialized, world.tick)));
  world.structures.push(...(structures ?? legacyStructures(tiles, world.tick)));
  for (const place of meta.places) if (!world.places.some(p => p.id === place.id)) world.places.push(place);
}
/** Only agent neighborhoods advance ecology. Camera queries never call this function. */
export function maintainRegions(world: World, context: WorldContext = worldContext(world)): void {
  const needed = new Set<string>();
  for (const person of world.people) {
    for (const dx of [-8, 0, 8]) for (const dy of [-8, 0, 8]) {
      const x = person.x + dx, y = person.y + dy;
      if (!validCoordinate(x) || !validCoordinate(y)) continue;
      needed.add(chunkKey(x, y)); activate(world, x, y, context);
    }
  }
  const retired = new Set<string>();
  const detached = new Map<string, Chunk>();
  for (const [key, meta] of Object.entries(world.chunks)) {
    if (needed.has(key)) continue;
    const chunk: Chunk = { ...meta, lifeVersion: 4, lastTick: world.tick, tiles: [], places: [], animals: [], structures: [] };
    world.retiredChunks.push(chunk); detached.set(key, chunk);
    delete world.chunks[key]; retired.add(key);
  }
  if (retired.size) {
    const active: Tile[] = [];
    for (const tile of world.tiles) {
      const chunk = detached.get(chunkKey(tile.x, tile.y));
      if (chunk) chunk.tiles.push(tile); else active.push(tile);
    }
    for (const place of world.places) detached.get(chunkKey(place.x, place.y))?.places.push(place);
    world.tiles = active;
    world.animals = world.animals.filter(animal => {
      const chunk = detached.get(chunkKey(animal.x, animal.y));
      if (chunk) chunk.animals!.push(animal);
      return !chunk;
    });
    world.structures = world.structures.filter(structure => {
      const chunk = detached.get(chunkKey(structure.x, structure.y));
      if (chunk) chunk.structures!.push(structure);
      return !chunk;
    });
    // The three memory anchors remain available as provenance even when dormant.
    world.places = world.places.filter(p => ['claro', 'refugio', 'huerta'].includes(p.id) || !retired.has(chunkKey(p.x, p.y)));
  }
}
export function normalizeViewport(value?: Viewport): Viewport {
  const v = value ?? { x: 0, y: 0, width: 40, height: 28 };
  if (!validCoordinate(v.x) || !validCoordinate(v.y) || !Number.isInteger(v.width) || !Number.isInteger(v.height) || v.width < 1 || v.width > 96 || v.height < 1 || v.height > 64 || !validCoordinate(v.x + v.width - 1) || !validCoordinate(v.y + v.height - 1)) throw new RangeError('Ventana de mundo inválida (máximo 96 × 64).');
  return { ...v };
}
export function projectTerrain(world: World, viewport?: Viewport, context: WorldContext = worldContext(world)): { viewport: Viewport; tiles: Tile[]; places: PlaceView[]; animals: AnimalView[]; structures: StructureView[] } {
  const v = normalizeViewport(viewport), tiles: Tile[] = [], places = new Map(world.places.map(p => [p.id, p]));
  const archive = new Map<string, Chunk>();
  for (let y = v.y; y < v.y + v.height; y++) for (let x = v.x; x < v.x + v.width; x++) {
    const active = tileAt(world, { x, y });
    if (active) { tiles.push({ ...active }); continue; }
    const key = chunkKey(x, y);
    let chunk = archive.get(key);
    if (!chunk) {
      const { cx, cy } = chunkCoords(x, y);
      chunk = world.retiredChunks.find(c => c.key === key) ?? context.loadChunk?.(key, world.tick) ?? generateChunk(world.seed, cx, cy);
      archive.set(key, chunk);
      // Undiscovered landmarks are scenery, not recorded discoveries.
      for (const place of chunk.places) places.set(place.id, place);
    }
    const index = (y - chunk.cy * CHUNK_SIZE) * CHUNK_SIZE + x - chunk.cx * CHUNK_SIZE;
    tiles.push(initializeEcosystem(world.seed, chunk.tiles[index] ?? generateTile(world.seed, x, y)));
  }
  const visible = (p: {x: number; y: number}) => p.x >= v.x && p.y >= v.y && p.x < v.x + v.width && p.y < v.y + v.height;
  return { viewport: v, tiles, places: [...places.values()].filter(visible).map(p => ({ ...p })),
    animals: [...world.animals, ...[...archive.values()].flatMap(c => c.animals ?? [])].filter(visible).map(a => projectAnimal(a, world.tick)),
    structures: [...world.structures, ...[...archive.values()].flatMap(c => c.structures ?? legacyStructures(c.tiles, c.lastTick))].filter(visible).map(s => ({id:s.id,x:s.x,y:s.y,blueprintId:s.blueprintId,name:s.name,components:[...s.components],condition:s.condition,water:s.water,food:s.food,uses:s.uses,builtAt:s.builtAt,builderId:s.builderId})),
  };
}
