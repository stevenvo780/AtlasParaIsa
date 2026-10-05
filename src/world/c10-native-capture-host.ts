/** COW host proposal only. NOT compiled, installed or executed.
 * Call from native finalizer after its actual durable COMMIT acknowledgement.
 * The independent capture writer pins these bytes before session export.
 * It must retain the actual store ledger/transaction receipt and source Git
 * object proof. Neither a fulfilled step nor adopted is a COMMIT substitute.
 */
import { observedEvents, type ObservationSession } from './observation.js';

export type NativeCommitReceipt = Readonly<{
  schema: 'native-finalizer-commit/v1'; eventRefs: readonly string[];
  operation: 'COMMIT'; durable: true; nativeTransactionId: string;
  runId: string; epochId: string; sourceSHA: string; attemptId: string;
}>;
export type IndependentCaptureSink = Readonly<{
  appendSourceEvent(event: ReturnType<typeof observedEvents>[number]): void;
  appendNativeCommit(receipt: NativeCommitReceipt): void;
}>;

/** No sorting, synthesis of ordinals, source actor inference, or World writes.
 * Sink writes are observational and need A/B/C parity and overhead QA.
 * Capture failure closes ingestion; it must never change physical adoption.
 */
export function captureAfterNativeCommit(
  session: ObservationSession, receipt: NativeCommitReceipt,
  sink: IndependentCaptureSink, alreadyCapturedEventIds: Set<string>,
): { captureComplete: boolean } {
  if (receipt.schema !== 'native-finalizer-commit/v1'
      || receipt.operation !== 'COMMIT' || receipt.durable !== true || !receipt.nativeTransactionId
      || receipt.runId !== session.runId || receipt.epochId !== session.epochId
      || receipt.sourceSHA !== session.sourceSHA) return { captureComplete: false };
  try {
    // This host capture runs before adapter-session serialization and before
    // the observation queue is drained. Independent byte pins are assigned by
    // the capture owner; the adapter never builds its own evidenceIndex.
    for (const event of observedEvents(session)) {
      if (alreadyCapturedEventIds.has(event.sourceEventId)) continue;
      sink.appendSourceEvent(event);
      alreadyCapturedEventIds.add(event.sourceEventId);
    }
    sink.appendNativeCommit(receipt);
    return { captureComplete: true };
  } catch { return { captureComplete: false } }
}
