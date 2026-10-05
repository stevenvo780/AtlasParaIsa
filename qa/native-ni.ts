// AUTHORED NOT RUN. Small paired technical replay; no scientific campaign.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Store } from '../src/server/store.js';
import { createWorld, stepWorld, observeWorldOpening, bindWorldContext } from '../src/world/index.js';
import { beginObservationAttempt, bindObservation, createObservationSession, drainObservation, endObservationAttempt, markObservationAttempt, coverageStatus } from '../src/world/observation.js';
import { attachC10NativeCaller, saveWithC10Capture } from '../src/server/c10-native-commit-caller.js';
import { createFsyncSidecar } from '../src/server/c10-fsync-sidecar.js';

const [mode, output, verifiedProof] = process.argv.slice(2);
if (!['A', 'B', 'C'].includes(mode) || !output || !verifiedProof) throw new Error('mode A|B|C OUTPUT VERIFIED_SOURCE_PROOF');
// source_guard must verify the entire effective tree immediately before this.
// Recheck captured commit bytes here; hash format alone is never accepted.
const proof = JSON.parse(readFileSync(verifiedProof, 'utf8')) as { sourceSHA: string; commit: { path: string; sha256: string } };
const raw = readFileSync(new URL(proof.commit.path, 'file://' + verifiedProof));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
if (hash(raw) !== proof.commit.sha256 || createHash('sha1').update(Buffer.from(`commit ${raw.length}\0`)).update(raw).digest('hex') !== proof.sourceSHA) throw new Error('genuine source commit mismatch');
mkdirSync(output, { mode: 0o700 });
const store = new Store(join(output, 'QA.sqlite')); const world = createWorld(20260905);
bindWorldContext(world, { loadChunk: (key, tick) => store.loadChunk(key, tick), catalogueReader: store.catalogueReader, loadLegacy: (id, tick) => store.loadLegacy(id, tick) });
const session = createObservationSession({ runId: 'technical-native-QA', epochId: mode, sourceSHA: proof.sourceSHA, capacity: 100000 });
const sink = mode === 'C' ? createFsyncSidecar(join(output, 'capture')) : undefined;
const caller = sink ? attachC10NativeCaller(store, sink) : undefined;
if (mode === 'C') bindObservation(world, session);
const digests: string[] = []; const costs: number[] = [];
try {
  if (mode === 'C') { beginObservationAttempt(world, world.tick); observeWorldOpening(world); }
  saveWithC10Capture(store, world);
  if (mode === 'C') { markObservationAttempt(world, 'adopted'); endObservationAttempt(world); await drainObservation(session, () => {}); }
  for (let tick = 0; tick < 1200; tick++) {
    if (mode === 'C') beginObservationAttempt(world, world.tick + 1);
    const start = performance.now(); stepWorld(world);
    if (world.tick % 20 === 0) saveWithC10Capture(store, world);
    costs.push(performance.now() - start);
    if (mode === 'C') { markObservationAttempt(world, 'adopted'); endObservationAttempt(world);
      // Drain only after a COMMIT captures the whole pending window.
      if (world.tick % 20 === 0) await drainObservation(session, () => {}); }
    digests.push(hash(JSON.stringify(world))); // full physical state incl. RNG/journals
  }
  writeFileSync(join(output, 'NI.json'), JSON.stringify({ mode, digests, costs, coverage: coverageStatus(session),
    state: 'UNKNOWN', ingestionAllowed: false, scientificAcceptance: false, caller: caller?.status(), sidecar: sink?.status() }));
  process.stdout.write(JSON.stringify({ mode, ticks: 1200, physicalSHA256: hash(JSON.stringify(digests)), state: 'UNKNOWN' }) + '\n');
} finally { caller?.detach(); sink?.close(); store.close(); }
