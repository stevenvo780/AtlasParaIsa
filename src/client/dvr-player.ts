/**
 * V21 — Controlador DVR del mundo grabado (cinta). Presentación pura: sin DOM, sin red propia.
 *
 * Quien lo usa le inyecta `fetchMeta`/`fetchChunk` (HTTP en el navegador, simulados en las pruebas) y recibe los
 * fotogramas por `onFrame`. `advance(nowMs)` se llama en cada `requestAnimationFrame`: el cabezal fraccionario
 * `playTick` corre a `TAPE_BASE_TICKS_PER_SEC × velocidad` ticks por segundo y libera cada fotograma de la cola al
 * cruzar su `tick`, así `Landscape`/`MotionTracker` reciben un ritmo regular a cualquier velocidad.
 *
 * Invariantes:
 *  - El cabezal nunca supera el último tick cargado: si el búfer se vacía espera, no salta ni retrocede.
 *  - A lo sumo UNA petición de trozo en vuelo; un `seek` invalida (época + `AbortSignal`) la anterior. Un cambio de cámara
 *    (V24) no aborta ni congela: el trozo con la ventana nueva sustituye a la cola desde el tick que se está viendo.
 *  - La cola no pasa de `DVR_LIMITS.maxFrames` fotogramas.
 *
 * V22 — trozos `encoding: 'delta'` (`baseFrame` + `deltas[]`): la cola guarda los deltas SIN expandir y cada uno se aplica
 * (`applyClientTapeDelta`) solo cuando el cabezal lo cruza, así `fetchChunk` no bloquea el hilo con 90 reconstrucciones y
 * `onFrame` recibe `info.changedTiles` (solo las teselas parcheadas) en lugar de las ~6.000 de la vista. Los trozos `full` siguen igual.
 */
import { TAPE_BASE_TICKS_PER_SEC, TAPE_SPEEDS, applyClientTapeDelta, indexTiles, type TapeChunkResponse, type TapeClientDelta, type TapeMetaResponse, type TapeSpeed, type TapeTimelinePoint } from '../shared/tape.js';
import type { Tile, Viewport, WorldView } from '../shared/types.js';

export const DVR_LIMITS = {
  /** Tamaño de la cola de fotogramas por delante del cabezal (anillo). */
  maxFrames: 360,
  /** Fotogramas por trozo: normal / a velocidades ≥ 10×. */
  chunkCount: 90, fastChunkCount: 120, fastSpeed: 10,
  /** Se pide el siguiente trozo cuando quedan menos de estos fotogramas por delante (≈ 7 s a 1×). */
  prefetchBelow: 45,
  /** El cabezal arranca tantos ticks por detrás del borde vivo: ≈ 5 s de colchón a 1×. */
  liveMargin: 30,
  /** «Borde vivo» = a lo sumo estos ticks por detrás del último calculado. */
  liveEdgeTicks: 60,
  /** Sondeo de `/api/tape/meta` y fusión de cambios de cámara (ms). */
  metaPollMs: 2000, viewportCoalesceMs: 200,
  /** Tope de un paso del reloj (una pestaña dormida no provoca saltos). */
  maxDtMs: 100,
  /** Memoria de ticks ya mostrados, para retroceder fotograma a fotograma. */
  recentTicks: 360,
} as const;

export type DvrFrameReason = 'start' | 'play' | 'seek' | 'step' | 'refresh';
export interface DvrFrameInfo {
  reason: DvrFrameReason;
  /** Duración visual de un tick a la velocidad actual (ms): alimenta el reloj de `Landscape`. */
  tickIntervalMs: number;
  /** Fotogramas intermedios que el cabezal cruzó en este mismo paso y no se emitieron (velocidades altas). */
  skipped: number;
  /** `true` si el cabezal saltó de sitio (seek, cámara): el colchón visual debe colapsarse, no interpolar. */
  discontinuity: boolean;
  /**
   * V22: teselas que cambiaron respecto al fotograma emitido antes (incluidas las de los fotogramas cruzados sin
   * emitir). Solo existe cuando el fotograma salió de decodificar deltas; ausente = fotograma completo (`frame.tiles`).
   */
  changedTiles?: Tile[];
}

/**
 * V22: cadena de decodificación de un trozo `encoding: 'delta'`. Cada delta se aplica sobre el último fotograma
 * decodificado de SU trozo (`frame`), con el índice de teselas compartido para tocar solo las modificadas.
 */
interface DeltaChain { frame: WorldView | null; tileIndex: Map<string, number> | null; }
/** Entrada de la cola: un fotograma ya completo (`full`/base) o un delta aún sin expandir (`delta`). */
interface QueuedFrame { tick: number; full?: WorldView; delta?: TapeClientDelta; chain?: DeltaChain; }

export interface DvrChunkRequest { fromTick: number; count: number; viewport: Viewport | null; signal: AbortSignal; }

export interface DvrState {
  enabled: boolean; observerOnly: boolean; turbo: boolean;
  playing: boolean; speed: TapeSpeed;
  playTick: number; currentTick: number; minTick: number; maxTick: number;
  latestDay: number; simHz: number; timeline: TapeTimelinePoint[];
  bufferedAhead: number; aheadOfPlayhead: number; atLiveEdge: boolean; loading: boolean;
  error: string | null;
}

export interface DvrPlayerOptions {
  fetchMeta: () => Promise<TapeMetaResponse>;
  fetchChunk: (request: DvrChunkRequest) => Promise<TapeChunkResponse>;
  onFrame: (frame: WorldView, info: DvrFrameInfo) => void;
  onStateChange?: (state: DvrState) => void;
  /** 0 desactiva el sondeo automático (las pruebas llaman a `pollMeta()`). */
  metaPollMs?: number;
  viewportCoalesceMs?: number;
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** Misma normalización que `Connection.setViewport`: enteros y tamaño acotado. */
export function normalizeViewport(viewport: Viewport): Viewport | null {
  if (![viewport.x, viewport.y, viewport.width, viewport.height].every(Number.isFinite)) return null;
  const width = clamp(Math.ceil(viewport.width), 1, 96), height = clamp(Math.ceil(viewport.height), 1, 64);
  return { x: clamp(Math.floor(viewport.x), -10_000_000, 10_000_000 - width), y: clamp(Math.floor(viewport.y), -10_000_000, 10_000_000 - height), width, height };
}

export class DvrPlayer {
  enabled = false;
  observerOnly = false;
  turbo = false;
  playing = true;
  speed: TapeSpeed = 1;
  /** Cabezal continuo (fraccionario), en ticks del mundo. */
  playTick = 0;
  /** Último tick emitido (entero). */
  currentTick = 0;
  minTick = 0;
  maxTick = 0;
  latestDay = 0;
  simHz = 0;
  timeline: TapeTimelinePoint[] = [];
  loading = false;
  error: string | null = null;

  /** Fotogramas ya cargados que aún no se han emitido, en orden de tick (todos > `currentTick`). Los deltas se expanden al cruzarlos. */
  private frames: QueuedFrame[] = [];
  /** Deltas expandidos hasta ahora (diagnóstico y pruebas: la decodificación es perezosa). */
  decodedDeltas = 0;
  private viewport: Viewport | null = null;
  private pendingViewport: Viewport | null = null;
  private viewportTimer: ReturnType<typeof setTimeout> | undefined;
  private metaTimer: ReturnType<typeof setInterval> | undefined;
  private epoch = 0;
  private inFlight = false;
  private aborter: AbortController | null = null;
  /** Hay un salto (seek/arranque) esperando su primer fotograma: el cabezal no corre. */
  private jumping = false;
  /** V24: la cámara cambió y falta pedir el trozo con la ventana nueva (sale en cuanto no haya otra petición en vuelo). */
  private refreshPending = false;
  private started = false;
  private lastNow: number | null = null;
  private recent: number[] = [];
  private polling: Promise<void> | null = null;

  constructor(private readonly options: DvrPlayerOptions) {}

  /* ---------------------------------------------------------------- */
  /* Estado derivado                                                  */
  /* ---------------------------------------------------------------- */

  get bufferedAhead(): number { return this.frames.length; }
  get aheadOfPlayhead(): number { return Math.max(0, this.maxTick - this.currentTick); }
  get atLiveEdge(): boolean { return this.aheadOfPlayhead <= DVR_LIMITS.liveEdgeTicks; }
  /** Último tick cargado (emitido o en cola): el cabezal no puede pasar de aquí. */
  get maxLoadedTick(): number { return this.frames.length ? this.frames[this.frames.length - 1]!.tick : this.currentTick; }
  /** Duración visual de un tick a la velocidad actual. */
  get tickIntervalMs(): number { return 1000 / (TAPE_BASE_TICKS_PER_SEC * this.speed); }

  snapshot(): DvrState {
    return {
      enabled: this.enabled, observerOnly: this.observerOnly, turbo: this.turbo, playing: this.playing, speed: this.speed,
      playTick: this.playTick, currentTick: this.currentTick, minTick: this.minTick, maxTick: this.maxTick,
      latestDay: this.latestDay, simHz: this.simHz, timeline: this.timeline,
      bufferedAhead: this.bufferedAhead, aheadOfPlayhead: this.aheadOfPlayhead, atLiveEdge: this.atLiveEdge,
      loading: this.loading, error: this.error,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Ciclo de vida                                                    */
  /* ---------------------------------------------------------------- */

  /** Lee la meta, coloca el cabezal en el borde vivo con colchón y emite el primer fotograma. `false` si la cinta no está activa. */
  async start(): Promise<boolean> {
    this.stopTimers();
    try { this.applyMeta(await this.options.fetchMeta()); }
    catch (error) { this.error = describe(error); this.notify(); return false; }
    if (!this.enabled) { this.notify(); return false; }
    const poll = this.options.metaPollMs ?? DVR_LIMITS.metaPollMs;
    if (poll > 0) this.metaTimer = setInterval(() => void this.pollMeta(), poll);
    if (this.hasFrames()) await this.jump(this.liveTick(), 'start', false);
    else this.notify();
    return true;
  }

  stop(): void {
    this.stopTimers();
    this.epoch++; this.aborter?.abort(); this.aborter = null; this.inFlight = false; this.loading = false; this.jumping = false; this.refreshPending = false;
    this.frames = [];
  }

  /** Vuelve a leer `/api/tape/meta`: refresca límites, Hz y línea de tiempo, y rellena el búfer si hace falta. */
  pollMeta(): Promise<void> {
    if (this.polling) return this.polling;
    const run = (async () => {
      try {
        this.applyMeta(await this.options.fetchMeta());
        this.error = null;
        if (!this.enabled) { this.notify(); return; }
        if (!this.started && !this.jumping && this.hasFrames()) await this.jump(this.liveTick(), 'start', false);
        else if (this.started && !this.jumping && this.playTick < this.minTick) await this.jump(this.minTick, 'seek', false); // la cinta rotó bajo el cabezal
        else this.prefetch();
      } catch (error) { this.error = describe(error); }
      this.notify();
    })();
    this.polling = run.finally(() => { this.polling = null; });
    return this.polling;
  }

  /* ---------------------------------------------------------------- */
  /* Reproducción a 60 fps                                            */
  /* ---------------------------------------------------------------- */

  /** Un paso del reloj de animación (`nowMs`: el de `requestAnimationFrame`). */
  advance(nowMs: number): void {
    const dt = this.lastNow === null || !Number.isFinite(nowMs) ? 0 : clamp(nowMs - this.lastNow, 0, DVR_LIMITS.maxDtMs);
    if (Number.isFinite(nowMs)) this.lastNow = nowMs;
    if (!this.enabled || !this.started) return;
    if (this.playing && !this.jumping && dt > 0) {
      // Nunca más allá de lo cargado: con el búfer vacío el cabezal espera, no salta ni retrocede.
      this.playTick = Math.min(this.playTick + dt / 1000 * TAPE_BASE_TICKS_PER_SEC * this.speed, Math.max(this.currentTick, this.maxLoadedTick));
      let crossed = 0;
      const batch: QueuedFrame[] = [];
      while (this.frames.length && this.frames[0]!.tick <= this.playTick) { batch.push(this.frames.shift()!); crossed++; }
      // A 10×–25× se cruzan varios fotogramas por rAF: solo el último se entrega. Los deltas intermedios sí se aplican
      // (cada uno parte del anterior) pero su fotograma no se emite; sus teselas cambiadas se acumulan en el entregado.
      if (batch.length && !this.deliver(batch, 'play', crossed - 1)) return;
    }
    if (this.refreshPending) void this.refresh();
    this.prefetch();
  }

  /* ---------------------------------------------------------------- */
  /* Controles                                                        */
  /* ---------------------------------------------------------------- */

  setPlaying(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;
    this.notify();
  }

  togglePlaying(): void { this.setPlaying(!this.playing); }

  setSpeed(speed: TapeSpeed): void {
    if (!TAPE_SPEEDS.includes(speed) || this.speed === speed) return;
    this.speed = speed;
    this.prefetch(); this.notify();
  }

  /** Salta a `tick` (acotado a la cinta), descarta lo cargado por delante y emite el primer fotograma en cuanto llega. */
  seek(tick: number): Promise<void> {
    if (!this.enabled || !Number.isFinite(tick)) return Promise.resolve();
    return this.jump(tick, 'seek', false);
  }

  /** Un fotograma atrás (-1) o adelante (+1). Pausa si estaba reproduciendo. */
  async step(delta: -1 | 1): Promise<void> {
    if (!this.enabled || !this.started) return;
    if (this.playing) { this.playing = false; this.notify(); }
    if (delta > 0) {
      const next = this.frames.shift();
      if (next) { this.playTick = next.tick; if (this.deliver([next], 'step', 0)) this.prefetch(); return; }
      if (this.currentTick >= this.maxTick) return;
      return this.jump(this.currentTick + 1, 'step', false);
    }
    const previous = [...this.recent].reverse().find(tick => tick < this.currentTick) ?? this.currentTick - 1;
    if (previous < this.minTick) return;
    return this.jump(previous, 'step', false);
  }

  /** Vuelve al borde vivo (con colchón) y reproduce. */
  jumpToLiveEdge(): Promise<void> {
    this.playing = true;
    if (!this.enabled) { this.notify(); return Promise.resolve(); }
    return this.jump(this.liveTick(), 'seek', false);
  }

  /** La cámara cambió: se fusiona ~200 ms y se refresca el trozo en `currentTick` sin perder la posición. */
  setViewport(viewport: Viewport): void {
    const next = normalizeViewport(viewport);
    if (!next) return;
    if (JSON.stringify(next) === JSON.stringify(this.pendingViewport ?? this.viewport)) return;
    this.pendingViewport = next;
    if (!this.started) { this.viewport = next; this.pendingViewport = null; return; } // aún no se pidió nada: no hay qué refrescar
    if (this.viewportTimer !== undefined) return; // la ventana no se rearma con cada movimiento: sale con la última cámara
    this.viewportTimer = setTimeout(() => { this.viewportTimer = undefined; void this.applyViewport(); }, this.options.viewportCoalesceMs ?? DVR_LIMITS.viewportCoalesceMs);
  }

  /** Aplica ya la cámara pendiente (las pruebas lo usan en lugar de esperar el temporizador). */
  flushViewport(): Promise<void> {
    clearTimeout(this.viewportTimer); this.viewportTimer = undefined;
    return this.applyViewport();
  }

  /* ---------------------------------------------------------------- */
  /* Internos                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * V24: la cámara nueva NO congela la reproducción. Lo ya cargado (recortado para la cámara anterior) sigue
   * reproduciéndose; se pide un trozo desde el fotograma actual con la cámara nueva y, al llegar, sustituye a la cola
   * desde el tick que esté mostrando el cabezal (sin abortar nada, sin discontinuidad y sin vaciar la cola antes).
   */
  private applyViewport(): Promise<void> {
    const next = this.pendingViewport; this.pendingViewport = null;
    if (!next || JSON.stringify(next) === JSON.stringify(this.viewport)) return Promise.resolve();
    this.viewport = next;
    if (!this.enabled || !this.started) return Promise.resolve();
    this.refreshPending = true;
    return this.refresh();
  }

  /** Trozo con la cámara actual desde `currentTick`; espera su turno si ya hay una petición en vuelo. */
  private async refresh(): Promise<void> {
    if (!this.refreshPending || this.inFlight || this.jumping || !this.enabled || !this.started) return;
    this.refreshPending = false;
    const epoch = this.epoch, viewport = this.viewport;
    const chunk = await this.fetchChunk(this.currentTick, this.chunkCount(), epoch);
    if (epoch !== this.epoch) return; // un salto lo reemplazó
    if (!chunk) { this.notify(); return; }
    this.applyChunkBounds(chunk); this.error = null;
    if (viewport !== this.viewport) this.refreshPending = true; // la cámara volvió a moverse mientras volaba
    // El cabezal siguió avanzando mientras volaba: el trozo se corta en el tick que se ve ahora.
    const list = DvrPlayer.ordered(chunk, this.currentTick - 1);
    const first = list.shift();
    if (!first || first.tick !== this.currentTick) { // el cabezal ya pasó este trozo: se reintenta con la cámara actual
      if (first) list.unshift(first);
      if (list.length && list[0]!.tick > this.currentTick) this.frames = list.slice(0, DVR_LIMITS.maxFrames);
      else this.refreshPending = true;
      this.notify(); return;
    }
    this.frames = list.slice(0, DVR_LIMITS.maxFrames);
    let decoded: { frame: WorldView };
    try { decoded = this.decode(first); }
    catch (error) { this.error = describe(error); this.frames = []; this.notify(); return; }
    // Mismo tick con la ventana nueva: se repinta sin discontinuidad (los cuerpos siguen su interpolación).
    this.emit(decoded.frame, 'refresh', 0, false);
    this.prefetch();
  }

  private hasFrames(): boolean { return this.maxTick >= this.minTick && this.maxTick >= 0; }
  private liveTick(): number { return Math.max(this.minTick, this.maxTick - DVR_LIMITS.liveMargin); }
  private chunkCount(): number { return this.speed >= DVR_LIMITS.fastSpeed ? DVR_LIMITS.fastChunkCount : DVR_LIMITS.chunkCount; }
  /** Colchón mínimo por delante antes de pedir más: ≥ 45 fotogramas y, a velocidad alta, ≈ 1,5 s de reproducción. */
  private prefetchThreshold(): number { return Math.max(DVR_LIMITS.prefetchBelow, Math.ceil(TAPE_BASE_TICKS_PER_SEC * this.speed * 1.5)); }

  private stopTimers(): void {
    clearInterval(this.metaTimer); this.metaTimer = undefined;
    clearTimeout(this.viewportTimer); this.viewportTimer = undefined;
  }

  private applyMeta(meta: TapeMetaResponse): void {
    this.enabled = !!meta.enabled; this.observerOnly = !!meta.observerOnly; this.turbo = !!meta.turbo;
    if (Number.isFinite(meta.minTick)) this.minTick = meta.minTick;
    if (Number.isFinite(meta.maxTick)) this.maxTick = meta.maxTick;
    if (Number.isFinite(meta.latestDay)) this.latestDay = meta.latestDay;
    if (Number.isFinite(meta.simHz)) this.simHz = meta.simHz;
    this.timeline = Array.isArray(meta.timeline) ? meta.timeline : [];
  }

  private applyChunkBounds(chunk: TapeChunkResponse): void {
    if (Number.isFinite(chunk.minTick)) this.minTick = chunk.minTick;
    if (Number.isFinite(chunk.maxTick) && chunk.maxTick > this.maxTick) this.maxTick = chunk.maxTick;
    if (Number.isFinite(chunk.simHz) && chunk.simHz > 0) this.simHz = chunk.simHz;
  }

  /**
   * Expande (si hace falta) la tanda de entradas cruzadas por el cabezal y entrega la última. Devuelve `false` si un
   * delta corrupto obligó a descartar la cola (el error queda en `error` y se repide desde el tick actual).
   */
  private deliver(batch: QueuedFrame[], reason: DvrFrameReason, skipped: number): boolean {
    let frame: WorldView | null = null, changed: Tile[] | undefined = [];
    try {
      for (const entry of batch) {
        const decoded = this.decode(entry);
        frame = decoded.frame;
        if (decoded.changedTiles === undefined) changed = undefined; // base/completo: no hay lista parcial fiable
        else if (changed) { for (const tile of decoded.changedTiles) changed.push(tile); }
      }
    } catch (error) {
      this.error = describe(error); this.frames = []; this.notify();
      return false;
    }
    if (!frame) return true;
    this.emit(frame, reason, skipped, false, changed);
    return true;
  }

  /** Un fotograma de la cola → `WorldView`. Los completos pasan tal cual; un delta se aplica sobre su cadena. */
  private decode(entry: QueuedFrame): { frame: WorldView; changedTiles?: Tile[] } {
    if (entry.full) {
      if (entry.chain) { entry.chain.frame = entry.full; entry.chain.tileIndex = null; }
      return { frame: entry.full };
    }
    const chain = entry.chain, delta = entry.delta;
    if (!chain?.frame || !delta) throw new Error('Delta de la cinta sin fotograma base.');
    if ((delta.tilesPatch?.length || delta.removedTiles?.length) && !chain.tileIndex) chain.tileIndex = indexTiles(chain.frame.tiles);
    const { frame, changedTiles } = applyClientTapeDelta(chain.frame, delta, chain.tileIndex ?? undefined);
    chain.frame = frame; this.decodedDeltas++;
    return { frame, changedTiles };
  }

  private emit(frame: WorldView, reason: DvrFrameReason, skipped: number, discontinuity: boolean, changedTiles?: Tile[]): void {
    this.currentTick = frame.tick; this.started = true;
    while (this.recent.length && this.recent[this.recent.length - 1]! >= frame.tick) this.recent.pop();
    this.recent.push(frame.tick);
    if (this.recent.length > DVR_LIMITS.recentTicks) this.recent.shift();
    this.options.onFrame(frame, { reason, tickIntervalMs: this.tickIntervalMs, skipped, discontinuity, ...(changedTiles ? { changedTiles } : {}) });
    this.notify();
  }

  private notify(): void { this.options.onStateChange?.(this.snapshot()); }

  private async fetchChunk(fromTick: number, count: number, epoch: number): Promise<TapeChunkResponse | null> {
    const aborter = new AbortController();
    this.aborter = aborter; this.inFlight = true; this.loading = true;
    try {
      const chunk = await this.options.fetchChunk({ fromTick, count, viewport: this.viewport, signal: aborter.signal });
      return epoch === this.epoch ? chunk : null; // respuesta de antes de un seek/cambio de cámara: se descarta
    } catch (error) {
      if (epoch === this.epoch) this.error = describe(error);
      return null;
    } finally {
      if (epoch === this.epoch) { this.inFlight = false; this.loading = false; }
    }
  }

  /**
   * Fotogramas de un trozo en orden de tick y sin repetidos, a partir de `after` (exclusivo). `'delta'` produce
   * entradas perezosas (base completa + deltas sin expandir); los deltas anteriores a `after` se aplican ya (son pocos:
   * el servidor pide desde `fromTick`) para que la cadena siga siendo exacta.
   */
  private static ordered(chunk: TapeChunkResponse, after: number): QueuedFrame[] {
    const out: QueuedFrame[] = [];
    if (chunk.encoding === 'delta' && chunk.baseFrame) {
      const chain: DeltaChain = { frame: null, tileIndex: null };
      const entries: QueuedFrame[] = [{ tick: chunk.baseFrame.tick, full: chunk.baseFrame, chain }];
      for (const delta of [...(chunk.deltas ?? [])].sort((a, b) => a.tick - b.tick)) entries.push({ tick: delta.tick, delta, chain });
      for (const entry of entries) {
        if (!Number.isFinite(entry.tick) || (out.length && out[out.length - 1]!.tick === entry.tick)) continue;
        if (entry.tick <= after) { DvrPlayer.foldIntoChain(entry); continue; }
        out.push(entry);
      }
      return out;
    }
    for (const frame of [...(chunk.frames ?? [])].sort((a, b) => a.tick - b.tick)) {
      if (!Number.isFinite(frame.tick) || frame.tick <= after || (out.length && out[out.length - 1]!.tick === frame.tick)) continue;
      out.push({ tick: frame.tick, full: frame });
    }
    return out;
  }

  /** Aplica a la cadena una entrada que no se pondrá en cola (anterior al punto de corte). */
  private static foldIntoChain(entry: QueuedFrame): void {
    const chain = entry.chain; if (!chain) return;
    if (entry.full) { chain.frame = entry.full; chain.tileIndex = null; return; }
    if (!chain.frame || !entry.delta) return;
    chain.frame = applyClientTapeDelta(chain.frame, entry.delta).frame; chain.tileIndex = null;
  }

  /**
   * Salto: invalida lo cargado y lo pedido, repide desde `fromTick` y emite el primer fotograma. Con `keepPlayTick`
   * (cambio de cámara) conserva el cabezal fraccionario y re-emite el fotograma actual con la nueva cámara.
   */
  private async jump(fromTick: number, reason: DvrFrameReason, keepPlayTick: boolean): Promise<void> {
    const target = clamp(Math.floor(fromTick), this.minTick, Math.max(this.minTick, this.maxTick));
    const epoch = ++this.epoch;
    this.aborter?.abort();
    this.frames = []; this.jumping = true; this.refreshPending = false; // el salto ya pide con la cámara actual
    if (!keepPlayTick) this.playTick = target;
    this.notify();
    const chunk = await this.fetchChunk(target, this.chunkCount(), epoch);
    if (epoch !== this.epoch) return; // otro salto lo reemplazó
    this.jumping = false;
    if (!chunk) { this.notify(); return; }
    this.applyChunkBounds(chunk); this.error = null;
    // Con `keepPlayTick` el primer fotograma ES el actual: se repinta con la cámara nueva aunque su tick no avance.
    const list = DvrPlayer.ordered(chunk, keepPlayTick ? target - 1 : Number.NEGATIVE_INFINITY);
    const first = list.shift();
    if (!first) { this.notify(); return; }
    this.frames = list.slice(0, DVR_LIMITS.maxFrames);
    this.playTick = keepPlayTick ? Math.max(this.playTick, first.tick) : first.tick;
    if (this.deliverFirst(first, reason)) this.prefetch();
  }

  /** Primer fotograma tras un salto: siempre completo (la base del trozo), con discontinuidad. */
  private deliverFirst(first: QueuedFrame, reason: DvrFrameReason): boolean {
    let decoded: { frame: WorldView };
    try { decoded = this.decode(first); }
    catch (error) { this.error = describe(error); this.frames = []; this.notify(); return false; }
    this.emit(decoded.frame, reason, 0, true);
    return true;
  }

  /** Pide el siguiente trozo si quedan pocos fotogramas por delante y la cinta tiene más. */
  private prefetch(): void {
    if (!this.enabled || !this.started || this.inFlight || this.jumping || this.error) return;
    const count = this.chunkCount();
    if (this.frames.length >= this.prefetchThreshold() || this.frames.length + count > DVR_LIMITS.maxFrames) return;
    const loaded = this.maxLoadedTick;
    if (loaded >= this.maxTick) return;
    const epoch = this.epoch;
    void this.fetchChunk(loaded + 1, count, epoch).then(chunk => {
      if (!chunk || epoch !== this.epoch) { this.notify(); return; }
      this.applyChunkBounds(chunk); this.error = null;
      const fresh = DvrPlayer.ordered(chunk, this.maxLoadedTick);
      this.frames.push(...fresh.slice(0, Math.max(0, DVR_LIMITS.maxFrames - this.frames.length)));
      this.notify();
      if (this.refreshPending) void this.refresh();
      this.prefetch();
    });
  }
}

function describe(error: unknown): string { return error instanceof Error ? error.message : 'La cinta no respondió.'; }
