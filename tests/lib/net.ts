import { once } from 'node:events';
import { createServer } from 'node:net';
import type { WebSocket } from 'ws';

/** Un puerto TCP libre en 127.0.0.1: lo reserva el sistema, se cierra y se devuelve. Entre el cierre y
 * el `listen` del llamador otro proceso podría ocuparlo; para una prueba local basta. La copia de
 * tests/connection.test.ts se migra en la ola 2 (la rama viva noche-wsfix toca ese fichero). */
export async function freePort(): Promise<number> {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

/** El pong llega después de los mensajes ya encolados en ambos sentidos. */
export async function barreraWs(socket: WebSocket): Promise<void> {
  const abortar = new AbortController();
  const alCerrar = () => abortar.abort(new Error('El WebSocket se cerró antes del pong.'));
  socket.once('close', alCerrar);
  try {
    const pong = once(socket, 'pong', { signal: abortar.signal });
    socket.ping(undefined, undefined, error => { if (error) abortar.abort(error); });
    await pong;
  } finally { socket.off('close', alCerrar); }
}
