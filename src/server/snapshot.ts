import type { Gesture, GestureResult, Tile } from '../shared/types.js';
import type { Chunk } from '../world/terrain.js';
import { RULES_VERSION, type World } from '../world/index.js';
import { DEFAULT_PARAMS, HISTORICAL_PARAMS, LEGACY_WORLD_LIMITS, PARAMETER_LIMITS_RULES_VERSION, WORLD_LIMIT_KEYS,
  assertWorldLimits, effectiveLimits, paramsOf, parseParams, type WorldLimits, type WorldParams } from '../world/params.js';
import { exactJsonNumber, stringifyExact } from '../shared/exact-json.js';
import { residentBackingArray, residentTopologyToken } from '../world/soa/topologia.js';
import { residentFastAccess } from '../world/soa/terreno.js';
import { GOBERNADOR_DIGESTO_HISTORICO, type GobernadorLegado } from '../world/digesto.js';

// Lossless JSON tuples avoid repeating twenty property names for every active tile
// on every durable step. Old object snapshots remain readable. No float quantization.
export const SNAPSHOT_TILE_ENCODING = 'tiles-tuple-v1';
/** T133: archived (retired) chunks reuse the tile tuple for `tiles` only; every
 * other chunk field (animals, structures, places, …) keeps its plain JSON shape,
 * so SQLite queries over `$.animals`/`$.structures` keep working unchanged. */
export const ARCHIVED_CHUNK_TILE_ENCODING = 'chunk-tiles-tuple-v1';
/** R8: los `WorldParams` viven en un `WeakMap` por instancia (params.ts, ruling R3), así
 * que `load()` reconstruía el mundo desde JSON SIN ellos y volvía silenciosamente a
 * `DEFAULT_PARAMS`. Viajan en la instantánea como campo versionado y aparte del `World`:
 * el objeto del mundo sigue sin llevarlos. Una instantánea SIN campo usa los valores
 * históricos y declara ahora su modo de admisión histórico.
 *
 * Reglas 10, etapa 1 (2026-09-22): «valores históricos» son `HISTORICAL_PARAMS`, nunca
 * `DEFAULT_PARAMS`. Desde que los defaults de un mundo NUEVO adoptan el paquete de natalidad,
 * completar una instantánea antigua con ellos le cambiaría las leyes en silencio. Los
 * escritores históricos (reglas < 9) omitían el campo cuando los params eran los suyos por
 * defecto, es decir los históricos: `LEGACY_PARAMS_BODY` es ese cuerpo, y un mundo viejo con
 * los defaults NUEVOS sí declara sus params para no volver al leerse como histórico. */
const PARAMS_ENCODING = 'params-v1';
const LEGACY_PARAMS_BODY = stringifyExact({ ...HISTORICAL_PARAMS, limites: LEGACY_WORLD_LIMITS });
const HISTORICAL_LIMIT_MODE_PARAMS = parseParams('limites.aplicacion=historicos', HISTORICAL_PARAMS);
/** Orden de los campos de cada tupla de tesela. `encodeSnapshotTileRows` escribe el mismo orden a mano
 * (camino caliente de cada guardado); tests/snapshot-tile-fields.test.ts comprueba que coinciden. */
export const SNAPSHOT_TILE_FIELDS = ['x','y','terrain','moisture','vegetation','food','biome','elevation','wood','stone','feature','variety','growth','fertility','cultivation','traffic','drinkingWater','species','fauna','life','paved'] as const;
const PAVED_TILE_RULES_VERSION = 14;
/** Only unreadable bytes justify trying an older checkpoint automatically. */
export class SnapshotPhysicalError extends Error {}
/** Readable bytes with an explicitly recognized codec/parameter violation. */
export class SnapshotSemanticError extends Error {}

/** Host changes are captured at their actual tick, after the mutation and before
 * the next step. Numeric simulation output is never a dirty page. */
export interface SnapshotReplayChange { tick: number; path: string[]; present: boolean; value?: unknown; }
export interface SnapshotReplayBase { snapshotReplay: 1; rules: number; tick: number; depth: number; root: string; }
export type SnapshotReplay = SnapshotReplayBase & (
  { kind: 'checkpoint'; body: string }
  | { kind: 'delta'; parent: string; inputs: { gesture: Gesture; result: GestureResult }[];
    changes: SnapshotReplayChange[]; journals: { chronicle: World['chronicleJournal']; technology: World['technology']['journal'] } }
);
const replayObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const replayDigest = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export function assertReplayPath(path: unknown): asserts path is string[] {
  if (!Array.isArray(path) || !path.length || path.some(key => typeof key !== 'string' || !key.length
    || ['__proto__', 'prototype', 'constructor'].includes(key))
    || ['tick', 'version', 'chronicleJournal', 'snapshotReplay', 'snapshotEncoding', 'params', 'paramsEncoding'].includes(path[0]))
    throw new SnapshotSemanticError('Invalid replay dirty path. Explicit recovery required.');
}
export function captureReplayChange(world: World, path: string[]): SnapshotReplayChange {
  assertReplayPath(path);
  if (path.length === 1 && path[0] === '$params')
    return { tick: world.tick, path: [...path], present: true, value: JSON.parse(stringifyExact(paramsOf(world))) };
  let value: unknown = world;
  for (const key of path.slice(0, -1)) {
    if (!replayObject(value) && !Array.isArray(value) || !Object.hasOwn(value as object, key))
      throw new SnapshotSemanticError('Missing replay dirty parent. Explicit recovery required.');
    value = (value as Record<string, unknown>)[key];
  }
  if (!replayObject(value) && !Array.isArray(value)) throw new SnapshotSemanticError('Invalid replay dirty parent.');
  const key = path.at(-1)!, present = Object.hasOwn(value, key);
  return { tick: world.tick, path: [...path], present,
    ...(present ? { value: JSON.parse(stringifyExact((value as Record<string, unknown>)[key])) } : {}) };
}
/** The durable reader supplies parent lookup and simulation; an ordinary JSON
 * snapshot reader must never accidentally accept this transport as a world. */
export function readSnapshotReplay(value: unknown): SnapshotReplay | null {
  if (!replayObject(value) || !Object.hasOwn(value, 'snapshotReplay')) return null;
  const fail = (): never => { throw new SnapshotSemanticError('Invalid snapshot replay. Explicit recovery required.'); };
  const fields = value.kind === 'checkpoint' ? ['snapshotReplay','rules','kind','tick','depth','root','body']
    : ['snapshotReplay','rules','kind','tick','depth','root','parent','inputs','changes','journals'];
  if (value.snapshotReplay !== 1 || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))
    || !Number.isSafeInteger(value.rules) || (value.rules as number) < 1 || (value.rules as number) > RULES_VERSION
    || !Number.isSafeInteger(value.tick) || (value.tick as number) < 0 || !replayDigest(value.root)
    || !Number.isSafeInteger(value.depth) || (value.depth as number) < 0 || (value.depth as number) > 99) fail();
  if (value.kind === 'checkpoint') {
    if (value.depth !== 0 || typeof value.body !== 'string') fail();
  } else {
    if (value.kind !== 'delta' || value.depth === 0 || !replayDigest(value.parent) || !Array.isArray(value.inputs)
      || !Array.isArray(value.changes) || !replayObject(value.journals)
      || Object.keys(value.journals).sort().join(',') !== 'chronicle,technology') fail();
    for (const input of value.inputs as unknown[]) {
      if (!replayObject(input) || Object.keys(input).sort().join(',') !== 'gesture,result'
        || !replayObject(input.gesture) || typeof input.gesture.id !== 'string' || !replayObject(input.result)
        || !Number.isSafeInteger(input.result.tick) || !Number.isSafeInteger(input.result.order)) fail();
    }
    for (const change of value.changes as unknown[]) {
      if (!replayObject(change) || !Number.isSafeInteger(change.tick) || typeof change.present !== 'boolean'
        || Object.keys(change).sort().join(',') !== (change.present ? 'path,present,tick,value' : 'path,present,tick')) fail();
      assertReplayPath((change as Record<string, unknown>).path);
    }
  }
  return value as unknown as SnapshotReplay;
}

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
/** Codifica `count` teselas desde `offset` sin copiar el tramo (el guardado por páginas ya no paga un
 * `slice` —otra pasada de traps sobre el array Proxy residente— por página). Sin tramo, el array entero. */
export function encodeSnapshotTileRows(tiles: readonly Tile[], offset = 0, count = tiles.length - offset, nativo = false): unknown[][] {
  // JSON null is reserved for absent optional fields. Never erase invalid present
  // values (JSON itself would turn NaN/Infinity into null) during compaction.
  const rows: unknown[][] = new Array(count);
  const token = residentTopologyToken(tiles as Tile[]);
  // An opaque array index accessor must keep the public Proxy as its receiver.
  const raw = token === undefined ? tiles : residentBackingArray(tiles);
  // The provider refuses busy stores and reflected resident descriptors. A binding
  // lookup (not an array index/coordinate guess) also handles mixed/new chunks.
  // Inherited optional values cannot be represented by the SoA absence sentinel.
  const fast = token !== undefined
    && !SNAPSHOT_TILE_FIELDS.some(key => key in Object.prototype) ? residentFastAccess(tiles) : undefined;
  for (let n = 0; n < count; n++) {
    const t = raw[offset + n]!;
    const cell = fast ? fast.cellOf(t) : -1;
    // Keep the historical tuple projection: custom object key order, extra keys
    // and tile.toJSON do not change it. Unbound/opaque tiles take the old reads.
    const row: unknown[] = cell < 0 ? [t.x,t.y,t.terrain,t.moisture,t.vegetation,t.food,t.biome,t.elevation,t.wood,t.stone,t.feature,t.variety,t.growth,t.fertility,t.cultivation,t.traffic,t.drinkingWater,t.species,t.fauna,t.life,t.paved]
      : [t.x,t.y,fast!.TERRAIN_NAMES[fast!.terrainArr[cell]! - 1],
        optionalNumber(fast!.moistureArr[cell]!),optionalNumber(fast!.vegetationArr[cell]!),optionalNumber(fast!.foodArr[cell]!),
        fast!.BIOME_NAMES[fast!.biomeArr[cell]! - 1],t.elevation,optionalNumber(fast!.woodArr[cell]!),t.stone,
        fast!.FEATURE_NAMES[fast!.featureArr[cell]! - 1],t.variety,optionalNumber(fast!.growthArr[cell]!),
        optionalNumber(fast!.fertilityArr[cell]!),optionalNumber(fast!.cultivationArr[cell]!),optionalNumber(fast!.trafficArr[cell]!),
        optionalNumber(fast!.drinkingWaterArr[cell]!),t.species,t.fauna,optionalNumber(fast!.lifeArr[cell]!),t.paved];
    for (let i = 0; i < row.length; i++) {
      const value = row[i];
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
          if (i < 6 && i !== 2) throw new Error('Invalid required numeric tile value. Snapshot was not written.');
          if (i >= 6) throw new Error('Invalid optional tile value. Snapshot was not written.');
        } else if (!nativo && value === 0 && 1 / value < 0) row[i] = exactJsonNumber(value);
      } else if (i < 6 && i !== 2) throw new Error('Invalid required numeric tile value. Snapshot was not written.');
      else if (i >= 6 && value === null) throw new Error('Invalid optional tile value. Snapshot was not written.');
    }
    rows[n] = row;
  }
  return rows;
}
/** NaN is the resident absence sentinel; Infinity is a present value and must
 * reach the same validation/error below as it does through a resident getter. */
function optionalNumber(value: number): number | undefined { return value === value ? value : undefined; }
export function snapshotRecord(world: World, params: WorldParams, tiles: unknown): Record<string, unknown> {
  if (Object.hasOwn(world, 'snapshotReplay')) throw new Error('Reserved snapshot replay field. Snapshot was not written.');
  if (Object.hasOwn(world, 'snapshotEncoding')) throw new Error('Reserved snapshot encoding field. Snapshot was not written.');
  if (Object.hasOwn(world, 'limitsProfile')) throw new Error('Reserved snapshot limits profile. Snapshot was not written.');
  assertWorldLimits(params.limites, true);
  const limits = world.version < PARAMETER_LIMITS_RULES_VERSION ? LEGACY_WORLD_LIMITS : effectiveLimits(params);
  assertSnapshotCounts(world as unknown as Record<string, unknown>, limits, world.tiles.length);
  const current = world.version >= PARAMETER_LIMITS_RULES_VERSION;
  const serializedParams = current ? params : { ...params, limites: Object.fromEntries(WORLD_LIMIT_KEYS.map(key => [key, params.limites[key]])) };
  const body = stringifyExact(serializedParams, params.v23.guardadoCompleto);
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
  const nativo = params.v23.guardadoCompleto;
  encoded.tiles = encodeSnapshotTileRows(world.tiles, 0, world.tiles.length, nativo);
  if (nativo) return stringifyExact(encoded, true);
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
/** Una instantánea declara su modo de admisión de límites dentro de sus params. */
function hasSnapshotLimitMode(record: Record<string, unknown>): boolean {
  const params = record.params as Record<string, unknown> | undefined;
  return !!params && (Object.hasOwn(params, 'limites.aplicacion') || !!params.limites && typeof params.limites === 'object'
    && Object.hasOwn(params.limites, 'aplicacion'));
}

/** Preserve a v1 profile's interpretation when its transport marker is removed. */
function retainSnapshotLimitMode(record: Record<string, unknown>): void {
  if (Object.hasOwn(record, 'limitsProfile') && !hasSnapshotLimitMode(record)) {
    const params = readSnapshotParams(record);
    record.params = { ...record.params as Record<string, unknown>, 'limites.aplicacion': params.limites.aplicacion };
    record.paramsEncoding = PARAMS_ENCODING;
  }
}

/** Extrae la configuración retirada del payload durable sin modificar los bytes que valida el replay. */
export function separarGobernadorLegado(
  original: Record<string, unknown>, base: GobernadorLegado = GOBERNADOR_DIGESTO_HISTORICO,
): { params: Record<string, unknown>; gobernador: GobernadorLegado } {
  const params: Record<string, unknown> = Object.create(null), hojas: Record<string, unknown> = Object.create(null);
  const invalido = (): never => { throw new SnapshotSemanticError('Invalid snapshot parameters: invalid legacy governor. Explicit recovery required.'); };
  for (const [clave, valor] of Object.entries(original)) {
    if (clave === 'gobernador') {
      if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return invalido();
      Object.assign(hojas, valor);
    } else if (clave.startsWith('gobernador.')) hojas[clave.slice('gobernador.'.length)] = valor;
    else params[clave] = valor;
  }
  let { presupuestoMs, senales, politica } = base;
  for (const [clave, valor] of Object.entries(hojas)) {
    if (clave === 'presupuestoMs') {
      const numero = typeof valor === 'string' && valor.trim() ? Number(valor) : valor;
      if (typeof numero !== 'number' || !Number.isFinite(numero) || numero < 5 || numero > 5000) return invalido();
      presupuestoMs = numero;
    } else if (clave === 'senales') {
      let lista = valor;
      if (typeof valor === 'string') {
        try { lista = JSON.parse(valor); } catch { return invalido(); }
      }
      if (!Array.isArray(lista) || !lista.length || new Set(lista).size !== lista.length
        || lista.some(senal => !['p95', 'max', 'rss', 'colaRed', 'saveMs'].includes(senal))) return invalido();
      senales = lista;
    } else if (clave === 'politica' && (valor === 'apagar' || valor === 'techo')) politica = valor;
    else return invalido();
  }
  return { params, gobernador: { presupuestoMs, senales, politica } };
}

/**
 * Valida los parámetros sin modificar la instantánea. El `World` recibe sus leyes
 * con `setParams`, después de extraerlas. Sin campo ni perfil ⇒ params históricos,
 * con modo explícito; no se activa una opción T102 reservada al migrar. Un campo presente se valida contra
 * `PARAM_RANGES` como cualquier entrada: un dígeste recalculado no legitima un
 * parámetro imposible. Las claves que el campo NO nombra se completan SIEMPRE con
 * `HISTORICAL_PARAMS` (reglas 10 y 11), sea cual sea la versión de reglas: una
 * instantánea sólo omite una clave si se escribió antes de que existiera.
 *
 * Poda ola 1 (2026-09-27): las claves de NAT-L y vocación que una instantánea antigua
 * nombre con su valor inerte se sueltan al cargar (nunca decidieron nada); con otro
 * valor esa instantánea usó la ley de verdad y se rechaza (recuperación explícita).
 */
const CLAVES_PODADAS_INERTES: readonly (readonly [string, string, unknown])[] = [
  ['poblacion', 'natalidadLocal', 0],
  ['poblacion', 'radioProvision', 16],
  ['conducta', 'vocacion', 0],
  ['conducta', 'vocacionTope', 0.9],
];
function sinClavesPodadas(params: Record<string, unknown>): Record<string, unknown> {
  const clon = structuredClone(params);
  for (const [seccion, hoja, inerte] of CLAVES_PODADAS_INERTES) {
    const grupo = clon[seccion];
    if (grupo !== null && typeof grupo === 'object' && !Array.isArray(grupo)
      && (grupo as Record<string, unknown>)[hoja] === inerte) {
      delete (grupo as Record<string, unknown>)[hoja];
    }
    const punteada = `${seccion}.${hoja}`;
    if (clon[punteada] === inerte) delete clon[punteada];
  }
  return clon;
}
export function readSnapshotParams(value: unknown): WorldParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return HISTORICAL_PARAMS;
  const record = value as Record<string, unknown>;
  const base = !Object.hasOwn(record, 'limitsProfile') && !hasSnapshotLimitMode(record) ? HISTORICAL_LIMIT_MODE_PARAMS : HISTORICAL_PARAMS;
  if (!('params' in record) && !('paramsEncoding' in record)) return base;
  const { params, paramsEncoding } = record;
  if (paramsEncoding !== PARAMS_ENCODING || !params || typeof params !== 'object' || Array.isArray(params)) throw new SnapshotSemanticError('Invalid snapshot parameter encoding. Explicit recovery required.');
  const vigentes = separarGobernadorLegado(params as Record<string, unknown>).params;
  try { return parseParams(sinClavesPodadas(vigentes), base); }
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
export function decodeSnapshotTileRows(rows: unknown[], rulesVersion?: number): Tile[] {
  // Los chunks archivados no llevan versión de reglas y también pueden contener tuplas históricas.
  const allowLegacyWidth = rulesVersion === undefined || rulesVersion < PAVED_TILE_RULES_VERSION;
  return rows.map(row => {
    if (!Array.isArray(row) || row.length !== SNAPSHOT_TILE_FIELDS.length
      && !(allowLegacyWidth && row.length === SNAPSHOT_TILE_FIELDS.length - 1))
      throw new SnapshotSemanticError('Invalid snapshot tile tuple. Explicit recovery required.');
    const tile: Record<string, unknown> = {};
    for (let i = 0; i < row.length; i++) if (row[i] !== null || i < 6) tile[SNAPSHOT_TILE_FIELDS[i]!] = row[i];
    return tile as unknown as Tile;
  });
}
export function decodeSnapshotValue(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if ('snapshotReplay' in record) throw new SnapshotSemanticError('Snapshot replay requires a durable reader. Explicit recovery required.');
  if ('snapshotEncoding' in record) throw new SnapshotSemanticError('Snapshot parts require a durable reader. Explicit recovery required.');
  const limits = readSnapshotLimits(record);
  assertSnapshotCounts(record, limits, Array.isArray(record.tiles) ? record.tiles.length : undefined);
  if ('tileEncoding' in record) {
    if (record.tileEncoding !== SNAPSHOT_TILE_ENCODING || !Array.isArray(record.tiles)) throw new SnapshotSemanticError('Invalid snapshot tile encoding. Explicit recovery required.');
    record.tiles = decodeSnapshotTileRows(record.tiles, record.version as number);
  }
  finishDecodedRecord(record);
  return value;
}
/** Último paso común de las lecturas en línea y por partes: quita las marcas de transporte
 * (codificación de teselas y perfil de límites) conservando el modo que declaraba un perfil v1. */
export function finishDecodedRecord(record: Record<string, unknown>): void {
  delete record.tileEncoding;
  retainSnapshotLimitMode(record);
  delete record.limitsProfile;
}
export function decodeSnapshot(body: string): unknown { return decodeSnapshotValue(parseSnapshotJSON(body)); }
/** T133: encode a retired chunk with its tiles as tuples (same lossless rows as
 * `tiles-tuple-v1`); all other fields travel exactly as `stringifyExact(chunk)` wrote them. */
export function encodeArchivedChunk(chunk: Chunk): string {
  if (!chunk || typeof chunk !== 'object' || !Array.isArray(chunk.tiles))
    throw new Error('Invalid archived chunk tiles. Snapshot was not written.');
  let rows = encodeSnapshotTileRows(chunk.tiles);
  // Coordinates are implicit in a chunk: tile i sits at (cx*16 + i%16, cy*16 + i/16),
  // exactly as `assertChunk` requires (same rationale as the SoA terrain of T112).
  // When every tile matches that derivation, drop the two leading slots; the decoder
  // rebuilds them from the grid. Any other chunk keeps the full tuple.
  if (Number.isSafeInteger(chunk.cx) && Number.isSafeInteger(chunk.cy)) {
    const x0 = chunk.cx * 16, y0 = chunk.cy * 16;
    if (rows.every((row, i) => row[0] === x0 + i % 16 && row[1] === y0 + Math.floor(i / 16)))
      rows = rows.map(row => row.slice(2));
  }
  const encoded: Record<string, unknown> = { ...(chunk as unknown as Record<string, unknown>),
    tiles: rows, tileEncoding: ARCHIVED_CHUNK_TILE_ENCODING };
  // Same fast path as `encodeSnapshot`: tiles already validated, keep their native
  // serializer so `-0` rawJSON rows survive; the rest uses the exact writer.
  const fields: string[] = [];
  for (const [key, value] of Object.entries(encoded)) {
    const fragment = key === 'tiles' ? JSON.stringify(value) : stringifyExact(value);
    if (fragment !== undefined) fields.push(`${JSON.stringify(key)}:${fragment}`);
  }
  return `{${fields.join(',')}}`;
}
/** Accepts both the historical plain-JSON chunk body and `chunk-tiles-tuple-v1`,
 * returning exactly the same `Chunk` (same keys and values) in either case. */
export function decodeArchivedChunk(body: string): Chunk {
  const value: unknown = JSON.parse(body);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value as Chunk;
  const record = value as Record<string, unknown>;
  if (!('tileEncoding' in record)) return value as Chunk;
  if (record.tileEncoding !== ARCHIVED_CHUNK_TILE_ENCODING || !Array.isArray(record.tiles))
    throw new SnapshotSemanticError('Invalid archived chunk tile encoding. Explicit recovery required.');
  // Las tuplas de dos campos menos toman x e y de la posición en la cuadrícula del chunk.
  if (Number.isSafeInteger(record.cx) && Number.isSafeInteger(record.cy)) {
    const x0 = (record.cx as number) * 16, y0 = (record.cy as number) * 16;
    record.tiles = (record.tiles as unknown[]).map((row, i) => Array.isArray(row) && (row.length === SNAPSHOT_TILE_FIELDS.length - 2 || row.length === SNAPSHOT_TILE_FIELDS.length - 3)
      ? [x0 + i % 16, y0 + Math.floor(i / 16), ...row] : row);
  }
  record.tiles = decodeSnapshotTileRows(record.tiles as unknown[]);
  delete record.tileEncoding;
  return value as Chunk;
}
