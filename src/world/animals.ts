import type { AnimalAction, AnimalDynamics, AnimalGenes, AnimalSpecies, AnimalView } from '../shared/life.js';
import type { ChronicleEvent, Tile } from '../shared/types.js';
import { FOOD_PER_ANIMAL } from './ecosystem.js';
import { advanceNeeds } from './needs.js';
import { MAX_COORDINATE } from './terrain.js';

export const MAX_ACTIVE_ANIMALS = 8192;
export const MAX_ANIMALS_PER_TILE = 6;
// Identity capacity follows the world's 65,536 active cells, independently of per-tick work.
export const MAX_STORED_ANIMALS = 65536 * MAX_ANIMALS_PER_TILE;
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

/** Compatibility projection only. Mixed-species totals must be counted from identities, not this representative species. */
export function syncFauna(tiles: Tile[], animals: Animal[]): void {
  const counts = new Map<string, { count: number; species: AnimalSpecies }>();
  for (const animal of animals) {
    const p = key(animal), existing = counts.get(p);
    if (existing) { existing.count++; if (animal.species < existing.species) existing.species = animal.species; }
    else counts.set(p, { count: 1, species: animal.species });
    if (counts.get(p)!.count > MAX_ANIMALS_PER_TILE) throw new Error('Capacidad local de fauna excedida.');
  }
  for (const tile of tiles) {
    const count = counts.get(key(tile));
    tile.fauna = count?.count ?? 0;
    if (count) tile.species = count.species; else delete tile.species;
  }
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
  animal.memory = animal.memory.filter(m => key(m) !== key(tile) && tick - m.tick <= MEMORY_TTL);
  animal.memory.push({ x: tile.x, y: tile.y, tick, food: tile.growth ?? tile.vegetation, water: waterAt(animal, tile), visited: visited || !!existing?.visited });
  if (animal.memory.length > MAX_ANIMAL_MEMORY) animal.memory.shift();
}
interface LocalState { tiles: Map<string, Tile>; occupants: Map<string, Animal[]>; counts: Map<string, number>; }
const terrainIndexes = new WeakMap<AnimalWorld, { tiles: Tile[]; length: number; index: Map<string, Tile> }>();
function terrainIndex(world: AnimalWorld): Map<string, Tile> {
  let entry = terrainIndexes.get(world);
  if (!entry || entry.tiles !== world.tiles || entry.length !== world.tiles.length) {
    entry = { tiles: world.tiles, length: world.tiles.length, index: new Map(world.tiles.map(t => [key(t), t])) };
    terrainIndexes.set(world, entry);
  }
  return entry.index;
}
function localTiles(animal: Animal, state: LocalState): Tile[] {
  const radius = 2 + Math.floor(animal.genes.perception * 4), result: Tile[] = [];
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    if (Math.abs(dx) + Math.abs(dy) > radius) continue;
    const tile = state.tiles.get(`${animal.x + dx},${animal.y + dy}`);
    if (tile && habitat(animal, tile)) result.push(tile);
  }
  return result;
}
function choose(animal: Animal, world: AnimalWorld, state: LocalState): void {
  const visible = localTiles(animal, state), near = visible.flatMap(t => state.occupants.get(key(t)) ?? []).filter(a => a.id !== animal.id && a.health > 0);
  const threats = near.filter(a => edible(a, animal) && distance(a, animal) <= 1 + Math.floor(animal.genes.perception * 5));
  const adjacent = visible.filter(t => distance(t, animal) === 1 && (state.counts.get(key(t)) ?? 0) < MAX_ANIMALS_PER_TILE);
  let action: AnimalAction = 'roam', target: Point = animal, reason = 'Explora celdas cercanas y evita recorridos que recuerda.';
  let preyId: string | null = null;
  for (const tile of visible.filter(t => (t.growth ?? 0) > 0.05 || waterAt(animal, t) > 0.005)
    .sort((a, b) => (waterAt(animal, b) + (b.growth ?? 0)) - (waterAt(animal, a) + (a.growth ?? 0)) || distance(a, animal) - distance(b, animal) || a.y - b.y || a.x - b.x).slice(0, 2)) remember(animal, tile, world.tick, distance(tile, animal) === 0);
  if (threats.length) {
    const safety = (p: Point): number => Math.min(...threats.map(t => distance(t, p)));
    const escape = adjacent.sort((a, b) => safety(b) - safety(a) || a.y - b.y || a.x - b.x)[0];
    action = 'flee'; target = escape && safety(escape) > safety(animal) ? escape : animal;
    reason = 'Percibe un depredador cercano y se aleja físicamente de su alcance.';
  } else {
    const resources = [...visible.map(t => ({ x: t.x, y: t.y, food: t.growth ?? t.vegetation, water: waterAt(animal, t) })),
      ...animal.memory.filter(m => world.tick - m.tick <= MEMORY_TTL && state.tiles.has(key(m)) && !visible.some(t => key(t) === key(m)))];
    const water = resources.filter(t => t.water > 0.001).sort((a, b) => distance(a, animal) - distance(b, animal) || b.water - a.water || a.y - b.y || a.x - b.x)[0];
    const food = resources.filter(t => t.food > 0.001).sort((a, b) => distance(a, animal) - distance(b, animal) || b.food - a.food || a.y - b.y || a.x - b.x)[0];
    const prey = near.filter(a => edible(animal, a)).sort((a, b) => distance(a, animal) - distance(b, animal) || canonical(a, b))[0];
    if (animal.thirst > 0.42 && water) { action = 'drink'; target = water; reason = 'La sed orienta su camino hacia agua percibida o recordada.'; }
    else if (animal.hunger > 0.38 && prey) { action = 'hunt'; target = prey; preyId = prey.id; reason = 'Persigue una presa individual visible; alimentarse exige alcanzarla.'; }
    else if (animal.hunger > 0.38 && animal.genes.carnivory < 0.6 && food) { action = 'graze'; target = food; reason = 'El hambre orienta su camino hacia crecimiento vegetal finito.'; }
    else if (animal.energy < 0.4 || animal.fatigue > 0.55) { action = 'rest'; reason = 'El agotamiento requiere una pausa; descansar no elimina hambre ni sed.'; }
    else {
      const novelty = (t: Tile): number => {
        const visit = animal.memory.find(m => m.visited && key(m) === key(t));
        return (visit ? Math.min(1, (world.tick - visit.tick) / MEMORY_TTL) : 2) + hash(world.seed, `${animal.id}:${key(t)}:${Math.floor(world.tick / 60)}`) / 4294967296 * 0.2;
      };
      target = adjacent.sort((a, b) => novelty(b) - novelty(a) || a.y - b.y || a.x - b.x)[0] ?? animal;
    }
  }
  if (animal.action !== action || animal.preyId !== preyId) animal.work = 0;
  animal.action = action; animal.target = { x: target.x, y: target.y }; animal.reason = reason; animal.preyId = preyId; animal.lastDecision = world.tick;
}
function move(animal: Animal, world: AnimalWorld, state: LocalState): void {
  const interval = Math.ceil(11 - animal.genes.speed * 7 + animal.fatigue * 3);
  if (animal.action === 'rest' || distance(animal, animal.target) === 0 || world.tick - animal.lastMove < interval || animal.energy < 0.06) return;
  const neighbors = [[0, -1], [-1, 0], [1, 0], [0, 1]].map(([dx, dy]) => state.tiles.get(`${animal.x + dx},${animal.y + dy}`))
    .filter((t): t is Tile => !!t && habitat(animal, t) && (state.counts.get(key(t)) ?? 0) < MAX_ANIMALS_PER_TILE);
  neighbors.sort((a, b) => distance(a, animal.target) - distance(b, animal.target) || a.y - b.y || a.x - b.x);
  const next = neighbors[0];
  if (!next) return;
  remember(animal, state.tiles.get(key(animal))!, world.tick, true);
  state.counts.set(key(animal), state.counts.get(key(animal))! - 1);
  state.occupants.set(key(animal), (state.occupants.get(key(animal)) ?? []).filter(a => a.id !== animal.id));
  animal.x = next.x; animal.y = next.y; animal.lastMove = world.tick;
  state.counts.set(key(animal), (state.counts.get(key(animal)) ?? 0) + 1);
  state.occupants.set(key(animal), [...(state.occupants.get(key(animal)) ?? []), animal]);
  animal.energy = clamp(animal.energy - (animal.action === 'flee' ? 0.003 : 0.0015));
  animal.fatigue = clamp(animal.fatigue + (animal.action === 'flee' ? 0.004 : 0.002));
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
    animal.hunger = clamp(animal.hunger - consumed * 4 * (1 - animal.genes.carnivory));
    animal.energy = clamp(animal.energy + consumed * 0.8);
    world.animalDynamics.plantConsumed += consumed;
    // Plant water is finite and belongs to this patch, never to an invisible drinking reservoir.
    if (animal.species !== 'fish') {
      const moisture = Math.min(tile.moisture, consumed * 3);
      tile.moisture = clamp(tile.moisture - moisture); animal.thirst = clamp(animal.thirst - moisture * 0.3);
      world.animalDynamics.waterConsumed += moisture * 0.1;
    }
    if (animal.hunger < 0.15 || (tile.growth ?? 0) <= 0.001) animal.lastDecision = world.tick - 12;
  } else if (animal.action === 'drink') {
    const water = takeWater(animal, tile, Math.min(0.0016, animal.thirst / 3));
    animal.thirst = clamp(animal.thirst - water * 3); world.animalDynamics.waterConsumed += water;
    if (animal.thirst < 0.15 || water <= 0) animal.lastDecision = world.tick - 12;
  } else if (animal.action === 'rest') {
    animal.fatigue = clamp(animal.fatigue - 0.002);
    animal.energy = clamp(animal.energy + 0.0015 * clamp((1 - Math.max(animal.hunger, animal.thirst)) / 0.5));
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
    const tile = state.tiles.get(key(a))!;
    if ((state.counts.get(key(a)) ?? 0) >= MAX_ANIMALS_PER_TILE || waterAt(a, tile) < 0.012
      || (tile.growth ?? 0) < 0.08) continue;
    const neighbors = [[0, 0], [0, -1], [-1, 0], [1, 0], [0, 1]].flatMap(([dx, dy]) => state.occupants.get(`${a.x + dx},${a.y + dy}`) ?? []);
    const b = neighbors.filter(b => b.id !== a.id && b.species === a.species && eligible(b)).sort(canonical)[0];
    if (!b) continue;
    capacity ??= Math.min(MAX_STORED_ANIMALS, world.tiles.filter(t => t.terrain !== 'shelter' && (t.growth ?? 0) > 0.04).length * 3);
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
    world.animals.push(child); state.counts.set(key(a), (state.counts.get(key(a)) ?? 0) + 1); world.animalDynamics.births++;
    emit?.({ kind: 'animal', actors: [...parents, id], x: a.x, y: a.y, text: `Nace ${a.species} de generación ${child.generation}.`, cause: 'reproducción con costes corporales, alimento y agua', source: 'simulation' });
  }
}

/** Active cells only; canonical decisions and flee-before-contact movement make array order irrelevant. */
export function stepAnimals(world: AnimalWorld, emit?: AnimalEmitter): void {
  if (world.animals.length > MAX_STORED_ANIMALS) throw new Error('Capacidad regional de fauna excedida.');
  const state: LocalState = { tiles: terrainIndex(world), occupants: new Map(), counts: new Map() };
  world.animals.sort(canonical);
  const population = world.animals.length;
  const offset = population ? ((world.tick % population) * MAX_ACTIVE_ANIMALS) % population : 0;
  const selected = population <= MAX_ACTIVE_ANIMALS ? [...world.animals]
    : [...world.animals.slice(offset, offset + MAX_ACTIVE_ANIMALS), ...world.animals.slice(0, Math.max(0, offset + MAX_ACTIVE_ANIMALS - population))].sort(canonical);
  const selectedIds = new Set(selected.map(a => a.id));
  for (const animal of world.animals) {
    const tile = state.tiles.get(key(animal));
    if (!tile) throw new Error('Animal fuera de las regiones activas.');
    if (selectedIds.has(animal.id)) physiology(animal, tile, world, emit);
    if (animal.health <= 0) continue;
    const p = key(animal); state.occupants.set(p, [...(state.occupants.get(p) ?? []), animal]); state.counts.set(p, (state.counts.get(p) ?? 0) + 1);
  }
  world.animals = world.animals.filter(a => a.health > 0);
  const active = selected.filter(a => a.health > 0);
  // Oldest decision first avoids starvation while preventing a synchronized migration from bursting every eighth tick.
  const due = active.filter(a => world.tick - a.lastDecision >= 8)
    .sort((a, b) => a.lastDecision - b.lastDecision || canonical(a, b)).slice(0, MAX_ANIMAL_DECISIONS_PER_TICK);
  for (const animal of due) choose(animal, world, state);
  for (const animal of [...active].sort((a, b) => Number(b.action === 'flee') - Number(a.action === 'flee') || canonical(a, b))) move(animal, world, state);
  const byId = new Map(world.animals.map(a => [a.id, a]));
  for (const animal of active) {
    if (animal.health <= 0) continue;
    const tile = state.tiles.get(key(animal))!;
    feed(animal, tile, world);
    if (animal.action !== 'hunt' || !animal.preyId) continue;
    const prey = byId.get(animal.preyId);
    // A resident prey is physically reachable even when its own routine is deferred; archived animals are absent from byId.
    if (!prey || prey.health <= 0 || !edible(animal, prey) || distance(animal, prey) > 0) { animal.work = 0; continue; }
    animal.work++; animal.energy = clamp(animal.energy - 0.0008); animal.fatigue = clamp(animal.fatigue + 0.001);
    if (animal.work < 4) continue;
    animal.work = 0; prey.health = clamp(prey.health - (0.18 + animal.genes.speed * 0.08 - prey.genes.camouflage * 0.05));
    if (prey.health > 0) continue;
    death(world, prey, 'depredación', emit, animal.id); world.animalDynamics.predations++;
    state.counts.set(key(prey), state.counts.get(key(prey))! - 1);
    animal.hunger = clamp(animal.hunger - FOOD_PER_ANIMAL[prey.species] * 4.8 * animal.genes.carnivory);
    animal.energy = clamp(animal.energy + FOOD_PER_ANIMAL[prey.species] * 0.5); animal.lastDecision = world.tick - 12;
  }
  world.animals = world.animals.filter(a => a.health > 0);
  reproduce(world, state, active, emit); world.animals.sort(canonical); syncFauna(world.tiles, world.animals);
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
export function assertAnimals(value: unknown, tick: number, tiles?: Tile[]): asserts value is Animal[] {
  if (!Array.isArray(value) || value.length > MAX_STORED_ANIMALS) throw new Error('Colección de fauna inválida.');
  const ids = new Set<string>(), counts = new Map<string, number>(), positions = tiles && new Map(tiles.map(t => [key(t), t]));
  for (const animal of value) {
    assertAnimal(animal, tick);
    const p = key(animal), count = (counts.get(p) ?? 0) + 1;
    if (ids.has(animal.id) || count > MAX_ANIMALS_PER_TILE || positions && !positions.has(p)) throw new Error('Identidad, región o capacidad animal inválida.');
    ids.add(animal.id); counts.set(p, count);
  }
}
