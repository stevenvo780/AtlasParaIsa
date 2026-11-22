import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createWorld, stepWorld, tileAt, type Person, type World } from '../src/world/index.js';
import { bond, cooperate, cooperationOpportunity, culturalDistance, inheritCulture, resourceDispute, updateCulturalNormsOnOutcome, type Culture } from '../src/world/society.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { HISTORICAL_PARAMS, parseParams } from '../src/world/params.js';
import { recordChronicleEvent } from '../src/world/chronicle-journal.js';
import { researchTechnology } from '../src/world/technology.js';
import type { ChronicleEvent } from '../src/shared/types.js';
import { aula, PROGRAMA_FILO, proyectoInvestigacion } from './lib/escenas.js';
import { clonarPlantillaSintetica } from '../scripts/lib/curva-techo-fixture.js';

/**
 * V16 carril 2 — especiación cultural bidireccional (`social.derivaCultural`) y coste de la
 * cooperación en pueblos densos. Con la ley a 0 todo es el histórico bit a bit: el digesto
 * dorado de la semilla 7 y los resultados dorados del cluster denso se midieron ANTES de
 * tocar `society.ts`. Con la ley a 1, agrarios cooperativos, extractivos hambrientos y
 * exploradores divergen de verdad en las tres dimensiones.
 */
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const derivados = (deriva: number, extra = '') => parseParams(`social.derivaCultural=${deriva}${extra}`, HISTORICAL_PARAMS);
function emit(w: World) {
  return (event: Omit<ChronicleEvent, 'id' | 'tick'>) => {
    const result = recordChronicleEvent(w, event); w.events.push(result); return result;
  };
}
const stdev = (values: readonly number[]): number => {
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / values.length);
};
const mean = (values: readonly number[]): number => values.reduce((s, v) => s + v, 0) / values.length;

test('derivaCultural=0: updateCulturalNormsOnOutcome is exactly the two historical monotone rises', () => {
  const world = createWorld(7, derivados(0));
  const person = world.people[0]!;
  const rate = person.genome.learningRate * 0.04;
  const cases: { action: string; useful: boolean; hunger: number; thirst: number; communityId: string | null; expected: Culture }[] = [
    { action: 'farm', useful: true, hunger: 0.1, thirst: 0.1, communityId: 'c', expected: { sharing: 0.4, stewardship: clamp01(0.4 + rate), openness: 0.4 } },
    { action: 'gather', useful: false, hunger: 0.1, thirst: 0.1, communityId: null, expected: { sharing: 0.4, stewardship: clamp01(0.4 + rate), openness: 0.4 } },
    // Historical law has NO downward pressure: hungry successful extraction changes nothing.
    { action: 'hunt', useful: true, hunger: 0.9, thirst: 0.9, communityId: null, expected: { sharing: 0.4, stewardship: 0.4, openness: 0.4 } },
    { action: 'cooperate', useful: true, hunger: 0.9, thirst: 0.9, communityId: null, expected: { sharing: clamp01(0.4 + rate), stewardship: 0.4, openness: 0.4 } },
    { action: 'share', useful: true, hunger: 0.1, thirst: 0.1, communityId: 'c', expected: { sharing: clamp01(0.4 + rate), stewardship: 0.4, openness: 0.4 } },
    { action: 'explore', useful: true, hunger: 0.1, thirst: 0.1, communityId: null, expected: { sharing: 0.4, stewardship: 0.4, openness: 0.4 } },
    { action: 'eat', useful: true, hunger: 0.95, thirst: 0.1, communityId: null, expected: { sharing: 0.4, stewardship: 0.4, openness: 0.4 } },
  ];
  for (const c of cases) {
    person.culture = { sharing: 0.4, stewardship: 0.4, openness: 0.4 };
    person.hunger = c.hunger; person.thirst = c.thirst; person.communityId = c.communityId;
    updateCulturalNormsOnOutcome(world, person, c.action, c.useful);
    assert.deepEqual(person.culture, c.expected, `${c.action}/${c.useful}`);
  }
});

test('derivaCultural=0: inheritCulture is the exact parental mean; bond is the exact historical averaging', () => {
  const a: Culture = { sharing: 0.2, stewardship: 0.9, openness: 0.35 };
  const b: Culture = { sharing: 0.8, stewardship: 0.1, openness: 0.65 };
  assert.deepEqual(inheritCulture(7, 'child-1', a, b, 0), { sharing: (0.2 + 0.8) / 2, stewardship: (0.9 + 0.1) / 2, openness: (0.35 + 0.65) / 2 });
  assert.deepEqual(inheritCulture(99, 'child-2', a, b, -1), inheritCulture(7, 'child-1', a, b, 0));

  const world = createWorld(51926, derivados(0));
  const p = world.people[2]!, q = world.people[3]!;
  p.culture = { ...a }; q.culture = { ...b };
  p.communityId = 'uno'; q.communityId = 'dos';
  const similarity = 1 - culturalDistance(a, b);
  const expectedP = { ...a }, expectedQ = { ...b };
  for (const key of ['sharing', 'stewardship', 'openness'] as const) {
    const delta = (b[key] - a[key]) * 0.015 * similarity;
    expectedP[key] = clamp01(a[key] + delta); expectedQ[key] = clamp01(b[key] - delta);
  }
  bond(world, p, q, 0.12);
  assert.deepEqual(p.culture, expectedP);
  assert.deepEqual(q.culture, expectedQ);
});

test('derivaCultural=1: inheritCulture varies deterministically per child inside [0.05, 0.98]', () => {
  const a: Culture = { sharing: 0.5, stewardship: 0.5, openness: 0.5 };
  const children = Array.from({ length: 40 }, (_, i) => inheritCulture(7, `child-${i}`, a, a, 1));
  assert.deepEqual(inheritCulture(7, 'child-3', a, a, 1), children[3], 'same seed and child id, same culture');
  for (const key of ['sharing', 'stewardship', 'openness'] as const) {
    const values = children.map(c => c[key]);
    assert.ok(values.every(v => v >= 0.05 && v <= 0.98), key);
    assert.ok(stdev(values) > 0.01, `${key} stdev ${stdev(values)}`);
    assert.ok(Math.abs(mean(values) - 0.5) < 0.04, `${key} mean ${mean(values)}`);
  }
});

test('derivaCultural=1: bond converges gently inside a community and only opens across communities', () => {
  const world = createWorld(51926, derivados(1));
  const p = world.people[2]!, q = world.people[3]!;
  const startP: Culture = { sharing: 0.2, stewardship: 0.9, openness: 0.4 };
  const startQ: Culture = { sharing: 0.8, stewardship: 0.1, openness: 0.4 };

  p.culture = { ...startP }; q.culture = { ...startQ };
  p.communityId = 'uno'; q.communityId = 'dos';
  bond(world, p, q, 0.12);
  assert.equal(p.culture.sharing, startP.sharing, 'cross-group contact must not average sharing away');
  assert.equal(p.culture.stewardship, startP.stewardship);
  assert.equal(q.culture.sharing, startQ.sharing);
  assert.equal(q.culture.stewardship, startQ.stewardship);
  assert.equal(p.culture.openness, clamp01(0.4 + 0.006 * 1));
  assert.equal(q.culture.openness, clamp01(0.4 + 0.006 * 1));

  p.culture = { ...startP }; q.culture = { ...startQ };
  p.communityId = q.communityId = 'uno';
  const before = culturalDistance(p.culture, q.culture);
  bond(world, p, q, 0.12);
  const similarity = 1 - culturalDistance(startP, startQ);
  assert.equal(p.culture.sharing, clamp01(startP.sharing + (startQ.sharing - startP.sharing) * 0.004 * similarity));
  assert.ok(culturalDistance(p.culture, q.culture) < before, 'intra-community cultures still approach, gently');
});

function supplyScene(deriva: number, sameCommunity: boolean) {
  const { world: w, maestro: a, aprendiz: b } = aula({
    params: derivados(deriva), cuerpo: { energy: 0.9, fatigue: 0.1, hunger: 0.1, thirst: 0.1 },
    decisionAt: 999, vaciarMateriales: false, sinEncuentroReciente: false,
  });
  b.action = 'build'; b.materials = { wood: 5, stone: 3 }; a.materials = { wood: 2, stone: 0 };
  a.communityId = 'grupo-a'; b.communityId = sameCommunity ? 'grupo-a' : 'grupo-b';
  a.culture = { sharing: 0.5, stewardship: 0.5, openness: 0.4 };
  b.culture = { sharing: 0.5, stewardship: 0.5, openness: 0.4 };
  return { w, a, b };
}

test('derivaCultural=1: cooperate opens across communities and tightens inside one; deriva=0 keeps history', () => {
  const cross = supplyScene(1, false);
  assert.equal(cooperate(cross.w, cross.a, emit(cross.w)), true);
  // bond cross-group (+0.006) then cooperate cross-group (+0.015); sharing/stewardship untouched.
  const expectedCross = clamp01(clamp01(0.4 + 0.006 * 1) + 0.015 * 1);
  assert.equal(cross.a.culture.openness, expectedCross);
  assert.equal(cross.b.culture.openness, expectedCross);
  assert.equal(cross.a.culture.sharing, 0.5); assert.equal(cross.a.culture.stewardship, 0.5);

  const same = supplyScene(1, true);
  assert.equal(cooperate(same.w, same.a, emit(same.w)), true);
  assert.equal(same.a.culture.openness, clamp01(0.4 - 0.003 * 1), 'identical cultures: bond moves nothing, cooperate tightens');
  assert.equal(same.b.culture.openness, clamp01(0.4 - 0.003 * 1));

  const historical = supplyScene(0, false);
  assert.equal(cooperate(historical.w, historical.a, emit(historical.w)), true);
  assert.equal(historical.a.culture.openness, 0.4, 'deriva=0: identical cultures stay identical, no openness law');
  assert.equal(historical.b.culture.openness, 0.4);
});

function disputeScene(deriva: number, trust: number) {
  const params = derivados(deriva, ',social.disputaNecesidad=0.65,social.disputaEscasez=1,social.disputaRadio=2,social.memoriaDisputa=0');
  const { world: w, maestro: a, aprendiz: b } = aula({
    params, cuerpo: { energy: 0.9, fatigue: 0.1, hunger: 0.1, thirst: 0.1 }, decisionAt: 999, vaciarMateriales: false, sinEncuentroReciente: false,
  });
  a.action = b.action = 'drink'; a.thirst = b.thirst = 0.95; a.lastDispute = b.lastDispute = -10_000;
  for (const [p, id] of [[a, 'one'], [b, 'two']] as const) {
    p.communityId = id; p.culture = { sharing: 0.5, stewardship: 0.5, openness: 0.1 };
    w.communityCounter++;
    w.communities.push({ id, name: id, x: p.x, y: p.y, color: '#aaccee', members: [p.id], culture: { ...p.culture }, formedAt: w.tick, cooperation: 0, disputes: 0 });
  }
  a.bonds[b.id] = trust; b.bonds[a.id] = trust;
  tileAt(w, a)!.drinkingWater = 0.05;
  return { w, a, b };
}

test('derivaCultural=1: disputes lower sharing/openness, peaceful cross-group turns raise openness', () => {
  const conflict = disputeScene(1, 0.1);
  assert.equal(resourceDispute(conflict.w, conflict.a, emit(conflict.w)), true);
  assert.equal(conflict.w.totals.conflicts, 1);
  assert.equal(conflict.a.culture.sharing, clamp01(0.5 - 0.025 * 1));
  assert.equal(conflict.b.culture.sharing, clamp01(0.5 - 0.025 * 1));
  assert.equal(conflict.a.culture.openness, clamp01(0.1 - 0.03 * 1));
  assert.equal(conflict.b.culture.openness, clamp01(0.1 - 0.03 * 1));

  const peaceful = disputeScene(1, 0.8);
  assert.equal(resourceDispute(peaceful.w, peaceful.a, emit(peaceful.w)), true);
  assert.equal(peaceful.w.totals.conflicts, 0);
  // bond cross-group (+0.006) then the peaceful turn itself (+0.012); sharing untouched.
  const expectedOpen = clamp01(clamp01(0.1 + 0.006 * 1) + 0.012 * 1);
  assert.equal(peaceful.a.culture.openness, expectedOpen);
  assert.equal(peaceful.b.culture.openness, expectedOpen);
  assert.equal(peaceful.a.culture.sharing, 0.5);

  const historical = disputeScene(0, 0.1);
  assert.equal(resourceDispute(historical.w, historical.a, emit(historical.w)), true);
  assert.equal(historical.w.totals.conflicts, 1);
  assert.equal(historical.a.culture.sharing, 0.5, 'deriva=0: a conflict leaves cultures exactly as before');
  assert.equal(historical.a.culture.openness, 0.1);
  assert.equal(historical.b.culture.sharing, 0.5);
  assert.equal(historical.b.culture.openness, 0.1);
});

test('derivaCultural=1: agrarian, extractive and explorer cohorts diverge on all three dimensions', () => {
  const world = createWorld(51926, derivados(1));
  const template = world.people.find(p => p.role === 'neighbor')!;
  const cohorts: Record<'agrarian' | 'extractive' | 'explorer', Person[]> = { agrarian: [], extractive: [], explorer: [] };
  for (const [name, members] of Object.entries(cohorts)) {
    for (let i = 0; i < 10; i++) {
      const p = clonarPlantillaSintetica(template);
      p.id = `${name}-${i}`; p.name = `${name}${i}`;
      p.genome = structuredClone(p.genome); p.genome.learningRate = 0.5;
      p.culture = { sharing: 0.5, stewardship: 0.5, openness: 0.5 };
      members.push(p);
    }
  }
  for (const p of cohorts.agrarian) {
    p.communityId = 'comunidad-agraria'; p.hunger = 0.1; p.thirst = 0.1;
    for (let n = 0; n < 300; n++) { updateCulturalNormsOnOutcome(world, p, 'farm', true); updateCulturalNormsOnOutcome(world, p, 'cooperate', true); }
  }
  for (const p of cohorts.extractive) {
    p.communityId = null; p.hunger = 0.8; p.thirst = 0.2;
    for (let n = 0; n < 300; n++) { updateCulturalNormsOnOutcome(world, p, 'hunt', true); updateCulturalNormsOnOutcome(world, p, 'eat', true); }
  }
  for (const p of cohorts.explorer) {
    p.communityId = null; p.hunger = 0.1; p.thirst = 0.1;
    for (let n = 0; n < 300; n++) updateCulturalNormsOnOutcome(world, p, 'explore', true);
  }
  const cohortMean = (members: Person[], key: keyof Culture) => mean(members.map(p => p.culture[key]));
  assert.ok(cohortMean(cohorts.agrarian, 'stewardship') > cohortMean(cohorts.extractive, 'stewardship') + 0.5, 'stewards vs extractors');
  assert.ok(cohortMean(cohorts.agrarian, 'sharing') > cohortMean(cohorts.extractive, 'sharing') + 0.5, 'cooperators vs the deprived');
  assert.ok(cohortMean(cohorts.explorer, 'openness') > cohortMean(cohorts.agrarian, 'openness') + 0.5, 'pioneers vs settled towns');
  const everyone = [...cohorts.agrarian, ...cohorts.extractive, ...cohorts.explorer];
  for (const key of ['sharing', 'stewardship', 'openness'] as const) {
    assert.ok(stdev(everyone.map(p => p.culture[key])) > 0.05, `${key} inter-community stdev must not collapse to 0.000`);
  }
});

/** Cluster denso de 50 personas en 5×5 celdas (el caso que ahogaba el hilo 0): acciones,
 * materiales, objetos y recetas variados y deterministas alrededor de la escena 51926. */
function denseCluster() {
  const params = parseParams('social.derivaCultural=0', HISTORICAL_PARAMS);
  const { world: w, maestro: a, aprendiz: b } = aula({ params, cuerpo: { energy: 0.9, fatigue: 0.1, hunger: 0.1, thirst: 0.1 }, decisionAt: 999, vaciarMateriales: false, sinEncuentroReciente: false });
  a.materials = { wood: 12, stone: 8 };
  a.technology.project = proyectoInvestigacion(structuredClone(PROGRAMA_FILO), w.tick);
  while (a.technology.project) { w.tick++; researchTechnology(w, a); }
  const item = a.technology.items[0]!;
  const tile = w.tiles.find(t => t.x === 36 && t.y === 12)!;
  tile.wood = 8; tile.stone = 4; tile.fauna = 2; tile.food = 0.5;
  const actions = ['gather', 'build', 'hunt', 'rest', 'craft', 'research', 'farm', 'forage'] as const;
  const clones: Person[] = [];
  for (let i = 0; i < 50; i++) {
    const p = clonarPlantillaSintetica(i % 2 ? a : b);
    p.id = `denso-${i}`; p.name = `Denso${i}`;
    p.x = 36 + (i % 5) - 2; p.y = 12 + (Math.floor(i / 5) % 5) - 2;
    p.target = { x: 36, y: 12 };
    p.action = actions[i % actions.length]! as Person['action'];
    p.materials = { wood: i % 7, stone: (i * 3) % 5 };
    p.work = i % 20; p.lastSocial = -30; p.decisionAt = 9999;
    p.skills = { hunt: (i % 9) / 10, gather: (i % 5) / 10, farm: (i % 7) / 10, forage: (i % 3) / 10 };
    p.activity = { hunt: i % 4, gather: i % 3, farm: i % 2, forage: 1 };
    p.bonds = {}; p.communityId = i % 3 === 0 ? 'community-densa' : null;
    p.culture = { sharing: 0.2 + (i % 6) / 10, stewardship: 0.3 + (i % 5) / 10, openness: 0.25 + (i % 7) / 10 };
    p.technology = structuredClone(p.technology);
    p.technology.items = i % 4 === 0 ? [{ ...structuredClone(item), id: `item-denso-${i}` }] : [];
    p.technology.knownRecipes = i % 5 === 0 ? [...a.technology.knownRecipes] : [];
    p.technology.project = i % 8 === 5 ? proyectoInvestigacion(structuredClone(PROGRAMA_FILO), w.tick) : p.technology.project;
    w.people.push(p); clones.push(p);
  }
  b.action = 'gather'; b.materials.wood = 1;
  return { w, a, clones };
}

/** Medido sobre el `society.ts` anterior a V16 (mismo fixture): la optimización no mueve ni un bit. */
const CLUSTER_GOLDEN = JSON.parse('[["neighbor-1","denso-17","supply",0.6257455990640737,null,null,null],["denso-0","denso-33","assist",0.7700115882818569,null,null,null],["denso-1","denso-25","supply",0.6257455990640737,null,null,null],["denso-2","denso-1","supply",0.8300115882818568,null,null,null],["denso-3","denso-33","supply",0.6257455990640737,null,null,null],["denso-4","neighbor-2","tools",0.8500115882818569,null,null,{"itemId":"item-denso-4","material":"wood","amount":1}],["denso-5","denso-25","supply",0.6257455990640737,null,null,null],["denso-6","denso-33","supply",0.8300115882818568,null,null,null],["denso-7","denso-17","supply",0.6257455990640737,null,null,null],["denso-8","denso-1","supply",0.8300115882818568,null,null,null],["denso-9","denso-33","supply",0.6257455990640737,null,null,null],["denso-10","denso-25","supply",0.8300115882818568,null,null,null],["denso-11","denso-17","supply",0.6257455990640737,null,null,null],["denso-12","neighbor-2","tools",0.8325115882818569,null,null,{"itemId":"item-denso-12","material":"wood","amount":1}],["denso-13","denso-17","supply",0.6257455990640737,null,null,null],["denso-14","denso-49","supply",0.8300115882818568,null,null,null],["denso-15","denso-33","supply",0.6257455990640737,null,null,null],["denso-16","denso-17","supply",0.8300115882818568,null,null,null],["denso-17","denso-20","supply",0.6257455990640737,null,"stone",null],["denso-18","denso-33","supply",0.8300115882818568,null,null,null],["denso-19","denso-49","supply",0.6257455990640737,null,null,null]]') as unknown[];

test('optimized cooperationOpportunity is bit-identical on a dense 50-person cluster and stays fast', () => {
  const { w, a, clones } = denseCluster();
  const actors = [a, ...clones.slice(0, 20)];
  const results = actors.map(p => {
    const o = cooperationOpportunity(w, p);
    return [p.id, o?.person.id ?? null, o?.kind ?? null, o?.score ?? null, o?.recipeId ?? null, o?.supplyMaterial ?? null, o?.exchange ?? null];
  });
  assert.deepEqual(results, CLUSTER_GOLDEN);
  const started = performance.now();
  for (let round = 0; round < 10; round++) for (const p of clones) cooperationOpportunity(w, p);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2000, `500 dense cooperation evaluations took ${elapsed.toFixed(1)}ms`);
});

test('derivaCultural=0: canonical digest of seed 7 after 240 ticks matches HISTORICAL_PARAMS bit-for-bit', () => {
  const control = createWorld(7, HISTORICAL_PARAMS);
  const explicit = createWorld(7, parseParams('social.derivaCultural=0', HISTORICAL_PARAMS));
  for (let i = 0; i < 240; i++) { stepWorld(control); stepWorld(explicit); }
  assert.equal(digestoCanonico(explicit), digestoCanonico(control));
});
