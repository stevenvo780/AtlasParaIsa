import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve, extname, sep } from 'node:path';
import { isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { gzip, gzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { TICKS_PER_DAY, createWorld, stepWorld, submitWhisper, validateWhisper, projectWorld, normalizeViewport, cloneWorld, puntoDeRestauracion, fraccionSerial, bindWorldContext, worldContext, closeFaunaParallelPools, closePersonasParallelPools, closePolicyGpuBatchers, type PuntoDeRestauracion, type World, type FaseMedicion } from '../world/index.js';
import { closeEcosystemWorkers } from '../world/ecosystem.js';
import { ResidentTopologyOwner } from '../world/soa/topologia.js';
import { dispositivosGpuApagados } from '../world/ecosystem-kernel.js';
import { gpuNvrtcAvailable } from '../world/gpu/puente.js';
import { calcularFraccionSerialReal } from '../world/paralelo/piscina.js';
export { aceleracionAmdahlTeorica } from '../world/paralelo/piscina.js';
import { paramsOf, type WorldParams } from '../world/params.js';
import { technologyRecipeDetail } from '../world/technology.js';
import { technologyCatalogueNearCapacity } from '../world/technology-catalogue.js';
import { technologyJournalNearCapacity } from '../world/technology-journal.js';
import { chronicleJournalNearCapacity } from '../world/chronicle-journal.js';
import type { ClientMessage, Gesture, GestureResult, ServerMessage, Tile, Viewport, WorldView, RuntimeStats, FaseNombre } from '../shared/types.js';
import { computeStateDelta } from '../shared/deltas.js';
import { Store, fingerprint, GestureConflict, SessionRevoked } from './store.js';
import { Muestreador } from './diagnostico.js';
import { cookie, hashToken, makeToken, passwordVerifier, sessionHash } from './auth.js';
import { ensureWorldInstance, readWorldInstance } from './world-instance.js';
import { enriquecerPersona } from './persona-extra.js';
import { CADA_PASOS, resumenVivo } from './resumen-vivo.js';
import { clavesVivasEn } from './regiones-vivas.js';
import { TapeReader, TapeWriter, tapePathForWorld } from './tape-store.js';
import { captureReplayChange, type SnapshotReplayChange } from './snapshot.js';
import type { TapeChunkEncoding, TapeChunkResponse, TapeMetaResponse } from '../shared/tape.js';
import type { Chunk } from '../world/terrain.js';
import { createTileObserver, projectMirrorTile, projectMirrorWorld, projectTapeFrame, tapeKeyframeDue, TURBO_MIRROR_MS } from './sim-worker.js';
import { parseWhisperRequest, whisperView } from '../world/whispers.js';
import { buildWorldDirectory, encodeChunkMinimapCells, WorldMapCache } from './worldmap-service.js';
import type { DivineWhisper, DivineWhisperRequest, WorldDirectoryResponse, WorldMapChunkSummary, WorldMapResponse } from '../shared/worldmap.js';
export class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export interface AppOptions {
  store: Store; password?: string; credentialPath?: string; origin: string;
  commit?: string;
  /** Orígenes HTTPS adicionales permitidos explícitamente por el operador (p. ej. acceso LAN/VPN).
   * Nunca relajan la validación: cada solicitud debe emparejar exactamente Host ↔ Origin. */
  extraOrigins?: readonly string[];
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
   * (`/ws?ack=1`) cuyo enlace no es de LAN; ver `compresion` en `createApp`, con la cifra. */
  perMessageDeflate?: boolean;
  /** Worker lifecycle hooks; never change simulation inputs or arithmetic. `afterStep` receives the
   * live simulation rate (EMA of steps per wall-clock second). Returning false from beforeStep
   * yields one scheduling turn for bounded recorder backpressure without dropping a tick. */
  beforeStep?: () => void | boolean;
  afterStep?: (simHz: number) => void;
  /** Salida del proceso cuando el paso ya no puede atravesar el tick guardado (código 75:
   * systemd reinicia sobre ese mismo guardado). Por defecto `process.exit`; las pruebas la
   * sustituyen para observar la salida sin morirse. */
  onFatalExit?: (code: number) => void;
  /** V21: uncapped loop. `tickMs = 0` (also implied by `tickMs: 0`): one step per `setImmediate`,
   * never an idle sleep, so I/O still interleaves between steps. Steps never clone the world. */
  turbo?: boolean;
  /** Minimum wall-clock spacing of routine turbo saves; gestures and close always persist. */
  turboSaveIntervalMs?: number;
  /** V21: record the DVR tape and serve `/api/tape/*` (defaults to `turbo`). In `createApp` the
   * app owns the writer; behind the worker gateway a dedicated tape thread owns it. */
  tape?: boolean;
  tapeMaxFrames?: number;
  tapeKeyframeInterval?: number;
  /** V21: observer-only mode. Inhabitants act autonomously: direct NPC orders are rejected (410). */
  observerOnly?: boolean;
}
/** Segundos sin completar un paso tras los cuales el mundo se declara `parado`. */
export const PASO_PARADO_S = 60;
/** Estado de salud operacional que sirve `GET /health` y consume el vigilante externo. */
export interface Salud {
  estado: 'ok' | 'degradado' | 'parado';
  tick: number;
  ticksPorSegundo: number;
  segundosDesdeUltimoPaso: number;
  /** Epoch ms del último guardado confirmado; `null` si este proceso no lo conoce. */
  ultimoGuardado: number | null;
  gpu: { dispositivo: number; estado: 'ok' | 'cpu' | 'sin' }[];
  recargas: number;
  diagnostico: DiagnosticoSalud;
}
export interface DiagnosticoSalud {
  duras24h: number;
  blandas24h: number;
  ultimaViolacion: string | null;
  errorBitacora: string | null;
  registrosSinBitacora: number;
}
export const DIAGNOSTICO_VACIO: DiagnosticoSalud = {
  duras24h: 0, blandas24h: 0, ultimaViolacion: null, errorBitacora: null, registrosSinBitacora: 0,
};
/** `cpu`: la tarjeta cayó en este proceso y su trabajo va por CPU. `sin`: pedida pero no utilizable. */
export function estadoGpu(dispositivos: readonly number[]): Salud['gpu'] {
  const hayNvrtc = gpuNvrtcAvailable();
  return dispositivos.map(dispositivo => ({ dispositivo,
    estado: dispositivosGpuApagados.has(dispositivo) ? 'cpu' : hayNvrtc ? 'ok' : 'sin' }));
}
/** Shared HTTP/WS security and transport, without a World or a SQLite writer. */
export interface ReadOnlyBackend {
  sessions: Pick<Store, 'sessionValid' | 'addSession' | 'revoke'>;
  view(viewport?: Viewport): WorldView;
  gesture(gesture: Gesture, hash: string): Promise<GestureResult>;
  person(id: string): Promise<Extract<ServerMessage, { type: 'persona' }>['persona']>;
  recipe(id: string): Promise<Extract<ServerMessage, { type: 'recipe' }>['recipe']>;
  regions(): unknown;
  salud(): Salud;
  readonly runtime: RuntimeStats;
  readonly deltas: boolean;
  readonly failed: boolean;
  readonly respaldo: unknown;
  /** V21 DVR (read-only, never an RPC to the simulation). Absent when the tape is disabled. */
  tapeMeta?(): TapeMetaResponse;
  tapeChunk?(fromTick: number, count: number, viewport?: Viewport, encoding?: TapeChunkEncoding): TapeChunkResponse;
  /** V24: discovered-terrain minimap, global directory and Mensajes Divinos. Each read returns the SAME
   * object while nothing changed, so the HTTP layer reuses its encoded (and gzipped) body. */
  worldmap?(): WorldMapResponse;
  directory?(): WorldDirectoryResponse;
  whispers?(): WhispersResponse;
  whisper?(request: DivineWhisperRequest, hash: string): Promise<DivineWhisper>;
}
export interface WhispersResponse { tick: number; whispers: DivineWhisper[] }

/**
 * V24 — Last known 4×4 palette summary of every chunk this process has seen: resident chunks refresh
 * as they change; a chunk that leaves the resident set keeps its last summary (it is still discovered
 * terrain), and pending retired chunks are encoded once. `version` moves on any change, so a caller can
 * cache the response built from `chunks()`.
 */
export class MinimapAtlas {
  private readonly summaries = new Map<string, WorldMapChunkSummary>();
  private readonly activeKeys = new Set<string>();
  version = 0;
  setActive(key: string, cells: string): void {
    const previous = this.summaries.get(key);
    this.activeKeys.add(key);
    if (previous?.cells === cells && previous.active) return;
    const [cx, cy] = key.split(',').map(Number) as [number, number];
    this.summaries.set(key, { cx, cy, cells, active: true });
    this.version++;
  }
  /** Chunks outside `active` keep their last summary, marked as not simulated. */
  retainActive(active: Iterable<string>): void {
    const next = new Set(active);
    for (const key of this.activeKeys) {
      if (next.has(key)) continue;
      this.activeKeys.delete(key);
      const summary = this.summaries.get(key);
      if (summary) { this.summaries.set(key, { cx: summary.cx, cy: summary.cy, cells: summary.cells }); this.version++; }
    }
  }
  /** A retired chunk (pending archive) whose terrain this atlas never summarized. */
  addKnown(chunk: Pick<Chunk, 'key' | 'cx' | 'cy' | 'tiles'>): void {
    if (this.summaries.has(chunk.key)) return;
    this.summaries.set(chunk.key, { cx: chunk.cx, cy: chunk.cy, cells: encodeChunkMinimapCells(chunk.tiles, chunk.cx, chunk.cy) });
    this.version++;
  }
  has(key: string): boolean { return this.summaries.has(key); }
  get activeCount(): number { return this.activeKeys.size; }
  chunks(): WorldMapChunkSummary[] { return [...this.summaries.values()]; }
  private archiveQueue: string[] | undefined;
  private archiveScheduled = false;
  /** True once every chunk archived in `store` has a summary. */
  get archiveFilled(): boolean { return !!this.archiveQueue && this.archiveQueue.length === 0; }
  /**
   * Chunks the world retired to its archive (before this process started, too) are discovered terrain.
   * The archive is read once, in bounded turns (`budgetMs` each) that continue on the event loop, so
   * neither the first request nor a large world stalls HTTP.
   */
  fillFromArchive(store: Pick<Store, 'db' | 'loadChunk'>, tick: number, budgetMs = 8): void {
    if (this.archiveFilled || this.archiveScheduled) return;
    try {
      if (!this.archiveQueue) {
        let keys: { key: string }[] = [];
        try { keys = store.db.prepare('SELECT key FROM chunks GROUP BY key ORDER BY key').all() as { key: string }[]; }
        catch { /* A V1 database has no chunk archive. */ }
        this.archiveQueue = keys.map(row => row.key).reverse();
      }
      // At least one chunk per turn, then as many as fit in the budget.
      const started = performance.now();
      do {
        const key = this.archiveQueue.pop();
        if (key === undefined || this.summaries.has(key)) continue;
        const chunk = store.loadChunk(key, tick);
        if (chunk) this.addKnown(chunk);
      } while (this.archiveQueue.length && performance.now() - started < budgetMs);
    } catch { this.archiveQueue = []; return; }
    if (this.archiveQueue.length) {
      this.archiveScheduled = true;
      setImmediate(() => { this.archiveScheduled = false; this.fillFromArchive(store, tick, budgetMs); });
    }
  }
}
/** Encoded JSON bodies, keyed by the response object: unchanged reads cost neither stringify nor gzip. */
const cuerposJson = new WeakMap<object, { raw: Buffer; gzip?: Promise<Buffer> }>();
async function jsonCacheable(req: IncomingMessage, res: ServerResponse, status: number, data: object) {
  let cuerpo = cuerposJson.get(data);
  if (!cuerpo) { cuerpo = { raw: Buffer.from(JSON.stringify(data)) }; cuerposJson.set(data, cuerpo); }
  if (!aceptaGzip(req)) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', Vary: 'Accept-Encoding' });
    return res.end(cuerpo.raw);
  }
  cuerpo.gzip ??= gzipAsync(cuerpo.raw, { level: 3 });
  const comprimido = await cuerpo.gzip;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
  return res.end(comprimido);
}
export type GatewayAppOptions = Omit<AppOptions, 'store' | 'params' | 'beforeStep' | 'afterStep'>;
export function createReadOnlyApp(options: GatewayAppOptions, gateway: ReadOnlyBackend) {
  return createServerApp({ ...options, manual: true, gateway });
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
  /** Lo mismo sin el tiempo en que el hilo principal estuvo ocupado en pasos o proyecciones
   * (ahí esperan el envío de trozos y la lectura del acuse): lo que tarda el ENLACE. */
  ultimoEnlaceMs: number | null;
  /** Compresión adaptativa: empieza comprimiendo (lo seguro para un enlace lento) y pasa a texto
   * plano cuando el enlace demuestra ser de LAN; vuelve a comprimir si deja de serlo. */
  comprimir: boolean; rapidos: number; lentos: number;
}
/** Enlace de LAN: un `state` grande comprimido va y vuelve en menos de esto (sin el tiempo del hilo
 * ocupado) tres veces seguidas. Por el dominio el RTT torre↔VPS ya es de 88 ms: nunca pasa. */
export const ENLACE_RAPIDO_MS = 60;
/** En texto plano, dos idas y vueltas por encima de esto (un `state` de escritorio a < ~25 Mbit/s)
 * vuelven a comprimir. */
export const ENLACE_LENTO_MS = 250;
type ClienteWs = {
  hash: string; alive: boolean; messages: number; window: number; viewport?: Viewport; lastView?: WorldView;
  subscribeMs: number; lastBroadcastAt: number;
  /** Último envío de cualquier mensaje: decide cuándo toca un latido de aplicación. */
  lastSentAt: number;
  /** `null` = cliente sin acuse (pestaña con el cliente anterior): conserva el camino de siempre. */
  flujo: Flujo | null;
  /** T135: estado de deltas por socket; `null` hasta que `red.deltas` lo activa para este socket. */
  delta: { prev: WorldView | null; buffer: WorldView[]; ackedSequence: number; needFull: boolean; viewportKey: string } | null;
};
/** Estadística de un socket vivo, para bancos y pruebas; no expone sesión ni contenido. */
export interface FlujoCliente { remotePort: number | null; acuse: boolean; subscribeMs: number; enVuelo: boolean; enviados: number; aplazados: number; acuses: number; ultimoAcuseMs: number | null; ultimoEnlaceMs: number | null; comprime: boolean; bufferedAmount: number }
/** Un `state` más largo que esto (unidades UTF-16 del JSON) viaja en trozos hacia `/ws?ack=1`. */
export const TROZO_WS = 64 * 1024;
/** Trozo cuando se comprime: cada mensaje comprimido cuesta al menos dos idas y vueltas por el hilo
 * principal (escribir y vaciar el deflate del threadpool), y con el hilo ocupado por pasos seguidos
 * cada una espera un paso entero. Menos trozos y más grandes: 256 Ki unidades comprimen a ~35 KiB,
 * que a 0,1 Mbit/s siguen llegando en ~3 s, lejos de los 8 s de silencio del cliente. */
export const TROZO_WS_COMPRIMIDO = 256 * 1024;
/** Un delta de menos unidades que esto viaja en claro aunque el enlace sea lento: deflate no compensa. */
const DELTA_MIN_COMPRIMIDO = 2048;
/** Sin nada que mandar durante este tiempo (y sin `state` en vuelo), el servidor manda un latido.
 * Holgado frente a los 8 s de silencio que tolera `src/client/connection.ts`. */
export const LATIDO_WS_MS = 3000;
/** Edad máxima, en pasos, de la vista de reserva cuando nadie mira (ver `renovarReserva` en `createApp`):
 * 10 s a ritmo nominal, por una proyección con la cámara por defecto cada tantos pasos. */
export const VISTA_RESERVA_PASOS = 100;
/** Con clientes WS, citas de 1 ms que el planificador cede siempre tras un paso que se pasó del intervalo, haya
 * o no E/S a la vista (ver `tic` en `createApp`). Lo que manda el navegador (acuses, cámara, biografías, gestos)
 * llega comprimido, y `ws` solo lo entrega tras inflarlo en el threadpool, en varias idas y vueltas que nada
 * público deja ver. La primera cita salta justo detrás de la vuelta del bucle que recogió lo llegado durante el
 * paso, que puede ser larga (proyectar para `/api/world`); la segunda deja al menos 1 ms de bucle libre para
 * que esas idas y vueltas vuelvan. Sin ellas, con pasos alargados 250 ms, un acuse esperaba ~3 pasos (831 ms
 * p50) y el pong, detrás de él, 812 ms p95; con ellas, 44 y 96 ms (verificación PERF3, 2026-09-23). */
export const VUELTAS_CON_CLIENTES_WS = 2;
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
/** Si este socket negoció permessage-deflate (lo ofrece todo navegador; decide el servidor). */
function deflateNegociado(socket: WebSocket): boolean { return socket.extensions.includes('permessage-deflate'); }
const gzipAsync = promisify(gzip);
/** Reloj real de la contrapresión y de los tramos ocupados, fijado al cargar el módulo. La medición de
 * fases del paso llama a `performance.now()` y las pruebas de restauración lo sustituyen para contar en
 * qué fase va el paso: una llamada más desde `stepOnce` correría esa cuenta y el fallo inyectado caería
 * fuera de la fase que se quería probar. */
const relojReal = performance.now.bind(performance);
function aceptaGzip(req: IncomingMessage): boolean {
  const header = req.headers['accept-encoding'];
  if (typeof header !== 'string') return false;
  return header.split(',').some(part => { const [token, ...rest] = part.trim().split(';'); return token!.trim().toLowerCase() === 'gzip' && !rest.some(p => /^\s*q\s*=\s*0(\.0*)?\s*$/.test(p)); });
}
/** Estáticos: caché en memoria por ruta, validada contra `(mtimeMs, size)`, con gzip precalculado para
 * los tipos de texto. Acotada: al llenarse se descarta la entrada más antigua. */
export const ESTATICOS_MAX = 64;
const COMPRESIBLES = new Set(['.html', '.js', '.css', '.svg']);
type Estatico = { mtimeMs: number; size: number; raw: Buffer; gzip: Buffer | null };
const estaticos = new Map<string, Estatico>();
/** Entradas vivas de la caché de estáticos (pruebas). */
export const estaticosEnCache = (): number => estaticos.size;
function estatico(path: string, ext: string): Estatico {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error('no es un fichero');
  const hit = estaticos.get(path);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;
  const raw = readFileSync(path);
  let comprimido: Buffer | null = null;
  if (COMPRESIBLES.has(ext) && raw.length > 512) { const g = gzipSync(raw, { level: 6 }); if (g.length < raw.length) comprimido = g; }
  const entry: Estatico = { mtimeMs: stat.mtimeMs, size: stat.size, raw, gzip: comprimido };
  estaticos.delete(path);
  if (estaticos.size >= ESTATICOS_MAX) estaticos.delete(estaticos.keys().next().value!);
  estaticos.set(path, entry);
  return entry;
}
type Pending = { gesture: Gesture; hash: string; resolve: (r: GestureResult) => void; reject: (e: Error) => void; promise: Promise<GestureResult> };
/** V24: a Mensaje Divino waiting for its step. Like a gesture, it enters the world at the start of a step and
 * is confirmed only once that step's save committed (with its session checked inside the transaction). */
type PendingWhisper = { request: DivineWhisperRequest; hash: string; resolve: (w: DivineWhisper) => void; reject: (e: Error) => void; promise: Promise<DivineWhisper> };
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
/** V21: what an observer-only world answers to a direct order to an inhabitant. */
export const MENSAJE_MODO_OBSERVADOR = 'Modo observador: los habitantes actúan de forma autónoma sin órdenes directas.';
/** Direct NPC control: the `command` gesture (an `order` to one inhabitant), and the V21 alias `order`. */
function esOrdenDirecta(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'command' || kind === 'order';
}
/** Ventana de cámara opcional en la consulta (`x`, `y`, `width`, `height`): o las cuatro o ninguna. */
function camaraDeConsulta(params: URLSearchParams): Viewport | undefined {
  const keys = ['x', 'y', 'width', 'height'] as const;
  const present = keys.filter(k => params.has(k));
  if (!present.length) return undefined;
  if (present.length !== keys.length) throw new HttpError(400, 'Ventana de cámara no válida.');
  try { return normalizeViewport({ x: Number(params.get('x')), y: Number(params.get('y')), width: Number(params.get('width')), height: Number(params.get('height')) }); }
  catch { throw new HttpError(400, 'Ventana de cámara no válida.'); }
}
/** Entero de la consulta dentro de [min, max]; `fallback` si falta. */
function enteroDeConsulta(params: URLSearchParams, key: string, min: number, max: number, fallback?: number): number {
  const raw = params.get(key);
  if (raw === null) {
    if (fallback === undefined) throw new HttpError(400, `Falta el parámetro ${key}.`);
    return fallback;
  }
  if (!/^\d{1,15}$/.test(raw)) throw new HttpError(400, `Parámetro ${key} no válido.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new HttpError(400, `Parámetro ${key} no válido.`);
  return value;
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
 * Suelta las cuatro piscinas de proceso (GPU de políticas, fauna, personas, ecología).
 * Son globales: un `createApp` que avanzó con `motor.hilos > 1` o con GPU las deja vivas
 * aunque el llamador solo cierre el HTTP. Cada cierre es idempotente. Un rechazo no se traga
 * en silencio ni impide intentar las demás.
 */
export async function cerrarPiscinasDeComputo(): Promise<void> {
  const errores: unknown[] = [];
  const paso = async (fn: () => unknown) => { try { await fn(); } catch (error) { errores.push(error); } };
  await paso(() => closePolicyGpuBatchers());
  await paso(() => closeFaunaParallelPools());
  await paso(() => closePersonasParallelPools());
  await paso(() => closeEcosystemWorkers());
  if (errores.length === 1) throw errores[0];
  if (errores.length > 1) throw new AggregateError(errores, 'No se pudieron cerrar todas las piscinas de cómputo.');
}
export function createApp(options: AppOptions) {
  return createServerApp(options);
}
function createServerApp(options: Omit<AppOptions, 'store'> & { store?: Store; gateway?: ReadOnlyBackend }) {
  const store = options.store!, gateway = options.gateway;
  const muestreador = !gateway && store.path !== ':memory:'
    ? new Muestreador({ directorio: dirname(store.path), commit: options.commit }) : undefined;
  const sessions = gateway?.sessions ?? store;
  /** V21. `tickMs: 0` is the uncapped loop too; the tape follows turbo unless it is set explicitly. */
  const turbo = !!options.turbo || options.tickMs === 0;
  const observerOnly = !!options.observerOnly;
  const tapeRequested = options.tape ?? turbo;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const verifyPassword = passwordVerifier(options);
  const primaryUrl = new URL(options.origin);
  const origin = primaryUrl.origin;
  if (options.secure && !origin.startsWith('https://')) throw new Error('Private hosted access requires an HTTPS origin.');
  const allowedOriginByHost = new Map<string, string>([[primaryUrl.host, origin]]);
  for (const rawExtra of options.extraOrigins ?? []) {
    const extraUrl = new URL(rawExtra);
    const extraOrigin = extraUrl.origin;
    if (options.secure && !extraOrigin.startsWith('https://')) throw new Error('Private hosted access requires an HTTPS origin.');
    const existing = allowedOriginByHost.get(extraUrl.host);
    if (existing && existing !== extraOrigin) throw new Error('Conflicting origins for the same host.');
    allowedOriginByHost.set(extraUrl.host, extraOrigin);
  }
  /** Cambios del anfitrión sobre el mundo (arranque, recarga, pausa manual) que el próximo guardado debe registrar
   * para que `persistencia.paginasSucias` pueda reproducir ese mundo. */
  const cambiosPendientes: SnapshotReplayChange[] = [];
  /** Pausa manual de los nacimientos, solo de este proceso: nada la persiste, así que un mundo guardado con
   * `reproductionEnabled` en falso (p. ej. por el gobernador antiguo) se rehabilita al cargarlo. */
  let reproduccionManual: boolean | null = null;
  /** Deja `reproductionEnabled` en lo que manda la pausa manual (por defecto, permitido) y lo anota para el guardado. */
  function normalizarReproduccion(): void {
    const deseado = reproduccionManual ?? true;
    if (world.reproductionEnabled === deseado) return;
    world.reproductionEnabled = deseado;
    cambiosPendientes.push(captureReplayChange(world, ['reproductionEnabled']));
  }
  const loaded = gateway ? null : store.load();
  const existingInstanceId = gateway ? undefined : readWorldInstance(store.db);
  let world = gateway ? undefined! as World : loaded?.world ?? createWorld(options.seed ?? 51926, typeof options.params === 'function' ? options.params() : options.params);
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
    normalizarReproduccion();
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
    cambiosPendientes.push(captureReplayChange(world, ['events']));
  }
  if (!gateway) { store.save(world, [], [], cambiosPendientes); cambiosPendientes.length = 0; }
  let lastWorldSaveAt = monotonicNow();
  /** Salud operacional y recuperación (reloj real, no el inyectable de las cuentas de paso). */
  let ultimoGuardadoEn: number | null = gateway ? null : Date.now();
  let ultimoPasoEn = relojReal();
  let recargas = 0;
  /** Tick que el paso no logra superar y cuántas veces ha fallado. Sobrevive a una recarga (que devuelve el mundo
   * a un tick anterior) y solo se olvida cuando el mundo pasa de ese tick. */
  let fallo: { tick: number; intentos: number } | null = null;
  const salirFatal = options.onFatalExit ?? ((codigo: number) => process.exit(codigo));
  const turboSaveIntervalMs = Math.max(0, options.turboSaveIntervalMs ?? 30_000);
  const instanceId = gateway ? undefined : existingInstanceId ?? ensureWorldInstance(store.db);
  let stopped = false;
  let failed = false;
  /** PERF3: `failed` con `world` a medio paso (un paso sin reserva, o un punto que no se pudo
   * restaurar, que falló). Terminal como `failed`; además, `world` ya no se proyecta ni se consulta. */
  let aMedioPaso = false;
  /** La última vista proyectada (a cualquier cliente, por `/api/world` o de reserva; ver `renovarReserva`).
   * Con el mundo a medio paso es lo único honesto que se puede enseñar: un estado que existió, marcado en
   * pausa y con su paso. Recargar el último estado durable del Store no lo es menos, pero sobre la copia
   * pública (3,3 GB) `load()` tardó 140–330 s con el hilo bloqueado (2026-09-23), y el fallo que pausó puede
   * ser del disco. Solo es `null` si ni la proyección del arranque pudo leer su región. */
  let ultimaVista: WorldView | null = null;
  const pending = new Map<string, Pending>();
  const pendingWhispers: PendingWhisper[] = [];
  /** True while the last step applied (and saved) a Mensaje Divino: the worker posts its mirror at once. */
  let susurrosEnUltimoPaso = false;
  // T024 (P1): `subscribeMs` es la cadencia mínima que un cliente pidió (móvil observador) —
  // 0 = sin pedido, se manda con la cadencia normal. `lastBroadcastAt` la hace cumplir en `broadcast`.
  const clients = new Map<WebSocket, ClienteWs>();
  const loginAttempts = new Map<string, { count: number; reset: number }>();
  const gestureAttempts = new Map<string, { count: number; reset: number }>();
  const whisperAttempts = new Map<string, { count: number; reset: number }>();
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
  // lo que su enlace drena (a lo sumo uno en vuelo), y solo mientras su enlace no sea de
  // LAN (`ENLACE_RAPIDO_MS`): en LAN cada trozo comprimido espera al hilo principal y,
  // con la torre cargada, llegaba 25–110 ms más tarde que en claro, sin ahorrar nada que
  // importe. El cliente anterior sin acuse sigue recibiendo texto plano, como antes.
  const compresion: Compresion = options.perMessageDeflate === undefined ? 'flujo' : options.perMessageDeflate ? 'siempre' : 'nunca';
  const ws = new WebSocketServer({ noServer: true, maxPayload: 4096,
    // `chunkSize` 128 KiB: la salida de un trozo (~35 KiB) cabe en un solo viaje al threadpool
    // (con los 16 KiB por defecto, zlib vuelve al hilo principal por cada 16 KiB de salida).
    perMessageDeflate: compresion === 'nunca' ? false : compresion === 'siempre' ? true : { zlibDeflateOptions: { level: 3, chunkSize: 128 * 1024 } } });
  const staticDir = resolve(options.staticDir ?? 'dist/client');
  const context = gateway ? {} : store.context;
  const beats: number[] = [];
  /** Duraciones de los últimos 120 pasos: de aquí sale el p95 que publica la telemetría. */
  const duracionesPaso: number[] = [];
  function registrarPaso(ms: number): number {
    duracionesPaso.push(ms); if (duracionesPaso.length > 120) duracionesPaso.shift();
    const ordenadas = [...duracionesPaso].sort((a, b) => a - b);
    return ordenadas[Math.min(ordenadas.length - 1, Math.floor(ordenadas.length * 0.95))]!;
  }
  // T107: nombres fijos de `FaseNombre`, listados una vez para no repetir el literal en cada
  // reinicio del registro (uno nuevo por paso; nunca se reutiliza el del paso anterior).
  const FASE_NOMBRES: readonly FaseNombre[] = ['maintainRegions', 'ecologia', 'kernel', 'fauna', 'personas', 'encuentros', 'demografia', 'comunidades', 'reproduccion', 'checkpoint', 'muestreo', 'save', 'broadcast'];
  const fasesEnCero = (): Record<FaseNombre, number> => Object.fromEntries(FASE_NOMBRES.map(nombre => [nombre, 0])) as Record<FaseNombre, number>;
  const runtime: RuntimeStats = gateway ? gateway.runtime : { stepMs: 0, p95StepMs: 0, cloneMs: 0, simulationMs: 0, saveMs: 0, projectionMs: 0, snapshotBytes: 0, activeTiles: world.tiles.length, processRssMiB: process.memoryUsage.rss() / 1048576, tickHz: 0, tickHzObjetivo: turbo ? 0 : 1000 / (options.tickMs ?? 100),
    fases: fasesEnCero(), fraccionSerial: 0, fraccionSerialReal: 1, ocupacionWorkers: 0, tiempoBarreraMs: 0, tiempoParaleloMs: 0 };
  function salud(): Salud {
    if (gateway) return gateway.salud();
    const segundos = Math.max(0, (relojReal() - ultimoPasoEn) / 1000);
    const gpu = estadoGpu(paramsOf(world).motor.gpu);
    const parado = failed || stopped || segundos > PASO_PARADO_S;
    const resumen = muestreador?.resumen();
    const diagnostico = resumen ? { duras24h: resumen.duras24h, blandas24h: resumen.blandas24h,
      ultimaViolacion: resumen.ultimaViolacion ?? null, errorBitacora: resumen.errorBitacora ?? null,
      registrosSinBitacora: resumen.registrosSinBitacora } : DIAGNOSTICO_VACIO;
    return { estado: parado ? 'parado' : diagnostico.duras24h > 0 || gpu.some(g => g.estado !== 'ok') ? 'degradado' : 'ok',
      tick: world.tick, ticksPorSegundo: runtime.tickHz, segundosDesdeUltimoPaso: segundos,
      ultimoGuardado: ultimoGuardadoEn, gpu, recargas, diagnostico };
  }
  const proyectar = (viewport?: Viewport) => {
    const start = monotonicNow(), projected = projectWorld(world, viewport, context);
    runtime.projectionMs = monotonicNow() - start;
    return { ...projected, instanceId, regionesVivas: clavesVivasEn(world, { x: projected.originX ?? 0, y: projected.originY ?? 0, width: projected.width, height: projected.height }), performance: { ...runtime }, ...(failed ? { paused: true, pauseReason: 'No se pudo guardar. El mundo está en pausa para proteger lo ya vivido.' } : {}) };
  };
  const view = (viewport?: Viewport): WorldView => {
    if (gateway) return gateway.view(viewport);
    if (!aMedioPaso) return ultimaVista = proyectar(viewport);
    // Ni la cámara pedida ni un mundo a medio paso: la última vista que existió, sea cual sea su cámara.
    if (!ultimaVista) throw new HttpError(503, 'El mundo está en pausa: un paso falló a medias y no hay un estado anterior que mostrar.');
    const pauseReason = 'El mundo está en pausa: un paso falló a medias. '
      + `Se muestra el último estado completo que se conserva (paso ${ultimaVista.tick}).`;
    return { ...ultimaVista, paused: true, pauseReason };
  };
  /** Vista de reserva, con la cámara por defecto: al arrancar y cada `VISTA_RESERVA_PASOS` pasos que nadie
   * mira. El servicio pasa horas sin visores, y sin ella un paso sin reserva que fallara entonces dejaba
   * `/api/world` en 503 para siempre: el cliente lo toma por «sin conexión» y reintenta sin fin, cuando la
   * base servía el mundo en pausa (verificación PERF3, 2026-09-23). Una región ilegible no puede impedir el
   * arranque ni pausar un paso ya confirmado: si esta proyección falla, se conserva la vista anterior y se
   * reintenta a los `VISTA_RESERVA_PASOS` pasos, no en cada paso. */
  let intentoReserva = gateway ? 0 : world.tick;
  function renovarReserva() {
    intentoReserva = world.tick;
    try { ultimaVista = proyectar(); } catch { /* se conserva la anterior */ }
  }
  if (!gateway) renovarReserva();
  /** V21 DVR of a world simulated in this thread (`createApp`). Behind the gateway the worker records
   * and `gateway.tapeMeta/tapeChunk` read; here the app owns both ends of the same tape. */
  const tapePath = !gateway && tapeRequested ? (store.path === ':memory:' ? ':memory:' : tapePathForWorld(store.path)) : undefined;
  let tapeWriter = tapePath ? new TapeWriter({ path: tapePath, maxFrames: options.tapeMaxFrames, keyframeInterval: options.tapeKeyframeInterval }) : undefined;
  const observadorCinta = createTileObserver();
  let ultimoTickGrabado = -1;
  /** EMA of steps per wall-clock second (V21 `simHz`), over the gaps between consecutive steps. */
  let simHz = 0, ultimoLatidoPaso: number | null = null;
  let ultimaDifusionTurbo = -Infinity;
  function grabarCinta() {
    if (!tapeWriter || failed || aMedioPaso || world.tick === ultimoTickGrabado) return;
    // A reopened tape already holds this tick (a world restarted from its last save): the writer would drop
    // the frame, and the first one it does accept must be a full keyframe, since it has no base to patch.
    if (world.tick <= tapeWriter.latestTick) return;
    try {
      const { chunks, changed } = observadorCinta.scan(world);
      const keyframe = tapeKeyframeDue(world.tick, options.tapeKeyframeInterval, ultimoTickGrabado < 0);
      let tiles = changed;
      if (keyframe) { tiles = []; for (const chunk of chunks.values()) for (const tile of chunk) tiles.push(tile); }
      tapeWriter.record(projectTapeFrame(world, runtime, instanceId, tiles), simHz, !keyframe);
      ultimoTickGrabado = world.tick;
    } catch (error) {
      // A DVR is an observer: it never pauses the world. It stops recording and says so once.
      console.warn(`La cinta dejó de grabar: ${error instanceof Error ? error.message : 'error desconocido'}.`);
      try { tapeWriter.close(); } catch { /* ya está perdida */ }
      tapeWriter = undefined;
    }
  }
  grabarCinta();
  tapeWriter?.flush();
  const tapeReader = tapePath ? new TapeReader({ path: tapePath, observerOnly, turbo }) : undefined;
  /** Static/unmodified tiles of one chunk request: one projection of the camera, not one per frame. */
  function fondoDeCinta(viewport?: Viewport) {
    if (!viewport || aMedioPaso) return undefined;
    let fondo: Map<string, Tile> | undefined;
    return (x: number, y: number): Tile => {
      if (!fondo) {
        fondo = new Map();
        for (const tile of projectWorld(world, viewport, context).tiles) fondo.set(`${tile.x},${tile.y}`, tile);
      }
      return fondo.get(`${x},${y}`) ?? projectWorld(world, { x, y, width: 1, height: 1 }, context).tiles[0]!;
    };
  }
  const cinta: { meta(): TapeMetaResponse; chunk(fromTick: number, count: number, viewport?: Viewport, encoding?: TapeChunkEncoding): TapeChunkResponse } | null =
    gateway ? (gateway.tapeMeta && gateway.tapeChunk ? { meta: () => gateway.tapeMeta!(), chunk: (f, c, v, e) => gateway.tapeChunk!(f, c, v, e) } : null)
      : tapeReader ? { meta: () => tapeReader.readMeta(240), chunk: (f, c, v, e) => tapeReader.readChunk(f, c, v, fondoDeCinta(v), e) } : null;
  const reservaVieja = () => world.tick - Math.max(ultimaVista?.tick ?? 0, intentoReserva) >= VISTA_RESERVA_PASOS;
  /** Consultas de solo lectura sobre `world` (biografías, recetas): nunca sobre un mundo a medio paso. */
  function mundoConsultable(): World {
    if (aMedioPaso) throw new HttpError(503, 'El mundo está en pausa: un paso falló a medias y no se puede consultar.');
    return world;
  }
  /** V24 direct mode (no gateway): minimap, directory and whispers read the live `world` between steps,
   * rebuilt at most once per simulated tick (the same object is served while the tick does not move). */
  const atlas = new MinimapAtlas(), atlasBuilder = new WorldMapCache(), atlasObserver = createTileObserver();
  let mapaDirecto: { tick: number; version: number; value: WorldMapResponse } | undefined;
  let directorioDirecto: { tick: number; value: WorldDirectoryResponse } | undefined;
  let susurrosDirectos: { tick: number; count: number; value: WhispersResponse } | undefined;
  function worldmapDirecto(): WorldMapResponse {
    const mundo = mundoConsultable();
    if (mapaDirecto?.tick !== mundo.tick) {
      // Every chunk the scan reports as changed is re-encoded now: a change is reported only once.
      const { chunks, dirty } = atlasObserver.scan(mundo);
      for (const key of dirty) {
        const comma = key.indexOf(',');
        atlas.setActive(key, encodeChunkMinimapCells(chunks.get(key)!, Number(key.slice(0, comma)), Number(key.slice(comma + 1))));
      }
      atlas.retainActive(chunks.keys());
      for (const chunk of mundo.retiredChunks) atlas.addKnown(chunk);
    }
    atlas.fillFromArchive(store, mundo.tick);
    if (mapaDirecto?.tick === mundo.tick && mapaDirecto.version === atlas.version) return mapaDirecto.value;
    const value = atlasBuilder.buildResponse({ tick: mundo.tick, day: Math.floor(mundo.tick / TICKS_PER_DAY) + 1,
      discoveredChunks: mundo.discoveredChunks, activeChunks: Object.keys(mundo.chunks).length, chunks: atlas.chunks(),
      // Read-only inputs: the response copies only ids, names, rounded positions and counts.
      people: mundo.people, communities: mundo.communities, animals: mundo.animals, whispers: mundo.whispers });
    mapaDirecto = { tick: mundo.tick, version: atlas.version, value };
    return value;
  }
  function directorioDirectoFn(): WorldDirectoryResponse {
    const mundo = mundoConsultable();
    if (directorioDirecto?.tick !== mundo.tick) directorioDirecto = { tick: mundo.tick, value: buildWorldDirectory(projectMirrorWorld(mundo, undefined, context)) };
    return directorioDirecto.value;
  }
  function susurrosDirectosFn(): WhispersResponse {
    const mundo = mundoConsultable();
    const count = mundo.whispers?.length ?? 0;
    if (susurrosDirectos?.tick !== mundo.tick || susurrosDirectos.count !== count)
      susurrosDirectos = { tick: mundo.tick, count, value: { tick: mundo.tick, whispers: (mundo.whispers ?? []).map(whisperView) } };
    return susurrosDirectos.value;
  }
  /**
   * V24 Mensajes Divinos (direct app, and the simulation worker behind the gateway). The message waits for
   * the next step: it enters the world at that step's tick, recorded as a replay change, and the 201 comes
   * only after that step's save committed — with the session checked again inside the save transaction.
   * A crash before the reply loses an unconfirmed message, never a confirmed one.
   */
  function requestWhisper(request: DivineWhisperRequest, hash: string): Promise<DivineWhisper> {
    if (gateway) return gateway.whisper!(request, hash);
    if (!sessions.sessionValid(hash)) throw new HttpError(401, 'La sesión terminó.');
    if (failed || stopped) throw new HttpError(503, 'El mundo está en pausa.');
    if (pendingWhispers.length >= 16) throw new HttpError(429, 'Hay varios mensajes en camino. Espera un momento.');
    // What only the world knows (a living listener, a land destination) fails at once, not a step later.
    try { validateWhisper(mundoConsultable(), request); }
    catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, error instanceof Error ? error.message : 'Mensaje divino no válido.'); }
    let resolve!: PendingWhisper['resolve'], reject!: PendingWhisper['reject'];
    const promise = new Promise<DivineWhisper>((yes, no) => { resolve = yes; reject = no; });
    pendingWhispers.push({ request, hash, resolve, reject, promise });
    return promise;
  }
  function rejectWhispers(error: HttpError, which: (item: PendingWhisper) => boolean = () => true) {
    for (let i = pendingWhispers.length - 1; i >= 0; i--) {
      const item = pendingWhispers[i]!;
      if (!which(item)) continue;
      pendingWhispers.splice(i, 1); item.promise.catch(() => undefined); item.reject(error);
    }
  }
  function authorized(req: IncomingMessage) {
    const hash = sessionHash(req);
    if (!hash || !sessions.sessionValid(hash)) throw new HttpError(401, 'Entra con la contraseña de la carta.');
    return hash;
  }
  function requestOrigin(req: IncomingMessage, errorMessage = 'Host no autorizado.'): string {
    const host = req.headers.host;
    const expected = typeof host === 'string' ? allowedOriginByHost.get(host) : undefined;
    if (!expected) throw new HttpError(403, errorMessage);
    return expected;
  }
  function checkOrigin(req: IncomingMessage, expectedOrigin: string) {
    if (req.headers.origin !== expectedOrigin) throw new HttpError(403, 'Origen no autorizado.');
  }
  /** Único punto de salida: registra el último envío (para el latido). Los mensajes pequeños no
   * se comprimen salvo con `perMessageDeflate: true` (T136). */
  // Tramos en que el hilo principal estuvo ocupado (pasos y proyecciones fuera de ellos), en reloj
  // real (`relojReal`): nunca `monotonicNow`, que las pruebas inyectan para contar el paso.
  const ocupado: [number, number][] = [];
  let enPaso = false;
  function anotarOcupado(desde: number) { ocupado.push([desde, relojReal()]); if (ocupado.length > 256) ocupado.shift(); }
  function ocupadoEntre(desde: number, hasta: number) {
    let total = 0;
    for (const [a, b] of ocupado) total += Math.max(0, Math.min(b, hasta) - Math.max(a, desde));
    return total;
  }
  /** Solicitudes HTTP con la respuesta sin terminar (incluida la lectura de su cuerpo). */
  let solicitudesEnCurso = 0;
  /** Gracia breve tras servir un recurso de arranque de página (`/`, activos, `/api/session`, `/api/world`,
   * login 200): el navegador encadena esas 5 peticiones con 5–30 ms de parseo entre ellas; sin esta ventana,
   * con pasos largos (> tickMs) cada recurso tropezaba con otro paso entero. Acotada por `TOPE_CARGA_MS` por
   * paso y desarmada en cuanto se abre el WebSocket. */
  const GRACIA_CARGA_MS = 80;
  const TOPE_CARGA_MS = 250;
  let graciaCargaHasta = 0;
  let limiteCargaHasta = 0;
  function armarGraciaCarga() { graciaCargaHasta = relojReal() + GRACIA_CARGA_MS; }
  /** Conexiones aceptadas que aún no trajeron su primera solicitud (o su `upgrade`): libuv acepta en una vuelta
   * del bucle y lee en la siguiente, así que entre las dos todavía no hay solicitud que contar. Una que nunca
   * habla la cierra `headersTimeout`; mientras tanto el planificador cede, como mucho `tickMs` por paso. */
  const conexionesNuevas = new Set<Duplex>();
  /** Queda E/S que necesita al hilo principal: una conexión o una solicitud HTTP sin responder del todo, o un
   * socket WS con bytes sin entregar al kernel (`bufferedAmount` cuenta lo que `ws` aún está comprimiendo). Lo
   * que `ws` está inflando no se ve: lo cubre `VUELTAS_CON_CLIENTES_WS`. */
  function ioEnCurso(): boolean {
    if (solicitudesEnCurso > 0 || conexionesNuevas.size > 0) return true;
    for (const socket of clients.keys()) if (socket.bufferedAmount > 0) return true;
    return false;
  }
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
    // Solo si el par negoció permessage-deflate: si no (un proxy que quita la cabecera), `ws` manda
    // en claro y el trozo debe ser el de texto plano para seguir rearmando el silencio a tiempo.
    const compress = compresion !== 'nunca' && flujo.comprimir && deflateNegociado(socket);
    const trozo = compress ? TROZO_WS_COMPRIMIDO : TROZO_WS;
    if (text.length <= trozo) emitir(socket, text, compress);
    else {
      // Todos los trozos se encolan en este mismo turno: ningún otro mensaje puede colarse entre ellos.
      const partes = trocear(text, trozo);
      emitir(socket, JSON.stringify({ type: 'trozos', partes: partes.length } satisfies ServerMessage), false);
      for (const parte of partes) emitir(socket, parte, compress);
    }
    flujo.enVuelo = { sequence: world.sequence, sentAt: relojReal(), bytes: Buffer.byteLength(text) };
    flujo.pendiente = false; flujo.enviados++;
  }
  /** Llegó el acuse del `state` en vuelo: si mientras tanto hubo difusión o cámara nueva, se manda
   * ya el mundo de ahora (uno solo, por muchas difusiones que se hayan saltado). */
  function liberar(socket: WebSocket, flujo: Flujo) {
    const enVuelo = flujo.enVuelo!, ahora = relojReal();
    flujo.enVuelo = null; flujo.acuses++;
    flujo.ultimoAcuseMs = ahora - enVuelo.sentAt;
    flujo.ultimoEnlaceMs = Math.max(0, flujo.ultimoAcuseMs - ocupadoEntre(enVuelo.sentAt, ahora));
    // Solo un `state` grande dice algo del enlace; uno pequeño va y vuelve rápido por cualquiera.
    if (compresion === 'flujo' && enVuelo.bytes >= TROZO_WS) {
      if (flujo.comprimir) {
        flujo.rapidos = flujo.ultimoEnlaceMs < ENLACE_RAPIDO_MS ? flujo.rapidos + 1 : 0;
        if (flujo.rapidos >= 3) { flujo.comprimir = false; flujo.lentos = 0; }
      } else {
        flujo.lentos = flujo.ultimoEnlaceMs > ENLACE_LENTO_MS ? flujo.lentos + 1 : 0;
        if (flujo.lentos >= 2) { flujo.comprimir = true; flujo.rapidos = 0; }
      }
    }
    if (flujo.pendiente) sendView(socket);
  }
  function broadcast() {
    const now = Date.now();
    for (const [socket, client] of clients) {
      if (!sessions.sessionValid(client.hash)) { socket.close(4001, 'La sesión terminó.'); continue; }
      // T024 (P1): un cliente suscrito con `intervaloMs` no recibe empujes más seguido que eso.
      if (client.subscribeMs && now - client.lastBroadcastAt < client.subscribeMs) continue;
      sendView(socket);
    }
  }
  function sendView(socket: WebSocket) {
    const client = clients.get(socket); if (!client) return;
    // Con un `state` en vuelo no se proyecta: se proyectará el mundo de cuando llegue el acuse.
    if (client.flujo?.enVuelo) { client.flujo.pendiente = true; client.flujo.aplazados++; return; }
    const desde = relojReal();
    try {
      const projected = view(client.viewport);
      client.lastView = projected;
      client.lastBroadcastAt = Date.now();
      // T135: con `red.deltas=false` (default) el camino es exactamente el de siempre.
      if (!(gateway ? gateway.deltas : paramsOf(world).red.deltas)) { send(socket, { type: 'state', world: projected }); return; }
      if (!client.delta) client.delta = { prev: null, buffer: [], ackedSequence: -1, needFull: true, viewportKey: '' };
      const deltaState = client.delta;
      const viewportKey = client.viewport ? `${client.viewport.x},${client.viewport.y},${client.viewport.width},${client.viewport.height}` : '';
      if (viewportKey !== deltaState.viewportKey) { deltaState.viewportKey = viewportKey; deltaState.needFull = true; deltaState.prev = null; }
      if (deltaState.needFull || !deltaState.prev) {
        // `state` completo acotado al viewport: solo con el socket drenado o dentro del límite seguro.
        if (socket.bufferedAmount > 256 * 1024) { if (client.flujo) client.flujo.pendiente = true; return; }
        send(socket, { type: 'state', world: projected });
        if (socket.readyState === WebSocket.OPEN) {
          deltaState.prev = projected; deltaState.buffer = [projected]; deltaState.needFull = false;
        }
        return;
      }
      const delta = computeStateDelta(deltaState.prev, projected);
      const text = JSON.stringify(delta);
      if (client.flujo) {
        // Misma política adaptativa que `sendState`: un delta pequeño (< 2 KiB) nunca paga deflate, y uno
        // grande (tick ecológico, ciudad densa) se comprime si el enlace es lento y se trocea si hace falta.
        const flujo = client.flujo;
        const compress = compresion !== 'nunca' && flujo.comprimir && deflateNegociado(socket) && text.length > DELTA_MIN_COMPRIMIDO;
        const trozo = compress ? TROZO_WS_COMPRIMIDO : TROZO_WS;
        if (text.length <= trozo) emitir(socket, text, compress);
        else {
          const partes = trocear(text, trozo);
          emitir(socket, JSON.stringify({ type: 'trozos', partes: partes.length } satisfies ServerMessage), false);
          for (const parte of partes) emitir(socket, parte, compress);
        }
        flujo.enVuelo = { sequence: delta.sequence, sentAt: relojReal(), bytes: Buffer.byteLength(text) };
        flujo.pendiente = false; flujo.enviados++;
      } else {
        if (socket.bufferedAmount > 256 * 1024) return;
        emitir(socket, text, false);
      }
      deltaState.prev = projected;
      deltaState.buffer.push(projected); if (deltaState.buffer.length > 8) deltaState.buffer.shift();
    } catch (error) {
      // A camera read is not a simulation transaction. Never retry the failing archive in a fallback.
      // `HttpError`: un mundo a medio paso sin vista anterior (ver `view`), no una región ilegible.
      const message = error instanceof HttpError ? error.message
        : 'No se pudo leer esa región guardada. Elige otra zona; su estado se conserva para recuperación.';
      send(socket, { type: 'error', message });
    } finally { if (!enPaso) anotarOcupado(desde); }
  }
  function requestGesture(gesture: Gesture, hash: string): Promise<GestureResult> {
    if (observerOnly && esOrdenDirecta(gesture)) throw new HttpError(410, MENSAJE_MODO_OBSERVADOR);
    if (gateway) return gateway.gesture(gesture, hash);
    if (!sessions.sessionValid(hash)) throw new HttpError(401, 'La sesión terminó.');
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
    const desde = relojReal();
    if (gateway) throw new Error('Read-only gateway cannot advance the simulation.');
    // A saturated recorder yields this event-loop turn without advancing or dropping a tick.
    if (options.beforeStep?.() === false) return;
    enPaso = true;
    try { avanzar(); } finally { enPaso = false; anotarOcupado(desde); }
    grabarCinta();
    options.afterStep?.(simHz);
  }
  function avanzar() {
    susurrosEnUltimoPaso = false;
    if (failed || stopped) return;
    const stepStarted = monotonicNow();
    runtime.cloneMs = 0; runtime.simulationMs = 0; runtime.saveMs = 0;
    // Ritmo real en reloj de pared sobre los últimos 120 pasos: lo que de verdad
    // avanza el mundo, no el intervalo pedido. Sin pasos previos no se afirma nada.
    beats.push(stepStarted); if (beats.length > 120) beats.shift();
    const span = beats.length > 1 ? beats[beats.length - 1]! - beats[0]! : 0;
    runtime.tickHz = span > 0 ? (beats.length - 1) * 1000 / span : 0;
    if (ultimoLatidoPaso !== null && stepStarted > ultimoLatidoPaso) {
      const instantaneo = 1000 / (stepStarted - ultimoLatidoPaso);
      simHz = simHz > 0 ? simHz * 0.8 + instantaneo * 0.2 : instantaneo;
    }
    ultimoLatidoPaso = stepStarted;
    // Turbo publishes the live EMA: with no sleep between steps, a 120-step window lags by seconds.
    if (turbo && simHz > 0) runtime.tickHz = simHz;
    const batch = [...pending.values()];
    const valid: Pending[] = [];
    /** Tick que este paso intenta alcanzar: el que cuenta `recuperarPaso` si falla. */
    const tickObjetivo = world.tick + 1;
    // T104: sin clon, el paso corre sobre el mundo vigente y la atomicidad la sostiene esto.
    let punto: PuntoDeRestauracion | null = null;
    // PERF3: el paso corre sobre el mundo vigente sin nada con que deshacerlo. Mientras siga en
    // `true`, un fallo deja `world` a medio paso (ver el `catch`).
    let sinReserva = false;
    /** El paso ya es el mundo vigente (y durable si tocaba guardar): un fallo posterior no lo deshace. */
    let confirmado = false;
    /** El fallo vino del propio `store.save`: seguir simulando sin guardar no se recupera aquí. */
    let guardando = false;
    try {
      for (const [socket, client] of clients) if (!sessions.sessionValid(client.hash)) socket.close(4001, 'La sesión terminó.');
      for (const item of batch) {
        if (sessions.sessionValid(item.hash)) valid.push(item);
        else { item.reject(new HttpError(401, 'La sesión terminó antes de aplicar el gesto.')); pending.delete(item.gesture.id); }
      }
      rejectWhispers(new HttpError(401, 'La sesión terminó antes de dejar el mensaje.'), item => !sessions.sessionValid(item.hash));
      const whisperBatch = pendingWhispers.slice();
      // A Mensaje Divino is a host input like a gesture: its step keeps an undo and saves at once.
      const conEntradas = valid.length > 0 || whisperBatch.length > 0;
      const cloneStarted = monotonicNow();
      // T104/PERF3. La reserva sirve para deshacer el paso y seguir: `SessionRevoked` se reintenta
      // tal cual, un fallo de paso deshecho (o recargado, sin reserva) sigue vía `recuperarPaso`, y
      // solo un fallo del propio guardado pausa el mundo (`failed`, ver el `catch`).
      // · `motor.clonPorPaso=true` (default y producción): con gestos se simula sobre un clon y el
      //   mundo vigente no se toca hasta que el guardado confirma; sin gestos se simula en el sitio,
      //   como el laboratorio, y un fallo deja el mundo a medio paso hasta que se recarga el guardado.
      //   Copiar el mundo costaba 40–245 ms por paso y casi nunca se usaba.
      // · `false` (T104): punto de restauración en todo paso y simulación sobre el mundo vigente.
      // `cloneMs` mide lo que costó reservar la vuelta atrás (0 sin reserva).
      // V21: turbo and observer-only steps never copy the world (`clonPorPaso` off). A step with gestures
      // still keeps its undo (`SessionRevoked`) with a restoration point; one without runs in place.
      const sinClon = turbo || observerOnly;
      const clonar = !sinClon && paramsOf(world).motor.clonPorPaso;
      if (sinClon) { if (conEntradas) punto = puntoDeRestauracion(world); else sinReserva = true; }
      else if (!clonar) punto = puntoDeRestauracion(world);
      else sinReserva = !conEntradas;
      const draft = clonar && !sinReserva ? cloneWorld(world, context) : world;
      runtime.cloneMs = monotonicNow() - cloneStarted;
      // V24: queued Mensajes Divinos enter the world at this step's tick, before it is simulated. The whole
      // `whispers` list is recorded as a replay change at that tick (`persistencia.paginasSucias`), so a
      // replayed save rebuilds exactly this world. A message the world rejects (its listener died, the
      // destination is water) is answered 400 and never touches the world.
      const susurrosAplicados: { item: PendingWhisper; whisper: DivineWhisper }[] = [];
      const cambios: SnapshotReplayChange[] = [...cambiosPendientes];
      for (const item of whisperBatch) {
        try { susurrosAplicados.push({ item, whisper: whisperView(submitWhisper(draft, item.request)) }); }
        catch (error) {
          rejectWhispers(new HttpError(400, error instanceof Error ? error.message : 'Mensaje divino no válido.'), other => other === item);
        }
      }
      if (susurrosAplicados.length) cambios.push(captureReplayChange(draft, ['whispers']));
      const simulationStarted = monotonicNow();
      // T107: `medicion.fases` empieza vacío en cada paso (nunca se arrastra el del anterior).
      // Reloj propio, **no** `monotonicNow`: perfilar por fase es observabilidad de hardware
      // real, nunca la variable de la que dependen las cuentas exactas de paso con reloj
      // inyectado en pruebas; compartir el contador falso haría que instrumentar sumara
      // ticks fantasma a `simulationMs`/`stepMs`.
      const medicion: FaseMedicion = { clock: () => performance.now(), fases: {} };
      // T151: capturar la ocupación del pool en las barreras ecológicas sin tocar el mundo;
      // se encadena cualquier `onBarrier` previo del contexto y solo se acumulan ms.
      let paraleloCapturadoMs = 0, barreraCapturadaMs = 0, ocupacionPonderada = 0;
      const ejecucionPrevia = context.ecologyExecution;
      const personasPrevia = context.personasExecution;
      const contextoPaso: typeof context = {
        ...context,
        tileOwnership: worldContext(draft).tileOwnership ?? context.tileOwnership,
        ecologyExecution: { ...ejecucionPrevia,
          onBarrier: evento => { ejecucionPrevia?.onBarrier?.(evento); const d = evento.diagnostics; if (d && d.tiempoParaleloMs > 0) { paraleloCapturadoMs += d.tiempoParaleloMs; barreraCapturadaMs += d.tiempoBarreraMs; ocupacionPonderada += d.ocupacionWorkers * d.tiempoParaleloMs; } } },
        personasExecution: { ...personasPrevia,
          onStep: d => { personasPrevia?.onStep?.(d); if (d.tiempoParaleloMs > 0) { paraleloCapturadoMs += d.tiempoParaleloMs; barreraCapturadaMs += d.tiempoBarreraMs; ocupacionPonderada += d.ocupacionWorkers * d.tiempoParaleloMs; } } },
      };
      const results = stepWorld(draft, valid.map(item => item.gesture), contextoPaso, medicion);
      runtime.simulationMs = monotonicNow() - simulationStarted;
      if (results.length !== valid.length) throw new Error('Gesture result count mismatch');
      // C3/C12: persistir es una transacción por cadencia, no por tick. Un gesto
      // confirmado nunca espera: obliga a guardar en su propio paso. Lo que se
      // arriesga entre guardados son los pasos de la cadencia, jamás un gesto.
      // sprint/journal-caps-20260929: una tercera razón para guardar YA, sin esperar la cadencia
      // ni un gesto — los diarios o el catálogo se acercan a su tope de pendientes. Con
      // población grande, esperar `cadaTicks` pasos puede acumular más recibos de los que caben
      // entre guardados (ver `technologyJournalNearCapacity`/`chronicleJournalNearCapacity`); esto
      // es lo que de verdad evita morir, no solo el tope más alto de esos módulos.
      // El gesto (`valid.length > 0`) sigue forzando el guardado en su propio paso,
      // sin tocar esa invariante.
      const routineSaveDue = draft.tick % paramsOf(draft).persistencia.cadaTicks === 0
        && (!turbo || monotonicNow() - lastWorldSaveAt >= turboSaveIntervalMs);
      if (valid.length > 0 || susurrosAplicados.length > 0 || routineSaveDue
        || technologyJournalNearCapacity(draft.technology) || chronicleJournalNearCapacity(draft)
        || technologyCatalogueNearCapacity(draft.technology)) {
        const saveStarted = monotonicNow();
        guardando = true;
        store.save(draft, valid.map((item, i) => ({ gesture: item.gesture, result: results[i] })),
          [...valid.map(item => item.hash), ...susurrosAplicados.map(({ item }) => item.hash)], cambios);
        guardando = false; ultimoGuardadoEn = Date.now(); cambiosPendientes.length = 0;
        lastWorldSaveAt = monotonicNow();
        runtime.saveMs = monotonicNow() - saveStarted;
      }
      world = draft;
      // Desde aquí el paso es el mundo vigente (y, si tocaba guardar, ya es durable): un fallo en lo
      // que queda (métricas, difusión) pausa el mundo pero no puede deshacerlo, igual que
      // con el clon, donde `world` ya es el borrador. Sin esto la memoria volvería a un tick que el
      // disco ya dejó atrás y los gestos resueltos en este paso quedarían fuera del mundo en memoria.
      // Tampoco lo deja a medio paso: sin reserva, lo que falle desde aquí cae sobre un paso entero.
      punto = null; sinReserva = false; confirmado = true;
      // Confirmado y durable: se responde a gestos y mensajes antes de la telemetría, para que un
      // fallo de esta nunca deje un gesto ya guardado sin respuesta (se reaplicaría al paso siguiente).
      for (let i=0; i<valid.length; i++) { pending.delete(valid[i].gesture.id); valid[i].resolve(results[i]); }
      // Durable now: confirm each Mensaje Divino as it entered the world.
      for (const { item, whisper } of susurrosAplicados) {
        const index = pendingWhispers.indexOf(item);
        if (index >= 0) pendingWhispers.splice(index, 1);
        item.resolve(whisper);
      }
      susurrosEnUltimoPaso = susurrosAplicados.length > 0;
      runtime.stepMs = monotonicNow() - stepStarted;
      muestreador?.paso(world, runtime.stepMs);
      runtime.p95StepMs = registrarPaso(runtime.stepMs);
      if (world.tick % CADA_PASOS === 0 || !runtime.natalidad) Object.assign(runtime, resumenVivo(world));
      runtime.activeTiles = world.tiles.length; runtime.processRssMiB = process.memoryUsage.rss() / 1048576; runtime.snapshotBytes = store.lastSnapshotBytes;
      // T107: `broadcast` mide su propio tramo porque corre después de que `stepMs` ya cerró
      // (siempre corrió así; instrumentarlo no adelanta ni retrasa el envío ni cambia su cadencia).
      // Reloj real, no `monotonicNow` — mismo motivo que `medicion` arriba.
      const fases = fasesEnCero();
      Object.assign(fases, medicion.fases, { save: runtime.saveMs });
      // Turbo: a step every event-loop turn would project for every viewer at 100–300 Hz; viewers get
      // the live world at most every `TURBO_MIRROR_MS` (the DVR tape keeps every tick).
      const entradas = valid.length > 0 || susurrosEnUltimoPaso;
      const difundir = turbo ? entradas || relojReal() - ultimaDifusionTurbo >= TURBO_MIRROR_MS : world.tick % 5 === 0 || entradas;
      if (difundir) {
        if (turbo) ultimaDifusionTurbo = relojReal();
        const broadcastStarted = performance.now();
        broadcast();
        fases.broadcast = performance.now() - broadcastStarted;
      }
      // Con visores, `broadcast` ya la renovó; sin ellos, una proyección cada `VISTA_RESERVA_PASOS` pasos.
      if (reservaVieja()) renovarReserva();
      runtime.fases = fases;
      runtime.fraccionSerial = fraccionSerial(fases);
      // T151: fracción real y ocupación. `fraccionSerial` conserva la lectura por diseño de
      // T107 (compatibilidad con perfil-fases/lab); la real vale 1 sin workers ni GPU y, con
      // tramo paralelo, es el tiempo fuera de ese tramo sobre el total de fases del paso.
      const motor = paramsOf(world).motor, hayGpu = motor.gpu.length > 0, hayParalelo = motor.hilos > 1 || hayGpu;
      const totalFases = FASE_NOMBRES.reduce((suma, nombre) => suma + fases[nombre], 0);
      // Solo un despacho real (o la pared GPU, sin diagnósticos de pool) actualiza el trío
      // paralelo/barrera/ocupación; entre ticks ecológicos se conserva el último despacho.
      const paraleloPasoMs = paraleloCapturadoMs > 0 ? paraleloCapturadoMs : hayGpu ? fases.ecologia + fases.kernel : 0;
      if (!hayParalelo) { runtime.fraccionSerialReal = 1; runtime.ocupacionWorkers = 0; runtime.tiempoParaleloMs = 0; runtime.tiempoBarreraMs = 0; }
      else {
        runtime.fraccionSerialReal = calcularFraccionSerialReal(Math.max(0, totalFases - paraleloPasoMs), paraleloPasoMs, motor.hilos, motor.gpu.length);
        if (paraleloCapturadoMs > 0) { runtime.ocupacionWorkers = Math.max(0, Math.min(1, ocupacionPonderada / paraleloCapturadoMs)); runtime.tiempoParaleloMs = paraleloCapturadoMs; runtime.tiempoBarreraMs = barreraCapturadaMs; }
        else if (hayGpu && paraleloPasoMs > 0) { runtime.tiempoParaleloMs = paraleloPasoMs; runtime.tiempoBarreraMs = 0; }
      }
      ultimoPasoEn = relojReal(); if (fallo && world.tick > fallo.tick) fallo = null;
    } catch (error) {
      // T104: deshacer va PRIMERO, y vale para las dos salidas. Sin clon, llegar aquí con punto
      // significa que el mundo vigente está a medio paso; un mundo que no se pudo deshacer ya no
      // puede seguir avanzando aunque el error fuera recuperable.
      // Sin reserva no hay nada que restaurar: el mundo se queda a medio paso.
      let restaurado = !sinReserva;
      if (punto) { try { punto.restaurar(); } catch { restaurado = false; } }
      if (restaurado && error instanceof SessionRevoked) {
        // La sesión se revocó entre aceptar el gesto y confirmarlo: el mundo no avanza con un
        // gesto aplicado y no guardado, así que este paso queda deshecho y se reintenta el siguiente.
        for (const item of pending.values()) if (!sessions.sessionValid(item.hash)) {
          item.reject(new HttpError(401, 'La sesión terminó antes de guardar el gesto.')); pending.delete(item.gesture.id);
        }
        // The undone step also undid its Mensajes Divinos: those with a live session wait for the retry.
        rejectWhispers(new HttpError(401, 'La sesión terminó antes de guardar el mensaje.'), item => !sessions.sessionValid(item.hash));
        return;
      }
      const motivo = error instanceof Error ? error.message : String(error);
      if (confirmado) {
        // El paso ya es durable y el mundo está entero: falló la telemetría o la difusión, no el paso.
        console.warn(`Un fallo tras confirmar el paso ${world.tick} no detiene el mundo: ${motivo}`);
        ultimoPasoEn = relojReal(); if (fallo && world.tick > fallo.tick) fallo = null;
        return;
      }
      if (guardando) {
        // Simular sin poder guardar perdería mundo y confirmaría lo que no es durable: se conserva
        // la pausa protectora. `/health` dice `parado` y el vigilante externo reinicia el servicio
        // sobre el último guardado; esa es la recuperación de un fallo de persistencia.
        failed = true;
        // Un mundo a medio paso (sin reserva, o con un punto que no se pudo restaurar) no es un estado
        // del mundo: desde aquí nada lo proyecta ni lo consulta (`view`, `persona`, `recipe`). Guardar ya
        // no puede: `avanzar` no pasa de `failed` y el cierre no guarda.
        aMedioPaso = !restaurado;
        for (const item of pending.values()) item.reject(new HttpError(503, 'No se pudo guardar; el gesto no fue confirmado.'));
        pending.clear();
        rejectWhispers(new HttpError(503, 'No se pudo guardar; el mensaje no fue confirmado.'));
        // Do not log snapshots, inputs, or personal content on failure.
        for (const socket of clients.keys()) {
          send(socket, { type: 'error', message: 'No se pudo guardar. El mundo está en pausa.' });
          const previous = clients.get(socket)?.lastView;
          // Terminal: no habrá más difusiones, así que no espera al acuse del `state` en vuelo.
          if (previous) sendState(socket, { ...previous, paused: true, pauseReason: 'El mundo está en pausa: no se pudo confirmar el siguiente paso. Se muestra el último estado recibido.' }, true);
        }
        return;
      }
      recuperarPaso(error, restaurado, tickObjetivo);
    }
  }
  /**
   * Un paso de simulación que lanzó ya no pausa el mundo para siempre: el paso quedó deshecho
   * (clon o punto de restauración) o, si iba sin reserva, el mundo en memoria se descarta y se
   * recarga el último guardado; en ambos casos el mundo sigue. Tres fallos seguidos intentando
   * superar el mismo tick (aunque entre uno y otro una recarga haya devuelto el mundo a un tick
   * anterior) son un estado que el paso no puede atravesar: se sale con 75 y systemd reinicia el
   * servicio sobre ese mismo guardado. También se sale con 75 sin recargar cuando se cayó una
   * piscina de cómputo: su fallo es permanente y solo un proceso nuevo las vuelve a crear.
   */
  function recuperarPaso(error: unknown, restaurado: boolean, tickObjetivo: number): void {
    const motivo = error instanceof Error ? error.message : String(error);
    if (fallo?.tick === tickObjetivo) fallo.intentos++; else fallo = { tick: tickObjetivo, intentos: 1 };
    const piscinaCaida = motivo.includes('StaticWorkerPool');
    if (fallo.intentos >= 3 || piscinaCaida) {
      console.error(piscinaCaida
        ? `El paso ${tickObjetivo} falló porque una piscina de cómputo cayó (${motivo}): salgo con 75 para que el servicio reinicie.`
        : `Tres fallos seguidos intentando superar el paso ${tickObjetivo} (último: ${motivo}): salgo con 75 para que el servicio reinicie.`);
      failed = true; aMedioPaso = !restaurado; salirFatal(75); return;
    }
    if (!restaurado) {
      let cargado: ReturnType<Store['load']> = null;
      try { cargado = store.load(); } catch { cargado = null; }
      if (!cargado) {
        console.error(`El paso falló (${motivo}) y no hay un guardado legible desde el que recargar: salgo con 75.`);
        failed = true; aMedioPaso = true; salirFatal(75); return;
      }
      // El arranque (main.ts, sim-worker.ts) envuelve las teselas con la propiedad residente cuando el motor es
      // paralelo; el mundo recién cargado no la trae y se le da igual que al descartado.
      const conPropiedad = !!worldContext(world).tileOwnership;
      world = cargado.world; recargas++; aMedioPaso = false;
      if (conPropiedad) {
        const tileOwnership = new ResidentTopologyOwner();
        world.tiles = tileOwnership.tiles(world.tiles.map(tile => tileOwnership.tile(tile)));
        bindWorldContext(world, { ...worldContext(world), tileOwnership });
      }
      // Las cachés por tick y la cinta describían el mundo descartado: el próximo fotograma va completo.
      mapaDirecto = undefined; directorioDirecto = undefined; susurrosDirectos = undefined;
      ultimoTickGrabado = -1;
      // Lo que quedó por registrar describía el mundo descartado; lo del mundo recargado se anota de nuevo.
      cambiosPendientes.length = 0;
      normalizarReproduccion();
      world.events.push({ id: `pause-${world.tick}-${makeToken().slice(0,12)}`, tick: world.tick, kind: 'pause', actors: [],
        text: 'Un paso falló y el mundo retomó desde su último momento guardado.',
        cause: 'Recuperación automática; se perdió lo simulado desde ese guardado.', source: 'simulation' });
      world.events = world.events.slice(-120);
      cambiosPendientes.push(captureReplayChange(world, ['events']));
      renovarReserva();
      console.warn(`El paso falló (${motivo}); el mundo se recargó desde su último guardado (paso ${world.tick}, recarga ${recargas}) y sigue.`);
    } else {
      console.warn(`El paso ${tickObjetivo} falló (${motivo}); quedó deshecho y el mundo sigue desde el paso ${world.tick}.`);
    }
    // Ni los gestos ni los mensajes del lote llegaron a aplicarse ni a guardarse: esperan al paso
    // siguiente como con `SessionRevoked`, salvo los de sesiones que ya terminaron.
    for (const item of pending.values()) if (!sessions.sessionValid(item.hash)) {
      item.reject(new HttpError(401, 'La sesión terminó antes de guardar el gesto.')); pending.delete(item.gesture.id);
    }
    rejectWhispers(new HttpError(401, 'La sesión terminó antes de guardar el mensaje.'), item => !sessions.sessionValid(item.hash));
    broadcast();
  }
  const server = createServer(async (req, res) => {
    // Hasta que la respuesta termina (o se corta): el planificador cede a ella tras un paso largo.
    solicitudesEnCurso++; res.once('close', () => { solicitudesEnCurso--; }); conexionesNuevas.delete(req.socket);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (options.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const expectedOrigin = requestOrigin(req);
      const url = new URL(req.url ?? '/', expectedOrigin);
      if (req.method === 'GET' && url.pathname === '/health') {
        // 503 solo en `parado`: más de `PASO_PARADO_S` sin completar un paso, o la pausa protectora de guardado.
        const estado = salud();
        return json(res, estado.estado === 'parado' ? 503 : 200,
          { ...estado, status: estado.estado === 'parado' ? 'paused' : 'ok', ...((gateway?.respaldo ?? respaldo) ? { respaldo: gateway?.respaldo ?? respaldo } : {}) });
      }
      if (req.method === 'GET' && url.pathname === '/api/session') {
        const hash = sessionHash(req);
        armarGraciaCarga();
        // V21 flags travel only when set: a classic world answers exactly what it always did.
        return json(res, 200, { authenticated: !!hash && sessions.sessionValid(hash),
          ...(observerOnly ? { observerOnly: true } : {}), ...(cinta ? { tapeEnabled: true } : {}), ...(turbo ? { turbo: true } : {}) });
      }
      if (req.method === 'POST') checkOrigin(req, expectedOrigin);
      if (req.method === 'POST' && url.pathname === '/api/login') {
        rate(loginAttempts, loginKey(req.socket.remoteAddress, req.headers['x-forwarded-for'], trustedProxies), 6, 60_000);
        // Cortafuegos ante una avalancha real, no un segundo límite por-persona: con el cupo
        // por clave (6/60s) ya aplicado arriba, 600/60s solo actúa si hay ~100 claves distintas
        // atacando a la vez. Un umbral bajo (p. ej. 60) repetía el daño de C7: cualquier tercero
        // sin sesión bloqueaba a la dueña de la carta.
        rate(loginGlobal, '*', 600, 60_000);
        const value = await body(req) as { password?: unknown } | null;
        if (!value || typeof value.password !== 'string' || !verifyPassword(value.password)) throw new HttpError(401, 'La contraseña no coincide.');
        const oldHash = sessionHash(req); if (oldHash) sessions.revoke(oldHash);
        const token = makeToken(); sessions.addSession(hashToken(token), Date.now() + 14 * 86400_000);
        res.setHeader('Set-Cookie', cookie(token, !!options.secure));
        armarGraciaCarga();
        return json(res, 200, { ok: true });
      }
      if (url.pathname.startsWith('/api/')) {
        const hash = authorized(req);
        if (req.method === 'POST' && url.pathname === '/api/logout') {
          sessions.revoke(hash); res.setHeader('Set-Cookie', cookie('', !!options.secure, 0));
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
          if (!aceptaGzip(req)) { armarGraciaCarga(); return json(res, 200, view(viewport)); }
          const cuerpo = await gzipAsync(Buffer.from(JSON.stringify(view(viewport))), { level: 3 });
          armarGraciaCarga();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
          return res.end(cuerpo);
        }
        if (gateway && req.method === 'GET' && url.pathname === '/api/regiones') return json(res, 200, gateway.regions());
        // V21 DVR: read-only, from the tape alone (never an RPC to the simulation).
        if (req.method === 'GET' && url.pathname === '/api/tape/meta') {
          if (!cinta) throw new HttpError(404, 'La cinta no está activada en este mundo.');
          return json(res, 200, cinta.meta());
        }
        if (req.method === 'GET' && url.pathname === '/api/tape/chunk') {
          if (!cinta) throw new HttpError(404, 'La cinta no está activada en este mundo.');
          const fromTick = enteroDeConsulta(url.searchParams, 'fromTick', 0, Number.MAX_SAFE_INTEGER, 0);
          const count = enteroDeConsulta(url.searchParams, 'count', 1, 240, 60);
          const encoding = url.searchParams.get('encoding') ?? 'full';
          if (encoding !== 'full' && encoding !== 'delta') throw new HttpError(400, 'Codificación de cinta no válida.');
          const chunk = cinta.chunk(fromTick, count, camaraDeConsulta(url.searchParams), encoding);
          if (!aceptaGzip(req)) return json(res, 200, chunk);
          const cuerpo = await gzipAsync(Buffer.from(JSON.stringify(chunk)), { level: 3 });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
          return res.end(cuerpo);
        }
        // V24: discovered-terrain minimap and global directory (whole world, never clipped to a camera).
        if (req.method === 'GET' && url.pathname === '/api/worldmap') {
          if (gateway && !gateway.worldmap) throw new HttpError(404, 'Ruta no encontrada.');
          return jsonCacheable(req, res, 200, gateway ? gateway.worldmap!() : worldmapDirecto());
        }
        if (req.method === 'GET' && url.pathname === '/api/directory') {
          if (gateway && !gateway.directory) throw new HttpError(404, 'Ruta no encontrada.');
          return jsonCacheable(req, res, 200, gateway ? gateway.directory!() : directorioDirectoFn());
        }
        if (req.method === 'GET' && url.pathname === '/api/whispers') {
          if (gateway && !gateway.whispers) throw new HttpError(404, 'Ruta no encontrada.');
          return jsonCacheable(req, res, 200, gateway ? gateway.whispers!() : susurrosDirectosFn());
        }
        // V24 Mensajes Divinos: allowed in observer-only worlds — they are asynchronous inspiration that an
        // inhabitant may hear later, when calm, never a direct order (those stay 410 in that mode).
        if (req.method === 'POST' && url.pathname === '/api/whisper') {
          if (gateway && !gateway.whisper) throw new HttpError(404, 'Ruta no encontrada.');
          rate(whisperAttempts, loginKey(req.socket.remoteAddress, req.headers['x-forwarded-for'], trustedProxies), 20, 60_000);
          const raw = await body(req);
          let request: DivineWhisperRequest;
          try { request = parseWhisperRequest(raw); }
          catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Mensaje divino no válido.'); }
          // The session may have ended while the body arrived: `requestWhisper` checks it again (and the
          // save transaction, a third time, before anything is confirmed).
          const whisper = await requestWhisper(request, hash);
          return json(res, 201, { ok: true, whisper });
        }
        if (req.method === 'POST' && (url.pathname === '/api/gesture' || (gateway && url.pathname === '/api/gestures'))) {
          const raw = await body(req);
          if (observerOnly && esOrdenDirecta(raw)) throw new HttpError(410, MENSAJE_MODO_OBSERVADOR);
          const gesture = parseGesture(raw);
          return json(res, 200, await requestGesture(gesture, hash));
        }
        throw new HttpError(404, 'Ruta no encontrada.');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método no permitido.');
      const path = resolve(staticDir, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      const mimes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
      if (!path.startsWith(staticDir + sep) || !mimes[extname(path)]) throw new HttpError(404, 'Ruta no encontrada.');
      let content: Estatico;
      try { content = estatico(path, extname(path)); }
      catch { throw new HttpError(404, 'La interfaz aún no está compilada. Ejecuta npm run build.'); }
      armarGraciaCarga();
      if (content.gzip && aceptaGzip(req)) {
        res.writeHead(200, { 'Content-Type': mimes[extname(path)]!, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': content.gzip.length });
        res.end(req.method === 'HEAD' ? undefined : content.gzip);
      } else {
        res.writeHead(200, { 'Content-Type': mimes[extname(path)]!, ...(content.gzip ? { Vary: 'Accept-Encoding' } : {}) });
        res.end(req.method === 'HEAD' ? undefined : content.raw);
      }
    } catch (error) {
      if (!res.headersSent) json(res, error instanceof HttpError ? error.status : 503, { error: error instanceof HttpError ? error.message : 'El servicio no pudo completar la solicitud.' });
      else res.end();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.on('connection', (socket: Socket) => {
    conexionesNuevas.add(socket); socket.once('close', () => conexionesNuevas.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => {
    conexionesNuevas.delete(socket);
    try {
      const expectedOrigin = requestOrigin(req, 'Ruta no autorizada.');
      checkOrigin(req, expectedOrigin);
      const solicitud = solicitudWs(req.url);
      const hash = authorized(req);
      if (clients.size >= 12) throw new HttpError(429, 'Demasiadas conexiones.');
      ws.handleUpgrade(req, socket, head, client => {
        clients.set(client, { hash, alive: true, messages: 0, window: Date.now(), subscribeMs: 0, lastBroadcastAt: 0, lastSentAt: Date.now(),
          ...(solicitud.viewport ? { viewport: solicitud.viewport } : {}),
          flujo: solicitud.acuse ? { enVuelo: null, pendiente: false, enviados: 0, aplazados: 0, acuses: 0, ultimoAcuseMs: null, ultimoEnlaceMs: null, comprimir: compresion !== 'nunca', rapidos: 0, lentos: 0 } : null, delta: null });
        client.on('error', () => client.terminate());
        client.on('pong', () => { const info = clients.get(client); if (info) info.alive = true; });
        client.on('close', () => clients.delete(client));
        client.on('message', async (data, binary) => {
          try {
            const info = clients.get(client)!;
            // Cualquier mensaje prueba que el par vive: el pong puede venir detrás de un `state` grande.
            info.alive = true;
            if (!sessions.sessionValid(hash)) { client.close(4001, 'La sesión terminó.'); return; }
            if (Date.now() - info.window >= 10_000) { info.window = Date.now(); info.messages = 0; }
            // El acuse que libera el `state` en vuelo no gasta cupo: cada uno responde a un `state`
            // que el servidor eligió mandar. Un acuse suelto o repetido sí cuenta (y no libera nada).
            if (!binary && info.flujo?.enVuelo && esAcuse(data, info.flujo.enVuelo.sequence)) {
              if (info.delta) { info.delta.ackedSequence = info.flujo.enVuelo.sequence; if (info.delta.buffer.length && info.delta.ackedSequence < info.delta.buffer[0]!.sequence) info.delta.needFull = true; }
              liberar(client, info.flujo); return;
            }
            if (++info.messages > 120) { client.close(4008, 'Demasiados mensajes.'); return; }
            if (binary) throw new HttpError(400, 'Se requiere JSON.');
            const parsed = JSON.parse(data.toString()) as Partial<ClientMessage> & { gesture?: unknown; viewport?: Viewport; id?: unknown; intervaloMs?: unknown };
            if (parsed?.type === 'ack') {
              // T135: un `ack` demasiado viejo (fuera del buffer corto) fuerza un `state` completo.
              if (info.delta && typeof (parsed as { sequence?: unknown }).sequence === 'number') {
                const seq = (parsed as { sequence: number }).sequence;
                info.delta.ackedSequence = seq;
                if (info.delta.buffer.length && seq < info.delta.buffer[0]!.sequence) info.delta.needFull = true;
              }
              return;
            }
            if (['viewport', 'persona', 'recipe', 'receta', 'regiones'].includes(parsed?.type ?? '')) armarGraciaCarga();
            if (gateway && (parsed as { type?: string })?.type === 'regiones') { emitir(client, JSON.stringify({ type: 'regiones', regiones: gateway.regions() }), false); return; }
            if (parsed?.type === 'resync') {
              const req = parsed as { viewport?: Viewport };
              if (req.viewport) { try { info.viewport = normalizeViewport(req.viewport); } catch { throw new HttpError(400, 'Ventana de cámara no válida.'); } }
              if (info.delta) { info.delta.prev = null; info.delta.buffer = []; info.delta.needFull = true; }
              if (info.flujo) info.flujo.enVuelo = null;
              sendView(client); return;
            }
            if (parsed?.type === 'viewport') {
              try { info.viewport = normalizeViewport(parsed.viewport); } catch { throw new HttpError(400, 'Ventana de cámara no válida.'); }
              if (info.delta) { info.delta.prev = null; info.delta.needFull = true; }
              // Con acuse, si hay un `state` en vuelo esto solo lo apunta: al llegar el acuse sale uno
              // con la cámara más reciente, por muchas que hayan llegado entretanto.
              sendView(client); return;
            }
            // T036(h): one inhabitant's biography at a time, read-only; the snapshot no longer carries it.
            if (parsed?.type === 'persona') {
              if (typeof parsed.id !== 'string' || !/^[A-Za-z0-9_:-]{1,50}$/.test(parsed.id)) throw new HttpError(400, 'Identificador de habitante no válido.');
              send(client, { type: 'persona', id: parsed.id, persona: gateway ? await gateway.person(parsed.id) : enriquecerPersona(mundoConsultable(), parsed.id) ?? null });
              return;
            }
            // One definition at a time, read-only: the snapshot carries summaries and this query never advances the world.
            if (parsed?.type === 'recipe' || (parsed as { type?: string })?.type === 'receta') {
              if (typeof parsed.id !== 'string' || !/^recipe-[1-9]\d{0,9}$/.test(parsed.id)) throw new HttpError(400, 'Identificador de procedimiento no válido.');
              send(client, { type: 'recipe', id: parsed.id, recipe: gateway ? await gateway.recipe(parsed.id) : technologyRecipeDetail(mundoConsultable(), parsed.id) ?? null });
              return;
            }
            if (parsed?.type === 'suscripcion') {
              // Modo ligero móvil (P1): el cliente pide una cadencia más espaciada; 1000 ms es el piso.
              if (typeof parsed.intervaloMs !== 'number' || !Number.isFinite(parsed.intervaloMs) || parsed.intervaloMs < 0) throw new HttpError(400, 'Intervalo de suscripción no válido.');
              info.subscribeMs = Math.max(1000, Math.floor(parsed.intervaloMs));
              return;
            }
            if (!parsed || parsed.type !== 'gesture') throw new HttpError(400, 'Mensaje desconocido.');
            if (observerOnly && esOrdenDirecta(parsed.gesture)) throw new HttpError(410, MENSAJE_MODO_OBSERVADOR);
            const result = await requestGesture(parseGesture(parsed.gesture), hash);
            if (sessions.sessionValid(hash)) send(client, { type: 'result', result });
          } catch (error) { send(client, { type: 'error', message: error instanceof HttpError ? error.message : 'No se pudo aplicar el gesto.' }); }
        });
        graciaCargaHasta = 0;
        sendView(client);
      });
    } catch (error) { socket.end(`HTTP/1.1 ${error instanceof HttpError ? error.status : 503} Rejected\r\nConnection: close\r\n\r\n`); }
  });
  // Planificador con compensación de deriva: el próximo paso se cita en `next +=
  // tickMs`, no «tickMs después de terminar», así un paso lento no desplaza para
  // siempre el reloj del mundo. Tras una pausa larga se recita, nunca se recupera
  // el retraso con una ráfaga de pasos: el mundo no salta hacia atrás ni adelante.
  const tickMs = turbo ? 0 : options.tickMs ?? 100;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** V21 turbo: the pending `setImmediate` of the uncapped loop (one step per event-loop turn). */
  let inmediato: ReturnType<typeof setImmediate> | undefined;
  let bucleTurbo = false;
  let next = monotonicNow() + tickMs;
  /** Tras un paso que se pasó del intervalo: hasta cuándo puede esperar el siguiente a que acabe la E/S. */
  let cederHasta: number | null = null;
  /** Citas cedidas desde ese paso: con clientes WS, nunca menos de `VUELTAS_CON_CLIENTES_WS`. */
  let cedidas = 0;
  function citar(ms: number) {
    if (turbo) { bucleTurbo = true; inmediato = setImmediate(tic); return; }
    timer = setTimeout(tic, ms); timer.unref();
  }
  function tic() {
    if (stopped) return;
    if (turbo) {
      // Uncapped: never an idle sleep. `setImmediate` runs after the poll phase, so every step leaves
      // a full event-loop turn to HTTP, WS and worker RPCs. A failed world stops spinning.
      inmediato = undefined;
      stepOnce();
      if (!stopped && !failed) citar(0);
      return;
    }
    // Ceder a la E/S en curso: se vuelve a mirar cada milisegundo; entretanto el bucle atiende el poll.
    const enGraciaCarga = graciaCargaHasta > 0 && (() => {
      const ahora = relojReal();
      return ahora < limiteCargaHasta && (ahora < graciaCargaHasta || solicitudesEnCurso > 0);
    })();
    if (cederHasta !== null
      && ((monotonicNow() < cederHasta && (cedidas < (clients.size > 0 ? VUELTAS_CON_CLIENTES_WS : 0) || ioEnCurso()))
        || enGraciaCarga)) { cedidas++; citar(1); return; }
    cederHasta = null; cedidas = 0; graciaCargaHasta = 0;
    next += tickMs;
    stepOnce();
    // El corte se juzga DESPUÉS del paso. Un paso que duró más que el intervalo ya llega tarde a su cita, y
    // el siguiente no espera `tickMs` ociosos (PERF3: con pasos de ~233 ms eran 100 ms por paso y el mundo
    // público iba a 3 pasos/s): espera solo a que acabe la E/S en curso (`ioEnCurso`), y como mucho
    // `tickMs`, lo que esperaba antes. Sin esa espera, con pasos seguidos a la E/S le quedaba una vuelta
    // del bucle por paso, y el gzip de `/api/world`, el deflate de cada trozo WS (con el pong, que `ws`
    // encola detrás) o el cuerpo de un login necesitan varias idas y vueltas al threadpool o al poll: con
    // pasos de 250 ms el gzip pasó de ~0,1 a 2,6 s, y con pasos de 1,1 s a 12 s, más que el aborto de 10 s
    // del cliente (verificación PERF3, 2026-09-23). Lo que llega por WS se infla sin dejarse ver: con clientes
    // WS se ceden además `VUELTAS_CON_CLIENTES_WS` citas. Nunca una ráfaga: un paso por callback, y el retraso
    // acumulado no se recupera: a tiempo, la cita compensa la deriva.
    const now = monotonicNow();
    if (next < now) { next = now; cederHasta = now + tickMs; limiteCargaHasta = relojReal() + TOPE_CARGA_MS; }
    if (!stopped) citar(Math.max(0, next - monotonicNow()));
  }
  if (!gateway && !options.manual) citar(Math.max(0, next - monotonicNow()));
  const heartbeat = setInterval(() => {
    for (const [socket, client] of clients) {
      if (!client.alive || !sessions.sessionValid(client.hash)) { socket.terminate(); continue; }
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
  let cierre: Promise<void> | undefined;
  return {
    /** `world` es el mundo vivo, para `main.ts` al arrancar (antes de ningún paso), bancos y pruebas. Tras un
     * paso sin reserva que falló es el mundo a medio paso (PERF3): muerto, nadie lo proyecta ni lo guarda, y
     * lo que se le haga ya no llega a ninguna parte; las pruebas lo leen justo para comprobarlo. */
    server, stepOnce, broadcast, requestGesture, requestWhisper, view, salud,
    /** V24: Mensajes Divinos waiting for their step (tests and benches), and whether the last step applied one. */
    get susurrosPendientes() { return pendingWhispers.length; },
    get susurrosEnUltimoPaso() { return susurrosEnUltimoPaso; },
    get respaldo() { return respaldo; },
    /** Arranca el bucle de pasos cuando `createApp` se creó con `manual: true` (p. ej. tras la autoprueba GPU). */
    start() { if (!gateway && !stopped && !timer && !bucleTurbo) { next = monotonicNow() + tickMs; citar(Math.max(0, next - monotonicNow())); } },
    get world() { return world; }, get failed() { return failed; },
    /** Gestos aceptados que esperan su paso (bancos y pruebas: saber que un gesto ya está en el lote
     * del paso siguiente sin adivinarlo por tiempo). */
    get gestosPendientes() { return pending.size; },
    /** Contrapresión por socket vivo (bancos y pruebas). */
    get flujo(): FlujoCliente[] {
      return [...clients].map(([socket, c]) => ({ remotePort: (socket as unknown as { _socket?: { remotePort?: number } })._socket?.remotePort ?? null,
        acuse: !!c.flujo, subscribeMs: c.subscribeMs, enVuelo: !!c.flujo?.enVuelo, enviados: c.flujo?.enviados ?? 0, aplazados: c.flujo?.aplazados ?? 0,
        acuses: c.flujo?.acuses ?? 0, ultimoAcuseMs: c.flujo?.ultimoAcuseMs ?? null, ultimoEnlaceMs: c.flujo?.ultimoEnlaceMs ?? null,
        comprime: deflateNegociado(socket) && (compresion === 'siempre' || !!c.flujo?.comprimir), bufferedAmount: socket.bufferedAmount }));
    },
    /** Copia de las métricas vivas; solo lectura. */
    get runtime(): RuntimeStats { if (gateway) return gateway.runtime; return { ...runtime }; },
    /** Pausa manual de los nacimientos: `false` los detiene; `true` y `null` los permiten. Es de este proceso
     * y la única mano que escribe `reproductionEnabled`: al reiniciar, el mundo vuelve a permitirlos. */
    setReproduccionManual(value: boolean | null) { reproduccionManual = value; normalizarReproduccion(); },
    close() {
      if (cierre) return cierre;
      stopped = true; if (timer) clearTimeout(timer); if (inmediato) clearImmediate(inmediato); clearInterval(heartbeat); clearInterval(latido);
      for (const item of pending.values()) { item.promise.catch(() => undefined); item.reject(new HttpError(503, 'El servicio se está cerrando.')); }
      pending.clear();
      rejectWhispers(new HttpError(503, 'El servicio se está cerrando.'));
      for (const socket of clients.keys()) socket.terminate();
      for (const socket of conexionesNuevas) socket.destroy();
      conexionesNuevas.clear();
      ws.close();
      // Un keep-alive ocioso dejaba `server.close()` esperando hasta `headersTimeout` (10 s)
      // y, con él, las piscinas y el candado del mundo.
      server.closeIdleConnections();
      server.closeAllConnections();
      cierre = (async () => {
        try {
          if (server.listening) await new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes()));
        } finally {
          try {
            if (!gateway && !failed && !aMedioPaso) store.save(world);
          } finally {
            try {
              // The writer flushes what it still buffers before closing (graceful shutdown keeps every frame).
              try { tapeReader?.close(); } finally { tapeWriter?.close(); tapeWriter = undefined; }
            } finally {
              try { await muestreador?.vaciar(); }
              finally { if (!gateway) await cerrarPiscinasDeComputo(); }
            }
          }
        }
      })();
      return cierre;
    }
  };
}
