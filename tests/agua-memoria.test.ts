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
import { DEFAULT_PARAMS, HISTORICAL_PARAMS, PARAM_RANGES, paramsOf, parseParams, setParams, type WorldParams } from '../src/world/params.js';

/**
 * Ley candidata SED (noche 2026-09-22): `agua.memoria`. Diagnóstico con la base del laboratorio de
 * la noche (semilla 42): las muertes por deshidratación son de gente que lleva 850–1100 pasos con
 * sed > 0,7 EXPLORANDO; la búsqueda de hoy premia la novedad y la aleja de la cuenca hasta morir a
 * ~130 celdas del agua más cercana. La ley: recordar la última celda con agua que vio (o donde bebió),
 * olvidarla al verla seca, y sin agua a la vista volver a ella cuando la sed prevista al llegar (la de
 * ahora − el agua que lleva + la del camino) supera el umbral. Default 1 = hoy.
 */

const BASE_LAB = 'persistencia.cadaTicks=300,poblacion.cortejo=1,poblacion.exigeComunidad=false,poblacion.comprobacionContinua=true,conducta.habituacion=0.35';

/** Réplica mínima como `scripts/lab/replica.ts`: Store temporal y `save` antes del primer paso. Parte de
 * `HISTORICAL_PARAMS` explícitos (reglas 10, etapa 1): esta ley se midió sobre el mundo de antes, y con
 * los defaults nuevos `BASE_LAB` heredaría además `poblacion.radioCortejo=128`. */
function replica(t: { after(callback: () => void): void }, seed: number, pasos: number, params?: string): World {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-agua-memoria-'));
  const store = new Store(join(directory, 'world.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const world = createWorld(seed, parseParams(params, HISTORICAL_PARAMS));
  store.save(world);
  for (let tick = 1; tick <= pasos; tick++) stepWorld(world);
  return world;
}

/** Digesto con la FORMA de params anterior a esta ley (sin `agua.memoria`): `digestoCanonico`
 * hashea `{world, params}`, así que declarar la clave mueve el hash aunque el mundo no se mueva.
 * `conMemoria` la conserva (digesto «completo» de f2757fa). En ambos casos se quita también
 * `social.memoriaDisputa` (fusión CONFL, `sprint/noche-lab60c-20260922`): no existía en f2757fa, donde se
 * midieron los hashes, y con su valor 0 no actúa. */
function digestoSinMemoria(world: World, conMemoria = false): string {
  const vigentes = paramsOf(world);
  const antes = structuredClone(vigentes) as unknown as {
    agua: Record<string, unknown>;
    social: Record<string, unknown>;
    tecnologia?: Record<string, unknown>;
    poblacion: Record<string, unknown>;
    conducta: Record<string, unknown>;
  };
  assert.equal(antes.social.memoriaDisputa, 0);
  assert.equal(antes.social.hogarTrabajo, 0);
  // COM-D′ (`sprint/com-d-20260928`): `social.disolucion` no existía en f2757fa; con su valor 0 no
  // actúa (identidad demostrada en `tests/com-d.test.ts`), así que también se quita de la forma.
  assert.equal(antes.social.disolucion, 0);
  // Fase B (`sprint/estabilidad-fase-b-20261118`): `tecnologia.*` no existía en f2757fa; con sus
  // valores históricos no actúa, así que también se quita de la forma.
  assert.deepEqual(antes.tecnologia, HISTORICAL_PARAMS.tecnologia);
  // V12 (`sprint/v15-rules12-20261119`): claves opt-in en valor inactivo (default) no actúan.
  assert.equal(antes.poblacion.natalidadVecindad, false);
  assert.equal(antes.poblacion.radioVecindadNatalidad, 16);
  assert.equal(antes.conducta.politicaPeso, 0);
  if (!conMemoria) delete antes.agua.memoria;
  delete antes.social.memoriaDisputa;
  delete antes.social.hogarTrabajo;
  delete antes.social.disolucion;
  delete antes.tecnologia;
  delete antes.poblacion.natalidadVecindad;
  delete antes.poblacion.radioVecindadNatalidad;
  delete antes.conducta.politicaPeso;
  // Poda ola 1 (2026-09-27): `conducta.vocacion`/`vocacionTope` y
  // `poblacion.natalidadLocal`/`radioProvision` ya no se declaran; la forma las trae quitadas.
  setParams(world, antes as unknown as WorldParams);
  const version = world.version;
  // La referencia V10 mide este mismo estado; sólo normalizamos su etiqueta al hashear.
  world.version = 10;
  try { return digestoCanonico(world); } finally { world.version = version; setParams(world, vigentes); }
}

// V23: no hay digestos dorados con valor fijo. La identidad «con agua.memoria=1 el mundo no se mueve» se
// comprueba como reproducibilidad: dos réplicas de lo mismo (misma semilla, un hilo, sin tarjeta) dan el
// mismo digesto, en su forma «física» (sin la clave) y «completa» (con la clave declarada).
test('(i) con agua.memoria=1 el mundo es reproducible (params históricos y régimen del laboratorio) y nadie recuerda aguaderos', { timeout: 1_800_000 }, t => {
  assert.equal(DEFAULT_PARAMS.agua.memoria, 1, 'reglas 10 no adopta la memoria del agua');
  assert.equal(HISTORICAL_PARAMS.agua.memoria, 1);
  const defecto = replica(t, 51926, 1200);
  const defectoOtra = replica(t, 51926, 1200);
  assert.equal(digestoSinMemoria(defecto), digestoSinMemoria(defectoOtra), 'seed 51926, params históricos, 1200 pasos: dos corridas, mismo estado físico');
  assert.equal(digestoSinMemoria(defecto, true), digestoSinMemoria(defectoOtra, true), 'el digesto completo también coincide entre corridas');
  const lab = replica(t, 42, 1200, BASE_LAB);
  const labOtra = replica(t, 42, 1200, BASE_LAB);
  assert.equal(digestoSinMemoria(lab), digestoSinMemoria(labOtra), 'seed 42 con la base de la noche: dos corridas, mismo estado físico');
  assert.equal(digestoSinMemoria(lab, true), digestoSinMemoria(labOtra, true));
  for (const world of [defecto, lab]) assert.ok(world.people.every(person => person.waterMemory === undefined), 'sin la ley nadie recuerda aguaderos');
});

/**
 * Escena de la semilla 42 al crearse (medida): (16,0) no tiene agua a menos de 8 celdas y (14,11)
 * es una charca a 13 pasos por tierra. Un vecino sediento (0,65) que recuerda haber bebido allí.
 */
const SECO = { x: 16, y: 0 }, CHARCA = { x: 14, y: 11 };
function escena(params?: string): { world: World; person: Person } {
  const world = createWorld(42, parseParams(params, HISTORICAL_PARAMS)); world.weather = 'clear';
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
