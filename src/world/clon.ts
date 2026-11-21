import type { World, WorldContext } from './index.js';
import { bindWorldContext, worldContext } from './spatial.js';
import { ResidentTopologyOwner } from './soa/topologia.js';
import { chunkLruFor } from './lru.js';
import { paramsOf, setParams } from './params.js';
import { heredarEstadisticas } from './statistics.js';

/** `structuredClone` semantics for the plain JSON-shaped world state, without its
 * serialize/deserialize round trip. `shared` keeps the identity the world already has —
 * an event lives at once in `events` and in `chronicleJournal.pending`, a place in
 * `places` and in the meta of its active chunk — so writing through one path is still
 * seen through the other. Anything that is not a plain object or array (a Date, a
 * null-prototype record) falls back to `structuredClone` for that subtree. */
function cloneState<T>(value: T, shared: Map<object, unknown>): T {
  if (value === null) return value;
  const kind = typeof value;
  // A host capability smuggled into the state still fails loudly, as structuredClone did.
  if (kind !== 'object') return kind === 'function' ? structuredClone(value) : value;
  const source = value as unknown as object;
  const previous = shared.get(source);
  if (previous !== undefined) return previous as T;
  if (Array.isArray(source)) {
    const copy: unknown[] = new Array(source.length);
    shared.set(source, copy);
    for (let i = 0; i < source.length; i++) if (i in source) copy[i] = cloneState(source[i], shared);
    return copy as T;
  }
  if (Object.getPrototypeOf(source) !== Object.prototype) {
    const copy = structuredClone(value); shared.set(source, copy as object); return copy;
  }
  const copy: Record<string, unknown> = {};
  shared.set(source, copy);
  for (const key in source) copy[key] = cloneState((source as Record<string, unknown>)[key], shared);
  return copy as T;
}

/** Flat terrain cells can be copied without the generic structured-clone traversal overhead. */
export function cloneWorld(world: World, context: WorldContext): World;
export function cloneWorld(world: World): World;
export function cloneWorld(world: World, context: WorldContext = worldContext(world)): World {
  // Same state and same sharing as structuredClone: the non-tile state of the aged 51926
  // laboratory fixture copies in 2.23 ms instead of 8.11 ms (T103).
  const draft: World = cloneState({ ...world, tiles: [], retiredChunks: [] }, new Map());
  const tileOwnership = worldContext(world).tileOwnership || context?.tileOwnership
    ? new ResidentTopologyOwner() : undefined;
  draft.tiles = tileOwnership
    ? tileOwnership.tiles(world.tiles.map(tile => tileOwnership.tile(tile)))
    : world.tiles.map(tile => ({ ...tile }));
  // Dormant chunks are immutable until activate() takes a private deep copy.
  // A new queue is still required: retiring/reactivating must not edit the confirmed queue.
  draft.retiredChunks = [...world.retiredChunks];
  bindWorldContext(draft, { ...worldContext(world), ...(context && typeof context === 'object' ? context : {}), tileOwnership });
  setParams(draft, paramsOf(world));
  // T041: la cadencia de las métricas caras vive en una caché lateral por mundo; el clon
  // de cada paso la hereda para no recalcular la BFS de agua en cada tick.
  heredarEstadisticas(draft, world);
  return draft;
}

/** T104: copia profunda del estado serializable (objetos llanos y arrays), sin el recorrido genérico
 * de `structuredClone`. Un prototipo ajeno se rechaza en vez de copiarse mal. `copias` conserva la
 * identidad compartida entre el estado y las colas que el Store confirmará (`technology.history` y
 * `technology.journal.pending`, `technology.recipes` y `technology.catalogue.pending`, `events` y
 * `chronicleJournal.pending`): las leyes escriben por un camino contando con que el otro lo ve. */
function copiaProfunda(value: object, copias: Map<object, unknown>): unknown {
  const previa = copias.get(value);
  if (previa !== undefined) return previa;
  if (Array.isArray(value)) {
    const length = value.length, copy: unknown[] = new Array(length);
    copias.set(value, copy);
    for (let index = 0; index < length; index++) {
      const item: unknown = value[index];
      copy[index] = item === null || typeof item !== 'object' ? item : copiaProfunda(item, copias);
    }
    return copy;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Estado del mundo con prototipo no copiable en el punto de restauración.');
  const source = value as Record<string, unknown>, copy: Record<string, unknown> = {};
  copias.set(value, copy);
  for (const key in source) {
    const item = source[key];
    copy[key] = item === null || typeof item !== 'object' ? item : copiaProfunda(item, copias);
  }
  return copy;
}

/** T104: lo que hace falta para deshacer un paso que no llegó a confirmarse. */
export interface PuntoDeRestauracion {
  /** Deja el mundo exactamente como estaba cuando se tomó el punto. Se usa una sola vez:
   * al restaurar, el mundo se queda con los objetos del punto y este deja de ser válido. */
  restaurar(): void;
}

/** T104: copia acotada a lo que un paso puede tocar, para simular sobre el mundo vigente
 * (`motor.clonPorPaso=false`) sin perder la atomicidad del paso.
 * · teselas: la copia se la queda el mundo y el punto guarda las confirmadas. `syncFauna` hace
 *   `delete tile.species`, que degrada la forma del objeto; con teselas nuevas cada paso el recorrido
 *   no se encarece (3,41 ms frente a 29,15 ms a 2 400 pasos, digesto idéntico).
 * · `retiredChunks`: array nuevo con chunks compartidos; `activate` clona en profundidad el chunk que
 *   reanima y `maintainRegions` solo añade, así que ningún chunk dormido se muta.
 * · el resto: `copiaProfunda`, que conserva la identidad compartida entre campos como `cloneWorld`.
 * El contenido del punto depende solo del mundo recibido. */
export function puntoDeRestauracion(world: World): PuntoDeRestauracion {
  // Un solo mapa para todos los campos: la identidad compartida cruza de un campo a otro.
  const campos: Record<string, unknown> = {}, copias = new Map<object, unknown>();
  for (const key in world) {
    if (key === 'tiles' || key === 'retiredChunks') continue;
    const value = (world as unknown as Record<string, unknown>)[key];
    campos[key] = value === null || typeof value !== 'object' ? value : copiaProfunda(value, copias);
  }
  const tiles = world.tiles;
  const tileOwnership = worldContext(world).tileOwnership;
  world.tiles = tileOwnership
    ? tileOwnership.tiles(tiles.map(tile => tileOwnership.tile(tile)))
    : tiles.map(tile => ({ ...tile }));
  const retiredChunks = [...world.retiredChunks];
  let usado = false;
  return {
    restaurar() {
      if (usado) throw new Error('El punto de restauración ya se consumió.');
      usado = true;
      const objetivo = world as unknown as Record<string, unknown>;
      // Un paso a medias pudo añadir campos que antes no existían: deshacer es también quitarlos.
      for (const key of Object.keys(objetivo)) if (key !== 'tiles' && key !== 'retiredChunks' && !(key in campos)) delete objetivo[key];
      Object.assign(objetivo, campos);
      world.tiles = tiles; world.retiredChunks = retiredChunks;
      chunkLruFor(world).clear();
      // El lector del catálogo vive en un WeakMap indexado por el `technology` del mundo, y
      // `technology` acaba de volver a ser otro objeto: sin esto el mundo restaurado perdería
      // el archivo de recetas del anfitrión.
      bindWorldContext(world, worldContext(world));
    },
  };
}
