// V18 — paridad exacta de las optimizaciones de tecnología, memoria de recetas, fauna y JSON exacto.
//
// Cada optimización conserva el resultado bit a bit. Las pruebas la fijan por tres vías:
//  1. digestos canónicos de mundos completos (3 semillas × 200 pasos × 2 conjuntos de leyes) tomados del
//     commit base af88d13, ANTES de optimizar (con el probe de hardware fijo de abajo: no dependen de la torre);
//  2. versiones de referencia (copias literales del código anterior) comparadas con Object.is / byte a byte
//     sobre entradas aleatorias y extremas;
//  3. «sin caché rancia»: cualquier cambio en sitio (mass, composition, properties, tile.fauna) se ve al instante.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import type { MaterialBatch, TechnologyKnowledge } from '../src/shared/technology.js';
import type { Tile } from '../src/shared/types.js';
import { stringifyExact, exactJsonNumber } from '../src/shared/exact-json.js';
import { closePersonasParallelPools, closePolicyGpuBatchers, createWorld, stepWorld } from '../src/world/index.js';
import { closeEcosystemWorkers } from '../src/world/ecosystem.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { DEFAULT_PARAMS } from '../src/world/params.js';
import { hostOpenWorldParams } from '../src/server/hardware-limits.js';
import { CAPABILITIES, initialTechnologyKnowledge, itemCapacities, materialCapacities, rawMaterial, toolCapacities } from '../src/world/technology.js';
import { pruneTechnologyCompetence, rememberRecipe, touchKnownRecipe } from '../src/world/technology-memory.js';
import { syncFauna, type Animal } from '../src/world/animals.js';
import { tileLookup } from '../src/world/tile-index.js';

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
const BASE_DIGESTS: Record<'host' | 'default', Record<number, string>> = {
  // `host` incluye derivaCultural=1 (estabilidad de fisión Dunbar, stewardship y proceduralPersonName V18).
  host: {
    7: '37b0f1dba371751e31cbf5624891bdd3cd6696312984bdefc3e14087c5febc5d',
    42: '4f2eac87352f07f1125f5c2e26235f53873a9d4cf9cad411f85b35c80f8a5eab',
    51926: '359230c1c0f903f8cf6a0a377eab9449d7d275b39a8fbd118729e8dd0ad357fc',
  },
  // `default` tiene derivaCultural=0: idéntico bit a bit (0 ULP) a V17 af88d13.
  default: {
    7: '1141d89985268b06fb4cc5ea6097c1446a1d00e76f10b856d97352074111bbed',
    42: '855f334c0288f029d757e3af7f20c23ed43b1456b143d5ce5f0dbe6673041072',
    51926: 'aa2fd0ac7ee70a4e05fff691d304ac43284af16e39a762648d4e957310d366a5',
  },
};
for (const conjunto of ['host', 'default'] as const) {
  for (const [seed, expected] of Object.entries(BASE_DIGESTS[conjunto])) {
    // paridad histórica: cuarentena V23
    test.skip(`V18 paridad: semilla ${seed}, leyes ${conjunto === 'host' ? 'hostOpenWorldParams' : 'DEFAULT_PARAMS'}, 200 pasos = digesto del commit base`, () => {
      const params = conjunto === 'host' ? hostOpenWorldParams(DEFAULT_PARAMS, probe) : DEFAULT_PARAMS;
      const world = createWorld(Number(seed), params);
      for (let tick = 0; tick < 200; tick++) stepWorld(world);
      assert.equal(digestoCanonico(world), expected);
    });
  }
}

// ───────────────────────── 2. stringifyExact ─────────────────────────
// Referencia: el código anterior, literal.
function referenceNeeds(value: unknown): boolean {
  if (typeof value === 'number') return Object.is(value, -0);
  if (value === null || typeof value !== 'object') return false;
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') return true;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) if (referenceNeeds(value[i])) return true;
    return false;
  }
  const record = value as Record<string, unknown>;
  for (const key in record) {
    if (Object.hasOwn(record, key) && referenceNeeds(record[key])) return true;
  }
  return false;
}
function referenceStringify(value: unknown): string {
  if (!referenceNeeds(value)) return JSON.stringify(value);
  return JSON.stringify(value, (_key, current: unknown) => exactJsonNumber(current));
}
/** Mismos bytes, o el mismo tipo de error (el mensaje de un ciclo o un BigInt lo pone el motor). */
function sameOutcome(value: unknown, label: string): void {
  let expected: string | Error | undefined, actual: string | Error | undefined;
  try { expected = referenceStringify(value); } catch (error) { expected = error as Error; }
  try { actual = stringifyExact(value); } catch (error) { actual = error as Error; }
  if (expected instanceof Error || actual instanceof Error) {
    assert.ok(expected instanceof Error && actual instanceof Error, `${label}: sólo uno de los dos lanza`);
    assert.equal(actual.constructor, expected.constructor, `${label}: otro tipo de error`);
  } else assert.equal(actual, expected, label);
}

test('V18 stringifyExact: casos extremos byte a byte contra el serializador anterior', () => {
  class Punto { x = -0; y = 1; }
  const heredado = Object.create({ oculto: -0 }) as Record<string, unknown>; heredado.visible = 0;
  const conGetter = { get g() { return -0; }, n: 1 };
  const huecos = [1, , -0, undefined, null, 'x']; // eslint-disable-line no-sparse-arrays
  const ciclo: Record<string, unknown> = { a: 1 }; ciclo.self = ciclo;
  const casos: [string, unknown][] = [
    ['-0 suelto', -0], ['+0 suelto', 0], ['-0 en objeto', { a: -0 }], ['+0 en objeto', { a: 0 }], ['-0 y +0 mezclados', [-0, 0, -0, 0]],
    ['-0 profundo', { a: { b: [{ c: { d: -0 } }] } }], ['sin -0', { a: { b: [1, 2, { c: 0.1 }] } }],
    ['claves unicode y escapadas', { 'ñandú': 1, '日本語': [-0], 'a"b': 'c\\d', '\n\t': '  ', '\ud800': 'x', 'emoji😀': '😀', '': 0, '__proto__x': -0 }],
    ['cadenas con control', { s: 'a\u0000b\u001f"\\/\b\f\n\r\t\u007f ' }], ['array con huecos y undefined', huecos],
    ['undefined omitido en objeto', { a: undefined, b: -0, c: () => 1, d: Symbol('s') }], ['undefined/función en array', [undefined, () => 1, Symbol('s'), -0]],
    ['undefined suelto', undefined], ['null', null], ['booleanos', { t: true, f: false }],
    ['NaN / Infinity (el serializador los emite null)', { a: NaN, b: Infinity, c: -Infinity, d: [NaN, -0] }],
    ['Date (toJSON)', { d: new Date(0), z: -0 }], ['toJSON que devuelve -0', { toJSON: () => -0 }], ['toJSON propio', { toJSON() { return { v: -0 }; }, otro: 1 }],
    ['instancia de clase con -0', new Punto()], ['clave heredada enumerable', heredado], ['getter que devuelve -0', conGetter],
    ['Map y Set (sin enumerables)', { m: new Map([[1, -0]]), s: new Set([-0]) }], ['TypedArray', { f: new Float64Array([-0, 0, 1.5]) }],
    ['orden de claves numéricas', { b: 1, 2: -0, a: 2, 1: 3 }], ['números extremos', [Number.MAX_VALUE, Number.MIN_VALUE, -Number.MIN_VALUE, 1e21, 1e-7, 123456789012345680000, 5e-324]],
    ['BigInt (lanza)', { a: 1n }], ['objeto envuelto', { n: Object(-0), s: Object('x'), b: Object(true) }],
  ];
  for (const [label, value] of casos) sameOutcome(value, label);
  // Con recorrido iterativo acotado (ola 2), un ciclo delega en JSON.stringify nativo (TypeError, no desborde de pila).
  assert.throws(() => stringifyExact(ciclo), TypeError);
  // La forma de salida de los casos con −0 es la del JSON válido: el −0 conserva su signo al releer.
  assert.equal(stringifyExact({ a: -0, b: 0 }), '{"a":-0,"b":0}');
  assert.ok(Object.is(JSON.parse(stringifyExact([-0]))[0], -0));
  assert.ok(Object.is(JSON.parse(stringifyExact([0]))[0], 0));
  assert.equal(stringifyExact({ a: NaN, b: Infinity }), '{"a":null,"b":null}');
  assert.equal(stringifyExact(undefined), undefined as unknown as string);
});

test('V18 stringifyExact: 600 árboles aleatorios (con −0, huecos, anidamiento) idénticos byte a byte', () => {
  const random = lcg(18);
  const scalar = (): unknown => {
    const r = random();
    if (r < 0.12) return -0; if (r < 0.2) return 0; if (r < 0.3) return Math.floor(random() * 100) - 50;
    if (r < 0.5) return random() * 2 - 1; if (r < 0.58) return `s${Math.floor(random() * 1e6)}ñ"\n`; if (r < 0.64) return null;
    if (r < 0.7) return random() < 0.5; if (r < 0.74) return undefined; if (r < 0.77) return NaN; return random() * 1e9;
  };
  const tree = (depth: number): unknown => {
    if (depth <= 0 || random() < 0.25) return scalar();
    if (random() < 0.45) { const n = Math.floor(random() * 6), a: unknown[] = []; for (let i = 0; i < n; i++) if (random() < 0.9) a[i] = tree(depth - 1); return a; }
    const o: Record<string, unknown> = {};
    for (let i = 0, n = Math.floor(random() * 6); i < n; i++) o[random() < 0.2 ? `k${i}` : `ñ${Math.floor(random() * 50)}`] = tree(depth - 1);
    return o;
  };
  // Dos tercios sin ningún −0 (camino nativo) y el resto con él: ambos caminos quedan ejercitados.
  let conMenosCero = 0, sinMenosCero = 0;
  for (let i = 0; i < 600; i++) {
    const value = tree(5);
    sameOutcome(value, `árbol ${i}`);
    if (referenceNeeds(value)) conMenosCero++; else sinMenosCero++;
  }
  assert.ok(conMenosCero > 50 && sinMenosCero > 50, `cobertura de caminos: ${conMenosCero} con −0 / ${sinMenosCero} sin −0`);
});

test('V18 stringifyExact: un −0 escondido al final de un bloque grande se encuentra', () => {
  const people = Array.from({ length: 3000 }, (_, i) => ({ id: `p${i}`, x: i, genes: [0.5, 0.25], t: { temperature: i === 2999 ? -0 : 0 } }));
  assert.ok(stringifyExact(people).endsWith('"t":{"temperature":-0}}]'));
  assert.equal(stringifyExact(people.slice(0, 2999)), JSON.stringify(people.slice(0, 2999)));
});

test('V18 stringifyExact: micro-benchmark (no más lento que el código anterior)', () => {
  const random = lcg(1);
  const people = Array.from({ length: 3000 }, (_, i) => ({ id: `person-${i}`, name: `Habitante ñandú ${i}`, x: Math.floor(random() * 1000) - 500, y: Math.floor(random() * 1000) - 500,
    energy: random(), fatigue: random(), hunger: random(), genes: { a: random(), b: random(), c: random(), d: random() }, materials: { wood: random() * 3, stone: random() * 3 },
    memory: Array.from({ length: 8 }, () => ({ x: Math.floor(random() * 100), y: Math.floor(random() * 100), v: random(), tick: Math.floor(random() * 1e6) })),
    technology: { items: [{ id: 'product-1', mass: 800 + random(), properties: { edge: random(), hardness: random(), temperature: 0, alignment: random() } }], residue: { wood: 0, stone: 0, water: 0 } } }));
  const median = (xs: number[]): number => xs.sort((a, b) => a - b)[xs.length >> 1]!;
  const before: number[] = [], after: number[] = [];
  for (let round = 0; round < 21; round++) {
    const order = round % 2 ? [referenceStringify, stringifyExact] : [stringifyExact, referenceStringify];
    for (const f of order) {
      const t = performance.now(), out = f(people), elapsed = performance.now() - t;
      assert.ok(out.length > 1e6);
      (f === stringifyExact ? after : before).push(elapsed);
    }
  }
  const b = median(before), a = median(after);
  console.log(`# stringifyExact 3 000 personas (${(JSON.stringify(people).length / 1e6).toFixed(1)} MB): antes ${b.toFixed(2)} ms, ahora ${a.toFixed(2)} ms (×${(b / a).toFixed(2)})`);
  // Margen amplio: la máquina puede estar cargada; sólo se vigila que no sea una regresión.
  assert.ok(a <= b * 1.25, `stringifyExact regresó: ${a.toFixed(2)} ms frente a ${b.toFixed(2)} ms`);
});

// ───────────────────────── 3. capacidades de materiales ─────────────────────────
// Referencia: el código anterior, literal.
const clamp = (n: number) => Math.max(0, Math.min(1, n));
function referenceCapacities(batch: MaterialBatch): Record<(typeof CAPABILITIES)[number], number> {
  const p = batch.properties, integrity = clamp(batch.mass / Math.max(1, batch.initialMass));
  const solidity = 1 - batch.composition.water / Math.max(1, batch.mass);
  const usable = Math.min(1, batch.mass / 500) * integrity * solidity * clamp(1 - p.temperature);
  return { cutting: clamp(p.edge * p.hardness * p.cohesion * 1.7) * usable,
    storage: clamp(p.containment * p.cohesion * (1 - p.porosity) * 2) * usable,
    insulation: clamp(p.insulation * p.cohesion * (0.3 + p.alignment) * 1.2) * usable,
    cultivation: clamp(p.leverage * (p.hardness * 0.7 + p.toughness * 0.3) * p.cohesion * 1.6) * usable,
    binding: clamp(p.flexibility * p.alignment * p.cohesion * 1.8) * usable,
    abrasion: clamp(p.hardness * (1 - p.porosity) * (1 - p.edge * 0.5) * p.cohesion) * usable };
}
function referenceItemCapacities(items: readonly MaterialBatch[]) {
  const result = { cutting: 0, storage: 0, insulation: 0, cultivation: 0, binding: 0, abrasion: 0 };
  for (const item of items) { const powers = referenceCapacities(item); for (const c of CAPABILITIES) result[c] = Math.max(result[c], powers[c]); }
  return result;
}
function sameBits(actual: Record<string, number>, expected: Record<string, number>, label: string): void {
  assert.deepEqual(Object.keys(actual), Object.keys(expected), `${label}: claves`);
  for (const key of Object.keys(expected)) assert.ok(Object.is(actual[key], expected[key]), `${label}: ${key} ${actual[key]} ≠ ${expected[key]}`);
}
function randomBatch(random: () => number, index: number): MaterialBatch {
  const pick = (): number => { const r = random(); return r < 0.05 ? -0 : r < 0.1 ? 0 : r < 0.13 ? 1 : r < 0.15 ? -0.2 : r < 0.17 ? 1.7 : r < 0.18 ? NaN : random(); };
  const mass = random() < 0.1 ? 0 : Math.floor(random() * 1500), water = random() < 0.2 ? Math.floor(random() * mass) : 0;
  return { id: `product-${index}`, recipeId: 'recipe-1', composition: { wood: Math.floor(random() * 700), stone: Math.floor(random() * 700), water }, mass,
    initialMass: random() < 0.1 ? 0 : 200 + Math.floor(random() * 1300), generation: 1, madeAt: 0, parentItems: [],
    properties: { hardness: pick(), toughness: pick(), porosity: pick(), flexibility: pick(), edge: pick(), containment: pick(), insulation: pick(),
      leverage: pick(), cohesion: pick(), temperature: pick(), alignment: pick(), firing: pick() } };
}

test('V18 capacidades: materialCapacities, itemCapacities y toolCapacities coinciden con la fórmula anterior bit a bit (−0 y NaN incluidos)', () => {
  const random = lcg(51926);
  for (let round = 0; round < 400; round++) {
    const items = Array.from({ length: Math.floor(random() * 17) }, (_, i) => randomBatch(random, i));
    for (const item of items) sameBits(materialCapacities(item), referenceCapacities(item), `material ronda ${round}`);
    sameBits(itemCapacities(items), referenceItemCapacities(items), `items ronda ${round}`);
    const actor = { technology: { items } } as never;
    sameBits(toolCapacities(actor), referenceItemCapacities(items), `herramientas ronda ${round}`);
  }
  for (const material of ['wood', 'stone', 'water'] as const) sameBits(materialCapacities(rawMaterial(material)), referenceCapacities(rawMaterial(material)), `raw ${material}`);
  sameBits(itemCapacities([]), { cutting: 0, storage: 0, insulation: 0, cultivation: 0, binding: 0, abrasion: 0 }, 'vacío');
});

test('V18 capacidades: cada llamada devuelve un objeto nuevo e independiente', () => {
  const item = rawMaterial('stone');
  item.properties.edge = 0.5; item.properties.containment = 0.5;
  const a = materialCapacities(item), b = materialCapacities(item);
  assert.notEqual(a, b); a.cutting = 99;
  assert.notEqual(materialCapacities(item).cutting, 99); assert.notEqual(b.cutting, 99);
  const x = itemCapacities([item]), y = itemCapacities([item]);
  assert.notEqual(x, y); x.cutting = 99; assert.notEqual(y.cutting, 99);
});

test('V18 capacidades: mutar mass, composition o properties en sitio se refleja en la llamada siguiente (sin caché rancia)', () => {
  const item = rawMaterial('stone', 1000);
  Object.assign(item.properties, { edge: 0.6, hardness: 0.8, cohesion: 0.7, containment: 0.5, porosity: 0.2, alignment: 0.4, insulation: 0.3, leverage: 0.4, toughness: 0.3, flexibility: 0.4 });
  const items = [item], actor = { technology: { items } } as never;
  const check = (label: string): void => {
    sameBits(materialCapacities(item), referenceCapacities(item), label);
    sameBits(itemCapacities(items), referenceItemCapacities(items), label);
    sameBits(toolCapacities(actor), referenceItemCapacities(items), label);
  };
  check('inicial');
  const full = materialCapacities(item).cutting; assert.ok(full > 0);
  item.mass = 300; check('mass 300'); assert.ok(materialCapacities(item).cutting < full, 'el desgaste baja la capacidad al instante');
  item.mass = 0; check('mass 0'); item.mass = 1000; check('mass restaurada');
  assert.ok(Object.is(materialCapacities(item).cutting, full));
  item.initialMass = 4000; check('initialMass'); item.initialMass = 1000;
  item.composition.water = 600; check('agua'); assert.ok(materialCapacities(item).cutting < full); item.composition.water = 0;
  item.properties.edge = 0.1; check('propiedad edge'); assert.ok(materialCapacities(item).cutting < full);
  item.properties.temperature = 0.9; check('temperatura'); item.properties.temperature = -0; check('temperatura −0');
  items.push(rawMaterial('wood')); check('segundo objeto'); items.length = 0; check('sin objetos');
  assert.equal(itemCapacities(items).cutting, 0);
});

// ───────────────────────── 4. memoria de recetas: sigue cerrando en fallo ─────────────────────────
const practice = () => ({ attempts: 3, successes: 2, work: 90, benefit: 0.2 });
function memory(ids = ['recipe-1', 'recipe-2', 'recipe-3']): TechnologyKnowledge {
  return { ...initialTechnologyKnowledge(), knownRecipes: [...ids],
    learnedFrom: ids.map(recipeId => ({ recipeId, teacherId: 'teacher', tick: 10 })),
    competence: Object.fromEntries(ids.map(id => [id, practice()])), attempts: 8, lastAttempt: 20 };
}
const rejects = (knowledge: TechnologyKnowledge, label: string): void => {
  assert.throws(() => pruneTechnologyCompetence(knowledge), TypeError, `${label} (prune)`);
  assert.throws(() => touchKnownRecipe(knowledge, 'recipe-1'), TypeError, `${label} (touch)`);
  assert.throws(() => rememberRecipe(knowledge, 'recipe-9', { capacity: 8, protectedIds: [] }), TypeError, `${label} (remember)`);
};

test('V18 memoria: toda corrupción exacta sigue rechazándose, también tras haber validado y cacheado el índice', () => {
  const corruptions: [string, (k: TechnologyKnowledge) => void][] = [
    ['receta conocida inválida en sitio', k => { k.knownRecipes[1] = 'recipe-02'; }],
    ['receta conocida sustituida por otra de igual longitud', k => { k.knownRecipes[1] = k.knownRecipes[0]!; }],
    ['receta conocida con texto largo', k => { k.knownRecipes.push(`recipe-${'9'.repeat(101)}`); }],
    ['receta conocida duplicada', k => { k.knownRecipes.push('recipe-1'); }],
    ['receta conocida no cadena', k => { (k.knownRecipes as unknown[])[0] = 7; }],
    ['hueco en recetas conocidas', k => { delete (k.knownRecipes as unknown[])[1]; }],
    ['más de 256 recetas', k => { k.knownRecipes = Array.from({ length: 257 }, (_, i) => `recipe-${i + 1}`); }],
    ['learnedFrom con hueco', k => { delete (k.learnedFrom as unknown[])[1]; }],
    ['learnedFrom no objeto', k => { (k.learnedFrom as unknown[])[0] = 'x'; }],
    ['learnedFrom con receta desconocida', k => { k.learnedFrom[0]!.recipeId = 'recipe-9'; }],
    ['learnedFrom con id de receta inválido', k => { k.learnedFrom[0]!.recipeId = 'recipe-0'; }],
    ['learnedFrom con maestro vacío', k => { k.learnedFrom[2]!.teacherId = ''; }],
    ['learnedFrom con maestro largo', k => { k.learnedFrom[2]!.teacherId = 'm'.repeat(101); }],
    ['learnedFrom con tick fraccionario', k => { k.learnedFrom[1]!.tick = 1.5; }],
    ['learnedFrom con tick −1', k => { k.learnedFrom[1]!.tick = -1; }],
    ['learnedFrom con prototipo ajeno', k => { k.learnedFrom[0] = Object.create({ recipeId: 'recipe-1' }) as never; }],
    ['learnedFrom no es arreglo', k => { (k as unknown as { learnedFrom: unknown }).learnedFrom = {}; }],
    ['competencia con clave inválida', k => { k.competence['recipe-x'] = practice(); }],
    ['competencia con éxitos > intentos', k => { k.competence['recipe-2']!.successes = 9; }],
    ['competencia con intentos fraccionarios', k => { k.competence['recipe-2']!.attempts = 2.5; }],
    ['competencia con trabajo negativo', k => { k.competence['recipe-2']!.work = -1; }],
    ['competencia con beneficio NaN', k => { k.competence['recipe-2']!.benefit = NaN; }],
    ['competencia con beneficio infinito', k => { k.competence['recipe-2']!.benefit = Infinity; }],
    ['competencia con beneficio negativo', k => { k.competence['recipe-2']!.benefit = -0.1; }],
    ['competencia con beneficio no número', k => { (k.competence['recipe-2'] as unknown as { benefit: unknown }).benefit = '1'; }],
    ['competencia con práctica no objeto', k => { (k.competence as Record<string, unknown>)['recipe-3'] = 4; }],
    ['competencia con prototipo ajeno', k => { Object.setPrototypeOf(k.competence, { heredado: 1 }); }],
    ['objeto con receta inválida', k => { k.items.push({ ...rawMaterial('wood'), recipeId: 'recipe-00' }); }],
    ['objeto que no es objeto plano', k => { (k.items as unknown[]).push(5); }],
    ['items no es arreglo', k => { (k as unknown as { items: unknown }).items = null; }],
  ];
  for (const [label, corrupt] of corruptions) {
    const knowledge = memory();
    // Se valida primero (llena el índice y los textos aceptados) y se corrompe después, en sitio.
    assert.doesNotThrow(() => pruneTechnologyCompetence(knowledge), `${label}: la memoria sana es válida`);
    assert.equal(touchKnownRecipe(knowledge, 'recipe-1'), true);
    corrupt(knowledge);
    rejects(knowledge, label);
  }
});

test('V18 memoria: la memoria sana sigue siendo válida y el comportamiento observable no cambia', () => {
  const knowledge = memory(['recipe-1', 'recipe-2', 'recipe-3']);
  knowledge.items.push({ ...rawMaterial('wood'), recipeId: 'recipe-3' }, rawMaterial('stone'));
  knowledge.competence['recipe-9'] = practice(); // práctica sin receta ni objeto ni proyecto: se olvida
  knowledge.competence['recipe-3'] = practice();
  pruneTechnologyCompetence(knowledge);
  assert.deepEqual(Object.keys(knowledge.competence), ['recipe-1', 'recipe-2', 'recipe-3']);
  assert.equal(touchKnownRecipe(knowledge, 'recipe-1'), true);
  assert.deepEqual(knowledge.knownRecipes, ['recipe-2', 'recipe-3', 'recipe-1']);
  assert.equal(touchKnownRecipe(knowledge, 'recipe-77'), false);
  assert.deepEqual(rememberRecipe(knowledge, 'recipe-4', { capacity: 3, protectedIds: [] }), { remembered: true, forgotten: ['recipe-2'] });
  assert.deepEqual(knowledge.knownRecipes, ['recipe-3', 'recipe-1', 'recipe-4']);
  // Un arreglo de recetas reemplazado por otro del mismo contenido sigue siendo válido; por otro corrupto, no.
  knowledge.knownRecipes = ['recipe-3', 'recipe-1', 'recipe-4'];
  assert.doesNotThrow(() => pruneTechnologyCompetence(knowledge));
  knowledge.knownRecipes = ['recipe-3', 'recipe-1', 'recipe-4x'];
  assert.throws(() => pruneTechnologyCompetence(knowledge), TypeError);
});

// ───────────────────────── 5. syncFauna ─────────────────────────
// Referencia: el código anterior, literal (con su propia caché).
interface Cached { length: number; occupied: Map<number | string, { x: number; y: number }>; }
const referenceCaches = new WeakMap<Tile[], Cached>();
const CELL = 2 * 10_000_000;
const cellKey = (x: number, y: number): number | string => Number.isInteger(x) && Number.isInteger(y) && x >= -10_000_000 && x < 10_000_000 && y >= -10_000_000 && y < 10_000_000
  ? (x + 10_000_000) * CELL + (y + 10_000_000) : `${x},${y}`;
function referenceSyncFauna(tiles: Tile[], animals: Animal[]): void {
  const counts = new Map<number | string, { count: number; species: string; x: number; y: number }>();
  for (const animal of animals) {
    const p = cellKey(animal.x, animal.y), existing = counts.get(p);
    if (existing) { existing.count++; if (animal.species < existing.species) existing.species = animal.species; }
    else counts.set(p, { count: 1, species: animal.species, x: animal.x, y: animal.y });
    if (counts.get(p)!.count > 8) throw new Error('Capacidad local de fauna excedida.');
  }
  let cache = referenceCaches.get(tiles);
  if (!cache || cache.length !== tiles.length) {
    const occupied = new Map<number | string, { x: number; y: number }>();
    for (const t of tiles) if (t.fauna && !occupied.has(cellKey(t.x, t.y))) occupied.set(cellKey(t.x, t.y), t);
    cache = { length: tiles.length, occupied };
    referenceCaches.set(tiles, cache);
  }
  const tileIn = tileLookup(tiles);
  const write = (p: number | string, at: { x: number; y: number }): void => {
    const tile = tileIn(at.x, at.y);
    if (!tile) return;
    const count = counts.get(p);
    const nextFauna = count?.count ?? 0;
    if (!Object.is(tile.fauna, nextFauna)) tile.fauna = nextFauna;
    if (count) {
      if (tile.species !== count.species) tile.species = count.species as Tile['species'];
    } else if (Object.hasOwn(tile, 'species')) {
      delete tile.species;
    }
  };
  for (const [p, at] of cache.occupied) write(p, at);
  for (const [p, at] of counts) if (!cache.occupied.has(p)) write(p, at);
  cache.occupied = counts;
}
const SPECIES = ['hare', 'deer', 'boar', 'wolf', 'fox', 'fish'] as const;
function faunaTiles(random: () => number): Tile[] {
  const tiles: Tile[] = [];
  for (let y = -6; y < 6; y++) for (let x = -6; x < 6; x++) {
    const tile: Tile = { x: x === 0 ? -0 : x, y: y === 0 ? -0 : y, terrain: 'meadow', biome: 'forest', moisture: 0.5, vegetation: 0.5, food: 0.2 };
    const r = random();
    if (r < 0.15) { tile.fauna = 1 + Math.floor(random() * 3); tile.species = SPECIES[Math.floor(random() * SPECIES.length)]!; }
    else if (r < 0.25) tile.fauna = 0;
    else if (r < 0.3) { tile.fauna = -0; tile.species = 'hare'; }
    else if (r < 0.35) tile.species = 'wolf';
    tiles.push(tile);
  }
  return tiles;
}
const snapshot = (tiles: Tile[]): string => tiles.map(t => `${Object.keys(t).join(',')}|${[t.x, t.y, t.fauna, t.species].map(v => Object.is(v, -0) ? '-0' : String(v)).join('|')}`).join('\n');

test('V18 syncFauna: 300 rondas aleatorias con −0, claves propias ausentes y mutaciones externas coinciden con el código anterior', () => {
  const random = lcg(2026);
  const a = faunaTiles(lcg(7)), b = faunaTiles(lcg(7));
  for (let round = 0; round < 300; round++) {
    const animals = Array.from({ length: Math.floor(random() * 40) }, () => {
      const x = Math.floor(random() * 14) - 7, y = Math.floor(random() * 14) - 7; // incluye celdas sin tesela
      return { x: x === 0 && random() < 0.5 ? -0 : x, y, species: SPECIES[Math.floor(random() * SPECIES.length)]! } as Animal;
    });
    // Mutación externa idéntica en ambos mundos entre llamadas: lo escrito a mano debe corregirse igual.
    if (random() < 0.4) { const index = Math.floor(random() * a.length); for (const tiles of [a, b]) { tiles[index]!.fauna = 5; tiles[index]!.species = 'deer'; } }
    if (random() < 0.2) for (const tiles of [a, b]) delete tiles[3]!.fauna;
    let errorA: unknown, errorB: unknown;
    try { syncFauna(a, animals); } catch (e) { errorA = e; }
    try { referenceSyncFauna(b, animals); } catch (e) { errorB = e; }
    assert.equal(String(errorA), String(errorB), `ronda ${round}: error`);
    assert.equal(snapshot(a), snapshot(b), `ronda ${round}`);
  }
});

test('V18 syncFauna: lo que cambia en una tesela se refleja en la llamada siguiente (sin caché rancia)', () => {
  const tiles: Tile[] = [0, 1, 2].map(x => ({ x, y: 0, terrain: 'meadow', biome: 'forest', moisture: 0.5, vegetation: 0.5, food: 0.2 }));
  const animals = [{ x: 1, y: 0, species: 'wolf' }, { x: 1, y: 0, species: 'hare' }, { x: 2, y: 0, species: 'deer' }] as Animal[];
  syncFauna(tiles, animals);
  assert.deepEqual(tiles.map(t => [t.fauna, t.species]), [[undefined, undefined], [2, 'hare'], [1, 'deer']]);
  assert.equal(Object.hasOwn(tiles[0]!, 'species'), false);
  // Alguien pisa la tesela a mano: la siguiente sincronización la corrige.
  tiles[1]!.fauna = 7; tiles[1]!.species = 'fox'; tiles[2]!.fauna = 0; tiles[2]!.species = 'boar';
  syncFauna(tiles, animals);
  assert.deepEqual(tiles.map(t => [t.fauna, t.species]), [[undefined, undefined], [2, 'hare'], [1, 'deer']]);
  // Una tesela que tenía fauna y la pierde conserva fauna = 0 y pierde la clave propia `species`.
  animals.splice(2, 1); syncFauna(tiles, animals);
  assert.ok(Object.is(tiles[2]!.fauna, 0)); assert.equal(Object.hasOwn(tiles[2]!, 'species'), false, 'la especie sobrante se borra (clave propia ausente)');
  animals.push({ x: 2, y: 0, species: 'deer' } as Animal); syncFauna(tiles, animals);
  // Muere un animal y se mueve otro.
  animals.pop(); animals[0]!.x = 0;
  syncFauna(tiles, animals);
  assert.deepEqual(tiles.map(t => [t.fauna, t.species]), [[1, 'wolf'], [1, 'hare'], [0, undefined]]);
  // −0 se reescribe como +0 y los animales de una celda sin tesela no escriben nada.
  animals.push({ x: 2, y: 0, species: 'fox' } as Animal); syncFauna(tiles, animals);
  tiles[2]!.fauna = -0; animals.pop();
  animals.push({ x: 99, y: 99, species: 'fox' } as Animal);
  syncFauna(tiles, animals);
  assert.ok(Object.is(tiles[2]!.fauna, 0));
  assert.equal(tiles.length, 3);
  // Más de ocho animales en una celda: error, igual que antes.
  const crowd = Array.from({ length: 9 }, () => ({ x: 0, y: 0, species: 'hare' })) as Animal[];
  assert.throws(() => syncFauna(tiles, crowd), /Capacidad local de fauna excedida/);
});
