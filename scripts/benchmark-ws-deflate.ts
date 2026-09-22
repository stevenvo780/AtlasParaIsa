/** T136 — ¿paga su coste `perMessageDeflate`? Banco reproducible: 12 clientes WS
 * autenticados, viewport medio (40×28, el mismo que usan research.md y
 * `tests/world-view-size.test.ts`), 1000 pasos manuales (`app.stepOnce()`, que
 * dispara `broadcast()` cada 5 ticks, igual que en producción). Corre las DOS
 * configuraciones (`perMessageDeflate` false/true) en el mismo proceso, contra
 * dos instancias de `createApp` (opción añadida en T136 a `src/server/app.ts`)
 * — nunca editando el fichero entre corridas.
 *
 * No se inyecta población sintética: el mundo por defecto (`createWorld(51926)`)
 * ya produce el "JSON más repetitivo posible" que menciona la tarea — `tiles`
 * es ≈82 % del `state` en viewport 40×28 (research.md) y es un array de objetos
 * con las mismas claves y rangos de valores repetidos, el caso ideal para deflate.
 *
 * Qué mide, en concreto:
 *   - `bytesPerClient` = `_socket.bytesRead` de cada cliente WS entre el primer
 *     `state` medido y el último: bytes TCP reales, framing de WebSocket
 *     incluido; bajo compresión el payload viaja deflatado.
 *   - `cpuUserMs` / `cpuSystemMs` = delta de `process.cpuUsage()` del PROCESO
 *     del servidor durante la ventana medida. `getrusage(RUSAGE_SELF)` agrega
 *     todos los hilos del proceso en Linux, así que la compresión asíncrona de
 *     zlib (corre en el threadpool de libuv, `concurrencyLimit` de `ws`) SÍ
 *     queda contabilizada aquí aunque no bloquee el hilo principal.
 *   - `stepMs` = duración de cada `app.stepOnce()` medida DESDE FUERA (incluye
 *     `broadcast()`). Ojo: `runtime.p95StepMs` (el que usa el gobernador, R17)
 *     NO incluye `broadcast()` — se congela antes de emitir (`src/server/app.ts`,
 *     `runtime.stepMs = monotonicNow() - stepStarted` ocurre antes del
 *     `broadcast()` de fin de paso). Por eso este banco separa los pasos que
 *     difunden (`tick % 5 === 0`) de los que no: la diferencia de p95 entre
 *     ambos grupos aísla el coste de `broadcast()` (donde vive la compresión)
 *     del resto del paso (clon + simulación + persistencia condicional).
 *
 * Uso:
 *   npx tsx scripts/benchmark-ws-deflate.ts
 *
 * Límite honesto: reloj de pared sobre esta torre, sin aislar de otra carga del
 * host; válido para comparar las dos configuraciones entre sí en la misma
 * corrida, no como número absoluto portable a otra máquina.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Store } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';

const password = 'synthetic-benchmark-password-only';
const CLIENT_COUNT = 12;
const STEP_COUNT = 1000;
const SEED = 51926;
// Viewport "medio": el mismo 40x28 que research.md y world-view-size.test.ts miden hoy.
const VIEWPORT = { x: 0, y: 0, width: 40, height: 28 };

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

function wireBytes(socket: WebSocket): number {
  // `_socket` es la net.Socket subyacente del cliente ws. `bytesRead` cuenta bytes
  // TCP realmente leídos del par: incluye el framing WebSocket y, si perMessageDeflate
  // está negociado, el payload comprimido. Es la medida honesta de lo que viaja.
  const inner = (socket as unknown as { _socket?: { bytesRead: number } })._socket;
  return inner?.bytesRead ?? 0;
}

function waitOpen(client: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout abriendo socket')), 5000);
    client.once('open', () => { clearTimeout(timer); resolve(); });
    client.once('error', err => { clearTimeout(timer); reject(err); });
  });
}

/** Cuenta mensajes desde el instante en que se crea el socket (ANTES de `open`):
 * el servidor manda el `state` inicial apenas termina el handshake, y si el
 * listener se engancha después con `.once('message', …)` puede llegar tarde a
 * un mensaje que ya pasó — el `Promise` de esa espera nunca se resolvería. */
function counter(client: WebSocket) {
  let count = 0;
  const waiters: { n: number; resolve: () => void }[] = [];
  client.on('message', () => {
    count++;
    for (let i = waiters.length - 1; i >= 0; i--) if (count >= waiters[i]!.n) { waiters[i]!.resolve(); waiters.splice(i, 1); }
  });
  return {
    get count() { return count; },
    waitForCount(n: number): Promise<void> {
      if (count >= n) return Promise.resolve();
      return new Promise(resolve => waiters.push({ n, resolve }));
    },
  };
}

function percentile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * q))]!;
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  return { n: values.length, meanMs: values.length ? sum / values.length : 0, p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95), maxMs: sorted.at(-1) ?? 0 };
}

async function run(label: string, perMessageDeflate: boolean) {
  const dir = mkdtempSync(join(tmpdir(), `t136-${label}-`));
  const store = new Store(join(dir, 'world.sqlite'));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const app = createApp({ store, password, origin, manual: true, tickMs: 15, seed: SEED, perMessageDeflate });
  app.server.listen(port, '127.0.0.1');
  await once(app.server, 'listening');
  try {
    const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    if (login.status !== 200) throw new Error(`login falló: ${login.status}`);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const wsUrl = origin.replace('http:', 'ws:') + '/ws';

    const clients: WebSocket[] = [];
    const counters: ReturnType<typeof counter>[] = [];
    for (let i = 0; i < CLIENT_COUNT; i++) {
      const client = new WebSocket(wsUrl, { headers: { Origin: origin, Cookie: cookie }, perMessageDeflate });
      counters.push(counter(client)); // enganchado antes de `open`: no se pierde el `state` inicial.
      await waitOpen(client);
      clients.push(client);
    }
    // Drenar el `state` inicial que el `upgrade` handler manda al conectar (ya en
    // viewport por defecto 40x28), luego fijar el viewport medio explícito y
    // drenar su eco: la ventana medida empieza limpia, sin ese costo de arranque.
    await Promise.all(counters.map(c => c.waitForCount(1)));
    for (const client of clients) client.send(JSON.stringify({ type: 'viewport', viewport: VIEWPORT }));
    await Promise.all(counters.map(c => c.waitForCount(2)));

    const baselineMessages = counters.map(c => c.count);
    const startBytes = clients.map(wireBytes);
    const startCpu = process.cpuUsage();
    const startMem = process.memoryUsage();

    const broadcastStepMs: number[] = [];
    const plainStepMs: number[] = [];
    let dropped = 0;
    let broadcastsSoFar = 0;
    for (let step = 0; step < STEP_COUNT; step++) {
      const t0 = performance.now();
      app.stepOnce();
      const dt = performance.now() - t0;
      if (app.world.tick % 5 === 0) {
        broadcastStepMs.push(dt);
        broadcastsSoFar++;
        // El bucle de `stepOnce()` es 100 % síncrono: sin ceder el hilo aquí, el proceso
        // nunca vuelve al event loop entre pasos y el servidor jamás llega a vaciar el
        // socket ni el cliente a leerlo — en producción median 500 ms reales (tickMs=100,
        // difunde cada 5) para que el SO drene. Esperamos la confirmación real de entrega
        // (cada cliente cuenta sus mensajes) con un techo de 500 ms: si de verdad se atrasa
        // (el `bufferedAmount>256KiB` de `send()` lo tira), lo contamos como descartado en
        // vez de fingir que llegó o de colgar el banco para siempre.
        const expected = 2 + broadcastsSoFar; // 2 = state inicial + eco del viewport, ya drenados
        const delivered = await Promise.race([
          Promise.all(counters.map(c => c.waitForCount(expected))).then(() => true),
          new Promise<boolean>(resolve => setTimeout(() => resolve(false), 500)),
        ]);
        if (!delivered) dropped += counters.filter(c => c.count < expected).length;
      } else {
        plainStepMs.push(dt);
        await new Promise(resolve => setImmediate(resolve)); // ceder el hilo también en los pasos llanos
      }
    }
    // Drenar los frames todavía en vuelo antes de leer los contadores finales.
    await new Promise(resolve => setTimeout(resolve, 300));

    const endCpu = process.cpuUsage(startCpu);
    const endMem = process.memoryUsage();
    const endBytes = clients.map(wireBytes);
    const perClientBytes = endBytes.map((b, i) => b - startBytes[i]!);
    const totalBytes = perClientBytes.reduce((a, b) => a + b, 0);
    const totalMessages = counters.reduce((sum, c, i) => sum + (c.count - baselineMessages[i]!), 0);

    for (const client of clients) client.terminate();
    return {
      label, perMessageDeflate,
      clientCount: CLIENT_COUNT, stepCount: STEP_COUNT,
      expectedMessages: CLIENT_COUNT * broadcastsSoFar, totalMessages, dropped,
      totalBytes, avgBytesPerMessage: totalMessages > 0 ? totalBytes / totalMessages : 0,
      cpuUserMs: endCpu.user / 1000, cpuSystemMs: endCpu.system / 1000, cpuTotalMs: (endCpu.user + endCpu.system) / 1000,
      rssDeltaMiB: (endMem.rss - startMem.rss) / 1048576,
      broadcastStep: summarize(broadcastStepMs), plainStep: summarize(plainStepMs),
    };
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const results: Awaited<ReturnType<typeof run>>[] = [];
for (const [label, deflate] of [['sin-deflate', false], ['con-deflate', true]] as const) {
  results.push(await run(label, deflate));
}

console.log(JSON.stringify(results, null, 2));

const base = results[0]!, on = results[1]!;
const bytesSavingPct = 100 * (1 - on.totalBytes / base.totalBytes);
const cpuExtraMs = on.cpuTotalMs - base.cpuTotalMs;
const broadcastOverheadP95Ms = on.broadcastStep.p95Ms - base.broadcastStep.p95Ms;
console.log(`\nResumen T136 (${CLIENT_COUNT} clientes, ${STEP_COUNT} pasos, viewport 40x28):`);
console.log(`  bytes totales:  sin-deflate ${base.totalBytes} B · con-deflate ${on.totalBytes} B · ahorro ${bytesSavingPct.toFixed(1)}%`);
console.log(`  CPU proceso:    sin-deflate ${base.cpuTotalMs.toFixed(1)} ms · con-deflate ${on.cpuTotalMs.toFixed(1)} ms · extra ${cpuExtraMs.toFixed(1)} ms`);
console.log(`  p95 broadcast:  sin-deflate ${base.broadcastStep.p95Ms.toFixed(2)} ms · con-deflate ${on.broadcastStep.p95Ms.toFixed(2)} ms · extra ${broadcastOverheadP95Ms.toFixed(2)} ms (presupuesto gobernador: 50 ms)`);
console.log(`  mensajes:       sin-deflate ${base.totalMessages}/${base.expectedMessages} (${base.dropped} descartados) · con-deflate ${on.totalMessages}/${on.expectedMessages} (${on.dropped} descartados)`);
console.log(`  p95 paso llano: sin-deflate ${base.plainStep.p95Ms.toFixed(2)} ms · con-deflate ${on.plainStep.p95Ms.toFixed(2)} ms`);
