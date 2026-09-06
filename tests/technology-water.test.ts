import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { decodeSnapshot, encodeSnapshot } from '../src/server/snapshot.js';
import { assertWorld, cloneWorld, createWorld, migrateWorld, stepWorld, type World } from '../src/world/index.js';
import { assertTechnology, projectTechnology, researchTechnology, settleTechnologyEstate, technologyWorkCost, transferTechnologyItem, useTool,
  type TechnologyProgram } from '../src/world/technology.js';
import { assertWaterExecution, carriedTechnologyMass, containedWaterQuanta, drinkContainedWater, fillContainedWater,
  maintainContainedWater, payContainedWaterCarry, WATER_WORK_ENERGY } from '../src/world/technology-water.js';
import { containerAffordance, WATER_QUANTA_PER_UNIT } from '../src/world/material-affordances.js';
import { captureTechnologyCheckpoint } from '../src/world/technology-checkpoint.js';

const hollow: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 2000 }],
  steps: [{ op: 'form', intensity: 4, shape: 'hollow' }, { op: 'compress', intensity: 2 }] };
function nextTick(world: World) {
  world.tick++;
  for (const person of world.people) person.demography.age = world.tick - person.bornAt;
}
function paid(world: World, program: TechnologyProgram, parents: string[] = []) {
  const actor = world.people[2]!;
  actor.technology.project = { kind: 'research', program, parents, recipeId: null, progress: 0,
    requiredWork: technologyWorkCost(program), energyPaid: 0, startedAt: world.tick };
  const before = world.technology.ledger.work;
  let success = false;
  for (let n = 0; actor.technology.project && n < 250; n++) { nextTick(world); success = researchTechnology(world, actor); }
  assert.equal(success, true); assert.equal(actor.technology.project, null);
  assert.equal(world.technology.ledger.work - before, technologyWorkCost(program));
  return actor.technology.items.at(-1)!;
}
function fixture(program = hollow) {
  const world = createWorld(51926), actor = world.people[2]!;
  world.reproductionEnabled = false;
  for (const person of world.people) {
    person.action = 'rest'; person.decisionAt = 1_000_000; person.target = { x: person.x, y: person.y };
    person.hunger = person.thirst = 0.1; person.energy = 1; person.fatigue = 0;
  }
  actor.materials = { wood: 12, stone: 8 };
  const tile = world.tiles.find(t => t.x === actor.x && t.y === actor.y)!;
  tile.drinkingWater = 0.8;
  const item = paid(world, program);
  assertWorld(world);
  return { world, actor, item, tile };
}
function fill(lab: ReturnType<typeof fixture>, ticks = 1) {
  let filled = 0;
  for (let n = 0; n < ticks; n++) { nextTick(lab.world); filled += fillContainedWater(lab.world, lab.actor, lab.item.id); }
  assert.ok(filled > 0); return filled;
}
function balanced(world: World) {
  const w = world.technology.water!;
  assert.equal(w.filled, world.people.reduce((n, p) => n + containedWaterQuanta(p), 0) + w.consumed + w.environmentalLoss);
  for (const receipt of world.technology.history) assertWaterExecution(receipt);
  assertTechnology(world);
}

test('paid hollow properties fill from finite local water, retain fractional source stock and only actual drinking relieves thirst', () => {
  const lab = fixture(), { world, actor, item, tile } = lab;
  const recipeBefore = structuredClone(world.technology.recipes[0]), dry = structuredClone(item.composition), thirst = actor.thirst;
  tile.drinkingWater = 0.005013;
  const energy = actor.energy, carried = carriedTechnologyMass(actor);
  assert.equal(fill(lab), 250);
  assert.equal(tile.drinkingWater, 0.005013 - 250 / WATER_QUANTA_PER_UNIT);
  assert.equal(item.contents!.water, 250); assert.deepEqual(item.composition, dry);
  assert.equal(actor.thirst, thirst); assert.equal(carriedTechnologyMass(actor) - carried, 250);
  assert.equal(actor.energy, energy - WATER_WORK_ENERGY);
  assert.equal(fillContainedWater(world, actor, item.id), 0, 'same tick has no second work allocation');
  assert.equal(drinkContainedWater(world, actor), 0, 'filling and drinking cannot each spend the same tick');
  assert.deepEqual(world.technology.recipes[0], recipeBefore, 'filling is not observed utility');
  nextTick(world);
  assert.equal(drinkContainedWater(world, actor), 250);
  assert.equal(actor.thirst, thirst - 250 / WATER_QUANTA_PER_UNIT * 3);
  assert.equal(item.contents!.water, 0); assert.equal(item.contents!.leakRemainder, 0);
  assert.equal(world.technology.water!.consumed, 250);
  assert.equal(world.technology.recipes[0]!.uses, 1);
  assert.equal(world.technology.recipes[0]!.utility, thirst - actor.thirst);
  nextTick(world); assert.equal(drinkContainedWater(world, actor), 0);
  balanced(world); assertWorld(world);
});

test('absence of containment, water, local ownership, effort or carrying room cannot create liquid or hydration', () => {
  const control = fixture({ inputs: hollow.inputs, steps: [{ op: 'form', intensity: 4, shape: 'rod' }] });
  assert.equal(containerAffordance(control.item).capacityQuanta, 0);
  const before = structuredClone(control.world);
  assert.equal(fillContainedWater(control.world, control.actor, control.item.id), 0); assert.deepEqual(control.world, before);
  const lab = fixture();
  lab.tile.drinkingWater = 0; assert.equal(fillContainedWater(lab.world, lab.actor, lab.item.id), 0);
  lab.tile.drinkingWater = 0.8;
  assert.equal(fillContainedWater(lab.world, lab.world.people[3]!, lab.item.id), 0);
  lab.actor.energy = 0; assert.equal(fillContainedWater(lab.world, lab.actor, lab.item.id), 0);
  lab.actor.energy = 1; lab.world.technology.budgets.maxItems = 1;
  assert.equal(fillContainedWater(lab.world, lab.actor, lab.item.id), 0, 'raw matter also occupies carry capacity');
  assert.equal(drinkContainedWater(lab.world, lab.actor), 0); balanced(lab.world);
});

test('chemical water in a paid composite is not drinkable contents and migration does not turn it into hydration', () => {
  const lab = fixture({ inputs: [{ source: 'raw', material: 'stone', mass: 1000 }, { source: 'raw', material: 'water', mass: 100 }],
    steps: [{ op: 'combine', intensity: 1 }, { op: 'form', intensity: 4, shape: 'hollow' }] });
  assert.ok(lab.item.composition.water > 0); assert.equal(lab.item.contents, undefined);
  const thirst = lab.actor.thirst;
  assert.equal(drinkContainedWater(lab.world, lab.actor), 0); assert.equal(lab.actor.thirst, thirst);
  const legacy = cloneWorld(lab.world); legacy.version = 5; delete legacy.technology.water;
  delete legacy.technology.checkpoint!.water;
  const original = structuredClone(legacy), migrated = migrateWorld(legacy);
  assert.equal(migrated.version, 6); assert.deepEqual(legacy, original);
  assert.equal(migrated.people[2]!.technology.items[0]!.contents, undefined);
  assert.deepEqual(migrated.technology.recipes, original.technology.recipes);
  assert.deepEqual(migrated.technology.history, original.technology.history);
  assert.equal(migrated.technology.water!.filled, 0); assertWorld(migrated);
});

test('porous contents leak during rest and repeated filling cannot erase elapsed leakage', () => {
  const lab = fixture(); fill(lab, 8);
  const held = lab.item.contents!.water, lost = lab.world.technology.water!.environmentalLoss;
  for (let n = 0; n < 100; n++) stepWorld(lab.world);
  assert.equal(lab.actor.action, 'rest'); assert.ok(lab.item.contents!.water < held);
  assert.equal(held - lab.item.contents!.water, lab.world.technology.water!.environmentalLoss - lost);
  assert.equal(lab.world.technology.water!.consumed, 0); balanced(lab.world);
  const beforeRefill = lab.world.technology.water!.environmentalLoss;
  fill(lab, 120);
  assert.ok(lab.world.technology.water!.environmentalLoss > beforeRefill);
  const sameTick = structuredClone(lab.item.contents); maintainContainedWater(lab.world, lab.actor);
  assert.deepEqual(lab.item.contents, sameTick, 'no second leak in one tick'); balanced(lab.world);
});

test('payload charges movement and an exhausted carrier cannot move it for free', () => {
  const lab = fixture(); fill(lab, 4);
  const held = containedWaterQuanta(lab.actor), energy = lab.actor.energy, fatigue = lab.actor.fatigue;
  assert.equal(payContainedWaterCarry(lab.world, lab.actor), true);
  assert.equal(lab.actor.energy, energy - held / 1000 * 0.0008);
  assert.equal(lab.actor.fatigue, fatigue + held / 1000 * 0.0007);
  assert.equal(payContainedWaterCarry(lab.world, lab.actor), false);
  nextTick(lab.world); lab.actor.energy = 0;
  const before = structuredClone(lab.world);
  assert.equal(payContainedWaterCarry(lab.world, lab.actor), false); assert.deepEqual(lab.world, before);
  balanced(lab.world);
});

test('wear and breakage spill every excess quantum while keeping dry matter in residue', () => {
  const lab = fixture(); fill(lab, 40);
  const held = containedWaterQuanta(lab.actor), dry = lab.item.mass, lost = lab.world.technology.water!.environmentalLoss;
  nextTick(lab.world);
  const receipt = useTool(lab.world, lab.actor, 'storage', 100)!;
  assert.ok(receipt.wear > 0 && receipt.wear < dry);
  assert.ok(lab.item.contents!.water <= containerAffordance(lab.item).capacityQuanta);
  assert.ok(lab.world.technology.water!.environmentalLoss > lost);
  assert.equal(held, containedWaterQuanta(lab.actor) + lab.world.technology.water!.environmentalLoss - lost);
  nextTick(lab.world); useTool(lab.world, lab.actor, 'storage', 100_000);
  assert.equal(lab.actor.technology.items.length, 0); assert.equal(containedWaterQuanta(lab.actor), 0);
  assert.equal(lab.world.technology.water!.environmentalLoss - lost, held); balanced(lab.world);
});

test('partial reuse of a filled substrate empties it once and never clones contents into a descendant', () => {
  const lab = fixture(); fill(lab, 4);
  const held = containedWaterQuanta(lab.actor), dry = lab.item.mass, loss = lab.world.technology.water!.environmentalLoss;
  const child = paid(lab.world, { inputs: [{ source: 'product', recipeId: lab.item.recipeId!, mass: 500 }], steps: [{ op: 'cool', intensity: 1 }] }, [lab.item.recipeId!]);
  assert.equal(lab.item.mass, dry - 500); assert.equal(lab.item.contents!.water, 0);
  assert.equal(child.contents, undefined);
  assert.equal(lab.world.technology.water!.environmentalLoss - loss, held);
  assert.equal(lab.world.technology.history.at(-1)!.water!.lost, held); balanced(lab.world);
});

test('filled objects retain identity and liquid through transfers and inheritance without granting instructions', () => {
  const lab = fixture(); fill(lab, 4);
  const receiver = lab.world.people[3]!; receiver.x = lab.actor.x; receiver.y = lab.actor.y;
  const held = structuredClone(lab.item.contents);
  assert.equal(transferTechnologyItem(lab.world, lab.actor, receiver, lab.item.id), true);
  assert.equal(receiver.technology.items[0], lab.item); assert.deepEqual(lab.item.contents, held);
  assert.deepEqual(receiver.technology.knownRecipes, []);
  assert.equal(lab.world.technology.history.at(-2)!.water!.sent, held!.water);
  assert.equal(lab.world.technology.history.at(-1)!.water!.received, held!.water);
  const estate = settleTechnologyEstate(lab.world, receiver, [lab.actor]);
  assert.equal(estate.transfers.length, 1); assert.equal(lab.actor.technology.items[0], lab.item);
  assert.deepEqual(lab.item.contents, held); balanced(lab.world);
  const beforeLoss = lab.world.technology.water!.environmentalLoss;
  settleTechnologyEstate(lab.world, lab.actor);
  assert.equal(lab.world.technology.water!.environmentalLoss - beforeLoss, held!.water);
  assert.equal(containedWaterQuanta(lab.actor), 0); balanced(lab.world);
});

test('automatic inventory recycling exports fill separately and does not convert it to recyclable chemical water', () => {
  const lab = fixture(); lab.actor.materials = { wood: 0, stone: 3 }; fill(lab, 4);
  lab.world.technology.budgets.maxItems = 1;
  const held = containedWaterQuanta(lab.actor), dryWater = lab.actor.technology.residue.water;
  paid(lab.world, { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }], steps: [{ op: 'form', intensity: 4, shape: 'edge' }] });
  assert.equal(lab.actor.technology.items.length, 1); assert.notEqual(lab.actor.technology.items[0]!.id, lab.item.id);
  const recycled = [...lab.world.technology.history].reverse().find(e => e.kind === 'recycle')!;
  assert.equal(recycled.water!.lost, held); assert.equal(lab.actor.technology.residue.water, dryWater);
  balanced(lab.world);
});

test('real drink action consumes local carried stock and checkpoint copies its contents without aliasing', () => {
  const lab = fixture(); fill(lab, 4);
  lab.tile.drinkingWater = 0;
  lab.actor.action = 'drink'; lab.actor.thirst = 0.7;
  const before = lab.world.technology.water!.consumed;
  stepWorld(lab.world);
  assert.ok(lab.world.technology.water!.consumed > before); assert.ok(lab.actor.thirst < 0.7);
  assert.ok(lab.world.totals.waterConsumed > 0);
  const checkpoint = captureTechnologyCheckpoint(lab.world.technology, lab.world.people, lab.world.tick, 'migration');
  const copied = checkpoint.inventories.find(i => i.actorId === lab.actor.id)!.items[0]!.contents!;
  assert.deepEqual(copied, lab.item.contents); copied.water = 0; assert.ok(lab.item.contents!.water > 0);
  balanced(lab.world); assertWorld(lab.world);
});

test('V5 cannot hide liquid state, V6 requires its ledger, and receipts reject forged physics or policy versions', () => {
  const lab = fixture(); fill(lab);
  const bad = cloneWorld(lab.world); bad.version = 5;
  assert.throws(() => migrateWorld(bad));
  delete bad.technology.water; assert.throws(() => migrateWorld(bad));
  const missing = cloneWorld(lab.world); delete missing.technology.water; assert.throws(() => migrateWorld(missing));
  const receipt = structuredClone(lab.world.technology.history.at(-1)!);
  const zeroEnergy = structuredClone(receipt); zeroEnergy.energy = Number.MIN_VALUE; assert.throws(() => assertWaterExecution(zeroEnergy));
  const wrongPolicy = structuredClone(receipt); Object.assign(wrongPolicy.water!, { policyVersion: 2 }); assert.throws(() => assertWaterExecution(wrongPolicy));
  const tooFast = structuredClone(receipt); tooFast.water!.filled = 50_000; tooFast.water!.closing[0]!.quanta = 50_000;
  tooFast.water!.source = { x: lab.actor.x, y: lab.actor.y, opening: 1, closing: 0 };
  assert.throws(() => assertWaterExecution(tooFast));
  const wrongBalance = structuredClone(receipt); wrongBalance.water!.closing[0]!.quanta++;
  assert.throws(() => assertWaterExecution(wrongBalance));
});

test('a filled catalyst pays real wear inside a later paid process and keeps its liquid out of the new output', () => {
  const lab = fixture(); fill(lab, 40);
  const opening = containedWaterQuanta(lab.actor), mass = lab.item.mass, loss = lab.world.technology.water!.environmentalLoss;
  const output = paid(lab.world, { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }],
    steps: [{ op: 'form', intensity: 4, shape: 'edge' }, { op: 'cool', intensity: 1, requiredCatalyst: 'storage' }] });
  const parent = lab.world.technology.history.at(-1)!;
  assert.equal(parent.catalysts.length, 1); assert.equal(parent.catalysts[0]!.itemId, lab.item.id);
  assert.ok(lab.item.mass < mass); assert.equal(output.contents, undefined);
  assert.equal(opening, containedWaterQuanta(lab.actor) + lab.world.technology.water!.environmentalLoss - loss);
  assert.ok(lab.world.technology.water!.environmentalLoss > loss);
  balanced(lab.world);
});

test('inheritance reserves payload capacity for actual residue and accounts for any unclaimed matter', () => {
  const lab = fixture();
  // The real manufacturing loss supplies residue; choose a receiver close enough
  // to capacity that only part fits after the existing vessel and its fill arrive.
  lab.actor.materials = { wood: 0, stone: 0 }; fill(lab);
  lab.world.technology.budgets.maxItems = 1;
  const receiver = lab.world.people[3]!; receiver.x = lab.actor.x; receiver.y = lab.actor.y;
  const capacity = 16_000, payload = lab.item.mass + lab.item.contents!.water;
  receiver.materials = { wood: 12, stone: (capacity - 12_000 - payload - 1) / 1000 };
  const residue = { ...lab.actor.technology.residue }, lostBefore = { ...lab.world.technology.ledger.estateLoss };
  assert.ok(residue.stone > 1);
  settleTechnologyEstate(lab.world, lab.actor, [receiver]);
  assert.ok(carriedTechnologyMass(receiver) <= capacity);
  assert.equal(receiver.technology.residue.stone, 1);
  assert.equal(lab.world.technology.ledger.estateLoss.stone - lostBefore.stone, residue.stone - 1);
  assert.equal(receiver.technology.items[0], lab.item); balanced(lab.world);
});

test('erasing a spill or transfer liquid envelope cannot hide an observed change after the checkpoint', () => {
  for (const kind of ['spill', 'transfer'] as const) {
    const lab = fixture(); fill(lab);
    if (kind === 'spill') useTool(lab.world, lab.actor, 'storage', 100_000);
    else {
      const other = lab.world.people[3]!; other.x = lab.actor.x; other.y = lab.actor.y;
      assert.equal(transferTechnologyItem(lab.world, lab.actor, other, lab.item.id), true);
    }
    balanced(lab.world);
    delete lab.world.technology.history.at(-1)!.water;
    assert.throws(() => assertTechnology(lab.world), /contained water/);
  }
});

test('contents, fractional leakage and hydration receipts survive SQL rollback, exact retry and read-only reopening', () => {
  const lab = fixture(), dir = mkdtempSync(join(tmpdir(), 'atlas-water-store-')), path = join(dir, 'world.sqlite');
  let store = new Store(path);
  try {
    store.save(lab.world); const baseline = store.load()!.world;
    fill(lab, 4); nextTick(lab.world); drinkContainedWater(lab.world, lab.actor);
    assert.ok(lab.item.contents!.leakRemainder > 0);
    const pending = structuredClone(lab.world.technology.journal!.pending), live = structuredClone(lab.world);
    store.db.exec("CREATE TRIGGER stop_water BEFORE INSERT ON snapshots BEGIN SELECT RAISE(ABORT, 'water rollback'); END");
    assert.throws(() => store.save(lab.world), /water rollback/);
    assert.deepEqual(lab.world, live); assert.deepEqual(lab.world.technology.journal!.pending, pending);
    assert.deepEqual(store.load()!.world, baseline);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM technology_executions WHERE serial>?").get(baseline.technology.executionCounter)!.n, 0);
    store.db.exec('DROP TRIGGER stop_water'); store.save(lab.world);
    const expected = structuredClone(lab.world);
    const execution = store.technologyArchive.getExecution(pending.at(-1)!.id, expected.tick)!;
    assert.equal(execution.water!.action, 'drink'); assert.equal(execution.water!.consumed, 250);
    store.close(); store = new Store(path, { readOnly: true });
    const restored = store.load()!.world; assert.deepEqual(restored, expected);
    const a = cloneWorld(restored), b = cloneWorld(expected);
    for (let n = 0; n < 40; n++) { stepWorld(a); stepWorld(b); }
    assert.deepEqual(a, b, 'restart preserves the exact fractional leak sequence');
    balanced(restored); assertWorld(restored);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('checksum-consistent removal of a committed spill from snapshot and archive fails closed', () => {
  const lab = fixture(), store = new Store(':memory:');
  try {
    store.save(lab.world); fill(lab); nextTick(lab.world); useTool(lab.world, lab.actor, 'storage', 100_000); store.save(lab.world);
    const row = store.db.prepare('SELECT body FROM snapshots WHERE slot=0').get() as { body: string };
    const altered = decodeSnapshot(row.body) as World, event = altered.technology.history.at(-1)!;
    assert.ok(event.water!.lost > 0); delete event.water;
    const digest = (body: string) => createHash('sha256').update(body).digest('hex');
    const body = encodeSnapshot(altered), receipt = JSON.stringify(event);
    store.db.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=0').run(body, digest(body));
    store.db.prepare('UPDATE technology_executions SET body=?,digest=? WHERE id=?').run(receipt, digest(receipt), event.id);
    assert.throws(() => store.load(), /contained water/);
  } finally { store.close(); }
});

test('the projection supplies authoritative liquid capacity and amount separately from structural mass', () => {
  const lab = fixture(), initial = projectTechnology(lab.world).items[0]!;
  assert.equal(initial.water!.quanta, 0); assert.equal(initial.water!.quantaPerUnit, 50_000);
  assert.equal(initial.water!.capacityQuanta, containerAffordance(lab.item).capacityQuanta);
  fill(lab); const before = structuredClone(lab.world), projected = projectTechnology(lab.world).items[0]!;
  assert.equal(projected.mass, lab.item.mass); assert.equal(projected.water!.quanta, lab.item.contents!.water);
  assert.equal(projected.water!.leakageNumerator, containerAffordance(lab.item).leakageNumerator);
  projected.water!.quanta = 0; assert.deepEqual(lab.world, before);
  const legacy = fixture(); delete legacy.world.technology.water; delete legacy.world.technology.checkpoint!.water;
  assert.equal(projectTechnology(legacy.world).items[0]!.water, undefined, 'old projection omits the datum instead of asserting empty');
});

test('retiming real receipts cannot allocate two handling actions to the same actor in one tick', () => {
  for (const second of ['fill', 'drink'] as const) {
    const lab = fixture(); fill(lab); nextTick(lab.world);
    if (second === 'fill') fillContainedWater(lab.world, lab.actor, lab.item.id);
    else drinkContainedWater(lab.world, lab.actor);
    balanced(lab.world);
    const events = lab.world.technology.history.filter(e => e.water?.action === 'fill' || e.water?.action === 'drink');
    events[0]!.tick = events[1]!.tick;
    assert.throws(() => assertTechnology(lab.world), /contained water/);
  }
});

test('paired whole-object transfers cannot rename the contained liquid into a different vessel', () => {
  const lab = fixture(), spare = paid(lab.world, hollow), receiver = lab.world.people[3]!;
  receiver.x = lab.actor.x; receiver.y = lab.actor.y;
  assert.equal(transferTechnologyItem(lab.world, lab.actor, receiver, spare.id), true);
  fill(lab);
  assert.equal(transferTechnologyItem(lab.world, lab.actor, receiver, lab.item.id), true); balanced(lab.world);
  const received = lab.world.technology.history.at(-1)!;
  received.water!.closing[0]!.itemId = spare.id;
  spare.contents = lab.item.contents; delete lab.item.contents;
  assert.throws(() => assertTechnology(lab.world), /contained water/);
});

test('a dry gift cannot act as an uncharged pour between two vessels that stay with its sender', () => {
  const lab = fixture(), spare = paid(lab.world, hollow), gift = paid(lab.world, hollow), receiver = lab.world.people[3]!;
  receiver.x = lab.actor.x; receiver.y = lab.actor.y;
  fill(lab); assert.equal(transferTechnologyItem(lab.world, lab.actor, receiver, gift.id), true); balanced(lab.world);
  const sent = lab.world.technology.history.at(-2)!;
  assert.equal(sent.water!.sent, 0); assert.equal(sent.water!.received, 0);
  sent.water!.closing[0]!.itemId = spare.id; spare.contents = lab.item.contents; delete lab.item.contents;
  assert.throws(() => assertTechnology(lab.world), /contained water/);
});

test('a statistics overflow cannot consume water or hydrate the actor without its receipt', () => {
  const lab = fixture(); fill(lab); nextTick(lab.world); maintainContainedWater(lab.world, lab.actor);
  lab.world.technology.recipes[0]!.uses = Number.MAX_SAFE_INTEGER;
  const before = structuredClone(lab.world);
  assert.throws(() => drinkContainedWater(lab.world, lab.actor), /statistics|integer|overflow/);
  assert.deepEqual(lab.world, before);
});
