/**
 * V19 — ciclo de vida visual de los cultivos y labores agrícolas.
 *
 * Presentación pura: todo sale de campos reales de la tesela (`cultivation`, `food`, `growth`/`vegetation`,
 * `moisture`) y de la persona (`action`, `working`, `workProgress`). Nada se inventa ni se simula aquí.
 *
 *  - Etapas (horneadas en el terreno): 0 recién arada · 1 brotando · 2 creciendo · 3 lista para cosechar.
 *  - Labores (dibujadas a 60 fps sobre el terreno): azada + tierra/semillas + arco de progreso; hoz + grano + gavilla.
 */
import type { Tile } from '../shared/types.js';
import { hash3 } from './terrain-field.js';

export type CropStage = 0 | 1 | 2 | 3;
export type CropTile = Pick<Tile, 'cultivation' | 'food' | 'vegetation' | 'moisture'> & { growth?: number };

/** Por debajo de esta labranza la tesela no se considera cultivada. */
export const CROP_MIN_CULTIVATION = .05;
/** Umbrales de `food` entre etapas (con `growth ?? vegetation ≥ .25` una tesela con poco alimento ya brota). */
export const CROP_FOOD = { sprout: .06, leafy: .14, ripe: .26 } as const;
export const CROP_GROWTH_SPROUT = .25;
/** Humedad por encima de la cual la tierra recién arada brilla húmeda. */
export const CROP_MOIST = .45;

/** Etapa del cultivo de una tesela, o `null` si no está labrada. */
export function cropStage(tile: CropTile): CropStage | null {
  if (!((tile.cultivation ?? 0) > CROP_MIN_CULTIVATION)) return null;
  const growth = tile.growth ?? tile.vegetation;
  if (tile.food >= CROP_FOOD.ripe) return 3;
  if (tile.food >= CROP_FOOD.leafy) return 2;
  if (tile.food >= CROP_FOOD.sprout || growth >= CROP_GROWTH_SPROUT) return 1;
  return 0;
}

/** 0 = sin cultivo; si no, etapa + 1 y el brillo húmedo: solo cambia al cruzar un umbral visual (el trozo se rehornea entonces). */
export function cropSignature(tile: CropTile): number {
  const stage = cropStage(tile);
  if (stage === null) return 0;
  return (stage + 1) | (stage === 0 && tile.moisture > CROP_MOIST ? 8 : 0);
}

const C = {
  furrow: '88,58,36', furrowRich: '70,45,28', ridge: '#8a6340', ridgeRich: '#7a5434',
  sprout: '#9be04a', sproutTip: '#c9f27a',
  leaf: '#3f8a4e', leafOlive: '#6f8f3a', leafLight: '#8fb85a',
  stalk: '#b8a04a', head: '#e8b83a', headDeep: '#c98a1e', glint: '#fbe08a',
  sheen: 'rgba(190,215,222,.34)',
  steel: '#aab3b8', steelDark: '#5d6870', wood: '#6b4a30', woodLight: '#96764f', soilFleck: '#3e2a1b', seed: '#e8d27a',
  ink: 'rgba(46,42,34,.28)', ring: 'rgba(217,146,46,.9)',
} as const;

function px(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  if (w <= 0 || h <= 0) return;
  g.fillStyle = color;
  g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

/**
 * Surcos y cultivo de una tesela en el terreno horneado (16×16 px por tesela). `left`/`right`: el vecino también
 * está labrado, así que los surcos continúan sin borde. El número de surcos sigue a la labranza real.
 */
export function paintCropField(g: CanvasRenderingContext2D, tile: CropTile & { x: number; y: number }, stage: CropStage, art: number, left: boolean, right: boolean): void {
  const { x, y } = tile, ox = x * art, oy = y * art, cultivation = Math.max(0, Math.min(1, tile.cultivation ?? 0));
  const xStart = left ? ox : ox + 2, span = (right ? ox + art : ox + art - 2) - xStart;
  const rows = 2 + Math.round(cultivation * 2);
  const alpha = (stage === 0 ? .72 : .55) + cultivation * .25;
  for (let row = 0; row < rows; row++) {
    const fy = oy + 3 + row * 3;
    px(g, xStart, fy, span, 2, `rgba(${stage === 0 ? C.furrowRich : C.furrow},${alpha.toFixed(2)})`);
    px(g, xStart, fy, span, 1, stage === 0 ? C.ridgeRich : C.ridge);
    if (stage === 0) {
      if (tile.moisture > CROP_MOIST) for (let sx = xStart + (hash3(x, y, 640 + row) & 3); sx < xStart + span - 1; sx += 5) px(g, sx, fy, 2, 1, C.sheen);
      continue;
    }
    const step = stage === 1 ? 3 : 2;
    for (let sx = xStart + (hash3(x, y, 660 + row) & 1); sx < xStart + span; sx += step) {
      const roll = hash3(x, y, 700 + row * 8 + (sx - ox));
      if (stage === 1) {
        px(g, sx, fy - 1, 1, 2, C.sprout);
        px(g, sx + ((roll & 1) ? 1 : -1), fy - 1, 1, 1, C.sproutTip);
      } else if (stage === 2) {
        const h = Math.min(fy - oy, 2 + (roll & 1));
        px(g, sx, fy - h + 1, 1, h, (roll & 2) ? C.leaf : C.leafOlive);
        px(g, sx - 1, fy - h + 1 + (roll >> 2 & 1), 1, 1, C.leafLight);
        px(g, sx + 1, fy - h + 2, 1, 1, C.leaf);
      } else {
        const h = Math.min(fy - oy, 3 + (roll & 1));
        px(g, sx, fy - h + 1, 1, h, C.stalk);
        px(g, sx, fy - h, 2, 2, (roll & 2) ? C.head : C.headDeep);
        px(g, sx, fy - h, 1, 1, C.glint);
        if (roll & 4) px(g, sx - 1, fy - h + 2, 1, 1, C.head);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Labores en vivo                                                     */
/* ------------------------------------------------------------------ */

export type CropWorkMode = 'till' | 'harvest' | 'eat';

/**
 * Qué labor muestra una persona. `farm` trabajando en su sitio = labrar (con o sin cultivo todavía);
 * `forage`/`eat` sobre una tesela labrada = cosechar/comer del cultivo. En marcha no hay labor.
 */
export function cropWorkMode(action: string, working: boolean, moving: boolean, ground: CropTile | undefined): CropWorkMode | null {
  if (moving) return null;
  if (action === 'farm') return working ? 'till' : null;
  if ((action === 'forage' || action === 'eat') && ground && cropStage(ground) !== null) return action === 'forage' ? 'harvest' : 'eat';
  return null;
}

export interface CropWorkDraw {
  mode: CropWorkMode;
  /** Pies de la persona en píxeles de arte. */
  ax: number; baseY: number;
  /** Segundos (reloj de pantalla) y semilla del cuerpo: desfasan el gesto entre personas. */
  t: number; seed: number;
  /** Con movimiento reducido o el mundo en pausa, un único fotograma fijo. */
  animate: boolean;
  workProgress?: number;
  /** Dibuja el arco de progreso (solo con zoom suficiente). */
  ring: boolean;
}

const line = (g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color: string): void => {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= n; i++) px(g, x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, 1, 1, color);
};

/** Gavilla de tallos dorados atados: la que se lleva en la mano. */
function sheaf(g: CanvasRenderingContext2D, x: number, y: number): void {
  line(g, x, y, x, y - 4, C.stalk); line(g, x + 1, y, x + 2, y - 4, C.stalk); line(g, x - 1, y, x - 2, y - 3, C.stalk);
  px(g, x, y - 6, 2, 2, C.head); px(g, x + 2, y - 5, 2, 2, C.headDeep); px(g, x - 2, y - 5, 2, 2, C.head); px(g, x, y - 6, 1, 1, C.glint);
  px(g, x - 1, y - 2, 4, 1, C.wood);
}

/** Motas que suben y caen en parábola desde un punto de impacto: `u` en [0, 1). */
function flecks(g: CanvasRenderingContext2D, x: number, y: number, u: number, colors: readonly string[], dir: number): void {
  const rise = Math.round(5 * 4 * u * (1 - u));
  const spread = [-2, 1, 3, -1];
  for (let i = 0; i < colors.length; i++) px(g, x + (spread[i % 4]! + Math.round(u * 2 * (i % 2 ? 1 : -1))) * dir, y - rise - (i & 1), 1, 1, colors[i]!);
}

function progressRing(g: CanvasRenderingContext2D, ax: number, baseY: number, progress: number): void {
  const total = 24, filled = Math.round(Math.max(0, Math.min(1, progress)) * total);
  for (let i = 0; i < total; i++) {
    const a = -Math.PI / 2 + i / total * Math.PI * 2;
    px(g, ax + Math.cos(a) * 8, baseY + 2 + Math.sin(a) * 3, 1, 1, i < filled ? C.ring : C.ink);
  }
}

/** Dibuja la labor sobre el terreno y sobre la persona (después de ella). Sin estado propio: solo `t` y los datos recibidos. */
export function drawCropWork(g: CanvasRenderingContext2D, w: CropWorkDraw): void {
  const { ax, baseY } = w, phase = w.animate ? ((w.t * 2.2 + (w.seed % 97) * .37) % 1 + 1) % 1 : .64, f = Math.floor(phase * 4);
  if (w.mode === 'till') {
    // Azada: levantada → en bajada → golpe → recoge; tierra y semillas saltan al golpear.
    const heads = [[7, -14], [9, -10], [10, -3], [9, -7]] as const, [hx, hy] = heads[f]!;
    line(g, ax + 4, baseY - 7, ax + hx, baseY + hy, C.wood);
    if (f === 0 || f === 2) px(g, ax + hx - 1, baseY + hy, 3, 1, C.steel); else px(g, ax + hx, baseY + hy - 1, 1, 3, C.steel);
    px(g, ax + hx, baseY + hy + (f === 2 ? 1 : 0), 1, 1, C.steelDark);
    if (w.animate && phase >= .5) flecks(g, ax + 10, baseY - 2, (phase - .5) * 2, [C.soilFleck, C.seed, C.soilFleck, C.soilFleck], 1);
    else if (!w.animate) { px(g, ax + 9, baseY - 4, 1, 1, C.soilFleck); px(g, ax + 12, baseY - 3, 1, 1, C.seed); }
    if (w.ring && w.workProgress !== undefined && w.workProgress > 0) progressRing(g, ax, baseY, w.workProgress);
    return;
  }
  if (w.mode === 'harvest') {
    // Hoz: curva baja que barre las espigas; grano dorado sale despedido; gavilla al costado.
    const sweep = [[5, -6], [7, -4], [9, -2], [7, -4]] as const, [sx, sy] = sweep[f]!;
    line(g, ax + 4, baseY - 6, ax + sx, baseY + sy, C.wood);
    for (const [dx, dy] of [[0, 0], [1, -1], [2, -1], [3, 0]] as const) px(g, ax + sx + dx, baseY + sy + dy, 1, 1, dx === 3 ? C.steelDark : C.steel);
    if (w.animate && f >= 1) flecks(g, ax + 9, baseY - 2, (phase * 4 - 1) / 3, [C.head, C.glint, C.stalk, C.head], 1);
    else if (!w.animate) { px(g, ax + 9, baseY - 4, 1, 1, C.head); px(g, ax + 11, baseY - 3, 1, 1, C.glint); }
    sheaf(g, ax - 6, baseY - 2);
    return;
  }
  // Comer del cultivo: gavilla en la mano, migas que caen y la hoz apoyada.
  sheaf(g, ax + 5, baseY - 2);
  line(g, ax + 8, baseY, ax + 10, baseY, C.wood); px(g, ax + 10, baseY - 1, 2, 1, C.steel);
  if (w.animate) { const u = (phase * 2) % 1; px(g, ax + 3, baseY - 10 + Math.round(u * 6), 1, 1, C.head); px(g, ax + 4, baseY - 9 + Math.round(((u + .5) % 1) * 6), 1, 1, C.glint); }
}
