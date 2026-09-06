import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
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
const checksum = (body: string) => createHash('sha256').update(body).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value);
const text = (value: unknown, max = 100): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const identifier = (value: unknown): value is string => text(value) && !/\s/.test(value);
const keys = (value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> => object(value)
  && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const serialOf = (value: unknown, prefix: string): number | null => {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}-[1-9]\\d*$`).test(value)) return null;
  const serial = Number(value.slice(prefix.length + 1)); return integer(serial) ? serial : null;
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
const resourceId = (value: unknown): boolean => typeof value === 'string'
  && (/^(raw|residue|spent):(wood|stone|water)$/.test(value) || value === 'unclassified' || value.startsWith('recipe:') && recipeId(value.slice(7)));
function resources(value: unknown): boolean {
  // Repeated resource lines are legal (two substrates or substrate plus fuel).
  return Array.isArray(value) && value.length <= 64 && value.every(line => keys(line, ['resourceId', 'mass']) && resourceId(line.resourceId) && integer(line.mass))
    && Number.isSafeInteger(value.reduce((sum, line) => sum + line.mass, 0));
}
function assertExecution(value: unknown): asserts value is TechnologyExecution {
  if (!keys(value, ['id', 'kind', 'tick', 'actorId', 'recipeId', 'programSignature', 'inputs', 'outputs', 'residueMass', 'energy', 'work', 'success',
    'parentRecipeIds', 'catalysts', 'benefit', 'balance'], ['transferId', 'counterpartyId', 'nestedExecutionIds', 'water'])
    || serialOf(value.id, 'process') === null || !integer(value.tick) || !identifier(value.actorId)
    || !['research', 'craft', 'use', 'recycle', 'estate', 'transfer', 'water'].includes(String(value.kind))
    || !(value.recipeId === null || recipeId(value.recipeId)) || typeof value.programSignature !== 'string' || value.programSignature.length > 16000
    || !integer(value.residueMass) || !finite(value.energy) || !integer(value.work) || !finite(value.benefit) || typeof value.success !== 'boolean'
    || !ids(value.parentRecipeIds, 6) || !Array.isArray(value.catalysts) || value.catalysts.length > 12
    || !keys(value.balance, ['opening', 'closing', 'externalInputs', 'externalLoss'])
    || ![value.inputs, value.outputs, ...Object.values(value.balance)].every(resources)) fail('execution');
  const serial = serialOf(value.id, 'process')!;
  if (Object.hasOwn(value, 'nestedExecutionIds') && (!ids(value.nestedExecutionIds, 13, (id: unknown): id is string => serialOf(id, 'process') !== null)
    || (value.nestedExecutionIds as string[]).some(id => serialOf(id, 'process')! >= serial))) fail('nested execution identities');
  const catalystIds = new Set<string>();
  for (const catalyst of value.catalysts) {
    if (!keys(catalyst, ['executionId', 'itemId', 'recipeId', 'wear', 'required']) || serialOf(catalyst.executionId, 'process') === null
      || serialOf(catalyst.executionId, 'process')! >= serial || serialOf(catalyst.itemId, 'product') === null
      || !(catalyst.recipeId === null || recipeId(catalyst.recipeId)) || !integer(catalyst.wear) || typeof catalyst.required !== 'boolean'
      || catalystIds.has(catalyst.executionId as string) || !(value.nestedExecutionIds as string[] | undefined)?.includes(catalyst.executionId as string)) fail('catalyst');
    catalystIds.add(catalyst.executionId as string);
  }
  if (value.kind === 'transfer') {
    if (serialOf(value.transferId, 'transfer') === null || !identifier(value.counterpartyId) || value.counterpartyId === value.actorId) fail('transfer identities');
  } else if (Object.hasOwn(value, 'transferId') || Object.hasOwn(value, 'counterpartyId')) fail('unexpected transfer identities');
  const execution = value as unknown as TechnologyExecution;
  assertWaterExecution(execution);
  const total = (lines: TechnologyExecution['inputs']) => lines.reduce((sum, line) => sum + line.mass, 0);
  const opening = total(execution.balance.opening) + total(execution.balance.externalInputs), closing = total(execution.balance.closing) + total(execution.balance.externalLoss);
  if (!Number.isSafeInteger(opening) || !Number.isSafeInteger(closing) || opening !== closing) fail('execution mass envelope');
}

type DefinitionRow = { id: string; tick: number; signature: string; body: string; digest: string };
type StatsRow = { recipeId: string; tick: number; body: string; digest: string };
type ExecutionRow = { id: string; serial: number; tick: number; body: string; digest: string };
function decode(row: { body: string; digest: string }): unknown {
  if (typeof row.body !== 'string' || typeof row.digest !== 'string' || checksum(row.body) !== row.digest) fail('checksum');
  try { return JSON.parse(row.body); } catch { return fail('JSON'); }
}
const monotone = (a: TechnologyStats, b: TechnologyStats) => a.uses <= b.uses && a.utility <= b.utility && a.manufactured <= b.manufactured;
export type TechnologyDefinitionSummary = TechnologyCatalogueTotals & { functions: number[] };
interface ArchiveStamp { dataVersion: number; totalChanges: number; schemaCookie: number; tempSchemaCookie: number; transaction: boolean; }
interface DefinitionProof {
  throughTick: number; recipes: number; maxGeneration: number; lastTick: number;
  functionalDiversity: number; functions: number[];
}
interface SummaryProof { fromTick: number; throughTick: number; value: TechnologyDefinitionSummary; }
const sameDatabase = (a: ArchiveStamp, b: ArchiveStamp) => a.dataVersion === b.dataVersion && a.schemaCookie === b.schemaCookie && a.tempSchemaCookie === b.tempSchemaCookie;
const sameStamp = (a: ArchiveStamp, b: ArchiveStamp) => sameDatabase(a, b) && a.totalChanges === b.totalChanges && a.transaction === b.transaction;
const copySummary = (value: TechnologyDefinitionSummary): TechnologyDefinitionSummary => ({ ...value, functions: [...value.functions] });

/** Persistence primitives only. The host owns transactions, pending queues, checkpoints,
 * cache eviction and causal analysis. Definition IDs form a contiguous allocation prefix.
 * Execution serials may have historical gaps; their completeness must be checked against
 * the host's opening checkpoint, never inferred from definition coverage.
 * No constructor/read operation changes SQLite. */
export class TechnologyArchive {
  private verifiedStamp: ArchiveStamp | null = null;
  private definitionProof: DefinitionProof | null = null;
  private summaryProof: SummaryProof | null = null;
  private hostTransaction = false;
  private readDepth = 0;
  constructor(private readonly db: DatabaseSync) {}

  private transaction(): void { if (!this.db.isTransaction) throw new Error('Technology archive mutation requires a host transaction.'); }

  private stamp(): ArchiveStamp {
    return { dataVersion: (this.db.prepare('PRAGMA main.data_version').get() as { data_version: number }).data_version,
      totalChanges: (this.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n,
      schemaCookie: (this.db.prepare('PRAGMA main.schema_version').get() as { schema_version: number }).schema_version,
      tempSchemaCookie: (this.db.prepare('PRAGMA temp.schema_version').get() as { schema_version: number }).schema_version,
      transaction: this.db.isTransaction };
  }
  private clearProofs(): void { this.verifiedStamp = null; this.definitionProof = null; this.summaryProof = null; }
  invalidateVerification(): void { this.clearProofs(); this.hostTransaction = false; }
  private synchronize(): ArchiveStamp {
    const current = this.stamp();
    if (!current.transaction) this.hostTransaction = false;
    if (!this.verifiedStamp || !sameStamp(this.verifiedStamp, current) || current.transaction && !this.hostTransaction) this.clearProofs();
    this.verifiedStamp = current;
    return current;
  }
  private retainProofs(): boolean { return !this.db.isTransaction || this.hostTransaction; }
  private hasTriggers(): boolean {
    return !!this.db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='trigger' UNION ALL SELECT 1 FROM temp.sqlite_schema WHERE type='trigger' LIMIT 1").get();
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
    this.transaction();
    this.db.exec(`CREATE TABLE IF NOT EXISTS technology_definitions (
      id TEXT PRIMARY KEY NOT NULL, tick INTEGER NOT NULL, signature TEXT UNIQUE NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS technology_stats (
      recipeId TEXT NOT NULL, tick INTEGER NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(recipeId,tick));
      CREATE TABLE IF NOT EXISTS technology_executions (
      id TEXT PRIMARY KEY NOT NULL, serial INTEGER UNIQUE NOT NULL, tick INTEGER NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS technology_origin (
      id INTEGER PRIMARY KEY NOT NULL CHECK(id=1), body TEXT NOT NULL, digest TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS technology_definitions_tick ON technology_definitions(tick);
      CREATE INDEX IF NOT EXISTS technology_executions_tick ON technology_executions(tick);`);
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
    const rows = this.db.prepare('SELECT id,body,digest FROM technology_origin LIMIT 2').all() as { id: number; body: string; digest: string }[];
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
    return this.db.prepare('SELECT id,tick,signature,body,digest FROM technology_definitions WHERE id=?').get(id) as DefinitionRow | undefined;
  }
  private definition(row: DefinitionRow): TechnologyDefinition {
    const value = decode(row); assertDefinition(value);
    if (value.id !== row.id || value.tick !== row.tick || value.signature !== row.signature) fail('definition key or tick');
    return value;
  }
  private definitionParents(value: TechnologyDefinition): void {
    let generation = 0;
    for (const id of value.parents) {
      const row = this.definitionRow(id); if (!row) fail('missing definition parent');
      const parent = this.definition(row);
      if (parent.tick > value.tick || parent.generation >= value.generation || serialOf(parent.id, 'recipe')! >= serialOf(value.id, 'recipe')!) fail('definition parent chronology');
      generation = Math.max(generation, parent.generation);
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
  private scanDefinitions(asOfTick: number, inspect?: (definition: TechnologyDefinition) => void): DefinitionProof {
    this.assertSchema();
    // SQLite INTEGER affinity is not a STRICT-table guarantee. An undatable row cannot
    // silently disappear behind the as-of predicate, even when its JSON has a valid digest.
    if (this.db.prepare("SELECT 1 FROM technology_definitions WHERE typeof(tick)<>'integer' OR tick<0 OR tick>? LIMIT 1").get(MAX_TICK)) fail('definition tick');
    const proof: DefinitionProof = { throughTick: asOfTick, recipes: 0, maxGeneration: 0, lastTick: -1,
      functionalDiversity: 0, functions: Array<number>(TECHNOLOGY_FUNCTION_WORDS).fill(0) };
    // Canonical IDs sort numerically without retaining any identity set or ancestor stack.
    // Each parent precedes its child, so checking every local edge proves the entire prefix DAG.
    for (const row of this.db.prepare('SELECT id,tick,signature,body,digest FROM technology_definitions WHERE tick<=? ORDER BY length(id),id').iterate(asOfTick) as Iterable<DefinitionRow>) {
      const value = this.definition(row); this.definitionParents(value);
      if (serialOf(value.id, 'recipe') !== proof.recipes + 1) fail('definition sequence');
      if (value.tick < proof.lastTick) fail('definition chronology');
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
    return this.scanDefinitions(asOfTick);
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

  private stats(row: StatsRow, verifiedPrefix = false): TechnologyStatsRecord {
    const value = decode(row);
    if (!keys(value, ['recipeId', 'tick', 'uses', 'utility', 'manufactured']) || value.recipeId !== row.recipeId || value.tick !== row.tick) fail('statistics key or tick');
    const stats = { uses: value.uses, utility: value.utility, manufactured: value.manufactured }; assertStats(stats); tick(row.tick);
    if (!recipeId(row.recipeId)) fail('statistics definition reference');
    if (verifiedPrefix) {
      const definition = this.definitionRow(row.recipeId);
      if (!definition || this.definition(definition).tick > row.tick) fail('statistics definition reference');
    } else if (!this.getDefinition(row.recipeId, row.tick)) fail('statistics definition reference');
    return { recipeId: row.recipeId, tick: row.tick, ...stats };
  }
  private statsTimeline(row: StatsRow, value: TechnologyStats, asOfTick = MAX_TICK): void {
    const before = this.db.prepare('SELECT recipeId,tick,body,digest FROM technology_stats WHERE recipeId=? AND tick<? ORDER BY tick DESC LIMIT 1').get(row.recipeId, row.tick) as StatsRow | undefined;
    const after = this.db.prepare('SELECT recipeId,tick,body,digest FROM technology_stats WHERE recipeId=? AND tick>? AND tick<=? ORDER BY tick LIMIT 1').get(row.recipeId, row.tick, asOfTick) as StatsRow | undefined;
    if (before && !monotone(this.stats(before), value) || after && !monotone(value, this.stats(after))) fail('statistics regression');
  }
  getStats(recipe: string, asOfTick = MAX_TICK): TechnologyStatsRecord | null {
    if (!recipeId(recipe)) fail('statistics lookup'); tick(asOfTick);
    return this.read(() => {
      const row = this.db.prepare('SELECT recipeId,tick,body,digest FROM technology_stats WHERE recipeId=? AND tick<=? ORDER BY tick DESC LIMIT 1').get(recipe, asOfTick) as StatsRow | undefined;
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
      const proof = this.scanDefinitions(asOfTick, inspect);
      const result: TechnologyDefinitionSummary = { recipes: proof.recipes, maxGeneration: proof.maxGeneration,
        manufactured: 0, uses: 0, utility: 0, functionalDiversity: proof.functionalDiversity, functions: [...proof.functions] };
      if (this.db.prepare("SELECT 1 FROM technology_stats WHERE typeof(tick)<>'integer' OR tick<0 OR tick>? LIMIT 1").get(MAX_TICK)) fail('statistics tick');
      let previous: TechnologyStatsRecord | undefined, covered = 0;
      const latest = (): void => {
        if (!previous) return;
        covered++; result.manufactured += previous.manufactured; result.uses += previous.uses; result.utility += previous.utility;
        if (!integer(result.manufactured) || !integer(result.uses) || !finite(result.utility)) fail('summary overflow');
      };
      for (const row of this.db.prepare('SELECT recipeId,tick,body,digest FROM technology_stats WHERE tick<=? ORDER BY recipeId,tick').iterate(asOfTick) as Iterable<StatsRow>) {
        const value = this.stats(row, true);
        if (previous?.recipeId === value.recipeId) { if (!monotone(previous, value)) fail('statistics regression'); }
        else latest();
        previous = value;
      }
      latest();
      if (covered !== proof.recipes) fail('summary statistics coverage');
      const future = this.db.prepare('SELECT MIN(tick) AS tick FROM (SELECT MIN(tick) AS tick FROM technology_definitions WHERE tick>? UNION ALL SELECT MIN(tick) AS tick FROM technology_stats WHERE tick>?)').get(asOfTick, asOfTick) as { tick: number | null };
      const throughTick = future.tick === null ? MAX_TICK : future.tick - 1;
      if (this.retainProofs()) this.summaryProof = { fromTick: asOfTick, throughTick, value: result };
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
      const cached = this.summaryProof;
      if (!cached || cached.throughTick !== MAX_TICK || atTick < cached.fromTick || after) { this.summaryProof = null; return; }
      const next = { ...cached.value, uses: cached.value.uses + (value.uses - (before?.uses ?? 0)),
        manufactured: cached.value.manufactured + (value.manufactured - (before?.manufactured ?? 0)),
        utility: cached.value.utility + (value.utility - (before?.utility ?? 0)) };
      if (!integer(next.uses) || !integer(next.manufactured) || !finite(next.utility)) { this.summaryProof = null; return; }
      this.summaryProof = { fromTick: atTick, throughTick: MAX_TICK, value: next };
    });
  }

  private executionRow(id: string): ExecutionRow | undefined {
    return this.db.prepare('SELECT id,serial,tick,body,digest FROM technology_executions WHERE id=?').get(id) as ExecutionRow | undefined;
  }
  private execution(row: ExecutionRow): TechnologyExecution {
    const value = decode(row); assertExecution(value);
    if (value.id !== row.id || value.tick !== row.tick || serialOf(value.id, 'process') !== row.serial) fail('execution key, serial or tick');
    return value;
  }
  private executionReferences(value: TechnologyExecution): void {
    const origin = this.getHistoryOrigin();
    const references = new Set([...value.parentRecipeIds, ...value.catalysts.flatMap(c => c.recipeId ? [c.recipeId] : []), ...(value.recipeId ? [value.recipeId] : [])]);
    for (const list of [value.inputs, value.outputs, ...Object.values(value.balance)]) for (const line of list) if (line.resourceId.startsWith('recipe:')) references.add(line.resourceId.slice(7));
    for (const id of references) if (!this.getDefinition(id, value.tick)) fail('execution definition reference');
    if (value.recipeId && ['research', 'craft'].includes(value.kind) && value.programSignature !== this.getDefinition(value.recipeId, value.tick)!.signature) fail('execution program signature');
    for (const id of value.nestedExecutionIds ?? []) {
      const row = this.executionRow(id);
      if (!row) {
        // Preserve the original reference, without manufacturing a receipt or
        // certifying its causal meaning outside the explicitly archived interval.
        if (origin && serialOf(id, 'process')! <= origin.startsAfter) continue;
        fail('missing nested execution');
      }
      const child = this.execution(row);
      if (child.tick !== value.tick || child.actorId !== value.actorId || !['use', 'recycle'].includes(child.kind)) fail('nested execution reference');
    }
  }
  private executionTimeline(row: ExecutionRow, asOfTick = MAX_TICK): void {
    const before = this.db.prepare('SELECT id,serial,tick,body,digest FROM technology_executions WHERE serial<? AND tick<=? ORDER BY serial DESC LIMIT 1').get(row.serial, asOfTick) as ExecutionRow | undefined;
    const after = this.db.prepare('SELECT id,serial,tick,body,digest FROM technology_executions WHERE serial>? AND tick<=? ORDER BY serial LIMIT 1').get(row.serial, asOfTick) as ExecutionRow | undefined;
    if (before && this.execution(before).tick > row.tick || after && this.execution(after).tick < row.tick) fail('execution chronology');
  }
  getExecution(id: string, asOfTick = MAX_TICK): TechnologyExecution | null {
    if (serialOf(id, 'process') === null) fail('execution lookup'); tick(asOfTick);
    const row = this.executionRow(id); if (!row) return null;
    tick(row.tick); if (row.tick > asOfTick) return null;
    const value = this.execution(row); this.executionTimeline(row, asOfTick); this.executionReferences(value);
    return value;
  }
  listExecutions({ afterSerial = 0, asOfTick = MAX_TICK, limit = 256 }: TechnologyExecutionQuery = {}): TechnologyExecution[] {
    tick(afterSerial); tick(asOfTick); if (!integer(limit) || limit < 1 || limit > 10000) fail('execution page limit');
    this.getHistoryOrigin();
    const rows = this.db.prepare('SELECT id,serial,tick,body,digest FROM technology_executions WHERE serial>? AND tick<=? ORDER BY serial LIMIT ?').all(afterSerial, asOfTick, limit) as ExecutionRow[];
    return rows.map(row => { const value = this.execution(row); this.executionTimeline(row, asOfTick); this.executionReferences(value); return value; });
  }
  putExecution(value: TechnologyExecution): void {
    this.transaction(); assertExecution(value); this.executionReferences(value);
    const token = this.synchronize();
    const body = JSON.stringify(value), prior = this.executionRow(value.id);
    if (prior) { this.getExecution(value.id); if (prior.body !== body) fail('immutable execution conflict'); return; }
    const serial = serialOf(value.id, 'process')!;
    this.executionTimeline({ id: value.id, serial, tick: value.tick, body, digest: checksum(body) });
    const result = this.db.prepare('INSERT INTO technology_executions VALUES (?,?,?,?,?)').run(value.id, serial, value.tick, body, checksum(body));
    this.ownMutation(token, Number(result.changes));
  }

  /** Recovery of a caller-owned copy. Validate retained references before deleting any future row. */
  truncateAfter(atTick: number): void {
    this.transaction(); tick(atTick);
    this.synchronize();
    this.getHistoryOrigin();
    this.scanDefinitions(atTick);
    let previousStats: TechnologyStatsRecord | undefined, previousExecutionTick = -1;
    for (const row of this.db.prepare('SELECT recipeId,tick,body,digest FROM technology_stats WHERE tick<=? ORDER BY recipeId,tick').iterate(atTick) as Iterable<StatsRow>) {
      const value = this.stats(row);
      if (previousStats?.recipeId === value.recipeId && !monotone(previousStats, value)) fail('retained statistics regression');
      previousStats = value;
    }
    for (const row of this.db.prepare('SELECT id,serial,tick,body,digest FROM technology_executions WHERE tick<=? ORDER BY serial').iterate(atTick) as Iterable<ExecutionRow>) {
      const value = this.execution(row); this.executionReferences(value);
      if (value.tick < previousExecutionTick) fail('retained execution chronology');
      previousExecutionTick = value.tick;
    }
    this.db.prepare('DELETE FROM technology_executions WHERE tick>?').run(atTick);
    this.db.prepare('DELETE FROM technology_stats WHERE tick>?').run(atTick);
    this.db.prepare('DELETE FROM technology_definitions WHERE tick>?').run(atTick);
    this.clearProofs();
  }
}
