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

/** Caja de teselas que ocupa la estructura (1×1 si el servidor no manda planta). */
export function footprintBox(s: ExtendedStructure): { x0: number; y0: number; w: number; h: number } {
  const fp = s.footprint;
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

/** «2×1», «2×2»…; vacío sin planta. */
export function footprintLabel(s: ExtendedStructure): string {
  const fp = s.footprint;
  if (!fp || (!('width' in fp) && !fp.length)) return '';
  const box = footprintBox(s);
  return `${box.w}×${box.h}`;
}

/** Casillas que ocupa, para que nada más (p. ej. una choza de terreno) se dibuje debajo. */
export function footprintCells(s: ExtendedStructure): readonly FootprintCell[] {
  const fp = s.footprint;
  if (fp && !('width' in fp)) return fp.length ? fp : [{ x: s.x, y: s.y }];
  const box = footprintBox(s), out: FootprintCell[] = [];
  for (let dy = 0; dy < box.h; dy++) for (let dx = 0; dx < box.w; dx++) out.push({ x: box.x0 + dx, y: box.y0 + dy });
  return out;
}

export type StructureTier = 'hut' | 'hall' | 'grand';
/** Salón mediano (2×1 o 3–4 marcos) y recinto grande (2×2 o ≥ 5 marcos); la planta real manda sobre los marcos. */
export function structureTier(s: ExtendedStructure): StructureTier {
  const box = footprintBox(s), area = box.w * box.h;
  if (area >= 4) return 'grand';
  if (area >= 2) return 'hall';
  const frames = s.components.filter(c => c === 'frame').length;
  return frames >= 5 ? 'grand' : frames >= 3 ? 'hall' : 'hut';
}

/** ¿Se dibuja como un solo edificio unificado de varias casillas (en vez del sprite de 1×1)? */
export const isModular = (s: ExtendedStructure): boolean => !s.site && footprintBox(s).w * footprintBox(s).h > 1;

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
  const foot = (box.y0 + box.h - 1) * ART + 13, height = s.site ? 24 : tier === 'grand' ? 36 : tier === 'hall' ? 28 : 29;
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
  const box = footprintBox(s), tier = structureTier(s), grand = tier === 'grand';
  const left = box.x0 * ART, W = box.w * ART, right = left + W, ground = (box.y0 + box.h - 1) * ART + 13;
  const worn = s.condition < .3, foundation = grand ? 4 : 3, wallH = grand ? 13 : 11, roofH = 8 + (box.h - 1) * 8;
  const wallTop = ground - foundation - wallH;
  px(g, left - 2, ground - 1, W + 4, 3, K.shadow);
  // cimiento de mampostería con juntas
  px(g, left - 1, ground - foundation, W + 2, foundation, K.stone); px(g, left - 1, ground - foundation, W + 2, 1, '#e6e0cf');
  for (let i = 0; i < Math.ceil(W / 5); i++) px(g, left + i * 5 + (i % 2 ? 2 : 0), ground - foundation + 1, 1, foundation - 1, K.stoneShade);
  // muros: entramado de madera
  px(g, left, wallTop, W, wallH, K.wall); px(g, right - 4, wallTop, 4, wallH, K.wallShade);
  px(g, left, wallTop, W, 1, K.timber); px(g, left, wallTop + Math.round(wallH / 2), W, 1, K.timberLight);
  const bay = 8, bays = Math.max(2, Math.round(W / bay));
  for (let i = 0; i <= bays; i++) px(g, Math.min(right - 1, left + i * (W / bays)), wallTop, 1, wallH, K.timber);
  // tejado a dos aguas con hileras alternas y viga cumbrera
  const rowsMax = roofH;
  for (let r = 0; r < roofH; r++) {
    const inset = Math.floor(r * (W / 2 - 2) / rowsMax);
    px(g, left - 2 + inset, wallTop - 1 - r, W + 4 - inset * 2, 1, worn ? K.thatchWeathered : r % 3 === 0 ? K.roofLight : r % 3 === 1 ? K.roof : K.roofDark);
  }
  const ridgeY = wallTop - roofH;
  px(g, left + Math.round(W / 2) - 6, ridgeY, 12, 1, K.timber); px(g, left + Math.round(W / 2) - 6, ridgeY - 1, 12, 1, K.timberLight);
  // contrafuertes laterales y de centro (salón grande)
  for (const bx of grand ? [left - 3, Math.round((left + right) / 2) - 1, right + 1] : [left - 3, right + 1]) { px(g, bx, wallTop + 2, 2, wallH + foundation - 2, K.stone); px(g, bx, wallTop + 2, 1, wallH + foundation - 2, '#e6e0cf'); px(g, bx - 1, ground - 2, 4, 2, K.stoneShade); }
  // puerta, ventanas y umbral del patio
  const mid = Math.round((left + right) / 2);
  px(g, mid - 3, ground - foundation - 8, 6, 8, K.door); px(g, mid - 4, ground - foundation - 9, 8, 1, K.timber); px(g, mid - 3, ground - foundation - 8, 6, 1, '#231710');
  px(g, mid - 5, ground, 10, 2, K.soil); px(g, mid - 4, ground + 2, 8, 1, K.soil);
  for (let i = 0; i < bays; i++) { const wx = left + 2 + i * (W / bays); if (Math.abs(wx + 1 - mid) > 5) { px(g, wx, wallTop + 3, 3, 3, K.glow); px(g, wx, wallTop + 3, 3, 1, K.timber); } }
  // componentes visibles
  const comps = s.components;
  if (comps.includes('hearth')) {
    const cx = left + Math.round(W * .22);
    px(g, cx, ridgeY - 6, 3, 8, K.stoneShade); px(g, cx - 1, ridgeY - 7, 5, 1, K.stoneDark); px(g, cx, ridgeY - 6, 1, 8, K.stone);
    if (animate) { const u = (t * .9) % 1; px(g, cx + 1 + Math.round(Math.sin(t * 2) * 1), ridgeY - 9 - Math.round(u * 7), 2, 2, K.smoke); }
  }
  let basin: { x: number; y: number; w: number } | null = null;
  if (comps.includes('cistern')) {
    const cisterns = comps.filter(c => c === 'cistern').length, level = clamp01(s.water / Math.max(1, cisterns) / .6);
    basin = { x: right - 14, y: ground + 1, w: 12 };
    px(g, basin.x - 1, basin.y, basin.w + 2, 5, K.stoneShade); px(g, basin.x, basin.y + 1, basin.w, 3, level > 0 ? K.water : K.door);
    if (level > .15) px(g, basin.x + 2 + (animate ? Math.floor(t * 2) % 3 : 0), basin.y + 1, 3, 1, K.waterGleam);
  }
  if (comps.includes('granary')) {
    const granaries = comps.filter(c => c === 'granary').length, fill = clamp01(s.food / Math.max(1, granaries) / .7);
    for (let i = 0; i < Math.min(3, box.w + (grand ? 1 : 0)); i++) {
      const bx = left + 3 + i * Math.floor((W - 8) / Math.max(1, Math.min(3, box.w + (grand ? 1 : 0)))) ;
      if (Math.abs(bx + 2 - mid) < 6) continue;
      px(g, bx, ground - foundation - 5, 5, 5, K.timber); px(g, bx + 1, ground - foundation - 4, 3, 4, K.door);
      if (fill > 0) px(g, bx + 1, ground - foundation - 1 - Math.round(fill * 3), 3, Math.max(1, Math.round(fill * 3)), K.food);
    }
  }
  if (worn) for (let i = 0; i < 4; i++) px(g, left + 3 + (hash3(s.x, s.y, 50 + i) % Math.max(1, W - 6)), wallTop + 1 + (i * 3) % wallH, 1, 2, K.stoneDark);
  // bodega de materiales, junto a la puerta de carga
  const wood = stockLevel(s.storedWood), stone = stockLevel(s.storedStone);
  if (wood) paintCordwood(g, left + 2, ground + 3, wood, false);
  if (stone) paintStonePallet(g, left + Math.round(W * .52), ground + 3, stone, false);
  paintInstalled(g, s, left, right, wallTop, ground, basin);
}

/**
 * Accesorios sobre el sprite de una estructura de 1×1 (cabaña/choza): existencias de la bodega a su lado y herrajes de
 * las piezas instaladas. `left`, `ground`: esquina inferior izquierda de su casilla en píxeles de arte.
 */
export function paintCompactAccessories(g: CanvasRenderingContext2D, s: ExtendedStructure): void {
  const left = s.x * ART, ground = s.y * ART + 13, wood = stockLevel(s.storedWood), stone = stockLevel(s.storedStone);
  if (wood) paintCordwood(g, left - 7, ground + 2, wood, true);
  if (stone) paintStonePallet(g, left + 14, ground + 2, stone, true);
  if (installedCount(s)) paintInstalled(g, s, left + 2, left + 14, ground - 22, ground, s.components.includes('cistern') ? { x: left + 8, y: ground - 3, w: 6 } : null);
}
