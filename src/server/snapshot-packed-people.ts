import { constants, isUtf8 } from 'node:buffer';
import { types } from 'node:util';
import { stringifyExact } from '../shared/exact-json.js';
import { SnapshotPhysicalError, SnapshotSemanticError } from './snapshot.js';

// WPF1 fixes the width on disk independently of the motor's current policy.
export const WPF1_WEIGHT_COUNT = 212;
export const WPF1_WEIGHT_BYTES = WPF1_WEIGHT_COUNT * Float64Array.BYTES_PER_ELEMENT;
const HEADER_BYTES = 16, MAGIC = Buffer.from('WPF1').readUInt32LE(0);
const MAX_U32 = 0xffff_ffff, MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_UTF8_TEXT_BYTES = 3 * constants.MAX_STRING_LENGTH;
const EMPTY_POLICY = { weights: [] };
const lookupGetter: (this: object, key: PropertyKey) => unknown =
  Object.getOwnPropertyDescriptor(Object.prototype, '__lookupGetter__')!.value;

export interface PackedPersonRow {
  readonly json: string;
  /** Weights captured when this row was prepared, before any flush callbacks. */
  readonly weights?: readonly number[];
  readonly bytes: number;
}

function failure(reason: string, cause?: unknown): never {
  throw new SnapshotSemanticError(`Invalid WPF1 people page ${reason}. Explicit recovery required.`, { cause });
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (types.isProxy(value) || !object(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && !('toJSON' in value);
}

export function isPackedPersonWeight(value: unknown): value is number {
  return typeof value === 'number' && value >= -1 && value <= 1;
}

function packableWeights(record: Record<string, unknown>): readonly number[] | undefined {
  if (!plainRecord(record)) return;
  const property = Object.getOwnPropertyDescriptor(record, 'policy');
  if (!property?.enumerable || !Object.hasOwn(property, 'value')) return;
  const policy: unknown = property.value;
  if (!plainRecord(policy) || Reflect.ownKeys(policy).length !== 1) return;
  const weightsProperty = Object.getOwnPropertyDescriptor(policy, 'weights');
  if (!weightsProperty?.enumerable || !Object.hasOwn(weightsProperty, 'value')) return;
  const weights: unknown = weightsProperty.value;
  if (types.isProxy(weights) || !Array.isArray(weights) || weights.length !== WPF1_WEIGHT_COUNT
    || Object.getPrototypeOf(weights) !== Array.prototype || 'toJSON' in weights) return;
  const captured = new Array<number>(WPF1_WEIGHT_COUNT);
  for (let i = 0; i < WPF1_WEIGHT_COUNT; i++) {
    if (!Object.hasOwn(weights, i) || lookupGetter.call(weights, i) !== undefined) return;
    const value: unknown = weights[i];
    if (!isPackedPersonWeight(value)) return;
    captured[i] = value;
  }
  return captured;
}

function jsonRow(record: Record<string, unknown>, weights?: readonly number[]): PackedPersonRow {
  const json = stringifyExact(record);
  if (typeof json !== 'string' || !json.startsWith('{')) failure('row');
  const bytes = Buffer.byteLength(json) + (weights === undefined ? 0 : WPF1_WEIGHT_BYTES);
  return weights === undefined ? { json, bytes } : { json, weights, bytes };
}

export function preparePackedPerson(record: Record<string, unknown>): PackedPersonRow {
  const weights = packableWeights(record);
  if (!weights || Object.getOwnPropertySymbols(record).length !== 0) return jsonRow(record);
  // Spread keeps the position of the existing policy key. Keep accessor-bearing
  // records on the original stringifier, which controls when their getters run.
  for (const key in record) if (lookupGetter.call(record, key) !== undefined) return jsonRow(record);
  const prepared = Object.getPrototypeOf(record) === null
    ? { __proto__: null, ...record, policy: EMPTY_POLICY }
    : { ...record, policy: EMPTY_POLICY };
  return jsonRow(prepared, weights);
}

function u32(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_U32;
}

export function packedPeoplePageBytes(rowCount: number, sumRowBytes: number): number {
  if (!u32(rowCount) || !u32(sumRowBytes)) failure('byte count');
  return HEADER_BYTES + Math.ceil(rowCount / 8) + 2 + Math.max(0, rowCount - 1) + sumRowBytes;
}

function assertSize(count: number, jsonBytes: number, bytes: number): void {
  const jsonMinimum = count === 0 ? 2 : 1 + 3 * count;
  // Like JSON organism pages, a large individual can occupy a page by itself.
  if (!u32(count) || !u32(jsonBytes) || jsonBytes < jsonMinimum
    || bytes > (count === 1 ? MAX_UTF8_TEXT_BYTES : MAX_PAGE_BYTES)) failure('byte count');
}

/** Header: magic, JSON byte count, row count, packed count. Then a mask (least
 * significant bit first), one UTF-8 JSON array, and F64LE weights in row order. */
export function encodePackedPeoplePage(rows: readonly PackedPersonRow[]): Buffer {
  const count = rows.length;
  let packedCount = 0, sumRowBytes = 0;
  for (const row of rows) {
    if (typeof row.json !== 'string' || !row.json.startsWith('{') || !row.json.endsWith('}')
      || row.bytes !== Buffer.byteLength(row.json) + (row.weights === undefined ? 0 : WPF1_WEIGHT_BYTES))
      failure('row byte count');
    if (row.weights !== undefined) {
      if (row.weights.length !== WPF1_WEIGHT_COUNT) failure('weight count');
      packedCount++;
    }
    sumRowBytes += row.bytes;
  }
  const size = packedPeoplePageBytes(count, sumRowBytes);
  const jsonStart = HEADER_BYTES + Math.ceil(count / 8);
  const jsonBytes = size - jsonStart - packedCount * WPF1_WEIGHT_BYTES;
  assertSize(count, jsonBytes, size);

  const body = Buffer.alloc(size);
  const data = new DataView(body.buffer, body.byteOffset, body.byteLength);
  data.setUint32(0, MAGIC, true);
  data.setUint32(4, jsonBytes, true);
  data.setUint32(8, count, true);
  data.setUint32(12, packedCount, true);
  let json = jsonStart, binary = jsonStart + jsonBytes;
  body[json++] = 0x5b; // [
  for (let i = 0; i < count; i++) {
    if (i > 0) body[json++] = 0x2c; // ,
    const row = rows[i]!;
    const bytes = row.bytes - (row.weights === undefined ? 0 : WPF1_WEIGHT_BYTES);
    json += body.write(row.json, json, bytes, 'utf8');
    if (row.weights === undefined) continue;
    body[HEADER_BYTES + (i >>> 3)]! |= 1 << (i & 7);
    for (let j = 0; j < WPF1_WEIGHT_COUNT; j++, binary += Float64Array.BYTES_PER_ELEMENT) {
      const value = row.weights[j];
      if (!isPackedPersonWeight(value)) failure('weight value');
      data.setFloat64(binary, value, true);
    }
  }
  body[json] = 0x5d; // ]
  return body;
}

export function decodePackedPeoplePage(body: Uint8Array, count: number, parse: (json: string) => unknown): unknown[] {
  if (body.byteLength < HEADER_BYTES) failure('header');
  const data = new DataView(body.buffer, body.byteOffset, body.byteLength);
  if (data.getUint32(0, true) !== MAGIC) failure('header');
  if (data.getUint32(8, true) !== count) failure('row count');
  const jsonBytes = data.getUint32(4, true), packedCount = data.getUint32(12, true);
  assertSize(count, jsonBytes, body.byteLength);
  const jsonStart = HEADER_BYTES + Math.ceil(count / 8), binaryStart = jsonStart + jsonBytes;
  if (packedCount > count || body.byteLength !== binaryStart + packedCount * WPF1_WEIGHT_BYTES) failure('byte count');
  const spare = count & 7;
  if (spare !== 0 && body[jsonStart - 1]! >>> spare !== 0) failure('mask padding');
  let present = 0;
  for (let i = HEADER_BYTES; i < jsonStart; i++) {
    for (let bits = body[i]!; bits !== 0; bits &= bits - 1) present++;
  }
  if (present !== packedCount) failure('mask count');

  const json = body.subarray(jsonStart, binaryStart);
  if (!isUtf8(json)) failure('UTF-8');
  let rows: unknown;
  try {
    rows = parse(Buffer.from(json.buffer, json.byteOffset, json.byteLength).toString('utf8'));
  } catch (error) {
    if (error instanceof SnapshotPhysicalError || error instanceof SnapshotSemanticError) throw error;
    failure('JSON', error);
  }
  if (!Array.isArray(rows) || rows.length !== count) failure('JSON row count');

  let binary = binaryStart;
  for (let i = 0; i < count; i++) {
    const row: unknown = rows[i];
    if (!object(row)) failure('JSON row');
    if ((body[HEADER_BYTES + (i >>> 3)]! & (1 << (i & 7))) === 0) continue;
    const policy = row.policy;
    if (!Object.hasOwn(row, 'policy') || !object(policy) || Reflect.ownKeys(policy).length !== 1
      || !Object.hasOwn(policy, 'weights') || !Array.isArray(policy.weights) || policy.weights.length !== 0)
      failure('policy placeholder');
    const weights = new Array<number>(WPF1_WEIGHT_COUNT);
    for (let j = 0; j < WPF1_WEIGHT_COUNT; j++, binary += Float64Array.BYTES_PER_ELEMENT) {
      const value = data.getFloat64(binary, true);
      if (!isPackedPersonWeight(value)) failure('weight value');
      weights[j] = value;
    }
    policy.weights = weights;
  }
  return rows;
}
