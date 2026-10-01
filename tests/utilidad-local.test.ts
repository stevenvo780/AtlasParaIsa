import assert from 'node:assert/strict';
import test from 'node:test';
import { assertWorld, cloneWorld, createWorld, puntoDeRestauracion, stepWorld, type Person } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { initialDemography } from '../src/world/demography.js';
import { FOOD_PER_ANIMAL } from '../src/world/ecosystem.js';
import { defaultBlueprint } from '../src/world/inventions.js';
import { parseParams } from '../src/world/params.js';
import { tileAt } from '../src/world/spatial.js';
import { rawMaterial, researchTechnology, technologyWorkCost, transferTechnologyItem } from '../src/world/technology.js';
import { aprendizajeUtilidadLocalValido, OFICIOS, permutarOficiosProductivos, registrarRetornoProductivo,
  type AprendizUtilidadLocal, type ConductaUtilidadLocal } from '../src/world/utilidad-local.js';
import { PROGRAMA_FILO, proyectoInvestigacion } from './lib/escenas.js';

// Perfil técnico fijado antes de ejecutar. No representa una calibración P90.
const ACTIVA: ConductaUtilidadLocal = { utilidadLocal: 1, utilidadLocalGhat: Object.freeze([1, 1, 1, 1, 1, 1, 1, 1]) };
const params = () => parseParams({ conducta: ACTIVA });
const aprendiz = (learningRate = 0.12): AprendizUtilidadLocal => ({ genome: { learningRate } });
function cerca(actual: number, esperado: number): void { assert.ok(Math.abs(actual - esperado) < 1e-12, `${actual} ≠ ${esperado}`); }
type Candidate = { action: string; score: number; target: { x: number; y: number }; reason: string };
const candidate = (action: string, score: number, id = action): Candidate => ({ action, score, target: { x: id.length, y: 3 }, reason: id });

test('la primera observación es y; las siguientes usan la tasa propia y el fracaso pagado vale cero', () => {
  for (const lambda of [0.04, 0.12, 0.2]) {
    const p = aprendiz(lambda);
    registrarRetornoProductivo(p, 'gather', 2, 10, ACTIVA);
    assert.deepEqual(p.utilidadLocal, { gather: { q: 0.2, intentos: 1 } });
    registrarRetornoProductivo(p, 'gather', 0, 20, ACTIVA);
    cerca(p.utilidadLocal!.gather!.q, 0.2 * (1 - lambda));
    registrarRetornoProductivo(p, 'gather', 10, 10, ACTIVA);
    const segundo = 0.2 * (1 - lambda);
    cerca(p.utilidadLocal!.gather!.q, segundo + lambda * (1 - segundo));
    assert.equal(p.utilidadLocal!.gather!.intentos, 3);
  }
});

test('beneficio por trabajo y escala, con saturación; proceso exitoso no implica y=1', () => {
  for (const [oficio, beneficio, trabajo, escala, esperado] of [
    ['gather', 1.5, 18, 0.5, 1 / 6], ['forage', 0.06, 18, 1, 0.06 / 18],
    ['hunt', 0.18, 45, 1, 0.18 / 45], ['farm', 1, 45, 1, 1 / 45],
    ['build', 1, 90, 1, 1 / 90], ['repair', 0.1, 30, 1, 0.1 / 30],
    ['research', 1, 17, 1, 1 / 17], ['craft', 1, 40, 1, 1 / 40],
    ['gather', 100, 1, 1, 1],
  ] as const) {
    const p = aprendiz(), profile = [...ACTIVA.utilidadLocalGhat!];
    profile[OFICIOS.indexOf(oficio)] = escala;
    registrarRetornoProductivo(p, oficio, beneficio, trabajo, { utilidadLocal: 1, utilidadLocalGhat: profile });
    cerca(p.utilidadLocal![oficio]!.q, esperado);
    assert.equal(p.utilidadLocal![oficio]!.intentos, 1);
  }
});

test('apagado, contexto no ready, invent y rechazo gratuito no leen estado ni perfil', () => {
  const prohibido = (): never => { throw new Error('Lectura de aprendizaje/perfil prohibida'); };
  const p = Object.defineProperties({}, { genome: { get: prohibido }, utilidadLocal: { get: prohibido } }) as AprendizUtilidadLocal;
  const off = Object.defineProperty({ utilidadLocal: 0 as const }, 'utilidadLocalGhat', { get: prohibido });
  const activeNoProfile = Object.defineProperty({ utilidadLocal: 1 as const }, 'utilidadLocalGhat', { get: prohibido });
  const candidates = [candidate('gather', 0.8), candidate('farm', 0.7)];
  registrarRetornoProductivo(p, 'gather', 1, 18, off);
  permutarOficiosProductivos(candidates, p, off, true);
  permutarOficiosProductivos(candidates, p, ACTIVA, false);
  registrarRetornoProductivo(p, 'invent', 1, 60, activeNoProfile);
  registrarRetornoProductivo(p, 'research', 0, 0, activeNoProfile);
  assert.deepEqual(candidates.map(c => c.action), ['gather', 'farm']);
});

test('assertWorld y stepWorld apagados tampoco leen el campo personal opcional', () => {
  const world = createWorld(19011);
  for (const person of world.people) Object.defineProperty(person, 'utilidadLocal', {
    get() { throw new Error('q fue leído con la ley apagada'); }, configurable: true,
  });
  assertWorld(world);
  stepWorld(world);
  assert.equal(world.tick, 1);
});

test('estado escaso válido, cotas de anticorrupción y claves propias serializables', () => {
  for (const valid of [undefined, {}, { gather: { q: 0, intentos: 1 }, craft: { q: 1, intentos: 3 } },
    { research: { q: 0.5, intentos: Number.MAX_SAFE_INTEGER } }]) assert.equal(aprendizajeUtilidadLocalValido(valid), true);
  for (const invalid of [null, [], { invent: { q: 0.5, intentos: 3 } },
    ...[NaN, Infinity, -0.1, 1.1].map(q => ({ gather: { q, intentos: 3 } })),
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map(intentos => ({ gather: { q: 0.5, intentos } })),
    { gather: { q: 0.5, intentos: 3, extra: 0 } },
    { gather: Object.assign(Object.create({ q: 0.5, intentos: 3 }), { a: 1, b: 2 }) },
  ]) assert.equal(aprendizajeUtilidadLocalValido(invalid), false);
  const p = aprendiz(); p.utilidadLocal = { gather: { q: 0.5, intentos: Number.MAX_SAFE_INTEGER } };
  registrarRetornoProductivo(p, 'gather', 0, 18, ACTIVA);
  assert.equal(p.utilidadLocal.gather!.intentos, Number.MAX_SAFE_INTEGER);
  assert.equal(aprendizajeUtilidadLocalValido(p.utilidadLocal), true);
});

test('uno o dos intentos no perturban; el tercero cambia cuál oficio conserva el score máximo', () => {
  for (const intentos of [1, 2, 3]) {
    const p = aprendiz(); p.utilidadLocal = { gather: { q: 0, intentos }, farm: { q: 1, intentos } };
    const cs = [candidate('gather', 0.8), candidate('farm', 0.7)];
    permutarOficiosProductivos(cs, p, ACTIVA, true);
    assert.deepEqual(cs.map(c => c.action), intentos < 3 ? ['gather', 'farm'] : ['farm', 'gather']);
    assert.deepEqual(cs.map(c => c.score), [0.8, 0.7]);
  }
});

test('cada acción no productiva retiene su objeto, ranura y victoria frente a los oficios', () => {
  for (const nonProductive of ['eat', 'drink', 'rest', 'share', 'cooperate', 'approach', 'explore', 'accompany', 'retreat', 'invent']) {
    for (const nonProductiveWins of [false, true]) {
      const p = aprendiz(); p.utilidadLocal = { gather: { q: 0, intentos: 3 }, farm: { q: 1, intentos: 3 } };
      const n = candidate(nonProductive, nonProductiveWins ? 0.85 : 0.75), g = candidate('gather', 0.8), f = candidate('farm', 0.7);
      const cs = [g, n, f].sort((a, b) => b.score - a.score), nIndex = cs.indexOf(n);
      const scores = cs.map(c => c.score), nBefore = structuredClone(n), gTarget = g.target, fTarget = f.target;
      permutarOficiosProductivos(cs, p, ACTIVA, true);
      assert.equal(cs[nIndex], n); assert.deepEqual(n, nBefore);
      assert.deepEqual(cs.map(c => c.score), scores);
      assert.equal(cs[0] === n, nonProductiveWins);
      assert.equal(cs.find(c => c.action === 'farm')!.target, fTarget);
      assert.equal(cs.find(c => c.action === 'gather')!.target, gTarget);
      assert.equal(g.reason, 'gather'); assert.equal(f.reason, 'farm');
      assert.equal(cs.filter(c => OFICIOS.includes(c.action as typeof OFICIOS[number]))[0], f);
    }
  }
});

test('empates entre clases conservan orden en ambas direcciones; empate auxiliar conserva orden estable', () => {
  const p = aprendiz(); p.utilidadLocal = { gather: { q: 0, intentos: 3 }, farm: { q: 1, intentos: 3 } };
  for (const firstIsNonProductive of [false, true]) {
    const g = candidate('gather', 0.8), n = candidate('eat', 0.8), f = candidate('farm', 0.7);
    const cs = firstIsNonProductive ? [n, g, f] : [g, n, f];
    permutarOficiosProductivos(cs, p, ACTIVA, true);
    assert.equal(cs.indexOf(n), firstIsNonProductive ? 0 : 1);
    assert.equal(cs[0] === n, firstIsNonProductive);
    assert.equal(cs[firstIsNonProductive ? 1 : 0], f);
  }
  p.utilidadLocal = { gather: { q: 0.5, intentos: 3 }, farm: { q: 0.5, intentos: 3 } };
  const g = candidate('gather', 0.8), f = candidate('farm', 0.8), cs = [g, f];
  permutarOficiosProductivos(cs, p, ACTIVA, true); assert.deepEqual(cs, [g, f]);
});

test('media por candidato con multiplicidad; sin q participa con perturbación cero', () => {
  const p = aprendiz(); p.utilidadLocal = { gather: { q: 1, intentos: 3 }, farm: { q: 0, intentos: 3 } };
  const craft = candidate('craft', 1.025), g1 = candidate('gather', 0.9, 'gather-first'),
    g2 = candidate('gather', 0.8, 'gather-second'), farm = candidate('farm', 0.7);
  const cs = [craft, g1, g2, farm];
  permutarOficiosProductivos(cs, p, ACTIVA, true);
  assert.equal(cs[0], craft, 'media 2/3: 1.025 supera gather .9+.1; deduplicar oficio daría .9+.15');
  assert.deepEqual(cs, [craft, g1, g2, farm]);
  const absent = aprendiz(), original = [candidate('gather', 0.8), candidate('farm', 0.7)];
  permutarOficiosProductivos(original, absent, ACTIVA, true);
  assert.equal(Object.hasOwn(absent, 'utilidadLocal'), false);
});

test('los helpers no consultan ni consumen RNG, reloj, mundo o inventarios', () => {
  const p = aprendiz();
  for (const key of ['rng', 'tick', 'materials', 'inventory']) Object.defineProperty(p, key, {
    get() { throw new Error(`Lectura ajena al aprendizaje: ${key}`); },
  });
  registrarRetornoProductivo(p, 'gather', 0, 18, ACTIVA);
  p.utilidadLocal!.gather!.intentos = 3; p.utilidadLocal!.farm = { q: 1, intentos: 3 };
  const cs = [candidate('gather', 0.8), candidate('farm', 0.7)];
  permutarOficiosProductivos(cs, p, ACTIVA, true); assert.equal(cs[0]!.action, 'farm');
});

/** Contadores de trabajo previos son un estado sintético de un intento en curso.
 * Un paso real prueba el sitio de captura antes de débito/reset. La continuidad
 * de intentos íntegramente pagados vive en utilidad-local-continuidad.test.ts. */
function scene(action: Person['action']) {
  const world = createWorld(19011, params()), person = world.people[2]!;
  const animal = world.animals[0];
  world.animals = []; world.places = []; world.structures = [];
  for (const other of world.people) {
    other.x = 10; other.y = 20; other.target = { x: 10, y: 20 }; other.action = 'rest'; other.decisionAt = 1000;
    other.hunger = other.thirst = other.fatigue = 0.1; other.energy = 1;
  }
  person.x = 36; person.y = 12; person.target = { x: 36, y: 12 }; person.action = action;
  person.skills = {}; person.materials = { wood: 0, stone: 0 }; person.inventory = 0;
  const tile = tileAt(world, person)!;
  tile.terrain = 'meadow'; tile.food = 0.25; tile.moisture = 0.5; tile.vegetation = 0.4;
  tile.wood = 12; tile.stone = 8; tile.cultivation = 0;
  return { world, person, tile, animal };
}

test('gather y forage registran cosecha real, incluido espacio de inventario parcial', () => {
  const gather = scene('gather'); gather.person.work = 17;
  const wood = gather.tile.wood!; stepWorld(gather.world);
  const gross = wood - gather.tile.wood!;
  assert.equal(gross, 1); cerca(gather.person.utilidadLocal!.gather!.q, gross / 18);
  assert.equal(gather.person.work, 0);
  const forage = scene('forage'); forage.person.inventory = 0.24; forage.person.work = 17;
  stepWorld(forage.world);
  cerca(forage.person.utilidadLocal!.forage!.q, 0.01 / 18);
  cerca(forage.person.inventory, 0.25);
  const failed = scene('gather'); failed.tile.wood = failed.tile.stone = 0; failed.person.work = 17;
  stepWorld(failed.world); assert.deepEqual(failed.person.utilidadLocal, { gather: { q: 0, intentos: 1 } });
  const over = scene('gather'); over.person.work = 23;
  stepWorld(over.world); cerca(over.person.utilidadLocal!.gather!.q, 1 / 24);
});

test('gather usa cosecha bruta, sin restarle desgaste de la herramienta', () => {
  const s = scene('gather'), tool = rawMaterial('wood');
  tool.id = 'product-1'; tool.properties.edge = tool.properties.hardness = tool.properties.cohesion = 1;
  s.person.technology.items.push(tool); s.person.work = 17;
  const before = tool.mass; stepWorld(s.world);
  assert.equal(s.person.materials.wood, 2); assert.ok(tool.mass < before);
  const netMatter = s.person.materials.wood + (tool.mass - before) / 1000;
  assert.ok(netMatter < 2);
  cerca(s.person.utilidadLocal!.gather!.q, 2 / 18);
});

test('farm cuenta celda, build obra y repair delta real antes de descontar su trabajo', () => {
  const farm = scene('farm'); farm.person.materials.wood = 1; farm.person.work = 44;
  stepWorld(farm.world); cerca(farm.person.utilidadLocal!.farm!.q, 1 / 45);
  assert.equal(farm.world.totals.cultivations, 1); assert.equal(farm.person.materials.wood, 0);
  const build = scene('build'); build.person.materials = { wood: 12, stone: 8 };
  const blueprint = defaultBlueprint(); build.world.blueprints = [blueprint]; build.person.blueprintId = blueprint.id;
  build.person.work = blueprint.cost.work - 1;
  stepWorld(build.world); assert.equal(build.world.structures.length, 1);
  cerca(build.person.utilidadLocal!.build!.q, 1 / blueprint.cost.work); assert.equal(build.person.work, 0);
  const repair = scene('repair'); repair.person.materials.wood = 1; repair.person.work = 29;
  repair.world.structures.push({ id: 'structure-1', x: repair.tile.x, y: repair.tile.y, blueprintId: blueprint.id,
    name: blueprint.name, components: [...blueprint.components], condition: 0.9, water: 0, food: 0, uses: 0, builtAt: 0, builderId: repair.person.id });
  stepWorld(repair.world); assert.equal(repair.world.structures[0]!.condition, 1);
  cerca(repair.person.utilidadLocal!.repair!.q, 0.1 / 30); assert.equal(repair.person.work, 0);
});

test('hunt mide todo el alimento de una identidad aunque la saciedad sature y no quepa inventario', () => {
  const s = scene('hunt'); assert.ok(s.animal);
  const victim = s.animal; victim.x = s.tile.x; victim.y = s.tile.y; victim.target = { x: victim.x, y: victim.y };
  victim.action = 'rest'; victim.lastDecision = 0; victim.health = 1; victim.hunger = victim.thirst = victim.fatigue = 0.1; victim.energy = 1;
  s.world.animals = [victim]; s.person.inventory = 0.25; s.person.hunger = 0; s.person.work = 44;
  stepWorld(s.world);
  assert.equal(s.world.animalDynamics.humanHunts, 1); assert.equal(s.person.inventory, 0.25);
  assert.equal(s.person.hunger, 0); cerca(s.person.utilidadLocal!.hunt!.q, FOOD_PER_ANIMAL[victim.species] / 45);
});

function pendingTechnology(action: 'research' | 'craft', fail = false) {
  const s = scene(action), program = structuredClone(PROGRAMA_FILO), project = proyectoInvestigacion(program, 0);
  const work = technologyWorkCost(program);
  if (action === 'craft') {
    // La receta previa se aprende por las leyes físicas reales; no se inventa un
    // proyecto craft sin recipeId. Estos resultados preparan el fixture, fuera
    // del sitio productivo de index y sin sembrar q.
    s.person.materials.stone = 8;
    s.person.technology.project = proyectoInvestigacion(structuredClone(program), 0);
    for (let i = 0; i < work; i++) researchTechnology(s.world, s.person);
    assert.equal(s.person.technology.items.length, 1);
    project.recipeId = s.person.technology.knownRecipes[0]!;
    s.person.technology.items = [];
  }
  const attempts = s.person.technology.attempts, ledgerWork = s.world.technology.ledger.work;
  project.kind = action; project.progress = work - 1; project.energyPaid = (work - 1) * 0.00045;
  s.person.technology.project = project;
  s.person.materials.stone = fail ? 0 : 8;
  s.world.technology.ledger.work += work - 1; s.world.technology.ledger.energy += project.energyPaid;
  return { ...s, work, attempts, ledgerEnd: ledgerWork + work };
}

test('research y craft incluyen el último débito y todos los ticks previos; fracaso pagado cero', () => {
  for (const action of ['research', 'craft'] as const) {
    const s = pendingTechnology(action); stepWorld(s.world);
    assert.equal(s.person.technology.attempts, s.attempts + 1); assert.equal(s.person.technology.project, null);
    assert.equal(s.world.technology.ledger.work, s.ledgerEnd);
    assert.equal(s.person.technology.items.length, 1);
    cerca(s.person.utilidadLocal![action]!.q, 1 / s.work);
    const failed = pendingTechnology(action, true); stepWorld(failed.world);
    assert.equal(failed.world.technology.ledger.work, failed.ledgerEnd);
    assert.deepEqual(failed.person.utilidadLocal, { [action]: { q: 0, intentos: 1 } });
  }
});

test('el último débito tecnológico conserva precisión con ledger cerca de MAX_SAFE_INTEGER', () => {
  const s = pendingTechnology('research');
  const opening = Number.MAX_SAFE_INTEGER - 1;
  s.world.technology.ledger.work = opening;
  assert.equal(s.person.technology.project!.progress, s.work - 1);
  stepWorld(s.world);
  assert.equal(s.world.technology.ledger.work - opening, 1);
  assert.equal(s.person.technology.project, null);
  assert.equal(s.person.technology.items.length, 1);
  assert.deepEqual(s.person.utilidadLocal, { research: { q: 1 / s.work, intentos: 1 } });
});

test('rechazo tecnológico sin pago no crea observación; suspensión retiene trabajo para el resultado', () => {
  for (const action of ['research', 'craft'] as const) {
    const free = scene(action); free.person.materials = { wood: 0, stone: 0 };
    const priorWork = free.world.technology.ledger.work; stepWorld(free.world);
    assert.equal(free.person.technology.attempts, 1);
    assert.equal(free.world.technology.ledger.work, priorWork);
    assert.equal(Object.hasOwn(free.person, 'utilidadLocal'), false);
  }
  const s = pendingTechnology('research'); s.person.action = 'rest';
  const progress = s.person.technology.project!.progress;
  stepWorld(s.world); assert.equal(s.person.technology.project!.progress, progress);
  assert.equal(Object.hasOwn(s.person, 'utilidadLocal'), false);
  s.person.action = 'research'; stepWorld(s.world);
  cerca(s.person.utilidadLocal!.research!.q, 1 / s.work);
});

test('cambio de orden abandona trabajo físico y cancelación tecnológica sin outcome no aprende', () => {
  const s = scene('gather'); s.person.work = 17;
  stepWorld(s.world, [{ id: 'change', kind: 'command', agentId: s.person.id, order: 'rest', x: s.person.x, y: s.person.y }]);
  assert.equal(s.person.work, 0); assert.equal(Object.hasOwn(s.person, 'utilidadLocal'), false);
  const tech = pendingTechnology('research');
  stepWorld(tech.world, [{ id: 'cancel', kind: 'command', agentId: tech.person.id, order: 'craft', x: tech.person.x, y: tech.person.y }]);
  assert.equal(Object.hasOwn(tech.person, 'utilidadLocal'), false);
  assert.ok(tech.world.technology.history.some(e => e.kind === 'research' && !e.success && e.work === tech.work - 1));
});

test('recibir un objeto existente no es producirlo ni observar un retorno', () => {
  const s = scene('rest'), receiver = s.world.people[3]!;
  receiver.x = s.person.x; receiver.y = s.person.y;
  const item = rawMaterial('wood'); item.id = 'product-1';
  s.person.technology.items.push(item);
  assert.equal(transferTechnologyItem(s.world, s.person, receiver, item.id), true);
  assert.equal(receiver.technology.items[0], item);
  assert.equal(Object.hasOwn(receiver, 'utilidadLocal'), false); assert.equal(Object.hasOwn(s.person, 'utilidadLocal'), false);
});

test('clone y rollback mantienen q, intentos y trabajo pendiente sin compartir objetos', () => {
  const s = pendingTechnology('research');
  s.person.utilidadLocal = { gather: { q: 0.375, intentos: 3 } }; s.person.work = 7;
  const digest = digestoCanonico(s.world), clone = cloneWorld(s.world), cloned = clone.people[2]!;
  assert.deepEqual(cloned.utilidadLocal, s.person.utilidadLocal); assert.notEqual(cloned.utilidadLocal, s.person.utilidadLocal);
  assert.notEqual(cloned.utilidadLocal!.gather, s.person.utilidadLocal.gather);
  assert.equal(cloned.work, 7); assert.deepEqual(cloned.technology.project, s.person.technology.project);
  cloned.utilidadLocal!.gather!.q = 0; cloned.technology.project!.progress = 0;
  assert.equal(s.person.utilidadLocal.gather!.q, 0.375); assert.equal(s.person.technology.project!.progress, s.work - 1);
  const restore = puntoDeRestauracion(s.world);
  s.person.utilidadLocal.gather!.q = 0; s.person.work = 0; s.person.technology.project!.progress = 0;
  restore.restaurar(); assert.equal(digestoCanonico(s.world), digest);
  const absent = scene('gather'), checkpoint = puntoDeRestauracion(absent.world);
  absent.person.work = 17; stepWorld(absent.world); assert.ok(absent.person.utilidadLocal);
  checkpoint.restaurar(); assert.equal(Object.hasOwn(absent.world.people[2]!, 'utilidadLocal'), false);
});

test('una cría comienza sin q aunque ambos progenitores ya aprendieron', () => {
  const world = createWorld(51926, params()), a = world.people[2]!, b = world.people[3]!;
  world.tick = 599; world.communities = [];
  for (const p of world.people) {
    p.communityId = null; p.bonds = {}; p.action = 'rest'; p.decisionAt = 999;
    p.hunger = p.thirst = p.fatigue = 0.1; p.energy = 0.9;
    p.demography = initialDemography(world.tick - p.bornAt); p.target = { x: p.x, y: p.y };
  }
  const place = world.places[0]!;
  for (const [index, p] of [a, b].entries()) {
    p.x = place.x; p.y = place.y; p.target = { x: p.x, y: p.y }; p.inventory = 0.2;
    p.utilidadLocal = { gather: { q: index ? 0.8 : 0.2, intentos: 8 } };
    p.communityId = `learning-family-${index}`;
    world.communities.push({ id: p.communityId, name: p.communityId, x: p.x, y: p.y, color: '#aabbcc', members: [p.id],
      culture: { ...p.culture }, formedAt: 0, cooperation: 0, disputes: 0 });
  }
  a.bonds[b.id] = b.bonds[a.id] = 0.7;
  stepWorld(world);
  assert.equal(world.totals.births, 1);
  const child = world.people.at(-1)!;
  assert.deepEqual(child.genome.parents, [a.id, b.id]); assert.equal(Object.hasOwn(child, 'utilidadLocal'), false);
  assert.equal(child.work, 0); assert.equal(child.technology.project, null);
  assertWorld(world);
});
