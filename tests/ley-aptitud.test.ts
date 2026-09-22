import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { createWorld, stepWorld, ventajaComparativa, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { indiceDiversidad } from '../src/world/diversidad.js';
import { DEFAULT_PARAMS, PARAM_RANGES, paramsOf, parseParams, setParams, type WorldParams } from '../src/world/params.js';
import type { Action } from '../src/shared/types.js';

/**
 * Ley candidata DIV (2026-09-22): ventaja comparativa heredable, `conducta.aptitud`.
 * Síntoma: el índice SC-003 se queda en 0,3–0,5 y el oficio dominante converge a cooperar/
 * investigar; la habituación sube la riqueza de oficios pero hace generalistas a todos (la
 * distancia media entre repertorios BAJA, test (ii) de `leyes-candidatas.test.ts`). La ley suma a
 * cada OFICIO `aptitud · (rasgo del oficio − media de los cinco rasgos de la persona)`.
 *
 * Réplica como la de `scripts/lab/replica.ts`: Store temporal guardado ANTES del primer paso.
 */
function replica(t: { after(callback: () => void): void }, pasos: number, params?: string, seed = 51926): World {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-aptitud-'));
  const store = new Store(join(directory, 'world.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const world = createWorld(seed, parseParams(params));
  store.save(world);
  for (let tick = 1; tick <= pasos; tick++) stepWorld(world);
  return world;
}

/** Digesto del mundo medido con la FORMA de params del padre (`f666226`, sin `conducta.aptitud`).
 * `digestoCanonico` hashea `{world, params}`: declarar la clave mueve el hash completo aunque el
 * estado físico sea idéntico, así que el control la quita antes de hashear. */
function digestoSinAptitud(world: World): string {
  const vigentes = paramsOf(world);
  const comoPadre = structuredClone(vigentes) as unknown as { conducta: Record<string, unknown> };
  delete comoPadre.conducta.aptitud;
  setParams(world, comoPadre as unknown as WorldParams);
  try { return digestoCanonico(world); } finally { setParams(world, vigentes); }
}

// Medidos en el padre `f666226` (sprint/noche-integra) con esta misma réplica, ANTES de tocar nada.
const PADRE_DEFECTO_1200 = 'd7e173a1f4610463929ed8128f2006a04833a477b6712800585e070edc95a9d9';
const CARRIL = 'persistencia.cadaTicks=300,poblacion.cortejo=1,poblacion.exigeComunidad=false,poblacion.comprobacionContinua=true,conducta.habituacion=0.35';
const PADRE_CARRIL_SEMILLA7_1200 = '47e0d5111877ceb77ad532a1542d03d7c17a0a50e347ab01d8345b8976f01dae';

test('(i) con aptitud=0 el mundo es bit a bit el del padre, con defaults y con los params del carril', { timeout: 2_800_000 }, t => {
  assert.equal(DEFAULT_PARAMS.conducta.aptitud, 0);
  const defecto = replica(t, 1200);
  assert.equal(digestoSinAptitud(defecto), PADRE_DEFECTO_1200, 'semilla 51926, 1200 pasos, defaults: el estado físico no se movió');
  assert.notEqual(digestoCanonico(defecto), PADRE_DEFECTO_1200, 'el digesto completo sí cambia, sólo por declarar la clave (T102)');
  const carril = replica(t, 1200, CARRIL, 7);
  assert.equal(digestoSinAptitud(carril), PADRE_CARRIL_SEMILLA7_1200, 'semilla 7 con los params del carril y habituación 0,35: idéntico');
});

const OFICIO_DE: Record<string, Action> = { curiosity: 'explore', sociability: 'cooperate', industriousness: 'gather', care: 'share', resilience: 'hunt' };

test('(ii) ventajaComparativa: rasgo del oficio menos la media propia, suma cero, nada fuera de los oficios', () => {
  const traits = { curiosity: 0.9, sociability: 0.1, industriousness: 0.5, care: 0.5, resilience: 0.5 };
  for (const action of ['explore', 'research', 'invent'] as const) assert.ok(Math.abs(ventajaComparativa(traits, action) - 0.4) < 1e-12, action);
  assert.ok(Math.abs(ventajaComparativa(traits, 'cooperate') + 0.4) < 1e-12);
  for (const action of ['gather', 'farm', 'build', 'repair', 'craft', 'share', 'hunt'] as const) assert.ok(Math.abs(ventajaComparativa(traits, action)) < 1e-12, action);
  // Comer, beber, descansar, los actos de vínculo y la provisión para una crianza no son oficios:
  // la ley no los toca nunca, ni siquiera con rasgos muy desiguales.
  for (const action of ['eat', 'drink', 'rest', 'approach', 'accompany', 'retreat', 'forage'] as const) {
    assert.equal(ventajaComparativa(traits, action), 0, action);
    assert.equal(ventajaComparativa({ curiosity: 0.05, sociability: 0.95, industriousness: 0.05, care: 0.95, resilience: 0.95 }, action), 0, action);
  }
  // Suma cero sobre los cinco rasgos: ser bueno en todo no da ventaja; sólo ordena los oficios.
  const desigual = { curiosity: 0.93, sociability: 0.27, industriousness: 0.61, care: 0.12, resilience: 0.78 };
  const suma = Object.values(OFICIO_DE).reduce((total, action) => total + ventajaComparativa(desigual, action), 0);
  assert.ok(Math.abs(suma) < 1e-12, `suma ${suma}`);
  const plano = { curiosity: 0.7, sociability: 0.7, industriousness: 0.7, care: 0.7, resilience: 0.7 };
  for (const action of Object.values(OFICIO_DE)) assert.ok(Math.abs(ventajaComparativa(plano, action)) < 1e-12, `${action} con rasgos planos`);
});

test('(iii) parseParams acota conducta.aptitud en [0, 2] y una instantánea sin la clave la completa con 0', t => {
  assert.deepEqual(PARAM_RANGES['conducta.aptitud'], [0, 2]);
  assert.throws(() => parseParams('conducta.aptitud=-0.05'), /rango/i);
  assert.throws(() => parseParams('conducta.aptitud=2.05'), /rango/i);
  assert.throws(() => parseParams('conducta.aptitud=mucho'), /num[ée]ric/i);
  assert.equal(parseParams('conducta.aptitud=2').conducta.aptitud, 2);
  assert.equal(parseParams('conducta.habituacion=0.35').conducta.aptitud, 0, 'mover otra clave de conducta no mueve ésta');

  const directory = mkdtempSync(join(tmpdir(), 'atlas-aptitud-snapshot-'));
  const path = join(directory, 'world.sqlite'), store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.save(createWorld(51926, parseParams('conducta.habituacion=0.35,conducta.aptitud=1.5')));
  const saved = JSON.parse((store.db.prepare('SELECT body FROM snapshots WHERE slot=0').get() as { body: string }).body);
  assert.equal(saved.params.conducta.aptitud, 1.5, 'la clave viaja en la instantánea como cualquier otra');
  delete saved.params.conducta.aptitud; // Instantánea escrita antes de esta ley.
  const body = JSON.stringify(saved);
  store.db.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=0').run(body, createHash('sha256').update(body).digest('hex'));
  const reopened = new Store(path);
  t.after(() => reopened.close());
  const vigentes = paramsOf(reopened.load()!.world);
  assert.equal(vigentes.conducta.aptitud, 0, 'sin campo rige el comportamiento de siempre');
  assert.equal(vigentes.conducta.habituacion, 0.35, 'y lo demás de la instantánea sobrevive');
});

/** Fracción vitalicia de `activity` que cae en los oficios de cada rasgo. */
function reparto(world: World) {
  const filas = [];
  for (const person of world.people) {
    const total = Object.values(person.activity).reduce((sum, n) => sum + n, 0);
    if (total < 20) continue; // Recién nacidos: aún no hay repertorio que medir.
    const porRasgo: Record<string, number> = {};
    for (const [action, n] of Object.entries(person.activity)) {
      const rasgo = Object.keys(OFICIO_DE).find(r => ventajaComparativa({ curiosity: 0, sociability: 0, industriousness: 0, care: 0, resilience: 0, [r]: 1 }, action as Action) > 0);
      if (rasgo) porRasgo[rasgo] = (porRasgo[rasgo] ?? 0) + n / total;
    }
    filas.push({ person, porRasgo });
  }
  return filas;
}

test('(iv) con aptitud=2 la elección cambia: cada cual se inclina a los oficios de su rasgo relativo más fuerte', { timeout: 2_800_000 }, t => {
  const hoy = replica(t, 2400), abierto = replica(t, 2400, 'conducta.aptitud=2');
  assert.notEqual(digestoSinAptitud(abierto), digestoSinAptitud(hoy), 'con 2 la ley sí elige distinto');
  // ¿El oficio de la ventaja comparativa ocupa más de la vida de quien la tiene que de quien no?
  // Para cada rasgo, fracción media de actividad en sus oficios entre quienes tienen ese rasgo
  // por ENCIMA de su media propia frente a quienes lo tienen por debajo. Con la ley abierta la
  // brecha tiene que crecer en la mayoría de los cinco rasgos.
  const brecha = (world: World, rasgo: string) => {
    const filas = reparto(world), accion = OFICIO_DE[rasgo]!;
    const arriba = filas.filter(f => ventajaComparativa(f.person.traits, accion) > 0), abajo = filas.filter(f => ventajaComparativa(f.person.traits, accion) < 0);
    const media = (grupo: typeof filas) => grupo.length ? grupo.reduce((sum, f) => sum + (f.porRasgo[rasgo] ?? 0), 0) / grupo.length : 0;
    return media(arriba) - media(abajo);
  };
  const rasgos = Object.keys(OFICIO_DE);
  const antes = rasgos.map(r => brecha(hoy, r)), despues = rasgos.map(r => brecha(abierto, r));
  t.diagnostic(`brechas por rasgo (${rasgos.join(', ')}): hoy ${antes.map(x => x.toFixed(3)).join(' ')} · aptitud=2 ${despues.map(x => x.toFixed(3)).join(' ')}`);
  const crecen = rasgos.filter((_, i) => despues[i]! > antes[i]!).length;
  assert.ok(crecen >= 4, `sólo crece la brecha en ${crecen} de 5 rasgos`);
  const base = indiceDiversidad(hoy), con = indiceDiversidad(abierto);
  t.diagnostic(`SC-003 hoy ${JSON.stringify(base)} · aptitud=2 ${JSON.stringify(con)} · enseñanzas ${hoy.totals.teaching} → ${abierto.totals.teaching}`);
  assert.ok(con.conducta > base.conducta, `la distancia entre repertorios no sube: ${con.conducta} <= ${base.conducta}`);
});
