import test from 'node:test';
import assert from 'node:assert/strict';
import type { BlueprintView, StructureComponent } from '../src/shared/life.js';
import type { ChronicleEvent } from '../src/shared/types.js';
import { createWorld, stepWorld, tileAt, type World } from '../src/world/index.js';
import { blueprintAffordances, blueprintCost, blueprintSignature, BROKEN_CONDITION, completeConstruction, constructionCost,
  defaultBlueprint, facilityRestQuality, foodAvailable, invent, inventionCandidates, inventionOpportunity, MAX_BLUEPRINTS,
  paretoCandidates, recordFacilityRest, repair, repairOpportunity, RESEARCH_COOLDOWN, stepStructures, takeFood, validBlueprint } from '../src/world/inventions.js';

function emitFor(world: World) {
  return (event: Omit<ChronicleEvent, 'id' | 'tick'>): ChronicleEvent => {
    const result = { ...event, id: `test-event-${++world.eventCounter}`, tick: world.tick }; world.events.push(result); return result;
  };
}
function scene(seed = 51926) {
  const world = createWorld(seed), person = world.people[2]!;
  world.people = [person]; world.places = []; world.structures = []; world.blueprints = [defaultBlueprint()];
  world.blueprintCounter = 0; world.structureCounter = 0; world.tick = 600;
  world.inventionDynamics = { attempts: 0, accepted: 0, repairs: 0, waterCollected: 0, foodStored: 0, foodTaken: 0 };
  for (const tile of world.tiles) { tile.terrain = 'meadow'; tile.food = 0.25; tile.moisture = 0.5; tile.drinkingWater = 0.4; tile.wood = 0; tile.stone = 0; tile.biome = 'grassland'; }
  person.x = 36; person.y = 12; person.target = { x: 36, y: 12 }; person.energy = 1; person.hunger = 0.1; person.thirst = 0.1; person.fatigue = 0.1;
  person.materials = { wood: 12, stone: 8 }; person.inventory = 0; person.skills = { build: 0.3 }; person.activity = { build: 2 };
  person.work = 0; person.blueprintId = null; person.lastInvention = undefined;
  return { world, person, emit: emitFor(world), tile: tileAt(world, person)! };
}
function recipe(world: World, components: StructureComponent[]): BlueprintView {
  const blueprint = { ...defaultBlueprint(), id: `blueprint-${++world.blueprintCounter}`, components, cost: blueprintCost(components),
    generation: 1, parents: ['blueprint-base'], inventorId: 'example-craftsperson', tick: world.tick };
  world.blueprints.push(blueprint); return blueprint;
}
function building(components: StructureComponent[]) {
  const state = scene(), { world, person, tile, emit } = state;
  const blueprint = recipe(world, components); person.blueprintId = blueprint.id; person.work = blueprint.cost.work;
  const structure = completeConstruction(world, person, tile, emit)!; assert.ok(structure);
  return { ...state, blueprint, structure };
}
const close = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 1e-10, message ?? `${actual} != ${expected}`);

test('typed multiset grammar and cost determine capacities; names and order do not', () => {
  const base = defaultBlueprint(); assert.deepEqual(base.cost, { wood: 6, stone: 3, work: 90 });
  assert.ok(validBlueprint(base.components));
  for (const invalid of [[], ['frame'], ['roof', 'cistern'], ['frame', 'roof', 'garden'], ['frame', 'roof', 'roof'],
    ['frame', 'roof', 'hearth', 'hearth'], ['frame', 'roof', 'cistern', 'cistern'], ['frame', 'roof', 'magic'], null]) assert.equal(validBlueprint(invalid), false);
  const a: StructureComponent[] = ['frame', 'roof', 'granary'], b: StructureComponent[] = ['frame', 'roof', 'granary', 'granary'];
  assert.ok(validBlueprint(b)); assert.equal(blueprintAffordances(b).foodCapacity, blueprintAffordances(a).foodCapacity * 2);
  assert.deepEqual(blueprintAffordances([...b].reverse()), blueprintAffordances(b));
  assert.equal(blueprintSignature([...b].reverse()), blueprintSignature(b));
  assert.ok(blueprintCost(b).wood > blueprintCost(a).wood); assert.ok(blueprintCost(b).work > blueprintCost(a).work);
});

test('construction charges the selected genotype exactly once, with no initial water or food', () => {
  const { world, person, tile, emit } = scene();
  const blueprint = recipe(world, ['frame', 'roof', 'cistern', 'garden']); person.blueprintId = blueprint.id;
  const cost = constructionCost(world, person); assert.deepEqual(cost, { wood: 10, stone: 7, work: 160 });
  person.work = cost.work - 1; assert.equal(completeConstruction(world, person, tile, emit), null); assert.deepEqual(person.materials, { wood: 12, stone: 8 });
  person.work++; const structure = completeConstruction(world, person, tile, emit)!;
  assert.ok(structure); assert.deepEqual(person.materials, { wood: 2, stone: 1 }); assert.equal(person.work, 0);
  assert.equal(structure.water + structure.food, 0); assert.equal(structure.blueprintId, blueprint.id); assert.deepEqual(structure.components, blueprint.components);
  assert.equal(completeConstruction(world, person, tile, emit), null); assert.equal(world.settlementCount, 1);
  assert.equal(world.events.filter(e => e.kind === 'settlement').length, 1);
  assert.equal(blueprint.uses, 0); assert.equal(blueprint.usefulness, 0);
});

test('rain, cistern storage and public tap conserve water; clear weather never adds water', () => {
  const { world, structure, tile, emit } = building(['frame', 'roof', 'cistern']);
  tile.drinkingWater = 0; world.weather = 'rain';
  for (let n = 0; n < 200; n++) { world.tick += 10; stepStructures(world, emit); }
  close(structure.water + tile.drinkingWater, world.inventionDynamics.waterCollected);
  assert.ok(structure.water <= 0.6); assert.ok(tile.drinkingWater <= 0.08); assert.ok(structure.water > 0);
  const before = structure.water + tile.drinkingWater, collected = world.inventionDynamics.waterCollected;
  world.weather = 'clear';
  for (let n = 0; n < 50; n++) { world.tick += 10; tile.drinkingWater -= Math.min(tile.drinkingWater, 0.001); stepStructures(world, emit); }
  close(structure.water + tile.drinkingWater, before - 0.05); assert.equal(world.inventionDynamics.waterCollected, collected);
  assert.ok(world.blueprints.find(b => b.id === structure.blueprintId)!.usefulness > 0);
});

test('gardens debit cistern water into neighboring moisture without instant food or vegetation', () => {
  const { world, structure, tile, emit } = building(['frame', 'roof', 'cistern', 'garden']);
  structure.water = 0.3; tile.drinkingWater = 0.08; world.weather = 'clear';
  const neighbors = [[0, -1], [-1, 0], [1, 0], [0, 1]].map(([dx, dy]) => tileAt(world, { x: tile.x + dx!, y: tile.y + dy! })!);
  for (const neighbor of neighbors) neighbor.moisture = 0.2;
  const food = neighbors.map(t => t.food), vegetation = neighbors.map(t => t.vegetation), before = structure.water + neighbors.reduce((sum, t) => sum + t.moisture, 0);
  world.tick += 10; stepStructures(world, emit);
  close(structure.water + neighbors.reduce((sum, t) => sum + t.moisture, 0), before);
  assert.ok(neighbors.every(t => t.moisture > 0.2)); assert.deepEqual(neighbors.map(t => t.food), food); assert.deepEqual(neighbors.map(t => t.vegetation), vegetation);
  structure.water = 0; const dry = neighbors.map(t => t.moisture); world.tick += 10; stepStructures(world, emit); assert.deepEqual(neighbors.map(t => t.moisture), dry);
});

test('granaries only store carried surplus and withdrawals have a sole matching debit', () => {
  const { world, person, structure, emit } = building(['frame', 'roof', 'granary']);
  person.inventory = 0.24; const before = person.inventory + structure.food;
  for (let n = 0; n < 10; n++) { world.tick += 10; stepStructures(world, emit); }
  close(person.inventory + structure.food, before); close(world.inventionDynamics.foodStored, structure.food);
  assert.ok(structure.food > 0); close(foodAvailable(world, person), structure.food);
  const stock = structure.food, withdrawn = takeFood(world, person, 0.05); person.inventory += withdrawn;
  close(structure.food, stock - withdrawn); close(person.inventory + structure.food, before); close(world.inventionDynamics.foodTaken, withdrawn);
  assert.equal(takeFood(world, { x: person.x + 10, y: person.y }, 1), 0); assert.equal(takeFood(world, person, Number.NaN), 0);
  person.inventory = 0; const unchanged = structure.food; world.tick += 10; stepStructures(world, emit); assert.equal(structure.food, unchanged);
});

test('broken structures cease all functions, then repairs spend actual wood and work', () => {
  const { world, person, structure, tile, emit } = building(['frame', 'roof', 'cistern', 'granary']);
  structure.condition = BROKEN_CONDITION; structure.water = 0.2; structure.food = 0.2; tile.drinkingWater = 0;
  world.weather = 'rain'; person.inventory = 0.2; const stocks = [structure.water, structure.food, person.inventory];
  world.tick += 10; stepStructures(world, emit); assert.deepEqual([structure.water, structure.food, person.inventory], stocks);
  assert.equal(tile.drinkingWater, 0); assert.equal(foodAvailable(world, person), 0); assert.equal(takeFood(world, person, 1), 0); assert.equal(facilityRestQuality(world, person), 0.2);
  person.materials.wood = 2; person.work = 29; assert.equal(repairOpportunity(world, person), structure); assert.equal(repair(world, person, structure, emit), false);
  person.work = 30; const condition = structure.condition; assert.equal(repair(world, person, structure, emit), true);
  assert.equal(person.materials.wood, 1); assert.equal(person.work, 0); close(structure.condition, condition + 0.4); assert.equal(world.inventionDynamics.repairs, 1);
  assert.equal(repair(world, person, structure, emit), false);
  world.tick += 10; stepStructures(world, emit); assert.ok(tile.drinkingWater > 0); assert.ok(foodAvailable(world, person) > 0);
});

test('hearth benefit requires cold weather, an occupant and combustible material', () => {
  const { world, person, structure, emit } = building(['frame', 'roof', 'hearth']);
  world.weather = 'rain'; person.materials.wood = 1;
  const fueled = facilityRestQuality(world, person); recordFacilityRest(world, person); close(person.materials.wood, 0.9995);
  person.materials.wood = 0; assert.ok(facilityRestQuality(world, person) < fueled); recordFacilityRest(world, person); assert.equal(person.materials.wood, 0);
  person.materials.wood = 1; person.x += 3; world.tick += 10; stepStructures(world, emit); recordFacilityRest(world, person); assert.equal(person.materials.wood, 1);
  person.x = structure.x; world.weather = 'clear'; world.tick = 800; recordFacilityRest(world, person); assert.equal(person.materials.wood, 1);
});

test('Pareto removes dominated options while preserving actual function/cost tradeoffs', () => {
  const components: StructureComponent[] = ['frame', 'roof', 'cistern'];
  const options = [
    { components, parents: ['blueprint-base'], value: 0.8, efficiency: 0.4, novelty: 0.2 },
    { components, parents: ['blueprint-base'], value: 0.5, efficiency: 0.3, novelty: 0.1 },
    { components, parents: ['blueprint-base'], value: 0.6, efficiency: 0.8, novelty: 0.2 },
  ];
  assert.deepEqual(paretoCandidates(options), [options[0], options[2]]);
});

test('research is deterministic, novel by genotype, pays once and never advances weather RNG', () => {
  const a = scene(), b = scene();
  for (const state of [a, b]) { state.person.work = 60; state.world.weather = 'rain'; for (const tile of state.world.tiles) tile.drinkingWater = 0; }
  const rng = a.world.rng, genes = structuredClone(a.person.genome);
  assert.deepEqual(inventionCandidates(a.world, a.person), inventionCandidates(b.world, b.person));
  assert.ok(invent(a.world, a.person, a.emit)); assert.ok(invent(b.world, b.person, b.emit));
  assert.deepEqual(a.world.blueprints, b.world.blueprints); assert.equal(a.world.rng, rng); assert.deepEqual(a.person.genome, genes);
  assert.equal(a.person.materials.wood, 11); assert.equal(a.person.work, 0); assert.equal(a.world.inventionDynamics.attempts, 1); assert.equal(a.world.inventionDynamics.accepted, 1);
  const blueprint = a.world.blueprints.at(-1)!; assert.ok(validBlueprint(blueprint.components)); assert.equal(blueprint.inventorId, a.person.id);
  assert.equal(blueprint.generation, 1); assert.deepEqual(blueprint.parents, ['blueprint-base']); assert.equal(blueprint.usefulness, 0); assert.equal(blueprint.uses, 0);
  a.person.work = 60; assert.equal(invent(a.world, a.person, a.emit), false); assert.equal(a.person.materials.wood, 11);
});

test('changing only local deficits causes water, food and rest designs to diverge', () => {
  const results: StructureComponent[][] = [];
  for (const kind of ['water', 'food', 'rest']) {
    const { world, person, emit } = scene(); world.weather = 'rain'; person.work = 60;
    world.structures.push({ id: 'known-roof', x: person.x + 1, y: person.y, blueprintId: 'blueprint-base', name: 'Techo conocido',
      components: ['frame', 'roof'], condition: 1, water: 0, food: 0, uses: 0, builtAt: 0, builderId: null });
    tileAt(world, world.structures[0]!)!.terrain = 'shelter';
    for (const tile of world.tiles) { tile.food = kind === 'food' ? 0 : 0.5; tile.drinkingWater = kind === 'water' ? 0 : 0.4; tile.moisture = kind === 'water' ? 0.1 : 0.5; }
    person.thirst = kind === 'water' ? 0.6 : 0.1; person.hunger = kind === 'food' ? 0.6 : 0.1; person.fatigue = kind === 'rest' ? 0.6 : 0.1;
    person.inventory = kind === 'food' ? 0.24 : 0;
    assert.ok(invent(world, person, emit), kind); results.push(world.blueprints.at(-1)!.components);
  }
  assert.ok(results[0]!.includes('cistern')); assert.ok(results[1]!.includes('granary'));
  assert.ok(results[2]!.includes('hearth') || results[2]!.filter(c => c === 'roof').length > 1);
  assert.equal(new Set(results.map(blueprintSignature)).size, 3);
});

test('inaccessible cultural recipes are not parents; contact enables recombination without changing human genes', () => {
  const { world, person, emit } = scene(), parent = recipe(world, ['frame', 'roof', 'cistern']), other = recipe(world, ['frame', 'roof', 'granary']);
  const before = structuredClone(person.genome);
  assert.ok(inventionCandidates(world, person).every(c => !c.parents.includes(parent.id)));
  world.structures.push({ id: 'observed', x: person.x, y: person.y, blueprintId: parent.id, name: parent.name, components: parent.components,
    condition: 1, water: 0.2, food: 0, uses: 3, builtAt: 0, builderId: 'other' }); tileAt(world, person)!.terrain = 'shelter';
  world.structures.push({ ...world.structures[0]!, id: 'second-example', x: person.x + 1, blueprintId: other.id, components: other.components, water: 0 });
  tileAt(world, world.structures[1]!)!.terrain = 'shelter';
  let inherited = false, crossed = false;
  for (let n = 0; n < 30; n++) { world.tick++; const candidates = inventionCandidates(world, person); inherited ||= candidates.some(c => c.parents.includes(parent.id)); crossed ||= candidates.some(c => c.parents.length === 2); }
  assert.ok(inherited); assert.ok(crossed); assert.deepEqual(person.genome, before);
  world.weather = 'rain'; for (const tile of world.tiles) tile.drinkingWater = 0; world.tick = 660; stepStructures(world, emit);
  assert.equal(person.blueprintId, parent.id); assert.deepEqual(person.genome, before);
});

test('unsuccessful paid research preserves the registry; absent resources and expertise prevent attempts', () => {
  const { world, person, emit } = scene();
  // Exhaust every valid budget-bounded genotype, without relying on a particular random proposal.
  for (let frame = 1; frame <= 2; frame++) for (let roof = 1; roof <= 2; roof++) for (let cistern = 0; cistern <= 2; cistern++)
    for (let granary = 0; granary <= 2; granary++) for (let garden = 0; garden <= 2; garden++) for (let hearth = 0; hearth <= 1; hearth++) {
      const components: StructureComponent[] = [...Array<StructureComponent>(frame).fill('frame'), ...Array<StructureComponent>(roof).fill('roof'),
        ...Array<StructureComponent>(cistern).fill('cistern'), ...Array<StructureComponent>(granary).fill('granary'), ...Array<StructureComponent>(garden).fill('garden'), ...Array<StructureComponent>(hearth).fill('hearth')];
      if (validBlueprint(components) && !world.blueprints.some(b => blueprintSignature(b.components) === blueprintSignature(components))) recipe(world, components);
    }
  const registry = structuredClone(world.blueprints); assert.ok(registry.length <= MAX_BLUEPRINTS);
  person.work = 60; assert.equal(invent(world, person, emit), false); assert.equal(person.materials.wood, 11); assert.equal(person.work, 0);
  assert.equal(world.inventionDynamics.attempts, 1); assert.equal(world.inventionDynamics.accepted, 0); assert.deepEqual(world.blueprints, registry);
  assert.equal(world.events.filter(e => e.kind === 'invention').length, 0); assert.match(person.reason, /no produjo/);
  world.tick += RESEARCH_COOLDOWN; person.materials.wood = 0; person.work = 60; assert.equal(inventionOpportunity(world, person), undefined);
  assert.equal(invent(world, person, emit), false); assert.equal(world.inventionDynamics.attempts, 1);
  person.materials.wood = 1; person.skills = {}; person.activity = {}; assert.equal(invent(world, person, emit), false); assert.equal(world.inventionDynamics.attempts, 1);
});

test('engine can choose paid research autonomously from practiced skill and a local deficit', () => {
  const { world, person } = scene();
  world.weather = 'rain'; person.skills = { build: 0.6 }; person.activity = { gather: 8 }; person.curiosity = 0.9; person.traits.industriousness = 0.1;
  person.command = null; person.controlMode = 'auto'; person.decisionAt = 0; person.closeness = 0; person.generosity = 0; person.socialLoad = 0;
  for (const tile of world.tiles) { tile.drinkingWater = 0; tile.food = 0.4; }
  assert.ok(inventionOpportunity(world, person));
  for (let n = 0; n < 100 && world.inventionDynamics.attempts === 0; n++) stepWorld(world);
  assert.ok(world.inventionDynamics.attempts >= 1); assert.ok(world.inventionDynamics.accepted >= 1);
  assert.equal(person.command, null); assert.equal(person.controlMode, 'auto');
});
