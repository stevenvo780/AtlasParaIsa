import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cerrarPiscinasDeComputo, createApp } from './app.js';
import { createWorkerGateway } from './gateway.js';
import { Store } from './store.js';
import { acquireLock } from './lock.js';
import { paramsOf, setParams } from '../world/params.js';
import { deploymentParams } from './deployment-params.js';
import { hostFullHardwareParams, hostOpenWorldParams, hostParams } from './hardware-limits.js';
import { gpuParitySession } from '../world/gpu/autoprueba.js';
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
// ritmo normal; `CARTA_OBSERVER_ONLY=1` quita las órdenes directas a los habitantes.
const tapeMaxFrames = enteroPositivo('CARTA_TAPE_MAX_FRAMES');
const tapeKeyframeInterval = enteroPositivo('CARTA_TAPE_KEYFRAME_INTERVAL');
const v21 = {
  ...(process.env.CARTA_TURBO === '1' ? { turbo: true, tape: true, tickMs: 0 } : {}),
  ...(process.env.CARTA_TAPE === '1' ? { tape: true } : {}),
  ...(process.env.CARTA_OBSERVER_ONLY === '1' ? { observerOnly: true } : {}),
  ...(tapeMaxFrames === undefined ? {} : { tapeMaxFrames }),
  ...(tapeKeyframeInterval === undefined ? {} : { tapeKeyframeInterval }),
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
/** `shutdown` puede entrar por señal mientras el `await` de la autoprueba sigue en curso. */
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
try {
  if (process.env.CARTA_SIM_WORKER === '1') {
    const pasarela = createWorkerGateway({ worldPath: resolve(dataPath, 'world.sqlite'), manual: true, deployment: true, commit,
      password: process.env.CARTA_PASSWORD, credentialPath: resolve(dataPath, 'access.scrypt'), origin, extraOrigins, secure, ...v21 });
    // Un worker caído deja el transporte sirviendo un espejo fosilizado para siempre: se sale con 75
    // y systemd reinicia el servicio sobre el último guardado.
    pasarela.events.on('workerError', (error: unknown) => {
      console.error(`El hilo de simulación cayó (${error instanceof Error ? error.message : String(error)}); salgo con 75 para que el servicio reinicie.`);
      process.exit(75);
    });
    app = pasarela;
    await app.ready;
  } else {
  store = new Store(resolve(dataPath, 'world.sqlite'));
  if (!abortado) {
    // Los params llegan ANTES de que `createApp` genere un mundo nuevo (R6: `agua.cuencas`
    // decide el terreno en la generación, así que fijarlos después no servía de nada).
    // `CARTA_OPEN_WORLD=1` activa evolución abierta V12 + todos los chips (CPU+GPU);
    // `CARTA_FULL_HARDWARE=1` activa solo el despacho multi-chip sobre las leyes base.
    // Orden de un mundo NUEVO: host (límites + motor + leyes abiertas) → `deploymentParams`
    // (`PRODUCTION_PARAMS` y, encima, cada clave de `CARTA_PARAMS`). Un mundo CARGADO no
    // vuelve a resolver el host: solo cede en las claves que `CARTA_PARAMS` nombra.
    const baseHostParams = () => process.env.CARTA_OPEN_WORLD === '1'
      ? hostOpenWorldParams()
      : process.env.CARTA_FULL_HARDWARE === '1'
        ? hostFullHardwareParams()
        : hostParams();
    // `manual: true` mantiene el bucle parado mientras terminan `setParams`, `tileOwnership` y la
    // autoprueba CUDA: con un mundo grande, arrancar `stepWorld` antes de `gpuParitySession.initialize`
    // bloqueaba el hilo principal 4–5 s y hacía caducar el presupuesto de autoprueba en RTX 5070 Ti.
    app = createApp({ store, manual: true, commit, password: process.env.CARTA_PASSWORD, credentialPath: resolve(dataPath, 'access.scrypt'), origin, extraOrigins, secure, params: () => deploymentParams(baseHostParams()), ...v21 });
    // Precedencia: un mundo cargado trae los params de su instantánea y esta línea aplica
    // ENCIMA la configuración explícita del despliegue, solo en las claves que nombra.
    // Los límites del host NO vuelven a resolverse aquí: los del mundo cargado son los suyos.
    setParams(app.world, deploymentParams(paramsOf(app.world)));
    const motor = paramsOf(app.world).motor;
    if ((motor.hilos > 1 || motor.gpu.length > 0) && !worldContext(app.world).tileOwnership) {
      const tileOwnership = new ResidentTopologyOwner();
      app.world.tiles = tileOwnership.tiles(app.world.tiles.map(t => tileOwnership.tile(t)));
      bindWorldContext(app.world, { ...worldContext(app.world), tileOwnership });
    }
    const vivo = app;
    for (const device of motor.gpu) {
      if (abortado) break;
      const parity = await gpuParitySession.initialize(device, { budgetMs: 5000, log: diagnostic => console.warn(JSON.stringify(diagnostic)) });
      console.info(JSON.stringify({ gpuAutoprueba: parity, v15: resumenDespacho(vivo.world) }));
    }
    if (!abortado && motor.gpu.length === 0) console.info(JSON.stringify({ gpuAutoprueba: null, v15: resumenDespacho(vivo.world) }));
  }
  }
  if (abortado || !app) await shutdown(abortado ? undefined : 1);
  else {
    const escuchando = app;
    escuchando.start();
    escuchando.server.on('error', () => { console.error('No se pudo abrir el servicio. Revisa dirección y puerto.'); void shutdown(1); });
    escuchando.server.listen(port, host, () => console.log(`Carta disponible en ${[origin, ...extraOrigins].join(', ')}; acceso privado requerido.`));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'No se pudo iniciar el mundo.');
  await shutdown(1);
}
