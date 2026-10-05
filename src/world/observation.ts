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
// COW v3: external tap observes the existing bus, never supplies ordinals.
type Tap = (row: unknown) => void;
const taps = new WeakMap<ObservationSession, Tap>();
const tapFailures = new WeakSet<ObservationSession>();
const ancestry = new WeakMap<object, string[]>();
export function attachSourceTap(session: ObservationSession, tap: Tap): () => void {
  if (taps.has(session) || session.nextAttempt || session.queue.length) throw new Error('tap must precede first attempt');
  taps.set(session, tap); checkpointSession(session, 'initial', null);
  return () => { taps.delete(session); };
}
export function sourceTapFailed(session: ObservationSession): boolean { return tapFailures.has(session); }
export function observationLineage(world: object): readonly string[] {
  const b = bindings.get(world); const prior = ancestry.get(world) ?? [];
  return Object.freeze(b?.attemptId && !prior.includes(b.attemptId) ? [...prior, b.attemptId] : [...prior]);
}
function checkpointSession(session: ObservationSession, operation: string, binding: Binding | null): void {
  const tap = taps.get(session); if (!tap) return;
  try { tap(structuredClone({ operation, runId: session.runId, epochId: session.epochId, sourceSHA: session.sourceSHA,
    nextAttempt: session.nextAttempt, binding: binding ? { attemptId: binding.attemptId, tick: binding.tick,
      phaseId: binding.phaseId, phaseOrdinal: binding.phaseOrdinal, eventOrdinal: binding.eventOrdinal } : null,
    queue: [...session.queue], attemptHistory: Object.fromEntries(session.attemptHistory),
    gaps: [...session.gaps], lostEvents: session.lostEvents, lostGaps: session.lostGaps })); }
  catch { tapFailures.add(session); } // never inspect opaque exceptions
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
  binding.session.attemptHistory.set(attemptId, [{ state: 'started' }]);
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
  binding.session.attemptHistory.get(binding.attemptId)?.push(Object.freeze(commitRef ? { state, commitRef } : { state }));
  if (state === 'adopted') { const prior = ancestry.get(world) ?? [];
    if (!prior.includes(binding.attemptId)) ancestry.set(world, [...prior, binding.attemptId]); }
  checkpoint(binding, 'mark');
  if (state === 'partial' || state === 'discarded' || state === 'restored') {
    gap(binding, 'attempt', state);
  }
}
function gap(binding: Binding, siteId: string, reason: string): void {
  if (binding.session.gaps.length >= binding.session.capacity) { binding.session.lostGaps++; checkpoint(binding, 'gap-overflow'); return; }
  binding.session.gaps.push(Object.freeze({ attemptId: binding.attemptId, tick: binding.tick, siteId, reason }));
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
  binding.session.queue.push(Object.freeze({
    sourceEventId, runId: binding.session.runId, epochId: binding.session.epochId,
    attemptId: binding.attemptId, tick: binding.tick, sourceSHA: binding.session.sourceSHA,
    siteId, phaseId: binding.phaseId, phaseOrdinal: binding.phaseOrdinal, eventOrdinal, payload,
  }));
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
    const event = session.queue.shift()!;
    checkpointSession(session, 'drain-event', null);
    try { await sink(event); }
    catch { if (session.gaps.length >= session.capacity) session.lostGaps++;
      else session.gaps.push(Object.freeze({ attemptId: event.attemptId, tick: event.tick, siteId: event.siteId, reason: 'callback-rejected' })); }
  }
  checkpointSession(session, 'drain-end', null);
}
