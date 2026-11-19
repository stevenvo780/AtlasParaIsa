/**
 * T151 (fracción serial y ocupación de workers). La instrumentación mide tiempos de pared
 * y tiempos activos por worker fuera del mundo: nunca entra en una fórmula del mundo ni
 * cambia un cálculo (reglas 2 y 3), así que el digesto canónico no puede depender de ella.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { createApp, aceleracionAmdahlTeorica as aceleracionDesdeApp } from '../src/server/app.js';
import { StaticWorkerPool, aceleracionAmdahlTeorica, calcularFraccionSerialReal, calcularOcupacionWorkers } from '../src/world/paralelo/piscina.js';
import { createWorld, stepWorld, cloneWorld, fraccionSerial, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { paramsOf, setParams, type WorldParams } from '../src/world/params.js';
import { closeEcosystemWorkers } from '../src/world/ecosystem.js';

const password = 'synthetic-test-password-only';

test('aceleracionAmdahlTeorica: valores exactos, bordes y rechazos', () => {
  assert.equal(aceleracionAmdahlTeorica(1, 28), 1);
  assert.equal(aceleracionAmdahlTeorica(0, 28), 28);
  assert.equal(aceleracionAmdahlTeorica(0.5, 1), 1);
  assert.ok(Math.abs(aceleracionAmdahlTeorica(0.05, 28) - 1 / (0.05 + 0.95 / 28)) < 1e-12);
  assert.ok(Math.abs(aceleracionAmdahlTeorica(0.05, 28) - 11.915) < 0.01, 'con 5 % serial la aceleración topa muy por debajo de 28×');
  assert.equal(aceleracionDesdeApp, aceleracionAmdahlTeorica, 'app.ts republica el mismo helper puro');
  assert.throws(() => aceleracionAmdahlTeorica(-0.01, 4), RangeError);
  assert.throws(() => aceleracionAmdahlTeorica(1.01, 4), RangeError);
  assert.throws(() => aceleracionAmdahlTeorica(Number.NaN, 4), RangeError);
  assert.throws(() => aceleracionAmdahlTeorica(0.1, 0), RangeError);
});

test('calcularFraccionSerialReal y calcularOcupacionWorkers: contrato puro', () => {
  assert.equal(calcularFraccionSerialReal(10, 10, 1), 1, 'sin workers ni GPU todo es serial aunque haya tiempo paralelo nominal');
  assert.equal(calcularFraccionSerialReal(10, 10, 1, 1), 0.5, 'con GPU sí hay tramo paralelo');
  assert.equal(calcularFraccionSerialReal(25, 75, 4), 0.25);
  assert.equal(calcularFraccionSerialReal(10, 0, 4), 1, 'sin tiempo paralelo medido no se inventa paralelismo');
  assert.equal(calcularOcupacionWorkers([50, 50, 50, 50], 55), 200 / 220);
  assert.equal(calcularOcupacionWorkers([200, 0, 0, 0], 200), 0.25);
  assert.equal(calcularOcupacionWorkers([], 10), 0);
  assert.equal(calcularOcupacionWorkers([10], 0), 0);
  assert.ok(calcularOcupacionWorkers([999], 10) <= 1, 'la ocupación nunca sale de [0,1]');
});

function fixtureApp(t: { after: (f: () => unknown) => void }, params?: WorldParams) {
  const dir = mkdtempSync(join(tmpdir(), 'carta-fraccion-serial-'));
  const store = new Store(join(dir, 'world.sqlite'));
  const app = createApp({ store, password, origin: 'http://127.0.0.1:3000', manual: true, seed: 51926, params });
  t.after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return app;
}

test('con motor.hilos=1: fraccionSerialReal === 1 y ocupacionWorkers === 0, conservando la lectura T107', (t) => {
  const app = fixtureApp(t);
  for (let n = 0; n < 5; n++) {
    app.stepOnce();
    const r = app.runtime;
    assert.equal(r.fraccionSerialReal, 1, `paso ${n + 1}: sin workers ni GPU la fracción serial real es 1`);
    assert.equal(r.ocupacionWorkers, 0, `paso ${n + 1}: sin pool no hay ocupación`);
    assert.equal(r.tiempoParaleloMs, 0);
    assert.equal(r.tiempoBarreraMs, 0);
    assert.ok(r.fraccionSerial >= 0 && r.fraccionSerial <= 1);
    assert.equal(r.fraccionSerial, fraccionSerial(r.fases), 'retrocompatibilidad T107: fraccionSerial sigue siendo fraccionSerial(fases)');
  }
});

// Handler físico: gira en CPU un tiempo proporcional al tamaño de cada región. El tiempo
// activo que mide la piscina es, por tanto, trabajo real del worker, no una espera.
const moduloTrabajo = new URL(`data:text/javascript,${encodeURIComponent(`
  export function work({ regions, params }) {
    for (const region of regions) {
      const hasta = performance.now() + (region.end - region.begin) * params.msPorUnidad;
      while (performance.now() < hasta) { /* trabajo CPU del worker */ }
    }
  }
`)}`);
const buffersVacios = () => ({ dummy: new SharedArrayBuffer(8) });

test('StaticWorkerPool: carga equilibrada ocupa >= 0.70 y la desbalanceada baja proporcionalmente', async (t) => {
  const pool = new StaticWorkerPool({ workers: 4, moduleURL: moduloTrabajo, exportName: 'work' });
  t.after(() => pool.close());
  const equilibradas = Array.from({ length: 4 }, (_, id) => ({ id, begin: id * 40, end: id * 40 + 40 }));
  pool.run({ regions: equilibradas, buffers: buffersVacios(), params: { msPorUnidad: 2 } });
  const eq = pool.diagnostics();
  assert.equal(eq.tiempoActivoWorkersMs.length, 4);
  assert.ok(eq.tiempoParaleloMs > 0 && eq.tiempoBarreraMs >= 0 && eq.tiempoBarreraMs <= eq.tiempoParaleloMs);
  assert.ok(eq.ocupacionWorkers >= 0.70, `carga equilibrada: ocupación ${eq.ocupacionWorkers.toFixed(3)} debe ser >= 0.70`);
  assert.ok(eq.ocupacionWorkers <= 1);

  const desbalanceadas = [{ id: 0, begin: 0, end: 160 }, { id: 1, begin: 160, end: 161 }, { id: 2, begin: 161, end: 162 }, { id: 3, begin: 162, end: 163 }];
  pool.run({ regions: desbalanceadas, buffers: buffersVacios(), params: { msPorUnidad: 2 } });
  const des = pool.diagnostics();
  assert.ok(des.ocupacionWorkers < eq.ocupacionWorkers, 'la carga desbalanceada debe ocupar menos que la equilibrada');
  assert.ok(des.ocupacionWorkers >= 0.15 && des.ocupacionWorkers <= 0.45,
    `una sola región dominante sobre 4 workers ocupa ≈ 1/4, fue ${des.ocupacionWorkers.toFixed(3)}`);
  const esperada = calcularOcupacionWorkers(des.tiempoActivoWorkersMs, des.tiempoParaleloMs);
  assert.ok(Math.abs(des.ocupacionWorkers - esperada) < 1e-9, 'la ocupación publicada es la del helper puro');
  t.diagnostic(`equilibrada ocupacion=${eq.ocupacionWorkers.toFixed(3)} paralelo=${eq.tiempoParaleloMs.toFixed(1)}ms barrera=${eq.tiempoBarreraMs.toFixed(1)}ms · desbalanceada ocupacion=${des.ocupacionWorkers.toFixed(3)} paralelo=${des.tiempoParaleloMs.toFixed(1)}ms barrera=${des.tiempoBarreraMs.toFixed(1)}ms`);
});

test('Amdahl: la aceleración medida del pool coincide con la predicha desde la fracción serial reportada (±20 %)', async (t) => {
  const regiones = Array.from({ length: 4 }, (_, id) => ({ id, begin: id * 100, end: id * 100 + 100 }));
  const unWorker = new StaticWorkerPool({ workers: 1, moduleURL: moduloTrabajo, exportName: 'work' });
  const cuatroWorkers = new StaticWorkerPool({ workers: 4, moduleURL: moduloTrabajo, exportName: 'work' });
  t.after(async () => { await unWorker.close(); await cuatroWorkers.close(); });
  unWorker.run({ regions: regiones, buffers: buffersVacios(), params: { msPorUnidad: 2 } });
  cuatroWorkers.run({ regions: regiones, buffers: buffersVacios(), params: { msPorUnidad: 2 } });
  const d1 = unWorker.diagnostics(), d4 = cuatroWorkers.diagnostics();
  const aceleracionMedida = d1.tiempoParaleloMs / d4.tiempoParaleloMs;
  // Fracción serial reportada del despacho paralelo: lo que quedó fuera del trabajo útil
  // (barrera/despacho) sobre la pared total del despacho.
  const fraccionReportada = calcularFraccionSerialReal(d4.tiempoBarreraMs, Math.max(0, d4.tiempoParaleloMs - d4.tiempoBarreraMs), 4);
  const aceleracionPredicha = aceleracionAmdahlTeorica(fraccionReportada, 4);
  t.diagnostic(`T1=${d1.tiempoParaleloMs.toFixed(1)}ms T4=${d4.tiempoParaleloMs.toFixed(1)}ms medida=${aceleracionMedida.toFixed(3)} fraccion=${fraccionReportada.toFixed(4)} predicha=${aceleracionPredicha.toFixed(3)} ocupacion=${d4.ocupacionWorkers.toFixed(3)}`);
  assert.ok(aceleracionMedida > 2, `4 workers deben acelerar de verdad, fue ${aceleracionMedida.toFixed(3)}×`);
  const desviacion = Math.abs(aceleracionMedida - aceleracionPredicha) / aceleracionPredicha;
  assert.ok(desviacion <= 0.20, `medida ${aceleracionMedida.toFixed(3)}× vs predicha ${aceleracionPredicha.toFixed(3)}× difieren ${(desviacion * 100).toFixed(1)} % (> 20 %)`);
});

test('con motor.hilos=4 el servidor publica ocupación y tiempos del último despacho del pool', (t) => {
  const base = createWorld(51926);
  const params = structuredClone(paramsOf(base));
  Object.assign(params.motor, { hilos: 4, orden: 'natural', gpu: [], soaTerreno: true });
  const app = fixtureApp(t, params);
  t.after(() => closeEcosystemWorkers());
  for (let n = 0; n < 12; n++) app.stepOnce();
  const r = app.runtime;
  assert.ok(r.ocupacionWorkers !== undefined && r.ocupacionWorkers >= 0 && r.ocupacionWorkers <= 1, `ocupación en [0,1], fue ${r.ocupacionWorkers}`);
  assert.ok(r.tiempoParaleloMs !== undefined && r.tiempoParaleloMs > 0, 'hubo al menos un despacho ecológico real en 12 pasos');
  assert.ok(r.tiempoBarreraMs !== undefined && r.tiempoBarreraMs >= 0 && r.tiempoBarreraMs <= r.tiempoParaleloMs, 'la barrera cabe en la pared paralela');
  assert.ok(r.fraccionSerialReal !== undefined && r.fraccionSerialReal >= 0 && r.fraccionSerialReal <= 1);
  assert.equal(r.fraccionSerial, fraccionSerial(r.fases), 'la lectura por diseño de T107 no cambia con workers');
  t.diagnostic(`app hilos=4 ocupacion=${r.ocupacionWorkers.toFixed(3)} paralelo=${r.tiempoParaleloMs.toFixed(2)}ms barrera=${r.tiempoBarreraMs.toFixed(2)}ms fsReal=${r.fraccionSerialReal.toFixed(3)}`);
});

function paramsConHilos(world: World, hilos: number): WorldParams {
  const params = structuredClone(paramsOf(world));
  Object.assign(params.motor, { hilos, orden: 'natural', gpu: [], soaTerreno: hilos > 1 });
  return params;
}
function digestoNormalizado(world: World): string {
  const copia = cloneWorld(world);
  setParams(copia, paramsConHilos(copia, 1));
  return digestoCanonico(copia);
}

test('paridad: la instrumentación nunca toca el mundo (digestoCanonico idéntico con 1 y con 4 hilos)', async (t) => {
  t.after(() => closeEcosystemWorkers());
  const serial = createWorld(51926), paralelo = createWorld(51926);
  setParams(serial, paramsConHilos(serial, 1));
  setParams(paralelo, paramsConHilos(paralelo, 4));
  for (let n = 0; n < 30; n++) { stepWorld(serial); stepWorld(paralelo); }
  assert.equal(digestoNormalizado(paralelo), digestoNormalizado(serial),
    'medir ocupación/fracción serial no puede cambiar ni un bit del mundo');
});
