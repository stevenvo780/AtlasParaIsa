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
import { DEFAULT_PARAMS, HISTORICAL_PARAMS, PARAM_RANGES, paramsOf, parseParams, setParams, type WorldParams } from '../src/world/params.js';
import type { Action } from '../src/shared/types.js';

/**
 * Ley candidata DIV (2026-09-22): ventaja comparativa heredable, `conducta.aptitud`.
 * Síntoma: el índice SC-003 se queda en 0,3–0,5 y el oficio dominante converge a cooperar/
 * investigar; la habituación sube la riqueza de oficios pero hace generalistas a todos (la
 * distancia media entre repertorios BAJA, test (ii) de `leyes-candidatas.test.ts`). La ley suma a
 * cada OFICIO `aptitud · (rasgo del oficio − media de los cinco rasgos de la persona)`.
 *
 * Réplica como la de `scripts/lab/replica.ts`: Store temporal guardado ANTES del primer paso. Parte de
 * `HISTORICAL_PARAMS` explícitos (reglas 10, etapa 1): la ley se midió sobre el mundo de antes, y con
 * los defaults nuevos `CARRIL` heredaría además `poblacion.radioCortejo=128`.
 */
function replica(t: { after(callback: () => void): void }, pasos: number, params?: string, seed = 51926): World {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-aptitud-'));
  const store = new Store(join(directory, 'world.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const world = createWorld(seed, parseParams(params, HISTORICAL_PARAMS));
  store.save(world);
  for (let tick = 1; tick <= pasos; tick++) stepWorld(world);
  return world;
}

/** Digesto del mundo medido con la FORMA de params del padre (`f666226`, sin `conducta.aptitud`).
 * `digestoCanonico` hashea `{world, params}`: declarar la clave mueve el hash completo aunque el
 * estado físico sea idéntico, así que el control la quita antes de hashear. */
function digestoSinAptitud(world: World): string {
  const vigentes = paramsOf(world);
  const comoPadre = structuredClone(vigentes) as unknown as { conducta: Record<string, unknown>; social: Record<string, unknown> };
  delete comoPadre.conducta.aptitud;
  // Fusión CONFL (`sprint/noche-lab60c-20260922`): `social.memoriaDisputa` no existía en f2757fa, donde se
  // midieron los hashes; con su valor 0 no actúa, así que también se quita de la forma.
  assert.equal(comoPadre.social.memoriaDisputa, 0);
  delete comoPadre.social.memoriaDisputa;
  assert.equal(comoPadre.social.hogarTrabajo, 0);
  delete comoPadre.social.hogarTrabajo;
  // Campaña C8 (H-A, `conducta.vocacion`/`vocacionTope`): claves posteriores a la medida; con ε = 0 no actúan.
  { const c = (comoPadre as unknown as { conducta: Record<string, unknown> }).conducta; assert.equal(c.vocacion, 0); assert.equal(c.vocacionTope, 0.9); delete c.vocacion; delete c.vocacionTope; }
  setParams(world, comoPadre as unknown as WorldParams);
  const version = world.version;
  // La referencia V10 mide este mismo estado; sólo normalizamos su etiqueta al hashear.
  world.version = 10;
  try { return digestoCanonico(world); } finally { world.version = version; setParams(world, vigentes); }
}

// Los hashes originales se midieron en el padre `f666226` (sprint/noche-integra), ANTES de la consolidación
// R2; allí la forma de params y la etiqueta V10 (alias de fundación) aún no existían, así que dejaron de
// corresponder en la propia base f2757fa (d7e173a1… y 47e0d511… fallaban ya allí). Regenerados el
// 2026-09-22 (reglas 10, etapa 1) DESDE UNA EXPORTACIÓN LIMPIA de la base f2757fa, nunca desde el árbol
// modificado, con la misma réplica (Store temporal, guardado antes del primer paso), campo `fisico`:
//   git archive f2757fa | tar -x -C /tmp/base-f2757fa && ln -s "$PWD/node_modules" /tmp/base-f2757fa/node_modules \
//     && cp scripts/lab/digesto-control.ts /tmp/base-f2757fa/scripts/lab/ && cd /tmp/base-f2757fa \
//     && npx tsx scripts/lab/digesto-control.ts --seed 51926 --pasos 1200 --sin conducta.aptitud \
//     && npx tsx scripts/lab/digesto-control.ts --seed 7 --pasos 1200 --params "$CARRIL" --sin conducta.aptitud
// (en f2757fa `DEFAULT_PARAMS` es exactamente `HISTORICAL_PARAMS`).
const PADRE_DEFECTO_1200 = '599f30e4dba17c1f46615d870496311a43dfd8ae8d6f5ae2558a2d17a58ae541';
const CARRIL = 'persistencia.cadaTicks=300,poblacion.cortejo=1,poblacion.exigeComunidad=false,poblacion.comprobacionContinua=true,conducta.habituacion=0.35';
const PADRE_CARRIL_SEMILLA7_1200 = '51595624213966fae231495c8a62b3c05d5eee894a0db65d28950a7e164de87d';

test('(i) con aptitud=0 el mundo es bit a bit el de antes, con params históricos y con los params del carril', { timeout: 2_800_000 }, t => {
  assert.equal(DEFAULT_PARAMS.conducta.aptitud, 0, 'reglas 10 no adopta la aptitud');
  assert.equal(HISTORICAL_PARAMS.conducta.aptitud, 0);
  const defecto = replica(t, 1200);
  assert.equal(digestoSinAptitud(defecto), PADRE_DEFECTO_1200, 'semilla 51926, 1200 pasos, params históricos: el estado físico no se movió');
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
  // Medido (semilla 51926, 2400 pasos, defaults frente a aptitud=2): alineación 0,250 → 0,487;
  // SC-003 0,351 → 0,533 (conducta 0,427 → 0,631, oficios 0,274 → 0,435); enseñanzas 49 → 10.
  // Alineación: fracción media de la vida de cada cual que cae en los oficios de SU rasgo de mayor
  // ventaja comparativa. Brecha por rasgo: fracción en los oficios de ese rasgo entre quienes lo
  // tienen por encima de su media propia menos la de quienes lo tienen por debajo.
  const alineacion = (world: World) => {
    const filas = reparto(world);
    return filas.reduce((sum, f) => {
      const propio = Object.keys(OFICIO_DE).reduce((mejor, r) => ventajaComparativa(f.person.traits, OFICIO_DE[r]!) > ventajaComparativa(f.person.traits, OFICIO_DE[mejor]!) ? r : mejor);
      return sum + (f.porRasgo[propio] ?? 0);
    }, 0) / Math.max(1, filas.length);
  };
  const brecha = (world: World, rasgo: string) => {
    const filas = reparto(world), accion = OFICIO_DE[rasgo]!;
    const arriba = filas.filter(f => ventajaComparativa(f.person.traits, accion) > 0), abajo = filas.filter(f => ventajaComparativa(f.person.traits, accion) < 0);
    const media = (grupo: typeof filas) => grupo.length ? grupo.reduce((sum, f) => sum + (f.porRasgo[rasgo] ?? 0), 0) / grupo.length : 0;
    return media(arriba) - media(abajo);
  };
  const rasgos = Object.keys(OFICIO_DE);
  const antes = rasgos.map(r => brecha(hoy, r)), despues = rasgos.map(r => brecha(abierto, r));
  const base = indiceDiversidad(hoy), con = indiceDiversidad(abierto);
  t.diagnostic(`alineación hoy ${alineacion(hoy).toFixed(3)} · aptitud=2 ${alineacion(abierto).toFixed(3)}`);
  t.diagnostic(`brechas por rasgo (${rasgos.join(', ')}): hoy ${antes.map(x => x.toFixed(3)).join(' ')} · aptitud=2 ${despues.map(x => x.toFixed(3)).join(' ')}`);
  t.diagnostic(`SC-003 hoy ${JSON.stringify(base)} · aptitud=2 ${JSON.stringify(con)} · enseñanzas ${hoy.totals.teaching} → ${abierto.totals.teaching}`);
  assert.ok(alineacion(abierto) > alineacion(hoy), 'la vida de cada cual no se inclina más hacia los oficios de su ventaja');
  // Explorar/investigar y recolectar/fabricar son los oficios que ocurren a diario en 2400 pasos:
  // ahí la brecha tiene que crecer. Cazar no ocurre aún, y compartir exige un lugar y alguien con
  // hambre a ≤ 2 celdas: sus brechas se informan, no se exigen.
  for (const rasgo of ['curiosity', 'industriousness']) {
    const i = rasgos.indexOf(rasgo);
    assert.ok(despues[i]! > antes[i]!, `la brecha de ${rasgo} no crece: ${antes[i]} → ${despues[i]}`);
  }
  assert.ok(con.conducta > base.conducta, `la distancia entre repertorios no sube: ${con.conducta} <= ${base.conducta}`);
});
