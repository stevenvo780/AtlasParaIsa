import type { PlaceView, Tile, Viewport } from '../shared/types.js';
import { CHUNK_SIZE, MAX_COORDINATE, chunkCoords, chunkKey, generateChunk, generateTile, legacyStructures, type Chunk } from './terrain.js';
import type { World } from './index.js';
import { initializeEcosystem } from './ecosystem.js';
import { paramsOf } from './params.js';
import { materializeAnimals } from './animals.js';
import type { AnimalView, StructureView } from '../shared/life.js';
import { projectAnimal } from './animals.js';
import type { LegacyRecord } from '../shared/demography.js';
import { bindTechnologyCatalogue, type TechnologyCatalogueReader } from './technology-catalogue.js';
import { lastTileAt, splitTileBlocks, tileIndexAppended } from './tile-index.js';

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
/** Índice compartido con la fauna (tile-index.ts): misma respuesta que el `Map` de claves
 * `"x,y"` que se construía aquí, sin crear una cadena por consulta; en un mundo real, aritmética
 * de chunk + posición dentro del chunk (T113). */
export function tileAt(world: World, p: { x: number; y: number }): Tile | undefined {
  return lastTileAt(world.tiles, p.x, p.y);
}

/** T113 (b). `retiredChunks` por clave: primera aparición de cada clave, asociada a la identidad y la
 * longitud del arreglo como el índice de teselas. Sólo `activate` (splice) y `maintainRegions` (push)
 * lo cambian en sitio y lo mantienen aquí; `cloneWorld` y el Store lo reemplazan entero. Indexar
 * cuesta unas diez veces un `findIndex`, así que un arreglo corto, o uno que se consulta pocas veces
 * (la copia que `cloneWorld` hace en cada paso), se sigue recorriendo como siempre. */
interface Archive { length: number; first: Map<string, Chunk>; duplicates: boolean; }
const archives = new WeakMap<Chunk[], Archive>(), lookups = new WeakMap<Chunk[], number>();
const ARCHIVE_MIN_LENGTH = 64, ARCHIVE_MIN_LOOKUPS = 8;
function archiveOf(chunks: Chunk[]): Archive | undefined {
  const archive = archives.get(chunks);
  return archive && archive.length === chunks.length ? archive : undefined;
}
function indexArchive(chunks: Chunk[]): Archive | undefined {
  if (chunks.length < ARCHIVE_MIN_LENGTH) return undefined;
  const seen = (lookups.get(chunks) ?? 0) + 1;
  lookups.set(chunks, seen < ARCHIVE_MIN_LOOKUPS ? seen : 0);
  if (seen < ARCHIVE_MIN_LOOKUPS) return undefined;
  const first = new Map<string, Chunk>();
  let duplicates = false;
  for (const chunk of chunks) { if (first.has(chunk.key)) duplicates = true; else first.set(chunk.key, chunk); }
  const archive = { length: chunks.length, first, duplicates };
  archives.set(chunks, archive);
  return archive;
}
/** Igual que `chunks.findIndex(c => c.key === key)`. Lo reanimado suele ser lo último retirado:
 * la posición se busca desde el final (con claves únicas es la misma). */
function pendingIndex(chunks: Chunk[], key: string): number {
  const archive = archiveOf(chunks) ?? indexArchive(chunks);
  if (archive && !archive.duplicates) {
    const chunk = archive.first.get(key);
    if (!chunk) return -1;
    const at = chunks.lastIndexOf(chunk);
    if (at >= 0) return at;
  }
  return chunks.findIndex(c => c.key === key);
}
function archivedChunk(chunks: Chunk[], key: string): Chunk | undefined {
  const at = pendingIndex(chunks, key);
  return at >= 0 ? chunks[at] : undefined;
}
function takePending(chunks: Chunk[], at: number): Chunk {
  const archive = archiveOf(chunks), chunk = chunks.splice(at, 1)[0]!;
  if (archive && !archive.duplicates) { archive.first.delete(chunk.key); archive.length = chunks.length; } else archives.delete(chunks);
  return chunk;
}
function retire(chunks: Chunk[], chunk: Chunk): void {
  const archive = archiveOf(chunks);
  chunks.push(chunk);
  if (!archive) return;
  if (archive.first.has(chunk.key)) archive.duplicates = true; else archive.first.set(chunk.key, chunk);
  archive.length = chunks.length;
}
export function activate(world: World, x: number, y: number, context: WorldContext = worldContext(world)): void {
  if (!validCoordinate(x) || !validCoordinate(y)) return;
  const key = chunkKey(x, y);
  if (world.chunks[key]) return;
  const pending = pendingIndex(world.retiredChunks, key);
  const { cx, cy } = chunkCoords(x, y);
  // T035 ronda de arreglo (hallazgo crítico #2): `agua.cuencas` del MUNDO real, no el default
  // global de `generateChunk`/`initializeEcosystem` — este es el único sitio de producción que
  // materializa teselas nuevas en una partida.
  const cuencas = paramsOf(world).agua.cuencas;
  // Both pending snapshots and host readers may share immutable archived objects.
  // Clone only the chunk being reactivated, before exposing animals/places/structures to laws.
  const archived = pending >= 0 ? takePending(world.retiredChunks, pending) : context.loadChunk?.(key, world.tick);
  const chunk = archived ? structuredClone(archived) : generateChunk(world.seed, cx, cy, cuencas);
  const { tiles, animals, structures, ...meta } = chunk;
  world.chunks[key] = meta;
  const initialized=tiles.map(tile => initializeEcosystem(world.seed, tile, cuencas));
  const from = world.tiles.length;
  world.tiles.push(...initialized);
  tileIndexAppended(world.tiles, from);
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
    retire(world.retiredChunks, chunk); detached.set(key, chunk);
    delete world.chunks[key]; retired.add(key);
  }
  if (retired.size) {
    const byBlock = splitTileBlocks(world.tiles, first => detached.get(chunkKey(first.x, first.y))?.tiles);
    if (byBlock) world.tiles = byBlock;
    else {
      const active: Tile[] = [];
      for (const tile of world.tiles) {
        const chunk = detached.get(chunkKey(tile.x, tile.y));
        if (chunk) chunk.tiles.push(tile); else active.push(tile);
      }
      world.tiles = active;
    }
    for (const place of world.places) detached.get(chunkKey(place.x, place.y))?.places.push(place);
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
  // T035 ronda de arreglo (hallazgo crítico #2): misma cuenca que `activate()`, para que la
  // previsualización de una zona aún no materializada coincida con lo que se generará de verdad.
  const cuencas = paramsOf(world).agua.cuencas;
  for (let y = v.y; y < v.y + v.height; y++) for (let x = v.x; x < v.x + v.width; x++) {
    const active = tileAt(world, { x, y });
    if (active) { tiles.push({ ...active }); continue; }
    const key = chunkKey(x, y);
    let chunk = archive.get(key);
    if (!chunk) {
      const { cx, cy } = chunkCoords(x, y);
      chunk = archivedChunk(world.retiredChunks, key) ?? context.loadChunk?.(key, world.tick) ?? generateChunk(world.seed, cx, cy, cuencas);
      archive.set(key, chunk);
      // Undiscovered landmarks are scenery, not recorded discoveries.
      for (const place of chunk.places) places.set(place.id, place);
    }
    const index = (y - chunk.cy * CHUNK_SIZE) * CHUNK_SIZE + x - chunk.cx * CHUNK_SIZE;
    tiles.push(initializeEcosystem(world.seed, chunk.tiles[index] ?? generateTile(world.seed, x, y, cuencas), cuencas));
  }
  const visible = (p: {x: number; y: number}) => p.x >= v.x && p.y >= v.y && p.x < v.x + v.width && p.y < v.y + v.height;
  return { viewport: v, tiles, places: [...places.values()].filter(visible).map(p => ({ ...p })),
    animals: [...world.animals, ...[...archive.values()].flatMap(c => c.animals ?? [])].filter(visible).map(a => projectAnimal(a, world.tick)),
    structures: [...world.structures, ...[...archive.values()].flatMap(c => c.structures ?? legacyStructures(c.tiles, c.lastTick))].filter(visible).map(s => ({id:s.id,x:s.x,y:s.y,blueprintId:s.blueprintId,name:s.name,components:[...s.components],condition:s.condition,water:s.water,food:s.food,uses:s.uses,builtAt:s.builtAt,builderId:s.builderId})),
  };
}
