import type { AnimalAction, AnimalDynamics, AnimalGenes, AnimalSpecies, AnimalView } from '../shared/life.js';
import type { ChronicleEvent, Tile } from '../shared/types.js';
import { FOOD_PER_ANIMAL } from './ecosystem.js';
import { advanceNeeds } from './needs.js';
import { assimilateFood, exertBody, hydrateBody, restBody } from './body.js';
import { MAX_COORDINATE } from './terrain.js';
import { LEGACY_WORLD_LIMITS, limitsOf } from './params.js';
import { tileLookup } from './tile-index.js';
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
    tile.fauna = count?.count ?? 0;
    if (count) tile.species = count.species; else delete tile.species;
  };
  // Cada celda una sola vez: primero las ocupadas antes y luego las nuevas, el orden del antiguo
  // `new Set([...occupied, ...counts.keys()])` (cada celda escribe una tesela distinta).
  for (const [p, at] of cache.occupied) write(p, at);
  for (const [p, at] of counts) if (!cache.occupied.has(p)) write(p, at);
  cache.occupied = counts;
}

function habitat(animal: Animal, tile: Tile): boolean {
  return animal.species === 'fish' ? tile.terrain === 'water' : tile.terrain !== 'water' && tile.terrain !== 'shelter';
}
function edible(animal: Animal, prey: Animal): boolean {
  if (animal.genes.carnivory < 0.6 || animal.species === prey.species) return false;
  return animal.species === 'wolf' ? ['hare', 'deer', 'boar', 'fox'].includes(prey.species)
    : animal.species === 'fox' ? prey.species === 'hare' : false;
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
function remember(animal: Animal, tile: Tile, tick: number, visited: boolean): void {
  const existing = animal.memory.find(m => m.x === tile.x && m.y === tile.y);
  const here = cell(tile);
  animal.memory = animal.memory.filter(m => cell(m) !== here && tick - m.tick <= MEMORY_TTL);
  animal.memory.push({ x: tile.x, y: tile.y, tick, food: tile.growth ?? tile.vegetation, water: waterAt(animal, tile), visited: visited || !!existing?.visited });
  if (animal.memory.length > MAX_ANIMAL_MEMORY) animal.memory.shift();
}
/** `tile(x, y)` es el índice de terreno fijado al empezar el paso (el `Map` de claves `"x,y"` que se
 * construía aquí, ahora compartido con `tileAt` en tile-index.ts): misma tesela para las mismas
 * coordenadas, y como antes no ve teselas añadidas a mitad del paso. */
interface LocalState { tile: (x: number, y: number) => Tile | undefined; occupants: Map<Cell, Animal[]>; counts: Map<Cell, number>; }
function localTiles(animal: Animal, state: LocalState): Tile[] {
  const radius = 2 + Math.floor(animal.genes.perception * 4), result: Tile[] = [];
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    if (Math.abs(dx) + Math.abs(dy) > radius) continue;
    const tile = state.tile(animal.x + dx, animal.y + dy);
    if (tile && habitat(animal, tile)) result.push(tile);
  }
  return result;
}
function choose(animal: Animal, world: AnimalWorld, state: LocalState): void {
  const visible = localTiles(animal, state), near = visible.flatMap(t => state.occupants.get(cell(t)) ?? []).filter(a => a.id !== animal.id && a.health > 0);
  const threats = near.filter(a => edible(a, animal) && distance(a, animal) <= 1 + Math.floor(animal.genes.perception * 5));
  const adjacent = visible.filter(t => distance(t, animal) === 1 && (state.counts.get(cell(t)) ?? 0) < MAX_ANIMALS_PER_TILE);
  let action: AnimalAction = 'roam', target: Point = animal, reason = 'Explora celdas cercanas y evita recorridos que recuerda.';
  let preyId: string | null = null;
  // Los dos primeros del mismo orden estable, sin ordenar todo lo visible (orden.ts).
  for (const tile of primerosDos(visible, (a, b) => (waterAt(animal, b) + (b.growth ?? 0)) - (waterAt(animal, a) + (a.growth ?? 0)) || distance(a, animal) - distance(b, animal) || a.y - b.y || a.x - b.x,
    t => (t.growth ?? 0) > 0.05 || waterAt(animal, t) > 0.005)) remember(animal, tile, world.tick, distance(tile, animal) === 0);
  if (threats.length) {
    const safety = (p: Point): number => Math.min(...threats.map(t => distance(t, p)));
    const escape = adjacent.sort((a, b) => safety(b) - safety(a) || a.y - b.y || a.x - b.x)[0];
    action = 'flee'; target = escape && safety(escape) > safety(animal) ? escape : animal;
    reason = 'Percibe un depredador cercano y se aleja físicamente de su alcance.';
  } else {
    // Sprint noche-perf2: «¿alguna celda visible es la del recuerdo?» con un conjunto de las celdas visibles
    // (las claves `cell` son números enteros o cadenas: `Set.has` y `===` coinciden) en vez de recorrer
    // lo visible por cada recuerdo.
    let visibleCells: Set<Cell> | undefined;
    const resources = [...visible.map(t => ({ x: t.x, y: t.y, food: t.growth ?? t.vegetation, water: waterAt(animal, t) })),
      ...animal.memory.filter(m => world.tick - m.tick <= MEMORY_TTL && state.tile(m.x, m.y) !== undefined
        && !(visibleCells ??= new Set(visible.map(cell))).has(cell(m)))];
    const water = primero(resources, (a, b) => distance(a, animal) - distance(b, animal) || b.water - a.water || a.y - b.y || a.x - b.x, t => t.water > 0.001);
    const food = primero(resources, (a, b) => distance(a, animal) - distance(b, animal) || b.food - a.food || a.y - b.y || a.x - b.x, t => t.food > 0.001);
    const prey = near.filter(a => edible(animal, a)).sort((a, b) => distance(a, animal) - distance(b, animal) || canonical(a, b))[0];
    if (animal.thirst > 0.42 && water) { action = 'drink'; target = water; reason = 'La sed orienta su camino hacia agua percibida o recordada.'; }
    else if (animal.hunger > 0.38 && prey) { action = 'hunt'; target = prey; preyId = prey.id; reason = 'Persigue una presa individual visible; alimentarse exige alcanzarla.'; }
    else if (animal.hunger > 0.38 && animal.genes.carnivory < 0.6 && food) { action = 'graze'; target = food; reason = 'El hambre orienta su camino hacia crecimiento vegetal finito.'; }
    else if (animal.energy < 0.4 || animal.fatigue > 0.55) { action = 'rest'; reason = 'El agotamiento requiere una pausa; descansar no elimina hambre ni sed.'; }
    else {
      // Función pura de la tesela: se calcula una vez por tesela y no en cada comparación del `sort`.
      const novelties = new Map<Tile, number>();
      const novelty = (t: Tile): number => {
        let value = novelties.get(t);
        if (value === undefined) {
          const visit = animal.memory.find(m => m.visited && cell(m) === cell(t));
          value = (visit ? Math.min(1, (world.tick - visit.tick) / MEMORY_TTL) : 2) + hash(world.seed, `${animal.id}:${key(t)}:${Math.floor(world.tick / 60)}`) / 4294967296 * 0.2;
          novelties.set(t, value);
        }
        return value;
      };
      target = adjacent.sort((a, b) => novelty(b) - novelty(a) || a.y - b.y || a.x - b.x)[0] ?? animal;
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
  const neighbors = [[0, -1], [-1, 0], [1, 0], [0, 1]].map(([dx, dy]) => state.tile(animal.x + dx!, animal.y + dy!))
    .filter((t): t is Tile => !!t && habitat(animal, t) && (state.counts.get(cell(t)) ?? 0) < MAX_ANIMALS_PER_TILE);
  neighbors.sort((a, b) => distance(a, animal.target) - distance(b, animal.target) || a.y - b.y || a.x - b.x);
  const next = neighbors[0];
  if (!next) return;
  remember(animal, state.tile(animal.x, animal.y)!, world.tick, true);
  const from = cell(animal);
  state.counts.set(from, state.counts.get(from)! - 1);
  state.occupants.set(from, (state.occupants.get(from) ?? []).filter(a => a.id !== animal.id));
  animal.x = next.x; animal.y = next.y; animal.lastMove = world.tick;
  const to = cell(animal);
  state.counts.set(to, (state.counts.get(to) ?? 0) + 1);
  // Nadie conserva los arreglos de ocupantes (quien los lee copia sus elementos): añadir en el sitio da
  // el mismo contenido y el mismo orden que el arreglo nuevo de antes.
  const arrived = state.occupants.get(to);
  if (arrived) arrived.push(animal); else state.occupants.set(to, [animal]);
  exertBody(animal, { energy: animal.action === 'flee' ? 0.003 : 0.0015, fatigue: animal.action === 'flee' ? 0.004 : 0.002 });
  remember(animal, next, world.tick, true);
}
function death(world: AnimalWorld, animal: Animal, cause: string, emit?: AnimalEmitter, hunter?: string): void {
  animal.health = 0; world.animalDynamics.deaths++;
  emit?.({ kind: 'animal', actors: hunter ? [hunter, animal.id] : [animal.id], x: animal.x, y: animal.y,
    text: `${animal.species} ${animal.id} muere por ${cause}.`, cause, source: 'simulation' });
}
function physiology(animal: Animal, tile: Tile, world: AnimalWorld, emit?: AnimalEmitter): void {
  const metabolism = 0.6 + animal.genes.metabolism * 0.8;
  advanceNeeds(animal, { hunger: 0.00042 * metabolism, thirst: 0.00048 * (1.3 - animal.genes.waterEfficiency * 0.6)
    + (tile.biome === 'desert' ? 0.00015 : 0), energy: 0.00008 * metabolism, stressEnergy: 0.0002, fatigue: 0.00012 });
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
    const neighbors = [[0, 0], [0, -1], [-1, 0], [1, 0], [0, 1]].flatMap(([dx, dy]) => state.occupants.get(cellXY(a.x + dx!, a.y + dy!)) ?? []);
    const b = neighbors.filter(b => b.id !== a.id && b.species === a.species && eligible(b)).sort(canonical)[0];
    if (!b) continue;
    // Capacidad de cría = capacidad NATURAL del terreno. `limites.fauna` es admisión (lanza en
    // `stepAnimals`), nunca una política silenciosa: la máquina no decide cuántos animales nacen.
    capacity ??= world.tiles.filter(t => t.terrain !== 'shelter' && (t.growth ?? 0) > 0.04).length * 3;
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
    world.animals.push(child); state.counts.set(cell(a), (state.counts.get(cell(a)) ?? 0) + 1); world.animalDynamics.births++;
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
export function mascaraFauna(world: AnimalWorld): MascaraFauna { return calcularMascara(world, true); }
function calcularMascara(world: AnimalWorld, exportada: boolean): MascaraFauna {
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
  const orden = exportada ? Object.freeze(certificado.objetos.slice()) : certificado.objetos;
  return Object.freeze({ tick: world.tick, animales: animals, poblacion: population, orden, seleccion: Object.freeze(selected), ids: new Set(selected.map(a => a.id)) });
}
/** Los animales de una región que la máscara selecciona, en orden canónico. */
export function seleccionDe(mascara: MascaraFauna, animales: readonly Animal[]): Animal[] {
  return animales.filter(a => mascara.ids.has(a.id)).sort(canonical);
}

/** Active cells only; canonical decisions and flee-before-contact movement make array order irrelevant.
 * `mascara` es la del coordinador para este paso; sin ella se calcula aquí, con el mismo resultado. */
export function stepAnimals(world: AnimalWorld, emit?: AnimalEmitter, mascara?: MascaraFauna): void {
  if (world.animals.length > limitsOf(world).fauna) throw new Error('Capacidad regional de fauna excedida.');
  const state: LocalState = { tile: tileLookup(world.tiles), occupants: new Map(), counts: new Map() };
  const m = mascara ?? calcularMascara(world, false);
  if (m.tick !== world.tick || m.animales !== world.animals || m.poblacion !== world.animals.length || mascara && !mismosObjetos(world.animals, m.orden))
    throw new Error('Máscara de fauna de otro paso.');
  for (const animal of world.animals) {
    const tile = state.tile(animal.x, animal.y);
    if (!tile) throw new Error('Animal fuera de las regiones activas.');
    if (m.ids.has(animal.id)) physiology(animal, tile, world, emit);
    if (animal.health <= 0) continue;
    const p = cell(animal), here = state.occupants.get(p);
    if (here) here.push(animal); else state.occupants.set(p, [animal]);
    state.counts.set(p, (state.counts.get(p) ?? 0) + 1);
  }
  world.animals = world.animals.filter(a => a.health > 0);
  const active = m.seleccion.filter(a => a.health > 0);
  // Oldest decision first avoids starvation while preventing a synchronized migration from bursting every eighth tick.
  const due = active.filter(a => world.tick - a.lastDecision >= 8)
    .sort((a, b) => a.lastDecision - b.lastDecision || canonical(a, b)).slice(0, MAX_ANIMAL_DECISIONS_PER_TICK);
  for (const animal of due) choose(animal, world, state);
  // Cadena secuencial (ver `move`): permanece en la fase serial del coordinador.
  for (const animal of [...active].sort((a, b) => Number(b.action === 'flee') - Number(a.action === 'flee') || canonical(a, b))) move(animal, world, state);
  const byId = new Map(world.animals.map(a => [a.id, a]));
  for (const animal of active) {
    if (animal.health <= 0) continue;
    const tile = state.tile(animal.x, animal.y)!;
    feed(animal, tile, world);
    if (animal.action !== 'hunt' || !animal.preyId) continue;
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
  reproduce(world, state, active, emit); ordenCanonico(world.animals, previos); syncFauna(world.tiles, world.animals);
}

/** A human hunt removes exactly one living identity on the requested cell, at most once. */
export function harvestAt(world: AnimalWorld, point: Point, hunterId: string, emit?: AnimalEmitter): number {
  const victim = world.animals.filter(a => a.x === point.x && a.y === point.y && a.health > 0).sort(canonical)[0];
  if (!victim || !world.tiles.some(t => t.x === point.x && t.y === point.y)) return 0;
  death(world, victim, 'caza humana', emit, hunterId); world.animalDynamics.humanHunts++;
  world.animals = world.animals.filter(a => a.id !== victim.id); syncFauna(world.tiles, world.animals);
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
