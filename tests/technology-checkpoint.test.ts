import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/server/store.js';
import { decodeSnapshot, encodeSnapshot, takeSnapshotParams } from '../src/server/snapshot.js';
import { paramsOf } from '../src/world/params.js';
import { assertWorld, cloneWorld, createWorld, migrateWorld, projectWorld, stepWorld, POPULATION_HARD_LIMIT, type World } from '../src/world/index.js';
import { captureTechnologyCheckpoint, advanceTechnologyCheckpoint, assertTechnologyCheckpoint, technologyHistoryGap, type TechnologyStockActor } from '../src/world/technology-checkpoint.js';
import { analyzeTechnologyOrganization } from '../src/world/technology-organization.js';
import { defaultTechnologyState, initialTechnologyKnowledge, researchTechnology, useTool,
  recordTechnologyBenefit, transferTechnologyItem, type TechnologyActor, type TechnologyHost, type TechnologyProgram } from '../src/world/technology.js';
import type { MaterialBatch, TechnologyState } from '../src/shared/technology.js';
import { filaInstantanea } from './lib/store.js';
import { proyectoInvestigacion } from './lib/escenas.js';

const edge: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 4000 }],
  steps: [{ op: 'form', intensity: 4, shape: 'edge' }, { op: 'compress', intensity: 2 }] };
const binding: TechnologyProgram = { inputs: [{ source: 'raw', material: 'wood', mass: 1000 }],
  steps: [{ op: 'weave', intensity: 4 }, { op: 'form', intensity: 2, shape: 'sheet' }] };

function scene() {
  const actor = (id: string): TechnologyActor => ({ id, x: 0, y: 0, energy: 1, fatigue: 0, hunger: 0.1, thirst: 0.1,
    materials: { wood: 10, stone: 10 }, skills: {}, technology: initialTechnologyKnowledge() });
  const a = actor('a'), b = actor('b');
  const host: TechnologyHost = { seed: 23, tick: 0, people: [b, a], technology: defaultTechnologyState() };
  host.technology.checkpoint = captureTechnologyCheckpoint(host.technology, host.people, host.tick, 'initial');
  return { host, a, b };
}
function manufacture(host: TechnologyHost, actor: TechnologyActor, program = edge, parents: string[] = []) {
  actor.energy = 1; actor.fatigue = 0;
  actor.technology.project = proyectoInvestigacion(program, host.tick, parents);
  for (let n = 0; n < 100 && actor.technology.project; n++) { host.tick++; researchTechnology(host, actor); }
  assert.equal(actor.technology.project, null); assert.ok(actor.technology.items.length);
}
function anchor(host: TechnologyHost) {
  host.technology.checkpoint = captureTechnologyCheckpoint(host.technology, host.people, host.tick, 'migration');
}
function use(host: TechnologyHost, actor: TechnologyActor) {
  const receipt = useTool(host, actor, 'cutting', 0.01);
  assert.ok(receipt); recordTechnologyBenefit(host, actor, receipt, 0.01);
}
function report(host: TechnologyHost) { return analyzeTechnologyOrganization(host.technology, host.people, host.tick); }
function withoutCheckpoint<T extends TechnologyHost>(host: T): T {
  const copy = structuredClone(host); delete copy.technology.checkpoint; return copy;
}
function storeFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-checkpoint-')), path = join(directory, 'world.sqlite');
  const store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, directory, path };
}
function makeWorldTool(world: World) {
  const person = world.people[2]!;
  person.materials.stone = 8; person.energy = 1; person.fatigue = person.hunger = person.thirst = 0.1;
  person.command = { order: 'research', x: person.x, y: person.y }; person.controlMode = 'directed'; person.decisionAt = 0;
  person.technology.project = proyectoInvestigacion(edge, world.tick);
  for (let n = 0; n < 100 && !person.technology.items.length; n++) stepWorld(world);
  assert.ok(person.technology.items.length); assertWorld(world); return person;
}

test('world creation records all inventories at the initial boundary without granting retrospective flux', () => {
  const world = createWorld(51926), cp = world.technology.checkpoint!;
  assert.equal(cp.version, 1); assert.equal(cp.reason, 'initial'); assert.equal(cp.tick, 0); assert.equal(cp.executionCounter, 0);
  assert.equal(cp.inventories.length, world.people.length);
  assert.deepEqual(cp.inventories.map(item => item.actorId), world.people.map(person => person.id).sort());
  assert.ok(cp.inventories.every(inventory => !inventory.items.length && Object.values(inventory.residue).every(value => value === 0)));
  const atBoundary = report(world); assert.equal(atBoundary.window.complete, false);
  assert.ok(atBoundary.evidence.failures.includes('no-complete-epoch')); assert.equal(atBoundary.evidence.executed, 0);
  stepWorld(world); assert.equal(report(world).window.startTick, 1); assert.equal(report(world).window.complete, true);
});

test('quiet stocks survive a rolling buffer and a capture is deep, ordered, and physically exact', () => {
  const { host, a, b } = scene(); manufacture(host, a); manufacture(host, b); anchor(host);
  const checkpoint = structuredClone(host.technology.checkpoint!);
  assert.deepEqual(checkpoint.inventories.map(item => item.actorId), ['a', 'b']);
  host.technology.budgets.maxHistory = 2;
  host.tick++; use(host, b); host.tick++; use(host, b);
  assert.ok(host.technology.historyDropped > 0);
  const observed = report(host);
  assert.equal(observed.window.startTick, checkpoint.tick + 1); assert.equal(observed.window.complete, true);
  assert.equal(observed.evidence.balanced, true); assert.equal(observed.evidence.executed, 2);
  assert.deepEqual(host.technology.checkpoint, checkpoint, 'tool wear cannot mutate the stored opening');
  const resource = observed.resources.find(item => item.resourceId === `recipe:${a.technology.items[0]!.recipeId}`)!;
  assert.equal(resource.openingStock, checkpoint.inventories.reduce((n, inventory) => n + inventory.items[0]!.mass, 0));
  assert.equal(observed.autopoiesisEstablished, false); assert.deepEqual(observed.maintainedComponents, []);
});

test('silent quiet-actor mass, identity, composition, or residue edits remain unverified', () => {
  const base = scene(); manufacture(base.host, base.a); manufacture(base.host, base.b, binding); anchor(base.host); base.host.tick++;
  for (const mutation of ['mass', 'identity', 'composition', 'residue'] as const) {
    const host = structuredClone(base.host), a = host.people.find(actor => actor.id === 'a')!, item = a.technology.items[0]!;
    if (mutation === 'mass') { item.mass--; item.composition.stone--; a.technology.residue.stone++; }
    if (mutation === 'identity') item.id = `product-${++host.technology.itemCounter}`;
    if (mutation === 'composition') { item.composition.stone--; item.composition.wood++; }
    if (mutation === 'residue') a.technology.residue.stone++;
    const result = report(host);
    assert.equal(result.window.complete, false, mutation);
    assert.ok(result.evidence.failures.includes('unlogged-physical-stock-change:a'), mutation);
    assert.deepEqual(result.maintainedComponents, [], mutation);
  }
});

test('a first transaction must match the opening checkpoint rather than replace it', () => {
  const { host, a } = scene(); manufacture(host, a); anchor(host); host.tick++; use(host, a);
  const cpItem = host.technology.checkpoint!.inventories.find(item => item.actorId === a.id)!.items[0]!;
  cpItem.mass--; cpItem.composition.stone--;
  const result = report(host);
  assert.equal(result.window.complete, false); assert.ok(result.evidence.failures.includes('unlogged-stock-change:a'));
});

test('serial holes, absent transfer halves, and absent required catalyst children stay unknown after anchoring', () => {
  const serial = scene(); manufacture(serial.host, serial.a); anchor(serial.host); serial.host.tick++; use(serial.host, serial.a);
  serial.host.technology.history.at(-1)!.id = 'process-99';
  assert.ok(report(serial.host).evidence.failures.includes('execution-ledger-gap'));

  const transfer = scene(); manufacture(transfer.host, transfer.a); anchor(transfer.host); transfer.host.tick++;
  assert.equal(transferTechnologyItem(transfer.host, transfer.a, transfer.b, transfer.a.technology.items[0]!.id), true);
  transfer.host.technology.history.pop();
  const missingPair = report(transfer.host);
  assert.equal(missingPair.window.complete, false); assert.ok(missingPair.evidence.failures.some(value => value.startsWith('incomplete-transfer:')));

  const catalyst = scene(); manufacture(catalyst.host, catalyst.a, binding); anchor(catalyst.host);
  manufacture(catalyst.host, catalyst.a, { inputs: [{ source: 'raw', material: 'wood', mass: 1000 }, { source: 'raw', material: 'stone', mass: 1000 }],
    steps: [{ op: 'combine', intensity: 3, requiredCatalyst: 'binding' }] }, [catalyst.a.technology.items[0]!.recipeId!]);
  const child = catalyst.host.technology.history.at(-1)!.catalysts[0]!.executionId;
  catalyst.host.technology.history = catalyst.host.technology.history.filter(event => event.id !== child);
  const missingChild = report(catalyst.host);
  assert.equal(missingChild.window.complete, false); assert.ok(missingChild.evidence.failures.includes(`missing-nested-execution:${child}`));
});

test('more than 256 real receipts in one tick lose that interval and open only a future epoch', () => {
  const { host, a } = scene(); manufacture(host, a); anchor(host); host.tick++;
  for (let n = 0; n < 270; n++) use(host, a);
  assert.equal(host.technology.history.length, 256);
  const lost = report(host); assert.equal(lost.window.complete, false); assert.ok(lost.evidence.failures.includes('execution-ledger-gap'));
  const physical = withoutCheckpoint(host);
  advanceTechnologyCheckpoint(host.technology, host.people, host.tick);
  assert.deepEqual(withoutCheckpoint(host), physical, 'rotation cannot change physical trajectories or receipts');
  assert.equal(host.technology.checkpoint!.reason, 'history-gap');
  const boundary = report(host); assert.equal(boundary.window.complete, false); assert.equal(boundary.evidence.executed, 0);
  host.tick++; use(host, a);
  const resumed = report(host); assert.equal(resumed.window.complete, true); assert.equal(resumed.evidence.balanced, true);
  assert.equal(resumed.evidence.executed, 1); assert.deepEqual(resumed.maintainedComponents, []);
});

test('an actor birth or death starts a conservative epoch after the complete world tick', () => {
  const world = createWorld(51926); world.tick = 599;
  for (const person of world.people) {
    person.action = 'rest'; person.decisionAt = 10000; person.hunger = person.thirst = person.fatigue = 0.1; person.energy = 0.9;
    person.demography.age = world.tick - person.bornAt;
  }
  const a = world.people[2]!, b = world.people[3]!;
  for (const person of [a, b]) { person.x = 17; person.y = 13; person.target = { x: 17, y: 13 }; person.communityId = 'community-1'; person.inventory = 0.2; }
  a.bonds[b.id] = b.bonds[a.id] = 0.7; world.communityCounter = 1;
  world.communities = [{ id: 'community-1', name: 'Test', x: 17, y: 13, color: '#aabbcc', members: [a.id, b.id], culture: { ...a.culture }, formedAt: 599, cooperation: 0, disputes: 0 }];
  stepWorld(world); assert.equal(world.birthCounter, 1); assert.equal(world.technology.checkpoint!.reason, 'roster-change');
  assert.equal(world.technology.checkpoint!.tick, 600); assert.equal(world.technology.checkpoint!.inventories.length, 17);
  assert.equal(report(world).window.complete, false); assertWorld(world);
  const dying = world.people[4]!; dying.demography.health = 1e-10; dying.hunger = dying.thirst = 1; dying.energy = 0.1; dying.fatigue = 0.9;
  stepWorld(world); assert.equal(world.technology.checkpoint!.tick, 601);
  assert.ok(!world.technology.checkpoint!.inventories.some(inventory => inventory.actorId === dying.id));
  assert.equal(report(world).window.complete, false); assertWorld(world);
  stepWorld(world); assert.equal(report(world).window.complete, true); assert.equal(report(world).window.startTick, 602);
});

test('old V5 loads capture current physical stock without certifying or changing its past', t => {
  const { store } = storeFixture(t), world = createWorld(51926); makeWorldTool(world);
  delete world.technology.checkpoint; store.save(world); const before = structuredClone(world);
  const loaded = store.load()!.world, cp = loaded.technology.checkpoint!;
  assert.equal(cp.reason, 'migration'); assert.equal(cp.tick, world.tick); assert.equal(cp.executionCounter, world.technology.executionCounter);
  assert.deepEqual(withoutCheckpoint(loaded), before); assert.equal(world.technology.checkpoint, undefined);
  assert.equal(report(loaded).window.complete, false); assert.equal(report(loaded).evidence.executed, 0);
  const raw = filaInstantanea(store);
  assert.equal((decodeSnapshot(raw.body) as World).technology.checkpoint, undefined, 'read does not rewrite the source snapshot');
  store.save(loaded); const savedCheckpoint = structuredClone(cp); stepWorld(loaded); store.save(loaded);
  assert.deepEqual(store.load()!.world.technology.checkpoint, savedCheckpoint, 'reload must not reset an existing epoch');
  assert.deepEqual(migrateWorld(loaded), loaded);
});

test('checkpoint shape rejects forged mass, counters, duplicate identities, and oversized inventories', () => {
  const { host, a } = scene(); manufacture(host, a); anchor(host);
  const mutations: ((value: typeof host) => void)[] = [
    value => { value.technology.checkpoint!.version = 2 as 1; },
    value => { value.technology.checkpoint!.tick++; },
    value => { value.technology.checkpoint!.executionCounter++; },
    value => { value.technology.checkpoint!.reason = 'initial'; },
    value => { value.technology.checkpoint!.inventories[0]!.items[0]!.mass++; },
    value => { value.technology.checkpoint!.inventories[0]!.items[0]!.composition.wood = Number.NaN; },
    value => { value.technology.checkpoint!.inventories.push(structuredClone(value.technology.checkpoint!.inventories[0]!)); },
    value => { value.technology.checkpoint!.inventories[1]!.items.push(structuredClone(value.technology.checkpoint!.inventories[0]!.items[0]!)); },
    value => { value.technology.checkpoint!.inventories[0]!.items[0]!.recipeId = 'missing'; },
    // Ruling R17: el tope de inventarios ya no dice cuánta gente cabe; solo ataja un
    // snapshot corrupto. Se fuerza la longitud (array disperso) para no reservar un millón de objetos.
    value => { value.technology.checkpoint!.inventories.length = POPULATION_HARD_LIMIT + 1; },
  ];
  for (const mutation of mutations) { const changed = structuredClone(host); mutation(changed); assert.throws(() => assertTechnologyCheckpoint(changed.technology, changed.tick), /checkpoint/); }
  assertTechnologyCheckpoint(host.technology, host.tick);
});

test('ruling R17: 129 inventarios (antes rechazados por el tope de 128) son un checkpoint válido', () => {
  const { host, a } = scene(); manufacture(host, a); anchor(host);
  const changed = structuredClone(host);
  changed.technology.checkpoint!.inventories = Array.from({ length: 129 }, (_, n) => ({ actorId: `actor-${String(n).padStart(4, '0')}`, items: [], residue: { wood: 0, stone: 0, water: 0 } }));
  assertTechnologyCheckpoint(changed.technology, changed.tick);
});

test('a checkpoint cannot hide a retained receipt by moving its tick or serial boundary', () => {
  const { host, a } = scene(); manufacture(host, a); host.tick++; use(host, a); anchor(host); host.tick++; use(host, a);
  assertTechnologyCheckpoint(host.technology, host.tick);
  for (const alteration of ['earlier-tick', 'earlier-serial', 'later-serial'] as const) {
    const changed = structuredClone(host), checkpoint = changed.technology.checkpoint!;
    if (alteration === 'earlier-tick') checkpoint.tick--;
    if (alteration === 'earlier-serial') checkpoint.executionCounter--;
    if (alteration === 'later-serial') checkpoint.executionCounter++;
    assert.ok(checkpoint.executionCounter <= changed.technology.executionCounter, 'the forged counter remains within the global bound');
    assert.throws(() => assertTechnologyCheckpoint(changed.technology, changed.tick), /checkpoint/, alteration);
    const result = report(changed); assert.equal(result.window.complete, false, alteration);
    assert.ok(result.evidence.failures.includes('invalid-opening-checkpoint'), alteration);
    assert.deepEqual(result.maintainedComponents, [], alteration);
  }
});

test('SQLite rollback, snapshot roundtrip, reload, and previous recovery preserve the epoch boundary', t => {
  const { store, directory } = storeFixture(t), world = createWorld(51926); store.save(world);
  const committed = cloneWorld(world), draft = cloneWorld(world), dying = draft.people[2]!;
  dying.demography.health = 1e-10; dying.hunger = dying.thirst = 1; dying.energy = 0.1; dying.fatigue = 0.9;
  stepWorld(draft); assert.equal(draft.technology.checkpoint!.reason, 'roster-change');
  const decoded = decodeSnapshot(encodeSnapshot(draft));
  assert.deepEqual(takeSnapshotParams(decoded), paramsOf(draft), 'the codec preserves the complete declared parameter mode');
  assert.deepEqual(decoded, { ...draft, retiredChunks: [], retiredLegacy: [] });
  store.db.exec("CREATE TEMP TRIGGER reject_snapshot BEFORE INSERT ON snapshots BEGIN SELECT RAISE(ABORT, 'checkpoint rollback probe'); END");
  assert.throws(() => store.save(draft), /checkpoint rollback probe/);
  assert.deepEqual(store.load()!.world, committed); assert.deepEqual(world, committed);
  assert.equal(draft.retiredLegacy.length, 1); assert.equal(store.loadLegacy(dying.id), null);
  store.db.exec('DROP TRIGGER reject_snapshot'); store.save(draft);
  assert.deepEqual(store.load()!.world, draft); assert.ok(store.loadLegacy(dying.id));
  const path = join(directory, 'previous.sqlite'); store.previous(path); const previous = new Store(path);
  try { assert.deepEqual(previous.load()!.world.technology.checkpoint, committed.technology.checkpoint); assert.equal(previous.loadLegacy(dying.id), null); }
  finally { previous.close(); }
});

test('checkpoint metadata and repeated projections do not alter world trajectories or random state', () => {
  const anchored = createWorld(51926); makeWorldTool(anchored); const unanchored = cloneWorld(anchored);
  for (let n = 0; n < 120; n++) {
    delete unanchored.technology.checkpoint;
    stepWorld(anchored); stepWorld(unanchored);
    if (n % 30 === 0) {
      const before = cloneWorld(anchored); report(anchored); report(anchored); assert.deepEqual(anchored, before);
      assert.deepEqual(withoutCheckpoint(anchored), withoutCheckpoint(unanchored));
    }
  }
  assert.deepEqual(withoutCheckpoint(anchored), withoutCheckpoint(unanchored));
});

test('a new epoch invalidates a projection cached at the same tick and execution counter', () => {
  const world = createWorld(51926); stepWorld(world);
  assert.equal(projectWorld(world).organization!.window.complete, true);
  world.technology.checkpoint = captureTechnologyCheckpoint(world.technology, world.people, world.tick, 'migration');
  const view = projectWorld(world).organization!;
  assert.equal(view.window.complete, false); assert.ok(view.evidence.failures.includes('no-complete-epoch'));
});

// T143: el padrón deja de reconstruirse con un Set en cada tick. Oráculo = el `advanceTechnologyCheckpoint`
// de 5e0556f, literal; la captura, la aserción y `technologyHistoryGap` no cambiaron.
function legacyAdvance(state: TechnologyState, actors: readonly TechnologyStockActor[], tick: number): void {
  const checkpoint = state.checkpoint;
  if (checkpoint === undefined) { state.checkpoint = captureTechnologyCheckpoint(state, actors, tick, 'migration'); return; }
  const current = new Set(actors.map(actor => actor.id));
  const rosterChanged = current.size !== checkpoint.inventories.length || checkpoint.inventories.some(inventory => !current.has(inventory.actorId));
  if (rosterChanged || technologyHistoryGap(state)) {
    assertTechnologyCheckpoint(state, tick);
    state.checkpoint = captureTechnologyCheckpoint(state, actors, tick, rosterChanged ? 'roster-change' : 'history-gap');
  }
}
/** Avanza `oracle` con el oráculo y `state` con la función de hoy: mismos bytes, misma rotación, mismo error. */
function lockstep(state: TechnologyState, oracle: TechnologyState, actors: readonly TechnologyStockActor[], tick: number, label: string): boolean {
  const before = state.checkpoint, oracleBefore = oracle.checkpoint;
  let expected: unknown, got: unknown;
  try { legacyAdvance(oracle, actors, tick); } catch (error) { expected = error; }
  try { advanceTechnologyCheckpoint(state, actors, tick); } catch (error) { got = error; }
  assert.equal(String(got), String(expected), `${label}: error`);
  assert.equal(JSON.stringify(state.checkpoint), JSON.stringify(oracle.checkpoint), `${label}: bytes`);
  assert.equal(state.checkpoint !== before, oracle.checkpoint !== oracleBefore, `${label}: rotación`);
  return expected !== undefined;
}
function stockActor(id: string, items: MaterialBatch[] = []): TechnologyStockActor {
  return { id, technology: { items, residue: { wood: 0, stone: 0, water: 0 } } };
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test('T143: 2400 world steps with births, deaths and per-step clones keep the legacy checkpoint byte for byte', () => {
  let world = createWorld(51926), births = 0, deaths = 0, rosterChanges = 0, withItems = 0;
  for (let n = 1; n <= 2400; n++) {
    if (n % 200 === 0) {
      const dying = world.people.find(person => person.role === 'neighbor' && person.demography.deathCause === null)!;
      dying.demography.health = 1e-10; dying.hunger = dying.thirst = 1; dying.energy = 0.1; dying.fatigue = 0.9;
    }
    if (n % 300 === 0) world = cloneWorld(world); // el servidor clona el mundo en cada paso: ninguna identidad sobrevive
    const prev = world.technology.checkpoint, before = new Set(world.people.map(person => person.id));
    stepWorld(world);
    const after = new Set(world.people.map(person => person.id));
    births += [...after].filter(id => !before.has(id)).length; deaths += [...before].filter(id => !after.has(id)).length;
    const oracle: TechnologyState = { ...world.technology, checkpoint: prev };
    legacyAdvance(oracle, world.people, world.tick);
    assert.equal(JSON.stringify(world.technology.checkpoint), JSON.stringify(oracle.checkpoint), `tick ${world.tick}: bytes`);
    assert.equal(world.technology.checkpoint !== prev, oracle.checkpoint !== prev, `tick ${world.tick}: rotación`);
    if (world.technology.checkpoint !== prev && world.technology.checkpoint!.reason === 'roster-change') rosterChanges++;
    if (world.technology.checkpoint!.inventories.some(inventory => inventory.items.length)) withItems++;
  }
  assert.ok(births >= 1 && deaths >= 5, `nacimientos ${births}, muertes ${deaths}`);
  assert.ok(rosterChanges >= 6, `rotaciones por padrón ${rosterChanges}`); assert.ok(withItems > 0, 'las aperturas comparadas llevan objetos reales');
  assertWorld(world);
});

test('T143: a seeded fuzz of roster edits, clones, forgeries and gaps matches the legacy predicate on every tick', () => {
  const rnd = mulberry32(143), pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;
  let actors: TechnologyStockActor[] = ['a', 'b', 'c', 'd'].map(id => stockActor(id)), serial = 0, made = 0, throws = 0;
  const item = (): MaterialBatch => ({ id: `product-${++made}`, recipeId: null, mass: 3, composition: { wood: 1, stone: 2, water: 0 } }) as MaterialBatch;
  const state = defaultTechnologyState(); state.itemCounter = 1e6; // techo holgado: los objetos del fuzz se numeran después
  actors[1]!.technology.items.push(item(), item());
  state.checkpoint = captureTechnologyCheckpoint(state, actors, 0, 'initial');
  let oracle = structuredClone(state), current = structuredClone(state);
  const both = (edit: (value: TechnologyState) => void) => { edit(oracle); edit(current); };
  const seen = new Set<string>(), reasons = new Set<string>();
  for (let tick = 1; tick <= 2400; tick++) {
    const op = pick(['none', 'none', 'birth', 'death', 'replace', 'shuffle', 'rename', 'duplicate', 'clone', 'items', 'gap', 'reorder', 'forge', 'twin'] as const);
    seen.add(op);
    if (op === 'birth') actors.push(stockActor(`n-${++serial}`, rnd() < 0.5 ? [item()] : []));
    if (op === 'death' && actors.length > 1) { const victim = pick(actors); actors = actors.filter(actor => actor !== victim); }
    if (op === 'replace') actors[Math.floor(rnd() * actors.length)] = stockActor(`n-${++serial}`); // alta y baja en el mismo tick, en sitio
    if (op === 'shuffle') for (let n = actors.length - 1; n > 0; n--) { const k = Math.floor(rnd() * (n + 1)); [actors[n], actors[k]] = [actors[k]!, actors[n]!]; }
    if (op === 'rename') pick(actors).id = `n-${++serial}`; // el mismo objeto cambia de id
    if (op === 'duplicate') actors.push(stockActor(pick(actors).id));
    if (op === 'clone') { actors = structuredClone(actors); oracle = structuredClone(oracle); current = structuredClone(current); }
    if (op === 'items') pick(actors).technology.items.push(item());
    if (op === 'gap') both(value => { value.executionCounter++; value.historyDropped++; });
    if (op === 'reorder') both(value => value.checkpoint!.inventories.reverse()); // mismo padrón, otro orden: no rota
    if (op === 'forge') { const at = Math.floor(rnd() * oracle.checkpoint!.inventories.length), id = `forged-${tick}`; both(value => { value.checkpoint!.inventories[at]!.actorId = id; }); }
    if (op === 'twin') both(value => value.checkpoint!.inventories.push(structuredClone(value.checkpoint!.inventories[0]!)));
    const opening = current.checkpoint;
    if (lockstep(current, oracle, actors, tick, `tick ${tick} (${op})`)) {
      throws++; actors = actors.filter((actor, n) => actors.findIndex(other => other.id === actor.id) === n);
      both(value => { value.checkpoint = captureTechnologyCheckpoint(value, actors, tick, 'migration'); });
    } else if (current.checkpoint !== opening) reasons.add(current.checkpoint!.reason);
  }
  assert.equal(seen.size, 13); assert.deepEqual([...reasons].sort(), ['history-gap', 'roster-change']);
  assert.ok(throws > 0, 'el fuzz ejercita los errores de la aserción');
});

test('T143: interleaved worlds share the single-entry cache and still match the legacy predicate', () => {
  const rosters = [['a1', 'a2', 'a3'], ['b1', 'b2']].map(ids => ids.map(id => stockActor(id)));
  const states = rosters.map(actors => { const state = defaultTechnologyState(); state.checkpoint = captureTechnologyCheckpoint(state, actors, 0, 'initial'); return state; });
  const oracles = states.map(state => structuredClone(state));
  for (let tick = 1; tick <= 40; tick++) for (let w = 0; w < 2; w++) {
    if (tick % 7 === w) rosters[w]!.push(stockActor(`w${w}-${tick}`));
    lockstep(states[w]!, oracles[w]!, rosters[w]!, tick, `mundo ${w} tick ${tick}`);
  }
  assert.deepEqual(states.map(state => state.checkpoint!.inventories.length), [8, 8]);
});

test('T143: same-length turnover rotates, reordering does not, and the tick after a rotation keeps the opening', () => {
  const actors = ['a', 'b', 'c'].map(id => stockActor(id)), state = defaultTechnologyState();
  state.checkpoint = captureTechnologyCheckpoint(state, actors, 0, 'initial');
  const opening = state.checkpoint;
  actors.reverse(); advanceTechnologyCheckpoint(state, actors, 1);
  assert.equal(state.checkpoint, opening, 'reordering the same roster is not a roster change');
  actors[1] = stockActor('d'); advanceTechnologyCheckpoint(state, actors, 2);
  const rotated = state.checkpoint!;
  assert.notEqual(rotated, opening); assert.equal(rotated.reason, 'roster-change');
  assert.deepEqual(rotated.inventories.map(inventory => inventory.actorId), ['a', 'c', 'd']);
  advanceTechnologyCheckpoint(state, actors, 3); advanceTechnologyCheckpoint(state, structuredClone(actors), 4);
  assert.equal(state.checkpoint, rotated, 'a stable roster, cloned or not, keeps its opening');
  actors.push(stockActor('a')); advanceTechnologyCheckpoint(state, actors, 5); advanceTechnologyCheckpoint(state, actors, 6);
  assert.equal(state.checkpoint, rotated, 'as before, the roster is a set of ids: a repeated id changes nothing');
  // Mismo array, misma longitud, misma apertura: sólo el contenido delata el cambio. Por eso el padrón no
  // puede decidirse en O(1) con (estado, actores, tick): un atajo por identidad o longitud no rotaría aquí.
  actors[0]!.id = 'e'; advanceTechnologyCheckpoint(state, actors, 7);
  assert.notEqual(state.checkpoint, rotated, 'renaming an actor in place is a roster change');
  assert.equal(state.checkpoint!.reason, 'roster-change');
});
