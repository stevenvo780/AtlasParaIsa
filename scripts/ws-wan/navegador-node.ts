/** Lo mínimo del navegador que usa `src/client/connection.ts` (`location`, `window`, `WebSocket`,
 * `fetch`), sobre Node, para correr el cliente REAL contra un servidor propio — normalmente a través
 * de un `Enlace` que limita el ancho de banda. Hace lo que hace un navegador y nada más:
 *
 *   - `WebSocket`: ofrece permessage-deflate (todo navegador lo ofrece; decide el servidor), manda
 *     Host/Origin/Cookie de la página y entrega texto como `string`, marco a marco.
 *   - `fetch`: rutas relativas a la página, `Accept-Encoding: gzip, deflate` y descompresión
 *     transparente, Origin en lo que no es GET, y `signal` que aborta de verdad la petición.
 *
 * Es global (como en un navegador): un proceso = una página. Para varias a la vez, un proceso por
 * página (lo hace `scripts/ws-wan/banco.ts`).
 */
import { request } from 'node:http';
import { gunzipSync, inflateSync } from 'node:zlib';
import { WebSocket as NodeWebSocket } from 'ws';

export interface Pagina {
  /** Host que el servidor espera (el de su `origin`), p. ej. `atlas-wan.test` o `127.0.0.1:3000`. */
  host: string;
  origin: string;
  /** `nombre=valor` de la cookie de sesión. */
  cookie: string;
  /** Adónde se conecta de verdad (el enlace o el servidor). */
  puerto: number;
  /** Cada marco WS recibido (bytes UTF-8 del texto, ya descomprimido) y cada respuesta HTTP. */
  registro?: (evento: EventoPagina) => void;
}
export type EventoPagina =
  | { t: number; ev: 'marco'; socket: number; bytes: number; texto: string }
  | { t: number; ev: 'ws-crea' | 'ws-abre'; socket: number; url: string }
  | { t: number; ev: 'ws-cierra'; socket: number; code: number }
  | { t: number; ev: 'http'; ruta: string; status: number; ms: number; bytesCable: number }
  | { t: number; ev: 'http-fallo'; ruta: string; ms: number; motivo: string };

export function instalarNavegador(pagina: Pagina): { window: EventTarget; restaurar: () => void } {
  const previos = {
    fetch: globalThis.fetch, WebSocket: globalThis.WebSocket,
    location: Object.getOwnPropertyDescriptor(globalThis, 'location'), window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
  };
  const win = new EventTarget();
  let sockets = 0;
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'http:', host: pagina.host } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });

  class SocketDeNavegador {
    static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    private readonly inner: NodeWebSocket;
    readonly id = ++sockets;
    constructor(url: string) {
      const u = new URL(url);
      pagina.registro?.({ t: Date.now(), ev: 'ws-crea', socket: this.id, url: `${u.pathname}${u.search}` });
      this.inner = new NodeWebSocket(`ws://127.0.0.1:${pagina.puerto}${u.pathname}${u.search}`, {
        headers: { Host: pagina.host, Origin: pagina.origin, Cookie: pagina.cookie }, perMessageDeflate: true,
      });
      this.inner.on('open', () => { pagina.registro?.({ t: Date.now(), ev: 'ws-abre', socket: this.id, url: `${u.pathname}${u.search}` }); this.onopen?.({ type: 'open' }); });
      this.inner.on('message', (data: Buffer, binary: boolean) => {
        const texto = binary ? '' : data.toString('utf8');
        pagina.registro?.({ t: Date.now(), ev: 'marco', socket: this.id, bytes: data.length, texto });
        this.onmessage?.({ data: texto });
      });
      this.inner.on('error', () => this.onerror?.({ type: 'error' }));
      this.inner.on('close', (code: number, reason: Buffer) => { pagina.registro?.({ t: Date.now(), ev: 'ws-cierra', socket: this.id, code }); this.onclose?.({ code, reason: reason.toString() }); });
    }
    get readyState(): number { return this.inner.readyState; }
    /** Puerto local del socket TCP (para unir con lo que ve el servidor). */
    get puertoLocal(): number | undefined { return (this.inner as unknown as { _socket?: { localPort?: number } })._socket?.localPort; }
    send(data: string): void { this.inner.send(data); }
    close(code?: number, reason?: string): void {
      // Un navegador que cierra un socket aún sin abrir lo da por fallido (1006), sin excepción.
      if (this.inner.readyState === NodeWebSocket.CONNECTING) { this.inner.terminate(); return; }
      this.inner.close(code, reason);
    }
  }
  globalThis.WebSocket = SocketDeNavegador as unknown as typeof WebSocket;

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const ruta = typeof input === 'string' ? input : input instanceof URL ? `${input.pathname}${input.search}` : new URL(input.url).pathname;
    const method = init?.method ?? 'GET';
    const t0 = Date.now();
    return new Promise<Response>((resolve, reject) => {
      const headers: Record<string, string> = { Host: pagina.host, Cookie: pagina.cookie, 'Accept-Encoding': 'gzip, deflate', ...(init?.headers as Record<string, string> | undefined) };
      if (method !== 'GET' && method !== 'HEAD') headers.Origin = pagina.origin;
      const req = request({ host: '127.0.0.1', port: pagina.puerto, path: ruta, method, agent: false, headers }, res => {
        const trozos: Buffer[] = [];
        res.on('data', (c: Buffer) => trozos.push(c));
        res.on('error', reject);
        res.on('end', () => {
          signal?.removeEventListener('abort', abortar);
          const cable = Buffer.concat(trozos);
          const encoding = String(res.headers['content-encoding'] ?? '');
          let cuerpo: Buffer;
          try { cuerpo = encoding === 'gzip' ? gunzipSync(cable) : encoding === 'deflate' ? inflateSync(cable) : cable; }
          catch (error) { reject(error); return; }
          pagina.registro?.({ t: Date.now(), ev: 'http', ruta, status: res.statusCode ?? 0, ms: Date.now() - t0, bytesCable: cable.length });
          resolve(new Response(res.statusCode === 204 ? null : cuerpo.toString('utf8'), { status: res.statusCode, headers: { 'Content-Type': String(res.headers['content-type'] ?? 'application/octet-stream') } }));
        });
      });
      const signal = init?.signal;
      const abortar = () => {
        pagina.registro?.({ t: Date.now(), ev: 'http-fallo', ruta, ms: Date.now() - t0, motivo: 'abortada' });
        req.destroy(); reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      };
      if (signal?.aborted) { abortar(); return; }
      signal?.addEventListener('abort', abortar, { once: true });
      req.on('error', error => { pagina.registro?.({ t: Date.now(), ev: 'http-fallo', ruta, ms: Date.now() - t0, motivo: error.message }); reject(error); });
      req.end(typeof init?.body === 'string' ? init.body : undefined);
    });
  }) as typeof fetch;

  return {
    window: win,
    restaurar() {
      globalThis.fetch = previos.fetch; globalThis.WebSocket = previos.WebSocket;
      for (const clave of ['location', 'window'] as const) {
        const d = previos[clave];
        if (d) Object.defineProperty(globalThis, clave, d); else Reflect.deleteProperty(globalThis, clave);
      }
    },
  };
}
