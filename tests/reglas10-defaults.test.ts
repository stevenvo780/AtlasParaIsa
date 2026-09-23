import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { readSnapshotParams } from '../src/server/snapshot.js';
import { deploymentParams } from '../src/server/deployment-params.js';
import { cloneWorld, createWorld, stepWorld, TICKS_PER_DAY, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { DEFAULT_PARAMS, HISTORICAL_PARAMS, RULES_10_ADOPTED, paramsOf, parseParams, setParams, type WorldParams } from '../src/world/params.js';

/**
 * Reglas 10, etapa 1 (2026-09-22): los mundos NUEVOS nacen con el paquete de natalidad medido esa
 * noche (cortejo 2, radio de cortejo 128, comunidad opcional, muestreo continuo, habituación 0,35);
 * los mundos ANTERIORES conservan su conducta: toda clave que su instantánea no nombra se completa
 * con `HISTORICAL_PARAMS`, nunca con `DEFAULT_PARAMS`. Evidencia y cifras: `docs/REGLAS.md` § «Reglas 10».
 */

const checksum = (body: string) => createHash('sha256').update(body).digest('hex');
function laboratorio(t: { after(callback: () => void): void }): { path: string; store: Store } {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-reglas10-defaults-'));
  const path = join(directory, 'world.sqlite'), store = new Store(path);
  t.after(() => { try { store.close(); } catch { /* ya cerrado por la prueba */ } rmSync(directory, { recursive: true, force: true }); });
  return { path, store };
}
const cuerpo = (store: Store) => JSON.parse((store.db.prepare('SELECT body FROM snapshots WHERE slot=0').get() as { body: string }).body) as Record<string, unknown>;
const reescribir = (store: Store, value: unknown) => {
  const body = JSON.stringify(value);
  store.db.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=0').run(body, checksum(body));
};

/** Claves que `main` @694f6b6 (reglas 9) no conocía: una instantánea V9 escrita antes de la noche del
 * 2026-09-22 no las nombra (las secciones `conducta` y `social` enteras no existían). */
function comoInstantaneaDeMain(params: Record<string, Record<string, unknown>>): void {
  delete params.conducta; delete params.social;
  delete params.gobernador!.politica; delete params.agua!.memoria; delete params.agua!.rebano;
  for (const clave of ['edadFundadoresMinDias', 'edadFundadoresMaxDias']) delete params.genes![clave];
  for (const clave of ['exigeComunidad', 'radioPareja', 'radioLugar', 'comprobacionContinua', 'cortejo', 'radioCortejo']) delete params.poblacion![clave];
}

/** Las cinco leyes adoptadas, leídas de unos params. */
const adoptadas = (params: WorldParams) => ({ cortejo: params.poblacion.cortejo, radioCortejo: params.poblacion.radioCortejo,
  exigeComunidad: params.poblacion.exigeComunidad, comprobacionContinua: params.poblacion.comprobacionContinua, habituacion: params.conducta.habituacion });
const HISTORICAS = { cortejo: 0, radioCortejo: 24, exigeComunidad: true, comprobacionContinua: false, habituacion: 0 };
const NUEVAS = { cortejo: 2, radioCortejo: 128, exigeComunidad: false, comprobacionContinua: true, habituacion: 0.35 };

test('(b) createWorld() nuevo nace con los defaults de reglas 10 y todo lo demás queda como antes', () => {
  const world = createWorld();
  assert.strictEqual(paramsOf(world), DEFAULT_PARAMS);
  assert.strictEqual(parseParams(undefined), DEFAULT_PARAMS, 'sin base ni overrides, los defaults nuevos');
  assert.deepEqual(adoptadas(DEFAULT_PARAMS), NUEVAS);
  assert.deepEqual(adoptadas(HISTORICAL_PARAMS), HISTORICAS);
  assert.deepEqual(RULES_10_ADOPTED, { poblacion: { cortejo: 2, radioCortejo: 128, exigeComunidad: false, comprobacionContinua: true }, conducta: { habituacion: 0.35 } });
  // Lo que NO se adopta sigue en su valor histórico: la memoria del agua quedó refutada fuera de muestra.
  assert.equal(DEFAULT_PARAMS.agua.memoria, 1);
  assert.equal(DEFAULT_PARAMS.conducta.aptitud, 0);
  assert.equal(DEFAULT_PARAMS.social.radioConvivencia, 0);
  assert.equal(DEFAULT_PARAMS.social.vinculoConvivencia, 0);
  assert.equal(DEFAULT_PARAMS.genes.edadFundadoresMinDias, 2); assert.equal(DEFAULT_PARAMS.genes.edadFundadoresMaxDias, 2);
  assert.equal(DEFAULT_PARAMS.gobernador.politica, 'techo');
  assert.deepEqual({ ...DEFAULT_PARAMS.social }, { maxComunidades: 8, disputaNecesidad: 0.65, disputaEscasez: 1, disputaRadio: 2, disputaDestino: 0.5,
    disputaEspera: 180, ensenanzaRareza: 0, confianzaSalida: 0.35, distanciaAlternativa: 0.2, vinculoConvivencia: 0, radioConvivencia: 0, memoriaDisputa: 0 });
  // Fuera de las cinco claves adoptadas, los defaults nuevos SON los históricos (mismo orden de claves).
  const sinAdoptadas = (params: WorldParams) => JSON.stringify({ ...params, poblacion: { ...params.poblacion, cortejo: 0, radioCortejo: 0,
    exigeComunidad: false, comprobacionContinua: false }, conducta: { ...params.conducta, habituacion: 0 } });
  assert.equal(sinAdoptadas(DEFAULT_PARAMS), sinAdoptadas(HISTORICAL_PARAMS));
  assert.ok(Object.isFrozen(HISTORICAL_PARAMS) && Object.isFrozen(HISTORICAL_PARAMS.poblacion) && Object.isFrozen(HISTORICAL_PARAMS.conducta));
  // Un servidor que genera un mundo nuevo parte de los defaults nuevos (los overrides del despliegue no los nombran).
  assert.deepEqual(adoptadas(deploymentParams(DEFAULT_PARAMS, undefined)), NUEVAS);
  // La receta documentada para medir el mundo de antes en el laboratorio da, byte a byte, los históricos.
  const antes = parseParams('poblacion.cortejo=0,poblacion.radioCortejo=24,poblacion.exigeComunidad=true,poblacion.comprobacionContinua=false,conducta.habituacion=0');
  assert.equal(JSON.stringify(antes), JSON.stringify(HISTORICAL_PARAMS));
});

test('(c) parseParams de un objeto sin las claves nuevas sobre la base histórica da los valores históricos', () => {
  const antiguo = { agua: { cuencas: 0.8 }, poblacion: { maxima: 50, intervaloComprobacionTicks: 120, nacimientosPorComprobacion: 2 } };
  const params = parseParams(antiguo, HISTORICAL_PARAMS);
  assert.deepEqual(adoptadas(params), HISTORICAS);
  assert.equal(params.agua.cuencas, 0.8); assert.equal(params.poblacion.maxima, 50);
  assert.equal(params.agua.memoria, 1);
  assert.deepEqual(params, parseParams('agua.cuencas=0.8,poblacion.maxima=50', HISTORICAL_PARAMS));
  // Contraste: sobre los defaults de un mundo nuevo el mismo objeto sí recibiría las leyes adoptadas.
  assert.deepEqual(adoptadas(parseParams(antiguo)), NUEVAS);

  // Lectura de instantáneas: las claves que el campo no nombra se completan con los históricos, sea
  // cual sea la versión de reglas, y lo que sí nombra se conserva tal cual.
  const actual = { version: 10, paramsEncoding: 'params-v1', params: { agua: { cuencas: 0.8 }, limites: { ...DEFAULT_PARAMS.limites } },
    limitsProfile: { version: 2, ...DEFAULT_PARAMS.limites } };
  assert.deepEqual(adoptadas(readSnapshotParams(actual)), HISTORICAS, 'reglas 10 sin las claves ⇒ históricos');
  assert.equal(readSnapshotParams(actual).agua.cuencas, 0.8);
  assert.deepEqual(adoptadas(readSnapshotParams({ ...actual, version: 9 })), HISTORICAS, 'reglas 9 ⇒ históricos');
  const explicitas = { ...actual, params: { ...actual.params, poblacion: { cortejo: 2 } } };
  assert.equal(readSnapshotParams(explicitas).poblacion.cortejo, 2, 'una clave nombrada no se toca');
  assert.equal(readSnapshotParams(explicitas).poblacion.radioCortejo, 24, 'y la que falta es la histórica');
  assert.deepEqual(readSnapshotParams({ version: 8 }), parseParams('limites.aplicacion=historicos', HISTORICAL_PARAMS),
    'sin campo ni perfil: históricos con admisión histórica');
});

test('(a) una instantánea V9 de antes de reglas 10 recarga, migra a V10 y sigue exactamente la trayectoria de las reglas anteriores', { timeout: 1_800_000 }, t => {
  const legado = laboratorio(t), control = laboratorio(t), otro = laboratorio(t);
  const world = createWorld(51926, HISTORICAL_PARAMS);
  for (let n = 0; n < 240; n++) stepWorld(world);
  world.version = 9;
  const copia = cloneWorld(world), tercera = cloneWorld(world);
  legado.store.save(world); control.store.save(copia); otro.store.save(tercera);
  // `legado` es la instantánea tal como la escribía `main` (reglas 9): sin ninguna clave de la noche.
  // `control` es la MISMA instantánea con los params históricos explícitos.
  const antigua = cuerpo(legado.store);
  assert.equal(antigua.version, 9);
  comoInstantaneaDeMain(antigua.params as Record<string, Record<string, unknown>>);
  reescribir(legado.store, antigua);
  assert.deepEqual(adoptadas(cuerpo(control.store).params as unknown as WorldParams), HISTORICAS);
  legado.store.close(); control.store.close(); otro.store.close();

  const reabierto = new Store(legado.path), referencia = new Store(control.path), contraste = new Store(otro.path);
  t.after(() => { reabierto.close(); referencia.close(); contraste.close(); });
  const cargado = reabierto.load()!.world, esperado = referencia.load()!.world, nuevo = contraste.load()!.world;
  assert.equal(cargado.version, 10, 'la migración V9→V10 sólo cambia la etiqueta');
  assert.equal(esperado.version, 10);
  assert.deepEqual(paramsOf(cargado), HISTORICAL_PARAMS, 'las claves ausentes se completan con los históricos, no con los defaults nuevos');
  assert.deepEqual(paramsOf(esperado), HISTORICAL_PARAMS, 'la migración conserva tal cual los params persistidos');
  assert.equal(digestoCanonico(cargado), digestoCanonico(esperado));

  // Sin la compatibilidad (claves ausentes completadas con los defaults nuevos) el mundo cambiaría de leyes.
  setParams(nuevo, parseParams(undefined, DEFAULT_PARAMS));
  const pasos = 1200;
  for (let n = 0; n < pasos; n++) { stepWorld(cargado); stepWorld(esperado); stepWorld(nuevo); }
  assert.equal(digestoCanonico(cargado), digestoCanonico(esperado), 'mismo digesto que avanzarla con params históricos explícitos');
  assert.equal(JSON.stringify(cargado), JSON.stringify(esperado));
  assert.notEqual(JSON.stringify(nuevo), JSON.stringify(cargado), 'con los defaults nuevos el mismo mundo toma otra trayectoria: el control tiene dientes');
});

test('la migración V9→V10 conserva los params persistidos tal cual, también si ya eran los nuevos', t => {
  const { path, store } = laboratorio(t);
  const world = createWorld(51926, parseParams('agua.cuencas=0.8'));
  world.version = 9;
  store.save(world); store.close();
  const reabierto = new Store(path);
  t.after(() => reabierto.close());
  const cargado = reabierto.load()!.world;
  assert.equal(cargado.version, 10);
  assert.deepEqual(paramsOf(cargado), parseParams('agua.cuencas=0.8'), 'nada se inyecta ni se revierte al migrar');
  assert.deepEqual(adoptadas(paramsOf(cargado)), NUEVAS);
});

/** Réplica de laboratorio (Store temporal guardado ANTES del primer paso, como `scripts/lab/replica.ts`). */
function replica(t: { after(callback: () => void): void }, seed: number, pasos: number): World {
  const { store } = laboratorio(t);
  const world = createWorld(seed);
  store.save(world);
  for (let n = 0; n < pasos; n++) stepWorld(world);
  return world;
}

test('con los defaults de reglas 10 la semilla 7 pare en 3 días y el mundo sigue siendo determinista', { timeout: 1_800_000 }, t => {
  // Con los params históricos la semilla 7 tiene 0 nacimientos a 3 días: lo afirma
  // `tests/leyes-candidatas.test.ts` (viii) sobre `HISTORICAL_PARAMS`.
  const pasos = 3 * TICKS_PER_DAY;
  const a = replica(t, 7, pasos), b = replica(t, 7, pasos);
  assert.strictEqual(paramsOf(a), DEFAULT_PARAMS);
  assert.ok(a.birthCounter > 0, `la semilla 7 sigue sin parir con los defaults nuevos: ${a.birthCounter}`);
  assert.equal(digestoCanonico(a), digestoCanonico(b), 'dos corridas, mismo digesto');
  assert.equal(a.birthCounter, b.birthCounter);
  t.diagnostic(JSON.stringify({ seed: 7, pasos, nacimientos: a.birthCounter, poblacion: a.people.length, digesto: digestoCanonico(a) }));
});
