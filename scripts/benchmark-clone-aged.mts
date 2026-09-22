import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/server/store.js';
import { cloneWorld, stepWorld, type World } from '../src/world/index.js';
import { paramsOf, setParams } from '../src/world/params.js';
import { bindWorldContext, worldContext } from '../src/world/spatial.js';
import { heredarEstadisticas } from '../src/world/statistics.js';
import { digestoCanonico } from '../src/world/digesto.js';

// Isolate the retiredChunks change: both implementations preserve context,
// parameters and statistics cache. No physical step belongs to the timed region.
function fullClone(world: World): World {
  const draft: World = structuredClone({ ...world, tiles: [] });
  draft.tiles = world.tiles.map(tile => ({ ...tile }));
  bindWorldContext(draft, { ...worldContext(world) });
  setParams(draft, paramsOf(world)); heredarEstadisticas(draft, world);
  return draft;
}
const sha = (path: string) => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
const summarize = (values: number[]) => {
  const sorted = [...values].sort((a,b) => a-b);
  return { n: sorted.length, p50Ms: sorted[Math.floor(sorted.length*.5)], p95Ms: sorted[Math.floor(sorted.length*.95)] };
};
const paths = process.argv.slice(2).map(path => resolve(path));
if (!paths.length) throw new Error('Provide readonly laboratory SQLite fixtures; never a live public database.');
const results = [];
for (const path of paths) {
  const before = { db: sha(path), wal: sha(`${path}-wal`) }, store = new Store(path, { readOnly: true });
  try {
    const row = store.db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get() as {body:string;digest:string};
    const source = JSON.parse(row.body), loaded = store.load()!;
    assert.equal(loaded.slot, 0); assert.equal(loaded.skipped.length, 0);
    const world = loaded.world, stages = [];
    assert.equal(world.tick, source.tick); assert.equal(paramsOf(world).persistencia.cadaTicks, 20);
    for (const offset of [0, 19]) {
      while (world.tick < source.tick + offset) stepWorld(world, [], store.context);
      const beforeDigest = digestoCanonico(world), times = { full: [] as number[], shared: [] as number[] };
      const cpu = { full: [] as number[], shared: [] as number[] };
      for (let round=0; round<70; round++) {
        for (const mode of (round%2 ? ['shared','full'] : ['full','shared']) as ('full'|'shared')[]) {
          const startedCPU = process.cpuUsage(), started = performance.now();
          const draft = mode==='full' ? fullClone(world) : cloneWorld(world);
          const elapsed = performance.now()-started, usedCPU = process.cpuUsage(startedCPU);
          if (round>=10) { times[mode].push(elapsed); cpu[mode].push((usedCPU.user+usedCPU.system)/1000); }
          if (round===0 || round===69) assert.equal(digestoCanonico(draft), beforeDigest);
        }
      }
      assert.equal(digestoCanonico(world), beforeDigest);
      stages.push({ tick: world.tick, pendingChunks: world.retiredChunks.length,
        pendingTiles: world.retiredChunks.reduce((n,c)=>n+c.tiles.length,0),
        pendingBytes: Buffer.byteLength(JSON.stringify(world.retiredChunks)), activeTiles: world.tiles.length,
        people: world.people.length, digest: beforeDigest,
        wall: { full: summarize(times.full), shared: summarize(times.shared) },
        processCPU: { full: summarize(cpu.full), shared: summarize(cpu.shared) } });
    }
    results.push({ path, sourceVersion: source.version, loadedVersion: world.version,
      seed: world.seed, sourceTick: source.tick, sourceSnapshotDigest: row.digest,
      archivedChunks: store.db.prepare('SELECT COUNT(*) AS n FROM chunks').get()!.n, before, stages });
  } finally { store.close(); }
  assert.deepEqual({db:sha(path),wal:sha(`${path}-wal`)},before);
}
console.log(JSON.stringify({at:new Date().toISOString(),node:process.version,
  instrumentSha256:sha(fileURLToPath(import.meta.url)),
  sourceHashes:Object.fromEntries(['src/world/index.ts','src/world/spatial.ts','src/world/statistics.ts','src/server/store.ts'].map(p=>[p,sha(resolve(p))])),
  scope:'Clone only, real aged checkpoints at load and 19 unsaved physical steps (cadence20), alternating order, 10 warmups and60 measured rounds. Shared host, no forced GC, CPU includes runtime overhead. Historical V6 fixture migrates in memory to V7; original SQLite/WAL unchanged. No synthetic dormant terrain, server latency or timing reproduction of the historical 10.25ms baseline.',
  results},null,2));
