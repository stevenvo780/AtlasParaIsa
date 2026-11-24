/**
 * V20 — caminos y geología latente sobre el suelo horneado.
 *
 * Módulo de presentación pura: solo `fillStyle` + `fillRect` sobre un contexto 2D, sin DOM ni estado. Se pinta una sola
 * vez dentro del trozo de terreno en caché (`landscape.ts`), así que no cuesta nada por fotograma.
 *
 *  - `paintRoadTile`: senda de tierra pisada (tráfico) y calzada empedrada (`paved`), autoconectadas con los vecinos N/E/S/O.
 *  - `paintGeologyVeins`: vetas de hierro, cal y sal deducidas de `geologyAt(seed, …)` (la misma función que usa el servidor).
 */
import { geologyAt } from '../shared/chemistry.js';
import type { Tile } from '../shared/types.js';
import { hash3 } from './terrain-field.js';

const ART = 16;

/** Umbrales del contrato V20: por encima de ellos la casilla ya es camino. */
export const DIRT_TRAFFIC = 0.25;
export const PAVED_LEVEL = 0.5;
export const IRON_VEIN = 0.24;
export const LIME_VEIN = 0.28;
export const SALT_VEIN = 0.22;

export type RoadKind = 'dirt' | 'paved';
export type VeinKind = 'Fe' | 'Ca' | 'S';
export type RoadTileLike = Pick<Tile, 'terrain'> & { traffic?: number; paved?: number };
export interface RoadNeighbors { n?: RoadTileLike | null; e?: RoadTileLike | null; s?: RoadTileLike | null; w?: RoadTileLike | null }

const finite = (v: number | undefined): number => typeof v === 'number' && Number.isFinite(v) ? v : 0;

/** `null` si la casilla no es camino; el empedrado manda sobre la senda. El agua nunca es camino. */
export function roadKind(tile: RoadTileLike | null | undefined): RoadKind | null {
  if (!tile || tile.terrain === 'water') return null;
  if (finite(tile.paved) >= PAVED_LEVEL) return 'paved';
  return finite(tile.traffic) >= DIRT_TRAFFIC ? 'dirt' : null;
}

export interface RoadLinks { n: boolean; e: boolean; s: boolean; w: boolean }
/** Qué lados continúan en camino (senda o calzada): la autoconexión de 4 vecinos. */
export function roadLinks(neighbors: RoadNeighbors): RoadLinks {
  return { n: roadKind(neighbors.n) !== null, e: roadKind(neighbors.e) !== null, s: roadKind(neighbors.s) !== null, w: roadKind(neighbors.w) !== null };
}

function px(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  if (w <= 0 || h <= 0) return;
  g.fillStyle = color;
  g.fillRect(x, y, w, h);
}

const D = {
  earth: '#b39467', earthEdge: '#8d7149', earthLight: '#c9ae82', rut: '#7a6240', pebble: '#dccaa0', pebbleDark: '#6f5a3b',
} as const;
const S = {
  curb: '#6f6a5c', curbLight: '#948d7b', flag: '#b9b2a0', flagAlt: '#a89f8b', flagLight: '#cfc8b5', mortar: '#625c4e', moss: '#7d8a5a',
} as const;

/** Cada lado conectado prolonga la banda de 6 px (tierra) o de 10 px (piedra) hasta el borde de la casilla. */
function inEarth(bx: number, by: number, wx: number, wy: number, l: RoadLinks): boolean {
  const cx = bx - 7.5, cy = by - 7.5;
  if (cx * cx + cy * cy <= 4.7 * 4.7) return true;
  // Anchura orgánica: la deriva depende de la coordenada de mundo para que dos casillas contiguas coincidan en el borde.
  if ((l.n && by <= 7) || (l.s && by >= 8)) { if (Math.abs(cx) <= 2.5 + (hash3(0, wy, 71) % 3) * .5) return true; }
  if ((l.w && bx <= 7) || (l.e && bx >= 8)) { if (Math.abs(cy) <= 2.5 + (hash3(wx, 0, 72) % 3) * .5) return true; }
  return false;
}
function inStone(bx: number, by: number, l: RoadLinks): boolean {
  if (bx >= 3 && bx <= 12 && by >= 3 && by <= 12) return true;
  if (bx >= 3 && bx <= 12 && ((l.n && by < 3) || (l.s && by > 12))) return true;
  if (by >= 3 && by <= 12 && ((l.w && bx < 3) || (l.e && bx > 12))) return true;
  return false;
}

/**
 * Pinta una casilla de camino en coordenadas de mundo (`tile.x * 16`). Devuelve el tipo pintado o `null` si la casilla no es camino.
 * Senda de tierra: cinta de tierra apisonada con roderas y guijarros. Calzada: adoquines alternos con juntas oscuras y bordillo.
 */
export function paintRoadTile(g: CanvasRenderingContext2D, tile: Tile, neighbors: RoadNeighbors): RoadKind | null {
  const kind = roadKind(tile);
  if (!kind) return null;
  const links = roadLinks(neighbors), ox = tile.x * ART, oy = tile.y * ART;
  if (kind === 'paved') { paintCobble(g, tile, ox, oy, links); return kind; }
  paintEarth(g, tile, ox, oy, links);
  return kind;
}

function paintEarth(g: CanvasRenderingContext2D, tile: Tile, ox: number, oy: number, l: RoadLinks): void {
  // Cuanto más pisada, más opaca y más clara (apisonada) queda la cinta.
  const wear = Math.max(0, Math.min(1, (finite(tile.traffic) - DIRT_TRAFFIC) / (1 - DIRT_TRAFFIC)));
  const alpha = (.62 + wear * .3).toFixed(2);
  const fill = (hex: string, a = alpha) => `${hexToRgba(hex, a)}`;
  const inside = (bx: number, by: number): boolean => inEarth(bx, by, ox + bx, oy + by, l);
  for (let by = 0; by < ART; by++) {
    let runStart = -1, runEdge = false;
    const flush = (end: number) => { if (runStart >= 0) px(g, ox + runStart, oy + by, end - runStart, 1, runEdge ? fill(D.earthEdge) : fill(wear > .55 ? D.earthLight : D.earth)); runStart = -1; };
    for (let bx = 0; bx < ART; bx++) {
      if (!inside(bx, by)) { flush(bx); continue; }
      const edge = !inside(bx - 1, by) && bx > 0 || !inside(bx + 1, by) && bx < ART - 1 || !inside(bx, by - 1) && by > 0 || !inside(bx, by + 1) && by < ART - 1;
      if (runStart >= 0 && edge !== runEdge) flush(bx);
      if (runStart < 0) { runStart = bx; runEdge = edge; }
    }
    flush(ART);
  }
  // Roderas: dos surcos paralelos por cada eje que atraviesa la casilla; faltan trozos al azar para que no parezcan una regla.
  const vertical = l.n || l.s, horizontal = l.w || l.e;
  for (let i = 0; i < ART; i++) {
    const wx = ox + i, wy = oy + i;
    if (vertical && !(l.n === false && i < 5) && !(l.s === false && i > 10) && hash3(wx, oy, 73) % 5 !== 0) { px(g, ox + 6, wy, 1, 1, hexToRgba(D.rut, '.7')); px(g, ox + 9, wy, 1, 1, hexToRgba(D.rut, '.7')); }
    if (horizontal && !(l.w === false && i < 5) && !(l.e === false && i > 10) && hash3(ox, wy, 74) % 5 !== 0) { px(g, wx, oy + 6, 1, 1, hexToRgba(D.rut, '.7')); px(g, wx, oy + 9, 1, 1, hexToRgba(D.rut, '.7')); }
  }
  // Guijarros: puntos claros y su sombra, fijos por casilla.
  for (let i = 0; i < 4; i++) {
    const bx = 4 + hash3(tile.x, tile.y, 75 + i) % 8, by = 4 + hash3(tile.x, tile.y, 85 + i) % 8;
    if (!inside(bx, by) || !inside(bx + 1, by)) continue;
    px(g, ox + bx, oy + by, 1, 1, D.pebble); px(g, ox + bx + 1, oy + by, 1, 1, hexToRgba(D.pebbleDark, '.6'));
  }
}

function paintCobble(g: CanvasRenderingContext2D, tile: Tile, ox: number, oy: number, l: RoadLinks): void {
  const inside = (bx: number, by: number): boolean => inStone(bx, by, l);
  for (let by = 0; by < ART; by++) for (let bx = 0; bx < ART; bx++) {
    if (!inside(bx, by)) continue;
    const wx = ox + bx, wy = oy + by;
    // Bordillo: cualquier píxel de piedra con un vecino fuera de la calzada; en el borde de la casilla la calzada sigue.
    const curb = (bx > 0 && !inside(bx - 1, by)) || (bx < ART - 1 && !inside(bx + 1, by)) || (by > 0 && !inside(bx, by - 1)) || (by < ART - 1 && !inside(bx, by + 1));
    if (curb) { px(g, wx, wy, 1, 1, (bx + by) % 2 ? S.curb : S.curbLight); continue; }
    // Adoquines en hiladas de 4 px con juntas desplazadas; el patrón se ancla al mundo para casar entre casillas.
    const course = Math.floor(wy / 4), mortarRow = wy % 4 === 0, mortarCol = (wx + (course % 2) * 3) % 6 === 0;
    if (mortarRow || mortarCol) { px(g, wx, wy, 1, 1, S.mortar); continue; }
    const block = hash3(Math.floor((wx + (course % 2) * 3) / 6), course, 76);
    px(g, wx, wy, 1, 1, block % 3 === 0 ? S.flagAlt : block % 7 === 0 ? S.flagLight : S.flag);
  }
  // Un adoquín cubierto de musgo por casilla, determinista.
  if (hash3(tile.x, tile.y, 77) % 4 === 0) px(g, ox + 5 + hash3(tile.x, tile.y, 78) % 6, oy + 5 + hash3(tile.x, tile.y, 79) % 6, 1, 1, S.moss);
}

/** `#rrggbb` + alfa → `rgba(...)`; cualquier otra cosa se devuelve tal cual. */
export function hexToRgba(hex: string, alpha: number | string): string {
  const m = /^#([\da-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${alpha})`;
}

const VEIN = {
  Fe: { dark: '#9c4e2e', light: '#d68c45' },
  Ca: { dark: '#cbc2ae', light: '#e4dfd0' },
  S: { dark: '#e8e6b8', light: '#fff8dc' },
} as const;

/** Qué vetas aflora `geologyAt` en la casilla (vacío en agua, refugio o sin semilla). Pura: sirve a la ficha y a las pruebas. */
export function veinsAt(tile: Tile, seed: number | undefined): { kind: VeinKind; amount: number }[] {
  if (seed === undefined || !Number.isFinite(seed) || tile.terrain === 'water' || tile.terrain === 'shelter') return [];
  const geo = geologyAt(seed, tile.x, tile.y, tile.biome, tile.feature), out: { kind: VeinKind; amount: number }[] = [];
  if (geo.Fe >= IRON_VEIN) out.push({ kind: 'Fe', amount: geo.Fe });
  if (geo.Ca >= LIME_VEIN) out.push({ kind: 'Ca', amount: geo.Ca });
  if (geo.S >= SALT_VEIN) out.push({ kind: 'S', amount: geo.S });
  return out;
}

/** Vetas de hierro (óxido/ocre), cal (tiza) y sal (cristales ámbar pálido): motas deterministas, más cuanto más rica es la veta. */
export function paintGeologyVeins(g: CanvasRenderingContext2D, tile: Tile, seed: number | undefined): VeinKind[] {
  const veins = veinsAt(tile, seed), ox = tile.x * ART, oy = tile.y * ART, painted: VeinKind[] = [];
  const salt = { Fe: 110, Ca: 130, S: 150 } as const, threshold = { Fe: IRON_VEIN, Ca: LIME_VEIN, S: SALT_VEIN } as const;
  for (const { kind, amount } of veins) {
    const n = Math.max(2, Math.min(9, 2 + Math.round((amount - threshold[kind]) * 16)));
    const palette = VEIN[kind];
    for (let i = 0; i < n; i++) {
      const bx = 1 + hash3(tile.x, tile.y, salt[kind] + i) % 14, by = 1 + hash3(tile.x, tile.y, salt[kind] + 20 + i) % 14;
      if (kind === 'Fe') {
        // Vetilla diagonal de óxido con una mota ocre brillante.
        px(g, ox + bx, oy + by, 2, 1, hexToRgba(palette.dark, '.72')); px(g, ox + bx + 1, oy + by + 1, 1, 1, hexToRgba(palette.dark, '.55'));
        if (i % 3 === 0) px(g, ox + bx, oy + by - 1, 1, 1, palette.light);
      } else if (kind === 'Ca') {
        // Vetas de tiza: trazo horizontal pálido con su sombra.
        px(g, ox + bx, oy + by, 3, 1, hexToRgba(palette.light, '.7')); px(g, ox + bx + 1, oy + by + 1, 2, 1, hexToRgba(palette.dark, '.5'));
      } else {
        // Cristal de sal: destello en cruz diminuta.
        px(g, ox + bx, oy + by, 1, 1, palette.light); px(g, ox + bx - 1, oy + by, 1, 1, hexToRgba(palette.dark, '.65'));
        px(g, ox + bx + 1, oy + by, 1, 1, hexToRgba(palette.dark, '.65')); if (i % 2 === 0) { px(g, ox + bx, oy + by - 1, 1, 1, hexToRgba(palette.dark, '.65')); }
      }
    }
    painted.push(kind);
  }
  return painted;
}
