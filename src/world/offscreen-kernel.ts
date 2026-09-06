import type { ChronicleEvent } from '../shared/types.js';
import type { AnimalDynamics, InventionDynamics } from '../shared/life.js';
import type { World } from './index.js';
import type { Chunk } from './terrain.js';
import { chunkKey } from './terrain.js';
import { assertAnimals, stepAnimals } from './animals.js';
import { stepStructures } from './inventions.js';
import { stepEcosystem } from './ecosystem.js';
import { updateEcosystemResources } from './ecology-resources.js';
import { phaseAt } from './time.js';
import { assertChunkLife, assertDormantTerrain, assertStructures } from './validation.js';

export interface ClimateObservation { tick: number; weather: 'clear' | 'rain'; }
export interface DelayedEcologyEvent extends Omit<ChronicleEvent, 'id' | 'tick'> {
  /** Physical time, distinct from the later host commit which observes it. */
  tick: number;
  observedAt: number;
}
export interface ColdBatch {
  chunks: Chunk[];
  animalCounter: number;
  animalDynamics: AnimalDynamics;
  inventionDynamics: InventionDynamics;
  events: DelayedEcologyEvent[];
  chunkTicks: number;
  migrations: number;
}

/** Every weather draw is archived, including unchanged weather. A deleted draw
 * cannot silently stretch its predecessor across an unobserved interval. */
export function assertClimateWindow(observations: ClimateObservation[], from: number, through: number): void {
  if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(through) || through < from
    || !observations.length || observations.length > 4) throw new Error('Invalid bounded climate window.');
  let previous = -1;
  for (const observation of observations) {
    if (!Number.isSafeInteger(observation.tick) || observation.tick < 0 || observation.tick <= previous
      || observation.tick > through || !['clear', 'rain'].includes(observation.weather)) throw new Error('Invalid climate observation.');
    previous = observation.tick;
  }
  if (observations[0]!.tick > from || observations[0]!.tick < Math.floor(from / 600) * 600
    || observations.slice(1).some(observation => observation.tick <= from || observation.tick % 600 !== 0))
    throw new Error('Climate does not cover the requested physical interval.');
  for (let tick = Math.floor(from / 600) * 600 + 600; tick <= through; tick += 600) {
    if (!observations.some(observation => observation.tick === tick)) throw new Error('A required historical weather draw is missing.');
  }
}

/** Bounded fine integration in a synchronized domain. Different-time neighbors
 * are absent, hence closed boundaries. No future halo, terrain generation,
 * aggregate replacement animal or global weather RNG is used. Returns copies;
 * a rejected batch never modifies its opening inventories or host counters. */
export function advanceColdGroup(host: World, opening: readonly Chunk[], observations: ClimateObservation[], chunkTickBudget: number): ColdBatch {
  if (!Number.isSafeInteger(chunkTickBudget) || chunkTickBudget < 1 || chunkTickBudget > 64
    || opening.length < 1 || opening.length > 2 || new Set(opening.map(chunk => chunk.key)).size !== opening.length)
    throw new Error('Invalid cold-region work budget or group.');
  const from = opening[0]!.lastTick;
  if (!Number.isSafeInteger(host.animalCounter) || host.animalCounter < 0
    || opening.some(chunk => chunk.lastTick !== from || chunk.lifeVersion !== 4) || from > host.tick
    || opening.length === 2 && Math.abs(opening[0]!.cx - opening[1]!.cx) + Math.abs(opening[0]!.cy - opening[1]!.cy) !== 1)
    throw new Error('Cold-region neighbors must share a physical time and border.');
  for (const chunk of opening) { assertDormantTerrain(chunk, from, true); assertChunkLife(chunk, from); }
  const steps = Math.min(host.tick - from, Math.floor(chunkTickBudget / opening.length));
  assertClimateWindow(observations, from, from + steps);
  const chunks = structuredClone([...opening]).sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  const domain: World = { ...host, tick: from, people: [], tiles: chunks.flatMap(chunk => chunk.tiles),
    animals: chunks.flatMap(chunk => chunk.animals ?? []), structures: chunks.flatMap(chunk => chunk.structures ?? []),
    animalDynamics: { ...host.animalDynamics }, inventionDynamics: { ...host.inventionDynamics } };
  assertAnimals(domain.animals, from, domain.tiles); assertStructures(domain.structures, from, domain.tiles);
  const events: DelayedEcologyEvent[] = [];
  let migrations = 0, weatherIndex = 0;
  for (let step = 0; step < steps; step++) {
    domain.tick++;
    while (observations[weatherIndex + 1] && observations[weatherIndex + 1]!.tick <= domain.tick) weatherIndex++;
    domain.weather = observations[weatherIndex]!.weather;
    const positions = new Map(domain.animals.map(animal => [animal.id, chunkKey(animal.x, animal.y)]));
    updateEcosystemResources(domain.tiles, domain.tick, domain.weather, phaseAt(domain.tick));
    stepEcosystem(domain.tiles, domain.tick, domain.weather, phaseAt(domain.tick), false);
    stepAnimals(domain, event => events.push({ ...event, tick: domain.tick, observedAt: host.tick }));
    stepStructures(domain, () => { throw new Error('Cold structures cannot emit a human action.'); });
    for (const animal of domain.animals) if (positions.has(animal.id) && positions.get(animal.id) !== chunkKey(animal.x, animal.y)) migrations++;
  }
  for (const chunk of chunks) {
    chunk.lastTick = domain.tick;
    chunk.animals = domain.animals.filter(animal => chunkKey(animal.x, animal.y) === chunk.key);
    chunk.structures = domain.structures.filter(structure => chunkKey(structure.x, structure.y) === chunk.key);
    assertChunkLife(chunk, domain.tick);
  }
  if (!Number.isSafeInteger(domain.animalCounter)) throw new Error('Cold animal identity allocator overflow.');
  return { chunks, animalCounter: domain.animalCounter, animalDynamics: domain.animalDynamics,
    inventionDynamics: domain.inventionDynamics, events, chunkTicks: steps * chunks.length, migrations };
}
