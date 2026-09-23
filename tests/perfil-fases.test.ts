/**
 * T107 (perfil por fase y fracción serial). `stepWorld` mide sus 11 fases con el reloj
 * inyectado en `FaseMedicion` (nunca `performance.now`/`Date.now` dentro de `src/world`, regla
 * 3); `stepOnce` (app.ts) añade `save` y `broadcast` y publica las 13 en `runtime.fases` +
 * `runtime.fraccionSerial`. `fraccionSerial` no cuenta el clon del paso (`cloneMs` es un campo
 * aparte, fuera de la lista de `FaseNombre` que pide esta tarea).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';
import { createWorld, stepWorld, fraccionSerial, FASES_SERIALES, type FaseMedicion } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import type { FaseNombre } from '../src/shared/types.js';

const password = 'synthetic-test-password-only';
const FASES_DE_STEPWORLD: readonly FaseNombre[] = ['maintainRegions', 'ecologia', 'kernel', 'fauna', 'personas', 'encuentros', 'demografia', 'comunidades', 'reproduccion', 'checkpoint', 'muestreo'];
const TODAS_LAS_FASES: readonly FaseNombre[] = [...FASES_DE_STEPWORLD, 'save', 'broadcast'];

test('stepWorld llena exactamente sus 11 fases, todas finitas y no negativas', () => {
  const world = createWorld(51926);
  const medicion: FaseMedicion = { clock: () => performance.now(), fases: {} };
  stepWorld(world, [], undefined, medicion);
  assert.deepEqual(Object.keys(medicion.fases).sort(), [...FASES_DE_STEPWORLD].sort());
  for (const nombre of FASES_DE_STEPWORLD) {
    const ms = medicion.fases[nombre]!;
    assert.ok(Number.isFinite(ms) && ms >= 0, `${nombre} debe ser un número finito ≥ 0, fue ${ms}`);
  }
});

test('con un reloj que cuenta lecturas, cada una de las 11 fases se mide una sola vez por paso y ninguna anida a otra', () => {
  // Reloj determinista: cada lectura avanza 1. Si las fases se midieran dos veces, anidadas o sin
  // cerrar, las cuentas no darían exactamente 1 por fase y 22 lecturas por paso.
  let lecturas = 0;
  const world = createWorld(51926);
  for (let paso = 0; paso < 3; paso++) {
    const medicion: FaseMedicion = { clock: () => lecturas++, fases: {} };
    const antes = lecturas;
    stepWorld(world, [], undefined, medicion);
    assert.equal(lecturas - antes, 2 * FASES_DE_STEPWORLD.length, `lecturas del reloj en el paso ${paso + 1}`);
    for (const nombre of FASES_DE_STEPWORLD) assert.equal(medicion.fases[nombre], 1, `${nombre} en el paso ${paso + 1}`);
  }
});

test('stepWorld sin `medicion` no mide nada (coste de instrumentación opt-in) y el mundo resultante es idéntico', () => {
  const conMedicion = createWorld(51926), sinMedicion = createWorld(51926);
  const medicion: FaseMedicion = { clock: () => performance.now(), fases: {} };
  for (let n = 0; n < 40; n++) { stepWorld(conMedicion, [], undefined, medicion); stepWorld(sinMedicion); }
  assert.equal(digestoCanonico(conMedicion), digestoCanonico(sinMedicion), 'el digesto no puede depender de si el paso se instrumentó');
  assert.deepEqual(conMedicion, sinMedicion, 'medir fases es un efecto lateral fuera del mundo; el estado completo debe coincidir bit a bit');
});

test('fraccionSerial(fases) cae en [0,1], ignora fases ausentes y clasifica según el diseño de plan.md/D21', () => {
  assert.equal(fraccionSerial({}), 0, 'sin fases medidas no se afirma nada: 0, no NaN');
  assert.equal(fraccionSerial({ ecologia: 10, kernel: 10 }), 0, 'todo paralelizable por diseño');
  assert.equal(fraccionSerial({ save: 10, broadcast: 10 }), 1, 'todo serial por diseño');
  assert.equal(fraccionSerial({ ecologia: 25, save: 75 }), 0.75);
  // La clasificación es un contrato de diseño (FR-021/D21): si cambia, esta prueba debe
  // actualizarse a propósito, nunca por accidente de una fase renombrada.
  assert.deepEqual([...FASES_SERIALES].sort(), ['broadcast', 'checkpoint', 'comunidades', 'demografia', 'maintainRegions', 'muestreo', 'reproduccion', 'save'].sort());
  for (const paralelizable of ['ecologia', 'kernel', 'fauna', 'personas', 'encuentros'] as const) assert.ok(!FASES_SERIALES.has(paralelizable), `${paralelizable} debería ser paralelizable por diseño`);
});

/** Servidor en modo manual: los pasos los da la prueba con el reloj real, para que la
 * medición de fases sea la que de verdad vería producción. */
function fixture(t: { after: (f: () => unknown) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'carta-perfil-fases-'));
  const store = new Store(join(dir, 'world.sqlite'));
  const app = createApp({ store, password, origin: 'http://127.0.0.1:3000', manual: true, seed: 51926 });
  t.after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return app;
}

test('el state publica las 13 fases por paso y fraccionSerial coherente con runtime.fases', (t) => {
  const app = fixture(t);
  for (let n = 0; n < 5; n++) {
    app.stepOnce();
    const { fases, fraccionSerial: publicada } = app.runtime;
    assert.deepEqual(Object.keys(fases).sort(), [...TODAS_LAS_FASES].sort());
    for (const nombre of TODAS_LAS_FASES) assert.ok(Number.isFinite(fases[nombre]) && fases[nombre] >= 0, `${nombre} inválida: ${fases[nombre]}`);
    assert.ok(publicada >= 0 && publicada <= 1, `fraccionSerial fuera de [0,1]: ${publicada}`);
    assert.equal(publicada, fraccionSerial(fases), 'runtime.fraccionSerial debe ser exactamente fraccionSerial(runtime.fases)');
  }
});

// Con reloj real y la torre cargada el 5 % no es estable: la medida pasa a opt-in. La estructura de
// las fases la fija, sin reloj, la prueba del reloj que cuenta lecturas.
const escala = process.env.CARTA_TEST_ESCALA === '1';
test('la suma de las 11 fases de stepWorld no difiere de simulationMs en más de un 5 % (acumulado en 400 pasos, para amortiguar el ruido del reloj real)',
  { skip: escala ? false : 'medida de tiempo del host: exige CARTA_TEST_ESCALA=1' }, (t) => {
  const app = fixture(t);
  let sumaFases = 0, sumaSimulation = 0;
  const PASOS = 400;
  for (let n = 0; n < PASOS; n++) {
    app.stepOnce();
    const { fases, simulationMs } = app.runtime;
    for (const nombre of FASES_DE_STEPWORLD) sumaFases += fases[nombre];
    sumaSimulation += simulationMs!;
  }
  assert.ok(sumaSimulation > 0, 'la simulación debe tardar algo medible en 400 pasos');
  const diferencia = Math.abs(sumaFases - sumaSimulation) / sumaSimulation;
  assert.ok(diferencia <= 0.05, `suma de fases ${sumaFases.toFixed(3)} ms vs simulationMs ${sumaSimulation.toFixed(3)} ms difieren ${(diferencia * 100).toFixed(2)} %`);
});

test('el coste de medir fases es marginal frente al paso (control, no puerta: el reloj real tiene ruido)', (t) => {
  const app = fixture(t);
  for (let n = 0; n < 20; n++) app.stepOnce();
  const PASOS = 300;
  let sumaStep = 0, sumaFasesInternas = 0;
  for (let n = 0; n < PASOS; n++) { app.stepOnce(); sumaStep += app.runtime.stepMs; for (const nombre of FASES_DE_STEPWORLD) sumaFasesInternas += app.runtime.fases[nombre]; }
  // 22 lecturas de reloj reales (11 fases × entrada/salida) frente a un paso de una decena de
  // personas: referencia informativa, no puerta de cierre (ver informe T107 para la cifra real).
  t.diagnostic(`stepMs acumulado=${sumaStep.toFixed(3)} ms · fases internas acumuladas=${sumaFasesInternas.toFixed(3)} ms en ${PASOS} pasos`);
  assert.ok(sumaFasesInternas <= sumaStep, 'las fases medidas dentro de stepWorld no pueden superar el paso completo (que además incluye el clon)');
});
