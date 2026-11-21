import { resolve } from 'node:path';
import { createApp } from './app.js';
import { Store } from './store.js';
import { acquireLock } from './lock.js';
import { paramsOf, setParams } from '../world/params.js';
import { deploymentParams } from './deployment-params.js';
import { hostFullHardwareParams, hostOpenWorldParams, hostParams } from './hardware-limits.js';
import { gpuParitySession } from '../world/gpu/autoprueba.js';
import { closeEcosystemWorkers } from '../world/ecosystem.js';
import { bindWorldContext, closeFaunaParallelPools, closePersonasParallelPools, closePolicyGpuBatchers, worldContext } from '../world/index.js';
import { ResidentTopologyOwner } from '../world/soa/topologia.js';

process.umask(0o077);
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT no válido.');
const host = process.env.HOST ?? '127.0.0.1';
const origin = process.env.CARTA_ORIGIN ?? `http://127.0.0.1:${port}`;
const secure = origin.startsWith('https://');
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !secure) throw new Error('Configura CARTA_ORIGIN con HTTPS antes de escuchar fuera de loopback.');
const dataPath = resolve(process.env.CARTA_DATA_DIR ?? 'data');
const unlock = acquireLock(resolve(dataPath, 'world.lock'));
let store: Store | undefined;
try {
  store = new Store(resolve(dataPath, 'world.sqlite'));
  // Los params llegan ANTES de que `createApp` genere un mundo nuevo (R6: `agua.cuencas`
  // decide el terreno en la generación, así que fijarlos después no servía de nada).
  // `CARTA_OPEN_WORLD=1` activa evolución abierta V12 + todos los chips (CPU+GPU);
  // `CARTA_FULL_HARDWARE=1` activa solo el despacho multi-chip sobre las leyes base.
  const baseHostParams = () => process.env.CARTA_OPEN_WORLD === '1'
    ? hostOpenWorldParams()
    : process.env.CARTA_FULL_HARDWARE === '1'
      ? hostFullHardwareParams()
      : hostParams();
  const app = createApp({ store, password: process.env.CARTA_PASSWORD, credentialPath: resolve(dataPath, 'access.scrypt'), origin, secure, params: () => deploymentParams(baseHostParams()) });
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
  for (const device of motor.gpu) {
    const parity = await gpuParitySession.initialize(device, { log: diagnostic => console.warn(JSON.stringify(diagnostic)) });
    console.info(JSON.stringify({ gpuAutoprueba: parity }));
  }
  let closing = false;
  const shutdown = async () => {
    if (closing) return; closing = true;
    await app.close();
    closePolicyGpuBatchers();
    await closeFaunaParallelPools();
    await closePersonasParallelPools();
    await closeEcosystemWorkers();
    store!.close(); unlock();
  };
  process.once('SIGINT', () => void shutdown()); process.once('SIGTERM', () => void shutdown());
  app.server.on('error', async () => { console.error('No se pudo abrir el servicio. Revisa dirección y puerto.'); await shutdown(); process.exitCode = 1; });
  app.server.listen(port, host, () => console.log(`Carta disponible en ${origin}; acceso privado requerido.`));
} catch (error) {
  store?.close(); unlock();
  console.error(error instanceof Error ? error.message : 'No se pudo iniciar el mundo.'); process.exitCode = 1;
}
