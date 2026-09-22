import type { Tile } from '../shared/types.js';
import type { World } from '../world/index.js';
import { DEFAULT_PARAMS, parseParams, type WorldParams } from '../world/params.js';
import { exactJsonNumber, stringifyExact } from '../shared/exact-json.js';

// Lossless JSON tuples avoid repeating twenty property names for every active tile
// on every durable step. Old object snapshots remain readable. No float quantization.
const ENCODING = 'tiles-tuple-v1';
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
export function encodeSnapshot(world: World, params: WorldParams = DEFAULT_PARAMS): string {
  // JSON null is reserved for absent optional fields. Never erase invalid present
  // values (JSON itself would turn NaN/Infinity into null) during compaction.
  const tiles = world.tiles.map(t => {
    const row: unknown[] = [t.x,t.y,t.terrain,t.moisture,t.vegetation,t.food,t.biome,t.elevation,t.wood,t.stone,t.feature,t.variety,t.growth,t.fertility,t.cultivation,t.traffic,t.drinkingWater,t.species,t.fauna,t.life];
    for (let i = 0; i < row.length; i++) {
      const value = row[i];
      if (i >= 6 && (value === null || typeof value === 'number' && !Number.isFinite(value))) throw new Error('Invalid optional tile value. Snapshot was not written.');
      if (Object.is(value, -0)) row[i] = exactJsonNumber(value);
    }
    return row;
  });
  const body = stringifyExact(params);
  const encoded: Record<string, unknown> = { ...world, retiredChunks: [], retiredLegacy: [], tiles, tileEncoding: ENCODING };
  // Los defaults no se escriben: con ellos la instantánea es bit a bit la de siempre.
  delete encoded.params; delete encoded.paramsEncoding;
  if (body !== DEFAULT_PARAMS_BODY) { encoded.paramsEncoding = PARAMS_ENCODING; encoded.params = params; }
  // Tile scalars were checked above. Keep their native serializer fast instead
  // of running a JS replacer for every scalar a second time. Metadata still uses
  // the exact scalar writer. Property order and ordinary bytes remain unchanged.
  const fields: string[] = [];
  for (const [key, value] of Object.entries(encoded)) {
    const fragment = key === 'tiles' ? JSON.stringify(value) : key === 'params' ? body : stringifyExact(value);
    if (fragment !== undefined) fields.push(`${JSON.stringify(key)}:${fragment}`);
  }
  return `{${fields.join(',')}}`;
}
/**
 * Extrae —y RETIRA— los parámetros de una instantánea ya decodificada: el `World` no
 * los lleva como campo, los recibe con `setParams`. Sin campo ⇒ `DEFAULT_PARAMS`
 * (migración de toda instantánea anterior a R8). Un campo presente se valida contra
 * `PARAM_RANGES` como cualquier entrada: un dígeste recalculado no legitima un
 * parámetro imposible.
 */
export function takeSnapshotParams(value: unknown): WorldParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_PARAMS;
  const record = value as Record<string, unknown>;
  if (!('params' in record) && !('paramsEncoding' in record)) return DEFAULT_PARAMS;
  const { params, paramsEncoding } = record;
  delete record.params; delete record.paramsEncoding;
  if (paramsEncoding !== PARAMS_ENCODING || !params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Invalid snapshot parameter encoding. Explicit recovery required.');
  try { return parseParams(params as Record<string, string>); }
  catch (error) { throw new Error(`Invalid snapshot parameters: ${(error as Error).message} Explicit recovery required.`); }
}
export function decodeSnapshot(body: string): unknown {
  let value: unknown;
  try { value = JSON.parse(body); }
  catch (error) {
    if (error instanceof SyntaxError) throw new SnapshotPhysicalError(error.message, { cause: error });
    throw error;
  }
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
