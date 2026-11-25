/**
 * V19 — arquitectura modular visual: obras en construcción, salones de varias casillas, bodega de materiales y
 * piezas técnicas instaladas.
 *
 * Presentación pura sobre campos opcionales de `StructureView` que el servidor v19 añade (`footprint`, `site`,
 * `installed`, `storedWood`, `storedStone`). Se leen con un tipo estructural LOCAL: este módulo no depende de que
 * `shared/life.ts` ya los declare y, si lo hace con la misma forma, sigue compilando sin cambios.
 */
import type { Tile } from '../shared/types.js';
import type { StructureView } from '../shared/life.js';
import { brilloTermico, colorCuerpoNegro, colorTermico, hash3, type Rgb } from './terrain-field.js';
import { formaDeCodigo } from '../shared/materia.js';
import type { LoteVisible } from '../shared/vistas-v23.js';

export interface FootprintCell { x: number; y: number }
export interface FootprintSize { width: number; height: number }
export interface ConstructionSite { requiredWood: number; requiredStone: number; depositedWood: number; depositedStone: number; requiredWork: number; completedWork: number }
export interface InstalledPart { id: string; recipeId: string | null; mass: number; containment: number; insulation: number; cohesion: number; binding: number; condition: number }
export type ExtendedStructure = Omit<StructureView, 'footprint'> & {
  footprint?: FootprintSize | readonly FootprintCell[]; site?: ConstructionSite; installed?: readonly InstalledPart[]; storedWood?: number; storedStone?: number;
};

const ART = 16;
const clamp01 = (v: number): number => Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
const ratio = (done: number, required: number): number => required > 0 ? clamp01(done / required) : 1;

/** V20: la planta real es `cells` (poliominó contiguo); sin ella manda `footprint`, y sin ninguno, la casilla ancla. */
function polyominoCells(s: ExtendedStructure): FootprintCell[] | null {
  const raw = s.cells;
  if (!raw?.length) return null;
  const seen = new Set<string>(), out: FootprintCell[] = [];
  for (const c of raw) {
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
    const x = Math.floor(c.x), y = Math.floor(c.y), key = `${x},${y}`;
    if (!seen.has(key)) { seen.add(key); out.push({ x, y }); }
  }
  return out.length ? out : null;
}
/** ¿Trae la estructura una planta V20 (`cells`)? */
export const isPolyomino = (s: ExtendedStructure): boolean => polyominoCells(s) !== null;

/** Caja de teselas que ocupa la estructura (1×1 si el servidor no manda planta). */
export function footprintBox(s: ExtendedStructure): { x0: number; y0: number; w: number; h: number } {
  const poly = polyominoCells(s);
  const fp = poly ?? s.footprint;
  if (fp && 'width' in fp) {
    const w = Number.isFinite(fp.width) && fp.width >= 1 ? Math.floor(fp.width) : 1;
    const h = Number.isFinite(fp.height) && fp.height >= 1 ? Math.floor(fp.height) : 1;
    return { x0: s.x, y0: s.y, w, h };
  }
  const cells = fp ? fp.filter(c => Number.isFinite(c.x) && Number.isFinite(c.y)) : undefined;
  if (!cells?.length) return { x0: s.x, y0: s.y, w: 1, h: 1 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of cells) { x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x); y1 = Math.max(y1, c.y); }
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Casillas que ocupa, para que nada más (p. ej. una choza de terreno) se dibuje debajo. */
export function footprintCells(s: ExtendedStructure): readonly FootprintCell[] {
  const poly = polyominoCells(s);
  if (poly) return poly;
  const fp = s.footprint;
  if (fp && !('width' in fp)) return fp.length ? fp : [{ x: s.x, y: s.y }];
  const box = footprintBox(s), out: FootprintCell[] = [];
  for (let dy = 0; dy < box.h; dy++) for (let dx = 0; dx < box.w; dx++) out.push({ x: box.x0 + dx, y: box.y0 + dy });
  return out;
}

/** Formas canónicas (todas las rotaciones y reflejos se reconocen): la letra con la que se nombra el poliominó. */
const SHAPES: ReadonlyArray<readonly [string, number, ReadonlyArray<readonly [number, number]>]> = [
  ['L', 3, [[0, 0], [0, 1], [1, 1]]],
  ['T', 4, [[0, 0], [1, 0], [2, 0], [1, 1]]], ['L', 4, [[0, 0], [0, 1], [0, 2], [1, 2]]], ['S', 4, [[1, 0], [2, 0], [0, 1], [1, 1]]],
  ['U', 5, [[0, 0], [2, 0], [0, 1], [1, 1], [2, 1]]], ['L', 5, [[0, 0], [0, 1], [0, 2], [0, 3], [1, 3]]], ['T', 5, [[0, 0], [1, 0], [2, 0], [1, 1], [1, 2]]],
  ['P', 5, [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2]]], ['+', 5, [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]]], ['Z', 5, [[0, 0], [1, 0], [1, 1], [1, 2], [2, 2]]],
  ['N', 5, [[1, 0], [1, 1], [0, 2], [1, 2], [0, 3]]], ['W', 5, [[0, 0], [0, 1], [1, 1], [1, 2], [2, 2]]], ['F', 5, [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]]],
  ['Y', 5, [[1, 0], [0, 1], [1, 1], [1, 2], [1, 3]]], ['V', 5, [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]]],
];
function canonicalKey(points: ReadonlyArray<readonly [number, number]>): string {
  const minX = Math.min(...points.map(p => p[0])), minY = Math.min(...points.map(p => p[1]));
  return points.map(p => `${p[0] - minX},${p[1] - minY}`).sort().join(';');
}
const SHAPE_INDEX: Map<string, string> = (() => {
  const index = new Map<string, string>();
  for (const [letter, , points] of SHAPES) {
    let current = points.map(p => [p[0], p[1]] as [number, number]);
    for (let flip = 0; flip < 2; flip++) {
      for (let turn = 0; turn < 4; turn++) {
        const key = `${points.length}|${canonicalKey(current)}`;
        if (!index.has(key)) index.set(key, letter);
        current = current.map(([x, y]) => [-y, x] as [number, number]);
      }
      current = current.map(([x, y]) => [-x, y] as [number, number]);
    }
  }
  return index;
})();

/** Letra de la planta («L», «T», «U»…); «» si es un rectángulo y `null` si no se reconoce. */
export function polyominoShape(cells: readonly FootprintCell[]): string | null {
  if (cells.length < 2) return '';
  const xs = cells.map(c => c.x), ys = cells.map(c => c.y);
  const w = Math.max(...xs) - Math.min(...xs) + 1, h = Math.max(...ys) - Math.min(...ys) + 1;
  if (w * h === cells.length) return '';
  return SHAPE_INDEX.get(`${cells.length}|${canonicalKey(cells.map(c => [c.x, c.y] as const))}`) ?? null;
}

/** «2×1», «3×2»… para rectángulos; «L · 3c», «T · 4c», «U · 5c» para poliominós; vacío sin planta. */
export function footprintLabel(s: ExtendedStructure): string {
  const poly = polyominoCells(s);
  if (poly) {
    const box = footprintBox(s), shape = polyominoShape(poly);
    if (shape === '') return `${box.w}×${box.h}`;
    return `${shape ?? 'Irregular'} · ${poly.length}c`;
  }
  const fp = s.footprint;
  if (!fp || (!('width' in fp) && !fp.length)) return '';
  const box = footprintBox(s);
  return `${box.w}×${box.h}`;
}

export type StructureTier = 'hut' | 'hall' | 'grand';
/** Salón mediano (2×1 o 3–4 marcos) y recinto grande (2×2 o ≥ 5 marcos); la planta real manda sobre los marcos. */
export function structureTier(s: ExtendedStructure): StructureTier {
  const area = isPolyomino(s) ? footprintCells(s).length : footprintBox(s).w * footprintBox(s).h;
  if (area >= 4) return 'grand';
  if (area >= 2) return 'hall';
  const frames = s.components.filter(c => c === 'frame').length;
  return frames >= 5 ? 'grand' : frames >= 3 ? 'hall' : 'hut';
}

/** ¿Se dibuja como un solo edificio unificado de varias casillas (en vez del sprite de 1×1)? */
export const isModular = (s: ExtendedStructure): boolean => !s.site && (isPolyomino(s) ? footprintCells(s).length > 1 : footprintBox(s).w * footprintBox(s).h > 1);

export interface SiteFractions { wood: number; stone: number; work: number }
export function siteFractions(site: ConstructionSite): SiteFractions {
  return { wood: ratio(site.depositedWood, site.requiredWood), stone: ratio(site.depositedStone, site.requiredStone), work: ratio(site.completedWork, site.requiredWork) };
}

/** 0 = vacío; luego 1–6 de forma logarítmica (un montón enorme no se sale del dibujo). */
export function stockLevel(value: number | undefined): number {
  return value !== undefined && value > 0 ? Math.max(1, Math.min(6, Math.round(Math.log2(1 + value)))) : 0;
}

export const installedCount = (s: ExtendedStructure): number => s.installed?.length ?? 0;

/** Rectángulo (en píxeles de arte) que ocupa el dibujo de la estructura: para ordenar por profundidad y recortar. */
export function structureExtent(s: ExtendedStructure): { left: number; right: number; top: number; bottom: number; foot: number } {
  const box = footprintBox(s), tier = structureTier(s);
  const foot = (box.y0 + box.h - 1) * ART + 13;
  // Planta V20: placa de tejado de 16 filas por casilla de alto, muro y cimiento, más chimenea y humo.
  const height = s.site ? 24 : isModular(s) && isPolyomino(s) ? 37 + (box.h - 1) * 16 : tier === 'grand' ? 36 : tier === 'hall' ? 28 : 29;
  return { left: box.x0 * ART - 2, right: (box.x0 + box.w) * ART + 2, top: foot - height, bottom: foot + 3, foot };
}

/* ------------------------------------------------------------------ */
/* Pintura                                                             */
/* ------------------------------------------------------------------ */

const K = {
  wall: '#c4a87c', wallShade: '#a0855e', wallLight: '#d8c093', timber: '#5a4330', timberLight: '#7a5d41',
  roof: '#b38d54', roofLight: '#d3ad6e', roofDark: '#8b6a3c', thatchWeathered: '#7c6a4a',
  stone: '#c4bdaa', stoneShade: '#9e9684', stoneDark: '#7c7566', door: '#3c2d22', glow: '#eeba6c',
  soil: '#c4a378', shadow: 'rgba(20,34,26,.28)',
  steel: '#aeb8bf', steelDark: '#59656d', steelLight: '#e4eef2', water: '#2f7f86', waterGleam: '#8cd0c4', food: '#d9922e',
  bar: '#2e2a22', barFill: '#d9922e', smoke: 'rgba(232,228,218,.55)',
} as const;

function px(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  if (w <= 0 || h <= 0) return;
  g.fillStyle = color;
  g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

/** Leños apilados (leña partida): `level` 1–6, en filas de 3 (o 2 si es compacto). Devuelve el ancho usado. */
export function paintCordwood(g: CanvasRenderingContext2D, x: number, groundY: number, level: number, compact: boolean): number {
  const perRow = compact ? 2 : 3, len = compact ? 4 : 5;
  let placed = 0;
  for (let row = 0; placed < level; row++) {
    const inRow = Math.min(perRow - (row > 0 ? 1 : 0), level - placed), inset = row > 0 ? len / 2 : 0, y = groundY - 2 - row * 2;
    for (let i = 0; i < inRow; i++, placed++) {
      const lx = x + inset + i * len;
      px(g, lx, y, len - 1, 2, K.timberLight); px(g, lx, y, len - 1, 1, K.wallLight); px(g, lx + len - 2, y, 1, 2, K.timber);
    }
  }
  return perRow * len;
}

/** Bloques de piedra tallada sobre una paleta de madera. */
export function paintStonePallet(g: CanvasRenderingContext2D, x: number, groundY: number, level: number, compact: boolean): number {
  const perRow = compact ? 2 : 3, bw = compact ? 4 : 5;
  px(g, x - 1, groundY - 1, perRow * bw + 1, 1, K.timber);
  let placed = 0;
  for (let row = 0; placed < level; row++) {
    const inRow = Math.min(perRow, level - placed);
    for (let i = 0; i < inRow; i++, placed++) {
      const bx = x + i * bw, by = groundY - 4 - row * 3;
      px(g, bx, by, bw - 1, 3, K.stone); px(g, bx, by, bw - 1, 1, '#e6e0cf'); px(g, bx + bw - 2, by + 1, 1, 2, K.stoneShade);
    }
  }
  return perRow * bw;
}

/** Herrajes artesanales de las piezas instaladas, proporcionales a cuántas hay. */
function paintInstalled(g: CanvasRenderingContext2D, s: ExtendedStructure, left: number, right: number, wallTop: number, ground: number, basin: { x: number; y: number; w: number } | null): void {
  const n = Math.min(installedCount(s), 6);
  if (n === 0) return;
  if (basin) { px(g, basin.x - 1, basin.y, basin.w + 2, 1, K.steelLight); px(g, basin.x - 1, basin.y + 1, 1, 2, K.steel); px(g, basin.x + basin.w, basin.y + 1, 1, 2, K.steel); }
  else px(g, left + 2, wallTop - 1, right - left - 4, 1, K.steelLight); // remate aislante del hastial
  if (n >= 2) for (const cx of [left, right - 2]) { px(g, cx, wallTop, 2, 4, K.steel); px(g, cx, ground - 5, 2, 4, K.steel); px(g, cx, wallTop, 1, 1, K.steelLight); }
  if (n >= 4) { const mid = Math.round((left + right) / 2); px(g, mid - 4, wallTop + 2, 8, 1, K.steelDark); px(g, mid - 4, wallTop + 2, 1, 1, K.steelLight); px(g, mid + 3, wallTop + 2, 1, 1, K.steelLight); }
  if (n >= 6) px(g, left + 3, wallTop + 4, 1, 1, K.steelLight);
}

/** Obra sin terminar: postes, riostras, leña y piedra proporcionales a lo depositado, silueta de tejado según el trabajo hecho. */
export function paintConstructionSite(g: CanvasRenderingContext2D, s: ExtendedStructure, site: ConstructionSite, t: number, animate: boolean): void {
  const box = footprintBox(s), f = siteFractions(site);
  const left = box.x0 * ART + 1, W = box.w * ART - 2, ground = (box.y0 + box.h - 1) * ART + 13, right = left + W;
  const postH = 6 + Math.round(f.work * 12), top = ground - postH;
  px(g, left - 1, ground - 1, W + 2, 2, K.shadow);
  for (const px0 of [left, left + Math.round(W / 2) - 1, right - 2]) { px(g, px0, top, 2, postH, K.timber); px(g, px0, top, 1, postH, K.timberLight); }
  if (f.work > .15) { // riostras
    const n = Math.max(2, Math.round(W / 2));
    for (let i = 0; i < n; i++) { px(g, left + 2 + i * (W - 6) / n, ground - 3 - i * (postH - 5) / n, 2, 1, K.timberLight); px(g, right - 4 - i * (W - 6) / n, ground - 3 - i * (postH - 5) / n, 2, 1, K.timberLight); }
    px(g, left, top, W, 2, K.timber);
  }
  if (f.work > .5) { // el tejado asoma desde el armazón
    const rows = Math.round((f.work - .5) * 2 * (5 + box.w * 2));
    for (let r = 0; r < rows; r++) { const inset = Math.floor(r * (W / 2) / (5 + box.w * 2 + 1)); px(g, left - 1 + inset, top - 1 - r, W + 2 - inset * 2, 1, r % 2 ? K.roofDark : K.roof); }
  }
  const woodUnits = Math.round(f.wood * 6), stoneUnits = Math.round(f.stone * 6);
  if (woodUnits) paintCordwood(g, left - 8, ground + 2, woodUnits, true);
  if (stoneUnits) paintStonePallet(g, right + 2, ground + 2, stoneUnits, true);
  // barra de avance de obra (fina)
  const bw = Math.max(10, W - 2), bx = left + (W - bw) / 2, by = ground + 4;
  px(g, bx - 1, by - 1, bw + 2, 4, K.bar); px(g, bx, by, bw, 2, '#5a5648'); px(g, bx, by, Math.round(bw * f.work), 2, K.barFill);
  if (animate && f.work > 0 && f.work < 1 && Math.floor(t * 4) % 2) px(g, left + Math.round(W * f.work) - 1, top - 3, 2, 2, K.glow); // golpe de martillo
}

/** Salón unificado: cimiento de mampostería, muros con marcos de madera, tejado a dos aguas y detalles por tier y componentes. */
export function paintModularHall(g: CanvasRenderingContext2D, s: ExtendedStructure, t: number, animate: boolean): void {
  if (isPolyomino(s)) { paintPolyominoStructure(g, s, t, animate); return; }
  const C = { ...K, ...structurePalette(s) }; // paleta teñida por el material (V20); sin perfil es la base
  const box = footprintBox(s), tier = structureTier(s), grand = tier === 'grand';
  const left = box.x0 * ART, W = box.w * ART, right = left + W, ground = (box.y0 + box.h - 1) * ART + 13;
  const worn = s.condition < .3, foundation = grand ? 4 : 3, wallH = grand ? 13 : 11, roofH = 8 + (box.h - 1) * 8;
  const wallTop = ground - foundation - wallH;
  px(g, left - 2, ground - 1, W + 4, 3, C.shadow);
  // cimiento de mampostería con juntas
  px(g, left - 1, ground - foundation, W + 2, foundation, C.stone); px(g, left - 1, ground - foundation, W + 2, 1, '#e6e0cf');
  for (let i = 0; i < Math.ceil(W / 5); i++) px(g, left + i * 5 + (i % 2 ? 2 : 0), ground - foundation + 1, 1, foundation - 1, C.stoneShade);
  // muros: entramado de madera
  px(g, left, wallTop, W, wallH, C.wall); px(g, right - 4, wallTop, 4, wallH, C.wallShade);
  px(g, left, wallTop, W, 1, C.timber); px(g, left, wallTop + Math.round(wallH / 2), W, 1, C.timberLight);
  const bay = 8, bays = Math.max(2, Math.round(W / bay));
  for (let i = 0; i <= bays; i++) px(g, Math.min(right - 1, left + i * (W / bays)), wallTop, 1, wallH, C.timber);
  // tejado a dos aguas con hileras alternas y viga cumbrera
  const rowsMax = roofH;
  for (let r = 0; r < roofH; r++) {
    const inset = Math.floor(r * (W / 2 - 2) / rowsMax);
    px(g, left - 2 + inset, wallTop - 1 - r, W + 4 - inset * 2, 1, worn ? C.thatchWeathered : r % 3 === 0 ? C.roofLight : r % 3 === 1 ? C.roof : C.roofDark);
  }
  const ridgeY = wallTop - roofH;
  px(g, left + Math.round(W / 2) - 6, ridgeY, 12, 1, C.timber); px(g, left + Math.round(W / 2) - 6, ridgeY - 1, 12, 1, C.timberLight);
  // contrafuertes laterales y de centro (salón grande)
  for (const bx of grand ? [left - 3, Math.round((left + right) / 2) - 1, right + 1] : [left - 3, right + 1]) { px(g, bx, wallTop + 2, 2, wallH + foundation - 2, C.stone); px(g, bx, wallTop + 2, 1, wallH + foundation - 2, '#e6e0cf'); px(g, bx - 1, ground - 2, 4, 2, C.stoneShade); }
  // puerta, ventanas y umbral del patio
  const mid = Math.round((left + right) / 2);
  px(g, mid - 3, ground - foundation - 8, 6, 8, C.door); px(g, mid - 4, ground - foundation - 9, 8, 1, C.timber); px(g, mid - 3, ground - foundation - 8, 6, 1, '#231710');
  px(g, mid - 5, ground, 10, 2, C.soil); px(g, mid - 4, ground + 2, 8, 1, C.soil);
  for (let i = 0; i < bays; i++) { const wx = left + 2 + i * (W / bays); if (Math.abs(wx + 1 - mid) > 5) { px(g, wx, wallTop + 3, 3, 3, C.glow); px(g, wx, wallTop + 3, 3, 1, C.timber); } }
  // componentes visibles
  const comps = s.components;
  if (comps.includes('hearth')) {
    const cx = left + Math.round(W * .22);
    px(g, cx, ridgeY - 6, 3, 8, C.stoneShade); px(g, cx - 1, ridgeY - 7, 5, 1, C.stoneDark); px(g, cx, ridgeY - 6, 1, 8, C.stone);
    if (animate) { const u = (t * .9) % 1; px(g, cx + 1 + Math.round(Math.sin(t * 2) * 1), ridgeY - 9 - Math.round(u * 7), 2, 2, C.smoke); }
  }
  let basin: { x: number; y: number; w: number } | null = null;
  if (comps.includes('cistern')) {
    const cisterns = comps.filter(c => c === 'cistern').length, level = clamp01(s.water / Math.max(1, cisterns) / .6);
    basin = { x: right - 14, y: ground + 1, w: 12 };
    px(g, basin.x - 1, basin.y, basin.w + 2, 5, C.stoneShade); px(g, basin.x, basin.y + 1, basin.w, 3, level > 0 ? C.water : C.door);
    if (level > .15) px(g, basin.x + 2 + (animate ? Math.floor(t * 2) % 3 : 0), basin.y + 1, 3, 1, C.waterGleam);
  }
  if (comps.includes('granary')) {
    const granaries = comps.filter(c => c === 'granary').length, fill = clamp01(s.food / Math.max(1, granaries) / .7);
    for (let i = 0; i < Math.min(3, box.w + (grand ? 1 : 0)); i++) {
      const bx = left + 3 + i * Math.floor((W - 8) / Math.max(1, Math.min(3, box.w + (grand ? 1 : 0)))) ;
      if (Math.abs(bx + 2 - mid) < 6) continue;
      px(g, bx, ground - foundation - 5, 5, 5, C.timber); px(g, bx + 1, ground - foundation - 4, 3, 4, C.door);
      if (fill > 0) px(g, bx + 1, ground - foundation - 1 - Math.round(fill * 3), 3, Math.max(1, Math.round(fill * 3)), C.food);
    }
  }
  if (worn) for (let i = 0; i < 4; i++) px(g, left + 3 + (hash3(s.x, s.y, 50 + i) % Math.max(1, W - 6)), wallTop + 1 + (i * 3) % wallH, 1, 2, C.stoneDark);
  // bodega de materiales, junto a la puerta de carga
  const wood = stockLevel(s.storedWood), stone = stockLevel(s.storedStone);
  if (wood) paintCordwood(g, left + 2, ground + 3, wood, false);
  if (stone) paintStonePallet(g, left + Math.round(W * .52), ground + 3, stone, false);
  paintInstalled(g, s, left, right, wallTop, ground, basin);
  paintRectAccents(g, s, t, animate);
}

/* ------------------------------------------------------------------ */
/* V20 — material, poliominós y sinergias                              */
/* ------------------------------------------------------------------ */

const WARM = { stone: '#d9b987', light: '#f1d9ac', dark: '#a8875a' } as const;
const KILN = { ember: '#ff7a2a', emberDim: '#c4562a', core: '#ffd27a', halo: 'rgba(255,170,70,.35)', bezel: '#3a3430' } as const;
const CHANNEL = { water: '#3fa9c9', gleam: '#bfeaf5', moist: 'rgba(63,169,201,.45)' } as const;
const BENCH = { plank: '#8a6a46', plankLight: '#a5825a' } as const;

const HEX = /^#(?:[\da-f]{3}|[\da-f]{6})$/i;
function parseHex(hex: string): [number, number, number] | null {
  if (!HEX.test(hex)) return null;
  const full = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
  const n = parseInt(full.slice(1), 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
}
/** Mezcla `a` hacia `b` (0 = a, 1 = b). Si algún color no es hexadecimal se devuelve `a`. */
export function mixHex(a: string, b: string, t: number): string {
  const ca = parseHex(a), cb = parseHex(b);
  if (!ca || !cb) return a;
  const k = clamp01(t), ch = (i: number) => Math.round(ca[i]! + (cb[i]! - ca[i]!) * k).toString(16).padStart(2, '0');
  return `#${ch(0)}${ch(1)}${ch(2)}`;
}

export interface StructurePalette { stone: string; stoneShade: string; timberLight: string; wall: string; wallShade: string; wallLight: string; roof: string; roofLight: string; roofDark: string; thatchWeathered: string }
/** Paleta de muros y tejado mezclada con el tinte del perfil material (arcilla, caliza, hierro…); sin perfil, la base. */
export function structurePalette(s: ExtendedStructure): StructurePalette {
  const tint = s.materialProfile?.tint;
  if (!tint || !parseHex(tint)) return { stone: K.stone, stoneShade: K.stoneShade, timberLight: K.timberLight, wall: K.wall, wallShade: K.wallShade, wallLight: K.wallLight, roof: K.roof, roofLight: K.roofLight, roofDark: K.roofDark, thatchWeathered: K.thatchWeathered };
  return {
    stone: mixHex(K.stone, tint, .45), stoneShade: mixHex(K.stoneShade, tint, .45), timberLight: mixHex(K.timberLight, tint, .3),
    wall: mixHex(K.wall, tint, .55), wallShade: mixHex(K.wallShade, tint, .5), wallLight: mixHex(K.wallLight, tint, .45),
    roof: mixHex(K.roof, tint, .4), roofLight: mixHex(K.roofLight, tint, .36), roofDark: mixHex(K.roofDark, tint, .42), thatchWeathered: mixHex(K.thatchWeathered, tint, .2),
  };
}

/** Un frente (cara sur visible) de la obra: dónde está su suelo y qué lados dan al exterior. */
interface Front { x0: number; w: number; west: boolean; east: boolean; ground: number; wallTop: number }
interface AccentLayout { fronts: Front[]; door: Front; doorX: number; doorTop: number; topY: number; smokeX: number }

const compoundHex = (lot: { properties?: { colorHex?: string } }): string => parseHex(lot.properties?.colorHex ?? '') ? lot.properties!.colorHex! : '#a29484';
const isAmphora = (phase: string): boolean => phase === 'fired' || phase === 'vitrified' || phase === 'smelted';

/**
 * Detalles V20 que dependen de la sinergia local y de la bodega química: contrafuertes de muro compartido, ranura de horno y
 * humo, banco y yunque del taller, canal de riego de la cisterna y ánforas/cajas con el color de cada compuesto almacenado.
 */
function paintV20Accents(g: CanvasRenderingContext2D, s: ExtendedStructure, L: AccentLayout, t: number, animate: boolean, kilnDecorated = false): void {
  const syn = s.synergy, fronts = L.fronts, door = L.door;
  paintMaterialFinish(g, s, fronts);
  if (syn && syn.sharedEdges > 0) {
    // Muros compartidos con la obra vecina: contrafuertes de piedra cálida en las esquinas exteriores y arco sobre la puerta.
    const corners: { x: number; f: Front }[] = [];
    for (const f of fronts) { if (f.west) corners.push({ x: f.x0 - 2, f }); if (f.east) corners.push({ x: f.x0 + f.w, f }); }
    for (const c of corners.slice(0, Math.max(1, Math.min(corners.length, Math.round(syn.sharedEdges))))) {
      const top = c.f.wallTop, h = c.f.ground - top;
      px(g, c.x, top + 1, 2, h - 1, WARM.stone); px(g, c.x, top + 1, 1, h - 1, WARM.light); px(g, c.x - 1, top, 4, 1, WARM.light); px(g, c.x - 1, c.f.ground - 2, 4, 2, WARM.dark);
    }
    px(g, L.doorX - 4, L.doorTop - 1, 8, 1, WARM.stone); px(g, L.doorX - 3, L.doorTop - 2, 6, 1, WARM.stone); px(g, L.doorX - 2, L.doorTop - 3, 4, 1, WARM.light);
  }
  const tier = syn?.kilnTier ?? (syn?.heated ? 1 : 0), kilnLit = !!syn && (tier === 2 || syn.heated);
  if (syn && kilnLit && !kilnDecorated) {
    const hot = tier === 2, ex = L.doorX + 4, ey = door.ground - 8;
    if (hot) {
      px(g, L.smokeX - 1, L.topY - 5, 3, 7, K.stoneShade);
      px(g, L.smokeX - 2, L.topY - 6, 5, 1, KILN.bezel);
      px(g, L.smokeX, L.topY - 4, 1, 2, KILN.ember);
    }
    px(g, ex - 1, ey - 1, 5, 4, KILN.bezel);
    if (hot && (!animate || Math.floor(t * 6) % 3 !== 0)) px(g, ex - 2, ey - 2, 7, 6, KILN.halo); // brasa viva con parpadeo
    px(g, ex, ey, 3, 2, hot ? KILN.ember : KILN.emberDim); if (hot) px(g, ex + 1, ey, 1, 1, KILN.core);
    for (let i = 0; i < 3; i++) { // volutas de humo ascendentes
      const u = animate ? (t * .8 + i / 3) % 1 : i / 3, dx = animate ? Math.round(Math.sin(t * 2 + i * 2) * 1.5) : i - 1;
      px(g, L.smokeX + dx + i, L.topY - 2 - Math.round(u * 12), 2, 2, `rgba(232,228,218,${(.6 - u * .5).toFixed(2)})`);
    }
  }
  if (syn && syn.workshopBonus > 0) {
    // Banco de trabajo con yunque de acero oscuro, junto a la puerta.
    const bx = L.doorX - 13, by = door.ground + 1;
    px(g, bx, by, 9, 2, BENCH.plank); px(g, bx, by, 9, 1, BENCH.plankLight); px(g, bx + 1, by + 2, 1, 2, K.timber); px(g, bx + 7, by + 2, 1, 2, K.timber);
    px(g, bx + 2, by - 1, 3, 1, K.steel); px(g, bx + 6, by - 1, 1, 1, K.timberLight);
    px(g, bx + 11, by + 2, 2, 3, K.timber); px(g, bx + 9, by, 6, 2, K.steelDark); px(g, bx + 9, by, 3, 1, K.steelLight); px(g, bx + 15, by + 1, 1, 1, K.steelDark);
  }
  if (syn?.irrigated) {
    // Canal de riego: hilo de agua cian a ras del cimiento, con destello que corre y gotas al exterior.
    for (const f of fronts) {
      px(g, f.x0, f.ground - 1, f.w, 1, CHANNEL.water); px(g, f.x0, f.ground, f.w, 1, CHANNEL.moist);
      px(g, f.x0 + (animate ? Math.floor(t * 3) % (f.w - 3) : 3), f.ground - 1, 3, 1, CHANNEL.gleam);
      px(g, f.x0 + f.w - 3, f.ground + 1, 1, 2, CHANNEL.water);
    }
  }
  const lots = (s.storedCompounds ?? []).filter(l => l.mass > 0).sort((a, b) => b.mass - a.mass).slice(0, 3);
  if (lots.length) {
    const slots: { x: number; ground: number }[] = [];
    for (const f of [...fronts].sort((a, b) => b.x0 - a.x0)) for (const off of f.w > 8 ? [f.w - 5, 6, 1] : [1]) {
      const x = f.x0 + off;
      if (Math.abs(x + 2 - L.doorX) >= 5 && !(kilnLit && Math.abs(x + 2 - (L.doorX + 5)) < 4)) slots.push({ x, ground: f.ground });
    }
    lots.slice(0, slots.length).forEach((lot, i) => {
      const { x, ground } = slots[i]!, color = compoundHex(lot), shade = mixHex(color, '#1c1612', .45);
      if (isAmphora(lot.phase)) { px(g, x, ground - 3, 3, 4, color); px(g, x + 1, ground - 4, 1, 1, shade); px(g, x, ground - 3, 1, 3, mixHex(color, '#ffffff', .25)); px(g, x + 2, ground - 1, 1, 2, shade); }
      else { px(g, x, ground - 3, 4, 4, shade); px(g, x + 1, ground - 2, 2, 2, color); px(g, x, ground - 3, 4, 1, mixHex(color, '#ffffff', .3)); }
    });
  }
}

/**
 * Obra de planta libre (poliominó contiguo: L, T, 3×1, 2×2, 3×2…). Cada casilla pinta su placa de tejado de 16 filas y su
 * frente solo donde la casilla vecina no existe: los bordes internos se funden sin costuras, y solo los bordes exteriores llevan
 * alero, postes de madera y cimiento de piedra. El tejado se sombrea por la distancia a ese borde exterior (faldón).
 */
export function paintPolyominoStructure(g: CanvasRenderingContext2D, s: ExtendedStructure, t: number, animate: boolean): void {
  const cells = footprintCells(s), set = new Set(cells.map(c => `${c.x},${c.y}`)), at = (x: number, y: number): boolean => set.has(`${x},${y}`);
  const pal = structurePalette(s), worn = s.condition < .3, box = footprintBox(s), comps = s.components;
  const ordered = [...cells].sort((a, b) => a.y - b.y || a.x - b.x);
  const run = (x: number, y: number, dx: number, dy: number): number => { let n = 0; while (at(x + dx * (n + 1), y + dy * (n + 1))) n++; return n; };
  const fronts: Front[] = [];
  let topY = Infinity;
  // 1) placas de tejado: una por casilla, sombreadas por distancia al borde exterior de la columna.
  for (const c of ordered) {
    const x0 = c.x * ART, y0 = c.y * ART - 14, north = !at(c.x, c.y - 1), south = !at(c.x, c.y + 1), west = !at(c.x - 1, c.y), east = !at(c.x + 1, c.y);
    const above = run(c.x, c.y, 0, -1), below = run(c.x, c.y, 0, 1);
    topY = Math.min(topY, y0);
    const shades = worn ? [pal.thatchWeathered, pal.roofDark, pal.thatchWeathered] : [pal.roofDark, pal.roof, pal.roofLight];
    for (let r = 0; r < ART; r++) {
      const y = y0 + r, d = Math.min(r + ART * above, ART - 1 - r + ART * below);
      let band = d < 3 ? 0 : d < 6 ? 1 : 2;
      if (y % 3 === 0 && band > 0) band--; // hiladas alternas
      const xl = x0 - (west ? 1 : 0), xr = x0 + ART + (east ? 1 : 0);
      px(g, xl, y, xr - xl, 1, north && r === 0 ? K.timber : shades[band]!);
      if (west) px(g, xl, y, 1, 1, K.timber);
      if (east) px(g, xr - 1, y, 1, 1, K.timber);
    }
    if (south) fronts.push({ x0, w: ART, west, east, ground: c.y * ART + 13, wallTop: c.y * ART + 2 });
    if (worn) for (let i = 0; i < 2; i++) px(g, x0 + 2 + hash3(c.x, c.y, 50 + i) % 12, y0 + 3 + (i * 6) % 10, 1, 2, K.stoneDark);
  }
  // 2) puerta en el frente más cercano al centro de la planta
  const centerX = (box.x0 + box.w / 2) * ART;
  const door = [...fronts].sort((a, b) => Math.abs(a.x0 + 8 - centerX) - Math.abs(b.x0 + 8 - centerX) || b.ground - a.ground || a.x0 - b.x0)[0]!;
  const doorX = door.x0 + 8;
  // 3) frentes: sombra, cimiento, muro con entramado, puerta y ventanas
  for (const f of fronts) {
    const left = f.x0 - (f.west ? 1 : 0), width = f.w + (f.west ? 1 : 0) + (f.east ? 1 : 0), isDoor = f === door;
    px(g, f.x0 - 2, f.ground - 1, f.w + 4, 3, K.shadow);
    px(g, left, f.ground - 3, width, 3, pal.stone); px(g, left, f.ground - 3, width, 1, '#e6e0cf');
    for (let i = 0; i < Math.ceil(width / 5); i++) px(g, left + i * 5 + (i % 2 ? 2 : 0), f.ground - 2, 1, 2, pal.stoneShade);
    px(g, f.x0, f.wallTop, f.w, 8, pal.wall); if (f.east) px(g, f.x0 + f.w - 4, f.wallTop, 4, 8, pal.wallShade);
    px(g, f.x0, f.wallTop, f.w, 1, K.timber); px(g, f.x0, f.wallTop + 4, f.w, 1, pal.timberLight);
    if (f.west) px(g, f.x0, f.wallTop, 1, 8, K.timber);
    if (f.east) px(g, f.x0 + f.w - 1, f.wallTop, 1, 8, K.timber);
    if (!isDoor) { px(g, f.x0 + 8, f.wallTop, 1, 8, K.timber); px(g, f.x0 + 2, f.wallTop + 2, 3, 3, K.glow); px(g, f.x0 + 2, f.wallTop + 2, 3, 1, K.timber); }
    else {
      px(g, doorX - 3, f.ground - 10, 6, 7, K.door); px(g, doorX - 4, f.ground - 11, 8, 1, K.timber); px(g, doorX - 3, f.ground - 10, 6, 1, '#231710');
      px(g, doorX - 5, f.ground, 10, 2, K.soil);
    }
  }
  // 4) componentes visibles
  const first = ordered[0]!, fx0 = first.x * ART;
  if (comps.includes('hearth')) {
    const cx = fx0 + 10, ty = first.y * ART - 14;
    px(g, cx, ty - 5, 3, 8, pal.stoneShade); px(g, cx - 1, ty - 6, 5, 1, K.stoneDark); px(g, cx, ty - 5, 1, 8, pal.stone);
    topY = Math.min(topY, ty - 6);
    if (animate) { const u = (t * .9) % 1; px(g, cx + 1 + Math.round(Math.sin(t * 2)), ty - 8 - Math.round(u * 7), 2, 2, K.smoke); }
  }
  const byX = [...fronts].sort((a, b) => a.x0 - b.x0), right = byX[byX.length - 1]!, leftmost = byX[0]!;
  let basin: { x: number; y: number; w: number } | null = null;
  if (comps.includes('cistern')) {
    const cisterns = comps.filter(c => c === 'cistern').length, level = clamp01(s.water / Math.max(1, cisterns) / .6);
    basin = { x: right.x0 + 2, y: right.ground + 1, w: 12 };
    px(g, basin.x - 1, basin.y, basin.w + 2, 5, pal.stoneShade); px(g, basin.x, basin.y + 1, basin.w, 3, level > 0 ? K.water : K.door);
    if (level > .15) px(g, basin.x + 2 + (animate ? Math.floor(t * 2) % 3 : 0), basin.y + 1, 3, 1, K.waterGleam);
  }
  if (comps.includes('granary')) {
    const granaries = comps.filter(c => c === 'granary').length, fill = clamp01(s.food / Math.max(1, granaries) / .7);
    byX.slice(0, 3).forEach(f => {
      const bx = f.x0 + (f === door ? 0 : 5);
      px(g, bx, f.ground - 8, 5, 5, K.timber); px(g, bx + 1, f.ground - 7, 3, 4, K.door);
      if (fill > 0) px(g, bx + 1, f.ground - 4 - Math.round(fill * 3), 3, Math.max(1, Math.round(fill * 3)), K.food);
    });
  }
  const wood = stockLevel(s.storedWood), stone = stockLevel(s.storedStone);
  if (wood) paintCordwood(g, leftmost.x0 + 2, leftmost.ground + 3, wood, false);
  if (stone) paintStonePallet(g, (byX[1] ?? leftmost).x0 + (byX[1] ? 2 : 9), (byX[1] ?? leftmost).ground + 3, stone, false);
  paintInstalled(g, s, door.x0, door.x0 + ART, door.wallTop, door.ground, basin);
  const layout: AccentLayout = { fronts, door, doorX, doorTop: door.ground - 11, topY, smokeX: fx0 + 8 };
  paintV20Accents(g, s, layout, t, animate);
}

/** Sinergia y bodega de un edificio de planta rectangular sin `cells` (V19 con datos V20): mismos detalles sobre su frente único. */
function paintRectAccents(g: CanvasRenderingContext2D, s: ExtendedStructure, t: number, animate: boolean): void {
  if (!s.synergy && !s.storedCompounds?.length && !s.materialProfile) return;
  const box = footprintBox(s), ground = (box.y0 + box.h - 1) * ART + 13, tier = structureTier(s), wallTop = ground - (tier === 'grand' ? 17 : 14);
  const fronts: Front[] = [];
  for (let i = 0; i < box.w; i++) fronts.push({ x0: (box.x0 + i) * ART, w: ART, west: i === 0, east: i === box.w - 1, ground, wallTop });
  const doorX = Math.round((box.x0 + box.w / 2) * ART), door = fronts.find(f => f.x0 <= doorX && doorX < f.x0 + f.w) ?? fronts[0]!;
  paintV20Accents(g, s, { fronts, door, doorX, doorTop: ground - 12, topY: wallTop - (8 + (box.h - 1) * 8), smokeX: box.x0 * ART + Math.round(box.w * ART * .22) + 1 }, t, animate);
}

/**
 * Accesorios sobre el sprite de una estructura de 1×1 (cabaña/choza): existencias de la bodega a su lado y herrajes de
 * las piezas instaladas. `left`, `ground`: esquina inferior izquierda de su casilla en píxeles de arte.
 */
export function paintCompactAccessories(g: CanvasRenderingContext2D, s: ExtendedStructure, t = 0, animate = false, materialDecorated = false): void {
  const left = s.x * ART, ground = s.y * ART + 13, wood = stockLevel(s.storedWood), stone = stockLevel(s.storedStone);
  const tint = s.materialProfile?.tint;
  if (!materialDecorated && tint && parseHex(tint)) px(g, left + 2, ground - 14, 12, 11, `rgba(${parseHex(tint)!.join(',')},.3)`);
  if (wood) paintCordwood(g, left - 7, ground + 2, wood, true);
  if (stone) paintStonePallet(g, left + 14, ground + 2, stone, true);
  if (installedCount(s)) paintInstalled(g, s, left + 2, left + 14, ground - 22, ground, s.components.includes('cistern') ? { x: left + 8, y: ground - 3, w: 6 } : null);
  if (s.synergy || !materialDecorated && s.storedCompounds?.length) {
    const front: Front = { x0: left, w: ART, west: true, east: true, ground, wallTop: ground - 15 };
    paintV20Accents(g, materialDecorated ? { ...s, storedCompounds: [], materialProfile: undefined } : s, { fronts: [front], door: front, doorX: left + 8, doorTop: ground - 12, topY: ground - 26, smokeX: left + 10 }, t, animate, materialDecorated && s.synergy?.kilnTier === 2);
  }
}

export interface StructureSurface {
  materials?: { wood: number; stone: number };
  ground?: Pick<Tile, 'growth' | 'vegetation' | 'cultivation' | 'moisture'>;
  generation?: number;
  communityColor?: string;
  culture?: { sharing: number; stewardship: number; openness: number };
}

/** Parts change layout and capacity; material tones describe the blueprint cost, never an invented alloy. */
export function paintStructure(g: CanvasRenderingContext2D, s: StructureView, surface: StructureSurface = {}): void {
  const tint = s.materialProfile?.tint;
  const surfaceColors = new Set(['#e4c797','#a39074','#cfc9ba','#8f8a7e','#ded8c8','#9c9689','#6e3222','#5c3822','#6e5522','#7d6e52','#9e4933','#8c5634','#b89240','#a69676','#d1785e','#c78c58','#ebd07a']);
  const block = (x: number, y: number, w: number, h: number, color: string) => {
    g.fillStyle = tint && surfaceColors.has(color) ? mixHex(color, tint, .45) : color;
    g.fillRect(Math.round(x), Math.round(y), Math.max(0, Math.round(w)), Math.max(0, Math.round(h)));
  };
  const count = (part: StructureView['components'][number]) => s.components.filter(c => c === part).length;
  const frames = count('frame'), roofs = count('roof'), cisterns = count('cistern');
  const stores = count('granary'), gardens = count('garden'), hearths = count('hearth');
  const condition = Math.max(0, Math.min(1, s.condition)), degraded = condition < .65, broken = condition < .3;
  const wood = surface.materials?.wood ?? 0, stone = surface.materials?.stone ?? 0;
  const stoneRatio = wood + stone > 0 ? stone / (wood + stone) : 0.25;
  const masonry = wood + stone > 0 ? Math.round(stoneRatio * 6) : 1;
  const gen = Math.max(0, Math.min(4, surface.generation ?? (frames > 1 || roofs > 1 || cisterns + stores + gardens + hearths >= 2 ? 2 : cisterns + stores + gardens + hearths === 1 ? 1 : 0)));
  const outline = '#2b1d14';
  const communityHex = surface.communityColor && /^#[0-9a-fA-F]{6}$/.test(surface.communityColor) ? surface.communityColor : null;

  // Layout geometry: never erase the main room when a garden or annex is attached.
  const hasRightAnnex = cisterns > 0;
  const hasLeftGarden = gardens > 0;
  const left = frames > 1 ? (hasLeftGarden ? 6 : 3) : hasLeftGarden ? 9 : hasRightAnnex ? 4 : 6;
  const width = frames > 1 ? (hasRightAnnex ? 19 : 24) : hasLeftGarden ? (hasRightAnnex ? 14 : 18) : hasRightAnnex ? 18 : 20;
  const floor = stores ? 25 : 27;
  const wallH = gen === 0 && frames <= 1 && roofs <= 1 && cisterns + stores + gardens + hearths === 0 ? 11 : gen >= 2 || frames > 1 ? 15 : 13;
  const eave = floor - wallH;

  // Ground shadow & stone foundation plinth (high value contrast against #a8825c soil)
  block(2, 29, 28, 2, '#14201948');
  block(left - 1, floor, width + 2, 2, outline);
  block(left, floor, width, 1, '#cfc9ba');

  if (frames) {
    // Raised granary stilts
    if (stores) {
      for (let x = left + 2; x < left + width - 1; x += 6) {
        block(x, floor + 1, 2, 3, outline);
        block(x, floor + 1, 1, 2, '#8c6947');
        block(x - 1, 28, 4, 1, '#cfc9ba');
      }
    }

    // Main wall body: light dressed timber (#e4c797) + real stone masonry courses up to stoneH
    const innerX = left + 1, innerW = Math.max(4, width - 2), innerH = Math.max(4, floor - eave);
    const stoneH = Math.min(innerH, Math.max(1, Math.round(innerH * Math.min(1, stoneRatio * 1.15))));
    const wallTopColor = degraded ? '#a39074' : '#e4c797';
    const plankJoint = degraded ? '#6e5c44' : '#b38b59';

    // Outer dark outline of the building box
    block(left, eave, width, innerH + 1, outline);
    // Upper timber wall
    block(innerX, eave + 1, innerW, innerH - 1, wallTopColor);
    for (let y = eave + 3; y < floor - stoneH; y += 3) {
      block(innerX, y, innerW, 1, plankJoint);
    }

    // Lower (or full) coursed stone masonry wall
    if (stoneH > 0) {
      const sy0 = floor - stoneH;
      block(innerX, sy0, innerW, stoneH, degraded ? '#8f8a7e' : '#cfc9ba');
      for (let y = sy0; y < floor; y += 2) {
        block(innerX, y, innerW, 1, '#5e5a52');
        const shift = ((y - sy0) >> 1) & 1 ? 2 : 0;
        for (let x = innerX + shift; x < innerX + innerW; x += 4) {
          block(x, y + 1, 1, 1, '#5e5a52');
          if (x + 1 < innerX + innerW) block(x + 1, y + 1, 2, 1, (x + y) % 3 === 0 ? '#9c9689' : '#ded8c8');
        }
      }
      // Corner stone quoins when stone ratio is high
      if (masonry >= 3) {
        for (let y = eave + 2; y < floor; y += 3) {
          block(innerX, y, 2, 2, '#ded8c8');
          block(innerX + innerW - 2, y, 2, 2, '#9c9689');
        }
      }
    }

    // Structural frame posts & bays (1 frame vs 2+ frames)
    const bays = Math.max(1, frames);
    for (let bay = 0; bay <= bays; bay++) {
      const x = left + Math.round(bay / bays * (width - 2));
      block(x, eave, 2, innerH + 1, '#4a3321');
      block(x, eave + 1, 1, innerH - 1, '#d4ad73');
    }
    // Reinforced buttresses for 2+ frames
    if (frames > 1) {
      block(left - 1, floor - 5, 2, 6, '#7a756c');
      block(left + width - 1, floor - 5, 2, 6, '#7a756c');
    }

    // Doorway with warm interior depth & optional community lintel
    const doorX = left + Math.max(2, width - 6);
    const doorH = Math.min(7, innerH - 2);
    block(doorX - 1, floor - doorH - 1, 5, doorH + 1, outline);
    block(doorX, floor - doorH, 3, doorH, '#291d15');
    block(doorX, floor - doorH, 1, doorH, '#c99b5b');
    if (communityHex) {
      block(doorX - 1, floor - doorH - 1, 5, 1, communityHex);
    }

    // Windows for multi-bay or higher-generation structures
    if ((gen >= 2 || frames > 1 || stores > 0) && width >= 15) {
      const winCount = frames > 1 ? 2 : 1;
      for (let w = 0; w < winCount; w++) {
        const wx = left + 3 + w * 6;
        if (wx + 3 < doorX) {
          block(wx, eave + 3, 3, 3, outline);
          block(wx + 1, eave + 4, 1, 1, '#f2d08a');
        }
      }
    }
    // Cross-beam at eave
    block(left - 1, eave, width + 2, 2, outline);
    block(left, eave, width, 1, communityHex ?? '#6b4c32');
  }

  // Hearth chimney stack (drawn behind/through roof ridge, no fake smoke or fire from historical `uses`)
  if (hearths) {
    const hx = left + 2;
    block(hx - 1, 3, 6, floor - 3, outline);
    block(hx, 4, 4, floor - 4, '#b8b2a4');
    block(hx, 4, 1, floor - 4, '#ded8c8');
    block(hx - 1, 3, 6, 2, '#ded8c8');
    block(hx, 7, 4, 1, '#6e6a61');
    block(hx, 11, 4, 1, '#6e6a61');
    // Hearth firebox arch at base
    block(hx - 1, floor - 5, 6, 5, '#5e5a52');
    block(hx, floor - 4, 4, 4, '#24221e');
    block(hx + 1, floor - 2, 2, 1, '#7a5238');
  }

  // Roofs: distinct silhouettes by roof count (1 vs 2 stepped gables) and palette by generation/stone
  if (roofs) {
    const spans = Math.max(1, roofs);
    const roofDark = gen >= 3 || masonry >= 4 ? '#6e3222' : gen >= 1 ? '#5c3822' : '#6e5522';
    const roofMid = degraded ? '#7d6e52' : gen >= 3 || masonry >= 4 ? '#9e4933' : gen >= 1 ? '#8c5634' : '#b89240';
    const roofLight = degraded ? '#a69676' : gen >= 3 || masonry >= 4 ? '#d1785e' : gen >= 1 ? '#c78c58' : '#ebd07a';

    for (let bay = 0; bay < spans; bay++) {
      const spanW = Math.ceil((width + 4) / spans);
      const l = left - 2 + Math.floor(bay * (width + 2) / spans);
      // Second roof gable is taller/stepped so "Casa de dos cubiertas" has an unmistakable twin silhouette
      const roofH = (spans > 1 ? (bay === 0 ? 6 : 8) : gen === 0 ? 5 : gen >= 2 ? 8 : 7);
      const ridge = Math.max(2, eave - roofH);
      for (let row = 0; row < eave - ridge; row++) {
        const taper = gen === 0 && spans === 1
          ? Math.round((eave - ridge - row - 1) * .45)
          : Math.round((eave - ridge - row - 1) * spanW / (2 * Math.max(1, eave - ridge)));
        const rx = l + taper;
        const rw = Math.max(2, spanW - taper * (gen === 0 && spans === 1 ? 1 : 2));
        block(rx - 1, ridge + row, rw + 2, 1, outline);
        block(rx, ridge + row, rw, 1, row === 0 ? roofLight : row % 2 === 0 ? roofMid : roofDark);
      }
      block(l - 1, eave - 1, spanW + 2, 2, outline);
      block(l, eave - 1, spanW, 1, roofLight);

      // Community pennant on main roof peak (extended streamer when cultural openness is high)
      if (communityHex && bay === spans - 1) {
        const px0 = l + Math.floor(spanW / 2);
        const openCulture = (surface.culture?.openness ?? 0) > 0.52;
        block(px0, Math.max(0, ridge - (openCulture ? 5 : 4)), 1, openCulture ? 5 : 4, outline);
        block(px0 + 1, Math.max(0, ridge - (openCulture ? 5 : 4)), openCulture ? 4 : 3, 2, communityHex);
        if (openCulture) {
          block(px0 + 5, Math.max(0, ridge - 4), 2, 1, '#e8f4f8');
        }
      }
      if (broken) {
        g.clearRect(l + Math.floor(spanW * .45), ridge + 2, 3, 3);
        block(l + 2, floor - 1, 5, 2, '#5c4b36');
      }
    }
  }

  // Cultural architectural motifs (when community culture is known):
  // - stewardship (>0.52): living green vine/moss garland along the eave
  // - sharing (>0.52): communal welcome bench/table beside the doorway
  // - openness (>0.52): painted sky-blue window shutters/trim
  if (surface.culture && frames) {
    if (surface.culture.stewardship > 0.52) {
      for (let vx = left + 1; vx < left + width - 1; vx += 3) {
        block(vx, eave + 1, 2, 1, '#68a848');
        if ((vx & 1) === 0) block(vx, eave + 2, 1, 1, '#a8e070');
      }
    }
    if (surface.culture.sharing > 0.52) {
      const bx = left + Math.max(1, width - 10);
      block(bx, floor - 2, 4, 1, '#f2ca68');
      block(bx, floor - 1, 1, 1, outline);
      block(bx + 3, floor - 1, 1, 1, outline);
    }
    if (surface.culture.openness > 0.52 && width >= 15) {
      block(left + 2, eave + 3, 1, 3, '#74b8c4');
    }
  }

  // Granary modules: raised storage chests with visible golden grain level
  for (let i = 0; i < stores; i++) {
    const x = left + 2 + i * 7, y = floor - 7;
    block(x - 1, y - 1, 7, 7, outline);
    block(x, y, 5, 5, '#6e4e2e');
    block(x, y, 5, 1, '#d9b066');
    const fill = Math.max(0, Math.min(4, Math.ceil(s.food / Math.max(1, stores) / .7 * 4)));
    if (fill) {
      block(x + 1, y + 5 - fill, 3, fill, '#f2ca68');
      block(x + 1, y + 5 - fill, 3, 1, '#fff0b8');
    }
  }

  // Cistern modules: stone water tower / well on the right with bright turquoise water gauge
  for (let i = 0; i < cisterns; i++) {
    const x = 23 - i * 6, y = 18 - i * 2;
    block(x - 1, y - 1, 8, 11, outline);
    block(x, y, 6, 9, '#b8b4a6');
    block(x + 1, y + 1, 4, 7, '#22383b');
    const fill = Math.max(0, Math.min(6, Math.ceil(s.water / Math.max(1, cisterns) / .6 * 6)));
    if (fill) {
      block(x + 1, y + 8 - fill, 4, fill, '#3da5ad');
      block(x + 1, y + 8 - fill, 4, 1, '#b8f2e6');
    }
    block(x, y, 6, 1, '#e6e1d0');
    block(x, y + 8, 6, 1, '#8c897d');
    if (roofs) {
      block(left + width - 1, eave + 1, Math.max(1, x - (left + width) + 2), 2, '#5e6e68');
      block(x + 2, eave + 1, 2, Math.max(1, y - eave - 1), '#7d8f88');
    }
  }

  // Garden modules: fenced courtyard beds in front/left (never deleting the house walls!)
  for (let i = 0; i < gardens; i++) {
    const x = 1 + i * 10, y = 21;
    // Fenced enclosure with dark irrigated soil contrast
    block(x, y, 9, 8, outline);
    block(x + 1, y + 1, 7, 6, '#423122');
    // Fence posts & top rail
    block(x, y - 2, 1, 3, '#d4ad73');
    block(x + 4, y - 2, 1, 3, '#d4ad73');
    block(x + 8, y - 2, 1, 3, '#d4ad73');
    block(x, y - 1, 9, 1, '#8c6742');
    // Furrows
    for (let row = 0; row < 3; row++) {
      block(x + 1, y + 1 + row * 2, 7, 1, '#2b1e14');
    }
    // Live crops require received cultivated living ground
    const ground = surface.ground;
    if (ground && (ground.cultivation ?? 0) > .08 && ground.vegetation > .1 && (ground.growth ?? ground.vegetation) > .15) {
      const lush = ground.moisture > .3;
      for (let col = 0; col < 3; col++) {
        for (let row = 0; row < 2; row++) {
          const cx = x + 2 + col * 2, cy = y + 1 + row * 3;
          block(cx, cy - 1, 2, 2, lush ? '#68a848' : '#9eb054');
          block(cx, cy - 2, 1, 1, lush ? '#a8e070' : '#d4c86a');
        }
      }
    }
  }

  if (degraded) {
    block(left + 3, eave + 3, 1, 4, outline);
    block(left + 4, eave + 6, 2, 1, outline);
  }
  if (broken) {
    block(left + 2, 28, 5, 1, outline);
    block(left + 9, 29, 3, 1, '#7a684b');
  }
  paintMaterialFinish(g, s, [{ x0: left, w: width, west: true, east: true, ground: floor, wallTop: eave }]);
  if (s.synergy?.kilnTier === 2) {
    block(left + 3, 2, 3, 6, '#544c43'); block(left + 3, 3, 1, 4, '#e1bd87');
    block(left + 2, 1, 5, 1, '#231710'); block(left + width - 4, floor - 6, 3, 2, '#ff7a2a');
    block(left + width - 3, floor - 6, 1, 1, '#ffd27a');
  }
  (s.storedCompounds ?? []).filter(l => l.mass > 0).slice(0, 3).forEach((lot, i) => {
    const x = left + 1 + i * 4;
    block(x, floor - 3, 3, 3, '#231710'); block(x + 1, floor - 2, 2, 2, compoundHex(lot));
    block(x, floor - 3, 3, 1, mixHex(compoundHex(lot), '#ffffff', .3));
  });
}

/** Property-driven corner reinforcement and glazed eaves, shared by all building sizes. */
function paintMaterialFinish(g: CanvasRenderingContext2D, s: ExtendedStructure, fronts: Front[]): void {
  const mat = s.materialProfile;
  if (!mat) return;
  for (const f of fronts) {
    if (mat.strength >= .65) for (const x of [f.west ? f.x0 : NaN, f.east ? f.x0 + f.w - 2 : NaN]) {
      if (!Number.isFinite(x)) continue;
      for (let y = f.wallTop + 2; y < f.ground - 1; y += 4) {
        px(g, x, y, 2, 2, mixHex('#777b7c', mat.tint, .4));
        px(g, x, y, 1, 1, '#ece5d5');
      }
    }
    if (mat.seal >= .65) {
      px(g, f.x0 + 1, f.wallTop + 1, f.w - 2, 1, mixHex('#adcbd0', mat.tint, .35));
      px(g, f.x0 + 2, f.wallTop + 1, 2, 1, '#f0faf2');
    }
  }
}

/* ------------------------------------------------------------------ */
/* V23: lotes con forma (objetos, montones, cadáveres, piezas, fuego)  */
/* ------------------------------------------------------------------ */

/** Píxeles de arte por metro: un adulto de ~1,7 m ocupa ~14 px del sprite de 32. */
export const PIXELES_POR_METRO = 8;
/** kg/L con que se estima el volumen de un lote cuya sustancia aún no tiene ficha (la del agua). */
export const DENSIDAD_SUPUESTA_KG_L = 1;
// PENDIENTE_MONTON vive en shared/naturaleza.ts (integrador) y se reexporta aquí.
import { PENDIENTE_MONTON } from '../shared/naturaleza.js';
export { PENDIENTE_MONTON };
/** Fracción de `Forma.filo` a partir de la cual el filo brilla en el dibujo. */
export const FILO_VISIBLE = 0.5;
/** Fracción de `Forma.hueco` a partir de la cual se ve la boca (vasija, horno). */
export const HUECO_VISIBLE = 0.3;
/** Altura de llama (px de arte) por kg^(1/3) de combustible: la llama crece con el tamaño de la pila, no con su masa. */
export const LLAMA_PX_POR_KG13 = 6;
/** Temperatura del borde de la llama sobre la de su núcleo (el borde se mezcla con aire frío). */
export const LLAMA_BORDE_SOBRE_NUCLEO = 0.7;
/** Bocanadas de humo a la vista por cada duplicación de la masa que arde. */
export const BOCANADAS_POR_DUPLICAR = 1;
/** Segundos que tarda una bocanada en subir y deshacerse. */
export const HUMO_VIDA_S = 2.4;
/** Lienzo de un lote (px de arte) y su ancla de suelo dentro de él. */
export const LOTE_SPRITE = { w: 32, h: 36, ox: 16, oy: 30 } as const;

const MAX_LARGO = LOTE_SPRITE.w - 4, MAX_ALTO = LOTE_SPRITE.oy - 2;

/** Medidas en píxeles de arte de un lote: `largo` en el suelo, `alto` sobre él, `fondo` de la cara de arriba. */
export interface FiguraLote { largo: number; alto: number; fondo: number; filo: boolean; hueco: boolean; monton: boolean }

const pxDe = (metros: number, max: number) => Math.max(1, Math.min(max, Math.round(metros * PIXELES_POR_METRO)));

/** Figura de un lote a partir de su forma empaquetada; sin forma (montón, cadáver sin forma) sale de su masa y densidad. */
export function figuraDeLote(lote: Pick<LoteVisible, 'rol' | 'forma' | 'masa'>, densidadKgL?: number): FiguraLote {
  if (lote.forma > 0) {
    const f = formaDeCodigo(lote.forma);
    const tumbado = lote.rol === 'cadaver';
    return {
      largo: pxDe(Math.max(f.largo, f.ancho), MAX_LARGO),
      alto: pxDe(tumbado ? Math.min(f.ancho, f.grueso) : f.grueso, MAX_ALTO),
      fondo: Math.max(1, Math.min(8, Math.round(Math.min(f.largo, f.ancho) * PIXELES_POR_METRO / 2))),
      filo: f.filo >= FILO_VISIBLE, hueco: f.hueco >= HUECO_VISIBLE, monton: false,
    };
  }
  const densidad = densidadKgL && densidadKgL > 0 ? densidadKgL : DENSIDAD_SUPUESTA_KG_L;
  const volumen = Math.max(0, lote.masa) / densidad / 1000; // m³
  // Cono de pendiente p: V = π·r³·p/3 → r = ∛(3V/(π·p)).
  const radio = Math.cbrt(3 * volumen / (Math.PI * PENDIENTE_MONTON));
  const largo = pxDe(2 * radio, MAX_LARGO);
  return { largo, alto: Math.max(1, Math.min(MAX_ALTO, Math.round(largo * PENDIENTE_MONTON / 2) || 1)), fondo: 1, filo: false, hueco: false, monton: true };
}

/** Altura de la llama (px de arte) de un fuego de `masa` kg. */
export function alturaLlama(masa: number): number {
  return Math.max(3, Math.min(MAX_ALTO, Math.round(Math.cbrt(Math.max(0, masa)) * LLAMA_PX_POR_KG13)));
}

/** Clave de caché del sprite de un lote: solo lo que cambia su dibujo. `pose` solo cuenta para el fuego. */
export function claveLote(lote: LoteVisible, figura: FiguraLote, color: Rgb, pose: number): string {
  const brillo = Math.round(brilloTermico(lote.T) * 8);
  const llama = lote.rol === 'fuego' ? `${alturaLlama(lote.masa)}:${pose & 3}:${Math.round(lote.T / 100)}` : '';
  return `lote:${lote.rol}:${figura.largo}x${figura.alto}x${figura.fondo}:${figura.filo ? 1 : 0}${figura.hueco ? 1 : 0}${figura.monton ? 1 : 0}:${color.join(',')}:${brillo}:${llama}`;
}

const hex = (c: Rgb, a?: number): string => a === undefined
  ? `#${((1 << 24) | (Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2])).toString(16).slice(1)}`
  : `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a.toFixed(3)})`;
const tono = (c: Rgb, k: number): Rgb => k >= 0
  ? [c[0] + (255 - c[0]) * k, c[1] + (255 - c[1]) * k, c[2] + (255 - c[2]) * k]
  : [c[0] * (1 + k), c[1] * (1 + k), c[2] * (1 + k)];
const TINTA: Rgb = [35, 23, 16];

/**
 * Pinta un lote con su pie en (`ax`, `ay`): caja de su color con cara de arriba más clara y contorno de tinta; el filo es una
 * línea de luz, el hueco una boca oscura (o encendida si está caliente), la pieza de obra lleva juntas y el cadáver yace.
 * Lo caliente se tiñe con su color de cuerpo negro. El fuego se pinta con `paintFuego`.
 */
export function paintLote(g: CanvasRenderingContext2D, lote: LoteVisible, figura: FiguraLote, color: Rgb, ax: number, ay: number): void {
  const propio: Rgb = lote.rol === 'cadaver' ? tono(color, -.22) : color;
  const visto = colorTermico(propio, lote.T), brillo = brilloTermico(lote.T);
  const { largo, alto, fondo } = figura;
  const x0 = Math.round(ax - largo / 2), base = Math.round(ay);
  if (brillo > 0) px(g, x0 - 2, base - alto - fondo - 2, largo + 4, alto + fondo + 3, hex(colorCuerpoNegro(lote.T), .18 + .3 * brillo));
  if (figura.monton) {
    // Hileras cada vez más cortas, con motas de luz deterministas: un montón suelto, no un bloque.
    for (let r = 0; r < alto; r++) {
      const ancho = Math.max(1, Math.round(largo * (1 - r / (alto + 1)))), x = Math.round(ax - ancho / 2), y = base - 1 - r;
      px(g, x - 1, y, ancho + 2, 1, hex(TINTA));
      px(g, x, y, ancho, 1, hex(r === alto - 1 ? tono(visto, .18) : visto));
      for (let i = 0; i < ancho; i += 2) if (hash3(x + i, y, 271) % 5 === 0) px(g, x + i, y, 1, 1, hex(tono(visto, (hash3(x + i, y, 272) & 1) ? .25 : -.25)));
    }
    return;
  }
  const top = base - alto;
  px(g, x0 - 1, top - fondo - 1, largo + 2, alto + fondo + 2, hex(TINTA));
  px(g, x0, top - fondo, largo, fondo, hex(tono(visto, .2)));
  px(g, x0, top, largo, alto, hex(visto));
  if (alto >= 2) px(g, x0, base - 1, largo, 1, hex(tono(visto, -.25)));
  if (lote.rol === 'pieza' && alto >= 4) {
    // Juntas de la obra: hiladas cada 3 px, trabadas.
    for (let y = top + 3, fila = 0; y < base - 1; y += 3, fila++) {
      px(g, x0, y, largo, 1, hex(tono(visto, -.3)));
      for (let x = x0 + (fila & 1 ? 2 : 4); x < x0 + largo; x += 5) px(g, x, y - 2, 1, 2, hex(tono(visto, -.3)));
    }
  }
  if (lote.rol === 'cadaver' && largo >= 4) {
    // Costillar claro sobre el lomo: se lee como cuerpo tendido, no como tronco.
    for (let x = x0 + 1; x < x0 + largo - 1; x += 2) px(g, x, top, 1, 1, hex(tono(visto, .3)));
  }
  if (figura.filo) px(g, x0, top - fondo, largo, 1, hex(tono(visto, .55)));
  if (figura.hueco && largo >= 3 && alto >= 3) {
    const boca: Rgb = brillo > 0 ? colorCuerpoNegro(lote.T) : tono(visto, -.6);
    const bw = Math.max(1, largo - 2), bh = Math.max(1, Math.min(alto - 1, Math.round(alto / 2)));
    px(g, x0 + 1, base - 1 - bh, bw, bh, hex(boca));
    if (brillo > 0) px(g, x0 + 1 + (bw >> 1), base - 1 - bh, 1, 1, hex(tono(boca, .6)));
  }
}

/** Llama de un fuego: lenguas que titilan por `pose` sobre la pila de combustible, con núcleo del color de cuerpo negro de su T. */
export function paintFuego(g: CanvasRenderingContext2D, lote: LoteVisible, combustible: Rgb, ax: number, ay: number, pose: number): void {
  const alto = alturaLlama(lote.masa), ancho = Math.max(3, Math.min(MAX_LARGO, Math.round(alto * .8)));
  const x0 = Math.round(ax - ancho / 2), base = Math.round(ay);
  const nucleo = colorCuerpoNegro(lote.T), borde = colorCuerpoNegro(lote.T * LLAMA_BORDE_SOBRE_NUCLEO);
  px(g, x0 - 1, base - 2, ancho + 2, 3, hex(TINTA));
  px(g, x0, base - 1, ancho, 2, hex(tono(combustible, -.35)));
  px(g, x0 - 2, base - alto - 2, ancho + 4, alto + 2, hex(nucleo, .16));
  for (let i = 0; i < ancho; i++) {
    const centro = 1 - Math.abs((i + .5) / ancho - .5) * 2;
    const lengua = Math.max(1, Math.round(alto * (.35 + .65 * centro) * (.75 + (hash3(i, pose & 3, 281) % 6) / 20)));
    px(g, x0 + i, base - 1 - lengua, 1, lengua, hex(borde));
    const dentro = Math.round(lengua * .6);
    if (dentro > 0) px(g, x0 + i, base - 1 - dentro, 1, dentro, hex(nucleo));
  }
  px(g, Math.round(ax), base - 2, 1, 1, hex(tono(nucleo, .7)));
}

/** Bocanadas de humo de un fuego en el instante `t` (s): posición relativa al pie (px de arte), lado y opacidad. Pura. */
export function humoDeFuego(lote: Pick<LoteVisible, 'x' | 'y' | 'masa'>, t: number): { dx: number; dy: number; lado: number; alfa: number }[] {
  const n = Math.max(1, Math.round(Math.log2(1 + Math.max(0, lote.masa)) * BOCANADAS_POR_DUPLICAR));
  const alto = alturaLlama(lote.masa), out: { dx: number; dy: number; lado: number; alfa: number }[] = [];
  for (let i = 0; i < n; i++) {
    const fase = ((t / HUMO_VIDA_S) + i / n + (hash3(lote.x, lote.y, 291 + i) % 97) / 97) % 1;
    const deriva = ((hash3(lote.x, lote.y, 301 + i) % 7) - 3) * fase;
    out.push({ dx: Math.round(deriva), dy: -Math.round(alto + fase * (alto + 14)), lado: 2 + Math.round(fase * 3), alfa: .45 * (1 - fase) });
  }
  return out;
}
