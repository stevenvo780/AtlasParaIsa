import assert from 'node:assert/strict';
import test from 'node:test';
import { constants as zstd, zstdCompressSync } from 'node:zlib';
import {
  decodePackedPeoplePage, decodeStoredPackedPeoplePage, encodePackedPeoplePage, encodeStoredPackedPeoplePage,
  packedPeoplePageBytes, preparePackedPerson,
} from '../src/server/snapshot-packed-people.js';
import { SnapshotPhysicalError, SnapshotSemanticError } from '../src/server/snapshot.js';
import { stringifyExact } from '../src/shared/exact-json.js';

const weightsOf = (value = 0.125): number[] => Array<number>(212).fill(value);
const decode = (body: Uint8Array, count: number) => decodePackedPeoplePage(body, count, JSON.parse);
const decodeStored = (body: Uint8Array, count: number) => decodeStoredPackedPeoplePage(body, count, JSON.parse);

test('WPF1 conserva orden, signos, pesos F64LE y una máscara de más de un byte', () => {
  const weights = weightsOf();
  weights[0] = -0; weights[1] = +0; weights[2] = Number.MIN_VALUE; weights[3] = -1; weights[4] = 1;
  const records: Record<string, unknown>[] = Array.from({ length: 10 }, (_, id) => ({ id }));
  records[0] = { id: 'niño', policy: { weights }, after: -0 };
  records[7]!.policy = { weights: weightsOf(-0.5) };
  records[8]!.policy = { weights: weightsOf(0.75) };

  const rows = records.map(preparePackedPerson);
  assert.notStrictEqual(rows[0]!.weights, weights);
  assert.deepEqual(rows[0]!.weights, weights);
  assert.equal(rows[0]!.json, '{"id":"niño","policy":{"weights":[]},"after":-0}');
  assert.equal(rows[0]!.bytes, Buffer.byteLength(rows[0]!.json) + 1696);
  assert.deepEqual(rows[1], { json: '{"id":1}', bytes: 8 });
  const body = encodePackedPeoplePage(rows);
  assert.equal(body.byteLength, packedPeoplePageBytes(rows.length, rows.reduce((n, row) => n + row.bytes, 0)));
  assert.equal(body.toString('ascii', 0, 4), 'WPF1');
  assert.equal(body.readUInt32LE(8), records.length);
  assert.equal(body.readUInt32LE(12), 3);
  assert.deepEqual([...body.subarray(16, 18)], [0b1000_0001, 0b0000_0001]);
  const packedStart = 18 + body.readUInt32LE(4);
  assert.equal(body.readBigUInt64LE(packedStart), 0x8000_0000_0000_0000n);
  assert.equal(body.readBigUInt64LE(packedStart + 8), 0n);
  assert.equal(body.readBigUInt64LE(packedStart + 16), 1n);
  assert.equal(body.readDoubleLE(packedStart + 1696), -0.5);

  const surrounding = Uint8Array.of(0xee, 0xff, ...body, 0xcc);
  const decoded = decode(surrounding.subarray(2, -1), records.length);
  assert.deepEqual(decoded, records);
  assert.deepEqual(Object.keys(decoded[0] as object), Object.keys(records[0]!));
  assert.ok(Object.is(records[0]!.after, -0));
  assert.ok(Object.is(weights[0], -0));
});

test('la fila preparada conserva sus pesos si el original cambia antes de escribir la página', () => {
  const weights = weightsOf(0.125);
  const row = preparePackedPerson({ policy: { weights } });
  weights.fill(0.5);
  assert.deepEqual(decode(encodePackedPeoplePage([row]), 1), [{ policy: { weights: weightsOf(0.125) } }]);
});

test('las formas ajenas a WPF1 conservan el JSON exacto', () => {
  const sparse = weightsOf();
  delete sparse[12];
  const weightsWithGetter = weightsOf();
  Object.defineProperty(weightsWithGetter, 10, { get: () => -0 });
  const policies = [
    undefined, null, {}, { weights: [] }, { weights: [-0, 1] }, { weights: weightsOf().slice(1) },
    { weights: sparse }, { weights: weightsOf(Infinity) }, { weights: weightsOf(NaN) },
    { weights: weightsOf(1.01) }, { weights: weightsOf(-1.01) }, { weights: new Float64Array(212) },
    { weights: weightsOf(), extra: true }, { weights: weightsOf(), [Symbol()]: null },
    { weights: new Proxy(weightsOf(), {}) }, { weights: weightsWithGetter },
    { get weights() { return weightsOf(); } },
    { weights: weightsOf(), toJSON() { return { weights: [-0] }; } },
  ];
  const records: Record<string, unknown>[] = policies.map((policy, id) => ({ id, policy, after: -0 }));
  records.push(
    { get policy() { return { weights: weightsOf() }; } },
    { policy: { weights: weightsOf() }, get after() { return -0; } },
    new Proxy({ policy: { weights: weightsOf() } }, {}),
    { policy: { weights: weightsOf() }, toJSON() { return { weights: [1, -0] }; } },
  );
  const rows = records.map(preparePackedPerson);
  const expected = records.map(record => stringifyExact(record));
  assert.deepEqual(rows.map(row => row.json), expected);
  assert.ok(rows.every(row => row.weights === undefined && row.bytes === Buffer.byteLength(row.json)));
  assert.deepEqual(decode(encodePackedPeoplePage(rows), rows.length), expected.map(row => JSON.parse(row)));
  assert.deepEqual(decode(encodePackedPeoplePage([]), 0), []);
});

test('WPF1 rechaza dimensiones, máscara, JSON, UTF-8 y pesos incoherentes', () => {
  const rows = [{ id: 'niño', policy: { weights: weightsOf() } }, { id: 2 }].map(preparePackedPerson);
  const body = encodePackedPeoplePage(rows), count = rows.length, jsonStart = 17;
  const binaryStart = jsonStart + body.readUInt32LE(4);
  const change = (edit: (newBody: Buffer) => void) => {
    const copy = Buffer.from(body);
    edit(copy);
    return copy;
  };
  const withJSON = (json: string) => {
    const header = Buffer.from(body.subarray(0, jsonStart)), bytes = Buffer.from(json);
    header.writeUInt32LE(bytes.length, 4);
    return Buffer.concat([header, bytes, body.subarray(binaryStart)]);
  };
  const corrupt = [
    body.subarray(0, 15), body.subarray(0, -1), Buffer.concat([body, Buffer.of(0)]),
    change(copy => { copy[0] = 0; }),
    change(copy => { copy.writeUInt32LE(0xffff_ffff, 4); }),
    change(copy => { copy.writeUInt32LE(0xffff_ffff, 8); }),
    change(copy => { copy.writeUInt32LE(3, 12); }),
    change(copy => { copy[16] = 0; }),
    change(copy => { copy[16] = 0b1000_0001; }),
    change(copy => { copy[16] = 0b0000_0010; }),
    change(copy => { copy[jsonStart + 2] = 0xff; }),
    change(copy => { copy[binaryStart - 1] = 0x7b; }),
    change(copy => { copy.writeDoubleLE(NaN, binaryStart); }),
    change(copy => { copy.writeDoubleLE(Infinity, binaryStart); }),
    change(copy => { copy.writeDoubleLE(-1.0001, binaryStart); }),
    withJSON('[{"policy":{"weights":[]}}]'),
    withJSON('[{"policy":{"weights":[0]}},{"id":2}]'),
    withJSON('[{"policy":{"weights":[],"extra":1}},{"id":2}]'),
    withJSON('[{"policy":{"weights":[]}},null]'),
  ];
  for (const bytes of corrupt) assert.throws(() => decode(bytes, count), SnapshotSemanticError);
  assert.throws(() => decode(body, count - 1), SnapshotSemanticError);
  assert.throws(() => packedPeoplePageBytes(-1, 0), SnapshotSemanticError);
  assert.throws(() => encodePackedPeoplePage([{ ...rows[0]!, bytes: rows[0]!.bytes - 1 }]), SnapshotSemanticError);
  const oversizedRow = preparePackedPerson({ note: 'x'.repeat(4 * 1024 * 1024) });
  assert.throws(() => encodePackedPeoplePage([oversizedRow, rows[0]!]), SnapshotSemanticError);
  const oversizedPage = encodePackedPeoplePage([oversizedRow]);
  assert.equal(decode(oversizedPage, 1).length, 1);
  assert.deepEqual(decodeStored(encodeStoredPackedPeoplePage(oversizedPage), 1), decode(oversizedPage, 1));
});

test('WZP1 conserva las filas WPF1 y el signo del cero al guardar páginas comprimidas y crudas', () => {
  const weights = weightsOf();
  weights[0] = -0;
  const rows = [{ id: 'niño', policy: { weights }, after: -0 }, { id: 2 }].map(preparePackedPerson);
  const raw = encodePackedPeoplePage(rows);
  const stored = Buffer.from(encodeStoredPackedPeoplePage(raw));
  assert.equal(stored.toString('ascii', 0, 4), 'WZP1');
  assert.equal(stored.readUInt32LE(4), raw.length);
  assert.ok(stored.length < raw.length);
  const surrounding = Buffer.concat([Buffer.of(0xff, 0xee), stored, Buffer.of(0xcc)]);
  assert.deepEqual(decodeStored(surrounding.subarray(2, -1), rows.length), decode(raw, rows.length));
  assert.deepEqual(decodeStored(raw, rows.length), decode(raw, rows.length));

  const empty = encodePackedPeoplePage([]);
  assert.strictEqual(encodeStoredPackedPeoplePage(empty), empty);
  assert.deepEqual(decodeStored(empty, 0), []);
});

test('WZP1 rechaza tamaños, ventanas y tramas Zstd corruptas como fallos físicos', () => {
  const raw = encodePackedPeoplePage([{ policy: { weights: weightsOf() } }, { id: 2 }].map(preparePackedPerson));
  const count = 2;
  const stored = Buffer.from(encodeStoredPackedPeoplePage(raw));
  const change = (edit: (copy: Buffer) => void) => {
    const copy = Buffer.from(stored);
    edit(copy);
    return copy;
  };
  const withFrame = (frame: Buffer) => Buffer.concat([stored.subarray(0, 8), frame]);
  const checksummed = withFrame(zstdCompressSync(raw, { params: { [zstd.ZSTD_c_checksumFlag]: 1 } }));
  assert.deepEqual(decodeStored(checksummed, count), decode(raw, count));
  const unknownSizeFrame = zstdCompressSync(raw, { params: { [zstd.ZSTD_c_contentSizeFlag]: 0 } });
  const oversizedWindow = Buffer.from(unknownSizeFrame);
  oversizedWindow[5] = 13 << 3; // 8 MiB.
  const smallerOutputLimit = withFrame(unknownSizeFrame);
  smallerOutputLimit.writeUInt32LE(raw.length - 1, 4);
  const largerOutputLimit = withFrame(unknownSizeFrame);
  largerOutputLimit.writeUInt32LE(raw.length + 1, 4);
  const corrupt = [
    stored.subarray(0, 7),
    stored.subarray(0, -1),
    checksummed.subarray(0, -1),
    Buffer.concat([stored, Buffer.of(0)]),
    change(copy => { copy[8] = 0; }),
    change(copy => { copy.writeUInt32LE(raw.length + 1, 4); }),
    change(copy => { copy.writeUInt32LE(4 * 1024 * 1024 + 1, 4); }),
    withFrame(oversizedWindow),
    smallerOutputLimit,
    largerOutputLimit,
  ];
  for (const body of corrupt) assert.throws(() => decodeStored(body, count), SnapshotPhysicalError);
});

test('WZP1 conserva el fallo semántico de la página WPF1 interior', () => {
  const raw = encodePackedPeoplePage([preparePackedPerson({ policy: { weights: weightsOf() } })]);
  raw.writeDoubleLE(NaN, raw.length - 8);
  const stored = encodeStoredPackedPeoplePage(raw);
  assert.ok(stored.length < raw.length);
  assert.throws(() => decodeStored(stored, 1), SnapshotSemanticError);
});

test('WPF1 conserva la clasificación de un error del analizador recibido', () => {
  const body = encodePackedPeoplePage([preparePackedPerson({ policy: { weights: weightsOf() } })]);
  const physical = new SnapshotPhysicalError('JSON sintácticamente inválido');
  const semantic = new SnapshotSemanticError('JSON con claves duplicadas');
  for (const error of [physical, semantic]) {
    assert.throws(() => decodePackedPeoplePage(body, 1, () => { throw error; }), value => value === error);
  }
});
