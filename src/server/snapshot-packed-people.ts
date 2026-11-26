import { constants, isUtf8 } from 'node:buffer';
import { types } from 'node:util';
import { constants as zstd, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { stringifyExact } from '../shared/exact-json.js';
import { SnapshotPhysicalError, SnapshotSemanticError } from './snapshot.js';

// WPF1 fixes the width on disk independently of the motor's current policy.
export const WPF1_WEIGHT_COUNT = 212;
export const WPF1_WEIGHT_BYTES = WPF1_WEIGHT_COUNT * Float64Array.BYTES_PER_ELEMENT;
const HEADER_BYTES = 16, MAGIC = Buffer.from('WPF1').readUInt32LE(0);
const DETACHED_MAGIC = Buffer.from('WPD1').readUInt32LE(0);
const MAX_U32 = 0xffff_ffff, MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_UTF8_TEXT_BYTES = 3 * constants.MAX_STRING_LENGTH;
const COMPRESSED_HEADER_BYTES = 8, COMPRESSED_MAGIC = Buffer.from('WZP1').readUInt32LE(0);
const ZSTD_MAGIC = 0xfd2f_b528, MAX_ZSTD_WINDOW_LOG = 22;
const ZSTD_COMPRESSION = { params: { [zstd.ZSTD_c_compressionLevel]: 1 } };
const ZSTD_WINDOW = { [zstd.ZSTD_d_windowLogMax]: MAX_ZSTD_WINDOW_LOG };
const EMPTY_POLICY = { weights: [] };
const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const lookupGetter: (this: object, key: PropertyKey) => unknown =
  Object.getOwnPropertyDescriptor(Object.prototype, '__lookupGetter__')!.value;

export interface PackedPersonRow {
  readonly json: string;
  /** Weights captured when this row was prepared, before any flush callbacks. */
  readonly weights?: readonly number[];
  readonly bytes: number;
}

export type PackedPersonWeights = Pick<PackedPersonRow, 'weights'>;
type StoredBinaryWeights =
  | { readonly body: Buffer; readonly offset: number }
  | { readonly copiar: (destino: Buffer, offset: number) => void };
const binaryWeights = new WeakMap<PackedPersonWeights, StoredBinaryWeights>();
const policyBasePesos = new WeakMap<object, {
  readonly validar: (uid: unknown) => boolean;
  readonly copiar: (destino: Buffer, offset: number) => void;
}>();
const binaryJson = new WeakMap<PackedPersonRow, { body: Buffer; start: number; end: number }>();
const capturedJsonProperty: PropertyDescriptor = {
  enumerable: true,
  get(this: PackedPersonRow): string {
    const { body, start, end } = binaryJson.get(this)!;
    return body.toString('utf8', start, end);
  },
};

function failure(reason: string, cause?: unknown): never {
  throw new SnapshotSemanticError(`Invalid WPF1 people page ${reason}. Explicit recovery required.`, { cause });
}

export function hasPackedPersonWeights(row: PackedPersonRow): boolean {
  return row.weights !== undefined || binaryWeights.has(row);
}

export function retainPackedPersonWeights(row: PackedPersonRow): PackedPersonWeights {
  const retained: PackedPersonWeights = row.weights === undefined ? {} : { weights: row.weights };
  const stored = binaryWeights.get(row);
  if (stored) binaryWeights.set(retained, stored);
  return retained;
}

/** Asocia una copia directa desde una base F64 publicada en SAB sin materializar buffers ni arrays intermedios. */
export function conservarPesosDesdeBase(row: PackedPersonRow, copiar: (destino: Buffer, offset: number) => void): void {
  binaryWeights.set(row, { copiar });
}

/** Marca una política diferida respaldada por la base F64 publicada (uso exclusivo del persistidor). */
export function marcarPoliticaBasePesos(
  policy: object,
  validar: (uid: unknown) => boolean,
  copiar: (destino: Buffer, offset: number) => void,
): void {
  policyBasePesos.set(policy, { validar, copiar });
}

export function olvidarPoliticaBasePesos(policy: object): void {
  policyBasePesos.delete(policy);
}

/** Comprueba que una política diferida sigue ligada a una base publicada vigente con el mismo UID. */
export function esPoliticaBasePesosValida(policy: unknown, uid: unknown): boolean {
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy) || types.isProxy(policy)) return false;
  const entrada = policyBasePesos.get(policy);
  if (!entrada) return false;
  const claves = Reflect.ownKeys(policy);
  return claves.length === 1 && claves[0] === 'weights' && entrada.validar(uid);
}

/** Copy a prepared row's F64LE weights. The original bytes stay private to the codec. */
export function copyPackedPersonWeights(row: PackedPersonWeights, destino: Buffer, offset: number): boolean {
  const stored = binaryWeights.get(row), weights = row.weights;
  if (stored === undefined && weights === undefined) return false;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + WPF1_WEIGHT_BYTES > destino.byteLength)
    failure('weight byte range');
  if (stored) {
    if ('copiar' in stored) stored.copiar(destino, offset);
    else stored.body.copy(destino, offset, stored.offset, stored.offset + WPF1_WEIGHT_BYTES);
    return true;
  }
  if (weights?.length !== WPF1_WEIGHT_COUNT) failure('weight count');
  const data = new DataView(destino.buffer, destino.byteOffset + offset, WPF1_WEIGHT_BYTES);
  for (let i = 0; i < WPF1_WEIGHT_COUNT; i++) {
    const weight = weights[i];
    if (!isPackedPersonWeight(weight)) failure('weight value');
    data.setFloat64(i * Float64Array.BYTES_PER_ELEMENT, weight, true);
  }
  return true;
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

export function prepareInlinePerson(record: Record<string, unknown>): PackedPersonRow {
  return jsonRow(record);
}

export function preparePackedPerson(record: Record<string, unknown>): PackedPersonRow {
  const policyProp = plainRecord(record) ? Object.getOwnPropertyDescriptor(record, 'policy') : undefined;
  const policyObj = policyProp?.enumerable && Object.hasOwn(policyProp, 'value') ? policyProp.value : undefined;
  const baseEntrada = typeof policyObj === 'object' && policyObj !== null ? policyBasePesos.get(policyObj) : undefined;
  if (baseEntrada && Object.getOwnPropertySymbols(record).length === 0
    && esPoliticaBasePesosValida(policyObj, record.uid)) {
    let tieneGetter = false;
    for (const key in record) if (lookupGetter.call(record, key) !== undefined) { tieneGetter = true; break; }
    if (!tieneGetter) {
      const prepared = Object.getPrototypeOf(record) === null
        ? { __proto__: null, ...record, policy: EMPTY_POLICY }
        : { ...record, policy: EMPTY_POLICY };
      const json = stringifyExact(prepared);
      if (typeof json !== 'string' || !json.startsWith('{')) failure('row');
      const row: PackedPersonRow = Object.freeze({ json, bytes: Buffer.byteLength(json) + WPF1_WEIGHT_BYTES });
      binaryWeights.set(row, { copiar: baseEntrada.copiar });
      return row;
    }
  }
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

function reservarBytes(cuerpo: Uint8Array, transferir: boolean, bloque: string): Buffer {
  if (!transferir) return Buffer.from(new Uint8Array(cuerpo).buffer);
  const buffer = cuerpo.buffer;
  if (!(buffer instanceof ArrayBuffer) || cuerpo.byteOffset !== 0 || cuerpo.byteLength !== buffer.byteLength)
    throw new Error(`El bloque de ${bloque} debe ocupar su propio ArrayBuffer.`);
  return Buffer.from(structuredClone(buffer, { transfer: [buffer] }));
}

function capturarPesosWpf1(cuerpo: Uint8Array, transferir: boolean):
  (fila: PackedPersonRow, offset: number) => number[] {
  const body = reservarBytes(cuerpo, transferir, 'pesos directos');
  const data = new DataView(body.buffer, body.byteOffset, body.byteLength);
  return (fila, offset) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset % WPF1_WEIGHT_BYTES !== 0
      || offset + WPF1_WEIGHT_BYTES > data.byteLength) throw new Error('Rango de pesos de persona directa inválido.');
    const pesos = new Array<number>(WPF1_WEIGHT_COUNT);
    for (let i = 0, cursor = offset; i < pesos.length; i++, cursor += Float64Array.BYTES_PER_ELEMENT) {
      const peso = data.getFloat64(cursor, true);
      if (!isPackedPersonWeight(peso)) throw new Error('Peso de persona directa inválido.');
      pesos[i] = peso;
    }
    binaryWeights.set(fila, { body, offset });
    return pesos;
  };
}

/** La fila retiene los bytes privados y la persona recibe su array mutable. */
export function conservarPesosWpf1(cuerpo: Uint8Array, transferir = false):
  (json: string, offset: number) => { fila: PackedPersonRow; pesos: number[] } {
  const capturar = capturarPesosWpf1(cuerpo, transferir);
  return (json, offset) => {
    const fila: PackedPersonRow = Object.freeze({ json, bytes: Buffer.byteLength(json) + WPF1_WEIGHT_BYTES });
    const pesos = capturar(fila, offset);
    return { fila, pesos };
  };
}

/** El receptor verifica el texto decodificado. Las filas solo conservan el rango JSON del bloque privado. */
export function conservarFilasWpf1(cuerpo: Uint8Array, anchoMascara: number, pesos: Uint8Array,
  { transferirCuerpo, transferirPesos }: { transferirCuerpo: boolean; transferirPesos: boolean }) {
  const body = reservarBytes(cuerpo, transferirCuerpo, 'personas directas');
  const texto = utf8Strict.decode(body.subarray(anchoMascara));
  const ascii = texto.length === body.length - anchoMascara;
  const capturarPesos = pesos.byteLength ? capturarPesosWpf1(pesos, transferirPesos) : undefined;
  return {
    texto,
    marcada(indice: number): boolean {
      return (body[indice >>> 3]! & (1 << (indice & 7))) !== 0;
    },
    fila(inicioLinea: number, longitudLinea: number, longitudJson: number, conAusencias: boolean, offsetPesos?: number,
      copiarDesdeBase?: (destino: Buffer, offset: number) => void) {
      const salto = ascii ? inicioLinea + longitudLinea : body.indexOf(0x0a, inicioLinea);
      const finLinea = salto === -1 ? body.length : salto;
      const start = inicioLinea + Number(conAusencias);
      // El envoltorio termina el JSON con coma y tabulador ASCII tras la llave.
      const end = ascii ? start + longitudJson : conAusencias ? body.indexOf(0x09, start) - 1 : finLinea;
      if (inicioLinea < anchoMascara || end < start + 2 || end > finLinea
        || body[start] !== 0x7b || body[end - 1] !== 0x7d || (conAusencias && body[end] !== 0x2c))
        throw new Error('Rango JSON de persona directa inválido.');
      const conPesos = offsetPesos !== undefined || copiarDesdeBase !== undefined;
      const bytes = end - start + (conPesos ? WPF1_WEIGHT_BYTES : 0);
      const fila: PackedPersonRow = Object.freeze(Object.defineProperty({ json: '', bytes }, 'json', capturedJsonProperty));
      const pesos = offsetPesos === undefined ? undefined : capturarPesos!(fila, offsetPesos);
      if (copiarDesdeBase !== undefined) binaryWeights.set(fila, { copiar: copiarDesdeBase });
      binaryJson.set(fila, { body, start, end });
      return { fila, pesos, siguienteLinea: finLinea < body.length ? finLinea + 1 : finLinea };
    },
  };
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
    || bytes > maxPageBytes(count)) failure('byte count');
}

function maxPageBytes(count: number): number {
  return count === 1 ? MAX_UTF8_TEXT_BYTES : MAX_PAGE_BYTES;
}

/** Header: magic, JSON byte count, row count, packed count. Then a mask (least
 * significant bit first), one UTF-8 JSON array, and F64LE weights in row order. */
export function encodePackedPeoplePage(rows: readonly PackedPersonRow[]): Buffer {
  return encodePeoplePage(rows, false);
}

/** WPD1 preserves the WPF1 header, mask and JSON. Weights live in separate UID pages. */
export function encodeDetachedPackedPeoplePage(rows: readonly PackedPersonRow[]): Buffer {
  return encodePeoplePage(rows, true);
}

function encodePeoplePage(rows: readonly PackedPersonRow[], detached: boolean): Buffer {
  const count = rows.length;
  let packedCount = 0, sumJsonBytes = 0;
  for (const row of rows) {
    const packed = hasPackedPersonWeights(row);
    const jsonBytes = row.bytes - (packed ? WPF1_WEIGHT_BYTES : 0);
    const stored = binaryJson.get(row);
    if (stored) {
      if (jsonBytes !== stored.end - stored.start) failure('row byte count');
    } else if (typeof row.json !== 'string' || !row.json.startsWith('{') || !row.json.endsWith('}')
      || jsonBytes !== Buffer.byteLength(row.json)) failure('row byte count');
    if (row.weights !== undefined && row.weights.length !== WPF1_WEIGHT_COUNT) failure('weight count');
    if (packed) packedCount++;
    sumJsonBytes += jsonBytes;
  }
  const weightBytes = detached ? 0 : packedCount * WPF1_WEIGHT_BYTES;
  const size = packedPeoplePageBytes(count, sumJsonBytes + weightBytes);
  const jsonStart = HEADER_BYTES + Math.ceil(count / 8);
  const jsonBytes = size - jsonStart - weightBytes;
  assertSize(count, jsonBytes, size);

  const body = Buffer.alloc(size);
  body.writeUInt32LE(detached ? DETACHED_MAGIC : MAGIC, 0);
  body.writeUInt32LE(jsonBytes, 4);
  body.writeUInt32LE(count, 8);
  body.writeUInt32LE(packedCount, 12);
  let json = jsonStart, binary = jsonStart + jsonBytes;
  body[json++] = 0x5b; // [
  for (let i = 0; i < count; i++) {
    if (i > 0) body[json++] = 0x2c; // ,
    const row = rows[i]!;
    const packed = detached ? hasPackedPersonWeights(row) : copyPackedPersonWeights(row, body, binary);
    const bytes = row.bytes - (packed ? WPF1_WEIGHT_BYTES : 0);
    const stored = binaryJson.get(row);
    json += stored ? stored.body.copy(body, json, stored.start, stored.end) : body.write(row.json, json, bytes, 'utf8');
    if (packed) {
      body[HEADER_BYTES + (i >>> 3)]! |= 1 << (i & 7);
      if (!detached) binary += WPF1_WEIGHT_BYTES;
    }
  }
  body[json] = 0x5d; // ]
  return body;
}

export function decodePackedPeoplePage(body: Uint8Array, count: number, parse: (json: string) => unknown): unknown[] {
  return decodePeoplePage(body, count, parse);
}

function decodePeoplePage(body: Uint8Array, count: number, parse: (json: string) => unknown,
  cargarPesos?: (uid: number) => number[]): unknown[] {
  if (body.byteLength < HEADER_BYTES) failure('header');
  const data = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const detached = cargarPesos !== undefined;
  if (data.getUint32(0, true) !== (detached ? DETACHED_MAGIC : MAGIC)) failure('header');
  if (data.getUint32(8, true) !== count) failure('row count');
  const jsonBytes = data.getUint32(4, true), packedCount = data.getUint32(12, true);
  assertSize(count, jsonBytes, body.byteLength);
  const jsonStart = HEADER_BYTES + Math.ceil(count / 8), binaryStart = jsonStart + jsonBytes;
  if (packedCount > count || body.byteLength !== binaryStart + (detached ? 0 : packedCount * WPF1_WEIGHT_BYTES))
    failure('byte count');
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
    if (cargarPesos) {
      const uid = row.uid;
      if (!Object.hasOwn(row, 'uid') || typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid <= 0)
        failure('detached policy uid');
      // The resolver checks the referenced policy's values when decoding its weight page.
      const weights = cargarPesos(uid);
      if (!Array.isArray(weights) || weights.length !== WPF1_WEIGHT_COUNT) failure('detached policy weight count');
      policy.weights = weights;
      continue;
    }
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

function compressedFailure(reason: string, cause?: unknown): never {
  throw new SnapshotPhysicalError(`Invalid WZP1 people page ${reason}.`, { cause });
}

// Node's streaming decoder can return the full output even if the frame trailer
// was truncated. Check the boundaries of a single Zstd frame (RFC 8878 §3.1.1).
function assertCompleteZstdFrame(frame: Buffer, rawBytes: number): void {
  if (frame.length < 8 || frame.readUInt32LE(0) !== ZSTD_MAGIC) compressedFailure('Zstd frame header');
  const descriptor = frame[4]!;
  const singleSegment = (descriptor & 0x20) !== 0;
  const sizeFlag = descriptor >>> 6, dictionaryFlag = descriptor & 3;
  const sizeBytes = sizeFlag === 0 ? Number(singleSegment) : 1 << sizeFlag;
  const dictionaryBytes = dictionaryFlag === 0 ? 0 : 1 << (dictionaryFlag - 1);
  const sizeAt = (singleSegment ? 5 : 6) + dictionaryBytes;
  let blockAt = sizeAt + sizeBytes;
  if (frame.length < blockAt + 3) compressedFailure('Zstd frame header');
  if (sizeBytes !== 0) {
    const size = sizeBytes === 8 ? frame.readBigUInt64LE(sizeAt)
      : BigInt(frame.readUIntLE(sizeAt, sizeBytes) + (sizeBytes === 2 ? 256 : 0));
    if (size !== BigInt(rawBytes)) compressedFailure('Zstd frame content size');
  }
  // An exact power of two has a zero window mantissa in the descriptor.
  const maxWindowDescriptor = (MAX_ZSTD_WINDOW_LOG - 10) << 3;
  if (singleSegment ? rawBytes > 2 ** MAX_ZSTD_WINDOW_LOG : frame[5]! > maxWindowDescriptor)
    compressedFailure('Zstd frame window');

  const checksumBytes = (descriptor & 4) === 0 ? 0 : 4;
  while (blockAt + 3 <= frame.length) {
    const header = frame.readUIntLE(blockAt, 3);
    const type = (header >>> 1) & 3;
    if (type === 3) compressedFailure('Zstd block type');
    blockAt += 3 + (type === 1 ? 1 : header >>> 3); // RLE stores only its repeated byte.
    if ((header & 1) === 0) continue;
    if (blockAt + checksumBytes === frame.length) return;
    break;
  }
  compressedFailure('Zstd frame length');
}

/** Store a WPF1 or WPD1 page as-is or as WZP1 plus its original u32 byte count and one Zstd frame. */
export function encodeStoredPackedPeoplePage(raw: Uint8Array): Uint8Array {
  // The existing format permits oversized pages with just one row.
  if (raw.byteLength > MAX_PAGE_BYTES) return raw;
  const compressed = zstdCompressSync(raw, ZSTD_COMPRESSION);
  const length = COMPRESSED_HEADER_BYTES + compressed.byteLength;
  if (length >= raw.byteLength) return raw;
  const body = Buffer.allocUnsafe(length);
  body.writeUInt32LE(COMPRESSED_MAGIC, 0);
  body.writeUInt32LE(raw.byteLength, 4);
  compressed.copy(body, COMPRESSED_HEADER_BYTES);
  return body;
}

export function decodeStoredPackedPeoplePage(body: Uint8Array, count: number, parse: (json: string) => unknown): unknown[] {
  return decodePeoplePage(unwrapStoredPeoplePage(body, count), count, parse);
}

export function decodeStoredDetachedPackedPeoplePage(body: Uint8Array, count: number, parse: (json: string) => unknown,
  cargarPesos: (uid: number) => number[]): unknown[] {
  return decodePeoplePage(unwrapStoredPeoplePage(body, count), count, parse, cargarPesos);
}

function unwrapStoredPeoplePage(body: Uint8Array, count: number): Uint8Array {
  const stored = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (stored.length < 4 || stored.readUInt32LE(0) !== COMPRESSED_MAGIC) return body;
  if (stored.length < COMPRESSED_HEADER_BYTES) compressedFailure('header');
  const rawBytes = stored.readUInt32LE(4);
  if (rawBytes < HEADER_BYTES + 2 || rawBytes > maxPageBytes(count)) compressedFailure('declared byte count');
  const frame = stored.subarray(COMPRESSED_HEADER_BYTES);
  assertCompleteZstdFrame(frame, rawBytes);
  let raw: Buffer;
  try {
    raw = zstdDecompressSync(frame, {
      chunkSize: Math.min(128 * 1024, Math.max(zstd.Z_MIN_CHUNK, rawBytes)),
      maxOutputLength: rawBytes,
      params: ZSTD_WINDOW,
    });
  } catch (error) {
    compressedFailure('Zstd decompression', error);
  }
  if (raw.length !== rawBytes) compressedFailure('decompressed byte count');
  return raw;
}
