import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Store } from '../src/server/store.js';
import { takeSnapshotParams } from '../src/server/snapshot.js';
import { readStoredSnapshot } from '../src/server/snapshot-parts.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { stepWorld, type World } from '../src/world/index.js';
import { paramsOf } from '../src/world/params.js';

// All controls execute the current validation and laws. They only disable the
// optimizations named below, in this process or a generated temporary module.
const modes = ['baseline', 'statements', 'memo', 'current'] as const;
const [sourceArgument, outputArgument, mode = 'current', roundsArgument = '12'] = process.argv.slice(2);
if (!sourceArgument || !outputArgument || !modes.some(value => value === mode))
  throw new Error('Usage: tsx scripts/benchmark-store.ts SOURCE.sqlite OUTPUT_DIRECTORY [baseline|statements|memo|current] [rounds]');
const rounds = Number(roundsArgument);
if (!Number.isSafeInteger(rounds) || rounds < 1) throw new Error('Invalid rounds');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(outputArgument), source = resolve(sourceArgument), database = join(directory, 'world.sqlite');
mkdirSync(directory, { recursive: true });
// The source connection cannot write. VACUUM INTO refuses an existing destination
// database instead of overwriting it, including an accidentally reused source.
const copy = new DatabaseSync(source, { readOnly: true });
try {
  copy.prepare('VACUUM INTO ?').run(database);
} finally { copy.close(); }
// Bind controls to the actual copied checkpoint if the source was still writing
// when VACUUM ran. Resolve every page inside one read transaction.
const inspection = new DatabaseSync(database, { readOnly: true });
let expectedParams;
try {
  const snapshot = readStoredSnapshot(inspection);
  if (!snapshot) throw new Error('Copied source snapshot is missing');
  expectedParams = takeSnapshotParams(snapshot.value);
} finally { inspection.close(); }

let Constructor = Store;
let variant: string | null = null;
if (mode === 'memo') {
  // Before the specialized defensive copy, memoization used structuredClone.
  // An .mts file and absolute imports keep the same ESM instances/WeakMaps as
  // the current world. A copied CommonJS module would silently lose its params.
  const storePath = join(root, 'src/server/store.ts');
  let body = readFileSync(storePath, 'utf8');
  for (const [before, after] of [
    ['return copyArchivedRecipe(reads.recipes.get(key)!)', 'return structuredClone(reads.recipes.get(key)!)'],
    ['reads.recipes.set(key, copyArchivedRecipe(value))', 'reads.recipes.set(key, structuredClone(value))'],
  ]) {
    if (body.split(before!).length !== 2) throw new Error('Memo control no longer matches the current implementation');
    body = body.replace(before!, after!);
  }
  body = body.replace(/(from\s+['"])(\.[^'"]+)(['"])/g,
    (_match, prefix: string, relative: string, suffix: string) => `${prefix}${pathToFileURL(resolve(dirname(storePath), relative)).href}${suffix}`);
  variant = join(directory, 'store-generic-copy.mts');
  writeFileSync(variant, body, { flag: 'wx' });
  Constructor = (await import(pathToFileURL(variant).href) as { Store: typeof Store }).Store;
}
const sourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? sourceFiles(join(directory, entry.name)) : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : []);
const paths = [...sourceFiles(join(root, 'src')), fileURLToPath(import.meta.url), ...(variant ? [variant] : [])].sort();
const hashes = () => Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
const sourceHashesBefore = hashes(), store = new Constructor(database);
const internal = store as unknown as Record<string, (...args: unknown[]) => unknown>;
if (mode === 'baseline') {
  const archive = store.technologyArchive as unknown as { readStatement: (sql: string) => unknown };
  if (typeof archive.readStatement !== 'function') throw new Error('Statement control no longer matches the current implementation');
  archive.readStatement = (sql: string) => store.db.prepare(sql);
}
if (mode === 'baseline' || mode === 'statements') {
  const scope = store as unknown as { withTechnologyReads: (world: World, validate: () => void) => void };
  if (typeof scope.withTechnologyReads !== 'function') throw new Error('Read-scope control no longer matches the current implementation');
  scope.withTechnologyReads = (_world, validate) => validate();
}
const timing: Record<string, { calls: number; ms: number }> = {};
for (const name of ['prepareTechnology', 'flushTechnology', 'assertTechnologyChanges', 'assertChronicleChanges', 'flushChronicle',
  'rememberTechnology', 'assertTechnologyCache', 'assertTechnologyCoverage']) {
  const previous = internal[name]!;
  internal[name] = function (...args: unknown[]) {
    const before = performance.now();
    try { return previous.apply(store, args); }
    finally { const value = timing[name] ??= { calls: 0, ms: 0 }; value.calls++; value.ms += performance.now() - before; }
  };
}
try {
  const start = performance.now(), world = store.load()!.world, loadMs = performance.now() - start;
  if (!isDeepStrictEqual(paramsOf(world), expectedParams)) throw new Error('Profile world lost its persisted parameters');
  const cadence = paramsOf(world).persistencia.cadaTicks;
  for (const key of Object.keys(timing)) delete timing[key];
  const samples = [];
  for (let round = 0; round < rounds; round++) {
    const simulationStart = performance.now();
    for (let step = 0; step < cadence; step++) stepWorld(world, [], store.context);
    const simulationMs = performance.now() - simulationStart;
    const before = structuredClone(timing), saveStart = performance.now();
    store.save(world);
    const saveMs = performance.now() - saveStart;
    const phases = Object.fromEntries(Object.entries(timing).map(([name, value]) => [name,
      { calls: value.calls - (before[name]?.calls ?? 0), ms: value.ms - (before[name]?.ms ?? 0) }]));
    samples.push({ round, tick: world.tick, population: world.people.length, tiles: world.tiles.length, simulationMs, saveMs, phases });
  }
  const snapshot = readStoredSnapshot(store.db)!;
  const archiveHashes: Record<string, { rows: number; sha256: string }> = {};
  for (const [table, order] of [['technology_definitions', 'length(id),id'], ['technology_stats', 'recipeId,tick'],
    ['technology_executions', 'serial'], ['technology_origin', 'id']]) {
    const digest = createHash('sha256'); let rows = 0;
    for (const row of store.db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).iterate()) {
      rows++; digest.update(JSON.stringify(row)); digest.update('\n');
    }
    archiveHashes[table!] = { rows, sha256: digest.digest('hex') };
  }
  const sourceHashesAfter = hashes();
  if (!isDeepStrictEqual(sourceHashesBefore, sourceHashesAfter)) throw new Error('Profile source changed during measurement');
  const result = { source, mode, cadence, rounds, sourceHashesBefore, sourceHashesAfter, loadMs, samples,
    finalTick: world.tick, finalStateHash: digestoCanonico(world), finalStateHashEncoding: 'digestoCanonico',
    snapshotBodyHash: snapshot.bodyDigest, snapshotBodyBytes: snapshot.bodyBytes,
    archiveHashes, snapshotBytes: snapshot.snapshotBytes };
  writeFileSync(join(directory, 'profile.json'), JSON.stringify(result, null, 2) + '\n');
  const ordered = samples.map(sample => sample.saveMs).sort((a, b) => a - b);
  console.log(JSON.stringify({ mode, cadence, medianSaveMs: (ordered[Math.floor((rounds - 1) / 2)]! + ordered[Math.floor(rounds / 2)]!) / 2,
    finalStateHash: result.finalStateHash, output: join(directory, 'profile.json') }));
} finally { store.close(); }
