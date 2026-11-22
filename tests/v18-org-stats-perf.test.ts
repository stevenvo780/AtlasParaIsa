import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Action, Tile } from '../src/shared/types.js';
import type { TechnologyState } from '../src/shared/technology.js';
import { createWorld, type Person, type World } from '../src/world/index.js';
import { CHUNK_SIZE, MAX_COORDINATE } from '../src/world/terrain.js';
import { regionesSinAgua } from '../src/world/agua.js';
import { CONDUCTA_DIMENSIONS, OFICIOS_CATEGORIAS, indiceDiversidad, vectorConducta } from '../src/world/diversidad.js';
import { ESTADISTICAS_CARAS_CADA_TICKS, distanciaMediaAgua, giniRecursosPorRegion, worldStatistics } from '../src/world/statistics.js';
import { analyzeTechnologyOrganization, observeTechnologyOrganization } from '../src/world/technology-organization.js';
import { assertTechnologyCheckpoint, captureTechnologyCheckpoint } from '../src/world/technology-checkpoint.js';
import { defaultTechnologyState, initialTechnologyKnowledge, recordTechnologyBenefit, researchTechnology, settleTechnologyEstate, transferTechnologyItem, useTool,
  type TechnologyActor, type TechnologyHost, type TechnologyProgram } from '../src/world/technology.js';
import { PROGRAMA_FILO as edge, proyectoInvestigacion } from './lib/escenas.js';

/**
 * V18 (Lane 7): coste de proyección, estadísticas y organización en mundos masivos.
 *
 * `observeTechnologyOrganization`, `regionesSinAgua`, `vectorConducta`/`indiceDiversidad`,
 * `giniRecursosPorRegion`, `distanciaMediaAgua` y `worldStatistics` se reescribieron sin
 * alocaciones por tesela/habitante/evento. Cota de equivalencia (0 ULP):
 *  - las funciones pequeñas se comparan bit a bit (`Object.is`) con una copia literal de la
 *    implementación anterior, incluida en este fichero (`ref*`), sobre fixtures deterministas;
 *  - la observación de organización tecnológica y `worldStatistics` se comparan con resúmenes
 *    SHA-256 (`GOLDEN`) calculados con el código anterior sobre los mismos fixtures, tanto en
 *    casos válidos como en mundos corruptos (45 mutaciones × 3 escenas) que ejercen los 22 diagnósticos fail-closed.
 *    Para regenerarlos: `V18_PRINT_GOLDEN=1 npx tsx --test tests/v18-org-stats-perf.test.ts`.
 */

// ---------------------------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------------------------
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Serialización que distingue -0, NaN, ±Infinity y `undefined`, para que el resumen sea bit a bit. */
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) => {
  if (typeof item === 'number' && (!Number.isFinite(item) || Object.is(item, -0))) return `n:${String(item)}${Object.is(item, -0) ? '-0' : ''}`;
  return item === undefined ? '__undefined__' : item;
})).digest('hex').slice(0, 16);
const PRINT_GOLDEN = process.env.V18_PRINT_GOLDEN === '1';
const printed: Record<string, string> = {};
function golden(name: string, value: unknown): void {
  const actual = digest(value);
  if (PRINT_GOLDEN) { printed[name] = actual; return; }
  assert.equal(actual, GOLDEN[name], `${name}: la salida cambió respecto al código anterior a V18 (${actual})`);
}
/** Mejor tiempo (ms) de `repeats` ejecuciones: el laboratorio comparte CPU y la media sería ruido. */
function best(repeats: number, run: () => void): number {
  let min = Infinity;
  for (let i = 0; i < repeats; i++) { const start = performance.now(); run(); min = Math.min(min, performance.now() - start); }
  return min;
}
const same = (actual: number, expected: number, label: string): void => assert.ok(Object.is(actual, expected), `${label}: ${actual} ≠ ${expected}`);

// ---------------------------------------------------------------------------------------------
// Implementaciones de referencia: copia literal del código anterior a V18
// ---------------------------------------------------------------------------------------------
const refRegionKey = (x: number, y: number, tamRegion: number): string => `${Math.floor(x / tamRegion)},${Math.floor(y / tamRegion)}`;
function refRegionesSinAgua(tiles: readonly Tile[], tamRegion = 16): number {
  const regiones = new Map<string, { tierra: boolean; agua: boolean }>();
  for (const tile of tiles) {
    const clave = refRegionKey(tile.x, tile.y, tamRegion);
    const entrada = regiones.get(clave) ?? { tierra: false, agua: false };
    if (tile.terrain !== 'water') entrada.tierra = true;
    if ((tile.drinkingWater ?? 0) > 0) entrada.agua = true;
    regiones.set(clave, entrada);
  }
  const conTierra = [...regiones.values()].filter(r => r.tierra);
  if (conTierra.length === 0) return 0;
  let sinAgua = 0;
  for (const r of conTierra) if (!r.agua) sinAgua++;
  return sinAgua / conTierra.length;
}

const ACTIONS: readonly Action[] = ['explore', 'eat', 'forage', 'drink', 'hunt', 'rest', 'approach', 'accompany', 'retreat', 'share', 'gather', 'farm', 'build', 'cooperate', 'invent', 'repair', 'research', 'craft'];
const FOOD_ACTIONS: readonly Action[] = ['eat', 'forage', 'hunt', 'farm', 'gather', 'share'];
const PLACE_BUCKETS = 6;
function refHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  return hash >>> 0;
}
const refSquash = (x: number): number => x / (1 + Math.abs(x));
function refPush(vector: number[], group: readonly number[]): void {
  const norm = Math.sqrt(group.reduce((sum, x) => sum + x * x, 0));
  for (const x of group) vector.push(norm > 0 ? x / norm : 0);
}
function refDominant(person: Person): Action | null {
  let bestAction: Action | null = null;
  for (const action of ACTIONS) {
    const count = person.activity[action] ?? 0;
    if (count > 0 && count > (bestAction ? person.activity[bestAction] ?? 0 : 0)) bestAction = action;
  }
  return bestAction;
}
function refVectorConducta(person: Person): number[] {
  const vector: number[] = [];
  const totalActivity = ACTIONS.reduce((sum, action) => sum + (person.activity[action] ?? 0), 0);
  refPush(vector, ACTIONS.map(action => totalActivity > 0 ? (person.activity[action] ?? 0) / totalActivity : 0));
  const dominant = refDominant(person);
  refPush(vector, ACTIONS.map(action => action === dominant ? 1 : 0));
  const competence = Object.values(person.technology.competence);
  const meanSuccessRate = competence.length ? competence.reduce((sum, c) => sum + c.successes / Math.max(1, c.attempts), 0) / competence.length : 0;
  const meanBenefit = competence.length ? competence.reduce((sum, c) => sum + c.benefit, 0) / competence.length : 0;
  const itemsMass = person.technology.items.reduce((sum, item) => sum + item.mass, 0);
  refPush(vector, [refSquash(person.technology.knownRecipes.length), meanSuccessRate, refSquash(meanBenefit), refSquash(person.technology.items.length), refSquash(itemsMass)]);
  refPush(vector, FOOD_ACTIONS.map(action => person.skills[action] ?? 0));
  const buckets = new Array(PLACE_BUCKETS).fill(0) as number[];
  const withPlace = person.experiences.filter(experience => experience.placeId !== '');
  for (const experience of withPlace) buckets[refHash(experience.placeId) % PLACE_BUCKETS] += 1;
  refPush(vector, buckets.map(count => withPlace.length > 0 ? count / withPlace.length : 0));
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  return norm > 0 ? vector.map(x => x / norm) : vector;
}
function refMeanCosineDistance(vectors: readonly (readonly number[])[]): number {
  const n = vectors.length;
  if (n < 2) return 0;
  const dim = vectors[0]!.length;
  const sumVec = new Float64Array(dim);
  let nonZero = 0, zero = 0, sumNormSq = 0;
  for (let i = 0; i < n; i++) {
    const v = vectors[i]!;
    let normSq = 0;
    for (let k = 0; k < dim; k++) { const x = v[k]!; normSq += x * x; }
    if (normSq === 0) { zero++; continue; }
    nonZero++;
    const invNorm = 1 / Math.sqrt(normSq);
    let unitNormSq = 0;
    for (let k = 0; k < dim; k++) { const u = v[k]! * invNorm; sumVec[k]! += u; unitNormSq += u * u; }
    sumNormSq += unitNormSq;
  }
  let sumSq = 0;
  for (let k = 0; k < dim; k++) { const s = sumVec[k]!; sumSq += s * s; }
  const pairs = (n * (n - 1)) / 2;
  const nonZeroDist = nonZero >= 2 ? Math.max(0, (nonZero * sumNormSq - sumSq) / 2) : 0;
  return Math.max(0, Math.min(1, (zero * nonZero + nonZeroDist) / pairs));
}
function refIndiceDiversidad(world: World): { conducta: number; oficios: number; total: number } {
  const people = world.people;
  if (people.length < 2) return { conducta: 0, oficios: 0, total: 0 };
  const conducta = refMeanCosineDistance(people.map(person => refVectorConducta(person)));
  const counts = new Map<string, number>();
  for (const person of people) { const label = refDominant(person) ?? ''; counts.set(label, (counts.get(label) ?? 0) + 1); }
  let entropy = 0;
  if (counts.size > 1) {
    for (const count of counts.values()) { const share = count / people.length; entropy -= share * Math.log(share); }
    entropy = Math.min(1, entropy / Math.log(OFICIOS_CATEGORIAS));
  }
  return { conducta, oficios: entropy, total: (conducta + entropy) / 2 };
}

const POSITION_STRIDE = 2 * MAX_COORDINATE + 1, REGION_LIMIT = Math.ceil(MAX_COORDINATE / CHUNK_SIZE), REGION_STRIDE = 2 * REGION_LIMIT + 1;
const refPackPosition = (x: number, y: number): number => (x + MAX_COORDINATE) * POSITION_STRIDE + (y + MAX_COORDINATE);
const refPackRegion = (x: number, y: number): number => (Math.floor(x / CHUNK_SIZE) + REGION_LIMIT) * REGION_STRIDE + (Math.floor(y / CHUNK_SIZE) + REGION_LIMIT);
const REF_NEIGHBORS: readonly (readonly [number, number])[] = [[0, -1], [-1, 0], [1, 0], [0, 1]];
function refGini(tiles: readonly Tile[]): number {
  const totals = new Map<number, number>();
  for (const tile of tiles) { const region = refPackRegion(tile.x, tile.y); totals.set(region, (totals.get(region) ?? 0) + tile.food); }
  const values = [...totals.values()].sort((left, right) => left - right), n = values.length;
  if (n === 0) return 0;
  let sum = 0, weighted = 0;
  for (let i = 0; i < n; i++) { const value = values[i]!; sum += value; weighted += (i + 1) * value; }
  if (sum === 0) return 0;
  return 2 * weighted / (n * sum) - (n + 1) / n;
}
function refDistanciaMediaAgua(tiles: readonly Tile[]): number {
  const count = tiles.length, index = new Map<number, number>();
  for (let i = 0; i < count; i++) { const tile = tiles[i]!; index.set(refPackPosition(tile.x, tile.y), i); }
  const distances = new Int32Array(count).fill(-1), queue = new Int32Array(count);
  let tail = 0;
  for (let i = 0; i < count; i++) { const tile = tiles[i]!; if ((tile.drinkingWater ?? 0) > 0) { distances[i] = 0; queue[tail++] = i; } }
  if (tail === 0) return -1;
  for (let head = 0; head < tail; head++) {
    const tile = tiles[queue[head]!]!, next = distances[queue[head]!]! + 1;
    for (const [dx, dy] of REF_NEIGHBORS) {
      const neighbor = index.get(refPackPosition(tile.x + dx, tile.y + dy));
      if (neighbor === undefined || distances[neighbor]! >= 0) continue;
      distances[neighbor] = next; queue[tail++] = neighbor;
    }
  }
  let land = 0, total = 0;
  for (let i = 0; i < count; i++) if (tiles[i]!.terrain !== 'water' && distances[i]! >= 0) { land++; total += distances[i]!; }
  return land === 0 ? 0 : total / land;
}

// ---------------------------------------------------------------------------------------------
// Fixtures de teselas y habitantes
// ---------------------------------------------------------------------------------------------
type Order = 'row' | 'chunk' | 'shuffle';
const BIOMES = ['grassland', 'forest', 'desert', 'mountain', 'wetland', 'ocean'] as const;
const FEATURES = ['tree', 'pine', 'palm', 'cactus', 'reeds', 'berries', 'flowers', 'rock', 'clay', 'stump', 'spring', 'pool', 'none'] as const;
function makeTiles(seed: number, width: number, height: number, order: Order, ox = 0, oy = 0): Tile[] {
  const rand = rng(seed), tiles: Tile[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const noise = rand(), water = noise < 0.18;
    const tile: Tile = { x: ox + x, y: oy + y, terrain: water ? 'water' : noise < 0.6 ? 'meadow' : 'soil', moisture: rand(), vegetation: rand(), food: rand() < 0.3 ? 0 : rand() * 0.5,
      biome: BIOMES[Math.floor(rand() * BIOMES.length)]!, feature: FEATURES[Math.floor(rand() * FEATURES.length)]!, cultivation: rand() * 0.3, traffic: rand() * 0.3 };
    // La tercera parte con `drinkingWater` ausente, el resto repartido entre 0 y positivo (algunas en el mar: no cuentan como fuente).
    const water01 = rand();
    if (water01 > 0.33) tile.drinkingWater = water01 > 0.985 ? 0.2 + rand() : water01 > 0.6 ? 0 : -0;
    tiles.push(tile);
  }
  if (order === 'chunk') {
    const keyOf = (t: Tile): number => Math.floor((t.y - oy) / CHUNK_SIZE) * 1e6 + Math.floor((t.x - ox) / CHUNK_SIZE);
    tiles.sort((a, b) => keyOf(a) - keyOf(b) || (a.y - b.y) || (a.x - b.x));
  } else if (order === 'shuffle') {
    for (let i = tiles.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [tiles[i], tiles[j]] = [tiles[j]!, tiles[i]!]; }
  }
  return tiles;
}
const tileAt = (x: number, y: number, extra: Partial<Tile> = {}): Tile => ({ x, y, terrain: 'meadow', moisture: 0.5, vegetation: 0.5, food: 0.25, ...extra });

interface TileCase { name: string; tiles: Tile[]; }
function tileCases(): TileCase[] {
  const cases: TileCase[] = [];
  for (const order of ['row', 'chunk', 'shuffle'] as const) {
    cases.push({ name: `mundo ${order}`, tiles: makeTiles(11, 80, 64, order) });
    cases.push({ name: `mundo ${order} con coordenadas negativas`, tiles: makeTiles(12, 50, 70, order, -37, -61) });
  }
  const dup = makeTiles(13, 20, 20, 'row'); dup.push(...makeTiles(14, 10, 10, 'row', 5, 5)); // posiciones repetidas: gana la última
  cases.push({ name: 'posiciones repetidas', tiles: dup });
  cases.push({ name: 'vacío', tiles: [] });
  cases.push({ name: 'una tesela', tiles: [tileAt(3, 4, { drinkingWater: 1 })] });
  cases.push({ name: 'sin ninguna fuente', tiles: makeTiles(15, 30, 30, 'row').map(t => ({ ...t, drinkingWater: 0 })) });
  cases.push({ name: 'todo mar', tiles: makeTiles(16, 30, 30, 'row').map(t => ({ ...t, terrain: 'water' as const })) });
  cases.push({ name: 'solo mar con agua potable', tiles: [tileAt(0, 0, { terrain: 'water', drinkingWater: 1 }), tileAt(1, 0, { terrain: 'water' })] });
  cases.push({ name: 'agua antes que tierra en la región', tiles: [tileAt(0, 0, { terrain: 'water', drinkingWater: 2 }), tileAt(1, 0), tileAt(40, 40), tileAt(41, 40, { terrain: 'water', drinkingWater: 1 })] });
  cases.push({ name: 'islas dispersas (rejilla demasiado vacía)', tiles: [...makeTiles(17, 12, 12, 'row', 0, 0), ...makeTiles(18, 12, 12, 'row', 5000, -4000), ...makeTiles(19, 12, 12, 'row', -90000, 70000)] });
  cases.push({ name: 'borde del mundo', tiles: [tileAt(MAX_COORDINATE - 1, MAX_COORDINATE - 1, { drinkingWater: 1 }), tileAt(MAX_COORDINATE - 2, MAX_COORDINATE - 1), tileAt(-MAX_COORDINATE, -MAX_COORDINATE), tileAt(-MAX_COORDINATE + 1, -MAX_COORDINATE, { drinkingWater: 1 }), tileAt(-MAX_COORDINATE, MAX_COORDINATE - 1), tileAt(-MAX_COORDINATE + 1, MAX_COORDINATE - 1)] });
  cases.push({ name: 'coordenadas extremas y no finitas', tiles: [tileAt(1e12, 3), tileAt(1e12 + 5, 3, { drinkingWater: 1 }), tileAt(NaN, 1), tileAt(NaN, 2, { drinkingWater: 1 }), tileAt(Infinity, 0), tileAt(-Infinity, 0, { drinkingWater: 1 }), tileAt(2 ** 40, -(2 ** 40)), tileAt(-(2 ** 26), 0), tileAt(2 ** 25, 0, { drinkingWater: 1 }), tileAt(16 * 2 ** 25 - 1, 0), tileAt(-16 * 2 ** 25, 5, { drinkingWater: 1 }), tileAt(0, 0)] });
  cases.push({ name: 'coordenadas fraccionarias', tiles: [tileAt(0.5, 0.5, { drinkingWater: 1 }), tileAt(1.5, 0.5), tileAt(15.9, 15.9), tileAt(16.1, 0), tileAt(-0.5, -0.5), tileAt(-0, -0)] });
  return cases;
}

function makePeople(seed: number, count: number): Person[] {
  const rand = rng(seed), source = createWorld(7).people.filter(p => p.role === 'neighbor');
  const places = ['', 'lugar-norte', 'lugar-sur', 'río', 'bosque', 'cueva', 'aldea', 'p7', 'p8', 'p9', 'ñandú'];
  const people: Person[] = [];
  for (let i = 0; i < count; i++) {
    const person: Person = structuredClone(source[i % source.length]!);
    person.id = `v18-${i}`; person.x = Math.floor(rand() * 400); person.y = Math.floor(rand() * 400);
    person.hunger = rand(); person.energy = rand(); person.fatigue = rand(); person.thirst = rand();
    person.materials = { wood: Math.floor(rand() * 9), stone: Math.floor(rand() * 9) };
    person.role = i % 97 === 0 ? 'I' : 'neighbor';
    person.demography = { ...person.demography, age: i % 53 === 0 ? undefined as unknown as number : rand() * 40 * 1000 };
    const mode = i % 6;
    person.activity = {};
    if (mode !== 0) for (const action of ACTIONS) if (rand() < 0.4) person.activity[action] = mode === 1 ? 3 : Math.floor(rand() * 50); // `mode 1`: empates exactos
    if (mode === 2) person.activity['no-es-una-accion'] = 99;
    if (mode === 3) person.activity = { [ACTIONS[i % ACTIONS.length]!]: 7 };
    person.skills = {}; for (const action of FOOD_ACTIONS) if (rand() < 0.6) person.skills[action] = rand();
    person.technology = initialTechnologyKnowledge();
    person.technology.knownRecipes = Array.from({ length: Math.floor(rand() * 5) }, (_, k) => `recipe-${k}`);
    for (let k = 0; k < Math.floor(rand() * 4); k++) person.technology.competence[`recipe-${k}`] = { attempts: Math.floor(rand() * 5), successes: Math.floor(rand() * 4), work: rand(), benefit: rand() * 3 };
    person.technology.items = Array.from({ length: Math.floor(rand() * 3) }, (_, k) => ({ id: `product-${i}-${k}`, mass: Math.floor(rand() * 900), recipeId: null, composition: { wood: 0, stone: 0, water: 0 } } as never));
    person.experiences = Array.from({ length: Math.floor(rand() * 7) }, (_, k) => ({ tick: k, text: 'x', causeId: 'c', placeId: places[Math.floor(rand() * places.length)]! }));
    people.push(person);
  }
  return people;
}
const worldWith = (seed: number, people: Person[], tiles?: Tile[]): World => {
  const world = createWorld(seed);
  world.people = people;
  if (tiles) world.tiles = tiles;
  return world;
};

// ---------------------------------------------------------------------------------------------
// Pruebas de equivalencia: agua, teselas y diversidad
// ---------------------------------------------------------------------------------------------
test('V18 regionesSinAgua: idéntica a la versión con claves de cadena en todos los órdenes y coordenadas', () => {
  for (const { name, tiles } of tileCases()) {
    for (const tam of [16, 7, 1, 3.5, 0.5, 100, 0]) same(regionesSinAgua(tiles, tam), refRegionesSinAgua(tiles, tam), `${name}, región ${tam}`);
    same(regionesSinAgua(tiles), refRegionesSinAgua(tiles), `${name}, región por defecto`);
  }
});

test('V18 giniRecursosPorRegion y distanciaMediaAgua: 0 ULP frente a la versión anterior', () => {
  for (const { name, tiles } of tileCases()) {
    same(giniRecursosPorRegion(tiles), refGini(tiles), `gini, ${name}`);
    same(distanciaMediaAgua(tiles), refDistanciaMediaAgua(tiles), `distancia, ${name}`);
  }
});

test('V18 vectorConducta: cada componente coincide bit a bit con la versión con arreglos temporales', () => {
  const people = makePeople(21, 240), world = worldWith(1, people);
  for (const person of people) {
    const vector = vectorConducta(person, world), expected = refVectorConducta(person);
    assert.equal(vector.length, CONDUCTA_DIMENSIONS);
    assert.deepStrictEqual(vector, expected, `vector de ${person.id}`);
  }
  // Persona sin ninguna conducta: vector de ceros (norma 0), no NaN.
  const blank = structuredClone(people[0]!); blank.activity = {}; blank.skills = {}; blank.experiences = []; blank.technology = initialTechnologyKnowledge();
  assert.deepStrictEqual(vectorConducta(blank, world), refVectorConducta(blank));
});

test('V18 indiceDiversidad: conducta, oficios y total idénticos para poblaciones de todos los tamaños', () => {
  for (const [seed, count] of [[1, 0], [2, 1], [3, 2], [4, 3], [5, 17], [6, 200], [7, 801]] as const) {
    const world = worldWith(seed, makePeople(30 + seed, count));
    assert.deepStrictEqual(indiceDiversidad(world), refIndiceDiversidad(world), `${count} habitantes`);
  }
  const clones = worldWith(9, makePeople(40, 1)); clones.people = Array.from({ length: 30 }, () => structuredClone(clones.people[0]!));
  assert.deepStrictEqual(indiceDiversidad(clones), refIndiceDiversidad(clones), 'clones idénticos');
  const blanks = worldWith(10, makePeople(41, 12)); for (const p of blanks.people) { p.activity = {}; p.skills = {}; p.experiences = []; p.technology = initialTechnologyKnowledge(); }
  assert.deepStrictEqual(indiceDiversidad(blanks), refIndiceDiversidad(blanks), 'población sin conducta');
});

// ---------------------------------------------------------------------------------------------
// worldStatistics
// ---------------------------------------------------------------------------------------------
function statsWorld(seed: number, people: number, width: number, height: number, order: Order): World {
  const world = worldWith(seed, makePeople(seed * 3 + 1, people), makeTiles(seed * 5 + 2, width, height, order));
  world.animals = world.animals.slice(0, 7); world.tick = 400;
  return world;
}

test('V18 worldStatistics: salida idéntica a la del código anterior (resumen SHA-256) y cadencia intacta', () => {
  for (const [name, seed, people, w, h, order] of [['pequeño', 3, 40, 40, 30, 'row'], ['mediano en chunks', 4, 400, 120, 90, 'chunk'], ['mezclado', 5, 150, 70, 70, 'shuffle']] as const) {
    const world = statsWorld(seed, people, w, h, order);
    const stats = worldStatistics(world);
    golden(`stats:${name}`, stats);
    // Los componentes caros coinciden además con la referencia embebida, número a número.
    same(stats.giniRecursosPorRegion, refGini(world.tiles), `${name}: gini`);
    same(stats.distanciaMediaAgua, refDistanciaMediaAgua(world.tiles), `${name}: distancia`);
    same(stats.regionesSinAgua, refRegionesSinAgua(world.tiles), `${name}: regiones sin agua`);
    assert.deepStrictEqual(stats.diversidad, refIndiceDiversidad(world), `${name}: diversidad`);
    assert.equal(worldStatistics(world), stats, 'memoria por paso');
    world.tick += ESTADISTICAS_CARAS_CADA_TICKS;
    assert.equal(worldStatistics(world).statsTick, world.tick, 'se recalcula al cumplir la cadencia');
  }
});

// ---------------------------------------------------------------------------------------------
// Organización tecnológica: casos válidos y corruptos (fail-closed)
// ---------------------------------------------------------------------------------------------
const binding: TechnologyProgram = { inputs: [{ source: 'raw', material: 'wood', mass: 1000 }], steps: [{ op: 'weave', intensity: 4 }, { op: 'form', intensity: 2, shape: 'sheet' }] };
const advanced: TechnologyProgram = { inputs: [{ source: 'raw', material: 'wood', mass: 1000 }, { source: 'raw', material: 'stone', mass: 1000 }],
  steps: [{ op: 'combine', intensity: 3, requiredCatalyst: 'binding' }, { op: 'form', intensity: 3, shape: 'rod' }] };
interface OrgScene { host: TechnologyHost; actors: TechnologyActor[]; }
const makeActor = (id: string, x = 0, y = 0): TechnologyActor => ({ id, x, y, energy: 1, fatigue: 0, hunger: 0.1, thirst: 0.1, materials: { wood: 20, stone: 20 }, skills: {}, technology: initialTechnologyKnowledge() });
function manufacture(host: TechnologyHost, actor: TechnologyActor, program: TechnologyProgram, parents: string[] = []): void {
  actor.energy = 1; actor.fatigue = 0;
  actor.technology.project = proyectoInvestigacion(program, host.tick, parents);
  for (let n = 0; actor.technology.project && n < 500; n++) { host.tick++; researchTechnology(host, actor); }
  assert.equal(actor.technology.project, null);
}
function useOnce(host: TechnologyHost, actor: TechnologyActor, demand = 0.5): void {
  host.tick++; const receipt = useTool(host, actor, 'cutting', demand);
  if (receipt) recordTechnologyBenefit(host, actor, receipt, 0.1);
}
/**
 * `crowd` habitantes en el padrón; el punto de partida del checkpoint reparte inventarios (de 0 a 6 objetos
 * y algo de residuo) entre ellos y, DESPUÉS de ese punto, `crafters` fabrican, usan herramientas y trasladan objetos.
 */
function orgScene(crowd: number, crafters: number, maxHistory = 256): OrgScene {
  const actors = Array.from({ length: crowd }, (_, i) => makeActor(`a${String(i).padStart(5, '0')}`, i % 40, Math.floor(i / 40)));
  const host: TechnologyHost = { seed: 23, tick: 0, people: actors, technology: defaultTechnologyState() };
  host.technology.budgets.maxHistory = maxHistory;
  manufacture(host, actors[0]!, edge);
  const template = actors[0]!.technology.items[0]!;
  host.technology.itemCounter += 100000; let serial = host.technology.itemCounter - 90000;
  for (let i = crafters + 1; i < crowd; i++) {
    for (let k = 0; k < i % 7; k++) actors[i]!.technology.items.push({ ...structuredClone(template), id: `product-${serial++}` });
    if (i % 7 === 0) actors[i]!.technology.residue.wood = 3 + (i % 5);
    if (i % 11 === 0) actors[i]!.technology.residue.stone = 2;
  }
  host.technology.checkpoint = captureTechnologyCheckpoint(host.technology, host.people, host.tick, 'migration');
  assertTechnologyCheckpoint(host.technology, host.tick);
  for (let i = 1; i <= crafters; i++) {
    const actor = actors[i]!;
    manufacture(host, actor, i % 2 ? edge : binding);
    if (i === 2) {
      // Fabricación con catalizador requerido y reciclaje anidado: el objeto nuevo desplaza al más viejo (tope de 1 objeto más).
      const parent = host.technology.history.filter(event => event.actorId === actor.id && event.kind === 'research').at(-1)!.recipeId!;
      host.technology.budgets.maxItems = actor.technology.items.length;
      manufacture(host, actor, advanced, [parent]);
      host.technology.budgets.maxItems = 16;
    }
    for (let u = 0; u < 2; u++) useOnce(host, actor);
    if (i % 5 === 0) { host.tick++; const peer = actors[i - 1]!; const item = actor.technology.items[0]; if (item) transferTechnologyItem(host, actor, peer, item.id); }
  }
  return { host, actors };
}
/** Copia profunda del estado, con los habitantes ligados a la copia (los inventarios se comparan por valor). */
function cloneScene(scene: OrgScene): OrgScene {
  const copy = structuredClone({ technology: scene.host.technology, actors: scene.actors });
  return { host: { ...scene.host, technology: copy.technology, people: copy.actors }, actors: copy.actors };
}
/** Una excepción también es parte del contrato fail-closed: se compara su clase y mensaje. */
const attempt = <T>(run: () => T): T | { thrown: string } => { try { return run(); } catch (error) { return { thrown: `${(error as Error).name}: ${(error as Error).message}` }; } };
const observeAll = (scene: OrgScene, tick = scene.host.tick, state: TechnologyState = scene.host.technology) => ({
  observation: attempt(() => observeTechnologyOrganization(state, scene.actors, tick)), analysis: attempt(() => analyzeTechnologyOrganization(state, scene.actors, tick)),
});
const diagnosticsOf = (outcome: ReturnType<typeof observeAll>): string[] => 'thrown' in outcome.observation ? [`thrown:${outcome.observation.thrown}`] : outcome.observation.diagnostics;

/** Recibos posteriores al checkpoint: los únicos que entran en la ventana observada. */
const post = (scene: OrgScene) => scene.host.technology.history.filter(event => Number(event.id.slice(8)) > scene.host.technology.checkpoint!.executionCounter);
/** Habitante sin recibos en la ventana con al menos `minItems` objetos (el `skip`-ésimo empezando por el final del padrón). */
function holder(scene: OrgScene, minItems: number, skip = 0): TechnologyActor | undefined {
  const withReceipts = new Set(scene.host.technology.history.map(event => event.actorId));
  const found = scene.actors.filter(actor => !withReceipts.has(actor.id) && actor.technology.items.length >= minItems && scene.host.technology.checkpoint!.inventories.some(inv => inv.actorId === actor.id));
  return found.at(-1 - skip);
}
/** Cada mutación rompe una invariante distinta; todas deben seguir produciendo los mismos diagnósticos y la misma observación. */
const MUTATIONS: [name: string, mutate: (scene: OrgScene) => { tick?: number; actors?: TechnologyActor[] } | void][] = [
  ['sin-checkpoint', s => { delete s.host.technology.checkpoint; }],
  ['checkpoint-invalido', s => { s.host.technology.checkpoint!.version = 2 as never; }],
  ['checkpoint-futuro', s => { s.host.technology.checkpoint!.tick = s.host.tick + 10; }],
  ['recibo-perdido-en-la-ventana', s => { const lost = post(s)[1]; s.host.technology.history = s.host.technology.history.filter(event => event !== lost); }],
  ['registro-desordenado', s => { s.host.technology.history.reverse(); }],
  ['historia-descartada', s => { s.host.technology.historyDropped = 3; }],
  ['sin-epoca-completa', s => ({ tick: s.host.technology.checkpoint!.tick })],
  ['recibos-fuera-de-epoca', s => ({ tick: s.host.technology.checkpoint!.tick + 3 })],
  ['actor-duplicado', s => ({ actors: [...s.actors, s.actors[1]!] })],
  ['actor-nuevo', s => ({ actors: [...s.actors, makeActor('zz-nuevo')] })],
  ['actor-nuevo-con-material', s => { const a = makeActor('zz-material'); a.technology.residue.wood = 4; return { actors: [...s.actors, a] }; }],
  ['actor-ausente-con-material', s => ({ actors: s.actors.filter(a => a.id !== s.actors[2]!.id) })],
  ['actor-ausente-sin-material', s => ({ actors: s.actors.filter(a => a.id !== s.actors.at(-1)!.id) })],
  ['padron-reordenado', s => ({ actors: [...s.actors].reverse() })],
  ['apertura-no-encadenada', s => { s.host.technology.history[3]!.balance.opening[0]!.mass += 5; }],
  ['masa-de-insumo-alterada', s => { const e = post(s).find(x => x.kind === 'research' || x.kind === 'craft')!; e.inputs[0]!.mass += 10; }],
  ['masa-de-cierre-alterada', s => { const e = post(s).find(x => x.kind === 'use')!; e.balance.closing[0]!.mass += 1; }],
  ['entrada-externa-alterada', s => { const e = post(s).find(x => x.balance.externalInputs.length)!; e.balance.externalInputs[0]!.mass -= 7; }],
  ['perdida-externa-alterada', s => { const e = post(s).find(x => x.balance.externalLoss.length)!; e.balance.externalLoss[0]!.mass += 7; }],
  ['receta-sin-verificar', s => { const e = post(s).find(x => x.kind === 'research' && x.success)!; e.programSignature = 'forjada'; }],
  ['receta-inexistente', s => { const e = post(s).find(x => x.kind === 'research' && x.success)!; e.recipeId = 'recipe-9999'; }],
  ['tick-previo-a-la-receta', s => { const e = post(s).find(x => x.kind === 'research' && x.success)!; e.tick = 0; }],
  ['transferencia-sin-id', s => { delete post(s).find(x => x.kind === 'transfer')!.transferId; }],
  ['transferencia-incompleta', s => { const t = post(s).find(x => x.kind === 'transfer')!; s.host.technology.history = s.host.technology.history.filter(x => x !== t); }],
  ['transferencia-sin-contraparte', s => { post(s).find(x => x.kind === 'transfer')!.counterpartyId = 'nadie'; }],
  ['transferencia-asimetrica', s => { const t = post(s).find(x => x.kind === 'transfer')!; t.balance.externalLoss[0]!.mass += 1; }],
  ['stock-actual-con-residuo', s => { s.actors[1]!.technology.residue.wood++; }],
  ['stock-actual-con-objeto', s => { s.actors[2]!.technology.items.pop(); }],
  ['inventario-sin-recibo-masa', s => { const a = holder(s, 1); if (a) a.technology.items[0]!.mass -= 1; }],
  ['inventario-sin-recibo-residuo', s => { const a = holder(s, 0, 1); if (a) a.technology.residue.stone += 1; }],
  ['inventario-sin-recibo-composicion', s => { const item = holder(s, 2)?.technology.items[1]; if (item) item.composition = { ...item.composition, wood: item.composition.wood + 1, stone: item.composition.stone - 1 }; }],
  ['inventario-sin-recibo-receta', s => { const item = holder(s, 1)?.technology.items[0]; if (item) item.recipeId = 'recipe-7'; }],
  ['inventario-sin-recibo-id', s => { const item = holder(s, 3)?.technology.items[2]; if (item) item.id = 'product-777'; }],
  ['inventario-con-id-repetido', s => { const items = holder(s, 2)?.technology.items; if (items) items[1]!.id = items[0]!.id; }],
  ['inventario-pequeno-con-objeto-de-mas', s => { const items = holder(s, 1, 1)?.technology.items; if (items) items.push({ ...structuredClone(items[0]!), id: 'product-31415' }); }],
  ['inventario-con-id-repetido-grande', s => { const items = holder(s, 5)?.technology.items; if (items) items[4]!.id = items[3]!.id; }],
  ['inventario-grande-alterado', s => { const item = holder(s, 5)?.technology.items[4]; if (item) item.mass += 3; }],
  ['inventario-grande-sin-cambios-de-residuo', s => { const a = holder(s, 5); if (a) a.technology.residue.water = 1; }],
  ['inventario-grande-con-objeto-menos', s => { holder(s, 5)?.technology.items.pop(); }],
  ['estado-anidado-ausente', s => { const e = post(s).find(x => x.nestedExecutionIds?.length); if (e) s.host.technology.history = s.host.technology.history.filter(x => x.id !== e.nestedExecutionIds![0]); }],
  ['anidado-de-otro-actor', s => { const e = post(s).find(x => x.nestedExecutionIds?.length); if (e) post(s).find(x => x.id === e.nestedExecutionIds![0])!.actorId = 'otro'; }],
  ['padre-duplicado', s => { const e = post(s).find(x => x.nestedExecutionIds?.length); if (e) { const other = post(s).find(x => x !== e && x.kind === 'use'); other!.nestedExecutionIds = [...e.nestedExecutionIds!]; } }],
  ['catalizador-con-desgaste-falso', s => { const e = post(s).find(x => x.catalysts.length); if (e) e.catalysts[0]!.wear += 1; }],
  ['catalizador-requerido-omitido', s => { const e = post(s).find(x => x.catalysts.length); if (e) e.catalysts[0]!.required = false; }],
  ['uso-anidado-sin-atribuir', s => { const e = post(s).find(x => x.catalysts.length); if (e) e.catalysts = []; }],
];

/** Escenas con catalizadores anidados y herencias: el flujo avanzado de los tests de organización. */
function nestedScene(): OrgScene {
  const actors = [makeActor('a'), makeActor('b'), makeActor('c')];
  const host: TechnologyHost = { seed: 23, tick: 0, people: actors, technology: defaultTechnologyState() };
  host.technology.checkpoint = captureTechnologyCheckpoint(host.technology, host.people, host.tick, 'initial');
  manufacture(host, actors[0]!, binding);
  host.technology.budgets.maxItems = 1;
  manufacture(host, actors[0]!, advanced, [host.technology.recipes[0]!.id]);
  manufacture(host, actors[1]!, edge); useOnce(host, actors[1]!, 2);
  host.tick++; settleTechnologyEstate(host, actors[0]!, [actors[2]!]);
  return { host, actors };
}

test('V18 organización tecnológica: observación y análisis idénticos al código anterior (válido y fail-closed)', () => {
  const coverage = new Set<string>(), threw: string[] = [];
  const collect = (diagnostics: string[]): void => { for (const diagnostic of diagnostics) coverage.add(diagnostic.split(':')[0]!); };

  const scenes: [string, OrgScene][] = [['pequeña', orgScene(12, 5)], ['anidada', nestedScene()], ['multitud', orgScene(90, 20)]];
  for (const [name, scene] of scenes) {
    const before = structuredClone({ technology: scene.host.technology, actors: scene.actors });
    const base = observeAll(scene);
    golden(`org:${name}`, base);
    assert.deepStrictEqual(before, { technology: scene.host.technology, actors: scene.actors }, 'la observación no cambia la simulación');
    assert.ok(!('thrown' in base.observation) && !('thrown' in base.analysis), `${name}: el caso base no lanza`);
    if ('thrown' in base.observation) throw new Error('inalcanzable');
    assert.deepEqual(base.observation.diagnostics, [], `${name}: el caso base es completo`);
    assert.equal(base.observation.observation.window.complete, true);
    assert.ok(base.observation.observation.executions.length > 0);
    for (const [mutation, mutate] of MUTATIONS) {
      const scene2 = cloneScene(scene), override = mutate(scene2) ?? {};
      const outcome = observeAll({ ...scene2, actors: override.actors ?? scene2.actors }, override.tick ?? scene2.host.tick);
      golden(`org:${name}:${mutation}`, outcome);
      collect(diagnosticsOf(outcome));
      if (!('thrown' in outcome.analysis)) assert.deepEqual(outcome.analysis.evidence.failures.filter(f => diagnosticsOf(outcome).includes(f)), diagnosticsOf(outcome), `${name}/${mutation}: los diagnósticos llegan al análisis`);
      else threw.push(`${name}/${mutation}`);
    }
  }
  // Cada diagnóstico fail-closed del adaptador tiene al menos un caso que lo dispara.
  for (const kind of ['invalid-opening-checkpoint', 'missing-opening-checkpoint', 'execution-ledger-gap', 'no-complete-epoch', 'execution-outside-epoch', 'duplicate-current-actor',
    'checkpoint-roster-change', 'unobserved-opening-stock', 'unlogged-stock-change', 'transaction-resource-mismatch', 'unverified-recipe', 'missing-transfer-id', 'incomplete-transfer',
    'current-stock-mismatch', 'unlogged-physical-stock-change', 'missing-current-actor', 'multiple-transaction-parents', 'missing-nested-execution', 'invalid-nested-execution',
    'missing-required-catalyst', 'unverified-catalyst-receipt', 'unattributed-nested-use']) assert.ok(coverage.has(kind), `ningún caso dispara «${kind}»`);
  if (PRINT_GOLDEN) console.log(`V18_THREW ${threw.join(',')}`);
  if (PRINT_GOLDEN) console.log(`V18_GOLDEN_OBSERVED ${[...coverage].sort().join(',')}`);
});

// ---------------------------------------------------------------------------------------------
// Benchmark sintético realista (3.000 habitantes, 65.536 teselas, 400 eventos)
// ---------------------------------------------------------------------------------------------
test('V18 benchmark: coste de organización, agua, diversidad, Gini, distancia y estadísticas en un mundo masivo', (t: TestContext) => {
  const people = makePeople(77, 3000), tiles = makeTiles(78, 256, 256, 'chunk');
  const world = worldWith(79, people, tiles); world.animals = world.animals.slice(0, 7); world.tick = 1000;
  const report = (name: string, now: number, before: number): void => t.diagnostic(`${name}: ${now.toFixed(2)} ms (referencia anterior: ${before.toFixed(2)} ms, ×${(before / now).toFixed(1)})`);

  const scene = orgScene(3000, 180, 1000);
  assert.ok(scene.host.technology.history.length >= 400, `el ledger tiene ${scene.host.technology.history.length} eventos`);
  assert.deepEqual(observeTechnologyOrganization(scene.host.technology, scene.actors, scene.host.tick).diagnostics, []);
  t.diagnostic(`organización: ${scene.actors.length} habitantes, ${scene.host.technology.history.length} eventos`);
  t.diagnostic(`observeTechnologyOrganization: ${best(7, () => observeTechnologyOrganization(scene.host.technology, scene.actors, scene.host.tick)).toFixed(2)} ms`);
  t.diagnostic(`analyzeTechnologyOrganization: ${best(7, () => analyzeTechnologyOrganization(scene.host.technology, scene.actors, scene.host.tick)).toFixed(2)} ms`);

  same(regionesSinAgua(tiles), refRegionesSinAgua(tiles), 'regionesSinAgua');
  report('regionesSinAgua', best(15, () => regionesSinAgua(tiles)), best(15, () => refRegionesSinAgua(tiles)));
  assert.deepStrictEqual(indiceDiversidad(world), refIndiceDiversidad(world));
  report('indiceDiversidad', best(9, () => indiceDiversidad(world)), best(9, () => refIndiceDiversidad(world)));
  same(giniRecursosPorRegion(tiles), refGini(tiles), 'gini');
  report('giniRecursosPorRegion', best(15, () => giniRecursosPorRegion(tiles)), best(15, () => refGini(tiles)));
  same(distanciaMediaAgua(tiles), refDistanciaMediaAgua(tiles), 'distanciaMediaAgua');
  report('distanciaMediaAgua', best(9, () => distanciaMediaAgua(tiles)), best(9, () => refDistanciaMediaAgua(tiles)));
  t.diagnostic(`worldStatistics (recálculo completo): ${best(7, () => { world.tick += ESTADISTICAS_CARAS_CADA_TICKS; worldStatistics(world); }).toFixed(2)} ms`);
});

// ---------------------------------------------------------------------------------------------
// Resúmenes del código anterior a V18 (se regeneran con V18_PRINT_GOLDEN=1)
// ---------------------------------------------------------------------------------------------
const GOLDEN: Record<string, string> = {
  "stats:pequeño": '9ba4a16c09294c17',
  "stats:mediano en chunks": '86975d1366b24751',
  "stats:mezclado": '6c340c9cbf3c4fbf',
  "org:pequeña": 'f8a813434dacd537',
  "org:pequeña:sin-checkpoint": 'cd360f9c82cecd6c',
  "org:pequeña:checkpoint-invalido": 'c297c29c89416907',
  "org:pequeña:checkpoint-futuro": 'c297c29c89416907',
  "org:pequeña:recibo-perdido-en-la-ventana": '871e0036646ef620',
  "org:pequeña:registro-desordenado": '2ec47a4fbc6e7675',
  "org:pequeña:historia-descartada": '09029d0050dd7505',
  "org:pequeña:sin-epoca-completa": '705ec00300619cea',
  "org:pequeña:recibos-fuera-de-epoca": '963e6c67d49232f5',
  "org:pequeña:actor-duplicado": '0d26379497d0ca27',
  "org:pequeña:actor-nuevo": '93588a5902e404de',
  "org:pequeña:actor-nuevo-con-material": '10621443319b6783',
  "org:pequeña:actor-ausente-con-material": 'd3f57691df08f9e0',
  "org:pequeña:actor-ausente-sin-material": '6f4e0a694d001ddf',
  "org:pequeña:padron-reordenado": 'f8a813434dacd537',
  "org:pequeña:apertura-no-encadenada": 'b06addb6f1e1be76',
  "org:pequeña:masa-de-insumo-alterada": 'bd6189e8081f0b04',
  "org:pequeña:masa-de-cierre-alterada": 'eaabfcff17357f50',
  "org:pequeña:entrada-externa-alterada": 'c9dcd8b41ac6c8f5',
  "org:pequeña:perdida-externa-alterada": '15e1fc118af2b8dc',
  "org:pequeña:receta-sin-verificar": 'd49e182dc63439a9',
  "org:pequeña:receta-inexistente": '122544df99bca77a',
  "org:pequeña:tick-previo-a-la-receta": 'adf5943b8656fbed',
  "org:pequeña:transferencia-sin-id": '40b19ab397b70948',
  "org:pequeña:transferencia-incompleta": '3f71da352e861fde',
  "org:pequeña:transferencia-sin-contraparte": 'beaa1ab578eb78d5',
  "org:pequeña:transferencia-asimetrica": '15e1fc118af2b8dc',
  "org:pequeña:stock-actual-con-residuo": '78e8cd2ba5ee0dc1',
  "org:pequeña:stock-actual-con-objeto": 'ad0731c1c6686845',
  "org:pequeña:inventario-sin-recibo-masa": '58415002d54b012f',
  "org:pequeña:inventario-sin-recibo-residuo": '94e2f8a128002fd3',
  "org:pequeña:inventario-sin-recibo-composicion": '05f340309856d7c1',
  "org:pequeña:inventario-sin-recibo-receta": '2dbf15bb28e8439c',
  "org:pequeña:inventario-sin-recibo-id": '05f340309856d7c1',
  "org:pequeña:inventario-con-id-repetido": '05f340309856d7c1',
  "org:pequeña:inventario-pequeno-con-objeto-de-mas": '2e7a46fb89d9058c',
  "org:pequeña:inventario-con-id-repetido-grande": '4e44fe76c86f1ea0',
  "org:pequeña:inventario-grande-alterado": 'd46478d24ca348d7',
  "org:pequeña:inventario-grande-sin-cambios-de-residuo": 'fd3d5a82aab7b933',
  "org:pequeña:inventario-grande-con-objeto-menos": '3132ad0ee5971115',
  "org:pequeña:estado-anidado-ausente": 'bc8986574c1f62ef',
  "org:pequeña:anidado-de-otro-actor": '9657fee9da5aa67c',
  "org:pequeña:padre-duplicado": 'd68ee684e6c13f78',
  "org:pequeña:catalizador-con-desgaste-falso": '4c35c0c152f957db',
  "org:pequeña:catalizador-requerido-omitido": '62d81c9c05936276',
  "org:pequeña:uso-anidado-sin-atribuir": '7868ff8a68235630',
  "org:anidada": '734881960f98ff47',
  "org:anidada:sin-checkpoint": 'ec3fcb4c9f8aef7e',
  "org:anidada:checkpoint-invalido": '767b62b72839aa3d',
  "org:anidada:checkpoint-futuro": '767b62b72839aa3d',
  "org:anidada:recibo-perdido-en-la-ventana": 'd3374882e92593d8',
  "org:anidada:registro-desordenado": 'd4a8db3e858f9e51',
  "org:anidada:historia-descartada": '498424e8cbac629c',
  "org:anidada:sin-epoca-completa": '49cfca9e6342ab81',
  "org:anidada:recibos-fuera-de-epoca": 'eeccc7c3e242df0b',
  "org:anidada:actor-duplicado": 'e2b266adc31cf688',
  "org:anidada:actor-nuevo": '22d0b8c2d0067d64',
  "org:anidada:actor-nuevo-con-material": 'f2def4d21a4d00d9',
  "org:anidada:actor-ausente-con-material": '8959f59918e96bd4',
  "org:anidada:actor-ausente-sin-material": '8959f59918e96bd4',
  "org:anidada:padron-reordenado": '734881960f98ff47',
  "org:anidada:apertura-no-encadenada": '5642f3781ee07999',
  "org:anidada:masa-de-insumo-alterada": '25b4809b4e8786e6',
  "org:anidada:masa-de-cierre-alterada": '734881960f98ff47',
  "org:anidada:entrada-externa-alterada": 'bed419c6a1626fb6',
  "org:anidada:perdida-externa-alterada": '7f215d5ac3532680',
  "org:anidada:receta-sin-verificar": '6f038b6fe5781e47',
  "org:anidada:receta-inexistente": 'bab6b61ea5e4ee52',
  "org:anidada:tick-previo-a-la-receta": '767b62b72839aa3d',
  "org:anidada:transferencia-sin-id": 'dcaea92bea33a1dd',
  "org:anidada:transferencia-incompleta": 'b514fc9596aa715d',
  "org:anidada:transferencia-sin-contraparte": 'a56f45c00dd11f4d',
  "org:anidada:transferencia-asimetrica": '7f215d5ac3532680',
  "org:anidada:stock-actual-con-residuo": '3c5dca82573b9917',
  "org:anidada:stock-actual-con-objeto": 'f302537df3500fa6',
  "org:anidada:inventario-sin-recibo-masa": '734881960f98ff47',
  "org:anidada:inventario-sin-recibo-residuo": '734881960f98ff47',
  "org:anidada:inventario-sin-recibo-composicion": '734881960f98ff47',
  "org:anidada:inventario-sin-recibo-receta": '734881960f98ff47',
  "org:anidada:inventario-sin-recibo-id": '734881960f98ff47',
  "org:anidada:inventario-con-id-repetido": '734881960f98ff47',
  "org:anidada:inventario-pequeno-con-objeto-de-mas": '734881960f98ff47',
  "org:anidada:inventario-con-id-repetido-grande": '734881960f98ff47',
  "org:anidada:inventario-grande-alterado": '734881960f98ff47',
  "org:anidada:inventario-grande-sin-cambios-de-residuo": '734881960f98ff47',
  "org:anidada:inventario-grande-con-objeto-menos": '734881960f98ff47',
  "org:anidada:estado-anidado-ausente": 'd3374882e92593d8',
  "org:anidada:anidado-de-otro-actor": '33c96847898ce92d',
  "org:anidada:padre-duplicado": 'a2d69f13cd80586e',
  "org:anidada:catalizador-con-desgaste-falso": 'f8234df9d53f4106',
  "org:anidada:catalizador-requerido-omitido": '1b300b18bb47e2d3',
  "org:anidada:uso-anidado-sin-atribuir": '5ae84a54d72f7237',
  "org:multitud": '3691fba70f13b438',
  "org:multitud:sin-checkpoint": '2a42799efea0ce51',
  "org:multitud:checkpoint-invalido": '9cb8ab36025b7e76',
  "org:multitud:checkpoint-futuro": '9cb8ab36025b7e76',
  "org:multitud:recibo-perdido-en-la-ventana": 'f72608d8e0e10130',
  "org:multitud:registro-desordenado": 'f2a1af048292ebcb',
  "org:multitud:historia-descartada": '6327b082edc22f16',
  "org:multitud:sin-epoca-completa": '33f47b0d57de9ae1',
  "org:multitud:recibos-fuera-de-epoca": '85b514fe82b01702',
  "org:multitud:actor-duplicado": 'e0f26755d10b530e',
  "org:multitud:actor-nuevo": 'cf83a6ffcc9462fd',
  "org:multitud:actor-nuevo-con-material": 'c4b030f448847419',
  "org:multitud:actor-ausente-con-material": '33bbf79b27ca4371',
  "org:multitud:actor-ausente-sin-material": '03931d5d9defe8c3',
  "org:multitud:padron-reordenado": '3691fba70f13b438',
  "org:multitud:apertura-no-encadenada": '88e598103fe385e7',
  "org:multitud:masa-de-insumo-alterada": '15097796f2309d7b',
  "org:multitud:masa-de-cierre-alterada": 'ec7f29763812c0c5',
  "org:multitud:entrada-externa-alterada": '320f8eae88b648a7',
  "org:multitud:perdida-externa-alterada": '78abe4db2377a396',
  "org:multitud:receta-sin-verificar": '2f440429c6829b36',
  "org:multitud:receta-inexistente": '20974ba70da8461a',
  "org:multitud:tick-previo-a-la-receta": 'c5b5e561c6c88243',
  "org:multitud:transferencia-sin-id": '2d39ef1b7b1d3ae5',
  "org:multitud:transferencia-incompleta": '0c0ac374c422eb58',
  "org:multitud:transferencia-sin-contraparte": '576c9ee21a035b3e',
  "org:multitud:transferencia-asimetrica": '78abe4db2377a396',
  "org:multitud:stock-actual-con-residuo": '20aef12b3fbe9907',
  "org:multitud:stock-actual-con-objeto": '4185803a624db7a2',
  "org:multitud:inventario-sin-recibo-masa": '52743e4c244c2f43',
  "org:multitud:inventario-sin-recibo-residuo": 'e951291b84613030',
  "org:multitud:inventario-sin-recibo-composicion": '15d0d18f750df46c',
  "org:multitud:inventario-sin-recibo-receta": '4bc0cd24dead99df',
  "org:multitud:inventario-sin-recibo-id": '15d0d18f750df46c',
  "org:multitud:inventario-con-id-repetido": '15d0d18f750df46c',
  "org:multitud:inventario-pequeno-con-objeto-de-mas": '2ca8db0f5530ac60',
  "org:multitud:inventario-con-id-repetido-grande": '15d0d18f750df46c',
  "org:multitud:inventario-grande-alterado": '6538dc7937901de4',
  "org:multitud:inventario-grande-sin-cambios-de-residuo": 'c3115ae515ee3447',
  "org:multitud:inventario-grande-con-objeto-menos": 'f5d9c7e0c3adfce2',
  "org:multitud:estado-anidado-ausente": '5b92be6514b80883',
  "org:multitud:anidado-de-otro-actor": 'a584b62f53e99d50',
  "org:multitud:padre-duplicado": '949bb47077c6070b',
  "org:multitud:catalizador-con-desgaste-falso": '521d0f30e55ca145',
  "org:multitud:catalizador-requerido-omitido": 'bcafec097cd659cb',
  "org:multitud:uso-anidado-sin-atribuir": '9e8d49b295180dab',
};
test.after(() => { if (PRINT_GOLDEN) console.log(`V18_GOLDEN ${JSON.stringify(printed)}`); });
