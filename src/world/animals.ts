import type { AnimalAction, AnimalDynamics, AnimalGenes, AnimalSpecies, AnimalView } from '../shared/life.js';
import type { ChronicleEvent, Tile } from '../shared/types.js';
import { FOOD_PER_ANIMAL } from './ecosystem.js';
import { advanceNeeds } from './needs.js';
import { assimilateFood, exertBody, hydrateBody, restBody } from './body.js';
import { MAX_COORDINATE } from './terrain.js';
import { LEGACY_WORLD_LIMITS, limitsOf, paramsOf } from './params.js';
import { tileLookup } from './tile-index.js';
import { residentFaunaCapacity, residentTileReader, type ResidentTileReader } from './soa/terreno.js';
import { applyFaunaChooseOutputs, stepChooseParallel } from './paralelo/fauna-motor.js';
import { primero, primerosDos } from './orden.js';

export const MAX_ACTIVE_ANIMALS = 8192;
export const MAX_ANIMALS_PER_TILE = 6;
// Historical ceiling, kept only for legacy admission defaults and reporting: the live
// admission ceiling is `limitsOf(world).fauna` (throws in `stepAnimals`); breeding capacity is
// the natural one, never a limit: the machine does not decide conduct.
export const MAX_STORED_ANIMALS = LEGACY_WORLD_LIMITS.fauna;
export const MAX_ANIMAL_MEMORY = 12;
export const MAX_ANIMAL_DECISIONS_PER_TICK = 1024;
const MEMORY_TTL = 480;
const MATURITY = 600;
const SPECIES: AnimalSpecies[] = ['hare', 'deer', 'boar', 'fish', 'wolf', 'fox'];
const ACTIONS: AnimalAction[] = ['roam', 'graze', 'drink', 'rest', 'hunt', 'flee'];
const LIFESPAN: Record<AnimalSpecies, number> = { hare: 18000, deer: 36000, boar: 30000, fish: 20000, wolf: 32000, fox: 26000 };
const clamp = (n: number): number => Math.max(0, Math.min(1, n));
interface Point { x: number; y: number; }
export interface AnimalMemory extends Point { tick: number; food: number; water: number; visited: boolean; }
export interface Animal extends AnimalView {
  bornAt: number; lastBirth: number; lastBirthAge: number; lastDecision: number; lastMove: number;
  target: Point; memory: AnimalMemory[]; work: number; preyId: string | null;
}
export interface AnimalWorld {
  seed: number; tick: number; tiles: Tile[]; animals: Animal[]; animalCounter: number;
  animalDynamics: AnimalDynamics; reproductionEnabled?: boolean;
}
export type AnimalEmitter = (event: Omit<ChronicleEvent, 'id' | 'tick'>) => unknown;
const key = (p: Point): string => `${p.x},${p.y}`;
/** Clave de celda para los `Map`/`Set` del paso (sprint noche-perf 2026-09-22): un número único para
 * cada par de enteros del dominio de coordenadas y, fuera de él, la cadena `key` de siempre. Dos
 * puntos comparten `cell` exactamente cuando comparten `key` (para números, la cadena identifica el
 * valor salvo `-0`/`+0`, igual que aquí), así que ningún conjunto ni recuento cambia: sólo deja de
 * crearse una cadena por consulta. El orden de inserción —el único que se recorre— es el mismo. */
const CELL_SPAN = 2 * MAX_COORDINATE;
type Cell = number | string;
const cellXY = (x: number, y: number): Cell => Number.isInteger(x) && Number.isInteger(y) && x >= -MAX_COORDINATE && x < MAX_COORDINATE
  && y >= -MAX_COORDINATE && y < MAX_COORDINATE ? (x + MAX_COORDINATE) * CELL_SPAN + (y + MAX_COORDINATE) : `${x},${y}`;
const cell = (p: Point): Cell => cellXY(p.x, p.y);
const distance = (a: Point, b: Point): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const canonical = (a: { id: string }, b: { id: string }): number => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const coordinate = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= -MAX_COORDINATE && v < MAX_COORDINATE;
const point = (v: unknown): v is Point => !!v && typeof v === 'object' && coordinate((v as Point).x) && coordinate((v as Point).y);
const unit = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

function hash(seed: number, text: string): number {
  let n = seed >>> 0;
  for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619);
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
  n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
  return (n ^ (n >>> 16)) >>> 0;
}
function genes(seed: number, id: string, species: AnimalSpecies): AnimalGenes {
  const varied = (name: string, baseline: number): number => clamp(baseline + (hash(seed, `${id}:${name}`) / 4294967296 - 0.5) * 0.18);
  return { speed: varied('speed', species === 'hare' ? 0.8 : species === 'wolf' ? 0.72 : species === 'fox' ? 0.68 : 0.5),
    perception: varied('perception', species === 'wolf' || species === 'fox' ? 0.7 : 0.55), metabolism: varied('metabolism', 0.5),
    carnivory: varied('carnivory', species === 'wolf' ? 0.96 : species === 'fox' ? 0.85 : species === 'boar' ? 0.22 : 0.04),
    waterEfficiency: varied('water', 0.5), camouflage: varied('camouflage', species === 'hare' || species === 'fox' ? 0.65 : 0.4) };
}

/** Exactly one identity per saved stock unit. Neither traversal order nor the world's weather RNG is consumed. */
export function materializeAnimals(seed: number, tiles: Tile[], tick: number): Animal[] {
  const animals: Animal[] = [];
  const positions = new Set<string>();
  for (const tile of tiles) {
    if (positions.has(key(tile))) throw new Error('Coordenadas de fauna duplicadas.');
    positions.add(key(tile));
    const population = tile.fauna ?? 0;
    if (!Number.isInteger(population) || population < 0 || population > MAX_ANIMALS_PER_TILE
      || population > 0 && !SPECIES.includes(tile.species!)) throw new Error('Existencias de fauna inválidas.');
    for (let n = 0; n < population; n++) {
      const id = `animal-${seed >>> 0}-${tile.x}-${tile.y}-${n}`;
      animals.push({ id, species: tile.species!, x: tile.x, y: tile.y, action: 'roam', reason: 'Explora su hábitat con percepción local.',
        hunger: 0.24 + (hash(seed, `${id}:hunger`) % 18) / 100, thirst: 0.2, energy: 0.8, fatigue: 0.12, health: 1,
        generation: 0, parents: [], genes: genes(seed, id, tile.species!), age: MATURITY, bornAt: tick - MATURITY,
        lastBirth: tick - MATURITY, lastBirthAge: 0, lastDecision: tick - 12, lastMove: tick - 12,
        target: { x: tile.x, y: tile.y }, memory: [], work: 0, preyId: null });
    }
  }
  animals.sort(canonical);
  assertAnimals(animals, tick, tiles);
  return animals;
}

/** Celdas con fauna en la llamada anterior, con sus coordenadas: la tesela se busca en el índice
 * compartido (tile-index.ts), el mismo «última tesela con esas coordenadas» que el `Map` propio que se
 * construía aquí cada vez que cambiaba el arreglo de teselas. */
interface FaunaCache { length: number; occupied: Map<Cell, Point>; }
const faunaCaches = new WeakMap<Tile[], FaunaCache>();

/** Compatibility projection only. Mixed-species totals must be counted from identities, not this representative species.
 * P2: only tiles with fauna the previous call or this one are written; a cache keyed on the tiles array remembers which
 * (rebuilt, reading ground-truth `fauna`, whenever that array is replaced or grows — same trigger as the terrain index). */
export function syncFauna(tiles: Tile[], animals: Animal[]): void {
  const counts = new Map<Cell, { count: number; species: AnimalSpecies; x: number; y: number }>();
  for (const animal of animals) {
    const p = cell(animal), existing = counts.get(p);
    if (existing) { existing.count++; if (animal.species < existing.species) existing.species = animal.species; }
    else counts.set(p, { count: 1, species: animal.species, x: animal.x, y: animal.y });
    if (counts.get(p)!.count > MAX_ANIMALS_PER_TILE) throw new Error('Capacidad local de fauna excedida.');
  }
  let cache = faunaCaches.get(tiles);
  if (!cache || cache.length !== tiles.length) {
    const occupied = new Map<Cell, Point>();
    for (const t of tiles) if (t.fauna && !occupied.has(cell(t))) occupied.set(cell(t), t);
    cache = { length: tiles.length, occupied };
    faunaCaches.set(tiles, cache);
  }
  const tileIn = tileLookup(tiles);
  const write = (p: Cell, at: Point): void => {
    const tile = tileIn(at.x, at.y);
    if (!tile) return;
    const count = counts.get(p);
    const nextFauna = count?.count ?? 0;
    if (!Object.is(tile.fauna, nextFauna)) tile.fauna = nextFauna;
    if (count) {
      if (tile.species !== count.species) tile.species = count.species;
    } else if (Object.hasOwn(tile, 'species')) {
      delete tile.species;
    }
  };
  // Cada celda una sola vez: primero las ocupadas antes y luego las nuevas, el orden del antiguo
  // `new Set([...occupied, ...counts.keys()])` (cada celda escribe una tesela distinta).
  for (const [p, at] of cache.occupied) write(p, at);
  for (const [p, at] of counts) if (!cache.occupied.has(p)) write(p, at);
  cache.occupied = counts;
}

/**
 * Rejilla espacial efímera de fauna (misma filosofía que `rejilla.ts` de personas): sólo existe
 * dentro de `conRejillaFauna` (lo abre `stepWorld`); fuera de ese ámbito las consultas son el
 * recorrido lineal de siempre, así que una mutación manual nunca deja un índice obsoleto.
 *   animalesVivosEnCelda(w, x, y) ≡ w.animals.filter(a => a.x === x && a.y === y && a.health > 0)
 * con los mismos objetos y en el mismo orden de slot: cada celda exacta guarda sus slots en orden
 * creciente y el predicado (coordenadas y salud) se evalúa en vivo sobre el animal actual. Se
 * construye en O(A) en la primera consulta del paso y sigue exacta porque, dentro del paso, el
 * único escritor de `x`/`y` es `move`, que avisa con `animalMovido`; un nacimiento sólo alarga el
 * arreglo (se anexan los slots nuevos en `sincronizarRejillaFauna`) y los escritores que lo
 * reemplazan entero (`stepAnimals`, `harvestAt`) refrescan el ámbito, así que la siguiente
 * consulta lo reconstruye. Un animal repetido en el arreglo o una coordenada no finita en la
 * consulta devuelven `undefined` y el llamador cae al recorrido lineal, idéntico por definición.
 * Nada de esto entra en el mundo ni en su digesto.
 */
interface IndiceFauna {
  arreglo: Animal[];
  length: number;
  valido: boolean;
  celdas: Map<Cell, number[]>;
  celdaPorSlot: Map<number, Cell>;
  slotPorAnimal: Map<Animal, number>;
}
/** Ámbito del paso: guarda el arreglo de fauna vigente, que los escritores de este módulo
 * (`stepAnimals`, `harvestAt`) refrescan con `refrescarAmbitoFauna` cada vez que lo reemplazan. */
interface AmbitoFauna { profundidad: number; arreglo: Animal[]; indice?: IndiceFauna }
const ambitosFauna = new WeakMap<AnimalWorld, AmbitoFauna>();
const rejillaFaunaDesactivada = new WeakMap<AnimalWorld, number>();

function insertarEnCelda(indice: IndiceFauna, slot: number, animal: Animal): boolean {
  if (indice.slotPorAnimal.has(animal)) return false;
  const claveCelda = cell(animal);
  let lista = indice.celdas.get(claveCelda);
  if (!lista) { lista = []; indice.celdas.set(claveCelda, lista); }
  let lo = 0, hi = lista.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (lista[mid]! < slot) lo = mid + 1; else hi = mid; }
  lista.splice(lo, 0, slot);
  indice.celdaPorSlot.set(slot, claveCelda);
  indice.slotPorAnimal.set(animal, slot);
  return true;
}
function construirRejillaFauna(animales: Animal[]): IndiceFauna {
  const indice: IndiceFauna = { arreglo: animales, length: 0, valido: true, celdas: new Map(), celdaPorSlot: new Map(), slotPorAnimal: new Map() };
  for (let slot = 0; slot < animales.length; slot++) {
    const animal = animales[slot];
    if (!(slot in animales) || !animal || typeof animal !== 'object' || !insertarEnCelda(indice, slot, animal)) { indice.valido = false; break; }
  }
  indice.length = animales.length;
  return indice;
}
function sincronizarRejillaFauna(ambito: AmbitoFauna): IndiceFauna {
  const animales = ambito.arreglo;
  let indice = ambito.indice;
  if (!indice || indice.arreglo !== animales || animales.length < indice.length) {
    indice = construirRejillaFauna(animales);
    ambito.indice = indice;
    return indice;
  }
  if (animales.length > indice.length) {
    if (indice.valido) for (let slot = indice.length; slot < animales.length; slot++) {
      const animal = animales[slot];
      if (!(slot in animales) || !animal || typeof animal !== 'object' || !insertarEnCelda(indice, slot, animal)) { indice.valido = false; break; }
    }
    indice.length = animales.length;
  }
  return indice;
}
/** Apunta el ámbito al arreglo de fauna actual y descarta el índice si el arreglo cambió. */
function refrescarAmbitoFauna(world: AnimalWorld): void {
  const ambito = ambitosFauna.get(world);
  if (ambito && ambito.arreglo !== world.animals) { ambito.arreglo = world.animals; ambito.indice = undefined; }
}
/** Descarta el índice al cerrar la fauna del paso: `ordenCanonico` puede haber reordenado el
 * mismo arreglo en el sitio, y eso no lo delata ningún cambio de identidad ni de longitud. */
function invalidarRejillaFauna(world: AnimalWorld): void {
  const ambito = ambitosFauna.get(world);
  if (ambito) { ambito.arreglo = world.animals; ambito.indice = undefined; }
}
export function conRejillaFauna<R>(world: AnimalWorld, fn: () => R): R {
  let ambito = ambitosFauna.get(world);
  if (!ambito) { ambito = { profundidad: 0, arreglo: world.animals }; ambitosFauna.set(world, ambito); }
  ambito.profundidad++;
  try { return fn(); }
  finally {
    ambito.profundidad--;
    if (ambito.profundidad === 0) ambitosFauna.delete(world);
  }
}
/** Animales vivos en la celda exacta `(x, y)`, en orden de slot: dentro del ámbito, los mismos
 * objetos y el mismo orden que `filter(a => a.x === x && a.y === y && a.health > 0)` sobre el
 * arreglo vigente; `undefined` fuera del ámbito o con la rejilla inválida, para que el llamador
 * use ese recorrido lineal, idéntico por definición. */
export function animalesVivosEnCelda(world: AnimalWorld, x: number, y: number): Animal[] | undefined {
  const ambito = ambitosFauna.get(world);
  if (!ambito || (rejillaFaunaDesactivada.get(world) ?? 0) > 0 || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const indice = sincronizarRejillaFauna(ambito);
  if (!indice.valido) return undefined;
  const lista = indice.celdas.get(cellXY(x, y));
  if (!lista) return [];
  const resultado: Animal[] = [];
  for (const slot of lista) {
    const animal = ambito.arreglo[slot]!;
    if (animal && animal.x === x && animal.y === y && animal.health > 0) resultado.push(animal);
  }
  return resultado;
}
/** Notifica el único cambio de posición de la fauna (`move`), después de escribir `x`/`y`. */
export function animalMovido(world: AnimalWorld, animal: Animal): void {
  const ambito = ambitosFauna.get(world);
  if (!ambito?.indice || (rejillaFaunaDesactivada.get(world) ?? 0) > 0) return;
  const indice = sincronizarRejillaFauna(ambito);
  if (!indice.valido) return;
  const slot = indice.slotPorAnimal.get(animal);
  if (slot === undefined || indice.arreglo[slot] !== animal) { indice.valido = false; return; }
  const destino = cell(animal), origen = indice.celdaPorSlot.get(slot);
  if (origen === destino) return;
  const listaOrigen = indice.celdas.get(origen!);
  if (listaOrigen) {
    const i = listaOrigen.indexOf(slot);
    if (i >= 0) listaOrigen.splice(i, 1);
    if (!listaOrigen.length) indice.celdas.delete(origen!);
  }
  let listaDestino = indice.celdas.get(destino);
  if (!listaDestino) { listaDestino = []; indice.celdas.set(destino, listaDestino); }
  let lo = 0, hi = listaDestino.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (listaDestino[mid]! < slot) lo = mid + 1; else hi = mid; }
  listaDestino.splice(lo, 0, slot);
  indice.celdaPorSlot.set(slot, destino);
}
/** Gancho de prueba: fuerza el recorrido lineal dentro del ámbito, como `sinRejillaParaPruebas`. */
export function sinRejillaFaunaParaPruebas<R>(world: AnimalWorld, fn: () => R): R {
  rejillaFaunaDesactivada.set(world, (rejillaFaunaDesactivada.get(world) ?? 0) + 1);
  try { return fn(); }
  finally {
    const depth = (rejillaFaunaDesactivada.get(world) ?? 1) - 1;
    if (depth === 0) rejillaFaunaDesactivada.delete(world); else rejillaFaunaDesactivada.set(world, depth);
  }
}

function habitat(animal: Animal, tile: Tile): boolean {
  return animal.species === 'fish' ? tile.terrain === 'water' : tile.terrain !== 'water' && tile.terrain !== 'shelter';
}
function edible(animal: Animal, prey: Animal): boolean {
  if (animal.genes.carnivory < 0.6 || animal.species === prey.species) return false;
  const p = prey.species;
  return animal.species === 'wolf' ? p === 'hare' || p === 'deer' || p === 'boar' || p === 'fox'
    : animal.species === 'fox' ? p === 'hare' : false;
}
function waterAt(animal: Animal, tile: Tile): number {
  return animal.species === 'fish' ? tile.moisture : tile.biome === 'ocean' ? 0 : tile.drinkingWater ?? 0;
}
function takeWater(animal: Animal, tile: Tile, requested: number): number {
  const amount = Math.min(waterAt(animal, tile), requested);
  if (animal.species === 'fish') tile.moisture = clamp(tile.moisture - amount);
  else tile.drinkingWater = clamp((tile.drinkingWater ?? 0) - amount);
  return amount;
}
/** `habitat`, `tile.growth ?? tile.vegetation` y `waterAt` leídos en la celda residente `at` (los mismos
 * valores que los getters de la tesela, sin pasar por ellos); con `at` < 0, en la tesela. */
function livable(animal: Animal, tile: Tile, reader: ResidentTileReader | undefined, at: number): boolean {
  if (!reader || at < 0) return habitat(animal, tile);
  const terrain = reader.terrainCode(at);
  return animal.species === 'fish' ? terrain === reader.TERRAIN_WATER : terrain !== reader.TERRAIN_WATER && terrain !== reader.TERRAIN_SHELTER;
}
function desertIn(tile: Tile, reader: ResidentTileReader | undefined, at: number): boolean {
  return !reader || at < 0 ? tile.biome === 'desert' : reader.biomeCode(at) === reader.BIOME_DESERT;
}
function plantIn(tile: Tile, reader: ResidentTileReader | undefined, at: number): number {
  return !reader || at < 0 ? tile.growth ?? tile.vegetation : reader.growth(at) ?? reader.vegetation(at)!;
}
function waterIn(animal: Animal, tile: Tile, reader: ResidentTileReader | undefined, at: number): number {
  if (!reader || at < 0) return waterAt(animal, tile);
  return animal.species === 'fish' ? reader.moisture(at)! : reader.biomeCode(at) === reader.BIOME_OCEAN ? 0 : reader.drinkingWater(at) ?? 0;
}
function remember(animal: Animal, tile: Point, tick: number, visited: boolean, food: number, water: number): void {
  const memory = animal.memory, x = tile.x, y = tile.y;
  // `find` precedía al filtro de caducidad: la primera visita a la celda, incluso caducada, conserva
  // visited. Con coordenadas enteras, misma celda (`cell`) equivale a mismas coordenadas (`===`).
  let existingVisited = false, found = false, kept = 0;
  for (const m of memory) {
    if (m.x === x && m.y === y) { if (!found) { existingVisited = m.visited; found = true; } }
    else if (tick - m.tick <= MEMORY_TTL) memory[kept++] = m;
  }
  // El recuerdo nuevo va al final; si no cabe, sale el más antiguo de los que quedan (el `shift` de antes).
  const drop = kept >= MAX_ANIMAL_MEMORY ? 1 : 0;
  for (let i = drop; i < kept; i++) memory[i - drop] = memory[i]!;
  memory[kept - drop] = { x, y, tick, food, water, visited: visited || existingVisited };
  memory.length = kept - drop + 1;
}
/** `tile(x, y)` es el índice de terreno fijado al empezar el paso (el `Map` de claves `"x,y"` que se
 * construía aquí, ahora compartido con `tileAt` en tile-index.ts): misma tesela para las mismas
 * coordenadas, y como antes no ve teselas añadidas a mitad del paso. */
interface Resource extends Point { food: number; water: number; }
interface VisibleTile extends Resource { growth: number | undefined; novelty: number | undefined; cell: Cell; }
/** Vecina candidata de `move`: las coordenadas de la consulta, su tesela y su celda residente (o -1). */
interface Step extends Point { tile: Tile; at: number; }
/** Radio máximo de percepción (`2 + ⌊1·4⌋`) y lado del cuadrado de desplazamientos que lo contiene. */
const MAX_RADIUS = 6, SEEN_SIDE = 2 * MAX_RADIUS + 1;
interface LocalState {
  tile: (x: number, y: number) => Tile | undefined; occupants: Map<Cell, Animal[]>; counts: Map<Cell, number>;
  reader: ResidentTileReader | undefined;
  visible: VisibleTile[]; pool: VisibleTile[]; resources: Resource[]; adjacent: VisibleTile[]; neighbors: Step[]; steps: Step[];
  /** Desplazamientos (dx, dy) de la última `localTiles` que entraron en lo visible: valen `stamp`. */
  seen: Int32Array; stamp: number;
}
/** La celda a (dx, dy) del animal está en lo que devolvió su última `localTiles`: lo mismo que buscar su
 * `cell` en `visible`, porque con coordenadas enteras dos celdas coinciden si coinciden sus desplazamientos. */
const seenAt = (state: LocalState, dx: number, dy: number): boolean => Math.abs(dx) <= MAX_RADIUS && Math.abs(dy) <= MAX_RADIUS
  && state.seen[(dy + MAX_RADIUS) * SEEN_SIDE + dx + MAX_RADIUS] === state.stamp;
function localTiles(animal: Animal, state: LocalState): VisibleTile[] {
  const radius = 2 + Math.floor(animal.genes.perception * 4), result = state.visible, reader = state.reader, stamp = ++state.stamp;
  result.length = 0;
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    if (Math.abs(dx) + Math.abs(dy) > radius) continue;
    let x = animal.x + dx, y = animal.y + dy, growth: number | undefined, vegetation: number, water: number;
    if (reader) {
      const at = reader.cellAt(x, y);
      if (at < 0) continue;
      const terrain = reader.terrainCode(at);
      if (animal.species === 'fish' ? terrain !== reader.TERRAIN_WATER
        : terrain === reader.TERRAIN_WATER || terrain === reader.TERRAIN_SHELTER) continue;
      growth = reader.growth(at); vegetation = reader.vegetation(at)!;
      water = animal.species === 'fish' ? reader.moisture(at)!
        : reader.biomeCode(at) === reader.BIOME_OCEAN ? 0 : reader.drinkingWater(at) ?? 0;
      // Las coordenadas implícitas no distinguen -0 de +0. Sólo en los ejes se leen las
      // coordenadas originales para conservar también esos bits en target y memory.
      if (x === 0 || y === 0) { const original = state.tile(x, y)!; x = original.x; y = original.y; }
    } else {
      const tile = state.tile(animal.x + dx, animal.y + dy);
      if (!tile || !habitat(animal, tile)) continue;
      x = tile.x; y = tile.y; growth = tile.growth; vegetation = tile.vegetation; water = waterAt(animal, tile);
    }
    // Scratch exclusivo del paso, reutilizado entre decisiones; ningún objeto escapa:
    // remember copia sus campos y choose copia el destino antes de la siguiente decisión.
    const t = state.pool[result.length] ??= { x: 0, y: 0, growth: undefined, food: 0, water: 0, novelty: undefined, cell: 0 };
    t.x = x; t.y = y; t.growth = growth; t.food = growth ?? vegetation; t.water = water; t.novelty = undefined; t.cell = cellXY(x, y);
    result.push(t);
    state.seen[(dy + MAX_RADIUS) * SEEN_SIDE + dx + MAX_RADIUS] = stamp;
  }
  return result;
}
/** Distancia de `p` al depredador más cercano. */
function safety(threats: readonly Animal[], p: Point): number {
  let min = Infinity;
  for (const t of threats) min = Math.min(min, distance(t, p));
  return min;
}
/** Atractivo de explorar la tesela: función pura de la tesela, calculada una vez (`t.novelty`) y no en cada comparación. */
function novelty(animal: Animal, seed: number, tick: number, t: VisibleTile): number {
  let value = t.novelty;
  if (value === undefined) {
    const visit = animal.memory.find(m => m.visited && m.x === t.x && m.y === t.y);
    value = (visit ? Math.min(1, (tick - visit.tick) / MEMORY_TTL) : 2) + hash(seed, `${animal.id}:${key(t)}:${Math.floor(tick / 60)}`) / 4294967296 * 0.2;
    t.novelty = value;
  }
  return value;
}
function choose(animal: Animal, world: AnimalWorld, state: LocalState): void {
  const visible = localTiles(animal, state), near = visible.flatMap(t => state.occupants.get(cell(t)) ?? []).filter(a => a.id !== animal.id && a.health > 0);
  const threats = near.filter(a => edible(a, animal) && distance(a, animal) <= 1 + Math.floor(animal.genes.perception * 5));
  const adjacent = state.adjacent;
  adjacent.length = 0;
  for (const t of visible) if (distance(t, animal) === 1 && (state.counts.get(t.cell) ?? 0) < MAX_ANIMALS_PER_TILE) adjacent.push(t);
  let action: AnimalAction = 'roam', target: Point = animal, reason = 'Explora celdas cercanas y evita recorridos que recuerda.';
  let preyId: string | null = null;
  // Los dos primeros del mismo orden estable, sin ordenar todo lo visible (orden.ts).
  for (const tile of primerosDos(visible, (a, b) => (b.water + (b.growth ?? 0)) - (a.water + (a.growth ?? 0)) || distance(a, animal) - distance(b, animal) || a.y - b.y || a.x - b.x,
    t => (t.growth ?? 0) > 0.05 || t.water > 0.005)) remember(animal, tile, world.tick, distance(tile, animal) === 0, tile.food, tile.water);
  if (threats.length) {
    const escape = primero(adjacent, (a, b) => safety(threats, b) - safety(threats, a) || a.y - b.y || a.x - b.x);
    action = 'flee'; target = escape && safety(threats, escape) > safety(threats, animal) ? escape : animal;
    reason = 'Percibe un depredador cercano y se aleja físicamente de su alcance.';
  } else {
    // Mismo orden: rombo visible, seguido de recuerdos válidos que no están en el rombo.
    const resources = state.resources;
    resources.length = 0;
    for (const t of visible) resources.push(t);
    for (const m of animal.memory) {
      if (world.tick - m.tick > MEMORY_TTL || !(state.reader ? state.reader.cellAt(m.x, m.y) >= 0 : state.tile(m.x, m.y) !== undefined)) continue;
      if (!seenAt(state, m.x - animal.x, m.y - animal.y)) resources.push(m);
    }
    const water = primero(resources, (a, b) => distance(a, animal) - distance(b, animal) || b.water - a.water || a.y - b.y || a.x - b.x, t => t.water > 0.001);
    const food = primero(resources, (a, b) => distance(a, animal) - distance(b, animal) || b.food - a.food || a.y - b.y || a.x - b.x, t => t.food > 0.001);
    const prey = primero(near, (a, b) => distance(a, animal) - distance(b, animal) || canonical(a, b), a => edible(animal, a));
    if (animal.thirst > 0.42 && water) { action = 'drink'; target = water; reason = 'La sed orienta su camino hacia agua percibida o recordada.'; }
    else if (animal.hunger > 0.38 && prey) { action = 'hunt'; target = prey; preyId = prey.id; reason = 'Persigue una presa individual visible; alimentarse exige alcanzarla.'; }
    else if (animal.hunger > 0.38 && animal.genes.carnivory < 0.6 && food) { action = 'graze'; target = food; reason = 'El hambre orienta su camino hacia crecimiento vegetal finito.'; }
    else if (animal.energy < 0.4 || animal.fatigue > 0.55) { action = 'rest'; reason = 'El agotamiento requiere una pausa; descansar no elimina hambre ni sed.'; }
    else {
      const { seed, tick } = world;
      target = primero(adjacent, (a, b) => novelty(animal, seed, tick, b) - novelty(animal, seed, tick, a) || a.y - b.y || a.x - b.x) ?? animal;
    }
  }
  if (animal.action !== action || animal.preyId !== preyId) animal.work = 0;
  animal.action = action; animal.target = { x: target.x, y: target.y }; animal.reason = reason; animal.preyId = preyId; animal.lastDecision = world.tick;
}
/** Cadena secuencial: cada movimiento libera y ocupa celdas en `state.counts`/`state.occupants`,
 * que el siguiente `move` lee para el cupo `MAX_ANIMALS_PER_TILE`; liberar una celda habilita la
 * entrada de otro. Permanece en la fase serial del coordinador: repartirlo por región cambiaría
 * quién entra. */
function move(animal: Animal, world: AnimalWorld, state: LocalState): void {
  const interval = Math.ceil(11 - animal.genes.speed * 7 + animal.fatigue * 3);
  if (animal.action === 'rest' || distance(animal, animal.target) === 0 || world.tick - animal.lastMove < interval || animal.energy < 0.06) return;
  const neighbors = state.neighbors, reader = state.reader;
  neighbors.length = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (Math.abs(dx) + Math.abs(dy) !== 1) continue;
    const t = state.tile(animal.x + dx, animal.y + dy);
    if (!t) continue;
    // Las coordenadas de la consulta valen lo mismo que las de la tesela (salvo el signo de un cero, que
    // ni `cellXY` ni las restas del comparador distinguen); la posición nueva se copia de la tesela.
    const x = animal.x + dx, y = animal.y + dy, at = reader ? reader.cellAt(x, y) : -1;
    if (!livable(animal, t, reader, at) || (state.counts.get(cellXY(x, y)) ?? 0) >= MAX_ANIMALS_PER_TILE) continue;
    const step = state.steps[neighbors.length] ??= { x, y, tile: t, at };
    step.x = x; step.y = y; step.tile = t; step.at = at;
    neighbors.push(step);
  }
  const next = primero(neighbors, (a, b) => distance(a, animal.target) - distance(b, animal.target) || a.y - b.y || a.x - b.x);
  if (!next) return;
  const current = state.tile(animal.x, animal.y)!, here = reader ? reader.cellAt(animal.x, animal.y) : -1;
  remember(animal, current, world.tick, true, plantIn(current, reader, here), waterIn(animal, current, reader, here));
  const from = cell(animal);
  state.counts.set(from, state.counts.get(from)! - 1);
  // Nadie conserva los arreglos de ocupantes (quien los lee copia sus elementos): quitar y añadir en el
  // sitio da el mismo contenido y el mismo orden que los arreglos nuevos de antes.
  const left = state.occupants.get(from);
  if (left) { let kept = 0; for (const a of left) if (a !== animal) left[kept++] = a; left.length = kept; }
  else state.occupants.set(from, []);
  const to = next.tile;
  animal.x = to.x; animal.y = to.y; animal.lastMove = world.tick; animalMovido(world, animal);
  const arrival = cell(animal);
  state.counts.set(arrival, (state.counts.get(arrival) ?? 0) + 1);
  const arrived = state.occupants.get(arrival);
  if (arrived) arrived.push(animal); else state.occupants.set(arrival, [animal]);
  exertBody(animal, { energy: animal.action === 'flee' ? 0.003 : 0.0015, fatigue: animal.action === 'flee' ? 0.004 : 0.002 });
  remember(animal, to, world.tick, true, plantIn(to, reader, next.at), waterIn(animal, to, reader, next.at));
}
function death(world: AnimalWorld, animal: Animal, cause: string, emit?: AnimalEmitter, hunter?: string): void {
  animal.health = 0; world.animalDynamics.deaths++;
  emit?.({ kind: 'animal', actors: hunter ? [hunter, animal.id] : [animal.id], x: animal.x, y: animal.y,
    text: `${animal.species} ${animal.id} muere por ${cause}.`, cause, source: 'simulation' });
}
function physiology(animal: Animal, desert: boolean, world: AnimalWorld, emit?: AnimalEmitter): void {
  const metabolism = 0.6 + animal.genes.metabolism * 0.8;
  advanceNeeds(animal, { hunger: 0.00042 * metabolism, thirst: 0.00048 * (1.3 - animal.genes.waterEfficiency * 0.6)
    + (desert ? 0.00015 : 0), energy: 0.00008 * metabolism, stressEnergy: 0.0002, fatigue: 0.00012 });
  // Dormancy never catches up. A founder materialized in this very tick has not yet completed another age interval.
  animal.age = Math.min(animal.age + 1, world.tick - animal.bornAt);
  const cause = animal.thirst >= 0.985 ? 'deshidratación' : animal.hunger >= 0.985 ? 'inanición'
    : animal.energy <= 0.001 ? 'agotamiento' : animal.age > LIFESPAN[animal.species] ? 'senescencia' : '';
  if (cause) animal.health = clamp(animal.health - (cause === 'deshidratación' ? 0.0012 : cause === 'inanición' ? 0.0008 : 0.0003));
  else if (animal.hunger < 0.55 && animal.thirst < 0.55 && animal.energy > 0.35 && animal.health < 1) {
    animal.health = clamp(animal.health + 0.00015); animal.energy = clamp(animal.energy - 0.00003);
  }
  if (animal.health <= 0) death(world, animal, cause || 'heridas', emit);
}
function feed(animal: Animal, tile: Tile, world: AnimalWorld): void {
  if (distance(animal, animal.target) > 0) return;
  if (animal.action === 'graze' && animal.genes.carnivory < 0.6) {
    const consumed = Math.min(tile.growth ?? tile.vegetation, 0.0015, animal.hunger / 4);
    tile.growth = clamp((tile.growth ?? tile.vegetation) - consumed);
    tile.vegetation = clamp(tile.vegetation - consumed * 0.5);
    assimilateFood(animal, consumed, { hungerPerUnit: 4, assimilation: 1 - animal.genes.carnivory, energyPerUnit: 0.8 });
    world.animalDynamics.plantConsumed += consumed;
    // Plant water is finite and belongs to this patch, never to an invisible drinking reservoir.
    if (animal.species !== 'fish') {
      const moisture = Math.min(tile.moisture, consumed * 3);
      tile.moisture = clamp(tile.moisture - moisture); hydrateBody(animal, moisture, 0.3);
      world.animalDynamics.waterConsumed += moisture * 0.1;
    }
    if (animal.hunger < 0.15 || (tile.growth ?? 0) <= 0.001) animal.lastDecision = world.tick - 12;
  } else if (animal.action === 'drink') {
    const water = takeWater(animal, tile, Math.min(0.0016, animal.thirst / 3));
    hydrateBody(animal, water); world.animalDynamics.waterConsumed += water;
    if (animal.thirst < 0.15 || water <= 0) animal.lastDecision = world.tick - 12;
  } else if (animal.action === 'rest') {
    restBody(animal, { fatigue: 0.002, energy: 0.0015 });
    if (animal.energy > 0.75 && animal.fatigue < 0.2) animal.lastDecision = world.tick - 12;
  }
}
/** Same number as `world.tiles.filter(t => t.terrain !== 'shelter' && (t.growth ?? 0) > 0.04).length`,
 * without allocating the intermediate array. `reproduce` calls this at most once per tick, guarded by
 * `capacity ??=` below, so it already runs once per `stepAnimals`, not once per animal. A cache kept
 * ACROSS ticks (by `world.tiles` reference, as `tile-index.ts` does for position) would go stale the
 * moment any tile's `growth` crosses 0,04: `stepEcosystem`, `trampleTile` and `cultivateTile`
 * (`index.ts`, `ecosystem.ts`, `ecosystem-kernel.ts`) rewrite `growth` every tick, outside the fauna
 * capacity's declared scope (regla 1) and unseen from here. Maintaining the count incrementally needs
 * those sites to report their own deltas — proposed for T140 ("recuento incremental mantenido por el
 * paso ecológico"), not attempted here: a wrong number would change `digestoCanonico`. */
function faunaCapacity(tiles: readonly Tile[]): number {
  const fast = residentFaunaCapacity(tiles);
  if (fast !== undefined) return fast;
  let count = 0;
  for (const t of tiles) if (t.terrain !== 'shelter' && (t.growth ?? 0) > 0.04) count++;
  return count * 3;
}
const BREEDING_CELLS = [[0, 0], [0, -1], [-1, 0], [1, 0], [0, 1]] as const;
function reproduce(world: AnimalWorld, state: LocalState, active: Animal[], emit?: AnimalEmitter): void {
  if (world.reproductionEnabled === false) return;
  // Eligibility uses biological time. A global modulo would permanently exclude some rotating cohorts.
  let capacity: number | undefined;
  // Only initiators consume an action slot. Resident partners can receive costs without an extra physiological turn.
  const eligible = (a: Animal): boolean => a.age >= MATURITY && a.age - a.lastBirthAge >= MATURITY
    && a.health > 0.75 && a.energy > 0.65 && a.hunger < 0.4 && a.thirst < 0.4 && a.action !== 'flee';
  for (const a of active) {
    if (capacity !== undefined && world.animals.length >= capacity) break;
    if (!eligible(a)) continue;
    const tile = state.tile(a.x, a.y)!;
    if ((state.counts.get(cell(a)) ?? 0) >= MAX_ANIMALS_PER_TILE || waterAt(a, tile) < 0.012
      || (tile.growth ?? 0) < 0.08) continue;
    // La pareja es la primera en orden canónico (`sort(canonical)[0]`) de las elegibles de su vecindad.
    let b: Animal | undefined;
    for (const [dx, dy] of BREEDING_CELLS) for (const c of state.occupants.get(cellXY(a.x + dx!, a.y + dy!)) ?? [])
      if (c !== a && c.species === a.species && eligible(c) && (!b || canonical(c, b) < 0)) b = c;
    if (!b) continue;
    // Capacidad de cría = capacidad NATURAL del terreno. `limites.fauna` es admisión (lanza en
    // `stepAnimals`), nunca una política silenciosa: la máquina no decide cuántos animales nacen.
    capacity ??= faunaCapacity(world.tiles);
    if (world.animals.length >= capacity) break;
    const parents = [a.id, b.id].sort(), id = `animal-born-${world.seed >>> 0}-${world.tick}-${++world.animalCounter}`;
    const inherited = Object.fromEntries(Object.keys(a.genes).map(name => {
      const field = name as keyof AnimalGenes, mutation = (hash(world.seed, `${id}:${parents.join(':')}:${field}`) / 4294967296 - 0.5) * 0.06;
      return [field, clamp((a.genes[field] + b.genes[field]) / 2 + mutation)];
    })) as unknown as AnimalGenes;
    for (const parent of [a, b]) {
      parent.lastBirth = world.tick; parent.lastBirthAge = parent.age; parent.energy = clamp(parent.energy - 0.18); parent.hunger = clamp(parent.hunger + 0.12);
      parent.thirst = clamp(parent.thirst + 0.07); parent.fatigue = clamp(parent.fatigue + 0.1);
    }
    const water = takeWater(a, tile, 0.012); world.animalDynamics.waterConsumed += water;
    // The natal patch provides limited biomass as well as energy donated by both parents.
    tile.growth = clamp((tile.growth ?? 0) - 0.06); world.animalDynamics.plantConsumed += 0.06;
    const child: Animal = { id, species: a.species, x: a.x, y: a.y, action: 'rest', reason: 'Cría con rasgos heredados; necesita alimento, agua y descanso.',
      hunger: 0.32, thirst: 0.25, energy: 0.35, fatigue: 0.2, health: 0.8, genes: inherited,
      generation: Math.max(a.generation, b.generation) + 1, parents, age: 0, bornAt: world.tick, lastBirth: world.tick, lastBirthAge: 0,
      lastDecision: world.tick, lastMove: world.tick, target: { x: a.x, y: a.y }, memory: [], work: 0, preyId: null };
    const here = cell(a);
    world.animals.push(child); state.counts.set(here, (state.counts.get(here) ?? 0) + 1); world.animalDynamics.births++;
    emit?.({ kind: 'animal', actors: [...parents, id], x: a.x, y: a.y, text: `Nace ${a.species} de generación ${child.generation}.`, cause: 'reproducción con costes corporales, alimento y agua', source: 'simulation' });
  }
}

/** Certificado del orden canónico (T116): la fauna tal como quedó en orden y, si el mundo se clona entre
 * pasos, también sus ids. Un arreglo cuyos elementos son, en el mismo orden, una subsecuencia de los
 * certificados también está en orden: lo que otro código hace entre pasos es quitar (una caza, un chunk
 * que se retira) o añadir al final (un chunk que se activa), y el orden por `id` de lo que queda no
 * cambia. Por objeto, verlo compara punteros sin leer ningún animal (la premisa es que un `id` no se
 * reasigna nunca: es la identidad). El clon de cada paso (`motor.clonPorPaso`) trae objetos nuevos, así
 * que ahí se comparan los ids, que `cloneWorld` comparte (comparar es otra vez comparar punteros).
 * Es solo una caché: decide qué parte hay que comprobar, nunca qué arreglo sale. Tiene un único
 * hueco; si lo ocupa otro mundo, se comprueba por pares. */
let certificado: { objetos: readonly Animal[]; ids: readonly string[] | null } = { objetos: [], ids: null };
/** El certificado lleva ids: la última comprobación no reconoció la fauna por sus objetos y sí (o
 * quizá) por sus ids, que es lo que pasa cuando el mundo se clona entre pasos. */
let porIds = false;
/** Los ids de `animals` al cerrar un paso con crías, sin leer los animales ya certificados: salvo las
 * `crias`, `animals` es una subsecuencia de los objetos del certificado, cuyos ids ya se conocen. `null` si
 * no lo es (el hueco es de otro mundo): entonces se leen. */
function idsSinLeer(animals: readonly Animal[], crias: ReadonlySet<Animal>): string[] | null {
  const { objetos, ids } = certificado, m = objetos.length;
  if (!ids) return null;
  const r = new Array<string>(animals.length);
  for (let i = 0, k = 0; i < animals.length; i++) {
    const animal = animals[i]!;
    if (k < m && animal === objetos[k]) { r[i] = ids[k++]!; continue; }
    if (crias.has(animal)) { r[i] = animal.id; continue; }
    while (k < m && animal !== objetos[k]) k++;
    if (k === m) return null;
    r[i] = ids[k++]!;
  }
  return r;
}
function certificar(animals: readonly Animal[], ids: readonly string[] | null): void {
  if (porIds && !ids) { const nuevos = new Array<string>(animals.length); for (let i = 0; i < animals.length; i++) nuevos[i] = animals[i]!.id; ids = nuevos; }
  // Sin `Object.freeze`: leer un arreglo congelado en el recorrido cuesta ~3,6 veces más.
  certificado = { objetos: animals.slice(), ids: porIds ? ids : null };
}
/** Hasta dónde el principio de `animals` es, en orden, una subsecuencia del certificado (por objeto o,
 * si lo lleva, por id); `exacto` si es el mismo arreglo de objetos, y `mismosIds` si es la misma
 * secuencia de ids, sin saltos, y el certificado la lleva. Los saltos por el certificado no pasan de
 * `animals.length`, así que el recorrido es O(A) aunque el certificado sea de un mundo mayor. */
function prefijoCertificado(animals: readonly Animal[]): { hasta: number; exacto: boolean; mismosIds: boolean } {
  const { objetos, ids } = certificado, n = animals.length, m = objetos.length;
  let i = 0;
  while (i < n && i < m && animals[i] === objetos[i]) i++;
  if (i === n && n === m) { porIds = false; return { hasta: n, exacto: true, mismosIds: false }; }
  let k = i, saltos = 0, porId = false;
  for (; i < n; i++, k++) {
    const animal = animals[i]!, id = ids ? animal.id : undefined;
    while (k < m && saltos <= n && animal !== objetos[k] && (id === undefined || id !== ids![k])) { k++; saltos++; }
    if (k === m || saltos > n) break;
    if (animal !== objetos[k]) porId = true;
  }
  // Sin ningún animal reconocido por objeto, o reconocidos por id: se clona entre pasos (o es otro mundo).
  porIds = porId || i === 0 && n > 0 && m > 0;
  return { hasta: i, exacto: false, mismosIds: !!ids && saltos === 0 && i === n && k === m };
}
/** Mete `cola`, en orden canónico, en `animals[0, hasta)`, también en orden, sobre el propio arreglo
 * (que mide `hasta + cola.length`). Da lo mismo que el `sort` estable de `animals[0, hasta) ++ cola`:
 * cada elemento de la cola va detrás de los de delante con su mismo id (el primer id mayor) y la cola
 * conserva su orden. El sitio se busca galopando hacia atrás desde el anterior: las crías de un paso
 * comparten prefijo de id y caen juntas, así que casi todas cuestan una comparación. */
function mezclar(animals: Animal[], hasta: number, cola: readonly Animal[]): void {
  let i = hasta; // animals[0, i) sigue en su sitio de origen
  for (let c = cola.length - 1; c >= 0; c--) {
    const animal = cola[c]!, id = animal.id;
    let lo = i;
    if (lo > 0 && id < animals[lo - 1]!.id) {
      // animals[alto].id > id; se galopa hasta un `bajo` con id <= id (o -1) y se busca entre ambos.
      let alto = lo - 1, bajo = -1, salto = 1;
      for (let cand = alto - salto; cand >= 0; cand = alto - salto) {
        if (id < animals[cand]!.id) { alto = cand; salto *= 2; } else { bajo = cand; break; }
      }
      let a = bajo + 1, b = alto;
      while (a < b) { const mid = (a + b) >>> 1; if (id < animals[mid]!.id) b = mid; else a = mid + 1; }
      lo = a;
    }
    while (i > lo) { i--; animals[i + c + 1] = animals[i]!; }
    animals[lo + c] = animal;
  }
}
/** Deja `animals` en orden canónico, en su sitio: el mismo arreglo que `animals.sort(canonical)`, y lo
 * certifica. `animals[0, desde)` se sabe en orden; al empezar el paso (`desde` = 0) se sabe hasta donde
 * llegue el certificado. Desde ahí se recorren los pares hasta el primer desorden, y lo que queda —las
 * crías del paso, la fauna de un chunk recién activado, o todo si se perdió el orden— se ordena aparte
 * y se mezcla. El `sort` O(A log A) de la fauna entera queda para cuando se pierde el orden entero.
 * Al cerrar un paso sin crías no hay nada que hacer: lo que queda es una subsecuencia de lo certificado
 * al empezarlo, y el paso siguiente lo reconoce así. */
function ordenCanonico(animals: Animal[], desde = 0): void {
  let ids: readonly string[] | null = null, crias: ReadonlySet<Animal> | null = null;
  if (desde === 0) {
    const prefijo = prefijoCertificado(animals);
    if (prefijo.exacto) return;
    if (prefijo.mismosIds) ids = certificado.ids;
    desde = prefijo.hasta;
  } else if (desde >= animals.length) return;
  else if (porIds) crias = new Set(animals.slice(desde));
  let j = Math.max(1, desde);
  while (j < animals.length && animals[j - 1]!.id < animals[j]!.id) j++;
  if (j < animals.length) { mezclar(animals, j, animals.slice(j).sort(canonical)); ids = null; }
  certificar(animals, ids ?? (crias && idsSinLeer(animals, crias)));
}

/** Máscara de fauna del paso (T116), de solo lectura: quién piensa en este tick. La calcula el
 * coordinador una vez, con la ventana sobre la población GLOBAL en orden canónico; las regiones sólo
 * consultan pertenencia (`seleccionDe`). Una ventana o un offset por región cambiaría qué animales
 * piensan en qué tick. `animales`, `tick`, `poblacion` y `orden` (toda la fauna en orden canónico, tal
 * como estaba al calcularla) la atan al paso para el que se calculó. */
export interface MascaraFauna {
  readonly tick: number; readonly animales: readonly Animal[]; readonly poblacion: number; readonly orden: readonly Animal[];
  readonly seleccion: readonly Animal[]; readonly ids: ReadonlySet<string>;
}
const mismosObjetos = (a: readonly Animal[], b: readonly Animal[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
/** La máscara del coordinador. Su `orden` es una copia congelada: el certificado no sale nunca del módulo. */
export function mascaraFauna(world: AnimalWorld): MascaraFauna {
  const seleccion = calcularMascara(world), animales = world.animals;
  return Object.freeze({ tick: world.tick, animales, poblacion: animales.length, orden: Object.freeze(certificado.objetos.slice()),
    seleccion: Object.freeze(seleccion), ids: new Set(seleccion.map(a => a.id)) });
}
/** La selección de la máscara: deja la fauna en orden canónico y devuelve, en ese orden, quién piensa. */
function calcularMascara(world: AnimalWorld): Animal[] {
  ordenCanonico(world.animals);
  const animals = world.animals, population = animals.length;
  const offset = population ? ((world.tick % population) * MAX_ACTIVE_ANIMALS) % population : 0;
  let selected: Animal[];
  if (population <= MAX_ACTIVE_ANIMALS) selected = [...animals];
  else {
    // Los dos tramos ya están en orden canónico: si la vuelta queda entera por delante, el `sort` de la
    // ventana los dejaría así; con ids repetidos entre ambos, lo decide el `sort`.
    const tramo = animals.slice(offset, offset + MAX_ACTIVE_ANIMALS), vuelta = animals.slice(0, Math.max(0, offset + MAX_ACTIVE_ANIMALS - population));
    selected = !vuelta.length ? tramo : vuelta[vuelta.length - 1]!.id < tramo[0]!.id ? [...vuelta, ...tramo] : [...tramo, ...vuelta].sort(canonical);
  }
  return selected;
}
/** Los animales de una región que la máscara selecciona, en orden canónico. */
export function seleccionDe(mascara: MascaraFauna, animales: readonly Animal[]): Animal[] {
  return animales.filter(a => mascara.ids.has(a.id)).sort(canonical);
}

/** Active cells only; canonical decisions and flee-before-contact movement make array order irrelevant.
 * `mascara` es la del coordinador para este paso; sin ella se calcula aquí, con el mismo resultado. */
export function stepAnimals(world: AnimalWorld, emit?: AnimalEmitter, mascara?: MascaraFauna): void {
  if (world.animals.length > limitsOf(world).fauna) throw new Error('Capacidad regional de fauna excedida.');
  const state: LocalState = { tile: tileLookup(world.tiles), occupants: new Map(), counts: new Map(),
    reader: undefined, visible: [], pool: [], resources: [], adjacent: [], neighbors: [], steps: [], seen: new Int32Array(SEEN_SIDE * SEEN_SIDE), stamp: 0 };
  if (mascara && (mascara.tick !== world.tick || mascara.animales !== world.animals || mascara.poblacion !== world.animals.length || !mismosObjetos(world.animals, mascara.orden)))
    throw new Error('Máscara de fauna de otro paso.');
  const seleccion = mascara?.seleccion ?? calcularMascara(world);
  // Con toda la fauna seleccionada (≤ MAX_ACTIVE_ANIMALS) todos piensan: no hace falta preguntar por id.
  const todos = seleccion.length === world.animals.length;
  const piensan = todos ? null : mascara?.ids ?? new Set(seleccion.map(a => a.id));
  // Vista residente validada (o ninguna) para todo el paso: la fauna no cambia la topología ni el SoA.
  const reader = state.reader = residentTileReader(world.tiles);
  for (const animal of world.animals) {
    const tile = state.tile(animal.x, animal.y);
    if (!tile) throw new Error('Animal fuera de las regiones activas.');
    if (!piensan || piensan.has(animal.id)) physiology(animal, desertIn(tile, reader, reader ? reader.cellAt(animal.x, animal.y) : -1), world, emit);
    if (animal.health <= 0) continue;
    const p = cell(animal), here = state.occupants.get(p);
    if (here) here.push(animal); else state.occupants.set(p, [animal]);
  }
  for (const [p, here] of state.occupants) state.counts.set(p, here.length);
  world.animals = world.animals.filter(a => a.health > 0);
  const active = seleccion.filter(a => a.health > 0);
  // Oldest decision first avoids starvation while preventing a synchronized migration from bursting every eighth tick.
  const due = active.filter(a => world.tick - a.lastDecision >= 8)
    .sort((a, b) => a.lastDecision - b.lastDecision || canonical(a, b)).slice(0, MAX_ANIMAL_DECISIONS_PER_TICK);
  // Después de la fisiología y sus emisiones: choose no escribe terreno ni llama código externo.
  const motor = paramsOf(world).motor, parallel = motor.hilos > 1 && due.length >= 384;
  if (parallel) applyFaunaChooseOutputs(due, world, stepChooseParallel(world, due, state, motor.hilos, motor.orden));
  else for (const animal of due) choose(animal, world, state);
  // Cadena secuencial (ver `move`): permanece en la fase serial del coordinador. `active` ya está
  // en orden canónico (la selección de la máscara), así que dos pasadas (`flee` primero) son idénticas al `sort`.
  for (const animal of active) if (animal.action === 'flee') move(animal, world, state);
  for (const animal of active) if (animal.action !== 'flee') move(animal, world, state);
  let byId: Map<string, Animal> | undefined;
  for (const animal of active) {
    if (animal.health <= 0) continue;
    const tile = state.tile(animal.x, animal.y)!;
    feed(animal, tile, world);
    if (animal.action !== 'hunt' || !animal.preyId) continue;
    if (!byId) {
      byId = new Map();
      for (const a of world.animals) byId.set(a.id, a);
    }
    const prey = byId.get(animal.preyId);
    // A resident prey is physically reachable even when its own routine is deferred; archived animals are absent from byId.
    if (!prey || prey.health <= 0 || !edible(animal, prey) || distance(animal, prey) > 0) { animal.work = 0; continue; }
    animal.work++; exertBody(animal, { energy: 0.0008, fatigue: 0.001 });
    if (animal.work < 4) continue;
    animal.work = 0; prey.health = clamp(prey.health - (0.18 + animal.genes.speed * 0.08 - prey.genes.camouflage * 0.05));
    if (prey.health > 0) continue;
    death(world, prey, 'depredación', emit, animal.id); world.animalDynamics.predations++;
    state.counts.set(cell(prey), state.counts.get(cell(prey))! - 1);
    assimilateFood(animal, FOOD_PER_ANIMAL[prey.species], { hungerPerUnit: 4.8, assimilation: animal.genes.carnivory, energyPerUnit: 0.5 });
    animal.lastDecision = world.tick - 12;
  }
  // Filtrar conserva el orden de la máscara: sólo las crías, al final, pueden estar fuera de sitio.
  world.animals = world.animals.filter(a => a.health > 0);
  const previos = world.animals.length;
  reproduce(world, state, active, emit); ordenCanonico(world.animals, previos); invalidarRejillaFauna(world); syncFauna(world.tiles, world.animals);
}

/** A human hunt removes exactly one living identity on the requested cell, at most once. */
export function harvestAt(world: AnimalWorld, point: Point, hunterId: string, emit?: AnimalEmitter): number {
  refrescarAmbitoFauna(world);
  const enCelda = animalesVivosEnCelda(world, point.x, point.y);
  const victim = enCelda ? enCelda.sort(canonical)[0]
    : world.animals.filter(a => a.x === point.x && a.y === point.y && a.health > 0).sort(canonical)[0];
  if (!victim || !world.tiles.some(t => t.x === point.x && t.y === point.y)) return 0;
  death(world, victim, 'caza humana', emit, hunterId); world.animalDynamics.humanHunts++;
  world.animals = world.animals.filter(a => a.id !== victim.id); refrescarAmbitoFauna(world); syncFauna(world.tiles, world.animals);
  return FOOD_PER_ANIMAL[victim.species];
}

export function projectAnimal(animal: Animal, _tick: number): AnimalView {
  return { id: animal.id, species: animal.species, x: animal.x, y: animal.y, action: animal.action, reason: animal.reason,
    hunger: animal.hunger, thirst: animal.thirst, energy: animal.energy, fatigue: animal.fatigue, health: animal.health,
    generation: animal.generation, parents: [...animal.parents], genes: { ...animal.genes }, age: animal.age };
}
export function assertAnimal(value: unknown, tick: number): asserts value is Animal {
  const fail = (): never => { throw new Error('Animal individual inválido.'); };
  if (!value || typeof value !== 'object') fail();
  const a = value as Animal, time = (n: number, lower = 0): boolean => Number.isSafeInteger(n) && n >= lower && n <= tick;
  if (typeof a.id !== 'string' || !/^animal-[a-zA-Z0-9-]{1,110}$/.test(a.id) || !SPECIES.includes(a.species) || !ACTIONS.includes(a.action)
    || !point(a) || !point(a.target) || typeof a.reason !== 'string' || a.reason.length > 240
    || !['hunger', 'thirst', 'energy', 'fatigue', 'health'].every(k => unit(a[k as keyof Animal])) || a.health <= 0
    || !Number.isSafeInteger(a.generation) || a.generation < 0 || a.generation > 1e6 || !Array.isArray(a.parents)
    || !(a.generation === 0 ? a.parents.length === 0 : a.parents.length === 2) || new Set(a.parents).size !== a.parents.length
    || a.parents.some(id => typeof id !== 'string' || !/^animal-[a-zA-Z0-9-]{1,110}$/.test(id) || id === a.id)
    || !a.genes || Object.keys(a.genes).length !== 6 || !['speed','perception','metabolism','carnivory','waterEfficiency','camouflage'].every(k => unit(a.genes[k as keyof AnimalGenes]))
    || !time(a.bornAt, -MATURITY) || !time(a.lastBirth, a.bornAt) || !time(a.lastDecision, Math.max(-12, a.bornAt)) || !time(a.lastMove, Math.max(-12, a.bornAt))
    || !Number.isSafeInteger(a.age) || a.age < 0 || a.age > tick - a.bornAt || !Number.isSafeInteger(a.lastBirthAge) || a.lastBirthAge < 0 || a.lastBirthAge > a.age
    || !Number.isSafeInteger(a.work) || a.work < 0 || a.work > 4
    || !(a.preyId === null || typeof a.preyId === 'string' && /^animal-[a-zA-Z0-9-]{1,110}$/.test(a.preyId) && a.preyId !== a.id)
    || !Array.isArray(a.memory) || a.memory.length > MAX_ANIMAL_MEMORY) fail();
  const seen = new Set<string>();
  for (const memory of a.memory) {
    if (!point(memory) || !time(memory.tick) || !unit(memory.food) || !unit(memory.water) || typeof memory.visited !== 'boolean' || seen.has(key(memory))) fail();
    seen.add(key(memory));
  }
}
export function assertAnimals(value: unknown, tick: number, tiles?: Tile[], maxAnimals = LEGACY_WORLD_LIMITS.fauna): asserts value is Animal[] {
  if (!Number.isSafeInteger(maxAnimals) || maxAnimals < 1 || !Array.isArray(value) || value.length > maxAnimals) throw new Error('Colección de fauna inválida.');
  const ids = new Set<string>(), counts = new Map<string, number>(), positions = tiles && new Map(tiles.map(t => [key(t), t]));
  for (const animal of value) {
    assertAnimal(animal, tick);
    const p = key(animal), count = (counts.get(p) ?? 0) + 1;
    if (ids.has(animal.id) || count > MAX_ANIMALS_PER_TILE || positions && !positions.has(p)) throw new Error('Identidad, región o capacidad animal inválida.');
    ids.add(animal.id); counts.set(p, count);
  }
}
