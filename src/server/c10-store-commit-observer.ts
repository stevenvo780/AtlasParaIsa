import type { World } from '../world/index.js';

/** In-process authority is the instrumented Store callsite, never caller strings.
 * No native transaction ID is exposed by DatabaseSync. A snapshot digest is NOT
 * a substitute. This callback therefore cannot issue NativeCommitReceipt. */
export type StoreCommitSignal = Readonly<{
  schema: 'c10-store-commit-signal/v1'; operation: 'COMMIT'; sqliteReturnedOK: true;
  durable: 'UNKNOWN'; nativeTransactionId: null; snapshotBodyDigest: string;
  world: World;
}>;
type Listener = (signal: StoreCommitSignal) => void;
const listeners = new WeakMap<object, Listener>();
const failures = new WeakMap<object, 'UNKNOWN'>();
export function observeC10Store(store: object, listener: Listener): () => void {
  if (listeners.has(store)) throw new Error('C10 Store already observed');
  listeners.set(store, listener);
  return () => { listeners.delete(store); };
}
export function c10StoreHookStatus(store: object): 'UNKNOWN' | 'NO_HOOK_EXCEPTION' {
  return failures.get(store) ?? 'NO_HOOK_EXCEPTION';
}
/** Called ONLY immediately after the save transaction's real db.exec COMMIT.
 * No observer exception can reach the original catch, return or cache work. */
export function notifyC10PostCommit(store: object, world: World, snapshotBodyDigest: string): void {
  const listener = listeners.get(store);
  if (!listener) return;
  try { listener(Object.freeze({ schema: 'c10-store-commit-signal/v1', operation: 'COMMIT',
    sqliteReturnedOK: true, durable: 'UNKNOWN', nativeTransactionId: null, snapshotBodyDigest, world })); }
  catch { failures.set(store, 'UNKNOWN'); }
}
