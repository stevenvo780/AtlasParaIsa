import type { World } from './index.js';
import type { ChronicleEvent } from '../shared/types.js';
import { CHUNK_SIZE, MAX_COORDINATE, type Chunk } from './terrain.js';
import type { ClimateObservation } from './offscreen-kernel.js';
import { assertChunkLife, assertDormantTerrain } from './validation.js';

export interface RegionHead { key: string; asOfTick: number; }
export interface EcologySummary { regions: number; sumTicks: number; oldestTick: number | null; }
export interface EcologyReader {
  read(key: string, revision: number): Chunk | null;
  oldest(revision: number, limit: number, excluded: string[], cursor: string | null): RegionHead[];
  summary(revision: number): EcologySummary;
  climate(from: number, through: number, revision: number): ClimateObservation[];
}
export interface EcologyState {
  version: 1;
  originTick: 0;
  revision: number;
  committedRevision: number;
  cursor: string | null;
  jobsPerPulse: number;
  chunkTicksPerJob: number;
  workedChunkTicks: number;
  migrations: number;
  jobs: number;
  preparedForTick: number | null;
  preparedSeams: string[];
  preparing: string[];
  summary: EcologySummary;
  pending: { key: string; chunk: Chunk | null }[];
  pendingClimate: ClimateObservation[];
  pendingEvents: ChronicleEvent[];
}
export const MAX_PENDING_REGIONS = 512;
export function assertRegionKey(key: unknown): asserts key is string {
  if (typeof key !== 'string') throw new Error('Invalid ecological region key.');
  const [cx, cy, extra] = key.split(',').map(Number), limit = MAX_COORDINATE / CHUNK_SIZE;
  if (extra !== undefined || !Number.isSafeInteger(cx) || !Number.isSafeInteger(cy) || Math.abs(cx!) > limit || Math.abs(cy!) > limit
    || cx! >= limit || cy! >= limit || `${cx},${cy}` !== key) throw new Error('Invalid ecological region key.');
}
export function assertEcologyState(world: World): void {
  const state = world.ecology;
  if (state === undefined) return;
  const safe = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
  const fail = (): never => { throw new Error('Invalid continuous ecology state.'); };
  if (!state || state.version !== 1 || state.originTick !== 0 || !safe(state.revision) || !safe(state.committedRevision, state.revision)
    || state.revision - state.committedRevision > 1 || !safe(state.jobsPerPulse, 8) || state.jobsPerPulse < 2
    || !safe(state.chunkTicksPerJob, 64) || state.chunkTicksPerJob < 2 || !safe(state.workedChunkTicks) || !safe(state.migrations)
    || !safe(state.jobs) || !(state.preparedForTick === null || state.preparedForTick === world.tick)
    || !Array.isArray(state.preparedSeams) || state.preparedSeams.length > 2 || new Set(state.preparedSeams).size !== state.preparedSeams.length
    || !Array.isArray(state.preparing) || state.preparing.length > 256 || new Set(state.preparing).size !== state.preparing.length
    || !Array.isArray(state.pending) || state.pending.length > MAX_PENDING_REGIONS || new Set(state.pending.map(item => item.key)).size !== state.pending.length
    || !Array.isArray(state.pendingClimate) || state.pendingClimate.length > 2
    || !Array.isArray(state.pendingEvents) || state.pendingEvents.length > 65536) fail();
  const serial = (event: ChronicleEvent) => {
    const id = /^e([1-9]\d*)$/.exec(event.id);
    if (!id || !safe(Number(id[1]), world.eventCounter) || !safe(event.tick, world.tick)
      || event.observedAt !== undefined && (!safe(event.observedAt, world.tick) || event.observedAt < event.tick)) fail();
    return Number(id![1]);
  };
  let eventSerial = 0;
  for (const event of world.events) { const next = serial(event); if (next <= eventSerial) fail(); eventSerial = next; }
  if (eventSerial !== world.eventCounter) fail();
  eventSerial = 0;
  for (const event of state.pendingEvents) {
    const next = serial(event);
    if (next <= eventSerial || !['ecology','meeting','care','learning','adaptation','memory','gesture','pause','discovery','settlement','cooperation','birth','community','conflict','animal','invention','death'].includes(event.kind)
      || !['simulation','sample','approved'].includes(event.source)
      || typeof event.text !== 'string' || event.text.length > 2000 || typeof event.cause !== 'string' || event.cause.length > 2000
      || !Array.isArray(event.actors) || event.actors.length > 32 || event.actors.some(actor => typeof actor !== 'string' || actor.length > 100)) fail();
    eventSerial = next;
  }
  if (state.cursor !== null) assertRegionKey(state.cursor);
  for (const key of state.preparing) { assertRegionKey(key); if (world.chunks[key]) fail(); }
  if (state.preparedForTick !== null && state.preparing.length) fail();
  for (const key of state.preparedSeams) { assertRegionKey(key); if (!world.chunks[key] || state.preparedForTick === null) fail(); }
  const summary = state.summary;
  if (!summary || !safe(summary.regions) || !safe(summary.sumTicks) || !safe(summary.regions * world.tick - summary.sumTicks)
    || (summary.regions === 0 ? summary.oldestTick !== null || summary.sumTicks !== 0 : !safe(summary.oldestTick, world.tick))) fail();
  for (const item of state.pending) {
    assertRegionKey(item.key);
    if (item.chunk !== null) {
      if (!item.chunk || item.chunk.key !== item.key || world.chunks[item.key]) fail();
      assertDormantTerrain(item.chunk, world.tick, true); assertChunkLife(item.chunk, item.chunk.lastTick);
    } else if (!world.chunks[item.key]) fail();
  }
  let previous = -1;
  for (const observation of state.pendingClimate) {
    if (!observation || !safe(observation.tick, world.tick) || observation.tick <= previous || observation.tick % 600 !== 0
      || !['clear', 'rain'].includes(observation.weather)) fail();
    previous = observation.tick;
  }
  for (const chunk of Object.values(world.chunks)) if (chunk.lastTick !== world.tick) fail();
  if (world.retiredChunks.length) fail();
}
/** New publications begin at zero. Existing V6 worlds retain their explicit old
 * law; no missing past climate or chemical inventory is invented by this opt-in. */
export function enableContinuousEcology(world: World, options: { jobsPerPulse?: number; chunkTicksPerJob?: number } = {}): void {
  if (world.ecology !== undefined) { assertEcologyState(world); return; }
  if (world.tick !== 0 || world.retiredChunks.length || Object.values(world.chunks).some(chunk => chunk.lastTick !== 0))
    throw new Error('Continuous ecology requires a new world at tick zero.');
  const state: EcologyState = { version: 1, originTick: 0, revision: 0, committedRevision: 0, cursor: null,
    jobsPerPulse: options.jobsPerPulse ?? 2, chunkTicksPerJob: options.chunkTicksPerJob ?? 8,
    workedChunkTicks: 0, migrations: 0, jobs: 0, preparedForTick: null, preparedSeams: [], preparing: [],
    summary: { regions: 0, sumTicks: 0, oldestTick: null }, pending: [], pendingClimate: [{ tick: 0, weather: world.weather }], pendingEvents: [] };
  assertEcologyState({ ...world, ecology: state });
  world.ecology = state;
}
export function queueRegion(world: World, key: string, chunk: Chunk | null): void {
  const state = world.ecology!;
  const previous = state.pending.find(item => item.key === key);
  if (previous) previous.chunk = chunk;
  else {
    if (state.pending.length >= MAX_PENDING_REGIONS) throw new Error('Ecological pending queue is full; commit the draft first.');
    state.pending.push({ key, chunk });
  }
}
export function ecologyStateForCommit(state: EcologyState): EcologyState {
  return { ...state, committedRevision: state.revision, pending: [], pendingClimate: [], pendingEvents: [] };
}
export function markEcologyCommitted(world: World): void {
  if (!world.ecology) return;
  world.ecology.committedRevision = world.ecology.revision; world.ecology.pending = []; world.ecology.pendingClimate = []; world.ecology.pendingEvents = [];
}
