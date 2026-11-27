/**
 * V24 — Interactive Real Discovered-Terrain Minimap Canvas.
 * Renders all discovered chunks (4×4 palette blocks = true coastlines, forests, roads, settlements),
 * live S/I & community markers, active camera viewport box, and click/drag teleportation!
 */
import { MINIMAP_PALETTE, type WorldMapResponse } from '../shared/worldmap.js';
import type { Viewport } from '../shared/types.js';

export interface MinimapProjection {
  minX: number;
  minY: number;
  spanX: number;
  spanY: number;
  scale: number;
  offsetX: number;
  offsetY: number;
}

const CHUNK_TILES = 16;

/** Compute aspect-preserving world-to-canvas transform for the discovered world bounds. */
export function minimapProjection(
  map: Pick<WorldMapResponse, 'bounds'>,
  canvasWidth: number,
  canvasHeight: number,
  padding = 6,
): MinimapProjection {
  const minX = map.bounds.minCx * CHUNK_TILES;
  const minY = map.bounds.minCy * CHUNK_TILES;
  const maxX = (map.bounds.maxCx + 1) * CHUNK_TILES;
  const maxY = (map.bounds.maxCy + 1) * CHUNK_TILES;
  const spanX = Math.max(CHUNK_TILES, maxX - minX);
  const spanY = Math.max(CHUNK_TILES, maxY - minY);
  const usableW = Math.max(8, canvasWidth - padding * 2);
  const usableH = Math.max(8, canvasHeight - padding * 2);
  const scale = Math.min(usableW / spanX, usableH / spanY);
  const drawW = spanX * scale;
  const drawH = spanY * scale;
  return {
    minX,
    minY,
    spanX,
    spanY,
    scale,
    offsetX: (canvasWidth - drawW) * 0.5,
    offsetY: (canvasHeight - drawH) * 0.5,
  };
}

/** Convert a canvas CSS pixel click/drag position into exact integer world tile coordinates. */
export function minimapPixelToWorld(
  px: number,
  py: number,
  proj: MinimapProjection,
): { x: number; y: number } {
  const worldX = proj.minX + (px - proj.offsetX) / Math.max(1e-6, proj.scale);
  const worldY = proj.minY + (py - proj.offsetY) / Math.max(1e-6, proj.scale);
  return {
    x: Math.round(Math.max(proj.minX, Math.min(proj.minX + proj.spanX, worldX))),
    y: Math.round(Math.max(proj.minY, Math.min(proj.minY + proj.spanY, worldY))),
  };
}

/** Render the discovered-terrain minimap, markers, and live viewport rectangle onto a 2D canvas. */
export function renderMinimap(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  map: WorldMapResponse,
  viewport: Viewport | null,
): MinimapProjection {
  const proj = minimapProjection(map, width, height);
  ctx.fillStyle = '#0f1b19';
  ctx.fillRect(0, 0, width, height);

  const cellWorld = CHUNK_TILES / 4; // 4 tiles per nibble
  const cellPx = Math.max(1, Math.ceil(cellWorld * proj.scale));

  for (let i = 0; i < map.chunks.length; i++) {
    const ch = map.chunks[i]!;
    const baseWx = ch.cx * CHUNK_TILES;
    const baseWy = ch.cy * CHUNK_TILES;
    const cells = ch.cells;
    for (let idx = 0; idx < 16 && idx < cells.length; idx++) {
      const nibble = Number.parseInt(cells.charAt(idx), 16);
      const color = MINIMAP_PALETTE[Number.isFinite(nibble) && nibble >= 0 && nibble < MINIMAP_PALETTE.length ? nibble : 15]!;
      const lx = idx & 3;
      const ly = idx >> 2;
      const sx = Math.floor(proj.offsetX + (baseWx + lx * cellWorld - proj.minX) * proj.scale);
      const sy = Math.floor(proj.offsetY + (baseWy + ly * cellWorld - proj.minY) * proj.scale);
      ctx.fillStyle = color;
      ctx.fillRect(sx, sy, cellPx, cellPx);
    }
    if (ch.active) {
      const ax = Math.floor(proj.offsetX + (baseWx - proj.minX) * proj.scale);
      const ay = Math.floor(proj.offsetY + (baseWy - proj.minY) * proj.scale);
      const aw = Math.max(2, Math.ceil(CHUNK_TILES * proj.scale));
      ctx.strokeStyle = 'rgba(247, 242, 231, 0.14)';
      ctx.lineWidth = 1;
      ctx.strokeRect(ax + 0.5, ay + 0.5, aw, aw);
    }
  }

  // Draw markers: communities, herds, whispers, and S/I on top
  for (const marker of map.markers) {
    const mx = proj.offsetX + (marker.x - proj.minX) * proj.scale;
    const my = proj.offsetY + (marker.y - proj.minY) * proj.scale;
    if (marker.kind === 'community') {
      ctx.fillStyle = marker.color || '#eab664';
      ctx.beginPath();
      ctx.arc(mx, my, Math.min(4.5, 2 + Math.sqrt(marker.count ?? 1) * 0.35), 0, Math.PI * 2);
      ctx.fill();
    } else if (marker.kind === 'herd') {
      ctx.fillStyle = '#c4e39b';
      ctx.fillRect(Math.round(mx) - 1, Math.round(my) - 1, 3, 3);
    } else if (marker.kind === 'whisper') {
      ctx.strokeStyle = '#9be8ff';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(mx, my, 4, 0, Math.PI * 2);
      ctx.stroke();
    } else if (marker.kind === 'S' || marker.kind === 'I') {
      ctx.fillStyle = marker.kind === 'S' ? '#f5b841' : '#f07c65';
      ctx.strokeStyle = '#1b1410';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(mx, my, 3.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // Live camera viewport rectangle
  if (viewport) {
    const vx = proj.offsetX + (viewport.x - proj.minX) * proj.scale;
    const vy = proj.offsetY + (viewport.y - proj.minY) * proj.scale;
    const vw = Math.max(5, viewport.width * proj.scale);
    const vh = Math.max(4, viewport.height * proj.scale);
    ctx.strokeStyle = '#f7f2e7';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(vx, vy, vw, vh);
    ctx.fillStyle = 'rgba(247, 242, 231, 0.10)';
    ctx.fillRect(vx, vy, vw, vh);
  }

  return proj;
}

export interface MinimapController {
  updateMap(map: WorldMapResponse): void;
  updateViewport(viewport: Viewport): void;
  destroy(): void;
}

/** Mount interactive click/drag-to-teleport terrain minimap onto an existing canvas element. */
export function mountMinimap(
  canvas: HTMLCanvasElement,
  onTeleport: (x: number, y: number) => void,
): MinimapController {
  const ctx = canvas.getContext('2d');
  let currentMap: WorldMapResponse | null = null;
  let currentViewport: Viewport | null = null;
  let lastProj: MinimapProjection | null = null;
  let dragging = false;
  // El terreno descubierto no depende de la cámara. Mover el recuadro no vuelve a pintar cada región.
  let base: HTMLCanvasElement | null = null;
  let baseMap: WorldMapResponse | null = null;
  let baseW = 0;
  let baseH = 0;

  const size = (): { w: number; h: number } => {
    const rect = canvas.getBoundingClientRect();
    return {
      w: Math.max(120, Math.round(rect.width || canvas.width || 220)),
      h: Math.max(90, Math.round(rect.height || canvas.height || 150)),
    };
  };

  const paintBase = (w: number, h: number): void => {
    if (!currentMap) return;
    if (!base) base = document.createElement('canvas');
    if (base.width !== w || base.height !== h) { base.width = w; base.height = h; }
    const baseCtx = base.getContext('2d');
    if (!baseCtx) return;
    lastProj = renderMinimap(baseCtx, w, h, currentMap, null);
    baseMap = currentMap;
    baseW = w;
    baseH = h;
  };

  const strokeViewport = (): void => {
    if (!ctx || !lastProj || !currentViewport) return;
    const proj = lastProj;
    const vx = proj.offsetX + (currentViewport.x - proj.minX) * proj.scale;
    const vy = proj.offsetY + (currentViewport.y - proj.minY) * proj.scale;
    const vw = Math.max(5, currentViewport.width * proj.scale);
    const vh = Math.max(4, currentViewport.height * proj.scale);
    ctx.strokeStyle = '#f7f2e7';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(vx, vy, vw, vh);
    ctx.fillStyle = 'rgba(247, 242, 231, 0.10)';
    ctx.fillRect(vx, vy, vw, vh);
  };

  const draw = (mapChanged: boolean) => {
    if (!ctx || !currentMap) return;
    const { w, h } = size();
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    if (mapChanged || !base || baseMap !== currentMap || baseW !== w || baseH !== h) paintBase(w, h);
    if (!base) return;
    ctx.drawImage(base, 0, 0);
    strokeViewport();
  };

  const teleportFromEvent = (ev: PointerEvent) => {
    if (!lastProj) return;
    const rect = canvas.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return;
    const px = ((ev.clientX - rect.left) / rect.width) * canvas.width;
    const py = ((ev.clientY - rect.top) / rect.height) * canvas.height;
    const target = minimapPixelToWorld(px, py, lastProj);
    onTeleport(target.x, target.y);
  };

  const onDown = (ev: PointerEvent) => {
    if (ev.button !== 0) return;
    dragging = true;
    canvas.setPointerCapture?.(ev.pointerId);
    teleportFromEvent(ev);
  };
  const onMove = (ev: PointerEvent) => {
    if (!dragging) return;
    teleportFromEvent(ev);
  };
  const onUp = () => { dragging = false; };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  return {
    updateMap(map) { currentMap = map; draw(true); },
    updateViewport(vp) { currentViewport = vp; draw(false); },
    destroy() {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      if (base) { base.width = base.height = 0; base = null; }
    },
  };
}
