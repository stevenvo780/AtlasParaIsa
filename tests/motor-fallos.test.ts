import assert from 'node:assert/strict';
import test from 'node:test';
import { threadId } from 'node:worker_threads';
import { ErrorFatalMotor, PLAZO_BARRERA_MS } from '../src/world/paralelo/barrera.js';
import { Piscina } from '../src/world/paralelo/piscina.js';
import { crear, type DatosFallos } from './lib/motor-hilos.js';

const MODULO = new URL('./lib/motor-hilos.ts', import.meta.url);
const HILOS = 8;

function piscinaDe(modo: DatosFallos['modo'], plazoFaseMs?: number) {
  const datos: DatosFallos = { prueba: 'fallos', modo, contador: new Int32Array(new SharedArrayBuffer(4)) };
  return { datos, piscina: new Piscina({ hilos: HILOS, datos, plazoFaseMs, crear, moduleURL: MODULO, exportName: 'crear' }) };
}

/** El fallo es fatal, no se reintenta, y tras el cierre ningún hilo sigue escribiendo. */
async function comprobarFatal(modo: DatosFallos['modo'], motivo: RegExp, plazoMs: number, plazoFaseMs?: number): Promise<number> {
  const { datos, piscina } = piscinaDe(modo, plazoFaseMs);
  try {
    for (let i = 0; i < 3; i++) piscina.ejecutar(0);
    const inicio = performance.now();
    let error: unknown;
    try { piscina.ejecutar(1); } catch (e) { error = e; }
    const ms = performance.now() - inicio;
    assert.ok(error instanceof ErrorFatalMotor, `se esperaba ErrorFatalMotor y llegó ${String(error)}`);
    assert.match(error.message, motivo);
    // recuperarPaso (src/server/app.ts) convierte en salida 75 todo error con este prefijo.
    assert.match(error.message, /StaticWorkerPool/);
    assert.ok(ms < plazoMs, `detectado en ${ms.toFixed(0)} ms`);
    assert.equal(piscina.diagnostico().fatal, true);
    assert.throws(() => piscina.ejecutar(0), e => e === error, 'una piscina fatal no vuelve a despachar');
    await piscina.cerrar();
    const quieto = Atomics.load(datos.contador, 0);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(Atomics.load(datos.contador, 0), quieto, 'tras el cierre ningún hilo escribe');
    return ms;
  } finally {
    await piscina.cerrar();
  }
}

test('con un hilo, las fases corren en el hilo que llama, sin piscina', async () => {
  const visto: number[] = [];
  const piscina = new Piscina({ hilos: 1, datos: null, crear: () => fase => { visto.push(fase, threadId); }, moduleURL: MODULO, exportName: 'crear' });
  piscina.ejecutar(3); piscina.ejecutar(4);
  assert.deepEqual(visto, [3, threadId, 4, threadId]);
  assert.deepEqual(piscina.diagnostico().threadIds, [threadId]);
  await piscina.cerrar();
});

test('la piscina es persistente: los mismos hilos en cada fase', async () => {
  const { piscina } = piscinaDe('lanza');
  try {
    piscina.ejecutar(0);
    const hilos = piscina.diagnostico().threadIds;
    assert.equal(new Set(hilos).size, HILOS);
    for (let i = 0; i < 20; i++) piscina.ejecutar(0);
    assert.deepEqual(piscina.diagnostico().threadIds, hilos);
    assert.equal(piscina.diagnostico().fases, 21);
  } finally { await piscina.cerrar(); }
});

test('un hilo que muere mientras el coordinador aún trabaja en su fase se detecta sin esperar el plazo', { timeout: 120_000 }, async () => {
  const ms = await comprobarFatal('muere', /salió inesperadamente \(código 7\)/, PLAZO_BARRERA_MS / 2);
  console.log(`# muerte detectada en ${ms.toFixed(0)} ms`);
});

test('un error en un hilo es fatal para el paso', { timeout: 120_000 }, async () => {
  await comprobarFatal('lanza', /fallo de prueba en el hilo 1/, PLAZO_BARRERA_MS / 2);
});

test('un error del coordinador detiene a los hilos que seguían escribiendo', { timeout: 120_000 }, async () => {
  await comprobarFatal('coordinador', /fallo de prueba en el coordinador/, PLAZO_BARRERA_MS / 2);
});

test('un hilo colgado vence el plazo real de su fase y queda fatal', { timeout: 30_000 }, async () => {
  const plazoFaseMs = 350;
  assert.equal(PLAZO_BARRERA_MS, 60_000);
  const ms = await comprobarFatal('cuelga', /Barrera vencida tras 0\.35 s/, 5_000, plazoFaseMs);
  assert.ok(ms >= plazoFaseMs - 50, `no vence antes del plazo: ${ms.toFixed(0)} ms`);
});
