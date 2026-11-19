/**
 * T161 — Señales del gobernador. El p95 sobre 120 pasos es ciego a los picos de
 * cadencia larga (comunidades cada 120 ticks, estadísticas cada 200, guardado
 * cada 20): un pico de 1 s cada 120 pasos es el 0,83 % de la ventana y queda
 * por debajo del percentil 95. El máximo por ventana (`maxMs`) y la fase que
 * lo produjo (`faseMax`) son obligatorios para delatarlo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';
import { Gobernador, RollingStepPerformance, teselasPorHabitante } from '../src/server/governor.js';
import { createWorld, stepWorld } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import type { FaseNombre } from '../src/shared/types.js';

const password = 'synthetic-test-password-only';
const FASES: readonly FaseNombre[] = ['maintainRegions', 'ecologia', 'kernel', 'fauna', 'personas', 'encuentros', 'demografia', 'comunidades', 'reproduccion', 'checkpoint', 'muestreo', 'save', 'broadcast'];

function fixture(t: { after: (f: () => unknown) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'carta-gobernador-senales-'));
  const store = new Store(join(dir, 'world.sqlite'));
  const app = createApp({ store, password, origin: 'http://127.0.0.1:3000', manual: true, seed: 42 });
  t.after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return app;
}

test('todas las señales de performance.gobernador se publican con rangos válidos', (t) => {
  const app = fixture(t);
  for (let n = 0; n < 5; n++) app.stepOnce();
  const g = app.runtime.gobernador!;
  assert.ok(g, 'el gobernador se publica en performance');
  for (const campo of ['p50Ms', 'p95Ms', 'p99Ms', 'maxMs'] as const) {
    assert.ok(Number.isFinite(g[campo]) && g[campo]! >= 0, `${campo} debe ser finito ≥ 0, fue ${g[campo]}`);
  }
  assert.ok(g.p50Ms! <= g.p95Ms! && g.p95Ms! <= g.p99Ms! && g.p99Ms! <= g.maxMs!, 'los percentiles ordenan: p50 ≤ p95 ≤ p99 ≤ max');
  assert.equal(g.p95Ms, g.p95StepMs, 'p95Ms es el mismo p95 que ya publicaba el gobernador');
  assert.ok(!g.faseMax || FASES.includes(g.faseMax), `faseMax debe nombrar una fase del paso, fue ${g.faseMax}`);
  assert.ok(g.fasesP95 && typeof g.fasesP95 === 'object', 'fasesP95 se publica');
  for (const [fase, ms] of Object.entries(g.fasesP95!)) {
    assert.ok(FASES.includes(fase as FaseNombre), `fasesP95 nombra fases reales, no ${fase}`);
    assert.ok(Number.isFinite(ms) && ms >= 0, `fasesP95.${fase} debe ser finito ≥ 0, fue ${ms}`);
  }
  assert.ok(Number.isFinite(g.tickHz) && g.tickHz! >= 0, `tickHz válido, fue ${g.tickHz}`);
  assert.ok(Number.isFinite(g.rssBytes) && g.rssBytes! > 0, `rssBytes válido, fue ${g.rssBytes}`);
  assert.ok(Number.isFinite(g.saveMs) && g.saveMs! >= 0, `saveMs válido, fue ${g.saveMs}`);
  const world = app.world;
  assert.equal(g.regionesActivas, Object.keys(world.chunks).length, 'regiones activas = chunks del mundo');
  assert.equal(g.teselasActivas, world.tiles.length, 'teselas activas = teselas del mundo');
  assert.equal(g.poblacion, world.people.length, 'población = habitantes del mundo');
  assert.equal(g.teselasPorHabitante, world.people.length > 0 ? world.tiles.length / world.people.length : 0);
  assert.equal(g.nacimientos, world.totals.births ?? 0, 'nacimientos = totals.births');
  const muertes = Object.values(world.demographyDynamics.causes).reduce((a, b) => a + b, 0);
  assert.equal(g.muertes, muertes, 'muertes = suma de causas de demographyDynamics');
  assert.ok(Number.isFinite(g.colaRed) && g.colaRed! >= 0, `colaRed (max bufferedAmount) válida, fue ${g.colaRed}`);
  assert.equal(g.presupuestoMs, 50);
  assert.ok(g.politica === 'apagar' || g.politica === 'techo', `politica válida, fue ${g.politica}`);
  assert.equal(g.reproductionEnabled, world.reproductionEnabled, 'reproductionEnabled refleja el mundo');
  assert.equal(g.techoPoblacion, g.techo ?? null, 'techoPoblacion refleja el techo vigente del gobernador');
});

test('teselasPorHabitante con 0 habitantes devuelve 0 y no lanza', () => {
  assert.equal(teselasPorHabitante(4096, 0), 0);
  assert.equal(teselasPorHabitante(0, 0), 0);
  assert.equal(teselasPorHabitante(4096, 8), 512);
  const g = new Gobernador();
  for (let n = 0; n < 8; n++) g.registrar(80);
  assert.doesNotThrow(() => g.decidir({ presupuestoMs: 50, politica: 'techo' }, true, 0, 4096, 8));
  assert.equal(g.techoObservado!.teselasPorHabitante, 0, 'el frenazo con 0 habitantes registra 0, no NaN ni Infinity');
});

test('un pico de 1000 ms cada 120 pasos deja el p95 en verde pero el máximo en rojo y nombra la fase', () => {
  const ventana = new RollingStepPerformance();
  const gobernador = new Gobernador();
  for (let n = 0; n < 119; n++) {
    ventana.record(5, { comunidades: 5 });
    gobernador.registrar(5, { comunidades: 5 });
  }
  ventana.record(1000, { comunidades: 1000 });
  gobernador.registrar(1000, { comunidades: 1000 });
  for (const senales of [ventana.senales(), gobernador.senales()]) {
    assert.ok(senales.p95Ms < 50, `el p95 (${senales.p95Ms} ms) queda por debajo del presupuesto: el panel seguiría en verde`);
    assert.ok(senales.maxMs >= 1000, `el máximo por ventana (${senales.maxMs} ms) delata el pico`);
    assert.equal(senales.faseMax, 'comunidades', 'faseMax nombra la fase culpable del pico');
    assert.ok(senales.p99Ms <= senales.maxMs);
    assert.equal(senales.fasesP95.comunidades, 5, 'ni siquiera el p95 por fase ve un pico que es el 0,83 % de la ventana');
  }
  assert.equal(ventana.p95Ms, ventana.senales().p95Ms);
  assert.equal(ventana.maxMs, 1000);
  assert.equal(gobernador.p95StepMs, gobernador.senales().p95Ms);
});

test('medir las señales no cambia el digestoCanonico del mundo', () => {
  const conSenales = createWorld(51926), sinSenales = createWorld(51926);
  const gobernador = new Gobernador();
  for (let n = 0; n < 40; n++) {
    stepWorld(conSenales);
    gobernador.registrar(5, { comunidades: 5 });
    gobernador.decidir({ presupuestoMs: 50, politica: 'techo' }, conSenales.reproductionEnabled, conSenales.people.length, conSenales.tiles.length, conSenales.tick);
    stepWorld(sinSenales);
  }
  assert.equal(digestoCanonico(conSenales), digestoCanonico(sinSenales), 'las señales son publicación, no regla: el mundo es bit a bit el mismo');
});
