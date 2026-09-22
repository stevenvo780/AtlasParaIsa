import type { Tile } from '../shared/types.js';
import type { World } from '../world/index.js';
import { DEFAULT_PARAMS, parseParams, type WorldParams } from '../world/params.js';
import { exactJsonNumber, stringifyExact } from '../shared/exact-json.js';

// Lossless JSON tuples avoid repeating twenty property names for every active tile
// on every durable step. Old object snapshots remain readable. No float quantization.
export const SNAPSHOT_TILE_ENCODING = 'tiles-tuple-v1';
export const LEGACY_SNAPSHOT_TILE_LIMIT = 65536;
/** R8: los `WorldParams` viven en un `WeakMap` por instancia (params.ts, ruling R3), así
 * que `load()` reconstruía el mundo desde JSON SIN ellos y volvía silenciosamente a
 * `DEFAULT_PARAMS`. Viajan en la instantánea como campo versionado y aparte del `World`:
 * el objeto del mundo sigue sin llevarlos. Una instantánea SIN campo es anterior a esta
 * ley — o tiene exactamente los defaults — y se lee como `DEFAULT_PARAMS`. */
const PARAMS_ENCODING = 'params-v1';
const DEFAULT_PARAMS_BODY = stringifyExact(DEFAULT_PARAMS);
const FIELDS = ['x','y','terrain','moisture','vegetation','food','biome','elevation','wood','stone','feature','variety','growth','fertility','cultivation','traffic','drinkingWater','species','fauna','life'] as const;
/** Only unreadable bytes justify trying an older checkpoint automatically. */
export class SnapshotPhysicalError extends Error {}
export function encodeSnapshotTileRows(tiles: readonly Tile[]): unknown[][] {
  // JSON null is reserved for absent optional fields. Never erase invalid present
  // values (JSON itself would turn NaN/Infinity into null) during compaction.
  return tiles.map(t => {
    const row: unknown[] = [t.x,t.y,t.terrain,t.moisture,t.vegetation,t.food,t.biome,t.elevation,t.wood,t.stone,t.feature,t.variety,t.growth,t.fertility,t.cultivation,t.traffic,t.drinkingWater,t.species,t.fauna,t.life];
    for (let i = 0; i < row.length; i++) {
      const value = row[i];
      if (i < 6 && i !== 2 && (typeof value !== 'number' || !Number.isFinite(value)))
        throw new Error('Invalid required numeric tile value. Snapshot was not written.');
      if (i >= 6 && (value === null || typeof value === 'number' && !Number.isFinite(value))) throw new Error('Invalid optional tile value. Snapshot was not written.');
      if (Object.is(value, -0)) row[i] = exactJsonNumber(value);
    }
    return row;
  });
}
export function snapshotRecord(world: World, params: WorldParams, tiles: unknown): Record<string, unknown> {
  if (Object.hasOwn(world, 'snapshotEncoding')) throw new Error('Reserved snapshot encoding field. Snapshot was not written.');
  const body = stringifyExact(params);
  const encoded: Record<string, unknown> = { ...world, retiredChunks: [], retiredLegacy: [], tiles, tileEncoding: SNAPSHOT_TILE_ENCODING };
  // Los defaults no se escriben: con ellos la instantánea es bit a bit la de siempre.
  delete encoded.params; delete encoded.paramsEncoding;
  if (body !== DEFAULT_PARAMS_BODY) { encoded.paramsEncoding = PARAMS_ENCODING; encoded.params = params; }
  return encoded;
}
export function encodeSnapshot(world: World, params: WorldParams = DEFAULT_PARAMS): string {
  const encoded = snapshotRecord(world, params, encodeSnapshotTileRows(world.tiles));
  // Tile scalars were checked above. Keep their native serializer fast instead
  // of running a JS replacer for every scalar a second time. Metadata still uses
  // the exact scalar writer. Property order and ordinary bytes remain unchanged.
  const fields: string[] = [];
  for (const [key, value] of Object.entries(encoded)) {
    const fragment = key === 'tiles' ? JSON.stringify(value) : stringifyExact(value);
    if (fragment !== undefined) fields.push(`${JSON.stringify(key)}:${fragment}`);
  }
  return `{${fields.join(',')}}`;
}
/**
 * Valida los parámetros sin modificar la instantánea. El `World` recibe sus leyes
 * con `setParams`, después de extraerlas. Sin campo ⇒ `DEFAULT_PARAMS`
 * (migración de toda instantánea anterior a R8). Un campo presente se valida contra
 * `PARAM_RANGES` como cualquier entrada: un dígeste recalculado no legitima un
 * parámetro imposible.
 */
export function readSnapshotParams(value: unknown): WorldParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_PARAMS;
  const record = value as Record<string, unknown>;
  if (!('params' in record) && !('paramsEncoding' in record)) return DEFAULT_PARAMS;
  const { params, paramsEncoding } = record;
  if (paramsEncoding !== PARAMS_ENCODING || !params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Invalid snapshot parameter encoding. Explicit recovery required.');
  try { return parseParams(params as Record<string, string>); }
  catch (error) { throw new Error(`Invalid snapshot parameters: ${(error as Error).message} Explicit recovery required.`); }
}
export function takeSnapshotParams(value: unknown): WorldParams {
  const params = readSnapshotParams(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    delete (value as Record<string, unknown>).params; delete (value as Record<string, unknown>).paramsEncoding;
  }
  return params;
}
export function parseSnapshotJSON(body: string): unknown {
  let value: unknown;
  try { value = JSON.parse(body); }
  catch (error) {
    if (error instanceof SyntaxError) throw new SnapshotPhysicalError(error.message, { cause: error });
    throw error;
  }
  return value;
}
export function decodeSnapshotTileRows(rows: unknown[]): Tile[] {
  return rows.map(row => {
    if (!Array.isArray(row) || row.length !== FIELDS.length) throw new Error('Invalid snapshot tile tuple. Explicit recovery required.');
    const tile: Record<string, unknown> = {};
    for (let i = 0; i < FIELDS.length; i++) if (row[i] !== null || i < 6) tile[FIELDS[i]!] = row[i];
    return tile as unknown as Tile;
  });
}
export function decodeSnapshotValue(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if ('snapshotEncoding' in record) throw new Error('Snapshot parts require a durable reader. Explicit recovery required.');
  if (!('tileEncoding' in record)) return value;
  if (record.tileEncoding !== SNAPSHOT_TILE_ENCODING || !Array.isArray(record.tiles) || record.tiles.length > LEGACY_SNAPSHOT_TILE_LIMIT) throw new Error('Invalid snapshot tile encoding. Explicit recovery required.');
  record.tiles = decodeSnapshotTileRows(record.tiles);
  delete record.tileEncoding;
  return value;
}
export function decodeSnapshot(body: string): unknown { return decodeSnapshotValue(parseSnapshotJSON(body)); }
