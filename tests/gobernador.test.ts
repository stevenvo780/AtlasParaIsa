/**
 * Ruling R17 (2026-09-19): «el límite de población lo pone el hardware, no el software».
 * Ya no hay tope fijo de habitantes; quien frena el crecimiento es el gobernador, que mira
 * el p95 del paso contra `gobernador.presupuestoMs` y apaga/enciende `reproductionEnabled`.
 * Se comprueban la ventana reciente, la histéresis y el lazo real con SQLite. El reloj
 * local permite repetir carga/recuperación sin cambiar presupuestos ni timers globales;
 * una prueba separada comprueba también latencia real de guardado.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { createApp, decideReproduction } from '../src/server/app.js';
import { GOVERNOR_WINDOW_STEPS, RollingStepPerformance } from '../src/server/governor.js';
import { parseParams, DEFAULT_PARAMS, PARAM_RANGES } from '../src/world/params.js';
import { POPULATION_HARD_LIMIT } from '../src/world/index.js';

const password = 'synthetic-test-password-only';

/** Servidor en modo manual: los pasos los da la prueba, no un temporizador. */
function fixture(t: { after: (f: () => unknown) => void }, presupuestoMs: number,
  { slowMs = 0, deterministic = false, cadaTicks = 1 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'carta-gobernador-'));
  const store = new Store(join(dir, 'world.sqlite'));
  let clock = 0;
  const app = createApp({ store, password, origin: 'http://127.0.0.1:3000', manual: true, seed: 42,
    params: parseParams(`gobernador.presupuestoMs=${presupuestoMs},persistencia.cadaTicks=${cadaTicks}`),
    ...(deterministic ? { monotonicNow: () => clock++ } : {}) });
  t.after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  // SQLite se ejecuta de verdad en ambos modos. Solo cambia cómo representa el reloj
  // el coste: latencia real, o avance local repetible dentro de la misma llamada save.
  const save = store.save.bind(store);
  let delay = slowMs;
  let saves = 0;
  store.save = ((...args: Parameters<Store['save']>) => {
    saves++;
    if (deterministic) clock += delay;
    else if (delay > 0) { const until = performance.now() + delay; while (performance.now() < until); }
    return save(...args);
  }) as Store['save'];
  return { app, store, get saves() { return saves; }, setDelay: (ms: number) => { delay = ms; } };
}

test('la decisión del gobernador apaga por encima del presupuesto, reenciende bajo el 70 % y conserva el estado en la banda muerta', () => {
  assert.equal(decideReproduction(60, 50, true), false, 'por encima del presupuesto se apaga');
  assert.equal(decideReproduction(50.001, 50, true), false);
  assert.equal(decideReproduction(20, 50, false), true, 'por debajo del 70 % se reenciende');
  assert.equal(decideReproduction(34.9, 50, false), true);
  // Banda muerta [0,7·P, P]: histéresis, para que el mundo no oscile en el filo.
  assert.equal(decideReproduction(40, 50, true), true);
  assert.equal(decideReproduction(40, 50, false), false);
  assert.equal(decideReproduction(35, 50, false), false, '0,7·P exacto sigue siendo banda muerta');
  assert.equal(decideReproduction(50, 50, true), true, 'el presupuesto exacto todavía no apaga');
});

test('el p95 descarta la carga antigua y conserva la sostenida en exactamente 120 pasos', () => {
  const recovered = new RollingStepPerformance(), loaded = new RollingStepPerformance();
  for (let n = 0; n < 1000; n++) { recovered.record(80); loaded.record(80); }
  assert.equal(recovered.count, GOVERNOR_WINDOW_STEPS);
  for (let n = 0; n < 114; n++) {
    assert.equal(recovered.record(20), 80, 'seis pasos lentos aún ocupan el p95');
    assert.equal(loaded.record(80), 80, 'la carga sostenida no desaparece por antigüedad');
  }
  assert.equal(recovered.record(20), 20, 'cinco pasos lentos quedan por encima del percentil');
  for (let n = 0; n < 5; n++) recovered.record(20);
  assert.equal(recovered.record(20), 20, 'sin lastre del historial anterior a la ventana');
  assert.equal(recovered.count, GOVERNOR_WINDOW_STEPS);
});

test('la latencia real de guardar cuenta contra el mismo presupuesto de hardware', t => {
  const f = fixture(t, 50, { slowMs: 80 });
  f.app.stepOnce();
  assert.equal(f.app.failed, false);
  assert.equal(f.saves, 1);
  assert.ok(f.app.runtime.saveMs >= 80);
  assert.ok(f.app.runtime.stepMs >= f.app.runtime.saveMs);
  assert.ok(f.app.runtime.cloneMs! > 0);
  assert.ok(f.app.runtime.simulationMs! > 0);
  assert.equal(f.app.world.reproductionEnabled, false);
});

test('el servidor recupera reproducción con presupuesto fijo al retirar la carga de guardado', t => {
  const f = fixture(t, 50, { slowMs: 80, deterministic: true });
  assert.equal(f.app.world.reproductionEnabled, true, 'el mundo nace reproduciéndose');
  for (let n = 0; n < 8; n++) f.app.stepOnce();
  const caliente = f.app.runtime.gobernador!;
  assert.ok(caliente.p95StepMs > caliente.presupuestoMs, `p95 ${caliente.p95StepMs.toFixed(1)} ms debe superar el presupuesto ${caliente.presupuestoMs} ms`);
  assert.equal(f.app.world.reproductionEnabled, false, 'el hardware, no un tope fijo, detiene los nacimientos');
  assert.equal(caliente.activo, false);
  assert.equal(caliente.manual, null);

  const pausedBirths = f.app.world.birthCounter;
  f.setDelay(10);
  for (let n = 0; n < 114; n++) {
    f.app.stepOnce();
    assert.equal(f.app.world.reproductionEnabled, false, 'la ventana conserva todavía seis muestras lentas');
  }
  f.app.stepOnce();
  const frio = f.app.runtime.gobernador!;
  assert.equal(frio.presupuestoMs, 50, 'no se eleva el presupuesto para simular recuperación');
  assert.ok(frio.p95StepMs < frio.presupuestoMs * 0.7);
  assert.equal(f.app.world.reproductionEnabled, true, 'con holgura el mundo vuelve a crecer');
  assert.equal(frio.activo, true);
  assert.equal(f.app.world.birthCounter, pausedBirths, 'recuperar el permiso no fabrica nacimientos');
  assert.equal(f.saves, 123, 'la medición ejercitó todos los guardados, incluido el de recuperación');
  assert.equal(f.app.world.tick, 123);
  assert.equal(f.app.failed, false);
});

test('una orden humana manda sobre el gobernador mientras siga puesta', t => {
  const f = fixture(t, 50, { deterministic: true });
  f.app.setReproduccionManual(false);
  f.app.stepOnce(); f.app.stepOnce();
  assert.equal(f.app.world.reproductionEnabled, false, 'con holgura de sobra, pero la orden humana manda');
  assert.equal(f.app.runtime.gobernador!.manual, false);
  f.app.setReproduccionManual(null); // devuelta al hardware
  f.app.stepOnce();
  assert.equal(f.app.world.reproductionEnabled, true);
  assert.equal(f.app.runtime.gobernador!.manual, null);
});

test('una orden humana de activar prevalece incluso bajo carga; al retirarla vuelve el freno', t => {
  const f = fixture(t, 50, { slowMs: 80, deterministic: true });
  f.app.setReproduccionManual(true);
  f.app.stepOnce();
  assert.ok(f.app.runtime.p95StepMs > 50);
  assert.equal(f.app.world.reproductionEnabled, true);
  f.app.setReproduccionManual(null);
  f.app.stepOnce();
  assert.equal(f.app.world.reproductionEnabled, false);
});

test('las métricas separan clon, simulación y guardado del paso vigente sin compartir relojes', t => {
  const slow = fixture(t, 50, { slowMs: 80, deterministic: true, cadaTicks: 2 });
  const fast = fixture(t, 50, { deterministic: true });
  slow.app.stepOnce();
  assert.equal(slow.app.runtime.saveMs, 0);
  slow.app.stepOnce();
  assert.equal(slow.app.runtime.cloneMs, 1);
  assert.equal(slow.app.runtime.simulationMs, 1);
  assert.equal(slow.app.runtime.saveMs, 81);
  assert.equal(slow.saves, 1);
  assert.equal(slow.app.world.reproductionEnabled, false);
  fast.app.stepOnce();
  assert.equal(fast.app.runtime.saveMs, 1);
  assert.equal(fast.app.world.reproductionEnabled, true, 'el otro reloj no hereda la sobrecarga');
  slow.app.stepOnce();
  assert.equal(slow.app.runtime.saveMs, 0, 'un paso sin guardar no publica el guardado anterior como actual');
  assert.equal(slow.app.runtime.stepMs, 5);
  assert.ok(slow.app.runtime.p95StepMs > 50, 'resetear la fase no borra la muestra de carga reciente');
});

test('el software ya no pone tope: `poblacion.maxima` por defecto no limita y el límite duro solo protege de snapshots corruptos', () => {
  assert.equal(POPULATION_HARD_LIMIT, 1_000_000);
  assert.equal(DEFAULT_PARAMS.poblacion.maxima, 1_000_000, 'ruling R17: el default ya no limita (antes 40)');
  assert.deepEqual(PARAM_RANGES['poblacion.maxima'], [1, 1_000_000]);
  assert.deepEqual(PARAM_RANGES['gobernador.presupuestoMs'], [5, 5000]);
  assert.equal(DEFAULT_PARAMS.gobernador.presupuestoMs, 50, 'presupuesto = constitución V (50 ms)');
  // El laboratorio sigue pudiendo acotar la población para un experimento.
  assert.equal(parseParams('poblacion.maxima=32').poblacion.maxima, 32);
  assert.throws(() => parseParams('gobernador.presupuestoMs=4'), /rango/i);
  assert.throws(() => parseParams('gobernador.presupuestoMs=5001'), /rango/i);
});

// ---------------------------------------------------------------------------------------------
// Política `techo` (revisión 2026-09-22): el mundo público V7 se extinguió porque la política
// `apagar` dejó cero nacimientos durante 15 días con un paso caro por clon + guardado de un
// mundo envejecido (docs/EVIDENCIA.md, «Mundo público V7: recambio insuficiente»). Con `techo`
// el hardware limita el crecimiento, no el reemplazo.
// ---------------------------------------------------------------------------------------------

import { decidirConTecho, ESTADO_TECHO_INICIAL, GOVERNOR_DECLINE_STEPS, Gobernador, type EstadoTecho } from '../src/server/governor.js';
import type { Person } from '../src/world/index.js';

/** Igual que `fatalThirst` en tests/muerte.test.ts: sed total y salud mínima ⇒ muerte real por deshidratación en el paso auténtico. */
function fatalThirstFor(person: Person): void { person.thirst = 1; person.demography = { ...person.demography, health: 1e-8, vitality: 0.1 }; }

test('techo: por encima del presupuesto se fija el techo en la población y solo se repone; bajo el 70 % se retira', () => {
  const rojo = decidirConTecho(60, 50, 22, ESTADO_TECHO_INICIAL);
  assert.equal(rojo.estado.techo, 22, 'el techo es la población del frenazo');
  assert.equal(rojo.reproduccion, false, 'con la población en el techo no se crece');
  const muerte = decidirConTecho(60, 50, 21, rojo.estado);
  assert.equal(muerte.estado.techo, 22, 'una muerte no baja el techo');
  assert.equal(muerte.reproduccion, true, 'por debajo del techo se repone');
  const repuesto = decidirConTecho(60, 50, 22, muerte.estado);
  assert.equal(repuesto.reproduccion, false);
  const bandaMuerta = decidirConTecho(40, 50, 22, repuesto.estado);
  assert.equal(bandaMuerta.estado.techo, 22, 'la banda muerta conserva el techo (histéresis)');
  assert.equal(bandaMuerta.estado.pasosEnRojo, 0);
  const verde = decidirConTecho(34.9, 50, 22, bandaMuerta.estado);
  assert.equal(verde.estado.techo, null, 'con holgura el techo se retira');
  assert.equal(verde.reproduccion, true);
  assert.equal(decidirConTecho(50, 50, 22, ESTADO_TECHO_INICIAL).estado.techo, null, 'el presupuesto exacto todavía no frena');
});

test('techo: un rojo grave y sostenido baja el techo una unidad por día simulado; nunca por debajo de cero ni por muertes provocadas', () => {
  assert.equal(GOVERNOR_DECLINE_STEPS, 2400, 'un día simulado a 10 Hz');
  let estado = { ...ESTADO_TECHO_INICIAL };
  for (let n = 0; n < GOVERNOR_DECLINE_STEPS - 1; n++) estado = decidirConTecho(120, 50, 30, estado).estado;
  assert.equal(estado.techo, 30, 'antes de completar el día el techo no cambia');
  estado = decidirConTecho(120, 50, 30, estado).estado;
  assert.equal(estado.techo, 29, 'p95 > 2× presupuesto durante 2400 pasos baja el techo en uno');
  for (let n = 0; n < GOVERNOR_DECLINE_STEPS; n++) estado = decidirConTecho(80, 50, 30, estado).estado;
  assert.equal(estado.techo, 29, 'un rojo leve (< 2×) no sigue bajando el techo');
  let cero: EstadoTecho = { techo: 0, pasosEnRojo: GOVERNOR_DECLINE_STEPS - 1 };
  cero = decidirConTecho(120, 50, 0, cero).estado;
  assert.equal(cero.techo, 0);
});

test('techo: la función es pura (no muta el estado recibido)', () => {
  const estado = Object.freeze({ techo: 10, pasosEnRojo: 3 });
  const r = decidirConTecho(60, 50, 9, estado);
  assert.deepEqual(estado, { techo: 10, pasosEnRojo: 3 });
  assert.deepEqual(r.estado, { techo: 10, pasosEnRojo: 4 });
});

test('Gobernador: `apagar` reproduce exactamente decideReproduction y `techo` registra el frenazo (T164) sin borrarlo al volver a verde', () => {
  const apagar = new Gobernador(), techo = new Gobernador();
  const params = (politica: 'apagar' | 'techo') => ({ presupuestoMs: 50, politica });
  assert.equal(apagar.decidir(params('apagar'), true, 22, 1120, 1), true, 'sin mediciones no se afirma nada');
  for (let n = 0; n < 8; n++) { apagar.registrar(80); techo.registrar(80); }
  assert.equal(apagar.decidir(params('apagar'), true, 22, 1120, 8), decideReproduction(80, 50, true));
  assert.equal(techo.decidir(params('techo'), true, 22, 1120, 8), false);
  assert.deepEqual(techo.estado, { techo: 22, pasosEnRojo: 1 });
  assert.ok(techo.techoObservado, 'el frenazo queda registrado');
  assert.equal(techo.techoObservado!.poblacion, 22); assert.equal(techo.techoObservado!.teselasActivas, 1120);
  assert.equal(techo.techoObservado!.tick, 8); assert.equal(techo.techoObservado!.senal, 'p95');
  assert.match(techo.techoObservado!.motivo, /frenado por p95 = 80\.0 ms > 50 ms con 22 habitantes y 1120 teselas activas/);
  assert.equal(techo.decidir(params('techo'), false, 21, 1120, 9), true, 'una muerte permite reponer');
  for (let n = 0; n < GOVERNOR_WINDOW_STEPS; n++) techo.registrar(10);
  assert.equal(techo.decidir(params('techo'), false, 21, 1120, 130), true);
  assert.equal(techo.estado.techo, null, 'en verde el techo se retira');
  assert.equal(techo.techoObservado!.tick, 8, 'el último frenazo no se borra al volver a verde');
});

test('servidor con la política por defecto (techo): bajo carga no crece, pero una muerte real se repone y el frenazo viaja en las métricas', t => {
  const f = fixture(t, 50, { slowMs: 80, deterministic: true });
  assert.equal(DEFAULT_PARAMS.gobernador.politica, 'techo');
  assert.equal(parseParams('gobernador.politica=apagar').gobernador.politica, 'apagar');
  assert.throws(() => parseParams('gobernador.politica=otra'), /valores permitidos/);
  for (let n = 0; n < 8; n++) f.app.stepOnce();
  const poblacion = f.app.world.people.length;
  const stats = f.app.runtime.gobernador!;
  assert.equal(stats.politica, 'techo');
  assert.ok(stats.p95StepMs > 50);
  assert.equal(stats.techo, poblacion, 'el techo se fija en la población del frenazo');
  assert.equal(f.app.world.reproductionEnabled, false, 'en el techo no se crece');
  assert.ok(stats.techoObservado && stats.techoObservado.poblacion === poblacion && stats.techoObservado.motivo.includes('frenado por p95'));
  // Una muerte real (deshidratación producida por el stepWorld auténtico): la población baja y se permite reponer.
  const victima = f.app.world.people.find(p => p.role === 'neighbor')!;
  fatalThirstFor(victima);
  let muerto = false;
  for (let n = 0; n < 40 && !muerto; n++) { f.app.stepOnce(); muerto = f.app.world.people.length < poblacion; }
  assert.ok(muerto, 'la sed fatal produjo una muerte real');
  assert.equal(f.app.runtime.gobernador!.techo, poblacion, 'la muerte no baja el techo');
  assert.equal(f.app.world.reproductionEnabled, true, 'por debajo del techo el mundo repone aunque siga en rojo');
  assert.ok(f.app.runtime.gobernador!.p95StepMs > 50, 'sigue en rojo: el hardware no cambió');
  assert.equal(f.app.failed, false);
});

test('servidor con `gobernador.politica=apagar`: bajo carga sostenida apaga la reproducción aunque haya muertes (el gobernador de 2026-09-19)', t => {
  const dir = mkdtempSync(join(tmpdir(), 'carta-gobernador-apagar-'));
  const store = new Store(join(dir, 'world.sqlite'));
  let clock = 0;
  const app = createApp({ store, password, origin: 'http://127.0.0.1:3000', manual: true, seed: 42,
    params: parseParams('gobernador.presupuestoMs=50,gobernador.politica=apagar'), monotonicNow: () => clock++ });
  t.after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const save = store.save.bind(store);
  store.save = ((...args: Parameters<Store['save']>) => { clock += 80; return save(...args); }) as Store['save'];
  for (let n = 0; n < 8; n++) app.stepOnce();
  const poblacion = app.world.people.length;
  assert.equal(app.runtime.gobernador!.politica, 'apagar');
  assert.equal(app.runtime.gobernador!.techo, null);
  assert.equal(app.world.reproductionEnabled, false);
  fatalThirstFor(app.world.people.find(p => p.role === 'neighbor')!);
  let muerto = false;
  for (let n = 0; n < 40 && !muerto; n++) { app.stepOnce(); muerto = app.world.people.length < poblacion; }
  assert.ok(muerto);
  assert.equal(app.world.reproductionEnabled, false, 'apagar no repone: la extinción observada en el mundo público');
});
