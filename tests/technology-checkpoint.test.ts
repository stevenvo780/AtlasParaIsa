import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/server/store.js';
import { decodeSnapshot, encodeSnapshot } from '../src/server/snapshot.js';
import { assertWorld, cloneWorld, createWorld, migrateWorld, projectWorld, stepWorld, type World } from '../src/world/index.js';
import { captureTechnologyCheckpoint, advanceTechnologyCheckpoint, assertTechnologyCheckpoint } from '../src/world/technology-checkpoint.js';
import { analyzeTechnologyOrganization } from '../src/world/technology-organization.js';
import { defaultTechnologyState, initialTechnologyKnowledge, researchTechnology, technologyWorkCost, useTool,
  recordTechnologyBenefit, transferTechnologyItem, type TechnologyActor, type TechnologyHost, type TechnologyProgram } from '../src/world/technology.js';

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
  actor.technology.project = { kind: 'research', program, parents, recipeId: null, progress: 0,
    requiredWork: technologyWorkCost(program), energyPaid: 0, startedAt: host.tick };
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
  person.technology.project = { kind: 'research', program: edge, parents: [], recipeId: null, progress: 0,
    requiredWork: technologyWorkCost(edge), energyPaid: 0, startedAt: world.tick };
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
  const raw = store.db.prepare('SELECT body FROM snapshots WHERE slot=0').get() as { body: string };
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
    value => { value.technology.checkpoint!.inventories = Array.from({ length: 33 }, (_, n) => ({ actorId: `actor-${n}`, items: [], residue: { wood: 0, stone: 0, water: 0 } })); },
  ];
  for (const mutation of mutations) { const changed = structuredClone(host); mutation(changed); assert.throws(() => assertTechnologyCheckpoint(changed.technology, changed.tick), /checkpoint/); }
  assertTechnologyCheckpoint(host.technology, host.tick);
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
  assert.deepEqual(decodeSnapshot(encodeSnapshot(draft)), { ...draft, retiredChunks: [], retiredLegacy: [] });
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
