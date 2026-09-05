import type { Biome, PlaceView, Tile } from '../shared/types.js';
import { initializeEcosystem } from './ecosystem.js';

export const CHUNK_SIZE = 16;
/** Technical integer-coordinate guard, not the boundary of a generated map. Upper bound is exclusive. */
export const MAX_COORDINATE = 10_000_000;

export interface Chunk {
  key: string;
  cx: number;
  cy: number;
  tiles: Tile[];
  discovered: boolean;
  places: PlaceView[];
  lastTick: number;
}

const clamp = (value: number): number => Math.max(0, Math.min(1, value));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
const rounded = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

function assertCoordinate(value: number): void {
  if (!Number.isSafeInteger(value) || value < -MAX_COORDINATE || value >= MAX_COORDINATE) {
    throw new RangeError(`Coordenada fuera del intervalo técnico [-${MAX_COORDINATE}, ${MAX_COORDINATE}).`);
  }
}

function assertSeed(seed: number): void {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new RangeError('La semilla debe ser un entero de 32 bits sin signo.');
  }
}

/** Integer lattice hash: all inputs remain exact within the supported coordinate range. */
function hash(seed: number, x: number, y: number, salt: number): number {
  let value = seed ^ salt ^ Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77);
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

function unit(seed: number, x: number, y: number, salt: number): number {
  return hash(seed, x, y, salt) / 0x1_0000_0000;
}

/** Smooth interpolation uses global lattice coordinates, including floor for negative cells. */
function noise(seed: number, x: number, y: number, scale: number, salt: number): number {
  const px = x / scale, py = y / scale;
  const ix = Math.floor(px), iy = Math.floor(py);
  const tx = fade(px - ix), ty = fade(py - iy);
  return lerp(
    lerp(unit(seed, ix, iy, salt), unit(seed, ix + 1, iy, salt), tx),
    lerp(unit(seed, ix, iy + 1, salt), unit(seed, ix + 1, iy + 1, salt), tx),
    ty,
  ) * 2 - 1;
}

function octaves(seed: number, x: number, y: number, scale: number, salt: number): number {
  return (noise(seed, x, y, scale, salt)
    + noise(seed, x, y, scale / 2, salt + 1) * 0.5
    + noise(seed, x, y, scale / 4, salt + 2) * 0.25) / 1.75;
}

export function chunkCoords(x: number, y: number): { cx: number; cy: number } {
  assertCoordinate(x); assertCoordinate(y);
  return { cx: Math.floor(x / CHUNK_SIZE), cy: Math.floor(y / CHUNK_SIZE) };
}

/** Accepts cell coordinates. For example (-1, 16) belongs to chunk "-1,1". */
export function chunkKey(x: number, y: number): string {
  const { cx, cy } = chunkCoords(x, y);
  return `${cx},${cy}`;
}

/** No persistent cache or shared random stream: a cell is a pure function of seed and position. */
export function generateTile(seed: number, x: number, y: number): Tile {
  assertSeed(seed); assertCoordinate(x); assertCoordinate(y);
  const continents = octaves(seed, x, y, 512, 100);
  const hills = octaves(seed, x, y, 64, 200);
  const ridge = 1 - Math.abs(noise(seed, x, y, 128, 300));
  const riverField = octaves(seed, x, y, 192, 400);
  const valley = clamp(1 - Math.abs(riverField) / 0.055);
  const rainfall = octaves(seed, x, y, 192, 500);
  const detail = noise(seed, x, y, 8, 600);
  const naturalElevation = clamp(0.45 + continents * 0.34 + hills * 0.13 + ridge * 0.11 - valley * 0.13);
  // A smooth, finite spawn highland keeps the initial region usable; terrain beyond it is unmodified.
  const spawnWeight = 1 - fade(clamp((Math.hypot(x - 17, y - 13) - 24) / 48));
  const elevation = clamp(lerp(naturalElevation, Math.max(0.57, naturalElevation), spawnWeight));
  const moisture = clamp(0.5 + rainfall * 0.65 - Math.max(0, elevation - 0.5) * 0.3 + valley * 0.22);
  // Water occupies the low continental/valley field; saturated land remains a traversable wetland.
  const water = elevation < 0.37;
  let biome: Biome;
  if (water) biome = 'ocean';
  else if (elevation > 0.72) biome = 'mountain';
  else if (moisture < 0.29) biome = 'desert';
  else if (moisture > 0.64 && elevation < 0.49) biome = 'wetland';
  else if (moisture > 0.56) biome = 'forest';
  else biome = 'grassland';

  if (water) return initializeEcosystem(seed, { x, y, terrain: 'water', biome, elevation: rounded(elevation), moisture: 1, vegetation: 0, food: 0, wood: 0, stone: 0 });

  const vegetation = clamp(biome === 'forest' ? 0.62 + moisture * 0.3 + detail * 0.06
    : biome === 'wetland' ? 0.45 + moisture * 0.35 + detail * 0.07
    : biome === 'desert' ? 0.025 + moisture * 0.14 + detail * 0.015
    : biome === 'mountain' ? 0.07 + moisture * 0.16 + detail * 0.025
    : 0.27 + moisture * 0.5 + detail * 0.07);
  const materials = unit(seed, x, y, 700);
  const wood = biome === 'forest' ? Math.min(12, Math.floor(vegetation * 10 + materials * 4))
    : biome === 'wetland' ? Math.floor(vegetation * 3 + materials)
    : biome === 'grassland' && materials > 0.84 ? 1 + Math.floor(materials * 2) : 0;
  const stone = biome === 'mountain' ? 4 + Math.floor(materials * 5)
    : biome === 'desert' ? Math.floor(materials * 3)
    : Math.floor(materials * 2);
  return initializeEcosystem(seed, {
    x, y, terrain: biome === 'desert' || biome === 'mountain' ? 'soil' : 'meadow', biome,
    elevation: rounded(elevation), moisture: rounded(moisture), vegetation: rounded(vegetation),
    food: rounded(clamp(vegetation * (0.16 + moisture * 0.38) * (0.9 + detail * 0.1))), wood, stone,
  });
}

const LANDMARKS: Record<Biome, readonly string[]> = {
  grassland: ['El claro', 'La pradera', 'La loma'],
  forest: ['El bosque', 'La arboleda', 'La senda'],
  desert: ['El arenal', 'La duna', 'El pedregal'],
  mountain: ['La cumbre', 'La ladera', 'El paso'],
  wetland: ['La ribera', 'El juncal', 'La orilla'],
  ocean: ['La ensenada', 'La bahía', 'El agua'],
};
const QUALIFIERS = ['de la brisa', 'del horizonte', 'de las vueltas', 'del alba', 'del poniente', 'de las nubes', 'del silencio', 'de la luz'] as const;

/** Descriptive generated names carry no invented biography or claims about prior visits. */
export function proceduralPlaceName(seed: number, x: number, y: number): string {
  const biome = generateTile(seed, x, y).biome!;
  const nouns = LANDMARKS[biome];
  return `${nouns[hash(seed, x, y, 800) % nouns.length]} ${QUALIFIERS[hash(seed, x, y, 801) % QUALIFIERS.length]}`;
}

export function generateChunk(seed: number, cx: number, cy: number): Chunk {
  assertSeed(seed);
  const limit = MAX_COORDINATE / CHUNK_SIZE;
  if (!Number.isInteger(cx) || !Number.isInteger(cy) || cx < -limit || cy < -limit || cx >= limit || cy >= limit) {
    throw new RangeError('Chunk fuera del intervalo técnico de coordenadas.');
  }
  const x0 = cx * CHUNK_SIZE, y0 = cy * CHUNK_SIZE;
  const tiles: Tile[] = [];
  for (let dy = 0; dy < CHUNK_SIZE; dy++) {
    for (let dx = 0; dx < CHUNK_SIZE; dx++) tiles.push(generateTile(seed, x0 + dx, y0 + dy));
  }
  const places: PlaceView[] = [];
  if (hash(seed, cx, cy, 900) % 7 === 0) {
    const dx = 4 + hash(seed, cx, cy, 901) % 8;
    const dy = 4 + hash(seed, cx, cy, 902) % 8;
    const tile = tiles[dy * CHUNK_SIZE + dx]!;
    if (tile.terrain !== 'water') places.push({
      id: `landmark:${cx},${cy}`, name: proceduralPlaceName(seed, tile.x, tile.y), x: tile.x, y: tile.y,
      description: 'Un lugar del paisaje que puede adquirir significado con las visitas y el cuidado.', gatherings: 0,
    });
  }
  return { key: `${cx},${cy}`, cx, cy, tiles, discovered: false, places, lastTick: 0 };
}
