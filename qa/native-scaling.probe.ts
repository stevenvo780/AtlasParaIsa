// AUTHORED_NOTRUN: capsule fixture, fixed capacity and payload; no campaign/scheduler/Source claim.
import { writeFileSync } from 'node:fs';
import { cpuUsage } from 'node:process';
import { createObservationSession, attachSourceTap, bindObservation, beginObservationAttempt,
  enterObservationPhase, emitObserved, markObservationAttempt, endObservationAttempt, drainObservation,
  sourceTapFailed } from '../src/world/observation.js';
const attempts = Number(process.argv[3]);
if (![2722, 10888].includes(attempts)) throw new Error('predefined size');
async function sample(n: number, retain: boolean) {
  const rows: unknown[] = [], costs: { operation: string; cpuMicroseconds: number; checkpoints: number; ordinal: number }[] = [];
  let checkpoints = 0;
  const session = createObservationSession({ runId: 'cost', epochId: 'candidate-v7', sourceSHA: 'a'.repeat(40), capacity: 16384 });
  attachSourceTap(session, row => { checkpoints++; if (retain) rows.push(row); });
  const world = {}; bindObservation(world, session);
  function measure(operation: string, ordinal: number, body: () => void) {
    const before = checkpoints, t = cpuUsage(); body(); const d = cpuUsage(t);
    if (retain) costs.push({ operation, ordinal, checkpoints: checkpoints - before, cpuMicroseconds: d.user + d.system });
  }
  for (let a = 0; a < n; a++) {
    measure('begin', a, () => { beginObservationAttempt(world, a); });
    measure('phase', a, () => { enterObservationPhase(world, 'fixed'); });
    measure('emit', a, () => { emitObserved(world, 'fixed.site', () => ({ fixed: 1, negz: -0, nan: NaN, big: 10n ** 30n })); });
    measure('mark', a, () => { markObservationAttempt(world, 'adopted', 'fixed-commit'); });
    measure('end', a, () => { endObservationAttempt(world); });
  }
  const t = cpuUsage(), before = checkpoints; await drainObservation(session, () => {}); const d = cpuUsage(t);
  if (retain) costs.push({ operation: 'drain-total', ordinal: n, checkpoints: checkpoints - before, cpuMicroseconds: d.user + d.system });
  if (sourceTapFailed(session) || session.lostEvents || session.lostGaps) throw new Error('invalid scaling sample');
  return { rows, costs, checkpoints, lostEvents: session.lostEvents, lostGaps: session.lostGaps, sourceTapFailed: false };
}
await sample(128, false);
writeFileSync(process.argv[2]!, JSON.stringify({ attempts, capacity: 16384, measurement: 'ACTUAL_CPU_SOURCE_OPERATION_PLUS_TAP_CALLBACK',
  scientificAcceptance: false, ...await sample(attempts, true) }), { flag: 'wx', mode: 0o600 });
