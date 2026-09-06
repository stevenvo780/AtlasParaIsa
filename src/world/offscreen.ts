import type { EcologyView } from '../shared/ecology.js';
import type { Viewport } from '../shared/types.js';
import type { World } from './index.js';
import { advanceColdGroup, type ClimateObservation } from './offscreen-kernel.js';
import { assertEcologyState, queueRegion, type EcologySummary, type RegionHead } from './offscreen-state.js';
import { activate, archivedRegion, bindWorldContext, maintainRegions, neededRegions, normalizeViewport, retireRegions, tileAt, worldContext, type WorldContext } from './spatial.js';
import { CHUNK_SIZE, MAX_COORDINATE, chunkKey } from './terrain.js';

const compare = (a: RegionHead, b: RegionHead, cursor: string | null) => a.asOfTick - b.asOfTick
  || Number(cursor !== null && a.key <= cursor) - Number(cursor !== null && b.key <= cursor) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
function oldest(world: World, context: WorldContext, limit: number): RegionHead[] {
  const state = world.ecology!, excluded = [...Object.keys(world.chunks), ...state.pending.map(item => item.key)];
  const persisted = context.ecologyReader!.oldest(state.committedRevision, limit, [...new Set(excluded)], state.cursor);
  const pending = state.pending.flatMap(item => item.chunk ? [{ key: item.key, asOfTick: item.chunk.lastTick }] : []);
  return [...persisted, ...pending].sort((a, b) => compare(a, b, state.cursor)).slice(0, limit);
}
export function refreshEcologySummary(world: World, context: WorldContext = worldContext(world)): void {
  if (!world.ecology) return;
  const state = world.ecology!, summary: EcologySummary = context.ecologyReader!.summary(state.committedRevision);
  for (const item of state.pending) {
    const before = context.ecologyReader!.read(item.key, state.committedRevision);
    if (before) { summary.regions--; summary.sumTicks -= before.lastTick; }
    if (item.chunk) { summary.regions++; summary.sumTicks += item.chunk.lastTick; }
  }
  summary.oldestTick = oldest(world, context, 1)[0]?.asOfTick ?? null;
  state.summary = summary;
}
function weatherWindow(world: World, context: WorldContext, from: number, through: number): ClimateObservation[] {
  const state = world.ecology!;
  const persisted = context.ecologyReader!.climate(from, through, state.committedRevision);
  const all = [...persisted, ...state.pendingClimate.filter(observation => observation.tick <= through)].sort((a, b) => a.tick - b.tick);
  const latest = all.filter(observation => observation.tick <= from).at(-1);
  return [...(latest ? [latest] : []), ...all.filter(observation => observation.tick > from)];
}
function neighbors(key: string): string[] {
  const [cx, cy] = key.split(',').map(Number);
  const limit = MAX_COORDINATE / CHUNK_SIZE;
  return [[cx! - 1, cy!], [cx!, cy! - 1], [cx! + 1, cy!], [cx!, cy! + 1]]
    .filter(([x, y]) => x! >= -limit && y! >= -limit && x! < limit && y! < limit).map(([x, y]) => `${x},${y}`);
}
function needsPromotion(world: World, context: WorldContext): RegionHead[] {
  return [...neededRegions(world)].flatMap(key => {
    if (world.chunks[key]) return [];
    const chunk = archivedRegion(world, key, context);
    return chunk && chunk.lastTick < world.tick ? [{ key, asOfTick: chunk.lastTick }] : [];
  }).sort((a, b) => compare(a, b, world.ecology!.cursor));
}

/** A pulse always gives its first job to the oldest region, independently of the
 * camera and promotion demand. Fine work is counted in CHUNK ticks, so a pair
 * advances at most half as many physical ticks as one region for the same cost.
 * Call on a draft, save even when !ready, and publish only after COMMIT. */
export function prepareEcology(world: World, context: WorldContext = worldContext(world)): { ready: boolean; work: number } {
  if (!world.ecology) return { ready: true, work: 0 };
  bindWorldContext(world, context);
  assertEcologyState(world);
  if (!context.ecologyReader) throw new Error('Ecology preparation requires an archive reader.');
  const state = world.ecology;
  if (state.revision !== state.committedRevision || state.revision === Number.MAX_SAFE_INTEGER)
    throw new Error('Commit or discard the current ecology draft before preparing another pulse.');
  // No API currently teleports. A caller must not move a human into unprepared
  // terrain and then use activation to conceal the stale physical placement.
  if (world.people.some(person => !tileAt(world, person))) throw new Error('Physical placement precedes the ecological promotion barrier.');
  state.revision++; state.preparedForTick = null; state.preparedSeams = [];
  let work = 0;
  for (let job = 0; job < state.jobsPerPulse; job++) {
    const demanded = job % 2 ? needsPromotion(world, context)[0] : undefined;
    const candidate = demanded ?? oldest(world, context, 1)[0];
    if (!candidate || candidate.asOfTick >= world.tick) continue;
    const first = archivedRegion(world, candidate.key, context)!;
    const neighbor = neighbors(first.key).filter(key => !world.chunks[key]).map(key => archivedRegion(world, key, context))
      .find(chunk => chunk && chunk.lastTick === first.lastTick);
    const group = neighbor ? [first, neighbor] : [first];
    const through = Math.min(world.tick, first.lastTick + Math.floor(state.chunkTicksPerJob / group.length));
    const batch = advanceColdGroup(world, group, weatherWindow(world, context, first.lastTick, through), state.chunkTicksPerJob);
    for (const chunk of batch.chunks) queueRegion(world, chunk.key, chunk);
    world.animalCounter = batch.animalCounter; world.animalDynamics = batch.animalDynamics; world.inventionDynamics = batch.inventionDynamics;
    for (const event of batch.events) {
      if (!Number.isSafeInteger(world.eventCounter + 1)) throw new Error('Ecological event allocator overflow.');
      if (state.pendingEvents.length >= 65536) throw new Error('Ecological event queue requires a commit.');
      const recorded = { ...event, id: `e${++world.eventCounter}` };
      state.pendingEvents.push(recorded); world.events.push(recorded);
      if (world.events.length > 120) world.events.shift();
    }
    work += batch.chunkTicks; state.workedChunkTicks += batch.chunkTicks; state.migrations += batch.migrations; state.jobs++;
    state.cursor = batch.chunks.at(-1)!.key;
  }
  state.preparing = needsPromotion(world, context).map(head => head.key);
  if (!state.preparing.length) {
    maintainRegions(world, context);
    // A bounded synchronized seam joins the active domain for its next real
    // environmental tick. Both fauna and resources can cross, then it retires.
    const keys = [...neededRegions(world)].sort(), joined = new Set<string>();
    for (const key of keys) for (const adjacent of neighbors(key)) {
      if (joined.size >= Math.min(2, state.jobsPerPulse * state.chunkTicksPerJob - work) || world.chunks[adjacent]) continue;
      const chunk = archivedRegion(world, adjacent, context);
      if (chunk?.lastTick === world.tick) { activate(world, chunk.cx * CHUNK_SIZE, chunk.cy * CHUNK_SIZE, context); joined.add(adjacent); }
    }
    state.preparedSeams = [...joined];
    state.preparedForTick = world.tick;
  }
  refreshEcologySummary(world, context); assertEcologyState(world);
  return { ready: state.preparedForTick === world.tick, work };
}

export function finishEcologyStep(world: World, context: WorldContext = worldContext(world)): void {
  if (!world.ecology) return;
  for (const chunk of Object.values(world.chunks)) chunk.lastTick = world.tick;
  world.ecology.workedChunkTicks += world.ecology.preparedSeams.length;
  world.ecology.preparedSeams = [];
  world.ecology.preparedForTick = null;
  retireRegions(world, neededRegions(world));
  refreshEcologySummary(world, context);
}
export function projectEcology(world: World, viewport?: Viewport, context: WorldContext = worldContext(world)): EcologyView | undefined {
  if (!world.ecology) return;
  const state = world.ecology, v = normalizeViewport(viewport), keys = new Set<string>();
  for (let y = v.y; y < v.y + v.height; y++) for (let x = v.x; x < v.x + v.width; x++) keys.add(chunkKey(x, y));
  return { version: 1, model: 'synchronized-regions-closed-different-time-borders', activeRegions: Object.keys(world.chunks).length,
    coldRegions: state.summary.regions, oldestTick: state.summary.oldestTick, debtChunkTicks: state.summary.regions * world.tick - state.summary.sumTicks,
    preparing: [...state.preparing], chunkTicksPerPulse: state.jobsPerPulse * state.chunkTicksPerJob,
    workedChunkTicks: state.workedChunkTicks, migrations: state.migrations,
    regions: [...keys].map(key => {
      if (world.chunks[key]) return { key, asOfTick: world.tick, status: 'active' as const };
      const chunk = archivedRegion(world, key, context);
      return { key, asOfTick: chunk?.lastTick ?? null, status: chunk ? 'cold' as const : 'unobserved' as const };
    }) };
}
