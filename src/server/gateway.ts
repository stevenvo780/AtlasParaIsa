import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { deserialize } from 'node:v8';
import { createReadOnlyApp, HttpError, type GatewayAppOptions, type ReadOnlyBackend } from './app.js';
import { Store } from './store.js';
import { normalizeViewport } from '../world/spatial.js';
import { CHUNK_SIZE, generateChunk, legacyStructures, type Chunk } from '../world/terrain.js';
import { initializeEcosystem } from '../world/ecosystem.js';
import { projectAnimal } from '../world/animals.js';
import { clavesVivasEn } from './regiones-vivas.js';
import { TapeReader, tapePathForWorld } from './tape-store.js';
import { projectMirrorTile, type MirrorUpdate, type SessionMirror, type SimReply, type SimRpc, type SimWorkerOptions } from './sim-worker.js';
import type { RuntimeStats, Tile, Viewport, WorldView } from '../shared/types.js';
import type { TapeChunkEncoding } from '../shared/tape.js';
import type { World } from '../world/index.js';

export interface WorkerGatewayOptions extends GatewayAppOptions, SimWorkerOptions {}
type Session = { expires: number; flag: Int32Array };
type TilePage = { data: Uint8Array; tiles?: Tile[] };

/**
 * Main-thread transport. Only an authenticated, immutable projection crosses from the
 * simulation worker. Its archive connection is WAL/read-only: never load/save a World here.
 */
export function createWorkerGateway(options: WorkerGatewayOptions) {
  let mirror: MirrorUpdate | undefined;
  let archive: Store | undefined;
  /** V21: same rule as the worker (`tickMs: 0` is turbo; the tape follows turbo unless set). */
  const turbo = !!options.turbo || options.tickMs === 0;
  const tapeEnabled = options.tape ?? turbo;
  /** Read-only WAL view of the worker's tape: scrubbing never sends an RPC to the simulation. */
  let tapeReader: TapeReader | undefined;
  let fatal: Error | undefined;
  let simulationPaused = false;
  let lastPublishMs = 0;
  let closing = false, started = !options.manual, isReady = false;
  let nextId = 0;
  const calls = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const sessions = new Map<string, Session>();
  const validSessionHashes = new Set<string>();
  const pages = new Map<string, TilePage>();
  let activeKeys: World['chunks'] = Object.create(null);
  let pendingChunks = new Map<string, Chunk>();
  const scenery = new Map<string, Chunk>();
  const events = new EventEmitter();
  let applying = Promise.resolve();
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((yes, no) => { readyResolve = yes; readyReject = no; });
  // close() before a caller awaits ready must not create an unhandled rejection.
  void ready.catch(() => undefined);
  function rpc<T>(method: string, ...args: unknown[]): Promise<T> {
    if (fatal) return Promise.reject(fatal);
    // After a clean shutdown nothing answers: a late call must settle, never hang its caller.
    if (workerExited) return Promise.reject(new HttpError(503, 'La simulación ya terminó.'));
    const id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      calls.set(id, { resolve: value => resolve(value as T), reject });
      try { worker.postMessage({ type: 'rpc', id, method, args } satisfies SimRpc); }
      catch (error) { calls.delete(id); reject(error); }
    });
  }
  function fail(error: Error) {
    if (fatal) return;
    fatal = error;
    readyReject(error);
    for (const call of calls.values()) call.reject(error);
    calls.clear();
    for (const session of sessions.values()) Atomics.store(session.flag, 0, 0);
    validSessionHashes.clear();
    events.emit('workerError', error);
    if (mirror) transport.broadcast();
  }
  function valid(hash: string) {
    const session = sessions.get(hash);
    if (fatal || !validSessionHashes.has(hash) || !session || session.expires <= Date.now() || Atomics.load(session.flag, 0) !== 1) {
      validSessionHashes.delete(hash); return false;
    }
    return true;
  }
  function sessionWrite(method: string, hash: string, ...args: unknown[]) {
    void rpc(method, hash, ...args).catch(error => {
      const session = sessions.get(hash);
      if (session) Atomics.store(session.flag, 0, 0);
      validSessionHashes.delete(hash);
      fail(error instanceof Error ? error : new Error('Session persistence failed.'));
    });
  }
  function chunkAt(key: string, cx: number, cy: number): Chunk {
    const pending = pendingChunks.get(key);
    if (pending) return pending;
    // Do not cache archived reads across ticks: the sole writer can retire/revisit a chunk.
    const saved = archive?.loadChunk(key, mirror!.view.tick);
    if (saved) return saved;
    let generated = scenery.get(key);
    if (!generated) {
      generated = generateChunk(mirror!.seed, cx, cy, mirror!.cuencas);
      if (scenery.size >= 128) scenery.delete(scenery.keys().next().value!);
      scenery.set(key, generated);
    }
    return generated;
  }
  /** Static/unmodified tiles for one tape chunk request, the way `view` fills terrain outside the live
   * pages: archive/pending/generated chunk, ecosystem initialization, mirror projection. Cached per
   * request, so 240 frames of one camera read each chunk once. */
  function tapeBackground() {
    if (!mirror) throw new HttpError(503, 'El mundo todavía está cargando.');
    const seed = mirror.seed, cuencas = mirror.cuencas;
    const chunks = new Map<string, Chunk>(), tiles = new Map<string, Tile>();
    return (x: number, y: number): Tile => {
      const id = `${x},${y}`;
      let tile = tiles.get(id);
      if (tile) return tile;
      const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE), key = `${cx},${cy}`;
      let chunk = chunks.get(key);
      if (!chunk) { chunk = chunkAt(key, cx, cy); chunks.set(key, chunk); }
      tile = projectMirrorTile(initializeEcosystem(seed, chunk.tiles[(y - cy * CHUNK_SIZE) * CHUNK_SIZE + x - cx * CHUNK_SIZE]!, cuencas));
      tiles.set(id, tile);
      return tile;
    };
  }
  /** Opens the read-only tape once the worker is ready. A DVR that cannot open is a 503 on its own
   * endpoints, retried on the next request: it never takes the live gateway down with it. */
  function openTape(): TapeReader | undefined {
    if (tapeReader || !tapeEnabled || !isReady || closing) return tapeReader;
    try { tapeReader = new TapeReader({ path: tapePathForWorld(options.worldPath), observerOnly: !!options.observerOnly, turbo }); }
    catch (error) { if (options.deployment) console.warn(JSON.stringify({ cinta: 'no se pudo abrir', motivo: error instanceof Error ? error.message : String(error) })); }
    return tapeReader;
  }
  function tape(): TapeReader {
    const reader = openTape();
    if (!reader) throw new HttpError(503, 'La cinta todavía no está disponible.');
    return reader;
  }
  function view(viewport?: Viewport): WorldView {
    if (!mirror) throw new HttpError(503, 'El mundo todavía está cargando.');
    const v = normalizeViewport(viewport), source = mirror.view;
    const tiles: Tile[] = [], chunks = new Map<string, Chunk>();
    const places = new Map(source.places.map(p => [p.id, p]));
    for (let y = v.y; y < v.y + v.height; y++) for (let x = v.x; x < v.x + v.width; x++) {
      const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE), key = `${cx},${cy}`;
      const index = (y - cy * CHUNK_SIZE) * CHUNK_SIZE + x - cx * CHUNK_SIZE;
      const page = pages.get(key);
      if (page) {
        if (!page.tiles) {
          const decoded = deserialize(page.data) as Tile[];
          page.tiles = [];
          for (const tile of decoded) page.tiles[(tile.y - cy * CHUNK_SIZE) * CHUNK_SIZE + tile.x - cx * CHUNK_SIZE] = tile;
        }
        const tile = page.tiles[index];
        if (tile) { tiles.push(tile); continue; }
      }
      let chunk = chunks.get(key);
      if (!chunk) {
        chunk = chunkAt(key, cx, cy); chunks.set(key, chunk);
        for (const place of chunk.places) places.set(place.id, place);
      }
      tiles.push(projectMirrorTile(initializeEcosystem(mirror.seed, chunk.tiles[index]!, mirror.cuencas)));
    }
    const visible = (p: { x: number; y: number }, margin = 0) => p.x >= v.x - margin && p.y >= v.y - margin
      && p.x < v.x + v.width + margin && p.y < v.y + v.height + margin;
    const people = source.people.filter(p => visible(p, 1)), visibleIds = new Set(people.map(p => p.id));
    const structures = [...source.structures ?? [], ...[...chunks.values()].flatMap(c => c.structures ?? legacyStructures(c.tiles, c.lastTick))].filter(s => visible(s, 1));
    const blueprintIds = new Set(structures.map(s => s.blueprintId));
    return { ...source, width: v.width, height: v.height, originX: v.x, originY: v.y, tiles, people,
      places: [...places.values()].filter(p => visible(p)),
      animals: [...source.animals ?? [], ...[...chunks.values()].flatMap(c => (c.animals ?? []).map(a => projectAnimal(a, source.tick)))].filter(a => visible(a)),
      structures, blueprints: source.blueprints?.filter(b => blueprintIds.has(b.id)),
      communities: source.communities?.map(c => ({ ...c, members: c.members.filter(id => visibleIds.has(id)) })),
      technology: source.technology && { ...source.technology, items: source.technology.items.filter(i => visibleIds.has(i.ownerId)),
        ...(source.technology.knowledge ? { knowledge: source.technology.knowledge.filter(k => visibleIds.has(k.actorId)) } : {}) },
      regionesVivas: clavesVivasEn({ chunks: activeKeys }, v),
      ...((fatal || simulationPaused || mirror.failed) ? { paused: true, pauseReason: 'El mundo está en pausa. Se muestra el último paso completo.' } : {}) };
  }
  const backend: ReadOnlyBackend = {
    sessions: {
      sessionValid: valid,
      addSession(hash, expires) {
        if (!isReady || closing || fatal) throw new HttpError(503, 'El mundo todavía no está disponible.');
        const flag = new Int32Array(new SharedArrayBuffer(4)); flag[0] = 1;
        sessions.set(hash, { expires, flag }); validSessionHashes.add(hash);
        sessionWrite('login', hash, expires, flag.buffer);
      },
      revoke(hash) {
        const hashes = hash ? [hash] : [...sessions.keys()];
        for (const id of hashes) {
          const session = sessions.get(id);
          if (session) Atomics.store(session.flag, 0, 0);
          sessions.delete(id); validSessionHashes.delete(id);
          sessionWrite('logout', id);
        }
      },
    },
    view,
    gesture: (gesture, hash) => {
      if (!valid(hash)) return Promise.reject(new HttpError(401, 'La sesión terminó.'));
      return rpc('gesture', gesture, hash);
    },
    person: id => rpc('personDetail', id),
    recipe: id => rpc('recipeDetail', id),
    regions: () => ({ tick: mirror?.view.tick ?? 0, regionesVivas: Object.keys(activeKeys) }),
    get runtime() { return mirror?.view.performance ?? {} as RuntimeStats; },
    get deltas() { return mirror?.deltas ?? false; },
    get failed() { return !!fatal || simulationPaused || !mirror || mirror.failed; },
    get respaldo() { return mirror?.respaldo; },
    ...(tapeEnabled ? {
      tapeMeta: () => tape().readMeta(240),
      tapeChunk: (fromTick: number, count: number, viewport?: Viewport, encoding?: TapeChunkEncoding) => {
        const reader = tape();
        return reader.readChunk(fromTick, count, viewport, viewport ? tapeBackground() : undefined, encoding);
      },
    } : {}),
  };
  // Validate credentials/origins before spawning, so configuration errors cannot orphan a worker.
  const transport = createReadOnlyApp(options, backend);
  let moduleURL = new URL('./sim-worker.js', import.meta.url);
  const sourceLoader = new URL(import.meta.url).pathname.endsWith('.ts');
  if (sourceLoader && !existsSync(moduleURL)) moduleURL = new URL('./sim-worker.ts', import.meta.url);
  const worker = new Worker(`
    const { workerData } = require('node:worker_threads');
    (async () => {
      if (workerData.loaderURL) (await import(workerData.loaderURL)).register();
      await import(workerData.moduleURL);
    })().catch(error => { setImmediate(() => { throw error; }); });
  `, { eval: true, execArgv: [], name: 'carta-simulation',
    workerData: { role: 'carta-sim', moduleURL: moduleURL.href,
      loaderURL: sourceLoader ? import.meta.resolve('tsx/esm/api') : undefined,
      options: { worldPath: options.worldPath, seed: options.seed, params: options.params, tickMs: options.tickMs,
        deployment: options.deployment, testStepDelayMs: options.testStepDelayMs,
        turbo, tape: tapeEnabled, tapeMaxFrames: options.tapeMaxFrames, tapeKeyframeInterval: options.tapeKeyframeInterval,
        turboSaveIntervalMs: options.turboSaveIntervalMs,
        observerOnly: options.observerOnly } satisfies SimWorkerOptions } });
  let workerExited = false;
  const exited = new Promise<void>(resolve => worker.once('exit', code => {
    workerExited = true;
    if (!closing || calls.size) fail(new Error(`Simulation worker exited (code ${code}).`));
    resolve();
  }));
  worker.on('error', fail);
  async function applyMirror(update: MirrorUpdate) {
    // Yield between bounded pages: even a full census refresh must not monopolize HTTP.
    for (const page of update.pages) {
      if (closing) return;
      const values = deserialize(page.data) as unknown[];
      let destination: unknown[];
      if (page.field === 'pendingChunks') destination = update.pendingChunks;
      else if (page.field.startsWith('technology.')) {
        const field = page.field.slice('technology.'.length) as 'items' | 'recipes' | 'knowledge';
        destination = update.view.technology![field]!;
      } else destination = update.view[page.field as 'people']!;
      for (const value of values) destination.push(value);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const next = Object.create(null) as Record<string, true>;
    for (const key of update.activeKeys) next[key] = true;
    for (const key of pages.keys()) if (!next[key]) pages.delete(key);
    for (const page of update.chunks) pages.set(page.key, { data: page.data });
    pendingChunks = new Map(update.pendingChunks.map(c => [c.key, c]));
    activeKeys = update.activeChunks; mirror = update;
    if (isReady && !closing) transport.broadcast();
    events.emit('mirror', update.view.tick);
  }
  worker.on('message', (message: MirrorUpdate | SimReply | { type: string; [key: string]: unknown }) => {
    try {
      if (message.type === 'reply') {
        const reply = message as SimReply, call = calls.get(reply.id);
        if (!call) return;
        calls.delete(reply.id);
        if (reply.error) call.reject(new HttpError(reply.error.status, reply.error.message));
        else call.resolve(reply.value);
      } else if (message.type === 'mirror') {
        applying = applying.then(() => applyMirror(message as MirrorUpdate));
        void applying.catch(fail);
      } else if (message.type === 'ready') {
        applying = applying.then(() => {
          if (!closing) {
            for (const entry of message.sessions as SessionMirror[]) {
              sessions.set(entry.hash, { expires: entry.expires, flag: new Int32Array(entry.validity) });
              validSessionHashes.add(entry.hash);
            }
            archive = new Store(options.worldPath, { readOnly: true });
            isReady = true;
            // The worker flushed its initial frame before `ready`: the tape file exists from here on.
            openTape();
            readyResolve();
            if (started) void rpc('start').catch(fail);
          } else { isReady = true; readyResolve(); }
        });
        void applying.catch(fail);
      } else if (message.type === 'paused') {
        simulationPaused = true;
        if (mirror) transport.broadcast();
      } else if (message.type === 'log') {
        if (options.deployment) {
          const log = message.level === 'warn' ? console.warn : console.info;
          log(JSON.stringify(message.value));
        }
      } else if (message.type === 'published') {
        lastPublishMs = message.ms as number;
      } else if (message.type === 'step-blocked') events.emit('step-blocked', message.tick);
    } catch (error) { fail(error instanceof Error ? error : new Error('Invalid simulation mirror.')); }
  });
  let closePromise: Promise<void> | undefined;
  return {
    server: transport.server, ready, events,
    start() { started = true; if (isReady && !closing) void rpc('start').catch(fail); },
    get runtime() { return backend.runtime; },
    get failed() { return backend.failed; },
    get workerThreadId() { return worker.threadId; },
    get workerExited() { return workerExited; },
    get publishMs() { return lastPublishMs; },
    /** V21: the worker writes its buffered tape frames now (tests, and readers that need the newest tick). */
    flushTape(): Promise<{ enabled: boolean; frames: number; latestTick: number }> { return rpc('flushTape'); },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        try {
          await transport.close();
          await ready;
          if (!workerExited) await rpc('shutdown');
          await exited;
        } finally {
          try { tapeReader?.close(); } finally {
            tapeReader = undefined;
            archive?.close();
            if (!workerExited) await worker.terminate();
          }
        }
      })();
      return closePromise;
    },
  };
}
