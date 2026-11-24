// V19 fase 1 — factores L (aprendizaje causal), S (acuerdos materiales) y F+R+M (fauna depredadora).
// Diseño: `docs/DISENO-V19.md`. Cada prueba es rápida (< 15 s en total) y no usa el laboratorio.
//
//  1. Con los interruptores V19 apagados el mundo es el de V18 bit a bit: los digestos de referencia se midieron
//     con el código de `4c97666` (HEAD de `sprint/v19-emergencia` antes de la fase 1) y sólo difieren en la
//     etiqueta de reglas, que se normaliza a 12 (la carga `version = 12` migra a 13 sin tocar el estado).
//  2. L: una persona descansada con un fuerte sesgo de descanso no acampa; una cansada sí descansa y se recupera.
//  3. S: un acuerdo materialmente imposible no se firma aunque la apertura sea 0,95; los cumplidos y los
//     incumplidos mueven la confianza y la apertura en sentidos opuestos.
//  4. F+R+M: `tests/v19-phase1-fauna.test.ts` (fixture de depredadores, paridad 0 ULP hilos 1 vs 4) se importa al
//     final de este fichero para que una sola ejecución cubra los cuatro desafíos.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  cloneWorld, closeFaunaParallelPools, closePersonasParallelPools, closePolicyGpuBatchers, createWorld, migrateWorld,
  RULES_VERSION, stepWorld, type Person, type World,
} from '../src/world/index.js';
import { closeEcosystemWorkers } from '../src/world/ecosystem.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { DEFAULT_PARAMS, HISTORICAL_PARAMS, parseParams, setParams, type WorldParams } from '../src/world/params.js';
import { hostOpenWorldParams } from '../src/server/hardware-limits.js';
import { POLICY_ACTIONS, initialPolicyPlasticity, updatePolicyPlasticity, updatePolicyPlasticityCausal } from '../src/world/politica.js';
import { observeAgreementOutcome, resourceDispute, settleAgreement } from '../src/world/society.js';
import { tileAt } from '../src/world/spatial.js';
import { readSnapshotParams } from '../src/server/snapshot.js';

after(async () => {
  closePolicyGpuBatchers();
  await closeFaunaParallelPools();
  await closePersonasParallelPools();
  await closeEcosystemWorkers();
});

const GiB = 1024 ** 3;
const probe = { cpuThreads: () => 1, totalRamBytes: () => 128 * GiB, nvrtcAvailable: () => false, nvidiaSmi: () => '',
  memory: () => ({ fisicaBytes: 128 * GiB, heapBytes: 8 * GiB }) };
const V19_OFF = { conducta: { aprendizajeCausal: false }, social: { acuerdosMateriales: false },
  fauna: { contactoContinuo: false, reservaReproductiva: false, encuentroFertil: false },
  construccion: { modular: false }, tecnologia: { obrasPorPropiedades: false },
  ecologia: { amplitudEstacional: 0 } } as const;
const hostWith = (overrides: Record<string, unknown> = {}): WorldParams => parseParams(overrides, hostOpenWorldParams(DEFAULT_PARAMS, probe));

// ───────────────────────── 0. esquema de parámetros ─────────────────────────
test('V19 fase 1: los interruptores nacen apagados en DEFAULT y HISTORICAL; sólo L, S, F, R y M se activan en el anfitrión abierto', () => {
  assert.equal(RULES_VERSION, 13);
  for (const params of [DEFAULT_PARAMS, HISTORICAL_PARAMS]) {
    assert.deepEqual([params.conducta.aprendizajeCausal, params.social.acuerdosMateriales, params.fauna.contactoContinuo,
      params.fauna.reservaReproductiva, params.fauna.encuentroFertil, params.construccion.modular, params.tecnologia.obrasPorPropiedades,
      params.ecologia.amplitudEstacional], [false, false, false, false, false, false, false, 0]);
    assert.deepEqual([params.conducta.memoriaResultadoTicks, params.social.memoriaResultadosDias, params.fauna.fraccionReservaCria,
      params.ecologia.periodoEstacionalDias, params.ecologia.escalaClimaticaCeldas], [2400, 10, 0.15, 20, 64]);
  }
  const host = hostWith();
  assert.deepEqual([host.conducta.aprendizajeCausal, host.social.acuerdosMateriales, host.fauna.contactoContinuo, host.fauna.reservaReproductiva,
    host.fauna.encuentroFertil], [true, true, true, true, true]);
  assert.deepEqual([host.construccion.modular, host.tecnologia.obrasPorPropiedades, host.ecologia.amplitudEstacional], [true, true, 0.25]);
  assert.throws(() => parseParams('fauna.fraccionReservaCria=1.5'), /fuera de rango/);
  assert.throws(() => parseParams('conducta.memoriaResultadoTicks=0'), /fuera de rango/);
  assert.throws(() => parseParams('social.memoriaResultadosDias=2.5'), /entero/);
  assert.throws(() => parseParams('ecologia.escalaClimaticaCeldas=0'), /fuera de rango/);
  assert.equal(parseParams('fauna.reservaReproductiva=true').fauna.reservaReproductiva, true);
});

test('V19 fase 1: una instantánea con params V18 (sin claves V19) carga con todo apagado; una con params V19 conserva sus valores', () => {
  const legacy = structuredClone(DEFAULT_PARAMS) as unknown as Record<string, Record<string, unknown>>;
  delete legacy.fauna; delete legacy.construccion; delete legacy.ecologia;
  for (const key of ['aprendizajeCausal', 'memoriaResultadoTicks']) delete legacy.conducta![key];
  for (const key of ['acuerdosMateriales', 'memoriaResultadosDias']) delete legacy.social![key];
  delete legacy.tecnologia!.obrasPorPropiedades;
  const loaded = readSnapshotParams({ params: legacy, paramsEncoding: 'params-v1', limitsProfile: {} });
  assert.deepEqual([loaded.conducta.aprendizajeCausal, loaded.social.acuerdosMateriales, loaded.fauna, loaded.construccion, loaded.ecologia],
    [false, false, HISTORICAL_PARAMS.fauna, HISTORICAL_PARAMS.construccion, HISTORICAL_PARAMS.ecologia]);
  const host = hostWith();
  const reloaded = readSnapshotParams({ params: JSON.parse(JSON.stringify(host)), paramsEncoding: 'params-v1', limitsProfile: {} });
  assert.deepEqual(reloaded.fauna, host.fauna);
  assert.deepEqual([reloaded.conducta.aprendizajeCausal, reloaded.social.acuerdosMateriales], [true, true]);
});

// ───────────────────────── 1. 0 ULP frente a V18 ─────────────────────────
// Medidos con el código de HEAD antes de la fase 1 (RULES_VERSION 12), 60 pasos con DEFAULT_PARAMS y 300 con el
// anfitrión abierto (sondeo fijo de hardware, un hilo): ver el encabezado.
const V18_DEFAULT_60: Record<number, string> = {
  7: '95017b600163b8ccc51e6be2961d7d6d2be31412ecdaba3ad0cac4b4fd0420ca',
  42: '66271ffc4b6b424214fc1a6fdfc784be354c45651133affc2703c0829f376828',
  51926: '98189db6f8697a10a0374b627d2c2938677b8953dbb92e07f2fe860b4b278b43',
  104729: 'c2ff0fde8cbafec05559c3dc7e59d2fb375f26959d71356949af42d8b784af8c',
};
const V18_HOST_300: Record<number, string> = {
  7: 'f0ab8eb74989f614bfc3de1cac658ad27bc269f8a8eabb49723f17745e343655',
  42: 'b99695ca036aa4b3f943de71673e13d7d4f78a330efa68db7f924c6806694a23',
};
/** Digesto con la etiqueta de reglas normalizada a 12 (única diferencia declarada neutral). */
function digestAsV18(world: World): string {
  const copy = cloneWorld(world);
  copy.version = 12;
  return digestoCanonico(copy);
}
function run(world: World, ticks: number): World { for (let i = 0; i < ticks; i++) stepWorld(world); return world; }

for (const [seedText, expected] of Object.entries(V18_DEFAULT_60)) {
  const seed = Number(seedText);
  test(`V19 fase 1: DEFAULT_PARAMS semilla ${seed}, 60 pasos = digesto V18, tanto creado como cargado desde version = 12`, () => {
    const created = run(createWorld(seed, DEFAULT_PARAMS), 60);
    assert.equal(created.version, 13);
    assert.equal(digestAsV18(created), expected, 'mundo nuevo con interruptores apagados');
    const legacy = createWorld(seed, DEFAULT_PARAMS);
    legacy.version = 12;
    const loaded = migrateWorld(legacy);
    assert.equal(loaded.version, 13, 'la carga V12 migra a 13');
    assert.equal(digestAsV18(run(loaded, 60)), expected, 'mundo V12 migrado');
  });
}
for (const [seedText, expected] of Object.entries(V18_HOST_300)) {
  const seed = Number(seedText);
  test(`V19 fase 1: anfitrión abierto con L/S/F/R/M apagados, semilla ${seed}, 300 pasos = digesto V18 (política neuronal activa)`, () => {
    const world = run(createWorld(seed, hostWith(V19_OFF)), 300);
    assert.equal(digestAsV18(world), expected);
  });
}

// ───────────────────────── 2. Factor L ─────────────────────────
const REST = POLICY_ACTIONS.indexOf('rest');
test('V19/L: sin recompensa recurrente ni consecuencia corporal, un sesgo de descanso adquirido se olvida; el viejo lo fija en el tope', () => {
  const old = initialPolicyPlasticity();
  const causal = initialPolicyPlasticity();
  old.bias[REST] = 0.5; causal.bias[REST] = 0.5;
  const body: [number, number, number, number] = [0.2, 0.2, 0.02, 0.98];
  updatePolicyPlasticityCausal(causal, 'rest', 'ready', body, 0, 2400, 0.2);
  for (let tick = 30; tick <= 12_000; tick += 30) {
    updatePolicyPlasticityCausal(causal, 'rest', 'ready', body, tick, 2400, 0.2);
    updatePolicyPlasticity(old, 'rest', 0.3, 0.2 * 0.3);
  }
  assert.equal(old.bias[REST], 0.5, 'el modelo V18 sigue reforzando aunque el cuerpo ya no mejore');
  assert.ok(causal.bias[REST] < 0.05, `el sesgo causal decae sin evidencia (${causal.bias[REST]})`);
  // Un descanso que SÍ recupera el cuerpo (fatiga 0,8 → 0,5) en un contexto cansado produce ventaja positiva.
  const tired = initialPolicyPlasticity();
  updatePolicyPlasticityCausal(tired, 'rest', 'tired', [0.2, 0.2, 0.8, 0.3], 0, 2400, 0.2);
  updatePolicyPlasticityCausal(tired, 'rest', 'tired', [0.2, 0.2, 0.5, 0.6], 60, 2400, 0.2);
  assert.ok(tired.bias[REST] > 0.01, `recuperar de verdad sí enseña (${tired.bias[REST]})`);
  assert.equal(tired.trace.length, 12);
});

function restFixture(causal: boolean, tired: boolean): { restShare: number; stillTired: number; meanFatigue: number } {
  const world = createWorld(7, hostWith({ conducta: { aprendizajeCausal: causal } }));
  const mortals = world.people.filter(p => p.role === 'neighbor');
  for (const person of mortals) {
    person.policyPlasticity!.bias[REST] = 0.5;
    if (tired) { person.fatigue = 0.85; person.energy = 0.3; }
  }
  let restTicks = 0, observed = 0;
  for (let t = 0; t < 900; t++) {
    if (!tired) for (const person of mortals) { person.energy = 0.98; person.fatigue = 0.02; person.hunger = Math.min(person.hunger, 0.3); person.thirst = Math.min(person.thirst, 0.3); }
    stepWorld(world);
    for (const person of mortals) { observed++; if (person.action === 'rest') restTicks++; }
  }
  return { restShare: restTicks / observed, stillTired: mortals.filter(p => p.fatigue > 0.6).length,
    meanFatigue: mortals.reduce((sum, p) => sum + p.fatigue, 0) / mortals.length };
}
test('V19/L: una persona descansada con sesgo de descanso 0,5 no acampa; una cansada sigue descansando y se recupera', () => {
  const off = restFixture(false, false), on = restFixture(true, false);
  assert.ok(off.restShare > 0.1, `control: el sesgo fuerte sí produce descanso (${off.restShare.toFixed(3)})`);
  assert.ok(on.restShare < off.restShare * 0.75, `L reduce el descanso sin cansancio (${on.restShare.toFixed(3)} frente a ${off.restShare.toFixed(3)})`);
  const exhausted = restFixture(true, true);
  assert.ok(exhausted.restShare > 0.15, `la gente cansada descansa (${exhausted.restShare.toFixed(3)})`);
  assert.ok(exhausted.meanFatigue < 0.85, `y se recupera (fatiga media ${exhausted.meanFatigue.toFixed(3)} < 0,85)`);
});

test('V19/L: la plasticidad causal y la V18 se validan y la cría nace sin ninguna', () => {
  const world = run(createWorld(7, hostWith()), 400);
  const learned = world.people.filter(p => p.policyPlasticity && 'baseline' in p.policyPlasticity);
  assert.ok(learned.length > 0, 'las personas aprendieron causalmente');
  const copy = cloneWorld(world);
  assert.equal(digestoCanonico(copy), digestoCanonico(world));
  const legacy = createWorld(7, hostWith(V19_OFF));
  run(legacy, 60);
  assert.ok(legacy.people.every(p => !p.policyPlasticity || !('baseline' in p.policyPlasticity)), 'sin L no aparece estado nuevo');
});

// ───────────────────────── 3. Factor S ─────────────────────────
interface Contienda { world: World; a: Person; b: Person; x: number; y: number }
function contienda(acuerdos: boolean, openness: number): Contienda {
  const world = createWorld(7, hostWith({ social: { acuerdosMateriales: acuerdos } }));
  const [a, b] = world.people.filter(p => p.role === 'neighbor');
  assert.ok(a && b);
  const x = a!.x, y = a!.y;
  for (const person of [a!, b!]) {
    person.communityId = 'comunidad-prueba'; person.action = 'eat'; person.target = { x, y }; person.x = x; person.y = y;
    person.hunger = 0.7; person.culture.openness = openness; person.lastDispute = -10_000;
  }
  b!.hunger = 0.8;
  a!.bonds[b!.id] = 0.6; b!.bonds[a!.id] = 0.6;
  return { world, a: a!, b: b!, x, y };
}
const emit = (event: object) => ({ id: 'e', tick: 0, ...event }) as never;
const setStock = (c: Contienda, food: number): void => { tileAt(c.world, { x: c.x, y: c.y })!.food = food; };
const resetPair = (c: Contienda, openness: number): void => {
  for (const person of [c.a, c.b]) { person.lastDispute = -10_000; person.hunger = 0.7; person.culture.openness = openness; delete person.agreement; person.socialLoad = 0; person.fatigue = 0; }
  c.b.hunger = 0.8; c.a.bonds[c.b.id] = 0.6; c.b.bonds[c.a.id] = 0.6; c.a.action = c.b.action = 'eat'; c.a.target = c.b.target = { x: c.x, y: c.y };
  c.a.x = c.b.x = c.x; c.a.y = c.b.y = c.y;
};

test('V19/S: con apertura 0,95 un stock que no alcanza para ambos produce desacuerdo costoso; V18 firma el turno igualmente', () => {
  const legacy = contienda(false, 0.95); setStock(legacy, 0.012);
  assert.equal(resourceDispute(legacy.world, legacy.a, emit), true);
  assert.equal(legacy.world.totals.conflicts ?? 0, 0, 'V18: el turno se firma sin comprobar el stock');
  const scarce = contienda(true, 0.95); setStock(scarce, 0.012);
  assert.equal(resourceDispute(scarce.world, scarce.a, emit), true);
  assert.equal(scarce.world.totals.conflicts, 1, 'V19: el stock no cubre a los dos y el desacuerdo se registra');
  assert.ok(scarce.a.fatigue > 0 && scarce.b.fatigue > 0 && scarce.a.socialLoad > 0, 'cuesta fatiga y tensión a ambos');
  assert.equal(scarce.a.agreement ?? scarce.b.agreement, undefined, 'no hay acuerdo pendiente');
  assert.ok((scarce.a.bonds[scarce.b.id] ?? 1) < 0.6, 'baja la confianza');
  assert.ok(scarce.a.culture.openness < 0.95 && scarce.b.culture.openness < 0.95, 'y la apertura (obstrucción real, sin etiqueta de comunidad)');
});

test('V19/S: un acuerdo viable no premia al firmarse; cumplido sube confianza y apertura, incumplido por agotamiento las baja', () => {
  const c = contienda(true, 0.8); setStock(c, 0.1);
  const before = { openness: c.a.culture.openness + c.b.culture.openness, trust: (c.a.bonds[c.b.id] ?? 0) + (c.b.bonds[c.a.id] ?? 0) };
  assert.equal(resourceDispute(c.world, c.a, emit), true);
  const waiting = c.a.agreement ? c.a : c.b, taking = waiting === c.a ? c.b : c.a;
  assert.ok(waiting.agreement && !taking.agreement, 'quien cede espera con un acuerdo pendiente');
  assert.equal(c.a.culture.openness + c.b.culture.openness, before.openness, 'sin apertura por firmar');
  assert.equal((c.a.bonds[c.b.id] ?? 0) + (c.b.bonds[c.a.id] ?? 0), before.trust, 'sin confianza por firmar');
  // Cumplido: tras la espera el stock sigue ahí, come y baja el hambre.
  const trustBefore = waiting.bonds[taking.id]!, opennessBefore = waiting.culture.openness;
  c.world.tick += 20; waiting.hunger -= 0.2;
  settleAgreement(c.world, waiting);
  assert.equal(waiting.agreement, undefined);
  assert.ok(waiting.bonds[taking.id]! > trustBefore && waiting.culture.openness > opennessBefore, 'el cumplimiento observado sube ambas estimas');
  // Incumplido: la fuente se agota durante la espera.
  resetPair(c, 0.8); setStock(c, 0.1); c.world.tick += 50;
  assert.equal(resourceDispute(c.world, c.a, emit), true);
  const waiting2 = c.a.agreement ? c.a : c.b, taking2 = waiting2 === c.a ? c.b : c.a;
  assert.ok(waiting2.agreement);
  const trust2 = waiting2.bonds[taking2.id]!, openness2 = waiting2.culture.openness;
  setStock(c, 0); c.world.tick += 20;
  settleAgreement(c.world, waiting2);
  assert.equal(waiting2.agreement, undefined);
  assert.ok(waiting2.bonds[taking2.id]! < trust2 && waiting2.culture.openness < openness2, 'la espera inútil baja confianza y apertura');
});

test('V19/S: 100 oportunidades con fuente que repone cumplen ≥ 90 %; veinte éxitos y veinte fracasos separan las estimas ≥ 0,02', () => {
  const c = contienda(true, 0.95);
  let signed = 0, fulfilled = 0;
  const OPPORTUNITIES = 120;
  for (let i = 0; i < OPPORTUNITIES; i++) {
    resetPair(c, 0.95); setStock(c, 0.17); c.world.tick += 400;
    resourceDispute(c.world, c.a, emit);
    const waiting = c.a.agreement ? c.a : c.b.agreement ? c.b : undefined;
    if (!waiting) continue;
    signed++;
    // La fuente repone: el stock sigue presente tras la espera y quien esperó come de él (materia conservada).
    c.world.tick += 20;
    const tile = tileAt(c.world, { x: c.x, y: c.y })!, eaten = Math.min(tile.food ?? 0, 0.03);
    tile.food = (tile.food ?? 0) - eaten; waiting.hunger -= eaten * 8;
    settleAgreement(c.world, waiting);
    if (!waiting.agreement) fulfilled++;
  }
  assert.ok(signed >= 100, `suficientes oportunidades firmadas (${signed})`);
  assert.ok(fulfilled / signed >= 0.9, `cumplimiento ${(fulfilled / signed).toFixed(3)} ≥ 0,9`);

  const start = 0.6, up = createWorld(7, hostWith()), down = cloneWorld(up);
  const [pa, pb] = up.people.filter(p => p.role === 'neighbor'), [qa, qb] = down.people.filter(p => p.role === 'neighbor');
  for (const person of [pa!, pb!, qa!, qb!]) person.culture.openness = start;
  for (let i = 0; i < 20; i++) { observeAgreementOutcome(up, pa!, pb!, 1); observeAgreementOutcome(down, qa!, qb!, 0); }
  assert.ok(pa!.culture.openness - start >= 0.02, `éxitos suben la apertura (${pa!.culture.openness})`);
  assert.ok(start - qa!.culture.openness >= 0.02, `fracasos la bajan (${qa!.culture.openness})`);
  assert.ok(pa!.culture.openness - qa!.culture.openness >= 0.04);
  setParams(up, hostWith());
});

// ───────────────────────── 4. Factores F+R+M ─────────────────────────
import './v19-phase1-fauna.test.js';
