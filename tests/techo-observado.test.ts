/**
 * T164 — Techo observado. Tras un frenazo, `performance.gobernador.techoObservado`
 * conserva las cifras de ese instante y un motivo legible; no se borra cuando
 * la carga vuelve a verde (es el registro del último frenazo, no el estado).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';
import { Gobernador, GOVERNOR_WINDOW_STEPS } from '../src/server/governor.js';
import { parseParams } from '../src/world/params.js';

const password = 'synthetic-test-password-only';

test('tras un frenazo sintético, techoObservado se puebla completo y no se borra al volver a verde', () => {
  const g = new Gobernador();
  for (let n = 0; n < 8; n++) g.registrar(80, { personas: 80 });
  assert.equal(g.decidir({ presupuestoMs: 50, politica: 'techo' }, true, 22, 1120, 8), false);
  const o = g.techoObservado;
  assert.ok(o, 'el frenazo queda registrado');
  assert.equal(o!.p95, 80);
  assert.ok(o!.maxMs >= 80, `maxMs del frenazo, fue ${o!.maxMs}`);
  assert.equal(o!.poblacion, 22);
  assert.equal(o!.teselasActivas, 1120);
  assert.equal(o!.teselasPorHabitante, 1120 / 22);
  assert.equal(o!.senal, 'p95');
  assert.equal(o!.tick, 8);
  assert.match(o!.motivo, /frenado por p95 = 80\.0 ms > 50 ms con 22 habitantes y 1120 teselas activas/);
  for (let n = 0; n < GOVERNOR_WINDOW_STEPS; n++) g.registrar(10);
  assert.equal(g.decidir({ presupuestoMs: 50, politica: 'techo' }, false, 21, 1120, 130), true);
  assert.equal(g.estado.techo, null, 'en verde el techo se retira');
  assert.ok(g.techoObservado, 'techoObservado no se borra al volver a verde');
  assert.equal(g.techoObservado!.tick, 8, 'sigue siendo el registro del último frenazo');
  assert.equal(g.techoObservado!.poblacion, 22);
});

test('el frenazo del servidor viaja en performance.gobernador.techoObservado y sobrevive a la recuperación', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'carta-techo-observado-'));
  const store = new Store(join(dir, 'world.sqlite'));
  let clock = 0;
  const app = createApp({ store, password, origin: 'http://127.0.0.1:3000', manual: true, seed: 42,
    params: parseParams('gobernador.presupuestoMs=50'), monotonicNow: () => clock++ });
  t.after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const save = store.save.bind(store);
  let delay = 80;
  store.save = ((...args: Parameters<Store['save']>) => { clock += delay; return save(...args); }) as Store['save'];

  for (let n = 0; n < 8; n++) app.stepOnce();
  const o = app.runtime.gobernador!.techoObservado;
  assert.ok(o, 'tras el frenazo, techoObservado viaja en performance.gobernador');
  assert.ok(o!.p95 > 50, `p95 del frenazo (${o!.p95}) supera el presupuesto`);
  assert.ok(Number.isFinite(o!.maxMs) && o!.maxMs >= o!.p95, 'maxMs acompaña al p95 del frenazo');
  assert.equal(o!.poblacion, app.world.people.length);
  assert.equal(o!.teselasActivas, app.world.tiles.length);
  assert.equal(o!.teselasPorHabitante, o!.teselasActivas / o!.poblacion);
  assert.ok(o!.senal.length > 0);
  assert.ok(o!.tick > 0);
  assert.match(o!.motivo, /frenado por p95 = \d+\.\d ms > 50 ms con \d+ habitantes y \d+ teselas activas/);
  const tickFrenazo = o!.tick;

  delay = 10;
  for (let n = 0; n < 130; n++) app.stepOnce();
  assert.ok(app.runtime.p95StepMs < 50 * 0.7, 'la carga volvió a verde');
  assert.equal(app.runtime.gobernador!.techo, null, 'el techo se retiró');
  assert.ok(app.runtime.gobernador!.techoObservado, 'el registro del frenazo no se borra');
  assert.equal(app.runtime.gobernador!.techoObservado!.tick, tickFrenazo, 'es el mismo frenazo, no uno nuevo');
});
