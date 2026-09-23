import { once } from 'node:events';
import { createServer } from 'node:net';

/** Un puerto TCP libre en 127.0.0.1: lo reserva el sistema, se cierra y se devuelve. Entre el cierre y
 * el `listen` del llamador otro proceso podría ocuparlo; para una prueba local basta. La copia de
 * tests/connection.test.ts se migra en la ola 2 (la rama viva noche-wsfix toca ese fichero). */
export async function freePort(): Promise<number> {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}
