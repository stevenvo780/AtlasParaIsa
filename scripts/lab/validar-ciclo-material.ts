/** Frozen Objective9 gate. No public inputs; dynamic baseline/candidate module graphs.
 * --selftest initializes fixtures only (ZERO stepWorld calls).
 * --run requires the parent's --authorized barrier and immutable protocol/source hashes.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { getPriority, setPriority, tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { World } from '../../src/world/index.js';
import type { Store } from '../../src/server/store.js';
import type { MaterialObserver, MaterialObserverExport } from '../../src/world/material-observer.js';
import type { StructureView } from '../../src/shared/life.js';

const LAB = '/datos/tmp-atlas-lab';
const ROOT = resolve(import.meta.dirname, '../..');
const V1 = join(LAB, 'datos-lab/CODEX9-PROTOCOLO-INSTRUMENTO.json');
const V1_HASH = '9795333d632e9a2b04b547ddc6df504cf91c1df9c519a5a85e78b8b6eb923762';
const DEFAULT_PROTOCOL = join(LAB, 'datos-lab/CODEX9-PROTOCOLO-EVENTOS-v3.json');
const SEEDS = [17001, 17002, 17003, 17004, 17005, 17006];
const FAMILIES = ['fresh', 'material-stressed'] as const;
type Family = typeof FAMILIES[number];
type Label = 'A1' | 'A2' | 'B1' | 'B2';
type Duration = { cpuMs: number; wallMs: number };
type Protocol = { schema: string; baselineCommit: string; seeds: number[]; families: string[];
  steps: number; blockSteps: number; rounds: number; checkpoints: number[]; params: string;
  orders: Label[][]; sourceAllowlist: string[]; bootstrap: { replicates: number; rngSeed: number };
  gate: { maxOverhead: number }; measuredWorlds: number; measuredSteps: number; limitations: string[] };
type Graph = { world: typeof import('../../src/world/index.js'); params: typeof import('../../src/world/params.js');
  inventions: typeof import('../../src/world/inventions.js'); terrain: typeof import('../../src/world/terrain.js');
  animals: typeof import('../../src/world/animals.js'); Store: typeof import('../../src/server/store.js').Store;
  digest: typeof import('../../src/world/digesto.js').digestoCanonico; factory?: () => MaterialObserver };
const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const json = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const clock = (): Duration => { const { user, system } = process.cpuUsage(); return { cpuMs: (user + system) / 1000, wallMs: performance.now() }; };
const difference = (before: Duration): Duration => { const after = clock(); return { cpuMs: after.cpuMs - before.cpuMs, wallMs: after.wallMs - before.wallMs }; };
const add = (target: Duration, value: Duration): void => { target.cpuMs += value.cpuMs; target.wallMs += value.wallMs; };
const zero = (): Duration => ({ cpuMs: 0, wallMs: 0 });
function option(flag: string): string | undefined { const i = process.argv.indexOf(flag); return i < 0 ? undefined : process.argv[i + 1]; }
function insideLab(path: string): string {
  const absolute = resolve(path); assert.ok(absolute.startsWith(LAB + '/'), 'Only new laboratory paths permitted'); return absolute;
}

export function cpuList(text: string): number[] {
  const result: number[] = [];
  for (const item of text.trim().split(',')) {
    assert.match(item, /^\d+(?:-\d+)?$/);
    const [from, rawTo] = item.split('-').map(Number), to = rawTo ?? from;
    assert.ok(from <= to && to < 4096);
    for (let n = from; n <= to; n++) result.push(n);
  }
  return result;
}
function guard(stage: string) {
  const status = readFileSync('/proc/self/status', 'utf8');
  const allowed = status.match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1]; assert.ok(allowed);
  const value = { stage, nice: getPriority(0), cpus: cpuList(allowed), runtime: process.execPath,
    title: process.title, TMPDIR: process.env.TMPDIR, sampledAt: new Date().toISOString() };
  assert.equal(value.nice, 19, 'resource drift: nice');
  assert.deepEqual(value.cpus, Array.from({ length: 26 }, (_, i) => i + 6), 'resource drift: affinity');
  assert.equal(basename(value.runtime), 'codex9-node', 'Copied runtime required');
  assert.equal(value.title, 'codex9gate'); assert.equal(value.TMPDIR, LAB); assert.equal(tmpdir(), LAB);
  return value;
}
function loadProtocol(path: string): Protocol {
  assert.equal(sha(readFileSync(V1)), V1_HASH, 'Preserved v1 changed');
  const p = json<Protocol>(insideLab(path));
  const chain = json<{ supersedes: { path: string; sha256: string } }>(path);
  assert.equal(sha(readFileSync(insideLab(chain.supersedes.path))), chain.supersedes.sha256, 'Preserved v2 changed');
  assert.equal(p.schema, 'codex9-material-observer-events-gate-v3');
  assert.equal(p.baselineCommit, 'bb483260b2489fe62b113d620e5f56e5f3676dbc');
  assert.deepEqual(p.seeds, SEEDS); assert.deepEqual(p.families, [...FAMILIES]);
  assert.equal(p.steps, 1200); assert.equal(p.blockSteps, 50); assert.equal(p.rounds, 2);
  assert.deepEqual(p.checkpoints, [0, 300, 600, 900, 1200]);
  assert.deepEqual(p.orders, [['A1', 'B1', 'B2', 'A2'], ['B1', 'A1', 'A2', 'B2']]);
  assert.equal(p.params, 'social.radioConvivencia=12,social.disolucion=1,social.maxComunidades=64');
  assert.equal(p.bootstrap.replicates, 10000); assert.equal(p.bootstrap.rngSeed, 912037);
  assert.equal(p.gate.maxOverhead, 0.01); assert.equal(p.measuredWorlds, 96); assert.equal(p.measuredSteps, 115200);
  assert.deepEqual([...p.sourceAllowlist].sort(), ['src/world/halo.ts', 'src/world/index.ts',
    'src/world/inventions.ts', 'src/world/material-observer.ts', 'src/world/spatial.ts'].sort());
  return p;
}
function sourceMap(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.name.endsWith('.ts')) result[relative(root, child)] = sha(readFileSync(child));
    }
  }
  for (const directory of ['src/server', 'src/shared', 'src/world']) visit(join(root, directory));
  return result;
}
function sources(base: string, p: Protocol) {
  assert.ok(realpathSync(base).startsWith(LAB + '/'), 'Baseline must be the read-only laboratory export');
  const manifestPath = join(base, 'SOURCE-MANIFEST.json');
  const manifest = json<{ baseCommit: string; archiveSHA256: string; files: { path: string; sha256: string }[] }>(manifestPath);
  assert.equal(manifest.baseCommit, p.baselineCommit);
  const baseline = sourceMap(base), candidate = sourceMap(ROOT);
  assert.equal(Object.keys(baseline).length, manifest.files.length);
  for (const entry of manifest.files) assert.equal(baseline[entry.path], entry.sha256, `Baseline drift: ${entry.path}`);
  const changed = [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])]
    .filter(path => baseline[path] !== candidate[path]).sort();
  for (const path of changed) assert.ok(p.sourceAllowlist.includes(path), `Unapproved source difference: ${path}`);
  assert.ok(changed.includes('src/world/material-observer.ts'), 'Candidate observer missing');
  return { baseline, candidate, changed, manifestSHA256: sha(readFileSync(manifestPath)), archiveSHA256: manifest.archiveSHA256,
    runnerSHA256: sha(readFileSync(new URL(import.meta.url))), runtimeSHA256: sha(readFileSync(process.execPath)) };
}
async function graph(root: string, candidate: boolean): Promise<Graph> {
  const load = (path: string) => import(pathToFileURL(join(root, path)).href);
  const [world, params, inventions, terrain, animals, store, digest] = await Promise.all([
    load('src/world/index.ts'), load('src/world/params.ts'), load('src/world/inventions.ts'), load('src/world/terrain.ts'),
    load('src/world/animals.ts'), load('src/server/store.ts'), load('src/world/digesto.ts')]);
  const factory = candidate ? (await load('src/world/material-observer.ts')).createMaterialObserver : undefined;
  return { world, params, inventions, terrain, animals, Store: store.Store, digest: digest.digestoCanonico, factory } as Graph;
}

/** Only synthetic setup; no S/I, memory, RNG or rule changes. Both graphs receive identical setup. */
export function fixture(api: Graph, seed: number, family: Family, params: string): World {
  const world = api.world.createWorld(seed, api.params.parseParams(params));
  if (family === 'fresh') return world;
  const neighbor = world.people.find(person => person.role === 'neighbor'); assert.ok(neighbor);
  const components: StructureView['components'] = ['frame', 'roof', 'cistern', 'granary'];
  world.blueprints.push({ id: 'blueprint-1', name: 'Synthetic material fixture', components, generation: 1,
    parents: ['blueprint-base'], inventorId: neighbor.id, tick: 0, uses: 0, usefulness: 0, cost: api.inventions.blueprintCost(components) });
  world.blueprintCounter = 1; world.structureCounter = 16;
  const occupied = new Set(world.structures.map(s => `${s.x},${s.y}`));
  const tiles = world.tiles.filter(tile => tile.terrain !== 'water' && !occupied.has(`${tile.x},${tile.y}`))
    .sort((a, b) => Math.hypot(a.x - neighbor.x, a.y - neighbor.y) - Math.hypot(b.x - neighbor.x, b.y - neighbor.y) || a.y - b.y || a.x - b.x).slice(0, 8);
  assert.equal(tiles.length, 8);
  const make = (id: number, x: number, y: number): StructureView => ({ id: `structure-${id}`, x, y,
    blueprintId: 'blueprint-1', name: 'Synthetic material fixture', components: [...components],
    condition: [1, 0.5, 0.10001, 0.05][(id - 1) % 4]!, water: 0.3, food: 0.35, uses: 0, builtAt: 0, builderId: neighbor.id });
  for (const [i, tile] of tiles.entries()) { tile.terrain = 'shelter'; world.structures.push(make(i + 1, tile.x, tile.y)); }
  const cistern = tiles[0]!; cistern.drinkingWater = 0;
  neighbor.x = cistern.x; neighbor.y = cistern.y; neighbor.target = { x: cistern.x, y: cistern.y };
  neighbor.thirst = 0.5; neighbor.action = 'drink'; neighbor.decisionAt = 1000;
  const dormant = api.terrain.generateChunk(seed, 100, 100, api.params.paramsOf(world).agua.cuencas);
  dormant.animals = api.animals.materializeAnimals(seed, dormant.tiles, 0);
  dormant.structures = api.terrain.legacyStructures(dormant.tiles, 0);
  const available = dormant.tiles.filter(tile => tile.terrain !== 'water' && tile.terrain !== 'shelter').slice(0, 8);
  assert.equal(available.length, 8);
  for (const [i, tile] of available.entries()) { tile.terrain = 'shelter'; dormant.structures.push(make(i + 9, tile.x, tile.y)); }
  dormant.lifeVersion = 4; world.retiredChunks.push(dormant);
  world.settlementCount += 16;
  return world;
}
function deterministicSave(store: Store, world: World): void {
  const previous = Date.now;
  Date.now = () => 1_000_000_000_000 + world.tick;
  try { store.save(world); } finally { Date.now = previous; }
}
function logicalDatabaseDigest(store: Store): { sha256: string; tables: Record<string, number> } {
  const hash = createHash('sha256'), tables: Record<string, number> = {};
  const names = store.db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name").all() as { name: string; sql: string }[];
  const quoted = (name: string) => '"' + name.replaceAll('"', '""') + '"';
  const replacer = (_key: string, value: unknown) => typeof value === 'bigint' ? { bigint: String(value) }
    : value instanceof Uint8Array ? { hex: Buffer.from(value).toString('hex') } : value;
  for (const { name, sql } of names) {
    const columns = store.db.prepare(`PRAGMA table_info(${quoted(name)})`).all() as { name: string }[];
    hash.update(JSON.stringify({ name, sql, columns: columns.map(c => c.name) }) + '\n'); tables[name] = 0;
    const statement = store.db.prepare(`SELECT * FROM ${quoted(name)} ORDER BY ${columns.map(c => quoted(c.name)).join(',')}`);
    for (const row of statement.iterate()) { hash.update(JSON.stringify(row, replacer) + '\n'); tables[name]++; }
  }
  return { sha256: hash.digest('hex'), tables };
}
class BufferedObserverFile {
  private readonly fd: number;
  private readonly buffer = Buffer.alloc(65536);
  private length = 0;
  private readonly hash = createHash('sha256');
  records = 0; bytes = 0; writes = 0;
  constructor(path: string) { this.fd = openSync(path, 'wx', 0o600); }
  private flush(): void {
    if (!this.length) return;
    let written = 0;
    while (written < this.length) { const n = writeSync(this.fd, this.buffer, written, this.length - written); assert.ok(n > 0); written += n; this.writes++; }
    this.hash.update(this.buffer.subarray(0, this.length)); this.length = 0;
  }
  append(value: unknown): void {
    const line = JSON.stringify(value); assert.ok(line !== undefined, 'Unsupported observer export');
    const bytes = Buffer.from(line + '\n'); this.bytes += bytes.length; this.records++;
    for (let from = 0; from < bytes.length;) {
      const n = Math.min(bytes.length - from, this.buffer.length - this.length);
      bytes.copy(this.buffer, this.length, from, from + n); from += n; this.length += n;
      if (this.length === this.buffer.length) this.flush();
    }
  }
  export(exported: MaterialObserverExport, tick: number): void {
    assert.equal(exported.version, 1);
    this.append({ kind: 'coverage', tick, version: exported.version, coverage: exported.coverage });
    for (const row of exported.structures) this.append({ kind: 'structure', tick, row });
    for (const row of exported.daily) this.append({ kind: 'daily', tick, row });
    this.flush();
  }
  close() { this.flush(); closeSync(this.fd); return { sha256: this.hash.digest('hex'), bytes: this.bytes, records: this.records, writes: this.writes }; }
}

type Block = Duration & { from: number; to: number; order: Label[] };
type Checkpoint = { step: number; tick: number; world: string; database: ReturnType<typeof logicalDatabaseDigest> };
type Residency = { id: string; chunkKey: string; state: 'active' | 'dormant' | 'unknown';
  source: 'resident' | 'pending' | 'archive' | 'missing'; condition?: number; uses?: number };
function residency(world: World, store: Store, loadArchive: boolean): Residency[] {
  const rows: Residency[] = [], archive = loadArchive ? store.context.loadChunk?.('100,100', world.tick) : undefined;
  for (let serial = 1; serial <= 16; serial++) {
    const id = `structure-${serial}`, resident = world.structures.find(s => s.id === id);
    const pending = world.retiredChunks.flatMap(c => c.structures ?? []).find(s => s.id === id);
    const archived = archive?.structures?.find(s => s.id === id), structure = resident ?? pending ?? archived;
    const key = structure ? `${Math.floor(structure.x / 16)},${Math.floor(structure.y / 16)}` : '';
    const source = resident ? 'resident' : pending ? 'pending' : archived ? 'archive' : 'missing';
    const state = resident && Object.hasOwn(world.chunks, key) ? 'active'
      : structure && !Object.hasOwn(world.chunks, key) ? 'dormant' : 'unknown';
    rows.push({ id, chunkKey: key, state, source, condition: structure?.condition, uses: structure?.uses });
  }
  return rows;
}
type Arm = { label: Label; api: Graph; world: World; store: Store; dir: string; observer?: MaterialObserver;
  sink?: BufferedObserverFile; initial: Duration; closing: Duration; sharedSetup: Duration; blocks: Block[];
  checkpoints: Checkpoint[]; observerFinal?: MaterialObserverExport; sinkFinal?: ReturnType<BufferedObserverFile['close']>;
  usesSeen: number; brokenSeen: Set<string>; initialHealthy: Set<string>; closed: boolean;
  initialResidency: Residency[]; firstStepResidency?: Residency[]; finalResidency?: Residency[];
  minimumActiveExposureTicks: number; minimumDormantExposureTicks: number };
function initialize(api: Graph, label: Label, seed: number, family: Family, p: Protocol): Arm {
  const setup = clock(), dir = mkdtempSync(join(tmpdir(), 'codex9gate-'));
  const store = new api.Store(join(dir, 'world.sqlite'));
  try {
    const world = fixture(api, seed, family, p.params); api.world.assertWorld(world);
    const initialResidency = family === 'material-stressed' ? residency(world, store, false) : [];
    if (family === 'material-stressed') {
      assert.equal(initialResidency.filter(r => r.state === 'active').length, 8);
      assert.equal(initialResidency.filter(r => r.state === 'dormant').length, 8);
    }
    const initialHealthy = new Set(world.structures.filter(s => /^structure-\d+$/.test(s.id) && s.condition > 0.1).map(s => s.id));
    const sharedSetup = difference(setup), initial = zero();
    let observer: MaterialObserver | undefined, sink: BufferedObserverFile | undefined, observerFinal: MaterialObserverExport | undefined;
    if (label.startsWith('B')) {
      assert.ok(api.factory); const start = clock(); observer = api.factory(); observer.ingest(world);
      sink = new BufferedObserverFile(join(dir, 'observer.jsonl'));
      observerFinal = observer.exportRows(); sink.export(observerFinal, world.tick); add(initial, difference(start));
    }
    const save = clock(); deterministicSave(store, world); add(sharedSetup, difference(save));
    return { label, api, world, store, dir, observer, sink, initial, sharedSetup, closing: zero(), blocks: [],
      checkpoints: [], observerFinal, initialHealthy, usesSeen: 0, brokenSeen: new Set(), closed: false,
      initialResidency, minimumActiveExposureTicks: 0, minimumDormantExposureTicks: 0 };
  } catch (error) { store.close(); rmSync(dir, { recursive: true, force: true }); throw error; }
}
function checkpoint(arm: Arm, step: number): void {
  arm.checkpoints.push({ step, tick: arm.world.tick, world: arm.api.digest(arm.world), database: logicalDatabaseDigest(arm.store) });
}
function advance(arm: Arm, from: number, to: number, order: Label[], p: Protocol): void {
  let start = clock(); const elapsed = zero();
  for (let n = from + 1; n <= to; n++) {
    arm.api.world.stepWorld(arm.world);
    arm.observer?.ingest(arm.world); // before Store.save drains pending chunks/journals
    if (arm.world.tick % arm.api.params.paramsOf(arm.world).persistencia.cadaTicks === 0) deterministicSave(arm.store, arm.world);
    if (p.checkpoints.includes(n) && arm.observer && arm.sink) {
      arm.observerFinal = arm.observer.exportRows(); arm.sink.export(arm.observerFinal, arm.world.tick);
    }
    if (n === 1 && arm.initialResidency?.length) {
      add(elapsed, difference(start)); // Pause timing for independent topology evidence.
      arm.firstStepResidency = residency(arm.world, arm.store, true);
      const remained = (state: Residency['state']) => arm.initialResidency.filter(row => row.state === state
        && arm.firstStepResidency!.find(after => after.id === row.id)?.state === state).length;
      arm.minimumActiveExposureTicks = remained('active'); arm.minimumDormantExposureTicks = remained('dormant');
      start = clock();
    }
  }
  add(elapsed, difference(start)); arm.blocks.push({ from, to, order: [...order], ...elapsed });
  // Independent coverage scan is OUTSIDE the timing block, equally applied to all arms.
  for (const structure of arm.world.structures) {
    if (!/^structure-\d+$/.test(structure.id)) continue;
    arm.usesSeen = Math.max(arm.usesSeen, structure.uses);
    if (arm.initialHealthy.has(structure.id) && structure.condition <= 0.1) arm.brokenSeen.add(structure.id);
  }
}
function closeObserver(arm: Arm): void {
  if (!arm.sink || arm.sinkFinal) return;
  const start = clock(); arm.sinkFinal = arm.sink.close(); arm.observer?.discard(arm.world); add(arm.closing, difference(start));
}
function dispose(arm: Arm): void {
  if (arm.closed) return;
  try { closeObserver(arm); }
  finally { try { arm.store.close(); } finally { rmSync(arm.dir, { recursive: true, force: true }); arm.closed = true; } }
}
function armResult(arm: Arm, family: Family) {
  closeObserver(arm);
  arm.finalResidency = family === 'material-stressed' ? residency(arm.world, arm.store, true) : [];
  const total = zero(); add(total, arm.initial); add(total, arm.closing); for (const block of arm.blocks) add(total, block);
  const steps = arm.blocks.reduce((sum, block) => sum + block.to - block.from, 0);
  const observer = arm.observerFinal;
  const fixtureRows = observer?.structures.filter(row => /^structure-(?:[1-9]|1[0-6])$/.test(row.id)) ?? [];
  const horizon = observer?.coverage.endTick ?? 0;
  const instrumentCoverage = observer ? {
    attachedPendingDormant: observer.coverage.attachments[0]?.pendingDormantStructures ?? 0,
    brokenCrossings: observer.structures.reduce((sum, row) => sum + row.brokenCrossings, 0),
    wearEvaluations: observer.structures.reduce((sum, row) => sum + row.wearEvaluations, 0),
    activeExposureTicks: observer.structures.reduce((sum, row) => sum + row.activeExposureTicks, 0),
    fixtureActiveExposureTicks: fixtureRows.reduce((sum, row) => sum + row.activeExposureTicks, 0),
    fixtureDormantExposureTicks: fixtureRows.reduce((sum, row) => sum + horizon - row.firstObservedTick - row.activeExposureTicks, 0),
    fixtureExposureComplete: fixtureRows.length === 16 && observer.coverage.observationGaps.length === 0
      && fixtureRows.every(row => row.firstObservedTick === 0 && row.activeExposureTicks >= 0 && row.activeExposureTicks <= horizon),
    dailyUses: observer.daily.reduce((sum, row) => sum + row.uses.food + row.uses.water + row.uses.rest, 0),
    observedSyntheticDormant: observer.structures.filter(row => /^structure-(?:9|1[0-6])$/.test(row.id)).length,
    explicitlyUnsupportedRuin: observer.structures.every(row => row.explicitRuinInModel === false),
  } : undefined;
  const topologyPassed = family === 'fresh' || (arm.initialResidency.filter(row => row.state === 'active').length === 8
    && arm.initialResidency.filter(row => row.state === 'dormant').length === 8
    && arm.minimumActiveExposureTicks >= 1 && arm.minimumDormantExposureTicks >= 1
    && arm.finalResidency.every(row => row.state !== 'unknown'));
  const fixturePassed = family === 'fresh' || (topologyPassed && arm.usesSeen > 0 && (observer
    ? !!instrumentCoverage && instrumentCoverage.brokenCrossings > 0 && instrumentCoverage.wearEvaluations > 0
      && instrumentCoverage.activeExposureTicks > 0 && instrumentCoverage.dailyUses > 0
      && instrumentCoverage.observedSyntheticDormant === 8 && instrumentCoverage.attachedPendingDormant >= 8
      && instrumentCoverage.fixtureExposureComplete
      && instrumentCoverage.fixtureActiveExposureTicks >= arm.minimumActiveExposureTicks
      && instrumentCoverage.fixtureDormantExposureTicks >= arm.minimumDormantExposureTicks
      && !!arm.sinkFinal && arm.sinkFinal.bytes > 0 && arm.sinkFinal.records > 0
    : arm.brokenSeen.size > 0));
  return { label: arm.label, total, initialObserver: arm.initial, closeObserver: arm.closing,
    sharedSetup: arm.sharedSetup, blocks: arm.blocks, checkpoints: arm.checkpoints,
    steps, cpuMsPerStep: total.cpuMs / steps, wallMsPerStep: total.wallMs / steps,
    blockCpuMsPerStep: descriptive(arm.blocks.map(b => b.cpuMs / (b.to - b.from))),
    blockWallMsPerStep: descriptive(arm.blocks.map(b => b.wallMs / (b.to - b.from))),
    fixture: { passed: fixturePassed, topologyPassed, usesSeen: arm.usesSeen, brokenSeen: [...arm.brokenSeen], instrumentCoverage,
      initialResidency: { tick: 0, rows: arm.initialResidency }, firstStepResidency: { tick: 1, rows: arm.firstStepResidency },
      finalResidency: { tick: arm.world.tick, rows: arm.finalResidency }, minimumActiveExposureTicks: arm.minimumActiveExposureTicks,
      minimumDormantExposureTicks: arm.minimumDormantExposureTicks, independentDurationWindow: '[0,1) only; remaining lifetime measured exactly by B observer' },
    observerFile: arm.sinkFinal, observerFinal: observer };
}
type ArmResult = ReturnType<typeof armResult>;
type Quartet = { seed: number; family: Family; round: number; arms: ArmResult[]; identical: boolean; fixturePassed: boolean };
function identity(arms: Arm[]): boolean {
  const reference = arms[0]!.checkpoints;
  return arms.every(arm => JSON.stringify(arm.checkpoints) === JSON.stringify(reference));
}
async function quartet(apis: { A: Graph; B: Graph }, seed: number, family: Family, round: number,
  p: Protocol, resources: ReturnType<typeof guard>[], warmup = false): Promise<Quartet> {
  const arms: Arm[] = [], order = warmup ? ['A1', 'B1'] as Label[] : p.orders[round]!;
  try {
    for (const label of order) arms.push(initialize(apis[label.startsWith('A') ? 'A' : 'B'], label, seed, family, p));
    for (const arm of arms) checkpoint(arm, 0);
    assert.ok(identity(arms), `Initial identity differs: ${seed}/${family}/${round}`);
    const steps = warmup ? 300 : p.steps;
    for (let from = 0; from < steps; from += p.blockSteps) {
      const to = Math.min(from + p.blockSteps, steps);
      resources.push(guard(`${seed}/${family}/${round}/before${from}`));
      for (const label of order) advance(arms.find(arm => arm.label === label)!, from, to, order, p);
      if (p.checkpoints.includes(to)) {
        for (const arm of arms) checkpoint(arm, to);
        resources.push(guard(`${seed}/${family}/${round}/after${to}`));
        assert.ok(identity(arms), `Checkpoint identity differs: ${seed}/${family}/${round}/${to}`);
      }
    }
    for (const arm of arms) arm.api.world.assertWorld(arm.world);
    const results = arms.map(arm => armResult(arm, family));
    const result = { seed, family, round, arms: results, identical: identity(arms), fixturePassed: results.every(a => a.fixture.passed) };
    assert.ok(result.fixturePassed, `Fixture event coverage failed: ${seed}/${family}/${round}`);
    return result;
  } catch (error) {
    for (const arm of arms) try { closeObserver(arm); } catch { /* Preserve original failure. */ }
    const wrapped = new Error(error instanceof Error ? error.message : String(error)) as Error & { partial: unknown };
    wrapped.partial = { seed, family, round, arms: arms.map(arm => ({ label: arm.label, tick: arm.world.tick,
      initial: arm.initial, closing: arm.closing, blocks: arm.blocks, checkpoints: arm.checkpoints,
      observerFile: arm.sinkFinal, observerFinal: arm.observerFinal })) };
    throw wrapped;
  } finally { for (const arm of arms) dispose(arm); }
}
export function percentile(values: readonly number[], p: number): number {
  assert.ok(values.length && values.every(Number.isFinite));
  const sorted = [...values].sort((a, b) => a - b), position = (sorted.length - 1) * p;
  const low = Math.floor(position), high = Math.ceil(position);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
}
function descriptive(values: readonly number[]) { return { n: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length,
  p50: percentile(values, 0.5), p95: percentile(values, 0.95) }; }
type Ratio = { seed: number; round: number; logRatio: number };
export function pairedConfidence(rows: readonly Ratio[], replicates = 10000, rngSeed = 912037) {
  assert.equal(rows.length, 12);
  const bySeed = new Map(SEEDS.map(seed => [seed, rows.filter(row => row.seed === seed).sort((a, b) => a.round - b.round)]));
  for (const pairs of bySeed.values()) { assert.deepEqual(pairs.map(p => p.round), [0, 1]); assert.ok(pairs.every(p => Number.isFinite(p.logRatio))); }
  let state = rngSeed >>> 0;
  const random = (n: number): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return Math.floor(state / 0x100000000 * n); };
  const estimates: number[] = [];
  for (let r = 0; r < replicates; r++) {
    let total = 0;
    for (let s = 0; s < 6; s++) { const pairs = bySeed.get(SEEDS[random(6)]!)!; for (let round = 0; round < 2; round++) total += pairs[random(2)]!.logRatio; }
    estimates.push(Math.expm1(total / 12));
  }
  const estimate = Math.expm1(rows.reduce((sum, row) => sum + row.logRatio, 0) / rows.length);
  const ci95 = [percentile(estimates, 0.025), percentile(estimates, 0.975)];
  return { estimate, ci95, passesOnePercent: ci95[1]! <= 0.01, replicates, rngSeed,
    reason: ci95[1]! <= 0.01 ? 'upper95CI<=1%' : estimate > 0.01 ? 'observed overhead>1%' : '1% unresolved by confidence interval' };
}
function analyze(quartets: Quartet[], p: Protocol) {
  assert.equal(quartets.length, 24);
  const result: Record<string, unknown> = {}; let passed = true;
  for (const family of FAMILIES) {
    const rows = quartets.filter(q => q.family === family); assert.equal(rows.length, 12);
    const metrics: Record<string, unknown> = {};
    for (const metric of ['cpuMs', 'wallMs'] as const) {
      const ratios: Ratio[] = [], aa: number[] = [], blocks: number[] = [];
      for (const row of rows) {
        const get = (label: Label) => row.arms.find(a => a.label === label)!;
        const a = get('A1').total[metric] + get('A2').total[metric], b = get('B1').total[metric] + get('B2').total[metric];
        assert.ok(a > 0 && b > 0); ratios.push({ seed: row.seed, round: row.round, logRatio: Math.log(b / a) });
        aa.push(get('A2').total[metric] / get('A1').total[metric] - 1);
        for (let i = 0; i < get('A1').blocks.length; i++) {
          blocks.push((get('B1').blocks[i]![metric] + get('B2').blocks[i]![metric]) /
            (get('A1').blocks[i]![metric] + get('A2').blocks[i]![metric]) - 1);
        }
      }
      const confidence = pairedConfidence(ratios, p.bootstrap.replicates, p.bootstrap.rngSeed);
      metrics[metric] = { ...confidence, pairedSeedRoundRatios: ratios, blockOverheads: descriptive(blocks), baselineAANoise: descriptive(aa) };
      passed &&= confidence.passesOnePercent;
    }
    result[family] = metrics;
  }
  return { passed, families: result, threshold: p.gate.maxOverhead, definition: 'upper two-sided95%CI<=1% for CPU AND wall in EACH family; no exclusions' };
}
async function selftest(p: Protocol, apis: { A: Graph; B: Graph }) {
  const checks: string[] = [];
  assert.deepEqual(cpuList('6-31'), Array.from({ length: 26 }, (_, i) => i + 6));
  assert.throws(() => cpuList('31-6')); assert.throws(() => cpuList('6x')); checks.push('affinity parser rejects malformed/range reversal');
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5); assert.equal(percentile([1, 2, 3, 4], 0.95), 3.8499999999999996); checks.push('p50/p95 linear interpolation');
  const ratios = (r: number): Ratio[] => SEEDS.flatMap(seed => [0, 1].map(round => ({ seed, round, logRatio: Math.log(r) })));
  assert.equal(pairedConfidence(ratios(1.005)).passesOnePercent, true);
  assert.equal(pairedConfidence(ratios(1.02)).passesOnePercent, false);
  assert.throws(() => pairedConfidence(ratios(1).slice(1))); checks.push('paired bootstrap known0.5%PASS/2%FAIL/missing seed rejected');
  const noisy = ratios(1); noisy[0]!.logRatio = Math.log(1.08); noisy[1]!.logRatio = Math.log(0.9259259259259259);
  assert.equal(pairedConfidence(noisy).passesOnePercent, false); checks.push('near-zero estimate with wideCI does not pass');
  assert.deepEqual(p.orders.map(order => order.filter(l => l.startsWith('A')).length), [2, 2]); checks.push('ABBA/BAAB includes every arm');
  const trace: string[] = [], fakeWorld = { tick: 0, structures: [] } as unknown as World;
  const fakeApi = { ...apis.A, world: { ...apis.A.world, stepWorld: () => { fakeWorld.tick++; trace.push('step'); return []; } },
    params: { ...apis.A.params, paramsOf: () => ({ persistencia: { cadaTicks: 1 } }) } } as unknown as Graph;
  const fakeArm = { api: fakeApi, world: fakeWorld, observer: { ingest: () => trace.push('ingest') },
    store: { save: () => { assert.equal(Date.now(), 1_000_000_000_000 + fakeWorld.tick); trace.push('save'); } },
    blocks: [], initialHealthy: new Set(), brokenSeen: new Set(), usesSeen: 0 } as unknown as Arm;
  const originalNow = Date.now;
  advance(fakeArm, 0, 2, ['A1', 'B1', 'B2', 'A2'], p);
  assert.deepEqual(trace, ['step', 'ingest', 'save', 'step', 'ingest', 'save']); assert.equal(Date.now, originalNow);
  checks.push('synthetic runner lifecycle step/ingest/save and host clock restored');
  const fixtures: unknown[] = [];
  for (const seed of SEEDS) for (const family of FAMILIES) {
    const a = fixture(apis.A, seed, family, p.params), b = fixture(apis.B, seed, family, p.params);
    apis.A.world.assertWorld(a); apis.B.world.assertWorld(b);
    const before = apis.B.digest(b); assert.equal(apis.A.digest(a), before);
    assert.ok(apis.B.factory); const observer = apis.B.factory(); observer.ingest(b); const exported = observer.exportRows();
    assert.equal(apis.B.digest(b), before, 'initial attach/export mutates world');
    assert.equal(exported.coverage.startTick, 0); assert.equal(exported.coverage.endTick, 0);
    if (family === 'material-stressed') {
      assert.equal(b.structures.filter(s => /^structure-[1-8]$/.test(s.id)).length, 8);
      assert.equal(b.retiredChunks.flatMap(c => c.structures ?? []).filter(s => /^structure-(?:9|1[0-6])$/.test(s.id)).length, 8);
      assert.equal(exported.structures.filter(s => /^structure-(?:9|1[0-6])$/.test(s.id)).length, 8);
    }
    fixtures.push({ seed, family, worldDigest: before, residents: b.structures.length,
      pendingDormant: b.retiredChunks.flatMap(c => c.structures ?? []).length, exportStructures: exported.structures.length });
    observer.discard(b);
  }
  checks.push('12 fixture pairs valid/equal; initial ingest sees dormant; attach/export preserve canonical world');
  return { status: 'PASS', checks, fixtures, fixturePairs: fixtures.length, stepWorldCalls: 0,
    limits: 'Only runner statistics and initial fixture topology; does not establish1200-step identity/event coverage/cost gate.' };
}
async function main(): Promise<void> {
  process.title = 'codex9gate'; setPriority(0, 19);
  const initialGuard = guard('initial'), protocolPath = option('--protocol') ?? DEFAULT_PROTOCOL;
  const p = loadProtocol(protocolPath), protocolSHA256 = sha(readFileSync(protocolPath));
  const base = option('--base') ?? join(LAB, 'datos-lab/codex9-main-source');
  const initialSources = sources(base, p), apis = { A: await graph(base, false), B: await graph(ROOT, true) };
  if (process.argv.includes('--selftest')) {
    const result = await selftest(p, apis), finalSources = sources(base, p);
    assert.deepEqual(finalSources, initialSources); assert.equal(sha(readFileSync(protocolPath)), protocolSHA256);
    const finalGuard = guard('final-selftest');
    console.log(JSON.stringify({ ...result, protocolPath, protocolSHA256, initialGuard, finalGuard, sources: initialSources }, null, 2)); return;
  }
  assert.ok(process.argv.includes('--run') && process.argv.includes('--authorized'), 'Use --selftest or --run --authorized AFTER parent barrier');
  const output = insideLab(option('--out') ?? ''); assert.ok(!existsSync(output), 'Refuse overwrite');
  mkdirSync(resolve(output, '..'), { recursive: true });
  const resources = [initialGuard], quartets: Quartet[] = [], warmup: Quartet[] = [];
  const report: Record<string, unknown> = { protocolPath, protocolSHA256, initialSources, startedAt: new Date().toISOString(),
    resources, quartets, warmup, status: 'NO CUMPLIDA', limitations: p.limitations };
  try {
    warmup.push(await quartet(apis, 16999, 'material-stressed', 0, p, resources, true));
    for (let round = 0; round < p.rounds; round++) for (let n = 0; n < SEEDS.length; n++) {
      const seed = SEEDS[(n + round) % SEEDS.length]!;
      for (const family of FAMILIES) {
        const q = await quartet(apis, seed, family, round, p, resources); quartets.push(q);
        const previous = quartets.filter(row => row.seed === seed && row.family === family);
        for (const row of previous) assert.deepEqual(row.arms[0]!.checkpoints, q.arms[0]!.checkpoints, 'Identity differs across repeated rounds');
        writeSync(2, JSON.stringify({ progress: quartets.length, total: 24, seed, family, round, identity: q.identical }) + '\n');
      }
    }
    const analysisStart = clock(); report.cost = analyze(quartets, p); report.analysisTime = difference(analysisStart);
    report.finalSources = sources(base, p); assert.deepEqual(report.finalSources, initialSources, 'Sources drifted during gate');
    assert.equal(sha(readFileSync(protocolPath)), protocolSHA256, 'Protocol drifted during gate');
    resources.push(guard('final'));
    report.identityPassed = quartets.every(q => q.identical); report.fixturePassed = quartets.every(q => q.fixturePassed);
    report.measuredWorlds = quartets.reduce((sum, q) => sum + q.arms.length, 0);
    report.measuredSteps = quartets.reduce((sum, q) => sum + q.arms.reduce((n, a) => n + a.blocks.reduce((b, block) => b + block.to - block.from, 0), 0), 0);
    assert.equal(report.measuredWorlds, 96); assert.equal(report.measuredSteps, 115200);
    report.status = (report.cost as { passed: boolean }).passed && report.identityPassed && report.fixturePassed ? 'CUMPLIDA' : 'NO CUMPLIDA';
  } catch (error) {
    report.failure = error instanceof Error ? error.message : String(error);
    report.failedQuartet = (error as { partial?: unknown })?.partial; process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  const encode = clock(), text = JSON.stringify(report, null, 2) + '\n', serialization = difference(encode);
  const io = clock(); writeFileSync(output, text, { flag: 'wx', mode: 0o600 });
  writeSync(1, JSON.stringify({ output, status: report.status, measuredWorlds: report.measuredWorlds, measuredSteps: report.measuredSteps }) + '\n');
  writeSync(2, JSON.stringify({ reportSerialization: serialization, reportFileAndStdout: difference(io), bytes: Buffer.byteLength(text), excludedAuditOverhead: true }) + '\n');
  if (report.status !== 'CUMPLIDA') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
