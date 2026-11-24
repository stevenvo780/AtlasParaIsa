import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTerrainPixel, newFieldPixel, prepareTerrainStencil, waterDepthTone, type FieldSample } from '../src/client/terrain-field.js';

type Cell = FieldSample;
const land = (biome = 'grassland', cover = 0, traffic = 0): Cell => ({ biome, water: false, cover, traffic });
const water: Cell = { biome: 'ocean', water: true, cover: 0, traffic: 0 };

function sampleAt(get: (x: number, y: number) => Cell, x: number, y: number): Cell[] {
  const result: Cell[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) result.push(get(x + dx, y + dy));
  return result;
}

function raster(get: (x: number, y: number) => Cell, x0: number, y0: number, width: number, height: number) {
  const grass = new Uint8Array(width * height), wear = new Uint8Array(width * height);
  const wet = new Uint8Array(width * height), sand = new Uint8Array(width * height);
  const biome: string[] = new Array(width * height);
  const pixel = newFieldPixel();
  let lastX = NaN, lastY = NaN, stencil = prepareTerrainStencil(sampleAt(get, 0, 0));
  for (let iy = 0; iy < height; iy++) for (let ix = 0; ix < width; ix++) {
    const wx = x0 + ix, wy = y0 + iy, cx = Math.floor(wx / 16), cy = Math.floor(wy / 16);
    if (cx !== lastX || cy !== lastY) { stencil = prepareTerrainStencil(sampleAt(get, cx, cy)); lastX = cx; lastY = cy; }
    classifyTerrainPixel(wx, wy, cx, cy, stencil, pixel);
    const index = iy * width + ix;
    grass[index] = Number(pixel.grass); wear[index] = Number(pixel.wear);
    wet[index] = Number(pixel.water); sand[index] = Number(pixel.sand);
    biome[index] = pixel.biome;
  }
  return { grass, wear, wet, sand, biome, width, height };
}

function connected(mask: Uint8Array, width: number, height: number): boolean {
  const start = mask.indexOf(1);
  if (start < 0) return false;
  const seen = new Uint8Array(mask.length), queue = new Int32Array(mask.length);
  let head = 0, tail = 0; queue[tail++] = start; seen[start] = 1;
  while (head < tail) {
    const at = queue[head++]!, x = at % width, y = Math.floor(at / width);
    for (const next of [x > 0 ? at - 1 : -1, x + 1 < width ? at + 1 : -1,
      y > 0 ? at - width : -1, y + 1 < height ? at + width : -1]) {
      if (next >= 0 && mask[next] && !seen[next]) { seen[next] = 1; queue[tail++] = next; }
    }
  }
  return tail === mask.reduce((sum, value) => sum + value, 0);
}

test('cover and traffic cross a straight cell edge without making a square or inventing deep zero stock', () => {
  for (const kind of ['cover', 'traffic'] as const) {
    const get = (x: number): Cell => land('grassland', kind === 'cover' && x <= 0 ? 1 : 0,
      kind === 'traffic' && x <= 0 ? 1 : 0);
    const { grass, wear, width } = raster(get, 0, 0, 32, 64);
    const mask = kind === 'cover' ? grass : wear;
    let entered = 0, missing = 0;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 32; x++) {
      const present = mask[y * width + x]! === 1;
      if (x >= 16 && present) { entered++; assert.ok(x <= 19, `${kind} entered ${x - 15} px into zero cell`); }
      if (x < 16 && !present) missing++;
      if (present && x >= 16) {
        const neighbours = [x > 0 ? mask[y * width + x - 1] : 0, x < 31 ? mask[y * width + x + 1] : 0,
          y > 0 ? mask[(y - 1) * width + x] : 0, y < 63 ? mask[(y + 1) * width + x] : 0];
        assert.ok(neighbours.some(Boolean), `${kind} has an isolated border pixel`);
      }
    }
    assert.ok(entered > 0 && missing > 0, `${kind} must cross the boundary both ways`);
    assert.ok(Math.abs(entered - missing) <= Math.max(entered, missing) * .25,
      `${kind} entered ${entered} pixels and vacated ${missing}`);
  }
});

test('diagonal river is one 4-connected water region with a short sand fringe and no tile staircase', () => {
  const get = (x: number, y: number) => x === y && x >= 0 && x <= 5 ? water : land();
  const { wet, sand, width, height } = raster(get, -16, -16, 128, 128);
  assert.ok(connected(wet, width, height), 'diagonal water must form one 4-connected region');
  for (let i = 0; i < sand.length; i++) if (sand[i]) {
    const x = i % width, y = Math.floor(i / width);
    let near = false;
    for (let dy = -4; dy <= 4 && !near; dy++) for (let dx = -4; dx <= 4; dx++) {
      if (Math.abs(dx) + Math.abs(dy) > 4) continue;
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < width && yy < height && wet[yy * width + xx]) near = true;
    }
    assert.ok(near, `sand at ${x},${y} is farther than 4 px from water`);
  }
  let longest = 0;
  for (let y = 16; y < 96; y++) {
    let run = 0;
    for (let x = 16; x < 96; x++) {
      const edge = wet[y * width + x] !== wet[(y + 1) * width + x];
      longest = Math.max(longest, run = edge ? run + 1 : 0);
    }
  }
  for (let x = 16; x < 96; x++) {
    let run = 0;
    for (let y = 16; y < 96; y++) {
      const edge = wet[y * width + x] !== wet[y * width + x + 1];
      longest = Math.max(longest, run = edge ? run + 1 : 0);
    }
  }
  assert.ok(longest < 8, `diagonal shore has a ${longest} px straight run`);
});

test('horizontal river stays connected and its shore varies by at most three pixels', () => {
  const get = (_x: number, y: number) => y === 2 ? water : land();
  const { wet, width, height } = raster(get, 0, 16, 112, 48);
  assert.ok(connected(wet, width, height));
  for (let x = 16; x < 96; x++) {
    const ys: number[] = [];
    for (let y = 0; y < height; y++) if (wet[y * width + x]) ys.push(y + 16);
    assert.ok(ys.length > 0);
    assert.ok(Math.abs(ys[0]! - 32) <= 3, `upper bank at ${x}: ${ys[0]}`);
    assert.ok(Math.abs(ys.at(-1)! - 47) <= 3, `lower bank at ${x}: ${ys.at(-1)}`);
  }
});

test('classification is deterministic across chunk-side stencils and uses no cells beyond 3 × 3', () => {
  const get = (x: number, y: number): Cell => x === y ? water : land((x + y) % 2 ? 'forest' : 'desert', .6, .2);
  const a = prepareTerrainStencil(sampleAt(get, 7, 2)), b = prepareTerrainStencil(sampleAt(get, 8, 2));
  const first = structuredClone(classifyTerrainPixel(128, 39, 7, 2, a, newFieldPixel()));
  const second = structuredClone(classifyTerrainPixel(128, 39, 8, 2, b, newFieldPixel()));
  assert.deepEqual({ ...first, corners: undefined }, { ...second, corners: undefined });
  const hostile = (x: number, y: number): Cell => Math.abs(x - 7) <= 1 && Math.abs(y - 2) <= 1 ? get(x, y) : water;
  const same = classifyTerrainPixel(119, 39, 7, 2, prepareTerrainStencil(sampleAt(hostile, 7, 2)), newFieldPixel());
  const before = classifyTerrainPixel(119, 39, 7, 2, a, newFieldPixel());
  assert.deepEqual(same, before);
  const stock = (x: number): Cell => land('grassland', x <= 7 ? 1 : 0, x <= 7 ? 1 : 0);
  const left = prepareTerrainStencil(sampleAt(stock, 7, 2));
  const right = prepareTerrainStencil(sampleAt(stock, 8, 2));
  for (let wx = 128; wx < 136; wx++) for (let wy = 32; wy < 48; wy++) {
    const l = classifyTerrainPixel(wx, wy, 7, 2, left, newFieldPixel());
    const r = classifyTerrainPixel(wx, wy, 8, 2, right, newFieldPixel());
    assert.equal(l.grass, r.grass); assert.equal(l.wear, r.wear);
    assert.equal(l.water, r.water); assert.equal(l.biome, r.biome);
  }
});

test('biome colors stay on their selected side and boundary bends off the cell grid', () => {
  const get = (x: number): Cell => land(x <= 0 ? 'forest' : 'desert', .65);
  const { biome, width } = raster(get, 0, 0, 32, 96);
  let grid = 0;
  for (let y = 0; y < 96; y++) {
    let edge = -1;
    for (let x = 0; x < 32; x++) {
      const b = biome[y * width + x];
      if (x < 12) assert.equal(b, 'forest');
      if (x >= 20) assert.equal(b, 'desert');
      if (x > 0 && b !== biome[y * width + x - 1]) edge = x;
    }
    assert.ok(edge >= 12 && edge <= 20);
    if (edge === 16) grid++;
  }
  assert.ok(grid < 48, `${grid}/96 biome-edge pixels coincide with the tile grid`);
});

test('a 5 × 5 lake deepens inward without depth-tone seams on tile lines', () => {
  const get = (x: number, y: number): Cell => x >= 0 && x < 5 && y >= 0 && y < 5 ? water : land();
  const tones = new Uint8Array(80 * 80), wet = new Uint8Array(80 * 80);
  const pixel = newFieldPixel();
  for (let cy = 0; cy < 5; cy++) for (let cx = 0; cx < 5; cx++) {
    const stencil = prepareTerrainStencil(sampleAt(get, cx, cy));
    for (let by = 0; by < 16; by++) for (let bx = 0; bx < 16; bx++) {
      const wx = cx * 16 + bx, wy = cy * 16 + by, index = wy * 80 + wx;
      classifyTerrainPixel(wx, wy, cx, cy, stencil, pixel);
      wet[index] = Number(pixel.water);
      if (pixel.water) tones[index] = waterDepthTone(wx, wy, cx, cy, stencil, pixel.waterValue);
    }
  }
  const mean = (cx: number, cy: number): number => {
    let sum = 0, count = 0;
    for (let by = 0; by < 16; by++) for (let bx = 0; bx < 16; bx++) {
      const index = (cy * 16 + by) * 80 + cx * 16 + bx;
      if (wet[index]) { sum += tones[index]!; count++; }
    }
    return sum / count;
  };
  assert.ok(mean(0, 0) < mean(0, 2), 'lake corner should be shallower than its side');
  assert.ok(mean(0, 2) < mean(2, 2), 'lake side should be shallower than its centre');
  for (let grid = 16; grid < 80; grid += 16) {
    let vertical = 0, horizontal = 0;
    for (let p = 0; p < 80; p++) {
      const left = p * 80 + grid - 1, right = left + 1;
      if (wet[left] && wet[right] && tones[left] !== tones[right]) vertical++;
      const above = (grid - 1) * 80 + p, below = above + 80;
      if (wet[above] && wet[below] && tones[above] !== tones[below]) horizontal++;
    }
    assert.ok(vertical <= 40, `vertical grid ${grid} has ${vertical}/80 depth jumps`);
    assert.ok(horizontal <= 40, `horizontal grid ${grid} has ${horizontal}/80 depth jumps`);
  }
});
