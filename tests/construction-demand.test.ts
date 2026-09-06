import test from 'node:test';
import assert from 'node:assert/strict';
import type { BlueprintView, StructureComponent } from '../src/shared/life.js';
import type { ChronicleEvent } from '../src/shared/types.js';
import { createWorld, tileAt } from '../src/world/index.js';
import { blueprintCost, completeConstruction, constructionCost, constructionOpportunity, defaultBlueprint,
  facilityRestQuality, repair, repairOpportunity, takeWater } from '../src/world/inventions.js';

function scene() {
  const world = createWorld(51926), person = world.people[2]!;
  world.people = [person]; world.structures = []; world.places = []; world.blueprints = [defaultBlueprint()];
  world.blueprintCounter = 0; world.structureCounter = 0; world.tick = 600; world.weather = 'clear';
  for (const tile of world.tiles) {
    tile.terrain = 'meadow'; tile.biome = 'grassland'; tile.food = 0.25; tile.moisture = 0.5;
    tile.drinkingWater = 0.4; tile.vegetation = 0.85; tile.wood = 0; tile.stone = 0;
  }
  Object.assign(person, { x: 36, y: 12, target: { x: 36, y: 12 }, energy: 1, hunger: 0.1, thirst: 0.1,
    fatigue: 0.1, materials: { wood: 12, stone: 8 }, inventory: 0, blueprintId: null, work: 0 });
  person.traits.industriousness = 1;
  const emit = (event: Omit<ChronicleEvent, 'id' | 'tick'>): ChronicleEvent => ({ ...event, id: `test-${++world.eventCounter}`, tick: world.tick });
  const select = (components: StructureComponent[]) => {
    const blueprint: BlueprintView = { ...defaultBlueprint(), id: `blueprint-${++world.blueprintCounter}`, components,
      cost: blueprintCost(components), generation: 1, parents: ['blueprint-base'], inventorId: person.id, tick: world.tick };
    world.blueprints.push(blueprint); person.blueprintId = blueprint.id; return blueprint;
  };
  const build = (x = 30, components: StructureComponent[] = ['frame', 'roof']) => {
    select(components); person.x = x; person.target = { x, y: 12 }; person.work = constructionCost(world, person).work;
    person.materials = { wood: 12, stone: 8 };
    const structure = completeConstruction(world, person, tileAt(world, person)!, emit)!;
    assert.ok(structure); person.x = 36; person.target = { x: 36, y: 12 }; person.materials = { wood: 12, stone: 8 }; person.work = 0;
    return structure;
  };
  return { world, person, select, build, emit };
}

test('a reusable local roof removes the marginal opportunity; an absent or remote roof does not', () => {
  const { world, person, build } = scene();
  assert.ok(constructionOpportunity(world, person));
  const structure = build();
  assert.equal(constructionOpportunity(world, person), undefined);
  structure.uses = 1_000_000;
  assert.equal(constructionOpportunity(world, person), undefined, 'historical use is not current occupancy');
  person.x = 38; // Eight cells from the same structure, beyond local perception.
  assert.ok(constructionOpportunity(world, person));
});

test('ordinary roof wear cannot finance a duplicate; lost physical roof function can', () => {
  const { world, person, build } = scene(), structure = build();
  structure.condition = 0.999;
  assert.equal(constructionOpportunity(world, person), undefined);
  assert.equal(repairOpportunity(world, person), undefined);
  tileAt(world, structure)!.terrain = 'meadow';
  assert.ok(constructionOpportunity(world, person));
  assert.equal(repairOpportunity(world, person), undefined);
});

test('a moderately worn roof six cells away can be restored under the existing physical repair law', () => {
  const { world, person, build, emit } = scene(), structure = build(30); structure.condition = 0.9;
  assert.equal(constructionOpportunity(world, person), undefined);
  assert.equal(repairOpportunity(world, person), structure);
  person.work = 30;
  assert.equal(repair(world, person, structure, emit), false, 'perception does not bypass physical travel');
  person.x = 30; person.target = { x: 30, y: 12 };
  assert.equal(repair(world, person, structure, emit), true);
  assert.equal(structure.condition, 1); assert.equal(person.materials.wood, 11); assert.equal(person.work, 0);
});

test('a selected cistern adds a missing catchment function but an equivalent empty cistern does not', () => {
  const { world, person, build, select } = scene();
  build(); world.weather = 'rain'; person.thirst = 0.7;
  for (const tile of world.tiles) tile.drinkingWater = 0;
  select(['frame', 'roof', 'cistern']);
  assert.ok(constructionOpportunity(world, person));
  const cistern = build(42, ['frame', 'roof', 'cistern']);
  assert.equal(cistern.water, 0);
  assert.equal(constructionOpportunity(world, person), undefined);
  person.x = cistern.x; person.target = { x: cistern.x, y: cistern.y }; person.action = 'drink';
  assert.equal(takeWater(world, person, 0.1), 0, 'forecast catchment does not create drinkable water');
  cistern.x = 44;
  person.x = 36; person.target = { x: 36, y: 12 };
  assert.ok(constructionOpportunity(world, person), 'remote infrastructure does not suppress local demand');
});

test('locally sufficient water removes the cistern incentive and unknown plans add no capabilities', () => {
  const { world, person, build, select } = scene(); build();
  select(['frame', 'roof', 'cistern']);
  assert.equal(constructionOpportunity(world, person), undefined);
  for (const tile of world.tiles) tile.drinkingWater = 0;
  world.weather = 'rain'; person.thirst = 0.7; person.blueprintId = 'not-known';
  assert.equal(constructionOpportunity(world, person), undefined, 'catalogue availability is not selected know-how');
});

test('additional cistern capacity follows visible thirsty people, not a global population count', () => {
  const { world, person, build } = scene();
  build(30, ['frame', 'roof', 'cistern']); world.weather = 'rain'; person.thirst = 0.9;
  for (const tile of world.tiles) tile.drinkingWater = 0;
  const others = [0, 1, 2].map(i => ({ ...person, id: `local-${i}`, x: 36 + i, y: 13 }));
  world.people.push(...others);
  assert.ok(constructionOpportunity(world, person));
  for (const other of others) other.x += 20;
  assert.equal(constructionOpportunity(world, person), undefined);
});

test('a worn cistern with real water is reusable even when its prospective catchment is weak', () => {
  const { world, person, build } = scene(), cistern = build(30, ['frame', 'roof', 'cistern']);
  build(42); person.blueprintId = cistern.blueprintId; cistern.condition = 0.11; cistern.water = 0.6;
  world.weather = 'rain'; person.thirst = 0.8;
  for (const tile of world.tiles) tile.drinkingWater = 0;
  assert.equal(constructionOpportunity(world, person), undefined);
});

test('additional granary space requires real carried surplus and accounts for already occupied storage', () => {
  const { world, person, build, select } = scene(); build();
  select(['frame', 'roof', 'granary']);
  for (const tile of world.tiles) tile.food = 0;
  assert.equal(constructionOpportunity(world, person), undefined);
  person.inventory = 0.25;
  assert.ok(constructionOpportunity(world, person));
  const granary = build(42, ['frame', 'roof', 'granary']);
  assert.equal(constructionOpportunity(world, person), undefined);
  granary.food = 0.7;
  assert.ok(constructionOpportunity(world, person));
});

test('wood committed to a new hearth structure cannot also count as its fuel', () => {
  const { world, person, build, select } = scene(); build(); world.weather = 'rain';
  select(['frame', 'roof', 'hearth']); person.materials.wood = constructionCost(world, person).wood;
  assert.equal(constructionOpportunity(world, person), undefined);
  person.materials.wood++;
  assert.ok(constructionOpportunity(world, person));
});

test('materials must be owned or perceived on land; distant and fractional unusable deposits do not suffice', () => {
  const { world, person } = scene(); person.materials = { wood: 0, stone: 0 };
  assert.equal(constructionOpportunity(world, person), undefined);
  const distant = tileAt(world, { x: 44, y: 12 })!; distant.wood = 100; distant.stone = 100;
  assert.equal(constructionOpportunity(world, person), undefined);
  for (const tile of world.tiles) { if (Math.hypot(tile.x - person.x, tile.y - person.y) <= 7) { tile.wood = 0.9; tile.stone = 0.9; } }
  assert.equal(constructionOpportunity(world, person), undefined);
  const local = tileAt(world, person)!; local.wood = 6; local.stone = 3;
  assert.ok(constructionOpportunity(world, person));
  local.terrain = 'water';
  assert.equal(constructionOpportunity(world, person), undefined);
});

test('repair is selected for recoverable service, not because an unused redundant building is damaged', () => {
  const { world, person, build } = scene(), damaged = build(32);
  damaged.condition = 0.5;
  assert.equal(repairOpportunity(world, person), damaged);
  assert.equal(constructionOpportunity(world, person), undefined, 'cheaper recovery precedes duplication');
  build(40);
  assert.equal(repairOpportunity(world, person), undefined);
  assert.equal(constructionOpportunity(world, person), undefined);
});

test('a broken roof can require two real repair debits before recovery; no free stock or first-step benefit', () => {
  const { world, person, build, emit } = scene(), structure = build(32); structure.condition = 0;
  assert.equal(repairOpportunity(world, person), structure);
  person.x = 32; person.target = { x: 32, y: 12 }; person.materials.wood = 2;
  const initialQuality = facilityRestQuality(world, person);
  for (let step = 0; step < 2; step++) {
    assert.equal(repairOpportunity(world, person), structure);
    person.work = 30; assert.equal(repair(world, person, structure, emit), true);
    assert.equal(person.materials.wood, 1 - step); assert.equal(person.work, 0);
    if (step === 0) assert.equal(facilityRestQuality(world, person), initialQuality);
  }
  assert.ok(facilityRestQuality(world, person) > initialQuality);
});

test('repair without carried wood does not spend imagined supply; perceived wood can support a later paid repair', () => {
  const { world, person, build, emit } = scene(), structure = build(32); structure.condition = 0.5;
  person.materials.wood = 0; person.work = 30; tileAt(world, person)!.wood = 6;
  assert.equal(repairOpportunity(world, person), undefined);
  assert.equal(constructionOpportunity(world, person), undefined);
  assert.equal(repair(world, person, structure, emit), false);
  assert.equal(structure.condition, 0.5); assert.equal(person.work, 30);
});

test('an intermediate repair that cannot yet restore service also needs material for the remaining step', () => {
  const { world, person, build } = scene(), structure = build(32); structure.condition = 0;
  person.materials.wood = 1;
  assert.equal(repairOpportunity(world, person), undefined);
  tileAt(world, person)!.wood = 1;
  assert.equal(repairOpportunity(world, person), structure);
});

test('opportunity evaluation is pure and explicit redundant construction still pays exact costs', () => {
  const { world, person, build, emit } = scene(); build();
  const before = JSON.stringify(world);
  assert.equal(constructionOpportunity(world, person), undefined); repairOpportunity(world, person);
  assert.equal(JSON.stringify(world), before);
  person.work = 90;
  const structure = completeConstruction(world, person, tileAt(world, person)!, emit)!;
  assert.ok(structure); assert.deepEqual(person.materials, { wood: 6, stone: 5 });
  assert.equal(person.work, 0); assert.equal(structure.water + structure.food, 0);
});
