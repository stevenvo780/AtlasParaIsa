/**
 * Barra de transporte de la cinta: una fila (reproducir, hora, línea de tiempo, ritmo y presente).
 * El ritmo es una sola etiqueta con el modo actual; el menú guarda todos los modos y se cierra al elegir.
 * Paso, tramos y telemetría siguen en «Más». `renderDvrBar` es HTML puro; `mountDvrBar` lo monta
 * y solo parchea texto y valores, para no perder el foco ni el arrastre.
 *
 * El deslizador no pide `seek` en `input` y otra vez en `change`: un solo commit. Mientras el dedo
 * está abajo, o el salto pedido aún no aterrizó, `update` no reescribe el valor (si no, el cabezal
 * vuelve al tick anterior). La vista previa usa el tick elegido; la serie solo aporta las cifras.
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
const modoDe = (state: Partial<Pick<DvrBarState, 'modoReloj'>>): ModoReloj => state.modoReloj ?? 'ritmo';
const relojPreciso = (modo: ModoReloj | undefined): boolean => modo === 'tiempo-real' || modo === 'paseo';

/** Texto de la etiqueta de ritmo, el que el reproductor está usando ahora: «Tiempo real», «Paseo», «0,5×». */
export function etiquetaRitmo(state: Partial<Pick<DvrBarState, 'modoReloj' | 'speed'>>): string {
  const modo = modoDe(state);
  if (modo === 'tiempo-real') return 'Tiempo real';
  if (modo === 'paseo') return 'Paseo';
  if (modo === 'borde-vivo') return 'Borde vivo';
  const cruda = state.speed as Velocidad | undefined;
  const speed = cruda != null && VELOCIDADES.includes(cruda) ? cruda : 1;
  return `${String(speed).replace('.', ',')}×`;
}

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

/**
 * Vista previa al pasar o arrastrar. La hora es la del tick elegido (`tick`); si no se pasa, la del
 * punto de la serie. Las cifras (población, fauna, obras) salen del punto más cercano, que puede no
 * caer en el mismo instante.
 */
export function dvrHoverLabel(point: SeriePunto | null, tick?: number): string {
  if (!point && tick == null) return '';
  const cuando = dvrTimeLabel({ currentTick: 0 }, tick ?? point!.t);
  if (!point) return cuando;
  return `${cuando} · Pob ${int(point.poblacion)} · Fauna ${int(point.fauna)} · Obras ${int(point.estructuras)} · Sustancias ${int(point.sustancias)}`;
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

/**
 * Tick bajo un puntero, lineal en la pista. El CSS anula el padding del `input`, así que el rectángulo
 * del rango y esta cuenta coinciden con el pulgar nativo (pulgar de 2 px).
 */
export function tickDesdePuntero(clientX: number, izquierda: number, ancho: number, minTick: number, maxTick: number): number {
  const span = num(maxTick) - num(minTick);
  if (!(ancho > 0) || !Number.isFinite(clientX) || !(span > 0)) return num(minTick);
  const fraccion = Math.min(1, Math.max(0, (clientX - izquierda) / ancho));
  return num(minTick) + fraccion * span;
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
const POPOVER_ID = 'dvr-popover';
const RITMO_ID = 'dvr-ritmo-menu';

/** Botones de modo, una sola vez: la etiqueta de fuera solo muestra el actual y abre este grupo. */
function botonesRitmo(modo: ModoReloj, speed: Velocidad): string {
  const ritmo = modo === 'ritmo';
  const marca = (activo: boolean): string => `role="menuitemradio" aria-checked="${activo}"`;
  return `<button type="button" class="dvr-speed" ${marca(modo === 'tiempo-real')} data-dvr-tiempo-real aria-pressed="${modo === 'tiempo-real'}" title="1 segundo de mundo por cada segundo">Tiempo real</button>`
    + `<button type="button" class="dvr-speed" ${marca(modo === 'paseo')} data-dvr-paseo aria-pressed="${modo === 'paseo'}" title="Un tick de mundo por cada segundo. En detalle, una foto cada 4 segundos">Paseo</button>`
    + VELOCIDADES.map(s => `<button type="button" class="dvr-speed" ${marca(ritmo && s === speed)} data-dvr-speed="${s}" aria-pressed="${ritmo && s === speed}">${s}×</button>`).join('');
}

export function renderDvrBar(state: DvrBarState, hoverPoint: SeriePunto | null = null): string {
  const modo = modoDe(state);
  const speed = VELOCIDADES.includes(state.speed) ? state.speed : 1;
  const min = int(state.minTick), max = Math.max(min, int(state.maxTick)), tick = Math.min(max, Math.max(min, int(state.currentTick)));
  const time = esc(horaVisible(state));
  const playing = !!state.playing, live = sigueBorde(state);
  const escala = relojLabel(state);
  const etiqueta = etiquetaRitmo({ modoReloj: modo, speed });
  const vivoTexto = state.archivo ? 'Último fotograma' : 'Borde vivo';
  const vivoTitle = state.archivo ? 'Último fotograma (0)' : 'Seguir el presente de la cinta (0)';
  return `<div class="dvr-transport" role="group" aria-label="Reproductor del mundo"${state.loading ? ' data-loading="true"' : ''}>`
    + `<button type="button" class="dvr-button dvr-play" data-dvr-play aria-pressed="${playing}" aria-label="${playing ? 'Pausar' : 'Reproducir'}" title="Espacio">${playing ? '⏸' : '▶'}</button>`
    + `<span class="dvr-time" data-dvr-time title="${time}">${time}</span>`
    + `<div class="dvr-scrubber"><div class="dvr-track"><svg class="dvr-sparkline" width="100%" height="32" viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" aria-hidden="true" focusable="false">${sparklineMarkup(state.serie, min, max, state.bifurcaciones, state.lagunas)}</svg>`
    + `<span class="dvr-playhead" data-dvr-playhead style="left:${dvrPercent(tick, min, max).toFixed(2)}%" aria-hidden="true"></span>`
    + `<input type="range" class="dvr-range" data-dvr-range min="${min}" max="${max}" step="1" value="${tick}" aria-label="Línea de tiempo del mundo" aria-valuetext="${time}"></div>`
    + `<span class="dvr-hover" data-dvr-hover>${esc(dvrHoverLabel(hoverPoint))}</span>`
    + `<div class="dvr-estado" data-dvr-estado role="status">${state.estado === 'error' ? ESTADO_ERROR : ''}</div></div>`
    + `<div class="dvr-ritmo-wrap"><button type="button" class="dvr-ritmo" data-dvr-ritmo aria-expanded="false" aria-controls="${RITMO_ID}" aria-haspopup="menu" aria-label="Ritmo: ${etiqueta}">${etiqueta}</button>`
    + `<div id="${RITMO_ID}" class="dvr-ritmo-menu" role="menu" aria-label="Velocidad" hidden>${botonesRitmo(modo, speed)}</div></div>`
    + `<button type="button" class="dvr-live${live ? ' is-live' : ''}" data-dvr-live aria-pressed="${live}" title="${vivoTitle}">${vivoTexto}</button>`
    + `<div class="dvr-more-wrap"><button type="button" class="dvr-more" data-dvr-mas aria-expanded="false" aria-controls="${POPOVER_ID}" aria-haspopup="dialog" aria-label="Paso, tramos y telemetría" title="Paso, tramos y telemetría">⋯</button>`
    + `<div id="${POPOVER_ID}" class="dvr-popover" role="dialog" aria-label="Paso, tramos y telemetría" hidden>`
    + `<div class="dvr-controls" role="group" aria-label="Fotograma a fotograma"><button type="button" class="dvr-button" data-dvr-step="-1" aria-label="Fotograma anterior (,)" title="Fotograma anterior (,)">⏮</button>`
    + `<button type="button" class="dvr-button" data-dvr-step="1" aria-label="Fotograma siguiente (.)" title="Fotograma siguiente (.)">⏭</button></div>`
    + `<details class="dvr-tramo"><summary>Elegir tramo</summary><div class="dvr-tramo-controles"><button type="button" data-tramo-inicio>Marcar inicio</button><button type="button" data-tramo-fin>Marcar final</button><button type="button" data-tramo-play disabled>Ver tramo</button><span data-tramo-label role="status">Elige inicio y final en la línea de tiempo</span></div></details>`
    + `<div class="dvr-engine"><p class="dvr-popover-title">Telemetría</p><span class="dvr-badge dvr-escala" data-dvr-escala title="Qué tanto mundo pasa por cada segundo de reproducción">${esc(escala)}</span>`
    + `<span class="dvr-badge" data-dvr-engine title="Velocidad del motor (ticks por segundo)"${state.archivo ? ' hidden' : ''}>${esc(dvrEngineLabel(state))}</span>`
    + `<span class="dvr-desfase" data-dvr-desfase>${esc(desfaseLabel(state))}</span></div>`
    + `</div></div></div>`;
}

/** Monta la barra en `container` (`#dvr-bar`). Delegación de eventos: el HTML interior se puede reemplazar sin reenganchar. */
export function mountDvrBar(container: HTMLElement, handlers: DvrBarHandlers): DvrBarController {
  let serieKey = '', last: DvrBarState | null = null;
  let inicio: number | null = null, fin: number | null = null;
  /** El puntero está sobre la pista: no aceptar el tick del reproductor. */
  let pointerDown = false;
  /** Hay un gesto en curso o un `seek` que todavía no aterrizó. */
  let hold = false;
  /** Tick que muestra la pista durante el gesto. */
  let holdTick: number | null = null;
  /** Último tick enviado a `seek`. Un `change` repetido del mismo valor no vuelve a pedir. */
  let pedido: number | null = null;
  /** `currentTick` en el momento del commit, para ignorar el `notify` síncrono de `jump` (aún no se movió). */
  let tickAlPedir: number | null = null;
  /** Evita que asignar `value`/`min`/`max` (dispara `input` en algunos motores) se tome por un arrastre. */
  let sincronizando = false;
  let reloj: ReturnType<typeof setTimeout> | undefined;
  const query = <T extends Element>(selector: string): T | null => container.querySelector<T>(selector);
  const setText = (selector: string, text: string): void => { const node = query(selector); if (node && node.textContent !== text) node.textContent = text; };
  const setAttr = (node: Element | null, name: string, value: string | null): void => {
    if (!node || node.getAttribute(name) === value) return;
    if (value === null) {
      if (typeof node.removeAttribute === 'function') node.removeAttribute(name);
      return;
    }
    node.setAttribute(name, value);
  };
  const enfocar = (nodo: Element | null): void => { (nodo as HTMLElement | null)?.focus?.({ preventScroll: true }); };
  const popover = (): HTMLElement | null => query(`#${POPOVER_ID}`);
  const popoverAbierto = (): boolean => { const pop = popover(); return !!pop && !pop.hasAttribute('hidden'); };
  const ritmoMenu = (): HTMLElement | null => query(`#${RITMO_ID}`);
  const ritmoAbierto = (): boolean => { const menu = ritmoMenu(); return !!menu && !menu.hasAttribute('hidden'); };
  const botonesDeRitmo = (): HTMLElement[] => [...container.querySelectorAll('[data-dvr-tiempo-real], [data-dvr-paseo], [data-dvr-speed]')] as HTMLElement[];
  const cerrarPopover = (devolverFoco = false): void => {
    const pop = popover(); if (!pop || pop.hasAttribute('hidden')) return;
    pop.setAttribute('hidden', '');
    setAttr(query('[data-dvr-mas]'), 'aria-expanded', 'false');
    if (devolverFoco) enfocar(query('[data-dvr-mas]'));
  };
  const cerrarRitmo = (devolverFoco = false): void => {
    const menu = ritmoMenu(); if (!menu || menu.hasAttribute('hidden')) return;
    menu.setAttribute('hidden', '');
    setAttr(query('[data-dvr-ritmo]'), 'aria-expanded', 'false');
    if (devolverFoco) enfocar(query('[data-dvr-ritmo]'));
  };
  const abrirPopover = (): void => {
    cerrarRitmo();
    const pop = popover(); if (!pop) return;
    pop.removeAttribute('hidden');
    setAttr(query('[data-dvr-mas]'), 'aria-expanded', 'true');
    enfocar(query('[data-dvr-step="-1"]'));
  };
  const abrirRitmo = (): void => {
    cerrarPopover();
    const menu = ritmoMenu(); if (!menu) return;
    menu.removeAttribute('hidden');
    setAttr(query('[data-dvr-ritmo]'), 'aria-expanded', 'true');
    const botones = botonesDeRitmo();
    enfocar(botones.find(b => b.getAttribute('aria-pressed') === 'true') ?? botones[0] ?? null);
  };

  const onClick = (event: Event): void => {
    const target = event.target as Element | null;
    const button = target?.closest?.('button') as HTMLButtonElement | null;
    if (!button || !container.contains(button)) return;
    // Un clic en la etiqueta solo abre o cierra. No elige un modo: eso lo hace un botón del menú, una sola vez.
    if (button.hasAttribute('data-dvr-ritmo')) { if (ritmoAbierto()) cerrarRitmo(true); else abrirRitmo(); return; }
    if (button.hasAttribute('data-dvr-mas')) { if (popoverAbierto()) cerrarPopover(true); else abrirPopover(); return; }
    if (button.hasAttribute('data-tramo-inicio') && last) { inicio = last.currentTick; actualizarTramo(); }
    else if (button.hasAttribute('data-tramo-fin') && last) { fin = last.currentTick; actualizarTramo(); }
    else if (button.hasAttribute('data-tramo-play') && inicio !== null && fin !== null) {
      handlers.reproducirTramo?.(inicio, fin);
      const detalle = button.closest('details');
      if (detalle) { detalle.open = false; detalle.querySelector('summary')?.focus?.({ preventScroll: true }); }
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
    const eligeRitmo = button.hasAttribute('data-dvr-tiempo-real') || button.hasAttribute('data-dvr-paseo') || button.hasAttribute('data-dvr-speed');
    if (eligeRitmo) cerrarRitmo(true); else cerrarRitmo();
    if (!button.closest('.dvr-popover')) cerrarPopover();
  };
  const actualizarTramo = (): void => {
    const play = query<HTMLButtonElement>('[data-tramo-play]');
    if (play) play.disabled = inicio === null || fin === null || fin <= inicio || !last || inicio < last.minTick || fin > last.maxTick;
    setText('[data-tramo-label]', `${inicio === null ? 'Inicio sin marcar' : `Desde ${dvrTimeLabel({ currentTick: inicio })}`} · ${fin === null ? 'final sin marcar' : `Hasta ${dvrTimeLabel({ currentTick: fin })}`}`);
  };
  const limites = (state: DvrBarState): { min: number; max: number } => {
    const min = int(state.minTick); return { min, max: Math.max(min, int(state.maxTick)) };
  };
  const pintarPreview = (tick: number, min: number, max: number, preciso: boolean): void => {
    const time = dvrTimeLabel({ currentTick: 0 }, tick, preciso);
    setText('[data-dvr-time]', time);
    setAttr(query('[data-dvr-time]'), 'title', time);
    const range = query<HTMLInputElement>('[data-dvr-range]');
    if (range) range.setAttribute('aria-valuetext', time);
    const head = query<HTMLElement>('[data-dvr-playhead]');
    if (head) head.style.left = `${dvrPercent(tick, min, max).toFixed(2)}%`;
    if (last) setText('[data-dvr-hover]', dvrHoverLabel(nearestSeriePoint(last.serie, tick), tick));
  };
  /**
   * Escribe min/max/valor sin que el motor recorte el pulgar al subir `min` por encima del valor actual
   * (pasa al pausar, cuando la ventana de la cinta se mueve). No asigna si nada cambió: reescribir
   * `min`/`max` en cada fotograma, sobre todo en móvil, dispara `input` y suelta la pausa.
   */
  const aplicarRango = (range: HTMLInputElement, min: number, max: number, tick: number, hora: string): void => {
    const deseado = String(Math.min(max, Math.max(min, Math.round(tick))));
    sincronizando = true;
    try {
      if (!(Number(range.max) >= min)) range.max = String(Math.max(max, min));
      if (Number(range.value) < min && Number(range.max) >= min) range.value = String(min);
      if (Number(range.max) < max) range.max = String(max);
      if (range.min !== String(min)) range.min = String(min);
      if (range.max !== String(max)) range.max = String(max);
      if (range.value !== deseado) range.value = deseado;
      if (range.getAttribute('aria-valuetext') !== hora) range.setAttribute('aria-valuetext', hora);
    } finally { sincronizando = false; }
  };
  const reflejarRango = (state: DvrBarState): void => {
    const { min, max } = limites(state);
    const tick = Math.min(max, Math.max(min, int(state.currentTick)));
    const hora = horaVisible(state);
    const range = query<HTMLInputElement>('[data-dvr-range]');
    if (range) aplicarRango(range, min, max, tick, hora);
    const head = query<HTMLElement>('[data-dvr-playhead]');
    if (head) head.style.left = `${dvrPercent(tick, min, max).toFixed(2)}%`;
    setText('[data-dvr-time]', hora);
    setAttr(query('[data-dvr-time]'), 'title', hora);
  };
  const soltarSiAterrizo = (state: DvrBarState): void => {
    if (pointerDown || pedido === null) return;
    const ahora = int(state.currentTick);
    const aterrizo = ahora === pedido || (tickAlPedir !== null && ahora !== tickAlPedir);
    if (!aterrizo) return;
    hold = false; pedido = null; holdTick = null; tickAlPedir = null;
    clearTimeout(reloj); reloj = undefined;
  };
  const programarSuelta = (): void => {
    clearTimeout(reloj);
    reloj = setTimeout(() => {
      reloj = undefined;
      // El `change` puede llegar con el dedo aún abajo. Si el plazo vence en medio del gesto,
      // se reprograma: si no, el `pointerup` ve el mismo `pedido` y no vuelve a armar el plazo.
      if (pointerDown) { programarSuelta(); return; }
      hold = false; pedido = null; holdTick = null; tickAlPedir = null;
      if (last) reflejarRango(last);
    }, 800);
  };
  const commit = (tick: number): void => {
    const rounded = Math.round(tick);
    if (!Number.isFinite(rounded)) return;
    if (pedido === rounded) {
      if (!pointerDown && reloj === undefined) programarSuelta();
      return;
    }
    tickAlPedir = last ? int(last.currentTick) : null;
    pedido = rounded; hold = true; holdTick = rounded;
    programarSuelta();
    handlers.seek(rounded);
  };
  const onPointerDown = (event: Event): void => {
    const target = event.target as Element | null;
    if (!target?.hasAttribute?.('data-dvr-range')) return;
    cerrarRitmo();
    cerrarPopover();
    pointerDown = true; hold = true;
  };
  const onInput = (event: Event): void => {
    if (sincronizando) return;
    if (!(event.target as Element | null)?.hasAttribute?.('data-dvr-range')) return;
    hold = true;
    const tick = Number((event.target as HTMLInputElement).value);
    holdTick = tick;
    if (!last) return;
    const { min, max } = limites(last);
    pintarPreview(tick, min, max, relojPreciso(last.modoReloj));
    (event.target as HTMLInputElement).setAttribute('aria-valuetext', dvrTimeLabel(last, tick, relojPreciso(last.modoReloj)));
  };
  const onChange = (event: Event): void => {
    if (sincronizando) return;
    if (!(event.target as Element | null)?.hasAttribute?.('data-dvr-range')) return;
    commit(Number((event.target as HTMLInputElement).value));
  };
  const onPointerUp = (): void => {
    if (!pointerDown) return;
    pointerDown = false;
    const range = query<HTMLInputElement>('[data-dvr-range]');
    if (!range) { hold = false; holdTick = null; return; }
    const tick = Math.round(Number(range.value));
    if (pedido === null && last && int(last.currentTick) === tick) { hold = false; holdTick = null; return; }
    commit(tick);
  };
  const onMove = (event: Event): void => {
    if (!last || pointerDown) return;
    const range = query<HTMLElement>('[data-dvr-range]');
    const rect = range?.getBoundingClientRect?.();
    if (!rect || !(rect.width > 0)) return;
    const x = (event as MouseEvent).clientX;
    if (!Number.isFinite(x)) return;
    const { min, max } = limites(last);
    const tick = tickDesdePuntero(x, rect.left, rect.width, min, max);
    setText('[data-dvr-hover]', dvrHoverLabel(nearestSeriePoint(last.serie, tick), tick));
  };
  const onLeave = (): void => { if (!pointerDown) setText('[data-dvr-hover]', ''); };
  const onKey = (event: KeyboardEvent): void => {
    const ev = event as KeyboardEvent & { _dvrTecla?: boolean };
    if (ev._dvrTecla) return;
    ev._dvrTecla = true;
    if (event.key === 'Escape') {
      if (ritmoAbierto()) { event.preventDefault(); event.stopPropagation(); cerrarRitmo(true); return; }
      if (!popoverAbierto()) return;
      event.preventDefault();
      event.stopPropagation();
      cerrarPopover(true);
      return;
    }
    const mueve = event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End';
    if (!mueve) return;
    if (!ritmoAbierto()) {
      if (event.target === query('[data-dvr-ritmo]') && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        abrirRitmo();
      }
      return;
    }
    const items = botonesDeRitmo();
    if (!items.length) return;
    event.preventDefault();
    const activo = items.indexOf(event.target as HTMLElement);
    const ultimo = items.length - 1;
    const siguiente = event.key === 'Home' ? 0
      : event.key === 'End' ? ultimo
      : event.key === 'ArrowDown' ? (activo + 1 + items.length) % items.length
      : (activo <= 0 ? ultimo : activo - 1);
    enfocar(items[siguiente] ?? null);
  };
  const onDocPointerDown = (event: Event): void => {
    const target = event.target as Node | null;
    if (target && container.contains(target)) return;
    cerrarRitmo();
    cerrarPopover();
  };
  /** Lo que `renderDvrBar` deriva de `playing`, `speed`, el modo y el archivo, sobre los mismos nodos. */
  const ajustarControles = (state: DvrBarState): void => {
    const modo = modoDe(state), ritmo = modo === 'ritmo';
    const speed = VELOCIDADES.includes(state.speed) ? state.speed : 1, playing = !!state.playing;
    const live = sigueBorde(state);
    const etiqueta = etiquetaRitmo(state);
    setAttr(query('.dvr-transport'), 'data-loading', state.loading ? 'true' : null);
    const play = query('[data-dvr-play]');
    setAttr(play, 'aria-pressed', String(playing)); setAttr(play, 'aria-label', playing ? 'Pausar' : 'Reproducir');
    setText('[data-dvr-play]', playing ? '⏸' : '▶');
    setText('[data-dvr-ritmo]', etiqueta);
    setAttr(query('[data-dvr-ritmo]'), 'aria-label', `Ritmo: ${etiqueta}`);
    const pulsar = (nodo: Element | null, activo: boolean): void => {
      setAttr(nodo, 'aria-pressed', String(activo));
      setAttr(nodo, 'aria-checked', String(activo));
    };
    pulsar(query('[data-dvr-tiempo-real]'), modo === 'tiempo-real');
    pulsar(query('[data-dvr-paseo]'), modo === 'paseo');
    for (const b of container.querySelectorAll('[data-dvr-speed]')) pulsar(b, ritmo && Number(b.getAttribute('data-dvr-speed')) === speed);
    const vivo = query('[data-dvr-live]');
    setAttr(vivo, 'aria-pressed', String(live)); vivo?.classList.toggle('is-live', live);
    setText('[data-dvr-live]', state.archivo ? 'Último fotograma' : 'Borde vivo');
    setAttr(vivo, 'title', state.archivo ? 'Último fotograma (0)' : 'Seguir el presente de la cinta (0)');
    setAttr(query('[data-dvr-engine]'), 'hidden', state.archivo ? '' : null);
    setText('[data-dvr-estado]', state.estado === 'error' ? ESTADO_ERROR : '');
  };

  container.addEventListener('click', onClick);
  container.addEventListener('input', onInput);
  container.addEventListener('change', onChange);
  container.addEventListener('pointermove', onMove);
  container.addEventListener('pointerleave', onLeave);
  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('pointerup', onPointerUp);
  container.addEventListener('pointercancel', onPointerUp);
  container.addEventListener('keydown', onKey);
  const documento = container.ownerDocument;
  if (documento && documento !== (container as unknown as Document)) {
    documento.addEventListener('keydown', onKey, true);
    documento.addEventListener('pointerdown', onDocPointerDown, true);
    documento.addEventListener('pointerup', onPointerUp, true);
    documento.addEventListener('pointercancel', onPointerUp, true);
  }

  return {
    seleccionarTramo({ desde, hasta }): void {
      inicio = desde; fin = hasta;
      actualizarTramo();
    },
    update(state: DvrBarState): void {
      last = state;
      // `input` pintó una vista previa y no hubo `change` ni botón pulsado: el reproductor sigue siendo la fuente.
      if (hold && !pointerDown && pedido === null) { hold = false; holdTick = null; }
      const { min, max } = limites(state);
      const lastPoint = state.serie[state.serie.length - 1];
      const nextSerie = `${state.serie.length}|${lastPoint ? int(lastPoint.t) : ''}|${min}|${max}|${state.bifurcaciones.length}|${state.lagunas.length}`;
      // La barra se pinta entera una sola vez: rehacerla al cambiar `loading` o la velocidad cambiaba los
      // botones bajo el puntero y el clic caía en un nodo ya retirado.
      const pintada = !!query('[data-dvr-range]');
      if (!pintada) {
        if (!hold) { serieKey = nextSerie; container.innerHTML = renderDvrBar(state); }
      } else if (nextSerie !== serieKey) {
        serieKey = nextSerie;
        const svg = query('.dvr-sparkline'); if (svg) svg.innerHTML = sparklineMarkup(state.serie, min, max, state.bifurcaciones, state.lagunas);
      }
      soltarSiAterrizo(state);
      const reteniendo = hold && (pointerDown || holdTick !== null || pedido !== null);
      if (!reteniendo) reflejarRango(state);
      else if (holdTick !== null) pintarPreview(holdTick, min, max, relojPreciso(state.modoReloj));
      setText('[data-dvr-desfase]', desfaseLabel(state));
      setText('[data-dvr-escala]', relojLabel(state));
      setText('[data-dvr-engine]', dvrEngineLabel(state));
      if (pintada || query('[data-dvr-play]')) ajustarControles(state);
      if (inicio !== null || fin !== null) actualizarTramo();
    },
    destroy(): void {
      clearTimeout(reloj);
      container.removeEventListener('click', onClick);
      container.removeEventListener('input', onInput);
      container.removeEventListener('change', onChange);
      container.removeEventListener('pointermove', onMove);
      container.removeEventListener('pointerleave', onLeave);
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointerup', onPointerUp);
      container.removeEventListener('pointercancel', onPointerUp);
      container.removeEventListener('keydown', onKey);
      if (documento && documento !== (container as unknown as Document)) {
        documento.removeEventListener('keydown', onKey, true);
        documento.removeEventListener('pointerdown', onDocPointerDown, true);
        documento.removeEventListener('pointerup', onPointerUp, true);
        documento.removeEventListener('pointercancel', onPointerUp, true);
      }
      container.innerHTML = '';
    },
  };
}
