import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorld, cloneWorld, createWorld, stepWorld, type World } from '../src/world/index.js';
import { researchTechnology, technologyWorkCost, type TechnologyProgram } from '../src/world/technology.js';
import { containedWaterQuanta, fillContainedWater } from '../src/world/technology-water.js';

const vessel: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 2000 }],
  steps: [{ op: 'form', intensity: 4, shape: 'hollow' }, { op: 'compress', intensity: 2 }] };

function nextTick(world: World): void {
  world.tick++;
  for (const person of world.people) person.demography.age = world.tick - person.bornAt;
}

/** The fixture pays for its vessel and withdraws its contents from a finite source.
 * After the matched clones are made, ordinary world steps own every action and debit. */
function preparedReserve() {
  const world = createWorld(51926), actor = world.people[2]!;
  world.reproductionEnabled = world.cooperationEnabled = false;
  for (const person of world.people) {
    person.action = 'rest'; person.decisionAt = 1_000_000; person.target = { x: person.x, y: person.y };
    person.hunger = person.thirst = 0.1; person.energy = 1; person.fatigue = 0;
  }
  actor.materials = { wood: 12, stone: 8 };
  actor.technology.project = { kind: 'research', program: vessel, parents: [], recipeId: null, progress: 0,
    requiredWork: technologyWorkCost(vessel), energyPaid: 0, startedAt: world.tick };
  let success = false;
  for (let n = 0; actor.technology.project && n < 250; n++) { nextTick(world); success = researchTechnology(world, actor); }
  assert.equal(success, true);
  const item = actor.technology.items.at(-1)!;
  const source = world.tiles.find(tile => tile.x === actor.x && tile.y === actor.y)!;
  source.drinkingWater = 0.8;
  for (let n = 0; n < 4; n++) { nextTick(world); assert.ok(fillContainedWater(world, actor, item.id) > 0); }
  for (const tile of world.tiles) tile.drinkingWater = 0;
  for (const structure of world.structures) structure.water = 0;
  world.weather = 'clear';
  Object.assign(actor, { hunger: 0.2, thirst: 0.95, energy: 0.8, fatigue: 0, decisionAt: 0 });
  assertWorld(world);
  return world;
}

for (const impairment of ['fatigue', 'energy'] as const) test(`${impairment} cannot trap a thirsty actor repeatedly attempting to drink an unusable carried reserve`, context => {
  const reference = preparedReserve(), exhausted = cloneWorld(reference);
  const ready = reference.people[2]!, tired = exhausted.people[2]!;
  if (impairment === 'fatigue') tired.fatigue = 1;
  else { tired.energy = 0.0001; tired.thirst = ready.thirst = 0.8; }
  const opening = containedWaterQuanta(tired), openingThirst = tired.thirst;
  const observations: { tick: number; action: string; energy: number; fatigue: number; thirst: number; consumed: number }[] = [];
  for (let n = 0; n < 30; n++) {
    stepWorld(reference); stepWorld(exhausted);
    observations.push({ tick: exhausted.tick, action: tired.action, energy: tired.energy, fatigue: tired.fatigue,
      thirst: tired.thirst, consumed: exhausted.technology.water!.consumed });
  }
  assert.ok(reference.technology.water!.consumed > 0, 'matched ready actor can physically drink its paid reserve');
  assert.ok(ready.thirst < openingThirst);
  const ledger = exhausted.technology.water!;
  assert.equal(opening, containedWaterQuanta(tired) + ledger.consumed + ledger.environmentalLoss,
    'water loss and drinking must close the balance, even when handling is blocked');
  context.diagnostic(JSON.stringify({ seed: 51926, ticks: 30, impairment, readyConsumed: reference.technology.water!.consumed,
    exhaustedConsumed: ledger.consumed, observations }));
  assert.ok(observations.some(sample => sample.action !== 'drink'), 'a failed handling prerequisite needs a paid recovery action');
  assert.ok(ledger.consumed > opening * 0.9, 'renewed exhaustion between doses must trigger recovery again, not another inert drink intention');
  assert.ok(tired.thirst < openingThirst);
});

test('ambient drinking remains possible at full fatigue and does not spend inaccessible contents', () => {
  const world = preparedReserve(), actor = world.people[2]!;
  actor.fatigue = 1;
  const source = world.tiles.find(tile => tile.x === actor.x && tile.y === actor.y)!;
  source.drinkingWater = 0.1;
  const openingThirst = actor.thirst, openingWater = source.drinkingWater;
  stepWorld(world);
  assert.equal(actor.action, 'drink');
  assert.ok(source.drinkingWater < openingWater);
  assert.ok(actor.thirst < openingThirst);
  assert.equal(world.technology.water!.consumed, 0, 'ambient drinking does not credit contained-water consumption');
});

test('rest that cannot recover handling capacity never creates energy or hydration', () => {
  const world = preparedReserve(), actor = world.people[2]!;
  actor.thirst = 1; actor.energy = 0; actor.fatigue = 1;
  for (let n = 0; n < 30; n++) stepWorld(world);
  assert.equal(actor.energy, 0);
  assert.equal(actor.thirst, 1);
  assert.equal(world.technology.water!.consumed, 0);
  assert.ok(containedWaterQuanta(actor) > 0, 'possessing water is insufficient without the effort required to drink it');
});
