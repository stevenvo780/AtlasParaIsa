import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { partitionRegions } from '../src/world/paralelo/particion.js';

const poolURL = new URL('../src/world/paralelo/piscina.ts', import.meta.url).href;
// Plazo del proceso de prueba: nunca se introduce en la barrera ni en el motor.
const HARNESS_WATCHDOG_MS = 60_000;

interface HarnessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function isolated(source: string): Promise<HarnessResult> {
  return new Promise((resolve, reject) => {
    // Permite que el laboratorio mantenga su nombre de runtime; por defecto es portable.
    const executable = process.env.ATLAS_TEST_NODE ?? process.execPath;
    const child = spawn(executable, ['--import', 'tsx', '--input-type=module', '-e', source], {
      cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr!.on('data', (chunk: string) => { stderr += chunk; });
    const watchdog = setTimeout(() => {
      timedOut = true;
      // Sólo el proceso creado por este test; SIGKILL detiene también sus worker_threads.
      child.kill('SIGKILL');
    }, HARNESS_WATCHDOG_MS);
    child.on('error', error => { clearTimeout(watchdog); reject(error); });
    child.on('close', code => {
      clearTimeout(watchdog);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

async function verifyIsolated(body: string): Promise<void> {
  const result = await isolated(`
    import assert from 'node:assert/strict';
    import { StaticWorkerPool } from ${JSON.stringify(poolURL)};
    ${body}
    console.log(JSON.stringify({ status: 'verified', pid: process.pid }));
  `);
  assert.equal(result.timedOut, false,
    `El watchdog externo detuvo un test bloqueado; esto es un FAIL, no un fallo entregado por el motor.\n${result.stderr}`);
  assert.equal(result.code, 0, `El proceso aislado falló:\n${result.stderr}\n${result.stdout}`);
  assert.equal((JSON.parse(result.stdout.trim()) as { status: string }).status, 'verified');
}

test('el arranque informa import inexistente por SAB sin esperar eventos del main', { timeout: 65_000 }, async () => {
  const missingURL = new URL('./__missing_static_pool_module__.mjs', import.meta.url).href;
  await verifyIsolated(`
    assert.throws(() => new StaticWorkerPool({
      workers: 2, moduleURL: ${JSON.stringify(missingURL)}, exportName: 'calculate',
    }), /__missing_static_pool_module__|ERR_MODULE_NOT_FOUND/);
  `);
});

test('el arranque informa export inválido por SAB y detiene todos los hijos', { timeout: 65_000 }, async () => {
  const moduleURL = `data:text/javascript,${encodeURIComponent('export const calculate = 42;')}`;
  await verifyIsolated(`
    assert.throws(() => new StaticWorkerPool({
      workers: 2, moduleURL: ${JSON.stringify(moduleURL)}, exportName: 'calculate',
    }), /export de cálculo no es una función/);
  `);
});

test('process.exit en compute entrega fallo y termina otro compute bloqueado antes de retornar', { timeout: 65_000 }, async () => {
  const moduleURL = `data:text/javascript,${encodeURIComponent(`
    export function calculate({ buffers, workerIndex }) {
      const control = new Int32Array(buffers.control);
      if (workerIndex === 0) {
        while (Atomics.load(control, 0) !== 1) Atomics.wait(control, 0, 0);
        process.exit(73);
      }
      Atomics.store(control, 0, 1);
      Atomics.notify(control, 0);
      // Sólo terminate puede liberar este hilo: no hay plazo ni respuesta futura inventada.
      Atomics.wait(control, 1, 0);
      throw new Error('El hilo bloqueado no debía reanudar un cálculo abortado.');
    }
  `)}`;
  await verifyIsolated(`
    const pool = new StaticWorkerPool({ workers: 2, moduleURL: ${JSON.stringify(moduleURL)}, exportName: 'calculate' });
    const control = new Int32Array(new SharedArrayBuffer(8));
    const job = { regions: [{ id: 0, begin: 0, end: 1 }], buffers: { control: control.buffer }, params: {} };
    try {
      assert.throws(() => pool.run(job), /salió inesperadamente.*73/s);
      assert.equal(Atomics.load(control, 0), 1, 'el segundo compute realmente estaba bloqueado');
      assert.throws(() => pool.run(job), /abortado/, 'un pool fatal no se reutiliza');
      assert.equal(pool.diagnostics().dispatches, 1);
    } finally {
      await pool.close();
    }
  `);
});

test('la partición rechaza todo solape no vacío, incluidos rangos anidados e ids distintos', () => {
  for (const regions of [
    [{ id: 'left', begin: 0, end: 2 }, { id: 'right', begin: 1, end: 3 }],
    [{ id: 8, begin: 2, end: 3 }, { id: 4, begin: 0, end: 9 }],
    [{ id: 0, begin: 0, end: 1 }, { id: 1, begin: 0, end: 1 }],
  ]) assert.throws(() => partitionRegions(regions, 2), /Rangos solapados/);
});

// V23 ya no reordena por id (no hay paridad entre hilos que defender): cada cola es un tramo del orden de entrada.
test('rangos adyacentes y regiones vacías pueden compartir un límite sin compartir escritura', () => {
  assert.deepEqual(partitionRegions([
    { id: 3, begin: 1, end: 2 }, { id: 2, begin: 1, end: 1 }, { id: 1, begin: 0, end: 1 },
    { id: 4, begin: 0, end: 0 },
  ], 2), [
    [{ id: 3, begin: 1, end: 2 }, { id: 2, begin: 1, end: 1 }],
    [{ id: 1, begin: 0, end: 1 }, { id: 4, begin: 0, end: 0 }],
  ]);
});
