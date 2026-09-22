import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2]!);
const moduleAt = (name: string) => import(pathToFileURL(join(root, name)).href);
const { createWorld, cloneWorld, stepWorld } = await moduleAt('src/world/index.ts');
const { paramsOf, setParams, parseParams } = await moduleAt('src/world/params.ts');
const { bindWorldContext, worldContext } = await moduleAt('src/world/spatial.ts');
const { digestoCanonico } = await moduleAt('src/world/digesto.ts');
const { Store } = await moduleAt('src/server/store.ts');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const sources = () => Object.fromEntries(['world', 'server', 'shared'].flatMap(folder =>
  readdirSync(join(root, 'src', folder)).filter(f => f.endsWith('.ts')).sort().map(f =>
    [`${folder}/${f}`, sha(readFileSync(join(root, 'src', folder, f)))])));
const beforeSources = sources(), directory = mkdtempSync('/tmp/atlas-clone-trajectories-');
const results = [];
function fullClone(world: any, context: any) {
  const draft = structuredClone({ ...world, tiles: [] });
  draft.tiles = world.tiles.map((tile: any) => ({ ...tile }));
  bindWorldContext(draft, context); setParams(draft, paramsOf(world));
  return draft;
}
try {
  for (const seed of [1, 7, 51926]) {
    const oldStore = new Store(join(directory, `${seed}-full.sqlite`)), store = new Store(join(directory, `${seed}-shared.sqlite`));
    try {
      let a = createWorld(seed, parseParams('persistencia.cadaTicks=20'));
      let b = createWorld(seed, parseParams('persistencia.cadaTicks=20'));
      oldStore.save(a); store.save(b);
      let pendingCloneCount = 0, pendingChunkCount = 0;
      const milestones = [];
      for (let tick = 1; tick <= 2400; tick++) {
        if (b.retiredChunks.length) { pendingCloneCount++; pendingChunkCount += b.retiredChunks.length; }
        const priorA = a, priorB = b;
        const held = tick % 120 === 0 ? digestoCanonico(priorB) : null;
        a = fullClone(a, oldStore.context); b = cloneWorld(b, store.context);
        stepWorld(a, [], oldStore.context); stepWorld(b, [], store.context);
        if (held) assert.equal(digestoCanonico(priorB), held, 'el clon avanzado conserva el mundo anterior');
        if (tick % 20 === 0) { oldStore.save(a); store.save(b); }
        if (tick % 120 === 0) {
          assert.equal(digestoCanonico(a), digestoCanonico(b), `${seed}:${tick}`);
          assert.deepEqual(priorA, priorB);
        }
        if (tick === 1200 || tick === 2400) {
          const digest = digestoCanonico(a);
          a = oldStore.load()!.world; b = store.load()!.world;
          assert.equal(digestoCanonico(a), digest); assert.equal(digestoCanonico(b), digest);
          milestones.push({ tick, digest });
        }
      }
      const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name<>'snapshots' ORDER BY name").all();
      for (const { name } of tables) {
        assert.match(name, /^[a-z_]+$/);
        assert.deepEqual(store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(), oldStore.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all());
      }
      results.push({ seed, ticks: 2400, pendingCloneCount, pendingChunkCount, milestones, equalArchiveTables: tables.map((t: any) => t.name) });
    } finally { oldStore.close(); store.close(); }
  }
  assert.deepEqual(sources(), beforeSources);
  console.log(JSON.stringify({ scope: 'Full clone versus dormant sharing on identical current laws, every step cloned, SQLite every20, reload1200/2400. Not a timing benchmark or T103 performance closure.', node: process.version, sourceHashes: beforeSources, results }, null, 2));
} finally { rmSync(directory, { recursive: true, force: true }); }
