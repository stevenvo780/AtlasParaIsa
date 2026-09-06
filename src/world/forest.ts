import type { Tile } from '../shared/types.js';

/** Proposed landscape distribution, not an empirically calibrated forest model.
 * The site exists in global coordinates; chunk boundaries never reseed it. */
export const FOREST_LAYOUT_VERSION = 1;

function unit(seed: number, x: number, y: number, salt: number): number {
  let value = seed ^ salt ^ Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77);
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return ((value ^ (value >>> 16)) >>> 0) / 0x1_0000_0000;
}
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => value * value * (3 - 2 * value);
function field(seed: number, x: number, y: number, scale: number, salt: number): number {
  const gx = Math.floor(x / scale), gy = Math.floor(y / scale);
  const u = smooth(x / scale - gx), v = smooth(y / scale - gy);
  const a = unit(seed, gx, gy, salt), b = unit(seed, gx + 1, gy, salt);
  const c = unit(seed, gx, gy + 1, salt), d = unit(seed, gx + 1, gy + 1, salt);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

/** One candidate root within each globally aligned 2×2 area. Smooth habitat
 * fields decide which candidates exist, leaving broad gaps and denser groves.
 * The stratum limits density, not movement: neighboring roots may be adjacent. */
export function woodySite(seed: number, x: number, y: number, biome: Tile['biome']): boolean {
  if (biome !== 'forest' && biome !== 'grassland') return false;
  const sx = Math.floor(x / 2), sy = Math.floor(y / 2);
  const rootX = sx * 2 + Math.floor(unit(seed, sx, sy, 1300) * 2);
  const rootY = sy * 2 + Math.floor(unit(seed, sx, sy, 1301) * 2);
  if (x !== rootX || y !== rootY) return false;
  const habitat = field(seed, x, y, 24, 1310) * 0.7 + field(seed, x, y, 8, 1311) * 0.3;
  const occupancy = biome === 'forest' ? clamp((habitat - 0.22) / 0.32) : clamp((habitat - 0.25) * 0.8);
  return unit(seed, sx, sy, 1320) < occupancy;
}

/** Initial stock only. A caller must never use this to refill an existing zero.
 * Ground plants remain vegetation/food; an empty forest site is not a stump. */
export function initialWood(seed: number, tile: Pick<Tile, 'x' | 'y' | 'terrain' | 'biome' | 'vegetation'>): number {
  if (tile.terrain === 'water') return 0;
  const material = unit(seed, tile.x, tile.y, 700);
  if (tile.biome === 'wetland') return Math.floor(tile.vegetation * 3 + material);
  if (!woodySite(seed, tile.x, tile.y, tile.biome)) return 0;
  return tile.biome === 'forest' ? Math.min(12, Math.floor(tile.vegetation * 10 + material * 4)) : 1 + Math.floor(material * 2);
}
