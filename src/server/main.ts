import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cerrarPiscinasDeComputo, createApp } from './app.js';
import { createWorkerGateway } from './gateway.js';
import { Store } from './store.js';
import { acquireLock } from './lock.js';
import { ley, paramsOf, setParams } from '../world/params.js';
import { deploymentParams, paramsNuevosDeDespliegue } from './deployment-params.js';
import { bindWorldContext, worldContext } from '../world/index.js';
import { ResidentTopologyOwner } from '../world/soa/topologia.js';
import { resumenDespacho } from './resumen-vivo.js';

process.umask(0o077);
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT no válido.');
const host = process.env.HOST ?? '127.0.0.1';
const origin = process.env.CARTA_ORIGIN ?? `http://127.0.0.1:${port}`;
const extraOrigins = (process.env.CARTA_EXTRA_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const secure = origin.startsWith('https://');
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && (!secure || extraOrigins.some(item => !item.startsWith('https://')))) {
  throw new Error('Configura CARTA_ORIGIN y CARTA_EXTRA_ORIGINS con HTTPS antes de escuchar fuera de loopback.');
}
/** Entero positivo opcional de entorno; un valor presente pero inválido es un error de configuración. */
function enteroPositivo(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value < 1) throw new Error(`${name} debe ser un entero positivo.`);
  return value;
}
// V21: `CARTA_TURBO=1` corre sin tope (`tickMs = 0`) y graba la cinta; `CARTA_TAPE=1` graba la cinta a
// ritmo normal; `CARTA_OBSERVER_ONLY=1` quita las órdenes directas a los habitantes. `CARTA_TAPE_TOPE_BYTES` fija
// cuánto disco puede ocupar la cinta (por defecto `CINTA.topeBytes`).
const tapeTopeBytes = enteroPositivo('CARTA_TAPE_TOPE_BYTES');
const tapeDirectory = process.env.CARTA_CINTA_DIR || undefined;
const v21 = {
  ...(process.env.CARTA_TURBO === '1' ? { turbo: true, tape: true, tickMs: 0 } : {}),
  ...(process.env.CARTA_TAPE === '1' ? { tape: true } : {}),
  ...(process.env.CARTA_OBSERVER_ONLY === '1' ? { observerOnly: true } : {}),
  ...(tapeTopeBytes === undefined ? {} : { tapeTopeBytes }),
  ...(tapeDirectory === undefined ? {} : { tapeDirectory }),
};
const dataPath = resolve(process.env.CARTA_DATA_DIR ?? 'data');
function commitEnEjecucion(): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return undefined; }
}
const commit = commitEnEjecucion();
const unlock = acquireLock(resolve(dataPath, 'world.lock'));
let store: Store | undefined;
let app: ReturnType<typeof createApp> | ReturnType<typeof createWorkerGateway> | undefined;
let released = false;
let closing: Promise<void> | undefined;
let abortado = false;
function release(): void {
  if (released) return; released = true;
  try { store?.close(); } finally { unlock(); }
}
function shutdown(code?: number): Promise<void> {
  if (code !== undefined) process.exitCode = code;
  abortado = true;
  if (closing) return closing;
  closing = (async () => {
    try {
      if (app) await app.close();
      else await cerrarPiscinasDeComputo();
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'No se pudieron cerrar las piscinas de cómputo.');
      process.exitCode = 1;
    } finally { release(); }
  })();
  return closing;
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
function escuchar(instancia: NonNullable<typeof app>) {
  instancia.server.on('error', () => { console.error('No se pudo abrir el servicio. Revisa dirección y puerto.'); void shutdown(1); });
  instancia.server.listen(port, host, () => console.log(`Carta disponible en ${[origin, ...extraOrigins].join(', ')}; acceso privado requerido.`));
}
const conWorker = process.env.CARTA_SIM_WORKER === '1';
try {
  if (conWorker) {
    const pasarela = createWorkerGateway({ worldPath: resolve(dataPath, 'world.sqlite'), manual: true, deployment: true, commit,
      password: process.env.CARTA_PASSWORD, credentialPath: resolve(dataPath, 'access.scrypt'), origin, extraOrigins, secure, ...v21 });
    // Un worker caído deja el transporte sirviendo un espejo fosilizado para siempre: se sale con 75
    // y systemd reinicia el servicio sobre el último guardado.
    pasarela.events.on('workerError', (error: unknown) => {
      console.error(`El hilo de simulación cayó (${error instanceof Error ? error.message : String(error)}); salgo con 75 para que el servicio reinicie.`);
      process.exit(75);
    });
    app = pasarela;
    escuchar(pasarela);
    await app.ready;
  } else {
    store = new Store(resolve(dataPath, 'world.sqlite'), { snapshotPackedPeople: process.env.CARTA_SNAPSHOT_PACKED_PEOPLE === '1' });
    app = createApp({ store, manual: true, deployment: true, commit, password: process.env.CARTA_PASSWORD,
      credentialPath: resolve(dataPath, 'access.scrypt'), origin, extraOrigins, secure,
      params: paramsNuevosDeDespliegue, ...v21 });
    if (!app.usaMotor) {
      if (!ley(app.world, 'guardadoCompleto')) setParams(app.world, deploymentParams(paramsOf(app.world)));
      const motor = paramsOf(app.world).motor;
      if ((motor.hilos > 1 || motor.gpu.length > 0) && !worldContext(app.world).tileOwnership) {
        const tileOwnership = new ResidentTopologyOwner();
        app.world.tiles = tileOwnership.tiles(app.world.tiles.map(t => tileOwnership.tile(t)));
        bindWorldContext(app.world, { ...worldContext(app.world), tileOwnership });
      }
      console.info(JSON.stringify({ v15: resumenDespacho(app.world) }));
    }
  }
  if (abortado || !app) await shutdown(abortado ? undefined : 1);
  else {
    if (!conWorker) escuchar(app);
    app.start();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'No se pudo iniciar el mundo.');
  await shutdown(1);
}
