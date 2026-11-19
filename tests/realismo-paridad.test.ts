import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ExactClockTrace, ClockTraceMismatch, firstPhysicalDifference, captureTechnicalPhysicalCut, firstTechnicalCutDifference, TECHNICAL_PARITY_SEEDS, TECHNICAL_PARITY_TICKS } from '../scripts/lab/realismo-replay.js';

// Manual temporal oracle. These tests are cheap; the 6x1200 World parity gate is launcher-owned.
test('clock replay consumes the exact site, ordinal, attempt and tick', () => {
  const record = new ExactClockTrace('record');
  assert.equal(record.read('step-start', 'run:e:attempt-1', 9, 'app-monotonic', () => 10), 10);
  assert.equal(record.read('step-end', 'run:e:attempt-1', 9, 'app-monotonic', () => 15), 15);
  const replay = new ExactClockTrace('replay', record.entries);
  assert.equal(replay.read('step-start', 'run:e:attempt-1', 9, 'app-monotonic', () => { throw new Error('must not read real clock'); }), 10);
  assert.equal(replay.read('step-end', 'run:e:attempt-1', 9, 'app-monotonic', () => { throw new Error('must not read real clock'); }), 15);
  replay.finish();
});
test('clock replay rejects wrong site, repeated tick with wrong attempt, extra and missing reads', () => {
  const entries = [{ siteId: 'projection-start', callOrdinal: 1, attemptId: null, tick: 8, clockDomain: 'projection' as const, value: 5 }];
  assert.throws(() => new ExactClockTrace('replay', entries).read('projection-end', null, 8, 'projection', () => 0), (e: unknown) => e instanceof ClockTraceMismatch && e.code === 'WRONG_SITE');
  assert.throws(() => new ExactClockTrace('replay', entries).read('projection-start', 'attempt-2', 8, 'projection', () => 0), (e: unknown) => e instanceof ClockTraceMismatch && e.code === 'WRONG_CONTEXT');
  assert.throws(() => new ExactClockTrace('replay', entries).finish(), (e: unknown) => e instanceof ClockTraceMismatch && e.code === 'MISSING_READ');
  const replay = new ExactClockTrace('replay', entries);
  replay.read('projection-start', null, 8, 'projection', () => 0);
  assert.throws(() => replay.read('projection-start', null, 8, 'projection', () => 0), (e: unknown) => e instanceof ClockTraceMismatch && e.code === 'EXTRA_READ');
});

test('full local comparison reports only path and hashes for private history', () => {
  const left = { history: [{ text: 'recuerdo privado A', actorId: 's' }], arrays: [1, 2] };
  const right = { history: [{ text: 'recuerdo privado B', actorId: 's' }], arrays: [1, 2] };
  const diff = firstPhysicalDifference(left, right);
  assert.equal(diff?.path, '$.history[0].text');
  assert.match(diff?.leftHash ?? '', /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(diff).includes('recuerdo privado'));
  assert.equal(firstPhysicalDifference(left, structuredClone(left)), null);
});

test('physical comparator includes map/set order, typed bytes and object insertion order', () => {
  const a = { map: new Map([['first', 1], ['second', 2]]), set: new Set(['a', 'b']), bytes: new Uint8Array([1, 2]) };
  const reordered = { map: new Map([['second', 2], ['first', 1]]), set: new Set(['a', 'b']), bytes: new Uint8Array([1, 2]) };
  assert.equal(firstPhysicalDifference(a, reordered)?.path, '$.map.map[0].key');
  const changed = structuredClone(a); changed.bytes[1] = 3;
  assert.equal(firstPhysicalDifference(a, changed)?.path, '$.bytes.byte[1]');
  assert.equal(firstPhysicalDifference({ a: 1, b: 2 }, { b: 2, a: 1 })?.path, '$.{keys}');
});

test('technical parity seeds and duration are fixed before launcher run', () => {
  assert.deepEqual([...TECHNICAL_PARITY_SEEDS], [51926, 42, 606, 1001, 20260924, 20261004]);
  assert.equal(TECHNICAL_PARITY_TICKS, 1200);
});

test('private SQLite logical cut retains duplicate rows and compares archive content without printing it', () => {
  const a = new DatabaseSync(':memory:'), b = new DatabaseSync(':memory:');
  try {
    for (const db of [a, b]) db.exec('CREATE TABLE items (id INTEGER, body TEXT)');
    a.exec("INSERT INTO items VALUES (1,'opaque'),(1,'opaque'),(2,'other')");
    b.exec("INSERT INTO items VALUES (2,'other'),(1,'opaque'),(1,'opaque')");
    const left = captureTechnicalPhysicalCut({ tick: 1, history: [{ text: 'local only' }] }, a, {}, [], []);
    const reordered = captureTechnicalPhysicalCut({ tick: 1, history: [{ text: 'local only' }] }, b, {}, [], []);
    assert.equal(firstTechnicalCutDifference(left, reordered), null);
    b.exec("DELETE FROM items WHERE rowid=(SELECT max(rowid) FROM items WHERE id=1)");
    const missing = captureTechnicalPhysicalCut({ tick: 1, history: [{ text: 'local only' }] }, b, {}, [], []);
    const difference = firstTechnicalCutDifference(left, missing);
    assert.equal(difference?.path, '$sqliteTables.map[0].value.length');
    assert.ok(!JSON.stringify(difference).includes('local only'));
    assert.ok(!JSON.stringify(difference).includes('opaque'));
  } finally { a.close(); b.close(); }
});
