/** Technical process-crash pilot. This contract cannot issue C21 or biological PASS. */
export const SCHEMA = 'c21-store-process-crash/v1' as const;
export const CASES = [
  { id: 'B01', phase: 'B01_BEFORE_BEGIN', committed: false, ack: false },
  { id: 'B02', phase: 'B02_AFTER_BEGIN', committed: false, ack: false },
  { id: 'A01', phase: 'AFTER_COMMIT_BEFORE_ACK', committed: true, ack: false },
  { id: 'ACK01', phase: 'AFTER_ACK', committed: true, ack: true },
] as const;
export type CaseId = typeof CASES[number]['id'];
export type Phase = typeof CASES[number]['phase'];
export const LIMITS = { cpuCount: 4, memoryGiB: 8, totalSeconds: 240,
  caseSeconds: 45, outputBytes: 512 * 1024 * 1024, receiptBytes: 2 * 1024 * 1024,
  databaseEncodedBytes: 128 * 1024 * 1024, databaseRows: 200_000 } as const;
export type BoundaryMessage = {
  schema: typeof SCHEMA; caseId: CaseId; sequence: number;
  kind: 'baseline' | 'candidate' | 'boundary' | 'store-api-ack';
  tick: number; gestureId: string; phase?: Phase;
  resultBody?: string; resultHash?: string;
  source: 'Store.save' | 'Store.result+independent-Store.load';
};
export function parseMessage(value: unknown): BoundaryMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_RECEIPT');
  const v = value as Record<string, unknown>;
  if (v.schema !== SCHEMA || !CASES.some(c => c.id === v.caseId)
    || !Number.isSafeInteger(v.sequence) || Number(v.sequence) < 1
    || !Number.isSafeInteger(v.tick) || Number(v.tick) < 0
    || typeof v.gestureId !== 'string' || !v.gestureId.startsWith('c21-technical-')
    || !['baseline', 'candidate', 'boundary', 'store-api-ack'].includes(String(v.kind))
    || !['Store.save', 'Store.result+independent-Store.load'].includes(String(v.source)))
    throw new Error('INVALID_RECEIPT');
  if (v.kind === 'boundary' && !CASES.some(c => c.phase === v.phase && c.id === v.caseId))
    throw new Error('BOUNDARY_CASE_MISMATCH');
  if ((v.kind === 'candidate' || v.kind === 'store-api-ack')
    && (typeof v.resultBody !== 'string' || typeof v.resultHash !== 'string'
      || !/^[0-9a-f]{64}$/.test(v.resultHash))) throw new Error('MISSING_RESULT_BINDING');
  if (v.kind === 'store-api-ack' && (v.phase !== 'AFTER_ACK'
    || v.source !== 'Store.result+independent-Store.load')) throw new Error('NOT_A_STORE_API_ACK');
  return v as BoundaryMessage;
}
export interface CaseEvidence {
  caseId: CaseId; reached: Phase | null; killedByController: boolean;
  childExitSignal: string | null; ackReceived: boolean; recoveredResultMatches: boolean | null;
  recoveredResultPresent: boolean | null; recoveredTick: number | null;
  expectedTick: number; expectedFullDigest: string | null; recoveredFullDigest: string | null;
  independentPreKillRead: boolean; independentPostKillRead: boolean;
  sourcePinsUnchanged: boolean;
}
export function assess(e: CaseEvidence): {
  verdict: 'TECHNICAL_PASS' | 'FAIL' | 'UNKNOWN'; reasons: string[];
  scope: 'STORE_API_PROCESS_CRASH_ONLY'; scientificAcceptance: false;
} {
  const c = CASES.find(c => c.id === e.caseId);
  if (!c) throw new Error('UNKNOWN_CASE');
  const missing: string[] = [];
  if (e.reached !== c.phase) missing.push('PLANNED_BOUNDARY_NOT_OBSERVED');
  if (!e.killedByController || e.childExitSignal !== 'SIGKILL') missing.push('PROCESS_CRASH_UNVERIFIED');
  if (!e.independentPreKillRead || !e.independentPostKillRead
    || !e.expectedFullDigest || !e.recoveredFullDigest) missing.push('FULL_DATABASE_CUT_UNOBSERVED');
  if (e.recoveredTick === null) missing.push('STORE_LOAD_UNOBSERVED');
  if (e.recoveredResultPresent === null || (c.committed && e.recoveredResultMatches === null))
    missing.push('STORE_INPUT_RESULT_UNOBSERVED');
  const failures: string[] = [];
  if (!e.sourcePinsUnchanged) failures.push('SOURCE_PIN_CONTRADICTION');
  if ((e.reached === c.phase && e.ackReceived !== c.ack) || (e.ackReceived && !c.committed))
    failures.push('ACK_PHASE_CONTRADICTION');
  if (e.recoveredResultPresent !== null && e.recoveredResultPresent !== c.committed)
    failures.push('INPUT_COMMIT_CONTRADICTION');
  if (c.committed && e.recoveredResultMatches === false) failures.push('RESULT_CHANGED_OR_LOST');
  if (e.recoveredTick !== null && e.recoveredTick !== e.expectedTick) failures.push('RECOVERY_TICK_CONTRADICTION');
  if (e.expectedFullDigest && e.recoveredFullDigest && e.expectedFullDigest !== e.recoveredFullDigest)
    failures.push('FULL_DATABASE_CHANGED_OR_LOST');
  return { verdict: failures.length ? 'FAIL' : missing.length ? 'UNKNOWN' : 'TECHNICAL_PASS',
    reasons: [...failures, ...missing], scope: 'STORE_API_PROCESS_CRASH_ONLY', scientificAcceptance: false };
}
