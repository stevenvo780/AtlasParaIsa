/**
 * V19 — arquitectura modular visual: obras en construcción, salones de varias casillas, bodega de materiales y
 * piezas técnicas instaladas.
 *
 * Presentación pura sobre campos opcionales de `StructureView` que el servidor v19 añade (`footprint`, `site`,
 * `installed`, `storedWood`, `storedStone`). Se leen con un tipo estructural LOCAL: este módulo no depende de que
 * `shared/life.ts` ya los declare y, si lo hace con la misma forma, sigue compilando sin cambios.
 */
import type { StructureView } from '../shared/life.js';
import { hash3 } from './terrain-field.js';

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

export interface StructurePalette { wall: string; wallShade: string; wallLight: string; roof: string; roofLight: string; roofDark: string; thatchWeathered: string }
/** Paleta de muros y tejado mezclada con el tinte del perfil material (arcilla, caliza, hierro…); sin perfil, la base. */
export function structurePalette(s: ExtendedStructure): StructurePalette {
  const tint = s.materialProfile?.tint;
  if (!tint || !parseHex(tint)) return { wall: K.wall, wallShade: K.wallShade, wallLight: K.wallLight, roof: K.roof, roofLight: K.roofLight, roofDark: K.roofDark, thatchWeathered: K.thatchWeathered };
  return {
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
function paintV20Accents(g: CanvasRenderingContext2D, s: ExtendedStructure, L: AccentLayout, t: number, animate: boolean): void {
  const syn = s.synergy, fronts = L.fronts, door = L.door;
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
  if (syn && kilnLit) {
    const hot = tier === 2, ex = L.doorX + 4, ey = door.ground - 8;
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
  const lots = (s.storedCompounds ?? []).filter(l => l.mass > 0).sort((a, b) => b.mass - a.mass).slice(0, 6);
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
    px(g, left, f.ground - 3, width, 3, K.stone); px(g, left, f.ground - 3, width, 1, '#e6e0cf');
    for (let i = 0; i < Math.ceil(width / 5); i++) px(g, left + i * 5 + (i % 2 ? 2 : 0), f.ground - 2, 1, 2, K.stoneShade);
    px(g, f.x0, f.wallTop, f.w, 8, pal.wall); if (f.east) px(g, f.x0 + f.w - 4, f.wallTop, 4, 8, pal.wallShade);
    px(g, f.x0, f.wallTop, f.w, 1, K.timber); px(g, f.x0, f.wallTop + 4, f.w, 1, K.timberLight);
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
    px(g, cx, ty - 5, 3, 8, K.stoneShade); px(g, cx - 1, ty - 6, 5, 1, K.stoneDark); px(g, cx, ty - 5, 1, 8, K.stone);
    topY = Math.min(topY, ty - 6);
    if (animate) { const u = (t * .9) % 1; px(g, cx + 1 + Math.round(Math.sin(t * 2)), ty - 8 - Math.round(u * 7), 2, 2, K.smoke); }
  }
  const byX = [...fronts].sort((a, b) => a.x0 - b.x0), right = byX[byX.length - 1]!, leftmost = byX[0]!;
  let basin: { x: number; y: number; w: number } | null = null;
  if (comps.includes('cistern')) {
    const cisterns = comps.filter(c => c === 'cistern').length, level = clamp01(s.water / Math.max(1, cisterns) / .6);
    basin = { x: right.x0 + 2, y: right.ground + 1, w: 12 };
    px(g, basin.x - 1, basin.y, basin.w + 2, 5, K.stoneShade); px(g, basin.x, basin.y + 1, basin.w, 3, level > 0 ? K.water : K.door);
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
  if (!s.synergy && !s.storedCompounds?.length) return;
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
export function paintCompactAccessories(g: CanvasRenderingContext2D, s: ExtendedStructure, t = 0, animate = false): void {
  const left = s.x * ART, ground = s.y * ART + 13, wood = stockLevel(s.storedWood), stone = stockLevel(s.storedStone);
  const tint = s.materialProfile?.tint;
  if (tint && parseHex(tint)) { // el sprite en caché no conoce el material: se le superpone un velo del tinte sobre el muro
    px(g, left + 2, ground - 14, 12, 11, `rgba(${parseHex(tint)!.join(',')},.3)`);
  }
  if (wood) paintCordwood(g, left - 7, ground + 2, wood, true);
  if (stone) paintStonePallet(g, left + 14, ground + 2, stone, true);
  if (installedCount(s)) paintInstalled(g, s, left + 2, left + 14, ground - 22, ground, s.components.includes('cistern') ? { x: left + 8, y: ground - 3, w: 6 } : null);
  if (s.synergy || s.storedCompounds?.length) {
    const front: Front = { x0: left, w: ART, west: true, east: true, ground, wallTop: ground - 15 };
    paintV20Accents(g, s, { fronts: [front], door: front, doorX: left + 8, doorTop: ground - 12, topY: ground - 26, smokeX: left + 10 }, t, animate);
  }
}
