import type { Store } from './store.js';
import { c10StoreHookStatus, observeC10Store } from './c10-store-commit-observer.js';
import { observedEvents, observationAttempt, observationSession, coverageStatus, type ObservationEvent } from '../world/observation.js';
import type { captureAfterNativeCommit } from '../world/c10-native-capture-host.js';

// The host contract remains pinned and exact. No receipt constructor or incoming
// attempt-ID argument exists here. A future native gate must establish its
// NativeCommitReceipt before this function can be called for physical ingestion.
export type DurableHostContract = typeof captureAfterNativeCommit;
export interface PassiveCaptureSink {
  appendSourceEvent(event: ObservationEvent): void;
  appendSignal(signal: unknown): void;
  unknown(reason: string): void;
}
export function attachC10NativeCaller(store: Store, sink: PassiveCaptureSink) {
  let failed = false;
  const detach = observeC10Store(store, signal => {
    try {
      const session = observationSession(signal.world);
      const attemptId = observationAttempt(signal.world);
      if (!session || !attemptId || !session.attemptHistory.has(attemptId)) throw new Error('unbound-native-attempt');
      const events = observedEvents(session);
      // Preserve ALL events, including unsupported sites and discarded attempts.
      // Consumer selection occurs independently, from source callsites and bytes.
      if (!events.some(e => e.attemptId === attemptId)) throw new Error('drain-before-capture-or-empty-attempt');
      const seen = new Set<string>();
      for (const event of events) {
        if (seen.has(event.sourceEventId)) throw new Error('duplicate-event');
        seen.add(event.sourceEventId);
        if (event.runId !== session.runId || event.epochId !== session.epochId
            || event.sourceSHA !== session.sourceSHA || !session.attemptHistory.has(event.attemptId)) throw new Error('event-ownership');
      }
      for (const event of events) sink.appendSourceEvent(event);
      sink.appendSignal({ schema: signal.schema, operation: signal.operation,
        sqliteReturnedOK: signal.sqliteReturnedOK, durable: 'UNKNOWN', nativeTransactionId: null,
        snapshotBodyDigest: signal.snapshotBodyDigest, runId: session.runId, epochId: session.epochId,
        sourceSHA: session.sourceSHA, attemptId, eventRefs: events.filter(e => e.attemptId === attemptId).map(e => e.sourceEventId),
        capturePoint: 'post-real-COMMIT-before-drain', coverage: coverageStatus(session) });
      // This remains an observational signal, never native-finalizer-commit/v1.
      sink.unknown('SQLITE_NORMAL_AND_NO_NATIVE_TRANSACTION_ID');
    } catch {
      failed = true;
      try { sink.unknown('hook-failure'); } catch { /* confined */ }
    }
  });
  return { detach, status: () => ({ state: 'UNKNOWN' as const, ingestionAllowed: false as const,
    hookFailed: failed || c10StoreHookStatus(store) === 'UNKNOWN' }) };
}

/** External runnable save caller. Return and errors are exactly Store.save's.
 * Capture happens synchronously inside the real post-COMMIT callback. Caller
 * owns any later drain; this function never drains or marks history durable. */
export function saveWithC10Capture(store: Store, ...args: Parameters<Store['save']>): ReturnType<Store['save']> {
  return store.save(...args);
}
