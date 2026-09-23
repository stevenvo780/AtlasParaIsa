import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { createBrowserTestServer as createServer } from './lib/vite.js';
import { getTerrainAtlas, terrainAtlasWindow } from '../src/client/terrain-atlas.js';

test('neighbouring tiles in one ecological bucket read distinct atlas windows', () => {
  const cell = { sx: 24, sy: 48 };
  const left = terrainAtlasWindow(cell, 0, 0), right = terrainAtlasWindow(cell, 1, 0);
  assert.notDeepEqual(left, right);
  for (const source of [left, right]) {
    assert.ok(source.sx >= cell.sx && source.sx + 16 <= cell.sx + 24);
    assert.ok(source.sy >= cell.sy && source.sy + 16 <= cell.sy + 24);
  }
});

test('atlas margins wrap every shifted terrain window inside its own cell', () => {
  const originalDocument = globalThis.document;
  let pixels: Uint8ClampedArray<ArrayBufferLike> = new Uint8ClampedArray();
  const canvas = { width: 0, height: 0, getContext: () => ({
    createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    putImageData: (image: { data: Uint8ClampedArray }) => { pixels = image.data; },
  }) } as unknown as HTMLCanvasElement;
  globalThis.document = { createElement: () => canvas } as unknown as Document;
  try {
    const atlas = getTerrainAtlas();
    assert.ok(atlas.canvas.width * atlas.canvas.height * 4 < 20 * 1024 * 1024);
    const sample = (x: number, y: number) => Array.from(pixels.slice((y * atlas.canvas.width + x) * 4, (y * atlas.canvas.width + x) * 4 + 4));
    for (const cell of [atlas.soil('grassland', 0, 6, 6), atlas.leaf('grassland', 0, 6, 6), atlas.water(1, 0)]) {
      for (let offsetY = 0; offsetY < 8; offsetY++) for (let offsetX = 0; offsetX < 8; offsetX++) {
        for (let v = 0; v < 16; v++) for (let u = 0; u < 16; u++) {
          assert.deepEqual(sample(cell.sx + offsetX + u, cell.sy + offsetY + v),
            sample(cell.sx + ((offsetX + u) & 15), cell.sy + ((offsetY + v) & 15)));
        }
      }
    }
  } finally {
    if (originalDocument) globalThis.document = originalDocument;
    else delete (globalThis as { document?: Document }).document;
  }
});

test('terrain atlas and biome contacts use palette colours exactly', { timeout: 60_000 }, async t => {
  if (!existsSync(chromium.executablePath())) { t.skip('Chromium absent: atlas palette raster not inspected.'); return; }
  const server = await createServer(); await server.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 }, reducedMotion: 'reduce' });
    await page.addInitScript('window.__name = value => value');
    await page.route('**/__atlas_palette.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><canvas></canvas>' }));
    await page.goto(new URL('__atlas_palette.html', server.resolvedUrls!.local[0]).href);
    const result = await page.evaluate(async () => {
      const landscapePath = '/src/client/landscape.ts', palettePath = '/src/client/paleta.ts';
      const { Landscape } = await import(/* @vite-ignore */ landscapePath);
      const { PALETA_PLANA } = await import(/* @vite-ignore */ palettePath);
      const renderer = new Landscape(document.querySelector('canvas')!, () => {});
      const columns = ['grassland', 'forest', 'wetland', 'ocean', 'desert', 'mountain'] as const;
      const width = columns.length, height = 4;
      const tiles = Array.from({ length: width * height }, (_, index) => {
        const x = index % width, y = Math.floor(index / width), biome = columns[x]!;
        return { x, y, terrain: biome === 'ocean' ? 'water' : 'meadow', biome, feature: 'none', moisture: (x + y) / 8,
          fertility: (x * 2 + y) / 14, vegetation: .35 + y * .15, growth: .7, food: 0, wood: 0, stone: 0,
          traffic: 0, cultivation: 0, drinkingWater: 0 };
      });
      renderer.update({ version: 10, sequence: 1, tick: 1, phase: 'day', day: 1, weather: 'clear', width, height,
        originX: 0, originY: 0, tiles, people: [], animals: [], structures: [], places: [], memories: [], events: [] });
      const canvas = document.createElement('canvas'); canvas.width = width * 16; canvas.height = height * 16;
      const g = canvas.getContext('2d')!;
      for (const tile of tiles) renderer.bakeTileBase(g, tile.x, tile.y);
      for (const tile of tiles) renderer.bakeCoast(g, tile.x, tile.y);
      const palette = new Set(PALETA_PLANA.map(([, hex]: readonly [string, string]) => Number.parseInt(hex.slice(1), 16)));
      const data = g.getImageData(0, 0, canvas.width, canvas.height).data;
      const invalid: Array<{ x: number; y: number; rgb: number }> = [];
      const contactInvalid: Array<{ x: number; y: number; rgb: number }> = [];
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const offset = (y * canvas.width + x) * 4; if (data[offset + 3] === 0) continue;
        const rgb = (data[offset]! << 16) | (data[offset + 1]! << 8) | data[offset + 2]!;
        if (!palette.has(rgb)) {
          if (invalid.length < 12) invalid.push({ x, y, rgb });
          // Bosque ocupa x=16..31 y humedal x=32..47; la transición mide 3 px por lado.
          if (x >= 29 && x <= 34 && contactInvalid.length < 12) contactInvalid.push({ x, y, rgb });
        }
      }
      renderer.destroy();
      return { invalid, contactInvalid, opaquePixels: Array.from(data).filter((_, index) => index % 4 === 3 && data[index]! > 0).length };
    });
    assert.ok(result.opaquePixels > 0);
    assert.deepEqual(result.invalid, [], 'every opaque terrain and water pixel is an exact palette swatch');
    assert.deepEqual(result.contactInvalid, [], 'forest/wetland contact does not invent melted intermediate browns');
  } finally { await browser.close(); await server.close(); }
});
