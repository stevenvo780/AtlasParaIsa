import type { PlaceView, Tile, Viewport } from '../shared/types.js';
import { CHUNK_SIZE, MAX_COORDINATE, chunkCoords, chunkKey, generateChunk, generateTile, legacyStructures, type Chunk } from './terrain.js';
import type { World } from './index.js';
import { initializeEcosystem } from './ecosystem.js';
import { paramsOf } from './params.js';
import { faunaCacheAppended, faunaCacheFiltered, materializeAnimals, projectAnimal } from './animals.js';
import type { AnimalView, StructureView } from '../shared/life.js';
import type { LegacyRecord } from '../shared/demography.js';
import { bindTechnologyCatalogue, type TechnologyCatalogueReader } from './technology-catalogue.js';
import { lastTileAt, splitTileBlocks, splitTileBlocksWith, tileIndexAppended, tileLookup } from './tile-index.js';
import type { ResidentTopologyOwner } from './soa/topologia.js';
import { notifyResidentSubset } from './soa/terreno.js';
import { chunkLruFor } from './lru.js';

export interface WorldContext {
  /** Propiedad privada del host, creada antes de exponer teselas; nunca se serializa. */
  tileOwnership?: ResidentTopologyOwner;
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

/** T113 (c). Lo que `maintainRegions` sabe de `world.chunks`, asociado a la identidad de ese objeto:
 * la secuencia de inserción de cada clave viva (el orden de `Object.entries`), cuántas celdas del
 * alcance de alguien piden cada clave (`refs`), las claves que pidió cada habitante en su última
 * posición y las que `activate` añadió desde la última vez. Tras cada llamada las claves vivas son
 * exactamente las pedidas (`refs` > 0), así que sólo puede sobrar una clave cuyo `refs` acaba de
 * llegar a cero o que se activó desde entonces: nada más se mira, y quien no se movió no cuesta
 * nada. Fuera de `activate`/`maintainRegions` nadie añade ni quita claves de un `world.chunks` vivo:
 * las migraciones, el Store, el clon y el punto de restauración ponen un objeto nuevo, que se relee
 * entero una vez. */
interface Presence { x: number; y: number; keys: string[]; stamp: number; }
interface Regions { order: Map<string, number>; next: number; refs: Map<string, number>; people: Map<object, Presence>; stamp: number; added: string[]; }
const regions = new WeakMap<Record<string, ChunkMeta>, Regions>();
function regionsOf(chunks: Record<string, ChunkMeta>): Regions {
  let state = regions.get(chunks);
  if (!state) {
    const keys = Object.keys(chunks);
    state = { order: new Map(keys.map((key, i) => [key, i])), next: keys.length, refs: new Map(), people: new Map(), stamp: 0, added: keys };
    regions.set(chunks, state);
  }
  return state;
}
function release(state: Regions, keys: readonly string[], zeroed: string[]): void {
  for (const key of keys) {
    const refs = state.refs.get(key)! - 1;
    if (refs > 0) state.refs.set(key, refs); else { state.refs.delete(key); zeroed.push(key); }
  }
}
const REACH = [-8, 0, 8] as const;

/** V23: quien conduce el tick con leyes encendidas se entera de cada chunk que entra (ya con sus teselas en el mundo) y
 * de cada uno que va a salir (todavía con ellas), para llamar a `Ley.alActivar` y `Ley.alRetirar`. Sin observador (todo
 * apagado) no hay ni una operación más. */
export interface ObservadorRegiones { activado(key: string, cx: number, cy: number): void; retirar(key: string, cx: number, cy: number): void }
const observadores = new WeakMap<World, ObservadorRegiones>();
export function observarRegiones(world: World, observador: ObservadorRegiones | undefined): void {
  if (observador) observadores.set(world, observador); else observadores.delete(world);
}

/** Claves de los chunks que una persona en (x, y) mantiene activos (el suyo y su halo), para quien lleva las regiones
 * desde el frente público (el coordinador de dueños). */
export function clavesDeHalo(x: number, y: number, out: string[] = []): string[] {
  out.length = 0;
  for (const dx of REACH) for (const dy of REACH) {
    const hx = x + dx, hy = y + dy;
    if (validCoordinate(hx) && validCoordinate(hy)) out.push(chunkKey(hx, hy));
  }
  return out;
}

/** El contenido de un chunk que se activa, sin meterlo en el mundo: del archivo pendiente, de la LRU, del anfitrión o
 * generado, con su ecología iniciada y su fauna y estructuras materializadas. Lo usa el coordinador de dueños, que lo
 * envía a su dueño; `activate` hace lo mismo y además lo inserta. */
export function tomarChunk(world: World, key: string, cx: number, cy: number, context: WorldContext = worldContext(world)): Chunk {
  const pending = pendingIndex(world.retiredChunks, key);
  const cuencas = paramsOf(world).agua.cuencas;
  const lru = chunkLruFor(world);
  let archived = pending >= 0 ? takePending(world.retiredChunks, pending) : lru.get(key);
  lru.delete(key);
  if (!archived && context.loadChunk) archived = context.loadChunk(key, world.tick) ?? undefined;
  const chunk = archived ? structuredClone(archived) : generateChunk(world.seed, cx, cy, cuencas);
  const tiles = chunk.tiles.map(tile => initializeEcosystem(world.seed, tile, cuencas));
  return { ...chunk, tiles, animals: chunk.animals ?? materializeAnimals(world.seed, tiles, world.tick),
    structures: chunk.structures ?? legacyStructures(chunk.tiles, world.tick) };
}

/** Archiva un chunk que su dueño devolvió al retirarlo (motor de dueños): queda pendiente de guardado como los demás. */
export function archivarChunk(world: World, chunk: Chunk): void { retire(world.retiredChunks, chunk); }

export function activate(world: World, x: number, y: number, context: WorldContext = worldContext(world)): void {
  if (!validCoordinate(x) || !validCoordinate(y)) return;
  activateChunk(world, chunkKey(x, y), x, y, context);
}
function activateChunk(world: World, key: string, x: number, y: number, context: WorldContext): void {
  if (world.chunks[key]) return;
  const pending = pendingIndex(world.retiredChunks, key);
  const { cx, cy } = chunkCoords(x, y);
  // T035 ronda de arreglo (hallazgo crítico #2): `agua.cuencas` del MUNDO real, no el default
  // global de `generateChunk`/`initializeEcosystem` — este es el único sitio de producción que
  // materializa teselas nuevas en una partida.
  const cuencas = paramsOf(world).agua.cuencas;
  // Both pending snapshots and host readers may share immutable archived objects.
  // Clone only the chunk being reactivated, before exposing animals/places/structures to laws.
  // Una vez reanimado el chunk vuelve a mutar en vivo: su copia dormida en la LRU deja de ser válida.
  const lru = chunkLruFor(world);
  let archived = pending >= 0 ? takePending(world.retiredChunks, pending) : lru.get(key);
  lru.delete(key);
  if (!archived && context.loadChunk) {
    archived = context.loadChunk(key, world.tick) ?? undefined;
  }
  // Los Tile observados son proxies. El archivo se materializa antes de cruzar structuredClone.
  const archivePlain = archived && context.tileOwnership
    ? { ...archived, tiles: archived.tiles.map(tile => ({ ...tile })) } : archived;
  const chunk = archivePlain ? structuredClone(archivePlain) : generateChunk(world.seed, cx, cy, cuencas);
  const { tiles, animals, structures, ...meta } = chunk;
  world.chunks[key] = meta;
  const state = regions.get(world.chunks);
  if (state) { state.order.set(key, state.next++); state.added.push(key); }
  const initialized=tiles.map(tile => {
    const initialized = initializeEcosystem(world.seed, tile, cuencas);
    return context.tileOwnership?.tile(initialized) ?? initialized;
  });
  const from = world.tiles.length;
  world.tiles.push(...initialized);
  tileIndexAppended(world.tiles, from);
  faunaCacheAppended(world.tiles, from);
  world.animals.push(...(animals ?? materializeAnimals(world.seed, initialized, world.tick)));
  world.structures.push(...(structures ?? legacyStructures(tiles, world.tick)));
  for (const place of meta.places) if (!world.places.some(p => p.id === place.id)) world.places.push(place);
  observadores.get(world)?.activado(key, cx, cy);
}
/** Mueve chunks activos (en el orden dado) a `retiredChunks` con sus teselas, lugares,
 * animales y estructuras, y los recuerda en la LRU del mundo. No borra información. */
function retireActiveChunks(world: World, keys: readonly string[], context: WorldContext = worldContext(world), cacheInLru = false): string[] {
  const state = regions.get(world.chunks);
  const retired = new Set<string>();
  const detached = new Map<string, Chunk>();
  const done: string[] = [];
  const observador = observadores.get(world);
  if (observador) for (const key of keys) { const meta = world.chunks[key]; if (meta) observador.retirar(key, meta.cx, meta.cy); }
  for (const key of keys) {
    const meta = world.chunks[key]!;
    if (!meta) continue;
    const chunk: Chunk = { ...meta, lifeVersion: 4, lastTick: world.tick, tiles: [], places: [], animals: [], structures: [] };
    retire(world.retiredChunks, chunk); detached.set(key, chunk);
    delete world.chunks[key]; retired.add(key); state?.order.delete(key); done.push(key);
  }
  if (retired.size) {
    const prevTiles = world.tiles;
    const owner = context.tileOwnership;
    const byBlock = owner
      ? splitTileBlocksWith(
          prevTiles,
          first => detached.get(chunkKey(first.x, first.y))?.tiles,
          (keptBases, blockLen) => owner.subsetBlocks(prevTiles, keptBases, blockLen),
        )
      : splitTileBlocks(prevTiles, first => detached.get(chunkKey(first.x, first.y))?.tiles);
    if (byBlock) {
      world.tiles = byBlock;
      if (owner) notifyResidentSubset(prevTiles, byBlock, [...detached.values()].flatMap(chunk => chunk.tiles));
    } else {
      const active: Tile[] = [];
      for (const tile of world.tiles) {
        const chunk = detached.get(chunkKey(tile.x, tile.y));
        if (chunk) chunk.tiles.push(tile); else active.push(tile);
      }
      world.tiles = owner?.tiles(active) ?? active;
    }
    faunaCacheFiltered(prevTiles, world.tiles);
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
    const lru = chunkLruFor(world);
    if (cacheInLru) {
      for (const chunk of detached.values()) {
        lru.set(context.tileOwnership ? { ...chunk, tiles: chunk.tiles.map(tile => ({ ...tile })) } : chunk);
      }
    } else {
      for (const key of detached.keys()) lru.delete(key);
    }
  }
  return done;
}

export interface EvictColdChunksOptions { maxActiveChunks?: number; maxActiveTiles?: number; }
const areaBudgets = new WeakMap<World, EvictColdChunksOptions>();
/** Presupuesto de área activo para este mundo (el último dado a `evictColdChunks`), o `undefined`. */
export function activeAreaBudget(world: World): EvictColdChunksOptions | undefined {
  const budget = areaBudgets.get(world);
  return budget ? { ...budget } : undefined;
}
function validateEvictOptions(options: EvictColdChunksOptions): void {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => key !== 'maxActiveChunks' && key !== 'maxActiveTiles')
    || (options.maxActiveChunks !== undefined && (!Number.isSafeInteger(options.maxActiveChunks) || options.maxActiveChunks < 0))
    || (options.maxActiveTiles !== undefined && (!Number.isSafeInteger(options.maxActiveTiles) || options.maxActiveTiles < 0)))
    throw new RangeError('Presupuesto de desalojo inválido: maxActiveChunks/maxActiveTiles deben ser enteros ≥ 0.');
}
/** Halo obligatorio: el chunk de cada persona viva y el anillo ±1 chunk (`REACH` de `maintainRegions`). */
function mandatoryChunkKeys(world: World): Set<string> {
  const mandatory = new Set<string>();
  for (const person of world.people) for (const dx of REACH) for (const dy of REACH) {
    const x = person.x + dx, y = person.y + dy;
    if (validCoordinate(x) && validCoordinate(y)) mandatory.add(chunkKey(x, y));
  }
  return mandatory;
}
/** Distancia Chebyshev, en chunks, del chunk a la persona viva más cercana (`Infinity` sin personas). */
function minChunkDistance(world: World, cx: number, cy: number): number {
  let best = Infinity;
  for (const person of world.people) {
    const pcx = Math.floor(person.x / CHUNK_SIZE), pcy = Math.floor(person.y / CHUNK_SIZE);
    best = Math.min(best, Math.max(Math.abs(cx - pcx), Math.abs(cy - pcy)));
  }
  return best;
}
function evictCold(world: World, options: EvictColdChunksOptions): string[] {
  const overBudget = (): boolean => (options.maxActiveChunks !== undefined && Object.keys(world.chunks).length > options.maxActiveChunks)
    || (options.maxActiveTiles !== undefined && world.tiles.length > options.maxActiveTiles);
  if (!overBudget()) return [];
  const mandatory = mandatoryChunkKeys(world);
  const candidates = Object.entries(world.chunks)
    .filter(([key]) => !mandatory.has(key))
    .map(([key, meta]) => ({ key, lastTick: meta.lastTick, distance: minChunkDistance(world, meta.cx, meta.cy) }))
    .sort((a, b) => (a.distance !== b.distance ? (a.distance > b.distance ? -1 : 1)
      : a.lastTick !== b.lastTick ? a.lastTick - b.lastTick
      : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const evicted: string[] = [];
  for (const candidate of candidates) {
    if (!overBudget()) break;
    evicted.push(...retireActiveChunks(world, [candidate.key], worldContext(world), true));
  }
  return evicted;
}
/**
 * T163 «Reducir área»: retira los chunks activos más fríos que no contienen habitantes ni
 * caen en el halo obligatorio de ninguna persona viva, en orden `(distancia mínima Chebyshev
 * en chunks DESC, lastTick ASC, chunkKey ASC)`, hasta cumplir el presupuesto dado. Los
 * retirados quedan en `world.retiredChunks` (el `Store` los respalda en la tabla `chunks`
 * al guardar y `activate` los reanima desde ahí, desde la LRU o desde `context.loadChunk`).
 * Nunca retira un chunk obligatorio: sin candidatos el conjunto activo puede quedar por
 * encima del presupuesto, pero el movimiento nunca se impide. Sin presupuesto (o ya bajo
 * él) es un no-op. El presupuesto queda activo para los siguientes `maintainRegions`.
 */
export function evictColdChunks(world: World, options: EvictColdChunksOptions = {}): string[] {
  validateEvictOptions(options);
  if (options.maxActiveChunks === undefined && options.maxActiveTiles === undefined) return [];
  areaBudgets.set(world, { ...options });
  return evictCold(world, options);
}

/** Only agent neighborhoods advance ecology. Camera queries never call this function. */
export function maintainRegions(world: World, context: WorldContext = worldContext(world)): void {
  const state = regionsOf(world.chunks), stamp = ++state.stamp, zeroed: string[] = [];
  let seen = 0;
  for (const person of world.people) {
    const presence = state.people.get(person);
    if (presence) {
      if (presence.stamp !== stamp) { presence.stamp = stamp; seen++; }
      // Sus celdas siguen pedidas y por tanto vivas: `activate` no haría nada.
      if (presence.x === person.x && presence.y === person.y) continue;
    }
    const keys: string[] = [];
    for (const dx of REACH) for (const dy of REACH) {
      const x = person.x + dx, y = person.y + dy;
      if (!validCoordinate(x) || !validCoordinate(y)) continue;
      const key = chunkKey(x, y);
      keys.push(key); state.refs.set(key, (state.refs.get(key) ?? 0) + 1);
      activateChunk(world, key, x, y, context);
    }
    if (!presence) { state.people.set(person, { x: person.x, y: person.y, keys, stamp }); seen++; continue; }
    release(state, presence.keys, zeroed);
    presence.x = person.x; presence.y = person.y; presence.keys = keys;
  }
  if (seen !== state.people.size) {
    for (const [person, presence] of state.people) if (presence.stamp !== stamp) { release(state, presence.keys, zeroed); state.people.delete(person); }
  }
  for (const key of state.added) zeroed.push(key);
  state.added.length = 0;
  const stale: string[] = [];
  for (const key of new Set(zeroed)) {
    if (state.refs.has(key)) continue;
    if (Object.hasOwn(world.chunks, key)) stale.push(key); else state.order.delete(key);
  }
  // Mismo orden que `Object.entries(world.chunks)`: el de inserción.
  stale.sort((a, b) => state.order.get(a)! - state.order.get(b)!);
  retireActiveChunks(world, stale, context);
  // T163: con presupuesto de área activo se retira además la página fría que sobra;
  // sin presupuesto este camino no existe y el comportamiento es exactamente el de siempre.
  const budget = areaBudgets.get(world);
  if (budget) evictCold(world, budget);
}
export function normalizeViewport(value?: Viewport): Viewport {
  const v = value ?? { x: 0, y: 0, width: 40, height: 28 };
  if (!validCoordinate(v.x) || !validCoordinate(v.y) || !Number.isInteger(v.width) || !Number.isInteger(v.height) || v.width < 1 || v.width > 96 || v.height < 1 || v.height > 64 || !validCoordinate(v.x + v.width - 1) || !validCoordinate(v.y + v.height - 1)) throw new RangeError('Ventana de mundo inválida (máximo 96 × 64).');
  return { ...v };
}
export function projectTerrain(world: World, viewport?: Viewport, context: WorldContext = worldContext(world)): { viewport: Viewport; tiles: Tile[]; places: PlaceView[]; animals: AnimalView[]; structures: StructureView[] } {
  const v = normalizeViewport(viewport), tiles: Tile[] = [], places = new Map(world.places.map(p => [p.id, p]));
  // Fija la misma vista que tileAt al comienzo; evita crear un Point por cada celda visible.
  const activeTile = tileLookup(world.tiles);
  const archive = new Map<string, Chunk>();
  // T035 ronda de arreglo (hallazgo crítico #2): misma cuenca que `activate()`, para que la
  // previsualización de una zona aún no materializada coincida con lo que se generará de verdad.
  const cuencas = paramsOf(world).agua.cuencas;
  for (let y = v.y; y < v.y + v.height; y++) for (let x = v.x; x < v.x + v.width; x++) {
    const active = activeTile(x, y);
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
