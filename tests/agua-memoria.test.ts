import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { createWorld, stepWorld, type Person, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { waterAvailable } from '../src/world/inventions.js';
import { tileAt } from '../src/world/spatial.js';
import { DEFAULT_PARAMS, PARAM_RANGES, paramsOf, parseParams, setParams, type WorldParams } from '../src/world/params.js';

/**
 * Ley candidata SED (noche 2026-09-22): `agua.memoria`. Diagnóstico con la base del laboratorio de
 * la noche (semilla 42): las muertes por deshidratación son de gente que lleva 850–1100 pasos con
 * sed > 0,7 EXPLORANDO; la búsqueda de hoy premia la novedad y la aleja de la cuenca hasta morir a
 * ~130 celdas del agua más cercana. La ley: recordar la última celda con agua que vio (o donde bebió),
 * olvidarla al verla seca, y sin agua a la vista volver a ella cuando la sed prevista al llegar (la de
 * ahora − el agua que lleva + la del camino) supera el umbral. Default 1 = hoy.
 */

const BASE_LAB = 'persistencia.cadaTicks=300,poblacion.cortejo=1,poblacion.exigeComunidad=false,poblacion.comprobacionContinua=true,conducta.habituacion=0.35';

/** Réplica mínima como `scripts/lab/replica.ts`: Store temporal y `save` antes del primer paso. */
function replica(t: { after(callback: () => void): void }, seed: number, pasos: number, params?: string): World {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-agua-memoria-'));
  const store = new Store(join(directory, 'world.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const world = createWorld(seed, parseParams(params));
  store.save(world);
  for (let tick = 1; tick <= pasos; tick++) stepWorld(world);
  return world;
}

/** Digesto con la FORMA de params anterior a esta ley (sin `agua.memoria`): `digestoCanonico`
 * hashea `{world, params}`, así que declarar la clave mueve el hash aunque el mundo no se mueva. */
function digestoSinMemoria(world: World): string {
  const vigentes = paramsOf(world);
  const antes = structuredClone(vigentes) as unknown as { agua: Record<string, unknown> };
  delete antes.agua.memoria;
  setParams(world, antes as unknown as WorldParams);
  try { return digestoCanonico(world); } finally { setParams(world, vigentes); }
}

// Medidos en `sprint/noche-hsed-20260922` @f666226 ANTES de tocar nada, con la réplica de arriba.
const FISICO_51926_1200 = 'd7e173a1f4610463929ed8128f2006a04833a477b6712800585e070edc95a9d9';
const FISICO_42_BASE_1200 = '844e82c55b5cf0e4bf6b00e2a55e64b5add18c27270c5d12f00a472214f346cc';
// Los mismos mundos con la clave ya declarada (default 1): sólo cambia el hash, no el estado.
const COMPLETO_51926_1200 = '7a33a032143f0faeb610702d50c4411292d0c52158874d3a5997c260d1102f4b';
const COMPLETO_42_BASE_1200 = '4ee4b82be1ed69821b5f71d1a6ad75b94cc0fff94b8b432fb11c46844894defc';

test('(i) con el default agua.memoria=1 el mundo es bit a bit el de antes (defaults y régimen del laboratorio)', { timeout: 1_800_000 }, t => {
  assert.equal(DEFAULT_PARAMS.agua.memoria, 1);
  const defecto = replica(t, 51926, 1200);
  assert.equal(digestoSinMemoria(defecto), FISICO_51926_1200, 'seed 51926, defaults, 1200 pasos: el estado físico no se movió');
  assert.equal(digestoCanonico(defecto), COMPLETO_51926_1200, 'el digesto completo sólo cambia por declarar la clave (T102)');
  const lab = replica(t, 42, 1200, BASE_LAB);
  assert.equal(digestoSinMemoria(lab), FISICO_42_BASE_1200, 'seed 42 con la base de la noche: el estado físico no se movió');
  assert.equal(digestoCanonico(lab), COMPLETO_42_BASE_1200);
  for (const world of [defecto, lab]) assert.ok(world.people.every(person => person.waterMemory === undefined), 'sin la ley nadie recuerda aguaderos');
});

/**
 * Escena de la semilla 42 al crearse (medida): (16,0) no tiene agua a menos de 8 celdas y (14,11)
 * es una charca a 13 pasos por tierra. Un vecino sediento (0,65) que recuerda haber bebido allí.
 */
const SECO = { x: 16, y: 0 }, CHARCA = { x: 14, y: 11 };
function escena(params?: string): { world: World; person: Person } {
  const world = createWorld(42, parseParams(params)); world.weather = 'clear';
  world.people = world.people.slice(0, 3); world.communities = [];
  const person = world.people[2]!;
  for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) {
    const tile = tileAt(world, { x: SECO.x + dx, y: SECO.y + dy });
    if (tile) assert.equal(waterAvailable(world, tile), 0, `la escena exige tierra seca alrededor de (16,0): (${tile.x},${tile.y})`);
  }
  assert.ok(waterAvailable(world, CHARCA) > 0.2, 'la charca recordada tiene agua');
  Object.assign(person, { x: SECO.x, y: SECO.y, target: { ...SECO }, action: 'rest', decisionAt: 0, thirst: 0.65, hunger: 0.1, fatigue: 0.1, energy: 0.9,
    inventory: 0, communityId: null, bonds: {}, command: null, values: {}, activity: {} });
  person.materials = { wood: 0, stone: 0 };
  person.waterMemory = { ...CHARCA };
  return { world, person };
}
const distancia = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

test('(ii) con sed y sin agua a la vista vuelve al último lugar donde vio agua; con el default explora al azar', { timeout: 600_000 }, () => {
  const hoy = escena();
  stepWorld(hoy.world);
  assert.equal(hoy.person.action, 'explore');
  assert.notDeepEqual(hoy.person.target, CHARCA, 'hoy la búsqueda elige una celda nueva, no el aguadero recordado');

  const ley = escena('agua.memoria=0.6');
  stepWorld(ley.world);
  assert.equal(ley.person.action, 'explore');
  assert.deepEqual(ley.person.target, CHARCA, 'con la ley la búsqueda va hacia la charca recordada');
  assert.match(ley.person.reason, /último lugar donde vio agua/);
  // Camina (paga el movimiento), ve la charca al acercarse y bebe de ella: la sed baja y el recuerdo se renueva.
  const sedInicial = ley.person.thirst, inicio = distancia(ley.person, CHARCA);
  let bebio = -1;
  for (let paso = 0; paso < 400 && bebio < 0; paso++) {
    const antes = ley.person.thirst;
    stepWorld(ley.world);
    if (ley.person.thirst < antes) bebio = ley.world.tick;
  }
  assert.ok(bebio > 0, 'en 400 pasos llega al agua y bebe');
  assert.ok(distancia(ley.person, CHARCA) < inicio, 'se acercó a la charca recordada');
  assert.ok(ley.person.waterMemory && distancia(ley.person.waterMemory, ley.person) === 0, 'el recuerdo pasa a ser la celda donde acaba de beber');
  // Durante el camino la sed siguió subiendo (el camino se paga); unos pasos bebiendo la dejan por debajo de la inicial.
  for (let paso = 0; paso < 40; paso++) stepWorld(ley.world);
  assert.ok(ley.person.thirst < sedInicial, `sed ${ley.person.thirst} tras beber no baja de ${sedInicial}`);
});

test('(iii) un recuerdo que se ve seco se olvida; bajo el umbral no manda nada', () => {
  const seco = escena('agua.memoria=0.6');
  seco.person.waterMemory = { x: SECO.x + 2, y: SECO.y + 3 }; // dentro de la percepción y sin agua
  stepWorld(seco.world);
  assert.equal(seco.person.waterMemory, undefined, 'ver seco el aguadero borra el recuerdo');
  assert.notDeepEqual(seco.person.target, { x: SECO.x + 2, y: SECO.y + 3 });

  const tranquila = escena('agua.memoria=0.6');
  tranquila.person.thirst = 0.5;
  stepWorld(tranquila.world);
  assert.notDeepEqual(tranquila.person.target, CHARCA, 'con sed 0,5 < 0,6 la memoria no dirige el paso');
  assert.deepEqual(tranquila.person.waterMemory, CHARCA, 'pero el recuerdo lejano se conserva');

  const anticipa = escena('agua.memoria=0.45');
  anticipa.person.thirst = 0.5;
  stepWorld(anticipa.world);
  assert.deepEqual(anticipa.person.target, CHARCA, 'con umbral 0,45 ya vuelve con sed 0,5 (anticipación)');
  assert.match(anticipa.person.reason, /antes de que la sed apriete/);

  // La sed del camino cuenta: con sed 0,3 y el aguadero a 200 celdas, llegaría con más de 0,6 → vuelve ya.
  const LEJOS = { x: SECO.x, y: SECO.y - 200 };
  const lejos = escena('agua.memoria=0.6');
  lejos.person.thirst = 0.3; lejos.person.waterMemory = { ...LEJOS };
  stepWorld(lejos.world);
  assert.deepEqual(lejos.person.target, LEJOS, 'la sed prevista al llegar (0,3 + camino) supera 0,6: emprende la vuelta');
  const cerca = escena('agua.memoria=0.6');
  cerca.person.thirst = 0.3;
  stepWorld(cerca.world);
  assert.notDeepEqual(cerca.person.target, CHARCA, 'a 11 celdas llegaría con ~0,33: sigue con lo suyo');
});

test('(iv) ver agua y beber del entorno registran el lugar sólo con la ley activa', () => {
  for (const [params, recuerda] of [[undefined, false], ['agua.memoria=0.6', true]] as const) {
    const { world, person } = escena(params);
    delete person.waterMemory;
    Object.assign(person, { x: CHARCA.x + 2, y: CHARCA.y - 3, target: { x: CHARCA.x + 2, y: CHARCA.y - 3 }, thirst: 0.1 });
    stepWorld(world);
    if (!recuerda) assert.equal(person.waterMemory, undefined);
    else assert.ok(person.waterMemory && waterAvailable(world, person.waterMemory) > 0.005, 'recuerda la celda con agua que acaba de ver');
  }
  for (const [params, recuerda] of [[undefined, false], ['agua.memoria=0.6', true]] as const) {
    const { world, person } = escena(params);
    delete person.waterMemory;
    Object.assign(person, { x: CHARCA.x, y: CHARCA.y, target: { ...CHARCA }, action: 'drink', thirst: 0.5, decisionAt: 1_000 });
    stepWorld(world);
    assert.ok(person.thirst < 0.5, 'bebió');
    assert.deepEqual(person.waterMemory, recuerda ? CHARCA : undefined);
  }
});

test('(v) agua.memoria se acota a [0,1]; una instantánea anterior a la ley la completa con 1 y el recuerdo persiste', t => {
  assert.deepEqual(PARAM_RANGES['agua.memoria'], [0, 1]);
  assert.throws(() => parseParams('agua.memoria=1.05'), /rango/i);
  assert.throws(() => parseParams('agua.memoria=-0.05'), /rango/i);
  assert.equal(parseParams('agua.memoria=0.45').agua.memoria, 0.45);

  const directory = mkdtempSync(join(tmpdir(), 'atlas-agua-memoria-snapshot-'));
  const path = join(directory, 'world.sqlite'), store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const { world, person } = escena('agua.memoria=0.6,agua.cuencas=0.4');
  store.save(world);
  const saved = JSON.parse((store.db.prepare('SELECT body FROM snapshots WHERE slot=0').get() as { body: string }).body);
  assert.equal(saved.params.agua.memoria, 0.6);
  const reopenedLaw = new Store(path);
  t.after(() => reopenedLaw.close());
  const loaded = reopenedLaw.load()!.world;
  assert.deepEqual(loaded.people.find(p => p.id === person.id)!.waterMemory, CHARCA, 'el recuerdo viaja con la instantánea y pasa la validación');

  delete saved.params.agua.memoria; // Instantánea escrita antes de esta ley.
  for (const p of saved.people ?? []) delete p.waterMemory;
  const body = JSON.stringify(saved);
  store.db.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=0').run(body, createHash('sha256').update(body).digest('hex'));
  const reopened = new Store(path);
  t.after(() => reopened.close());
  assert.equal(paramsOf(reopened.load()!.world).agua.memoria, 1, 'sin campo rige el comportamiento de siempre');
});
