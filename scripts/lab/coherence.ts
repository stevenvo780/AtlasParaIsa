/** Paired audit of immutable worktrees. Uses production SQLite and optional real app steps.
 * Example: --root /worktree --seed 51926 --days 5 --output /tmp/run --engine world|server
 * Wall-clock governor traces are hardware observations, not deterministic law controls.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { durableActivityMetrics } from './metrics.js';
import type { World } from '../../src/world/index.js';
import type { Store } from '../../src/server/store.js';

const arg = (key: string, fallback: string) => { const i = process.argv.indexOf(key); return i < 0 ? fallback : process.argv[i + 1]!; };
const root = resolve(arg('--root', '.')), output = resolve(arg('--output', 'artifacts/coherence'));
const seed = Number(arg('--seed', '51926')), days = Number(arg('--days', '5')), engine = arg('--engine', 'world');
if (!Number.isInteger(seed) || seed < 0 || !Number.isInteger(days) || days < 1 || !['world', 'server'].includes(engine)) throw new Error('Invalid audit arguments.');
const requestedRevision = arg('--revision', '');
if (process.argv.includes('--revision') && !/^[a-f0-9]{40}$/.test(requestedRevision)) throw new Error('--revision must be a full lowercase SHA-1.');
mkdirSync(output, { recursive: false });
const imported = async (path: string) => import(pathToFileURL(join(root, path)).href);
const api = await imported('src/world/index.ts') as typeof import('../../src/world/index.js');
const assertWorld: typeof api.assertWorld = api.assertWorld;
const storage = await imported('src/server/store.ts') as typeof import('../../src/server/store.js');
const parameters = await imported('src/world/params.ts') as typeof import('../../src/world/params.js');
const family = await imported('src/world/family.ts') as typeof import('../../src/world/family.js');
const diversity = await imported('src/world/diversidad.ts') as typeof import('../../src/world/diversidad.js');
function sourceDigest() {
  const hash = createHash('sha256');
  for (const folder of ['src/world', 'src/server', 'src/shared']) for (const file of readdirSync(join(root, folder)).filter(file => file.endsWith('.ts')).sort())
    hash.update(folder + '/' + file).update('\0').update(readFileSync(join(root, folder, file)));
  return hash.digest('hex');
}
const source = sourceDigest();
const instrumentHash = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url)))
  .update(readFileSync(fileURLToPath(new URL('./metrics.ts', import.meta.url)))).digest('hex');
const params = parameters.parseParams(arg('--params', 'persistencia.cadaTicks=20'));
const meta = { metricasVersion: 2, instrumentHash, sha: requestedRevision || execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), source, seed, days, engine, params,
  scope: engine === 'server' ? 'createApp, real clone/step/save and hardware governor; no clients, scheduler or network' : 'stepWorld and production Store; governor not executed',
  thresholds: { mortalExtinction: 0, failedSteps: 0, serverStepP95Ms: 50 }, complete: false };
writeFileSync(join(output, 'run.json'), JSON.stringify(meta, null, 2));
const store: Store = new storage.Store(join(output, 'world.sqlite'));
let app: ReturnType<typeof import('../../src/server/app.js').createApp> | undefined;
let world: World;
let lastTick = 0;
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;
try {
  if (engine === 'server') {
    const application = await imported('src/server/app.ts') as typeof import('../../src/server/app.js');
    app = application.createApp({ store, seed, params, manual: true, password: randomBytes(24).toString('base64url'), origin: 'http://127.0.0.1:3199' });
    world = app.world;
  } else { world = api.createWorld(seed, params); store.save(world); }
  for (let day = 1; day <= days; day++) {
    const times: number[] = [], saves: number[] = [];
    let paused = 0;
    for (let tick = 0; tick < api.TICKS_PER_DAY; tick++) {
      const before = performance.now();
      if (app) {
        app.stepOnce(); if (app.failed) throw new Error('Server step failed; audit preserves database.');
        world = app.world; saves.push(app.runtime.saveMs);
      } else {
        api.stepWorld(world);
        if (world.tick % params.persistencia.cadaTicks === 0) { const at = performance.now(); store.save(world); saves.push(performance.now() - at); }
      }
      times.push(performance.now() - before);
      if (!world.reproductionEnabled) paused++;
    }
    // Complete the interval before querying durable evidence, including a partial cadence.
    if (world.tick % params.persistencia.cadaTicks !== 0) store.save(world);
    assertWorld(world);
    const record = { day, tick: world.tick, population: world.people.length, births: world.totals.births,
      deaths: world.demographyDynamics, reproductionPausedTicks: paused,
      neighborsReady: world.people.filter(person => family.reproductiveReadiness(world, person)).length,
      totals: world.totals, diversity: diversity.indiceDiversidad(world),
      activity: durableActivityMetrics(world, store.db, lastTick),
      p50StepMs: percentile(times, .5), p95StepMs: percentile(times, .95), maxStepMs: Math.max(...times),
      p95SaveMs: percentile(saves, .95), rss: process.memoryUsage().rss, runtime: app?.runtime ?? null };
    writeFileSync(join(output, `day-${String(day).padStart(3, '0')}.json`), JSON.stringify(record, null, 2));
    lastTick = world.tick;
    console.log(JSON.stringify({ day, seed, engine, population: record.population, neighbors: record.activity.vecinosMortales, births: record.births, p95StepMs: record.p95StepMs }));
  }
  store.save(world);
  const endSource = sourceDigest();
  if (source !== endSource) throw new Error('Source changed during audit; this run cannot prove a fixed revision.');
  writeFileSync(join(output, 'run.json'), JSON.stringify({ ...meta, complete: true, finalTick: world.tick }, null, 2));
} catch (error) {
  writeFileSync(join(output, 'failure.json'), JSON.stringify({ message: String(error), lastCompletedTick: lastTick }, null, 2));
  throw error;
} finally { if (app) await app.close(); store.close(); }
