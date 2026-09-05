import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/server/store.js';
import { assertWorld, createWorld, stepWorld, TICKS_PER_DAY, type Person, type World } from '../src/world/index.js';
import { GENE_COUNT } from '../src/world/genetics.js';
import { projectTechnology } from '../src/world/technology.js';
import { analyzeTechnologyOrganization } from '../src/world/technology-organization.js';

// This is an observational run of the production world rules. Nothing here supplies
// gestures, parents, food, replacement inhabitants, destinations, or research designs.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAVE_EVERY = 120, SAMPLE_EVERY = 1200;
const LOCI = ['curiosity', 'sociability', 'industriousness', 'care', 'resilience', 'learning', 'cooperation'] as const;

function options() {
  const values = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]!;
    if (arg === '--help' || arg === '-h') {
      console.log('Uso: npx tsx scripts/evolution.ts [--days 15..25] [--seeds 51926,20260905] [--output artifacts/evolution-v5.json]\n' +
        'Variables: EVOLUTION_DAYS, EVOLUTION_SEEDS, EVOLUTION_OUTPUT.\n' +
        'Sin gestos ni rescates. SQLite/yield cada 120 ticks; muestras cada 1200; reinicio a mitad y backup final.\n' +
        'Corrida acelerada observacional; no mide el commit por tick del servidor de producción a 10 Hz.');
      return null;
    }
    const separator = arg.indexOf('='), key = separator < 0 ? arg : arg.slice(0, separator);
    const inline = separator < 0 ? undefined : arg.slice(separator + 1);
    if (!['--days', '--seeds', '--output'].includes(key) || values.has(key)) throw new Error(`Opción desconocida o repetida: ${key}`);
    const value = inline ?? process.argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Falta valor para ${key}`);
    values.set(key, value);
  }
  const days = Number(values.get('--days') ?? process.env.EVOLUTION_DAYS ?? 15);
  if (!Number.isInteger(days) || days < 15 || days > 25) throw new Error('--days / EVOLUTION_DAYS debe estar entre 15 y 25.');
  const seedText = (values.get('--seeds') ?? process.env.EVOLUTION_SEEDS ?? '51926,20260905').split(',');
  const seeds = seedText.map(value => Number(value.trim()));
  if (!seeds.length || seeds.length > 32 || seedText.some(value => !/^\d+$/.test(value.trim())) ||
    seeds.some(seed => !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) || new Set(seeds).size !== seeds.length) {
    throw new Error('--seeds / EVOLUTION_SEEDS requiere de 1 a 32 semillas uint32 distintas separadas por coma.');
  }
  return { days, seeds, output: resolve(ROOT, values.get('--output') ?? process.env.EVOLUTION_OUTPUT ?? 'artifacts/evolution-v5.json') };
}

function sourceDigests(): Record<string, string> {
  const files = ['scripts/evolution.ts', 'package.json', 'package-lock.json', 'tsconfig.json'];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
    }
  };
  for (const directory of ['src/world', 'src/shared', 'src/server']) visit(directory);
  return Object.fromEntries(files.sort().map(path => [path, createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex')]));
}

function distribution(values: number[]) {
  if (!values.length) return { n: 0, mean: null, variance: null, min: null, max: null, bins: Array<number>(10).fill(0) };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const bins = Array<number>(10).fill(0);
  for (const value of values) bins[Math.min(9, Math.floor(value * 10))]!++;
  return { n: values.length, mean, variance: values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length,
    min: Math.min(...values), max: Math.max(...values), bins };
}

function genes(people: readonly Person[]) {
  assert.equal(GENE_COUNT, LOCI.length, 'Update experiment labels when the genetic model changes.');
  const generations: Record<string, number> = {};
  for (const person of people) generations[person.genome.generation] = (generations[person.genome.generation] ?? 0) + 1;
  return { population: people.length, generations, maxGeneration: people.length ? Math.max(...people.map(p => p.genome.generation)) : null,
    loci: LOCI.map((name, index) => ({ name,
      alleles: distribution(people.flatMap(p => p.genome.alleles.slice(index * 2, index * 2 + 2))),
      diploidMean: distribution(people.map(p => (p.genome.alleles[index * 2]! + p.genome.alleles[index * 2 + 1]!) / 2)),
    })) };
}

function newObserver() {
  return { serial: 0, receiptGaps: 0, receipts: 0, kinds: {} as Record<string, number>,
    successfulCrafts: 0, successfulResearch: 0, productInputAttempts: 0, productInputSuccesses: 0,
    positiveToolUses: 0, toolBenefit: 0, requiredCatalystUses: 0, optionalCatalystUses: 0,
    transferPairs: 0, incompleteTransferGroups: 0, craftsByRecipe: {} as Record<string, number>,
    maxGenerationEver: 0, birthsByGeneration: {} as Record<string, number> };
}
type Observer = ReturnType<typeof newObserver>;

/** Consume new receipts every tick, before the bounded in-world history can discard them. */
function observe(world: World, observer: Observer): void {
  const state = world.technology;
  assert.ok(state.executionCounter >= observer.serial, 'Execution counter went backwards.');
  if (state.historyDropped > observer.serial) observer.receiptGaps += state.historyDropped - observer.serial;
  const offset = Math.max(0, observer.serial - state.historyDropped);
  const transfers = new Map<string, typeof state.history>();
  for (const receipt of state.history.slice(offset)) {
    observer.receipts++;
    observer.kinds[receipt.kind] = (observer.kinds[receipt.kind] ?? 0) + 1;
    if (receipt.kind === 'craft' && receipt.success) {
      observer.successfulCrafts++;
      if (receipt.recipeId) observer.craftsByRecipe[receipt.recipeId] = (observer.craftsByRecipe[receipt.recipeId] ?? 0) + 1;
    }
    if (receipt.kind === 'research' && receipt.success) observer.successfulResearch++;
    if (['research', 'craft'].includes(receipt.kind) && receipt.inputs.some(input => input.resourceId.startsWith('recipe:'))) {
      observer.productInputAttempts++;
      if (receipt.success) observer.productInputSuccesses++;
    }
    if (receipt.kind === 'use' && receipt.benefit > 0) { observer.positiveToolUses++; observer.toolBenefit += receipt.benefit; }
    for (const catalyst of receipt.catalysts) {
      if (catalyst.required) observer.requiredCatalystUses++; else observer.optionalCatalystUses++;
    }
    if (receipt.kind === 'transfer') {
      if (!receipt.transferId) observer.incompleteTransferGroups++;
      else transfers.set(receipt.transferId, [...transfers.get(receipt.transferId) ?? [], receipt]);
    }
  }
  for (const group of transfers.values()) {
    if (group.length === 2 && group[0]!.actorId === group[1]!.counterpartyId && group[1]!.actorId === group[0]!.counterpartyId) observer.transferPairs++;
    else observer.incompleteTransferGroups++;
  }
  observer.serial = state.executionCounter;
  for (const person of world.people) {
    observer.maxGenerationEver = Math.max(observer.maxGenerationEver, person.genome.generation);
    if (person.bornAt === world.tick && person.genome.generation > 0) {
      observer.birthsByGeneration[person.genome.generation] = (observer.birthsByGeneration[person.genome.generation] ?? 0) + 1;
    }
  }
}

function sample(world: World, observer: Observer) {
  const neighbors = world.people.filter(p => p.role === 'neighbor');
  const technology = projectTechnology(world);
  const organization = analyzeTechnologyOrganization(world.technology, world.people, world.tick);
  return { tick: world.tick, day: world.tick / TICKS_PER_DAY, population: world.people.length, neighbors: neighbors.length,
    births: world.totals.births ?? 0, deaths: world.demographyDynamics.deaths, demography: structuredClone(world.demographyDynamics),
    genetics: { all: genes(world.people), neighbors: genes(neighbors), protected: genes(world.people.filter(p => p.role !== 'neighbor')) },
    founderNeighborsAlive: neighbors.filter(p => p.genome.generation === 0).length,
    meanHealth: world.people.reduce((sum, p) => sum + p.demography.health, 0) / world.people.length,
    meanHunger: world.people.reduce((sum, p) => sum + p.hunger, 0) / world.people.length,
    meanThirst: world.people.reduce((sum, p) => sum + p.thirst, 0) / world.people.length,
    communities: world.communities.map(community => {
      const members = world.people.filter(p => community.members.includes(p.id));
      return { id: community.id, members: members.length, listedMembers: community.members.length, formedAt: community.formedAt,
        cooperation: community.cooperation, disputes: community.disputes,
        membersWithin7OfCenter: members.filter(p => Math.hypot(p.x - community.x, p.y - community.y) <= 7).length,
        membersWithPeerWithin7: members.filter(p => members.some(q => p !== q && Math.hypot(p.x - q.x, p.y - q.y) <= 7)).length };
    }),
    cooperation: world.totals.cooperation ?? 0, trade: world.totals.trade ?? 0, totals: { ...world.totals },
    technology: { dynamics: technology.dynamics, ledger: structuredClone(world.technology.ledger),
      recipes: technology.recipes.map(r => ({ id: r.id, generation: r.generation, parents: [...r.parents], inventorId: r.inventorId,
        tick: r.tick, uses: r.uses, utility: r.utility, manufactured: r.manufactured, novelty: r.novelty })),
      observedLifetime: structuredClone(observer),
      recipesCraftedMoreThanOnce: Object.values(observer.craftsByRecipe).filter(count => count > 1).length,
      limits: { budgets: { ...world.technology.budgets }, reusedProductsDynamicsScope: 'retained receipts only; lifetime counts are in observedLifetime' } },
    // Keep finite-window failures, stocks, RAF, and maintenance evidence. Dense
    // dependency graphs are counted, not copied into every long-run sample.
    organization: { window: organization.window, boundary: organization.boundary,
      autopoiesisEstablished: organization.autopoiesisEstablished, foodClosure: organization.foodClosure,
      maximalRaf: organization.maximalRaf, constructibleFromFood: organization.constructibleFromFood,
      evidence: organization.evidence, resources: organization.resources, processes: organization.processes,
      maintenance: organization.maintenance, maintainedComponents: organization.maintainedComponents,
      diversity: organization.diversity, actorRoles: organization.actorRoles,
      dependencyCounts: { structural: organization.structuralDependencies.length, observed: organization.observedDependencies.length },
      componentCounts: { structural: organization.structuralComponents.length, observed: organization.observedComponents.length } },
    inventions: { blueprints: world.blueprints.length, maxGeneration: Math.max(0, ...world.blueprints.map(b => b.generation)),
      activeStructures: world.structures.length, activeNonBaseStructures: world.structures.filter(s => s.blueprintId !== 'blueprint-base').length,
      dynamics: { ...world.inventionDynamics } },
    bounds: { activeChunks: Object.keys(world.chunks).length, activeTiles: world.tiles.length,
      legacyCache: world.legacy.length, pendingLegacy: world.retiredLegacy.length, pendingChunks: world.retiredChunks.length,
      retainedReceipts: world.technology.history.length, receiptHistoryDropped: world.technology.historyDropped } };
}

/** Iterate archive rows: the experiment never loads a lifetime identity tree into RAM. */
function verifyBackup(original: Store, backup: Store, world: World) {
  assert.deepEqual(backup.load()!.world, world);
  const count = (store: Store, table: 'legacy' | 'chunks') => (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  assert.equal(count(original, 'legacy'), world.demographyDynamics.deaths);
  assert.equal(count(backup, 'legacy'), count(original, 'legacy'));
  assert.equal(count(backup, 'chunks'), count(original, 'chunks'));
  const legacyDigest = createHash('sha256'), chunkDigest = createHash('sha256');
  let legacyRecords = 0, legacyOutsideCache = 0, chunkVersions = 0;
  const cachedIds = new Set(world.legacy.map(record => record.id));
  for (const row of original.db.prepare('SELECT id,tick FROM legacy ORDER BY id').iterate() as Iterable<{ id: string; tick: number }>) {
    const record = original.loadLegacy(row.id, world.tick);
    assert.ok(record); assert.equal(record.diedAt, row.tick);
    assert.deepEqual(backup.loadLegacy(row.id, world.tick), record);
    legacyDigest.update(JSON.stringify(record) + '\n'); legacyRecords++;
    if (!cachedIds.has(row.id)) legacyOutsideCache++;
  }
  for (const row of original.db.prepare('SELECT key,tick FROM chunks ORDER BY key,tick').iterate() as Iterable<{ key: string; tick: number }>) {
    const chunk = original.loadChunk(row.key, row.tick);
    assert.ok(chunk); assert.deepEqual(backup.loadChunk(row.key, row.tick), chunk);
    chunkDigest.update(JSON.stringify([row.key, row.tick, chunk]) + '\n'); chunkVersions++;
  }
  return { worldEquality: true, legacyRecords, legacyOutsideCache, chunkVersions,
    legacySha256: legacyDigest.digest('hex'), chunksSha256: chunkDigest.digest('hex'),
    emptyLegacyArchive: legacyRecords === 0, identityEvictionObserved: legacyOutsideCache > 0 };
}

async function replicate(seed: number, days: number, publish: (value: unknown) => void) {
  const directory = mkdtempSync(join(tmpdir(), `carta-evolution-${seed}-`));
  const database = join(directory, 'world.sqlite'), backupPath = join(directory, 'backup.sqlite');
  let store = new Store(database), world = createWorld(seed);
  const started = performance.now(), observer = newObserver(), initialPopulation = world.people.length;
  const targetTick = days * TICKS_PER_DAY, restartTick = targetTick / 2;
  const samples: ReturnType<typeof sample>[] = [];
  let extinctionTick: number | null = null, restart: { tick: number; equality: boolean } | null = null;
  let saves = 0, maximumPendingLegacy = 0, maximumPendingChunks = 0, maximumLegacyCache = 0, maximumSnapshotBytes = 0;
  let maximumRssMiB = 0;
  const save = () => {
    store.save(world); saves++; maximumSnapshotBytes = Math.max(maximumSnapshotBytes, store.lastSnapshotBytes);
    assert.equal(world.retiredLegacy.length, 0, 'Committed legacy queue was not cleared.');
    assert.equal(world.retiredChunks.length, 0, 'Committed chunk queue was not cleared.');
  };
  const progress = () => ({ seed, rulesVersion: world.version, targetTick, completedTick: world.tick, restart,
    neighborsExtinctionTick: extinctionTick, samples, saves, wallSeconds: (performance.now() - started) / 1000,
    memory: { maximumPendingLegacy, maximumPendingChunks, maximumLegacyCache, maximumSnapshotBytes, maximumRssMiB } });
  try {
    assertWorld(world); save(); samples.push(sample(world, observer)); publish({ ...progress(), status: 'running' });
    while (world.tick < targetTick) {
      stepWorld(world, [], { loadChunk: (key, tick) => store.loadChunk(key, tick) });
      observe(world, observer);
      if (extinctionTick === null && !world.people.some(p => p.role === 'neighbor')) extinctionTick = world.tick;
      maximumPendingLegacy = Math.max(maximumPendingLegacy, world.retiredLegacy.length);
      maximumPendingChunks = Math.max(maximumPendingChunks, world.retiredChunks.length);
      maximumLegacyCache = Math.max(maximumLegacyCache, world.legacy.length);
      if (world.tick % SAVE_EVERY === 0 || world.tick === restartTick || world.tick === targetTick) {
        assertWorld(world);
        assert.equal(world.people.length, initialPopulation + (world.totals.births ?? 0) - world.demographyDynamics.deaths, 'Population has an unaccounted arrival or disappearance.');
        assert.ok(world.people.every(p => p.command === null && p.controlMode === 'auto'), 'Directed intervention entered the experiment.');
        save(); maximumRssMiB = Math.max(maximumRssMiB, process.memoryUsage().rss / 1024 ** 2);
        if (world.tick === restartTick) {
          store.close(); store = new Store(database);
          const restored = store.load(); assert.ok(restored); assert.deepEqual(restored.world, world);
          world = restored.world; restart = { tick: world.tick, equality: true };
        }
        if (world.tick % SAMPLE_EVERY === 0 || world.tick === targetTick) {
          samples.push(sample(world, observer)); publish({ ...progress(), status: 'running' });
          console.log(JSON.stringify({ seed, tick: world.tick, day: world.tick / TICKS_PER_DAY, population: world.people.length,
            births: world.totals.births ?? 0, deaths: world.demographyDynamics.deaths, neighborsExtinctionTick: extinctionTick }));
        }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
    assertWorld(world); assert.deepEqual(store.load()!.world, world); assert.ok(restart?.equality);
    assert.equal(observer.receipts + observer.receiptGaps, world.technology.executionCounter);
    const persistedInputs = (store.db.prepare('SELECT COUNT(*) AS n FROM inputs').get() as { n: number }).n;
    assert.equal(persistedInputs, 0);
    store.backup(backupPath);
    const backup = new Store(backupPath, { readOnly: true });
    let archive: ReturnType<typeof verifyBackup>;
    try { archive = verifyBackup(store, backup, world); } finally { backup.close(); }
    const report = { ...progress(), status: 'completed', endpoint: world.people.every(p => p.role !== 'neighbor') ? 'protected-pair-only' : 'neighbors-present',
      persistedInputs, finalLoadEquality: true, backup: archive, observerComplete: observer.receiptGaps === 0,
      databaseBytes: statSync(database).size, backupBytes: statSync(backupPath).size,
      temporaryDatabasesRetained: false };
    publish(report); return report;
  } catch (error) {
    const report = { ...progress(), status: 'failed', error: error instanceof Error ? `${error.name}: ${error.message}` : String(error), temporaryDatabasesRetained: false };
    publish(report); return report;
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}

async function main() {
  const config = options(); if (!config) return;
  const sourceAtStart = sourceDigests(), startedAt = new Date().toISOString();
  const replicas: unknown[] = [];
  const base = { schemaVersion: 1, startedAt, node: process.version, requestedDays: config.days, seeds: config.seeds,
    ticksPerDay: TICKS_PER_DAY, saveEveryTicks: SAVE_EVERY, sampleEveryTicks: SAMPLE_EVERY,
    mode: 'accelerated autonomous production rules; mutable world; SQLite every 120 ticks; sequential replicas; no browser',
    interventions: { gestures: 0, forcedBirths: 0, refills: 0, reseeding: 0 }, sourceAtStart,
    interpretation: {
      performance: 'Persistence cadence differs from the server at 10 Hz with commit each tick. Wall duration and sampled RSS describe only this experiment, not production commit latency or capacity.',
      genetics: 'Seven artificial diploid parameter loci, separately sampled for neighbors and protected S/I. Allele shifts do not isolate selection from drift, mortality or founder effects; skills and learned culture are not DNA. Histogram bins are [0,.1),...,[.9,1].',
      demography: 'S/I follow the explicit continuity-protection policy. Zero neighbors is recorded immediately; the run continues without replenishment or changing seed, so any later natural recovery remains observable.',
      organization: 'Finite retained receipt windows only. RAF, material balance, useful production, product reuse and maintained cycles are separate observations. Missing evidence stays unknown; autopoiesis and open-ended evolution are not established by counters.',
      persistence: 'Real reopen at midpoint and final load/backup comparison. Queues clear only after successful Store.save; temporary experiment databases are removed after validation. Zero archived deaths cannot demonstrate identity eviction.',
      limits: 'No physical browser, wall-clock deployment, crash between checkpoint commits, neutral-selection control or ecological full-world mass balance. Samples of spatial community membership are observations within radius 7, not proof of sustained social organization. Source hashes certify matching start/end files, not absence of transient edits between checks.',
    } };
  mkdirSync(dirname(config.output), { recursive: true });
  const write = (state: Record<string, unknown>) => {
    const temporary = `${config.output}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ ...base, ...state, replicas }, null, 2) + '\n');
    renameSync(temporary, config.output);
  };
  let failed = false;
  for (const seed of config.seeds) {
    const index = replicas.length;
    const report = await replicate(seed, config.days, value => { replicas[index] = value; write({ status: 'running', sourceAtEnd: null, sourceUnchanged: null }); });
    if (report.status === 'failed') failed = true;
    // Never run further replicas against a different source snapshot.
    if (JSON.stringify(sourceDigests()) !== JSON.stringify(sourceAtStart)) { failed = true; break; }
  }
  const sourceAtEnd = sourceDigests(), sourceUnchanged = JSON.stringify(sourceAtStart) === JSON.stringify(sourceAtEnd);
  failed ||= !sourceUnchanged || replicas.length !== config.seeds.length;
  write({ status: failed ? 'failed' : 'completed', completedAt: new Date().toISOString(), sourceAtEnd, sourceUnchanged });
  console.log(JSON.stringify({ output: config.output, status: failed ? 'failed' : 'completed', sourceUnchanged, replicas: replicas.length }));
  if (failed) process.exitCode = 1;
}

await main();
