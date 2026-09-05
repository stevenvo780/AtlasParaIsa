import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createWorld, stepWorld, assertWorld, projectWorld, cloneWorld, TICKS_PER_DAY } from '../src/world/index.js';
import { worldStatistics } from '../src/world/statistics.js';
import { Store } from '../src/server/store.js';

const days = Number(process.env.SOAK_DAYS ?? 5);
if (!Number.isInteger(days) || days < 3 || days > 60) throw new Error('SOAK_DAYS debe estar entre 3 y 60.');
const dir = mkdtempSync(join(tmpdir(), 'carta-soak-'));
const path = join(dir, 'world.sqlite');
let store = new Store(path);
const started = performance.now(); const cpu = process.cpuUsage(); const latencies: number[] = [];
let world = createWorld(51926); const phases = new Set<string>(); const events = new Map<string, number>();
let maximumViewBytes = 0, maximumSnapshotBytes = 0, maximumActiveChunks = 0, maximumActiveTiles = 0;
try {
  store.save(world);
  for (let tick = 0; tick < TICKS_PER_DAY * days; tick++) {
    const before = performance.now(); const draft = cloneWorld(world); stepWorld(draft, [], { loadChunk: (key, tick) => store.loadChunk(key, tick) }); store.save(draft); world = draft;
    latencies.push(performance.now() - before);
    maximumActiveChunks = Math.max(maximumActiveChunks, Object.keys(world.chunks).length);
    maximumActiveTiles = Math.max(maximumActiveTiles, world.tiles.length);
    maximumSnapshotBytes = Math.max(maximumSnapshotBytes, store.lastSnapshotBytes);
    if (tick % 100 === 0) {
      assertWorld(world); const view = projectWorld(world, undefined, { loadChunk: (key, tick) => store.loadChunk(key, tick) }); phases.add(view.phase);
      maximumViewBytes = Math.max(maximumViewBytes, Buffer.byteLength(JSON.stringify(view)));
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (tick === TICKS_PER_DAY * 2) {
      store.close(); store = new Store(path); assert.deepEqual(store.load()!.world, world);
    }
  }
  assertWorld(world); assert.deepEqual(store.load()!.world, world);
  store.backup(join(dir, 'backup.sqlite'));
  const copy = new Store(join(dir, 'backup.sqlite'), { readOnly: true });
  assert.deepEqual(copy.load()!.world, world); copy.close();
  for (const row of store.db.prepare('SELECT body FROM events').all() as {body:string}[]) {
    const event = JSON.parse(row.body) as {kind:string}; events.set(event.kind, (events.get(event.kind)??0)+1);
  }
  latencies.sort((a,b)=>a-b); const cpuUsed = process.cpuUsage(cpu);
  const archive = store.db.prepare('SELECT COUNT(*) AS versions, COUNT(DISTINCT key) AS regions FROM chunks').get() as { versions: number; regions: number };
  const report = {
    generatedAt: new Date().toISOString(), node: process.version, mode: 'accelerated fixed-step simulation with transactional draft clone and SQLite commit on every step; no browser',
    seed: world.seed, rulesVersion: world.version, population: world.people.length,
    ticks: world.tick, modelDays: days, modelSeconds: world.tick / 10, wallSeconds: (performance.now()-started)/1000,
    cpuSeconds: (cpuUsed.user+cpuUsed.system)/1_000_000,
    stepWithCommitMs: {p50:latencies[Math.floor(latencies.length*0.5)],p95:latencies[Math.floor(latencies.length*0.95)],max:latencies.at(-1)},
    peakRssMiB: process.resourceUsage().maxRSS/1024, maximumViewBytes, maximumSnapshotBytes, databaseBytes:statSync(path).size,
    society: { communities: world.communities.length, generations: worldStatistics(world).generations, totals: world.totals, finalWildlife: worldStatistics(world).wildlife, meanThirst: worldStatistics(world).meanThirst },
    procedural: { discoveredChunks: world.discoveredChunks, settlements: world.settlementCount, maximumActiveChunks, maximumActiveTiles, archivedRegions: archive.regions, archivedVersions: archive.versions },
    phases:[...phases], persistedEvents:Object.fromEntries(events), restartEquality:true, backupEquality:true,
    failures:0, limits:'Accelerated run is not a multi-day wall-clock deployment or a physical-phone test.'
  };
  const output=resolve(process.argv[2]??'artifacts/soak.json'); mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,JSON.stringify(report,null,2)+'\n'); console.log(JSON.stringify(report,null,2));
} finally {store.close();rmSync(dir,{recursive:true,force:true});}
