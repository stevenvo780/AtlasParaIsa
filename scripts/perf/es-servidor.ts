/**
 * PERF3 — servidor real para medir la E/S entre pasos (verificación del planificador, 2026-09-23).
 *
 *   TMPDIR=/datos/tmp-atlas-lab npx tsx scripts/perf/es-servidor.ts --lento B [--cada K] --info info.json
 *
 * `createApp` con el planificador de verdad (`tickMs` 100), semilla 42 y la receta de producción con un
 * presupuesto del gobernador de 5000 ms. Uno de cada K pasos (1 por defecto) se alarga B ms de CPU con una
 * espera activa dentro de `Gobernador.registrar`, que corre dentro de `stepOnce`: así se imita un mundo cuyo
 * paso dura más que el intervalo. Escribe `{port, cookie}` en `--info` y sirve hasta SIGTERM; entonces deja
 * en `<info>.srv` los pasos por segundo de pared y el p95 del paso. Las sondas (`es-sonda.ts`,
 * `es-cliente.ts`) corren en OTRO proceso: en el mismo compartirían el bucle de eventos que se mide.
 * SIGTERM al proceso `node` interior, no a `npx`: si no, el padre lo mata antes de escribir el resumen.
 */
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/app.js';
import { hashToken } from '../../src/server/auth.js';
import { PRODUCTION_PARAMS } from '../../src/server/deployment-params.js';
import { Gobernador } from '../../src/server/governor.js';
import { Store } from '../../src/server/store.js';
import { DEFAULT_PARAMS, parseParams } from '../../src/world/params.js';

const arg = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag); return index === -1 ? undefined : process.argv[index + 1];
};
const lento = Number(arg('--lento') ?? 0), cadaLento = Number(arg('--cada') ?? 1), info = arg('--info');
if (!info || !(lento >= 0) || !Number.isInteger(cadaLento) || cadaLento < 1) {
  throw new Error('Uso: es-servidor.ts --lento B [--cada K] --info info.json');
}
if (!process.env.TMPDIR || process.env.TMPDIR.startsWith('/tmp')) {
  throw new Error('TMPDIR debe apuntar fuera de /tmp (cuota): TMPDIR=/datos/tmp-atlas-lab');
}

let llamadas = 0;
const registrar = Gobernador.prototype.registrar;
Gobernador.prototype.registrar = function (this: Gobernador, ms: number) {
  const hasta = performance.now() + (++llamadas % cadaLento === 0 ? lento : 0);
  while (performance.now() < hasta) { /* CPU del hilo principal, como un paso caro */ }
  return registrar.call(this, ms);
};

const dir = mkdtempSync(join(tmpdir(), 'es-servidor-')), store = new Store(join(dir, 'world.sqlite'));
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = (probe.address() as { port: number }).port;
await new Promise<void>(resolve => probe.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`;
const app = createApp({ store, origin, password: 'es-servidor-perf3', manual: false, tickMs: 100, seed: 42,
  params: parseParams(`${PRODUCTION_PARAMS},gobernador.presupuestoMs=5000`, DEFAULT_PARAMS) });
app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
const token = 'esservidorperf3'.padEnd(43, 'y');
store.addSession(hashToken(token), Date.now() + 86400_000);
const tick0 = app.world.tick, t0 = performance.now();
writeFileSync(info, JSON.stringify({ port, cookie: `carta_session=${token}`, password: 'es-servidor-perf3' }));
process.on('SIGTERM', async () => {
  const segundos = (performance.now() - t0) / 1000;
  writeFileSync(info + '.srv', JSON.stringify({ lento, cadaLento,
    pasosPorSegundo: Math.round((app.world.tick - tick0) / segundos * 100) / 100, p95StepMs: Math.round(app.runtime.p95StepMs) }));
  await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); process.exit(0);
});
setInterval(() => {}, 1000);
