import type { Tile } from '../shared/types.js';
import { RULES_VERSION, type World } from '../world/index.js';
import { DEFAULT_PARAMS, LEGACY_WORLD_LIMITS, PARAMETER_LIMITS_RULES_VERSION, WORLD_LIMIT_KEYS,
  assertWorldLimits, effectiveLimits, parseParams, type WorldLimits, type WorldParams } from '../world/params.js';
import { exactJsonNumber, stringifyExact } from '../shared/exact-json.js';

// Lossless JSON tuples avoid repeating twenty property names for every active tile
// on every durable step. Old object snapshots remain readable. No float quantization.
export const SNAPSHOT_TILE_ENCODING = 'tiles-tuple-v1';
export const LEGACY_SNAPSHOT_TILE_LIMIT = LEGACY_WORLD_LIMITS.teselasActivas;
/** R8: los `WorldParams` viven en un `WeakMap` por instancia (params.ts, ruling R3), así
 * que `load()` reconstruía el mundo desde JSON SIN ellos y volvía silenciosamente a
 * `DEFAULT_PARAMS`. Viajan en la instantánea como campo versionado y aparte del `World`:
 * el objeto del mundo sigue sin llevarlos. Una instantánea SIN campo usa los valores
 * históricos y declara ahora su modo de admisión histórico. */
const PARAMS_ENCODING = 'params-v1';
const LEGACY_PARAMS_BODY = stringifyExact({ ...DEFAULT_PARAMS, limites: LEGACY_WORLD_LIMITS });
const HISTORICAL_DEFAULT_PARAMS = parseParams('limites.aplicacion=historicos');
const FIELDS = ['x','y','terrain','moisture','vegetation','food','biome','elevation','wood','stone','feature','variety','growth','fertility','cultivation','traffic','drinkingWater','species','fauna','life'] as const;
/** Only unreadable bytes justify trying an older checkpoint automatically. */
export class SnapshotPhysicalError extends Error {}
/** Readable bytes with an explicitly recognized codec/parameter violation. */
export class SnapshotSemanticError extends Error {}

function assertSnapshotRulesVersion(record: Record<string, unknown>): void {
  if (!Number.isSafeInteger(record.version) || (record.version as number) < 1 || (record.version as number) > RULES_VERSION)
    throw new SnapshotSemanticError('Invalid snapshot rules version. Explicit recovery required.');
}

/** Admission is checked before tuples/pages are expanded. The profile is transport
 * metadata; effective laws remain the complete params covered by the world digest. */
export function readSnapshotLimits(record: Record<string, unknown>, validateParams = true): Readonly<WorldLimits> {
  assertSnapshotRulesVersion(record);
  const params = validateParams ? readSnapshotParams(record) : undefined;
  const declaredMode = hasSnapshotLimitMode(record);
  if (!Object.hasOwn(record, 'limitsProfile')) {
    if (declaredMode) throw new SnapshotSemanticError('Missing snapshot limits profile for declared application mode. Explicit recovery required.');
    return LEGACY_WORLD_LIMITS;
  }
  const profile = record.limitsProfile;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)
    || ![1, 2].includes((profile as { version: number }).version)
    || Object.keys(profile).length !== WORLD_LIMIT_KEYS.length + ((profile as { version: number }).version === 2 ? 2 : 1)
    || !Number.isSafeInteger(record.version) || (record.version as number) < PARAMETER_LIMITS_RULES_VERSION)
    throw new SnapshotSemanticError('Invalid snapshot limits profile. Explicit recovery required.');
  const version = (profile as { version: number }).version;
  const application = version === 1 ? 'parametros' : (profile as { aplicacion?: unknown }).aplicacion;
  if (version === 2 && (!declaredMode || typeof application !== 'string' || !['historicos', 'parametros'].includes(application))
    || params && params.limites.aplicacion !== application)
    throw new SnapshotSemanticError('Invalid snapshot limits application mode. Explicit recovery required.');
  const limits = { ...profile } as Record<string, unknown>; delete limits.version;
  if (version === 2) delete limits.aplicacion;
  try { assertWorldLimits(limits); }
  catch (error) { throw new SnapshotSemanticError('Invalid snapshot limits profile. Explicit recovery required.', { cause: error }); }
  if (params && WORLD_LIMIT_KEYS.some(key => limits[key] !== effectiveLimits(params)[key]))
    throw new SnapshotSemanticError('Snapshot limits disagree with parameters. Explicit recovery required.');
  return limits;
}

export function assertSnapshotCounts(record: Record<string, unknown>, limits: Readonly<WorldLimits>, tileCount?: number): void {
  if (tileCount !== undefined && tileCount > (record.version === 1 ? 1120 : limits.teselasActivas))
    throw new SnapshotSemanticError('Invalid snapshot tile encoding. Explicit recovery required.');
  if (record.chunks && typeof record.chunks === 'object' && Object.keys(record.chunks).length > limits.chunks
    || Array.isArray(record.communities) && record.communities.length > limits.comunidades
    || Array.isArray(record.animals) && record.animals.length > limits.fauna)
    throw new SnapshotSemanticError('Invalid snapshot collection limit. Explicit recovery required.');
}
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
  if (Object.hasOwn(world, 'limitsProfile')) throw new Error('Reserved snapshot limits profile. Snapshot was not written.');
  assertWorldLimits(params.limites, true);
  const limits = world.version < PARAMETER_LIMITS_RULES_VERSION ? LEGACY_WORLD_LIMITS : effectiveLimits(params);
  assertSnapshotCounts(world as unknown as Record<string, unknown>, limits, world.tiles.length);
  const current = world.version >= PARAMETER_LIMITS_RULES_VERSION;
  const serializedParams = current ? params : { ...params, limites: Object.fromEntries(WORLD_LIMIT_KEYS.map(key => [key, params.limites[key]])) };
  const body = stringifyExact(serializedParams);
  const encoded: Record<string, unknown> = { ...world, retiredChunks: [], retiredLegacy: [], tiles, tileEncoding: SNAPSHOT_TILE_ENCODING };
  // Current snapshots declare the mode even with defaults; old encoders retain
  // their historical omission convention.
  delete encoded.params; delete encoded.paramsEncoding;
  if (current || body !== LEGACY_PARAMS_BODY) { encoded.paramsEncoding = PARAMS_ENCODING; encoded.params = serializedParams; }
  if (current) encoded.limitsProfile = { version: 2, aplicacion: params.limites.aplicacion,
    ...Object.fromEntries(WORLD_LIMIT_KEYS.map(key => [key, limits[key]])) };
  return encoded;
}
export function encodeSnapshot(world: World, params: WorldParams = DEFAULT_PARAMS): string {
  const encoded = snapshotRecord(world, params, undefined);
  encoded.tiles = encodeSnapshotTileRows(world.tiles);
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
 * con `setParams`, después de extraerlas. Sin campo ni perfil ⇒ defaults históricos,
 * con modo explícito; no se activa una opción T102 reservada al migrar. Un campo presente se valida contra
 * `PARAM_RANGES` como cualquier entrada: un dígeste recalculado no legitima un
 * parámetro imposible.
 */
function hasSnapshotLimitMode(record: Record<string, unknown>): boolean {
  const params = record.params as Record<string, unknown> | undefined;
  return !!params && (Object.hasOwn(params, 'limites.aplicacion') || !!params.limites && typeof params.limites === 'object'
    && Object.hasOwn(params.limites, 'aplicacion'));
}

/** Preserve a v1 profile's interpretation when its transport marker is removed. */
export function retainSnapshotLimitMode(record: Record<string, unknown>): void {
  if (Object.hasOwn(record, 'limitsProfile') && !hasSnapshotLimitMode(record)) {
    record.params = readSnapshotParams(record); record.paramsEncoding = PARAMS_ENCODING;
  }
}

export function readSnapshotParams(value: unknown): WorldParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_PARAMS;
  const record = value as Record<string, unknown>;
  const base = !Object.hasOwn(record, 'limitsProfile') && !hasSnapshotLimitMode(record) ? HISTORICAL_DEFAULT_PARAMS : DEFAULT_PARAMS;
  if (!('params' in record) && !('paramsEncoding' in record)) return base;
  const { params, paramsEncoding } = record;
  if (paramsEncoding !== PARAMS_ENCODING || !params || typeof params !== 'object' || Array.isArray(params)) throw new SnapshotSemanticError('Invalid snapshot parameter encoding. Explicit recovery required.');
  try { return parseParams(params as Record<string, string>, base); }
  catch (error) {
    if (!(error instanceof Error) || error.constructor !== Error || 'code' in error) throw error;
    throw new SnapshotSemanticError(`Invalid snapshot parameters: ${error.message} Explicit recovery required.`, { cause: error });
  }
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
    if (!Array.isArray(row) || row.length !== FIELDS.length) throw new SnapshotSemanticError('Invalid snapshot tile tuple. Explicit recovery required.');
    const tile: Record<string, unknown> = {};
    for (let i = 0; i < FIELDS.length; i++) if (row[i] !== null || i < 6) tile[FIELDS[i]!] = row[i];
    return tile as unknown as Tile;
  });
}
export function decodeSnapshotValue(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if ('snapshotEncoding' in record) throw new SnapshotSemanticError('Snapshot parts require a durable reader. Explicit recovery required.');
  const limits = readSnapshotLimits(record);
  assertSnapshotCounts(record, limits, Array.isArray(record.tiles) ? record.tiles.length : undefined);
  if ('tileEncoding' in record) {
    if (record.tileEncoding !== SNAPSHOT_TILE_ENCODING || !Array.isArray(record.tiles)) throw new SnapshotSemanticError('Invalid snapshot tile encoding. Explicit recovery required.');
    record.tiles = decodeSnapshotTileRows(record.tiles);
    delete record.tileEncoding;
  }
  retainSnapshotLimitMode(record);
  delete record.limitsProfile;
  return value;
}
export function decodeSnapshot(body: string): unknown { return decodeSnapshotValue(parseSnapshotJSON(body)); }
