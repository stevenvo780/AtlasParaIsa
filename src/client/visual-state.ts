import type { AnimalView, ChronicleEvent, WorldView } from '../shared/types.js';

/** Hard bounds apply at every zoom and on both render backends. */
export const VISUAL_BUDGET = { water: 120, vegetation: 96, rain: 90, events: 16, shadows: 260 } as const;
export const EVENT_LIFETIME_MS = 2400;

/** Daylight is a presentation of a received model tick, not a browser clock. */
export function daylightAt(tick: number): { color: string; alpha: number; shadowX: number; shadowY: number; shadowAlpha: number } {
  const phase = ((tick % 2400) + 2400) % 2400;
  const stops = [
    [0, 138, 153, 191, .34], [140, 248, 193, 150, .22], [340, 255, 249, 226, .03],
    [1300, 255, 249, 226, .03], [1590, 240, 178, 135, .23], [1840, 117, 137, 192, .48],
    [2220, 111, 133, 183, .49], [2400, 138, 153, 191, .34],
  ];
  const index = Math.max(0, stops.findIndex((stop, i) => i < stops.length - 1 && phase >= stop[0]! && phase < stops[i + 1]![0]!));
  const from = stops[index]!, to = stops[index + 1]!;
  let blend = (phase - from[0]!) / (to[0]! - from[0]!); blend = blend * blend * (3 - 2 * blend);
  const value = (i: number) => from[i]! + (to[i]! - from[i]!) * blend;
  const sun = Math.max(0, Math.sin((phase - 70) / 1750 * Math.PI));
  return { color: `rgb(${Math.round(value(1))},${Math.round(value(2))},${Math.round(value(3))})`, alpha: value(4),
    shadowX: Math.cos((phase - 70) / 1750 * Math.PI) * 8, shadowY: 2 + (1 - sun) * 4, shadowAlpha: sun * .2 };
}

export interface EventAccent { id: string; x: number; y: number; kind: ChronicleEvent['kind']; bornAt: number; }
const ACCENT_KINDS = new Set<ChronicleEvent['kind']>(['birth', 'care', 'learning', 'discovery', 'settlement', 'cooperation', 'community', 'invention', 'conflict', 'meeting']);

/** Marks acknowledge received facts, never generate outcomes or replay old chronicle entries. */
export function newEventAccents(previous: WorldView | null, current: WorldView, now: number): EventAccent[] {
  if (!previous || current.tick <= previous.tick || current.paused) return [];
  const seen = new Set(previous.events.map(event => event.id));
  return current.events.filter(event => !seen.has(event.id) && event.tick > previous.tick && event.tick <= current.tick
    && event.source === 'simulation' && ACCENT_KINDS.has(event.kind) && Number.isFinite(event.x) && Number.isFinite(event.y))
    .slice(-VISUAL_BUDGET.events).map(event => ({ id: event.id, x: event.x!, y: event.y!, kind: event.kind, bornAt: now }));
}

/** A standing animal never walks in place. Feeding poses require an active received action. */
export function animalPose(animal: Pick<AnimalView, 'action'>, moving: boolean, time: number, reduced: boolean, active: boolean): number {
  if (reduced || !active || animal.action === 'rest') return 0;
  if (moving) return Math.floor(time * (animal.action === 'flee' || animal.action === 'hunt' ? 10 : 6)) % 4;
  if (animal.action === 'graze' || animal.action === 'drink') return Math.floor(time * 2) % 2;
  return 0;
}

/* ------------------------------------------------------------------ */
/* V18 capa 1 — cadencia real del servidor y deslizamiento a 60 fps     */
/* ------------------------------------------------------------------ */
/* Todo lo de abajo es PRESENTACIÓN pura (sin DOM, sin simular): suaviza lo que el servidor ya dijo.
 * A 8 000+ habitantes un paso tarda 0,6–1,2 s (hasta 2–3 s al guardar) y la gente se mueve cada 6 pasos:
 * interpolar «hasta el siguiente estado» da saltos de casilla; se desliza a la cadencia MEDIDA. */

export const CADENCE_LIMITS = { initialMs: 250, minMs: 100, maxMs: 3500 } as const;
export const MOTION_LIMITS = {
  /** Más de esto entre dos posiciones del servidor es un teletransporte real: se coloca, no se cruza el mapa volando. */
  snapTiles: 6,
  /** Pasos de servidor que dura un desplazamiento típico (se mueven cada 6 pasos; 5,2 deja un respiro). */
  ticksPerGlide: 5.2, minMs: 280, maxMs: 2600,
  entityMinMs: 260, entityMaxMs: 2800,
  /** Mezcla de «paso constante» y «suavizado» de la curva: sin pararse del todo entre casillas seguidas. */
  easeBlend: .4,
} as const;
export const ATMOSPHERE_SETTLE_MS = 1500;

const clampTo = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));

/**
 * Estima cuánto tarda de verdad un paso del servidor (EMA de la llegada de actualizaciones distintas).
 * Un eco de cámara (misma `sequence`) no es un paso. Mediana de 3 + EMA: un solo paso lento (guardado)
 * no mueve la media; un cambio sostenido de ritmo se adopta sin saltos.
 */
export class CadenceEstimator {
  tickIntervalMs: number = CADENCE_LIMITS.initialMs;
  private lastSequence = Number.NEGATIVE_INFINITY;
  private lastTick = Number.NEGATIVE_INFINITY;
  private lastAt = Number.NaN;
  private samples = 0;
  private readonly recent: number[] = [];

  /** Duración de un desplazamiento de un cuerpo: ≈ 5,2 pasos, acotada a [280, 2600] ms. */
  get moveDurationMs(): number { return clampTo(this.tickIntervalMs * MOTION_LIMITS.ticksPerGlide, MOTION_LIMITS.minMs, MOTION_LIMITS.maxMs); }

  /** `true` si es una actualización distinta (nueva secuencia); `false` si es un eco de cámara o datos inválidos. */
  observe(sequence: number, tick: number, nowMs: number): boolean {
    if (!Number.isFinite(sequence) || !Number.isFinite(tick) || !Number.isFinite(nowMs)) return false;
    if (sequence === this.lastSequence) return false;
    const rebase = Number.isNaN(this.lastAt) || sequence < this.lastSequence || tick < this.lastTick;
    if (rebase) { this.lastSequence = sequence; this.lastTick = tick; this.lastAt = nowMs; this.recent.length = 0; return true; }
    this.lastSequence = sequence;
    if (tick === this.lastTick) return true; // pausa u otro cambio operativo al mismo paso: no avanza el reloj del mundo
    const perTick = (nowMs - this.lastAt) / (tick - this.lastTick);
    this.lastTick = tick; this.lastAt = nowMs;
    this.recent.push(clampTo(perTick, CADENCE_LIMITS.minMs, CADENCE_LIMITS.maxMs));
    if (this.recent.length > 3) this.recent.shift();
    const middle = [...this.recent].sort((a, b) => a - b)[Math.floor(this.recent.length / 2)]!;
    const alpha = this.samples++ < 2 ? .6 : .35;
    this.tickIntervalMs = clampTo(this.tickIntervalMs + (middle - this.tickIntervalMs) * alpha, CADENCE_LIMITS.minMs, CADENCE_LIMITS.maxMs);
    return true;
  }
}

export interface MotionBody { id: string; x: number; y: number; }
/** Estado visual de un cuerpo. El objeto devuelto por `sample` se reutiliza: cópialo si lo guardas. */
export interface MotionView {
  x: number; y: number;
  /** Dirección suavizada (vector unitario o 0,0 si nunca se movió). */
  dirX: number; dirY: number;
  /** 0..1: velocidad visual en vivo; 0 al llegar o si está quieto. */
  speed: number;
  moving: boolean;
  /** Teselas recorridas en total por este cuerpo: la fase de zancada sale de aquí, no del reloj. */
  stride: number;
  /** Mira a la izquierda (se conserva mientras no cambie de sentido). */
  left: boolean;
  seed: number;
}

/** Curva de un desplazamiento: mezcla de paso constante y suavizado (S de Hermite). */
export function glideEase(k: number): number {
  const c = clampTo(k, 0, 1), b = MOTION_LIMITS.easeBlend;
  return c * (1 - b) + c * c * (3 - 2 * c) * b;
}
/** Derivada normalizada de `glideEase` (su máximo, en k = ½, vale 1). */
function glideSpeed(k: number): number {
  const b = MOTION_LIMITS.easeBlend;
  return ((1 - b) + b * 6 * k * (1 - k)) / (1 + b * .5);
}

interface Track {
  fromX: number; fromY: number; toX: number; toY: number;
  serverX: number; serverY: number;
  startedAt: number; durationMs: number; length: number; odometer: number;
  dirX: number; dirY: number; left: boolean;
  lastMoveAt: number | null;
  view: MotionView;
}

/** Semilla estable (16 bits) de un cuerpo: desfasa su zancada y su pose sin tocar el estado del mundo. */
export function bodySeed(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619) >>> 0;
  return hash & 0xffff;
}

/**
 * Trayectoria visual de personas O animales. Cada vez que el servidor cambia la casilla de un cuerpo
 * (0 < distancia ≤ 6) se parte de DONDE SE VE AHORA (nunca se vuelve atrás de golpe) hacia la casilla
 * nueva; más de 6, o un cuerpo nuevo, se coloca directamente. `sample` no tiene efectos: puede llamarse
 * varias veces por fotograma.
 */
export class MotionTracker {
  private readonly tracks = new Map<string, Track>();
  constructor(private readonly cadence: CadenceEstimator) {}

  get size(): number { return this.tracks.size; }
  clear(): void { this.tracks.clear(); }

  /** Registra las posiciones recibidas. Los que ya no vienen en la ventana se olvidan. */
  ingest(bodies: readonly MotionBody[], nowMs: number): void {
    const seen = new Set<string>();
    for (const body of bodies) {
      if (!Number.isFinite(body.x) || !Number.isFinite(body.y)) continue;
      seen.add(body.id);
      const track = this.tracks.get(body.id);
      if (!track) {
        this.tracks.set(body.id, { fromX: body.x, fromY: body.y, toX: body.x, toY: body.y, serverX: body.x, serverY: body.y, startedAt: nowMs, durationMs: 0, length: 0, odometer: 0,
          dirX: 0, dirY: 0, left: bodySeed(body.id) % 2 === 1, lastMoveAt: null,
          view: { x: body.x, y: body.y, dirX: 0, dirY: 0, speed: 0, moving: false, stride: 0, left: false, seed: bodySeed(body.id) } });
        continue;
      }
      const dx = body.x - track.serverX, dy = body.y - track.serverY, step = Math.hypot(dx, dy);
      if (step === 0) continue; // sigue su deslizamiento
      const odometer = this.odometerAt(track, nowMs);
      if (step > MOTION_LIMITS.snapTiles) {
        Object.assign(track, { fromX: body.x, fromY: body.y, toX: body.x, toY: body.y, serverX: body.x, serverY: body.y, startedAt: nowMs, durationMs: 0, length: 0, odometer, lastMoveAt: null });
        continue;
      }
      const here = this.positionAt(track, nowMs);
      const gap = track.lastMoveAt === null ? null : nowMs - track.lastMoveAt;
      const global = this.cadence.moveDurationMs;
      // Quien se mueve más seguido que el ritmo típico (p. ej. una orden directa, 1 casilla por paso) se desliza a ese ritmo.
      const durationMs = gap !== null && gap * .87 < global ? clampTo(gap * .87, MOTION_LIMITS.entityMinMs, MOTION_LIMITS.entityMaxMs) : global;
      const rx = dx / step, ry = dy / step;
      let mx = track.dirX * .4 + rx * .6, my = track.dirY * .4 + ry * .6;
      const norm = Math.hypot(mx, my);
      if (norm > 1e-6) { mx /= norm; my /= norm; } else { mx = rx; my = ry; }
      if (Math.abs(mx) > .2) track.left = mx < 0;
      Object.assign(track, { fromX: here.x, fromY: here.y, toX: body.x, toY: body.y, serverX: body.x, serverY: body.y, startedAt: nowMs, durationMs,
        length: Math.hypot(body.x - here.x, body.y - here.y), odometer, dirX: mx, dirY: my, lastMoveAt: nowMs });
    }
    for (const id of this.tracks.keys()) if (!seen.has(id)) this.tracks.delete(id);
  }

  /**
   * Alarga el deslizamiento que acaba de abrirse hasta `holdMs` (como mucho 8 s). Solo pasos cortos ya
   * registrados: no crea una trayectoria, no cruza un teletransporte y no inventa un hueco de archivo.
   */
  prolongar(holdMs: number, nowMs: number): void {
    if (!(holdMs > 0) || !Number.isFinite(nowMs)) return;
    const tope = Math.min(holdMs, 8_000);
    for (const track of this.tracks.values()) {
      if (track.startedAt !== nowMs || track.length <= 0 || track.length > MOTION_LIMITS.snapTiles) continue;
      if (track.durationMs < tope) track.durationMs = tope;
    }
  }

  /** Estado visual en `nowMs`. `undefined` si el cuerpo no se ha recibido. */
  sample(id: string, nowMs: number): MotionView | undefined {
    const track = this.tracks.get(id);
    if (!track) return undefined;
    const k = track.durationMs > 0 ? clampTo((nowMs - track.startedAt) / track.durationMs, 0, 1) : 1;
    const view = track.view, at = this.positionAt(track, nowMs);
    view.x = at.x; view.y = at.y;
    view.dirX = track.dirX; view.dirY = track.dirY; view.left = track.left;
    view.speed = k >= 1 || track.length === 0 ? 0 : clampTo(glideSpeed(k), 0, 1);
    view.moving = view.speed > 0;
    view.stride = this.odometerAt(track, nowMs);
    return view;
  }

  private progress(track: Track, nowMs: number): number {
    return track.durationMs > 0 ? glideEase((nowMs - track.startedAt) / track.durationMs) : 1;
  }
  private positionAt(track: Track, nowMs: number): { x: number; y: number } {
    const e = this.progress(track, nowMs);
    return { x: track.fromX + (track.toX - track.fromX) * e, y: track.fromY + (track.toY - track.fromY) * e };
  }
  private odometerAt(track: Track, nowMs: number): number { return track.odometer + track.length * this.progress(track, nowMs); }
}

/* ------------------------------------------------------------------ */
/* Luz del día y lluvia sin saltos                                     */
/* ------------------------------------------------------------------ */

export interface AtmosphereState { r: number; g: number; b: number; alpha: number; shadowX: number; shadowY: number; shadowAlpha: number; rain: number; color: string; }

/** Lee `rgb(r,g,b)` (el formato de `daylightAt`). */
export function parseRgb(color: string): [number, number, number] {
  const match = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(color);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [255, 255, 255];
}

/**
 * Acerca el tinte, las sombras y la lluvia a su objetivo con una exponencial (≈ 95 % en `settleMs`).
 * Admite objetivos que se mueven (la luz avanza con cada paso) sin reiniciar nada; la primera muestra se coloca.
 */
export class AtmosphereSmoother {
  private state: AtmosphereState | null = null;
  private at = 0;
  constructor(private readonly settleMs: number = ATMOSPHERE_SETTLE_MS) {}

  /** `raining`: `true`/`false` como hoy, o la intensidad local de la lluvia en [0, 1] (V23, de `WorldView.aire`). */
  step(daylight: ReturnType<typeof daylightAt>, raining: boolean | number, nowMs: number): AtmosphereState {
    const [r, g, b] = parseRgb(daylight.color);
    const rain = typeof raining === 'number' ? (Number.isFinite(raining) ? Math.max(0, Math.min(1, raining)) : 0) : raining ? 1 : 0;
    const previous = this.state;
    if (!previous) {
      this.at = nowMs;
      return this.state = { r, g, b, alpha: daylight.alpha, shadowX: daylight.shadowX, shadowY: daylight.shadowY, shadowAlpha: daylight.shadowAlpha, rain, color: `rgb(${r},${g},${b})` };
    }
    const dt = Math.max(0, nowMs - this.at); this.at = nowMs;
    const k = 1 - Math.exp(-dt / (this.settleMs / 3));
    const lerp = (from: number, to: number): number => from + (to - from) * k;
    const next = { r: lerp(previous.r, r), g: lerp(previous.g, g), b: lerp(previous.b, b), alpha: lerp(previous.alpha, daylight.alpha),
      shadowX: lerp(previous.shadowX, daylight.shadowX), shadowY: lerp(previous.shadowY, daylight.shadowY), shadowAlpha: lerp(previous.shadowAlpha, daylight.shadowAlpha), rain: lerp(previous.rain, rain) };
    return this.state = { ...next, color: `rgb(${Math.round(next.r)},${Math.round(next.g)},${Math.round(next.b)})` };
  }

  reset(): void { this.state = null; }
}

/* ------------------------------------------------------------------ */
/* V18 capa 1.5 — colchón de reproducción corto (3–6 s) en el cliente  */
/* ------------------------------------------------------------------ */
/* Presentación pura. Guarda los últimos fotogramas recibidos y reproduce un reloj virtual que va un
 * colchón por detrás del más reciente. El cabezal corre en el dominio del TICK del modelo (1 tick cada
 * `tickIntervalMs`, ±8 %), no en el de las llegadas: así un paso de servidor que tarda 2,4 s (guardado)
 * consume colchón en vez de abrir un hueco en lo que se ve.
 *
 * El colchón NO interpola posiciones A→B (quien se mueve cada 6 pasos recorría su casilla en un solo
 * intervalo y esperaba el resto). Solo decide CUÁNDO se libera cada fotograma, a un ritmo regular; los
 * fotogramas liberados alimentan a `MotionTracker`, que reparte cada casilla en ≈ 5,2 pasos, y se muestrea
 * en el reloj virtual (`visualMs`). La luz y la lluvia siguen el mismo cabezal (`shownTick`). */

export const PLAYBACK_LIMITS = {
  maxFrames: 10,
  /** Colchón objetivo = clamp(paso·3,2, 1200, 5000) ms. */
  lagPerTick: 3.2, minLagMs: 1200, maxLagMs: 5000,
  /** Margen sobre el mayor hueco entre llegadas (el colchón nunca baja de «hueco + un paso + margen»: el paso cubre el diente de sierra de las llegadas). */
  gapMarginMs: 250,
  /** Un pico de hueco (p. ej. un guardado de 2,4 s) se recuerda tanto tiempo, aunque el anillo (≈ 6 s) ya lo haya olvidado. */
  gapMemoryMs: 180_000,
  rateMin: .92, rateMax: 1.08,
  /** Banda muerta alrededor del objetivo antes de acelerar o frenar. */
  deadbandMs: 400,
  /** Más retraso que esto sobre el objetivo (pestaña dormida) = salto limpio. */
  resyncMs: 8000,
  /** Tope de un paso del reloj virtual (cambiar de pestaña no provoca saltos). */
  maxDtMs: 100,
  /** Constante de tiempo con la que la velocidad se acerca a la deseada. */
  rateSettleMs: 500,
} as const;

export interface PlaybackFrame<V> { receivedAt: number; sequence: number; tick: number; view: V; }
interface PlaybackBodies { id: string; x: number; y: number; }
interface PlaybackSource { people: readonly PlaybackBodies[]; animals?: readonly PlaybackBodies[]; }

/**
 * Anillo de ≤ 10 fotogramas + reloj de reproducción con control de velocidad suave (0,92×–1,08×).
 * Genérico sobre la vista (solo lee `people`/`animals`); sin DOM ni temporizadores: todo es explícito y se prueba solo.
 */
export class PlaybackBuffer<V extends PlaybackSource = PlaybackSource> {
  private readonly ring: PlaybackFrame<V>[] = [];
  private lastNow = Number.NaN;
  private bracketA: PlaybackFrame<V> | null = null;
  private bracketB: PlaybackFrame<V> | null = null;
  private releasedSequence = Number.NEGATIVE_INFINITY;
  private collapse = false;
  /** Último ritmo del servidor (ms por tick) con el que se avanzó; convierte ticks de colchón en milisegundos. */
  private tickMs: number = CADENCE_LIMITS.initialMs;
  /** Cabezal de reproducción, en ticks del modelo (fraccionario): se libera cada fotograma al cruzar su `tick`. */
  playTick = 0;
  /**
   * Reloj de muestreo de `MotionTracker`: avanza `dt × rate` SIN tope superior ni saltos (un vaciado o un
   * resincronizado solo mueve `playTick`), así un deslizamiento a medias nunca se corta ni se adelanta de golpe.
   */
  visualMs = 0;
  /** Velocidad actual del reloj (0,92–1,08). */
  rate = 1;
  /** Colchón objetivo vigente (ms). */
  targetLagMs: number = PLAYBACK_LIMITS.minLagMs;
  /** Mayor hueco entre llegadas distintas: el del anillo o un pico reciente (`gapMemoryMs`). */
  maxGapMs = 0;
  private gapPeak = { gap: 0, at: 0 };

  get size(): number { return this.ring.length; }
  get latest(): PlaybackFrame<V> | null { return this.ring.length ? this.ring[this.ring.length - 1]! : null; }
  /** Colchón actual (ms): cuánto contenido recibido queda por delante del cabezal al ritmo del servidor. */
  get lagMs(): number { const latest = this.latest; return latest ? (latest.tick - this.playTick) * this.tickMs : 0; }
  /** `true` si hay un par A→B que cubre el cabezal. */
  get active(): boolean { return this.bracketA !== null; }

  clear(): void {
    this.ring.length = 0;
    this.bracketA = this.bracketB = null; this.lastNow = Number.NaN; this.rate = 1; this.playTick = 0; this.maxGapMs = 0; this.gapPeak = { gap: 0, at: 0 };
    this.releasedSequence = Number.NEGATIVE_INFINITY; this.collapse = false; // `visualMs` sigue: el muestreo no retrocede
  }

  /**
   * Registra un estado recibido. Misma `sequence` que un fotograma ya guardado (eco de cámara) = se sustituye la
   * vista SIN avanzar el tiempo de reproducción. Secuencia o paso hacia atrás (reconexión) = se empieza de cero.
   */
  push(view: V, sequence: number, tick: number, receivedAt: number): void {
    if (!Number.isFinite(sequence) || !Number.isFinite(tick) || !Number.isFinite(receivedAt)) return;
    for (let i = this.ring.length - 1; i >= 0; i--) {
      const frame = this.ring[i]!;
      if (frame.sequence !== sequence) continue;
      frame.view = view; frame.tick = tick;
      return;
    }
    const last = this.latest;
    if (last && (sequence < last.sequence || tick < last.tick)) this.clear();
    const stamp = this.latest ? Math.max(receivedAt, this.latest.receivedAt) : receivedAt;
    this.ring.push({ receivedAt: stamp, sequence, tick, view });
    while (this.ring.length > PLAYBACK_LIMITS.maxFrames) this.ring.shift();
    if (this.ring.length === 1) this.playTick = tick;
    let gap = 0;
    for (let i = 1; i < this.ring.length; i++) gap = Math.max(gap, this.ring[i]!.receivedAt - this.ring[i - 1]!.receivedAt);
    if (this.ring.length > 1) {
      const fresh = stamp - this.ring[this.ring.length - 2]!.receivedAt;
      if (fresh >= this.gapPeak.gap || stamp - this.gapPeak.at > PLAYBACK_LIMITS.gapMemoryMs) this.gapPeak = { gap: fresh, at: stamp };
    }
    this.maxGapMs = Math.max(gap, this.gapPeak.gap);
  }

  /** Colapsa el colchón al fotograma más reciente (cámara movida u orden directa). La velocidad lo vuelve a llenar. */
  flushToLatest(): void {
    const latest = this.latest;
    if (!latest) return;
    this.playTick = latest.tick; this.rate = PLAYBACK_LIMITS.rateMin; this.collapse = true;
    this.locate();
  }

  /** Colchón objetivo para un ritmo de servidor dado y los huecos recientes (colchón adaptativo de jitter). */
  desiredLagMs(tickIntervalMs: number): number {
    const L = PLAYBACK_LIMITS;
    const base = Number.isFinite(tickIntervalMs) ? tickIntervalMs * L.lagPerTick : L.minLagMs;
    return clampTo(Math.max(base, this.maxGapMs + (Number.isFinite(tickIntervalMs) ? tickIntervalMs : 0) + L.gapMarginMs), L.minLagMs, L.maxLagMs);
  }

  /** Avanza el reloj virtual un fotograma de animación (`nowMs`: reloj de rAF). Devuelve la velocidad aplicada. */
  advance(nowMs: number, tickIntervalMs: number): number {
    const L = PLAYBACK_LIMITS, latest = this.latest;
    const dt = Number.isNaN(this.lastNow) || !Number.isFinite(nowMs) ? 0 : clampTo(nowMs - this.lastNow, 0, L.maxDtMs);
    if (Number.isFinite(nowMs)) this.lastNow = nowMs;
    if (!latest) return this.rate = 1;
    if (Number.isFinite(tickIntervalMs) && tickIntervalMs > 0) this.tickMs = tickIntervalMs;
    this.targetLagMs = this.desiredLagMs(tickIntervalMs);
    const target = this.targetLagMs, lag = this.lagMs;
    if (lag > target + L.resyncMs) {
      this.playTick = latest.tick - target / this.tickMs; this.rate = 1; this.collapse = true;
    } else {
      const wanted = lag > target + L.deadbandMs ? L.rateMax : lag < target - L.deadbandMs ? L.rateMin : 1;
      this.rate = clampTo(this.rate + (wanted - this.rate) * (1 - Math.exp(-dt / L.rateSettleMs)), L.rateMin, L.rateMax);
      this.playTick += dt * this.rate / this.tickMs;
    }
    this.visualMs += dt * this.rate;
    this.playTick = clampTo(this.playTick, this.ring[0]!.tick, latest.tick);
    this.locate();
    return this.rate;
  }

  /**
   * Fotogramas que el cabezal acaba de cruzar desde la última llamada, en orden. Tras un vaciado o un resincronizado
   * solo se devuelve el más reciente: `MotionTracker` se reorienta desde donde se ve el cuerpo, sin pasar por los intermedios.
   */
  takeReleased(): PlaybackFrame<V>[] {
    const out: PlaybackFrame<V>[] = [];
    for (const frame of this.ring) if (frame.sequence > this.releasedSequence && frame.tick <= this.playTick) out.push(frame);
    if (!out.length) { this.collapse = false; return out; }
    this.releasedSequence = out[out.length - 1]!.sequence;
    if (this.collapse) { this.collapse = false; return [out[out.length - 1]!]; }
    return out;
  }

  /** Par A→B que cubre el cabezal y su fracción exacta (0..1). `null` si aún no hay dos fotogramas. */
  bracket(): { a: PlaybackFrame<V>; b: PlaybackFrame<V>; alpha: number } | null {
    if (!this.bracketA || !this.bracketB) return null;
    const span = this.bracketB.tick - this.bracketA.tick;
    return { a: this.bracketA, b: this.bracketB, alpha: span > 0 ? clampTo((this.playTick - this.bracketA.tick) / span, 0, 1) : 1 };
  }

  /** Tick del modelo en el cabezal; sin colchón útil, `fallbackTick`. La luz y la lluvia siguen este flujo retrasado. */
  shownTick(fallbackTick: number): number {
    return this.bracketA ? this.playTick : fallbackTick;
  }

  /** Elige (A, B) que cubren el cabezal. */
  private locate(): void {
    const ring = this.ring, n = ring.length;
    if (n < 2) { this.bracketA = this.bracketB = null; return; }
    let i = n - 2;
    while (i > 0 && ring[i]!.tick > this.playTick) i--;
    this.bracketA = ring[i]!; this.bracketB = ring[i + 1]!;
  }
}

/** Lluvia (mm/h) que se pinta como aguacero pleno: la de una lluvia fuerte. La intensidad satura hacia ella sin tope duro. */
export const LLUVIA_PLENA_MM_H = 8;

/** Intensidad visible en [0, 1) de una lluvia de `mmH` mm/h (`AireVisible.lluvia`): ≈ 95 % a `LLUVIA_PLENA_MM_H`; 0 sin dato. */
export function intensidadLluvia(mmH: number | undefined): number {
  if (mmH === undefined || !Number.isFinite(mmH) || mmH <= 0) return 0;
  return 1 - Math.exp(-mmH / LLUVIA_PLENA_MM_H * 3);
}
