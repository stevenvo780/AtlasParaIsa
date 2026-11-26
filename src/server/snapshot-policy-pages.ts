import { copyPackedPersonWeights, isPackedPersonWeight, WPF1_WEIGHT_BYTES, WPF1_WEIGHT_COUNT,
  type PackedPersonWeights } from './snapshot-packed-people.js';
import { SnapshotSemanticError } from './snapshot.js';

export const POLICY_UIDS_PER_PAGE = 1024;
const MAGIC = Buffer.from('WGP1').readUInt32LE(0);
const HEADER_BYTES = 8;
const UID_BYTES = Float64Array.BYTES_PER_ELEMENT;
const ROW_BYTES = UID_BYTES + WPF1_WEIGHT_BYTES;

function failure(reason: string): never {
  throw new SnapshotSemanticError(`Invalid WGP1 policy page ${reason}. Explicit recovery required.`);
}

export function policyWeightPageBytes(count: number): number {
  if (!Number.isSafeInteger(count) || count < 1 || count > POLICY_UIDS_PER_PAGE) failure('row count');
  return HEADER_BYTES + count * ROW_BYTES;
}

function bucketForUid(uid: number): number {
  if (!Number.isSafeInteger(uid) || uid <= 0) failure('UID');
  return Math.floor(uid / POLICY_UIDS_PER_PAGE);
}

function assertUid(uid: number, previous: number, bucket: number): void {
  if (bucketForUid(uid) !== bucket) failure('UID bucket');
  if (uid <= previous) failure('UID order');
}

/** Header: WGP1 and u32 count. Each row stores its UID followed by its F64LE weights. */
export function encodePolicyWeightPage(entries: readonly { uid: number; weights: PackedPersonWeights }[]): Buffer {
  const body = Buffer.allocUnsafe(policyWeightPageBytes(entries.length));
  const bucket = bucketForUid(entries[0]!.uid);
  body.writeUInt32LE(MAGIC, 0);
  body.writeUInt32LE(entries.length, 4);
  let offset = HEADER_BYTES, previous = 0;
  for (const { uid, weights } of entries) {
    assertUid(uid, previous, bucket);
    body.writeDoubleLE(uid, offset);
    if (!copyPackedPersonWeights(weights, body, offset + UID_BYTES)) failure('missing weights');
    offset += ROW_BYTES;
    previous = uid;
  }
  return body;
}

/** Reads the directory of a validated body. Offsets point into the original view. */
export function decodePolicyWeightPage(body: Uint8Array, count: number):
  { bucket: number; entries: readonly { uid: number; offset: number }[] } {
  if (body.byteLength !== policyWeightPageBytes(count)) failure('byte count');
  const data = new DataView(body.buffer, body.byteOffset, body.byteLength);
  if (data.getUint32(0, true) !== MAGIC) failure('header');
  if (data.getUint32(4, true) !== count) failure('row count');
  const bucket = bucketForUid(data.getFloat64(HEADER_BYTES, true));
  const entries = new Array<{ uid: number; offset: number }>(count);
  for (let i = 0, offset = HEADER_BYTES, previous = 0; i < count; i++, offset += ROW_BYTES) {
    const uid = data.getFloat64(offset, true);
    assertUid(uid, previous, bucket);
    entries[i] = { uid, offset: offset + UID_BYTES };
    previous = uid;
  }
  return { bucket, entries };
}

export function decodePolicyWeights(body: Uint8Array, offset: number): number[] {
  const first = HEADER_BYTES + UID_BYTES;
  if (!Number.isSafeInteger(offset) || offset < first || (offset - first) % ROW_BYTES !== 0
    || offset + WPF1_WEIGHT_BYTES > body.byteLength) failure('weight offset');
  const data = new DataView(body.buffer, body.byteOffset + offset, WPF1_WEIGHT_BYTES);
  const weights = new Array<number>(WPF1_WEIGHT_COUNT);
  for (let i = 0; i < WPF1_WEIGHT_COUNT; i++) {
    const value = data.getFloat64(i * Float64Array.BYTES_PER_ELEMENT, true);
    if (!isPackedPersonWeight(value)) failure('weight value');
    weights[i] = value;
  }
  return weights;
}
