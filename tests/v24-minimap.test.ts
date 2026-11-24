import test from 'node:test';
import assert from 'node:assert/strict';
import { minimapPixelToWorld, minimapProjection, renderMinimap } from '../src/client/minimap.js';
import type { WorldMapResponse } from '../src/shared/worldmap.js';

function sampleMap(): WorldMapResponse {
  return {
    tick: 1200,
    day: 2,
    discoveredChunks: 4,
    activeChunks: 2,
    bounds: { minCx: -1, maxCx: 0, minCy: -1, maxCy: 0 },
    chunks: [
      { cx: -1, cy: -1, cells: '0000011003430393', active: true },
      { cx: 0, cy: -1, cells: '3344344477889933', active: true },
      { cx: -1, cy: 0, cells: '2222226622663333', active: false },
      { cx: 0, cy: 0, cells: '3333377338833993', active: false },
    ],
    markers: [
      { kind: 'S', id: 's', name: 'S', x: 4, y: -4 },
      { kind: 'I', id: 'i', name: 'I', x: -3, y: 2 },
      { kind: 'community', id: 'c1', name: 'Alba', x: 5, y: -5, color: '#e8a848', count: 14 },
      { kind: 'whisper', id: 'w1', name: 'Viaje', x: -8, y: 6 },
    ],
  };
}

test('minimapProjection and minimapPixelToWorld round-trip center and corners accurately', () => {
  const map = sampleMap();
  const proj = minimapProjection(map, 220, 160);
  // World spans [-16, 16) in X and [-16, 16) in Y => center (0, 0) maps to (110, 80)
  const center = minimapPixelToWorld(110, 80, proj);
  assert.deepEqual(center, { x: 0, y: 0 });
  const topLeft = minimapPixelToWorld(proj.offsetX, proj.offsetY, proj);
  assert.deepEqual(topLeft, { x: -16, y: -16 });
  const bottomRight = minimapPixelToWorld(proj.offsetX + proj.spanX * proj.scale, proj.offsetY + proj.spanY * proj.scale, proj);
  assert.deepEqual(bottomRight, { x: 16, y: 16 });
});

test('renderMinimap draws terrain nibbles, markers, active chunk outlines, and viewport box cleanly', () => {
  const ops: string[] = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    fillRect: (x: number, y: number, w: number, h: number) => ops.push(`fillRect:${x},${y},${w},${h}`),
    strokeRect: () => ops.push('strokeRect'),
    beginPath: () => {},
    arc: () => ops.push('arc'),
    fill: () => ops.push('fill'),
    stroke: () => ops.push('stroke'),
  } as unknown as CanvasRenderingContext2D;

  const proj = renderMinimap(ctx, 220, 150, sampleMap(), { x: -8, y: -6, width: 24, height: 16 });
  assert.ok(proj.scale > 0);
  // 1 background + 4*16 chunk cells + 1 viewport fill = 66 fillRects
  const fillRects = ops.filter(o => o.startsWith('fillRect:')).length;
  assert.equal(fillRects, 66);
  // 2 active chunks + 1 viewport rect = 3 strokeRects
  assert.equal(ops.filter(o => o === 'strokeRect').length, 3);
  // S, I, community, whisper = 4 arcs
  assert.equal(ops.filter(o => o === 'arc').length, 4);
});
