import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.js';
import { assertWorld, cloneWorld, createWorld, migrateWorld, projectWorld, stepWorld, type World } from '../src/world/index.js';
import { assertTechnology, researchTechnology, settleTechnologyEstate, technologyWorkCost, transferTechnologyItem, useTool,
  type TechnologyProgram } from '../src/world/technology.js';
import { containedWaterQuanta, WATER_PREPARATION_MAX_TICKS } from '../src/world/technology-water.js';
import { WATER_QUANTA_PER_UNIT } from '../src/world/material-affordances.js';
import { bindWorldContext } from '../src/world/spatial.js';
import { generateChunk } from '../src/world/terrain.js';

/** Controlled laboratory: the experiment is selected, but all substrate and work
 * are paid. Subsequent choices use stepWorld with no gestures. The separate
 * natural-seed observation never uses this setup. */
function laboratory(shape: 'hollow' | 'rod' = 'hollow', source = 0.8) {
  const world = createWorld(51926), actor = world.people[2]!;
  world.reproductionEnabled = false; world.cooperationEnabled = false;
  for (const person of world.people) {
    person.action = 'rest'; person.decisionAt = 1_000_000; person.target = { x: person.x, y: person.y };
    person.energy = 1; person.fatigue = 0; person.hunger = person.thirst = 0.1;
  }
  actor.materials = { wood: 0, stone: 2 };
  const program: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 2000 }],
    steps: [{ op: 'form', intensity: 4, shape }, { op: 'compress', intensity: 2 }] };
  actor.technology.project = { kind: 'research', program, parents: [], recipeId: null, progress: 0,
    requiredWork: technologyWorkCost(program), energyPaid: 0, startedAt: world.tick };
  let success = false;
  while (actor.technology.project) {
    world.tick++; for (const person of world.people) person.demography.age = world.tick - person.bornAt;
    success = researchTechnology(world, actor);
  }
  assert.equal(success, true); assert.equal(actor.materials.stone, 0);
  world.noveltyEnabled = false; // Keep this physical lab focused on the existing object.
  for (const tile of world.tiles) tile.drinkingWater = 0;
  for (const structure of world.structures) structure.water = 0;
  const tile = world.tiles.find(tile => tile.x === actor.x && tile.y === actor.y)!;
  tile.drinkingWater = source; tile.wood = tile.stone = 0;
  actor.thirst = 0.5; actor.decisionAt = world.tick;
  assertWorld(world);
  return { world, actor, item: actor.technology.items[0]!, tile };
}
function until(world: World, predicate: () => boolean, max = 120) {
  for (let n = 0; n < max && !predicate(); n++) stepWorld(world);
  assert.ok(predicate(), `condition not reached within ${max} autonomous ticks`);
}
function preparation(lab: ReturnType<typeof laboratory>) {
  until(lab.world, () => !!lab.actor.technology.waterPreparation);
  return { ...lab.actor.technology.waterPreparation! };
}
function finish(lab: ReturnType<typeof laboratory>) {
  const plan = preparation(lab);
  until(lab.world, () => !lab.actor.technology.waterPreparation, WATER_PREPARATION_MAX_TICKS + 1);
  assert.ok(containedWaterQuanta(lab.actor) > 0);
  return plan;
}

test('autonomous local preparation has a fixed finite goal, leaves the source loaded and later hydrates away from it', () => {
  const lab = laboratory(), plan = preparation(lab), work = lab.world.technology.water!.work;
  assert.equal(lab.actor.command, null); assert.equal(lab.actor.action, 'drink');
  assert.match(lab.actor.reason, /reserva/);
  while (lab.actor.technology.waterPreparation) {
    assert.equal(lab.actor.technology.waterPreparation.targetQuanta, plan.targetQuanta);
    stepWorld(lab.world);
    const view = projectWorld(lab.world).people.find(person => person.id === lab.actor.id)!;
    if (lab.actor.technology.waterPreparation) { assert.equal(view.working, true); assert.ok(view.workProgress! > 0 && view.workProgress! < 1); }
  }
  assert.ok(containedWaterQuanta(lab.actor) <= plan.targetQuanta);
  assert.ok(lab.world.technology.water!.work > work);
  assert.equal(lab.world.technology.recipes[0]!.utility, 0, 'preparation has not earned hydration utility');
  until(lab.world, () => Math.hypot(lab.actor.x - lab.tile.x, lab.actor.y - lab.tile.y) > 0.5, 120);
  assert.ok(containedWaterQuanta(lab.actor) > 0, 'the departure retains a usable reserve');
  const consumed = lab.world.technology.water!.consumed;
  until(lab.world, () => lab.world.technology.water!.consumed > consumed, 1200);
  assert.ok(Math.hypot(lab.actor.x - lab.tile.x, lab.actor.y - lab.tile.y) > 0.5);
  assert.ok(lab.world.technology.recipes[0]!.utility > 0);
  assert.equal(lab.actor.command, null); assert.equal(lab.actor.controlMode, 'auto'); assertWorld(lab.world);
});

test('no containment or no local source gives no preparation, fill or stored-water utility', () => {
  for (const [shape, source] of [['rod', 0.8], ['hollow', 0]] as const) {
    const lab = laboratory(shape, source);
    if (source === 0) bindWorldContext(lab.world, { loadChunk: key => {
      // Environmental ablation includes newly explored terrain: discovery must
      // not silently introduce a fresh source into the no-water control.
      const [cx, cy] = key.split(',').map(Number);
      const chunk = generateChunk(lab.world.seed, cx!, cy!);
      for (const tile of chunk.tiles) tile.drinkingWater = 0;
      return chunk;
    } });
    for (let tick = 0; tick < 120; tick++) stepWorld(lab.world);
    assert.equal(lab.actor.technology.waterPreparation, undefined);
    assert.equal(lab.world.technology.water!.filled, 0); assert.equal(lab.world.technology.water!.consumed, 0);
    assert.equal(lab.world.technology.water!.work, 0); assert.equal(lab.world.technology.recipes[0]!.utility, 0);
    assertWorld(lab.world);
  }
});

test('food and bodily exhaustion interrupt preparation without charging a second flow', () => {
  for (const need of ['hunger', 'fatigue', 'energy'] as const) {
    const lab = laboratory(); preparation(lab); stepWorld(lab.world);
    lab.actor[need] = need === 'energy' ? 0.01 : 0.95;
    const before = { filled: lab.world.technology.water!.filled, work: lab.world.technology.water!.work };
    stepWorld(lab.world);
    assert.equal(lab.actor.technology.waterPreparation, undefined);
    assert.equal(lab.world.technology.water!.filled, before.filled); assert.equal(lab.world.technology.water!.work, before.work);
    assert.notEqual(lab.actor.action, 'drink'); assertWorld(lab.world);
  }
});

test('direct water is consumed before portable reserves and the vessel receives no equivalent-source credit', () => {
  const lab = laboratory(); finish(lab);
  lab.actor.thirst = 0.7; lab.actor.decisionAt = lab.world.tick;
  const utility = lab.world.technology.recipes[0]!.utility, consumed = lab.world.technology.water!.consumed;
  stepWorld(lab.world);
  assert.equal(lab.actor.action, 'drink'); assert.ok(lab.actor.thirst < 0.7);
  assert.equal(lab.world.technology.water!.consumed, consumed); assert.equal(lab.world.technology.recipes[0]!.utility, utility);
  assert.ok(containedWaterQuanta(lab.actor) > 0); assertWorld(lab.world);
});

test('one direct water quantum reduces the real portable deficit without merging the two liquid balances', () => {
  const lab = laboratory(); finish(lab);
  // A controlled one-quantum source; the only intervention is its finite stock.
  lab.tile.drinkingWater = 1 / WATER_QUANTA_PER_UNIT;
  lab.actor.thirst = 0.7; lab.actor.decisionAt = lab.world.tick;
  const consumed = lab.world.technology.water!.consumed, utility = lab.world.technology.recipes[0]!.utility;
  stepWorld(lab.world);
  const delta = lab.world.technology.water!.consumed - consumed;
  assert.equal(delta, 250); assert.equal(lab.tile.drinkingWater, 0);
  assert.ok(Math.abs(lab.world.technology.recipes[0]!.utility - utility - delta / WATER_QUANTA_PER_UNIT * 3) < 1e-12);
  const ledger = lab.world.technology.water!;
  assert.equal(ledger.filled, lab.world.people.reduce((n, actor) => n + containedWaterQuanta(actor), 0) + ledger.consumed + ledger.environmentalLoss);
  assertWorld(lab.world);
});

test('restart in a preparation phase retains its original target and never reserves source water or work in advance', () => {
  const lab = laboratory(), store = new Store(':memory:');
  try {
    const plan = preparation(lab); stepWorld(lab.world); store.save(lab.world);
    const restored = store.load()!.world, actor = restored.people.find(p => p.id === lab.actor.id)!;
    assert.deepEqual(actor.technology.waterPreparation, plan); assert.deepEqual(restored, lab.world);
    const uninterrupted = cloneWorld(lab.world);
    for (let n = 0; n < WATER_PREPARATION_MAX_TICKS; n++) { stepWorld(restored); stepWorld(uninterrupted); }
    assert.deepEqual(restored, uninterrupted); assert.equal(actor.technology.waterPreparation, undefined);
    assertWorld(restored);
  } finally { store.close(); }
});

test('losing the source cancels the remaining plan without inventing or reserving its missing water', () => {
  const lab = laboratory(); preparation(lab); stepWorld(lab.world);
  const before = { ...lab.world.technology.water! }, held = containedWaterQuanta(lab.actor);
  lab.tile.drinkingWater = 0;
  stepWorld(lab.world);
  assert.equal(lab.actor.technology.waterPreparation, undefined);
  assert.equal(lab.world.technology.water!.filled, before.filled);
  assert.equal(lab.world.technology.water!.work, before.work);
  assert.ok(containedWaterQuanta(lab.actor) <= held); assertWorld(lab.world);
});

test('persisted preparation rejects remote, impossible and future targets and cannot hide in a V5 snapshot', () => {
  const lab = laboratory(); preparation(lab);
  for (const change of [
    (world: World) => { world.people[2]!.technology.waterPreparation!.sourceX++; },
    (world: World) => { world.people[2]!.technology.waterPreparation!.targetQuanta = 1_000_000; },
    (world: World) => { world.people[2]!.technology.waterPreparation!.startedAt++; },
    (world: World) => { world.version = 5; delete world.technology.water; },
  ]) {
    const bad = cloneWorld(lab.world); change(bad);
    assert.throws(() => migrateWorld(bad));
  }
  assertWorld(lab.world);
});

test('commands, transfers, support transformation and death cancel the actor-owned preparation', () => {
  for (const event of ['command', 'transfer', 'wear', 'transform', 'death'] as const) {
    const lab = laboratory(); preparation(lab); stepWorld(lab.world);
    const filled = lab.world.technology.water!.filled, work = lab.world.technology.water!.work;
    if (event === 'command') stepWorld(lab.world, [{ id: 'interrupt-water-plan', kind: 'command', agentId: lab.actor.id, order: 'rest', x: lab.actor.x, y: lab.actor.y }]);
    else if (event === 'transfer') {
      const other = lab.world.people[3]!; other.x = lab.actor.x; other.y = lab.actor.y; lab.world.cooperationEnabled = true;
      assert.equal(transferTechnologyItem(lab.world, lab.actor, other, lab.item.id), true);
      assert.equal(other.technology.waterPreparation, undefined);
    } else if (event === 'wear') useTool(lab.world, lab.actor, 'storage');
    else if (event === 'transform') {
      const program: TechnologyProgram = { inputs: [{ source: 'product', recipeId: lab.item.recipeId!, mass: 500 }], steps: [{ op: 'cool', intensity: 1 }] };
      lab.actor.technology.project = { kind: 'research', program, parents: [lab.item.recipeId!], recipeId: null,
        progress: 0, requiredWork: technologyWorkCost(program), energyPaid: 0, startedAt: lab.world.tick };
      while (lab.actor.technology.project) {
        lab.world.tick++; for (const person of lab.world.people) person.demography.age = lab.world.tick - person.bornAt;
        researchTechnology(lab.world, lab.actor);
      }
      assert.ok(lab.item.mass < 2000); assert.equal(lab.item.contents!.water, 0);
    }
    else settleTechnologyEstate(lab.world, lab.actor);
    assert.equal(lab.actor.technology.waterPreparation, undefined);
    assert.equal(lab.world.technology.water!.filled, filled); assert.equal(lab.world.technology.water!.work, work);
    assertTechnology(lab.world);
  }
});
