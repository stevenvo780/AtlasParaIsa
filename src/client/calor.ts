/**
 * Una carta para Isa — mapa de calor de recursos (FR-010, US3 escenario 3).
 *
 * Módulo puro: sin DOM global, sin estado. `dibujarCalor` recibe la subselección
 * de teselas visibles que ya calculó el renderizador (mismo criterio que
 * `landscape.ts`) y pinta un rectángulo por tesela con `ctx.fillRect`. El
 * orquestador de T024 cablea la tecla `H`, el `view` real (cámara) y la leyenda.
 */
import type { Tile } from '../shared/types.js';

export const capasDeCalor = ['comida', 'vegetacion', 'agua', 'fertilidad', 'madera'] as const;
export type Capa = typeof capasDeCalor[number];

// Cota máxima de `tile.wood` fijada por el contrato del mundo (validation.ts:
// `number(t.wood, 12)`), no un parámetro simulable: normaliza a 0..1 para la rampa.
const MADERA_MAXIMA = 12;
const COTA: Record<Capa, number> = { comida: 1, vegetacion: 1, agua: 1, fertilidad: 1, madera: MADERA_MAXIMA };

/** Valor crudo de la capa tal cual llega en la tesela (mismas unidades que el servidor). */
export function valorCrudo(tile: Tile, capa: Capa): number {
  switch (capa) {
    case 'comida': return tile.food;
    case 'vegetacion': return tile.vegetation;
    case 'agua': return tile.drinkingWater ?? 0;
    case 'fertilidad': return tile.fertility ?? 0;
    case 'madera': return tile.wood ?? 0;
  }
}

// Rampa perceptual por capa: dos paradas (mínimo, máximo) con cada canal RGB
// no decreciente — garantiza que la luminancia crezca monótonamente con `valor`.
const RAMPA: Record<Capa, readonly [readonly [number, number, number], readonly [number, number, number]]> = {
  comida:     [[36, 28, 20], [214, 168, 46]],
  vegetacion: [[24, 36, 24], [78, 196, 96]],
  agua:       [[18, 30, 46], [60, 150, 224]],
  fertilidad: [[40, 28, 18], [212, 132, 48]],
  madera:     [[30, 22, 16], [168, 118, 62]],
};

const canal = (a: number, b: number, t: number): number => Math.round(a + (b - a) * t);
const hex = (n: number): string => n.toString(16).padStart(2, '0');

/** Rampa perceptual de 5 paradas (0, .25, .5, .75, 1) muestreada de forma continua. */
export function colorCalor(capa: Capa, valor: number): string {
  const t = Math.max(0, Math.min(1, valor)), [desde, hasta] = RAMPA[capa];
  return `#${hex(canal(desde[0], hasta[0], t))}${hex(canal(desde[1], hasta[1], t))}${hex(canal(desde[2], hasta[2], t))}`;
}

function conAlpha(colorHex: string, alpha: number): string {
  const r = parseInt(colorHex.slice(1, 3), 16), g = parseInt(colorHex.slice(3, 5), 16), b = parseInt(colorHex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export interface VistaCalor { x0: number; y0: number; tileSize: number; scale: number; }
/** M10: rango de valores realmente recibido (mínimo y máximo crudos) sobre el que se estira la rampa. */
export interface RangoCalor { min: number; max: number }

/** Posición 0..1 de un valor crudo: sobre el rango recibido si lo hay (y no es plano), si no sobre la cota. */
export function posicionEnRampa(valor: number, capa: Capa, rango?: RangoCalor | null): number {
  if (rango && rango.max - rango.min > 1e-9) return (valor - rango.min) / (rango.max - rango.min);
  return valor / COTA[capa];
}

/** Pinta un rectángulo por tesela recibida (ya filtrada a las visibles por el llamador). */
export function dibujarCalor(ctx: CanvasRenderingContext2D, tiles: readonly Tile[], capa: Capa, view: VistaCalor, alpha = 0.55, rango?: RangoCalor | null): void {
  const lado = Math.max(1, view.tileSize * view.scale);
  for (const tile of tiles) {
    ctx.fillStyle = conAlpha(colorCalor(capa, posicionEnRampa(valorCrudo(tile, capa), capa, rango)), alpha);
    ctx.fillRect(Math.round((tile.x - view.x0) * lado), Math.round((tile.y - view.y0) * lado), Math.ceil(lado), Math.ceil(lado));
  }
}

export const TITULOS: Record<Capa, string> = { comida: 'Comida', vegetacion: 'Vegetación', agua: 'Agua potable', fertilidad: 'Fertilidad', madera: 'Madera' };
const ETIQUETAS = ['nulo', 'escaso', 'moderado', 'abundante', 'máximo'] as const;

export function leyendaCalor(capa: Capa): { titulo: string; paradas: { valor: number; color: string; etiqueta: string }[] } {
  const paradas = ETIQUETAS.map((etiqueta, i) => {
    const valor = i / (ETIQUETAS.length - 1);
    return { valor, color: colorCalor(capa, valor), etiqueta };
  });
  return { titulo: TITULOS[capa], paradas };
}

/** Suma el valor crudo de la capa por región cuadrada de `tamRegion` teselas (clave `"rx:ry"`). */
export function totalesPorRegion(tiles: readonly Tile[], capa: Capa, tamRegion = 16): Map<string, number> {
  const totales = new Map<string, number>();
  for (const tile of tiles) {
    const clave = `${Math.floor(tile.x / tamRegion)}:${Math.floor(tile.y / tamRegion)}`;
    totales.set(clave, (totales.get(clave) ?? 0) + valorCrudo(tile, capa));
  }
  return totales;
}

/** M10: mínimo y máximo crudos de la capa en las teselas recibidas (null si no llegó ninguna). */
export function rangoRecibido(tiles: readonly Tile[], capa: Capa): RangoCalor | null {
  if (!tiles.length) return null;
  let min = Infinity, max = -Infinity;
  for (const tile of tiles) { const v = valorCrudo(tile, capa); if (!Number.isFinite(v)) continue; if (v < min) min = v; if (v > max) max = v; }
  return Number.isFinite(min) ? { min, max } : null;
}

const formato: Record<Capa, (v: number) => string> = {
  comida: v => `${Math.round(v * 100)} %`, vegetacion: v => `${Math.round(v * 100)} %`, fertilidad: v => `${Math.round(v * 100)} %`,
  agua: v => `${v.toLocaleString('es-CO', { maximumFractionDigits: 2 })} u.`, madera: v => `${v.toLocaleString('es-CO', { maximumFractionDigits: 1 })} u.`,
};

/** M10: leyenda con los valores reales de lo que se ve: cinco paradas entre el mínimo y el máximo recibidos,
 * con el mismo color que la rampa estirada. Si todo vale lo mismo, una sola parada. */
export function leyendaEnRango(capa: Capa, rango: RangoCalor | null): { titulo: string; paradas: { color: string; etiqueta: string }[]; nota: string } {
  const titulo = TITULOS[capa];
  if (!rango) return { titulo, paradas: [], nota: 'Sin casillas recibidas en esta vista.' };
  if (rango.max - rango.min <= 1e-9) return { titulo, paradas: [{ color: colorCalor(capa, posicionEnRampa(rango.max, capa)), etiqueta: formato[capa](rango.max) }], nota: 'Todo lo que ves tiene el mismo valor.' };
  const paradas = [0, 0.25, 0.5, 0.75, 1].map(t => { const v = rango.min + (rango.max - rango.min) * t; return { color: colorCalor(capa, t), etiqueta: formato[capa](v) }; });
  return { titulo, paradas, nota: 'La rampa se estira entre el mínimo y el máximo de lo que ves.' };
}
