/**
 * Una carta para Isa — mapa de calor de recursos (FR-010, US3 escenario 3).
 *
 * Módulo puro: sin DOM global, sin estado. `dibujarCalor` recibe la subselección
 * de teselas visibles que ya calculó el renderizador (mismo criterio que
 * `landscape.ts`) y pinta un rectángulo por tesela con `ctx.fillRect`. La escena
 * lo pinta con `pintarCalor` (landscape.ts) y game.ts pone el selector de capa y la leyenda.
 */
import type { Tile } from '../shared/types.js';

export const capasDeCalor = ['comida', 'vegetacion', 'agua', 'fertilidad', 'madera'] as const;
export type Capa = typeof capasDeCalor[number];

// Cota máxima de `tile.wood` fijada por el contrato del mundo (validation.ts:
// `number(t.wood, 12)`), no un parámetro simulable: normaliza a 0..1 para la rampa.
const MADERA_MAXIMA = 12;
const COTA: Record<Capa, number> = { comida: 1, vegetacion: 1, agua: 1, fertilidad: 1, madera: MADERA_MAXIMA };

/** Valor crudo de la capa tal cual llega en la tesela (mismas unidades que el servidor). */
function valorCrudo(tile: Tile, capa: Capa): number {
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

/** Interpolación continua entre las dos paradas de `RAMPA`; la leyenda la muestrea en 5 valores. */
export function colorCalor(capa: Capa, valor: number): string {
  const t = Math.max(0, Math.min(1, valor)), [desde, hasta] = RAMPA[capa];
  return `#${hex(canal(desde[0], hasta[0], t))}${hex(canal(desde[1], hasta[1], t))}${hex(canal(desde[2], hasta[2], t))}`;
}

function conAlpha(colorHex: string, alpha: number): string {
  const r = parseInt(colorHex.slice(1, 3), 16), g = parseInt(colorHex.slice(3, 5), 16), b = parseInt(colorHex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export interface VistaCalor { x0: number; y0: number; tileSize: number; scale: number; }

/** Pinta un rectángulo por tesela recibida (ya filtrada a las visibles por el llamador). */
export function dibujarCalor(ctx: CanvasRenderingContext2D, tiles: readonly Tile[], capa: Capa, view: VistaCalor, alpha = 0.55): void {
  const lado = Math.max(1, view.tileSize * view.scale);
  for (const tile of tiles) {
    ctx.fillStyle = conAlpha(colorCalor(capa, valorCrudo(tile, capa) / COTA[capa]), alpha);
    ctx.fillRect(Math.round((tile.x - view.x0) * lado), Math.round((tile.y - view.y0) * lado), Math.ceil(lado), Math.ceil(lado));
  }
}

const TITULOS: Record<Capa, string> = { comida: 'Comida', vegetacion: 'Vegetación', agua: 'Agua', fertilidad: 'Fertilidad', madera: 'Madera' };
const ETIQUETAS = ['nulo', 'escaso', 'moderado', 'abundante', 'máximo'] as const;

export function leyendaCalor(capa: Capa): { titulo: string; paradas: { valor: number; color: string; etiqueta: string }[] } {
  const paradas = ETIQUETAS.map((etiqueta, i) => {
    const valor = i / (ETIQUETAS.length - 1);
    return { valor, color: colorCalor(capa, valor), etiqueta };
  });
  return { titulo: TITULOS[capa], paradas };
}
