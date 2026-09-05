/** Synthetic CPU/storage comparison. No private DB, HTTP server, browser, workers or GPU. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, loadavg, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { encodeSnapshot, decodeSnapshot } from '../src/server/snapshot.js';
import { assertWorld, cloneWorld, createWorld, stepWorld, type World } from '../src/world/index.js';
import { generateTile } from '../src/world/terrain.js';
import { maintainRegions } from '../src/world/spatial.js';

const samples = Number(process.env.CPU_BENCH_STEPS ?? 24), warmup = 4, seed = 51926;
assert.ok(Number.isInteger(samples) && samples >= 24 && samples <= 60, 'CPU_BENCH_STEPS must be 24–60');
const digest = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');
const sourceFiles = ['src/server/snapshot.ts', 'src/server/store.ts', 'src/world/index.ts', 'src/world/spatial.ts'];
const sourceHashes = Object.fromEntries(sourceFiles.map(path => [path, digest(readFileSync(path))]));
const readOptional = (path: string) => { try { return readFileSync(path, 'utf8').trim(); } catch { return null; } };
type Measure = { wallMs: number[]; cpuMs: number[] };
const empty = (): Measure => ({ wallMs: [], cpuMs: [] });
function timed<T>(bucket: Measure, collect: boolean, operation: () => T): T {
  const cpuBefore = process.cpuUsage(), before = performance.now();
  const result = operation();
  const wallMs = performance.now() - before, cpu = process.cpuUsage(cpuBefore);
  if (collect) { bucket.wallMs.push(wallMs); bucket.cpuMs.push((cpu.user + cpu.system) / 1000); }
  return result;
}
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: sorted[Math.floor(sorted.length * .5)]!, p95: sorted[Math.floor(sorted.length * .95)]!, max: sorted.at(-1)!,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length };
}
const describe = (bucket: Measure) => ({ wallMs: distribution(bucket.wallMs), cpuMs: distribution(bucket.cpuMs) });
const codecMetrics = () => ({ encode: empty(), decode: empty(), transaction: empty(), bytes: [] as number[] });

function fixture(population: 16 | 32): World {
  const world = createWorld(seed);
  for (let index = 16; index < population; index++) {
    const inhabitant = structuredClone(world.people[2 + (index - 16) % 14]!);
    inhabitant.id = `cpu-benchmark-${index}`; inhabitant.name = `Sintético ${index}`; world.people.push(inhabitant);
  }
  const centers = population === 16 ? 16 : 28;
  for (let index = 0; index < population; index++) {
    const person = world.people[index]!, center = index % centers;
    const x0 = (center % 8) * 64, y0 = Math.floor(center / 8) * 64;
    const positions = Array.from({ length: 256 }, (_, i) => ({ x: x0 + i % 16, y: y0 + Math.floor(i / 16) }))
      .sort((a, b) => Math.hypot(a.x - x0 - 8, a.y - y0 - 8) - Math.hypot(b.x - x0 - 8, b.y - y0 - 8));
    const position = positions.find(p => generateTile(seed, p.x, p.y).terrain !== 'water');
    assert.ok(position, 'fixture center must include traversable ground');
    Object.assign(person, position, { target: { ...position }, action: 'rest', decisionAt: 10000, hunger: .2, thirst: .2 });
  }
  maintainRegions(world);
  // Initialization only: this benchmark isolates active snapshots, with no archive/session/input work.
  world.retiredChunks = [];
  assert.ok(Object.keys(world.chunks).length <= 128 && world.tiles.length < 30000);
  assertWorld(world); return world;
}

/** Same WAL/FULL snapshot/previous/metadata/event transaction as Store.save, empty inputs/archive. */
function saveEncoded(store: Store, world: World, body: string): void {
  assert.equal(world.retiredChunks.length, 0);
  const db = store.db;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('INSERT OR REPLACE INTO snapshots SELECT 1,body,digest,saved_at FROM snapshots WHERE slot=0');
    db.prepare('INSERT OR REPLACE INTO snapshots VALUES (0,?,?,?)').run(body, digest(body), Date.now());
    db.prepare("INSERT OR REPLACE INTO metadata VALUES ('initialized','1')").run();
    const insertEvent = db.prepare('INSERT OR IGNORE INTO events VALUES (?,?,?)');
    for (const event of world.events) insertEvent.run(event.id, event.tick, JSON.stringify(event));
    db.prepare('INSERT INTO inputs VALUES (?,?,?,?,?,?)');
    db.exec('COMMIT');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

function verifyCheckpoint(store: Store, expectedCurrent: World, previousBody: string | undefined, codec: 'plain' | 'tuple') {
  const rows = store.db.prepare('SELECT slot,body,digest FROM snapshots ORDER BY slot').all() as { slot: number; body: string; digest: string }[];
  assert.equal(rows.length, 2); assert.equal(rows[0]!.slot, 0); assert.equal(rows[1]!.slot, 1);
  for (const row of rows) assert.equal(digest(row.body), row.digest);
  assert.equal(rows[1]!.body, previousBody, 'previous checkpoint is exactly the preceding committed body');
  const parsed = codec === 'plain' ? JSON.parse(rows[0]!.body) : decodeSnapshot(rows[0]!.body);
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(expectedCurrent)));
  assert.equal(Object.values(store.db.prepare('PRAGMA quick_check').get()!)[0], 'ok');
}

const dir = mkdtempSync(join(tmpdir(), 'carta-cpu-v3-'));
const environment = { node: process.version, v8: process.versions.v8, platform: platform(), kernel: release(), arch: process.arch,
  cpu: cpus()[0]?.model ?? 'unreported', logicalCpus: cpus().length, availableParallelism: availableParallelism(),
  cgroupCpuMax: readOptional('/sys/fs/cgroup/cpu.max'), cgroupMemoryMax: readOptional('/sys/fs/cgroup/memory.max'),
  loadAverageBefore: loadavg(), tempFilesystem: execFileSync('stat', ['-f', '-c', '%T', dir], { encoding: 'utf8' }).trim() };
const started = performance.now();
const scenarios = [];
try {
  for (const population of [16, 32] as const) {
    const world = fixture(population), initialDigest = digest(JSON.stringify(world));
    const stores = { plain: new Store(join(dir, `plain-${population}.sqlite`)), tuple: new Store(join(dir, `tuple-${population}.sqlite`)) };
    const metrics = { plain: codecMetrics(), tuple: codecMetrics() };
    const clones = { structuredClone: empty(), cloneWorld: empty() }, step = empty();
    const previousBodies: Partial<Record<'plain' | 'tuple', string>> = {}, lastBodies: Partial<Record<'plain' | 'tuple', string>> = {};
    let roundTrips = 0, cloneChecks = 0;
    try {
      for (const store of Object.values(stores)) {
        assert.equal(Object.values(store.db.prepare('PRAGMA journal_mode').get()!)[0], 'wal');
        assert.equal(Object.values(store.db.prepare('PRAGMA synchronous').get()!)[0], 2);
      }
      for (let iteration = -warmup; iteration < samples; iteration++) {
        const collect = iteration >= 0;
        timed(step, collect, () => stepWorld(world)); assert.equal(world.retiredChunks.length, 0); assertWorld(world);
        // Alternate order to reduce first/second allocation, JIT and I/O cache bias.
        const firstCustom = iteration % 2 === 0;
        const a = timed(firstCustom ? clones.cloneWorld : clones.structuredClone, collect, () => firstCustom ? cloneWorld(world) : structuredClone(world));
        const b = timed(firstCustom ? clones.structuredClone : clones.cloneWorld, collect, () => firstCustom ? structuredClone(world) : cloneWorld(world));
        assert.deepEqual(a, b); assert.deepEqual(a, world);
        for (const draft of [a, b]) {
          assert.notEqual(draft.tiles[0], world.tiles[0]); assert.notEqual(draft.people[0]!.skills, world.people[0]!.skills);
          const original = world.tiles[0]!.moisture; draft.tiles[0]!.moisture = original === 0 ? 1 : 0;
          draft.people[0]!.skills.benchmarkProbe = .5;
          assert.equal(world.tiles[0]!.moisture, original); assert.equal(world.people[0]!.skills.benchmarkProbe, undefined);
        }
        if (collect) cloneChecks++;
        const plainExpected = JSON.parse(JSON.stringify({ ...world, retiredChunks: [] }));
        for (const codec of (iteration % 2 === 0 ? ['plain', 'tuple'] : ['tuple', 'plain']) as ('plain' | 'tuple')[]) {
          const bucket = metrics[codec];
          const body = timed(bucket.encode, collect, () => codec === 'plain' ? JSON.stringify({ ...world, retiredChunks: [] }) : encodeSnapshot(world));
          const decoded = timed(bucket.decode, collect, () => codec === 'plain' ? JSON.parse(body) : decodeSnapshot(body));
          assert.deepEqual(decoded, plainExpected); assertWorld(decoded); if (collect) roundTrips++;
          timed(bucket.transaction, collect, () => saveEncoded(stores[codec], world, body));
          if (collect) bucket.bytes.push(Buffer.byteLength(body));
          previousBodies[codec] = lastBodies[codec]; lastBodies[codec] = body;
        }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      for (const codec of ['plain', 'tuple'] as const) verifyCheckpoint(stores[codec], world, previousBodies[codec], codec);
      const codecs = Object.fromEntries((['plain', 'tuple'] as const).map(codec => {
        const m = metrics[codec];
        const encodePlusTransaction = { wallMs: m.encode.wallMs.map((value, index) => value + m.transaction.wallMs[index]!),
          cpuMs: m.encode.cpuMs.map((value, index) => value + m.transaction.cpuMs[index]!) };
        return [codec, { bytes: distribution(m.bytes), encode: describe(m.encode), decode: describe(m.decode), transaction: describe(m.transaction),
          encodePlusTransaction: describe(encodePlusTransaction), databaseBytes: statSync(stores[codec].path).size,
          walBytes: statSync(`${stores[codec].path}-wal`).size, rawSamples: m }];
      }));
      scenarios.push({ population, activeRegions: Object.keys(world.chunks).length, activeTiles: world.tiles.length, initialDigest,
        finalDigest: digest(JSON.stringify(world)), measuredSteps: samples, warmupSteps: warmup, firstMeasuredTick: warmup + 1, finalTick: world.tick,
        fixture: '16 distinct centers, or 32 synthetic inhabitants in 28 centers, separated by 64 tiles; rest fixed during the sample; real ecology steps',
        clone: { structuredClone: describe(clones.structuredClone), cloneWorld: describe(clones.cloneWorld), rawSamples: clones },
        simulationOnly: describe(step), codecs, fidelity: { exactRoundTrips: roundTrips, exactCloneChecks: cloneChecks,
          inputMutationChecks: cloneChecks * 2, currentAndPreviousCheckpoints: true, checksums: true, sqliteQuickCheck: true } });
      console.log(`CPU benchmark: ${population} people, ${world.tiles.length} tiles, ${samples} paired steps; fidelity and SQLite checkpoints passed.`);
    } finally { stores.plain.close(); stores.tuple.close(); }
  }
  for (const path of sourceFiles) assert.equal(digest(readFileSync(path)), sourceHashes[path], `Source changed during benchmark: ${path}; rerun for a reproducible result.`);
  const report = { generatedAt: new Date().toISOString(), environment: { ...environment, loadAverageAfter: loadavg() },
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceHashes,
    seed, wallSeconds: (performance.now() - started) / 1000, peakRssMiB: process.resourceUsage().maxRSS / 1024, scenarios,
    method: 'Paired identical live states; codecs and clones alternate order. Encoding, decoding, SQLite transaction and simulation are timed separately. CPU uses process.cpuUsage(user+system); wall uses performance.now. Fidelity and integrity assertions are outside measured regions. WAL and synchronous=FULL on separate temporary files; same previous/current snapshot, digest, metadata and event SQL for both encodings.',
    limits: '24–60 steps are a short synthetic comparison, not a soak. No browser, GPU, threads, sessions, gestures, archival writes, concurrent clients or power-loss test. CPU samples may include V8 GC/runtime threads. Files use the current temporary filesystem and host cache. Other processes/soak may contend: wall time is not isolated. Encode+transaction is a paired sum of separate intervals, not end-to-end request latency.', failures: 0 };
  mkdirSync('artifacts', { recursive: true }); writeFileSync('artifacts/cpu-v3-comparison.json', JSON.stringify(report, null, 2) + '\n');
  console.log('Saved artifacts/cpu-v3-comparison.json');
} finally { rmSync(dir, { recursive: true, force: true }); }
