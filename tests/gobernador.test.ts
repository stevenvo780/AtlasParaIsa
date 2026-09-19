/**
 * Ruling R17 (2026-09-19): «el límite de población lo pone el hardware, no el software».
 * Ya no hay tope fijo de habitantes; quien frena el crecimiento es el gobernador, que mira
 * el p95 del paso contra `gobernador.presupuestoMs` y apaga/enciende `reproductionEnabled`.
 * Estas pruebas fijan esa frontera: la decisión pura (con su histéresis) y el lazo real del
 * servidor con pasos lentos de verdad, no con un número inyectado a mano.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { Store } from '../src/server/store.js';
import { createApp, decideReproduction } from '../src/server/app.js';
import { setParams, parseParams, DEFAULT_PARAMS, PARAM_RANGES } from '../src/world/params.js';
import { POPULATION_HARD_LIMIT } from '../src/world/index.js';

const password = 'synthetic-test-password-only';

async function freePort() {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve())); return port;
}

/** Servidor en modo manual: los pasos los da la prueba, no un temporizador. */
async function fixture(t: { after: (f: () => unknown) => void }, presupuestoMs: number, slowMs = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'carta-gobernador-'));
  const store = new Store(join(dir, 'world.sqlite'));
  // Un guardado lento es una fuente honesta de latencia del paso: el gobernador mide
  // el paso completo (simular + persistir), que es lo que el hardware cobra de verdad.
  const save = store.save.bind(store);
  let delay = slowMs;
  store.save = ((...args: Parameters<Store['save']>) => {
    if (delay > 0) { const until = performance.now() + delay; while (performance.now() < until); }
    return save(...args);
  }) as Store['save'];
  const port = await freePort();
  const app = createApp({ store, password, origin: `http://127.0.0.1:${port}`, manual: true, tickMs: 15, seed: 42 });
  setParams(app.world, parseParams(`gobernador.presupuestoMs=${presupuestoMs}`));
  t.after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { app, store, setDelay: (ms: number) => { delay = ms; } };
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

test('con pasos por encima del presupuesto el servidor apaga la reproducción y la devuelve al bajar la exigencia', async t => {
  const f = await fixture(t, 10, 25); // cada paso cuesta ≥25 ms contra un presupuesto de 10 ms
  assert.equal(f.app.world.reproductionEnabled, true, 'el mundo nace reproduciéndose');
  for (let n = 0; n < 6; n++) f.app.stepOnce();
  const caliente = f.app.runtime.gobernador!;
  assert.ok(caliente.p95StepMs > caliente.presupuestoMs, `p95 ${caliente.p95StepMs.toFixed(1)} ms debe superar el presupuesto ${caliente.presupuestoMs} ms`);
  assert.equal(f.app.world.reproductionEnabled, false, 'el hardware, no un tope fijo, detiene los nacimientos');
  assert.equal(caliente.activo, false);
  assert.equal(caliente.manual, null);

  // Un servidor más grande = más presupuesto: el mismo p95 ya cabe bajo el 70 %.
  setParams(f.app.world, parseParams('gobernador.presupuestoMs=5000'));
  f.setDelay(0);
  f.app.stepOnce();
  const frio = f.app.runtime.gobernador!;
  assert.equal(frio.presupuestoMs, 5000);
  assert.ok(frio.p95StepMs < frio.presupuestoMs * 0.7);
  assert.equal(f.app.world.reproductionEnabled, true, 'con holgura el mundo vuelve a crecer');
  assert.equal(frio.activo, true);
});

test('una orden humana manda sobre el gobernador mientras siga puesta', async t => {
  const f = await fixture(t, 5000);
  f.app.setReproduccionManual(false);
  f.app.stepOnce(); f.app.stepOnce();
  assert.equal(f.app.world.reproductionEnabled, false, 'con holgura de sobra, pero la orden humana manda');
  assert.equal(f.app.runtime.gobernador!.manual, false);
  f.app.setReproduccionManual(null); // devuelta al hardware
  f.app.stepOnce();
  assert.equal(f.app.world.reproductionEnabled, true);
  assert.equal(f.app.runtime.gobernador!.manual, null);
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
