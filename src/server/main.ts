import { resolve } from 'node:path';
import { createApp } from './app.js';
import { Store } from './store.js';
import { acquireLock } from './lock.js';

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
  const app = createApp({ store, password: process.env.CARTA_PASSWORD, credentialPath: resolve(dataPath, 'access.scrypt'), origin, secure });
  let closing = false;
  const shutdown = async () => {
    if (closing) return; closing = true;
    await app.close(); store!.close(); unlock();
  };
  process.once('SIGINT', () => void shutdown()); process.once('SIGTERM', () => void shutdown());
  app.server.on('error', async () => { console.error('No se pudo abrir el servicio. Revisa dirección y puerto.'); await shutdown(); process.exitCode = 1; });
  app.server.listen(port, host, () => console.log(`Carta disponible en ${origin}; acceso privado requerido.`));
} catch (error) {
  store?.close(); unlock();
  console.error(error instanceof Error ? error.message : 'No se pudo iniciar el mundo.'); process.exitCode = 1;
}
