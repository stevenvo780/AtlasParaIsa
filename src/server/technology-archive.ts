import * as nodeCrypto from 'node:crypto';
import { createHash } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { TECHNOLOGY_ARCHIVE_LAWS_VERSION, type TechnologyDefinition, type TechnologyExecutionQuery,
  type TechnologyStats, type TechnologyStatsRecord, type TechnologyHistoryOrigin } from '../shared/technology-archive.js';
import type { TechnologyCatalogueTotals, TechnologyExecution, TechnologyProgram } from '../shared/technology.js';
import { assertWaterExecution } from '../world/technology-water.js';
import { technologyFunctionCode, technologyFunctionCount, TECHNOLOGY_FUNCTION_WORDS } from '../world/technology-catalogue.js';

const MAX_TICK = Number.MAX_SAFE_INTEGER;
const CAPABILITIES = ['cutting', 'storage', 'insulation', 'cultivation', 'binding', 'abrasion'];
const MATERIALS = ['wood', 'stone', 'water'];
const CATALYSTS: Record<string, string[]> = { combine: ['binding'], separate: ['cutting', 'abrasion'], form: ['cutting', 'abrasion'],
  abrade: ['abrasion'], heat: ['insulation'], cool: ['storage'], compress: ['cultivation'], weave: ['binding'] };
// `crypto.hash` (Node ≥ 21.7) es el mismo SHA-256 hexadecimal sobre el mismo UTF-8 que
// `createHash().update().digest()`, sin crear un objeto Hash por fila (V18 ola 2: 1,4 M filas por carga).
const checksum: (body: string) => string = typeof nodeCrypto.hash === 'function'
  ? body => nodeCrypto.hash('sha256', body, 'hex') : body => createHash('sha256').update(body).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value);
const text = (value: unknown, max = 100): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const identifier = (value: unknown): value is string => text(value) && !/\s/.test(value);
const keys = (value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> => object(value)
  && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
/** La misma ley que `keys` sin alocar nada por llamada (V18 ola 2, camino caliente de los recibos): toda clave
 * requerida es propia (enumerable o no) y toda clave propia enumerable está permitida. `for…in` recorre las
 * propias enumerables y además las heredadas enumerables, que se descartan con `Object.hasOwn`: el conjunto
 * que se examina es exactamente el de `Object.keys`. */
interface Shape { required: readonly string[]; allowed: ReadonlySet<string>; }
const shape = (required: readonly string[], optional: readonly string[] = []): Shape => ({ required, allowed: new Set([...required, ...optional]) });
function shaped(value: unknown, form: Shape): value is Record<string, unknown> {
  if (!object(value)) return false;
  const required = form.required;
  for (let index = 0; index < required.length; index++) if (!Object.hasOwn(value, required[index]!)) return false;
  for (const key in value) if (!form.allowed.has(key) && Object.hasOwn(value, key)) return false;
  return true;
}
/** Serie canónica `[1-9][0-9]*` desde `start` hasta el final, como entero seguro, o `null`. Equivale a
 * `/^…-[1-9]\d*$/` + `Number(slice)` + `integer`: más de 16 cifras sin cero inicial ya supera 2^53 − 1, y
 * mientras el acumulado es exacto (≤ 2^53) el redondeo monótono no puede devolverlo por debajo del tope. */
function serialAt(value: string, start: number): number | null {
  const length = value.length;
  if (start >= length || length - start > 16) return null;
  let serial = 0;
  for (let index = start; index < length; index++) {
    const digit = value.charCodeAt(index) - 48;
    if (digit < 0 || digit > 9 || digit === 0 && index === start) return null;
    serial = serial * 10 + digit;
  }
  return Number.isSafeInteger(serial) ? serial : null;
}
// Sprint noche-arch 2026-09-23: `serialOf` construía un `new RegExp` en cada llamada; V18 ola 2: ni RegExp ni
// `slice`, mismo lenguaje aceptado (prefijo exacto, sin cero inicial, entero seguro).
const SERIAL_PREFIXES = { process: 'process-', recipe: 'recipe-', product: 'product-', transfer: 'transfer-' } as const;
const serialOf = (value: unknown, prefix: keyof typeof SERIAL_PREFIXES): number | null => {
  if (typeof value !== 'string') return null;
  const head = SERIAL_PREFIXES[prefix];
  return value.startsWith(head) ? serialAt(value, head.length) : null;
};
const recipeId = (value: unknown): value is string => serialOf(value, 'recipe') !== null;
function fail(what: string): never { throw new Error(`Invalid technology archive ${what}.`); }
function tick(value: unknown): asserts value is number { if (!integer(value)) fail('tick'); }
const ids = (value: unknown, max: number, check = recipeId): value is string[] => Array.isArray(value)
  && value.length <= max && value.every(check) && new Set(value).size === value.length;

/** Frozen V1 representation: do not silently reinterpret old definitions using future engine laws. */
function assertProgram(value: unknown): asserts value is TechnologyProgram {
  if (!keys(value, ['inputs', 'steps']) || !Array.isArray(value.inputs) || value.inputs.length < 1 || value.inputs.length > 4
    || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 12) fail('program');
  for (const input of value.inputs) {
    if (!keys(input, ['source', 'mass'], ['material', 'recipeId']) || !integer(input.mass) || input.mass < 30 || input.mass > 4000) fail('program input');
    if (input.source === 'product') {
      if (!recipeId(input.recipeId) || Object.hasOwn(input, 'material')) fail('product input');
    } else if (!['raw', 'residue'].includes(String(input.source)) || !MATERIALS.includes(String(input.material)) || Object.hasOwn(input, 'recipeId')
      || input.source === 'raw' && input.material !== 'water' && input.mass % 1000 !== 0) fail('raw input');
  }
  for (const step of value.steps) {
    if (!keys(step, ['op', 'intensity'], ['shape', 'material', 'catalyst', 'requiredCatalyst']) || !text(step.op) || !Object.hasOwn(CATALYSTS, step.op)
      || !integer(step.intensity) || step.intensity < 1 || step.intensity > 4
      || Object.hasOwn(step, 'shape') && !['edge', 'hollow', 'sheet', 'rod', 'granular'].includes(String(step.shape))
      || Object.hasOwn(step, 'material') && !MATERIALS.includes(String(step.material))
      || ['catalyst', 'requiredCatalyst'].some(key => Object.hasOwn(step, key) && !CATALYSTS[step.op as string]!.includes(String(step[key])))) fail('program step');
  }
}
function signature(program: TechnologyProgram): string {
  return JSON.stringify([program.inputs.map(i => [i.source, i.material ?? '', i.recipeId ?? '', i.mass]),
    program.steps.map(s => [s.op, s.intensity, s.shape ?? '', s.material ?? '', s.catalyst ?? '', s.requiredCatalyst ?? ''])]);
}
function assertDefinition(value: unknown): asserts value is TechnologyDefinition {
  if (!keys(value, ['lawsVersion', 'id', 'name', 'program', 'signature', 'parents', 'generation', 'inventorId', 'tick', 'x', 'y', 'novelty', 'capacities'])
    || value.lawsVersion !== TECHNOLOGY_ARCHIVE_LAWS_VERSION || !recipeId(value.id) || !text(value.name) || !identifier(value.inventorId)
    || !integer(value.tick) || !integer(value.generation) || value.generation < 1 || !ids(value.parents, 6)
    || typeof value.x !== 'number' || !Number.isFinite(value.x) || typeof value.y !== 'number' || !Number.isFinite(value.y)
    || !['program', 'function', 'both'].includes(String(value.novelty)) || !keys(value.capacities, CAPABILITIES)) fail('definition');
  const capacities = value.capacities;
  if (CAPABILITIES.some(key => !finite(capacities[key]) || (capacities[key] as number) > 1)) fail('definition capacities');
  assertProgram(value.program);
  const parents = value.parents;
  if (value.signature !== signature(value.program) || parents.includes(value.id)
    || value.program.inputs.some(input => input.source === 'product' && !parents.includes(input.recipeId!))) fail('definition signature or parents');
}
function assertStats(value: unknown): asserts value is TechnologyStats {
  if (!keys(value, ['uses', 'utility', 'manufactured']) || !integer(value.uses) || !finite(value.utility) || !integer(value.manufactured)) fail('statistics');
}
const BASIC_RESOURCES: ReadonlySet<string> = new Set(['raw', 'residue', 'spent']
  .flatMap(state => ['wood', 'stone', 'water'].map(material => `${state}:${material}`)).concat('unclassified'));
/** `/^(raw|residue|spent):(wood|stone|water)$/`, `unclassified` o `recipe:` + un id de receta canónico. */
const resourceId = (value: unknown): boolean => typeof value === 'string'
  && (BASIC_RESOURCES.has(value) || value.startsWith('recipe:recipe-') && serialAt(value, 14) !== null);
/** Masa total de una lista de recursos válida, o −1 si la lista no es válida. Repeated resource lines are
 * legal (two substrates or substrate plus fuel). Cada línea tiene exactamente `resourceId` y `mass` propios;
 * los huecos de un arreglo disperso (imposibles en JSON) se rechazan en vez de saltarse. */
function resourceMass(value: unknown): number {
  if (!Array.isArray(value) || value.length > 64) return -1;
  let mass = 0;
  for (let index = 0; index < value.length; index++) {
    const line: unknown = value[index];
    if (!object(line) || !Object.hasOwn(line, 'resourceId') || !Object.hasOwn(line, 'mass')) return -1;
    for (const key in line) if (key !== 'resourceId' && key !== 'mass' && Object.hasOwn(line, key)) return -1;
    if (!resourceId(line.resourceId) || !integer(line.mass)) return -1;
    mass += line.mass;
  }
  return Number.isSafeInteger(mass) ? mass : -1;
}
const EXECUTION_SHAPE = shape(['id', 'kind', 'tick', 'actorId', 'recipeId', 'programSignature', 'inputs', 'outputs', 'residueMass', 'energy', 'work',
  'success', 'parentRecipeIds', 'catalysts', 'benefit', 'balance'], ['transferId', 'counterpartyId', 'nestedExecutionIds', 'water']);
const BALANCE_SHAPE = shape(['opening', 'closing', 'externalInputs', 'externalLoss']);
const CATALYST_SHAPE = shape(['executionId', 'itemId', 'recipeId', 'wear', 'required']);
const EXECUTION_KIND_SET: ReadonlySet<unknown> = new Set(['research', 'craft', 'use', 'recycle', 'estate', 'transfer', 'water']);
/** `ids` sin `Set` ni cierres para listas cortas (≤ 13): series canónicas del prefijo, sin repetir; con
 * `below`, todas menores que esa serie. */
function serialIds(value: unknown, max: number, prefix: keyof typeof SERIAL_PREFIXES, below = Number.POSITIVE_INFINITY): value is string[] {
  if (!Array.isArray(value) || value.length > max) return false;
  for (let index = 0; index < value.length; index++) {
    const id: unknown = value[index], serial = serialOf(id, prefix);
    if (serial === null || serial >= below) return false;
    for (let prior = 0; prior < index; prior++) if (value[prior] === id) return false;
  }
  return true;
}
/** Verifica la forma y las leyes locales de un recibo y devuelve su serie. Las mismas condiciones que la
 * versión anterior basada en `keys`/`every`/`Set` (sprint noche-arch 2026-09-23), en el mismo orden de
 * mensajes, sin alocar nada por recibo (V18 ola 2: 1,4 M recibos por carga). Sólo es más estricta en
 * objetos que JSON no puede producir: claves de balance no enumerables, huecos de arreglos dispersos,
 * `kind` no cadena convertible con `String`, y `nestedExecutionIds` heredado en vez de propio. */
function executionSerial(value: unknown): number {
  if (!shaped(value, EXECUTION_SHAPE)) fail('execution');
  const serial = serialOf(value.id, 'process');
  const balance = value.balance;
  if (serial === null || !integer(value.tick) || !identifier(value.actorId) || !EXECUTION_KIND_SET.has(value.kind)
    || !(value.recipeId === null || recipeId(value.recipeId)) || typeof value.programSignature !== 'string' || value.programSignature.length > 16000
    || !integer(value.residueMass) || !finite(value.energy) || !integer(value.work) || !finite(value.benefit) || typeof value.success !== 'boolean'
    || !serialIds(value.parentRecipeIds, 6, 'recipe') || !Array.isArray(value.catalysts) || value.catalysts.length > 12
    || !shaped(balance, BALANCE_SHAPE) || resourceMass(value.inputs) < 0 || resourceMass(value.outputs) < 0) fail('execution');
  const opening = resourceMass(balance.opening), closing = resourceMass(balance.closing);
  const externalInputs = resourceMass(balance.externalInputs), externalLoss = resourceMass(balance.externalLoss);
  if (opening < 0 || closing < 0 || externalInputs < 0 || externalLoss < 0) fail('execution');
  const hasNested = Object.hasOwn(value, 'nestedExecutionIds'), nested: unknown = hasNested ? value.nestedExecutionIds : undefined;
  if (hasNested && !serialIds(nested, 13, 'process', serial)) fail('nested execution identities');
  const catalysts = value.catalysts as unknown[];
  for (let index = 0; index < catalysts.length; index++) {
    const catalyst = catalysts[index];
    if (!shaped(catalyst, CATALYST_SHAPE)) fail('catalyst');
    const executionId = catalyst.executionId, used = serialOf(executionId, 'process');
    if (used === null || used >= serial || serialOf(catalyst.itemId, 'product') === null
      || !(catalyst.recipeId === null || recipeId(catalyst.recipeId)) || !integer(catalyst.wear) || typeof catalyst.required !== 'boolean'
      || !hasNested || !(nested as string[]).includes(executionId as string)) fail('catalyst');
    for (let prior = 0; prior < index; prior++) if ((catalysts[prior] as { executionId: unknown }).executionId === executionId) fail('catalyst');
  }
  if (value.kind === 'transfer') {
    if (serialOf(value.transferId, 'transfer') === null || !identifier(value.counterpartyId) || value.counterpartyId === value.actorId) fail('transfer identities');
  } else if (Object.hasOwn(value, 'transferId') || Object.hasOwn(value, 'counterpartyId')) fail('unexpected transfer identities');
  assertWaterExecution(value as unknown as TechnologyExecution);
  const inflow = opening + externalInputs, outflow = closing + externalLoss;
  if (!Number.isSafeInteger(inflow) || !Number.isSafeInteger(outflow) || inflow !== outflow) fail('execution mass envelope');
  return serial;
}
function assertExecution(value: unknown): asserts value is TechnologyExecution { executionSerial(value); }

type DefinitionRow = { id: string; tick: number; signature: string; body: string; digest: string };
type StatsRow = { recipeId: string; tick: number; body: string; digest: string };
type ExecutionRow = { id: string; serial: number; tick: number; body: string; digest: string };
/** Vecinas de una fila entre las visibles a una fecha: la ley de cronología de los recibos. */
const EXECUTION_BEFORE = 'SELECT id,serial,tick,body,digest FROM technology_executions'
  + ' WHERE serial<? AND tick<=? ORDER BY serial DESC LIMIT 1';
const EXECUTION_AFTER = 'SELECT id,serial,tick,body,digest FROM technology_executions WHERE serial>? AND tick<=? ORDER BY serial LIMIT 1';
function decode(row: { body: string; digest: string }): unknown {
  if (typeof row.body !== 'string' || typeof row.digest !== 'string' || checksum(row.body) !== row.digest) fail('checksum');
  try { return JSON.parse(row.body); } catch { return fail('JSON'); }
}
const monotone = (a: TechnologyStats, b: TechnologyStats) => a.uses <= b.uses && a.utility <= b.utility && a.manufactured <= b.manufactured;
export type TechnologyDefinitionSummary = TechnologyCatalogueTotals & { functions: number[] };
/** Un recibo leído y verificado junto con el digesto de su fila: el anfitrión encadena esos digestos. */
export interface TechnologyExecutionRecord { execution: TechnologyExecution; digest: string; }
export const TECHNOLOGY_EXECUTION_KINDS = ['research', 'craft', 'use', 'recycle', 'estate', 'transfer', 'water'] as const;
export type TechnologyExecutionCounts = Record<TechnologyExecution['kind'], number>;
export const emptyTechnologyExecutionCounts = (): TechnologyExecutionCounts => ({
  research: 0, craft: 0, use: 0, recycle: 0, estate: 0, transfer: 0, water: 0,
});
export const canonicalTechnologyExecutionCounts = (counts: TechnologyExecutionCounts): string =>
  JSON.stringify(Object.fromEntries(TECHNOLOGY_EXECUTION_KINDS.map(kind => [kind, counts[kind]])));
export interface TechnologyPruneSealInput {
  startsAfter: number; through: number; tick: number; digest: string; count: number; byKind: TechnologyExecutionCounts;
}
/** La cabeza durable repite este sello: cambiar cualquier campo rompe también el enlace con esa cabeza. */
export const technologyPruneSeal = (value: TechnologyPruneSealInput): string => checksum([
  'technology-pruned-v2', value.digest, value.startsAfter, value.through, value.tick, value.count,
  canonicalTechnologyExecutionCounts(value.byKind),
].join('\n'));
/** Lo que devuelve podar un prefijo: el pliegue de la cadena a través de lo borrado, su último tick y sus tipos. */
export interface TechnologyPruneResult { digest: string; count: number; tick: number; byKind: TechnologyExecutionCounts; }
/**
 * Lo que el archivo necesita saber del anfitrión (sprint noche-arch 2026-09-23). El anfitrión puede podar un
 * prefijo de recibos ya verificado (retención por ventana) y guarda esa frontera en sus propios metadatos;
 * el archivo la consulta cada vez que la necesita —nunca la recuerda— para aceptar una ejecución anidada
 * ausente sólo si su serie quedó en el prefijo podado, igual que hoy acepta las anteriores al origen. Sin
 * anfitrión (archivo suelto) no hay poda y la ley es la de siempre.
 */
export interface TechnologyArchiveHost { prunedThrough(): number | null; }
/** Cadena V2: cada fila autentica tanto el cuerpo como el tick que ordena y limita los intervalos. */
export const TECHNOLOGY_CHAIN_EMPTY = '0'.repeat(64);
export const technologyChainStep = (previous: string, digest: string, atTick: number): string =>
  checksum(`${previous}\n${digest}\n${atTick}`);
/** Sólo para verificar y actualizar una cabeza V1 no podada; nunca se escribe de nuevo. */
export const legacyTechnologyChainStep = (previous: string, digest: string): string => checksum(`${previous}\n${digest}`);
interface ArchiveStamp { dataVersion: number; totalChanges: number; schemaCookie: number; tempSchemaCookie: number; transaction: boolean; }
interface DefinitionProof {
  throughTick: number; recipes: number; maxGeneration: number; lastTick: number;
  functionalDiversity: number; functions: number[];
}
/** Definiciones ya verificadas en esta generación de pruebas, por id y por línea de recurso `recipe:<id>`. */
interface ReferenceMemo {
  generation: number;
  definitions: Map<string, { tick: number; signature: string }>;
  resources: Map<string, { tick: number; signature: string }>;
}
interface SummaryProof { fromTick: number; throughTick: number; value: TechnologyDefinitionSummary; }
const sameDatabase = (a: ArchiveStamp, b: ArchiveStamp) => a.dataVersion === b.dataVersion && a.schemaCookie === b.schemaCookie && a.tempSchemaCookie === b.tempSchemaCookie;
const sameStamp = (a: ArchiveStamp, b: ArchiveStamp) => sameDatabase(a, b) && a.totalChanges === b.totalChanges && a.transaction === b.transaction;
const copySummary = (value: TechnologyDefinitionSummary): TechnologyDefinitionSummary => ({ ...value, functions: [...value.functions] });

/** Índice compacto en memoria de definiciones ya verificadas durante un barrido completo desde el origen
 * (A2, plan de estabilidad): evita re-leer y re-decodificar (SHA-256 + JSON.parse) cada padre en
 * `definitionParents` y cada definición al recorrer `technology_stats`. Usa arreglos tipados indexados por
 * serie 1..N (16 B/receta, sin presión GC, enteros seguros exactos hasta MAX_SAFE_INTEGER) y se libera al
 * terminar el barrido. */
class VerifiedDefinitionIndex {
  count = 0;
  private ticks = new Float64Array(256);
  private generations = new Float64Array(256);
  push(serial: number, atTick: number, generation: number): void {
    if (serial !== this.count + 1) fail('definition sequence');
    if (serial >= this.ticks.length) {
      const size = this.ticks.length * 2;
      const nextTicks = new Float64Array(size); nextTicks.set(this.ticks); this.ticks = nextTicks;
      const nextGenerations = new Float64Array(size); nextGenerations.set(this.generations); this.generations = nextGenerations;
    }
    this.ticks[serial] = atTick;
    this.generations[serial] = generation;
    this.count = serial;
  }
  get(id: string): { tick: number; generation: number } | null {
    const serial = serialOf(id, 'recipe');
    if (serial === null || serial < 1 || serial > this.count) return null;
    return { tick: this.ticks[serial]!, generation: this.generations[serial]! };
  }
  tickOf(id: string): number {
    const serial = serialOf(id, 'recipe');
    return serial !== null && serial >= 1 && serial <= this.count ? this.ticks[serial]! : -1;
  }
}

/** Persistence primitives only. The host owns transactions, pending queues, checkpoints,
 * cache eviction and causal analysis. Definition IDs form a contiguous allocation prefix.
 * Execution serials may have historical gaps; their completeness must be checked against
 * the host's opening checkpoint, never inferred from definition coverage.
 * No constructor/read operation changes SQLite. */
export class TechnologyArchive {
  private verifiedStamp: ArchiveStamp | null = null;
  private definitionProof: DefinitionProof | null = null;
  private summaryProof: SummaryProof | null = null;
  private compactedStatsThrough: number | null = null;
  private hostTransaction = false;
  private readDepth = 0;
  /** A fixed set of SQL programs, never cached rows or validation results. Each get
   * still reads the current SQLite snapshot and every stamp check remains in place.
   * Streaming statements stay separate: a nested read must not reset an iterator.
   * Also holds non-streaming writes run to completion (`putExecution`'s INSERT). */
  private readonly readStatements = new Map<string, StatementSync>();
  constructor(private readonly db: DatabaseSync, private readonly host: TechnologyArchiveHost | null = null) {}

  private readStatement(sql: string): StatementSync {
    let statement = this.readStatements.get(sql);
    if (!statement) { statement = this.db.prepare(sql); this.readStatements.set(sql, statement); }
    return statement;
  }

  private transaction(): void { if (!this.db.isTransaction) throw new Error('Technology archive mutation requires a host transaction.'); }

  private stamp(): ArchiveStamp {
    return { dataVersion: (this.readStatement('PRAGMA main.data_version').get() as { data_version: number }).data_version,
      totalChanges: (this.readStatement('SELECT total_changes() AS n').get() as { n: number }).n,
      schemaCookie: (this.readStatement('PRAGMA main.schema_version').get() as { schema_version: number }).schema_version,
      tempSchemaCookie: (this.readStatement('PRAGMA temp.schema_version').get() as { schema_version: number }).schema_version,
      transaction: this.db.isTransaction };
  }
  private clearProofs(): void {
    this.verifiedStamp = null; this.definitionProof = null; this.summaryProof = null;
    this.referenceMemo = null; this.compactedStatsThrough = null; this.proofGeneration++;
  }
  invalidateVerification(): void { this.clearProofs(); this.hostTransaction = false; this.epochMemo = null; }
  /** Sello de la base para la memoria de lecturas del anfitrión (Store, sprint noche-perf 2026-09-22):
   * el mismo `stamp()` que invalida las pruebas de este archivo, serializado; `null` dentro de una
   * transacción, donde el anfitrión no debe recordar nada. Cualquier escritura propia (total_changes),
   * ajena (data_version) o de esquema cambia el sello. */
  readEpoch(): string | null {
    // Sprint noche-perf2 2026-09-22: con ~230 habitantes se piden ~900 sellos por paso y cada uno eran
    // cuatro sentencias (5,8 µs). Ahora cada llamada lee sólo `data_version` (escrituras ajenas) y
    // `total_changes()` (escrituras propias), 2,5 µs, y relee los dos esquemas cuando cualquiera de los
    // dos cambia. Lo único que cambia un esquema sin mover ninguno de los dos es DDL propio fuera de una
    // transacción: después de construir el Store sólo lo hace `installSchema`, que olvida el sello.
    if (this.db.isTransaction) return null;
    const dataVersion = (this.readStatement('PRAGMA main.data_version').get() as { data_version: number }).data_version;
    const totalChanges = (this.readStatement('SELECT total_changes() AS n').get() as { n: number }).n;
    const memo = this.epochMemo;
    if (memo && memo.dataVersion === dataVersion && memo.totalChanges === totalChanges) return memo.epoch;
    const stamp = this.stamp();
    if (stamp.transaction) return null;
    const epoch = `${stamp.dataVersion}:${stamp.totalChanges}:${stamp.schemaCookie}:${stamp.tempSchemaCookie}`;
    this.epochMemo = { dataVersion: stamp.dataVersion, totalChanges: stamp.totalChanges, epoch };
    return epoch;
  }
  private epochMemo: { dataVersion: number; totalChanges: number; epoch: string } | null = null;
  /** Tick más alto de cualquier definición o estadística archivada, o -1 si no hay ninguna. Una lectura
   * «a fecha de» un tick igual o posterior no depende de ese tick mientras el sello no cambie. */
  latestTick(): number {
    const definitions = this.readStatement('SELECT max(tick) AS t FROM technology_definitions').get() as { t: unknown };
    const stats = this.readStatement('SELECT max(tick) AS t FROM technology_stats').get() as { t: unknown };
    const ticks = [definitions.t, stats.t].map(t => t === null ? -1 : typeof t === 'number' && Number.isSafeInteger(t) ? t : Number.NaN);
    return Math.max(...ticks);
  }
  private synchronize(): ArchiveStamp {
    const current = this.stamp();
    if (!current.transaction) this.hostTransaction = false;
    if (!this.verifiedStamp || !sameStamp(this.verifiedStamp, current) || current.transaction && !this.hostTransaction) this.clearProofs();
    this.verifiedStamp = current;
    return current;
  }
  private retainProofs(): boolean { return !this.db.isTransaction || this.hostTransaction; }
  private hasTriggers(): boolean {
    return !!this.readStatement("SELECT 1 FROM main.sqlite_schema WHERE type='trigger' UNION ALL SELECT 1 FROM temp.sqlite_schema WHERE type='trigger' LIMIT 1").get();
  }
  private read<T>(callback: () => T): T {
    if (this.readDepth) return callback();
    const before = this.synchronize(); this.readDepth++;
    try {
      const result = callback();
      if (!sameStamp(before, this.stamp())) { this.clearProofs(); fail('changed during verified read'); }
      return result;
    } catch (error) { this.clearProofs(); throw error; }
    finally { this.readDepth--; if (!this.retainProofs()) this.clearProofs(); }
  }

  /** The synchronous Store owns this transaction until acknowledgeHostCommit or invalidation.
   * Generic callers retain no proofs computed inside raw transactions: rollback+begin cannot
   * be distinguished using SQLite's cumulative change counters alone.
   */
  beginHostTransaction(): void {
    this.transaction();
    if (this.hostTransaction) fail('nested host transaction');
    const current = this.stamp(), prior = this.verifiedStamp;
    if (!prior || prior.transaction || !sameDatabase(prior, current) || prior.totalChanges !== current.totalChanges) this.clearProofs();
    this.hostTransaction = true; this.verifiedStamp = current;
  }
  /** callback is trusted, synchronous SQL on non-technology tables; no transaction boundaries. */
  observeHostWrites<T>(callback: () => T): T {
    this.transaction();
    const before = this.synchronize(), triggers = this.hasTriggers();
    try {
      const result = callback();
      if (result && typeof (result as { then?: unknown }).then === 'function') fail('asynchronous host writes');
      const after = this.stamp();
      if (!after.transaction) fail('host write transaction boundary');
      if (!this.hostTransaction || triggers || this.hasTriggers() || !sameDatabase(before, after)) this.clearProofs();
      this.verifiedStamp = after;
      return result;
    } catch (error) { this.invalidateVerification(); throw error; }
  }
  /** Cache optimization only. A durable COMMIT must never be reported as failed by this hook. */
  acknowledgeHostCommit(): void {
    try {
      const current = this.stamp(), prior = this.verifiedStamp;
      if (!this.hostTransaction || current.transaction || !prior || !prior.transaction || !sameDatabase(prior, current)
        || prior.totalChanges !== current.totalChanges || this.hasTriggers()) this.clearProofs();
      else this.verifiedStamp = current;
    } catch { this.clearProofs(); }
    finally { this.hostTransaction = false; }
  }
  private ownMutation(before: ArchiveStamp, changes: number, update?: () => void): void {
    const after = this.stamp();
    if (!this.hostTransaction || !sameDatabase(before, after) || before.transaction !== after.transaction
      || after.totalChanges !== before.totalChanges + changes || this.hasTriggers()) this.clearProofs();
    else update?.();
    this.verifiedStamp = after;
  }

  installSchema(): void {
    this.transaction(); this.epochMemo = null;
    this.db.exec(`CREATE TABLE IF NOT EXISTS technology_definitions (
      id TEXT PRIMARY KEY NOT NULL, tick INTEGER NOT NULL, signature TEXT UNIQUE NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS technology_stats (
      recipeId TEXT NOT NULL, tick INTEGER NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(recipeId,tick));
      CREATE TABLE IF NOT EXISTS technology_executions (
      id TEXT PRIMARY KEY NOT NULL, serial INTEGER UNIQUE NOT NULL, tick INTEGER NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS technology_origin (
      id INTEGER PRIMARY KEY NOT NULL CHECK(id=1), body TEXT NOT NULL, digest TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS technology_definitions_tick ON technology_definitions(tick);
      CREATE INDEX IF NOT EXISTS technology_definitions_order ON technology_definitions(length(id), id);
      CREATE INDEX IF NOT EXISTS technology_stats_tick ON technology_stats(tick);
      CREATE INDEX IF NOT EXISTS technology_executions_tick ON technology_executions(tick);`);
    this.assertSchema();
  }

  hasPerformanceIndexes(): boolean {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS n FROM main.sqlite_schema WHERE type='index' AND name IN ('technology_definitions_order','technology_stats_tick')"
    ).get() as { n: number };
    return row.n === 2;
  }

  /** Crea los índices no únicos de rendimiento (A1/A2) en bases existentes schemaVersion >= 4 abiertas en modo
   * escritura. Requiere transacción anfitriona; nunca se invoca en conexiones readOnly. */
  ensurePerformanceIndexes(): void {
    this.transaction();
    if (this.hasPerformanceIndexes()) return;
    this.epochMemo = null;
    this.clearProofs();
    this.db.exec(`CREATE INDEX IF NOT EXISTS technology_definitions_order ON technology_definitions(length(id), id);
      CREATE INDEX IF NOT EXISTS technology_stats_tick ON technology_stats(tick);`);
    this.assertSchema();
  }

  private assertSchema(): void {
    for (const [table, columns, primary, unique] of [
      ['technology_definitions', ['id', 'tick', 'signature', 'body', 'digest'], ['id'], 'signature'],
      ['technology_stats', ['recipeId', 'tick', 'body', 'digest'], ['recipeId', 'tick'], null],
      ['technology_executions', ['id', 'serial', 'tick', 'body', 'digest'], ['id'], 'serial'],
      ['technology_origin', ['id', 'body', 'digest'], ['id'], null],
    ] as const) {
      const actual = this.db.prepare('SELECT name,type,"notnull",pk FROM pragma_table_info(?)').all(table) as { name: string; type: string; notnull: number; pk: number }[];
      const actualPrimary = actual.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => column.name);
      if (JSON.stringify(actual.map(column => column.name)) !== JSON.stringify(columns) || JSON.stringify(actualPrimary) !== JSON.stringify(primary)
        || actual.some(column => column.notnull !== 1 || column.type !== (['tick', 'serial'].includes(column.name) || table === 'technology_origin' && column.name === 'id' ? 'INTEGER' : 'TEXT'))) fail('schema');
      if (unique) {
        const indexes = this.db.prepare('SELECT name FROM pragma_index_list(?) WHERE "unique"=1 AND partial=0').all(table) as { name: string }[];
        if (!indexes.some(index => {
          const fields = this.db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(index.name) as { name: string }[];
          return fields.length === 1 && fields[0]!.name === unique;
        })) fail('schema uniqueness');
      }
    }
  }

  getHistoryOrigin(): TechnologyHistoryOrigin | null {
    const rows = this.readStatement('SELECT id,body,digest FROM technology_origin LIMIT 2').all() as { id: number; body: string; digest: string }[];
    if (!rows.length) return null;
    if (rows.length !== 1 || rows[0]!.id !== 1) fail('history origin identity');
    const value = decode(rows[0]!);
    if (!keys(value, ['version', 'startsAfter']) || value.version !== 1 || !integer(value.startsAfter)) fail('history origin');
    return { version: 1, startsAfter: value.startsAfter };
  }

  /** Establish the boundary before archiving anything. It cannot be advanced or
   * rewound in a live archive; a recovery copy is a separate explicit host operation. */
  initializeHistory(startsAfter: number): void {
    this.transaction(); tick(startsAfter);
    const before = this.synchronize();
    const origin = this.getHistoryOrigin();
    if (origin) {
      if (origin.startsAfter !== startsAfter) fail('immutable history origin conflict');
      return;
    }
    if (['technology_definitions', 'technology_stats', 'technology_executions'].some(table =>
      this.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())) fail('history origin must precede archived records');
    const body = JSON.stringify({ version: 1, startsAfter });
    const result = this.db.prepare('INSERT INTO technology_origin VALUES (1,?,?)').run(body, checksum(body));
    this.ownMutation(before, Number(result.changes));
  }

  private definitionRow(id: string): DefinitionRow | undefined {
    return this.readStatement('SELECT id,tick,signature,body,digest FROM technology_definitions WHERE id=?').get(id) as DefinitionRow | undefined;
  }
  private definition(row: DefinitionRow): TechnologyDefinition {
    const value = decode(row); assertDefinition(value);
    if (value.id !== row.id || value.tick !== row.tick || value.signature !== row.signature) fail('definition key or tick');
    return value;
  }
  private definitionParents(value: TechnologyDefinition, verified?: VerifiedDefinitionIndex): void {
    let generation = 0;
    const valueSerial = serialOf(value.id, 'recipe')!;
    for (const id of value.parents) {
      const known = verified?.get(id);
      if (known) {
        if (known.tick > value.tick || known.generation >= value.generation || serialOf(id, 'recipe')! >= valueSerial) fail('definition parent chronology');
        generation = Math.max(generation, known.generation);
      } else {
        const row = this.definitionRow(id); if (!row) fail('missing definition parent');
        const parent = this.definition(row);
        if (parent.tick > value.tick || parent.generation >= value.generation || serialOf(parent.id, 'recipe')! >= valueSerial) fail('definition parent chronology');
        if (verified) fail('definition parent chronology');
        generation = Math.max(generation, parent.generation);
      }
    }
    if (value.generation !== generation + 1) fail('definition generation');
  }
  private definitionFunction(value: TechnologyDefinition, functions: readonly number[]): number {
    const code = technologyFunctionCode(value.capacities), seen = !!(functions[code >>> 5]! & (1 << (code & 31)));
    // Program signatures are independently unique. The frozen 'function' tag may
    // describe an actual first occurrence, but cannot invent a second one.
    const reportsFunctionNovelty = value.novelty === 'both' || value.novelty === 'function';
    if (reportsFunctionNovelty !== !seen) fail('definition novelty');
    return code;
  }
  private scanDefinitions(asOfTick: number, inspect?: (definition: TechnologyDefinition) => void, opening?: DefinitionProof,
    verifiedDefs?: VerifiedDefinitionIndex): DefinitionProof {
    if (!opening) {
      this.assertSchema();
      // SQLite INTEGER affinity is not a STRICT-table guarantee. An undatable row cannot
      // silently disappear behind the as-of predicate, even when its JSON has a valid digest.
      if (this.db.prepare("SELECT 1 FROM technology_definitions WHERE typeof(tick)<>'integer' OR tick<0 OR tick>? LIMIT 1").get(MAX_TICK)) fail('definition tick');
    }
    // An opening proof belongs to the unchanged database stamp checked by read/synchronize.
    // Its schema, every stored tick's type, and earlier edges are already verified. Copy its
    // bounded bitmap so a rejected extension cannot certify a partially inspected suffix.
    const proof: DefinitionProof = opening ? { ...opening, throughTick: asOfTick, functions: [...opening.functions] }
      : { throughTick: asOfTick, recipes: 0, maxGeneration: 0, lastTick: -1,
        functionalDiversity: 0, functions: Array<number>(TECHNOLOGY_FUNCTION_WORDS).fill(0) };
    const verified = opening ? undefined : (verifiedDefs ?? new VerifiedDefinitionIndex());
    // Canonical IDs sort numerically without retaining any ancestor stack.
    // `+tick<=?` prevents SQLite from choosing `technology_definitions_tick` + `TEMP B-TREE`
    // when `technology_definitions_order` is present, while still falling back safely on old
    // read-only databases without that index.
    const rows = opening
      ? this.db.prepare('SELECT id,tick,signature,body,digest FROM technology_definitions WHERE tick>? AND tick<=? ORDER BY length(id),id').iterate(opening.throughTick, asOfTick)
      : this.db.prepare('SELECT id,tick,signature,body,digest FROM technology_definitions WHERE +tick<=? ORDER BY length(id),id').iterate(asOfTick);
    for (const row of rows as Iterable<DefinitionRow>) {
      const value = this.definition(row); this.definitionParents(value, verified);
      const serial = serialOf(value.id, 'recipe');
      if (serial !== proof.recipes + 1) fail('definition sequence');
      if (value.tick < proof.lastTick) fail('definition chronology');
      verified?.push(serial, value.tick, value.generation);
      proof.recipes++; proof.lastTick = value.tick; proof.maxGeneration = Math.max(proof.maxGeneration, value.generation);
      const code = this.definitionFunction(value, proof.functions), word = code >>> 5;
      proof.functions[word] = (proof.functions[word]! | (1 << (code & 31))) >>> 0;
      const inspected: unknown = inspect?.(value);
      if (inspected && typeof (inspected as { then?: unknown }).then === 'function') fail('asynchronous definition inspector');
    }
    proof.functionalDiversity = technologyFunctionCount(proof.functions);
    if (this.retainProofs() && (!this.definitionProof || this.definitionProof.throughTick <= asOfTick)) this.definitionProof = proof;
    return proof;
  }
  private verifyDefinitionsThrough(asOfTick: number): DefinitionProof {
    const proof = this.definitionProof;
    if (proof && proof.throughTick >= asOfTick) return proof;
    if (proof && !this.db.prepare('SELECT 1 FROM technology_definitions WHERE tick>? AND tick<=? LIMIT 1').get(proof.throughTick, asOfTick)) {
      proof.throughTick = asOfTick; return proof;
    }
    return this.scanDefinitions(asOfTick, undefined, proof ?? undefined);
  }
  getDefinition(id: string, asOfTick = MAX_TICK): TechnologyDefinition | null {
    if (!recipeId(id)) fail('definition lookup'); tick(asOfTick);
    return this.read(() => {
      const row = this.definitionRow(id); if (!row) return null;
      tick(row.tick); if (row.tick > asOfTick) return null;
      const value = this.definition(row); this.verifyDefinitionsThrough(value.tick);
      return value;
    });
  }
  findDefinitionBySignature(value: string, asOfTick = MAX_TICK): TechnologyDefinition | null {
    if (!text(value, 16000)) fail('signature lookup'); tick(asOfTick);
    return this.read(() => {
      const row = this.db.prepare('SELECT id,tick,signature,body,digest FROM technology_definitions WHERE signature=?').get(value) as DefinitionRow | undefined;
      if (!row) return null;
      return this.getDefinition(row.id, asOfTick);
    });
  }
  putDefinition(value: TechnologyDefinition): void {
    this.transaction(); assertDefinition(value);
    const before = this.synchronize(); this.definitionParents(value);
    const proof = this.verifyDefinitionsThrough(MAX_TICK);
    const body = JSON.stringify(value), prior = this.definitionRow(value.id);
    if (prior) { this.definition(prior); if (prior.body !== body) fail('immutable definition conflict'); return; }
    if (this.db.prepare('SELECT 1 FROM technology_definitions WHERE signature=?').get(value.signature)) fail('duplicate definition signature');
    if (serialOf(value.id, 'recipe') !== proof.recipes + 1) fail('definition sequence');
    if (value.tick < proof.lastTick) fail('definition chronology');
    const code = this.definitionFunction(value, proof.functions), word = code >>> 5;
    const result = this.db.prepare('INSERT INTO technology_definitions VALUES (?,?,?,?,?)').run(value.id, value.tick, value.signature, body, checksum(body));
    this.ownMutation(before, Number(result.changes), () => {
      proof.functions[word] = (proof.functions[word]! | (1 << (code & 31))) >>> 0;
      proof.recipes++; proof.lastTick = value.tick; proof.maxGeneration = Math.max(proof.maxGeneration, value.generation);
      proof.functionalDiversity = technologyFunctionCount(proof.functions); this.definitionProof = proof;
      // A new definition has no statistics until its matching putStats; no complete summary exists yet.
      this.summaryProof = null;
    });
  }

  private stats(row: StatsRow, verifiedPrefix: boolean | VerifiedDefinitionIndex = false): TechnologyStatsRecord {
    const value = decode(row);
    if (!keys(value, ['recipeId', 'tick', 'uses', 'utility', 'manufactured']) || value.recipeId !== row.recipeId || value.tick !== row.tick) fail('statistics key or tick');
    const stats = { uses: value.uses, utility: value.utility, manufactured: value.manufactured }; assertStats(stats); tick(row.tick);
    if (!recipeId(row.recipeId)) fail('statistics definition reference');
    if (verifiedPrefix instanceof VerifiedDefinitionIndex) {
      const defTick = verifiedPrefix.tickOf(row.recipeId);
      if (defTick < 0 || defTick > row.tick) fail('statistics definition reference');
    } else if (verifiedPrefix) {
      const definition = this.definitionRow(row.recipeId);
      if (!definition || this.definition(definition).tick > row.tick) fail('statistics definition reference');
    } else if (!this.getDefinition(row.recipeId, row.tick)) fail('statistics definition reference');
    return { recipeId: row.recipeId, tick: row.tick, ...stats };
  }
  private statsTimeline(row: StatsRow, value: TechnologyStats, asOfTick = MAX_TICK): void {
    const before = this.readStatement('SELECT recipeId,tick,body,digest FROM technology_stats WHERE recipeId=? AND tick<? ORDER BY tick DESC LIMIT 1').get(row.recipeId, row.tick) as StatsRow | undefined;
    const after = this.readStatement('SELECT recipeId,tick,body,digest FROM technology_stats WHERE recipeId=? AND tick>? AND tick<=? ORDER BY tick LIMIT 1').get(row.recipeId, row.tick, asOfTick) as StatsRow | undefined;
    if (before && !monotone(this.stats(before), value) || after && !monotone(value, this.stats(after))) fail('statistics regression');
  }
  getStats(recipe: string, asOfTick = MAX_TICK): TechnologyStatsRecord | null {
    if (!recipeId(recipe)) fail('statistics lookup'); tick(asOfTick);
    return this.read(() => {
      const row = this.readStatement('SELECT recipeId,tick,body,digest FROM technology_stats WHERE recipeId=? AND tick<=? ORDER BY tick DESC LIMIT 1').get(recipe, asOfTick) as StatsRow | undefined;
      if (!row) return null;
      const value = this.stats(row);
      this.statsTimeline(row, value, asOfTick);
      return value;
    });
  }

  /** Exact counters/bitmap, finite utility, and only the latest validated statistic per definition.
   * inspect always streams every definition, even when a prior summary is reusable.
   */
  summarizeDefinitions(asOfTick: number, inspect?: (definition: TechnologyDefinition) => void): TechnologyDefinitionSummary {
    tick(asOfTick); if (inspect !== undefined && typeof inspect !== 'function') fail('definition inspector');
    return this.read(() => {
      const cached = this.summaryProof;
      if (!inspect && cached && asOfTick >= cached.fromTick && asOfTick <= cached.throughTick) return copySummary(cached.value);
      const verified = new VerifiedDefinitionIndex();
      const proof = this.scanDefinitions(asOfTick, inspect, undefined, verified);
      const result: TechnologyDefinitionSummary = { recipes: proof.recipes, maxGeneration: proof.maxGeneration,
        manufactured: 0, uses: 0, utility: 0, functionalDiversity: proof.functionalDiversity, functions: [...proof.functions] };
      if (this.db.prepare("SELECT 1 FROM technology_stats WHERE typeof(tick)<>'integer' OR tick<0 OR tick>? LIMIT 1").get(MAX_TICK)) fail('statistics tick');
      let previous: TechnologyStatsRecord | undefined, covered = 0, earliestSupersededTick = Number.POSITIVE_INFINITY;
      const latest = (): void => {
        if (!previous) return;
        covered++; result.manufactured += previous.manufactured; result.uses += previous.uses; result.utility += previous.utility;
        if (!integer(result.manufactured) || !integer(result.uses) || !finite(result.utility)) fail('summary overflow');
      };
      for (const row of this.db.prepare('SELECT recipeId,tick,body,digest FROM technology_stats WHERE tick<=? ORDER BY recipeId,tick').iterate(asOfTick) as Iterable<StatsRow>) {
        const value = this.stats(row, verified);
        if (previous?.recipeId === value.recipeId) {
          if (!monotone(previous, value)) fail('statistics regression');
          if (value.tick < earliestSupersededTick) earliestSupersededTick = value.tick;
        } else latest();
        previous = value;
      }
      latest();
      if (covered !== proof.recipes) fail('summary statistics coverage');
      const future = this.db.prepare('SELECT MIN(tick) AS tick FROM (SELECT MIN(tick) AS tick FROM technology_definitions WHERE tick>? UNION ALL SELECT MIN(tick) AS tick FROM technology_stats WHERE tick>?)').get(asOfTick, asOfTick) as { tick: number | null };
      const throughTick = future.tick === null ? MAX_TICK : future.tick - 1;
      if (this.retainProofs()) {
        this.summaryProof = { fromTick: asOfTick, throughTick, value: result };
        const compacted = earliestSupersededTick === Number.POSITIVE_INFINITY ? asOfTick : earliestSupersededTick - 1;
        if (this.compactedStatsThrough === null || compacted > this.compactedStatsThrough) this.compactedStatsThrough = compacted;
      }
      return copySummary(result);
    });
  }
  putStats(recipe: string, atTick: number, value: TechnologyStats): void {
    this.transaction(); if (!recipeId(recipe)) fail('statistics identity'); tick(atTick); assertStats(value);
    const token = this.synchronize();
    if (!this.getDefinition(recipe, atTick)) fail('statistics definition reference');
    const body = JSON.stringify({ recipeId: recipe, tick: atTick, ...value });
    const exact = this.db.prepare('SELECT recipeId,tick,body,digest FROM technology_stats WHERE recipeId=? AND tick=?').get(recipe, atTick) as StatsRow | undefined;
    if (exact) { this.stats(exact); this.statsTimeline(exact, value); if (exact.body !== body) fail('immutable statistics conflict'); return; }
    const before = this.getStats(recipe, atTick);
    const after = this.db.prepare('SELECT recipeId,tick,body,digest FROM technology_stats WHERE recipeId=? AND tick>? ORDER BY tick LIMIT 1').get(recipe, atTick) as StatsRow | undefined;
    if (before && !monotone(before, value) || after && !monotone(value, this.stats(after))) fail('statistics regression');
    const result = this.db.prepare('INSERT INTO technology_stats VALUES (?,?,?,?)').run(recipe, atTick, body, checksum(body));
    this.ownMutation(token, Number(result.changes), () => {
      if (this.compactedStatsThrough !== null && atTick <= this.compactedStatsThrough) {
        this.compactedStatsThrough = atTick > 0 ? atTick - 1 : -1;
      }
      const cached = this.summaryProof;
      if (!cached || cached.throughTick !== MAX_TICK || atTick < cached.fromTick || after) { this.summaryProof = null; return; }
      const next = { ...cached.value, uses: cached.value.uses + (value.uses - (before?.uses ?? 0)),
        manufactured: cached.value.manufactured + (value.manufactured - (before?.manufactured ?? 0)),
        utility: cached.value.utility + (value.utility - (before?.utility ?? 0)) };
      if (!integer(next.uses) || !integer(next.manufactured) || !finite(next.utility)) { this.summaryProof = null; return; }
      this.summaryProof = { fromTick: atTick, throughTick: MAX_TICK, value: next };
    });
  }

  /**
   * Compactación incremental de `technology_stats` (A1, plan de estabilidad): dentro de una transacción
   * anfitriona borra como mucho `maxRows` filas estrictamente superadas cuya receta ya tiene otra fila más
   * reciente `<= beforeTick`. Conserva SIEMPRE la última fila `<= beforeTick` de cada receta y todas las
   * filas con `tick > beforeTick`, y valida checksum, forma, referencia a definición y monotonicidad antes
   * de borrar cualquier fila (fail-closed: nunca silencia corrupción).
   */
  compactStats(beforeTick: number, maxRows: number, maxScan = Number.POSITIVE_INFINITY): number {
    this.transaction();
    tick(beforeTick);
    if (!integer(maxRows) || maxRows < 1 || maxRows > 1_000_000) fail('compact limit');
    if (maxScan !== Number.POSITIVE_INFINITY && (!integer(maxScan) || maxScan < 1)) fail('compact scan limit');
    const before = this.synchronize();
    if (beforeTick <= 0) return 0;
    if (this.compactedStatsThrough !== null && beforeTick <= this.compactedStatsThrough) return 0;
    if (this.compactedStatsThrough === null) {
      this.assertSchema();
      if (this.db.prepare("SELECT 1 FROM technology_stats WHERE typeof(tick)<>'integer' OR tick<0 OR tick>? LIMIT 1").get(MAX_TICK))
        fail('statistics tick');
    }
    const startAfter = this.compactedStatsThrough ?? -1;
    const hasOlder = this.readStatement('SELECT 1 FROM technology_stats WHERE recipeId=? AND tick<? LIMIT 1');
    const historyForRecipe = this.readStatement('SELECT recipeId,tick,body,digest FROM technology_stats WHERE recipeId=? AND tick<=? ORDER BY tick ASC');
    const queued = new Set<string>();
    const toDelete: { recipeId: string; tick: number }[] = [];
    const defTicks = new Map<string, number>();
    let definitionsVerified = false;
    const verifyRow = (row: StatsRow): TechnologyStatsRecord => {
      if (!definitionsVerified) { this.verifyDefinitionsThrough(beforeTick); definitionsVerified = true; }
      const value = decode(row);
      if (!keys(value, ['recipeId', 'tick', 'uses', 'utility', 'manufactured']) || value.recipeId !== row.recipeId || value.tick !== row.tick)
        fail('statistics key or tick');
      const current = { uses: value.uses, utility: value.utility, manufactured: value.manufactured };
      assertStats(current); tick(row.tick);
      if (!recipeId(row.recipeId)) fail('statistics definition reference');
      let defTick = defTicks.get(row.recipeId);
      if (defTick === undefined) {
        const defRow = this.definitionRow(row.recipeId);
        if (!defRow) fail('statistics definition reference');
        defTick = this.definition(defRow).tick;
        defTicks.set(row.recipeId, defTick);
      }
      if (defTick > row.tick) fail('statistics definition reference');
      return { recipeId: row.recipeId, tick: row.tick, ...current };
    };

    let scanned = 0, lastCompletedTick = startAfter, currentTick = startAfter, stoppedEarly = false;
    const cursor = this.db.prepare('SELECT recipeId,tick FROM technology_stats WHERE tick>? AND tick<=? ORDER BY tick');
    for (const entry of cursor.iterate(startAfter, beforeTick) as Iterable<{ recipeId: string; tick: number }>) {
      if (entry.tick > currentTick) {
        if (currentTick > lastCompletedTick) lastCompletedTick = currentTick;
        if (scanned >= maxScan) { stoppedEarly = true; break; }
        currentTick = entry.tick;
      }
      scanned++;
      if (!hasOlder.get(entry.recipeId, entry.tick)) continue;
      const chain = historyForRecipe.all(entry.recipeId, entry.tick) as StatsRow[];
      const remaining: StatsRow[] = [];
      for (const row of chain) {
        if (!queued.has(`${row.recipeId}\0${row.tick}`)) remaining.push(row);
      }
      if (remaining.length < 2) continue;
      const decoded = remaining.map(verifyRow);
      for (let i = 1; i < decoded.length; i++) {
        if (!monotone(decoded[i - 1]!, decoded[i]!)) fail('statistics regression');
      }
      const limit = Math.min(remaining.length - 1, maxRows - toDelete.length);
      for (let i = 0; i < limit; i++) {
        const victim = remaining[i]!;
        queued.add(`${victim.recipeId}\0${victim.tick}`);
        toDelete.push({ recipeId: victim.recipeId, tick: victim.tick });
      }
      if (toDelete.length >= maxRows) { stoppedEarly = true; break; }
    }

    let deleted = 0;
    if (toDelete.length > 0) {
      const remove = this.db.prepare('DELETE FROM technology_stats WHERE recipeId=? AND tick=?');
      for (const victim of toDelete) deleted += Number(remove.run(victim.recipeId, victim.tick).changes);
      if (deleted !== toDelete.length) fail('compact statistics mismatch');
    }
    const nextCursor = stoppedEarly ? lastCompletedTick : beforeTick;
    this.ownMutation(before, deleted, () => {
      if (this.compactedStatsThrough === null || nextCursor > this.compactedStatsThrough) {
        this.compactedStatsThrough = nextCursor;
      }
      if (deleted > 0 && this.summaryProof && beforeTick > this.summaryProof.fromTick) {
        this.summaryProof = null;
      }
    });
    return deleted;
  }

  private executionRow(id: string): ExecutionRow | undefined {
    return this.readStatement('SELECT id,serial,tick,body,digest FROM technology_executions WHERE id=?').get(id) as ExecutionRow | undefined;
  }
  private execution(row: ExecutionRow): TechnologyExecution {
    const value = decode(row), serial = executionSerial(value), execution = value as TechnologyExecution;
    if (execution.id !== row.id || execution.tick !== row.tick || serial !== row.serial) fail('execution key, serial or tick');
    return execution;
  }
  /**
   * Referencias verificadas durante una transacción anfitriona (sprint noche-perf2 2026-09-22). Cada
   * guardado archiva cientos de ejecuciones y cada una volvía a leer, decodificar y verificar —con dos
   * sellos de cuatro sentencias— las mismas definiciones que referencia: 3–5 ms por paso amortizados
   * con ~230 habitantes. Una definición archivada es inmutable (`putDefinition` rechaza cualquier otro
   * cuerpo; sólo `truncateAfter`, de recuperación, borra filas y limpia las pruebas), así que dentro de
   * la transacción anfitriona —donde toda escritura pasa por las mutaciones propias o por
   * `observeHostWrites`, que mantienen el sello verificado— la respuesta de `getDefinition(id, t)` para
   * un id ya verificado es siempre la misma: la definición si su tick ≤ t y si no `null`. La primera
   * lectura de cada id sigue siendo la completa, con sellos y verificación. Nada de esto entra en el mundo
   * ni en disco.
   *
   * V18 ola 2: la memoria iba atada al OBJETO de prueba de definiciones, y cada extensión de esa prueba
   * (una definición referenciada por primera vez con un tick posterior) la tiraba entera aunque el sello
   * no hubiera cambiado; con 1 841 definiciones la carga la reconstruía cientos de veces. Ahora va atada a
   * la generación de pruebas: `clearProofs` —sello inesperado o ajeno, escritura no contabilizada, disparadores,
   * error, `truncateAfter`, fin o invalidación de la transacción— la incrementa y la memoria deja de valer.
   * Extender la prueba sobre el mismo sello no retira nada verificado: las filas ya leídas no cambian.
   */
  private proofGeneration = 0;
  private referenceMemo: ReferenceMemo | null = null;
  private validReferenceMemo(): ReferenceMemo | null {
    const memo = this.referenceMemo;
    return memo && this.hostTransaction && this.definitionProof && memo.generation === this.proofGeneration ? memo : null;
  }
  private referencedDefinition(id: string, asOfTick: number): { signature: string } | null {
    const known = this.validReferenceMemo()?.definitions.get(id);
    if (known) { tick(asOfTick); return known.tick <= asOfTick ? known : null; }
    const definition = this.getDefinition(id, asOfTick);
    if (definition && this.hostTransaction && this.definitionProof) {
      if (this.referenceMemo?.generation !== this.proofGeneration)
        this.referenceMemo = { generation: this.proofGeneration, definitions: new Map(), resources: new Map() };
      this.referenceMemo.definitions.set(id, { tick: definition.tick, signature: definition.signature });
    }
    return definition;
  }
  /** Hasta qué serie una ejecución anidada ausente es una referencia conservada y no un hueco: el origen
   * declarado o, si es mayor, la frontera de poda del anfitrión. `null` sin origen (todo hueco es error). */
  private unverifiableThrough(origin: TechnologyHistoryOrigin | null): number | null {
    if (!origin) return null;
    const pruned = this.host?.prunedThrough() ?? null;
    return pruned === null ? origin.startsAfter : Math.max(origin.startsAfter, pruned);
  }
  /** `origin`/`unverifiable` se leen una vez por página y no por fila (296 793 lecturas del origen, 6,1 s
   * en la carga del mundo público); `page` son los recibos ya decodificados y verificados de esa misma
   * página: una anidada comparte tick con su padre y casi siempre va justo antes, así que no se relee. */
  private executionReferences(value: TechnologyExecution, origin = this.getHistoryOrigin(),
    unverifiable = this.unverifiableThrough(origin), page?: ReadonlyMap<string, TechnologyExecution>): void {
    // Cada id distinto se comprueba una vez y en el mismo orden de primera visita que el antiguo
    // `new Set([...padres, ...catalizadores, receta, ...líneas])`, sin construir arreglos ni conjuntos por
    // recibo: `referenceScratch` es un único conjunto reutilizado (nada de lo que hay dentro sale de aquí).
    const seen = this.referenceScratch, at = value.tick; seen.clear();
    try {
      for (let index = 0; index < value.parentRecipeIds.length; index++) this.referenceOnce(value.parentRecipeIds[index]!, at);
      for (let index = 0; index < value.catalysts.length; index++) { const recipe = value.catalysts[index]!.recipeId; if (recipe) this.referenceOnce(recipe, at); }
      if (value.recipeId) this.referenceOnce(value.recipeId, at);
      this.lineReferences(value.inputs, at); this.lineReferences(value.outputs, at);
      // El orden de `Object.values(balance)`: el de inserción de sus claves propias enumerables.
      const balance = value.balance as unknown as Record<string, TechnologyExecution['inputs']>;
      for (const key in balance) if (Object.hasOwn(balance, key)) this.lineReferences(balance[key]!, at);
    } finally { seen.clear(); }
    if (value.recipeId && (value.kind === 'research' || value.kind === 'craft')
      && value.programSignature !== this.referencedDefinition(value.recipeId, at)!.signature) fail('execution program signature');
    const nested = value.nestedExecutionIds;
    if (!nested) return;
    for (let index = 0; index < nested.length; index++) {
      const id = nested[index]!;
      let child = page?.get(id);
      if (!child) {
        const row = this.executionRow(id);
        if (!row) {
          // Preserve the original reference, without manufacturing a receipt or
          // certifying its causal meaning outside the explicitly archived interval
          // (before the origin, or inside a verified prefix the host pruned).
          if (unverifiable !== null && serialOf(id, 'process')! <= unverifiable) continue;
          fail('missing nested execution');
        }
        child = this.execution(row);
      }
      if (child.tick !== value.tick || child.actorId !== value.actorId || child.kind !== 'use' && child.kind !== 'recycle') fail('nested execution reference');
    }
  }
  private readonly referenceScratch = new Set<string>();
  /** Un acierto de la memoria vigente es puro (misma respuesta cada vez), así que no necesita el conjunto de
   * vistos; sólo un fallo hace la lectura completa, una vez por id y recibo. */
  private referenceOnce(id: string, at: number): void {
    const known = this.validReferenceMemo()?.definitions.get(id);
    if (known) { if (known.tick > at) fail('execution definition reference'); return; }
    if (this.referenceScratch.has(id)) return;
    this.referenceScratch.add(id);
    if (!this.referencedDefinition(id, at)) fail('execution definition reference');
  }
  /** Las líneas `recipe:<id>` se resuelven por la cadena entera de la línea (sin `slice` por línea) contra la
   * misma memoria, que sólo se llena con definiciones ya verificadas por `referencedDefinition`. */
  private lineReferences(list: TechnologyExecution['inputs'], at: number): void {
    for (let index = 0; index < list.length; index++) {
      const resource = list[index]!.resourceId;
      if (!resource.startsWith('recipe:')) continue;
      const known = this.validReferenceMemo()?.resources.get(resource);
      if (known) { if (known.tick > at) fail('execution definition reference'); continue; }
      const id = resource.slice(7);
      this.referenceOnce(id, at);
      const memo = this.validReferenceMemo(), verified = memo?.definitions.get(id);
      if (verified) memo!.resources.set(resource, verified);
    }
  }
  private executionTimeline(row: ExecutionRow, asOfTick = MAX_TICK): void {
    const before = this.readStatement(EXECUTION_BEFORE).get(row.serial, asOfTick) as ExecutionRow | undefined;
    const after = this.readStatement(EXECUTION_AFTER).get(row.serial, asOfTick) as ExecutionRow | undefined;
    if (before && this.execution(before).tick > row.tick || after && this.execution(after).tick < row.tick) fail('execution chronology');
  }
  getExecution(id: string, asOfTick = MAX_TICK): TechnologyExecution | null {
    if (serialOf(id, 'process') === null) fail('execution lookup'); tick(asOfTick);
    const row = this.executionRow(id); if (!row) return null;
    tick(row.tick); if (row.tick > asOfTick) return null;
    const value = this.execution(row); this.executionTimeline(row, asOfTick); this.executionReferences(value);
    return value;
  }
  listExecutions(query: TechnologyExecutionQuery = {}): TechnologyExecution[] {
    return this.listExecutionRecords(query).map(record => record.execution);
  }
  /**
   * Una página verificada con el digesto de cada fila. Mismas leyes que `getExecution` fila a fila, con el
   * coste por fila recortado (sprint noche-arch 2026-09-23: 3,11 decodificaciones por fila en la carga):
   * - Cronología: `executionTimeline` compara cada fila con su vecina anterior y posterior entre las filas
   *   con `tick <= asOfTick`, en orden de serie. Dentro de la página esas vecinas SON la fila de al lado,
   *   ya decodificada y verificada; sólo la primera y la última piden su vecina de fuera (2 por página).
   * - El origen y la frontera de poda se leen una vez por página.
   * - Una anidada que está en la página se toma de la página.
   */
  listExecutionRecords({ afterSerial = 0, asOfTick = MAX_TICK, limit = 256 }: TechnologyExecutionQuery = {}): TechnologyExecutionRecord[] {
    tick(afterSerial); tick(asOfTick); if (!integer(limit) || limit < 1 || limit > 10000) fail('execution page limit');
    // V18 ola 2: toda la página es UNA lectura verificada. `read` sincroniza el sello al empezar (cualquier
    // escritura propia, ajena o de esquema desde la llamada anterior borra las pruebas y la memoria de
    // referencias, también dentro de la transacción anfitriona) y exige el mismo sello al terminar; las
    // lecturas de definiciones anidadas ya no sellan dos veces cada una.
    return this.read(() => {
      const origin = this.getHistoryOrigin(), unverifiable = this.unverifiableThrough(origin);
      // `.all()` materializa la página antes de cualquier otra lectura: la sentencia preparada se puede reutilizar.
      const rows = this.readStatement('SELECT id,serial,tick,body,digest FROM technology_executions WHERE serial>? AND tick<=? ORDER BY serial LIMIT ?')
        .all(afterSerial, asOfTick, limit) as ExecutionRow[];
      const values: TechnologyExecution[] = new Array(rows.length), page = new Map<string, TechnologyExecution>();
      for (let index = 0; index < rows.length; index++) {
        const value = this.execution(rows[index]!);
        values[index] = value; page.set(value.id, value);
      }
      for (let index = 1; index < values.length; index++) if (values[index - 1]!.tick > values[index]!.tick) fail('execution chronology');
      if (rows.length) {
        const first = rows[0]!, last = rows.at(-1)!;
        const before = this.readStatement(EXECUTION_BEFORE).get(first.serial, asOfTick) as ExecutionRow | undefined;
        const after = this.readStatement(EXECUTION_AFTER).get(last.serial, asOfTick) as ExecutionRow | undefined;
        if (before && this.execution(before).tick > first.tick || after && this.execution(after).tick < last.tick)
          fail('execution chronology');
      }
      const records: TechnologyExecutionRecord[] = new Array(values.length);
      for (let index = 0; index < values.length; index++) {
        const execution = values[index]!;
        this.executionReferences(execution, origin, unverifiable, page);
        records[index] = { execution, digest: rows[index]!.digest };
      }
      return records;
    });
  }
  /** Devuelve el digesto de la fila (nueva o idéntica ya archivada): el anfitrión lo encadena. */
  putExecution(value: TechnologyExecution): string {
    this.transaction(); assertExecution(value); this.executionReferences(value);
    const token = this.synchronize();
    const body = JSON.stringify(value), digest = checksum(body), prior = this.executionRow(value.id);
    if (prior) { this.getExecution(value.id); if (prior.body !== body) fail('immutable execution conflict'); return digest; }
    const serial = serialOf(value.id, 'process')!;
    this.executionTimeline({ id: value.id, serial, tick: value.tick, body, digest });
    const result = this.readStatement('INSERT INTO technology_executions VALUES (?,?,?,?,?)').run(value.id, serial, value.tick, body, digest);
    this.ownMutation(token, Number(result.changes));
    return digest;
  }
  /**
   * Retención (sprint noche-arch 2026-09-23): borra los recibos de serie `(afterSerial, throughSerial]`,
   * que el anfitrión ya verificó y que nada del mundo lee, y devuelve el pliegue de la cadena de digestos a
   * través de ellos desde `digest`. Antes de borrar comprueba que el tramo está completo (series
   * consecutivas), en orden cronológico y que cada cuerpo sigue siendo el de su digesto: lo que se descarta
   * queda certificado por el pliegue, y un tramo exportado antes de podar se verificaría contra él. El
   * anfitrión elige el tramo (ventana, anillos de los respaldos, tope por guardado) y guarda la frontera.
   */
  pruneExecutions(afterSerial: number, throughSerial: number, digest: string): TechnologyPruneResult {
    this.transaction(); tick(afterSerial); tick(throughSerial);
    if (throughSerial <= afterSerial || !/^[0-9a-f]{64}$/.test(digest)) fail('prune interval');
    const token = this.synchronize();
    let expected = afterSerial, lastTick = -1;
    const byKind = emptyTechnologyExecutionCounts();
    const rows = this.db.prepare('SELECT id,serial,tick,body,digest FROM technology_executions WHERE serial>? AND serial<=? ORDER BY serial');
    for (const row of rows.iterate(afterSerial, throughSerial) as Iterable<ExecutionRow>) {
      if (row.serial !== ++expected) fail('prune interval has a gap');
      const execution = this.execution(row);
      if (execution.tick < lastTick) fail('execution chronology');
      lastTick = execution.tick; byKind[execution.kind]++;
      digest = technologyChainStep(digest, row.digest, execution.tick);
    }
    if (expected !== throughSerial) fail('prune interval has a gap');
    const result = this.db.prepare('DELETE FROM technology_executions WHERE serial>? AND serial<=?').run(afterSerial, throughSerial);
    const count = Number(result.changes);
    if (count !== throughSerial - afterSerial) fail('prune interval');
    this.ownMutation(token, count);
    return { digest, count, tick: lastTick, byKind };
  }

  /** Recovery of a caller-owned copy. Validate retained references before deleting any future row. */
  truncateAfter(atTick: number): void {
    this.transaction(); tick(atTick);
    this.synchronize();
    const origin = this.getHistoryOrigin(), unverifiable = this.unverifiableThrough(origin);
    const verified = new VerifiedDefinitionIndex();
    this.scanDefinitions(atTick, undefined, undefined, verified);
    let previousStats: TechnologyStatsRecord | undefined, previousExecutionTick = -1;
    for (const row of this.db.prepare('SELECT recipeId,tick,body,digest FROM technology_stats WHERE tick<=? ORDER BY recipeId,tick').iterate(atTick) as Iterable<StatsRow>) {
      const value = this.stats(row, verified);
      if (previousStats?.recipeId === value.recipeId && !monotone(previousStats, value)) fail('retained statistics regression');
      previousStats = value;
    }
    for (const row of this.db.prepare('SELECT id,serial,tick,body,digest FROM technology_executions WHERE tick<=? ORDER BY serial').iterate(atTick) as Iterable<ExecutionRow>) {
      const value = this.execution(row); this.executionReferences(value, origin, unverifiable);
      if (value.tick < previousExecutionTick) fail('retained execution chronology');
      previousExecutionTick = value.tick;
    }
    this.db.prepare('DELETE FROM technology_executions WHERE tick>?').run(atTick);
    this.db.prepare('DELETE FROM technology_stats WHERE tick>?').run(atTick);
    this.db.prepare('DELETE FROM technology_definitions WHERE tick>?').run(atTick);
    this.clearProofs();
  }
}
