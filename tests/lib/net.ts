import { once } from 'node:events';
import { createServer } from 'node:net';

/** Un puerto TCP libre en 127.0.0.1: lo reserva el sistema, se cierra y se devuelve. Entre el cierre y
 * el `listen` del llamador otro proceso podría ocuparlo; para una prueba local basta. */
export async function freePort(): Promise<number> {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

/** Espera a que `condition()` sea cierta, sondeando cada `everyMs`, o falla tras `timeoutMs`. */
export async function until(condition: () => boolean, message: string, timeoutMs = 2000, everyMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Plazo de ${timeoutMs} ms agotado: ${message}`);
    await new Promise(resolve => setTimeout(resolve, everyMs));
  }
}
