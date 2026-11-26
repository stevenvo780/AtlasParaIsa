/**
 * V23 — Reproductor de la cinta de toda la vida del mundo. Presentación pura: sin DOM, sin red propia.
 *
 * Quien lo usa le inyecta `fetchMeta`/`fetchChunk` (HTTP en el navegador con `crearRedCinta`, simulados en las pruebas)
 * y recibe los fotogramas por `onFrame`. `advance(nowMs)` se llama en cada `requestAnimationFrame`.
 *
 * La cinta tiene 5 niveles de paso fijo (`CINTA.pasos`): el reproductor pide siempre `nivel: 'auto'` (el más fino que
 * cubra el tick pedido) y cada fotograma de la cola lleva el nivel que lo sirvió. A 1× se muestran `CINTA.fpsNormal`
 * fotogramas por segundo DEL NIVEL EN CURSO (no ticks): en L3 son 6 días de mundo por segundo. El reloj cuenta
 * fotogramas, así que un salto de paso entre dos fotogramas contiguos (cadencia variable en L0, cambio de nivel) no
 * acelera ni frena la reproducción. Cuando el siguiente fotograma es de otro nivel se entrega sin esperar y con
 * `discontinuity: true` (`cambioDeNivel: true`): el cliente funde o corta, nunca interpola posiciones entre niveles.
 *
 * Invariantes:
 *  - El cabezal nunca supera lo cargado: con la cola vacía espera, no salta ni retrocede.
 *  - A lo sumo UNA petición de trozo en vuelo; un salto invalida (generación + `AbortSignal`) la anterior. Un cambio de
 *    cámara no aborta ni congela: el trozo con la ventana nueva sustituye a la cola desde el tick que se está viendo.
 *  - El paso atrás NO reconstruye hacia atrás: pide el fotograma anterior exacto (`n = 1`, `t = currentTick - 1`) y la
 *    cinta devuelve el último fotograma ≤ t.
 *  - La cola no pasa de `DVR_LIMITS.maxFrames` fotogramas y los deltas se expanden al cruzarlos, no al llegar.
 *  - Lo grabado solo se sirve sin lagunas ni huecos: el reproductor las salta y lo avisa (`onMarca`).
 */
import { DEMOGRAPHY_TICKS_PER_DAY } from '../shared/demography.js';
import { CINTA, type Bifurcacion, type ChunkReq, type ChunkResp, type CintaMeta, type Laguna, type Marcador, type Nivel, type SeriePunto } from '../shared/cinta.js';
import { applyClientTapeDelta, indexTiles, type TapeClientDelta } from '../shared/tape-delta.js';
import type { Tile, Viewport, WorldView } from '../shared/types.js';

/** Ticks de mundo por día (unidad: tick). */
export const TICKS_POR_DIA = DEMOGRAPHY_TICKS_PER_DAY;
export const VELOCIDADES = CINTA.velocidades;
export type Velocidad = (typeof CINTA.velocidades)[number];

export const DVR_LIMITS = {
  /** Tamaño de la cola de fotogramas por delante del cabezal (fotogramas). */
  maxFrames: 360,
  /** Fotogramas por trozo: normal / a velocidades ≥ `fastSpeed` (el tope por respuesta es `CINTA.maxFotogramas`). */
  chunkCount: 90, fastChunkCount: CINTA.maxFotogramas, fastSpeed: 10,
  /** Se pide el siguiente trozo cuando quedan menos de estos fotogramas por delante (≈ 7 s a 1×). */
  prefetchBelow: 45,
  /** «Presente» deja el cabezal tantos ticks por detrás del último grabado (ticks). */
  liveMargin: 30,
  /** «Presente» = a lo sumo estos ticks por detrás del último grabado (ticks). */
  liveEdgeTicks: 60,
  /** Sondeo de `/api/cinta/meta` y fusión de cambios de cámara (ms). */
  metaPollMs: 2000, viewportCoalesceMs: 200,
  /** Tope de un paso del reloj (ms): una pestaña dormida no provoca saltos. */
  maxDtMs: 100,
  /** Cada cuánto de reproducción se guarda el marcador (ms). */
  marcadorCadaMs: 5000,
  /** Tamaño máximo de la ventana de cámara que se pide, en teselas. */
  camaraMaxAncho: 96, camaraMaxAlto: 64,
} as const;

export type DvrFrameReason = 'start' | 'play' | 'seek' | 'step' | 'refresh';
export interface DvrFrameInfo {
  reason: DvrFrameReason;
  /** Duración visual de un fotograma a la velocidad actual (ms): alimenta el reloj de `Landscape`. */
  tickIntervalMs: number;
  /** Fotogramas intermedios que el cabezal cruzó en este mismo paso y no se emitieron (velocidades altas). */
  skipped: number;
  /** `true` si el cabezal saltó de sitio (salto, nivel, laguna): el colchón visual debe colapsarse, no interpolar. */
  discontinuity: boolean;
  /** Nivel de la cinta que sirvió este fotograma y su paso (ticks entre fotogramas). */
  nivel: Nivel; paso: number;
  /** `true` si este fotograma es de otro nivel que el anterior (el cliente puede fundir). */
  cambioDeNivel: boolean;
  /** Teselas que cambiaron respecto al fotograma emitido antes; ausente = fotograma completo (`frame.tiles`). */
  changedTiles?: Tile[];
}

/** Lo que el cabezal cruza y merece una línea en la crónica o un aviso. */
export type DvrMarca =
  | { tipo: 'bifurcacion'; bifurcacion: Bifurcacion; texto: string }
  | { tipo: 'laguna'; laguna: Laguna; texto: string };

/** Cadena de decodificación de un trozo: cada delta se aplica sobre el último fotograma decodificado de SU trozo. */
interface DeltaChain { frame: WorldView | null; tileIndex: Map<string, number> | null; }
/** Entrada de la cola: un fotograma completo (base) o un delta aún sin expandir, con el nivel que lo sirvió. */
interface QueuedFrame { tick: number; nivel: Nivel; paso: number; epoca: number; full?: WorldView; delta?: TapeClientDelta; chain?: DeltaChain; }

export interface DvrChunkRequest extends ChunkReq { signal: AbortSignal; }

export interface DvrState {
  enabled: boolean;
  /** `'error'`: la cinta dejó de grabar (el motor sigue); se muestra en la barra. */
  estado: CintaMeta['estado'];
  playing: boolean; speed: Velocidad;
  /** Cabezal continuo: el último fotograma emitido más la fracción hacia el siguiente. */
  playTick: number; currentTick: number;
  /** Primer y último tick grabado (`t0`/`t1` de la meta); `maxTick` es «el presente». */
  minTick: number; maxTick: number;
  latestDay: number; simHz: number;
  /** Época de la cinta viva y la que se está viendo (`epocaVista` solo si se pidió una huérfana). */
  epoca: number; epocaVista: number | null;
  /** Nivel y paso del fotograma en pantalla (null antes del primero) y el nivel pedido. */
  nivel: Nivel | null; paso: number | null; nivelPedido: Nivel | 'auto';
  niveles: CintaMeta['niveles'];
  serie: SeriePunto[]; bifurcaciones: Bifurcacion[]; lagunas: Laguna[];
  bufferedAhead: number; aheadOfPlayhead: number; atLiveEdge: boolean; loading: boolean;
  error: string | null;
  tramo: { desde: number; hasta: number } | null;
}

export interface DvrPlayerOptions {
  fetchMeta: () => Promise<CintaMeta>;
  fetchChunk: (request: DvrChunkRequest) => Promise<ChunkResp>;
  onFrame: (frame: WorldView, info: DvrFrameInfo) => void;
  onStateChange?: (state: DvrState) => void;
  /** Línea breve para el usuario («Retomando en el día 41…», «No hay cinta en ese punto»). */
  onAviso?: (texto: string) => void;
  /** El cabezal cruzó una bifurcación o una laguna: una línea para la crónica. */
  onMarca?: (marca: DvrMarca) => void;
  /** Perfil y marcadores: sin él no se retoma ni se guarda nada. */
  marcadores?: PerfilCinta;
  /** 0 desactiva el sondeo automático (las pruebas llaman a `pollMeta()`). */
  metaPollMs?: number;
  /** Una grabación cerrada se abre pausada en su primer fotograma. */
  abrirEnInicio?: boolean;
  escenaArchivo?: EscenaArchivo;
  viewportCoalesceMs?: number;
}

export interface EscenaArchivo {
  tick: number;
  x: number;
  y: number;
  tramo?: { desde: number; hasta: number };
}

/** El enlace del archivo usa coordenadas de tesela. Un tramo, si se indica, contiene el fotograma de apertura. */
export function leerEscenaArchivo(query: URLSearchParams): EscenaArchivo | undefined {
  const entero = (clave: string, minimo = 0, maximo = Number.MAX_SAFE_INTEGER): number | undefined => {
    const texto = query.get(clave);
    if (!texto || !/^-?\d+$/.test(texto)) return undefined;
    const n = Number(texto);
    return Number.isSafeInteger(n) && n >= minimo && n <= maximo ? n : undefined;
  };
  const tick = entero('t'), x = entero('x', -9_999_950, 9_999_949), y = entero('y', -9_999_950, 9_999_949);
  if (tick === undefined || x === undefined || y === undefined) return undefined;
  if (!query.has('desde') && !query.has('hasta')) return { tick, x, y };
  const desde = entero('desde'), hasta = entero('hasta');
  if (desde === undefined || hasta === undefined || desde >= hasta || tick < desde || tick > hasta) return undefined;
  return { tick, x, y, tramo: { desde, hasta } };
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** Enteros y tamaño acotado: la ventana de cámara que se pide a la cinta. */
export function normalizeViewport(viewport: Viewport): Viewport | null {
  if (![viewport.x, viewport.y, viewport.width, viewport.height].every(Number.isFinite)) return null;
  const width = clamp(Math.ceil(viewport.width), 1, DVR_LIMITS.camaraMaxAncho), height = clamp(Math.ceil(viewport.height), 1, DVR_LIMITS.camaraMaxAlto);
  return { x: clamp(Math.floor(viewport.x), -10_000_000, 10_000_000 - width), y: clamp(Math.floor(viewport.y), -10_000_000, 10_000_000 - height), width, height };
}

/** Días de mundo (con un decimal y coma) de una duración en ticks. */
export function diasDeTicks(ticks: number): string {
  const dias = Math.max(0, ticks) / TICKS_POR_DIA;
  return (Math.round(dias * 10) / 10).toString().replace('.', ',');
}

export function textoBifurcacion(b: Bifurcacion): string {
  const perdidos = diasDeTicks(b.hasta - b.desde);
  return b.motivo === 'restauracion'
    ? `Se restauró una copia anterior del mundo: se perdieron ${perdidos} días de historia.`
    : `El mundo se reinició: se perdieron ${perdidos} días no guardados.`;
}

export function textoLaguna(l: Laguna): string {
  return `La cinta no grabó ${diasDeTicks(l.t1 - l.t0)} días (el mundo estuvo apagado).`;
}

export class DvrPlayer {
  enabled = false;
  estado: CintaMeta['estado'] = 'ok';
  playing = true;
  speed: Velocidad = 1;
  /** Cabezal continuo (fraccionario), en ticks del mundo. */
  playTick = 0;
  /** Último tick emitido (entero). */
  currentTick = 0;
  minTick = 0;
  maxTick = 0;
  latestDay = 0;
  simHz = 0;
  epoca = 0;
  epocaVista: number | null = null;
  nivel: Nivel | null = null;
  paso: number | null = null;
  nivelPedido: Nivel | 'auto' = 'auto';
  niveles: CintaMeta['niveles'] = [];
  serie: SeriePunto[] = [];
  bifurcaciones: Bifurcacion[] = [];
  lagunas: Laguna[] = [];
  tramo: { desde: number; hasta: number } | null = null;
  escenaInicial?: EscenaArchivo;
  loading = false;
  error: string | null = null;

  /** Fotogramas ya cargados que aún no se han emitido, en orden de tick (todos > `currentTick`). */
  private frames: QueuedFrame[] = [];
  /** Deltas expandidos hasta ahora (diagnóstico y pruebas: la decodificación es perezosa). */
  decodedDeltas = 0;
  private viewport: Viewport | null = null;
  private pendingViewport: Viewport | null = null;
  private viewportTimer: ReturnType<typeof setTimeout> | undefined;
  private metaTimer: ReturnType<typeof setInterval> | undefined;
  private generacion = 0;
  private inFlight = false;
  private aborter: AbortController | null = null;
  /** Hay un salto (seek/arranque/paso atrás) esperando su fotograma: el cabezal no corre. */
  private jumping = false;
  /** La cámara cambió y falta pedir el trozo con la ventana nueva. */
  private refreshPending = false;
  private refreshReintentos = 0;
  private started = false;
  private lastNow: number | null = null;
  /** Fotogramas de reloj acumulados sin entregar (fracción del siguiente). */
  private credito = 0;
  private cargando: Promise<void> | null = null;
  private polling: Promise<void> | null = null;
  private pasos: Promise<void> = Promise.resolve();
  /** Último `maxTick` con el que un trozo no trajo nada nuevo: no se repide hasta que la cinta crezca. */
  private agotado: { cargado: number; presente: number } | null = null;
  private msReproduciendo = 0;
  private marcadorEnVuelo = false;

  constructor(private readonly options: DvrPlayerOptions) {}

  /* ---------------------------------------------------------------- */
  /* Estado derivado                                                  */
  /* ---------------------------------------------------------------- */

  get bufferedAhead(): number { return this.frames.length; }
  get aheadOfPlayhead(): number { return Math.max(0, this.maxTick - this.currentTick); }
  get atLiveEdge(): boolean { return this.aheadOfPlayhead <= (this.options.abrirEnInicio ? 0 : DVR_LIMITS.liveEdgeTicks); }
  /** Último tick cargado (emitido o en cola): el cabezal no puede pasar de aquí. */
  get maxLoadedTick(): number { return this.frames.length ? this.frames[this.frames.length - 1]!.tick : this.currentTick; }
  /** Duración visual de un fotograma a la velocidad actual. */
  get tickIntervalMs(): number { return 1000 / (CINTA.fpsNormal * this.speed); }

  snapshot(): DvrState {
    return {
      enabled: this.enabled, estado: this.estado, playing: this.playing, speed: this.speed,
      playTick: this.playTick, currentTick: this.currentTick, minTick: this.minTick, maxTick: this.maxTick,
      latestDay: this.latestDay, simHz: this.simHz, epoca: this.epoca, epocaVista: this.epocaVista,
      nivel: this.nivel, paso: this.paso, nivelPedido: this.nivelPedido, niveles: this.niveles,
      serie: this.serie, bifurcaciones: this.bifurcaciones, lagunas: this.lagunas,
      bufferedAhead: this.bufferedAhead, aheadOfPlayhead: this.aheadOfPlayhead, atLiveEdge: this.atLiveEdge,
      loading: this.loading, error: this.error, tramo: this.tramo,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Ciclo de vida                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Lee la meta y coloca el cabezal: en el último marcador del perfil a 1× si lo hay, o en el presente. Emite el primer
   * fotograma. `false` si la cinta no responde (el cliente vuelve al modo vivo).
   */
  async start(): Promise<boolean> {
    this.stopTimers();
    try { this.applyMeta(await this.options.fetchMeta()); }
    catch (error) { this.error = describe(error); this.notify(); return false; }
    if (!this.enabled) { this.notify(); return false; }
    const poll = this.options.metaPollMs ?? DVR_LIMITS.metaPollMs;
    if (poll > 0) this.metaTimer = setInterval(() => void this.pollMeta(), poll);
    if (this.hasFrames()) await this.arrancar();
    else this.notify();
    return true;
  }

  stop(): void {
    this.guardarMarcador(true);
    this.stopTimers();
    this.generacion++; this.aborter?.abort(); this.aborter = null; this.inFlight = false; this.loading = false; this.jumping = false; this.refreshPending = false;
    this.cargando = null; this.frames = [];
  }

  /** Vuelve a leer `/api/cinta/meta`: refresca límites, serie, bifurcaciones y lagunas, y rellena el búfer si hace falta. */
  pollMeta(): Promise<void> {
    if (this.polling) return this.polling;
    const run = (async () => {
      try {
        const conocidas = new Set(this.bifurcaciones.map(b => b.epoca));
        this.applyMeta(await this.options.fetchMeta());
        this.error = null;
        if (!this.enabled) { this.notify(); return; }
        const nuevas = this.bifurcaciones.filter(b => !conocidas.has(b.epoca));
        if (!this.started && !this.jumping && this.hasFrames()) await this.arrancar();
        else if (this.started && !this.jumping && this.currentTick < this.minTick) await this.jump(this.minTick, 'seek', 1); // la cinta rotó bajo el cabezal
        else if (this.started && !this.jumping && nuevas.length && await this.invalidarHuerfanos(nuevas)) return this.notify();
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
      this.credito += dt / 1000 * CINTA.fpsNormal * this.speed;
      // Con la cola vacía el reloj espera sin acumular deuda: al llegar el trozo no se entrega un racimo.
      if (!this.frames.length) this.credito = Math.min(this.credito, 1);
      const batch: QueuedFrame[] = [];
      let cambio = false;
      let fueraDelTramo = false;
      while (this.frames.length) {
        const next = this.frames[0]!;
        if (this.tramo && next.tick > this.tramo.hasta) { fueraDelTramo = true; break; }
        const previo = batch.length ? batch[batch.length - 1]!.nivel : this.nivel;
        const otroNivel = previo !== null && next.nivel !== previo;
        if (otroNivel) { if (!batch.length) { batch.push(this.frames.shift()!); cambio = true; this.credito = Math.max(0, this.credito - 1); } break; }
        if (this.credito < 1) break;
        batch.push(this.frames.shift()!); this.credito -= 1;
      }
      // A 10×–25× se cruzan varios fotogramas por rAF: solo el último se entrega. Los deltas intermedios sí se aplican
      // (cada uno parte del anterior) pero su fotograma no se emite; sus teselas cambiadas se acumulan en el entregado.
      if (batch.length && !this.deliver(batch, 'play', batch.length - 1, cambio)) return;
      if (this.tramo && (fueraDelTramo || this.currentTick >= this.tramo.hasta ||
          (!this.frames.length && this.currentTick >= this.maxTick))) {
        this.tramo = null; this.playing = false; this.credito = 0; this.options.onAviso?.('Terminó el tramo.'); this.notify();
      } else if (this.options.abrirEnInicio && this.currentTick >= this.maxTick) {
        this.playing = false; this.credito = 0; this.notify();
      }
      this.msReproduciendo += dt;
      if (this.msReproduciendo >= DVR_LIMITS.marcadorCadaMs) { this.msReproduciendo = 0; this.guardarMarcador(false); }
      this.actualizarCabezal();
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
    if (!playing) this.guardarMarcador(false);
    this.notify();
  }

  togglePlaying(): void { this.setPlaying(!this.playing); }

  setSpeed(speed: Velocidad): void {
    if (!VELOCIDADES.includes(speed) || this.speed === speed) return;
    this.speed = speed;
    this.prefetch(); this.notify();
  }

  /** `'auto'` (por defecto) o un nivel fijo: se repite lo cargado en el tick actual con el nivel pedido. */
  setNivel(nivel: Nivel | 'auto'): Promise<void> {
    if (this.nivelPedido === nivel) return Promise.resolve();
    this.nivelPedido = nivel;
    return this.started ? this.seek(this.currentTick) : (this.notify(), Promise.resolve());
  }

  /** Mira la historia huérfana de una época (`null` vuelve a lo visible) desde `tick`. */
  verEpoca(epoca: number | null, tick = this.currentTick): Promise<void> {
    this.epocaVista = epoca;
    return this.started ? this.seek(tick) : (this.notify(), Promise.resolve());
  }

  /** Salta a `tick` (acotado a la cinta y fuera de las lagunas), descarta lo cargado y emite el fotograma en cuanto llega. */
  async seek(tick: number): Promise<void> {
    if (!this.enabled || !Number.isFinite(tick)) return;
    this.tramo = null;
    await this.jump(tick, 'seek', Math.sign(tick - this.currentTick) || 1);
  }

  /** Un fotograma atrás (-1) o adelante (+1). Pausa si estaba reproduciendo. */
  step(delta: -1 | 1): Promise<void> {
    if (!this.enabled || !this.started) return Promise.resolve();
    this.tramo = null;
    if (this.playing) { this.playing = false; this.notify(); }
    if (delta > 0) return this.adelantar();
    // Varios clics seguidos se encadenan: cada uno parte del fotograma en que dejó el anterior.
    const run = this.pasos.then(() => this.retroceder());
    this.pasos = run.catch(() => undefined);
    return run;
  }

  /** Reproduce hasta el último fotograma disponible dentro del intervalo elegido. */
  async reproducirTramo(desde: number, hasta: number): Promise<void> {
    if (!this.enabled || !Number.isFinite(desde) || !Number.isFinite(hasta)) return;
    const inicio = clamp(Math.floor(desde), this.minTick, this.maxTick);
    const fin = clamp(Math.floor(hasta), this.minTick, this.maxTick);
    if (fin <= inicio) { this.options.onAviso?.('El final debe estar después del inicio.'); return; }
    const tramo = { desde: inicio, hasta: fin };
    this.tramo = tramo;
    this.playing = false;
    const ok = await this.jump(inicio, 'seek', 1, tramo);
    if (this.tramo !== tramo) return; // Otro salto o tramo sustituyó a este mientras llegaba el corte.
    if (!ok) { this.tramo = null; this.notify(); return; }
    this.playing = true; this.lastNow = null; this.notify();
  }

  /** Vuelve al presente (con colchón) y reproduce. */
  async jumpToLiveEdge(): Promise<void> {
    this.tramo = null;
    this.playing = !this.options.abrirEnInicio;
    if (!this.enabled) { this.notify(); return; }
    this.epocaVista = null;
    // La meta puede tener varios segundos: el motor y la reproducción tienen relojes distintos.
    // Una orden posterior del usuario invalida esta consulta, incluso antes de pedir el trozo.
    const gen = this.generacion;
    if (!this.options.abrirEnInicio) {
      try {
        const meta = await this.options.fetchMeta();
        if (gen !== this.generacion) return;
        this.applyMeta(meta);
      } catch { if (gen !== this.generacion) return; }
    }
    await this.jump(this.liveTick(), 'seek', 1, undefined, !this.options.abrirEnInicio);
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

  /** Guarda el marcador ya (al salir de la página: `keepalive`, porque `sendBeacon` no puede hacer PUT). */
  guardarAlSalir(): void { this.guardarMarcador(true); }

  /* ---------------------------------------------------------------- */
  /* Arranque y marcadores                                            */
  /* ---------------------------------------------------------------- */

  private async arrancar(): Promise<void> {
    if (this.options.abrirEnInicio) {
      this.playing = false;
      const escena = this.escenaDisponible();
      this.escenaInicial = escena;
      if (escena) {
        const ventanaOriginal = this.viewport;
        const { camaraMaxAncho, camaraMaxAlto } = DVR_LIMITS;
        this.viewport = normalizeViewport({ x: escena.x - camaraMaxAncho / 2, y: escena.y - camaraMaxAlto / 2,
          width: camaraMaxAncho, height: camaraMaxAlto });
        const generacionEscena = this.generacion + 1;
        if (await this.jump(escena.tick, 'start', 1)) return;
        if (this.generacion !== generacionEscena) return; // El reproductor se cerró o el usuario eligió otro fotograma.
        this.viewport = ventanaOriginal;
        this.escenaInicial = undefined;
      }
      await this.jump(this.minTick, 'start', 1);
      return;
    }
    let marcador: Marcador | null = null;
    try { marcador = await this.options.marcadores?.ultimo() ?? null; } catch { marcador = null; }
    if (marcador && this.maxTick >= marcador.t) {
      this.speed = 1;
      const objetivo = clamp(marcador.t, this.minTick, this.maxTick);
      if (await this.jump(objetivo, 'start', 1)) {
        const dia = Math.floor(this.currentTick / TICKS_POR_DIA) + 1;
        const resto = this.maxTick - this.currentTick;
        this.options.onAviso?.(resto <= DVR_LIMITS.liveEdgeTicks
          ? `Retomando en el día ${dia} · estás en el presente`
          : `Retomando en el día ${dia} · el presente está a ${diasDeTicks(resto)} días`);
        return;
      }
    }
    await this.jump(this.liveTick(), 'start', 1);
  }

  private escenaDisponible(): EscenaArchivo | undefined {
    const escena = this.options.escenaArchivo, nivel = this.niveles.find(n => n.nivel === 0);
    if (!escena || !nivel || !Number.isSafeInteger(nivel.paso) || nivel.paso <= 0) return undefined;
    const desde = escena.tramo?.desde ?? escena.tick, hasta = escena.tramo?.hasta ?? escena.tick;
    if (desde < Math.max(this.minTick, nivel.t0) || hasta > Math.min(this.maxTick, nivel.t1)
      || [desde, escena.tick, hasta].some(tick => (tick - nivel.t0) % nivel.paso !== 0)
      || this.lagunas.some(l => (l.nivel === undefined || l.nivel === 0) && l.t0 < hasta && l.t1 > desde)) return undefined;
    return escena;
  }

  private guardarMarcador(alSalir: boolean): void {
    const perfil = this.options.marcadores;
    if (!perfil || !this.started || this.marcadorEnVuelo && !alSalir) return;
    this.marcadorEnVuelo = true;
    void perfil.guardar({ epoca: this.epocaActual(), t: this.currentTick, nivel: this.nivel ?? 0, velocidad: this.speed }, alSalir)
      .catch(() => undefined).finally(() => { this.marcadorEnVuelo = false; });
  }

  /** Época del fotograma en pantalla: la que se pidió, o la de la cinta viva. */
  private epocaActual(): number { return this.epocaVista ?? this.epoca; }

  /* ---------------------------------------------------------------- */
  /* Internos                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * La cámara nueva NO congela la reproducción. Lo ya cargado (recortado para la cámara anterior) sigue
   * reproduciéndose; se pide un trozo desde el fotograma actual con la cámara nueva y, al llegar, sustituye a la cola
   * desde el tick que esté mostrando el cabezal (sin abortar nada, sin discontinuidad y sin vaciar la cola antes).
   */
  private applyViewport(): Promise<void> {
    const next = this.pendingViewport; this.pendingViewport = null;
    if (!next || JSON.stringify(next) === JSON.stringify(this.viewport)) return Promise.resolve();
    this.viewport = next;
    if (!this.enabled || !this.started) return Promise.resolve();
    this.refreshPending = true; this.refreshReintentos = 0;
    return this.refresh();
  }

  /** Trozo con la cámara actual desde `currentTick`; espera su turno si ya hay una petición en vuelo. */
  private async refresh(): Promise<void> {
    if (!this.refreshPending || this.inFlight || this.jumping || !this.enabled || !this.started) return;
    this.refreshPending = false;
    const gen = this.generacion, viewport = this.viewport;
    const chunk = await this.fetchChunk(this.currentTick, this.chunkCount(), gen);
    if (gen !== this.generacion) return; // un salto lo reemplazó
    if (!chunk) { this.notify(); return; }
    this.applyChunkBounds(chunk); this.error = null;
    if (viewport !== this.viewport) { this.refreshPending = true; this.refreshReintentos = 0; } // la cámara volvió a moverse mientras volaba
    // El cabezal siguió avanzando mientras volaba: el trozo se corta en el tick que se ve ahora.
    const list = DvrPlayer.ordered(chunk, this.currentTick - 1);
    const first = list.shift();
    if (!first) { // el cabezal ya pasó este trozo: se reintenta con la cámara actual (unas pocas veces)
      if (this.refreshReintentos++ < 3) this.refreshPending = true;
      this.notify(); return;
    }
    this.frames = (first.tick === this.currentTick ? list : [first, ...list]).slice(0, DVR_LIMITS.maxFrames);
    if (first.tick !== this.currentTick) { this.notify(); return; } // sin fotograma en el tick actual: se repinta al llegar al siguiente
    let decoded: { frame: WorldView };
    try { decoded = this.decode(first); }
    catch (error) { this.error = describe(error); this.frames = []; this.notify(); return; }
    // Mismo tick con la ventana nueva: se repinta sin discontinuidad (los cuerpos siguen su interpolación).
    this.emit(decoded.frame, 'refresh', 0, false, first, undefined);
    this.prefetch();
  }

  private hasFrames(): boolean { return this.niveles.length > 0 && this.maxTick >= this.minTick; }
  private liveTick(): number { return this.options.abrirEnInicio ? this.maxTick : Math.max(this.minTick, this.maxTick - DVR_LIMITS.liveMargin); }
  private chunkCount(): number { return this.speed >= DVR_LIMITS.fastSpeed ? DVR_LIMITS.fastChunkCount : DVR_LIMITS.chunkCount; }
  /** Colchón mínimo por delante antes de pedir más: ≥ 45 fotogramas y, a velocidad alta, ≈ 1,5 s de reproducción. */
  private prefetchThreshold(): number { return Math.max(DVR_LIMITS.prefetchBelow, Math.ceil(CINTA.fpsNormal * this.speed * 1.5)); }

  private stopTimers(): void {
    clearInterval(this.metaTimer); this.metaTimer = undefined;
    clearTimeout(this.viewportTimer); this.viewportTimer = undefined;
  }

  private applyMeta(meta: CintaMeta): void {
    this.enabled = true;
    this.estado = meta.estado === 'error' ? 'error' : 'ok';
    if (Number.isFinite(meta.epoca)) this.epoca = meta.epoca;
    if (Number.isFinite(meta.t0)) this.minTick = meta.t0;
    if (Number.isFinite(meta.t1)) this.maxTick = meta.t1;
    if (Number.isFinite(meta.hz)) this.simHz = meta.hz;
    this.latestDay = Math.floor(this.maxTick / TICKS_POR_DIA) + 1;
    this.niveles = Array.isArray(meta.niveles) ? meta.niveles : [];
    this.bifurcaciones = Array.isArray(meta.bifurcaciones) ? meta.bifurcaciones : [];
    this.lagunas = Array.isArray(meta.lagunas) ? meta.lagunas : [];
    this.serie = Array.isArray(meta.serie) ? meta.serie : [];
    if (this.tramo && (this.tramo.desde < this.minTick || this.tramo.hasta > this.maxTick)) {
      this.tramo = null; this.playing = false;
      this.options.onAviso?.('El tramo ya no está completo en la cinta.');
    }
  }

  private applyChunkBounds(chunk: ChunkResp): void {
    if (Number.isFinite(chunk.t1) && chunk.t1 > this.maxTick) this.maxTick = chunk.t1;
  }

  /** Un tick dentro de una laguna salta a su borde: hacia delante a `t1`, hacia atrás a `t0`. */
  private fueraDeLaguna(tick: number, direccion: number): number {
    for (const l of this.lagunas) if (tick > l.t0 && tick < l.t1) return direccion >= 0 ? l.t1 : l.t0;
    return tick;
  }

  /** El siguiente tick que pedir tras `cargado`, saltando la laguna que haya delante. */
  private siguienteT(cargado: number): number { return this.fueraDeLaguna(cargado + 1, 1); }

  /**
   * Una bifurcación nueva hace huérfano lo que viene después de su punto (`desde`): los fotogramas en cola de ese
   * tramo ya no son lo visible y se descartan. Si el cabezal estaba dentro de lo olvidado, vuelve al punto de la
   * bifurcación. Devuelve si hizo un salto.
   */
  private async invalidarHuerfanos(nuevas: Bifurcacion[]): Promise<boolean> {
    if (this.epocaVista !== null || !nuevas.length) return false;
    const desde = Math.min(...nuevas.map(b => b.desde));
    if (this.currentTick > desde) { await this.jump(desde, 'seek', -1); return true; }
    const antes = this.frames.length;
    this.frames = this.frames.filter(f => f.tick <= desde);
    this.agotado = null;
    if (this.frames.length !== antes) this.prefetch();
    return false;
  }

  /**
   * Expande (si hace falta) la tanda de entradas cruzadas por el cabezal y entrega la última. Devuelve `false` si un
   * delta corrupto obligó a descartar la cola (el error queda en `error` y se repide desde el tick actual).
   */
  private deliver(batch: QueuedFrame[], reason: DvrFrameReason, skipped: number, cambioDeNivel: boolean): boolean {
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
    this.emit(frame, reason, skipped, cambioDeNivel, batch[batch.length - 1]!, changed);
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

  /**
   * Entrega un fotograma. `cambioDeNivel`: el nivel de `entry` difiere del anterior (se calcula aquí si el llamador no
   * lo sabe: un salto siempre es discontinuo). Cruzar una laguna es discontinuo; cruzar una bifurcación solo avisa,
   * porque el mundo restaurado continúa desde el mismo punto.
   */
  private emit(frame: WorldView, reason: DvrFrameReason, skipped: number, cambioDeNivel: boolean | 'salto', entry: QueuedFrame, changedTiles: Tile[] | undefined): void {
    const previo = this.currentTick, habiaFotograma = this.started;
    const salto = cambioDeNivel === 'salto';
    const cambio = salto ? this.nivel !== null && this.nivel !== entry.nivel : cambioDeNivel;
    let discontinuity = salto || cambio;
    this.currentTick = frame.tick; this.started = true;
    this.nivel = entry.nivel; this.paso = entry.paso;
    if (!salto && habiaFotograma && frame.tick > previo) {
      for (const l of this.lagunas) if (previo <= l.t0 && frame.tick >= l.t1) { discontinuity = true; this.options.onMarca?.({ tipo: 'laguna', laguna: l, texto: textoLaguna(l) }); }
      for (const b of this.bifurcaciones) if (previo < b.desde && frame.tick >= b.desde) this.options.onMarca?.({ tipo: 'bifurcacion', bifurcacion: b, texto: textoBifurcacion(b) });
    }
    this.actualizarCabezal();
    this.options.onFrame(frame, { reason, tickIntervalMs: this.tickIntervalMs, skipped, discontinuity, nivel: entry.nivel, paso: entry.paso, cambioDeNivel: cambio, ...(changedTiles ? { changedTiles } : {}) });
    this.notify();
  }

  /** `playTick`: el último fotograma más la fracción de reloj hacia el siguiente. */
  private actualizarCabezal(): void {
    const siguiente = this.frames[0];
    this.playTick = siguiente && this.playing && !this.jumping
      ? this.currentTick + clamp(this.credito, 0, 1) * (siguiente.tick - this.currentTick)
      : this.currentTick;
  }

  private notify(): void { this.options.onStateChange?.(this.snapshot()); }

  private async fetchChunk(t: number, n: number, gen: number, nivel: Nivel | 'auto' = this.nivelPedido): Promise<ChunkResp | null> {
    const aborter = new AbortController();
    this.aborter = aborter; this.inFlight = true; this.loading = true;
    const v = this.viewport;
    try {
      const chunk = await this.options.fetchChunk({
        t, n, nivel, ...(this.epocaVista !== null ? { epoca: this.epocaVista } : {}),
        ...(v ? { x: v.x, y: v.y, w: v.width, h: v.height } : {}), signal: aborter.signal,
      });
      return gen === this.generacion ? chunk : null; // respuesta de antes de un salto: se descarta
    } catch (error) {
      if (gen === this.generacion) this.error = describe(error);
      return null;
    } finally {
      if (gen === this.generacion) { this.inFlight = false; this.loading = false; }
    }
  }

  /**
   * Fotogramas de un trozo en orden de tick y sin repetidos, a partir de `after` (exclusivo): una base completa (el
   * fotograma clave ≤ t) y sus deltas sin expandir. Lo anterior a `after` se aplica ya a la cadena (son pocos: un
   * bloque) para que siga siendo exacta.
   */
  private static ordered(chunk: ChunkResp, after: number): QueuedFrame[] {
    const out: QueuedFrame[] = [];
    if (!chunk.baseFrame && !chunk.deltas?.length) return out;
    const chain: DeltaChain = { frame: null, tileIndex: null };
    const meta = { nivel: chunk.nivel, paso: chunk.paso, epoca: chunk.epoca };
    const entries: QueuedFrame[] = [];
    if (chunk.baseFrame) entries.push({ tick: chunk.baseFrame.tick, full: chunk.baseFrame, chain, ...meta });
    for (const delta of [...(chunk.deltas ?? [])].sort((a, b) => a.tick - b.tick)) entries.push({ tick: delta.tick, delta, chain, ...meta });
    for (const entry of entries) {
      if (!Number.isFinite(entry.tick) || (out.length && out[out.length - 1]!.tick === entry.tick)) continue;
      if (entry.tick <= after) { DvrPlayer.foldIntoChain(entry); continue; }
      out.push(entry);
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
   * Salto: invalida lo cargado y lo pedido, repide desde `t` y emite el fotograma en que cae. El primer pintado sale
   * de la base del trozo (el fotograma clave ≤ t) y, si hay deltas hasta `t`, se aplican de una vez para aterrizar en
   * el último fotograma ≤ t en vez de reproducir el tramo desde el fotograma clave. Devuelve si pintó algo.
   */
  private async jump(t: number, reason: DvrFrameReason, direccion: number, tramo?: Readonly<{ desde: number; hasta: number }>, alPresente = false): Promise<boolean> {
    const target = this.fueraDeLaguna(clamp(Math.floor(t), this.minTick, Math.max(this.minTick, this.maxTick)), direccion);
    const gen = ++this.generacion;
    this.aborter?.abort(); this.cargando = null;
    this.frames = []; this.jumping = true; this.refreshPending = false; this.credito = 0; this.agotado = null;
    this.notify();
    const chunk = await this.fetchChunk(target, this.chunkCount(), gen);
    if (gen !== this.generacion) return false; // otro salto lo reemplazó
    this.jumping = false;
    if (!chunk) { this.notify(); return false; }
    this.applyChunkBounds(chunk); this.error = null;
    const list = DvrPlayer.ordered(chunk, Number.NEGATIVE_INFINITY);
    if (!list.length) { // nada en ese punto (podado o fuera de lo grabado): se queda donde estaba
      if (reason === 'seek' || reason === 'step') this.options.onAviso?.('No hay cinta en ese punto.');
      this.notify(); return false;
    }
    let aterriza = 0;
    if (tramo) {
      aterriza = list.findIndex(entry => entry.tick >= target);
      if (aterriza < 0 || list[aterriza]!.tick > tramo.hasta) {
        this.options.onAviso?.('No hay cinta en ese tramo.'); this.notify(); return false;
      }
    } else if (alPresente) aterriza = list.length - 1;
    else while (aterriza + 1 < list.length && list[aterriza + 1]!.tick <= target) aterriza++;
    let frame: WorldView | null = null;
    try { for (let i = 0; i <= aterriza; i++) frame = this.decode(list[i]!).frame; }
    catch (error) { this.error = describe(error); this.frames = []; this.notify(); return false; }
    const escena = reason === 'start' ? this.escenaInicial : undefined;
    if (escena && (list[aterriza]!.nivel !== 0 || frame?.tick !== escena.tick
      || !frame.tiles.some(tesela => tesela.x === escena.x && tesela.y === escena.y))) return false;
    this.frames = list.slice(aterriza + 1, aterriza + 1 + DVR_LIMITS.maxFrames);
    this.emit(frame!, reason, 0, 'salto', list[aterriza]!, undefined);
    this.msReproduciendo = 0;
    this.prefetch();
    return true;
  }

  /** Paso atrás: el fotograma anterior exacto, sin reconstruir nada hacia atrás. */
  private async retroceder(): Promise<void> {
    if (!this.enabled || !this.started || this.currentTick <= this.minTick) return;
    const gen = ++this.generacion;
    this.aborter?.abort(); this.cargando = null;
    this.frames = []; this.jumping = true; this.refreshPending = false; this.credito = 0; this.agotado = null;
    const chunk = await this.fetchChunk(this.currentTick - 1, 1, gen);
    if (gen !== this.generacion) return;
    this.jumping = false;
    const entrada = chunk ? DvrPlayer.ordered(chunk, Number.NEGATIVE_INFINITY)[0] : undefined;
    if (!entrada || entrada.tick >= this.currentTick) { this.notify(); return; } // no hay nada anterior
    this.applyChunkBounds(chunk!); this.error = null;
    let decoded: { frame: WorldView };
    try { decoded = this.decode(entrada); }
    catch (error) { this.error = describe(error); this.notify(); return; }
    this.emit(decoded.frame, 'step', 0, 'salto', entrada, undefined);
  }

  /** Paso adelante: el siguiente fotograma de la cola; con la cola vacía, lo pide. */
  private async adelantar(): Promise<void> {
    if (!this.frames.length && !this.jumping) await this.cargarMas();
    const next = this.frames.shift();
    if (!next) return;
    const cambio = this.nivel !== null && next.nivel !== this.nivel;
    this.credito = 0;
    if (this.deliver([next], 'step', 0, cambio)) this.prefetch();
  }

  /** Pide el siguiente trozo si quedan pocos fotogramas por delante y la cinta tiene más. */
  private prefetch(): void {
    if (!this.enabled || !this.started || this.inFlight || this.jumping || this.error) return;
    const count = this.chunkCount();
    if (this.frames.length >= this.prefetchThreshold() || this.frames.length + count > DVR_LIMITS.maxFrames) return;
    void this.cargarMas();
  }

  /** Trae el trozo que sigue a lo cargado y lo añade a la cola. Una sola petición a la vez. */
  private cargarMas(): Promise<void> {
    if (this.cargando) return this.cargando;
    if (!this.enabled || !this.started || this.inFlight || this.jumping) return Promise.resolve();
    const cargado = this.maxLoadedTick;
    if (cargado >= this.maxTick) return Promise.resolve();
    if (this.agotado && this.agotado.cargado === cargado && this.agotado.presente === this.maxTick) return Promise.resolve();
    const gen = this.generacion;
    const run = (async () => {
      const chunk = await this.fetchChunk(this.siguienteT(cargado), this.chunkCount(), gen);
      if (!chunk || gen !== this.generacion) { this.notify(); return; }
      this.applyChunkBounds(chunk); this.error = null;
      const fresh = DvrPlayer.ordered(chunk, this.maxLoadedTick);
      if (!fresh.length) this.agotado = { cargado, presente: this.maxTick };
      this.frames.push(...fresh.slice(0, Math.max(0, DVR_LIMITS.maxFrames - this.frames.length)));
      this.notify();
      if (this.refreshPending) void this.refresh();
    })();
    const rastreada = run.finally(() => { if (this.cargando === rastreada) this.cargando = null; this.prefetch(); });
    this.cargando = rastreada;
    return rastreada;
  }
}

function describe(error: unknown): string { return error instanceof Error ? error.message : 'La cinta no respondió.'; }

/* ------------------------------------------------------------------ */
/* Perfil y marcadores                                                 */
/* ------------------------------------------------------------------ */

/** Lo mínimo de `localStorage` que se usa (inyectable: en un navegador privado o bloqueado puede faltar o lanzar). */
export interface AlmacenLocal { getItem(clave: string): string | null; setItem(clave: string, valor: string): void; }

/** Rutas `GET`/`PUT /api/cinta/marcador`. `null`/`false` = la ruta no existe (404): se usa solo el almacén local. */
export interface RedMarcadores {
  leer(perfil: string): Promise<Marcador[] | null>;
  escribir(marcador: Marcador, alSalir: boolean): Promise<boolean>;
}

const CLAVE_PERFIL = 'carta.cinta.perfil';
const CLAVE_MARCADORES = 'carta.cinta.marcadores';
/** Se guardan los 5 últimos por perfil, igual que el servidor (marcadores). */
const MARCADORES_POR_PERFIL = 5;

export function esMarcador(valor: unknown): valor is Marcador {
  const m = valor as Partial<Marcador> | null;
  return !!m && typeof m === 'object' && typeof m.perfil === 'string' && [m.epoca, m.t, m.velocidad, m.en].every(n => typeof n === 'number' && Number.isFinite(n))
    && typeof m.nivel === 'number' && m.nivel >= 0 && m.nivel <= 4;
}

function uuidV4(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) { try { return c.randomUUID(); } catch { /* contexto no seguro: se genera a mano */ } }
  const hex = (n: number): string => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex(3)}-${hex(12)}`;
}

function almacenDelNavegador(): AlmacenLocal | null {
  try { return (globalThis as { localStorage?: AlmacenLocal }).localStorage ?? null; } catch { return null; }
}

/**
 * Perfil de navegador (UUID en `localStorage`) y su marcador: dónde se quedó mirando. El servidor guarda los 5 últimos;
 * el almacén local siempre se escribe y manda si el servidor no responde. Si la ruta no existe (404) no se vuelve a pedir.
 */
export class PerfilCinta {
  private readonly almacen: AlmacenLocal | null;
  private readonly red: RedMarcadores | undefined;
  private readonly uuid: () => string;
  private readonly ahora: () => number;
  private id: string | null = null;
  private servidor = true;

  constructor(opciones: { red?: RedMarcadores; almacen?: AlmacenLocal | null; uuid?: () => string; ahora?: () => number } = {}) {
    this.red = opciones.red;
    this.almacen = opciones.almacen === undefined ? almacenDelNavegador() : opciones.almacen;
    this.uuid = opciones.uuid ?? uuidV4;
    this.ahora = opciones.ahora ?? Date.now;
  }

  get perfil(): string {
    if (this.id) return this.id;
    let id: string | null = null;
    try { id = this.almacen?.getItem(CLAVE_PERFIL) ?? null; } catch { id = null; }
    if (!id) {
      id = this.uuid();
      try { this.almacen?.setItem(CLAVE_PERFIL, id); } catch { /* sin almacén: el perfil dura lo que la página */ }
    }
    return this.id = id;
  }

  private locales(): Marcador[] {
    try {
      const crudo = this.almacen?.getItem(CLAVE_MARCADORES);
      const lista = crudo ? JSON.parse(crudo) as unknown : [];
      return Array.isArray(lista) ? lista.filter(esMarcador).filter(m => m.perfil === this.perfil) : [];
    } catch { return []; }
  }

  /** El marcador más reciente entre el servidor y el almacén local, o `null` si no hay ninguno. */
  async ultimo(): Promise<Marcador | null> {
    const todos = this.locales();
    if (this.red && this.servidor) {
      try {
        const remotos = await this.red.leer(this.perfil);
        if (remotos === null) this.servidor = false;
        else todos.push(...remotos.filter(esMarcador).filter(m => m.perfil === this.perfil));
      } catch { /* sin respuesta: manda lo local */ }
    }
    return todos.reduce<Marcador | null>((mejor, m) => !mejor || m.en > mejor.en ? m : mejor, null);
  }

  /** Guarda dónde se quedó el perfil: siempre en local y, si la ruta existe, en el servidor. */
  async guardar(datos: Omit<Marcador, 'perfil' | 'en'>, alSalir = false): Promise<void> {
    const marcador: Marcador = { perfil: this.perfil, epoca: Math.floor(datos.epoca), t: Math.floor(datos.t), nivel: datos.nivel, velocidad: datos.velocidad, en: Math.floor(this.ahora()) };
    try {
      const lista = [marcador, ...this.locales().filter(m => m.en !== marcador.en)].slice(0, MARCADORES_POR_PERFIL);
      this.almacen?.setItem(CLAVE_MARCADORES, JSON.stringify(lista));
    } catch { /* almacén lleno o bloqueado */ }
    if (this.red && this.servidor) {
      if (!await this.red.escribir(marcador, alSalir)) this.servidor = false;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Red: /api/cinta/*                                                   */
/* ------------------------------------------------------------------ */

export interface OpcionesRedCinta {
  fetch?: typeof fetch;
  /** 401/403: la sesión terminó (el cliente muestra el acceso). */
  alSesionTerminada?: () => void;
  timeoutMs?: number;
}

export interface RedCinta {
  fetchMeta: DvrPlayerOptions['fetchMeta'];
  fetchChunk: DvrPlayerOptions['fetchChunk'];
  marcadores: RedMarcadores;
}

/** Consulta de `GET /api/cinta/chunk` con los campos de `ChunkReq` que vengan definidos. */
export function consultaChunk(req: ChunkReq): string {
  const q = new URLSearchParams({ t: String(Math.floor(req.t)), n: String(Math.floor(req.n)), nivel: String(req.nivel ?? 'auto') });
  if (req.epoca !== undefined) q.set('epoca', String(req.epoca));
  for (const clave of ['x', 'y', 'w', 'h'] as const) { const v = req[clave]; if (v !== undefined) q.set(clave, String(v)); }
  return q.toString();
}

/** Las cuatro rutas de `RutasCinta` sobre `fetch` con la sesión de la página. */
export function crearRedCinta(opciones: OpcionesRedCinta = {}): RedCinta {
  const llamar = opciones.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const timeout = opciones.timeoutMs ?? 10_000;
  const pedir = async (url: string, init: RequestInit): Promise<Response> => {
    const respuesta = await llamar(url, { credentials: 'same-origin', cache: 'no-store', ...init });
    if (respuesta.status === 401 || respuesta.status === 403) { opciones.alSesionTerminada?.(); throw new Error('Sesión terminada.'); }
    return respuesta;
  };
  const cinta = async <T>(url: string, signal?: AbortSignal): Promise<T> => {
    const respuesta = await pedir(url, { signal: signal ?? AbortSignal.timeout(timeout) });
    if (!respuesta.ok) throw new Error('La cinta del mundo no está disponible todavía.');
    return await respuesta.json() as T;
  };
  return {
    fetchMeta: () => cinta<CintaMeta>('/api/cinta/meta'),
    fetchChunk: ({ signal, ...req }) => cinta<ChunkResp>(`/api/cinta/chunk?${consultaChunk(req)}`, signal),
    marcadores: {
      async leer(perfil) {
        const respuesta = await pedir(`/api/cinta/marcador?perfil=${encodeURIComponent(perfil)}`, { signal: AbortSignal.timeout(timeout) });
        if (respuesta.status === 404) return null;
        if (!respuesta.ok) throw new Error('Los marcadores no respondieron.');
        const lista = await respuesta.json() as unknown;
        return Array.isArray(lista) ? lista.filter(esMarcador) : [];
      },
      async escribir(marcador, alSalir) {
        // `sendBeacon` solo hace POST: al salir de la página se usa `keepalive`, que sobrevive igual al cierre.
        const respuesta = await pedir('/api/cinta/marcador', {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(marcador),
          ...(alSalir ? { keepalive: true } : { signal: AbortSignal.timeout(timeout) }),
        });
        if (respuesta.status === 404) return false;
        if (!respuesta.ok) throw new Error('El marcador no se guardó.');
        return true;
      },
    },
  };
}
