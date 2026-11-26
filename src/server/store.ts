import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Gesture, GestureResult } from '../shared/types.js';
import { assertWorld, bindWorldContext, cloneWorld, migrateWorld, RULES_VERSION, stepWorld, TICKS_PER_DAY, type World, type WorldContext } from '../world/index.js';
import { CHUNK_SIZE, MAX_COORDINATE, type Chunk } from '../world/terrain.js';
import { assertEcosystemTile, assertChunkLife } from '../world/validation.js';
import { takeSnapshotParams, SnapshotPhysicalError, SnapshotSemanticError, encodeArchivedChunk, decodeArchivedChunk,
  parseSnapshotJSON, readSnapshotReplay, assertReplayPath, separarGobernadorLegado, type SnapshotReplay, type SnapshotReplayChange } from './snapshot.js';
import { digestoCanonico, type GobernadorLegado } from '../world/digesto.js';
import { SnapshotParts, assertSnapshotPartsSchema, hasCanonicalSnapshotPartsPrefix, SNAPSHOT_INLINE_TILE_LIMIT, type SnapshotReuseTicket, type WrittenSnapshot } from './snapshot-parts.js';
import type { LegacyRecord } from '../shared/demography.js';
import { assertLegacyRecord, genealogiaValida } from '../world/lineage.js';
import { TechnologyArchive, TECHNOLOGY_CHAIN_EMPTY, TECHNOLOGY_EXECUTION_KINDS, emptyTechnologyExecutionCounts,
  legacyTechnologyChainStep, technologyChainStep, technologyPruneSeal,
  type TechnologyExecutionCounts } from './technology-archive.js';
import { TECHNOLOGY_ARCHIVE_LAWS_VERSION, type TechnologyDefinition } from '../shared/technology-archive.js';
import type { TechnologyCatalogueTotals, TechnologyRecipe } from '../shared/technology.js';
import { enableTechnologyJournal, assertTechnologyJournal, technologyStateForCommit, markTechnologyJournalCommitted } from '../world/technology-journal.js';
import { assertTechnologyCatalogueState, enableTechnologyCatalogue, markTechnologyCatalogueCommitted,
  technologyCatalogueStateForCommit, technologyCatalogueTotals, technologyFunctionCode,
  TECHNOLOGY_FUNCTION_WORDS, type TechnologyCatalogueReader } from '../world/technology-catalogue.js';
import { assertChronicleEvent, assertChronicleJournal, enableChronicleJournal, chronicleSerial, chronicleFailure, chronicleForCommit, EMPTY_CHRONICLE_DIGEST, type ChronicleJournal } from '../world/chronicle-journal.js';
import { assertTechnology, maintainTechnologyMemory } from '../world/technology.js';
import { ley, paramsOf, parseParams, setParams, type WorldParams } from '../world/params.js';
import { stringifyExact } from '../shared/exact-json.js';
import type { Instantanea } from '../world/motor/contratos.js';
import { consumirCorteGuardado, type CorteGuardadoSellado } from '../world/motor/corte-sellado.js';
import type { TramoFaunaVerificada } from '../world/motor/fauna-corte.js';
import type { TeselasCorteVerificadas } from '../world/motor/teselas-corte.js';
import { codificarCheckpoint } from '../world/materia/checkpoint.js';
import { MAX_SNAPSHOT_MATTER_PART_BYTES, SnapshotMatterParts, type PreparedMatterParts } from './snapshot-matter-parts.js';
import { cargarSustancias, type ServicioQuimicoImpl } from '../world/materia/servicio.js';
import { AgendaTerritorial, type CorteAgendaTerritorial } from '../world/territorio/agenda.js';
import { writeWorldInstance } from './world-instance.js';

/** Profundidad de recuperación: cada cien guardados el slot 2 hereda la instantánea
 * vigente, de modo que el respaldo más viejo mide minutos y no el último paso. */
export const DEEP_CHECKPOINT_EVERY_SAVES = 100;
/** La cadena de respaldo, de la más reciente a la más profunda: la instantánea vigente
 * (0), la copia del guardado anterior (1) y la copia profunda (2, una de cada
 * `DEEP_CHECKPOINT_EVERY_SAVES`). `load()` y `previous()` la recorren EN ORDEN —cada uno
 * con su ley, documentada en cada método— y ninguno adopta un eslabón sin verificarlo
 * entero (R2: hasta esta ronda el slot 2 se escribía y no lo leía nadie). */
export const SNAPSHOT_SLOTS = [0, 1, 2] as const;
export type SnapshotSlot = (typeof SNAPSHOT_SLOTS)[number];
/** Lo que `load()` devuelve, con el eslabón del que salió el mundo a la vista: adoptar un
 * respaldo es un retroceso, y quien lo pone en servicio tiene que poder contarlo (el
 * suceso de pausa de la crónica y `/health` lo hacen, en `app.ts`). */
export interface LoadedSnapshot {
  world: World; savedAt: number;
  /** Eslabón adoptado: 0 es la instantánea vigente, > 0 un respaldo. */
  slot: SnapshotSlot;
  /** Por qué se saltó cada eslabón anterior. Vacío cuando `slot === 0`. */
  skipped: string[];
  /** `saved_at` del eslabón dañado más reciente, o `null` si su fila ni siquiera estaba.
   * La diferencia con `savedAt` es el retroceso del rescate: el cuerpo que lo superaba
   * es ilegible, así que en pasos no se puede medir, solo en tiempo de servicio. */
  supersededAt: number | null;
}

// El sello del snapshot cubre el corte y el SHA de los bytes exactos de materia.
const CAMPO_AGENDA = 'agendaTerritorialV1';
const AGENDA_DURABLE_KEY = 'v24-agenda-durable-v1';
interface AdjuntoAgenda {
  corte: CorteAgendaTerritorial;
  materiaDigest: string | null;
}
type MatterForWrite = Uint8Array | PreparedMatterParts | null;
interface MatterManifestRow { slot: SnapshotSlot; world_digest: string; snapshot_digest: string | null; body: Uint8Array; }
type LoadedSnapshotBruto = LoadedSnapshot & { agendaBruta?: unknown };
interface InstantaneaCargada {
  instantanea: Instantanea;
  epoca: number;
  /** La época del corte es la de la instantánea, antes de reservar la nueva época de ejecución. */
  corteAgenda?: CorteAgendaTerritorial;
}

function separarAgenda(world: World): unknown {
  const record = world as World & { [CAMPO_AGENDA]?: unknown };
  const agenda = record[CAMPO_AGENDA];
  delete record[CAMPO_AGENDA];
  return agenda;
}

function validarCorteAgenda(corte: unknown, epoca: number, tick: number): CorteAgendaTerritorial {
  try { return AgendaTerritorial.restaurar(corte, epoca, tick).corte(epoca); }
  catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof RangeError)) throw error;
    throw new SnapshotSemanticError('Corte de agenda territorial inválido o de otro tick o época.', { cause: error });
  }
}
/** Cadencia de la revisión COMPLETA del mundo (`assertWorld`) dentro de `save()`.
 * Recorrer el mundo entero cuesta O(tiles + gente + recetas) y a día 5 (40 personas,
 * instantánea de 4,3 MiB) era 270 ms de los 634 ms del guardado: el 43 %. Se paga
 * una vez cada diez guardados —y siempre en el primero de cada proceso— en lugar de
 * en todos. Ver `save()` para la ventana descubierta y su compensación. */
export const DEEP_VALIDATION_EVERY_SAVES = 10;
/**
 * Retención del archivo de recibos de ejecución (sprint noche-arch 2026-09-23). Con `persistencia.ventanaEventosTicks`
 * > 0 cada guardado poda los recibos anteriores a la ventana, pero nunca a menos de un día: las métricas C7 del
 * laboratorio (`scripts/lab/metrics.ts`) leen el último día de recibos detrás de cada guardado.
 */
export const TECHNOLOGY_RETENTION_MIN_TICKS = TICKS_PER_DAY;
/**
 * Tope de recibos podados en un guardado. Un mundo que ya existía (el público: 351 486 recibos a día 66) no se
 * poda de golpe —borrar y plegar 300 000 filas en un guardado pararía el bucle segundos—, sino a este ritmo, muy
 * por encima de lo que crece (≈ 2 recibos por paso, 200 por guardado con `cadaTicks=100`). Medido en la copia
 * pública: ver docs/REGLAS.md, «Retención del archivo de recibos».
 */
export const TECHNOLOGY_PRUNE_ROWS_PER_SAVE = 16384;
/** Tope de filas históricas de `technology_stats` compactadas por guardado (A1). */
export const TECHNOLOGY_STATS_COMPACT_ROWS_PER_SAVE = 2048;
/** Tope de recetas en la memoria de lecturas archivadas (`archivedRecipeMemo`); al llenarse se vacía. */
const ARCHIVED_RECIPE_MEMO_LIMIT = 65_536;
interface ArchivedRecipeMemo {
  epoch: string;
  /** Tick de la fila archivada más reciente bajo este sello; `undefined` hasta el primer reuso. */
  horizon: number | undefined;
  recipes: Map<string, { atTick: number; value: TechnologyRecipe | null }>;
}
/**
 * ¿Toca la revisión completa (`assertWorld`) en este guardado? Cada `DEEP_VALIDATION_EVERY_SAVES`
 * guardados y siempre en el primero del proceso, SALVO que el proceso acabe de cargar el mundo:
 * `load()` ya aplica `assertWorld` entero (migrateWorld), así que repetirlo en el guardado 0 solo
 * duplica el coste — 103 s de mundo congelado con 133 710 ejecuciones archivadas (2026-09-21).
 */
export function deepValidationDue(saves: number, verifiedByLoad: boolean): boolean {
  if (saves === 0) return !verifiedByLoad;
  return saves % DEEP_VALIDATION_EVERY_SAVES === 0;
}

const checksum = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
// Preserve all V1 gesture identities; only the new command kind extends the tuple.
export const fingerprint = (g: Gesture) => checksum(JSON.stringify(g.kind === 'command'
  ? [g.kind, g.x, g.y, g.memoryId ?? null, g.agentId ?? null, g.order ?? null]
  : [g.kind, g.x, g.y, g.memoryId ?? null]));
type Row = { body: string; digest: string; saved_at: number };
type ChronicleStamp = { dataVersion: number; totalChanges: number; schemaCookie: number; tempSchemaCookie: number };
const sameChronicleStamp = (a: ChronicleStamp, b: ChronicleStamp) => Object.keys(a).every(key => a[key as keyof ChronicleStamp] === b[key as keyof ChronicleStamp]);
function sameReplayState(left: World, right: World): boolean {
  // Más estricto que el SHA histórico: huecos, `undefined`, prototipos o formas
  // distintas también fallan cerrado aunque serializaran igual.
  if (!isDeepStrictEqual(left, right)) return false;
  // `motor.depuracion` es observabilidad y está excluido del digesto histórico.
  const leftParams = paramsOf(left), rightParams = paramsOf(right);
  const { depuracion: _leftDebug, ...leftMotor } = leftParams.motor;
  const { depuracion: _rightDebug, ...rightMotor } = rightParams.motor;
  return isDeepStrictEqual({ ...leftParams, motor: leftMotor }, { ...rightParams, motor: rightMotor });
}
/**
 * Compromiso del delta nuevo. El objeto completo ya queda autenticado además
 * por su digest en `metadata`; esta raíz enlaza explícitamente padre, timeline,
 * resultados, cambios y diarios sin volver a recorrer el mundo. El estado se
 * autoriza antes con `sameReplayState`, y al leer `replayDelta` vuelve a ejecutar
 * y cotejar resultados/diarios. Los checkpoints conservan el SHA canónico.
 */
function replayDeltaRoot(node: Extract<SnapshotReplay, { kind: 'delta' }>): string {
  const { root: _root, ...commitment } = node;
  return checksum(stringifyExact(commitment));
}
type ChronicleProof = { startsAfter: number; through: number; digest: string; tick: number; stamp: ChronicleStamp };
type ChroniclePrune = { through: number; digest: string };
/** Cabeza V2 de la cadena de recibos: pliegue de `(startsAfter, through]` (ver `technologyChainStep`). */
type TechnologyChain = { startsAfter: number; through: number; digest: string };
type TechnologyChainRecord = TechnologyChain & ({ version: 1 } | { version: 2; pruneSeal: string | null });
/** Frontera V2: `digest` pliega todo el prefijo desde el origen; `seal` autentica los campos acumulados y la
 * cabeza durable lo repite, de modo que no pueda cambiar sin romper la prueba del archivo. */
type TechnologyPrune = TechnologyChain & { tick: number; count: number; byKind: TechnologyExecutionCounts; seal: string };
/** Lo que una instantánea exige del archivo para volver a cargarse o recuperarse: su tick,
 * sus recibos confirmados y los de su anillo residente (`ringTick`, tick del primero; `null` si está vacío). */
type SlotBounds = { tick: number; committed: number; ringTick: number | null };
const TECHNOLOGY_PRUNED_KEY = 'technology-pruned-v1', TECHNOLOGY_CHAIN_KEY = 'technology-chain-v1';
const DEEP_CHECKPOINT_SAVES_KEY = 'deep-checkpoint-saves-v1';
const REPLAY_KEY = 'snapshot-replay-v1:';
const EPOCA_COMPLETA_KEY = 'v23-complete-epoch-v1';
const hexDigest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const safeCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const technologyCounts = (value: unknown): TechnologyExecutionCounts | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...TECHNOLOGY_EXECUTION_KINDS].sort().join(',')) return null;
  const counts = value as Partial<TechnologyExecutionCounts>;
  return TECHNOLOGY_EXECUTION_KINDS.every(kind => safeCount(counts[kind])) ? counts as TechnologyExecutionCounts : null;
};
const addTechnologyCounts = (left: TechnologyExecutionCounts, right: TechnologyExecutionCounts): TechnologyExecutionCounts =>
  Object.fromEntries(TECHNOLOGY_EXECUTION_KINDS.map(kind => [kind, left[kind] + right[kind]])) as TechnologyExecutionCounts;
type SchemaColumn = { name: string; pk: number };
const BASE_TABLES: Record<string, string[]> = {
  snapshots: ['slot', 'body', 'digest', 'saved_at'], events: ['id', 'tick', 'body'],
  inputs: ['id', 'fingerprint', 'tick', 'ordinal', 'body', 'result'], sessions: ['hash', 'expires'], metadata: ['key', 'value'],
};
const ARCHIVE_SCHEMA = 'CREATE TABLE chunks (key TEXT NOT NULL, tick INTEGER NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY (key,tick));';
const LEGACY_SCHEMA = 'CREATE TABLE legacy (id TEXT PRIMARY KEY, tick INTEGER NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL); CREATE INDEX legacy_tick ON legacy(tick);';

function definitionOf(recipe: TechnologyRecipe): TechnologyDefinition {
  const { uses: _uses, utility: _utility, manufactured: _manufactured, ...definition } = recipe;
  return { ...definition, lawsVersion: TECHNOLOGY_ARCHIVE_LAWS_VERSION };
}
/** Archive definitions have already passed the closed V1 field/schema checks.
 * Copy every mutable branch without re-running a general structured serializer. */
function copyArchivedRecipe(recipe: TechnologyRecipe): TechnologyRecipe {
  return { ...recipe, program: { ...recipe.program, inputs: recipe.program.inputs.map(input => ({ ...input })),
    steps: recipe.program.steps.map(step => ({ ...step })) }, parents: [...recipe.parents], capacities: { ...recipe.capacities } };
}
const sameStats = (a: { uses: number; utility: number; manufactured: number }, b: TechnologyRecipe) =>
  a.uses === b.uses && a.utility === b.utility && a.manufactured === b.manufactured;
const technologyFailure = (message: string): never => { throw new Error(`Technology archive ${message}. Explicit recovery required.`); };
const sameUtility = (a: number, b: number, terms: number): boolean => Number.isFinite(a) && Number.isFinite(b)
  && Math.abs(a - b) <= Number.EPSILON * Math.max(1, terms) * Math.max(1, a, b);

/** Read-only schema inspection: opening a recovery source must never install tables. */
function assertTechnologySchema(db: DatabaseSync): void {
  for (const [table, names, primary, unique] of [
    ['technology_definitions', ['id', 'tick', 'signature', 'body', 'digest'], ['id'], 'signature'],
    ['technology_stats', ['recipeId', 'tick', 'body', 'digest'], ['recipeId', 'tick'], null],
    ['technology_executions', ['id', 'serial', 'tick', 'body', 'digest'], ['id'], 'serial'],
    ['technology_origin', ['id', 'body', 'digest'], ['id'], null],
  ] as const) {
    const columns = db.prepare('SELECT name,type,"notnull",pk FROM pragma_table_info(?)').all(table) as { name: string; type: string; notnull: number; pk: number }[];
    if (JSON.stringify(columns.map(c => c.name)) !== JSON.stringify(names)
      || JSON.stringify(columns.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name)) !== JSON.stringify(primary)
      || columns.some(c => c.notnull !== 1 || c.type !== (['tick', 'serial'].includes(c.name) || table === 'technology_origin' && c.name === 'id' ? 'INTEGER' : 'TEXT'))) technologyFailure('schema is incomplete');
    if (unique) {
      const indexes = db.prepare('SELECT name FROM pragma_index_list(?) WHERE "unique"=1 AND partial=0').all(table) as { name: string }[];
      if (!indexes.some(index => {
        const fields = db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(index.name) as { name: string }[];
        return fields.length === 1 && fields[0]!.name === unique;
      })) technologyFailure('schema uniqueness is incomplete');
    }
  }
}

function coordinatesFromKey(key: string): { cx: number; cy: number } {
  const pieces = typeof key === 'string' ? key.split(',') : [];
  const cx = Number(pieces[0]), cy = Number(pieces[1]);
  const limit = MAX_COORDINATE / CHUNK_SIZE;
  if (pieces.length !== 2 || !Number.isInteger(cx) || !Number.isInteger(cy) || cx < -limit || cy < -limit || cx >= limit || cy >= limit || `${cx},${cy}` !== key) {
    throw new Error('Invalid archived chunk key. Explicit recovery required.');
  }
  return { cx, cy };
}

/** Validate archived terrain before it re-enters the active world, even if its checksum matches. */
function assertChunk(value: unknown, key: string, atTick: number, v23?: WorldParams['v23']): asserts value is Chunk {
  const fail = (): never => { throw new Error('Invalid archived chunk state. Explicit recovery required.'); };
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const number = (v: unknown, max = 1): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
  const integer = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => number(v, max) && Number.isInteger(v);
  const string = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.length <= max;
  const { cx, cy } = coordinatesFromKey(key);
  const x0 = cx * CHUNK_SIZE, y0 = cy * CHUNK_SIZE;
  if (!object(value) || value.key !== key || value.cx !== cx || value.cy !== cy || typeof value.discovered !== 'boolean' || !integer(value.lastTick, atTick) || !Array.isArray(value.tiles) || value.tiles.length !== CHUNK_SIZE ** 2 || !Array.isArray(value.places) || v23?.obra === false && value.places.length > CHUNK_SIZE ** 2) fail();
  const chunk = value as unknown as Chunk;
  for (let index = 0; index < chunk.tiles.length; index++) {
    const tile = chunk.tiles[index];
    if (!object(tile) || tile.x !== x0 + index % CHUNK_SIZE || tile.y !== y0 + Math.floor(index / CHUNK_SIZE) || !['water', 'soil', 'meadow', 'shelter'].includes(String(tile.terrain)) || !number(tile.moisture) || !number(tile.vegetation) || !number(tile.food) || (tile.elevation !== undefined && !number(tile.elevation)) || (tile.wood !== undefined && !number(tile.wood, v23?.materia === false ? 12 : Infinity)) || (tile.stone !== undefined && !number(tile.stone, v23?.materia === false ? 8 : Infinity)) || (tile.biome !== undefined && !['grassland', 'forest', 'desert', 'mountain', 'wetland', 'ocean'].includes(String(tile.biome)))) fail();
    assertEcosystemTile(tile, false);
  }
  const ids = new Set<string>();
  for (const place of chunk.places) {
    if (!object(place) || !string(place.id, 200) || ids.has(place.id) || !string(place.name, 200) || !string(place.description) || !integer(place.gatherings, 1_000_000) || !Number.isInteger(place.x) || !Number.isInteger(place.y) || place.x < x0 || place.x >= x0 + CHUNK_SIZE || place.y < y0 || place.y >= y0 + CHUNK_SIZE) fail();
    ids.add(place.id);
  }
  assertChunkLife(chunk, atTick, v23?.obra ?? true, v23?.fauna ?? true);
}
export class GestureConflict extends Error {}
export class SessionRevoked extends Error {}
export interface StoreOptions {
  readOnly?: boolean; snapshotInlineTileLimit?: number;
  /** Umbral de los bloques de materia y máximo de bytes por parte. Por defecto, 4 MiB. */
  snapshotMatterPartBytes?: number;
  /** Escribe las páginas de personas del guardado completo con pesos Float64 binarios. */
  snapshotPackedPeople?: boolean;
  onProgress?: () => void;
  /** Recibos podados como mucho por guardado (default `TECHNOLOGY_PRUNE_ROWS_PER_SAVE`); las pruebas lo bajan. */
  technologyPruneRowsPerSave?: number;
}
function validateStoreOptions(options: StoreOptions): void {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key =>
      !['readOnly', 'snapshotInlineTileLimit', 'snapshotMatterPartBytes', 'snapshotPackedPeople', 'technologyPruneRowsPerSave', 'onProgress'].includes(key))
    || options.onProgress !== undefined && typeof options.onProgress !== 'function'
    || options.readOnly !== undefined && typeof options.readOnly !== 'boolean'
    || options.snapshotInlineTileLimit !== undefined && (!Number.isSafeInteger(options.snapshotInlineTileLimit)
      || options.snapshotInlineTileLimit < 0 || options.snapshotInlineTileLimit > SNAPSHOT_INLINE_TILE_LIMIT)
    || options.snapshotMatterPartBytes !== undefined && (!Number.isSafeInteger(options.snapshotMatterPartBytes)
      || options.snapshotMatterPartBytes < 1 || options.snapshotMatterPartBytes > MAX_SNAPSHOT_MATTER_PART_BYTES)
    || options.snapshotPackedPeople !== undefined && typeof options.snapshotPackedPeople !== 'boolean'
    || options.technologyPruneRowsPerSave !== undefined && (!Number.isSafeInteger(options.technologyPruneRowsPerSave)
      || options.technologyPruneRowsPerSave < 1 || options.technologyPruneRowsPerSave > 1_000_000))
    throw new Error('Invalid StoreOptions: readOnly must be boolean, snapshotInlineTileLimit an integer from 0 to 32768'
      + `, snapshotMatterPartBytes an integer from 1 to ${MAX_SNAPSHOT_MATTER_PART_BYTES}`
      + ', snapshotPackedPeople a boolean, technologyPruneRowsPerSave an integer from 1 to 1000000 and onProgress a function.');
}
export class Store {
  readonly db: DatabaseSync;
  readonly technologyArchive: TechnologyArchive;
  readonly catalogueReader: TechnologyCatalogueReader = {
    // `readTechnologyRecipe` devuelve siempre un objeto recién construido (lectura decodificada o copia
    // de una memoria que nunca se entrega): la resolución del mundo no necesita clonarlo otra vez.
    freshCopies: true,
    resolve: (id, atTick) => this.readTechnologyRecipe(id, atTick),
    readBatch: (atTick, read) => this.readBatch(atTick, read),
    findBySignature: (signature, atTick) => {
      if (this.schemaVersion < 4) return null;
      const definition = this.technologyArchive.findDefinitionBySignature(signature, atTick);
      return definition ? this.readTechnologyRecipe(definition.id, atTick) : null;
    },
  };
  lastSnapshotBytes = 0;
  /** Guardados confirmados y último paso en que se intentó podar: gobiernan la
   * profundidad del tercer respaldo y el coste amortizado de la poda. */
  private saves = 0;
  /** `load()` devolvió un mundo ya revisado por completo: el guardado 0 no repite `assertWorld`. */
  private verifiedByLoad = false;
  /** ¿El cuerpo que hoy ocupa el slot 0 se puede leer entero? `null` = todavía no consta
   * (una conexión que guarda sin haber cargado), y entonces `save()` lo comprueba una
   * sola vez. Gobierna la rotación de respaldos: ver `rotatesBackups()`. */
  private slot0Readable: boolean | null = null;
  private lastPruneTick = -1;
  private readonly schemaVersion: number;
  private readonly snapshotParts: SnapshotParts;
  private readonly snapshotInlineTileLimit: number;
  private readonly snapshotMatterParts: SnapshotMatterParts;
  private readonly snapshotMatterPartBytes: number;
  private readonly snapshotPackedPeople: boolean;
  private verifiedChronicle: ChronicleProof | null = null;
  private verifiedTechnology: { startsAfter: number; through: number; catalogueThrough: number; dataVersion: number; totalChanges: number;
    schemaCookie: number; chain: TechnologyChain } | null = null;
  private readonly technologyPruneRowsPerSave: number;
  private readonly explicitPruneCap: boolean;
  private readonly readOnly: boolean;
  private readonly autoVacuumIncremental: boolean;
  /** Límites de retención de cada instantánea por el digesto de su fila (`SlotBounds`): la del slot 0 se
   * anota al cargarla o escribirla, y la rotación copia cuerpos idénticos a los slots 1 y 2, así que casi
   * nunca hace falta decodificar un respaldo para saber cuánto archivo necesita. Acotada a 8 entradas. */
  private readonly slotBounds = new Map<string, SlotBounds | 'unusable'>();
  private verifiedRecipes = new Map<string, { body: string; uses: number; utility: number; manufactured: number }>();
  private verifiedCatalogue: { totals: TechnologyCatalogueTotals; functions: number[] } | null = null;
  private technologyReads: { limit: number; recipes: Map<string, TechnologyRecipe>; warmMemo: ArchivedRecipeMemo | null } | null = null;
  private replayCache: { digest: string; world: World; stamp: ChronicleStamp } | null = null;
  private readonly replayFloors = new Map<string, number>();
  /** Sello de base tomado tras el último COMMIT exitoso de `save()` en ESTE proceso: es la mitad durable
   * del vale de reutilización de páginas limpias (v18). Solo avanza tras COMMIT (o tras una escritura
   * auxiliar probada como propia en `auxiliaryWrite`); cualquier escritura ajena, DDL o escritura propia no
   * contabilizada lo desajusta y el guardado siguiente recodifica todas las páginas. */
  private snapshotPagesStamp: ChronicleStamp | null = null;
  private loadedMatterStamp: ChronicleStamp | null = null;
  private readonly onProgress: StoreOptions['onProgress'];
  constructor(readonly path: string, options: StoreOptions = {}) {
    validateStoreOptions(options);
    this.onProgress = options.onProgress;
    this.readOnly = options.readOnly ?? false;
    this.snapshotInlineTileLimit = options.snapshotInlineTileLimit ?? SNAPSHOT_INLINE_TILE_LIMIT;
    this.snapshotMatterPartBytes = options.snapshotMatterPartBytes ?? MAX_SNAPSHOT_MATTER_PART_BYTES;
    this.snapshotPackedPeople = options.snapshotPackedPeople ?? false;
    this.explicitPruneCap = options.technologyPruneRowsPerSave !== undefined;
    this.technologyPruneRowsPerSave = options.technologyPruneRowsPerSave ?? TECHNOLOGY_PRUNE_ROWS_PER_SAVE;
    const existed = path !== ':memory:' && existsSync(path);
    if (path !== ':memory:' && !this.readOnly) mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { readOnly: this.readOnly });
    this.snapshotMatterParts = new SnapshotMatterParts(this.db);
    // El archivo consulta la frontera de poda en cada verificación: nunca la recuerda (ver TechnologyArchiveHost).
    this.technologyArchive = new TechnologyArchive(this.db, { prunedThrough: () => this.prunedTechnology()?.through ?? null });
    let schemaVersion = existed ? 0 : 5;
    try {
      if (existed) {
        const marker = this.db.prepare('PRAGMA application_id').get() as { application_id: number };
        const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
        if (marker.application_id !== 1128354388 || ![1, 2, 3, 4, 5].includes(version.user_version)) throw new Error('Unrecognized database or schema version. Explicit recovery required.');
        schemaVersion = version.user_version;
        for (const [table, columns] of Object.entries(BASE_TABLES)) {
          const actual = (this.db.prepare(`PRAGMA table_info(${table})`).all() as SchemaColumn[]).map(row => row.name);
          if (JSON.stringify(actual) !== JSON.stringify(columns)) throw new Error('Database schema is incomplete. Explicit recovery required.');
        }
        if (schemaVersion >= 2) {
          const columns = this.db.prepare('PRAGMA table_info(chunks)').all() as SchemaColumn[];
          const primary = columns.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
          if (JSON.stringify(columns.map(c => c.name)) !== JSON.stringify(['key', 'tick', 'body', 'digest']) || JSON.stringify(primary) !== JSON.stringify(['key', 'tick'])) throw new Error('Archive schema is incomplete. Explicit recovery required.');
        }
        if (schemaVersion >= 3) {
          const columns = this.db.prepare('PRAGMA table_info(legacy)').all() as SchemaColumn[];
          if (JSON.stringify(columns.map(c=>c.name))!==JSON.stringify(['id','tick','body','digest']) || columns.find(c=>c.name==='id')?.pk!==1) throw new Error('Identity archive schema is incomplete. Explicit recovery required.');
        }
        if (schemaVersion >= 4) assertTechnologySchema(this.db);
        if (schemaVersion >= 5) assertSnapshotPartsSchema(this.db);
      }
      if (!this.readOnly) {
        // WAL + synchronous=NORMAL: un corte de luz puede costar el último commit
        // (≤ `persistencia.cadaTicks` pasos), nunca una base corrupta ni un estado
        // a medias. El fsync por tick era el 48 % del paso del servidor (C3).
        // `wal_autocheckpoint` por defecto (1000 páginas ≈ 4 MiB) dispara un volcado
        // del WAL a la base DENTRO de casi cada COMMIT cuando la instantánea pesa
        // megabytes. Con 4000 páginas (≈16 MiB) el volcado se paga una vez cada
        // varios guardados en lugar de en todos: mismo trabajo total, un WAL acotado
        // y un p95 que deja de heredar el checkpoint en cada guardado.
        // Una base NUEVA usa páginas de 8 KiB (sprint noche-arch 2026-09-23): un recibo de ejecución ronda
        // 2,1 KB y en una hoja de 4 KiB cabe uno solo, así que el 36 % del archivo público eran huecos
        // (952,6 → 697 MiB con 8 KiB, mismos bytes de contenido). Sólo se puede fijar antes de crear la
        // primera tabla y de pasar a WAL; una base existente conserva su tamaño de página.
        // `auto_vacuum=INCREMENTAL` (A3): en bases nuevas permite devolver al disco las páginas liberadas
        // por poda/compactación en pasos cortos (`PRAGMA incremental_vacuum(256)`) sin pausar el bucle.
        if (!existed) this.db.exec('PRAGMA page_size=8192; PRAGMA auto_vacuum=INCREMENTAL;');
        // El umbral del volcado del WAL se fija en bytes (≈16 MiB, el medido), no en páginas.
        const pageBytes = Number((this.db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size);
        const walPages = Math.max(1000, Math.round(16_384_000 / (Number.isSafeInteger(pageBytes) && pageBytes > 0 ? pageBytes : 4096)));
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;');
        this.db.exec(`PRAGMA wal_autocheckpoint=${walPages};`);
        if (!existed || schemaVersion < 5) {
          this.db.exec('BEGIN IMMEDIATE');
          try {
            if (!existed) this.db.exec(`
              CREATE TABLE snapshots (slot INTEGER PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL, saved_at INTEGER NOT NULL);
              CREATE TABLE events (id TEXT PRIMARY KEY, tick INTEGER NOT NULL, body TEXT NOT NULL);
              CREATE TABLE inputs (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, tick INTEGER NOT NULL, ordinal INTEGER NOT NULL, body TEXT NOT NULL, result TEXT NOT NULL);
              CREATE TABLE sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
              CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
            if (!existed || schemaVersion === 1) this.db.exec(ARCHIVE_SCHEMA);
            if (!existed || schemaVersion < 3) this.db.exec(LEGACY_SCHEMA);
            if (!existed || schemaVersion < 4) this.technologyArchive.installSchema();
            SnapshotParts.install(this.db);
            this.db.exec('PRAGMA application_id=1128354388; PRAGMA user_version=5; COMMIT;');
            schemaVersion = 5;
          } catch (error) {
            if (this.db.isTransaction) this.db.exec('ROLLBACK');
            throw error;
          }
        }
        if (schemaVersion >= 4 && !this.technologyArchive.hasPerformanceIndexes()) {
          this.db.exec('BEGIN IMMEDIATE');
          try {
            this.technologyArchive.ensurePerformanceIndexes();
            this.db.exec('COMMIT');
          } catch (error) {
            if (this.db.isTransaction) this.db.exec('ROLLBACK');
            throw error;
          }
        }
      }
      this.autoVacuumIncremental = !this.readOnly
        && Number((this.db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum) === 2;
      this.schemaVersion = schemaVersion;
      this.snapshotParts = new SnapshotParts(this.db, schemaVersion, this.onProgress, undefined, this.snapshotPackedPeople);
    } catch (error) { this.db.close(); throw error; }
  }
  /** Diagnóstico v18: páginas de instantánea reutilizadas del directorio confirmado frente a recodificadas. */
  get snapshotPageStats(): { reused: number; encoded: number } { return this.snapshotParts.pageStats; }
  get snapshotFaunaCorteStats(): { compared: number; accepted: number; rejected: number; reused: number } {
    return this.snapshotParts.faunaCorteStats;
  }
  get snapshotTeselasCorteStats(): { reused: number; recoded: number } {
    return this.snapshotParts.teselasCorteStats;
  }
  get context(): WorldContext {
    return { loadChunk: (key, atTick, v23) => this.loadChunk(key, atTick, v23),
      loadLegacy: (id, atTick) => this.loadLegacy(id, atTick),
      ...(this.schemaVersion >= 4 ? { catalogueReader: this.catalogueReader } : {}) };
  }
  private readTechnologyRecipe(id: string, atTick: number): TechnologyRecipe | null {
    if (this.schemaVersion < 4) return null;
    const reads = typeof atTick === 'number' && typeof id === 'string' ? this.technologyReads : null, key = `${atTick}:${id}`;
    if (reads?.recipes.has(key)) return copyArchivedRecipe(reads.recipes.get(key)!);
    const memo = reads ? reads.warmMemo : this.archivedRecipeMemo(id, atTick);
    const remembered = memo?.recipes.get(id);
    if (memo && remembered) {
      // Válida si la lectura recordada y ésta miran ambas desde la fila más reciente o después.
      memo.horizon ??= this.technologyArchive.latestTick();
      if (remembered.atTick >= memo.horizon && atTick >= memo.horizon) return remembered.value && copyArchivedRecipe(remembered.value);
    }
    const definition = this.technologyArchive.getDefinition(id, atTick);
    if (!definition) { if (!reads) memo?.recipes.set(id, { atTick, value: null }); return null; }
    const stats = this.technologyArchive.getStats(id, atTick);
    if (!stats) technologyFailure('definition has no statistics at the requested tick');
    const { lawsVersion: _lawsVersion, ...recipe } = definition;
    const value = { ...recipe, uses: stats!.uses, utility: stats!.utility, manufactured: stats!.manufactured };
    if (reads) {
      if (reads.recipes.size >= reads.limit) reads.recipes.delete(reads.recipes.keys().next().value!);
      reads.recipes.set(key, copyArchivedRecipe(value));
    } else memo?.recipes.set(id, { atTick, value: copyArchivedRecipe(value) });
    return value;
  }
  /** Memoria de recetas archivadas durante la simulación (sprint noche-perf 2026-09-22). La ventana
   * residente del mundo (`budgets.maxRecipes` = 256) es menor que las recetas que recuerdan los vivos
   * (1 066 distintas a día 6 en la semilla 51926 con las leyes candidatas), así que casi toda
   * resolución volvía a SQLite: 82 lecturas verificadas por paso, un cuarto del paso. Una lectura
   * «a fecha de» `atTick` sólo puede cambiar si cambia la base —lo delata el sello del archivo, que
   * cualquier escritura propia o ajena mueve— o si hay filas posteriores a `atTick`; por eso sólo se
   * reutiliza con el sello intacto, fuera de toda transacción y cuando la lectura recordada y la nueva
   * miran ambas desde la fila más reciente (`horizon`, que se consulta sólo al primer reuso de cada
   * sello: con un guardado por paso casi nunca se llega a pedir). Cada receta se lee y verifica
   * entera la primera vez; después se devuelve una copia de ese mismo valor, como hace la memoria de
   * validación de arriba. Nada de esto entra en el mundo ni en el disco. */
  private archivedRecipes: ArchivedRecipeMemo | null = null;
  /** Lote de lecturas (sprint noche-perf2 2026-09-22): `stepWorld` avanza un tick sin escribir nada en
   * el archivo y sin ceder el hilo, y con ~230 habitantes hace ~900 lecturas de recetas archivadas: el
   * sello de cada una era ~5 % del paso. Dentro del lote, las lecturas a fecha del tick del lote usan el
   * sello tomado al empezarlo: el paso ve una sola foto del archivo. Una escritura propia es imposible
   * dentro del lote (el mundo sólo lee; guardar es del anfitrión, entre pasos); una ajena a mitad del
   * lote se ve en la primera lectura fuera de él, que vuelve a pedir el sello completo, y lo recordado
   * dentro se olvida entonces. Las lecturas sueltas (`resolve` fuera de un lote) siguen validando el
   * sello una por una. */
  private batchEpoch: { atTick: number; epoch: string | null } | null = null;
  private readBatch<T>(atTick: number, read: () => T): T {
    if (this.batchEpoch || this.technologyReads !== null || this.schemaVersion < 4 || typeof atTick !== 'number' || !Number.isSafeInteger(atTick)) return read();
    this.batchEpoch = { atTick, epoch: this.technologyArchive.readEpoch() };
    try { return read(); } finally { this.batchEpoch = null; }
  }
  private archivedRecipeMemo(id: unknown, atTick: unknown): ArchivedRecipeMemo | null {
    if (typeof id !== 'string' || typeof atTick !== 'number' || !Number.isSafeInteger(atTick)) return null;
    const batch = this.batchEpoch;
    const epoch = batch && batch.atTick === atTick ? batch.epoch : this.technologyArchive.readEpoch();
    if (epoch === null) { this.archivedRecipes = null; return null; }
    let memo = this.archivedRecipes;
    if (!memo || memo.epoch !== epoch) {
      memo = this.archivedRecipes = { epoch, horizon: undefined, recipes: new Map() };
    } else if (memo.recipes.size >= ARCHIVED_RECIPE_MEMO_LIMIT && !memo.recipes.has(id)) {
      memo.recipes.delete(memo.recipes.keys().next().value!);
    }
    return memo;
  }
  /** Only this synchronous validation owns the read snapshot and its temporary
   * resolution memory. Neither caller-owned transactions nor subsequent saves
   * can reuse it. Every miss keeps the archive's complete validation path. */
  private withTechnologyReads(world: World, validate: () => void): void {
    if (this.db.isTransaction || this.schemaVersion < 4) { validate(); return; }
    this.db.exec('BEGIN');
    try {
      this.db.prepare('SELECT 1 FROM main.sqlite_schema LIMIT 1').get();
      const before = this.chronicleStamp();
      const currentEpoch = `${before.dataVersion}:${before.totalChanges}:${before.schemaCookie}:${before.tempSchemaCookie}`;
      const warmMemo = this.archivedRecipes && this.archivedRecipes.epoch === currentEpoch ? this.archivedRecipes : null;
      this.technologyArchive.beginHostTransaction();
      this.technologyReads = { limit: Math.max(ARCHIVED_RECIPE_MEMO_LIMIT, world.technology.recipes.length), recipes: new Map(), warmMemo };
      validate();
      if (!this.db.isTransaction || !sameChronicleStamp(before, this.chronicleStamp()))
        technologyFailure('database changed during technology validation');
      this.db.exec('COMMIT');
      this.technologyArchive.acknowledgeHostCommit();
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      this.technologyArchive.invalidateVerification();
      throw error;
    } finally { this.technologyReads = null; }
  }
  /** Validate the old complete representation before adopting bounded local memory.
   * An existing catalogue is never repaired or pruned to make corrupted input load. */
  private prepareTechnology(world: World, committedThrough = 0, validate: (world: World) => void = assertTechnology): void {
    this.withTechnologyReads(world, () => {
      bindWorldContext(world, this.context);
      if (this.schemaVersion >= 4 && world.technology.catalogue === undefined) {
        assertWorld(world, world.version, this.context);
        enableTechnologyCatalogue(world.technology, { committedThrough });
        for (const actor of world.people) maintainTechnologyMemory(world, actor);
      }
      assertTechnologyCatalogueState(world);
      validate(world);
    });
  }
  private replayParent(digest: string): string {
    const row = this.db.prepare('SELECT value FROM main.metadata WHERE key=?').get(REPLAY_KEY + digest) as { value: string } | undefined;
    if (!row || checksum(row.value) !== digest) throw new SnapshotPhysicalError('Replay parent missing or checksum mismatch.');
    return row.value;
  }
  private committedReplayWorld(world: World): World {
    const committed = { ...world, retiredChunks: [], retiredLegacy: [],
      chronicleJournal: chronicleForCommit(world, this.chronicleDigest(world)),
      technology: technologyCatalogueStateForCommit(technologyStateForCommit(world.technology)) };
    setParams(committed, paramsOf(world));
    return committed;
  }
  private replayDelta(world: World, node: Extract<SnapshotReplay, { kind: 'delta' }>, legado?: { gobernador: GobernadorLegado }): World {
    if (node.tick < world.tick) throw new SnapshotSemanticError('Replay tick regressed. Explicit recovery required.');
    let input = 0, change = 0;
    for (const entry of node.inputs) if (entry.result.tick <= world.tick || entry.result.tick > node.tick)
      throw new SnapshotSemanticError('Replay gesture outside commit. Explicit recovery required.');
    let lastTick = world.tick;
    for (const entry of node.changes) {
      if (entry.tick < lastTick || entry.tick > node.tick) throw new SnapshotSemanticError('Replay dirty timeline is invalid. Explicit recovery required.');
      lastTick = entry.tick;
    }
    for (;;) {
      while (change < node.changes.length && node.changes[change]!.tick === world.tick) {
        const entry = node.changes[change++]!;
        assertReplayPath(entry.path);
        if (entry.path[0] === '$params') {
          if (entry.path.length !== 1 || !entry.present || !entry.value || typeof entry.value !== 'object' || Array.isArray(entry.value))
            throw new SnapshotSemanticError('Invalid replay parameter change. Explicit recovery required.');
          let params = entry.value as Record<string, unknown>;
          if (legado) ({ params, gobernador: legado.gobernador } = separarGobernadorLegado(params, legado.gobernador));
          setParams(world, parseParams(params, paramsOf(world)));
          continue;
        }
        let parent = world as unknown as Record<string, unknown>;
        for (const key of entry.path.slice(0, -1)) {
          if (!Object.hasOwn(parent, key) || !parent[key] || typeof parent[key] !== 'object')
            throw new SnapshotSemanticError('Replay dirty parent is missing. Explicit recovery required.');
          parent = parent[key] as Record<string, unknown>;
        }
        const key = entry.path.at(-1)!;
        if (entry.present) parent[key] = JSON.parse(stringifyExact(entry.value));
        else delete parent[key];
      }
      if (world.tick === node.tick) break;
      const batch: typeof node.inputs = [];
      while (input < node.inputs.length && node.inputs[input]!.result.tick === world.tick + 1) batch.push(node.inputs[input++]!);
      if (batch.some((entry, order) => entry.result.order !== order))
        throw new SnapshotSemanticError('Replay gesture order is invalid. Explicit recovery required.');
      const results = stepWorld(world, batch.map(entry => entry.gesture), this.context);
      if (stringifyExact(results) !== stringifyExact(batch.map(entry => entry.result)))
        throw new SnapshotSemanticError('Replay gesture result mismatch. Explicit recovery required.');
      this.onProgress?.();
    }
    if (input !== node.inputs.length || change !== node.changes.length)
      throw new SnapshotSemanticError('Replay input timeline is invalid. Explicit recovery required.');
    const committed = this.committedReplayWorld(world);
    if (stringifyExact(node.journals) !== stringifyExact({ chronicle: committed.chronicleJournal, technology: committed.technology.journal }))
      throw new SnapshotSemanticError('Replay journal mismatch. Explicit recovery required.');
    return committed;
  }
  /** Iterative and bounded before any simulation. No partially replayed world is
   * published, cached or written if a parent, root or execution fails. */
  private replayWorld(body: string): World {
    const chain: SnapshotReplay[] = [];
    let node = readSnapshotReplay(parseSnapshotJSON(body));
    if (!node) throw new SnapshotSemanticError('Missing replay encoding. Explicit recovery required.');
    for (;;) {
      chain.push(node);
      if (node.kind === 'checkpoint') break;
      if (chain.length >= DEEP_CHECKPOINT_EVERY_SAVES) throw new SnapshotSemanticError('Replay exceeds 99 commits. Explicit recovery required.');
      const parent = readSnapshotReplay(parseSnapshotJSON(this.replayParent(node.parent)));
      if (!parent || parent.depth + 1 !== node.depth || parent.tick > node.tick)
        throw new SnapshotSemanticError('Replay parent depth or tick mismatch. Explicit recovery required.');
      node = parent;
    }
    if (node.kind !== 'checkpoint') throw new SnapshotSemanticError('Missing replay checkpoint.');
    const decoded = this.snapshotParts.read(node.body) as World & { params?: Record<string, unknown> };
    const legado = { gobernador: separarGobernadorLegado(decoded.params ?? {}).gobernador };
    let world = this.migrateSnapshot(decoded);
    let root = digestoCanonico(world, legado.gobernador);
    for (const entry of chain.reverse()) {
      if (entry.kind === 'delta') {
        const changed = entry.tick !== world.tick || entry.changes.length !== 0 || entry.inputs.length !== 0;
        const priorRoot = root;
        world = this.replayDelta(world, entry, legado);
        // Fase 2: compromiso del delta. Fallbacks: la fase 1 guardaba el SHA
        // canónico cuando había cambios y heredaba la raíz si no los había.
        if (replayDeltaRoot(entry) !== entry.root
          && (changed ? digestoCanonico(world, legado.gobernador) !== entry.root : priorRoot !== entry.root))
          throw new SnapshotSemanticError('Replay canonical hash mismatch (unmarked page or state). Explicit recovery required.');
        root = entry.root;
      }
      if (world.version !== entry.rules || world.tick !== entry.tick || root !== entry.root)
        throw new SnapshotSemanticError('Replay canonical hash mismatch (unmarked page or state). Explicit recovery required.');
    }
    return world;
  }
  private readSnapshot(body: string): unknown {
    if (!body.startsWith('{"snapshotReplay":') || this.readCompleteEpoch() !== null) return this.snapshotParts.read(body);
    const world = this.replayWorld(body);
    // Keep the same decoded transport contract as SnapshotParts: the next
    // migrateSnapshot owns taking the effective parameters off the record.
    return { ...world, paramsEncoding: 'params-v1', params: paramsOf(world) };
  }
  private prepareReplay(world: World, inputs: { gesture: Gesture; result: GestureResult }[], changes: readonly SnapshotReplayChange[],
    durableSaves: number): { node: SnapshotReplay; world: World } {
    const current = this.db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get() as Row | undefined;
    const parent = current && checksum(current.body) === current.digest ? readSnapshotReplay(parseSnapshotJSON(current.body)) : null;
    const committed = this.committedReplayWorld(world);
    let candidate: World;
    if (parent && current && this.slot0Readable !== false) {
      const node: Extract<SnapshotReplay, { kind: 'delta' }> = { snapshotReplay: 1, rules: world.version, kind: 'delta', tick: world.tick,
        depth: parent.depth + 1, parent: current.digest, root: parent.root, inputs: JSON.parse(stringifyExact(inputs)),
        changes: JSON.parse(stringifyExact(changes)), journals: { chronicle: committed.chronicleJournal, technology: committed.technology.journal } };
      const cached = this.replayCache;
      // La auditoría retenida de abajo vuelve a leer la cadena cada diez
      // guardados. Repetir esa reconstrucción aquí no añade evidencia: la caché
      // está ligada al digest del padre y a todos los sellos SQLite.
      const cachedPrior = cached?.digest === current.digest && sameChronicleStamp(cached.stamp, this.chronicleStamp())
        ? cached.world : null;
      const prior = cachedPrior ?? this.replayWorld(current.body);
      // `replayDelta` muta su argumento. Consumir la caché evita clonar el mundo
      // completo en la ruta normal; retirarla ANTES hace que cualquier excepción o
      // rollback obligue a reconstruir desde el cuerpo durable en el reintento.
      if (cachedPrior) this.replayCache = null;
      candidate = this.replayDelta(prior, node);
      if (!sameReplayState(candidate, committed))
        throw new SnapshotSemanticError('Replay canonical hash mismatch (unmarked page or state). Snapshot was not written.');
      node.root = replayDeltaRoot(node);
      if (parent.depth < DEEP_CHECKPOINT_EVERY_SAVES - 1 && durableSaves % DEEP_CHECKPOINT_EVERY_SAVES !== 0) return { node, world: candidate };
    } else candidate = cloneWorld(committed, this.context);
    const root = digestoCanonico(candidate);
    return { node: { snapshotReplay: 1, rules: world.version, kind: 'checkpoint', tick: world.tick, depth: 0, root, body: '' }, world: candidate };
  }
  /** Objects and paged checkpoints belong to the three retained heads, including
   * the old checkpoint needed by previous() at a checkpoint rollover. */
  private collectSnapshots(reuse?: SnapshotReuseTicket): void {
    const objects = this.db.prepare('SELECT key,value FROM main.metadata WHERE key GLOB ?').all(REPLAY_KEY + '*') as { key: string; value: string }[];
    if (!objects.length) { this.snapshotParts.collect(reuse); return; }
    const retained = new Set<string>(), pages = new Set<string>();
    const visit = (body: string, remaining: number): void => {
      const node = readSnapshotReplay(parseSnapshotJSON(body));
      if (node) {
        if (remaining === 0) throw new SnapshotSemanticError('Replay collection exceeds depth.');
        const digest = checksum(body);
        if (retained.has(REPLAY_KEY + digest)) return;
        retained.add(REPLAY_KEY + digest);
        if (node.kind === 'delta') visit(this.replayParent(node.parent), remaining - 1);
        else visit(node.body, remaining - 1);
      } else {
        const value = parseSnapshotJSON(body) as { snapshotEncoding?: unknown; tiles?: { pages?: { digest: string }[] } };
        this.snapshotParts.verify(body);
        if (value?.snapshotEncoding === 'snapshot-parts-v1') for (const page of value.tiles!.pages!) pages.add(page.digest);
      }
    };
    try {
      for (const row of this.db.prepare('SELECT body,digest FROM snapshots').all() as Row[]) {
        if (checksum(row.body) !== row.digest) return;
        visit(row.body, DEEP_CHECKPOINT_EVERY_SAVES + 1);
      }
    } catch (error) {
      // An unreadable backup is not evidence that it has no references.
      if (error instanceof SnapshotPhysicalError || error instanceof SnapshotSemanticError) return;
      throw error;
    }
    for (const row of objects) if (!retained.has(row.key)) this.db.prepare('DELETE FROM main.metadata WHERE key=?').run(row.key);
    this.db.prepare('DELETE FROM main.snapshot_parts WHERE digest NOT IN (SELECT value FROM json_each(?))').run(JSON.stringify([...pages]));
  }
  private replayFloor(atTick: number): number | null {
    let floor = atTick;
    try {
      for (const row of this.db.prepare('SELECT body,digest FROM snapshots').all() as Row[]) {
        if (checksum(row.body) !== row.digest) return null;
        let node = readSnapshotReplay(parseSnapshotJSON(row.body));
        if (!node) continue;
        for (let remaining = DEEP_CHECKPOINT_EVERY_SAVES; node.kind === 'delta'; remaining--) {
          if (remaining <= 0) return null;
          const parent = readSnapshotReplay(parseSnapshotJSON(this.replayParent(node.parent)));
          if (!parent || parent.depth + 1 !== node.depth) return null;
          node = parent;
        }
        const digest = checksum(node.body);
        let checkpointFloor = this.replayFloors.get(digest);
        if (checkpointFloor === undefined) {
          const world = this.snapshotParts.read(node.body) as World;
          checkpointFloor = world.tick;
          for (const event of world.events) checkpointFloor = Math.min(checkpointFloor, event.tick);
          for (const receipt of world.technology.history) checkpointFloor = Math.min(checkpointFloor, receipt.tick);
          this.replayFloors.set(digest, checkpointFloor);
          while (this.replayFloors.size > 8) this.replayFloors.delete(this.replayFloors.keys().next().value!);
        }
        floor = Math.min(floor, checkpointFloor);
      }
    } catch (error) {
      if (error instanceof SnapshotPhysicalError || error instanceof SnapshotSemanticError) return null;
      throw error;
    }
    return floor;
  }
  /** C10: leer es una transacción. Una copia en caliente o un guardado de otra
   * conexión ya no puede convertir una lectura correcta en «corrupción»: la
   * instantánea queda congelada durante toda la verificación. */
  load(): LoadedSnapshot | null {
    return this.loadTransaction(rawTransaction => {
      if (this.readCompleteEpoch() !== null) throw new Error('El mundo usa guardado completo. Cárgalo con Store.cargarInstantanea.');
      return this.loadVerified(rawTransaction);
    });
  }

  cargarInstantanea(): InstantaneaCargada | null {
    const carga = this.cargarGuardadoCompleto();
    if (!carga) { this.assertNewCompleteStore(); return null; }
    const { metadatos: _metadatos, ...instantanea } = carga;
    return instantanea;
  }

  cargarGuardadoCompleto(): (InstantaneaCargada & { metadatos: Omit<LoadedSnapshot, 'world'> }) | null {
    if (this.readOnly || this.db.isTransaction) throw new Error('Store.cargarInstantanea requiere una transacción propia de escritura.');
    let matterStamp: ChronicleStamp | null = null;
    const carga = this.loadTransaction(rawTransaction => {
      const anterior = this.readCompleteEpoch();
      if (anterior === null) return null;
      const loaded = this.loadVerified(rawTransaction, true);
      if (!loaded) throw new SnapshotPhysicalError('Falta el mundo del guardado completo.');
      const { materia, digest } = this.readCompleteMatter(loaded.slot, loaded.world.tick);
      const { world, agendaBruta, ...metadatos } = loaded;
      const corteAgenda = this.decodeCompleteAgenda(agendaBruta, digest, materia, world.tick, anterior);
      const epoca = Math.max(anterior, materia?.epoca ?? 0) + 1;
      if (!Number.isSafeInteger(epoca)) throw new SnapshotSemanticError('La época de carga excede el rango de enteros exactos.');
      this.db.prepare('UPDATE main.metadata SET value=? WHERE key=?').run(String(epoca), EPOCA_COMPLETA_KEY);
      if (this.readCompleteEpoch() !== epoca) throw new SnapshotSemanticError('La época cambió antes del commit.');
      // Reservar la época es la única escritura después de leer materia. Solo sin triggers
      // esa lectura prueba también el estado tras la reserva y evita repetirla al primer guardado.
      if (loaded.slot === 0 && !this.chronicleHasTriggers()) matterStamp = this.chronicleStamp();
      return { instantanea: { world, materia }, epoca, metadatos, ...(corteAgenda && { corteAgenda }) };
    }, true);
    this.loadedMatterStamp = matterStamp;
    return carga;
  }

  /** Verifica una copia en solo lectura sin abrir una época del motor. */
  verificarGuardado(): LoadedSnapshot | null {
    return this.loadTransaction(rawTransaction => {
      const epoca = this.readCompleteEpoch();
      const loaded = this.loadVerified(rawTransaction, epoca !== null);
      if (epoca === null) return loaded;
      if (!loaded) throw new SnapshotPhysicalError('Falta el mundo del guardado completo.');
      const { agendaBruta, ...verificado } = loaded;
      const { materia, digest } = this.readCompleteMatter(loaded.slot, loaded.world.tick);
      this.decodeCompleteAgenda(agendaBruta, digest, materia, loaded.world.tick, epoca);
      return verificado;
    });
  }

  private completeMatterBody(slot: SnapshotSlot): Uint8Array | null {
    const row = this.db.prepare(`
      SELECT m.body FROM main.snapshot_matter m
      JOIN main.snapshots s ON s.slot=m.slot AND s.digest=m.world_digest WHERE s.slot=?
    `).get(slot) as { body: Uint8Array | null } | undefined;
    if (!row) throw new SnapshotPhysicalError('Falta la materia asociada al guardado completo.');
    return row.body;
  }

  private readCompleteMatter(slot: SnapshotSlot, tick: number): { materia: Instantanea['materia']; digest: string | null } {
    let quimica: ServicioQuimicoImpl | undefined;
    try {
      const resultado = this.snapshotMatterParts.decode(this.completeMatterBody(slot), (id, registro) =>
        (quimica ??= cargarSustancias(registro, { modo: 'inmediato' })).sustancia(id));
      if (resultado.materia) {
        quimica ??= cargarSustancias(resultado.materia.sustancias, { modo: 'inmediato' });
        if (resultado.materia.tick !== tick) throw new SnapshotSemanticError('Los ticks de mundo y materia no coinciden.');
      }
      return resultado;
    } finally { void quimica?.cerrar(); }
  }

  private retainedMatterManifests(): MatterManifestRow[] {
    // Haría falta leer los VMAT legados enteros si se filtrara en JavaScript.
    return this.db.prepare(`SELECT m.slot, m.world_digest, s.digest AS snapshot_digest, m.body
      FROM main.snapshot_matter m LEFT JOIN main.snapshots s ON s.slot=m.slot
      WHERE m.slot IN (0,1,2) AND substr(m.body,1,4)=X'564d5054' ORDER BY m.slot`).all() as unknown as MatterManifestRow[];
  }

  private collectMatterParts(strict: boolean): void {
    const installed = SnapshotMatterParts.installed(this.db);
    if (!installed && !strict) return;
    // Si la firma de un respaldo se perdió, el filtro de manifiestos no puede decidir
    // cuáles eran sus referencias. No se borra nada en un guardado ordinario.
    if (this.db.prepare(`SELECT 1 FROM main.snapshot_matter WHERE slot IN (1,2) AND body IS NOT NULL
      AND coalesce(substr(body,1,4) NOT IN (X'564d4154', X'564d5054'),1) LIMIT 1`).get()) {
      if (strict) throw new SnapshotPhysicalError('Formato desconocido de materia de respaldo.');
      return;
    }
    const manifests = this.retainedMatterManifests();
    if (!installed) {
      if (manifests.length) throw new SnapshotPhysicalError('Falta la tabla de partes de materia.');
      return;
    }
    try { this.snapshotMatterParts.collect(manifests.map(row => row.body)); }
    catch (error) {
      // collect enumera todos los manifiestos antes del primer DELETE. Los errores SQL
      // y la comprobación estricta siguen abortando la transacción.
      if (strict || !(error instanceof SnapshotPhysicalError)) throw error;
    }
  }

  private expectedMatterBackups(rotates: boolean, deep: boolean): Map<SnapshotSlot, MatterManifestRow> {
    const manifests = new Map(this.retainedMatterManifests().map(row => [row.slot, row]));
    const slot0 = manifests.get(0);
    manifests.delete(0);
    if (rotates && this.db.prepare('SELECT 1 FROM main.snapshot_matter WHERE slot=0').get()) {
      for (const slot of deep ? [1, 2] as const : [1] as const) {
        if (slot0) manifests.set(slot, slot0);
        else manifests.delete(slot);
      }
    }
    return manifests;
  }

  private verifyMatterBackups(expected: Map<SnapshotSlot, MatterManifestRow>): void {
    for (const row of this.retainedMatterManifests()) {
      if (row.snapshot_digest !== row.world_digest)
        throw new SnapshotPhysicalError('El manifiesto de materia no corresponde al mundo de su slot.');
      if (row.slot !== 0) {
        const before = expected.get(row.slot);
        if (!before || row.world_digest !== before.world_digest || Buffer.compare(row.body, before.body) !== 0)
          throw new SnapshotPhysicalError('El manifiesto de materia de un respaldo cambió antes del commit.');
        expected.delete(row.slot);
      }
      this.snapshotMatterParts.verify(row.body);
    }
    if (expected.size) throw new SnapshotPhysicalError('Falta el manifiesto de materia de un respaldo antes del commit.');
  }

  /** Sin un sello vigente, comprueba la pareja mundo/materia antes de sobrescribir respaldos. */
  private completeMatterCanRotate(world: World, epoca: number): boolean {
    try {
      const agenda = separarAgenda(world);
      if (agenda === undefined && this.requiereAgenda()) return false;
      const { materia, digest } = this.readCompleteMatter(0, world.tick);
      this.decodeCompleteAgenda(agenda, digest, materia, world.tick, epoca);
      return true;
    } catch (error) {
      // Los decodificadores VMAT y químicos de v1 informan errores de datos sin clase propia.
      if (!(error instanceof SnapshotPhysicalError) && !(error instanceof SnapshotSemanticError) &&
          (!(error instanceof Error) || error.constructor !== Error || 'code' in error)) throw error;
      return false;
    }
  }

  private decodeCompleteAgenda(raw: unknown, matterDigest: string | null, materia: Instantanea['materia'], tick: number, epocaReservada: number): CorteAgendaTerritorial | undefined {
    if (raw === undefined) return undefined;
    const adjunto = raw as Partial<AdjuntoAgenda> | null;
    if (!adjunto || typeof adjunto !== 'object' || adjunto.materiaDigest !== matterDigest)
      throw new SnapshotSemanticError('La agenda territorial no corresponde a la materia del guardado.');
    const epoca = materia?.epoca ?? adjunto.corte?.epoca;
    if (epoca === undefined || epoca > epocaReservada)
      throw new SnapshotSemanticError('La época de la agenda territorial no corresponde al guardado.');
    return validarCorteAgenda(adjunto.corte, epoca, tick);
  }

  private readCompleteEpoch(): number | null {
    const row = this.db.prepare('SELECT value FROM main.metadata WHERE key=?').get(EPOCA_COMPLETA_KEY) as { value: string } | undefined;
    if (!row) return null;
    const epoca = Number(row.value);
    if (!Number.isSafeInteger(epoca) || epoca < 0 || String(epoca) !== row.value)
      throw new SnapshotSemanticError('Contador durable de épocas inválido.');
    return epoca;
  }

  private requiereAgenda(): boolean {
    return !!this.db.prepare('SELECT 1 FROM main.metadata WHERE key=?').get(AGENDA_DURABLE_KEY);
  }

  private assertNewCompleteStore(): void {
    if (this.db.prepare(`SELECT 1 FROM main.snapshots
      UNION ALL SELECT 1 FROM main.metadata WHERE key='initialized' LIMIT 1`).get()) {
      throw new SnapshotSemanticError('El guardado completo de la V23 requiere un mundo nuevo.');
    }
  }

  private loadTransaction<T>(read: (rawTransaction: boolean) => T, opensEpoch = false): T {
    const rawTransaction = this.db.isTransaction;
    if (!rawTransaction) this.db.exec(opensEpoch ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      if (!rawTransaction) {
        // Lectura cebadora: fija la instantánea ANTES de sellar `data_version`.
        this.db.prepare('SELECT 1 FROM main.sqlite_schema LIMIT 1').get();
        // La carga hace miles de lecturas del archivo de tecnología (una por referencia de cada
        // ejecución archivada). Sin transacción anfitriona el archivo descarta sus pruebas en cada
        // lectura y vuelve a recorrer todas las definiciones: 468 s con 13 710 ejecuciones
        // (evidencia 2026-09-19). Dentro de la misma instantánea de lectura las pruebas siguen
        // siendo válidas, igual que en `save()`. Va dentro del `try`: si fallara, el `catch`
        // deshace el BEGIN en vez de dejar la conexión en transacción para siempre.
        this.technologyArchive.beginHostTransaction();
      }
      const loaded = read(rawTransaction);
      if (!rawTransaction && this.db.isTransaction) { this.db.exec('COMMIT'); this.technologyArchive.acknowledgeHostCommit(); }
      if (loaded && this.saves === 0) this.verifiedByLoad = true;
      return loaded;
    } catch (error) {
      if (!rawTransaction && this.db.isTransaction) this.db.exec('ROLLBACK');
      if (!rawTransaction) this.technologyArchive.invalidateVerification();
      throw error;
    }
  }
  /**
   * Recorre la cadena de respaldo y adopta la primera instantánea LEGIBLE, con dos
   * límites que mantienen la ley de frontera:
   * 1. Solo se salta el DAÑO FÍSICO —fila ausente, checksum roto, JSON ilegible—, que es
   *    justo para lo que existen las copias. Una instantánea que se lee entera pero
   *    INFRINGE una ley no se sustituye por un respaldo: eso taparía un estado inválido
   *    en vez de recuperarlo, así que falla cerrada como siempre (Constitución VI).
   * 2. Un respaldo (slot > 0) solo entra en caliente si el archivo durable no guarda NADA
   *    posterior; si lo guarda, adoptarlo tiraría lo ya vivido y la recuperación tiene
   *    que ser explícita (`previous()`, que poda y revoca en una copia nueva).
   */
  private loadVerified(rawTransaction: boolean, complete = false): LoadedSnapshotBruto | null {
    const chronicleStamp = this.chronicleStamp();
    this.verifiedChronicle = null;
    const check = this.db.prepare('PRAGMA quick_check').get() as Record<string, unknown>;
    if (Object.values(check)[0] !== 'ok') throw new Error('SQLite integrity check failed. Explicit recovery required.');
    this.onProgress?.();
    const refusals: string[] = [];
    // El momento del eslabón dañado MÁS RECIENTE cuya fila seguía ahí: es lo único que
    // mide el retroceso de un rescate, porque el cuerpo que lo superaba no se puede leer.
    let supersededAt: number | null = null;
    for (const slot of SNAPSHOT_SLOTS) {
      const row = this.db.prepare('SELECT body,digest,saved_at FROM snapshots WHERE slot=?').get(slot) as Row | undefined;
      if (!row) { refusals.push(`slot ${slot}: snapshot missing`); continue; }
      const refuse = (reason: string) => { refusals.push(`slot ${slot}: ${reason}`); supersededAt ??= row.saved_at; };
      if (checksum(row.body) !== row.digest) { refuse('snapshot checksum mismatch'); continue; }
      let decoded: World;
      try { decoded = (complete ? this.snapshotParts.read(row.body) : this.readSnapshot(row.body)) as World; }
      catch (error) {
        if (!(error instanceof SnapshotPhysicalError)) throw error;
        refuse(error.message); continue;
      }
      // Un slot 0 que se lee entero es el único cuerpo que `save()` puede copiar a un
      // respaldo. Si adoptamos un respaldo, el slot 0 queda marcado como NO fiable.
      this.slot0Readable = slot === 0;
      return this.loadSlot(row, decoded, slot, rawTransaction, chronicleStamp, refusals, supersededAt, complete);
    }
    if (refusals.every(reason => reason.endsWith('snapshot missing'))
      && !this.db.prepare("SELECT value FROM metadata WHERE key='initialized'").get()) { this.slot0Readable = true; return null; }
    throw new Error(`Snapshot missing or unusable in every backup slot (${refusals.join('; ')}). Explicit recovery required.`);
  }
  private loadSlot(row: Row, decoded: World, slot: SnapshotSlot, rawTransaction: boolean, chronicleStamp: ChronicleStamp,
    skipped: string[], supersededAt: number | null, complete: boolean): LoadedSnapshotBruto {
    const declaredChronicle = decoded.chronicleJournal !== undefined;
    const agendaBruta = separarAgenda(decoded);
    if (!complete && agendaBruta !== undefined) throw new SnapshotSemanticError('La agenda territorial requiere guardado completo.');
    if (complete && agendaBruta === undefined && this.requiereAgenda())
      throw new SnapshotSemanticError(`Falta el corte territorial en el guardado seleccionado (slot ${slot}).`);
    const world = this.migrateSnapshot(decoded, complete);
    this.onProgress?.();
    if (slot > 0) this.assertNothingNewerThan(world);
    if (world.technology.catalogue && (world.technology.catalogue.pending.length ||
      world.technology.catalogue.committedThrough !== world.technology.recipeCounter)) technologyFailure('snapshot contains uncommitted definitions');
    this.assertChronicleOrigin(world, declaredChronicle);
    this.assertChronicleArchive(world);
    this.onProgress?.();
    const declaredJournal = world.technology.journal !== undefined;
    enableTechnologyJournal(world.technology);
    assertTechnologyJournal(world.technology, world.tick);
    let chain: TechnologyChain | null = null;
    if (declaredJournal) {
      if (world.technology.journal!.pending.length || world.technology.journal!.committedThrough !== world.technology.executionCounter) technologyFailure('snapshot contains uncommitted executions');
      if (this.schemaVersion >= 4) this.assertTechnologyCache(world);
      chain = this.assertTechnologyCoverage(world);
      this.onProgress?.();
    } else if (this.schemaVersion >= 4 && (this.technologyArchive.getHistoryOrigin()
      || ['technology_definitions', 'technology_stats', 'technology_executions'].some(table => this.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()))) {
      technologyFailure('an unjournaled snapshot cannot describe an initialized archive');
    }
    // A migrated global allocator must remain above every archived identity, too.
    // Otherwise a corrupted counter could allocate an ID already living in a dormant region.
    if(this.schemaVersion>=2) {
      const archived=this.db.prepare("SELECT MAX(CAST(substr(json_extract(s.value,'$.id'),11) AS INTEGER)) AS maximum FROM chunks c, json_each(c.body,'$.structures') s WHERE c.tick<=? AND json_extract(s.value,'$.id') GLOB 'structure-[0-9]*'").get(world.tick) as {maximum:number|null};
      if(archived.maximum!==null&&(!Number.isSafeInteger(archived.maximum)||archived.maximum>world.structureCounter))throw new Error('Archived structure identity exceeds snapshot counter. Explicit recovery required.');
      const animals=this.db.prepare("SELECT DISTINCT json_extract(a.value,'$.id') AS id FROM chunks c, json_each(c.body,'$.animals') a WHERE c.tick<=? AND json_extract(a.value,'$.generation')>0").all(world.tick) as {id:string}[];
      for(const animal of animals){const serial=/^animal-born-\d+-\d+-([1-9]\d*)$/.exec(animal.id);if(serial&&(!Number.isSafeInteger(Number(serial[1]))||Number(serial[1])>world.animalCounter))throw new Error('Archived animal identity exceeds snapshot counter. Explicit recovery required.');}
    }
    if (this.schemaVersion>=3) {
      const count=this.db.prepare('SELECT COUNT(*) AS count FROM legacy WHERE tick<=?').get(world.tick) as {count:number};
      if (count.count!==world.demographyDynamics.deaths) throw new Error('Identity archive count disagrees with snapshot. Explicit recovery required.');
      for (const record of world.legacy) {
        const archived=this.loadLegacy(record.id,world.tick);
        if (!archived || stringifyExact(archived)!==stringifyExact(record)) throw new Error('Cached identity disagrees with archive. Explicit recovery required.');
        this.assertLegacyParents(record,world);
      }
      const serial=this.db.prepare("SELECT MAX(CAST(substr(id,12) AS INTEGER)) AS maximum FROM legacy WHERE tick<=? AND id GLOB 'descendant-[0-9]*'").get(world.tick) as {maximum:number|null};
      if (serial.maximum!==null&&(!Number.isSafeInteger(serial.maximum)||serial.maximum>world.birthCounter)) throw new Error('Archived human identity exceeds snapshot counter. Explicit recovery required.');
      for (const person of world.people) if(this.loadLegacy(person.id,world.tick)) throw new Error('A deceased identity is present among living inhabitants. Explicit recovery required.');
    }
    this.prepareTechnology(world, declaredJournal && this.schemaVersion >= 4 ? world.technology.recipeCounter : 0);
    if (declaredJournal && this.schemaVersion >= 4) this.rememberTechnology(world, chain!);
    this.rememberSlotBounds(row.digest, world);
    if (!sameChronicleStamp(chronicleStamp, this.chronicleStamp())) chronicleFailure('database changed while loading');
    if (!rawTransaction) this.rememberChronicle(world, chronicleStamp);
    return { world, savedAt: row.saved_at, slot, skipped, supersededAt: slot > 0 ? supersededAt : null,
      ...(agendaBruta !== undefined && { agendaBruta }) };
  }
  /** ¿El cuerpo del slot 0 se lee entero? Lo pregunta `save()` cuando esta conexión aún
   * no ha cargado nada (no consta el estado de la cadena) y solo la primera vez: después
   * lo sabe por el guardado que acaba de confirmar. Un slot 0 ausente no tiene nada que
   * propagar, así que la rotación —que copiaría cero filas— no hace daño. */
  private readSlot0(completeEpoch: number | null = null): boolean {
    const row = this.db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get() as Row | undefined;
    if (!row) return this.slot0Readable = true;
    if (checksum(row.body) !== row.digest) return this.slot0Readable = false;
    try {
      const world = this.readSnapshot(row.body) as World;
      if (completeEpoch !== null && !this.completeMatterCanRotate(world, completeEpoch)) return this.slot0Readable = false;
    }
    catch (error) {
      if (!(error instanceof SnapshotPhysicalError)) throw error;
      return this.slot0Readable = false;
    }
    return this.slot0Readable = true;
  }
  /** Un respaldo solo se adopta EN CALIENTE si el archivo durable acaba donde acaba él.
   * En cuanto el archivo guarda un suceso, un gesto, una región, una identidad o una
   * observación técnica posterior, adoptarlo significaría tirar lo ya vivido: eso es
   * recuperación, no arranque, y pasa por `previous()` —que poda en una copia nueva y
   * revoca las sesiones— o por `npm run recover:previous -- <dir> --slot N`. */
  private assertNothingNewerThan(world: World): void {
    const later = (sql: string, ...values: (string | number)[]) => !!this.db.prepare(sql).get(...values);
    const behind = (): never => { throw new Error('Backup snapshot is behind the durable archive. Explicit recovery required.'); };
    if (later('SELECT 1 FROM inputs WHERE tick>? LIMIT 1', world.tick)) behind();
    if (this.schemaVersion >= 2 && later('SELECT 1 FROM chunks WHERE tick>? LIMIT 1', world.tick)) behind();
    if (this.schemaVersion >= 3 && later('SELECT 1 FROM legacy WHERE tick>? LIMIT 1', world.tick)) behind();
    if (this.schemaVersion >= 4 && (later('SELECT 1 FROM technology_executions WHERE serial>? LIMIT 1', world.technology.executionCounter)
      || later('SELECT 1 FROM technology_stats WHERE tick>? LIMIT 1', world.tick)
      || later("SELECT 1 FROM technology_definitions WHERE id GLOB 'recipe-[0-9]*' AND CAST(substr(id,8) AS INTEGER)>? LIMIT 1", world.technology.recipeCounter))) behind();
  }
  private readLegacyRecord(id: string, atTick: number, statement?: StatementSync): LegacyRecord | null {
    if (typeof id!=='string'||!id.length||id.length>50||!Number.isSafeInteger(atTick)||atTick<0) throw new RangeError('Invalid identity archive lookup.');
    if (this.schemaVersion<3) return null;
    const row=(statement ?? this.db.prepare('SELECT body,digest,tick FROM legacy WHERE id=? AND tick<=?')).get(id,atTick) as {body:string;digest:string;tick:number}|undefined;
    if (!row) return null;
    if (checksum(row.body)!==row.digest) throw new Error('Archived identity checksum mismatch. Explicit recovery required.');
    const record:unknown=JSON.parse(row.body); assertLegacyRecord(record,atTick);
    if(record.id!==id||record.diedAt!==row.tick) throw new Error('Archived identity key or date mismatch. Explicit recovery required.');
    return record;
  }
  loadLegacy(id: string, atTick=Number.MAX_SAFE_INTEGER): LegacyRecord | null {
    return this.readLegacyRecord(id, atTick);
  }
  private assertLegacyParents(record: LegacyRecord, world: World): void {
    const parents = record.parents.map(id => world.people.find(p => p.id === id)
      ?? world.retiredLegacy.find(p => p.id === id) ?? this.loadLegacy(id, world.tick));
    if (!genealogiaValida(record, parents, ley(world, 'natalidad'))) {
      throw new Error('Archived genealogy is inconsistent. Explicit recovery required.');
    }
  }
  /** Los lectores históricos sin un mundo conocido validan la forma que comparten los dos modos. */
  loadChunk(key: string, atTick = Number.MAX_SAFE_INTEGER, v23?: WorldParams['v23']): Chunk | null {
    coordinatesFromKey(key);
    if (!Number.isSafeInteger(atTick) || atTick < 0) throw new RangeError('Invalid archive lookup tick.');
    // Read-only recovery of a V1 database never silently creates an archive or alters its schema.
    if (this.schemaVersion === 1) return null;
    const row = this.db.prepare('SELECT body,digest,tick FROM chunks WHERE key=? AND tick<=? ORDER BY tick DESC LIMIT 1').get(key, atTick) as { body: string; digest: string; tick: number } | undefined;
    if (!row) return null;
    if (!Number.isSafeInteger(row.tick) || row.tick < 0 || checksum(row.body) !== row.digest) throw new Error('Archived chunk checksum or version mismatch. Explicit recovery required.');
    // T133: accepts both the historical plain-JSON body and `chunk-tiles-tuple-v1`.
    const chunk: unknown = decodeArchivedChunk(row.body);
    assertChunk(chunk, key, row.tick, v23);
    return chunk;
  }

  private dataVersion(): number { return Number(this.db.prepare('PRAGMA data_version').get()!.data_version); }
  private totalChanges(): number { return Number(this.db.prepare('SELECT total_changes() AS n').get()!.n); }
  private schemaCookie(): number { return Number(this.db.prepare('PRAGMA schema_version').get()!.schema_version); }

  private chronicleStamp(): ChronicleStamp {
    return { dataVersion: this.dataVersion(), totalChanges: this.totalChanges(), schemaCookie: this.schemaCookie(),
      tempSchemaCookie: Number(this.db.prepare('PRAGMA temp.schema_version').get()!.schema_version) };
  }
  private chronicleHasTriggers(): boolean {
    return !!this.db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='trigger' UNION ALL SELECT 1 FROM temp.sqlite_schema WHERE type='trigger' LIMIT 1").get();
  }
  private assertChronicleSchema(): void {
    if (this.db.prepare("SELECT 1 FROM temp.sqlite_schema WHERE name IN ('events','metadata','snapshots','snapshot_parts') LIMIT 1").get()) chronicleFailure('temporary objects shadow durable tables');
    for (const [table, fields] of [['events',['id','tick','body']],['metadata',['key','value']]] as const) {
      const columns = this.db.prepare(`PRAGMA main.table_info(${table})`).all() as { name: string; type: string; pk: number; notnull: number }[];
      if (columns.length !== fields.length || columns.some((column,index) => column.name !== fields[index]
        || column.type !== (column.name === 'tick' ? 'INTEGER' : 'TEXT') || column.pk !== (index === 0 ? 1 : 0)
        || index > 0 && column.notnull !== 1)) chronicleFailure('schema uniqueness or fields are invalid');
    }
  }
  private chronicleOrigin(): number | null {
    const row = this.db.prepare("SELECT value FROM main.metadata WHERE key='chronicle-origin-v1'").get() as { value: string } | undefined;
    if (!row) return null;
    let origin: { version?: unknown; startsAfter?: unknown };
    try { origin = JSON.parse(row.value); } catch { chronicleFailure('invalid durable origin'); }
    if (!origin! || typeof origin !== 'object' || Array.isArray(origin)
      || Object.keys(origin).sort().join(',') !== 'startsAfter,version' || origin.version !== 1
      || typeof origin.startsAfter !== 'number' || !Number.isSafeInteger(origin.startsAfter) || origin.startsAfter < 0) chronicleFailure('invalid durable origin');
    return origin.startsAfter as number;
  }
  private assertChronicleOrigin(world: World, declared: boolean, recoveringLegacy = false): void {
    const origin = this.chronicleOrigin();
    // Only the authentic adoption checkpoint can precede a declared journal.
    // A later checkpoint missing its journal must not erase an already covered
    // interval by reopening it as unknown during previous() recovery.
    if (declared ? origin !== world.chronicleJournal!.startsAfter
      : origin !== null && (!recoveringLegacy || origin !== world.eventCounter)) chronicleFailure('durable origin disagrees with snapshot');
  }
  private rememberChronicle(world: World, stamp: ChronicleStamp): void {
    const journal = world.chronicleJournal!;
    this.verifiedChronicle = { startsAfter: journal.startsAfter, through: journal.committedThrough,
      digest: journal.committedDigest, tick: world.tick, stamp };
  }
  private chronicleDigest(world: World): string {
    let digest = world.chronicleJournal!.committedDigest;
    for (const event of world.chronicleJournal!.pending) digest = checksum(`${digest}\n${JSON.stringify(event)}`);
    return digest;
  }
  /** Límite de poda: hasta qué serie se borró y con qué dígeste cerraba la cadena ahí.
   * Es el único modo de seguir verificando lo retenido sin releer lo borrado. */
  private prunedChronicle(): ChroniclePrune | null {
    const row = this.db.prepare("SELECT value FROM main.metadata WHERE key='chronicle-pruned-v1'").get() as { value: string } | undefined;
    if (!row) return null;
    let pruned: { version?: unknown; through?: unknown; digest?: unknown };
    try { pruned = JSON.parse(row.value); } catch { chronicleFailure('invalid prune boundary'); }
    if (!pruned! || typeof pruned !== 'object' || Array.isArray(pruned)
      || Object.keys(pruned).sort().join(',') !== 'digest,through,version' || pruned.version !== 1
      || typeof pruned.through !== 'number' || !Number.isSafeInteger(pruned.through) || pruned.through < 0
      || typeof pruned.digest !== 'string' || !/^[0-9a-f]{64}$/.test(pruned.digest)) chronicleFailure('invalid prune boundary');
    return { through: pruned.through as number, digest: pruned.digest as string };
  }
  /** Bounded memory: primary-key reads and a rolling digest, never a Set of the lifetime archive. */
  private assertChronicleArchive(world: World, allowLater = false): void {
    this.assertChronicleSchema();
    assertChronicleJournal(world);
    const journal = world.chronicleJournal!;
    if (journal.pending.length || journal.committedThrough !== world.eventCounter) chronicleFailure('snapshot contains uncommitted events');
    const lookup = this.db.prepare('SELECT id,tick,body FROM events WHERE id=?');
    const boundary = this.prunedChronicle();
    // Una instantánea anterior al límite de poda ya no se puede verificar: se
    // declara, no se rellena. Recuperar a ese punto exige recuperación explícita.
    if (boundary && boundary.through > journal.committedThrough) chronicleFailure('prune boundary escapes declared coverage');
    const pruned = boundary && boundary.through > journal.startsAfter ? boundary : null;
    let digest = pruned ? pruned.digest : EMPTY_CHRONICLE_DIGEST, tick = 0;
    for (let serial = (pruned ? pruned.through : journal.startsAfter) + 1; serial <= journal.committedThrough; serial++) {
      const row = lookup.get(`e${serial}`) as { id: string; tick: number; body: string } | undefined;
      if (!row) chronicleFailure('declared coverage has a gap');
      let event: unknown; try { event = JSON.parse(row!.body); } catch { chronicleFailure('invalid archived JSON'); }
      assertChronicleEvent(event, world.tick);
      if (event.id !== row!.id || event.tick !== row!.tick || event.tick < tick) chronicleFailure('archived identity or timeline disagrees');
      tick = event.tick; digest = checksum(`${digest}\n${row!.body}`);
      if (serial % 1024 === 0) this.onProgress?.();
    }
    if (digest !== journal.committedDigest) chronicleFailure('archive digest disagrees');
    if (!allowLater && this.db.prepare("SELECT 1 FROM events WHERE id GLOB 'e[0-9]*' AND (CAST(substr(id,2) AS INTEGER)>? OR CAST(substr(id,2) AS INTEGER)<=0 OR id<>'e'||CAST(substr(id,2) AS INTEGER)) LIMIT 1").get(world.eventCounter)) chronicleFailure('archived event exceeds snapshot counter');
    for (const event of world.events) {
      const row = lookup.get(event.id) as { tick: number; body: string } | undefined;
      if (!row || row.tick !== event.tick || row.body !== JSON.stringify(event)) chronicleFailure('visible event disagrees with archive');
    }
  }
  /** Called before any host SQL writes. A raw transaction can never supply a reusable proof. */
  private assertChronicleChanges(world: World, stampBeforeBegin: ChronicleStamp, trusted: boolean): void {
    const journal = world.chronicleJournal!, proof = this.verifiedChronicle;
    if (!trusted || !proof || !sameChronicleStamp(proof.stamp, stampBeforeBegin)
      || !sameChronicleStamp(stampBeforeBegin, this.chronicleStamp())) {
      this.verifiedChronicle = null;
      this.assertChronicleSchema();
      const row = this.db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get() as Row | undefined;
      if (!row) {
        if (this.chronicleOrigin() !== null || this.db.prepare("SELECT 1 FROM metadata WHERE key='initialized'").get() || this.db.prepare('SELECT 1 FROM events LIMIT 1').get()) chronicleFailure('baseline snapshot is missing');
        if (journal.committedThrough !== journal.startsAfter || journal.committedDigest !== EMPTY_CHRONICLE_DIGEST) chronicleFailure('committed history has no baseline');
      } else {
        if (checksum(row.body) !== row.digest) chronicleFailure('baseline snapshot checksum mismatch');
        const baseline = this.readSnapshot(row.body) as World, declared = baseline.chronicleJournal !== undefined;
        enableChronicleJournal(baseline); this.assertChronicleOrigin(baseline, declared); this.assertChronicleArchive(baseline);
        this.rememberChronicle(baseline, this.chronicleStamp());
      }
    }
    const baseline = this.verifiedChronicle;
    if (baseline && (journal.startsAfter !== baseline.startsAfter || journal.committedThrough !== baseline.through
      || journal.committedDigest !== baseline.digest || world.tick < baseline.tick
      || journal.pending.some(event => event.tick < baseline.tick))) chronicleFailure('candidate changed committed history');
  }
  private flushChronicle(world: World): void {
    const journal = world.chronicleJournal!, origin = this.chronicleOrigin();
    if (origin === null) this.db.prepare("INSERT INTO metadata VALUES ('chronicle-origin-v1',?)").run(JSON.stringify({ version: 1, startsAfter: journal.startsAfter }));
    else if (origin !== journal.startsAfter) chronicleFailure('durable origin changed');
    const lookup = this.db.prepare('SELECT tick,body FROM events WHERE id=?');
    const insert = this.db.prepare('INSERT INTO events VALUES (?,?,?)');
    for (const event of [...journal.pending, ...world.events]) {
      assertChronicleEvent(event, world.tick);
      const body = JSON.stringify(event), previous = lookup.get(event.id) as { tick: number; body: string } | undefined;
      if (previous) {
        if (previous.tick !== event.tick || previous.body !== body) chronicleFailure('an immutable event cannot be overwritten');
      } else insert.run(event.id, event.tick, body);
    }
  }

  /** C5: el archivo deja de crecer sin fin. Borra un prefijo YA verificado de
   * sucesos y guarda el dígeste de control del límite, de modo que la cadena
   * siga cerrando contra la instantánea sin releer lo borrado. Nunca toca la
   * ventana pedida, lo visible ni lo pendiente; su coste es O(borrados). */
  private pruneChronicle(world: World, journal: ChronicleJournal, window: number): void {
    const horizon = world.tick - window;
    if (horizon <= 0) return;
    const previous = this.prunedChronicle();
    const pruned = previous && previous.through > journal.startsAfter ? previous : null;
    const from = pruned ? pruned.through : journal.startsAfter;
    let visible = Number.MAX_SAFE_INTEGER;
    for (const event of world.events) { const serial = chronicleSerial(event.id); if (serial !== null && serial < visible) visible = serial; }
    const oldest = this.db.prepare("SELECT MAX(CAST(substr(id,2) AS INTEGER)) AS serial FROM events WHERE id GLOB 'e[0-9]*' AND tick<?").get(horizon) as { serial: number | null };
    const boundary = Math.min(journal.committedThrough, visible - 1, oldest.serial ?? 0);
    if (boundary <= from) return;
    let digest = pruned ? pruned.digest : EMPTY_CHRONICLE_DIGEST;
    const lookup = this.db.prepare('SELECT body FROM events WHERE id=?');
    for (let serial = from + 1; serial <= boundary; serial++) {
      const row = lookup.get(`e${serial}`) as { body: string } | undefined;
      if (!row) chronicleFailure('declared coverage has a gap');
      digest = checksum(`${digest}\n${row!.body}`);
    }
    this.db.prepare("DELETE FROM events WHERE id GLOB 'e[0-9]*' AND CAST(substr(id,2) AS INTEGER)<=?").run(boundary);
    this.db.prepare("INSERT OR REPLACE INTO metadata VALUES ('chronicle-pruned-v1',?)").run(JSON.stringify({ version: 1, through: boundary, digest }));
  }

  /** A declared prefix is verified once on load, not scanned at the 10 Hz save cadence.
   * Devuelve la cabeza de la cadena de digestos a través de lo verificado. */
  private assertTechnologyCoverage(world: World): TechnologyChain {
    const state = world.technology, journal = state.journal!;
    if (this.schemaVersion < 4) {
      if (journal.committedThrough !== journal.startsAfter) technologyFailure('coverage has no backing schema');
      return { startsAfter: journal.startsAfter, through: journal.startsAfter, digest: TECHNOLOGY_CHAIN_EMPTY };
    }
    const origin = this.technologyArchive.getHistoryOrigin();
    if (!origin || origin.startsAfter !== journal.startsAfter) technologyFailure('history origin disagrees with snapshot');
    return this.assertTechnologyReceipts(world, journal.startsAfter, journal.committedThrough);
  }

  /** Frontera de poda del archivo de recibos (metadato del anfitrión, como `chronicle-pruned-v1`). */
  private prunedTechnology(): TechnologyPrune | null {
    const row = this.db.prepare('SELECT value FROM main.metadata WHERE key=?').get(TECHNOLOGY_PRUNED_KEY) as { value: string } | undefined;
    if (!row) return null;
    let value: Record<string, unknown> | null = null;
    try { value = JSON.parse(row.value); } catch { technologyFailure('prune boundary is invalid'); }
    if (value && value.version === 1
      && Object.keys(value).sort().join(',') === 'count,digest,startsAfter,through,tick,version')
      technologyFailure('legacy prune boundary has no authenticated V2 seal');
    const byKind = value ? technologyCounts(value.byKind) : null;
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'byKind,count,digest,seal,startsAfter,through,tick,version' || value.version !== 2
      || !safeCount(value.startsAfter) || !safeCount(value.through) || !safeCount(value.tick) || !safeCount(value.count)
      || !hexDigest(value.digest) || !hexDigest(value.seal) || !byKind || value.through <= value.startsAfter
      || value.count !== value.through - value.startsAfter
      || TECHNOLOGY_EXECUTION_KINDS.reduce((sum, kind) => sum + byKind[kind], 0) !== value.count)
      technologyFailure('prune boundary is invalid');
    const boundary: TechnologyPrune = { startsAfter: value!.startsAfter as number, through: value!.through as number,
      tick: value!.tick as number, digest: value!.digest as string, count: value!.count as number, byKind: byKind!,
      seal: value!.seal as string };
    if (technologyPruneSeal(boundary) !== boundary.seal) technologyFailure('prune boundary seal disagrees with its fields');
    return boundary;
  }
  /** Cabeza durable de la cadena de recibos, escrita en la misma transacción que cada instantánea. `null` en
   * un archivo escrito antes de la retención: la primera carga la calcula y el primer guardado la escribe. */
  private technologyChainRecord(): TechnologyChainRecord | null {
    const row = this.db.prepare('SELECT value FROM main.metadata WHERE key=?').get(TECHNOLOGY_CHAIN_KEY) as { value: string } | undefined;
    if (!row) return null;
    let value: Record<string, unknown> | null = null;
    try { value = JSON.parse(row.value); } catch { technologyFailure('execution chain head is invalid'); }
    const version = value?.version;
    const expectedKeys = version === 1 ? 'digest,startsAfter,through,version' : 'digest,pruneSeal,startsAfter,through,version';
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== expectedKeys || ![1, 2].includes(version as number)
      || !safeCount(value.startsAfter) || !safeCount(value.through) || value.through < value.startsAfter || !hexDigest(value.digest))
      technologyFailure('execution chain head is invalid');
    if (version === 2 && value!.pruneSeal !== null && !hexDigest(value!.pruneSeal))
      technologyFailure('execution chain head is invalid');
    const chain = { startsAfter: value!.startsAfter as number, through: value!.through as number, digest: value!.digest as string };
    return version === 1 ? { version: 1, ...chain } : { version: 2, ...chain, pruneSeal: value!.pruneSeal as string | null };
  }
  /** Host write: cabeza de la cadena y, si hubo poda en este guardado, la nueva frontera. */
  private writeTechnologyMetadata(chain: TechnologyChain, pruned: TechnologyPrune | null): void {
    const put = this.db.prepare('INSERT OR REPLACE INTO main.metadata VALUES (?,?)');
    const boundary = pruned ?? this.prunedTechnology();
    put.run(TECHNOLOGY_CHAIN_KEY, JSON.stringify({ version: 2, startsAfter: chain.startsAfter, through: chain.through,
      digest: chain.digest, pruneSeal: boundary?.seal ?? null }));
    if (pruned) put.run(TECHNOLOGY_PRUNED_KEY, JSON.stringify({ version: 2, startsAfter: pruned.startsAfter, through: pruned.through,
      tick: pruned.tick, digest: pruned.digest, count: pruned.count, byKind: pruned.byKind, seal: pruned.seal }));
  }
  /** El anillo residente de una instantánea nunca queda dentro del prefijo podado: la poda se acota por el
   * primer recibo de cada anillo. Si lo estuviera, la frontera no es la que la poda pudo escribir. */
  private assertRingOutsidePrune(world: World, startsAfter: number, from: number): void {
    for (const receipt of world.technology.history) {
      const serial = Number(receipt.id.slice(8));
      if (serial > startsAfter && serial <= from) technologyFailure('prune boundary cuts the resident execution ring');
    }
  }

  /**
   * Cobertura sin huecos de `(startsAfter, through]` o, si el anfitrión podó un prefijo, de `(frontera, through]`
   * (igual que `assertChronicleArchive` arranca en `chronicle-pruned-v1`). Pliega la cadena de digestos desde la
   * frontera y la compara con la cabeza durable: una fila retenida borrada, alterada (aunque su digesto se
   * recalcule) o reordenada, o una frontera falsificada, dejan de cerrar. `verifyHead = false` sólo lo usa la
   * recuperación de una instantánea anterior al diario, cuya copia ya perdió las filas posteriores a la cabeza.
   */
  private assertTechnologyReceipts(world: World, startsAfter: number, through: number, verifyHead = true): TechnologyChain {
    const state = world.technology;
    const boundary = this.prunedTechnology(), head = verifyHead ? this.technologyChainRecord() : null;
    if (boundary && boundary.startsAfter !== startsAfter) technologyFailure('prune boundary disagrees with history origin');
    if (boundary && boundary.through > through) technologyFailure('prune boundary escapes declared coverage');
    if (boundary && verifyHead && !head) technologyFailure('prune boundary has no execution chain head');
    const from = boundary ? boundary.through : startsAfter;
    if (head && (head.startsAfter !== startsAfter || head.through < from || head.through > through))
      technologyFailure('execution chain head escapes declared coverage');
    if (head?.version === 2 && head.pruneSeal !== (boundary?.seal ?? null))
      technologyFailure('execution chain head disagrees with prune boundary seal');
    // Cada guardado escribe la cabeza V2 en la transacción de su instantánea: una V2 atrasada no la dejó
    // ningún binario (los anteriores a la retención solo conocen la V1) y aceptarla como prefijo dejaría
    // sin autenticar las filas que vienen detrás.
    if (head?.version === 2 && head.through !== through) technologyFailure('execution chain head V2 is not the snapshot head');
    if (boundary && this.db.prepare('SELECT 1 FROM technology_executions WHERE serial<=? LIMIT 1').get(boundary.through))
      technologyFailure('pruned executions are still archived');
    const firstRetained = boundary && this.db.prepare('SELECT tick FROM technology_executions WHERE serial=?').get(boundary.through + 1) as
      { tick: number } | undefined;
    if (boundary && firstRetained && firstRetained.tick <= boundary.tick)
      technologyFailure('prune boundary tick overlaps the first retained execution');
    this.assertRingOutsidePrune(world, startsAfter, from);
    let serial = from, digest = boundary ? boundary.digest : TECHNOLOGY_CHAIN_EMPTY;
    let legacyDigest = TECHNOLOGY_CHAIN_EMPTY;
    const headDisagrees = (): boolean => !!head && head.digest !== (head.version === 1 ? legacyDigest : digest);
    // Una cabeza V1 atrasada (la escribió un binario anterior que no la mantenía) se comprueba como prefijo.
    if (head && head.through === serial && headDisagrees()) technologyFailure('execution chain disagrees with archive');
    const recent = new Map(state.history.map(receipt => [receipt.id, receipt]));
    while (serial < through) {
      const page = this.technologyArchive.listExecutionRecords({ afterSerial: serial, asOfTick: world.tick,
        limit: Math.min(1000, through - serial) });
      if (!page.length) technologyFailure('declared execution coverage is incomplete');
      for (const { execution: receipt, digest: rowDigest } of page) {
        if (receipt.id !== `process-${++serial}`) technologyFailure('declared execution coverage has a gap');
        digest = technologyChainStep(digest, rowDigest, receipt.tick);
        if (!boundary) legacyDigest = legacyTechnologyChainStep(legacyDigest, rowDigest);
        if (head && head.through === serial && headDisagrees()) technologyFailure('execution chain disagrees with archive');
        const cached = recent.get(receipt.id);
        if (cached && JSON.stringify(cached) !== JSON.stringify(receipt)) technologyFailure('cached execution disagrees with archive');
      }
      this.onProgress?.();
    }
    return { startsAfter, through, digest };
  }
  /** Tras probar la línea base en esta misma transacción, un candidato con el MISMO intervalo confirmado sólo
   * difiere en su anillo residente: se comprueba por id en vez de repetir el barrido entero (sprint noche-arch
   * 2026-09-23: el camino frío recorría el archivo dos veces, 42–120 s en el mundo público). */
  private assertTechnologyRing(world: World): void {
    const journal = world.technology.journal!, boundary = this.prunedTechnology();
    const from = boundary ? Math.max(boundary.through, journal.startsAfter) : journal.startsAfter;
    this.assertRingOutsidePrune(world, journal.startsAfter, from);
    for (const receipt of world.technology.history) {
      const serial = Number(receipt.id.slice(8));
      if (serial <= from || serial > journal.committedThrough) continue;
      const archived = this.technologyArchive.getExecution(receipt.id, world.tick);
      if (!archived || JSON.stringify(archived) !== JSON.stringify(receipt)) technologyFailure('cached execution disagrees with archive');
    }
  }

  /** Lo que una instantánea exige del archivo de recibos y estadísticas (ver `SlotBounds`). */
  private boundsOf(world: Pick<World, 'tick' | 'technology'>): SlotBounds {
    const technology = world.technology as Partial<World['technology']> | undefined;
    const committed = technology?.executionCounter, first = Array.isArray(technology?.history) ? technology.history[0]?.tick : undefined;
    const atTick = typeof world.tick === 'number' && Number.isSafeInteger(world.tick) && world.tick >= 0 ? world.tick : 0;
    // Sin contador legible (instantánea anterior a la tecnología) se supone que necesita todo: 0 frena la poda.
    return { tick: atTick,
      committed: typeof committed === 'number' && Number.isSafeInteger(committed) && committed >= 0 ? committed : 0,
      ringTick: typeof first === 'number' && Number.isSafeInteger(first) ? first : null };
  }
  private rememberSlotBounds(digest: string, world: Pick<World, 'tick' | 'technology'>): void {
    if (!digest) return;
    this.slotBounds.delete(digest); this.slotBounds.set(digest, this.boundsOf(world));
    while (this.slotBounds.size > 8) this.slotBounds.delete(this.slotBounds.keys().next().value!);
  }
  /** Contador durable de guardados (A3): desacopla la rotación del respaldo profundo (slot 2) de los reinicios
   * del proceso, de modo que reiniciar antes de los 100 guardados nunca congele el slot 2 ni la poda. */
  private readDurableSaves(): number {
    const row = this.db.prepare('SELECT value FROM main.metadata WHERE key=?').get(DEEP_CHECKPOINT_SAVES_KEY) as { value: string } | undefined;
    if (!row) return this.saves;
    const value = Number(row.value);
    if (!/^(0|[1-9]\d*)$/.test(row.value) || !Number.isSafeInteger(value))
      throw new Error('Invalid durable save counter metadata. Explicit recovery required.');
    return value;
  }
  /** Límites del respaldo que hoy ocupa `slot` con ese digesto; `'unusable'` si su cuerpo está dañado (ni la
   * carga ni `previous()` lo adoptarían) y `null` si no se pudo decidir: entonces no se poda en este guardado.
   * Decodificar un respaldo sólo ocurre con uno que este proceso no cargó ni escribió (al arrancar, el slot 1
   * y el 2): una vez por proceso y respaldo. */
  private slotBoundsOf(slot: SnapshotSlot, digest: string): SlotBounds | 'unusable' | null {
    const known = this.slotBounds.get(digest);
    if (known) {
      // LRU de verdad: sin refrescar al acertar, cada guardado anota un digesto nuevo y a los ~8
      // guardados el respaldo profundo salía de la memoria y se volvía a decodificar entero.
      this.slotBounds.delete(digest); this.slotBounds.set(digest, known);
      return known;
    }
    const row = this.db.prepare('SELECT body,digest FROM snapshots WHERE slot=?').get(slot) as Row | undefined;
    if (!row || row.digest !== digest) return null;
    let bounds: SlotBounds | 'unusable';
    if (checksum(row.body) !== row.digest) bounds = 'unusable';
    else {
      const decided = this.cheapSlotBounds(slot, digest, row.body) ?? this.readSlotBounds(row.body);
      if (decided === null) return null;
      bounds = decided;
    }
    this.slotBounds.set(digest, bounds);
    while (this.slotBounds.size > 8) this.slotBounds.delete(this.slotBounds.keys().next().value!);
    return bounds;
  }
  /** La clasificación completa de siempre: legible entero o `'unusable'`; `null` si ni decidir se pudo.
   * Solo la devuelve `slotBoundsOf`, que memoriza cualquier decisión distinta de `null`. */
  private readSlotBounds(body: string): SlotBounds | 'unusable' | null {
    try { return this.boundsOf(this.readSnapshot(body) as World); }
    catch (error) {
      if (!(error instanceof SnapshotPhysicalError) && !(error instanceof SnapshotSemanticError)) return null;
      return 'unusable';
    }
  }
  /** Cotas de una instantánea por partes sin decodificarla: `boundsOf` solo lee `tick`,
   * `technology.executionCounter` y el tick del primer recibo residente, así que SQLite los extrae
   * del manifiesto en C y el mismo `boundsOf` los sanea sobre un mundo mínimo equivalente. Solo se
   * aplica al prefijo canónico que escribe `SnapshotParts.write` (con el checksum ya cotejado por
   * el llamador); replay, cuerpos en línea y cualquier rareza de extracción vuelven a la lectura
   * completa. Un manifiesto por partes que la lectura completa declararía `'unusable'` (claves
   * duplicadas, página dañada, límites inválidos) puede aquí dar unas cotas, pero ambos usos de las
   * cotas —poda de recibos y compactación de estadísticas— solo las aplican con `Math.min` contra
   * las del propio mundo y las de los demás respaldos: tratarlo como utilizable jamás poda más que
   * ignorarlo, solo puede retener de más. La carga y la recuperación siguen juzgando el cuerpo
   * entero exactamente igual. `null` = sin extracción fiable, que decida la lectura completa. */
  private cheapSlotBounds(slot: SnapshotSlot, digest: string, body: string): SlotBounds | null {
    if (!hasCanonicalSnapshotPartsPrefix(body)) return null;
    try {
      const row = this.db.prepare("SELECT json_extract(body,'$.world.tick','$.world.technology.executionCounter','$.world.technology.history[0].tick') AS v FROM main.snapshots WHERE slot=? AND digest=?").get(slot, digest) as { v: unknown } | undefined;
      if (!row || typeof row.v !== 'string') return null;
      const values: unknown = JSON.parse(row.v);
      if (!Array.isArray(values) || values.length !== 3) return null;
      const [tick, committed, ringTick] = values as [unknown, unknown, unknown];
      return this.boundsOf({ tick, technology: { executionCounter: committed,
        history: ringTick === null || ringTick === undefined ? [] : [{ tick: ringTick }] } } as unknown as Pick<World, 'tick' | 'technology'>);
    } catch { return null; }
  }
  /** Serie del último recibo con tick < `tick` (con todos los de su mismo tick), o `null` si no hay ninguno. */
  private lastExecutionBefore(tick: number): number | null {
    const last = this.db.prepare('SELECT MAX(tick) AS tick FROM technology_executions WHERE tick<?').get(tick) as { tick: number | null };
    return last.tick === null ? null : this.lastExecutionAt(last.tick);
  }
  private lastExecutionAt(tick: number): number | null {
    const last = this.db.prepare('SELECT MAX(serial) AS serial FROM technology_executions WHERE tick=?').get(tick);
    return (last as { serial: number | null }).serial;
  }
  private executionTick(serial: number): number | null {
    const row = this.db.prepare('SELECT tick FROM technology_executions WHERE serial=?').get(serial) as { tick: number } | undefined;
    return row?.tick ?? null;
  }
  /**
   * Retención del archivo de recibos (FR-016, sprint noche-arch 2026-09-23). Dentro de la transacción del
   * guardado, después de archivar los recibos pendientes y antes de escribir la instantánea, borra el prefijo
   * de recibos que ya nadie puede pedir y devuelve la nueva frontera (la escribe `save`):
   * - sólo recibos con tick < tick − max(ventana, un día) (`persistencia.ventanaEventosTicks`, la misma ventana
   *   que ya poda sucesos y terreno: un parámetro nuevo entraría en `paramsOf` y cambiaría el digesto);
   * - nunca lo que necesite una de las tres instantáneas que quedarán tras el guardado —el candidato y lo que
   *   la rotación deje en los slots 1 y 2—: ni sus recibos confirmados (la cobertura de `load()` y de
   *   `previous()`) ni ninguno desde el primero de su anillo residente (que se compara con el archivo). Se
   *   mira cada respaldo, no se supone su edad: el slot 2 envejece si el servicio se reinicia a menudo;
   * - siempre en un tick completo (un padre y sus anidadas comparten tick) y como mucho
   *   `technologyPruneRowsPerSave` recibos por guardado —o los de un único tick, si él solo lo supera—: un
   *   archivo que ya existía se poda poco a poco.
   * El mundo no lee estos recibos (sólo definiciones y estadísticas, `catalogueReader`), así que nada de esto
   * cambia la simulación ni `digestoCanonico`.
   */
  private pruneTechnology(world: World, window: number, rotatesBackups: boolean, deep: boolean): TechnologyPrune | null {
    if (this.schemaVersion < 4 || window <= 0) return null;
    let limitTick = world.tick - Math.max(window, TECHNOLOGY_RETENTION_MIN_TICKS);
    if (limitTick <= 0) return null;
    const origin = this.technologyArchive.getHistoryOrigin(), journal = world.technology.journal;
    if (!origin || !journal || origin.startsAfter !== journal.startsAfter) return null;
    const previous = this.prunedTechnology(), from = previous ? previous.through : origin.startsAfter;
    const own = this.boundsOf(world);
    let limitSerial = own.committed;
    if (own.ringTick !== null) limitTick = Math.min(limitTick, own.ringTick);
    const digests = new Map((this.db.prepare('SELECT slot,digest FROM snapshots').all() as { slot: number; digest: string }[])
      .map(row => [row.slot, row.digest]));
    for (const source of [rotatesBackups ? 0 : 1, deep ? 0 : 2] as SnapshotSlot[]) {
      const digest = digests.get(source);
      if (digest === undefined) continue;
      const bounds = this.slotBoundsOf(source, digest);
      if (bounds === null) return null;
      if (bounds === 'unusable') continue;
      limitSerial = Math.min(limitSerial, bounds.committed);
      if (bounds.ringTick !== null) limitTick = Math.min(limitTick, bounds.ringTick);
    }
    let through = this.lastExecutionBefore(limitTick);
    if (through !== null && through > limitSerial) {
      const next = this.executionTick(limitSerial + 1);
      through = next === null ? null : this.lastExecutionBefore(next);
    }
    if (through === null || through <= from) return null;
    // A3: en producción/lab (sin tope explícito en StoreOptions) escalar la poda por encima del ritmo de generación.
    const cap = this.explicitPruneCap
      ? this.technologyPruneRowsPerSave
      : Math.max(this.technologyPruneRowsPerSave, journal.pending.length * 2);
    if (through - from > cap) {
      const capTick = this.executionTick(from + cap);
      if (capTick === null) return null;
      const capTickEnd = this.lastExecutionAt(capTick);
      const cut = capTickEnd !== null && capTickEnd <= from + cap
        ? capTickEnd : this.lastExecutionBefore(capTick);
      // Si ni el primer tick completo cabe, se poda ese tick entero y solo: nunca se parte un padre de sus
      // anidadas y, si no se podara, la poda quedaría atascada para siempre en él. Su coste está acotado por
      // lo que un solo paso escribió en un solo guardado.
      const firstTick = this.executionTick(from + 1);
      through = cut !== null && cut > from ? cut : firstTick === null ? null : this.lastExecutionAt(firstTick);
      if (through === null || through <= from) return null;
    }
    const pruned = this.technologyArchive.pruneExecutions(from, through, previous ? previous.digest : TECHNOLOGY_CHAIN_EMPTY);
    const byKind = addTechnologyCounts(previous?.byKind ?? emptyTechnologyExecutionCounts(), pruned.byKind);
    const boundary = { startsAfter: origin.startsAfter, through, tick: pruned.tick, digest: pruned.digest,
      count: through - origin.startsAfter, byKind };
    return { ...boundary, seal: technologyPruneSeal(boundary) };
  }

  /**
   * Compactación incremental de `technology_stats` (A1, plan de estabilidad): bajo `ventanaEventosTicks > 0`,
   * borra filas estrictamente superadas por otra fila de la misma receta `<= cutoffTick`, donde `cutoffTick`
   * queda acotado tanto por la ventana como por el tick más viejo de las instantáneas que sobrevivirán al
   * guardado (`[0, 1, 2]`). Con `window === 0` no compacta nada.
   */
  private compactTechnologyStats(world: World, window: number, rotatesBackups: boolean, deep: boolean): number {
    if (this.schemaVersion < 4 || window <= 0) return 0;
    let cutoffTick = Math.min(world.tick - Math.max(window, TECHNOLOGY_RETENTION_MIN_TICKS), world.tick);
    if (cutoffTick <= 0) return 0;
    const digests = new Map((this.db.prepare('SELECT slot,digest FROM snapshots').all() as { slot: number; digest: string }[])
      .map(row => [row.slot, row.digest]));
    for (const source of [rotatesBackups ? 0 : 1, deep ? 0 : 2] as SnapshotSlot[]) {
      const digest = digests.get(source);
      if (digest === undefined) continue;
      const bounds = this.slotBoundsOf(source, digest);
      if (bounds === null) return 0;
      if (bounds === 'unusable') continue;
      cutoffTick = Math.min(cutoffTick, bounds.tick);
    }
    if (cutoffTick <= 0) return 0;
    return this.technologyArchive.compactStats(cutoffTick, TECHNOLOGY_STATS_COMPACT_ROWS_PER_SAVE, TECHNOLOGY_STATS_COMPACT_ROWS_PER_SAVE * 16);
  }

  private assertTechnologyAuthor(world: World, definition: Pick<TechnologyDefinition, 'inventorId' | 'tick'>,
    authorLookup?: (id: string) => { bornAt: number; diedAt?: number } | null): void {
    const author = authorLookup ? authorLookup(definition.inventorId)
      : world.people.find(person => person.id === definition.inventorId)
        ?? world.legacy.find(person => person.id === definition.inventorId)
        ?? world.retiredLegacy.find(person => person.id === definition.inventorId)
        ?? this.loadLegacy(definition.inventorId, world.tick);
    if (!author || author.bornAt > definition.tick || 'diedAt' in author && author.diedAt !== undefined && author.diedAt < definition.tick)
      technologyFailure('definition author disagrees with world history');
  }
  private assertTechnologyCache(world: World): void {
    const state = world.technology;
    // A2: indexar autores residentes y memoizar `loadLegacy()` con sentencia preparada durante este barrido.
    const residentAuthors = new Map<string, { bornAt: number; diedAt?: number }>();
    for (const record of world.retiredLegacy) residentAuthors.set(record.id, { bornAt: record.bornAt, diedAt: record.diedAt });
    for (const record of world.legacy) residentAuthors.set(record.id, { bornAt: record.bornAt, diedAt: record.diedAt });
    for (const person of world.people) residentAuthors.set(person.id, { bornAt: person.bornAt });
    const legacyStatement = this.schemaVersion >= 3 ? this.db.prepare('SELECT body,digest,tick FROM legacy WHERE id=? AND tick<=?') : undefined;
    const legacyAuthors = new Map<string, { bornAt: number; diedAt: number } | null>();
    const authorLookup = (id: string): { bornAt: number; diedAt?: number } | null => {
      const resident = residentAuthors.get(id);
      if (resident) return resident;
      if (legacyAuthors.has(id)) return legacyAuthors.get(id)!;
      const archived = this.readLegacyRecord(id, world.tick, legacyStatement);
      const entry = archived ? { bornAt: archived.bornAt, diedAt: archived.diedAt } : null;
      legacyAuthors.set(id, entry);
      return entry;
    };
    // The resident list is a cache, never evidence of lifetime archive coverage.
    const summary = this.technologyArchive.summarizeDefinitions(world.tick, definition => this.assertTechnologyAuthor(world, definition, authorLookup));
    if (summary.recipes !== state.recipeCounter) technologyFailure('definition cache disagrees with archive');
    if (state.catalogue) {
      const totals = state.catalogue.totals;
      for (const key of ['recipes', 'maxGeneration', 'manufactured', 'uses', 'functionalDiversity'] as const)
        if (summary[key] !== totals[key]) technologyFailure('catalogue aggregates disagree with archive');
      // Utility is an observational float accumulated in execution order in the
      // world and recipe order in the archive. Only this non-material sum gets a
      // rounding allowance; integer mass, counts and novelty bits stay exact.
      if (!sameUtility(summary.utility, totals.utility, summary.uses + summary.recipes) ||
        JSON.stringify(summary.functions) !== JSON.stringify(state.catalogue.functions)) technologyFailure('catalogue summary disagrees with archive');
    }
    for (const recipe of state.recipes) {
      const definition = this.technologyArchive.getDefinition(recipe.id, world.tick), stats = this.technologyArchive.getStats(recipe.id, world.tick);
      if (!definition || JSON.stringify(definition) !== JSON.stringify(definitionOf(recipe))) technologyFailure('cached definition disagrees with archive');
      if (!stats || !sameStats(stats, recipe)) technologyFailure('cached statistics disagree with archive');
    }
    const latest = this.db.prepare('SELECT serial FROM technology_executions WHERE tick<=? ORDER BY serial DESC LIMIT 1').get(world.tick) as { serial: number } | undefined;
    if (latest && latest.serial > state.executionCounter) technologyFailure('execution identity exceeds snapshot counter');
  }

  private rememberTechnology(world: World, chain: TechnologyChain): void {
    const state = world.technology, journal = state.journal!;
    if (chain.startsAfter !== journal.startsAfter || chain.through !== journal.committedThrough)
      technologyFailure('execution chain head disagrees with snapshot');
    this.verifiedTechnology = { startsAfter: journal.startsAfter, through: journal.committedThrough,
      catalogueThrough: state.catalogue?.committedThrough ?? state.recipeCounter,
      dataVersion: this.dataVersion(), totalChanges: this.totalChanges(), schemaCookie: this.schemaCookie(), chain: { ...chain } };
    // `definitionOf` strips the three mutable stats fields, so its JSON is a pure function
    // of properties `registerTechnologyRecipe` sets once and nothing ever reassigns
    // (T105: grep confirms the only post-creation mutation site is `Object.assign` in
    // `updateTechnologyRecipeStats`, which touches manufactured/uses/utility only). A
    // recipe already in the previous map has that same body verbatim forever; re-stringify
    // only ids this map has never seen, instead of the whole resident window every save.
    const previousRecipes = this.verifiedRecipes;
    this.verifiedRecipes = new Map(state.recipes.map(recipe => [recipe.id, { body: previousRecipes.get(recipe.id)?.body ?? JSON.stringify(definitionOf(recipe)),
      uses: recipe.uses, utility: recipe.utility, manufactured: recipe.manufactured }]));
    const functions = state.catalogue?.functions.slice() ?? Array<number>(TECHNOLOGY_FUNCTION_WORDS).fill(0);
    if (!state.catalogue) for (const recipe of state.recipes) {
      const code = technologyFunctionCode(recipe.capacities), index = code >>> 5;
      functions[index] = (functions[index]! | (1 << (code & 31))) >>> 0;
    }
    this.verifiedCatalogue = { totals: technologyCatalogueTotals(world), functions };
  }

  /** Prove aggregate changes from bounded pending records before acknowledging a
   * new snapshot. Unchanged resident objects cannot silently change the totals. */
  private assertTechnologyChanges(world: World): void {
    const state = world.technology, catalogue = state.catalogue;
    if (!catalogue) return;
    const expected = this.verifiedCatalogue ? { ...this.verifiedCatalogue.totals }
      : { recipes: 0, maxGeneration: 0, manufactured: 0, uses: 0, utility: 0, functionalDiversity: 0 };
    const functions = this.verifiedCatalogue?.functions.slice() ?? Array<number>(TECHNOLOGY_FUNCTION_WORDS).fill(0);
    const prefix = expected.recipes;
    for (const recipe of [...catalogue.pending].sort((a, b) => Number(a.id.slice(7)) - Number(b.id.slice(7)))) {
      const id = Number(recipe.id.slice(7));
      const previous = id <= prefix ? this.verifiedRecipes.get(recipe.id) ?? this.readTechnologyRecipe(recipe.id, world.tick) : null;
      if (id <= prefix && !previous) technologyFailure('pending statistics have no durable definition');
      if (id > prefix) {
        if (id !== ++expected.recipes) technologyFailure('pending definitions do not extend the durable prefix');
        expected.maxGeneration = Math.max(expected.maxGeneration, recipe.generation);
        const code = technologyFunctionCode(recipe.capacities), index = code >>> 5, bit = 1 << (code & 31);
        if (!(functions[index]! & bit)) { functions[index] = (functions[index]! | bit) >>> 0; expected.functionalDiversity++; }
      }
      for (const key of ['manufactured', 'uses', 'utility'] as const) {
        const delta = recipe[key] - (previous?.[key] ?? 0);
        if (!Number.isFinite(delta) || delta < 0) technologyFailure('pending statistics regress');
        expected[key] += delta;
      }
    }
    for (const key of ['recipes', 'maxGeneration', 'manufactured', 'uses', 'functionalDiversity'] as const)
      if (!Number.isSafeInteger(expected[key]) || expected[key] !== catalogue.totals[key]) technologyFailure('catalogue totals changed without matching pending records');
    if (!sameUtility(expected.utility, catalogue.totals.utility, expected.uses + expected.recipes) ||
      JSON.stringify(functions) !== JSON.stringify(catalogue.functions)) technologyFailure('catalogue summary changed without matching pending records');
  }

  /** All writes use the host transaction. Neither this helper nor a failed save clears queues.
   * Devuelve la cabeza de la cadena de recibos tras archivar los pendientes (la escribe `save`). */
  private flushTechnology(world: World, recovering = false, recoveredChain: TechnologyChain | null = null): TechnologyChain {
    const state = world.technology, journal = state.journal!;
    assertTechnologyJournal(state, world.tick);
    assertTechnologyCatalogueState(world);
    const verified = this.verifiedTechnology;
    let chain: TechnologyChain | null = verified?.chain ?? null;
    if (!verified || verified.startsAfter !== journal.startsAfter || verified.through !== journal.committedThrough
      || verified.dataVersion !== this.dataVersion() || verified.totalChanges !== this.totalChanges() || verified.schemaCookie !== this.schemaCookie()) {
      this.verifiedRecipes.clear();
      chain = null;
      assertTechnologySchema(this.db);
      if (!recovering) {
        // Validate the durable baseline BEFORE any idempotent writes. Otherwise a
        // deleted definition/statistics row could be silently rebuilt from the candidate.
        const row = this.db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get() as Row | undefined;
        if (!row && this.db.prepare("SELECT 1 FROM metadata WHERE key='initialized'").get()) technologyFailure('baseline snapshot is missing');
        let baselineProved = false;
        if (row) {
          if (checksum(row.body) !== row.digest) technologyFailure('baseline snapshot checksum mismatch');
          const baseline = this.migrateSnapshot(this.readSnapshot(row.body) as World);
          if (baseline.technology.journal !== undefined) {
            const committed = baseline.technology.journal;
            assertTechnologyJournal(baseline.technology, baseline.tick);
            if (committed.pending.length || committed.committedThrough !== baseline.technology.executionCounter) technologyFailure('baseline snapshot contains uncommitted executions');
            this.assertTechnologyCache(baseline); chain = this.assertTechnologyCoverage(baseline);
            if (journal.startsAfter !== committed.startsAfter || journal.committedThrough !== committed.committedThrough) technologyFailure('candidate changed the committed coverage boundary');
            if (baseline.technology.catalogue && state.catalogue?.committedThrough !== baseline.technology.catalogue.committedThrough)
              technologyFailure('candidate changed the committed definition boundary');
            this.rememberTechnology(baseline, chain);
            this.rememberSlotBounds(row.digest, baseline);
            baselineProved = true;
          } else if (this.technologyArchive.getHistoryOrigin()) {
            technologyFailure('baseline snapshot lost its declared history origin');
          }
        }
        this.technologyArchive.initializeHistory(journal.startsAfter);
        // El candidato tiene por contrato el mismo intervalo confirmado que la línea base recién probada en
        // esta transacción (comprobado arriba): basta su anillo. Sin línea base con diario, barrido completo.
        if (baselineProved) this.assertTechnologyRing(world);
        else chain = this.assertTechnologyCoverage(world);
      }
    }
    this.technologyArchive.initializeHistory(journal.startsAfter);
    if (this.verifiedTechnology && state.catalogue && state.catalogue.committedThrough !== this.verifiedTechnology.catalogueThrough)
      technologyFailure('candidate changed the committed definition boundary');
    if (!recovering) this.assertTechnologyChanges(world);
    const latest = this.db.prepare('SELECT serial FROM technology_executions ORDER BY serial DESC LIMIT 1').get() as { serial: number } | undefined;
    if (latest && latest.serial > state.executionCounter) technologyFailure('cannot move behind archived executions');
    const changed = state.catalogue?.pending ?? state.recipes;
    for (const recipe of changed) this.assertTechnologyAuthor(world, recipe);
    if (state.catalogue) {
      const pendingIds = new Set(changed.map(recipe => recipe.id));
      for (const recipe of state.recipes) {
        if (pendingIds.has(recipe.id)) continue;
        const cached = this.verifiedRecipes.get(recipe.id);
        if (cached) {
          // T105: a recipe outside `pendingIds` was not touched by `updateTechnologyRecipeStats`
          // this round — the only site that mutates a resident recipe, and it always pends its
          // target first. Its definition (program/capacities/parents/…) is therefore provably the
          // same object state `cached.body` was stringified from; only the stats can have drifted,
          // so those are what a warm hit re-checks here. The `else` branch below still runs the
          // full definition comparison against the durable row for every id `verifiedRecipes`
          // has not proven yet (right after a reset, or a stamp mismatch clears the cache).
          if (!sameStats(cached, recipe)) technologyFailure('resident definition or statistics changed without a pending record');
        } else {
          const durable = this.readTechnologyRecipe(recipe.id, world.tick);
          if (!durable || JSON.stringify(definitionOf(durable)) !== JSON.stringify(definitionOf(recipe)) || !sameStats(durable, recipe))
            technologyFailure('cold resident definition or statistics disagrees with archive');
        }
      }
    }
    for (const recipe of [...changed].sort((a, b) => Number(a.id.slice(7)) - Number(b.id.slice(7)))) {
      const definition = definitionOf(recipe), cached = this.verifiedRecipes.get(recipe.id);
      if (!cached || cached.body !== JSON.stringify(definition)) this.technologyArchive.putDefinition(definition);
    }
    for (const recipe of changed) {
      const previous = this.verifiedRecipes.get(recipe.id) ?? this.technologyArchive.getStats(recipe.id, world.tick);
      if (!previous || !sameStats(previous, recipe)) this.technologyArchive.putStats(recipe.id, world.tick,
        { uses: recipe.uses, utility: recipe.utility, manufactured: recipe.manufactured });
    }
    // La cabeza de la cadena llega hasta lo confirmado: de la prueba vigente, de la línea base recién probada o,
    // en una recuperación explícita, de la que `previous()` verificó sobre la copia. Un intervalo vacío no
    // necesita prueba (archivo nuevo, o recién migrado desde antes del diario).
    const empty = { startsAfter: journal.startsAfter, through: journal.startsAfter, digest: TECHNOLOGY_CHAIN_EMPTY };
    chain ??= recovering && recoveredChain ? recoveredChain : journal.committedThrough === journal.startsAfter ? empty : null;
    if (!chain || chain.startsAfter !== journal.startsAfter || chain.through !== journal.committedThrough)
      technologyFailure('execution chain head is unknown');
    let digest = chain!.digest;
    for (const receipt of journal.pending)
      digest = technologyChainStep(digest, this.technologyArchive.putExecution(receipt), receipt.tick);
    return { startsAfter: journal.startsAfter, through: journal.committedThrough + journal.pending.length, digest };
  }

  save(world: World, inputs: { gesture: Gesture; result: GestureResult }[] = [], requiredSessions: string[] = [],
    changes: readonly SnapshotReplayChange[] = []): void {
    if (ley(world, 'guardadoCompleto')) throw new Error('El mundo usa guardado completo. Guárdalo con Store.guardar.');
    this.saveSnapshot(world, inputs, requiredSessions, changes);
  }

  guardar(i: Instantanea, corteAgenda?: CorteAgendaTerritorial): void {
    this.guardarConEntradas(i, [], [], corteAgenda);
  }

  guardarConEntradas(instantanea: Instantanea, inputs: { gesture: Gesture; result: GestureResult }[],
    sesiones: string[], corteAgenda?: CorteAgendaTerritorial): void {
    this.guardarCompleto(instantanea, inputs, sesiones, corteAgenda);
  }

  guardarCorteSellado(sello: CorteGuardadoSellado, inputs: { gesture: Gesture; result: GestureResult }[],
    sesiones: string[], corteAgenda?: CorteAgendaTerritorial): Instantanea {
    const { instantanea, fauna, teselas } = consumirCorteGuardado(sello);
    this.guardarCompleto(instantanea, inputs, sesiones, corteAgenda, fauna, teselas);
    return instantanea;
  }

  private guardarCompleto({ world, materia }: Instantanea, inputs: { gesture: Gesture; result: GestureResult }[],
    sesiones: string[], corteAgenda?: CorteAgendaTerritorial, faunaVerificada?: readonly TramoFaunaVerificada[],
    teselasVerificadas?: TeselasCorteVerificadas): void {
    if (!ley(world, 'guardadoCompleto')) throw new Error('Store.guardar requiere v23.guardadoCompleto.');
    if (world.version !== RULES_VERSION) throw new SnapshotSemanticError('El guardado completo de la V23 requiere un mundo nuevo.');
    if (materia !== null && materia.tick !== world.tick) throw new SnapshotSemanticError('Los ticks de mundo y materia no coinciden.');
    let guardado: MatterForWrite = null;
    if (materia !== null) {
      const bytes = materia.paginas.byteLength + materia.enVuelo.byteLength + materia.sustancias.byteLength + materia.registro.byteLength;
      guardado = bytes > this.snapshotMatterPartBytes
        ? SnapshotMatterParts.prepare(materia, this.snapshotMatterPartBytes) : codificarCheckpoint(materia);
    }
    const adjunto = corteAgenda === undefined ? undefined : {
      corte: validarCorteAgenda(corteAgenda, materia?.epoca ?? this.readCompleteEpoch() ?? 0, world.tick),
      materiaDigest: guardado instanceof Uint8Array ? checksum(guardado) : guardado?.digest ?? null,
    };
    this.saveSnapshot(world, inputs, sesiones, [], guardado, adjunto, faunaVerificada, teselasVerificadas);
  }

  private saveSnapshot(world: World, inputs: { gesture: Gesture; result: GestureResult }[], requiredSessions: string[],
    changes: readonly SnapshotReplayChange[], matter?: MatterForWrite, agenda?: AdjuntoAgenda,
    faunaVerificada?: readonly TramoFaunaVerificada[], teselasVerificadas?: TeselasCorteVerificadas): void {
    const complete = matter !== undefined;
    const matterParts = matter && !(matter instanceof Uint8Array) ? matter : null;
    let matterBody = matter instanceof Uint8Array ? matter : null;
    if (Object.hasOwn(world, CAMPO_AGENDA)) throw new SnapshotSemanticError('Campo reservado para el corte durable de la agenda territorial.');
    const retired = world.retiredChunks;
    if (this.db.isTransaction) { this.verifiedChronicle = null; throw new Error("Store.save requires its own transaction."); }
    const chronicleStamp = this.chronicleStamp();
    enableChronicleJournal(world); assertChronicleJournal(world);
    const committedChronicle = chronicleForCommit(world, this.chronicleDigest(world));
    // Escribir exige la misma ley de frontera que leer: nunca se archiva un estado
    // que `load()` rechazaría. La revisión COMPLETA recorre el mundo entero (tiles,
    // gente, recetas) y a día 5 era el 43 % del guardado: se ejecuta cada
    // `DEEP_VALIDATION_EVERY_SAVES` guardados y SIEMPRE en el primero de cada
    // proceso. VENTANA DESCUBIERTA: hasta 9 guardados (≤180 pasos, ~18 s con
    // `cadaTicks=20`) pueden archivarse sin la revisión completa. Lo que la cubre:
    // (1) las leyes POR SECCIÓN —crónica, tecnología, terreno dormido, identidades—
    // se siguen comprobando en CADA guardado; (2) `load()` aplica `assertWorld` al
    // arrancar, así que un estado inválido nunca se pone en uso; (3) el slot 1
    // conserva el guardado anterior y el slot 2 uno de cada cien, de modo que
    // `previous()` sigue siendo la salida si la revisión completa falla tarde.
    const deepValidation = complete || deepValidationDue(this.saves, this.verifiedByLoad);
    const validateBeforeWrite = () => {
      enableTechnologyJournal(world.technology);
      assertTechnologyJournal(world.technology, world.tick);
      // Dar el diagnóstico de autoría antes de la revisión general del mundo.
      for (const recipe of world.technology.catalogue?.pending ?? world.technology.recipes) this.assertTechnologyAuthor(world, recipe);
      if (deepValidation) assertWorld(world, world.version, this.context);
    };
    const validatedInReadSnapshot = deepValidation && world.version >= 5 && world.technology.journal !== undefined;
    if (validatedInReadSnapshot) {
      // assertWorld ya comprueba la tecnología. Resuelve sus referencias a recetas sobre una sola lectura SQLite.
      this.prepareTechnology(world, 0, validateBeforeWrite);
    } else {
      this.prepareTechnology(world);
      validateBeforeWrite();
    }
    this.onProgress?.();
    // Vale v18 de páginas limpias: solo si el sello COMPLETO (incluido `total_changes` de esta conexión)
    // sigue siendo el del último COMMIT de este Store y no toca la revisión completa. Los triggers se
    // descartan dentro de la transacción, antes de escribir; `snapshot-parts` recoteja allí los campos
    // que una conexión ajena puede mover. Cualquier desajuste ⇒ codificación completa de siempre.
    const stampTicket: SnapshotReuseTicket | undefined = this.snapshotPagesStamp !== null
      && sameChronicleStamp(this.snapshotPagesStamp, chronicleStamp)
      ? { dataVersion: chronicleStamp.dataVersion, schemaCookie: chronicleStamp.schemaCookie, tempSchemaCookie: chronicleStamp.tempSchemaCookie }
      : undefined;
    // Las páginas limpias exigen además que no toque la revisión completa; la recogida de partes
    // huérfanas solo necesita el sello (y, como aquellas, que no haya triggers: se retira al usarlo).
    const pageReuseTicket: SnapshotReuseTicket | undefined = !deepValidation ? stampTicket : undefined;
    const replayEnabled = !complete && paramsOf(world).persistencia.paginasSucias;
    // A replay reads archives at the checkpoint's horizon, not merely at its
    // head. Bound pruning by every retained anchor, even after flag rollback.
    const replayRetained = !complete
      && (replayEnabled || !!this.db.prepare('SELECT 1 FROM main.metadata WHERE key GLOB ? LIMIT 1').get(REPLAY_KEY + '*'));
    const configuredWindow = paramsOf(world).persistencia.ventanaEventosTicks;
    let window = configuredWindow;
    let prunes = window > 0 && world.tick - this.lastPruneTick >= window;
    const changedRecipeIds = new Set((world.technology.catalogue?.pending ?? world.technology.recipes).map(recipe => recipe.id));
    const memoBefore = this.archivedRecipes;
    const beforeMemoEpoch = memoBefore ? this.technologyArchive.readEpoch() : null;
    if (memoBefore && beforeMemoEpoch && memoBefore.epoch === beforeMemoEpoch && memoBefore.recipes.size > 0 && this.schemaVersion >= 4) {
      memoBefore.horizon ??= this.technologyArchive.latestTick();
    }
    // Los params vigentes viajan con el mundo: `load()` no puede medirlo con otros (R8).
    let prepared = replayEnabled ? undefined : this.snapshotParts.prepare({ ...world, chronicleJournal: committedChronicle,
      technology: technologyCatalogueStateForCommit(technologyStateForCommit(world.technology)), ...(agenda && { [CAMPO_AGENDA]: agenda }) },
    paramsOf(world), this.snapshotInlineTileLimit, faunaVerificada, teselasVerificadas);
    let replay: { node: SnapshotReplay; world: World } | undefined;
    let body = '', bodyDigest = '';
    let written: WrittenSnapshot | undefined;
    let committedChain: TechnologyChain | null = null;
    let technologyPruned: TechnologyPrune | null = null;
    let statsCompacted = 0;
    this.db.exec('BEGIN IMMEDIATE');
    // Authorization and commit share a transaction with respect to external revocation.
    // Revocada antes de escribir nada: se deshace una transacción sin cambios, que no mueve ningún sello,
    // así que las pruebas de la carga siguen valiendo (antes se tiraban y el guardado siguiente
    // reverificaba el archivo entero). Si la propia lectura falla, el camino de error de siempre.
    let revoked = false;
    try { revoked = requiredSessions.some(hash => !this.sessionValid(hash)); }
    catch (error) {
      this.db.exec('ROLLBACK'); this.technologyArchive.invalidateVerification(); this.verifiedChronicle = null; this.archivedRecipes = null; throw error;
    }
    if (revoked) { this.db.exec('ROLLBACK'); throw new SessionRevoked('Session revoked before commit.'); }
    let chronicleTriggers = false;
    try {
      const epoca = this.readCompleteEpoch();
      if (complete && !agenda && this.requiereAgenda())
        throw new SnapshotSemanticError('Este mundo requiere guardar su corte de agenda territorial.');
      if (agenda && epoca !== null && agenda.corte.epoca !== epoca)
        throw new SnapshotSemanticError('La agenda territorial no pertenece a la época reservada del motor.');
      if (complete && epoca === null) {
        this.assertNewCompleteStore();
        this.db.exec('CREATE TABLE main.snapshot_matter (slot INTEGER PRIMARY KEY, world_digest TEXT NOT NULL, body BLOB) STRICT');
        this.db.prepare('INSERT INTO main.metadata VALUES (?,?)').run(EPOCA_COMPLETA_KEY, String(agenda?.corte.epoca ?? 0));
      } else if (!complete && epoca !== null) {
        throw new Error('El mundo usa guardado completo. Guárdalo con Store.guardar.');
      }
      // Abrir la transacción anfitriona ANTES de `prepareReplay`: el replay ejecuta `stepWorld`
      // con lecturas de `catalogueReader`; sin ella cada consulta descartaba pruebas y reescaneaba
      // toda `technology_definitions` (12+ min y >120 GB leídos en un mundo V14 real de 705 hab.).
      this.technologyArchive.beginHostTransaction();
      // Otra conexión puede confirmar entre el snapshot de lectura y BEGIN IMMEDIATE. Si cambió
      // el archivo, revalidar los vínculos del candidato sobre la versión que vamos a escribir.
      if (validatedInReadSnapshot && !sameChronicleStamp(chronicleStamp, this.chronicleStamp())) validateBeforeWrite();
      chronicleTriggers = this.chronicleHasTriggers();
      const matterStillVerified = epoca !== null && !chronicleTriggers
        && (stampTicket !== undefined || this.loadedMatterStamp !== null && sameChronicleStamp(this.loadedMatterStamp, chronicleStamp))
        && sameChronicleStamp(chronicleStamp, this.chronicleStamp());
      const rotatesBackups = epoca === null || matterStillVerified
        ? this.slot0Readable ?? this.readSlot0()
        : this.slot0Readable !== false && this.readSlot0(epoca);
      const nextDurableSaves = this.readDurableSaves() + 1;
      const deep = rotatesBackups && nextDurableSaves % DEEP_CHECKPOINT_EVERY_SAVES === 0;
      const expectedMatterBackups = complete && chronicleTriggers ? this.expectedMatterBackups(rotatesBackups, deep) : null;
      const replayFloor = replayRetained ? this.replayFloor(world.tick) : null;
      if (replayRetained && configuredWindow > 0) {
        window = replayFloor === null ? 0 : Math.max(configuredWindow, world.tick - replayFloor + 1);
        prunes = window > 0 && world.tick - this.lastPruneTick >= configuredWindow;
      }
      if (replayEnabled) {
        replay = this.prepareReplay(world, inputs, changes, nextDurableSaves);
        if (replay.node.kind === 'checkpoint') prepared = this.snapshotParts.prepare(this.committedReplayWorld(world), paramsOf(world), this.snapshotInlineTileLimit);
      }
      this.assertChronicleChanges(world, chronicleStamp, !chronicleTriggers);
      const technologyChain = this.flushTechnology(world);
      technologyPruned = this.pruneTechnology(world, window, rotatesBackups, deep);
      statsCompacted = this.compactTechnologyStats(world, window, rotatesBackups, deep);
      this.technologyArchive.observeHostWrites(() => {
      if (this.schemaVersion >= 4) this.writeTechnologyMetadata(technologyChain, technologyPruned);
      this.flushChronicle(world);
      const archiveIdentity=this.db.prepare('INSERT INTO legacy VALUES (?,?,?,?)');
      for (const record of world.retiredLegacy) {
        assertLegacyRecord(record,world.tick); this.assertLegacyParents(record,world);
        const prior=this.loadLegacy(record.id);
        const archivedBody=stringifyExact(record);
        if (prior) { if(stringifyExact(prior)!==archivedBody) throw new Error('An archived identity cannot be overwritten. Explicit recovery required.'); }
        else archiveIdentity.run(record.id,record.diedAt,archivedBody,checksum(archivedBody));
      }
      if (retired.length) {
        const archive = this.db.prepare('INSERT OR REPLACE INTO chunks VALUES (?,?,?,?)');
        // Con ventana de poda el terreno dormido guarda una sola versión por clave:
        // la vigente. Sin ventana (0) se conserva el historial completo de siempre.
        const supersede = window > 0 ? this.db.prepare(replayRetained
          ? 'DELETE FROM chunks WHERE key=? AND tick<(SELECT MAX(tick) FROM chunks WHERE key=? AND tick<=?)'
          : 'DELETE FROM chunks WHERE key=? AND tick<?') : null;
        for (const chunk of retired) {
          assertChunk(chunk, chunk.key, world.tick, paramsOf(world).v23);
          // T133: compact tuple body; digest is sha256 of the stored bytes, as before.
          const archivedBody = encodeArchivedChunk(chunk);
          archive.run(chunk.key, world.tick, archivedBody, checksum(archivedBody));
          if (replayRetained) supersede?.run(chunk.key, chunk.key, replayFloor!);
          else supersede?.run(chunk.key, world.tick);
        }
      }
      if (prunes) this.pruneChronicle(world, committedChronicle, window);
      // El slot 1 sigue heredando la instantánea del guardado ANTERIOR en cada
      // guardado: cuesta ~13 ms de 630 a día 5 y es la profundidad de recuperación
      // que `previous()` promete (un guardado, no diez). Espaciarlo no compensa.
      // Pero solo si ese cuerpo se puede leer: tras un rescate el slot 0 está podrido y
      // copiarlo destruiría en un guardado (2 s en producción) el respaldo que acababa de
      // salvar el arranque. Un cuerpo no verificado nunca entra en un respaldo.
      if (rotatesBackups) {
        this.db.exec('INSERT OR REPLACE INTO snapshots SELECT 1,body,digest,saved_at FROM snapshots WHERE slot=0');
        if (deep) this.db.exec('INSERT OR REPLACE INTO snapshots SELECT 2,body,digest,saved_at FROM snapshots WHERE slot=0');
        if (complete) {
          this.db.exec('INSERT OR REPLACE INTO main.snapshot_matter SELECT 1,world_digest,body FROM main.snapshot_matter WHERE slot=0');
          if (deep) this.db.exec('INSERT OR REPLACE INTO main.snapshot_matter SELECT 2,world_digest,body FROM main.snapshot_matter WHERE slot=0');
        }
      }
      written = prepared ? this.snapshotParts.write(prepared, chronicleTriggers ? undefined : pageReuseTicket) : undefined;
      this.onProgress?.();
      if (replay) {
        if (replay.node.kind === 'checkpoint') replay.node.body = written!.body;
        body = stringifyExact(replay.node);
        bodyDigest = checksum(body);
        const existing = this.db.prepare('SELECT value FROM main.metadata WHERE key=?').get(REPLAY_KEY + bodyDigest) as { value: string } | undefined;
        if (existing && existing.value !== body) throw new SnapshotPhysicalError('Replay object disagrees with its digest.');
        if (!existing) this.db.prepare('INSERT INTO main.metadata VALUES (?,?)').run(REPLAY_KEY + bodyDigest, body);
        this.lastSnapshotBytes = Buffer.byteLength(body) + (written ? written.bytes - Buffer.byteLength(written.body) : 0);
      } else {
        body = written!.body;
        bodyDigest = written!.digest;
        if (!complete) this.lastSnapshotBytes = written!.bytes;
      }
      this.db.prepare('INSERT OR REPLACE INTO snapshots VALUES (0,?,?,?)').run(body, bodyDigest, Date.now());
      if (complete) {
        if (matterParts) {
          SnapshotMatterParts.install(this.db);
          matterBody = this.snapshotMatterParts.write(matterParts);
        }
        this.db.prepare('INSERT OR REPLACE INTO main.snapshot_matter VALUES (0,?,?)').run(bodyDigest, matterBody);
      }
      if (agenda) this.db.prepare('INSERT OR IGNORE INTO main.metadata VALUES (?,?)').run(AGENDA_DURABLE_KEY, '1');
      this.db.prepare("INSERT OR REPLACE INTO metadata VALUES ('initialized','1')").run();
      this.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run(DEEP_CHECKPOINT_SAVES_KEY, String(nextDurableSaves));
      const insertInput = this.db.prepare('INSERT INTO inputs VALUES (?,?,?,?,?,?)');
      for (const { gesture, result } of inputs) insertInput.run(gesture.id, fingerprint(gesture), result.tick, result.order, JSON.stringify(gesture), JSON.stringify(result));
      const collectionTicket = chronicleTriggers ? undefined : stampTicket;
      if (complete) {
        this.snapshotParts.collect(collectionTicket);
        this.collectMatterParts(chronicleTriggers);
      }
      else this.collectSnapshots(collectionTicket);
      });
      if (replay && this.replayParent(bodyDigest) !== body) throw new SnapshotPhysicalError('Replay head changed before commit.');
      if (agenda && !this.requiereAgenda()) throw new SnapshotSemanticError('La marca de agenda territorial cambió antes del commit.');
      if (chronicleTriggers) {
        this.assertChronicleOrigin({ ...world, chronicleJournal: committedChronicle }, true);
        this.assertChronicleArchive({ ...world, chronicleJournal: committedChronicle });
        const saved = this.db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get() as Row | undefined;
        if (!saved || saved.body !== body || saved.digest !== checksum(body)) chronicleFailure('trigger changed committed snapshot');
        if (complete && !this.db.prepare(`SELECT 1 FROM main.snapshot_matter
          WHERE slot=0 AND world_digest=? AND body IS ?`).get(bodyDigest, matterBody))
          throw new SnapshotPhysicalError('La materia cambió antes del commit.');
        if (expectedMatterBackups) this.verifyMatterBackups(expectedMatterBackups);
      }
      // La revisión de la cadena retenida comparte guardado con `assertWorld`.
      // Antes usaba `nextDurableSaves` y caía un guardado antes: dos picos
      // completos consecutivos cada diez commits sin evidencia adicional.
      if (replay && (chronicleTriggers || deepValidation)) {
        for (const row of this.db.prepare('SELECT body,digest FROM snapshots').all() as Row[]) {
          if (checksum(row.body) !== row.digest) throw new SnapshotPhysicalError('Retained replay checksum mismatch.');
          this.readSnapshot(row.body);
        }
      }
      if (chronicleTriggers) this.snapshotParts.verifyRetained();
      else if (written && written.pages.length) this.snapshotParts.assertWritten(written);
      this.db.exec('COMMIT');
      if (complete) this.lastSnapshotBytes = written!.bytes + (matterParts?.longitud ?? matterBody?.byteLength ?? 0);
      this.saves++;
      // Confirmado: el slot 0 es ahora este cuerpo, escrito y verificado por esta misma
      // conexión, así que la rotación de respaldos se reanuda en el guardado siguiente.
      this.slot0Readable = true;
      if (prunes) this.lastPruneTick = world.tick;
      this.technologyArchive.acknowledgeHostCommit();
      committedChain = technologyChain;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      this.technologyArchive.invalidateVerification();
      this.verifiedChronicle = null;
      this.archivedRecipes = null;
      // El directorio de páginas construido en esta transacción jamás se confirma: lo durable sigue siendo
      // el del COMMIT anterior (y el sello v18 no avanza, así que el reintento recoteja contra él).
      this.snapshotParts.discardPendingPages();
      throw error;
    }
    // A discarded transaction must leave the caller's pending archive queue intact for a retry.
    world.chronicleJournal = committedChronicle;
    this.verifiedChronicle = null;
    try {
      const current = this.chronicleStamp();
      const unchangedEnv = !chronicleTriggers && current.dataVersion === chronicleStamp.dataVersion && current.schemaCookie === chronicleStamp.schemaCookie
        && current.tempSchemaCookie === chronicleStamp.tempSchemaCookie;
      if (unchangedEnv) this.rememberChronicle(world, current);
      if (unchangedEnv && this.archivedRecipes === memoBefore && memoBefore && beforeMemoEpoch && memoBefore.epoch === beforeMemoEpoch
        && memoBefore.horizon !== undefined && Number.isSafeInteger(memoBefore.horizon) && world.tick >= memoBefore.horizon) {
        const afterEpoch = this.technologyArchive.readEpoch();
        if (afterEpoch !== null) {
          for (const [id, entry] of memoBefore.recipes) {
            if (changedRecipeIds.has(id) || entry.value === null || entry.atTick < memoBefore.horizon) memoBefore.recipes.delete(id);
            else entry.atTick = world.tick;
          }
          memoBefore.epoch = afterEpoch;
          memoBefore.horizon = world.tick;
        } else this.archivedRecipes = null;
      } else this.archivedRecipes = null;
    } catch { this.archivedRecipes = null; /* Durable commit succeeded; losing a cache is not a failed transaction. */ }
    world.retiredChunks = [];
    world.retiredLegacy = [];
    markTechnologyJournalCommitted(world.technology);
    markTechnologyCatalogueCommitted(world.technology);
    this.replayCache = null;
    if (replay) {
      try { this.replayCache = { digest: bodyDigest, world: replay.world, stamp: this.chronicleStamp() }; }
      catch { /* A lost cache never changes an acknowledged commit. */ }
    }
    // The transaction is already durable. Failure to refresh an optimization
    // cannot turn a successful save into a reported failure or a discarded tick.
    try {
      this.rememberTechnology(world, committedChain!);
      this.rememberSlotBounds(bodyDigest, world);
      if (!this.readOnly && this.autoVacuumIncremental && (technologyPruned !== null || statsCompacted > 0 || prunes)) {
        this.db.exec('PRAGMA incremental_vacuum(256)');
      }
    }
    catch {
      this.verifiedTechnology = null; this.verifiedCatalogue = null; this.verifiedRecipes.clear();
      this.technologyArchive.invalidateVerification();
    }
    // v18: solo ahora —COMMIT hecho y pasada la limpieza post-confirmación (vacuum incremental incluido)—
    // el directorio de páginas pasa a confirmado y el sello queda tomado sobre el estado durable. Si el
    // sello no se puede leer, se olvida todo el directorio: perder la caché nunca invalida el guardado.
    try {
      this.snapshotParts.confirmPendingPages();
      this.snapshotPagesStamp = this.chronicleStamp();
    } catch {
      this.snapshotPagesStamp = null;
      this.snapshotParts.invalidatePageCache();
    }
  }
  result(gesture: Gesture): GestureResult | null {
    const row = this.db.prepare('SELECT fingerprint,result FROM inputs WHERE id=?').get(gesture.id) as { fingerprint: string; result: string } | undefined;
    if (!row) return null;
    if (row.fingerprint !== fingerprint(gesture)) throw new GestureConflict('Ese identificador ya se usó para otro gesto.');
    return JSON.parse(row.result) as GestureResult;
  }
  /** Da de alta la procedencia después de confirmar el primer guardado. */
  ensureWorldInstance(): string {
    if (this.db.isTransaction) throw new Error('Store.ensureWorldInstance requires its own transaction.');
    return this.auxiliaryWrite(() => writeWorldInstance(this.db)).instanceId;
  }
  addSession(hash: string, expires: number) {
    this.auxiliaryWrite(() => ({
      changes: Number(this.db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now()).changes)
        + Number(this.db.prepare('INSERT INTO sessions VALUES (?,?)').run(hash, expires).changes),
    }));
  }
  /**
   * Las escrituras sobre sesiones y la clave de procedencia mueven `total_changes()`.
   * Las pruebas vigentes avanzan si el sello refleja exactamente esa escritura local, con ambos esquemas
   * estables y sin disparadores ni cambios de otra conexión. Durante la recuperación,
   * la revocación de sesiones participa en la transacción anfitriona sin retocar las pruebas.
   */
  private auxiliaryWrite<T extends { changes: number }>(write: () => T): T {
    if (this.db.isTransaction) return write();
    const before = this.chronicleStamp();
    const beforeMemoEpoch = this.archivedRecipes ? this.technologyArchive.readEpoch() : null;
    this.db.exec('BEGIN IMMEDIATE');
    let result: T, triggers: boolean;
    try {
      triggers = this.chronicleHasTriggers();
      this.technologyArchive.beginHostTransaction();
      result = this.technologyArchive.observeHostWrites(write);
      this.db.exec('COMMIT');
      this.technologyArchive.acknowledgeHostCommit();
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      this.technologyArchive.invalidateVerification();
      this.archivedRecipes = null;
      throw error;
    }
    const after = this.chronicleStamp();
    const own = !triggers && after.dataVersion === before.dataVersion && after.schemaCookie === before.schemaCookie
      && after.tempSchemaCookie === before.tempSchemaCookie && after.totalChanges === before.totalChanges + result.changes;
    const technology = this.verifiedTechnology;
    if (own && technology && technology.dataVersion === before.dataVersion && technology.totalChanges === before.totalChanges
      && technology.schemaCookie === before.schemaCookie) technology.totalChanges = after.totalChanges;
    const chronicle = this.verifiedChronicle;
    if (own && chronicle && sameChronicleStamp(chronicle.stamp, before)) chronicle.stamp = after;
    if (own && this.snapshotPagesStamp && sameChronicleStamp(this.snapshotPagesStamp, before)) this.snapshotPagesStamp = after;
    if (own && this.archivedRecipes && beforeMemoEpoch && this.archivedRecipes.epoch === beforeMemoEpoch) {
      const afterEpoch = this.technologyArchive.readEpoch();
      if (afterEpoch !== null) this.archivedRecipes.epoch = afterEpoch;
      else this.archivedRecipes = null;
    }
    return result;
  }
  sessionValid(hash: string): boolean {
    const row = this.db.prepare('SELECT expires FROM sessions WHERE hash=?').get(hash) as { expires: number } | undefined;
    return !!row && row.expires > Date.now();
  }
  revoke(hash?: string) {
    this.auxiliaryWrite(() => ({
      changes: Number((hash ? this.db.prepare('DELETE FROM sessions WHERE hash=?').run(hash)
        : this.db.prepare('DELETE FROM sessions').run()).changes),
    }));
  }
  backup(destination: string) {
    if (existsSync(destination)) throw new Error('Backup destination exists; choose a new path.');
    mkdirSync(dirname(resolve(destination)), { recursive: true, mode: 0o700 });
    this.db.prepare('VACUUM INTO ?').run(resolve(destination));
  }

  /** Recuperación: recorre los digestos retenidos desde la frontera de poda, comprueba que cierran la cabeza
   * durable (si la hay) y devuelve el pliegue a través de `target`, la cabeza que tendrá la copia. */
  private technologyChainAt(target: number): TechnologyChain | null {
    const origin = this.technologyArchive.getHistoryOrigin();
    if (!origin) return null;
    const boundary = this.prunedTechnology(), head = this.technologyChainRecord();
    if (boundary && boundary.startsAfter !== origin.startsAfter || head && head.startsAfter !== origin.startsAfter)
      technologyFailure('prune boundary disagrees with history origin');
    if (boundary && !head) technologyFailure('prune boundary has no execution chain head');
    if (boundary && head?.version !== 2) technologyFailure('prune boundary has no V2 execution chain head');
    // La cabeza V2 es la de la última instantánea: nunca queda por detrás de un punto anterior que se recupera.
    if (head?.version === 2 && head.through < target) technologyFailure('execution chain head V2 is behind the recovered coverage');
    if (head?.version === 2 && head.pruneSeal !== (boundary?.seal ?? null))
      technologyFailure('execution chain head disagrees with prune boundary seal');
    const firstRetained = boundary && this.db.prepare('SELECT tick FROM technology_executions WHERE serial=?').get(boundary.through + 1) as
      { tick: number } | undefined;
    if (boundary && firstRetained && firstRetained.tick <= boundary.tick)
      technologyFailure('prune boundary tick overlaps the first retained execution');
    let serial = boundary ? boundary.through : origin.startsAfter, digest = boundary ? boundary.digest : TECHNOLOGY_CHAIN_EMPTY;
    let legacyDigest = TECHNOLOGY_CHAIN_EMPTY;
    if (target < serial) technologyFailure('prune boundary escapes declared coverage');
    const currentHead = () => head?.version === 1 ? legacyDigest : digest;
    let atTarget = target === serial ? digest : null, headChecked = !head || head.through === serial && head.digest === currentHead();
    if (head && head.through < serial) technologyFailure('execution chain head escapes declared coverage');
    for (const row of this.db.prepare('SELECT serial,tick,digest FROM technology_executions WHERE serial>? ORDER BY serial')
      .iterate(serial) as Iterable<{ serial: number; tick: number; digest: string }>) {
      // Lo posterior al punto recuperado se borra en la copia: un hueco ahí no impide recuperar (para eso
      // existe `previous()`), sólo deja sin comprobar una cabeza que caiga más allá.
      if (row.serial !== ++serial) { if (serial <= target) technologyFailure('declared execution coverage has a gap'); break; }
      digest = technologyChainStep(digest, row.digest, row.tick);
      if (!boundary) legacyDigest = legacyTechnologyChainStep(legacyDigest, row.digest);
      if (serial === target) atTarget = digest;
      if (head && head.through === serial) {
        if (head.digest !== currentHead()) technologyFailure('execution chain disagrees with archive');
        headChecked = true;
      }
    }
    if (atTarget === null) technologyFailure('declared execution coverage is incomplete');
    if (!headChecked && head!.through <= target) technologyFailure('execution chain disagrees with archive');
    return { startsAfter: origin.startsAfter, through: target, digest: atTarget! };
  }

  /** Only called inside a transaction on the explicit recovery copy. A checkpoint
   * predating journaling supplies real earlier observations, not a moved live watermark. */
  private rebuildPreviousTechnology(world: World): void {
    const origin = this.technologyArchive.getHistoryOrigin();
    const current = this.db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get() as Row | undefined;
    // When an origin exists, the newer committed checkpoint must corroborate it.
    // Unverifiable metadata is not permission to reconstruct a damaged retained prefix.
    if (origin) {
      if (!current || checksum(current.body) !== current.digest) technologyFailure('cannot verify recovery history origin');
      const baseline = this.migrateSnapshot(this.readSnapshot(current!.body) as World), journal = baseline.technology.journal;
      if (!journal || journal.startsAfter !== origin.startsAfter || journal.pending.length
        || journal.committedThrough !== baseline.technology.executionCounter) technologyFailure('recovery history origin disagrees with committed snapshot');
      assertTechnologyJournal(baseline.technology, baseline.tick);
      // La copia ya perdió las filas posteriores a este punto: la cabeza de la cadena no se puede cerrar aquí,
      // y todo el archivo de recibos se reconstruye abajo desde el anillo de la instantánea.
      this.assertTechnologyReceipts(world, origin.startsAfter, world.technology.executionCounter, false);
      for (const recipe of world.technology.recipes) {
        const retained = this.technologyArchive.getDefinition(recipe.id, world.tick);
        if (!retained || JSON.stringify(retained) !== JSON.stringify(definitionOf(recipe))) technologyFailure('recovery definition disagrees with checkpoint');
        const stats = this.technologyArchive.getStats(recipe.id, world.tick);
        if (stats && (stats.uses > recipe.uses || stats.utility > recipe.utility || stats.manufactured > recipe.manufactured
          || stats.tick === world.tick && !sameStats(stats, recipe))) technologyFailure('recovery statistics disagree with checkpoint');
      }
      for (const receipt of world.technology.history) {
        const retained = this.technologyArchive.getExecution(receipt.id, world.tick);
        if (retained && JSON.stringify(retained) !== JSON.stringify(receipt)) technologyFailure('recovery execution disagrees with checkpoint');
      }
    } else {
      if (['technology_definitions', 'technology_stats', 'technology_executions'].some(table => this.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())) technologyFailure('recovery archive has records but no origin');
      if (current && checksum(current.body) === current.digest) {
        const baseline = this.migrateSnapshot(this.readSnapshot(current.body) as World);
        if (baseline.technology.journal !== undefined) technologyFailure('recovery lost its declared history origin');
      }
    }
    // All retained rows were validated by truncateAfter; overlapping observations
    // and any already-declared serial interval were checked above. Only this copy
    // now receives the old checkpoint's exact surviving ring and its honest origin.
    this.db.exec('DELETE FROM technology_executions; DELETE FROM technology_stats; DELETE FROM technology_definitions; DELETE FROM technology_origin;');
    this.db.prepare('DELETE FROM main.metadata WHERE key IN (?,?)').run(TECHNOLOGY_PRUNED_KEY, TECHNOLOGY_CHAIN_KEY);
    this.verifiedTechnology = null; this.verifiedRecipes.clear();
  }

  /** Todas las lecturas de un mundo durable validan sus leyes antes de migrarlo,
   * también al verificar el baseline de un guardado o reconstruir una recuperación. */
  private migrateSnapshot(decoded: World, complete = false): World {
    const params = takeSnapshotParams(decoded);
    separarAgenda(decoded);
    if (complete && !params.v23.guardadoCompleto) throw new SnapshotSemanticError('El guardado completo requiere v23.guardadoCompleto.');
    setParams(decoded, params);
    if (ley(decoded, 'guardadoCompleto')) {
      assertWorld(decoded, RULES_VERSION, this.context);
      return decoded;
    }
    const world = migrateWorld(decoded, this.context);
    setParams(world, params);
    return world;
  }

  /** Verificación previa de un candidato de la cadena, ANTES de copiar nada al destino:
   * una recuperación imposible no deja una copia a medias. */
  private verifyPrevious(decoded: World, complete: boolean): { world: World; declaredJournal: boolean; agendaBruta: unknown } {
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new SnapshotSemanticError('Invalid snapshot world. Explicit recovery required.');
    const declaredChronicle = decoded.chronicleJournal !== undefined;
    const agendaBruta = separarAgenda(decoded);
    if (!complete && agendaBruta !== undefined) throw new SnapshotSemanticError('La agenda territorial requiere guardado completo.');
    const world = this.migrateSnapshot(decoded, complete);
    this.assertChronicleOrigin(world, declaredChronicle, true);
    this.assertChronicleArchive(world, true);
    const declaredJournal = world.technology.journal !== undefined;
    if (world.technology.catalogue && (world.technology.catalogue.pending.length ||
      world.technology.catalogue.committedThrough !== world.technology.recipeCounter)) technologyFailure('previous snapshot contains uncommitted definitions');
    enableTechnologyJournal(world.technology);
    assertTechnologyJournal(world.technology, world.tick);
    if (declaredJournal && (world.technology.journal!.pending.length || world.technology.journal!.committedThrough !== world.technology.executionCounter)) technologyFailure('previous snapshot contains uncommitted executions');
    return { world, declaredJournal, agendaBruta };
  }
  /**
   * Recuperación explícita a un punto anterior, en una copia NUEVA: recorre la cadena
   * desde `fromSlot` (1 = el guardado anterior, 2 = el respaldo profundo de cada
   * `DEEP_CHECKPOINT_EVERY_SAVES`) y rebobina al primer respaldo verificable. Devuelve
   * el slot que restauró, para que quien lo pidió sepa cuánto retrocedió.
   */
  previous(destination: string, fromSlot: SnapshotSlot = 1): SnapshotSlot {
    if (this.db.isTransaction) throw new Error('Store.previous requires its own transaction.');
    const refusals: string[] = [];
    let chosen: { slot: SnapshotSlot; row: Row; matterDigest: string | null } | undefined;
    let complete = false;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('SELECT 1 FROM main.sqlite_schema LIMIT 1').get();
      this.technologyArchive.beginHostTransaction();
      const epoca = this.readCompleteEpoch();
      complete = epoca !== null;
    for (const slot of SNAPSHOT_SLOTS) {
      if (slot < fromSlot) continue;
      const candidate = this.db.prepare('SELECT body,digest,saved_at FROM snapshots WHERE slot=?').get(slot) as Row | undefined;
      if (!candidate) { refusals.push(`slot ${slot}: snapshot missing`); continue; }
      if (checksum(candidate.body) !== candidate.digest) { refusals.push(`slot ${slot}: snapshot checksum mismatch`); continue; }
      // Aquí sí se salta un respaldo que infringe una ley: quien pidió recuperar ya
      // aceptó retroceder, y el destino es una copia nueva que se poda y se valida.
      let decoded: World;
      try { decoded = (complete ? this.snapshotParts.read(candidate.body) : this.readSnapshot(candidate.body)) as World; }
      catch (error) {
        // The reader may throw ordinary operational errors too. Only declared
        // codec faults justify skipping its bytes; do not classify by message.
        if (!(error instanceof SnapshotPhysicalError) && !(error instanceof SnapshotSemanticError)) throw error;
        refusals.push(`slot ${slot}: ${error.message}`); continue;
      }
      try {
        const { world, agendaBruta } = this.verifyPrevious(decoded, complete);
        if (complete && slot === 0 && agendaBruta === undefined && this.requiereAgenda())
          throw new SnapshotSemanticError('Falta el corte territorial del guardado vigente.');
        const { materia, digest } = complete ? this.readCompleteMatter(slot, world.tick) : { materia: null, digest: null };
        if (epoca !== null) {
          this.decodeCompleteAgenda(agendaBruta, digest, materia, world.tick, epoca);
        }
        chosen = { slot, row: candidate, matterDigest: digest };
        break;
      }
      catch (error) {
        // Existing validators report plain Error; codec faults are typed. Resource,
        // programming and coded Node/SQLite failures do not authorize a rewind.
        if (!(error instanceof SnapshotPhysicalError) && !(error instanceof SnapshotSemanticError)
          && (!(error instanceof Error) || error.constructor !== Error || 'code' in error)) throw error;
        refusals.push(`slot ${slot}: ${error.message}`);
      }
    }
    this.db.exec('COMMIT');
    this.technologyArchive.acknowledgeHostCommit();
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); this.technologyArchive.invalidateVerification(); throw error; }
    if (!chosen) throw new Error(`No valid previous checkpoint (${refusals.join('; ')}).`);
    this.backup(destination);
    const recovered = new Store(destination, { snapshotInlineTileLimit: this.snapshotInlineTileLimit,
      snapshotMatterPartBytes: this.snapshotMatterPartBytes, snapshotPackedPeople: this.snapshotPackedPeople });
    try {
      recovered.db.exec('BEGIN IMMEDIATE');
      recovered.technologyArchive.beginHostTransaction();
      // VACUUM cannot run inside the source read transaction. Another writer may
      // rotate a checkpoint or remove its pages in that interval. Never silently
      // substitute its new slot occupant or reuse the previously decoded world.
      const copied = recovered.db.prepare('SELECT body,digest,saved_at FROM snapshots WHERE slot=?').get(chosen.slot) as Row | undefined;
      if (!copied || copied.body !== chosen.row.body || copied.digest !== chosen.row.digest || copied.saved_at !== chosen.row.saved_at)
        throw new Error('Selected previous checkpoint changed before backup. Explicit recovery required.');
      const copiedWorld = (complete ? recovered.snapshotParts.read(copied.body) : recovered.readSnapshot(copied.body)) as World;
      const { world, declaredJournal, agendaBruta } = recovered.verifyPrevious(copiedWorld, complete);
      const matter = complete ? recovered.completeMatterBody(chosen.slot) : null;
      if (complete && recovered.snapshotMatterParts.verify(matter) !== chosen.matterDigest)
        throw new Error('La materia del respaldo seleccionado cambió antes de copiarlo.');
      bindWorldContext(world, recovered.context);
      // Antes de borrar nada: la cadena del original tiene que cerrar sobre lo retenido, y su pliegue en este
      // punto es la cabeza de la copia (las filas posteriores se van a borrar).
      const chainAtCheckpoint = declaredJournal ? recovered.technologyChainAt(world.technology.executionCounter) : null;
      // Two snapshots may share a tick. Their serial/recipe boundaries still differ.
      recovered.db.prepare('DELETE FROM technology_executions WHERE serial>?').run(world.technology.executionCounter);
      recovered.db.prepare('DELETE FROM technology_stats WHERE recipeId IN (SELECT id FROM technology_definitions WHERE CAST(substr(id,8) AS INTEGER)>?)').run(world.technology.recipeCounter);
      recovered.db.prepare('DELETE FROM technology_definitions WHERE CAST(substr(id,8) AS INTEGER)>?').run(world.technology.recipeCounter);
      recovered.technologyArchive.truncateAfter(world.tick);
      let chain: TechnologyChain | null = null;
      if (declaredJournal) {
        if (chainAtCheckpoint) recovered.writeTechnologyMetadata(chainAtCheckpoint, null);
        recovered.assertTechnologyCache(world);
        chain = recovered.assertTechnologyCoverage(world);
      } else recovered.rebuildPreviousTechnology(world);
      recovered.prepareTechnology(world, declaredJournal ? world.technology.recipeCounter : 0);
      // A pre-journal checkpoint has surviving receipts in memory, not a backed watermark.
      recovered.writeTechnologyMetadata(recovered.flushTechnology(world, true, chain), null);
      const prepared = recovered.snapshotParts.prepare({ ...world, technology: technologyCatalogueStateForCommit(technologyStateForCommit(world.technology)),
        ...(agendaBruta !== undefined && { [CAMPO_AGENDA]: agendaBruta }) }, paramsOf(world), recovered.snapshotInlineTileLimit);
      const { body } = recovered.snapshotParts.write(prepared);
      const digest = checksum(body);
      recovered.db.prepare('INSERT OR REPLACE INTO snapshots VALUES (0,?,?,?)').run(body, digest, chosen.row.saved_at);
      // La copia empieza su propia cadena: heredar los respaldos del original dejaría
      // ahí puntos POSTERIORES al que se acaba de restaurar (o los que fallaron).
      recovered.db.prepare('DELETE FROM snapshots WHERE slot<>0').run();
      if (complete) {
        recovered.db.prepare('INSERT OR REPLACE INTO main.snapshot_matter VALUES (0,?,?)').run(digest, matter);
        recovered.db.exec('DELETE FROM main.snapshot_matter WHERE slot<>0');
        if (agendaBruta === undefined) recovered.db.prepare('DELETE FROM main.metadata WHERE key=?').run(AGENDA_DURABLE_KEY);
        else recovered.db.prepare('INSERT OR IGNORE INTO main.metadata VALUES (?,?)').run(AGENDA_DURABLE_KEY, '1');
      }
      recovered.db.prepare('DELETE FROM main.metadata WHERE key=?').run(DEEP_CHECKPOINT_SAVES_KEY);
      recovered.db.prepare('DELETE FROM inputs WHERE tick>?').run(world.tick);
      recovered.db.prepare('DELETE FROM events WHERE tick>?').run(world.tick);
      recovered.db.prepare('DELETE FROM chunks WHERE tick>?').run(world.tick);
      recovered.db.prepare('DELETE FROM legacy WHERE tick>?').run(world.tick);
      for (const event of recovered.db.prepare('SELECT id FROM events WHERE tick=?').all(world.tick) as {id:string}[]) {
        const serial = chronicleSerial(event.id);
        if (serial !== null ? serial > world.eventCounter : !world.events.some(e => e.id === event.id)) recovered.db.prepare('DELETE FROM events WHERE id=?').run(event.id);
      }
      // Recovery changes only the explicit destination's coverage epoch.
      recovered.db.prepare("INSERT OR REPLACE INTO metadata VALUES ('chronicle-origin-v1',?)").run(JSON.stringify({ version: 1, startsAfter: world.chronicleJournal!.startsAfter }));
      recovered.assertChronicleOrigin(world, true); recovered.assertChronicleArchive(world);
      recovered.revoke();
      if (complete) {
        recovered.snapshotParts.collect();
        recovered.collectMatterParts(true);
      }
      else recovered.collectSnapshots();
      if (recovered.chronicleHasTriggers()) recovered.snapshotParts.verifyRetained();
      else if (prepared.inline === undefined) recovered.snapshotParts.verify(body);
      // Self-consistency is insufficient: a trigger could substitute a different
      // valid world with a recomputed digest. Keep the exact selected checkpoint.
      const final = recovered.db.prepare('SELECT body,digest,saved_at FROM snapshots WHERE slot=0').get() as Row | undefined;
      if (!final || final.body !== body || final.digest !== checksum(body) || final.saved_at !== chosen.row.saved_at)
        throw new Error('Trigger changed the selected recovery snapshot. Explicit recovery required.');
      if (complete && !recovered.db.prepare(`SELECT 1 FROM main.snapshot_matter
        WHERE slot=0 AND world_digest=? AND body IS ?`).get(digest, matter))
        throw new SnapshotPhysicalError('La materia del respaldo cambió antes del commit.');
      if (complete && recovered.db.prepare('SELECT 1 FROM main.snapshot_matter WHERE slot<>0 LIMIT 1').get())
        throw new SnapshotPhysicalError('La copia recuperada conserva otros slots de materia.');
      // All writes, including revocation and GC triggers, precede this full read.
      // A failed archive check must roll back the copy, not report failure after
      // committing an already damaged recovery destination.
      const verified = recovered.verificarGuardado();
      if (!verified || verified.slot !== 0) throw new Error('Selected recovery snapshot is not readable. Explicit recovery required.');
      recovered.assertNothingNewerThan(verified.world);
      recovered.db.exec('COMMIT'); recovered.technologyArchive.acknowledgeHostCommit();
    } catch (error) {
      if (recovered.db.isTransaction) recovered.db.exec('ROLLBACK');
      recovered.technologyArchive.invalidateVerification(); throw error;
    }
    finally { recovered.close(); }
    return chosen.slot;
  }
  close() { this.db.close(); }
}
