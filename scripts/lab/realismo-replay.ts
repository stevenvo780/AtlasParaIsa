import { createHash } from 'node:crypto';
import { serialize } from 'node:v8';
/** Preregistered technical parity identities; never held-out scientific seeds. */
export const TECHNICAL_PARITY_SEEDS = Object.freeze([51926, 42, 606, 1001, 20260924, 20261004] as const);
export const TECHNICAL_PARITY_TICKS = 1200;
/** Exact decision-clock trace for a declared technical scene. Observation cost uses a separate clock. */
export type ClockDomain = 'app-monotonic' | 'scheduler' | 'projection';
export type ClockEntry = Readonly<{
  siteId: string; callOrdinal: number; attemptId: string | null; tick: number;
  clockDomain: ClockDomain; value: number;
}>;
export class ClockTraceMismatch extends Error {
  constructor(readonly code: 'EXTRA_READ' | 'MISSING_READ' | 'WRONG_SITE' | 'WRONG_CONTEXT' | 'INVALID_VALUE', message: string) { super(message); }
}
export class ExactClockTrace {
  readonly entries: ClockEntry[];
  private cursor = 0;
  private ordinal = new Map<string, number>();
  constructor(readonly mode: 'record' | 'replay', entries: readonly ClockEntry[] = []) {
    this.entries = mode === 'replay' ? entries.map(x => Object.freeze({ ...x })) : [];
  }
  read(siteId: string, attemptId: string | null, tick: number, clockDomain: ClockDomain, readReal: () => number): number {
    const key = `${siteId}\0${attemptId ?? ''}\0${tick}\0${clockDomain}`;
    const callOrdinal = (this.ordinal.get(key) ?? 0) + 1;
    this.ordinal.set(key, callOrdinal);
    if (this.mode === 'record') {
      const value = readReal();
      if (!Number.isFinite(value)) throw new ClockTraceMismatch('INVALID_VALUE', `Nonfinite clock at ${siteId}`);
      this.entries.push(Object.freeze({ siteId, callOrdinal, attemptId, tick, clockDomain, value }));
      return value;
    }
    const expected = this.entries[this.cursor];
    if (!expected) throw new ClockTraceMismatch('EXTRA_READ', `Extra clock read ${siteId} ${callOrdinal}`);
    if (expected.siteId !== siteId || expected.callOrdinal !== callOrdinal) throw new ClockTraceMismatch('WRONG_SITE', `Expected ${expected.siteId}#${expected.callOrdinal}, got ${siteId}#${callOrdinal}`);
    if (expected.attemptId !== attemptId || expected.tick !== tick || expected.clockDomain !== clockDomain)
      throw new ClockTraceMismatch('WRONG_CONTEXT', `Clock context mismatch at ${siteId}`);
    if (!Number.isFinite(expected.value)) throw new ClockTraceMismatch('INVALID_VALUE', `Invalid recorded clock at ${siteId}`);
    this.cursor++;
    return expected.value;
  }
  finish(): void {
    if (this.mode === 'replay' && this.cursor !== this.entries.length)
      throw new ClockTraceMismatch('MISSING_READ', `${this.entries.length - this.cursor} clock entries left unread`);
  }
  get consumed(): number { return this.cursor; }
}

/** Full local comparison; report only the first path and opaque hashes, never a personal value. */
export function firstPhysicalDifference(left: unknown, right: unknown): null | { path: string; leftHash: string; rightHash: string } {
  const hash = (value: unknown): string => {
    try { return createHash('sha256').update(serialize(value)).digest('hex'); }
    catch { return createHash('sha256').update(safeCanonical(value)).digest('hex'); }
  };
  const seen = new WeakMap<object, WeakSet<object>>();
  const walk = (a: unknown, b: unknown, path: string): string | null => {
    if (Object.is(a, b)) return null;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return path;
    const ao = a as object, bo = b as object;
    const prior = seen.get(ao);
    if (prior?.has(bo)) return null;
    if (prior) prior.add(bo); else seen.set(ao, new WeakSet([bo]));
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return path;
    if (a instanceof Date && b instanceof Date) return Object.is(a.getTime(), b.getTime()) ? null : path;
    if (a instanceof Map && b instanceof Map) {
      if (a.size !== b.size) return `${path}.size`;
      const ae = [...a], be = [...b];
      for (let i = 0; i < ae.length; i++) {
        const key = walk(ae[i]![0], be[i]![0], `${path}.map[${i}].key`); if (key) return key;
        const value = walk(ae[i]![1], be[i]![1], `${path}.map[${i}].value`); if (value) return value;
      }
      return null;
    }
    if (a instanceof Set && b instanceof Set) {
      if (a.size !== b.size) return `${path}.size`;
      const ae = [...a], be = [...b];
      for (let i = 0; i < ae.length; i++) { const value = walk(ae[i], be[i], `${path}.set[${i}]`); if (value) return value; }
      return null;
    }
    if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
      const av = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), bv = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
      if (av.length !== bv.length) return `${path}.byteLength`;
      for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return `${path}.byte[${i}]`;
      return null;
    }
    if (a instanceof ArrayBuffer && b instanceof ArrayBuffer) {
      const av = new Uint8Array(a), bv = new Uint8Array(b);
      if (av.length !== bv.length) return `${path}.byteLength`;
      for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return `${path}.byte[${i}]`;
      return null;
    }
    if (Array.isArray(a) !== Array.isArray(b)) return path;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return `${path}.length`;
      for (let i = 0; i < a.length; i++) {
        if ((i in a) !== (i in b)) return `${path}[${i}]`;
        const result = walk(a[i], b[i], `${path}[${i}]`);
        if (result) return result;
      }
      return null;
    }
    const ak = Object.keys(a as object), bk = Object.keys(b as object);
    if (ak.length !== bk.length) return `${path}.{keys}`;
    for (let i = 0; i < ak.length; i++) if (ak[i] !== bk[i]) return `${path}.{keys}`;
    for (const key of ak) {
      const result = walk((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
      if (result) return result;
    }
    return null;
  };
  const path = walk(left, right, '$');
  if (!path) return null;
  return { path, leftHash: hash(left), rightHash: hash(right) };
}
function safeCanonical(value: unknown): string {
  if (value === undefined) return 'undefined';
  try { return JSON.stringify(value) ?? String(value); } catch { return '[unserializable]'; }
}

/** Private in-process cut; callers must never JSON-log this object or send it to another model. */
export interface TechnicalPhysicalCut {
  readonly world: unknown;
  readonly sqliteSchema: readonly Readonly<{ type: string; name: string; sql: string | null }>[];
  readonly sqliteTables: ReadonlyMap<string, readonly Readonly<Record<string, unknown>>[]>;
  readonly governor: unknown;
  readonly decisionClock: readonly ClockEntry[];
  readonly physicalInputs: unknown;
}
function encodeSqliteValue(value: unknown): unknown {
  if (typeof value === 'bigint') return { sqliteBigint: value.toString() };
  if (value instanceof Uint8Array) return { sqliteBlobHex: Buffer.from(value).toString('hex') };
  return value;
}
function stableSqliteRow(row: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(row).sort().map(key => [key, encodeSqliteValue(row[key])]));
}
/** Logical rows, including duplicates and SQLite metadata. Sorting only table rows, never motor arrays. */
export function captureTechnicalPhysicalCut(
  world: unknown, db: import('node:sqlite').DatabaseSync,
  governor: unknown, decisionClock: readonly ClockEntry[], physicalInputs: unknown,
): TechnicalPhysicalCut {
  const definitions = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all() as unknown as Array<{ type: string; name: string; sql: string | null }>;
  const schema = definitions.map(row => Object.freeze({ type: row.type, name: row.name, sql: row.sql }));
  const tables = new Map<string, readonly Readonly<Record<string, unknown>>[]>();
  for (const definition of definitions) {
    if (definition.type !== 'table') continue;
    const quoted = `"${definition.name.replaceAll('"', '""')}"`;
    const rows = [...db.prepare(`SELECT * FROM ${quoted}`).iterate()].map(row => {
      const copy: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) copy[key] = encodeSqliteValue(value);
      return Object.freeze(copy);
    });
    rows.sort((a, b) => { const left = stableSqliteRow(a), right = stableSqliteRow(b); return left < right ? -1 : left > right ? 1 : 0; });
    tables.set(definition.name, Object.freeze(rows));
  }
  return Object.freeze({ world: structuredClone(world), sqliteSchema: Object.freeze(schema), sqliteTables: tables,
    governor: structuredClone(governor), decisionClock: Object.freeze(decisionClock.map(entry => Object.freeze({ ...entry }))),
    physicalInputs: structuredClone(physicalInputs) });
}
/** First mismatch only. The private snapshots and SQLite rows remain in the caller's memory. */
export function firstTechnicalCutDifference(a: TechnicalPhysicalCut, b: TechnicalPhysicalCut):
  null | { path: string; leftHash: string; rightHash: string } {
  for (const [label, left, right] of [
    ['world', a.world, b.world], ['sqliteSchema', a.sqliteSchema, b.sqliteSchema],
    ['sqliteTables', a.sqliteTables, b.sqliteTables], ['governor', a.governor, b.governor],
    ['decisionClock', a.decisionClock, b.decisionClock], ['physicalInputs', a.physicalInputs, b.physicalInputs],
  ] as const) {
    const difference = firstPhysicalDifference(left, right);
    if (difference) return { ...difference, path: `$${label}${difference.path.slice(1)}` };
  }
  return null;
}
