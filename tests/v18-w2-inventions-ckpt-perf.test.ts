// V18 ola 2, carril F — paridad exacta de `inventions.ts`, `technology-checkpoint.ts` y `technology-execution.ts`.
//
// Cada optimización conserva el resultado bit a bit y todos los rechazos. Se fija por cuatro vías:
//  1. digestos canónicos de mundos completos (3 semillas × 300 pasos × 2 conjuntos de leyes, más dos mundos de 4 000 pasos
//     con estructuras, planos y lluvia) medidos en el commit base 2ff91e3, ANTES de editar;
//  2. referencias (copias literales del código anterior) comparadas con `Object.is` / `deepStrictEqual` / JSON byte a byte
//     sobre entradas aleatorias y extremas;
//  3. fail-closed: cada corrupción de un punto de apertura debe seguir fallando con el mismo error que antes;
//  4. micro-benchmark realista (3 000 habitantes + 800 estructuras) antes vs después, sólo como diagnóstico.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import type { StructureComponent, StructureView } from '../src/shared/life.js';
import type { MaterialBatch, ResourceMass, TechnologyCheckpoint, TechnologyProgram, TechnologyState } from '../src/shared/technology.js';
import { POPULATION_HARD_LIMIT } from '../src/shared/life.js';
import { closePersonasParallelPools, closePolicyGpuBatchers, createWorld, stepWorld, type Person, type World } from '../src/world/index.js';
import { closeEcosystemWorkers } from '../src/world/ecosystem.js';
import { cloneWorld } from '../src/world/clon.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { DEFAULT_PARAMS } from '../src/world/params.js';
import { hostOpenWorldParams } from '../src/server/hardware-limits.js';
import { activate, tileAt } from '../src/world/spatial.js';
import { filtrarCerca } from '../src/world/indice-puntos.js';
import { esMiembro } from '../src/world/indices.js';
import { SED_POR_UNIDAD } from '../src/world/ecologia-constantes.js';
import {
  BROKEN_CONDITION, blueprintAffordances, blueprintCost, constructionCost, defaultBlueprint, facilityRestQuality, foodAvailable, hypotExact,
  stepStructures, takeFood, takeWater, validBlueprint, waterAvailable,
} from '../src/world/inventions.js';
import { applyPhysicalOperation, materialCapacities, programSignature, rawMaterial } from '../src/world/technology.js';
import { resolveTechnologyRecipe } from '../src/world/technology-catalogue.js';
import { assertContainedWater, assertWaterLedger } from '../src/world/technology-water.js';
import { assertTechnologyCheckpoint, captureTechnologyCheckpoint, type TechnologyStockActor } from '../src/world/technology-checkpoint.js';
import { technologyStock } from '../src/world/technology-execution.js';

after(async () => {
  closePolicyGpuBatchers();
  await closePersonasParallelPools();
  await closeEcosystemWorkers();
});

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// ───────────────────────── 1. digestos de mundos completos ─────────────────────────
const GiB = 1024 ** 3;
const probe = { cpuThreads: () => 1, totalRamBytes: () => 128 * GiB, nvrtcAvailable: () => false, nvidiaSmi: () => '',
  memory: () => ({ fisicaBytes: 128 * GiB, heapBytes: 8 * GiB }) };
const BASE_300: Record<'host' | 'default', Record<number, string>> = {
  host: {
    7: 'f0ab8eb74989f614bfc3de1cac658ad27bc269f8a8eabb49723f17745e343655',
    42: 'b99695ca036aa4b3f943de71673e13d7d4f78a330efa68db7f924c6806694a23',
    51926: '2d959a6a8ce132be3227eaa6b072dcf51d9d1ea473c06d425879593509a17b4a',
  },
  default: {
    7: 'f636c2ae21bbe4c11ccb290306e49e13628bfee018f3b7b1397f6005cb8b6f5f',
    42: 'ee74060dc11a38f9f93d574aa33c2c87ee2b9c58096331821a75057d86be0bc3',
    51926: '7d70c818adac9efbc90a91d50b4bed6fadd9d9c97fe36bd6a7cce996e304c4d5',
  },
};
const paramsOf = (conjunto: 'host' | 'default') => conjunto === 'host' ? hostOpenWorldParams(DEFAULT_PARAMS, probe) : DEFAULT_PARAMS;
for (const conjunto of ['host', 'default'] as const) {
  for (const [seed, expected] of Object.entries(BASE_300[conjunto])) {
    test(`V18 ola 2 paridad: semilla ${seed}, leyes ${conjunto === 'host' ? 'hostOpenWorldParams' : 'DEFAULT_PARAMS'}, 300 pasos = digesto del commit base`, () => {
      const world = createWorld(Number(seed), paramsOf(conjunto));
      for (let tick = 0; tick < 300; tick++) stepWorld(world);
      assert.equal(digestoCanonico(world), expected);
    });
  }
}
// Mundos largos: ya con estructuras, planos inventados y lluvia (recogida, riego, depósito y aprendizaje de planos cada 60 pasos).
const BASE_4000 = [
  { conjunto: 'default' as const, seed: 51926, digest: 'b746e3cf96a21491f5d0df02b5c3df2bc54bc119a177063959ba13bb61126d12', structures: 8, blueprints: 9 },
  { conjunto: 'host' as const, seed: 42, digest: '314d5e6d5ac8ef78431d2a436734756c50d277fbf0ce9f9eeca3067e998ed693', structures: 14, blueprints: 5 },
];
for (const { conjunto, seed, digest, structures, blueprints } of BASE_4000) {
  test(`V18 ola 2 paridad larga: semilla ${seed}, leyes ${conjunto}, 4 000 pasos (obras, planos, lluvia) = digesto del commit base`, () => {
    const world = createWorld(seed, paramsOf(conjunto));
    for (let tick = 0; tick < 4000; tick++) stepWorld(world);
    assert.equal(world.structures.length, structures);
    assert.equal(world.blueprints.length, blueprints);
    assert.equal(digestoCanonico(world), digest);
  });
}

// ───────────────────────── 2. hypot exacto ─────────────────────────
test('V18 ola 2: hypotExact es idéntico bit a bit a Math.hypot (aleatorio, enteros, extremos, ±0, NaN, ∞)', () => {
  const random = lcg(2026);
  const check = (x: number, y: number) => assert.ok(Object.is(hypotExact(x, y), Math.hypot(x, y)), `hypot(${x}, ${y})`);
  for (let i = 0; i < 300_000; i++) {
    check((random() - 0.5) * 40, (random() - 0.5) * 40);
    check(Math.floor(random() * 30) - 15, Math.floor(random() * 30) - 15);
    check((random() - 0.5) * 1e7, Math.floor(random() * 1e7));
    if (i % 10 === 0) { check(random() * 1e-200, random() * 1e-200); check(random() * 1e200, random() * 1e200); check(random() * 1e-310, random()); }
  }
  for (const [x, y] of [[0, 0], [-0, 0], [0, -0], [-0, -0], [NaN, 1], [1, NaN], [Infinity, NaN], [NaN, Infinity], [-Infinity, 3], [3, 4],
    [5e-324, 0], [Number.MAX_VALUE, Number.MAX_VALUE], [0.5, 0.5], [1, 1], [-7, 24]] as const) check(x, y);
});

// ───────────────────────── 3. technologyStock ─────────────────────────
// Referencia: el código anterior, literal.
function referenceStock(actor: TechnologyStockActor): ResourceMass[] {
  const map = new Map<string, number>();
  for (const item of actor.technology.items) {
    const id = item.recipeId ? `recipe:${item.recipeId}` : 'unclassified';
    map.set(id, (map.get(id) ?? 0) + item.mass);
  }
  for (const m of ['wood', 'stone', 'water'] as const) if (actor.technology.residue[m]) map.set(`residue:${m}`, actor.technology.residue[m]);
  return [...map].map(([resourceId, mass]) => ({ resourceId, mass })).sort((a, b) => a.resourceId.localeCompare(b.resourceId));
}
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789-'.split('');
const ODD = ['A', 'Z', '_', ':', 'é', ' ', '.', 'ñ', '１', 'ch', 'll'];
function randomRecipeId(random: () => number, odd: boolean): string {
  let id = random() < 0.5 ? 'recipe-' : '';
  for (let i = 1 + Math.floor(random() * 6); i > 0; i--) id += odd && random() < 0.3 ? ODD[Math.floor(random() * ODD.length)]! : ALPHABET[Math.floor(random() * ALPHABET.length)]!;
  return id;
}
test('V18 ola 2: technologyStock = referencia (mismas líneas, mismo orden, mismas masas) con ids de receta normales y extraños', () => {
  const random = lcg(7);
  for (let iteration = 0; iteration < 60_000; iteration++) {
    const pool = Array.from({ length: 1 + Math.floor(random() * 5) }, () => randomRecipeId(random, iteration % 3 === 0));
    const items = Array.from({ length: Math.floor(random() * 10) }, () => ({
      recipeId: random() < 0.25 ? null : random() < 0.05 ? '' : pool[Math.floor(random() * pool.length)]!, mass: Math.floor(random() * 4000) + 1 })) as unknown as MaterialBatch[];
    const actor = { id: 'a', technology: { items, residue: { wood: random() < 0.5 ? Math.floor(random() * 100) : 0, stone: random() < 0.5 ? 5 : 0, water: random() < 0.3 ? 7 : 0 } } } as unknown as TechnologyStockActor;
    assert.deepEqual(technologyStock(actor as never), referenceStock(actor));
  }
});
test('V18 ola 2: technologyStock con ids de receta no cadena (forjados) sigue la clave por conversión de siempre', () => {
  const actor = { id: 'a', technology: { items: [{ recipeId: 5, mass: 3 }, { recipeId: '5', mass: 4 }, { recipeId: 0, mass: 1 }, { recipeId: null, mass: 2 }],
    residue: { wood: 0, stone: 9, water: 0 } } } as unknown as TechnologyStockActor;
  assert.deepEqual(technologyStock(actor as never), referenceStock(actor));
  assert.deepEqual(technologyStock(actor as never).map(l => l.resourceId), ['recipe:5', 'residue:stone', 'unclassified']);
});

// ───────────────────────── 4. checkpoint ─────────────────────────
// Referencia: el código anterior, literal (captura y validación).
const idAlphabet = (code: number) => code === 45 || (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
function referenceCompareId(a: string, b: string): number {
  const n = a.length < b.length ? a.length : b.length;
  for (let i = 0; i < n; i++) {
    const left = a.charCodeAt(i), right = b.charCodeAt(i);
    if (!idAlphabet(left) || !idAlphabet(right)) return a.localeCompare(b);
    if (left !== right) return left - right;
  }
  const rest = a.length > b.length ? a : b;
  for (let i = n; i < rest.length; i++) if (!idAlphabet(rest.charCodeAt(i))) return a.localeCompare(b);
  return a.length - b.length;
}
function referenceCapture(state: TechnologyState, actors: readonly TechnologyStockActor[], tick: number, reason: TechnologyCheckpoint['reason']): TechnologyCheckpoint {
  return { version: 1, tick, executionCounter: state.executionCounter, reason,
    ...(state.water ? { water: { ...state.water } } : {}),
    inventories: actors.map(actor => ({ actorId: actor.id, residue: { ...actor.technology.residue },
      items: actor.technology.items.map(item => ({ id: item.id, recipeId: item.recipeId, mass: item.mass, composition: { ...item.composition }, ...(item.contents ? { contents: { ...item.contents } } : {}) }))
        .sort((a, b) => referenceCompareId(a.id, b.id)),
    })).sort((a, b) => referenceCompareId(a.actorId, b.actorId)) };
}
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 100;
function referenceComposition(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  let keys = 0;
  for (const key in value) if (Object.hasOwn(value, key) && ++keys > 3) return false;
  if (keys !== 3) return false;
  const record = value as Record<string, unknown>;
  return integer(record.wood) && integer(record.stone) && integer(record.water);
}
function referenceProductSerial(id: string, max: number): boolean {
  if (id.length < 9 || !id.startsWith('product-')) return false;
  const first = id.charCodeAt(8);
  if (first < 49 || first > 57) return false;
  let value = first - 48;
  for (let i = 9; i < id.length; i++) {
    const digit = id.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return false;
    value = value * 10 + digit;
  }
  return integer(value, max);
}
function referenceAssert(state: TechnologyState, tick: number): void {
  const checkpoint = state.checkpoint;
  if (checkpoint === undefined) return;
  const fail = (): never => { throw new Error('Invalid technology opening checkpoint.'); };
  if (!checkpoint || checkpoint.version !== 1 || !integer(checkpoint.tick, tick) || !integer(checkpoint.executionCounter, state.executionCounter) ||
    !['initial', 'migration', 'history-gap', 'roster-change'].includes(checkpoint.reason) ||
    !Array.isArray(checkpoint.inventories) || checkpoint.inventories.length > POPULATION_HARD_LIMIT) fail();
  if (checkpoint.reason === 'initial' && (checkpoint.tick !== 0 || checkpoint.executionCounter !== 0)) fail();
  for (const event of state.history) {
    const serial = Number(event.id.slice(8));
    if (serial <= checkpoint.executionCounter ? event.tick > checkpoint.tick : event.tick <= checkpoint.tick) fail();
  }
  const actorIds = new Set<string>(), itemIds = new Set<string>();
  let contained = 0;
  const existed = new Map<string, boolean>();
  const recipeExisted = (id: string): boolean => {
    let result = existed.get(id);
    if (result === undefined) {
      const recipe = resolveTechnologyRecipe({ technology: state, tick }, id, { cache: false });
      result = !!recipe && recipe.tick <= checkpoint.tick;
      existed.set(id, result);
    }
    return result;
  };
  for (const inventory of checkpoint.inventories) {
    if (!inventory || !identifier(inventory.actorId) || actorIds.has(inventory.actorId) || !referenceComposition(inventory.residue) ||
      !Array.isArray(inventory.items) || inventory.items.length > state.budgets.maxItems) fail();
    actorIds.add(inventory.actorId);
    for (const item of inventory.items) {
      if (!item) fail();
      const itemId = item.id;
      if (!identifier(itemId) || !referenceProductSerial(itemId, state.itemCounter) ||
        itemIds.has(itemId) || !(item.recipeId === null || recipeExisted(item.recipeId)) || !referenceComposition(item.composition) ||
        !integer(item.mass) || item.mass === 0 || item.mass !== item.composition.wood + item.composition.stone + item.composition.water) fail();
      itemIds.add(item.id);
      if (item.contents !== undefined) {
        if (!state.water) fail();
        assertContainedWater(item.contents, checkpoint.tick);
        contained += item.contents.water;
      }
    }
  }
  if (checkpoint.water !== undefined) {
    if (!state.water) fail();
    assertWaterLedger(checkpoint.water, contained);
  } else if (contained) fail();
}
const outcome = (run: () => void): string => { try { run(); return 'ok'; } catch (error) { return `${(error as Error).constructor.name}: ${(error as Error).message}`; } };

/** Un estado tecnológico con 16 recetas reales y actores con objetos de esas recetas, sin contenedores de agua. */
function technologyScenario(people: number, itemsPerActor: (index: number) => number, seed = 7) {
  const world = createWorld(seed, DEFAULT_PARAMS);
  const founders = world.people;
  world.people = Array.from({ length: people }, (_, i) => {
    const person = structuredClone(founders[i % founders.length]!);
    person.id = `perf-${i}`; person.materials = { wood: 3 + i % 10, stone: 2 + i % 7 };
    return person;
  });
  for (let a = 1; a <= 4; a++) for (let b = 1; b <= 4; b++) {
    const program: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }], steps: [{ op: 'form', shape: 'edge', intensity: a }, { op: 'abrade', intensity: b }] };
    let item = rawMaterial('stone'); for (const step of program.steps) item = applyPhysicalOperation(step, [item]).product!;
    world.technology.recipes.push({ id: `recipe-${++world.technology.recipeCounter}`, name: 'Filo sintético', program, signature: programSignature(program), generation: 1,
      parents: [], inventorId: 's', tick: 0, x: 0, y: 0, capacities: materialCapacities(item), novelty: 'program', uses: 0, utility: 0, manufactured: 0 });
  }
  let serial = 0;
  world.people.forEach((person, i) => {
    person.technology.residue = { wood: i % 3 ? 1000 : 0, stone: i % 5 ? 500 : 0, water: 0 };
    person.technology.items = Array.from({ length: itemsPerActor(i) }, (_, k) => {
      const mass = 1000 + k * 500;
      return { id: `product-${++serial}`, recipeId: k === 0 ? null : `recipe-${1 + (i + k) % 16}`, composition: { wood: mass, stone: 0, water: 0 }, mass,
        properties: {} as MaterialBatch['properties'], generation: 0, madeAt: 0, parentItems: [], initialMass: mass };
    });
  });
  world.technology.itemCounter = serial;
  return world;
}

test('V18 ola 2: captureTechnologyCheckpoint = referencia (JSON y estructura) con ids normales, extraños, repetidos y vacíos', () => {
  const world = technologyScenario(300, i => i % 9);
  const state = world.technology;
  for (const actors of [world.people, [...world.people].reverse(), [], world.people.slice(0, 1)]) {
    const mine = captureTechnologyCheckpoint(state, actors, 5, 'roster-change'), expected = referenceCapture(state, actors, 5, 'roster-change');
    assert.deepStrictEqual(mine, expected);
    assert.equal(JSON.stringify(mine), JSON.stringify(expected));
  }
  // Ids fuera del alfabeto, mayúsculas, repetidos: el orden sigue siendo el de `compareId`/`localeCompare` de siempre.
  const random = lcg(99);
  for (let iteration = 0; iteration < 400; iteration++) {
    const actors = Array.from({ length: 2 + Math.floor(random() * 12) }, () => ({ id: randomRecipeId(random, iteration % 2 === 0), technology: {
      residue: { wood: Math.floor(random() * 5), stone: 0, water: 0 },
      items: Array.from({ length: Math.floor(random() * 6) }, () => ({ id: randomRecipeId(random, iteration % 2 === 0), recipeId: random() < 0.3 ? null : 'recipe-1',
        mass: 1, composition: { wood: 1, stone: 0, water: 0 }, ...(random() < 0.1 ? { contents: { version: 1, water: 2, leakRemainder: 0, lastTick: 0 } } : {}) })) } })) as unknown as TechnologyStockActor[];
    const mine = captureTechnologyCheckpoint(state, actors, 1, 'migration'), expected = referenceCapture(state, actors, 1, 'migration');
    assert.deepStrictEqual(mine, expected);
    assert.equal(JSON.stringify(mine), JSON.stringify(expected));
  }
});
test('V18 ola 2: captureTechnologyCheckpoint copia (no comparte objetos con los actores) y falla igual ante ids que no son cadena', () => {
  const world = technologyScenario(20, () => 3);
  const captured = captureTechnologyCheckpoint(world.technology, world.people, 0, 'initial');
  for (const inventory of captured.inventories) { inventory.residue.wood = -1; for (const item of inventory.items) item.composition.wood = -1; }
  for (const person of world.people) { assert.notEqual(person.technology.residue.wood, -1); for (const item of person.technology.items) assert.notEqual(item.composition.wood, -1); }
  const forged = (id: unknown, items: number) => [{ id: 'a', technology: { residue: { wood: 0, stone: 0, water: 0 },
    items: Array.from({ length: items }, () => ({ id, recipeId: null, mass: 1, composition: { wood: 1, stone: 0, water: 0 } })) } }] as unknown as TechnologyStockActor[];
  for (const [id, items] of [[undefined, 2], [5, 2], [null, 3], [undefined, 1], [undefined, 0]] as const) {
    assert.equal(outcome(() => { captureTechnologyCheckpoint(world.technology, forged(id, items), 0, 'initial'); }).split(':')[0],
      outcome(() => { referenceCapture(world.technology, forged(id, items), 0, 'initial'); }).split(':')[0], `${String(id)} × ${items}`);
  }
  const twoActors = [{ id: undefined, technology: { residue: { wood: 0, stone: 0, water: 0 }, items: [] } }, { id: 'b', technology: { residue: { wood: 0, stone: 0, water: 0 }, items: [] } }] as unknown as TechnologyStockActor[];
  assert.equal(outcome(() => { captureTechnologyCheckpoint(world.technology, twoActors, 0, 'initial'); }).split(':')[0],
    outcome(() => { referenceCapture(world.technology, twoActors, 0, 'initial'); }).split(':')[0]);
});

test('V18 ola 2: assertTechnologyCheckpoint acepta lo mismo y rechaza lo mismo que la referencia (fuzz de 600 corrupciones, fail-closed)', () => {
  const random = lcg(31337);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  let rejected = 0, accepted = 0;
  const mutations: ((state: TechnologyState, checkpoint: TechnologyCheckpoint, tick: number) => void)[] = [
    (s, c) => { (c as { version: number }).version = 2; },
    (s, c, tick) => { c.tick = tick + 1; },
    (s, c) => { c.tick = -1; },
    (s, c) => { c.tick = 1.5; },
    (s, c) => { c.executionCounter = s.executionCounter + 1; },
    (s, c) => { (c as { reason: string }).reason = 'bogus'; },
    (s, c) => { c.reason = 'initial'; c.tick = 3; },
    (s, c) => { (c as { inventories: unknown }).inventories = {}; },
    (s, c) => { (s as { checkpoint: unknown }).checkpoint = null; },
    (s, c) => { c.inventories.length = POPULATION_HARD_LIMIT + 1; },
    (s, c) => { c.inventories[Math.floor(random() * c.inventories.length)]!.actorId = ''; },
    (s, c) => { c.inventories[Math.floor(random() * c.inventories.length)]!.actorId = 'x'.repeat(101); },
    (s, c) => { if (c.inventories.length > 1) c.inventories[1]!.actorId = c.inventories[0]!.actorId; },
    (s, c) => { delete (c.inventories[Math.floor(random() * c.inventories.length)]!.residue as Partial<Record<string, number>>).stone; },
    (s, c) => { (c.inventories[Math.floor(random() * c.inventories.length)]!.residue as unknown as Record<string, number>).extra = 1; },
    (s, c) => { c.inventories[Math.floor(random() * c.inventories.length)]!.residue.wood = -1; },
    (s, c) => { c.inventories[Math.floor(random() * c.inventories.length)]!.residue.wood = 0.5; },
    (s, c) => { (c.inventories[Math.floor(random() * c.inventories.length)] as { residue: unknown }).residue = [0, 0, 0]; },
    (s, c) => { (c.inventories[Math.floor(random() * c.inventories.length)] as { items: unknown }).items = null; },
    (s, c) => { const inv = c.inventories[Math.floor(random() * c.inventories.length)]!; while (inv.items.length <= s.budgets.maxItems) inv.items.push({ ...inv.items[0] ?? c.inventories.find(i => i.items.length)!.items[0]! }); },
    (s, c) => { const inv = pick(c.inventories.filter(i => i.items.length)); if (inv) (inv.items as unknown[])[0] = null; },
    (s, c) => { const inv = pick(c.inventories.filter(i => i.items.length)); if (inv) inv.items[0]!.id = pick(['product-0', 'product-01', 'item-1', 'product-', 'product-x', `product-${s.itemCounter + 1}`, 'PRODUCT-1', 'product-1.5', 'product- 1', '']); },
    (s, c) => { const inv = pick(c.inventories.filter(i => i.items.length)); if (inv) (inv.items[0] as { id: unknown }).id = pick([1, null, undefined, {}]); },
    (s, c) => { const inv = pick(c.inventories.filter(i => i.items.length > 1)); if (inv) inv.items[1]!.id = inv.items[0]!.id; },
    (s, c) => { const [a, b] = [pick(c.inventories.filter(i => i.items.length)), pick(c.inventories.filter(i => i.items.length))]; if (a && b && a !== b) b.items[0]!.id = a.items[0]!.id; },
    (s, c) => { const inv = pick(c.inventories.filter(i => i.items.some(it => it.recipeId))); if (inv) inv.items.find(it => it.recipeId)!.recipeId = pick(['recipe-999', 'nope', '', 'recipe-0']); },
    (s, c) => { const inv = pick(c.inventories.filter(i => i.items.length)); if (inv) (inv.items[0] as { recipeId: unknown }).recipeId = undefined; },
    (s, c) => { const inv = pick(c.inventories.filter(i => i.items.length)); if (inv) (inv.items[0]!.composition as unknown as Record<string, number>).extra = 1; },
    (s, c) => { const inv = pick(c.inventories.filter(i => i.items.length)); if (inv) delete (inv.items[0]!.composition as Partial<Record<string, number>>).water; },
    (s, c) => { const inv = pick(c.inventories.filter(i => i.items.length)); if (inv) inv.items[0]!.composition.wood = -3; },
    (s, c) => { const inv = pick(c.inventories.filter(i => i.items.length)); if (inv) inv.items[0]!.mass = 0; },
    (s, c) => { const inv = pick(c.inventories.filter(i => i.items.length)); if (inv) inv.items[0]!.mass += 1; },
    (s, c) => { const inv = pick(c.inventories.filter(i => i.items.length)); if (inv) inv.items[0]!.mass = 0.5; },
    (s, c) => { const inv = pick(c.inventories.filter(i => i.items.length)); if (inv) inv.items[0]!.contents = { version: 1, water: 1, leakRemainder: 0, lastTick: 0 }; },
    (s, c) => { delete (c as { water?: unknown }).water; },
    (s, c) => { (s as { water?: unknown }).water = undefined; },
    (s, c) => { s.itemCounter = Math.max(0, s.itemCounter - 3); },
    (s, c) => { s.itemCounter = Number.NaN; },
    (s, c) => { s.itemCounter = 2 ** 27; },
    (s, c) => { s.itemCounter = Number.MAX_SAFE_INTEGER; },
    (s, c) => { s.budgets.maxItems = 1; },
    (s, c) => { s.history.push({ id: 'process-1', tick: c.tick + 5 } as never); },
    (s, c) => { s.history.push({ id: `process-${s.executionCounter + 7}`, tick: Math.max(0, c.tick - 1) } as never); },
    (s, c) => { const inv = pick(c.inventories.filter(i => i.items.length)); if (inv) inv.items[0]!.id = `product-${Math.min(s.itemCounter, 2 ** 31)}`; },
  ];
  for (let iteration = 0; iteration < 600; iteration++) {
    const world = technologyScenario(12, i => (i + iteration) % 5, 7 + iteration % 3);
    const state = world.technology;
    // Un tercio de los casos parte de un estado con 2^27 < contador, otro tercio con un contador pequeño exacto.
    if (iteration % 3 === 1) state.itemCounter += 5;
    state.checkpoint = referenceCapture(state, world.people, world.tick, 'migration');
    const tick = world.tick + 2;
    assert.equal(outcome(() => assertTechnologyCheckpoint(state, tick)), 'ok', 'base válida');
    for (let applied = iteration % 5 === 0 ? 0 : 1 + Math.floor(random() * 2); applied > 0 && state.checkpoint; applied--) {
      // Una mutación puede dejar el punto de apertura en un estado donde otra ya no se aplica: se ignora y se sigue.
      try { pick(mutations)(state, state.checkpoint, tick); } catch { /* la mutación no aplica a este estado */ }
    }
    const reference = structuredClone(state);
    const expected = outcome(() => referenceAssert(reference, tick)), actual = outcome(() => assertTechnologyCheckpoint(state, tick));
    assert.equal(actual, expected, `iteración ${iteration}`);
    if (expected === 'ok') accepted++; else rejected++;
  }
  assert.ok(rejected > 300 && accepted > 60, `rechazos ${rejected}, aceptados ${accepted}`);
});

// ───────────────────────── 5. inventions.ts ─────────────────────────
// Referencias: el código anterior, literal (`functionalNear` con `Math.hypot`, afinidades por estructura).
type Point = { x: number; y: number };
const refDistance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const refFunctionalNear = (world: World, point: Point, radius = 1.5) => filtrarCerca(world.structures, point, radius + 1, s => Math.abs(s.x - point.x) <= radius + 1
  && Math.abs(s.y - point.y) <= radius + 1 && s.condition > BROKEN_CONDITION && tileAt(world, s)?.terrain === 'shelter' && refDistance(s, point) <= radius);
const refFoodAvailable = (world: World, person: Point): number => refFunctionalNear(world, person).reduce((sum, s) => sum + (blueprintAffordances(s.components).foodCapacity ? s.food : 0), 0);
const refWaterAvailable = (world: World, point: Point): number => (tileAt(world, point)?.drinkingWater ?? 0) + refFunctionalNear(world, point, 0.5)
  .reduce((sum, structure) => sum + (blueprintAffordances(structure.components).waterCapacity > 0 ? structure.water : 0), 0);
const clamp = (value: number, maximum = 1) => Math.max(0, Math.min(maximum, value));
function refObserveUse(world: World, structure: StructureView, benefit: number): void {
  if (benefit <= 0) return;
  structure.uses++;
  const blueprint = world.blueprints.find(b => b.id === structure.blueprintId);
  if (blueprint) { blueprint.uses++; blueprint.usefulness = clamp(blueprint.usefulness + (clamp(benefit) - blueprint.usefulness) * 0.04); }
}
function refTakeFood(world: World, person: Point, requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return 0;
  const member = person as Person;
  let taken = 0;
  for (const structure of refFunctionalNear(world, person).sort((a, b) => refDistance(person, a) - refDistance(person, b) || a.id.localeCompare(b.id))) {
    if (!blueprintAffordances(structure.components).foodCapacity) continue;
    const amount = Math.min(structure.food, requested - taken);
    structure.food -= amount; taken += amount; world.inventionDynamics.foodTaken += amount;
    if (esMiembro(world.people, member, world.tick) && member.action === 'eat' && member.hunger > 0) refObserveUse(world, structure, amount * 10);
    if (taken >= requested) break;
  }
  return taken;
}
function refTakeWater(world: World, person: Person, requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0 || !esMiembro(world.people, person, world.tick) || person.action !== 'drink'
    || refDistance(person, person.target) > 0.5 || person.thirst <= 0) return 0;
  const tile = tileAt(world, person); if (!tile) return 0;
  const needed = Math.min(requested, person.thirst / SED_POR_UNIDAD), ambient = Math.min(tile.drinkingWater ?? 0, needed);
  tile.drinkingWater = (tile.drinkingWater ?? 0) - ambient;
  let taken = ambient;
  for (const structure of refFunctionalNear(world, person, 0.5)) {
    if (blueprintAffordances(structure.components).waterCapacity <= 0) continue;
    const amount = Math.min(structure.water, needed - taken);
    structure.water -= amount; taken += amount;
    refObserveUse(world, structure, amount * 15);
    if (taken >= needed) break;
  }
  return taken;
}
function refFacilityRestQuality(world: World, person: Person): number {
  const outdoor = world.weather === 'rain' ? 0.2 : 0.55;
  if (!world.shelterBenefitEnabled) return outdoor;
  const structure = refFunctionalNear(world, person, 0.5).sort((a, b) => b.condition - a.condition || a.id.localeCompare(b.id))[0]; if (!structure) return outdoor;
  const a = blueprintAffordances(structure.components), fuel = world.weather === 'rain' || world.tick % 2400 >= 1800 ? a.hearths * 0.0005 : 0;
  return Math.max(outdoor, clamp((a.restQuality + (fuel > 0 && person.materials.wood >= fuel ? 0.12 : 0)) * structure.condition));
}
function refConstructionCost(world: World, person: Person) {
  const blueprint = world.blueprints.find(b => b.id === person.blueprintId && validBlueprint(b.components)) ?? world.blueprints.find(b => b.id === 'blueprint-base') ?? defaultBlueprint();
  return blueprintCost(blueprint.components);
}

const COMPONENT_SETS: StructureComponent[][] = [['frame', 'roof'], ['frame', 'roof', 'cistern'], ['frame', 'roof', 'granary'],
  ['frame', 'roof', 'cistern', 'garden', 'hearth'], ['frame', 'frame', 'roof', 'roof', 'cistern', 'granary'], ['frame', 'roof', 'granary', 'granary', 'hearth']];
/** `people` habitantes agrupados en poblados de 10 × 10 y `structures` estructuras repartidas entre ellos, sobre teselas reales. */
function settlementWorld(people: number, structures: number, seed = 7): World {
  const world = createWorld(seed, DEFAULT_PARAMS);
  for (let cx = 0; cx < 336; cx += 16) for (let cy = 0; cy < 336; cy += 16) activate(world, cx, cy);
  const founders = world.people, perSettlement = Math.ceil(people / 64);
  world.people = Array.from({ length: people }, (_, i) => {
    const person = structuredClone(founders[i % founders.length]!), k = Math.floor(i / perSettlement), j = i % perSettlement;
    person.id = `perf-${i}`; person.x = (k % 8) * 40 + 8 + j % 10; person.y = Math.floor(k / 8) * 40 + 8 + Math.floor(j / 10) % 10;
    person.target = { x: person.x, y: person.y }; person.materials = { wood: 3 + i % 10, stone: 2 + i % 7 };
    return person;
  });
  world.structures = []; world.structureCounter = 0;
  const random = lcg(seed);
  for (let k = 0; k < 64 && world.structures.length < structures; k++) for (let m = 0; m < Math.ceil(structures / 64) && world.structures.length < structures; m++) {
    const x = (k % 8) * 40 + 8 + (m * 3) % 10, y = Math.floor(k / 8) * 40 + 8 + Math.floor(m * 3 / 10) * 3, tile = tileAt(world, { x, y });
    if (!tile || tile.terrain === 'water' || tile.terrain === 'shelter') continue;
    const components = COMPONENT_SETS[world.structures.length % COMPONENT_SETS.length]!, capacities = blueprintAffordances(components);
    tile.terrain = 'shelter';
    world.structures.push({ id: `structure-${++world.structureCounter}`, x, y, blueprintId: 'blueprint-base', name: 'Refugio', components: [...components],
      condition: random() < 0.15 ? 0.05 : 0.3 + random() * 0.7, water: capacities.waterCapacity * random(), food: capacities.foodCapacity * random(), uses: 0, builtAt: 0, builderId: 's' });
  }
  return world;
}
const sameStructures = (a: World, b: World) => assert.equal(JSON.stringify([a.structures, a.blueprints, a.inventionDynamics]), JSON.stringify([b.structures, b.blueprints, b.inventionDynamics]));

test('V18 ola 2: waterAvailable, foodAvailable, constructionCost y facilityRestQuality = referencia en cada habitante y en puntos fraccionarios', () => {
  const world = settlementWorld(1200, 400);
  world.shelterBenefitEnabled = true;
  const random = lcg(5);
  world.people.forEach((person, i) => { person.blueprintId = i % 7 === 0 ? 'blueprint-base' : i % 7 === 1 ? 'no-existe' : 'blueprint-base'; });
  for (const weather of ['clear', 'rain'] as const) for (const tick of [0, 1900]) {
    world.weather = weather; world.tick = tick;
    for (const person of world.people) {
      assert.ok(Object.is(waterAvailable(world, person), refWaterAvailable(world, person)));
      assert.ok(Object.is(foodAvailable(world, person), refFoodAvailable(world, person)));
      assert.ok(Object.is(facilityRestQuality(world, person), refFacilityRestQuality(world, person)));
      assert.deepEqual(constructionCost(world, person), refConstructionCost(world, person));
      const point = { x: person.x + (random() - 0.5) * 6, y: person.y + (random() - 0.5) * 6 };
      assert.ok(Object.is(waterAvailable(world, point), refWaterAvailable(world, point)));
      assert.ok(Object.is(foodAvailable(world, point), refFoodAvailable(world, point)));
    }
  }
  assert.ok(world.people.some(person => foodAvailable(world, person) > 0) && world.people.some(person => waterAvailable(world, person) > 0), 'el escenario ejerce depósitos reales');
});

test('V18 ola 2: takeFood y takeWater dejan exactamente el mismo estado (existencias, usos, utilidad, dinámica) que la referencia', () => {
  const mine = settlementWorld(900, 300, 11), ref = cloneWorld(mine);
  const random = lcg(13);
  mine.people.forEach((person, i) => {
    const copy = ref.people[i]!, thirst = random() * 0.9, hunger = random();
    for (const p of [person, copy]) {
      p.action = i % 3 === 0 ? 'drink' : i % 3 === 1 ? 'eat' : 'rest'; p.thirst = thirst; p.hunger = hunger; p.target = { x: p.x, y: p.y };
    }
  });
  for (const world of [mine, ref]) for (const person of world.people) { const tile = tileAt(world, person); if (tile) tile.drinkingWater = person.id.endsWith('1') ? 0.0004 : 0; }
  let withdrawn = 0;
  for (let round = 0; round < 3; round++) mine.people.forEach((person, i) => {
    const copy = ref.people[i]!, amount = [0.002, 0.006, 0.05, 0, -1, Number.NaN][(i + round) % 6]!;
    const food = [takeFood(mine, person, amount), refTakeFood(ref, copy, amount)], water = [takeWater(mine, person, amount), refTakeWater(ref, copy, amount)];
    assert.ok(Object.is(food[0], food[1]), `takeFood ${i}`); assert.ok(Object.is(water[0], water[1]), `takeWater ${i}`);
    withdrawn += food[0]! + water[0]!;
  });
  assert.ok(withdrawn > 0.05, 'el escenario retira existencias reales');
  sameStructures(mine, ref);
  assert.equal(JSON.stringify(mine.tiles.filter(tile => tile.drinkingWater !== undefined).map(tile => [tile.x, tile.y, tile.drinkingWater])),
    JSON.stringify(ref.tiles.filter(tile => tile.drinkingWater !== undefined).map(tile => [tile.x, tile.y, tile.drinkingWater])));
});

/** Digesto del mundo tras 4 revisiones de `stepStructures` (con aprendizaje de planos en los ticks múltiplos de 60), medido en el commit base. */
const STEP_STRUCTURES_BASE = '0a533d7574c059e2bc7720b5be64a7d79340ab5bda84662c5583d75c1289a19f';
test('V18 ola 2: stepStructures (lluvia, riego, depósito y aprendizaje de planos cada 60 pasos) deja el mismo mundo que el commit base', () => {
  const world = settlementWorld(600, 300, 17);
  world.learningEnabled = true; world.cooperationEnabled = true;
  for (let i = 1; i <= 5; i++) {
    const components = COMPONENT_SETS[i % COMPONENT_SETS.length]!;
    world.blueprints.push({ ...defaultBlueprint(), id: `blueprint-${++world.blueprintCounter}`, components: [...components], cost: blueprintCost(components),
      generation: 1, parents: ['blueprint-base'], inventorId: world.people[i]!.id, usefulness: i / 10 });
  }
  world.structures.forEach((structure, i) => { const blueprint = world.blueprints[i % world.blueprints.length]!; structure.blueprintId = blueprint.id; structure.components = [...blueprint.components]; });
  world.people.forEach((person, i) => { person.action = i % 11 === 0 ? 'build' : 'rest'; person.blueprintId = world.blueprints[i % world.blueprints.length]!.id; person.inventory = 0.1 + (i % 5) * 0.05; person.hunger = (i % 4) * 0.1; });
  const initial = world.people.map(person => person.blueprintId);
  for (const [tick, weather] of [[1200, 'rain'], [1260, 'clear'], [1320, 'rain'], [1380, 'clear']] as const) { world.tick = tick; world.weather = weather; stepStructures(world, () => ({}) as never); }
  assert.ok(world.people.some((person, i) => person.blueprintId !== initial[i]), 'algún habitante cambia de plano');
  assert.ok(world.inventionDynamics.waterCollected > 0 && world.inventionDynamics.foodStored > 0, 'hay recogida de agua y depósito de comida');
  assert.equal(digestoCanonico(world), STEP_STRUCTURES_BASE);
});

// ───────────────────────── 6. micro-benchmark (diagnóstico) ─────────────────────────
function bench(reps: number, run: () => void): number {
  run();
  const start = performance.now();
  for (let i = 0; i < reps; i++) run();
  return (performance.now() - start) / reps;
}
test('V18 ola 2: micro-benchmark 3 000 habitantes + 800 estructuras, antes (referencia) vs después', t => {
  const world = settlementWorld(3000, 800, 7);
  const scenario = technologyScenario(3000, i => 4 + i % 9);
  scenario.technology.checkpoint = captureTechnologyCheckpoint(scenario.technology, scenario.people, 0, 'initial');
  const state = scenario.technology, tick = scenario.tick, people = world.people;
  assert.ok(world.structures.length >= 700, `${world.structures.length} estructuras`);
  const rows: [string, number, number][] = [];
  const row = (name: string, reps: number, before: () => void, after: () => void) => {
    const slow = bench(reps, before), fast = bench(reps, after);
    rows.push([name, slow, fast]);
    t.diagnostic(`${name.padEnd(34)} antes ${slow.toFixed(3).padStart(8)} ms   después ${fast.toFixed(3).padStart(8)} ms   ×${(slow / fast).toFixed(2)}`);
  };
  row('captureTechnologyCheckpoint', 15, () => { referenceCapture(state, scenario.people, tick, 'roster-change'); }, () => { captureTechnologyCheckpoint(state, scenario.people, tick, 'roster-change'); });
  row('assertTechnologyCheckpoint', 15, () => { referenceAssert(state, tick); }, () => { assertTechnologyCheckpoint(state, tick); });
  row('technologyStock × 3 000 actores', 15, () => { for (const actor of scenario.people) referenceStock(actor); }, () => { for (const actor of scenario.people) technologyStock(actor); });
  row('waterAvailable × 3 000', 15, () => { let sum = 0; for (const person of people) sum += refWaterAvailable(world, person); return void sum; },
    () => { let sum = 0; for (const person of people) sum += waterAvailable(world, person); return void sum; });
  row('foodAvailable × 3 000', 15, () => { let sum = 0; for (const person of people) sum += refFoodAvailable(world, person); return void sum; },
    () => { let sum = 0; for (const person of people) sum += foodAvailable(world, person); return void sum; });
  row('constructionCost × 3 000', 15, () => { for (const person of people) refConstructionCost(world, person); }, () => { for (const person of people) constructionCost(world, person); });
  row('facilityRestQuality × 3 000', 15, () => { for (const person of people) refFacilityRestQuality(world, person); }, () => { for (const person of people) facilityRestQuality(world, person); });
  assert.equal(rows.length, 7);
});
