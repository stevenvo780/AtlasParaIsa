/**
 * V21 — Barra de transporte DVR («cine»): reproducir/pausar, paso a paso, velocidad, línea de tiempo con
 * sparkline de población y telemetría del motor turbo. `renderDvrBar` es HTML puro (se prueba sin DOM);
 * `mountDvrBar` lo monta y solo PARCHEA texto/valores en cada fotograma para no perder el foco ni el arrastre.
 */
import { TAPE_SPEEDS, type TapeSpeed, type TapeTimelinePoint } from '../shared/tape.js';
import { esc } from './ui-catalog.js';
import type { DvrState } from './dvr-player.js';

export type DvrBarState = Pick<DvrState, 'playing' | 'speed' | 'currentTick' | 'minTick' | 'maxTick' | 'latestDay' | 'simHz' | 'timeline' | 'aheadOfPlayhead' | 'atLiveEdge'> & Partial<Pick<DvrState, 'loading'>>;

export interface DvrBarHandlers {
  togglePlay(): void;
  step(delta: -1 | 1): void;
  setSpeed(speed: TapeSpeed): void;
  seek(tick: number): void;
  jumpLive(): void;
}
export interface DvrBarController { update(state: DvrBarState): void; destroy(): void; }

/** Puntos máximos que se dibujan en el sparkline (el servidor ya reduce la serie; esto es solo un seguro). */
const SPARK_POINTS = 160;
const SPARK_W = 100, SPARK_H = 24;
/** El arrastre del deslizador pide un `seek` como mucho cada tanto, y siempre al soltar. */
const SCRUB_DEBOUNCE_MS = 150;

/** Cualquier valor del servidor se vuelve número finito: nada llega al HTML sin pasar por aquí. */
const num = (value: unknown): number => { const n = Number(value); return Number.isFinite(n) ? n : 0; };
const int = (value: unknown): number => Math.round(num(value));

/** Último punto de la línea de tiempo cuyo tick no pasa de `tick` (o el primero si todos son posteriores). */
export function nearestTimelinePoint(timeline: readonly TapeTimelinePoint[], tick: number): TapeTimelinePoint | null {
  let best: TapeTimelinePoint | null = null, bestDistance = Infinity;
  for (const point of timeline) {
    const distance = Math.abs(num(point.tick) - tick);
    if (distance < bestDistance) { best = point; bestDistance = distance; }
  }
  return best;
}

/** «Día X · Paso Y» para el cabezal. El día sale de la línea de tiempo; sin ella, el último conocido. */
export function dvrTimeLabel(state: Pick<DvrBarState, 'currentTick' | 'timeline' | 'latestDay'>, tick = state.currentTick): string {
  const point = nearestTimelinePoint(state.timeline, tick);
  return `Día ${int(point ? point.day : state.latestDay)} · Paso ${int(tick)}`;
}

/** Vista previa al pasar/arrastrar sobre la línea: «Día · Pob · Obras · Fórmulas». */
export function dvrHoverLabel(point: TapeTimelinePoint | null): string {
  return point ? `Día ${int(point.day)} · Pob ${int(point.pop)} · Obras ${int(point.structures)} · Fórmulas ${int(point.formulas)}` : '';
}

export function dvrEngineLabel(state: Pick<DvrBarState, 'simHz' | 'latestDay' | 'aheadOfPlayhead'>): string {
  return `⚡ ${int(state.simHz)} Hz · Día ${int(state.latestDay)} (+${int(state.aheadOfPlayhead)} adel.)`;
}

/** Posición horizontal (0–100) de un tick dentro de la cinta. */
export function dvrPercent(tick: number, minTick: number, maxTick: number): number {
  const span = num(maxTick) - num(minTick);
  return span > 0 ? Math.min(100, Math.max(0, (num(tick) - num(minTick)) / span * 100)) : 100;
}

/** Contenido interior del `<svg>` del sparkline: área + línea de población (y marcador del cabezal aparte). */
export function sparklineMarkup(timeline: readonly TapeTimelinePoint[], minTick: number, maxTick: number): string {
  const sorted = [...timeline].map(p => ({ tick: num(p.tick), pop: Math.max(0, num(p.pop)) })).sort((a, b) => a.tick - b.tick);
  if (!sorted.length) return `<line class="dvr-spark-base" x1="0" y1="${SPARK_H - 1}" x2="${SPARK_W}" y2="${SPARK_H - 1}"/>`;
  const stride = Math.max(1, Math.ceil(sorted.length / SPARK_POINTS));
  const points = sorted.filter((_, i) => i % stride === 0 || i === sorted.length - 1);
  const top = Math.max(1, ...points.map(p => p.pop));
  const coords = points.map(p => `${dvrPercent(p.tick, minTick, maxTick).toFixed(2)},${(SPARK_H - 2 - p.pop / top * (SPARK_H - 5)).toFixed(2)}`);
  const first = coords[0]!.split(',')[0], last = coords[coords.length - 1]!.split(',')[0];
  return `<path class="dvr-spark-area" d="M${first},${SPARK_H} L${coords.join(' L')} L${last},${SPARK_H} Z"/><path class="dvr-spark-line" d="M${coords.join(' L')}"/>`;
}

export function renderDvrBar(state: DvrBarState, hoverPoint: TapeTimelinePoint | null = null): string {
  const speed = TAPE_SPEEDS.includes(state.speed) ? state.speed : 1;
  const min = int(state.minTick), max = Math.max(min, int(state.maxTick)), tick = Math.min(max, Math.max(min, int(state.currentTick)));
  const time = esc(dvrTimeLabel(state));
  const playing = !!state.playing, live = !!state.atLiveEdge;
  return `<div class="dvr-transport" role="group" aria-label="Reproductor del mundo"${state.loading ? ' data-loading="true"' : ''}>`
    + `<div class="dvr-controls"><button type="button" class="dvr-button" data-dvr-step="-1" aria-label="Fotograma anterior (,)" title="Fotograma anterior (,)">⏮</button>`
    + `<button type="button" class="dvr-button dvr-play" data-dvr-play aria-pressed="${playing}" aria-label="${playing ? 'Pausar' : 'Reproducir'}" title="Espacio">${playing ? '⏸' : '▶'}</button>`
    + `<button type="button" class="dvr-button" data-dvr-step="1" aria-label="Fotograma siguiente (.)" title="Fotograma siguiente (.)">⏭</button></div>`
    + `<div class="dvr-speeds" role="group" aria-label="Velocidad">${TAPE_SPEEDS.map(s => `<button type="button" class="dvr-speed" data-dvr-speed="${s}" aria-pressed="${s === speed}">${s}×</button>`).join('')}</div>`
    + `<div class="dvr-scrubber"><svg class="dvr-sparkline" viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" aria-hidden="true" focusable="false">${sparklineMarkup(state.timeline, min, max)}</svg>`
    + `<span class="dvr-playhead" data-dvr-playhead style="left:${dvrPercent(tick, min, max).toFixed(2)}%" aria-hidden="true"></span>`
    + `<input type="range" class="dvr-range" data-dvr-range min="${min}" max="${max}" step="1" value="${tick}" aria-label="Línea de tiempo del mundo" aria-valuetext="${time}">`
    + `<div class="dvr-readout"><span class="dvr-time" data-dvr-time>${time}</span><span class="dvr-hover" data-dvr-hover>${esc(dvrHoverLabel(hoverPoint))}</span></div></div>`
    + `<div class="dvr-engine"><span class="dvr-badge" data-dvr-engine title="Velocidad del motor y ticks ya calculados por delante">${esc(dvrEngineLabel(state))}</span>`
    + `<button type="button" class="dvr-live${live ? ' is-live' : ''}" data-dvr-live aria-pressed="${live}" title="Volver al borde vivo (0)">● Borde vivo</button></div></div>`;
}

/** Monta la barra en `container` (`#dvr-bar`). Delegación de eventos: el HTML interior se puede reemplazar sin reenganchar. */
export function mountDvrBar(container: HTMLElement, handlers: DvrBarHandlers): DvrBarController {
  let structure = '', timelineKey = '', scrubbing = false, last: DvrBarState | null = null;
  let scrubTimer: ReturnType<typeof setTimeout> | undefined;
  const query = <T extends Element>(selector: string): T | null => container.querySelector<T>(selector);
  const setText = (selector: string, text: string): void => { const node = query(selector); if (node && node.textContent !== text) node.textContent = text; };

  const onClick = (event: Event): void => {
    const target = event.target as Element | null;
    const button = target?.closest?.('button') as HTMLButtonElement | null;
    if (!button || !container.contains(button)) return;
    if (button.hasAttribute('data-dvr-play')) handlers.togglePlay();
    else if (button.hasAttribute('data-dvr-live')) handlers.jumpLive();
    else if (button.hasAttribute('data-dvr-step')) handlers.step(button.getAttribute('data-dvr-step') === '-1' ? -1 : 1);
    else if (button.hasAttribute('data-dvr-speed')) {
      const speed = Number(button.getAttribute('data-dvr-speed')) as TapeSpeed;
      if (TAPE_SPEEDS.includes(speed)) handlers.setSpeed(speed);
    }
  };
  const rangeValue = (event: Event): number => Number((event.target as HTMLInputElement).value);
  const onInput = (event: Event): void => {
    if (!(event.target as Element | null)?.hasAttribute?.('data-dvr-range')) return;
    scrubbing = true;
    const tick = rangeValue(event);
    if (last) { setText('[data-dvr-time]', dvrTimeLabel(last, tick)); setText('[data-dvr-hover]', dvrHoverLabel(nearestTimelinePoint(last.timeline, tick))); }
    clearTimeout(scrubTimer);
    scrubTimer = setTimeout(() => handlers.seek(tick), SCRUB_DEBOUNCE_MS);
  };
  const onChange = (event: Event): void => {
    if (!(event.target as Element | null)?.hasAttribute?.('data-dvr-range')) return;
    clearTimeout(scrubTimer); scrubTimer = undefined;
    scrubbing = false;
    handlers.seek(rangeValue(event));
  };
  const onMove = (event: Event): void => {
    const scrubber = (event.target as Element | null)?.closest?.('.dvr-scrubber') as HTMLElement | null;
    if (!scrubber || !last) return;
    const rect = scrubber.getBoundingClientRect(), x = (event as MouseEvent).clientX;
    if (!(rect.width > 0) || !Number.isFinite(x)) return;
    const tick = last.minTick + Math.min(1, Math.max(0, (x - rect.left) / rect.width)) * (last.maxTick - last.minTick);
    setText('[data-dvr-hover]', dvrHoverLabel(nearestTimelinePoint(last.timeline, tick)));
  };
  const onLeave = (): void => setText('[data-dvr-hover]', '');

  container.addEventListener('click', onClick);
  container.addEventListener('input', onInput);
  container.addEventListener('change', onChange);
  container.addEventListener('pointermove', onMove);
  container.addEventListener('pointerleave', onLeave);

  return {
    update(state: DvrBarState): void {
      last = state;
      const nextStructure = `${state.playing}|${state.speed}|${state.atLiveEdge}|${!!state.loading}`;
      const min = int(state.minTick), max = Math.max(min, int(state.maxTick));
      const lastPoint = state.timeline[state.timeline.length - 1];
      const nextTimeline = `${state.timeline.length}|${lastPoint ? int(lastPoint.tick) : ''}|${min}|${max}`;
      if (nextStructure !== structure || !query('[data-dvr-range]')) {
        if (!scrubbing) { structure = nextStructure; timelineKey = nextTimeline; container.innerHTML = renderDvrBar(state); }
      } else if (nextTimeline !== timelineKey) {
        timelineKey = nextTimeline;
        const svg = query('.dvr-sparkline'); if (svg) svg.innerHTML = sparklineMarkup(state.timeline, min, max);
        const range = query<HTMLInputElement>('[data-dvr-range]'); if (range) { range.min = String(min); range.max = String(max); }
      }
      const tick = Math.min(max, Math.max(min, int(state.currentTick)));
      const range = query<HTMLInputElement>('[data-dvr-range]');
      if (range && !scrubbing) { range.min = String(min); range.max = String(max); range.value = String(tick); range.setAttribute('aria-valuetext', dvrTimeLabel(state)); }
      const head = query<HTMLElement>('[data-dvr-playhead]'); if (head) head.style.left = `${dvrPercent(tick, min, max).toFixed(2)}%`;
      if (!scrubbing) setText('[data-dvr-time]', dvrTimeLabel(state));
      setText('[data-dvr-engine]', dvrEngineLabel(state));
    },
    destroy(): void {
      clearTimeout(scrubTimer);
      container.removeEventListener('click', onClick);
      container.removeEventListener('input', onInput);
      container.removeEventListener('change', onChange);
      container.removeEventListener('pointermove', onMove);
      container.removeEventListener('pointerleave', onLeave);
      container.innerHTML = '';
    },
  };
}
