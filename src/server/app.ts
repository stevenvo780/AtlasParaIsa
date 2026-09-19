import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { isIP } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { createWorld, stepWorld, projectWorld, normalizeViewport, cloneWorld, personDetail, type World } from '../world/index.js';
import { paramsOf } from '../world/params.js';
import { technologyRecipeDetail } from '../world/technology.js';
import type { ClientMessage, Gesture, GestureResult, ServerMessage, Viewport, WorldView, RuntimeStats } from '../shared/types.js';
import { Store, fingerprint, GestureConflict, SessionRevoked } from './store.js';
import { cookie, hashToken, makeToken, passwordVerifier, sessionHash } from './auth.js';
import { ensureWorldInstance, readWorldInstance } from './world-instance.js';

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export interface AppOptions {
  store: Store; password?: string; credentialPath?: string; origin: string;
  secure?: boolean; staticDir?: string; tickMs?: number; seed?: number; manual?: boolean;
}
type Pending = { gesture: Gesture; hash: string; resolve: (r: GestureResult) => void; reject: (e: Error) => void; promise: Promise<GestureResult> };
export function parseGesture(value: unknown): Gesture {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Gesto no válido.');
  const g = value as Record<string, unknown>;
  if (typeof g.id !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(g.id) || typeof g.kind !== 'string' || !['plant', 'invite', 'remember', 'command'].includes(g.kind) ||
    !Number.isInteger(g.x) || !Number.isInteger(g.y) || (g.x as number) < -10_000_000 || (g.y as number) < -10_000_000 || (g.x as number) >= 10_000_000 || (g.y as number) >= 10_000_000 ||
    (g.memoryId !== undefined && (typeof g.memoryId !== 'string' || g.memoryId.length > 80)) ||
    (g.kind === 'command' && (typeof g.agentId !== 'string' || g.agentId.length > 50 || typeof g.order !== 'string' || !['move','explore','gather','farm','build','rest','hunt','drink','cooperate','invent','repair','research','craft','forage','auto'].includes(g.order))) || (g.kind !== 'command' && (g.agentId !== undefined || g.order !== undefined)) ||
    Object.keys(g).some(k => !['id', 'kind', 'x', 'y', 'memoryId', 'agentId', 'order'].includes(k))) throw new HttpError(400, 'La forma o el destino del gesto no es válido.');
  return { id: g.id, kind: g.kind as Gesture['kind'], x: g.x as number, y: g.y as number, ...(g.memoryId === undefined ? {} : { memoryId: g.memoryId as string }), ...(g.kind === 'command' ? { agentId: g.agentId as string, order: g.order as Gesture['order'] } : {}) };
}
async function body(req: IncomingMessage) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Se requiere JSON.');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new HttpError(413, 'Solicitud demasiado grande.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new HttpError(400, 'JSON no válido.'); }
}
function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data));
}
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// El despliegue real (atlas-servidor) escucha en la IP de malla (HOST=100.64.0.1) y el peer
// que ve el socket es el Caddy del VPS por la malla (100.64.0.11), NO loopback: por eso el
// conjunto de proxies de confianza es configurable con CARTA_PROXY_IP (lista separada por
// comas), y no solo loopback. Ver hallazgo C7 / revisión T023.
export function trustedProxiesFromEnv(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const extra = (env.CARTA_PROXY_IP ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return extra.length ? new Set([...LOOPBACK, ...extra]) : LOOPBACK;
}
// El último token de X-Forwarded-For es el que añade el proxy de confianza más cercano
// (asumiendo que AÑADE, no reemplaza, la cadena); el primer token lo controla el cliente y
// no debe usarse como clave del limitador (permitiría evadirlo rotando el valor).
function lastForwardedFor(xff: string | string[]): string | undefined {
  const raw = Array.isArray(xff) ? xff.join(',') : xff;
  const parts = raw.split(',');
  return parts[parts.length - 1]?.trim() || undefined;
}
export function loginKey(remoteAddress: string | undefined, xff: string | string[] | undefined, trusted: ReadonlySet<string> = LOOPBACK): string {
  if (xff !== undefined && remoteAddress !== undefined && trusted.has(remoteAddress)) {
    const candidate = lastForwardedFor(xff);
    if (candidate && isIP(candidate) !== 0) return candidate;
  }
  return remoteAddress ?? 'local';
}
export function rate(map: Map<string, { count: number; reset: number }>, key: string, max: number, interval: number) {
  const now = Date.now();
  for (const [k, v] of map) if (v.reset <= now) map.delete(k);
  const row = map.get(key) ?? { count: 0, reset: now + interval };
  if (map.size >= 2048 && !map.has(key)) throw new HttpError(429, 'Demasiadas solicitudes. Intenta más tarde.');
  row.count++; map.set(key, row);
  if (row.count > max) throw new HttpError(429, 'Espera un momento antes de intentarlo de nuevo.');
}
/**
 * Ruling R17: decisión del gobernador, aislada y pura para poder verificarla sin reloj.
 * Por encima del presupuesto se apaga; por debajo del 70 % se reenciende; en la banda
 * muerta [0,7·P, P] se conserva el estado vigente — esa histéresis evita oscilar.
 */
export function decideReproduction(p95StepMs: number, presupuestoMs: number, actual: boolean): boolean {
  if (p95StepMs > presupuestoMs) return false;
  if (p95StepMs < presupuestoMs * 0.7) return true;
  return actual;
}

export function createApp(options: AppOptions) {
  const { store } = options;
  const verifyPassword = passwordVerifier(options);
  const origin = new URL(options.origin).origin;
  if (options.secure && !origin.startsWith('https://')) throw new Error('Private hosted access requires an HTTPS origin.');
  const loaded = store.load();
  const existingInstanceId = readWorldInstance(store.db);
  let world = loaded?.world ?? createWorld(options.seed ?? 51926);
  if (loaded) {
    world.events.push({ id: `pause-${world.tick}-${makeToken().slice(0,12)}`, tick: world.tick, kind: 'pause', actors: [],
      text: 'El servicio estuvo en pausa. El mundo retoma desde su último momento guardado.', cause: 'Reinicio del servicio; sin avance retrospectivo.', source: 'simulation' });
    world.events = world.events.slice(-120);
  }
  store.save(world);
  const instanceId = existingInstanceId ?? ensureWorldInstance(store.db);
  let stopped = false;
  let failed = false;
  const pending = new Map<string, Pending>();
  // T024 (P1): `subscribeMs` es la cadencia mínima que un cliente pidió (móvil observador) —
  // 0 = sin pedido, se manda con la cadencia normal. `lastBroadcastAt` la hace cumplir en `broadcast`.
  const clients = new Map<WebSocket, { hash: string; alive: boolean; messages: number; window: number; viewport?: Viewport; lastView?: WorldView; subscribeMs: number; lastBroadcastAt: number }>();
  const loginAttempts = new Map<string, { count: number; reset: number }>();
  const gestureAttempts = new Map<string, { count: number; reset: number }>();
  const loginGlobal = new Map<string, { count: number; reset: number }>();
  const trustedProxies = trustedProxiesFromEnv();
  const ws = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const staticDir = resolve(options.staticDir ?? 'dist/client');
  const context = store.context;
  const measurements: number[] = [];
  const beats: number[] = [];
  const runtime: RuntimeStats = { stepMs: 0, p95StepMs: 0, saveMs: 0, projectionMs: 0, snapshotBytes: 0, activeTiles: world.tiles.length, processRssMiB: process.memoryUsage.rss() / 1048576, tickHz: 0,
    gobernador: { activo: world.reproductionEnabled, presupuestoMs: paramsOf(world).gobernador.presupuestoMs, p95StepMs: 0, manual: null } };
  /**
   * Ruling R17: la población la limita el HARDWARE, no un tope fijo. Tras medir el paso,
   * el gobernador compara el p95 (ventana de 120 pasos) con `gobernador.presupuestoMs`:
   * por encima apaga la reproducción, por debajo del 70 % la reenciende. La histéresis
   * (0,7) evita que el mundo oscile en el filo del presupuesto.
   *
   * Una orden humana manda siempre: mientras `runtime.gobernador.manual` no sea `null`,
   * el gobernador observa y publica el p95 pero no toca `reproductionEnabled`.
   */
  function governReproduction(draft: World): void {
    const stats = runtime.gobernador!;
    stats.presupuestoMs = paramsOf(draft).gobernador.presupuestoMs;
    stats.p95StepMs = runtime.p95StepMs;
    if (stats.manual !== null) { draft.reproductionEnabled = stats.manual; stats.activo = stats.manual; return; }
    // Sin medición todavía (primer paso) no se afirma nada sobre el hardware.
    if (measurements.length > 0) draft.reproductionEnabled = decideReproduction(runtime.p95StepMs, stats.presupuestoMs, draft.reproductionEnabled);
    stats.activo = draft.reproductionEnabled;
  }
  const view = (viewport?: Viewport) => {
    const start = performance.now(), projected = projectWorld(world, viewport, context);
    runtime.projectionMs = performance.now() - start;
    return { ...projected, instanceId, performance: { ...runtime }, ...(failed ? { paused: true, pauseReason: 'No se pudo guardar. El mundo está en pausa para proteger lo ya vivido.' } : {}) };
  };
  function authorized(req: IncomingMessage) {
    const hash = sessionHash(req);
    if (!hash || !store.sessionValid(hash)) throw new HttpError(401, 'Entra con la contraseña de la carta.');
    return hash;
  }
  function checkOrigin(req: IncomingMessage) {
    if (req.headers.origin !== origin) throw new HttpError(403, 'Origen no autorizado.');
  }
  function send(socket: WebSocket, message: ServerMessage) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 2 * 1024 * 1024) { socket.terminate(); return; }
    if (socket.bufferedAmount > 256 * 1024 && message.type === 'state') return;
    socket.send(JSON.stringify(message));
  }
  function broadcast() {
    const now = Date.now();
    for (const [socket, client] of clients) {
      if (!store.sessionValid(client.hash)) { socket.close(4001, 'La sesión terminó.'); continue; }
      // T024 (P1): un cliente suscrito con `intervaloMs` no recibe empujes más seguido que eso.
      if (client.subscribeMs && now - client.lastBroadcastAt < client.subscribeMs) continue;
      sendView(socket);
    }
  }
  function sendView(socket: WebSocket) {
    const client = clients.get(socket); if (!client) return;
    try {
      const projected = view(client.viewport);
      client.lastView = projected;
      client.lastBroadcastAt = Date.now();
      send(socket, { type: 'state', world: projected });
    } catch {
      // A camera read is not a simulation transaction. Never retry the failing archive in a fallback.
      send(socket, { type: 'error', message: 'No se pudo leer esa región guardada. Elige otra zona; su estado se conserva para recuperación.' });
    }
  }
  function requestGesture(gesture: Gesture, hash: string): Promise<GestureResult> {
    if (!store.sessionValid(hash)) throw new HttpError(401, 'La sesión terminó.');
    let saved: GestureResult | null;
    try { saved = store.result(gesture); }
    catch (error) { if (error instanceof GestureConflict) throw new HttpError(409, error.message); throw error; }
    if (saved) return Promise.resolve(saved);
    if (failed || stopped) throw new HttpError(503, 'El mundo está en pausa. Este gesto sigue sin confirmación.');
    const existing = pending.get(gesture.id);
    if (existing) {
      if (fingerprint(existing.gesture) !== fingerprint(gesture)) throw new HttpError(409, 'Ese identificador ya se usó para otro gesto.');
      return existing.promise;
    }
    rate(gestureAttempts, hash, 64, 10_000);
    if (pending.size >= 32) throw new HttpError(429, 'Hay varios gestos en camino. Espera un momento.');
    let resolve!: Pending['resolve'], reject!: Pending['reject'];
    const promise = new Promise<GestureResult>((yes, no) => { resolve = yes; reject = no; });
    pending.set(gesture.id, { gesture, hash, resolve, reject, promise });
    return promise;
  }
  function stepOnce() {
    if (failed || stopped) return;
    const stepStarted = performance.now();
    // Ritmo real en reloj de pared sobre los últimos 120 pasos: lo que de verdad
    // avanza el mundo, no el intervalo pedido. Sin pasos previos no se afirma nada.
    beats.push(stepStarted); if (beats.length > 120) beats.shift();
    const span = beats.length > 1 ? beats[beats.length - 1]! - beats[0]! : 0;
    runtime.tickHz = span > 0 ? (beats.length - 1) * 1000 / span : 0;
    const batch = [...pending.values()];
    const valid: Pending[] = [];
    try {
      for (const [socket, client] of clients) if (!store.sessionValid(client.hash)) socket.close(4001, 'La sesión terminó.');
      for (const item of batch) {
        if (store.sessionValid(item.hash)) valid.push(item);
        else { item.reject(new HttpError(401, 'La sesión terminó antes de aplicar el gesto.')); pending.delete(item.gesture.id); }
      }
      const draft = cloneWorld(world, context);
      const results = stepWorld(draft, valid.map(item => item.gesture), context);
      if (results.length !== valid.length) throw new Error('Gesture result count mismatch');
      // C3/C12: persistir es una transacción por cadencia, no por tick. Un gesto
      // confirmado nunca espera: obliga a guardar en su propio paso. Lo que se
      // arriesga entre guardados son los pasos de la cadencia, jamás un gesto.
      if (valid.length > 0 || draft.tick % paramsOf(draft).persistencia.cadaTicks === 0) {
        const saveStarted = performance.now();
        store.save(draft, valid.map((item, i) => ({ gesture: item.gesture, result: results[i] })), valid.map(item => item.hash));
        runtime.saveMs = performance.now() - saveStarted;
      }
      world = draft;
      runtime.stepMs = performance.now() - stepStarted; measurements.push(runtime.stepMs); if (measurements.length > 120) measurements.shift();
      runtime.p95StepMs = [...measurements].sort((a, b) => a - b)[Math.floor(measurements.length * 0.95)] ?? 0;
      // El gobernador decide sobre el mundo ya vigente: la próxima `reproduce()` lo lee.
      governReproduction(world);
      runtime.activeTiles = world.tiles.length; runtime.processRssMiB = process.memoryUsage.rss() / 1048576; runtime.snapshotBytes = store.lastSnapshotBytes;
      for (let i=0; i<valid.length; i++) { pending.delete(valid[i].gesture.id); valid[i].resolve(results[i]); }
      if (world.tick % 5 === 0 || valid.length) broadcast();
    } catch (error) {
      if (error instanceof SessionRevoked) {
        for (const item of pending.values()) if (!store.sessionValid(item.hash)) {
          item.reject(new HttpError(401, 'La sesión terminó antes de guardar el gesto.')); pending.delete(item.gesture.id);
        }
        return;
      }
      failed = true;
      for (const item of pending.values()) item.reject(new HttpError(503, 'No se pudo guardar; el gesto no fue confirmado.'));
      pending.clear();
      // Do not log snapshots, inputs, or personal content on failure.
      for (const socket of clients.keys()) {
        send(socket, { type: 'error', message: 'No se pudo guardar. El mundo está en pausa.' });
        const previous = clients.get(socket)?.lastView;
        if (previous) send(socket, { type: 'state', world: { ...previous, paused: true, pauseReason: 'El mundo está en pausa: no se pudo confirmar el siguiente paso. Se muestra el último estado recibido.' } });
      }
    }
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (options.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(req.url ?? '/', origin);
      if (req.headers.host !== new URL(origin).host) throw new HttpError(403, 'Host no autorizado.');
      if (req.method === 'GET' && url.pathname === '/health') return json(res, failed ? 503 : 200, { status: failed ? 'paused' : 'ok' });
      if (req.method === 'GET' && url.pathname === '/api/session') {
        const hash = sessionHash(req);
        return json(res, 200, { authenticated: !!hash && store.sessionValid(hash) });
      }
      if (req.method === 'POST') checkOrigin(req);
      if (req.method === 'POST' && url.pathname === '/api/login') {
        rate(loginAttempts, loginKey(req.socket.remoteAddress, req.headers['x-forwarded-for'], trustedProxies), 6, 60_000);
        // Cortafuegos ante una avalancha real, no un segundo límite por-persona: con el cupo
        // por clave (6/60s) ya aplicado arriba, 600/60s solo actúa si hay ~100 claves distintas
        // atacando a la vez. Un umbral bajo (p. ej. 60) repetía el daño de C7: cualquier tercero
        // sin sesión bloqueaba a la dueña de la carta.
        rate(loginGlobal, '*', 600, 60_000);
        const value = await body(req) as { password?: unknown } | null;
        if (!value || typeof value.password !== 'string' || !verifyPassword(value.password)) throw new HttpError(401, 'La contraseña no coincide.');
        const oldHash = sessionHash(req); if (oldHash) store.revoke(oldHash);
        const token = makeToken(); store.addSession(hashToken(token), Date.now() + 14 * 86400_000);
        res.setHeader('Set-Cookie', cookie(token, !!options.secure));
        return json(res, 200, { ok: true });
      }
      if (url.pathname.startsWith('/api/')) {
        const hash = authorized(req);
        if (req.method === 'POST' && url.pathname === '/api/logout') {
          store.revoke(hash); res.setHeader('Set-Cookie', cookie('', !!options.secure, 0));
          for (const [socket, client] of clients) if (client.hash === hash) socket.close(4001, 'La sesión terminó.');
          return json(res, 200, { ok: true });
        }
        if (req.method === 'GET' && url.pathname === '/api/world') {
          let viewport: Viewport | undefined;
          if (url.search) {
            try { viewport = normalizeViewport({ x: Number(url.searchParams.get('x')), y: Number(url.searchParams.get('y')), width: Number(url.searchParams.get('width')), height: Number(url.searchParams.get('height')) }); }
            catch { throw new HttpError(400, 'Ventana de cámara no válida.'); }
          }
          return json(res, 200, view(viewport));
        }
        if (req.method === 'POST' && url.pathname === '/api/gesture') {
          const gesture = parseGesture(await body(req));
          return json(res, 200, await requestGesture(gesture, hash));
        }
        throw new HttpError(404, 'Ruta no encontrada.');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método no permitido.');
      const path = resolve(staticDir, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      const mimes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
      if (!path.startsWith(staticDir + sep) || !mimes[extname(path)]) throw new HttpError(404, 'Ruta no encontrada.');
      let content: Buffer;
      try { if (!statSync(path).isFile()) throw new Error(); content = readFileSync(path); }
      catch { throw new HttpError(404, 'La interfaz aún no está compilada. Ejecuta npm run build.'); }
      res.writeHead(200, { 'Content-Type': mimes[extname(path)] }); res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!res.headersSent) json(res, error instanceof HttpError ? error.status : 503, { error: error instanceof HttpError ? error.message : 'El servicio no pudo completar la solicitud.' });
      else res.end();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.on('upgrade', (req, socket, head) => {
    try {
      checkOrigin(req);
      if (req.url !== '/ws' || req.headers.host !== new URL(origin).host) throw new HttpError(403, 'Ruta no autorizada.');
      const hash = authorized(req);
      if (clients.size >= 12) throw new HttpError(429, 'Demasiadas conexiones.');
      ws.handleUpgrade(req, socket, head, client => {
        clients.set(client, { hash, alive: true, messages: 0, window: Date.now(), subscribeMs: 0, lastBroadcastAt: 0 });
        client.on('error', () => client.terminate());
        client.on('pong', () => { const info = clients.get(client); if (info) info.alive = true; });
        client.on('close', () => clients.delete(client));
        client.on('message', async (data, binary) => {
          try {
            const info = clients.get(client)!;
            if (!store.sessionValid(hash)) { client.close(4001, 'La sesión terminó.'); return; }
            if (Date.now() - info.window >= 10_000) { info.window = Date.now(); info.messages = 0; }
            if (++info.messages > 120) { client.close(4008, 'Demasiados mensajes.'); return; }
            if (binary) throw new HttpError(400, 'Se requiere JSON.');
            const parsed = JSON.parse(data.toString()) as Partial<ClientMessage> & { gesture?: unknown; viewport?: Viewport; id?: unknown; intervaloMs?: unknown };
            if (parsed?.type === 'viewport') {
              try { info.viewport = normalizeViewport(parsed.viewport); } catch { throw new HttpError(400, 'Ventana de cámara no válida.'); }
              sendView(client); return;
            }
            // T036(h): one inhabitant's biography at a time, read-only; the snapshot no longer carries it.
            if (parsed?.type === 'persona') {
              if (typeof parsed.id !== 'string' || !/^[A-Za-z0-9_:-]{1,50}$/.test(parsed.id)) throw new HttpError(400, 'Identificador de habitante no válido.');
              send(client, { type: 'persona', id: parsed.id, persona: personDetail(world, parsed.id) ?? null });
              return;
            }
            // One definition at a time, read-only: the snapshot carries summaries and this query never advances the world.
            if (parsed?.type === 'recipe') {
              if (typeof parsed.id !== 'string' || !/^recipe-[1-9]\d{0,9}$/.test(parsed.id)) throw new HttpError(400, 'Identificador de procedimiento no válido.');
              send(client, { type: 'recipe', id: parsed.id, recipe: technologyRecipeDetail(world, parsed.id) ?? null });
              return;
            }
            if (parsed?.type === 'suscripcion') {
              // Modo ligero móvil (P1): el cliente pide una cadencia más espaciada; 1000 ms es el piso.
              if (typeof parsed.intervaloMs !== 'number' || !Number.isFinite(parsed.intervaloMs) || parsed.intervaloMs < 0) throw new HttpError(400, 'Intervalo de suscripción no válido.');
              info.subscribeMs = Math.max(1000, Math.floor(parsed.intervaloMs));
              return;
            }
            if (!parsed || parsed.type !== 'gesture') throw new HttpError(400, 'Mensaje desconocido.');
            const result = await requestGesture(parseGesture(parsed.gesture), hash);
            if (store.sessionValid(hash)) send(client, { type: 'result', result });
          } catch (error) { send(client, { type: 'error', message: error instanceof HttpError ? error.message : 'No se pudo aplicar el gesto.' }); }
        });
        sendView(client);
      });
    } catch (error) { socket.end(`HTTP/1.1 ${error instanceof HttpError ? error.status : 503} Rejected\r\nConnection: close\r\n\r\n`); }
  });
  // Planificador con compensación de deriva: el próximo paso se cita en `next +=
  // tickMs`, no «tickMs después de terminar», así un paso lento no desplaza para
  // siempre el reloj del mundo. Tras una pausa larga se recita, nunca se recupera
  // el retraso con una ráfaga de pasos: el mundo no salta hacia atrás ni adelante.
  const tickMs = options.tickMs ?? 100;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let next = performance.now() + tickMs;
  function schedule() {
    timer = setTimeout(() => {
      next += tickMs;
      stepOnce();
      // El corte se juzga DESPUÉS del paso: un paso que duró más que el intervalo
      // vuelve a citarse, nunca dispara una ráfaga para «recuperar» lo perdido.
      const now = performance.now();
      if (next < now) next = now + tickMs;
      if (!stopped) schedule();
    }, Math.max(0, next - performance.now()));
    timer.unref();
  }
  if (!options.manual) schedule();
  const heartbeat = setInterval(() => {
    for (const [socket, client] of clients) {
      if (!client.alive || !store.sessionValid(client.hash)) { socket.terminate(); continue; }
      client.alive = false; socket.ping();
    }
  }, 20_000);
  heartbeat.unref();
  return {
    server, stepOnce, get world() { return world; }, get failed() { return failed; },
    /** Copia de las métricas vivas (incluido el gobernador de ruling R17); solo lectura. */
    get runtime(): RuntimeStats { return { ...runtime, ...(runtime.gobernador ? { gobernador: { ...runtime.gobernador } } : {}) }; },
    /** Orden humana sobre la reproducción: manda sobre el gobernador. `null` la devuelve al hardware. */
    setReproduccionManual(value: boolean | null) { runtime.gobernador!.manual = value; if (value !== null) { world.reproductionEnabled = value; runtime.gobernador!.activo = value; } },
    async close() {
      stopped = true; if (timer) clearTimeout(timer); clearInterval(heartbeat);
      for (const item of pending.values()) item.reject(new HttpError(503, 'El servicio se está cerrando.'));
      pending.clear(); for (const socket of clients.keys()) socket.terminate(); ws.close();
      if (server.listening) await new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes()));
    }
  };
}
