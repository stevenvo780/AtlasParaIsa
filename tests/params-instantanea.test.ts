import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';
import { encodeSnapshot } from '../src/server/snapshot.js';
import { cloneWorld, createWorld, type World } from '../src/world/index.js';
import { DEFAULT_PARAMS, HISTORICAL_PARAMS, paramsOf, parseParams, setParams } from '../src/world/params.js';
import { deploymentParams } from '../src/server/deployment-params.js';

/** R8: los `WorldParams` viven en un WeakMap por instancia, así que un mundo recargado
 * desde JSON los perdía y volvía a los defaults. Ahora viajan en la instantánea. */
const digest = (body: string) => createHash('sha256').update(body).digest('hex');
function laboratory(t: { after(callback: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-params-test-'));
  const path = join(directory, 'world.sqlite'), store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, path, directory };
}
const row = (store: Store) => store.db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get() as { body: string; digest: string };
const rewrite = (store: Store, body: string) => store.db.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=0').run(body, digest(body));

test('los parámetros del mundo viajan en la instantánea y mandan al recargar', t => {
  const { store, path } = laboratory(t);
  const params = parseParams('agua.cuencas=0.8,poblacion.maxima=50');
  const world = createWorld(51926, params);
  store.save(world);
  const saved = row(store);
  assert.deepEqual(JSON.parse(saved.body).params, params, 'la instantánea declara los params vigentes');

  const reopened = new Store(path);
  try {
    const loaded = reopened.load()!.world;
    assert.deepEqual(paramsOf(loaded), params, 'un mundo recargado conserva sus params, no los defaults');
    assert.equal(paramsOf(loaded).agua.cuencas, 0.8);
    assert.equal(paramsOf(loaded).poblacion.maxima, 50);
    // Guardar lo recargado reproduce el mismo cuerpo: los params no introducen deriva.
    reopened.save(loaded);
    assert.equal(row(reopened).digest, saved.digest, 'el dígeste sobrevive a la ida y vuelta');
  } finally { reopened.close(); }
});

test('los defaults actuales son explícitos y una instantánea legacy sin params recibe el modo histórico', t => {
  const { store, path } = laboratory(t);
  const world = createWorld(51926);
  store.save(world);
  const saved = row(store);
  assert.deepEqual(JSON.parse(saved.body).params, DEFAULT_PARAMS, 'el modo actual se declara incluso con defaults');
  assert.equal(encodeSnapshot(world, DEFAULT_PARAMS), encodeSnapshot(world));

  // Migración: una instantánea escrita antes de esta ley no declara params.
  const antigua = JSON.parse(saved.body) as Record<string, unknown>;
  delete antigua.params; delete antigua.paramsEncoding; delete antigua.limitsProfile;
  rewrite(store, JSON.stringify(antigua));
  const reopened = new Store(path);
  // Reglas 10, etapa 1: sin campo rigen los params HISTÓRICOS, no los defaults de un mundo nuevo.
  try { assert.deepEqual(paramsOf(reopened.load()!.world), parseParams('limites.aplicacion=historicos', HISTORICAL_PARAMS), 'sin campo, se conservan números y se declara su aplicación histórica'); }
  finally { reopened.close(); }
});

test('unos parámetros fuera de rango en la instantánea fallan cerrado en vez de colarse en el mundo', t => {
  const { store } = laboratory(t);
  const world = createWorld(51926, parseParams('agua.cuencas=0.8'));
  store.save(world);
  const cuerpo = JSON.parse(row(store).body) as Record<string, unknown>;
  const params = structuredClone(cuerpo.params) as { agua: { cuencas: number } };
  params.agua.cuencas = 9;
  rewrite(store, JSON.stringify({ ...cuerpo, params }));
  assert.throws(() => store.load(), /Invalid snapshot parameters/, 'un dígeste recalculado no legitima un parámetro imposible');

  const desconocido = JSON.stringify({ ...cuerpo, params: { ...(cuerpo.params as object), inventado: { clave: 1 } } });
  rewrite(store, desconocido);
  assert.throws(() => store.load(), /Invalid snapshot parameters/);
});

test('createApp genera el mundo nuevo con los parámetros recibidos y respeta los de la instantánea al recargar', async t => {
  const { store, path } = laboratory(t);
  const params = parseParams('agua.cuencas=1');
  const app = createApp({ store, password: 'synthetic-test-password-only', origin: 'http://127.0.0.1:3000', manual: true, seed: 42, params });
  t.after(async () => { await app.close(); });
  const conAgua = (world: World) => world.tiles.filter(tile => (tile.drinkingWater ?? 0) > 0).length;
  assert.deepEqual(paramsOf(app.world), params, 'los params llegan antes de que createApp genere el mundo');
  assert.equal(conAgua(app.world), conAgua(createWorld(42, params)));
  assert.notEqual(conAgua(app.world), conAgua(createWorld(42)), 'el terreno se generó con los params pedidos, no con los defaults');

  // Al recargar, los params de la instantánea mandan sobre los de createApp…
  const reopened = new Store(path);
  t.after(() => reopened.close());
  const otros = parseParams('agua.cuencas=0.2');
  const resumed = createApp({ store: reopened, password: 'synthetic-test-password-only', origin: 'http://127.0.0.1:3000', manual: true, seed: 42, params: otros });
  t.after(async () => { await resumed.close(); });
  assert.deepEqual(paramsOf(resumed.world), params, 'un mundo cargado conserva los params con los que se generó');
  // …y la configuración explícita del despliegue se aplica ENCIMA, clave a clave, con la
  // receta literal de `main.ts`: no reemplaza el objeto entero (eso borraría la instantánea).
  setParams(resumed.world, deploymentParams(paramsOf(resumed.world), 'agua.cuencas=0.2'));
  assert.equal(paramsOf(resumed.world).agua.cuencas, 0.2, 'CARTA_PARAMS manda sobre lo que nombra');
  assert.equal(paramsOf(resumed.world).persistencia.cadaTicks, 100, 'la cadencia de producción también');
});

/** Ronda de corrección R2: `setParams(app.world, parseParams(CARTA_PARAMS))` reemplazaba el
 * objeto ENTERO por «defaults + CARTA_PARAMS», así que en el único camino de despliegue real
 * los params de la instantánea se borraban siempre y R8 quedaba inerte. La precedencia que
 * publica docs/REGLAS.md §Parámetros tiene que ser cierta, no una intención. */
test('la receta del despliegue conserva del mundo cargado toda clave que no nombre', t => {
  const { store, path } = laboratory(t);
  const generados = parseParams('agua.cuencas=1,poblacion.maxima=50');
  store.save(createWorld(51926, generados));

  const reopened = new Store(path);
  t.after(() => reopened.close());
  const app = createApp({ store: reopened, password: 'synthetic-test-password-only', origin: 'http://127.0.0.1:3000', manual: true, seed: 51926, params: deploymentParams() });
  t.after(async () => { await app.close(); });
  // Exactamente lo que corre en producción sin CARTA_PARAMS.
  setParams(app.world, deploymentParams(paramsOf(app.world), undefined));
  const vigentes = paramsOf(app.world);
  assert.equal(vigentes.agua.cuencas, 1, 'el terreno se generó con este régimen: reabrirlo no puede cambiarlo');
  assert.equal(vigentes.poblacion.maxima, 50, 'ni el techo con el que venía');
  assert.equal(vigentes.persistencia.cadaTicks, 100, 'y la cadencia del despliegue sí se impone');
  assert.equal(vigentes.persistencia.ventanaEventosTicks, 24000);
  assert.notDeepEqual(vigentes, DEFAULT_PARAMS);
});

test('parseParams sobre una base aplica los overrides encima de ella, no encima de los defaults', () => {
  const base = parseParams('agua.cuencas=1,poblacion.maxima=50');
  assert.equal(parseParams(undefined, base), base, 'sin overrides la base pasa tal cual');
  const encima = parseParams('poblacion.maxima=7', base);
  assert.equal(encima.poblacion.maxima, 7);
  assert.equal(encima.agua.cuencas, 1, 'lo que el override no nombra sobrevive');
  assert.equal(encima.cuerpo.longevidadBaseDias, DEFAULT_PARAMS.cuerpo.longevidadBaseDias);
  assert.throws(() => parseParams('agua.cuencas=9', base), /fuera de rango/, 'la base no relaja la validación');
  assert.deepEqual(parseParams('poblacion.maxima=7'), parseParams('poblacion.maxima=7', DEFAULT_PARAMS), 'la base por defecto es DEFAULT_PARAMS');
});

test('T102: parámetros tipados sobreviven a guardado, reinicio, clon y overrides del despliegue', t => {
  const { store, path } = laboratory(t);
  const params = parseParams('agua.cuencas=0.8,motor.hilos=8,motor.gpu=[1,0],motor.clonPorPaso=false,motor.orden=inverso,persistencia.paginasSucias=true,red.deltas=true');
  store.save(createWorld(51926, params));
  const saved = row(store), reopened = new Store(path);
  try {
    const loaded = reopened.load()!.world, effective = paramsOf(loaded);
    assert.deepEqual(effective, params);
    assert.ok(Object.isFrozen(effective.motor.gpu)); assert.ok(Object.isFrozen(effective.gobernador.senales));
    assert.equal(paramsOf(cloneWorld(loaded)), effective);
    reopened.save(loaded);
    assert.equal(row(reopened).body, saved.body, 'roundtrip tipado conserva los bytes');
    const overridden = deploymentParams(effective, 'motor.hilos=16,motor.gpu=[]');
    assert.equal(overridden.motor.hilos, 16); assert.deepEqual(overridden.motor.gpu, []);
    assert.deepEqual(effective.motor.gpu, [1, 0]); assert.equal(overridden.agua.cuencas, 0.8);
    assert.equal(overridden.motor.clonPorPaso, false); assert.equal(overridden.persistencia.cadaTicks, 100);
  } finally { reopened.close(); }
});

test('T102: snapshot params-v1 anterior completa sólo los campos nuevos con defaults', t => {
  const { store, path } = laboratory(t);
  const params = parseParams('agua.cuencas=0.8,persistencia.cadaTicks=20');
  store.save(createWorld(51926, params));
  const saved = JSON.parse(row(store).body);
  delete saved.limitsProfile;
  for (const key of ['motor', 'red', 'limites']) delete saved.params[key];
  delete saved.params.persistencia.paginasSucias; delete saved.params.gobernador.senales;
  rewrite(store, JSON.stringify(saved));
  const reopened = new Store(path);
  try {
    const loaded = reopened.load()!.world;
    assert.deepEqual(paramsOf(loaded), parseParams('limites.aplicacion=historicos', params));
    reopened.save(loaded);
    const expanded = JSON.parse(row(reopened).body).params;
    assert.equal(expanded.agua.cuencas, 0.8); assert.equal(expanded.persistencia.cadaTicks, 20);
    assert.deepEqual(expanded.motor, DEFAULT_PARAMS.motor);
  } finally { reopened.close(); }
});

test('T102: checksum recalculado no legitima flags, arrays o señales corruptos del snapshot', t => {
  const { store } = laboratory(t);
  store.save(createWorld(51926, parseParams('motor.hilos=8')));
  const saved = JSON.parse(row(store).body);
  for (const [section, key, value] of [
    ['motor', 'hilos', 1.5], ['motor', 'clonPorPaso', 1], ['motor', 'gpu', [0, 0]],
    ['motor', 'gpu', ['0']], ['motor', 'gpu', [null]], ['motor', 'orden', 'azar'],
    ['gobernador', 'senales', []], ['gobernador', 'senales', ['rss']], ['limites', 'fauna', -1],
  ] as const) {
    const corrupted = structuredClone(saved); corrupted.params[section][key] = value;
    rewrite(store, JSON.stringify(corrupted));
    assert.throws(() => store.load(), /Invalid snapshot parameters/, `${section}.${key}`);
  }
});
