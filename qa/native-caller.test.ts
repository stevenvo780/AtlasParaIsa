// AUTHORED NOT RUN. All commit paths use the real Store and SQLite connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, SessionRevoked } from '../src/server/store.js';
import { createWorld, observeWorldOpening } from '../src/world/index.js';
import { bindObservation, beginObservationAttempt, createObservationSession, drainObservation } from '../src/world/observation.js';
import { attachC10NativeCaller, saveWithC10Capture } from '../src/server/c10-native-commit-caller.js';
import { observeC10Store } from '../src/server/c10-store-commit-observer.js';

function fixture() {
  const store = new Store(':memory:'); const world = createWorld(20260905);
  // Explicit synthetic QA identity, never labelled native source proof.
  const session = createObservationSession({ runId: 'synthetic-QA', epochId: 'QA', sourceSHA: 'a'.repeat(40) });
  bindObservation(world, session); beginObservationAttempt(world, world.tick); observeWorldOpening(world);
  return { store, world, session };
}
test('real save returns void; signal is post COMMIT and UNKNOWN', () => {
  const { store, world } = fixture(); let count = 0;
  const detach = observeC10Store(store, signal => { count++; assert.equal(store.db.isTransaction, false);
    assert.equal(signal.durable, 'UNKNOWN'); assert.equal(signal.nativeTransactionId, null); });
  try { assert.equal(saveWithC10Capture(store, world), undefined); assert.equal(count, 1); }
  finally { detach(); store.close(); }
});
test('revoked transaction ROLLBACK emits no COMMIT callback', () => {
  const { store, world } = fixture(); let count = 0;
  const detach = observeC10Store(store, () => { count++; });
  try { assert.throws(() => store.save(world, [], ['missing-session']), SessionRevoked); assert.equal(count, 0); assert.equal(store.db.isTransaction, false); }
  finally { detach(); store.close(); }
});
test('actual COMMIT execution failure preserves error and emits no callback', () => {
  const { store, world } = fixture(); let count = 0;
  const detach = observeC10Store(store, () => { count++; }); const exec = store.db.exec.bind(store.db);
  const sentinel = new Error('COMMIT failure injection at real SQLite boundary');
  store.db.exec = (sql: string) => { if (sql === 'COMMIT') throw sentinel; return exec(sql); };
  try { assert.throws(() => store.save(world), error => error === sentinel); assert.equal(count, 0); assert.equal(store.db.isTransaction, false); }
  finally { detach(); store.close(); }
});
test('callback exception cannot turn successful commit into save error', () => {
  const { store, world } = fixture(); const detach = observeC10Store(store, () => { throw new Error('sinkfail'); });
  try { assert.equal(store.save(world), undefined); assert.ok(store.load()); }
  finally { detach(); store.close(); }
});
test('duplicate event rejects capture without changing queue/census or save', () => {
  const { store, world, session } = fixture(); session.queue.push(session.queue[0]);
  const before = session.queue.length; let appended = 0;
  const caller = attachC10NativeCaller(store, { appendSourceEvent() { appended++; }, appendSignal() {}, unknown() {} });
  try { store.save(world); assert.equal(appended, 0); assert.equal(session.queue.length, before); assert.equal(caller.status().hookFailed, true); }
  finally { caller.detach(); store.close(); }
});
test('drain before capture blocks observation, while save still succeeds', async () => {
  const { store, world, session } = fixture(); await drainObservation(session, () => {}); let appended = 0;
  const caller = attachC10NativeCaller(store, { appendSourceEvent() { appended++; }, appendSignal() {}, unknown() {} });
  try { store.save(world); assert.equal(appended, 0); assert.equal(caller.status().hookFailed, true); }
  finally { caller.detach(); store.close(); }
});
test('sink failure keeps real save, queue and counters; capture before drain', async () => {
  const { store, world, session } = fixture(); const before = session.queue.length; let beforeDrain = false;
  const caller = attachC10NativeCaller(store, { appendSourceEvent() { beforeDrain = session.queue.length === before; throw new Error('disk-full'); }, appendSignal() {}, unknown() { throw new Error('disk-full'); } });
  try { assert.equal(store.save(world), undefined); assert.equal(beforeDrain, true); assert.equal(session.queue.length, before);
    assert.equal(session.lostEvents, 0); assert.equal(session.lostGaps, 0); assert.equal(caller.status().ingestionAllowed, false); }
  finally { caller.detach(); store.close(); }
});
