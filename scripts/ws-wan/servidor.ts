/** Banco WS-WAN (diagnóstico «por dominio siempre dice sin conexión», 2026-09-22).
 *
 * Levanta UNA instancia propia del servidor (la misma `createApp` de producción, reloj real,
 * `tickMs` 100, params `deploymentParams(hostParams())` como `main.ts`) sobre un mundo propio
 * en `CARTA_DATA_DIR`, y registra en JSONL lo que `send()` de `src/server/app.ts` decide para
 * cada socket SIN tocar ese fichero: se envuelven `bufferedAmount`, `send` y `terminate` del
 * prototipo de `ws`. En este proceso no hay clientes WS: todo socket `ws` es del servidor
 * (se comprueba igualmente con `_isServer`).
 *
 *   evento `send`      → un mensaje salió: tipo, bytes UTF-8, `bufferedAmount` justo antes,
 *                        secuencia del `state` (para medir en el cliente la edad al llegar).
 *   evento `drop`      → `send()` leyó `bufferedAmount > 256 KiB` y descartó un `state`.
 *   evento `terminate` → alguien cortó el socket (con el `bufferedAmount` visto y quién).
 *
 * Cada evento lleva `peer` = puerto remoto del socket TCP (el del proxy que lo abrió): así el
 * banco une servidor ↔ escenario sin tocar el protocolo.
 *
 *   evento `flujo`     → cada segundo, la contrapresión por socket (`app.flujo`: enviados,
 *                        aplazados, acuses, último acuse) — solo existe desde la contrapresión.
 *
 * Compresión: sin opción, la de producción (se negocia; solo los `state` hacia clientes con acuse);
 * `--deflate` = comprimir todo a todos (T136); `--sin-deflate` = no negociar.
 *
 * Uso: CARTA_DATA_DIR=/datos/tmp-atlas-lab/wsfix/mundo CARTA_PASSWORD=x \
 *        npx tsx scripts/ws-wan/servidor.ts [--poblacion 30..60] [--deflate|--sin-deflate] [--port N]
 * Imprime en stdout una línea JSON {port, origin, host, cookie, people, tick} cuando está listo.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { request } from 'node:http';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import { createApp } from '../../src/server/app.js';
import { Store } from '../../src/server/store.js';
import { deploymentParams } from '../../src/server/deployment-params.js';
import { hostParams } from '../../src/server/hardware-limits.js';
import { paramsOf, setParams } from '../../src/world/params.js';

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : 'true';
};
if (!process.env.CARTA_DATA_DIR) throw new Error('Define CARTA_DATA_DIR (temporal, nunca el del servidor público).');
const dataDir = resolve(process.env.CARTA_DATA_DIR);
if (dataDir.startsWith('/datos/workspaces/personal/AtlasParaIsa-worlds') || dataDir === '/datos/workspaces/personal/AtlasParaIsa' || dataDir.startsWith('/datos/workspaces/personal/AtlasParaIsa/')) throw new Error('Ese directorio es del servidor público.');
const password = process.env.CARTA_PASSWORD;
if (!password) throw new Error('Define CARTA_PASSWORD desechable.');
const [minPeople, maxPeople] = arg('poblacion', '30..60')!.split('..').map(Number) as [number, number];
const deflate = arg('deflate') === 'true';
const sinDeflate = arg('sin-deflate') === 'true';
const port = Number(arg('port', '0'));
const host = 'atlas-wan.test', origin = `http://${host}`;
mkdirSync(dataDir, { recursive: true });
const telemetryPath = resolve(dataDir, `telemetria-${deflate ? 'deflate' : sinDeflate ? 'plano' : 'produccion'}-${process.pid}.jsonl`);

// ---------------------------------------------------------------- telemetría del servidor
type Tagged = WebSocket & { _isServer?: boolean; __reads?: number; __lastRead?: number; __sent?: boolean; __checkPending?: boolean };
const log = (event: Record<string, unknown>) => appendFileSync(telemetryPath, JSON.stringify({ t: Date.now(), ...event }) + '\n');
const peerOf = (socket: WebSocket): number | null => (socket as unknown as { _socket?: { remotePort?: number } })._socket?.remotePort ?? null;
const bufferedGet = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount')!.get!;
const originalSend = WebSocket.prototype.send;
const originalTerminate = WebSocket.prototype.terminate;
Object.defineProperty(WebSocket.prototype, 'bufferedAmount', {
  configurable: true,
  get(this: Tagged) {
    const value = bufferedGet.call(this) as number;
    if (!this._isServer) return value;
    // `send()` de app.ts lee dos veces seguidas (corte a 2 MiB, descarte a 256 KiB) y, si no
    // descarta, llama a `ws.send` en el mismo turno síncrono: una microtarea decide qué pasó.
    this.__reads = (this.__reads ?? 0) + 1; this.__lastRead = value;
    if (!this.__checkPending) {
      this.__checkPending = true; this.__sent = false;
      queueMicrotask(() => {
        this.__checkPending = false;
        const reads = this.__reads ?? 0, last = this.__lastRead ?? 0; this.__reads = 0;
        if (reads >= 2 && !this.__sent && last > 256 * 1024) log({ ev: 'drop', peer: peerOf(this), bufferedAmount: last });
      });
    }
    return value;
  },
});
WebSocket.prototype.send = function (this: Tagged, data: unknown, ...rest: unknown[]) {
  if (this._isServer) {
    this.__sent = true;
    const text = typeof data === 'string' ? data : '';
    // Un trozo de un `state` partido no empieza por `{"type"` (salvo el primero, que es el `state`).
    const type = /^\{"type":"([a-z]+)"/.exec(text)?.[1] ?? (text ? 'trozo' : 'binario');
    const sequence = type === 'state' ? Number(/"sequence":(\d+)/.exec(text)?.[1] ?? NaN) : undefined;
    log({ ev: 'send', peer: peerOf(this), type, bytes: Buffer.byteLength(text), bufferedAmount: bufferedGet.call(this), sequence });
  }
  return (originalSend as (...a: unknown[]) => void).call(this, data, ...rest);
} as typeof WebSocket.prototype.send;
WebSocket.prototype.terminate = function (this: Tagged) {
  if (this._isServer) log({ ev: 'terminate', peer: peerOf(this), bufferedAmount: bufferedGet.call(this), by: new Error().stack?.split('\n')[2]?.trim() });
  return originalTerminate.call(this);
};

// ---------------------------------------------------------------- mundo con 30–60 habitantes
const store = new Store(resolve(dataDir, 'world.sqlite'));
{
  const grower = createApp({ store, password, origin, manual: true, params: () => deploymentParams(hostParams()) });
  setParams(grower.world, deploymentParams(paramsOf(grower.world)));
  const started = performance.now();
  let steps = 0;
  while (grower.world.people.length < minPeople && steps < 60_000) {
    grower.stepOnce(); steps++;
    if (grower.failed) throw new Error('El mundo falló al crecer.');
    if (steps % 1000 === 0) process.stderr.write(`crecer: tick ${grower.world.tick} · ${grower.world.people.length} hab. · ${((performance.now() - started) / 1000).toFixed(0)} s\n`);
  }
  if (grower.world.people.length > maxPeople) process.stderr.write(`aviso: ${grower.world.people.length} hab. (> ${maxPeople})\n`);
  store.save(grower.world);
  await grower.close();
}

// ---------------------------------------------------------------- servidor vivo
const app = createApp({ store, password, origin, params: () => deploymentParams(hostParams()), ...(deflate ? { perMessageDeflate: true } : sinDeflate ? { perMessageDeflate: false } : {}) });
setParams(app.world, deploymentParams(paramsOf(app.world)));
await new Promise<void>(yes => app.server.listen(port, '127.0.0.1', () => yes()));
const address = app.server.address() as { port: number };
// `fetch` no deja fijar Host: se entra por http.request.
const cookie = await new Promise<string>((yes, no) => {
  const req = request({ host: '127.0.0.1', port: address.port, path: '/api/login', method: 'POST', headers: { Host: host, Origin: origin, 'Content-Type': 'application/json' } }, res => {
    res.resume(); const c = res.headers['set-cookie']?.[0]?.split(';')[0]; if (c) yes(c); else no(new Error(`login ${res.statusCode}`));
  });
  req.on('error', no); req.end(JSON.stringify({ password }));
});
log({ ev: 'ready', port: address.port, people: app.world.people.length, tick: app.world.tick, deflate });
// El ritmo real del mundo decide cada cuánto se difunde: se registra cada 5 s.
setInterval(() => {
  const r = app.runtime;
  log({ ev: 'runtime', tick: app.world.tick, people: app.world.people.length, tickHz: r.tickHz, stepMs: r.stepMs, p95StepMs: r.p95StepMs, broadcastMs: r.fases?.broadcast, projectionMs: r.projectionMs });
}, 5000).unref();
setInterval(() => { const conexiones = app.flujo; if (conexiones.length) log({ ev: 'flujo', conexiones }); }, 1000).unref();
process.stdout.write(JSON.stringify({ port: address.port, origin, host, cookie, people: app.world.people.length, tick: app.world.tick, deflate, telemetry: telemetryPath }) + '\n');
const shutdown = async () => { await app.close(); store.close(); process.exit(0); };
process.once('SIGINT', () => void shutdown()); process.once('SIGTERM', () => void shutdown());
