/**
 * V23 — Barra de transporte de la cinta («cine»): reproducir/pausar, paso a paso, velocidad, insignia de escala (nivel
 * y paso en tiempo de mundo), botón «Presente» con el desfase, y la serie de población de toda la vida como fondo de la
 * barra con marcas de bifurcación y laguna. `renderDvrBar` es HTML puro (se prueba sin DOM); `mountDvrBar` lo monta y
 * solo PARCHEA texto/valores en cada fotograma para no perder el foco ni el arrastre.
 */
import { CINTA, type Bifurcacion, type Laguna, type Nivel, type SeriePunto } from '../shared/cinta.js';
import { esc } from './ui-catalog.js';
import { SEGUNDOS_POR_TICK, TICKS_POR_DIA, VELOCIDADES, type DvrState, type ModoReloj, type Velocidad } from './dvr-player.js';

export type DvrBarState = Pick<DvrState, 'playing' | 'speed' | 'currentTick' | 'minTick' | 'maxTick' | 'latestDay' | 'simHz' | 'serie' | 'bifurcaciones' | 'lagunas' | 'nivel' | 'aheadOfPlayhead' | 'atLiveEdge'> & Partial<Pick<DvrState, 'loading' | 'estado' | 'modoReloj' | 'playTick' | 'paso'>> & { archivo?: boolean };

export interface DvrBarHandlers {
  togglePlay(): void;
  step(delta: -1 | 1): void;
  setSpeed(speed: Velocidad): void;
  /** 1 s de mundo por 1 s de pared. Opcional para quien aún no lo conecta. */
  setTiempoReal?(): void;
  /** Un tick de mundo por segundo de pared. */
  setPaseo?(): void;
  seek(tick: number): void;
  jumpLive(): void;
  reproducirTramo?(desde: number, hasta: number): void;
}
export interface DvrBarController {
  update(state: DvrBarState): void;
  seleccionarTramo(tramo: { desde: number; hasta: number }): void;
  destroy(): void;
}

/** Puntos máximos que se dibujan de la serie (el servidor ya la decima a ≤ 400; esto es solo un seguro). */
const SPARK_POINTS = 160;
const SPARK_W = 100, SPARK_H = 24;
/** El arrastre del deslizador pide un `seek` como mucho cada tanto, y siempre al soltar (ms). */
const SCRUB_DEBOUNCE_MS = 150;
const modoDe = (state: Partial<Pick<DvrBarState, 'modoReloj'>>): ModoReloj => state.modoReloj ?? 'ritmo';
const relojPreciso = (modo: ModoReloj | undefined): boolean => modo === 'tiempo-real' || modo === 'paseo';

/** Nombre del nivel de la cinta (cinta-sonnet §2): lo que el usuario ve en la insignia. */
export const NOMBRE_NIVEL: Record<Nivel, string> = {
  0: 'Detalle completo', 1: 'Sin telemetría', 2: 'Fauna en densidad', 3: 'Resumen diario', 4: 'Resumen de 10 días',
};

/** Cualquier valor del servidor se vuelve número finito: nada llega al HTML sin pasar por aquí. */
const num = (value: unknown): number => { const n = Number(value); return Number.isFinite(n) ? n : 0; };
const int = (value: unknown): number => Math.round(num(value));

/** Duración de mundo legible: «14 min», «6 d», «2 d 4 h». Entrada en segundos de mundo. */
export function duracionDeMundo(segundos: number): string {
  const s = Math.max(0, num(segundos));
  if (s < 60) return `${Math.max(1, Math.round(s))} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86_400) { const h = Math.floor(s / 3600), m = Math.round((s - h * 3600) / 60); return m && h < 10 ? `${h} h ${m} min` : `${Math.round(s / 3600)} h`; }
  const d = Math.floor(s / 86_400), h = Math.round((s - d * 86_400) / 3600);
  return h && d < 10 ? `${d} d ${h} h` : `${Math.round(s / 86_400)} d`;
}

/** Duración de mundo de un número de ticks: «4 d 6 h». */
export function duracionDeTicks(ticks: number): string { return duracionDeMundo(Math.max(0, num(ticks)) * SEGUNDOS_POR_TICK); }

/** Segundos de mundo que pasan por cada segundo real al nivel y velocidad dados: fps del nivel × paso × velocidad. */
export function segundosDeMundoPorSegundo(nivel: Nivel, velocidad: number): number {
  return CINTA.fpsNormal * CINTA.pasos[nivel] * Math.max(0, num(velocidad)) * SEGUNDOS_POR_TICK;
}

/** Insignia de escala: «Detalle completo · 1 s = 14 min de mundo». Sin nivel (aún sin fotograma) devuelve cadena vacía. */
export function escalaLabel(nivel: Nivel | null | undefined, velocidad: number): string {
  if (nivel === null || nivel === undefined || !(nivel in NOMBRE_NIVEL)) return '';
  return `${NOMBRE_NIVEL[nivel]} · 1 s = ${duracionDeMundo(segundosDeMundoPorSegundo(nivel, velocidad))} de mundo`;
}

/** Duración con los segundos que `duracionDeMundo` redondea: 144 s son «2 min 24 s», no «2 min». */
export function duracionPrecisa(segundos: number): string {
  const s = Math.max(0, Math.round(num(segundos)));
  if (s < 60) return `${s} s`;
  const parte = (n: number, unidad: string): string => n ? `${n} ${unidad}` : '';
  if (s < 3600) return [parte(Math.floor(s / 60), 'min'), parte(s % 60, 's')].filter(Boolean).join(' ');
  if (s < 86_400) return [parte(Math.floor(s / 3600), 'h'), parte(Math.floor(s % 3600 / 60), 'min'), parte(s % 60, 's')].filter(Boolean).join(' ');
  const resto = s % 86_400;
  return [parte(Math.floor(s / 86_400), 'd'), parte(Math.floor(resto / 3600), 'h'), parte(Math.floor(resto % 3600 / 60), 'min')].filter(Boolean).join(' ');
}

/**
 * Insignia del reloj. Tiempo real dice 1 s = 1 s y cuánto tarda el fotograma: cada tick son 36 s y no hay
 * interpolación entre medias. Un ritmo conserva la escala de fotogramas.
 */
export function relojLabel(state: Pick<DvrBarState, 'nivel' | 'speed'> & Partial<Pick<DvrBarState, 'modoReloj' | 'paso'>>): string {
  if (state.modoReloj === 'borde-vivo') return 'Borde vivo · la imagen sigue el presente de la cinta';
  const paso = state.paso && state.paso > 0 ? state.paso : state.nivel != null && state.nivel in NOMBRE_NIVEL ? CINTA.pasos[state.nivel] : 1;
  if (state.modoReloj === 'tiempo-real') return `Tiempo real · 1 s = 1 s de mundo · fotograma cada ${duracionPrecisa(paso * SEGUNDOS_POR_TICK)} · cada tick son ${SEGUNDOS_POR_TICK} s · el terreno espera`;
  if (state.modoReloj === 'paseo') return `Paseo · 1 tick de mundo por segundo · fotograma cada ${duracionPrecisa(paso)} · los cuerpos se deslizan entre fotos cercanas`;
  return escalaLabel(state.nivel, state.speed);
}

/** Punto de la serie más cercano al tick (o `null` si no hay serie). */
export function nearestSeriePoint(serie: readonly SeriePunto[], tick: number): SeriePunto | null {
  let best: SeriePunto | null = null, bestDistance = Infinity;
  for (const point of serie) {
    const distance = Math.abs(num(point.t) - tick);
    if (distance < bestDistance) { best = point; bestDistance = distance; }
  }
  return best;
}

/** «Día X · HH:MM» para el cabezal. Con `preciso`, incluye segundos: en tiempo real el reloj avanza entre fotogramas. */
export function dvrTimeLabel(state: Pick<DvrBarState, 'currentTick'>, tick = state.currentTick, preciso = false): string {
  const t = Math.max(0, preciso ? num(tick) : int(tick)), dia = Math.floor(t / TICKS_POR_DIA) + 1;
  const segundos = (t % TICKS_POR_DIA) / TICKS_POR_DIA * 86_400;
  if (!preciso) {
    const minutos = Math.floor(segundos / 60);
    return `Día ${dia} · ${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}`;
  }
  const total = Math.floor(segundos + 1e-9);
  const h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60;
  return `Día ${dia} · ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Hora que muestra la barra: en tiempo real sale de `playTick` (fracción incluida) y lleva segundos. */
export function horaVisible(state: Pick<DvrBarState, 'currentTick'> & Partial<Pick<DvrBarState, 'modoReloj' | 'playTick'>>): string {
  const preciso = relojPreciso(state.modoReloj);
  return dvrTimeLabel(state, preciso ? (state.playTick ?? state.currentTick) : state.currentTick, preciso);
}

/** Vista previa al pasar/arrastrar sobre la línea: «Día · Pob · Fauna · Obras · Sustancias». */
export function dvrHoverLabel(point: SeriePunto | null): string {
  return point ? `${dvrTimeLabel({ currentTick: 0 }, point.t)} · Pob ${int(point.poblacion)} · Fauna ${int(point.fauna)} · Obras ${int(point.estructuras)} · Sustancias ${int(point.sustancias)}` : '';
}

export function dvrEngineLabel(state: Pick<DvrBarState, 'simHz'>): string { return `⚡ ${int(state.simHz)} Hz`; }

/**
 * El botón «Borde vivo» está pulsado solo si ese modo fue elegido. La cercanía al final
 * (`atLiveEdge`, margen de ticks) no lo enciende. En archivo, «Último fotograma» marca la posición exacta.
 */
export function sigueBorde(state: Pick<DvrBarState, 'aheadOfPlayhead'> & Partial<Pick<DvrBarState, 'modoReloj' | 'archivo'>>): boolean {
  if (state.archivo) return num(state.aheadOfPlayhead) <= 0;
  return state.modoReloj === 'borde-vivo';
}

/** Distancia al presente, o al final si es archivo. «en el presente» solo mientras se sigue el borde. */
export function desfaseLabel(state: Pick<DvrBarState, 'aheadOfPlayhead' | 'atLiveEdge'> & Partial<Pick<DvrBarState, 'archivo' | 'modoReloj'>>): string {
  const ahead = Math.max(0, num(state.aheadOfPlayhead));
  if (state.archivo) return ahead <= 0 ? 'Fin de la grabación' : `${duracionDeTicks(ahead)} de mundo hasta el final`;
  if (state.modoReloj === 'borde-vivo') return 'en el presente';
  if (ahead <= 0) return 'en la última foto';
  return `${duracionDeTicks(ahead)} de mundo hasta el presente`;
}

/** Posición horizontal (0–100) de un tick dentro de la cinta. */
export function dvrPercent(tick: number, minTick: number, maxTick: number): number {
  const span = num(maxTick) - num(minTick);
  return span > 0 ? Math.min(100, Math.max(0, (num(tick) - num(minTick)) / span * 100)) : 100;
}

/** Marcas verticales de bifurcación y tramos de laguna, dentro del `<svg>` de la serie (atributos propios: no necesitan CSS). */
export function marcasMarkup(bifurcaciones: readonly Bifurcacion[], lagunas: readonly Laguna[], minTick: number, maxTick: number): string {
  const lagunasSvg = lagunas.map(l => {
    const x0 = dvrPercent(l.t0, minTick, maxTick), x1 = dvrPercent(l.t1, minTick, maxTick);
    return `<rect class="dvr-marca dvr-marca-laguna" data-dvr-laguna="${int(l.t0)}" x="${x0.toFixed(2)}" y="0" width="${Math.max(0.4, x1 - x0).toFixed(2)}" height="${SPARK_H}" fill="#000" fill-opacity="0.55"/>`;
  });
  const bifurcacionesSvg = bifurcaciones.map(b => {
    const x = dvrPercent(b.desde, minTick, maxTick).toFixed(2);
    return `<line class="dvr-marca dvr-marca-bifurcacion" data-dvr-bifurcacion="${int(b.epoca)}" x1="${x}" y1="0" x2="${x}" y2="${SPARK_H}" stroke="#e8a86a" stroke-width="1.6" vector-effect="non-scaling-stroke"/>`;
  });
  return lagunasSvg.join('') + bifurcacionesSvg.join('');
}

/** Contenido interior del `<svg>`: área + línea de población de toda la vida y las marcas encima. */
export function sparklineMarkup(serie: readonly SeriePunto[], minTick: number, maxTick: number, bifurcaciones: readonly Bifurcacion[] = [], lagunas: readonly Laguna[] = []): string {
  const sorted = [...serie].map(p => ({ t: num(p.t), pop: Math.max(0, num(p.poblacion)) })).sort((a, b) => a.t - b.t);
  const marcas = marcasMarkup(bifurcaciones, lagunas, minTick, maxTick);
  if (!sorted.length) return `<line class="dvr-spark-base" x1="0" y1="${SPARK_H - 1}" x2="${SPARK_W}" y2="${SPARK_H - 1}"/>${marcas}`;
  const stride = Math.max(1, Math.ceil(sorted.length / SPARK_POINTS));
  const points = sorted.filter((_, i) => i % stride === 0 || i === sorted.length - 1);
  const top = Math.max(1, ...points.map(p => p.pop));
  const coords = points.map(p => `${dvrPercent(p.t, minTick, maxTick).toFixed(2)},${(SPARK_H - 2 - p.pop / top * (SPARK_H - 5)).toFixed(2)}`);
  const first = coords[0]!.split(',')[0], last = coords[coords.length - 1]!.split(',')[0];
  return `<path class="dvr-spark-area" d="M${first},${SPARK_H} L${coords.join(' L')} L${last},${SPARK_H} Z"/><path class="dvr-spark-line" d="M${coords.join(' L')}"/>${marcas}`;
}

const ESTADO_ERROR = '⚠ La cinta dejó de grabar: el mundo sigue, pero esto no se guarda.';

export function renderDvrBar(state: DvrBarState, hoverPoint: SeriePunto | null = null): string {
  const modo = modoDe(state);
  const speed = VELOCIDADES.includes(state.speed) ? state.speed : 1;
  const min = int(state.minTick), max = Math.max(min, int(state.maxTick)), tick = Math.min(max, Math.max(min, int(state.currentTick)));
  const time = esc(horaVisible(state));
  const playing = !!state.playing, live = sigueBorde(state);
  const escala = relojLabel(state);
  const ritmo = modo === 'ritmo';
  return `<div class="dvr-transport" role="group" aria-label="Reproductor del mundo"${state.loading ? ' data-loading="true"' : ''}>`
    + `<div class="dvr-controls"><button type="button" class="dvr-button" data-dvr-step="-1" aria-label="Fotograma anterior (,)" title="Fotograma anterior (,)">⏮</button>`
    + `<button type="button" class="dvr-button dvr-play" data-dvr-play aria-pressed="${playing}" aria-label="${playing ? 'Pausar' : 'Reproducir'}" title="Espacio">${playing ? '⏸' : '▶'}</button>`
    + `<button type="button" class="dvr-button" data-dvr-step="1" aria-label="Fotograma siguiente (.)" title="Fotograma siguiente (.)">⏭</button></div>`
    + `<div class="dvr-speeds" role="group" aria-label="Velocidad">`
    + `<button type="button" class="dvr-speed" data-dvr-tiempo-real aria-pressed="${modo === 'tiempo-real'}" title="1 segundo de mundo por cada segundo">Tiempo real</button>`
    + `<button type="button" class="dvr-speed" data-dvr-paseo aria-pressed="${modo === 'paseo'}" title="Un tick de mundo por cada segundo. En detalle, una foto cada 4 segundos">Paseo</button>`
    + `${VELOCIDADES.map(s => `<button type="button" class="dvr-speed" data-dvr-speed="${s}" aria-pressed="${ritmo && s === speed}">${s}×</button>`).join('')}</div>`
    + `<div class="dvr-scrubber"><svg class="dvr-sparkline" viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" aria-hidden="true" focusable="false">${sparklineMarkup(state.serie, min, max, state.bifurcaciones, state.lagunas)}</svg>`
    + `<span class="dvr-playhead" data-dvr-playhead style="left:${dvrPercent(tick, min, max).toFixed(2)}%" aria-hidden="true"></span>`
    + `<input type="range" class="dvr-range" data-dvr-range min="${min}" max="${max}" step="1" value="${tick}" aria-label="Línea de tiempo del mundo" aria-valuetext="${time}">`
    + `<div class="dvr-readout"><span class="dvr-time" data-dvr-time>${time}</span><span class="dvr-desfase" data-dvr-desfase>${esc(desfaseLabel(state))}</span><span class="dvr-hover" data-dvr-hover>${esc(dvrHoverLabel(hoverPoint))}</span></div>`
    + `<div class="dvr-estado" data-dvr-estado role="status">${state.estado === 'error' ? ESTADO_ERROR : ''}</div></div>`
    + `<details class="dvr-tramo"><summary>Elegir tramo</summary><div class="dvr-tramo-controles"><button type="button" data-tramo-inicio>Marcar inicio</button><button type="button" data-tramo-fin>Marcar final</button><button type="button" data-tramo-play disabled>Ver tramo</button><span data-tramo-label role="status">Elige inicio y final en la línea de tiempo</span></div></details>`
    + `<div class="dvr-engine"><span class="dvr-badge dvr-escala" data-dvr-escala title="Qué tanto mundo pasa por cada segundo de reproducción">${esc(escala)}</span>`
    + (state.archivo ? '' : `<span class="dvr-badge" data-dvr-engine title="Velocidad del motor (ticks por segundo)">${esc(dvrEngineLabel(state))}</span>`)
    + `<button type="button" class="dvr-live${live ? ' is-live' : ''}" data-dvr-live aria-pressed="${live}" title="${state.archivo ? 'Último fotograma (0)' : 'Seguir el presente de la cinta (0)'}">${state.archivo ? 'Último fotograma' : 'Borde vivo'}</button></div></div>`;
}

/** Monta la barra en `container` (`#dvr-bar`). Delegación de eventos: el HTML interior se puede reemplazar sin reenganchar. */
export function mountDvrBar(container: HTMLElement, handlers: DvrBarHandlers): DvrBarController {
  let serieKey = '', scrubbing = false, last: DvrBarState | null = null;
  let scrubTimer: ReturnType<typeof setTimeout> | undefined;
  let inicio: number | null = null, fin: number | null = null;
  const query = <T extends Element>(selector: string): T | null => container.querySelector<T>(selector);
  const setText = (selector: string, text: string): void => { const node = query(selector); if (node && node.textContent !== text) node.textContent = text; };

  const onClick = (event: Event): void => {
    const target = event.target as Element | null;
    const button = target?.closest?.('button') as HTMLButtonElement | null;
    if (!button || !container.contains(button)) return;
    if (button.hasAttribute('data-tramo-inicio') && last) { inicio = last.currentTick; actualizarTramo(); }
    else if (button.hasAttribute('data-tramo-fin') && last) { fin = last.currentTick; actualizarTramo(); }
    else if (button.hasAttribute('data-tramo-play') && inicio !== null && fin !== null) {
      handlers.reproducirTramo?.(inicio, fin);
      const detalle = button.closest('details');
      if (detalle) { detalle.open = false; detalle.querySelector('summary')?.focus({ preventScroll: true }); }
    }
    else if (button.hasAttribute('data-dvr-play')) handlers.togglePlay();
    else if (button.hasAttribute('data-dvr-tiempo-real')) handlers.setTiempoReal?.();
    else if (button.hasAttribute('data-dvr-paseo')) handlers.setPaseo?.();
    else if (button.hasAttribute('data-dvr-live')) handlers.jumpLive();
    else if (button.hasAttribute('data-dvr-step')) handlers.step(button.getAttribute('data-dvr-step') === '-1' ? -1 : 1);
    else if (button.hasAttribute('data-dvr-speed')) {
      const speed = Number(button.getAttribute('data-dvr-speed')) as Velocidad;
      if (VELOCIDADES.includes(speed)) handlers.setSpeed(speed);
    }
  };
  const actualizarTramo = (): void => {
    const play = query<HTMLButtonElement>('[data-tramo-play]');
    if (play) play.disabled = inicio === null || fin === null || fin <= inicio || !last || inicio < last.minTick || fin > last.maxTick;
    setText('[data-tramo-label]', `${inicio === null ? 'Inicio sin marcar' : `Desde ${dvrTimeLabel({ currentTick: inicio })}`} · ${fin === null ? 'final sin marcar' : `Hasta ${dvrTimeLabel({ currentTick: fin })}`}`);
  };
  const rangeValue = (event: Event): number => Number((event.target as HTMLInputElement).value);
  const onInput = (event: Event): void => {
    if (!(event.target as Element | null)?.hasAttribute?.('data-dvr-range')) return;
    scrubbing = true;
    const tick = rangeValue(event);
    if (last) {
      const time = dvrTimeLabel(last, tick, relojPreciso(last.modoReloj));
      setText('[data-dvr-time]', time);
      (event.target as HTMLInputElement).setAttribute('aria-valuetext', time);
      setText('[data-dvr-hover]', dvrHoverLabel(nearestSeriePoint(last.serie, tick)));
    }
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
    setText('[data-dvr-hover]', dvrHoverLabel(nearestSeriePoint(last.serie, tick)));
  };
  const onLeave = (): void => setText('[data-dvr-hover]', '');
  const setAttr = (node: Element | null, name: string, value: string | null): void => {
    if (!node || node.getAttribute(name) === value) return;
    if (value === null) node.removeAttribute(name); else node.setAttribute(name, value);
  };
  /** Lo que `renderDvrBar` deriva de `playing`, `speed`, el modo y el final de archivo, sobre los mismos nodos. */
  const ajustarControles = (state: DvrBarState): void => {
    const modo = modoDe(state), ritmo = modo === 'ritmo';
    const speed = VELOCIDADES.includes(state.speed) ? state.speed : 1, playing = !!state.playing;
    const live = sigueBorde(state);
    setAttr(query('.dvr-transport'), 'data-loading', state.loading ? 'true' : null);
    const play = query('[data-dvr-play]');
    setAttr(play, 'aria-pressed', String(playing)); setAttr(play, 'aria-label', playing ? 'Pausar' : 'Reproducir');
    setText('[data-dvr-play]', playing ? '⏸' : '▶');
    setAttr(query('[data-dvr-tiempo-real]'), 'aria-pressed', String(modo === 'tiempo-real'));
    setAttr(query('[data-dvr-paseo]'), 'aria-pressed', String(modo === 'paseo'));
    for (const b of container.querySelectorAll('[data-dvr-speed]')) setAttr(b, 'aria-pressed', String(ritmo && Number(b.getAttribute('data-dvr-speed')) === speed));
    const vivo = query('[data-dvr-live]');
    setAttr(vivo, 'aria-pressed', String(live)); vivo?.classList.toggle('is-live', live);
    setText('[data-dvr-estado]', state.estado === 'error' ? ESTADO_ERROR : '');
  };

  container.addEventListener('click', onClick);
  container.addEventListener('input', onInput);
  container.addEventListener('change', onChange);
  container.addEventListener('pointermove', onMove);
  container.addEventListener('pointerleave', onLeave);

  return {
    seleccionarTramo({ desde, hasta }): void {
      inicio = desde; fin = hasta;
      actualizarTramo();
    },
    update(state: DvrBarState): void {
      last = state;
      const min = int(state.minTick), max = Math.max(min, int(state.maxTick));
      const lastPoint = state.serie[state.serie.length - 1];
      const nextSerie = `${state.serie.length}|${lastPoint ? int(lastPoint.t) : ''}|${min}|${max}|${state.bifurcaciones.length}|${state.lagunas.length}`;
      // La barra se pinta entera una sola vez: rehacerla al cambiar `loading` (cada trozo que llega) o la velocidad
      // cambiaba los botones bajo el puntero y el clic caía en un nodo ya retirado (con el motor a ~100 Hz y 25×, el
      // botón «Presente» no se podía pulsar). Lo demás se ajusta en su sitio.
      const pintada = !!query('[data-dvr-range]');
      if (!pintada) {
        if (!scrubbing) { serieKey = nextSerie; container.innerHTML = renderDvrBar(state); }
      } else if (nextSerie !== serieKey) {
        serieKey = nextSerie;
        const svg = query('.dvr-sparkline'); if (svg) svg.innerHTML = sparklineMarkup(state.serie, min, max, state.bifurcaciones, state.lagunas);
        const range = query<HTMLInputElement>('[data-dvr-range]'); if (range) { range.min = String(min); range.max = String(max); }
      }
      const tick = Math.min(max, Math.max(min, int(state.currentTick)));
      const hora = horaVisible(state);
      const range = query<HTMLInputElement>('[data-dvr-range]');
      if (range && !scrubbing) { range.min = String(min); range.max = String(max); range.value = String(tick); range.setAttribute('aria-valuetext', hora); }
      const head = query<HTMLElement>('[data-dvr-playhead]'); if (head) head.style.left = `${dvrPercent(tick, min, max).toFixed(2)}%`;
      if (!scrubbing) setText('[data-dvr-time]', hora);
      setText('[data-dvr-desfase]', desfaseLabel(state));
      setText('[data-dvr-escala]', relojLabel(state));
      setText('[data-dvr-engine]', dvrEngineLabel(state));
      if (pintada) ajustarControles(state);
      if (inicio !== null || fin !== null) actualizarTramo();
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
