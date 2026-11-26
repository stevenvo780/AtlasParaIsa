import type { AnimalAction, AnimalDynamics, AnimalGenes, AnimalMorphology, AnimalSpecies, AnimalView } from '../shared/life.js';
import type { ChronicleEvent, Tile } from '../shared/types.js';
import { FOOD_PER_ANIMAL } from './ecosystem.js';
import { SED_POR_UNIDAD } from './ecologia-constantes.js';
import { advanceNeeds } from './needs.js';
import { assimilateFood, exertBody, hydrateBody, restBody } from './body.js';
import { MAX_COORDINATE } from './terrain.js';
import { ley, paramsOf } from './params.js';
import { ctxMateriaDe, ctxSi, type CtxLeyMateria } from './motor/acceso.js';
import { extraerEscalar } from './materia/ley-mundo.js';
import { matarAnimal } from './ley-fauna.js';
import { tileLookup, verifiedChunkBlocks } from './tile-index.js';
import { residentFaunaCapacity, residentFastAccess, residentTileReader, type ResidentFastAccess, type ResidentTileReader } from './soa/terreno.js';
import { residentBackingArray, residentInPlaceRevision } from './soa/topologia.js';
import { decidirFauna, habitableParaPlan, planFauna, presaDe, type PercepcionFauna, type PlanFauna, type VisibleTile } from './decision/fauna.js';
import { primero } from './orden.js';
import { faunaDe, faunaRegistrada, organismosDe } from './soa/organismos-mundo.js';
import { registrar } from './registro-invariantes.js';
import { assertAnimalTraits } from './validation.js';

// Los importadores del perfil de hardware y del soak aún usan las cifras históricas.
export const MAX_ACTIVE_ANIMALS = 8192;
export const MAX_ANIMAL_MEMORY = 12;
export const MEMORY_TTL = 480;
const MATURITY = 600;
/** V19/R: biomasa que cada progenitor aporta a la cría (0,03 + 0,03 = los 0,06 de la biomasa natal histórica). */
export const RESERVA_POR_PROGENITOR = 0.03;
/** V19/R: cota de la reserva de un animal; permite cuatro aportes y es lo que `assertAnimal` valida. */
export const RESERVA_MAXIMA = 0.12;
export const RAZON_PAREJA = 'Está listo para criar y se acerca, pagando cada paso, a una pareja compatible que percibe.';
/** V19/M y V19/R: puertas corporales de la cría SIN la acción (`flee`), que `choose` no debe leer de otro animal
 * porque otra decisión del mismo paso puede haberla escrito. Con `reserva`, además la reserva alcanza su aporte. */
export function listoParaCriar(a: Animal, reserva: boolean): boolean {
  return a.age >= MATURITY && a.age - a.lastBirthAge >= MATURITY && a.health > 0.75 && a.energy > 0.65
    && a.hunger < 0.4 && a.thirst < 0.4 && (!reserva || (a.reproReserve ?? 0) >= RESERVA_POR_PROGENITOR);
}
/** V19/M: todas las puertas de `listoParaCriar` salvo la energía, que todavía no supera 0,65. Un animal así ya pagó
 * la madurez, la recuperación de la última cría, la salud, la saciedad, la hidratación y (con R) la reserva: lo único
 * que le falta es recuperar fuerzas, y eso sólo lo da el descanso real (`restBody`), que cuesta tiempo con hambre y sed. */
export function listoSalvoEnergia(a: Animal, reserva: boolean): boolean {
  return a.age >= MATURITY && a.age - a.lastBirthAge >= MATURITY && a.health > 0.75 && !(a.energy > 0.65)
    && a.hunger < 0.4 && a.thirst < 0.4 && (!reserva || (a.reproReserve ?? 0) >= RESERVA_POR_PROGENITOR);
}
/** V19/M: alcance (Manhattan, en celdas) del olor o la llamada con que un animal listo detecta a una pareja lista de
 * su especie más allá de su vista. */
export const RADIO_PAREJA = 12;
export const RAZON_REPOSO_CRIA = 'Saciado y listo para criar salvo por las fuerzas; descansa para recuperarlas, sin dejar de tener hambre y sed.';
export const SPECIES: readonly AnimalSpecies[] = ['hare', 'deer', 'boar', 'fish', 'wolf', 'fox'];
const especieHeredada = (valor: unknown): valor is AnimalSpecies => typeof valor === 'string' && Object.hasOwn(FOOD_PER_ANIMAL, valor);
/** La vista de teselas y los sprites conservan la paleta histórica; el guardado retiene el nombre original. */
export const especieVisual = (valor: string): AnimalSpecies => especieHeredada(valor) ? valor : 'hare';
/** Orden de las acciones de la fauna: su índice es la columna `accion` del frente. */
export const ACTIONS: readonly AnimalAction[] = ['roam', 'graze', 'drink', 'rest', 'hunt', 'flee'];
const LIFESPAN: Record<AnimalSpecies, number> = { hare: 18000, deer: 36000, boar: 30000, fish: 20000, wolf: 32000, fox: 26000 };
const clamp = (n: number): number => Math.max(0, Math.min(1, n));
interface Point { x: number; y: number; }
export interface AnimalMemory extends Point { tick: number; food: number; water: number; visited: boolean; }
export interface Animal extends Omit<AnimalView, 'species'> {
  species: string;
  bornAt: number; lastBirth: number; lastBirthAge: number; lastDecision: number; lastMove: number;
  target: Point; memory: AnimalMemory[]; work: number; preyId: string | null;
  /** V19/R (`fauna.reservaReproductiva`): biomasa de la dieta apartada para la cría, en [0, `RESERVA_MAXIMA`]. Ausente = 0. */
  reproReserve?: number;
  /** V23: persistent biological costs/cooldowns; absent in historical worlds. */
  lastTended?: number;
  lastHunted?: number;
  /** V23: identidad durable en la tabla de organismos (`World.siguienteUid`); ninguna ley la lee. */
  uid?: number;
  /** V23 (`v23.fauna`): cuerpo de átomos; se pone al crear el animal con la ley encendida, nunca después. */
  cuerpo?: import('./materia/tipos.js').Cuerpo;
  /** V23 (`v23.fauna`): genes continuos y estado de conducta sin especies (`ley-fauna.ts`); como `cuerpo`. */
  fauna?: EstadoFauna;
}
/** Estado de un animal bajo `v23.fauna`. Uids del frente; 0 = nadie. */
export interface EstadoFauna {
  /** Genes continuos (`decision/fauna.ts`, `GEN`): los suyos, sorteados al concebir o heredados del fundador. */
  genoma: number[];
  habituacion: number;
  /** Último miedo calculado (lo lee quien quiere extraerle algo: lo consiente si es menor que su reserva relativa). */
  miedo: number;
  /** Sobresalto de golpes y extracciones: S₀ en el tick `sobresaltoDesde`, decae como la alarma. */
  sobresalto: number; sobresaltoDesde: number;
  /** Celdas de movimiento acumuladas y aún no andadas (la velocidad es fraccionaria). */
  avance: number;
  persigue: number; huyeDe: number; pareja: number;
  heridoPor: number; heridoEn: number;
  extraido: { que: 'reserva' | 'fibra'; tick: number; por: number } | null;
}
export interface AnimalWorld {
  seed: number; tick: number; tiles: Tile[]; animals: Animal[]; animalCounter: number;
  animalDynamics: AnimalDynamics; reproductionEnabled?: boolean; siguienteUid?: number;
  people?: readonly Point[];
  structures?: readonly (Point & { condition: number; components: readonly string[] })[];
  weather?: 'clear' | 'rain';
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

export function hash(seed: number, text: string): number {
  return hashCerrar(hashParcial(seed >>> 0, text));
}
/** El estado del hash tras recorrer `text` desde `n` (`seed >>> 0` al empezar): un prefijo común se recorre una vez. */
export function hashParcial(n: number, text: string): number {
  for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619);
  return n;
}
export function hashCerrar(n: number): number {
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

const MORPH_FIELDS = ['caution', 'size', 'coat', 'defense'] as const;
const MORPH_BASE: Record<AnimalSpecies, AnimalMorphology> = {
  deer: { caution: 0.62, size: 0.5, coat: 0.45, defense: 0.4 },
  boar: { caution: 0.5, size: 0.62, coat: 0.4, defense: 0.55 },
  hare: { caution: 0.57, size: 0.3, coat: 0.5, defense: 0.15 },
  wolf: { caution: 0.68, size: 0.6, coat: 0.6, defense: 0.65 },
  fox: { caution: 0.58, size: 0.35, coat: 0.55, defense: 0.3 },
  fish: { caution: 0.5, size: 0.3, coat: 0.1, defense: 0.2 },
};
function ensureMorphology(animal: Animal, seed: number): AnimalMorphology {
  if (!animal.morphology) {
    const base = MORPH_BASE[especieVisual(animal.species)];
    animal.morphology = { ...base };
    for (const field of MORPH_FIELDS) animal.morphology[field] = Math.max(0.05, Math.min(0.95,
      base[field] + (hash(seed, `${animal.id}:morph:${field}`) / 4294967296 - 0.5) * 0.18));
  }
  return animal.morphology;
}
export const isHerdAnimal = (animal: Animal): boolean => animal.species === 'deer' || animal.species === 'boar' || animal.species === 'hare';
export const animalBiomass = (animal: Animal): number => FOOD_PER_ANIMAL[especieVisual(animal.species)] * (0.75 + (animal.morphology?.size ?? 0.5) * 0.65);

/** V23 serial physical overlay, after the fauna decision. All sensing is local
 * (Manhattan ≤ 6); no person/structure data enters the fauna Plan.
 * Las personas y los hogares se agrupan una vez por paso en bloques de 16 × 16 celdas. Solo cuentan los puntos de
 * coordenadas enteras: son los únicos cuya celda puede coincidir con la de un animal. */
const BLOQUE = 16, BLOQUE_DESPLAZAMIENTO = 2 ** 20, BLOQUE_LADO = 2 ** 21;
const bloqueXY = (bx: number, by: number): number => (bx + BLOQUE_DESPLAZAMIENTO) * BLOQUE_LADO + (by + BLOQUE_DESPLAZAMIENTO);
function settlementBuckets(points: readonly Point[]): Map<number, Point[]> {
  const result = new Map<number, Point[]>();
  for (const p of points) {
    if (!Number.isInteger(p.x) || !Number.isInteger(p.y)) continue;
    const k = bloqueXY(Math.floor(p.x / BLOQUE), Math.floor(p.y / BLOQUE)), here = result.get(k);
    if (here) here.push(p); else result.set(k, [p]);
  }
  return result;
}
/** Los puntos agrupados a distancia de Manhattan ≤ `radio` de (x, y), en cualquier orden: quien los usa solo toma
 * la mínima distancia o si hay alguno. */
function puntosCerca(bloques: Map<number, Point[]>, x: number, y: number, radio: number, fuera: Point[]): void {
  if (!bloques.size) return;
  const bx1 = Math.floor((x + radio) / BLOQUE), by0 = Math.floor((y - radio) / BLOQUE), by1 = Math.floor((y + radio) / BLOQUE);
  for (let bx = Math.floor((x - radio) / BLOQUE); bx <= bx1; bx++) for (let by = by0; by <= by1; by++) {
    const aqui = bloques.get(bloqueXY(bx, by));
    if (aqui) for (const p of aqui) if (Math.abs(p.x - x) + Math.abs(p.y - y) <= radio) fuera.push(p);
  }
}
/** Distancia de (x, y) a la amenaza más cercana. */
function safetyAt(threats: readonly Point[], x: number, y: number): number {
  let d = Infinity;
  for (const t of threats) d = Math.min(d, Math.abs(x - t.x) + Math.abs(y - t.y));
  return d;
}
function settlementOverlay(animal: Animal, tick: number, state: LocalState, humans: Map<number, Point[]>, hearths: Map<number, Point[]>): void {
  // Un pez no tiene amenazas de poblado ni habituación: nada de lo que se percibe aquí le cambia.
  if (animal.species === 'fish') return;
  const m = animal.morphology!, threats = state.amenazas, cerca = state.cerca, celdas = state.celdas;
  const predator = animal.species === 'wolf' || animal.species === 'fox';
  const alarm = animal.lastHunted !== undefined && tick - animal.lastHunted < 120;
  const fleeRadius = Math.max(alarm ? 3 : 0, 1 + m.caution * (1 - (animal.habituation ?? 0) * 0.78) * 5);
  threats.length = 0;
  if (predator) {
    // El fuego y el refugio humano a ≤ 3 celdas.
    cerca.length = 0;
    puntosCerca(hearths, animal.x, animal.y, 3, cerca);
    for (const p of cerca) threats.push(p);
    const ax = animal.x, ay = animal.y, fila = state.fila;
    for (let dy = -3; dy <= 3; dy++) {
      const span = 3 - Math.abs(dy), y = ay + dy;
      celdas.fila(ax - span, ax + span, y, state, fila);
      for (let dx = -span; dx <= span; dx++) {
        const x = ax + dx, i = fila[dx + span]!;
        if (celdas.poblado(i < 0 ? celdas.indice(x, y, state) : i, x, y, state) & REFUGIO_TESELA) threats.push({ x, y });
      }
    }
  } else {
    // Herbívoros de manada: las personas a ≤ min(6, radio de huida) son amenaza; el poblado a ≤ 5 celdas (personas,
    // refugio o cultivo) solo cuenta para habituarse, y solo se busca cuando puede habituarse.
    cerca.length = 0;
    puntosCerca(humans, animal.x, animal.y, 6, cerca);
    let nearSettlement = false;
    for (const p of cerca) {
      const d = Math.abs(p.x - animal.x) + Math.abs(p.y - animal.y);
      if (d <= 5) nearSettlement = true;
      if (d <= fleeRadius) threats.push(p);
    }
    const puedeHabituarse = !alarm && m.caution < 0.65;
    if (puedeHabituarse && !nearSettlement) {
      const ax = animal.x, ay = animal.y, fila = state.fila;
      busca: for (let dy = -5; dy <= 5; dy++) {
        const span = 5 - Math.abs(dy), y = ay + dy;
        celdas.fila(ax - span, ax + span, y, state, fila);
        for (let dx = -span; dx <= span; dx++) {
          const x = ax + dx, i = fila[dx + span]!;
          if (celdas.poblado(i < 0 ? celdas.indice(x, y, state) : i, x, y, state) & POBLADO) { nearSettlement = true; break busca; }
        }
      }
    }
    animal.habituation = clamp((animal.habituation ?? 0) + (nearSettlement && puedeHabituarse ? 0.012 : -0.003));
  }
  if (!threats.length) return;
  let best = animal as Point, bestSafety = safetyAt(threats, best.x, best.y);
  for (const [dx, dy] of BREEDING_CELLS) {
    const x = animal.x + dx, y = animal.y + dy, tile = state.tile(x, y);
    if (!tile || !habitat(animal, tile)) continue;
    const safe = safetyAt(threats, x, y);
    if (safe > bestSafety) { best = { x, y }; bestSafety = safe; }
  }
  animal.action = 'flee'; animal.target = { x: best.x, y: best.y }; animal.preyId = null; animal.work = 0;
  animal.reason = predator ? 'Evita el fuego y el refugio humano.' : 'Su cautela y habituación regulan la distancia a las personas.';
}

/** Exactly one identity per saved stock unit. Neither traversal order nor the world's weather RNG is consumed. */
export function materializeAnimals(seed: number, tiles: Tile[], tick: number, faunaV23 = false): Animal[] {
  const animals: Animal[] = [];
  const positions = new Set<string>();
  const raw = residentBackingArray(tiles);
  for (let i = 0; i < raw.length; i++) {
    const tile = raw[i]!;
    if (positions.has(key(tile))) throw new Error('Coordenadas de fauna duplicadas.');
    positions.add(key(tile));
    const population = tile.fauna ?? 0;
    if (!Number.isSafeInteger(population) || population < 0
      || population > 0 && !SPECIES.includes(tile.species!)) throw new Error('Existencias de fauna inválidas.');
    for (let n = 0; n < population; n++) {
      const id = `animal-${seed >>> 0}-${tile.x}-${tile.y}-${n}`;
      animals.push({ id, species: tile.species!, x: tile.x, y: tile.y, action: 'roam', reason: 'Explora su hábitat con percepción local.',
        hunger: 0.24 + (hash(seed, `${id}:hunger`) % 18) / 100, thirst: 0.2, energy: 0.8, fatigue: 0.12, health: 1,
        generation: 0, parents: [], genes: genes(seed, id, tile.species!), age: MATURITY, bornAt: tick - MATURITY,
        lastBirth: tick - MATURITY, lastBirthAge: 0, lastDecision: tick - 12, lastMove: tick - 12,
        target: { x: tile.x, y: tile.y }, memory: [], work: 0, preyId: null,
        ...(faunaV23 ? { cuerpo: undefined, fauna: undefined, uid: undefined, morphology: undefined, habituation: undefined,
          tends: undefined, lastTended: undefined, lastHunted: undefined } : {}) });
    }
  }
  animals.sort(canonical);
  assertAnimals(animals, tick, tiles);
  return animals;
}

/** Celdas con fauna en la llamada anterior, con sus coordenadas: la tesela se busca en el índice
 * compartido (tile-index.ts), el mismo «última tesela con esas coordenadas» que el `Map` propio que se
 * construía aquí cada vez que cambiaba el arreglo de teselas. */
interface FaunaCache { length: number; inPlaceRev: object | undefined; occupied: Map<Cell, Point>; }
const faunaCaches = new WeakMap<Tile[], FaunaCache>();
let faunaFullScans = 0;
/** Diagnóstico (pruebas y perfiles): barridos completos de `tiles` realizados por `syncFauna`. */
export const faunaCacheBuilds = (): number => faunaFullScans;
const CHUNK_GRID_LIMIT = 2 ** 24, CHUNK_BLOCK_OFFSET = 2 ** 20, CHUNK_BLOCK_SPAN = 2 ** 21;

/** Mantenimiento incremental de la caché de `syncFauna` tras `tiles.push(...)` (p. ej. `activateChunk`).
 * Registra solo las teselas nuevas `[from..length)` con `fauna` truthy (mismo criterio y orden que el
 * barrido completo), evitando reescanear 440k teselas al activar un chunk. */
export function faunaCacheAppended(tiles: Tile[], from: number): void {
  const cache = faunaCaches.get(tiles);
  if (!cache || cache.length !== from) return;
  const inPlaceRev = residentInPlaceRevision(tiles);
  if (cache.inPlaceRev !== inPlaceRev) {
    faunaCaches.delete(tiles);
    return;
  }
  const raw = residentBackingArray(tiles);
  if (raw.length < from) {
    faunaCaches.delete(tiles);
    return;
  }
  const occupied = cache.occupied;
  for (let i = from; i < raw.length; i++) {
    const t = raw[i];
    if (t && t.fauna) {
      const p = cell(t);
      if (!occupied.has(p)) occupied.set(p, t);
    }
  }
  cache.length = raw.length;
}

/** Mantenimiento incremental de la caché de `syncFauna` tras retirar chunks (`retireActiveChunks`).
 * Si `prevTiles` tiene caché vigente y ambos arreglos comparten disposición verificada por chunks
 * (proveniencia de `blockIds` confirmada en O(chunks)), migra solo las entradas ocupadas (~7,5k)
 * en vez de reescanear todas las teselas activas (~440k). Fail-closed ante cualquier anomalía. */
export function faunaCacheFiltered(prevTiles: Tile[], nextTiles: Tile[]): void {
  if (prevTiles === nextTiles) return;
  const prev = faunaCaches.get(prevTiles);
  if (!prev) return;
  const prevRaw = residentBackingArray(prevTiles);
  if (prev.length !== prevRaw.length || prev.inPlaceRev !== residentInPlaceRevision(prevTiles)) return;
  const nextRaw = residentBackingArray(nextTiles);
  if (nextRaw.length > prevRaw.length) return;
  const prevBlocks = verifiedChunkBlocks(prevTiles), nextBlocks = verifiedChunkBlocks(nextTiles);
  if (!prevBlocks || !nextBlocks) return;
  for (const [key, id] of nextBlocks.blockIds) {
    if (prevBlocks.blockIds.get(key) !== id) return;
  }
  const occupied = new Map<Cell, Point>();
  if (nextBlocks.bases.size > 0) {
    const bases = nextBlocks.bases;
    let k1 = -1, b1 = -1, k2 = -1, b2 = -1, k3 = -1, b3 = -1, k4 = -1, b4 = -1;
    for (const [p, at] of prev.occupied) {
      const x = at.x, y = at.y;
      if (x !== (x | 0) || y !== (y | 0) || x < -CHUNK_GRID_LIMIT || x >= CHUNK_GRID_LIMIT
        || y < -CHUNK_GRID_LIMIT || y >= CHUNK_GRID_LIMIT) continue;
      const key = ((x >> 4) + CHUNK_BLOCK_OFFSET) * CHUNK_BLOCK_SPAN + ((y >> 4) + CHUNK_BLOCK_OFFSET);
      let base: number;
      if (key === k1) base = b1;
      else if (key === k2) base = b2;
      else if (key === k3) base = b3;
      else if (key === k4) base = b4;
      else {
        base = bases.get(key) ?? -1;
        k4 = k3; b4 = b3; k3 = k2; b3 = b2; k2 = k1; b2 = b1; k1 = key; b1 = base;
      }
      if (base < 0) continue;
      const tile = nextRaw[base + (((y & 15) << 4) | (x & 15))];
      if (tile && tile.fauna) occupied.set(p, tile);
    }
  }
  faunaCaches.set(nextTiles, {
    length: nextRaw.length,
    inPlaceRev: residentInPlaceRevision(nextTiles),
    occupied,
  });
}

/** Compatibility projection only. Mixed-species totals must be counted from identities, not this representative species.
 * P2: only tiles with fauna the previous call or this one are written; a cache keyed on the tiles array remembers which
 * (rebuilt, reading ground-truth `fauna`, whenever that array is replaced or grows — same trigger as the terrain index).
 * The optional observer is called once for each tile whose count or representative species changed. */
export function syncFauna(tiles: Tile[], animals: Animal[], alCambiar?: (x: number, y: number) => void): void {
  const counts = new Map<Cell, { count: number; species: AnimalSpecies; x: number; y: number }>();
  for (const animal of animals) {
    const p = cell(animal);
    const species = especieVisual(animal.species), entry = counts.get(p);
    if (entry) { entry.count++; if (species < entry.species) entry.species = species; }
    else counts.set(p, { count: 1, species, x: animal.x, y: animal.y });
  }
  const raw = residentBackingArray(tiles);
  const inPlaceRev = residentInPlaceRevision(tiles);
  let cache = faunaCaches.get(tiles);
  if (!cache || cache.length !== raw.length || cache.inPlaceRev !== inPlaceRev) {
    faunaFullScans++;
    const occupied = new Map<Cell, Point>();
    for (let i = 0; i < raw.length; i++) {
      const t = raw[i]!;
      if (t.fauna) {
        const p = cell(t);
        if (!occupied.has(p)) occupied.set(p, t);
      }
    }
    cache = { length: raw.length, inPlaceRev, occupied };
    faunaCaches.set(tiles, cache);
  }
  const tileIn = tileLookup(tiles);
  let missing = false;
  const write = (at: Point, count: { count: number; species: AnimalSpecies } | undefined): void => {
    const tile = tileIn(at.x, at.y);
    if (!tile) { if (count) missing = true; return; }
    const nextFauna = count?.count ?? 0;
    const cambiaFauna = !Object.is(tile.fauna, nextFauna);
    if (cambiaFauna) tile.fauna = nextFauna;
    const nextSpecies = count?.species;
    const cambiaEspecie = tile.species !== nextSpecies;
    if (cambiaEspecie) tile.species = nextSpecies;
    if (cambiaFauna || cambiaEspecie) alCambiar?.(at.x, at.y);
  };
  // Cada celda una sola vez: primero las ocupadas antes y luego las nuevas, el orden del antiguo
  // `new Set([...occupied, ...counts.keys()])` (cada celda escribe una tesela distinta).
  const before = cache.occupied;
  for (const [p, at] of before) write(at, counts.get(p));
  for (const [p, entry] of counts) if (!before.has(p)) write(entry, entry);
  if (missing) {
    for (const [p, entry] of counts) if (!tileIn(entry.x, entry.y)) counts.delete(p);
  }
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
interface AmbitoFauna { profundidad: number; arreglo: Animal[]; indice?: IndiceFauna; publicar?: boolean }
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
/** Descarta el índice al cerrar la fauna del paso: el orden canónico puede haber reordenado el
 * mismo arreglo en el sitio, y eso no lo delata ningún cambio de identidad ni de longitud. */
function invalidarRejillaFauna(world: AnimalWorld): void {
  const ambito = ambitosFauna.get(world);
  if (ambito) { ambito.arreglo = world.animals; ambito.indice = undefined; }
}
export function conRejillaFauna<R>(world: AnimalWorld, fn: () => R): R {
  let ambito = ambitosFauna.get(world);
  if (!ambito) { ambito = { profundidad: 0, arreglo: world.animals }; ambitosFauna.set(world, ambito); }
  ambito.profundidad++;
  try {
    const resultado = fn();
    if (ambito.profundidad === 1 && ambito.publicar) publicarFrenteFauna(world);
    return resultado;
  } finally {
    ambito.profundidad--;
    if (ambito.profundidad === 0) ambitosFauna.delete(world);
  }
}
interface ActividadFauna { readonly tick: number; readonly vivos: number; readonly decisiones: number }
const actividadFauna = new WeakMap<AnimalWorld, ActividadFauna>();
/** Vivos tras la fisiología y cuántos de ellos decidieron en el tick, contados por su `lastDecision`, no por
 * vueltas del bucle: así un filtro o una salida temprana en la decisión se ven. */
export const decisionesFauna = (world: AnimalWorld): ActividadFauna | undefined => actividadFauna.get(world);
const decididosEn = (animales: readonly Animal[], tick: number): number => {
  let n = 0;
  for (const a of animales) if (a.lastDecision === tick) n++;
  return n;
};
let frenteRegistrado = false;
function publicarFrenteFauna(world: AnimalWorld): void {
  const organismos = organismosDe(world);
  organismos.fauna.sincronizar(world.animals);
  const terreno = residentTileReader(world.tiles);
  const reserva = paramsOf(world).fauna.reservaReproductiva;
  organismos.publicar(world.tick, { celda: terreno?.cellAt.bind(terreno), chunkDe: celda => celda >> 8,
    fertil: animal => animal.action !== 'flee' && listoParaCriar(animal, reserva) });
  if (!frenteRegistrado) {
    registrar({ id: 'motor-frente', carril: 'M2a', gravedad: 'dura', cadaTicks: 60, alcance: 'global', comprobar(mundo) {
      faunaRegistrada(mundo)?.tabla.verificarFrente();
      return [];
    } });
    registrar({ id: 'fauna.decisiones', carril: 'M2a', gravedad: 'dura', cadaTicks: 1, alcance: 'global', comprobar(mundo) {
      const actividad = decisionesFauna(mundo);
      if (!actividad || actividad.tick !== mundo.tick) return [];
      // Al cerrar el tick, también las crías (nacen con su decisión hecha) y los que siguen vivos tras la caza.
      const decididos = decididosEn(mundo.animals, mundo.tick);
      if (actividad.vivos === actividad.decisiones && decididos === mundo.animals.length) return [];
      return [{ id: 'fauna.decisiones', gravedad: 'dura', tick: mundo.tick, detalle: 'Cada animal vivo debe decidir una vez en el tick.',
        esperado: mundo.animals.length, observado: decididos, contexto: { vivosTrasFisiologia: actividad.vivos, decidieron: actividad.decisiones } }];
    } });
    frenteRegistrado = true;
  }
}
function solicitarFrenteFauna(world: AnimalWorld): void {
  const ambito = ambitosFauna.get(world);
  if (ambito) ambito.publicar = true;
  else publicarFrenteFauna(world);
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
  return animal.genes.carnivory >= 0.6 && presaDe(animal.species, prey.species);
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
function livable(animal: Animal, tile: Tile, reader: ResidentTileReader | undefined, fast: ResidentFastAccess | undefined, at: number): boolean {
  const cell = reader ? at : fast?.cellOf(tile) ?? -1;
  if (cell < 0) return habitat(animal, tile);
  const terrain = reader ? reader.terrainCode(cell) : fast!.terrainCode(cell);
  const water = reader?.TERRAIN_WATER ?? fast!.TERRAIN_WATER, shelter = reader?.TERRAIN_SHELTER ?? fast!.TERRAIN_SHELTER;
  return animal.species === 'fish' ? terrain === water : terrain !== water && terrain !== shelter;
}
function desertIn(tile: Tile, reader: ResidentTileReader | undefined, fast: ResidentFastAccess | undefined, at: number): boolean {
  const cell = reader ? at : fast?.cellOf(tile) ?? -1;
  return cell < 0 ? tile.biome === 'desert' : (reader ? reader.biomeCode(cell) : fast!.biomeCode(cell)) === (reader?.BIOME_DESERT ?? fast!.BIOME_DESERT);
}
function plantIn(tile: Tile, reader: ResidentTileReader | undefined, fast: ResidentFastAccess | undefined, at: number): number {
  const cell = reader ? at : fast?.cellOf(tile) ?? -1;
  return cell < 0 ? tile.growth ?? tile.vegetation : (reader ? reader.growth(cell) ?? reader.vegetation(cell)! : fast!.growth(cell) ?? fast!.vegetation(cell)!);
}
function waterIn(animal: Animal, tile: Tile, reader: ResidentTileReader | undefined, fast: ResidentFastAccess | undefined, at: number): number {
  const cell = reader ? at : fast?.cellOf(tile) ?? -1;
  if (cell < 0) return waterAt(animal, tile);
  if (animal.species === 'fish') return reader ? reader.moisture(cell)! : fast!.moisture(cell)!;
  const ocean = reader ? reader.biomeCode(cell) === reader.BIOME_OCEAN : fast!.biomeCode(cell) === fast!.BIOME_OCEAN;
  return ocean ? 0 : reader ? reader.drinkingWater(cell) ?? 0 : fast!.drinkingWater(cell) ?? 0;
}
function remember(animal: Animal, tile: Point, tick: number, visited: boolean, food: number, water: number): void {
  const memory = animal.memory, x = tile.x, y = tile.y;
  // `find` precedía al filtro de caducidad: la primera visita a la celda, incluso caducada, conserva
  // visited. Con coordenadas enteras, misma celda (`cell`) equivale a mismas coordenadas (`===`).
  let existingVisited = false, found = false, kept = 0;
  for (let j = 0, n = memory.length; j < n; j++) {
    const m = memory[j]!;
    if (m.x === x && m.y === y) { if (!found) { existingVisited = m.visited; found = true; } }
    else if (tick - m.tick <= MEMORY_TTL) { if (kept !== j) memory[kept] = m; kept++; }
  }
  // El recuerdo nuevo va al final; si no cabe, sale el más antiguo de los que quedan (el `shift` de antes).
  const drop = kept >= MAX_ANIMAL_MEMORY ? 1 : 0;
  for (let i = drop; i < kept; i++) memory[i - drop] = memory[i]!;
  memory[kept - drop] = { x, y, tick, food, water, visited: visited || existingVisited };
  if (memory.length !== kept - drop + 1) memory.length = kept - drop + 1;
}
/** `tile(x, y)` es el índice de terreno fijado al empezar el paso (el `Map` de claves `"x,y"` que se
 * construía aquí, ahora compartido con `tileAt` en tile-index.ts): misma tesela para las mismas
 * coordenadas, y como antes no ve teselas añadidas a mitad del paso. */
/** Vecina candidata de `move`: las coordenadas de la consulta, su tesela y su celda residente (o -1). */
interface Step extends Point { tile: Tile; at: number; }
/** Radio máximo de percepción (`2 + ⌊1·4⌋`) y lado del cuadrado de desplazamientos que lo contiene. */
const MAX_RADIUS = 6, SEEN_SIDE = 2 * MAX_RADIUS + 1;
interface LocalState extends PercepcionFauna {
  tile: (x: number, y: number) => Tile | undefined; occupants: Map<Cell, Animal[]>;
  reader: ResidentTileReader | undefined;
  fast: ResidentFastAccess | undefined;
  visible: VisibleTile[]; pool: VisibleTile[]; neighbors: Step[]; steps: Step[];
  /** Desplazamientos (dx, dy) de la última `localTiles` que entraron en lo visible: valen `stamp`. */
  seen: Int32Array; stamp: number;
  /** V19: leyes de fauna del paso (`paramsOf(world).fauna`), leídas una vez por `stepAnimals`. */
  contacto: boolean; reserva: boolean; fraccionReserva: number; encuentro: boolean;
  /** `paramsOf(world).quimica.emergente`, leído una vez por paso. */
  emergente: boolean;
  /** Borradores de `settlementOverlay`, reutilizados entre animales. */
  amenazas: Point[]; cerca: Point[];
  celdas: CeldasFauna; fila: Int32Array;
  /** Plan de cada animal activo y el orden por cercanía de la decisión (`ordenEspacial`). */
  planes: PlanFauna[]; claves: Float64Array; orden: Int32Array;
  /** Etapa intermedia (`v23.materia` sin `v23.fauna`): el contexto con el que comer y beber sacan materia. */
  materia: CtxLeyMateria | undefined;
}
/** El contexto de materia del dueño de `world`, si el motor ya lo enlazó (un mundo de prueba sin motor no lo tiene). */
function materiaDe(world: AnimalWorld): CtxLeyMateria | undefined {
  const c = ctxSi(world as unknown as Parameters<typeof ctxSi>[0]) as Partial<CtxLeyMateria> | undefined;
  return c?.materia && c.quimica ? c as CtxLeyMateria : undefined;
}
/** La celda a (dx, dy) del animal está en lo que devolvió su última `localTiles`: lo mismo que buscar su
 * `cell` en `visible`, porque con coordenadas enteras dos celdas coinciden si coinciden sus desplazamientos. */
const seenAt = (state: LocalState, dx: number, dy: number): boolean => Math.abs(dx) <= MAX_RADIUS && Math.abs(dy) <= MAX_RADIUS
  && state.seen[(dy + MAX_RADIUS) * SEEN_SIDE + dx + MAX_RADIUS] === state.stamp;

// Marcas de una celda en `CeldasFauna`.
const VISIBLE = 1, AGUA = 2, REFUGIO = 4, CRECIMIENTO = 8, POBLADO_LEIDO = 16, POBLADO = 32, REFUGIO_TESELA = 64,
  HUMEDAD_LEIDA = 128, AGUA_TIERRA_LEIDA = 256;
const PAGINA = 256, REJILLA = 2 ** 24, PAGINA_DESPLAZAMIENTO = 2 ** 20, PAGINA_LADO = 2 ** 21;
// Campos de una celda, contiguos (una línea de caché por celda): sello del paso, marcas, coordenadas de la tesela,
// `growth ?? 0`, `growth ?? vegetation` y el agua de pez y de tierra.
const C_SELLO = 0, C_MARCAS = 1, C_X = 2, C_Y = 3, C_BROTE = 4, C_ALIMENTO = 5, C_AGUA_PEZ = 6, C_AGUA_TIERRA = 7, ANCHO = 8;
/**
 * Lo que la fauna lee de cada celda desde la fisiología hasta el final del poblado de un paso, leído una vez por celda
 * en vez de una vez por cada animal que la ve. En ese tramo nadie escribe teselas ni mueve animales (moverse, pastar y
 * criar vienen después), así que cada lectura repetida da lo mismo que la primera. El agua y el poblado se leen la
 * primera vez que alguien los pide. Las páginas (16 × 16 celdas, como los chunks) se reutilizan de un paso a otro; el
 * sello del paso descarta lo leído antes.
 */
class CeldasFauna {
  private readonly paginas = new Map<number, number>();
  private usadas = 0;
  generacion = 0;
  private k1 = -1; private p1 = -1; private k2 = -1; private p2 = -1;
  datos = new Float64Array(0);
  /** La celda residente de la tesela (-1 sin SoA residente), para las lecturas que se hacen tarde. */
  private residente = new Int32Array(0);
  /** Los animales vivos de la celda al empezar la decisión: el arreglo de `occupants`, sellado al registrarlo. */
  selloOcupantes = new Int32Array(0);
  ocupantes: (Animal[] | undefined)[] = [];

  empezar(): void {
    // La página 0 es la de las celdas fuera de la rejilla, que se leen cada vez.
    this.paginas.clear(); this.usadas = 1; this.generacion = (this.generacion + 1) | 0;
    this.k1 = -1; this.p1 = -1; this.k2 = -1; this.p2 = -1;
    if (!this.residente.length) this.crecer(16 * PAGINA);
  }

  marcas(i: number): number { return this.datos[i * ANCHO + C_MARCAS]!; }

  /** El índice de la celda (x, y), leída si aún no lo estaba en este paso. Fuera de la rejilla de los chunks la
   * celda se lee cada vez en la ranura 0, que nunca queda sellada. */
  indice(x: number, y: number, state: LocalState): number {
    if (x !== (x | 0) || y !== (y | 0) || x < -REJILLA || x >= REJILLA || y < -REJILLA || y >= REJILLA) {
      this.leer(0, x, y, state); this.datos[C_SELLO] = this.generacion - 1;
      this.ocupantes[0] = state.occupants.get(cellXY(this.datos[C_X]!, this.datos[C_Y]!)); this.selloOcupantes[0] = this.generacion;
      return 0;
    }
    const i = this.pagina(x, y) * PAGINA + (((y & 15) << 4) | (x & 15));
    if (this.datos[i * ANCHO + C_SELLO] !== this.generacion) this.leer(i, x, y, state);
    return i;
  }

  /** Los índices de las celdas (x0..x1, y), en orden, en `salida`: la página se busca una vez por chunk de la fila.
   * Fuera de la rejilla deja -1, y quien lee la celda la pide entonces con `indice`. */
  fila(x0: number, x1: number, y: number, state: LocalState, salida: Int32Array): void {
    if (x0 !== (x0 | 0) || x1 !== (x1 | 0) || y !== (y | 0) || x0 < -REJILLA || x1 >= REJILLA || y < -REJILLA || y >= REJILLA) {
      salida.fill(-1, 0, x1 - x0 + 1);
      return;
    }
    const fila = (y & 15) << 4, generacion = this.generacion;
    let base = 0;
    for (let x = x0; x <= x1; x++) {
      if (x === x0 || (x & 15) === 0) base = this.pagina(x, y) * PAGINA + fila;
      const i = base + (x & 15);
      if (this.datos[i * ANCHO + C_SELLO] !== generacion) this.leer(i, x, y, state);
      salida[x - x0] = i;
    }
  }

  /** Registra el arreglo de `occupants` de la celda de un animal vivo; fuera de la rejilla se busca al leer. */
  ocupar(x: number, y: number, animales: Animal[]): void {
    if (x !== (x | 0) || y !== (y | 0) || x < -REJILLA || x >= REJILLA || y < -REJILLA || y >= REJILLA) return;
    const i = this.pagina(x, y) * PAGINA + (((y & 15) << 4) | (x & 15));
    this.ocupantes[i] = animales; this.selloOcupantes[i] = this.generacion;
  }

  /** El agua que bebe un pez (la humedad) o un animal de tierra (la potable, nula en el océano), como `waterAt`. */
  agua(i: number, pez: boolean, state: LocalState): number {
    const b = i * ANCHO, datos = this.datos, marcas = datos[b + C_MARCAS]!;
    if (pez ? marcas & HUMEDAD_LEIDA : marcas & AGUA_TIERRA_LEIDA) return datos[b + (pez ? C_AGUA_PEZ : C_AGUA_TIERRA)]!;
    const reader = state.reader, fast = state.fast, at = this.residente[i]!;
    if (pez) {
      datos[b + C_AGUA_PEZ] = reader ? reader.moisture(at)! : at < 0 ? state.tile(datos[b + C_X]!, datos[b + C_Y]!)!.moisture : fast!.moisture(at)!;
      datos[b + C_MARCAS] = marcas | HUMEDAD_LEIDA;
      return datos[b + C_AGUA_PEZ]!;
    }
    if (reader) datos[b + C_AGUA_TIERRA] = reader.biomeCode(at) === reader.BIOME_OCEAN ? 0 : reader.drinkingWater(at) ?? 0;
    else if (at < 0) {
      const tile = state.tile(datos[b + C_X]!, datos[b + C_Y]!)!;
      datos[b + C_AGUA_TIERRA] = tile.biome === 'ocean' ? 0 : tile.drinkingWater ?? 0;
    }
    else datos[b + C_AGUA_TIERRA] = fast!.biomeCode(at) === fast!.BIOME_OCEAN ? 0 : fast!.drinkingWater(at) ?? 0;
    datos[b + C_MARCAS] = marcas | AGUA_TIERRA_LEIDA;
    return datos[b + C_AGUA_TIERRA]!;
  }

  /** Refugio o cultivo en la tesela, leídos en el objeto como hace el poblado, solo cuando alguien los pregunta. */
  poblado(i: number, x: number, y: number, state: LocalState): number {
    const b = i * ANCHO;
    let marcas = this.datos[b + C_MARCAS]!;
    if (!(marcas & POBLADO_LEIDO)) {
      const tile = state.tile(x, y);
      marcas |= POBLADO_LEIDO;
      if (tile?.terrain === 'shelter') marcas |= REFUGIO_TESELA | POBLADO;
      else if (tile && (tile.cultivation ?? 0) > 0) marcas |= POBLADO;
      this.datos[b + C_MARCAS] = marcas;
    }
    return marcas;
  }

  private pagina(x: number, y: number): number {
    const clave = ((x >> 4) + PAGINA_DESPLAZAMIENTO) * PAGINA_LADO + ((y >> 4) + PAGINA_DESPLAZAMIENTO);
    if (clave === this.k1) return this.p1;
    let pagina: number;
    if (clave === this.k2) pagina = this.p2;
    else pagina = this.paginas.get(clave) ?? this.nuevaPagina(clave);
    this.k2 = this.k1; this.p2 = this.p1; this.k1 = clave; this.p1 = pagina;
    return pagina;
  }

  private nuevaPagina(clave: number): number {
    const pagina = this.usadas++;
    if (this.usadas * PAGINA > this.residente.length) this.crecer(this.usadas * 2 * PAGINA);
    this.paginas.set(clave, pagina);
    return pagina;
  }

  private crecer(n: number): void {
    const viejo = this.residente.length;
    // Las celdas nuevas no deben parecer leídas ni ocupadas en la generación vigente.
    const datos = new Float64Array(n * ANCHO); datos.set(this.datos);
    for (let i = viejo; i < n; i++) datos[i * ANCHO + C_SELLO] = this.generacion - 1;
    this.datos = datos;
    const residente = new Int32Array(n); residente.set(this.residente); this.residente = residente;
    const ocupados = new Int32Array(n); ocupados.set(this.selloOcupantes); ocupados.fill(this.generacion - 1, viejo);
    this.selloOcupantes = ocupados;
    for (let i = viejo; i < n; i++) this.ocupantes.push(undefined);
  }

  /** La clase de terreno, el crecimiento, el alimento y las coordenadas de la tesela, como los leía `localTiles`. */
  private leer(i: number, x: number, y: number, state: LocalState): void {
    const reader = state.reader, b = i * ANCHO, datos = this.datos;
    let marcas = 0, tile: Tile | undefined, at = -1, growth: number | undefined, vegetation = 0;
    if (reader) {
      at = reader.cellAt(x, y);
      if (at >= 0) {
        const terrain = reader.terrainCode(at);
        marcas = VISIBLE | (terrain === reader.TERRAIN_WATER ? AGUA : 0) | (terrain === reader.TERRAIN_SHELTER ? REFUGIO : 0);
        growth = reader.growth(at);
        if (growth === undefined) vegetation = reader.vegetation(at)!;
        // Las coordenadas implícitas no distinguen -0 de +0. Sólo en los ejes se leen las
        // coordenadas originales para conservar también esos bits en target y memory.
        if (x === 0 || y === 0) { const original = state.tile(x, y); if (original) { x = original.x; y = original.y; } }
      }
    } else {
      tile = state.tile(x, y);
      if (tile) {
        const fast = state.fast;
        at = fast?.cellOf(tile) ?? -1;
        if (at < 0) {
          // Con la tesela a mano se leen también el poblado y el agua de quien puede estar en ella (un pez en el
          // agua, un animal de tierra fuera); la otra agua se lee tarde si alguien la pide.
          const terrain = tile.terrain;
          marcas = VISIBLE | POBLADO_LEIDO | (terrain === 'water' ? AGUA : 0)
            | (terrain === 'shelter' ? REFUGIO | REFUGIO_TESELA | POBLADO : (tile.cultivation ?? 0) > 0 ? POBLADO : 0);
          growth = tile.growth;
          if (growth === undefined) vegetation = tile.vegetation;
          if (terrain === 'water') { datos[b + C_AGUA_PEZ] = tile.moisture; marcas |= HUMEDAD_LEIDA; }
          else { datos[b + C_AGUA_TIERRA] = tile.biome === 'ocean' ? 0 : tile.drinkingWater ?? 0; marcas |= AGUA_TIERRA_LEIDA; }
        } else {
          const terrain = fast!.terrainCode(at);
          marcas = VISIBLE | (terrain === fast!.TERRAIN_WATER ? AGUA : 0) | (terrain === fast!.TERRAIN_SHELTER ? REFUGIO : 0);
          growth = fast!.growth(at);
          if (growth === undefined) vegetation = fast!.vegetation(at)!;
        }
        // Fuera de los ejes las coordenadas de la consulta valen lo mismo que las de la tesela.
        if (x === 0 || y === 0) { x = tile.x; y = tile.y; }
      }
    }
    if (growth !== undefined) { marcas |= CRECIMIENTO; datos[b + C_BROTE] = growth; datos[b + C_ALIMENTO] = growth; }
    else { datos[b + C_BROTE] = 0; datos[b + C_ALIMENTO] = vegetation; }
    datos[b + C_SELLO] = this.generacion; datos[b + C_MARCAS] = marcas; datos[b + C_X] = x; datos[b + C_Y] = y;
    this.residente[i] = at;
  }
}
const celdasFauna = new CeldasFauna();

/**
 * Los índices de `animales` agrupados por chunk (16 × 16), para que la decisión y el poblado de animales vecinos lean
 * seguidas las mismas celdas. Ninguna de las dos fases lee lo que la otra escribe en otro animal (cada una escribe solo
 * la acción, el destino, la memoria y la habituación del suyo, y lee de los demás posición, especie, salud, genes y
 * cuerpo), así que el orden no cambia nada. Con más de 2^21 animales la clave no cabe y se deja el orden canónico.
 */
function ordenEspacial(animales: readonly Animal[], state: LocalState): Iterable<number> {
  const n = animales.length;
  if (n > 2 ** 21) return animales.keys();
  if (state.claves.length < n) state.claves = new Float64Array(Math.max(n, 2 * state.claves.length));
  const claves = state.claves.subarray(0, n);
  for (let i = 0; i < n; i++) {
    const a = animales[i]!;
    // Chunk en 16 + 16 bits (con vuelta: solo agrupa) por delante del índice.
    claves[i] = ((((a.x >> 4) & 0xffff) << 16 | ((a.y >> 4) & 0xffff)) >>> 0) * 2 ** 21 + i;
  }
  claves.sort();
  if (state.orden.length < n) state.orden = new Int32Array(state.claves.length);
  const orden = state.orden.subarray(0, n);
  for (let i = 0; i < n; i++) orden[i] = claves[i]! % 2 ** 21;
  return orden;
}
function localTiles(animal: Animal, state: LocalState, plan: PlanFauna): VisibleTile[] {
  const radius = plan.radio, result = state.visible, stamp = ++state.stamp, celdas = state.celdas, fish = animal.species === 'fish';
  result.length = 0;
  // El rombo por filas, en el orden de siempre (dy y luego dx crecientes).
  const ax = animal.x, ay = animal.y, fila = state.fila, generacion = celdas.generacion;
  for (let dy = -radius; dy <= radius; dy++) {
    const span = radius - Math.abs(dy);
    celdas.fila(ax - span, ax + span, ay + dy, state, fila);
    for (let dx = -span; dx <= span; dx++) {
      let i = fila[dx + span]!;
      if (i < 0) i = celdas.indice(ax + dx, ay + dy, state);
      const datos = celdas.datos, b = i * ANCHO, marcas = datos[b + C_MARCAS]!;
      if (!(marcas & VISIBLE) || !habitableParaPlan(plan, (marcas & AGUA) !== 0, (marcas & REFUGIO) !== 0)) continue;
      // Scratch exclusivo del paso, reutilizado entre decisiones; ningún objeto escapa:
      // remember copia sus campos y choose copia el destino antes de la siguiente decisión.
      const t = state.pool[result.length] ??= { x: 0, y: 0, brote: 0, food: 0, water: 0, novelty: undefined, ocupantes: undefined };
      t.x = datos[b + C_X]!; t.y = datos[b + C_Y]!; t.brote = datos[b + C_BROTE]!; t.food = datos[b + C_ALIMENTO]!;
      t.water = marcas & (fish ? HUMEDAD_LEIDA : AGUA_TIERRA_LEIDA) ? datos[b + (fish ? C_AGUA_PEZ : C_AGUA_TIERRA)]! : celdas.agua(i, fish, state);
      t.novelty = undefined;
      t.ocupantes = celdas.selloOcupantes[i] === generacion ? celdas.ocupantes[i] : undefined;
      result.push(t);
      state.seen[(dy + MAX_RADIUS) * SEEN_SIDE + dx + MAX_RADIUS] = stamp;
    }
  }
  return result;
}
function move(animal: Animal, world: AnimalWorld, state: LocalState): void {
  const interval = Math.ceil(11 - animal.genes.speed * 7 + animal.fatigue * 3);
  const physicalInterval = state.emergente ? interval + Math.round((animal.morphology?.size ?? 0.5) * 2) : interval;
  if (animal.action === 'rest' || distance(animal, animal.target) === 0 || world.tick - animal.lastMove < physicalInterval || animal.energy < 0.06) return;
  const neighbors = state.neighbors, reader = state.reader, fast = state.fast;
  neighbors.length = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (Math.abs(dx) + Math.abs(dy) !== 1) continue;
    const t = state.tile(animal.x + dx, animal.y + dy);
    if (!t) continue;
    // Las coordenadas de la consulta valen lo mismo que las de la tesela (salvo el signo de un cero, que
    // ni `cellXY` ni las restas del comparador distinguen); la posición nueva se copia de la tesela.
    const x = animal.x + dx, y = animal.y + dy, at = reader ? reader.cellAt(x, y) : -1;
    if (!livable(animal, t, reader, fast, at)) continue;
    const step = state.steps[neighbors.length] ??= { x, y, tile: t, at };
    step.x = x; step.y = y; step.tile = t; step.at = at;
    neighbors.push(step);
  }
  const next = primero(neighbors, (a, b) => distance(a, animal.target) - distance(b, animal.target) || a.y - b.y || a.x - b.x);
  if (!next) return;
  const current = state.tile(animal.x, animal.y)!, here = reader ? reader.cellAt(animal.x, animal.y) : -1;
  remember(animal, current, world.tick, true, plantIn(current, reader, fast, here), waterIn(animal, current, reader, fast, here));
  const from = cell(animal);
  // Nadie conserva los arreglos de ocupantes (quien los lee copia sus elementos): quitar y añadir en el
  // sitio da el mismo contenido y el mismo orden que los arreglos nuevos de antes.
  const left = state.occupants.get(from);
  if (left) { let kept = 0; for (const a of left) if (a !== animal) left[kept++] = a; left.length = kept; }
  else state.occupants.set(from, []);
  const to = next.tile;
  animal.x = to.x; animal.y = to.y; animal.lastMove = world.tick; animalMovido(world, animal);
  const arrival = cell(animal);
  const arrived = state.occupants.get(arrival);
  if (arrived) arrived.push(animal); else state.occupants.set(arrival, [animal]);
  exertBody(animal, { energy: animal.action === 'flee' ? 0.003 : 0.0015, fatigue: animal.action === 'flee' ? 0.004 : 0.002 });
  remember(animal, to, world.tick, true, plantIn(to, reader, fast, next.at), waterIn(animal, to, reader, fast, next.at));
}
function death(world: AnimalWorld, animal: Animal, cause: string, emit?: AnimalEmitter, hunter?: string): void {
  animal.health = 0; world.animalDynamics.deaths++;
  emit?.({ kind: 'animal', actors: hunter ? [hunter, animal.id] : [animal.id], x: animal.x, y: animal.y,
    text: `${animal.species} ${animal.id} muere por ${cause}.`, cause, source: 'simulation' });
}
function physiology(animal: Animal, desert: boolean, world: AnimalWorld, emergent: boolean, emit?: AnimalEmitter): void {
  const morphology = emergent ? ensureMorphology(animal, world.seed) : undefined;
  const metabolism = (0.6 + animal.genes.metabolism * 0.8) * (morphology ? 0.9 + morphology.size * 0.3 : 1);
  advanceNeeds(animal, { hunger: 0.00042 * metabolism, thirst: 0.00048 * (1.3 - animal.genes.waterEfficiency * 0.6)
    + (desert ? 0.00015 : 0), energy: 0.00008 * metabolism, stressEnergy: 0.0002, fatigue: 0.00012 });
  // Dormancy never catches up. A founder materialized in this very tick has not yet completed another age interval.
  animal.age = Math.min(animal.age + 1, world.tick - animal.bornAt);
  const cause = animal.thirst >= 0.985 ? 'deshidratación' : animal.hunger >= 0.985 ? 'inanición'
    : animal.energy <= 0.001 ? 'agotamiento' : animal.age > LIFESPAN[especieVisual(animal.species)] ? 'senescencia' : '';
  if (cause) animal.health = clamp(animal.health - (cause === 'deshidratación' ? 0.0012 : cause === 'inanición' ? 0.0008 : 0.0003));
  else if (animal.hunger < 0.55 && animal.thirst < 0.55 && animal.energy > 0.35 && animal.health < 1) {
    animal.health = clamp(animal.health + 0.00015); animal.energy = clamp(animal.energy - 0.00003);
  }
  if (animal.health <= 0) death(world, animal, cause || 'heridas', emit);
}
/** V19/R: aparta de lo realmente consumido la fracción de la reserva (sin pasar de `RESERVA_MAXIMA`) y
 * devuelve lo apartado, que NO baja el hambre. */
function reservar(animal: Animal, consumed: number, fraccion: number): number {
  const actual = animal.reproReserve ?? 0, parte = Math.min(consumed * fraccion, RESERVA_MAXIMA - actual);
  if (!(parte > 0)) return 0;
  animal.reproReserve = Math.min(RESERVA_MAXIMA, actual + parte);
  return parte;
}
function feed(animal: Animal, tile: Tile, world: AnimalWorld, state: LocalState): void {
  if (distance(animal, animal.target) > 0) return;
  if (state.materia) { feedMaterial(animal, tile, world, state, state.materia); return; }
  if (animal.action === 'graze' && animal.genes.carnivory < 0.6) {
    const consumed = Math.min(tile.growth ?? tile.vegetation, 0.0015, animal.hunger / 4);
    tile.growth = clamp((tile.growth ?? tile.vegetation) - consumed);
    tile.vegetation = clamp(tile.vegetation - consumed * 0.5);
    // Grazing is paid in tiny per-tick plant units, unlike a carnivore's whole carcass intake.
    // Allocate up to four times the configured fraction to herbivores, still only from consumed biomass.
    const apartado = state.reserva ? reservar(animal, consumed, Math.min(1, state.fraccionReserva * 4)) : 0;
    assimilateFood(animal, state.reserva ? consumed - apartado : consumed, { hungerPerUnit: 4, assimilation: 1 - animal.genes.carnivory, energyPerUnit: 0.8 });
    world.animalDynamics.plantConsumed += consumed;
    // Plant water is finite and belongs to this patch, never to an invisible drinking reservoir.
    if (animal.species !== 'fish') {
      const moisture = Math.min(tile.moisture, consumed * 3);
      tile.moisture = clamp(tile.moisture - moisture); hydrateBody(animal, moisture, 0.3);
      world.animalDynamics.waterConsumed += moisture * 0.1;
    }
  } else if (animal.action === 'drink') {
    const water = takeWater(animal, tile, Math.min(0.0016, animal.thirst / 3));
    hydrateBody(animal, water); world.animalDynamics.waterConsumed += water;
  } else if (animal.action === 'rest') {
    restBody(animal, { fatigue: 0.002, energy: 0.0015 });
  }
}
/** Etapa intermedia (`v23.materia` sin `v23.fauna`): el animal escalar de hoy come y bebe lo mismo que en `feed`, pero
 * lo saca de la materia de la tesela con `extraerEscalar` (sumidero declarado «uso heredado»), que escribe la vista;
 * solo asimila lo que de verdad salió. */
function feedMaterial(animal: Animal, tile: Tile, world: AnimalWorld, state: LocalState, c: CtxLeyMateria): void {
  const celda = c.terreno.celda(animal.x, animal.y);
  if (celda < 0) return;
  if (animal.action === 'graze' && animal.genes.carnivory < 0.6) {
    const pedido = Math.min(tile.food, 0.0015, animal.hunger / 4);
    const consumed = pedido > 0 ? extraerEscalar(c, celda, 'comida', pedido) : 0;
    const apartado = state.reserva ? reservar(animal, consumed, Math.min(1, state.fraccionReserva * 4)) : 0;
    assimilateFood(animal, state.reserva ? consumed - apartado : consumed, { hungerPerUnit: 4, assimilation: 1 - animal.genes.carnivory, energyPerUnit: 0.8 });
    world.animalDynamics.plantConsumed += consumed;
    if (animal.species !== 'fish' && consumed > 0) {
      const agua = extraerEscalar(c, celda, 'agua', consumed * 3);
      hydrateBody(animal, agua, 0.3); world.animalDynamics.waterConsumed += agua * 0.1;
    }
  } else if (animal.action === 'drink') {
    const pedido = Math.min(waterAt(animal, tile), 0.0016, animal.thirst / 3);
    const water = pedido > 0 ? extraerEscalar(c, celda, 'agua', pedido) : 0;
    hydrateBody(animal, water); world.animalDynamics.waterConsumed += water;
  } else if (animal.action === 'rest') {
    restBody(animal, { fatigue: 0.002, energy: 0.0015 });
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
  const raw = residentBackingArray(tiles);
  let count = 0;
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i]!;
    if (t.terrain !== 'shelter' && (t.growth ?? 0) > 0.04) count++;
  }
  return count * 3;
}
const BREEDING_CELLS = [[0, 0], [0, -1], [-1, 0], [1, 0], [0, 1]] as const;
function reproduce(world: AnimalWorld, state: LocalState, active: Animal[], emit?: AnimalEmitter): void {
  if (world.reproductionEnabled === false) return;
  // La madurez y el intervalo entre crías se miden en edad biológica.
  let capacity: number | undefined;
  const reserva = state.reserva;
  const eligible = (a: Animal): boolean => a.age >= MATURITY && a.age - a.lastBirthAge >= MATURITY
    && a.health > 0.75 && a.energy > 0.65 && a.hunger < 0.4 && a.thirst < 0.4 && a.action !== 'flee'
    && (!reserva || (a.reproReserve ?? 0) >= RESERVA_POR_PROGENITOR);
  for (const a of active) {
    if (capacity !== undefined && world.animals.length >= capacity) break;
    if (!eligible(a)) continue;
    const tile = state.tile(a.x, a.y)!;
    // V19/R: la cría se financia con el cuerpo de los progenitores; el agua natal que la celda no tenga la ponen ellos
    // (abajo), así que con R la celda no necesita guardar 0,012 de agua.
    if (!reserva && (waterAt(a, tile) < 0.012 || (tile.growth ?? 0) < 0.08)) continue;
    // La pareja es la primera en orden canónico (`sort(canonical)[0]`) de las elegibles de su vecindad.
    let b: Animal | undefined;
    for (const [dx, dy] of BREEDING_CELLS) for (const c of state.occupants.get(cellXY(a.x + dx!, a.y + dy!)) ?? [])
      if (c !== a && c.species === a.species && eligible(c) && (!b || canonical(c, b) < 0)) b = c;
    if (!b) continue;
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
    // V19/R: lo que falte de los 0,012 de agua natal sale, a partes iguales, del agua corporal de los dos progenitores
    // (ambos con sed < 0,4): su sed sube lo que esa agua calmaría (`SED_POR_UNIDAD`). No se crea agua: se transfiere.
    if (reserva && water < 0.012) for (const parent of [a, b]) parent.thirst = clamp(parent.thirst + (0.012 - water) / 2 * SED_POR_UNIDAD);
    // The natal patch provides limited biomass as well as energy donated by both parents.
    // V19/R: la biomasa de la cría sale de los 0,03 de cada progenitor (conservada: 0,06 en total), no de la celda.
    if (reserva) { for (const parent of [a, b]) parent.reproReserve = Math.max(0, (parent.reproReserve ?? 0) - RESERVA_POR_PROGENITOR); }
    else { tile.growth = clamp((tile.growth ?? 0) - 0.06); world.animalDynamics.plantConsumed += 0.06; }
    const child: Animal = { id, species: a.species, x: a.x, y: a.y, action: 'rest', reason: 'Cría con rasgos heredados; necesita alimento, agua y descanso.',
      hunger: 0.32, thirst: 0.25, energy: 0.35, fatigue: 0.2, health: 0.8, genes: inherited,
      generation: Math.max(a.generation, b.generation) + 1, parents, age: 0, bornAt: world.tick, lastBirth: world.tick, lastBirthAge: 0,
      lastDecision: world.tick, lastMove: world.tick, target: { x: a.x, y: a.y }, memory: [], work: 0, preyId: null };
    if (paramsOf(world).quimica.emergente) {
      const ma = ensureMorphology(a, world.seed), mb = ensureMorphology(b, world.seed);
      child.morphology = { ...ma };
      for (const field of MORPH_FIELDS) child.morphology[field] = Math.max(0.05, Math.min(0.95,
        (ma[field] + mb[field]) / 2 + (hash(world.seed, `${id}:morph:${field}`) / 4294967296 - 0.5) * 0.06));
    }
    world.animals.push(child); world.animalDynamics.births++;
    emit?.({ kind: 'animal', actors: [...parents, id], x: a.x, y: a.y, text: `Nace ${a.species} de generación ${child.generation}.`, cause: 'reproducción con costes corporales, alimento y agua', source: 'simulation' });
  }
}

export function stepAnimals(world: AnimalWorld, emit?: AnimalEmitter): void {
  world.animals.sort(canonical);
  const state: LocalState = { tile: tileLookup(world.tiles), occupants: new Map(),
    visibles: (animal, plan) => localTiles(animal, state, plan),
    ocupantes: (x, y) => state.occupants.get(cellXY(x, y)),
    residente: t => (state.celdas.marcas(state.celdas.indice(t.x, t.y, state)) & VISIBLE) !== 0,
    visto: (dx, dy) => seenAt(state, dx, dy),
    recordar: remember,
    reader: undefined, fast: undefined, visible: [], pool: [], resources: [], adjacent: [], neighbors: [], steps: [], seen: new Int32Array(SEEN_SIDE * SEEN_SIDE), stamp: 0,
    contacto: false, reserva: false, fraccionReserva: 0, encuentro: false, emergente: false, amenazas: [], cerca: [], celdas: celdasFauna, fila: new Int32Array(SEEN_SIDE),
    planes: [], claves: new Float64Array(0), orden: new Int32Array(0),
    materia: ley(world, 'materia') && !ley(world, 'fauna') ? materiaDe(world) : undefined };
  const { fauna: leyesFauna } = paramsOf(world);
  const emergent = state.emergente = paramsOf(world).quimica.emergente;
  // Con los params históricos (o ausentes) los tres quedan apagados: la aritmética y el RNG son los de V18.
  if (leyesFauna) {
    state.contacto = leyesFauna.contactoContinuo; state.reserva = leyesFauna.reservaReproductiva;
    state.fraccionReserva = leyesFauna.fraccionReservaCria; state.encuentro = leyesFauna.encuentroFertil;
  }
  const fauna = faunaDe(world);
  fauna.sincronizar(world.animals);
  const { columnaEspecie } = fauna;
  // Vista residente validada (o ninguna) para todo el paso: la fauna no cambia la topología ni el SoA.
  const reader = state.reader = residentTileReader(world.tiles);
  state.fast = residentFastAccess(world.tiles);
  state.celdas.empezar();
  for (const animal of world.animals) {
    const tile = state.tile(animal.x, animal.y);
    if (!tile) throw new Error('Animal fuera de las regiones activas.');
    physiology(animal, desertIn(tile, reader, state.fast, reader ? reader.cellAt(animal.x, animal.y) : -1), world, emergent, emit);
    if (emergent && animal.species !== 'fish') {
      const m = animal.morphology!, cold = tile.biome === 'mountain' || world.tick % 2400 >= 1800 || world.weather === 'rain';
      // Physical heat loss, paid by the body. Insulation protects in cold conditions,
      // but traps heat in desert; these costs affect survival and breeding eligibility.
      const loss = (cold ? 0.00022 * (1 - m.coat * 0.85) * (1.2 - m.size * 0.5) : 0)
        + (tile.biome === 'desert' ? 0.00016 * m.coat : 0);
      animal.energy = clamp(animal.energy - loss);
    }
    if (animal.health <= 0) continue;
    const p = cell(animal), here = state.occupants.get(p);
    if (here) here.push(animal);
    else { const nuevos = [animal]; state.occupants.set(p, nuevos); state.celdas.ocupar(animal.x, animal.y, nuevos); }
  }
  world.animals = world.animals.filter(a => a.health > 0);
  const active = world.animals;
  // Los planes se crean en orden canónico (su id es el orden de creación); la decisión y el poblado van por cercanía.
  const planes = state.planes, orden = ordenEspacial(active, state);
  planes.length = active.length;
  for (let i = 0; i < active.length; i++) planes[i] = planFauna(active[i]!, columnaEspecie);
  for (const i of orden) decidirFauna(active[i]!, world, state, planes[i]!);
  actividadFauna.set(world, { tick: world.tick, vivos: active.length, decisiones: decididosEn(active, world.tick) });
  if (emergent) {
    const humans = settlementBuckets(world.people ?? []);
    const structures = world.structures ?? [];
    const hearths = settlementBuckets(structures.filter(s => s.condition > 0.1 && s.components.includes('hearth')));
    for (const i of orden) settlementOverlay(active[i]!, world.tick, state, humans, hearths);
  }
  // Las huidas preceden al contacto, con desempate por id dentro de cada grupo.
  for (const animal of active) if (animal.action === 'flee') move(animal, world, state);
  for (const animal of active) if (animal.action !== 'flee') move(animal, world, state);
  let byId: Map<string, Animal> | undefined;
  for (const animal of active) {
    if (animal.health <= 0) continue;
    const tile = state.tile(animal.x, animal.y)!;
    feed(animal, tile, world, state);
    if (emergent && world.tick % 8 === 0 && isHerdAnimal(animal) && tile.terrain !== 'water'
      && (animal.action === 'graze' || animal.action === 'rest')) tile.fertility = clamp((tile.fertility ?? 0) + 0.008);
    if (animal.action !== 'hunt' || !animal.preyId) continue;
    if (!byId) {
      byId = new Map();
      for (const a of world.animals) byId.set(a.id, a);
    }
    const prey = byId.get(animal.preyId);
    if (emergent && prey && hash(world.seed, `${animal.id}:${prey.id}:defense:${Math.floor(world.tick / 8)}`) / 4294967296 < (prey.morphology?.defense ?? 0) * 0.65) {
      animal.work = 0; continue;
    }
    if (state.contacto && prey && prey.health > 0 && edible(animal, prey)) {
      // V19/F: el alcance es el contacto o la adyacencia (≤ 1 celda, también tras cruzarse); una separación breve
      // sólo resta un paso de preparación en vez de borrarla. El daño sigue exigiendo contacto/alcance actual.
      if (distance(animal, prey) > 1) { if (animal.work > 0) animal.work--; continue; }
    } else if (!prey || prey.health <= 0 || !edible(animal, prey) || distance(animal, prey) > 0) { animal.work = 0; continue; }
    animal.work++; exertBody(animal, { energy: 0.0008, fatigue: 0.001 });
    if (animal.work < 4) continue;
    animal.work = 0; prey.health = clamp(prey.health - (0.18 + animal.genes.speed * 0.08 - prey.genes.camouflage * 0.05)
      * (emergent ? 1 - (prey.morphology?.defense ?? 0) * 0.5 : 1));
    if (prey.health > 0) continue;
    death(world, prey, 'depredación', emit, animal.id); world.animalDynamics.predations++;
    const botin = emergent ? animalBiomass(prey) : FOOD_PER_ANIMAL[especieVisual(prey.species)];
    assimilateFood(animal, state.reserva ? botin - reservar(animal, botin, state.fraccionReserva) : botin, { hungerPerUnit: 4.8, assimilation: animal.genes.carnivory, energyPerUnit: 0.5 });
    // V19/R: una presa es también agua. Como el pasto (`feed`: 3 unidades de agua por unidad de biomasa, 0,3 de sed
    // por unidad), el cuerpo de la presa aporta la que conservaba: `botín · 3 · (1 − sed de la presa)`. Sale de ESE
    // cuerpo (que la bebió antes, ya contada en `waterConsumed`), no de un depósito invisible; una presa sedienta da menos.
    if (state.reserva) hydrateBody(animal, botin * 3 * (1 - prey.thirst), 0.3);
  }
  world.animals = world.animals.filter(a => a.health > 0);
  const previos = world.animals.length;
  reproduce(world, state, active, emit);
  if (world.animals.length !== previos) world.animals.sort(canonical);
  invalidarRejillaFauna(world); syncFauna(world.tiles, world.animals);
  solicitarFrenteFauna(world);
}

/** A human hunt removes exactly one living identity on the requested cell, at most once. */
export function harvestAt(world: AnimalWorld, point: Point, hunterId: string, emit?: AnimalEmitter, victimId?: string): number {
  refrescarAmbitoFauna(world);
  const enCelda = animalesVivosEnCelda(world, point.x, point.y);
  const candidates = enCelda ?? world.animals.filter(a => a.x === point.x && a.y === point.y && a.health > 0);
  const victim = (victimId === undefined ? candidates : candidates.filter(a => a.id === victimId)).sort(canonical)[0];
  if (!victim || !residentBackingArray(world.tiles).some(t => t.x === point.x && t.y === point.y)) return 0;
  // V23: el animal tiene cuerpo; matarlo deja su cadáver en la celda (la comida sale de ahí, no de un escalar).
  if (victim.cuerpo) { matarAnimal(ctxMateriaDe(world as unknown as Parameters<typeof ctxMateriaDe>[0]), victim, 'caza humana', hunterId); return 0; }
  if (paramsOf(world).quimica.emergente) alarmHerd(world.animals, victim, world.tick);
  death(world, victim, 'caza humana', emit, hunterId); world.animalDynamics.humanHunts++;
  world.animals = world.animals.filter(a => a.id !== victim.id); refrescarAmbitoFauna(world); syncFauna(world.tiles, world.animals);
  solicitarFrenteFauna(world);
  return paramsOf(world).quimica.emergente ? animalBiomass(victim) : FOOD_PER_ANIMAL[especieVisual(victim.species)];
}

function alarmHerd(animals: readonly Animal[], at: Point, tick: number): void {
  for (const animal of animals) if (animal.health > 0 && distance(animal, at) <= 3) {
    animal.lastHunted = tick; animal.habituation = clamp((animal.habituation ?? 0) - 0.15);
  }
}

export function projectAnimal(animal: Animal, _tick: number): AnimalView {
  return { id: animal.id, species: especieVisual(animal.species), x: animal.x, y: animal.y, action: animal.action, reason: animal.reason,
    hunger: animal.hunger, thirst: animal.thirst, energy: animal.energy, fatigue: animal.fatigue, health: animal.health,
    generation: animal.generation, parents: [...animal.parents], genes: { ...animal.genes }, age: animal.age,
    ...(animal.morphology === undefined ? {} : { morphology: { ...animal.morphology } }),
    ...(animal.habituation === undefined ? {} : { habituation: animal.habituation }),
    ...(animal.tends === undefined ? {} : { tends: animal.tends }),
    ...(animal.reproReserve === undefined ? {} : { reproReserve: Math.round(animal.reproReserve * 1000) / 1000 }) };
}
export function assertAnimal(value: unknown, tick: number, faunaV23 = false): asserts value is Animal {
  const fail = (): never => { throw new Error('Animal individual inválido.'); };
  if (!value || typeof value !== 'object') fail();
  const a = value as Animal, time = (n: number, lower = 0): boolean => Number.isSafeInteger(n) && n >= lower && n <= tick;
  assertAnimalTraits(a, tick);
  if (typeof a.id !== 'string' || !/^animal-[a-zA-Z0-9-]{1,110}$/.test(a.id) || !(faunaV23 ? typeof a.species === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(a.species) : especieHeredada(a.species)) || !ACTIONS.includes(a.action)
    || !point(a) || !point(a.target) || typeof a.reason !== 'string' || a.reason.length > 240
    || !['hunger', 'thirst', 'energy', 'fatigue', 'health'].every(k => unit(a[k as keyof Animal])) || a.health <= 0
    || !Number.isSafeInteger(a.generation) || a.generation < 0 || (!faunaV23 && a.generation > 1e6) || !Array.isArray(a.parents)
    || !(a.generation === 0 ? a.parents.length === 0 : a.parents.length === 2) || new Set(a.parents).size !== a.parents.length
    || a.parents.some(id => typeof id !== 'string' || !/^animal-[a-zA-Z0-9-]{1,110}$/.test(id) || id === a.id)
    || !a.genes || Object.keys(a.genes).length !== 6 || !['speed','perception','metabolism','carnivory','waterEfficiency','camouflage'].every(k => unit(a.genes[k as keyof AnimalGenes]))
    || !time(a.bornAt, -MATURITY) || !time(a.lastBirth, a.bornAt) || !time(a.lastDecision, Math.max(-12, a.bornAt)) || !time(a.lastMove, Math.max(-12, a.bornAt))
    || !Number.isSafeInteger(a.age) || a.age < 0 || a.age > tick - a.bornAt || !Number.isSafeInteger(a.lastBirthAge) || a.lastBirthAge < 0 || a.lastBirthAge > a.age
    || !Number.isSafeInteger(a.work) || a.work < 0 || a.work > 4
    || !(a.preyId === null || typeof a.preyId === 'string' && /^animal-[a-zA-Z0-9-]{1,110}$/.test(a.preyId) && a.preyId !== a.id)
    || !Array.isArray(a.memory) || a.memory.length > MAX_ANIMAL_MEMORY
    || a.reproReserve !== undefined && !(typeof a.reproReserve === 'number' && Number.isFinite(a.reproReserve) && a.reproReserve >= 0 && a.reproReserve <= RESERVA_MAXIMA)) fail();
  const seen = new Set<string>();
  for (const memory of a.memory) {
    if (!point(memory) || !time(memory.tick) || !unit(memory.food) || !unit(memory.water) || typeof memory.visited !== 'boolean' || seen.has(key(memory))) fail();
    seen.add(key(memory));
  }
}
export function assertAnimals(value: unknown, tick: number, tiles?: Tile[], maxAnimals = Number.MAX_SAFE_INTEGER, faunaV23 = false): asserts value is Animal[] {
  if (!Number.isSafeInteger(maxAnimals) || maxAnimals < 1 || !Array.isArray(value) || value.length > maxAnimals) throw new Error('Colección de fauna inválida.');
  const ids = new Set<string>();
  const positions = tiles && new Map(residentBackingArray(tiles).map(t => [key(t), t]));
  for (const animal of value) {
    assertAnimal(animal, tick, faunaV23);
    if (ids.has(animal.id) || positions && !positions.has(key(animal))) throw new Error('Identidad o región animal inválida.');
    ids.add(animal.id);
  }
}
