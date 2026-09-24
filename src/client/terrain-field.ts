/** Pure, world-space classification of one native (16 px) terrain pixel. */
export const TERRAIN_ART = 16;

export interface FieldSample {
  biome: string;
  water: boolean;
  cover: number;
  traffic: number;
}

export interface FieldPixel {
  corners: [number, number, number, number];
  weights: [number, number, number, number];
  biome: string;
  water: boolean;
  waterValue: number;
  sand: boolean;
  sandEdge: boolean;
  grass: boolean;
  grassEdge: boolean;
  wear: boolean;
  wearEdge: boolean;
  fine: number;
  cover: number;
}

interface BiomeGroup { biome: string; bias: number; mask: number; }
interface FieldQuad {
  indices: [number, number, number, number];
  a: FieldSample; b: FieldSample; c: FieldSample; d: FieldSample;
  coverContrast: number; trafficContrast: number;
  coverThresholdBase: number; coverThresholdScale: number;
  trafficThresholdBase: number; trafficThresholdScale: number;
  coverVertical: boolean; trafficVertical: boolean;
  waterMask: number;
  saddle: 0 | 1 | 2;
  biomes: BiomeGroup[];
}
export interface TerrainStencil { owner: FieldSample; samples: readonly FieldSample[]; quads: [FieldQuad, FieldQuad, FieldQuad, FieldQuad]; }

function biomeBias(biome: string): number {
  switch (biome) {
    case 'forest': return -1;
    case 'desert': return 1;
    case 'grassland': return -.35;
    case 'mountain': return .35;
    case 'wetland': return .8;
    default: return -.8;
  }
}

export function prepareTerrainStencil(samples: readonly FieldSample[]): TerrainStencil {
  if (samples.length !== 9) throw new RangeError('terrain stencil requires exactly 3 × 3 cells');
  const quads = [] as FieldQuad[];
  for (const i of [0, 1, 3, 4]) {
    const indices: [number, number, number, number] = [i, i + 1, i + 3, i + 4];
    const a = samples[i]!, b = samples[i + 1]!, c = samples[i + 3]!, d = samples[i + 4]!;
    const coverRange = Math.max(a.cover, b.cover, c.cover, d.cover) - Math.min(a.cover, b.cover, c.cover, d.cover);
    const trafficRange = Math.max(a.traffic, b.traffic, c.traffic, d.traffic) - Math.min(a.traffic, b.traffic, c.traffic, d.traffic);
    const biomes: BiomeGroup[] = [];
    for (const [j, sample] of [a, b, c, d].entries()) {
      if (sample.water) continue;
      let group = biomes.find(group => group.biome === sample.biome);
      if (!group) { group = { biome: sample.biome, bias: biomeBias(sample.biome), mask: 0 }; biomes.push(group); }
      group.mask |= 1 << j;
    }
    const coverContrast = Math.min(1, coverRange / .8), trafficContrast = Math.min(1, trafficRange / .8);
    quads.push({ indices, a, b, c, d, coverContrast, trafficContrast,
      coverThresholdBase: .5 * coverContrast + .10 * (1 - coverContrast),
      coverThresholdScale: .65 * (1 - coverContrast),
      trafficThresholdBase: .5 * trafficContrast + .10 * (1 - trafficContrast),
      trafficThresholdScale: .65 * (1 - trafficContrast),
      coverVertical: Math.abs(b.cover + d.cover - a.cover - c.cover) >= Math.abs(c.cover + d.cover - a.cover - b.cover),
      trafficVertical: Math.abs(b.traffic + d.traffic - a.traffic - c.traffic) >= Math.abs(c.traffic + d.traffic - a.traffic - b.traffic),
      waterMask: (a.water ? 1 : 0) | (b.water ? 2 : 0) | (c.water ? 4 : 0) | (d.water ? 8 : 0),
      saddle: a.water && d.water && !b.water && !c.water ? 1 : b.water && c.water && !a.water && !d.water ? 2 : 0,
      biomes });
  }
  return { owner: samples[4]!, samples, quads: quads as TerrainStencil['quads'] };
}

export function newFieldPixel(): FieldPixel {
  return { corners: [0, 0, 0, 0], weights: [0, 0, 0, 0], biome: '', water: false,
    waterValue: 0, sand: false, sandEdge: false, grass: false, grassEdge: false,
    wear: false, wearEdge: false, fine: 0, cover: 0 };
}

function smooth(value: number): number { return value * value * (3 - 2 * value); }

export function rnd(x: number, y: number, salt: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(salt | 0, 2246822519);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise; the seed lattice is fixed in world pixels. */
export function materialNoise(x: number, y: number, scale: number, salt: number): number {
  const gx = Math.floor(x / scale), gy = Math.floor(y / scale);
  const u = smooth(x / scale - gx), v = smooth(y / scale - gy);
  const top = rnd(gx, gy, salt) * (1 - u) + rnd(gx + 1, gy, salt) * u;
  const bottom = rnd(gx, gy + 1, salt) * (1 - u) + rnd(gx + 1, gy + 1, salt) * u;
  return top * (1 - v) + bottom * v;
}

interface PixelGeometry {
  left: number; top: number; u: number; v: number;
  weights: [number, number, number, number];
}

function pixelGeometry(bx: number, by: number): PixelGeometry {
  const left = bx < 8 ? 0 : 1, top = by < 8 ? 0 : 1;
  const u = (bx + 8.5) / TERRAIN_ART - left;
  const v = (by + 8.5) / TERRAIN_ART - top;
  return { left, top, u, v, weights: [(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v] };
}

const PIXEL_GEOMETRY = Array.from({ length: 256 }, (_, index) => pixelGeometry(index % 16, index >> 4));
const EDGE_WAVE = [-.09, -.045, 0, .045, .09, .045, 0, -.045] as const;

/** Reads only the 3 × 3 stencil centred on (cellX, cellY). Reuse `out` per pixel. */
export function classifyTerrainPixel(
  wx: number, wy: number, cellX: number, cellY: number,
  stencil: TerrainStencil, out: FieldPixel,
): FieldPixel {
  const bx = wx - cellX * TERRAIN_ART, by = wy - cellY * TERRAIN_ART;
  const geometry = bx >= 0 && bx < 16 && by >= 0 && by < 16
    ? PIXEL_GEOMETRY[by * 16 + bx]! : pixelGeometry(bx, by);
  const { left, top, u, v } = geometry;
  const quad = stencil.quads[top * 2 + left]!;
  out.corners = quad.indices;
  const weights = out.weights = geometry.weights;
  const { a, b, c, d } = quad;
  const wa = weights[0], wb = weights[1], wc = weights[2], wd = weights[3];
  const fine = materialNoise(wx, wy, 7, 351);
  out.fine = fine;
  // The four centre indicators form a marching-squares scalar field. At a saddle,
  // the diagonal water centres receive a thin bridge on their own diagonal.
  let waterValue = 0;
  if (quad.waterMask === 15) waterValue = 1;
  else if (quad.waterMask !== 0) {
    waterValue = ((quad.waterMask & 1) ? wa : 0) + ((quad.waterMask & 2) ? wb : 0)
      + ((quad.waterMask & 4) ? wc : 0) + ((quad.waterMask & 8) ? wd : 0) + (fine - .5) * .05;
    if (quad.saddle === 1) {
      waterValue = Math.max(waterValue, .5 + (.30 - Math.abs(u - v)) * .22);
    } else if (quad.saddle === 2) {
      waterValue = Math.max(waterValue, .5 + (.30 - Math.abs(u + v - 1)) * .22);
    }
  }
  out.waterValue = waterValue;
  out.water = waterValue > .5;
  out.sand = !out.water && waterValue > .45;
  out.sandEdge = out.sand && waterValue > .485;
  if (out.water || out.sand) {
    out.grass = out.grassEdge = out.wear = out.wearEdge = false;
    out.cover = 0; out.biome = '';
    return out;
  }

  // Centre the eight-pixel wave on the nearest cell edge. The two pixels on
  // either side use the same offset and conserve area at a 1↔0 boundary.
  const verticalPhase = (wy + 2 * (cellX + left)) & 7;
  const horizontalPhase = (wx + 2 * (cellY + top)) & 7;
  const verticalWave = EDGE_WAVE[verticalPhase]!;
  const horizontalWave = EDGE_WAVE[horizontalPhase]!;
  const coverWave = quad.coverVertical ? verticalWave : horizontalWave;
  const trafficWave = quad.trafficVertical ? verticalWave : horizontalWave;
  const coverNoise = coverWave * quad.coverContrast + (fine - .5) * .16 * (1 - quad.coverContrast);
  const trafficNoise = trafficWave * quad.trafficContrast + (fine - .5) * .16 * (1 - quad.trafficContrast);
  const cover = a.cover * wa + b.cover * wb + c.cover * wc + d.cover * wd;
  const traffic = a.traffic * wa + b.traffic * wb + c.traffic * wc + d.traffic * wd;
  const coverThreshold = quad.coverThresholdBase + fine * quad.coverThresholdScale;
  const trafficThreshold = quad.trafficThresholdBase + fine * quad.trafficThresholdScale;
  let owner = stencil.owner, localX = bx, localY = by;
  if (bx < 0 || bx >= 16 || by < 0 || by >= 16) {
    const actualCellX = Math.floor(wx / 16), actualCellY = Math.floor(wy / 16);
    const ownerIndex = (actualCellY - cellY + 1) * 3 + actualCellX - cellX + 1;
    owner = stencil.samples[ownerIndex] ?? stencil.owner;
    localX = wx - actualCellX * 16; localY = wy - actualCellY * 16;
  }
  // A zero stock can borrow at most the three border pixels of its neighbour.
  const nearEdge = Math.min(localX, 15 - localX, localY, 15 - localY) <= 3;
  const grassDelta = cover + coverNoise - coverThreshold;
  const wearDelta = traffic + trafficNoise - trafficThreshold;
  out.grass = grassDelta > 0 && (owner.cover > 0 || nearEdge);
  out.grassEdge = out.grass && grassDelta < .065;
  out.wear = wearDelta > 0 && (owner.traffic > 0 || nearEdge);
  out.wearEdge = out.wear && wearDelta < .065;
  out.cover = cover;

  // Compare the *sum* of bilinear weights per land biome, then renormalize only
  // the winning biome in the raster. The noise bends the boundary by a few pixels.
  if (quad.biomes.length === 1) out.biome = quad.biomes[0]!.biome;
  else if (quad.biomes.length === 2) {
    const first = quad.biomes[0]!, second = quad.biomes[1]!;
    const mask = first.mask;
    const firstWeight = ((mask & 1) ? wa : 0) + ((mask & 2) ? wb : 0)
      + ((mask & 4) ? wc : 0) + ((mask & 8) ? wd : 0);
    const otherMask = second.mask;
    const secondWeight = quad.waterMask === 0 ? 1 - firstWeight
      : ((otherMask & 1) ? wa : 0) + ((otherMask & 2) ? wb : 0)
        + ((otherMask & 4) ? wc : 0) + ((otherMask & 8) ? wd : 0);
    const bend = (fine - .5) * .55;
    out.biome = firstWeight + bend * first.bias >= secondWeight + bend * second.bias ? first.biome : second.biome;
  }
  else {
    let chosen = '', best = -Infinity;
    for (const group of quad.biomes) {
      const mask = group.mask;
      const score = ((mask & 1) ? wa : 0) + ((mask & 2) ? wb : 0)
        + ((mask & 4) ? wc : 0) + ((mask & 8) ? wd : 0) + (fine - .5) * .55 * group.bias;
      if (score > best) { best = score; chosen = group.biome; }
    }
    out.biome = chosen;
  }
  return out;
}
