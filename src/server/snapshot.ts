import type { Tile } from '../shared/types.js';
import type { World } from '../world/index.js';

// Lossless JSON tuples avoid repeating twenty property names for every active tile
// on every durable step. Old object snapshots remain readable. No float quantization.
const ENCODING = 'tiles-tuple-v1';
const FIELDS = ['x','y','terrain','moisture','vegetation','food','biome','elevation','wood','stone','feature','variety','growth','fertility','cultivation','traffic','drinkingWater','species','fauna','life'] as const;
export function encodeSnapshot(world: World): string {
  // JSON null is reserved for absent optional fields. Never erase invalid present
  // values (JSON itself would turn NaN/Infinity into null) during compaction.
  for (const tile of world.tiles) for (let i = 6; i < FIELDS.length; i++) {
    const value = tile[FIELDS[i]!];
    if (value === null || typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid optional tile value. Snapshot was not written.');
  }
  const tiles = world.tiles.map(t => [t.x,t.y,t.terrain,t.moisture,t.vegetation,t.food,t.biome,t.elevation,t.wood,t.stone,t.feature,t.variety,t.growth,t.fertility,t.cultivation,t.traffic,t.drinkingWater,t.species,t.fauna,t.life]);
  return JSON.stringify({ ...world, retiredChunks: [], tiles, tileEncoding: ENCODING });
}
export function decodeSnapshot(body: string): unknown {
  const value: unknown = JSON.parse(body);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!('tileEncoding' in record)) return value;
  if (record.tileEncoding !== ENCODING || !Array.isArray(record.tiles) || record.tiles.length > 65536) throw new Error('Invalid snapshot tile encoding. Explicit recovery required.');
  record.tiles = record.tiles.map(row => {
    if (!Array.isArray(row) || row.length !== FIELDS.length) throw new Error('Invalid snapshot tile tuple. Explicit recovery required.');
    const tile: Record<string, unknown> = {};
    for (let i = 0; i < FIELDS.length; i++) if (row[i] !== null || i < 6) tile[FIELDS[i]!] = row[i];
    return tile as unknown as Tile;
  });
  delete record.tileEncoding;
  return value;
}
