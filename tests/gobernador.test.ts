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
