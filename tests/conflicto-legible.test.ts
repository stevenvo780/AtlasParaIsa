import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { createWorld, stepWorld, TICKS_PER_DAY, type Person, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { tileAt } from '../src/world/spatial.js';
import { DEFAULT_PARAMS, HISTORICAL_PARAMS, PARAM_RANGES, paramsOf, parseParams, setParams, type WorldParams } from '../src/world/params.js';

/**
 * Hipótesis CONFL (noche 2026-09-22): conflicto legible no letal, `social.memoriaDisputa`.
 * Diagnóstico (`scripts/lab/diagnostico-disputas.ts`): hoy, en `resourceDispute`, cede quien llega
 * primero a la comprobación —quien va antes en `world.people`—, no quien menos lo necesita, y queda
 * treinta pasos inmóvil sin poder volver a elegir aunque su sed o su hambre pasen de 0,9. La ley: cede
 * quien menos lo necesita (empate: el de id mayor), vuelve a elegir al paso siguiente y recuerda un día
 * la fuente disputada, que al elegir dónde comer, beber o cazar le parece `memoriaDisputa` celdas más
 * lejos. Default 0 = hoy.
 */

/** Carril de la ronda 3 (base P de la ronda 2) con el disparador de disputas abierto (claves de la noche). */
const CARRIL_D = 'persistencia.cadaTicks=300,poblacion.cortejo=2,poblacion.radioCortejo=128,poblacion.exigeComunidad=false,'
  + 'poblacion.comprobacionContinua=true,conducta.habituacion=0.35,agua.memoria=0.6,social.disputaNecesidad=0.45,social.disputaEscasez=3,social.disputaRadio=3';

/** Réplica mínima como `scripts/lab/replica.ts`: Store temporal y `save` antes del primer paso.
 * Fusión con reglas 10 (`sprint/noche-lab60c-20260922`): los «defaults» de e1adaaf, donde se midieron los
 * hashes de abajo, son `HISTORICAL_PARAMS`; la réplica parte de esa base explícita. El carril D nombra las
 * cinco claves adoptadas, así que con él la base no cambia nada (lo comprueba (i)). */
function replica(t: { after(callback: () => void): void }, seed: number, pasos: number, params?: string): World {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-conflicto-'));
  const store = new Store(join(directory, 'world.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const world = createWorld(seed, parseParams(params, HISTORICAL_PARAMS));
  store.save(world);
  for (let tick = 1; tick <= pasos; tick++) stepWorld(world);
  return world;
}

/** Digesto con la FORMA de params anterior a esta ley (sin `social.memoriaDisputa`): `digestoCanonico`
 * hashea `{world, params}`, así que declarar la clave mueve el hash aunque el estado no se mueva (T102). */
function digestoSinLaClave(world: World): string {
  const vigentes = paramsOf(world);
  const antes = structuredClone(vigentes) as unknown as { social: Record<string, unknown> };
  delete antes.social.memoriaDisputa;
  setParams(world, antes as unknown as WorldParams);
  try { return digestoCanonico(world); } finally { setParams(world, vigentes); }
}

// Medidos en `sprint/noche-r3confl-20260922` @e1adaaf ANTES de tocar `src/world`, con la réplica de arriba.
const PREVIO_42_DEFAULTS_1200 = 'de0bfc68040849eb0b0c906d023a4625893b816b50a7659d14b03ad73616c99f';
const PREVIO_51926_CARRIL_D_2400 = 'ea56cf5a7901ec169e228bdae9838c8e6b646dd485d2849974b1f8c602cb3e72';

test('(i) con memoriaDisputa=0 el mundo es bit a bit el de antes, también cuando hay disputas', { timeout: 2_800_000 }, t => {
  assert.equal(DEFAULT_PARAMS.social.memoriaDisputa, 0);
  assert.deepEqual(PARAM_RANGES['social.memoriaDisputa'], [0, 32]);
  assert.equal(HISTORICAL_PARAMS.social.memoriaDisputa, 0);
  assert.deepEqual(parseParams(CARRIL_D, HISTORICAL_PARAMS), parseParams(CARRIL_D), 'el carril D da el mismo mundo sobre cualquier base');
  const defecto = replica(t, 42, 1200);
  assert.equal(digestoSinLaClave(defecto), PREVIO_42_DEFAULTS_1200, 'seed 42, defaults, 1200 pasos');
  const carril = replica(t, 51926, 2400, CARRIL_D);
  assert.ok((carril.totals.conflicts ?? 0) > 0, 'el control ejerce el camino de la disputa de hoy');
  assert.equal(digestoSinLaClave(carril), PREVIO_51926_CARRIL_D_2400, 'seed 51926, carril con disputas, 2400 pasos');
  for (const world of [defecto, carril]) assert.ok(world.people.every(p => p.conflictMemory === undefined), 'sin la ley nadie recuerda disputas');
});

/**
 * Escena: dos vecinos de comunidades distintas, sin confianza ni apertura, comiendo de la misma celda F
 * con alimento escaso (0,05 ≤ 0,06). `a` va antes en `world.people` y tiene MÁS hambre (0,88) que `b`
 * (0,70). A 5 celdas hay otra fuente G con alimento de sobra. Nada más de comer alrededor.
 */
function escena(params?: string, hambreA = 0.88, hambreB = 0.7) {
  const world = createWorld(42, parseParams(params)); world.weather = 'clear';
  world.people = world.people.filter(p => p.role === 'neighbor').slice(0, 2);
  const [a, b] = world.people as [Person, Person];
  // Busca una celda de tierra F con vecina de tierra al oeste y otra celda de tierra G a 5 al este.
  let F: { x: number; y: number } | undefined;
  for (let y = 0; y < 40 && !F; y++) for (let x = 2; x < 40 && !F; x++) {
    const tierra = (dx: number) => { const tile = tileAt(world, { x: x + dx, y }); return !!tile && tile.terrain !== 'water'; };
    if ([-1, 0, 1, 2, 3, 4, 5].every(tierra)) F = { x, y };
  }
  assert.ok(F, 'la escena necesita una franja de tierra');
  const G = { x: F.x + 5, y: F.y };
  for (let dy = -12; dy <= 12; dy++) for (let dx = -12; dx <= 12; dx++) {
    const tile = tileAt(world, { x: F.x + dx, y: F.y + dy }); if (tile) { tile.food = 0; tile.fauna = 0; }
  }
  world.animals = [];
  tileAt(world, F)!.food = 0.05; tileAt(world, G)!.food = 0.5;
  world.communities = [a, b].map((p, i) => ({ id: `community-${i + 1}`, name: `Círculo ${i + 1}`, x: F!.x, y: F!.y, color: '#fff', members: [p.id],
    culture: { sharing: 0.2, stewardship: 0.2, openness: 0.2 }, formedAt: 0, cooperation: 0, disputes: 0 }));
  world.communityCounter = 2;
  for (const [p, hambre, x] of [[a, hambreA, F.x - 1], [b, hambreB, F.x]] as const) {
    Object.assign(p, { x, y: F.y, target: { ...F }, action: 'eat', decisionAt: 100, hunger: hambre, thirst: 0.1, fatigue: 0.1, energy: 0.9,
      inventory: 0, communityId: `community-${p === a ? 1 : 2}`, bonds: {}, command: null, values: {}, activity: {}, lastDispute: -180 });
    p.culture = { sharing: 0.2, stewardship: 0.2, openness: 0.2 };
  }
  return { world, a, b, F, G };
}

test('(ii) hoy cede quien llega antes a la comprobación, aunque tenga más hambre, y queda inmóvil treinta pasos', () => {
  const { world, a, b } = escena();
  stepWorld(world);
  assert.equal(world.totals.conflicts, 1);
  assert.equal(a.action, 'retreat', 'cede `a`, el primero de la lista, con hambre 0,88');
  assert.equal(b.action, 'eat');
  assert.equal(a.decisionAt, world.tick + 30);
  const conflicto = world.events.find(e => e.kind === 'conflict')!;
  assert.deepEqual(conflicto.actors, [a.id, b.id]);
  for (let paso = 0; paso < 10; paso++) stepWorld(world);
  assert.equal(a.action, 'retreat', 'diez pasos después sigue sin poder volver a elegir');
  assert.equal(a.conflictMemory, undefined);
});

test('(iii) con la ley cede quien menos lo necesita, vuelve a elegir al paso siguiente y va a otra fuente', () => {
  const { world, a, b, F, G } = escena('social.memoriaDisputa=8');
  stepWorld(world);
  assert.equal(world.totals.conflicts, 1);
  assert.equal(a.action, 'eat', 'quien tiene más hambre conserva la fuente');
  assert.equal(b.action, 'retreat');
  assert.equal(b.decisionAt, world.tick + 1);
  assert.deepEqual(b.conflictMemory, { x: F.x, y: F.y, tick: world.tick });
  const conflicto = world.events.find(e => e.kind === 'conflict')!;
  assert.deepEqual(conflicto.actors, [b.id, a.id], 'actors[0] sigue siendo quien cede');
  assert.match(conflicto.text, /cedió/);
  // El coste es el de siempre, en los dos: fatiga, tensión y confianza.
  assert.ok(a.socialLoad > 0.11 && b.socialLoad > 0.11);
  assert.ok((a.bonds[b.id] ?? 0.2) < 0.2 && (b.bonds[a.id] ?? 0.2) < 0.2);
  stepWorld(world);
  assert.equal(b.action, 'eat', 'vuelve a elegir comer al paso siguiente');
  assert.deepEqual(b.target, G, 'prefiere la otra fuente que percibe');
});

test('(iv) sin otra fuente vuelve a la disputada: el recuerdo reordena, no prohíbe', () => {
  const { world, b, F, G } = escena('social.memoriaDisputa=8');
  tileAt(world, G)!.food = 0;
  stepWorld(world); stepWorld(world);
  assert.equal(b.action, 'eat');
  assert.deepEqual(b.target, F, 'la única fuente que percibe sigue siendo elegible');
});

test('(v) con la misma necesidad cede el de id mayor; el recuerdo se olvida al día', () => {
  const { world, a, b } = escena('social.memoriaDisputa=8', 0.8, 0.8);
  stepWorld(world);
  const [menor, mayor] = a.id < b.id ? [a, b] : [b, a];
  assert.equal(mayor.action, 'retreat');
  assert.equal(menor.action, 'eat');
  mayor.conflictMemory!.tick = world.tick - TICKS_PER_DAY;
  stepWorld(world);
  assert.equal(mayor.conflictMemory, undefined, 'pasado un día el recuerdo se borra al volver a elegir');
});

test('(vi) un turno lo espera quien menos lo necesita', () => {
  const hoy = escena();
  hoy.a.bonds[hoy.b.id] = 0.6;
  stepWorld(hoy.world);
  assert.equal(hoy.a.action, 'retreat', 'hoy espera el primero de la lista');
  const ley = escena('social.memoriaDisputa=8');
  ley.a.bonds[ley.b.id] = 0.6;
  stepWorld(ley.world);
  assert.equal(ley.world.totals.conflicts ?? 0, 0);
  assert.equal(ley.b.action, 'retreat', 'con la ley espera quien tiene menos hambre');
  assert.equal(ley.b.decisionAt, ley.world.tick + 12);
  assert.equal(ley.b.conflictMemory, undefined, 'un turno no deja recuerdo de disputa');
  assert.equal(ley.world.events.find(e => e.kind === 'cooperation' && /turnarse/.test(e.text))?.actors[0], ley.b.id);
});
