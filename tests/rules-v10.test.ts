import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.js';
import { cloneWorld, createWorld, RULES_VERSION, stepWorld, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { HISTORICAL_PARAMS, parseParams, paramsOf } from '../src/world/params.js';
import { type ConLimpieza, laboratorio } from './lib/store.js';

/** Reglas 10, etapa 1 (2026-09-22): un mundo V9 es un mundo de antes, así que estas pruebas lo crean
 * con `HISTORICAL_PARAMS` explícitos; los defaults de un mundo NUEVO adoptan el paquete de natalidad. */

const laboratory = (t: ConLimpieza) => laboratorio(t, 'atlas-reglas10-');

test('un mundo V9 guardado por Store se recarga como V11 conservando todo salvo la versión', t => {
  // Control: el MISMO mundo guardado y recargado como V11. El Store archiva terreno dormido y
  // sella diarios al guardar, así que la comparación justa es contra ese viaje de ida y vuelta.
  const legacy = laboratory(t), control = laboratory(t);
  const world = createWorld(51926, HISTORICAL_PARAMS);
  for (let n = 0; n < 120; n++) stepWorld(world);
  const current = cloneWorld(world);
  world.version = 9;
  legacy.store.save(world); control.store.save(current);
  legacy.store.close(); control.store.close();
  const reopened = new Store(legacy.path), reference = new Store(control.path);
  try {
    const loaded = reopened.load()!.world, expected = reference.load()!.world;
    assert.equal(RULES_VERSION, 11);
    assert.equal(loaded.version, 11);
    assert.equal(JSON.stringify(loaded), JSON.stringify(expected));
    assert.deepEqual(paramsOf(loaded), paramsOf(expected));
    stepWorld(loaded); reopened.save(loaded);
  } finally { reopened.close(); reference.close(); }
});

test('un mundo V10 cargado migra a V11 con el mismo digesto de estado salvo version y los params persistidos intactos', t => {
  const legacy = laboratory(t), control = laboratory(t);
  const persisted = parseParams('agua.cuencas=0.8,social.disputaNecesidad=0.45,social.disputaEscasez=3,social.disputaRadio=3,social.memoriaDisputa=8', HISTORICAL_PARAMS);
  const world = createWorld(404, persisted);
  for (let n = 0; n < 120; n++) stepWorld(world);
  const current = cloneWorld(world);
  world.version = 10;
  legacy.store.save(world); control.store.save(current);
  legacy.store.close(); control.store.close();
  const reopened = new Store(legacy.path), reference = new Store(control.path);
  try {
    const loaded = reopened.load()!.world, expected = reference.load()!.world;
    assert.equal(loaded.version, 11);
    assert.deepEqual(loaded, expected);
    assert.deepEqual(paramsOf(loaded), persisted);
    assert.deepEqual(paramsOf(expected), persisted);
    const normalized = cloneWorld(loaded); normalized.version = 10;
    const referenceV10 = cloneWorld(expected); referenceV10.version = 10;
    assert.equal(digestoCanonico(normalized), digestoCanonico(referenceV10));
  } finally { reopened.close(); reference.close(); }
});

for (const params of ['poblacion.comprobacionContinua=true', undefined]) test(`V11 conserva la corrección V10: los actores de fundación no cambian (${params ?? 'leyes históricas'})`, { timeout: 900000 }, t => {
  // Semilla 42: funda comunidades y pare dentro de 400 pasos; con comprobación continua el
  // nacimiento caía después de archivar el evento y `Store.save` abortaba (defecto de alias).
  const { store } = laboratory(t);
  const world: World = createWorld(42, parseParams(params, HISTORICAL_PARAMS));
  assert.equal(world.version, 11);
  const founding = new Map<string, string[]>();
  const record = (): void => { for (const event of world.events) if (event.kind === 'community' && !founding.has(event.id)) founding.set(event.id, [...event.actors]); };
  store.save(world);
  for (let tick = 1; tick <= 400; tick++) {
    stepWorld(world); record();
    assert.doesNotThrow(() => store.save(world));
  }
  assert.ok(world.birthCounter > 0, 'la semilla 42 tiene que parir dentro de los 400 pasos');
  assert.ok(founding.size > 0, 'la semilla 42 tiene que fundar al menos una comunidad');
  for (const event of world.events) if (event.kind === 'community') assert.deepEqual(event.actors, founding.get(event.id), `${event.id} cambió sus actores`);
  const grown = world.communities.some(group => group.members.some(id => id.startsWith('descendant-')));
  assert.ok(grown, 'alguna cría tiene que figurar en el censo de su comunidad');
  for (const group of world.communities) for (const event of world.events) if (event.kind === 'community') assert.notEqual(event.actors, group.members);
});

/** El mundo sin la etiqueta de versión ni los actores de los eventos de fundación. */
function sinAliasDeFundacion(world: World): string {
  return JSON.stringify(world, function (this: unknown, key, value: unknown) {
    if (key === 'version' && this === world) return undefined;
    if (key === 'actors' && (this as { kind?: unknown }).kind === 'community') return undefined;
    return value;
  });
}
/** Réplica de laboratorio (Store temporal, guardado antes del primer paso) con la etiqueta dada. */
function replica(t: { after(callback: () => void): void }, version: number, pasos: number): World {
  const { store } = laboratory(t);
  const world = createWorld(51926, HISTORICAL_PARAMS); world.version = version;
  store.save(world);
  for (let n = 0; n < pasos; n++) stepWorld(world);
  return world;
}

test('V11 recorre la misma trayectoria histórica que V9 salvo la etiqueta y los actores de fundación', { timeout: 900000 }, t => {
  // Medido (semilla 51926, 1200 pasos): sólo cambian `version` y un evento de fundación que en
  // V9 creció después con `neighbor-9` (se unió por el camino de unión, no por nacimiento).
  const v9 = replica(t, 9, 1200), v11 = replica(t, 11, 1200);
  assert.equal(v9.version, 9); assert.equal(v11.version, 11);
  assert.equal(sinAliasDeFundacion(v11), sinAliasDeFundacion(v9));
  const fundaciones = (w: World) => [...w.events, ...(w.chronicleJournal?.pending ?? [])].filter(e => e.kind === 'community');
  const viejas = new Map(fundaciones(v9).map(e => [e.id, e.actors]));
  assert.ok(viejas.size > 0);
  for (const evento of fundaciones(v11)) {
    const vieja = viejas.get(evento.id)!;
    assert.deepEqual(vieja.slice(0, evento.actors.length), evento.actors, `${evento.id}: V11 guarda el prefijo fundador`);
  }
});
