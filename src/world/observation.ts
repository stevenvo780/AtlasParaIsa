/** Private, opt-in observation channel. No state here is part of World or Store. */
export type AttemptState = 'started' | 'adopted' | 'discarded' | 'restored' | 'partial' | 'durable';
export type ObservationQuality = 'COMPLETE' | 'PARTIAL';
export type ObservationGap = Readonly<{ attemptId: string | null; tick: number | null; siteId: string; reason: string }>;
export type ObservationEvent = Readonly<{
  sourceEventId: string; runId: string; epochId: string; attemptId: string;
  tick: number; sourceSHA: string; siteId: string; phaseId: string;
  phaseOrdinal: number; eventOrdinal: number; payload: unknown;
}>;
export interface ObservationSession {
  readonly runId: string;
  readonly epochId: string;
  readonly sourceSHA: string;
  readonly capacity: number;
  readonly attemptHistory: Map<string, Array<Readonly<{ state: AttemptState; commitRef?: string }>>>;
  readonly queue: ObservationEvent[];
  readonly gaps: ObservationGap[];
  lostEvents: number;
  lostGaps: number;
  nextAttempt: number;
}
interface Binding {
  session: ObservationSession;
  attemptId: string | null;
  tick: number | null;
  phaseId: string;
  phaseOrdinal: number;
  eventOrdinal: number;
}
// v7 source observer 'c10-source-observer/v7' (CANDIDATE). Observes the existing bus, never supplies ordinals.
// The source's own mutation sites (queue push/shift, gaps push, attemptHistory set/push) journal one O(1) op each; a
// checkpoint flushes the ops since the previous one. No container is rescanned. Records are deep-frozen and encoded once.
// O(1) tripwires (container identity, lengths, Map size, drained head identity) detect length-changing or head writes by
// foreign holders of the mutable refs; same-length in-place foreign writes are UNKNOWN by contract (never claimed).
// Any tripwire, unsupported shape or tap failure fails closed: tapFailures + tap detached. No Proxy/getter/trap/rescan.
type Tap = (row: unknown) => void;
interface Journal { seq: number; ops: unknown[]; queue: unknown[]; gaps: unknown[]; history: Map<string, unknown[]>;
  qLen: number; gLen: number; hSize: number; ring: unknown[]; head: number; capacity: number; last: Map<string, unknown>; }
const taps = new WeakMap<ObservationSession, Tap>();
const tapFailures = new WeakSet<ObservationSession>();
const journals = new WeakMap<ObservationSession, Journal>();
const ancestry = new WeakMap<object, string[]>();
const UNSUPPORTED = Object.freeze({});
const ownDesc = Reflect.getOwnPropertyDescriptor, ownKeys = Reflect.ownKeys, protoOf = Reflect.getPrototypeOf;
const isFrozen = Object.isFrozen, isArray = Array.isArray, apply = Reflect.apply, objectIs = Object.is;
const OBJ = Object.prototype, ARR = Array.prototype, MAP = Map.prototype;
const mapSize = ownDesc(MAP, 'size')!.get!, mapGet = MAP.get;
function f64(x: number): string { const v = new DataView(new ArrayBuffer(8)); v.setFloat64(0, x); let h = '';
  for (let i = 0; i < 8; i++) h += (v.getUint8(i) + 0x100).toString(16).slice(1); return h; }
function dataValue(o: object, k: PropertyKey): unknown {
  const d = ownDesc(o, k); if (!d || !('value' in d)) throw UNSUPPORTED; return d.value; }
function scalar(v: unknown): unknown[] {
  switch (typeof v) {
    case 'undefined': return ['u']; case 'boolean': return ['b', v ? 1 : 0]; case 'string': return ['s', v];
    case 'number': return ['d', f64(v)]; case 'bigint': return ['i', v.toString()];
    case 'object': if (v === null) return ['z']; throw UNSUPPORTED;
    default: throw UNSUPPORTED; // symbol, function
  }
}
/** Encodes a deep-frozen plain record once (O(record size)); shared sub-objects become local refs. */
function encodeRecord(value: unknown): unknown[] {
  const local = new Map<object, number>();
  const enc = (v: unknown): unknown[] => {
    if (v === null || typeof v !== 'object') return scalar(v);
    const seen = local.get(v); if (seen !== undefined) return ['r', seen];
    if (!isFrozen(v)) throw UNSUPPORTED; const k = local.size; local.set(v, k); const proto = protoOf(v);
    if (isArray(v)) {
      if (proto !== ARR) throw UNSUPPORTED; const n = dataValue(v, 'length') as number;
      if (ownKeys(v).length !== n + 1) throw UNSUPPORTED; const out: unknown[] = [];
      for (let i = 0; i < n; i++) out.push(enc(dataValue(v, String(i)))); return ['a', k, out];
    }
    if (proto !== OBJ && proto !== null) throw UNSUPPORTED; const out: unknown[] = [];
    for (const key of ownKeys(v)) { if (typeof key !== 'string') throw UNSUPPORTED;
      const d = ownDesc(v, key)!; if (!('value' in d) || !d.enumerable) throw UNSUPPORTED; out.push([key, enc(d.value)]); }
    return [proto === null ? 'n' : 'o', k, out];
  };
  return enc(value);
}
function failJournal(session: ObservationSession): void { journals.delete(session); taps.delete(session); tapFailures.add(session); }
/** Source mutation hook: called right after the source's own write, same call site; never throws into the source. */
function note(session: ObservationSession, op: 'q+' | 'q-' | 'g+' | 'h=' | 'h+', item: unknown, key?: string, list?: unknown[]): void {
  const j = journals.get(session); if (!j) return;
  try {
    if (op === 'q+') {
      if (j.qLen >= j.capacity || dataValue(j.queue, 'length') !== j.qLen + 1 || dataValue(j.queue, String(j.qLen)) !== item) throw UNSUPPORTED;
      j.ops.push(['q+', encodeRecord(item)]); j.ring.push(item); j.qLen++;
    } else if (op === 'q-') {
      if (j.head >= j.ring.length || j.ring[j.head] !== item || dataValue(j.queue, 'length') !== j.qLen - 1) throw UNSUPPORTED;
      j.ring[j.head++] = undefined; j.qLen--; j.ops.push(['q-']);
      if (j.head > 1024 && j.head * 2 > j.ring.length) { j.ring = j.ring.slice(j.head); j.head = 0; } // amortized O(1)
    } else if (op === 'g+') {
      if (dataValue(j.gaps, 'length') !== j.gLen + 1 || dataValue(j.gaps, String(j.gLen)) !== item) throw UNSUPPORTED;
      j.ops.push(['g+', encodeRecord(item)]); j.gLen++;
    } else if (op === 'h=') {
      if (apply(mapSize, j.history, []) !== j.hSize + 1 || apply(mapGet, j.history, [key]) !== list
        || dataValue(list!, 'length') !== 1 || dataValue(list!, '0') !== item) throw UNSUPPORTED;
      j.ops.push(['h=', key, encodeRecord(item)]); j.hSize++;
    } else {
      const n = dataValue(list!, 'length') as number; if (dataValue(list!, String(n - 1)) !== item) throw UNSUPPORTED;
      j.ops.push(['h+', key, n - 1, encodeRecord(item)]); // reader verifies index == its own length for that attempt
    }
  } catch { failJournal(session); } // never inspect opaque exceptions
}
export function attachSourceTap(session: ObservationSession, tap: Tap): () => void {
  if (taps.has(session) || session.nextAttempt || session.queue.length) throw new Error('tap must precede first attempt');
  taps.set(session, tap);
  try {
    const queue = dataValue(session, 'queue') as unknown[], gaps = dataValue(session, 'gaps') as unknown[];
    const history = dataValue(session, 'attemptHistory') as Map<string, unknown[]>;
    if (protoOf(queue) !== ARR || protoOf(gaps) !== ARR || protoOf(history) !== MAP || ownKeys(history).length
      || apply(mapSize, history, []) !== 0 || dataValue(queue, 'length') !== 0) throw UNSUPPORTED;
    const gLen = dataValue(gaps, 'length') as number; const initial: unknown[] = [];
    for (let i = 0; i < gLen; i++) initial.push(encodeRecord(dataValue(gaps, String(i)))); // one-time, <= capacity
    journals.set(session, { seq: 0, ops: [['init', initial]], queue, gaps, history, qLen: 0, gLen, hSize: 0, ring: [], head: 0,
      capacity: dataValue(session, 'capacity') as number, last: new Map() });
  } catch { failJournal(session); }
  checkpointSession(session, 'initial', null);
  return () => { taps.delete(session); journals.delete(session); };
}
export function sourceTapFailed(session: ObservationSession): boolean { return tapFailures.has(session); }
export function observationLineage(world: object): readonly string[] {
  const b = bindings.get(world); const prior = ancestry.get(world) ?? [];
  return Object.freeze(b?.attemptId && !prior.includes(b.attemptId) ? [...prior, b.attemptId] : [...prior]);
}
const ROOT = ['runId', 'epochId', 'sourceSHA', 'capacity', 'nextAttempt', 'lostEvents', 'lostGaps'] as const;
function checkpointSession(session: ObservationSession, operation: string, binding: Binding | null): void {
  const tap = taps.get(session); const j = journals.get(session); if (!tap || !j) return;
  try { // O(1 + ops since previous checkpoint + bytes of newly defined records): no container is read beyond tripwires
    if (dataValue(session, 'queue') !== j.queue || dataValue(session, 'gaps') !== j.gaps || dataValue(session, 'attemptHistory') !== j.history
      || protoOf(j.queue) !== ARR || protoOf(j.gaps) !== ARR || protoOf(j.history) !== MAP
      || dataValue(j.queue, 'length') !== j.qLen || dataValue(j.gaps, 'length') !== j.gLen || apply(mapSize, j.history, []) !== j.hSize
      || (j.qLen > 0 && dataValue(j.queue, '0') !== j.ring[j.head])) throw UNSUPPORTED;
    const root: unknown[] = [];
    for (const k of ROOT) { const v = dataValue(session, k); if (!j.last.has(k) || !objectIs(j.last.get(k), v)) { root.push([k, scalar(v)]); j.last.set(k, v); } }
    const b = binding ? [binding.attemptId, binding.tick, binding.phaseId, binding.phaseOrdinal, binding.eventOrdinal].map(scalar) : null;
    const ops = j.ops; j.ops = [];
    tap({ protocol: 'c10-source-observer/v7', seq: j.seq++, operation, binding: b, root, ops });
  } catch { failJournal(session); } // never inspect opaque exceptions
}
function checkpoint(binding: Binding, operation: string): void { checkpointSession(binding.session, operation, binding); }
const bindings = new WeakMap<object, Binding>();
const sourceOwners = new WeakMap<object, object>();
const sourceActors = new WeakMap<object, string>();
export function bindObservationSource(source: object, world: object, actorId?: string): void {
  if (bindings.has(world)) { sourceOwners.set(source, world); if (actorId) sourceActors.set(source, actorId); }
}
export function observationSourceActor(source: object): string | null { return sourceActors.get(source) ?? null; }
export function unbindObservationSource(source: object): void { sourceOwners.delete(source); sourceActors.delete(source); }
const bindingFor = (source: object): Binding | undefined => bindings.get(source) ?? bindings.get(sourceOwners.get(source) ?? source);
const PRIVATE_KEYS = /^(?:name|title|text|description|reasonText|recentMemory|memories|letter|carta|password|secret|token|auth|credential)$/i;

export function createObservationSession(input: { runId: string; epochId: string; sourceSHA: string; capacity?: number }): ObservationSession {
  if (!input.runId || !input.epochId || !/^[a-f0-9]{40}$/.test(input.sourceSHA)) throw new Error('Invalid observation identity');
  const capacity = input.capacity ?? 8192;
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid observation capacity');
  return { ...input, capacity, attemptHistory: new Map(), queue: [], gaps: [], lostEvents: 0, lostGaps: 0, nextAttempt: 0 };
}
export function bindObservation(world: object, session: ObservationSession, attemptId?: string): void {
  const prior = attemptId ? [...session.attemptHistory.keys()].find(key => key === attemptId) : undefined;
  if (attemptId && !prior) throw new Error('Unknown observation attempt');
  ancestry.set(world, []);
  bindings.set(world, { session, attemptId: attemptId ?? null, tick: null, phaseId: 'unentered', phaseOrdinal: -1, eventOrdinal: 0 });
}
export function unbindObservation(world: object): void { bindings.delete(world); }
export function observationSession(world: object): ObservationSession | undefined { return bindings.get(world)?.session; }
export function observationAttempt(world: object): string | null { return bindings.get(world)?.attemptId ?? null; }
export function beginObservationAttempt(world: object, tick: number): string {
  const binding = bindings.get(world);
  if (!binding) throw new Error('Observation not bound');
  if (!Number.isSafeInteger(tick)) throw new Error('Invalid observation tick');
  const attemptId = `${binding.session.runId}:${binding.session.epochId}:attempt-${++binding.session.nextAttempt}`;
  binding.attemptId = attemptId;
  binding.tick = tick;
  binding.phaseId = 'step';
  binding.phaseOrdinal = 0;
  binding.eventOrdinal = 0;
  const started = Object.freeze({ state: 'started' as const }), history = [started]; // v7: entry frozen (type is Readonly)
  binding.session.attemptHistory.set(attemptId, history); note(binding.session, 'h=', started, attemptId, history);
  checkpoint(binding, 'begin');
  return attemptId;
}
export function bindObservationAttempt(fromWorld: object, toWorld: object): void {
  const from = bindings.get(fromWorld);
  if (!from || !from.attemptId) throw new Error('No source observation attempt');
  bindings.set(toWorld, { ...from });
  ancestry.set(toWorld, [...(ancestry.get(fromWorld) ?? [])]);
  checkpoint(from, 'fork');
}
export function endObservationAttempt(world: object): void {
  const binding = bindings.get(world);
  if (!binding) return;
  binding.attemptId = null; binding.tick = null; binding.phaseId = 'unentered';
  binding.phaseOrdinal = -1; binding.eventOrdinal = 0;
  checkpoint(binding, 'end');
}
export function enterObservationPhase(world: object, phaseId: string): void {
  const binding = bindings.get(world);
  if (!binding || !binding.attemptId) return;
  binding.phaseId = phaseId;
  binding.phaseOrdinal++;
  binding.eventOrdinal = 0;
  checkpoint(binding, 'phase');
}
export function markObservationAttempt(world: object, state: Exclude<AttemptState, 'started'>, commitRef?: string): void {
  const binding = bindings.get(world);
  if (!binding?.attemptId) return;
  const history = binding.session.attemptHistory.get(binding.attemptId);
  if (history) { const entry = Object.freeze(commitRef ? { state, commitRef } : { state }); history.push(entry); note(binding.session, 'h+', entry, binding.attemptId, history); }
  if (state === 'adopted') { const prior = ancestry.get(world) ?? [];
    if (!prior.includes(binding.attemptId)) ancestry.set(world, [...prior, binding.attemptId]); }
  checkpoint(binding, 'mark');
  if (state === 'partial' || state === 'discarded' || state === 'restored') {
    gap(binding, 'attempt', state);
  }
}
function gap(binding: Binding, siteId: string, reason: string): void {
  if (binding.session.gaps.length >= binding.session.capacity) { binding.session.lostGaps++; checkpoint(binding, 'gap-overflow'); return; }
  const entry = Object.freeze({ attemptId: binding.attemptId, tick: binding.tick, siteId, reason });
  binding.session.gaps.push(entry); note(binding.session, 'g+', entry);
  checkpoint(binding, 'gap');
}
function validatePrivate(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error('Cycle in observation payload');
  seen.add(value);
  for (const [key, item] of Object.entries(value)) {
    if (PRIVATE_KEYS.test(key)) throw new Error('Private observation field');
    validatePrivate(item, seen);
  }
  seen.delete(value);
}
function freezeCopy(value: unknown): unknown {
  const copy = structuredClone(value);
  validatePrivate(copy);
  const freeze = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    for (const child of Object.values(node)) freeze(child);
    Object.freeze(node);
  };
  freeze(copy);
  return copy;
}
/** The factory runs only when bound and inside an attempt; failures degrade coverage. */
export function emitObserved(world: object, siteId: string, payloadFactory: () => unknown): void {
  const binding = bindingFor(world);
  if (!binding) return;
  if (!binding.attemptId || binding.tick === null) { gap(binding, siteId, 'outside-attempt'); return; }
  let payload: unknown;
  try { payload = freezeCopy(payloadFactory()); }
  catch { gap(binding, siteId, 'serialization-failed'); return; }
  if (binding.session.queue.length >= binding.session.capacity) {
    binding.session.lostEvents++;
    gap(binding, siteId, 'queue-overflow');
    return;
  }
  const eventOrdinal = ++binding.eventOrdinal;
  const sourceEventId = `${binding.attemptId}:${binding.tick}:${binding.phaseOrdinal}:${eventOrdinal}:${siteId}`;
  const event = Object.freeze({
    sourceEventId, runId: binding.session.runId, epochId: binding.session.epochId,
    attemptId: binding.attemptId, tick: binding.tick, sourceSHA: binding.session.sourceSHA,
    siteId, phaseId: binding.phaseId, phaseOrdinal: binding.phaseOrdinal, eventOrdinal, payload,
  });
  binding.session.queue.push(event); note(binding.session, 'q+', event);
  checkpoint(binding, 'emit');
}
export function observedEvents(session: ObservationSession): readonly ObservationEvent[] { return Object.freeze([...session.queue]); }
export function coverageStatus(session: ObservationSession): Readonly<{ quality: ObservationQuality; lostEvents: number; lostGaps: number; gaps: readonly ObservationGap[] }> {
  return Object.freeze({ quality: session.gaps.length || session.lostGaps ? 'PARTIAL' : 'COMPLETE',
    lostEvents: session.lostEvents, lostGaps: session.lostGaps, gaps: Object.freeze([...session.gaps]) });
}
/** Called by the harness after the physical decision; callback failures never propagate. */
export async function drainObservation(session: ObservationSession, sink: (event: ObservationEvent) => void | Promise<void>): Promise<void> {
  checkpointSession(session, 'drain-start', null);
  while (session.queue.length) {
    const event = session.queue.shift()!; note(session, 'q-', event);
    checkpointSession(session, 'drain-event', null);
    try { await sink(event); }
    catch { if (session.gaps.length >= session.capacity) session.lostGaps++;
      else { const entry = Object.freeze({ attemptId: event.attemptId, tick: event.tick, siteId: event.siteId, reason: 'callback-rejected' });
        session.gaps.push(entry); note(session, 'g+', entry); } }
  }
  checkpointSession(session, 'drain-end', null);
}
