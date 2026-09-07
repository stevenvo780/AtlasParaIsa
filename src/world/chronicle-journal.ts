import type { ChronicleEvent } from '../shared/types.js';
import { MAX_COORDINATE } from './terrain.js';

/** Backpressure on uncommitted observations, never a silent history truncation. */
export const MAX_PENDING_CHRONICLE_EVENTS = 32_768;
export const EMPTY_CHRONICLE_DIGEST = '0'.repeat(64);
export interface ChronicleJournal {
  version: 1;
  startsAfter: number;
  committedThrough: number;
  committedDigest: string;
  pending: ChronicleEvent[];
}
export interface ChronicleHost {
  tick: number; eventCounter: number; events: ChronicleEvent[]; chronicleJournal?: ChronicleJournal;
}
const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
export function chronicleSerial(id: string): number | null {
  if (typeof id !== 'string' || !/^e[1-9]\d*$/.test(id)) return null;
  const serial = Number(id.slice(1)); return integer(serial) ? serial : null;
}
export function chronicleFailure(reason: string): never { throw new Error(`Chronicle journal ${reason}. Explicit recovery required.`); }
export function assertChronicleEvent(value: unknown, tick: number): asserts value is ChronicleEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) chronicleFailure('invalid event');
  const event = value as ChronicleEvent;
  const text = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.length <= max;
  const coordinate = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= -MAX_COORDINATE && v < MAX_COORDINATE;
  if (Object.keys(event).some(key => !['id','tick','kind','actors','text','cause','x','y','source'].includes(key))
    || !text(event.id,100) || !integer(event.tick) || event.tick > tick
    || !['ecology','meeting','care','learning','adaptation','memory','gesture','pause','discovery','settlement','cooperation','birth','community','conflict','animal','invention','death'].includes(event.kind)
    || !Array.isArray(event.actors) || event.actors.length > 32 || !Array.from(event.actors).every(id => text(id,100))
    || !text(event.text) || !text(event.cause) || !['simulation','sample','approved'].includes(event.source)
    || (event.x !== undefined && !coordinate(event.x)) || (event.y !== undefined && !coordinate(event.y))) chronicleFailure('invalid event');
}
export function assertChronicleJournal(world: ChronicleHost): void {
  const journal = world.chronicleJournal;
  if (journal === undefined) return;
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)
    || Object.keys(journal).sort().join(',') !== 'committedDigest,committedThrough,pending,startsAfter,version'
    || journal.version !== 1 || !integer(world.eventCounter) || !integer(world.tick)
    || !integer(journal.startsAfter) || !integer(journal.committedThrough)
    || journal.startsAfter > journal.committedThrough || journal.committedThrough > world.eventCounter
    || typeof journal.committedDigest !== 'string' || !/^[0-9a-f]{64}$/.test(journal.committedDigest)
    || journal.startsAfter === journal.committedThrough && journal.committedDigest !== EMPTY_CHRONICLE_DIGEST
    || !Array.isArray(journal.pending) || journal.pending.length > MAX_PENDING_CHRONICLE_EVENTS
    || journal.pending.length !== world.eventCounter - journal.committedThrough) chronicleFailure('invalid coverage');
  let tick = 0;
  for (let index = 0; index < journal.pending.length; index++) {
    const event = journal.pending[index]!; assertChronicleEvent(event, world.tick);
    if (chronicleSerial(event.id) !== journal.committedThrough + index + 1 || event.tick < tick) chronicleFailure('pending sequence has a gap');
    tick = event.tick;
  }
  let lastSerial = 0;
  for (const event of world.events) {
    assertChronicleEvent(event, world.tick);
    const serial = chronicleSerial(event.id);
    if (serial === null) continue; // Startup pause receipts have their own non-serial identity.
    if (serial <= lastSerial || serial > world.eventCounter) chronicleFailure('visible sequence is invalid');
    lastSerial = serial;
    if (serial > journal.committedThrough && JSON.stringify(journal.pending[serial - journal.committedThrough - 1]) !== JSON.stringify(event)) chronicleFailure('visible event disagrees with pending event');
    if (serial === journal.committedThrough && journal.pending.length && journal.pending[0]!.tick < event.tick) chronicleFailure('pending timeline regresses');
  }
}
/** Earlier receipts remain unverified; an old gap is never reconstructed or certified. */
export function enableChronicleJournal(world: ChronicleHost): void {
  if (world.chronicleJournal === undefined) {
    if (!integer(world.eventCounter)) chronicleFailure('invalid opening counter');
    world.chronicleJournal = { version: 1, startsAfter: world.eventCounter,
      committedThrough: world.eventCounter, committedDigest: EMPTY_CHRONICLE_DIGEST, pending: [] };
  }
  assertChronicleJournal(world);
}
/** Same event and field order as the original emitter; admission precedes every mutation. */
export function recordChronicleEvent(world: ChronicleHost, input: Omit<ChronicleEvent,'id'|'tick'>): ChronicleEvent {
  if (world.chronicleJournal === undefined) enableChronicleJournal(world);
  const journal = world.chronicleJournal!;
  if (journal.pending.length >= MAX_PENDING_CHRONICLE_EVENTS) throw new Error('Chronicle journal is full; commit before advancing the simulation.');
  if (!integer(world.eventCounter + 1) || journal.committedThrough + journal.pending.length !== world.eventCounter) chronicleFailure('invalid append boundary');
  const event = { ...input, id: `e${world.eventCounter + 1}`, tick: world.tick };
  assertChronicleEvent(event, world.tick);
  journal.pending.push(event); world.eventCounter++;
  return event;
}
export function chronicleForCommit(world: ChronicleHost, digest: string): ChronicleJournal {
  assertChronicleJournal(world);
  return { version: 1, startsAfter: world.chronicleJournal!.startsAfter,
    committedThrough: world.eventCounter, committedDigest: digest, pending: [] };
}
