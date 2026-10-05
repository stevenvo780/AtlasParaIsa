import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Store } from './store.js';
import { observeC10Store } from './c10-store-commit-observer.js';
import { observationSession, observationLineage, observedEvents, sourceTapFailed, attachSourceTap,
  type ObservationSession } from '../world/observation.js';

export const COMPONENTS = ['snapshot', 'identity', 'authorship', 'inputs', 'chronicle', 'technology', 'terrain', 'metadata', 'sessions'] as const;
export type ComponentManifest = { tables: Record<string, string>; components: Record<typeof COMPONENTS[number], string> };
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export function stable(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify({ sqliteBigInt: value.toString() });
  if (value instanceof Uint8Array) return JSON.stringify({ sqliteBytes: Buffer.from(value).toString('hex') });
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable((value as Record<string, unknown>)[k])).join(',') + '}';
  const s = JSON.stringify(value); if (s === undefined) throw new Error('non-JSON data'); return s;
}
// Independent read transaction: all actual SQL tables, not slot0 alone. No PRAGMA changes.
export function readManifest(path: string): ComponentManifest {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('BEGIN');
    const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    const tables: Record<string, string> = {};
    for (const { name } of names) {
      const query = db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"'); query.setReadBigInts(true);
      const rows = query.all().map(row => {
        // Registration timestamp is excluded, physical history/identity/inputs remain complete.
        if (name === 'snapshots') { const { saved_at: _time, ...rest } = row; return rest; }
        return row;
      }).map(stable).sort();
      tables[name] = digest(stable(rows));
    }
    const group = (pattern: RegExp) => digest(stable(Object.fromEntries(Object.entries(tables).filter(([n]) => pattern.test(n)))));
    const components = { snapshot: group(/snapshot/), identity: group(/legacy|identit/), authorship: group(/legacy|events|technology|inputs/),
      inputs: group(/^inputs$/), chronicle: group(/events|chronicle/), technology: group(/technology/), terrain: group(/chunks|snapshot/),
      metadata: group(/^metadata$/), sessions: group(/^sessions$/) };
    db.exec('COMMIT'); return { tables, components };
  } finally { db.close(); }
}
export interface ExternalCapture {
  // Controller retains initial pin outside capture; adapter has no sealing API.
  append(kind: string, row: unknown): string;
}
export type ProcessReceipt = Readonly<{
  schema: 'c10-store-persistence-evidence/v1'; sqliteCommitReturnedOK: true;
  signalRef: string; captureRef: string; runId: string; epochId: string; sourceSHA: string;
  storeInstanceRef: string; dbCaptureRef: string; commitObservationRef: string;
  eventRefs: readonly string[]; attemptRefs: readonly string[]; snapshotDigest: string;
  componentFrontier: ComponentManifest; persistenceScope: 'PROCESS';
  processRecovery: 'verified' | 'UNKNOWN'; powerLoss: 'UNKNOWN';
}>;
export function attachProcessCaller(store: Store, session: ObservationSession, capture: ExternalCapture) {
  const storeInstanceRef = randomUUID(), dbCaptureRef = randomUUID();
  let unknown = false;
  const reconciled = new Set<string>();
  const pending: { receipt: ProcessReceipt; lineage: readonly string[] }[] = [];
  const detachTap = attachSourceTap(session, row => { capture.append('source-tap', row); });
  const detachStore = observeC10Store(store, signal => {
    try {
      if (observationSession(signal.world) !== session || sourceTapFailed(session)) throw new Error('capture ownership');
      const lineage = observationLineage(signal.world);
      const events = observedEvents(session); // before drain, preserve unsupported events too
      const signalRef = capture.append('store-signal', { sqliteCommitReturnedOK: true, snapshotDigest: signal.snapshotBodyDigest,
        runId: session.runId, epochId: session.epochId, sourceSHA: session.sourceSHA, storeInstanceRef, dbCaptureRef,
        attemptRefs: lineage, eventRefs: events.map(e => e.sourceEventId), capturePoint: 'post-COMMIT-before-ACK' });
      const componentFrontier = readManifest(store.path);
      const captureRef = capture.append('SQL-independent', { storeInstanceRef, dbCaptureRef, componentFrontier });
      const commitObservationRef = signalRef; // unique actual callback operation, never snapshot digest/nativeTxnId
      const receipt: ProcessReceipt = Object.freeze({ schema: 'c10-store-persistence-evidence/v1', sqliteCommitReturnedOK: true,
        signalRef, captureRef, runId: session.runId, epochId: session.epochId, sourceSHA: session.sourceSHA,
        storeInstanceRef, dbCaptureRef, commitObservationRef, attemptRefs: lineage,
        eventRefs: events.filter(e => lineage.includes(e.attemptId)).map(e => e.sourceEventId), snapshotDigest: signal.snapshotBodyDigest,
        componentFrontier, persistenceScope: 'PROCESS', processRecovery: 'UNKNOWN', powerLoss: 'UNKNOWN' });
      capture.append('process-receipt', receipt); pending.push({ receipt, lineage });
    } catch { unknown = true; } // no instanceof/getter/proxy/toString access to opaque error
  });
  return { detach() { detachStore(); detachTap(); }, status: () => ({ unknown: unknown || sourceTapFailed(session), normalAppIngestion: false }),
    reconcile() {
      return pending.filter(({receipt}) => !reconciled.has(receipt.commitObservationRef)).map(({ receipt, lineage }) => {
        const states = lineage.map(id => (session.attemptHistory.get(id) ?? []).map(h => h.state));
        const accepted = states.every(s => s.length === 2 && s[0] === 'started' && s[1] === 'adopted');
        const row = { commitObservationRef: receipt.commitObservationRef, ownershipReconciled: accepted,
          attemptRefs: accepted ? lineage : [], state: accepted ? 'RECONCILED' : 'UNKNOWN' };
        capture.append('lineage-reconciliation', row); if (accepted) reconciled.add(receipt.commitObservationRef); return row;
      });
    } };
}
// Read-backed cut occurs only AFTER actual Store.load; no opening backdated to COMMIT.
export function captureOpening(store: Store, capture: ExternalCapture) {
  const loaded = store.load(); if (!loaded || loaded.slot !== 0) return { state: 'UNKNOWN' as const };
  const componentFrontier = readManifest(store.path);
  return { state: 'READ_BACKED' as const, ref: capture.append('opening-read', { tick: loaded.world.tick, slot: loaded.slot,
    worldDigest: digest(stable(loaded.world)), componentFrontier, kind: 'AFTER_ACTUAL_STORE_LOAD' }) };
}
export function verifyReload(store: Store, copy: string, expected: ComponentManifest) {
  store.backup(copy); // VACUUM INTO consistent copy, never hot .db copy
  const reopened = new (store.constructor as new (path: string) => Store)(copy);
  try { const loaded = reopened.load(); const sourceLoaded = store.load(); const actual = readManifest(copy);
    return { verified: !!loaded && loaded.slot === 0 && stable(actual) === stable(expected) && !!sourceLoaded && digest(stable(sourceLoaded.world)) === digest(stable(loaded.world)), actual,
      worldDigest: loaded ? digest(stable(loaded.world)) : null };
  } finally { reopened.close(); }
}
