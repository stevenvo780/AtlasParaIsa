import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { isIP } from 'node:net';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { createWorld, stepWorld, projectWorld, normalizeViewport, cloneWorld, puntoDeRestauracion, personDetail, fraccionSerial, type PuntoDeRestauracion, type World, type FaseMedicion } from '../world/index.js';
import { paramsOf, type WorldParams } from '../world/params.js';
import { technologyRecipeDetail } from '../world/technology.js';
import type { ClientMessage, Gesture, GestureResult, ServerMessage, Viewport, WorldView, RuntimeStats, FaseNombre } from '../shared/types.js';
import { Store, fingerprint, GestureConflict, SessionRevoked } from './store.js';
import { cookie, hashToken, makeToken, passwordVerifier, sessionHash } from './auth.js';
import { ensureWorldInstance, readWorldInstance } from './world-instance.js';
import { Gobernador } from './governor.js';
export { decideReproduction, decidirConTecho } from './governor.js';

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export interface AppOptions {
  store: Store; password?: string; credentialPath?: string; origin: string;
  secure?: boolean; staticDir?: string; tickMs?: number; seed?: number; manual?: boolean;
  /** Params con los que se GENERA un mundo nuevo (R6: antes llegaban después de que
   * `createApp` ya hubiera generado el terreno). Un mundo cargado conserva los suyos,
   * los de su instantánea; quien quiera imponerlos llama `setParams` después.
   * Una función se evalúa SOLO si no hay mundo que cargar (T100, fase 4b): así el
   * resolver de límites del host no se consulta en `load`, `previous` ni migración. */
  params?: WorldParams | (() => WorldParams);
  /** Instance-local monotonic clock; tests can measure work without patching global timers. */
  monotonicNow?: () => number;
  /** T136: permite alternar la compresión del `WebSocketServer` sin editar este fichero
   * entre corridas del banco (`scripts/benchmark-ws-deflate.ts`). `true` comprime todo
   * mensaje a todo cliente (lo que midió T136), `false` no negocia compresión. Sin valor
   * (producción): se negocia y solo se comprimen los `state` hacia clientes con acuse
   * (`/ws?ack=1`); ver `compresion` en `createApp`, con la cifra medida. */
  perMessageDeflate?: boolean;
}
type Compresion = 'nunca' | 'flujo' | 'siempre';
/** Contrapresión por cliente (2026-09-22, «por el dominio siempre dice sin conexión»). */
interface Flujo {
  /** El `state` enviado y aún sin acuse. Nunca hay más de uno. */
  enVuelo: { sequence: number; sentAt: number; bytes: number } | null;
  /** Hubo una difusión o un cambio de cámara mientras había un `state` en vuelo: al llegar el
   * acuse se proyecta y se manda el mundo de ESE momento, no los intermedios. */
  pendiente: boolean;
  enviados: number; aplazados: number; acuses: number;
  /** Del último acuse: cuánto tardó el `state` en salir, cruzar el enlace y volver confirmado. */
  ultimoAcuseMs: number | null;
}
type ClienteWs = {
  hash: string; alive: boolean; messages: number; window: number; viewport?: Viewport; lastView?: WorldView;
  subscribeMs: number; lastBroadcastAt: number;
  /** Último envío de cualquier mensaje: decide cuándo toca un latido de aplicación. */
  lastSentAt: number;
  /** `null` = cliente sin acuse (pestaña con el cliente anterior): conserva el camino de siempre. */
  flujo: Flujo | null;
};
/** Estadística de un socket vivo, para bancos y pruebas; no expone sesión ni contenido. */
export interface FlujoCliente { remotePort: number | null; acuse: boolean; subscribeMs: number; enVuelo: boolean; enviados: number; aplazados: number; acuses: number; ultimoAcuseMs: number | null; bufferedAmount: number }
/** Un `state` más largo que esto (unidades UTF-16 del JSON) viaja en trozos hacia `/ws?ack=1`. */
export const TROZO_WS = 64 * 1024;
/** Trozo cuando se comprime: cada mensaje comprimido cuesta al menos dos idas y vueltas por el hilo
 * principal (escribir y vaciar el deflate del threadpool), y con el hilo ocupado por pasos seguidos
 * cada una espera un paso entero. Menos trozos y más grandes: 256 Ki unidades comprimen a ~35 KiB,
 * que a 0,1 Mbit/s siguen llegando en ~3 s, lejos de los 8 s de silencio del cliente. */
export const TROZO_WS_COMPRIMIDO = 256 * 1024;
/** Sin nada que mandar durante este tiempo (y sin `state` en vuelo), el servidor manda un latido.
 * Holgado frente a los 8 s de silencio que tolera `src/client/connection.ts`. */
export const LATIDO_WS_MS = 3000;
/** Parte `text` en trozos de a lo sumo `size` unidades sin separar nunca un par sustituto
 * (un trozo con medio carácter no sería UTF-8 válido y el navegador cerraría la conexión). */
export function trocear(text: string, size = TROZO_WS): string[] {
  const partes: string[] = [];
  for (let i = 0; i < text.length;) {
    let fin = Math.min(text.length, i + size);
    if (fin < text.length) { const c = text.charCodeAt(fin - 1); if (c >= 0xd800 && c <= 0xdbff) fin--; }
    partes.push(text.slice(i, fin)); i = fin;
  }
  return partes;
}
const CAMARA_WS = ['x', 'y', 'width', 'height'] as const;
/** `/ws` (cliente anterior, sin acuse) o `/ws?ack=1[&x=&y=&width=&height=]` (cliente con acuse; la
 * cámara en la URL evita mandar primero la vista por defecto). Cualquier otra cosa se rechaza. */
export function solicitudWs(url: string | undefined): { acuse: boolean; viewport?: Viewport } {
  const raw = url ?? '', q = raw.indexOf('?');
  if ((q < 0 ? raw : raw.slice(0, q)) !== '/ws') throw new HttpError(403, 'Ruta no autorizada.');
  if (q < 0) return { acuse: false };
  const params = new URLSearchParams(raw.slice(q + 1));
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length || keys.some(k => k !== 'ack' && !(CAMARA_WS as readonly string[]).includes(k)) || params.get('ack') !== '1') throw new HttpError(403, 'Ruta no autorizada.');
  const camara = CAMARA_WS.filter(k => params.has(k));
  if (!camara.length) return { acuse: true };
  if (camara.length !== CAMARA_WS.length || CAMARA_WS.some(k => !/^-?\d{1,8}$/.test(params.get(k)!))) throw new HttpError(400, 'Ventana de cámara no válida.');
  try { return { acuse: true, viewport: normalizeViewport({ x: Number(params.get('x')), y: Number(params.get('y')), width: Number(params.get('width')), height: Number(params.get('height')) }) }; }
  catch { throw new HttpError(400, 'Ventana de cámara no válida.'); }
}
/** El acuse que libera el `state` en vuelo: exactamente `{type:'ack', sequence}` con SU secuencia. */
function esAcuse(data: RawData, sequence: number): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(data.toString()); } catch { return false; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const m = parsed as Record<string, unknown>;
  return m.type === 'ack' && m.sequence === sequence && Object.keys(m).length === 2;
}
const gzipAsync = promisify(gzip);
function aceptaGzip(req: IncomingMessage): boolean {
  const header = req.headers['accept-encoding'];
  if (typeof header !== 'string') return false;
  return header.split(',').some(part => { const [token, ...rest] = part.trim().split(';'); return token!.trim().toLowerCase() === 'gzip' && !rest.some(p => /^\s*q\s*=\s*0(\.0*)?\s*$/.test(p)); });
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
export function createApp(options: AppOptions) {
  const { store } = options;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const verifyPassword = passwordVerifier(options);
  const origin = new URL(options.origin).origin;
  if (options.secure && !origin.startsWith('https://')) throw new Error('Private hosted access requires an HTTPS origin.');
  const loaded = store.load();
  const existingInstanceId = readWorldInstance(store.db);
  let world = loaded?.world ?? createWorld(options.seed ?? 51926, typeof options.params === 'function' ? options.params() : options.params);
  // Arrancar desde un respaldo es un retroceso: la crónica que Isa lee no puede decir que
  // el mundo «retoma desde su último momento guardado», y el operador tiene que ver que el
  // eslabón vigente está podrido. El retroceso solo se puede medir en tiempo de servicio:
  // el cuerpo que superaba al respaldo es ilegible, así que sus pasos no se saben.
  const respaldo = loaded && loaded.slot > 0
    ? { slot: loaded.slot, retrocesoSegundos: loaded.supersededAt === null ? null : Math.max(0, Math.round((loaded.supersededAt - loaded.savedAt) / 1000)) }
    : null;
  if (respaldo) console.warn(`El último momento guardado no se pudo leer; el mundo arranca desde el respaldo ${respaldo.slot}`
    + `${respaldo.retrocesoSegundos === null ? '' : `, ${respaldo.retrocesoSegundos} s atrás`}. Motivo: ${loaded!.skipped.join('; ')}.`);
  if (loaded) {
    // Sin número cuando la fila del eslabón dañado ni siquiera estaba: decirlo sin cifra
    // es honesto; inventarla, no. En pasos nunca se puede medir (el cuerpo es ilegible).
    const perdido = respaldo === null ? '' : respaldo.retrocesoSegundos === null
      ? 'lo simulado después de él' : `lo simulado en los ${respaldo.retrocesoSegundos} s siguientes`;
    world.events.push({ id: `pause-${world.tick}-${makeToken().slice(0,12)}`, tick: world.tick, kind: 'pause', actors: [],
      text: respaldo ? 'El servicio estuvo en pausa. El último momento guardado no se pudo leer y el mundo retoma desde un respaldo anterior.'
        : 'El servicio estuvo en pausa. El mundo retoma desde su último momento guardado.',
      cause: respaldo ? `Reinicio del servicio; se adoptó el respaldo ${respaldo.slot} de la cadena y se perdió ${perdido}.`
        : 'Reinicio del servicio; sin avance retrospectivo.', source: 'simulation' });
    world.events = world.events.slice(-120);
  }
  store.save(world);
  const instanceId = existingInstanceId ?? ensureWorldInstance(store.db);
  let stopped = false;
  let failed = false;
  const pending = new Map<string, Pending>();
  // T024 (P1): `subscribeMs` es la cadencia mínima que un cliente pidió (móvil observador) —
  // 0 = sin pedido, se manda con la cadencia normal. `lastBroadcastAt` la hace cumplir en `broadcast`.
  const clients = new Map<WebSocket, ClienteWs>();
  const loginAttempts = new Map<string, { count: number; reset: number }>();
  const gestureAttempts = new Map<string, { count: number; reset: number }>();
  const loginGlobal = new Map<string, { count: number; reset: number }>();
  const trustedProxies = trustedProxiesFromEnv();
  // T136: medido con `scripts/benchmark-ws-deflate.ts` (12 clientes, viewport 40x28,
  // 1000 pasos, esta torre, 2026-09-22): comprimir TODO a TODOS ahorra 88.7% de bytes
  // (650.9 MB -> 73.3 MB) pero cuesta +15.3 s de CPU de proceso y +58.8 ms de p95 SOLO
  // en el paso que difunde. Eso sigue valiendo para `perMessageDeflate: true`.
  // Contrapresión (2026-09-22, `scripts/ws-wan/`): por el dominio un `state` de escritorio
  // pesa ~733 KiB y a ~2 states/s pide 12 Mbit/s por visor; comprimido a nivel 3 baja a
  // ~105 KiB (7×) por ~3,6 ms de CPU del threadpool de libuv (no del hilo del paso;
  // `scripts/ws-wan/coste-deflate.ts`). Por eso, por defecto, se negocia la compresión
  // pero solo se comprimen los `state` hacia clientes con acuse, cuyo ritmo ya lo acota
  // lo que su enlace drena (a lo sumo uno en vuelo). El cliente anterior sin acuse sigue
  // recibiendo texto plano, como antes.
  const compresion: Compresion = options.perMessageDeflate === undefined ? 'flujo' : options.perMessageDeflate ? 'siempre' : 'nunca';
  const ws = new WebSocketServer({ noServer: true, maxPayload: 4096,
    // `chunkSize` 128 KiB: la salida de un trozo (~35 KiB) cabe en un solo viaje al threadpool
    // (con los 16 KiB por defecto, zlib vuelve al hilo principal por cada 16 KiB de salida).
    perMessageDeflate: compresion === 'nunca' ? false : compresion === 'siempre' ? true : { zlibDeflateOptions: { level: 3, chunkSize: 128 * 1024 } } });
  const staticDir = resolve(options.staticDir ?? 'dist/client');
  const context = store.context;
  const gobernador = new Gobernador();
  const beats: number[] = [];
  // T107: nombres fijos de `FaseNombre`, listados una vez para no repetir el literal en cada
  // reinicio del registro (uno nuevo por paso; nunca se reutiliza el del paso anterior).
  const FASE_NOMBRES: readonly FaseNombre[] = ['maintainRegions', 'ecologia', 'kernel', 'fauna', 'personas', 'encuentros', 'demografia', 'comunidades', 'reproduccion', 'checkpoint', 'muestreo', 'save', 'broadcast'];
  const fasesEnCero = (): Record<FaseNombre, number> => Object.fromEntries(FASE_NOMBRES.map(nombre => [nombre, 0])) as Record<FaseNombre, number>;
  const runtime: RuntimeStats = { stepMs: 0, p95StepMs: 0, cloneMs: 0, simulationMs: 0, saveMs: 0, projectionMs: 0, snapshotBytes: 0, activeTiles: world.tiles.length, processRssMiB: process.memoryUsage.rss() / 1048576, tickHz: 0,
    fases: fasesEnCero(), fraccionSerial: 0,
    gobernador: { activo: world.reproductionEnabled, presupuestoMs: paramsOf(world).gobernador.presupuestoMs, p95StepMs: 0, manual: null,
      politica: paramsOf(world).gobernador.politica, techo: null, techoObservado: null } };
  /**
   * Ruling R17: la población la limita el HARDWARE, no un tope fijo. Tras medir el paso,
   * el gobernador compara el p95 (ventana de 120 pasos) con `gobernador.presupuestoMs`.
   * La política la elige `gobernador.politica` (ver `governor.ts`): `apagar` (2026-09-19,
   * apaga por encima y reenciende bajo el 70 %) o `techo` (default desde 2026-09-22: por
   * encima solo se repone, no se crece). La histéresis (0,7) evita oscilar en el filo.
   *
   * Una orden humana manda siempre: mientras `runtime.gobernador.manual` no sea `null`,
   * el gobernador observa y publica el p95 pero no toca `reproductionEnabled`.
   */
  function governReproduction(draft: World): void {
    const stats = runtime.gobernador!, params = paramsOf(draft).gobernador;
    stats.presupuestoMs = params.presupuestoMs; stats.politica = params.politica;
    stats.p95StepMs = runtime.p95StepMs;
    if (stats.manual !== null) { draft.reproductionEnabled = stats.manual; stats.activo = stats.manual; return; }
    draft.reproductionEnabled = gobernador.decidir(params, draft.reproductionEnabled, draft.people.length, draft.tiles.length, draft.tick);
    stats.techo = gobernador.estado.techo; stats.techoObservado = gobernador.techoObservado;
    stats.activo = draft.reproductionEnabled;
  }
  const view = (viewport?: Viewport) => {
    const start = monotonicNow(), projected = projectWorld(world, viewport, context);
    runtime.projectionMs = monotonicNow() - start;
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
  /** Único punto de salida: registra el último envío (para el latido). Los mensajes pequeños no
   * se comprimen salvo con `perMessageDeflate: true` (T136). */
  function emitir(socket: WebSocket, text: string, compress: boolean) {
    socket.send(text, { compress: compress || compresion === 'siempre' });
    const client = clients.get(socket); if (client) client.lastSentAt = Date.now();
  }
  /** Corte de seguridad ante un par que no lee: más de 2 MiB retenidos por `ws` además del `state`
   * en vuelo (con acuse, uno como mucho; sin acuse, ninguno cuenta: la regla de siempre). */
  function saturado(socket: WebSocket): boolean {
    return socket.bufferedAmount > 2 * 1024 * 1024 + (clients.get(socket)?.flujo?.enVuelo?.bytes ?? 0);
  }
  function send(socket: WebSocket, message: ServerMessage) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (saturado(socket)) { socket.terminate(); return; }
    if (message.type === 'state') { sendState(socket, message.world); return; }
    emitir(socket, JSON.stringify(message), false);
  }
  /** Un `state` hacia `socket`.
   *
   * Sin acuse (cliente anterior): lo de siempre — se descarta si `ws` retiene más de 256 KiB. Esa
   * regla no ve el búfer de envío del kernel (hasta 4 MiB) ni los del VPS: por un enlace más lento
   * que la demanda el retraso crecía hasta 10–30 s y el latido de 20 s acababa cortando.
   *
   * Con acuse: nunca más de un `state` en vuelo. Si el anterior aún no llegó, se apunta que hay uno
   * más reciente y se manda al llegar su acuse (`liberar`): el ritmo lo pone lo que el enlace de ESE
   * cliente drena y lo que recibe siempre es el mundo más reciente. `forzar` salta la espera: solo
   * para el aviso terminal de pausa, tras el cual no habrá más difusiones. */
  function sendState(socket: WebSocket, world: WorldView, forzar = false) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (saturado(socket)) { socket.terminate(); return; }
    const flujo = clients.get(socket)?.flujo;
    if (!flujo) {
      if (socket.bufferedAmount > 256 * 1024) return;
      emitir(socket, JSON.stringify({ type: 'state', world } satisfies ServerMessage), false);
      return;
    }
    if (flujo.enVuelo && !forzar) { flujo.pendiente = true; flujo.aplazados++; return; }
    const text = JSON.stringify({ type: 'state', world } satisfies ServerMessage);
    const compress = compresion !== 'nunca';
    const trozo = compress ? TROZO_WS_COMPRIMIDO : TROZO_WS;
    if (text.length <= trozo) emitir(socket, text, compress);
    else {
      // Todos los trozos se encolan en este mismo turno: ningún otro mensaje puede colarse entre ellos.
      const partes = trocear(text, trozo);
      emitir(socket, JSON.stringify({ type: 'trozos', partes: partes.length } satisfies ServerMessage), false);
      for (const parte of partes) emitir(socket, parte, compress);
    }
    flujo.enVuelo = { sequence: world.sequence, sentAt: monotonicNow(), bytes: Buffer.byteLength(text) };
    flujo.pendiente = false; flujo.enviados++;
  }
  /** Llegó el acuse del `state` en vuelo: si mientras tanto hubo difusión o cámara nueva, se manda
   * ya el mundo de ahora (uno solo, por muchas difusiones que se hayan saltado). */
  function liberar(socket: WebSocket, flujo: Flujo) {
    const enVuelo = flujo.enVuelo!;
    flujo.enVuelo = null; flujo.acuses++;
    flujo.ultimoAcuseMs = monotonicNow() - enVuelo.sentAt;
    if (flujo.pendiente) sendView(socket);
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
    // Con un `state` en vuelo no se proyecta: se proyectará el mundo de cuando llegue el acuse.
    if (client.flujo?.enVuelo) { client.flujo.pendiente = true; client.flujo.aplazados++; return; }
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
    const stepStarted = monotonicNow();
    runtime.cloneMs = 0; runtime.simulationMs = 0; runtime.saveMs = 0;
    // Ritmo real en reloj de pared sobre los últimos 120 pasos: lo que de verdad
    // avanza el mundo, no el intervalo pedido. Sin pasos previos no se afirma nada.
    beats.push(stepStarted); if (beats.length > 120) beats.shift();
    const span = beats.length > 1 ? beats[beats.length - 1]! - beats[0]! : 0;
    runtime.tickHz = span > 0 ? (beats.length - 1) * 1000 / span : 0;
    const batch = [...pending.values()];
    const valid: Pending[] = [];
    // T104: sin clon, el paso corre sobre el mundo vigente y la atomicidad la sostiene esto.
    let punto: PuntoDeRestauracion | null = null;
    try {
      for (const [socket, client] of clients) if (!store.sessionValid(client.hash)) socket.close(4001, 'La sesión terminó.');
      for (const item of batch) {
        if (store.sessionValid(item.hash)) valid.push(item);
        else { item.reject(new HttpError(401, 'La sesión terminó antes de aplicar el gesto.')); pending.delete(item.gesture.id); }
      }
      const cloneStarted = monotonicNow();
      // T104. `motor.clonPorPaso=true` (default) conserva el camino de hoy: se simula sobre un
      // clon y el mundo vigente no se toca hasta que el guardado confirma. En `false` se toma un
      // punto de restauración y se simula sobre el mundo vigente; `cloneMs` mide lo que costó
      // reservar la vuelta atrás, que es lo que sustituye al clon.
      const clonar = paramsOf(world).motor.clonPorPaso;
      if (!clonar) punto = puntoDeRestauracion(world);
      const draft = clonar ? cloneWorld(world, context) : world;
      runtime.cloneMs = monotonicNow() - cloneStarted;
      const simulationStarted = monotonicNow();
      // T107: `medicion.fases` empieza vacío en cada paso (nunca se arrastra el del anterior).
      // Reloj propio, **no** `monotonicNow`: perfilar por fase es observabilidad de hardware
      // real, nunca la variable de la que dependen las cuentas exactas de paso/gobernador con
      // reloj inyectado en pruebas (`tests/gobernador.test.ts`); compartir el contador falso
      // haría que instrumentar sumara ticks fantasma a `simulationMs`/`stepMs`.
      const medicion: FaseMedicion = { clock: () => performance.now(), fases: {} };
      const results = stepWorld(draft, valid.map(item => item.gesture), context, medicion);
      runtime.simulationMs = monotonicNow() - simulationStarted;
      if (results.length !== valid.length) throw new Error('Gesture result count mismatch');
      // C3/C12: persistir es una transacción por cadencia, no por tick. Un gesto
      // confirmado nunca espera: obliga a guardar en su propio paso. Lo que se
      // arriesga entre guardados son los pasos de la cadencia, jamás un gesto.
      if (valid.length > 0 || draft.tick % paramsOf(draft).persistencia.cadaTicks === 0) {
        const saveStarted = monotonicNow();
        store.save(draft, valid.map((item, i) => ({ gesture: item.gesture, result: results[i] })), valid.map(item => item.hash));
        runtime.saveMs = monotonicNow() - saveStarted;
      }
      world = draft;
      runtime.stepMs = monotonicNow() - stepStarted;
      runtime.p95StepMs = gobernador.registrar(runtime.stepMs);
      // El gobernador decide sobre el mundo ya vigente: la próxima `reproduce()` lo lee.
      governReproduction(world);
      runtime.activeTiles = world.tiles.length; runtime.processRssMiB = process.memoryUsage.rss() / 1048576; runtime.snapshotBytes = store.lastSnapshotBytes;
      for (let i=0; i<valid.length; i++) { pending.delete(valid[i].gesture.id); valid[i].resolve(results[i]); }
      // T107: `broadcast` mide su propio tramo porque corre después de que `stepMs` ya cerró
      // (siempre corrió así; instrumentarlo no adelanta ni retrasa el envío ni cambia su cadencia).
      // Reloj real, no `monotonicNow` — mismo motivo que `medicion` arriba.
      const fases = fasesEnCero();
      Object.assign(fases, medicion.fases, { save: runtime.saveMs });
      if (world.tick % 5 === 0 || valid.length) {
        const broadcastStarted = performance.now();
        broadcast();
        fases.broadcast = performance.now() - broadcastStarted;
      }
      runtime.fases = fases;
      runtime.fraccionSerial = fraccionSerial(fases);
    } catch (error) {
      // T104: deshacer va PRIMERO, y vale para las dos salidas. Sin clon, llegar aquí significa
      // que el mundo vigente está a medio paso; un mundo que no se pudo deshacer ya no puede
      // seguir avanzando aunque el error fuera recuperable.
      let restaurado = true;
      if (punto) { try { punto.restaurar(); } catch { restaurado = false; } }
      if (restaurado && error instanceof SessionRevoked) {
        // La sesión se revocó entre aceptar el gesto y confirmarlo: el mundo no avanza con un
        // gesto aplicado y no guardado, así que este paso queda deshecho y se reintenta el siguiente.
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
        // Terminal: no habrá más difusiones, así que no espera al acuse del `state` en vuelo.
        if (previous) sendState(socket, { ...previous, paused: true, pauseReason: 'El mundo está en pausa: no se pudo confirmar el siguiente paso. Se muestra el último estado recibido.' }, true);
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
      if (req.method === 'GET' && url.pathname === '/health') return json(res, failed ? 503 : 200, { status: failed ? 'paused' : 'ok', ...(respaldo ? { respaldo } : {}) });
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
          // Sin comprimir pesaba 0,45–1,4 MB y el cliente lo aborta a los 10 s: por un enlace lento
          // la reconexión fallaba en bucle. gzip lo deja ~8× menor y corre en el threadpool.
          if (!aceptaGzip(req)) return json(res, 200, view(viewport));
          const cuerpo = await gzipAsync(Buffer.from(JSON.stringify(view(viewport))), { level: 3 });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
          return res.end(cuerpo);
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
      if (req.headers.host !== new URL(origin).host) throw new HttpError(403, 'Ruta no autorizada.');
      const solicitud = solicitudWs(req.url);
      const hash = authorized(req);
      if (clients.size >= 12) throw new HttpError(429, 'Demasiadas conexiones.');
      ws.handleUpgrade(req, socket, head, client => {
        clients.set(client, { hash, alive: true, messages: 0, window: Date.now(), subscribeMs: 0, lastBroadcastAt: 0, lastSentAt: Date.now(),
          ...(solicitud.viewport ? { viewport: solicitud.viewport } : {}),
          flujo: solicitud.acuse ? { enVuelo: null, pendiente: false, enviados: 0, aplazados: 0, acuses: 0, ultimoAcuseMs: null } : null });
        client.on('error', () => client.terminate());
        client.on('pong', () => { const info = clients.get(client); if (info) info.alive = true; });
        client.on('close', () => clients.delete(client));
        client.on('message', async (data, binary) => {
          try {
            const info = clients.get(client)!;
            // Cualquier mensaje prueba que el par vive: el pong puede venir detrás de un `state` grande.
            info.alive = true;
            if (!store.sessionValid(hash)) { client.close(4001, 'La sesión terminó.'); return; }
            if (Date.now() - info.window >= 10_000) { info.window = Date.now(); info.messages = 0; }
            // El acuse que libera el `state` en vuelo no gasta cupo: cada uno responde a un `state`
            // que el servidor eligió mandar. Un acuse suelto o repetido sí cuenta (y no libera nada).
            if (!binary && info.flujo?.enVuelo && esAcuse(data, info.flujo.enVuelo.sequence)) { liberar(client, info.flujo); return; }
            if (++info.messages > 120) { client.close(4008, 'Demasiados mensajes.'); return; }
            if (binary) throw new HttpError(400, 'Se requiere JSON.');
            const parsed = JSON.parse(data.toString()) as Partial<ClientMessage> & { gesture?: unknown; viewport?: Viewport; id?: unknown; intervaloMs?: unknown };
            if (parsed?.type === 'ack') return;
            if (parsed?.type === 'viewport') {
              try { info.viewport = normalizeViewport(parsed.viewport); } catch { throw new HttpError(400, 'Ventana de cámara no válida.'); }
              // Con acuse, si hay un `state` en vuelo esto solo lo apunta: al llegar el acuse sale uno
              // con la cámara más reciente, por muchas que hayan llegado entretanto.
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
  let next = monotonicNow() + tickMs;
  function schedule() {
    timer = setTimeout(() => {
      next += tickMs;
      stepOnce();
      // El corte se juzga DESPUÉS del paso: un paso que duró más que el intervalo
      // vuelve a citarse, nunca dispara una ráfaga para «recuperar» lo perdido.
      const now = monotonicNow();
      if (next < now) next = now + tickMs;
      if (!stopped) schedule();
    }, Math.max(0, next - monotonicNow()));
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
  // Latido de aplicación: sin él, un mundo en pausa (sin difusiones) o una suscripción lenta dejaban
  // al cliente 8 s sin noticias y lo mostraban «Sin conexión». Nunca se encola detrás de un `state`
  // en vuelo: ahí lo que demuestra que la conexión vive son sus trozos.
  const latido = setInterval(() => {
    const now = Date.now();
    for (const [socket, client] of clients) {
      if (socket.readyState !== WebSocket.OPEN || now - client.lastSentAt < LATIDO_WS_MS) continue;
      if (client.flujo ? client.flujo.enVuelo : socket.bufferedAmount > 0) continue;
      emitir(socket, JSON.stringify({ type: 'latido' } satisfies ServerMessage), false);
    }
  }, 1000);
  latido.unref();
  return {
    server, stepOnce, get world() { return world; }, get failed() { return failed; },
    /** Contrapresión por socket vivo (bancos y pruebas). */
    get flujo(): FlujoCliente[] {
      return [...clients].map(([socket, c]) => ({ remotePort: (socket as unknown as { _socket?: { remotePort?: number } })._socket?.remotePort ?? null,
        acuse: !!c.flujo, subscribeMs: c.subscribeMs, enVuelo: !!c.flujo?.enVuelo, enviados: c.flujo?.enviados ?? 0, aplazados: c.flujo?.aplazados ?? 0,
        acuses: c.flujo?.acuses ?? 0, ultimoAcuseMs: c.flujo?.ultimoAcuseMs ?? null, bufferedAmount: socket.bufferedAmount }));
    },
    /** Copia de las métricas vivas (incluido el gobernador de ruling R17); solo lectura. */
    get runtime(): RuntimeStats { return { ...runtime, ...(runtime.gobernador ? { gobernador: { ...runtime.gobernador } } : {}) }; },
    /** Orden humana sobre la reproducción: manda sobre el gobernador. `null` la devuelve al hardware. */
    setReproduccionManual(value: boolean | null) { runtime.gobernador!.manual = value; if (value !== null) { world.reproductionEnabled = value; runtime.gobernador!.activo = value; } },
    async close() {
      stopped = true; if (timer) clearTimeout(timer); clearInterval(heartbeat); clearInterval(latido);
      for (const item of pending.values()) item.reject(new HttpError(503, 'El servicio se está cerrando.'));
      pending.clear(); for (const socket of clients.keys()) socket.terminate(); ws.close();
      if (server.listening) await new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes()));
    }
  };
}
