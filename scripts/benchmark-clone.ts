import { cloneWorld, createWorld, type World } from '../src/world/index.js';
import { generateChunk } from '../src/world/terrain.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { bindWorldContext, worldContext } from '../src/world/spatial.js';
import { paramsOf, setParams } from '../src/world/params.js';

const world = createWorld(51926);
for (let n = 0; n < 256; n++) world.retiredChunks.push(generateChunk(world.seed, 100 + n % 16, 100 + Math.floor(n / 16)));
const oldClone = () => {
  const draft: World = structuredClone({ ...world, tiles: [] });
  draft.tiles = world.tiles.map(tile => ({ ...tile }));
  bindWorldContext(draft, worldContext(world)); setParams(draft, paramsOf(world));
  return draft;
};
const before = digestoCanonico(world), oldTimes: number[] = [], newTimes: number[] = [];
for (let round = 0; round < 90; round++) {
  const oldFirst = round % 2 === 0;
  for (const mode of oldFirst ? ['old', 'new'] : ['new', 'old']) {
    const at = performance.now(), draft = mode === 'old' ? oldClone() : cloneWorld(world);
    const elapsed = performance.now() - at;
    if (round >= 10) (mode === 'old' ? oldTimes : newTimes).push(elapsed);
    if (round === 89 && digestoCanonico(draft) !== before) throw new Error('Copy changed canonical state.');
  }
}
const summary = (times: number[]) => {
  times.sort((a, b) => a - b);
  return { n: times.length, p50Ms: times[Math.floor(times.length * .5)], p95Ms: times[Math.floor(times.length * .95)] };
};
console.log(JSON.stringify({ scope: 'clone only; synthetic dormant terrain, alternating order; shared host', seed: world.seed,
  activeTiles: world.tiles.length, dormantTiles: world.retiredChunks.reduce((n, chunk) => n + chunk.tiles.length, 0),
  dormantBytes: Buffer.byteLength(JSON.stringify(world.retiredChunks)), before: summary(oldTimes), after: summary(newTimes), digest: before }, null, 2));
