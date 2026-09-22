// node --import tsx docs/evidencia-2026-09-22/t100-parts-benchmark.mjs SOURCE.sqlite REPORT.json [rounds=8]
// Three disposable copies of a read-only checkpoint. Shared-host timings, not a server gate.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const instrument = fileURLToPath(import.meta.url), root = resolve(dirname(instrument), '../..');
const [sourceArgument, outputArgument, roundsArgument = '8'] = process.argv.slice(2);
if (!sourceArgument || !outputArgument) throw new Error('Usage: t100-parts-benchmark.mjs SOURCE.sqlite REPORT.json [rounds=8]');
const rounds = Number(roundsArgument);
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 24) throw new Error('Invalid rounds');
const parent = 'bfa4297fb741a5301b3f17c6a695c3b9c780d1b5';
const sha = value => createHash('sha256').update(value).digest('hex');
const directory = mkdtempSync(join(tmpdir(), 'atlas-parts-benchmark-'));
const mod = file => import(pathToFileURL(join(root, file)).href);
const { Store } = await mod('src/server/store.ts');
const { stepWorld } = await mod('src/world/index.ts');
const { digestoCanonico } = await mod('src/world/digesto.ts');
const { paramsOf } = await mod('src/world/params.ts');
const { readStoredSnapshot } = await mod('src/server/snapshot-parts.ts');
const stores = [], samples = [], startLoad = loadavg(), initialMemory = process.memoryUsage();
const sources = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? sources(join(directory, entry.name)) : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : []);
const hashes = () => Object.fromEntries([...sources(join(root, 'src')), instrument].sort().map(path => [path, sha(readFileSync(path))]));
const sourceHashesBefore = hashes(), parentSources = {};
let copiedCheckpoint;
try {
  // Same shared world/WeakMap modules, but exact parent persistence sources.
  for (const name of ['snapshot', 'store']) {
    const file = `src/server/${name}.ts`;
    const source = execFileSync('git', ['show', `${parent}:${file}`], { cwd: root, encoding: 'utf8' });
    parentSources[file] = sha(source);
    const rewritten = source.replace(/(from\s+['"])(\.[^'"]+)(['"])/g, (_match, before, relative, after) => {
      const target = name === 'store' && relative === './snapshot.js' ? join(directory, 'snapshot.mts') : resolve(root, 'src/server', relative);
      return `${before}${pathToFileURL(target).href}${after}`;
    });
    writeFileSync(join(directory, `${name}.mts`), rewritten, { flag: 'wx' });
  }
  const ParentStore = (await import(pathToFileURL(join(directory, 'store.mts')).href)).Store;
  const source = new DatabaseSync(resolve(sourceArgument), { readOnly: true });
  const master = join(directory, 'fixture.sqlite');
  try { source.prepare('VACUUM INTO ?').run(master); } finally { source.close(); }
  const fixture = new DatabaseSync(master, { readOnly: true });
  try {
    copiedCheckpoint = fixture.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get();
    assert.equal(sha(copiedCheckpoint.body), copiedCheckpoint.digest);
    for (const [name, Constructor, options] of [['parent', ParentStore, {}], ['inline', Store, {}], ['parts', Store, { snapshotInlineTileLimit: 0 }]]) {
      const path = join(directory, `${name}.sqlite`);
      fixture.prepare('VACUUM INTO ?').run(path);
      const store = new Constructor(path, options), world = store.load().world;
      const phases = {};
      if (store.snapshotParts) for (const method of ['prepare', 'write', 'collect', 'verify', 'verifyRetained']) {
        const previous = store.snapshotParts[method].bind(store.snapshotParts);
        store.snapshotParts[method] = (...args) => {
          const before = performance.now();
          try { return previous(...args); }
          finally { phases[method] = (phases[method] ?? 0) + performance.now() - before; }
        };
      }
      stores.push({ name, store, world, phases });
    }
  } finally { fixture.close(); }
  const cadence = paramsOf(stores[0].world).persistencia.cadaTicks;
  const initialDigest = digestoCanonico(stores[0].world);
  for (const { world } of stores) assert.equal(digestoCanonico(world), initialDigest);
  // One unmeasured save initializes format/schema state; no simulated tick is skipped.
  for (const { store, world } of stores) store.save(world);
  for (let round = 0; round < rounds; round++) {
    const order = [...stores.slice(round % 3), ...stores.slice(0, round % 3)];
    for (const { name, store, world, phases } of order) {
      for (let tick = 0; tick < cadence; tick++) stepWorld(world, [], store.context);
      const beforePhases = { ...phases }, cpu = process.cpuUsage(), before = performance.now();
      store.save(world);
      const wallMs = performance.now() - before, elapsedCpu = process.cpuUsage(cpu);
      samples.push({ name, round, tick: world.tick, wallMs, cpuMs: (elapsedCpu.user + elapsedCpu.system) / 1000, snapshotBytes: store.lastSnapshotBytes,
        phases: Object.fromEntries(Object.entries(phases).map(([key, value]) => [key, value - (beforePhases[key] ?? 0)])) });
    }
    const expected = digestoCanonico(stores[0].world);
    for (const { world } of stores) assert.equal(digestoCanonico(world), expected);
    const inlineBodies = stores.slice(0, 2).map(({ store }) => store.db.prepare('SELECT body FROM snapshots WHERE slot=0').get().body);
    assert.equal(inlineBodies[0], inlineBodies[1], 'ordinary inline bytes must remain unchanged');
  }
  const finalDigest = digestoCanonico(stores[0].world), persisted = [];
  for (const { name, store, world } of stores) {
    const snapshot = readStoredSnapshot(store.db);
    assert.equal(digestoCanonico(store.load().world), finalDigest, 're-read durable state matches post-commit state');
    assert.equal(store.lastSnapshotBytes, snapshot.snapshotBytes);
    persisted.push({ name, tick: world.tick, bodyHash: snapshot.bodyDigest, bodyBytes: snapshot.bodyBytes, snapshotBytes: snapshot.snapshotBytes });
  }
  const sourceHashesAfter = hashes();
  assert.deepEqual(sourceHashesAfter, sourceHashesBefore);
  const timings = Object.fromEntries(stores.map(({ name }) => {
    const values = samples.filter(sample => sample.name === name).map(sample => sample.wallMs).sort((a, b) => a - b);
    return [name, { median: (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2,
      p95: values[Math.min(values.length - 1, Math.floor(values.length * .95))] }];
  }));
  const report = { parent, source: resolve(sourceArgument), copiedBodyHash: copiedCheckpoint.digest, parentSources,
    instrumentHash: sha(readFileSync(instrument)), sourceHashesBefore, sourceHashesAfter, node: process.version,
    rounds, cadence, tiles: stores[0].world.tiles.length, population: stores[0].world.people.length,
    initialDigest, finalDigest, persisted, timings, samples, startLoad, endLoad: loadavg(), initialMemory,
    finalMemory: process.memoryUsage(), peakRssMiB: process.resourceUsage().maxRSS / 1024,
    limits: 'Shared host; three worlds/stores in one process. Same copied checkpoint, rotating order, one warm save, fixed persisted cadence. Save-only samples include SQLite and GC but not step or digest checks. Not a server governor gate or isolated hardware benchmark. Parts forced on a small real fixture; this does not prove 2M capacity.' };
  writeFileSync(resolve(outputArgument), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ timings, rounds, cadence, finalDigest, output: resolve(outputArgument) }));
} finally {
  for (const { store } of stores) store.close();
  rmSync(directory, { recursive: true, force: true });
}
