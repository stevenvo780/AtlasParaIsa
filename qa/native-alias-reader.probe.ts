// AUTHORED_NOTRUN. Copy ONLY this fixture into candidate checkout/qa in the admitted capsule.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createObservationSession, attachSourceTap, bindObservation, beginObservationAttempt,
  enterObservationPhase, emitObserved, markObservationAttempt, sourceTapFailed } from '../src/world/observation.js';

// Independent expected graph: local references, own field order and raw IEEE bits.
function expected(value: unknown): unknown[] {
  const ids = new Map<object, number>();
  function enc(v: unknown): unknown[] {
    if (v === undefined) return ['u']; if (v === null) return ['z'];
    if (typeof v === 'string') return ['s', v]; if (typeof v === 'boolean') return ['b', +v];
    if (typeof v === 'bigint') return ['i', v.toString()];
    if (typeof v === 'number') { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, v);
      return ['d', Array.from({ length: 8 }, (_, i) => d.getUint8(i).toString(16).padStart(2, '0')).join('')]; }
    assert.equal(typeof v, 'object'); const o = v as object;
    if (ids.has(o)) return ['r', ids.get(o)]; const id = ids.size; ids.set(o, id);
    if (Array.isArray(o)) return ['a', id, o.map(enc)];
    return ['o', id, Object.keys(o).map(k => [k, enc(Object.getOwnPropertyDescriptor(o, k)!.value)])];
  }
  return enc(value);
}
function fixture(kind: 'trusted' | 'history-alias' | 'undrained-alias') {
  const session = createObservationSession({ runId: 'peer', epochId: 'candidate-v7', sourceSHA: 'a'.repeat(40), capacity: 16 });
  const checkpoints: unknown[] = []; const world = {};
  attachSourceTap(session, row => checkpoints.push({ row, expected: {
    queue: session.queue.map(expected), gaps: session.gaps.map(expected),
    history: [...session.attemptHistory].map(([id, h]) => [id, h.map(expected)]) } }));
  bindObservation(world, session); const id = beginObservationAttempt(world, 7); enterObservationPhase(world, 'fixed-phase');
  const shared = { ordered: [1, 2] };
  emitObserved(world, 'peer.fixed', () => ({ nan: NaN, negz: -0, big: 10n ** 30n, u: undefined, a: shared, b: shared }));
  emitObserved(world, 'peer.second', () => ({ fixed: 2 }));
  assert.equal(session.queue[0]!.sourceEventId, `${id}:7:1:1:peer.fixed`);
  assert.equal(session.queue[0]!.phaseOrdinal, 1); assert.equal(session.queue[0]!.eventOrdinal, 1);
  assert.deepEqual(Object.keys(session.queue[0]!), ['sourceEventId','runId','epochId','attemptId','tick','sourceSHA','siteId','phaseId','phaseOrdinal','eventOrdinal','payload']);
  assert.deepEqual(Object.keys(session.queue[0]!.payload as object), ['nan','negz','big','u','a','b']);
  if (kind === 'history-alias') session.attemptHistory.get(id)![0] = Object.freeze({ state: 'durable' });
  if (kind === 'undrained-alias') session.queue[1] = Object.freeze({ ...session.queue[1]!, siteId: 'foreign-replacement' });
  markObservationAttempt(world, 'adopted');
  assert.equal(sourceTapFailed(session), false); // BOTH alias cases remain invisible; this boolean cannot authorize PASS.
  return { kind, scope: kind === 'trusted' ? 'TRUSTED_SOURCE_FIXTURE' : 'UNKNOWN_UNSUPPORTED_EXTERNAL_ALIAS',
    checkpoints, tapFailed: sourceTapFailed(session), scientificAcceptance: false };
}
writeFileSync(process.argv[2]!, JSON.stringify({ nativeExecution: 'CONTROLLER_FIXTURE_ONLY',
  cases: ['trusted','history-alias','undrained-alias'].map(k => fixture(k as Parameters<typeof fixture>[0])) }), { flag: 'wx', mode: 0o600 });
