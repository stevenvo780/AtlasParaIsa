import test from 'node:test';
import assert from 'node:assert/strict';
import type { BlueprintView, StructureComponent, StructureView } from '../src/shared/life.js';
import type { ChronicleEvent } from '../src/shared/types.js';
import type { TechnologyProgram } from '../src/shared/technology.js';
import { createWorld, tileAt, type World, type Person } from '../src/world/index.js';
import { chunkKey } from '../src/world/terrain.js';
import { parseParams, setParams } from '../src/world/params.js';
import { blueprintCost, completeConstruction, completedStructureCells, computeStructureSynergy, contributeConstruction,
  defaultBlueprint, facilityRestQuality, fittingPolyomino, isFootprintFree, materialCapacity, polyominoCost,
  polyominoGeometry, stepStructures, structureFootprintCells, waterAvailable } from '../src/world/inventions.js';
import { assertChunkLife, assertEcosystemTile, assertStructures } from '../src/world/validation.js';
import { assertTechnology, craftTechnology, researchTechnology, technologyWorkCost, workshopWorkFactor } from '../src/world/technology.js';

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
const framed = (n: number, modules: StructureComponent[] = []): StructureComponent[] => [...Array<StructureComponent>(n).fill('frame'), 'roof', ...modules];
function scene(enabled = true, seed = 51926) {
  const world = createWorld(seed), person = world.people[2]!;
  setParams(world, parseParams(`construccion.modular=true,construccion.poliminosYSinergia=${enabled}`));
  world.people = [person]; world.structures = []; world.places = []; world.blueprints = [defaultBlueprint()];
  world.tick = 600; world.weather = 'rain'; world.blueprintCounter = 0; world.structureCounter = 0;
  for (const t of world.tiles) { t.terrain = 'meadow'; t.moisture = 0.5; t.food = 0.2; t.drinkingWater = 0; t.wood = 0; t.stone = 0; }
  Object.assign(person, { x: 36, y: 12, target: { x: 36, y: 12 }, inventory: 0, energy: 1, fatigue: 0.1, hunger: 0.1, thirst: 0.1, work: 0 });
  person.materials = { wood: 0, stone: 0 };
  const emit = (e: Omit<ChronicleEvent, 'id' | 'tick'>): ChronicleEvent => {
    const event = { ...e, id: `event-${world.events.length}`, tick: world.tick }; world.events.push(event); return event;
  };
  return { world, person, emit };
}
function blueprint(world: World, person: Person, components: StructureComponent[]): BlueprintView {
  const b = { ...defaultBlueprint(), id: `blueprint-${++world.blueprintCounter}`, components, cost: blueprintCost(components, true),
    parents: ['blueprint-base'], generation: 1, inventorId: person.id, tick: world.tick };
  world.blueprints.push(b); person.blueprintId = b.id; return b;
}
function finish(state: ReturnType<typeof scene>, structure: StructureView) {
  const { world, person, emit } = state;
  let wood = 0, stone = 0, work = 0;
  while (structure.site) {
    const site = structure.site;
    person.materials = { wood: Math.min(12, site.requiredWood - site.depositedWood), stone: Math.min(8, site.requiredStone - site.depositedStone) };
    person.work = site.requiredWork - site.completedWork;
    wood += person.materials.wood; stone += person.materials.stone; work += person.work;
    assert.ok(contributeConstruction(world, person, structure, emit));
    wood -= person.materials.wood; stone -= person.materials.stone; work -= person.work;
  }
  return { wood, stone, work };
}
function build(state: ReturnType<typeof scene>, components: StructureComponent[]) {
  const { world, person, emit } = state;
  blueprint(world, person, components); person.materials = { wood: 0, stone: 0 }; person.work = 1;
  const s = completeConstruction(world, person, tileAt(world, person)!, emit)!;
  assert.ok(s); const paid = finish(state, s); paid.work++;
  assertStructures(world.structures, world.tick, world.tiles);
  return { s, paid };
}
/** Explicit completed fixture, with no manufactured matter or fabricated use credit. */
function building(state: ReturnType<typeof scene>, x: number, y: number, components = framed(1), cells?: StructureView['cells']) {
  const b = blueprint(state.world, state.person, components);
  const s: StructureView = { id: `structure-${++state.world.structureCounter}`, x, y, blueprintId: b.id, name: b.name,
    components, condition: 1, water: 0, food: 0, uses: 0, builtAt: 0, builderId: null, ...(cells ? { cells } : {}) };
  state.world.structures.push(s);
  for (const c of completedStructureCells(s)) tileAt(state.world, c)!.terrain = 'shelter';
  return s;
}
function tick(state: ReturnType<typeof scene>) { state.world.tick += 10; stepStructures(state.world, state.emit); }

test('disabled V20 preserves the V19 geometry, paid costs and complete local trajectory', () => {
  for (const seed of [7, 42, 51926]) {
    const a = scene(false, seed), b = scene(false, seed);
    setParams(b.world, parseParams('construccion.modular=true'));
    for (const state of [a, b]) {
      const { s, paid } = build(state, framed(5, ['cistern', 'granary', 'hearth']));
      assert.equal(s.cells, undefined); assert.deepEqual(s.footprint, { width: 2, height: 2 });
      assert.deepEqual(paid, blueprintCost(s.components, true));
      s.water = 0.4; s.food = 0.3;
      for (let i = 0; i < 8; i++) tick(state);
      assert.equal(s.synergy, undefined); assert.equal(s.materialProfile, undefined);
      assert.equal(workshopWorkFactor(state.world, state.person), 1);
    }
    assert.deepEqual(a.world, b.world);
  }
});

test('paid organic growth preserves every old cell and charges only the super-linear integer delta', () => {
  const state = scene(), { world, person, emit } = state;
  const { s, paid } = build(state, framed(1, ['cistern', 'granary']));
  s.water = 0.4; s.food = 0.3;
  const id = s.id, builtAt = s.builtAt;
  for (const [frames, area] of [[3, 2], [4, 3], [5, 4], [6, 6]]) {
    const oldCells = structuredClone(completedStructureCells(s)), previous = { ...paid };
    const b = blueprint(world, person, framed(frames!, ['cistern', 'granary']));
    person.materials = { wood: 0, stone: 0 }; person.work = 1;
    assert.equal(completeConstruction(world, person, tileAt(world, person)!, emit), s);
    assert.ok(s.site?.expansion?.cells); assert.equal(structureFootprintCells(s).length, area);
    assert.deepEqual(completedStructureCells(s), oldCells);
    const total = polyominoCost(b.components, area!);
    assert.deepEqual([s.site.requiredWood, s.site.requiredStone, s.site.requiredWork], [total.wood - paid.wood, total.stone - paid.stone, total.work - paid.work]);
    assertStructures(world.structures, world.tick, world.tiles);
    const delta = finish(state, s); delta.work++;
    paid.wood += delta.wood; paid.stone += delta.stone; paid.work += delta.work;
    assert.deepEqual(paid, total);
    assert.ok(total.work - previous.work > blueprintCost(b.components, true).work - blueprintCost(s.components, true).work);
    assert.equal(s.cells!.length, area);
    for (const c of oldCells) assert.ok(s.cells!.some(p => p.x === c.x && p.y === c.y));
    assert.equal(s.id, id); assert.equal(s.builtAt, builtAt); assert.equal(s.water, 0.4); assert.equal(s.food, 0.3);
    assert.equal(world.structures.length, 1); assert.equal(materialCapacity(s).wood, area! * 12);
    if (area === 3) assert.equal(new Set(s.cells!.map(c => c.x)).size, 2); // L, not a rectangle.
    if (area === 6) assert.equal(s.footprint, undefined);
    assertStructures(world.structures, world.tick, world.tiles);
  }
});

test('growth avoids water, shelters and neighbours, fits T/U/long shapes and remains in its archival chunk', () => {
  for (const seed of [7, 42, 51926]) {
    const state = scene(true, seed), { world, person } = state;
    person.x = 47; person.y = 15; // Both positive directions leave this chunk.
    tileAt(world, { x: 46, y: 14 })!.terrain = 'water';
    const neighbour = building(state, 45, 15);
    const cells = fittingPolyomino(world, person, framed(6)); assert.ok(cells);
    assert.equal(cells.length, 6);
    assert.ok(cells.every(c => chunkKey(c.x, c.y) === chunkKey(person.x, person.y)));
    assert.ok(cells.every(c => tileAt(world, c)!.terrain !== 'water' && (c.x !== neighbour.x || c.y !== neighbour.y)));
    const { s } = build(state, framed(6));
    assert.deepEqual(s.cells, cells);
    const key = chunkKey(s.x, s.y), chunk = world.chunks[key]!;
    const archived = JSON.parse(JSON.stringify({ ...chunk, tiles: world.tiles.filter(t => chunkKey(t.x, t.y) === key), structures: [s], animals: undefined, lifeVersion: undefined }));
    assertChunkLife(archived, world.tick); assert.deepEqual(archived.structures[0].cells, s.cells);
  }
  const state = scene();
  const compact = fittingPolyomino(state.world, state.person, framed(5)); assert.ok(compact);
  const exposed = fittingPolyomino(state.world, state.person, framed(5, ['cistern', 'cistern', 'garden', 'garden'])); assert.ok(exposed);
  assert.ok(polyominoGeometry(exposed).perimeter > polyominoGeometry(compact).perimeter);
  for (const t of state.world.tiles) if (t.x !== 36 || t.y !== 12) t.terrain = 'water';
  assert.equal(fittingPolyomino(state.world, state.person, framed(3)), false);
  state.person.work = 10;
  blueprint(state.world, state.person, framed(3));
  assert.equal(completeConstruction(state.world, state.person, tileAt(state.world, state.person)!, state.emit), null);
  assert.equal(state.person.work, 10);
});

test('geometry counts outer edges exactly, including a courtyard', () => {
  const grid = (w: number, h: number) => Array.from({ length: w * h }, (_, i) => ({ x: i % w, y: Math.floor(i / w) }));
  for (const [w, h, perimeter, compactness] of [[1, 1, 4, 0.25], [2, 2, 8, 0.5], [3, 2, 10, 0.6], [3, 1, 8, 0.375]]) {
    assert.deepEqual(polyominoGeometry(grid(w!, h!)), { area: w! * h!, perimeter, compactness });
  }
  assert.deepEqual(polyominoGeometry([]), { area: 0, perimeter: 0, compactness: 0 });
  assert.equal(polyominoGeometry([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }, { x: 2, y: 1 }]).perimeter, 12);
});

test('exposed halls collect more rain while compact halls lose less condition and retain more warmth', () => {
  const compact = scene(), exposed = scene();
  const square = [{ x: 36, y: 12 }, { x: 37, y: 12 }, { x: 36, y: 13 }, { x: 37, y: 13 }];
  const tee = [{ x: 36, y: 12 }, { x: 37, y: 12 }, { x: 35, y: 12 }, { x: 36, y: 13 }];
  const modules: StructureComponent[] = ['cistern', 'hearth'];
  const a = building(compact, 36, 12, framed(5, modules), square), b = building(exposed, 36, 12, framed(5, modules), tee);
  tick(compact); tick(exposed);
  assert.ok(a.condition > b.condition); assert.ok(b.water > a.water);
  // Isolate thermal geometry from roof rest-quality saturation.
  a.components = b.components = framed(1, ['hearth']); a.condition = b.condition = 0.8;
  compact.person.materials.wood = exposed.person.materials.wood = 1;
  assert.ok(facilityRestQuality(compact.world, compact.person) > facilityRestQuality(exposed.world, exposed.person));
});

test('shared walls lower weather wear and raise hearth quality; broken and unfinished neighbours cannot help', () => {
  const touching = scene(), alone = scene();
  const a = building(touching, 36, 12, framed(1, ['hearth'])), b = building(alone, 36, 12, framed(1, ['hearth']));
  const neighbour = building(touching, 37, 12);
  tick(touching); tick(alone);
  assert.equal(a.synergy!.sharedEdges, 1); assert.ok(a.condition > b.condition);
  a.condition = b.condition = 0.8;
  touching.person.materials.wood = alone.person.materials.wood = 1;
  assert.ok(facilityRestQuality(touching.world, touching.person) > facilityRestQuality(alone.world, alone.person));
  neighbour.condition = 0.1; assert.equal(computeStructureSynergy(touching.world, a).sharedEdges, 0);
  neighbour.condition = 1; neighbour.site = { requiredWood: 6, requiredStone: 3, requiredWork: 90, depositedWood: 0, depositedStone: 0, completedWork: 0 };
  assert.equal(computeStructureSynergy(touching.world, a).sharedEdges, 0);
});

test('neighbour irrigation transfers exactly 0.01 real water and credits actual cistern utility', () => {
  const state = scene(), { world } = state; world.weather = 'clear'; world.people = [];
  const garden = building(state, 36, 12, framed(1, ['cistern', 'garden']));
  const donor = building(state, 39, 12, framed(1, ['cistern'])); donor.water = 0.2;
  const beforeSoil = world.tiles.reduce((n, t) => n + t.moisture, 0);
  tick(state);
  near(donor.water + donor.losses!.water, 0.19);
  const soilGain = world.tiles.reduce((n, t) => n + t.moisture, 0) - beforeSoil;
  assert.ok(soilGain > 0); near(garden.water + soilGain, 0.01);
  assert.equal(donor.uses, 1); assert.equal(world.blueprints.find(b => b.id === donor.blueprintId)!.uses, 1);
  assert.equal(garden.synergy!.irrigated, true);
  donor.water = 0.019; garden.water = 0; tick(state); assert.equal(donor.uses, 1); assert.equal(garden.water, 0);
  const remote = scene(); remote.world.weather = 'clear'; const g = building(remote, 36, 12, framed(1, ['cistern', 'garden']));
  building(remote, 40, 12, framed(1, ['cistern'])).water = 0.2; tick(remote);
  assert.equal(g.water, 0); assert.equal(g.synergy!.irrigated, false);
});

test('a local hearth halves granary spoilage; a hearth beyond three cells has no effect', () => {
  const heated = scene(), cold = scene(), remote = scene();
  const stores = [heated, cold, remote].map(s => building(s, 36, 12, framed(1, ['granary'])));
  building(heated, 39, 12, framed(1, ['hearth'])); building(remote, 40, 12, framed(1, ['hearth']));
  stores.forEach(s => { s.food = 0.5; });
  [heated, cold, remote].forEach(tick);
  near(stores[0]!.losses!.food * 2, stores[1]!.losses!.food);
  near(stores[2]!.losses!.food, stores[1]!.losses!.food);
  assert.equal(stores[0]!.synergy!.heated, true); assert.equal(stores[2]!.synergy!.heated, false);
});

test('material strength, seal and insulation have independent physical effects and compound tints survive archival', () => {
  const strong = scene(), weak = scene();
  const a = building(strong, 36, 12, framed(2, ['cistern', 'granary', 'hearth']));
  const b = building(weak, 36, 12, framed(2, ['cistern', 'granary', 'hearth']));
  a.materialProfile = { strength: 1, insulation: 1, seal: 1, tint: '#ffffff' };
  b.materialProfile = { strength: 0, insulation: 0, seal: 0, tint: '#000000' };
  a.food = b.food = 0.3; a.water = b.water = 0.3;
  tick(strong); tick(weak);
  assert.ok(a.condition > b.condition); assert.ok(a.losses!.water < b.losses!.water); assert.ok(a.losses!.food < b.losses!.food);
  a.condition = b.condition = 0.8; strong.person.materials.wood = weak.person.materials.wood = 1;
  assert.ok(facilityRestQuality(strong.world, strong.person) > facilityRestQuality(weak.world, weak.person));
  delete a.materialProfile;
  a.storedCompounds = [{ id: 'lot-1', formulaId: 'formula-1', phase: 'fired', mass: 1000,
    composition: { C: 1000, Si: 0, Ca: 0, Fe: 0, S: 0, H: 0 },
    properties: { hardness: 0.8, toughness: 0.7, seal: 0.9, insulation: 0.8, fuelPower: 0.7, colorHex: '#aabbcc' } }];
  tick(strong); assert.equal(a.materialProfile!.tint, '#aabbcc');
  assert.deepEqual(JSON.parse(JSON.stringify(a)).storedCompounds, a.storedCompounds);
  assertStructures(strong.world.structures, strong.world.tick, strong.world.tiles);
});

const vessel: TechnologyProgram = { inputs: [{ source: 'raw', material: 'wood', mass: 1000 }, { source: 'raw', material: 'stone', mass: 1000 }],
  steps: [{ op: 'combine', intensity: 2 }, { op: 'form', intensity: 4, shape: 'hollow' }] };
function manufacture(state: ReturnType<typeof scene>, craft = false) {
  const { world, person } = state;
  if (!craft) person.technology.project = { kind: 'research', program: structuredClone(vessel), parents: [], recipeId: null,
    progress: 0, requiredWork: technologyWorkCost(vessel), energyPaid: 0, startedAt: world.tick };
  const recipe = person.technology.knownRecipes[0];
  let ticks = 0, success = false;
  do { world.tick++; ticks++; success = craft ? craftTechnology(world, person, recipe) : researchTechnology(world, person); assertTechnology(world); }
  while (person.technology.project && ticks < 100);
  assert.ok(success); return ticks;
}

test('warehouse supplies conserved integer wood/stone to researchers and crafters while workshops save real work', () => {
  const state = scene(), control = scene(), { world, person } = state;
  const warehouse = building(state, 37, 12, framed(2, ['hearth'])); warehouse.storedWood = 8; warehouse.storedStone = 6;
  tick(state); assert.ok(warehouse.synergy!.workshopBonus > 0);
  control.person.materials = { wood: 8, stone: 6 };
  const researchTicks = manufacture(state), controlTicks = manufacture(control);
  assert.ok(researchTicks < controlTicks);
  assert.deepEqual(person.materials, { wood: 0, stone: 0 });
  assert.deepEqual([warehouse.storedWood, warehouse.storedStone], [7, 5]); assert.equal(warehouse.uses, 1);
  const craftTicks = manufacture(state, true), controlCraft = manufacture(control, true);
  assert.ok(craftTicks < controlCraft);
  assert.deepEqual([warehouse.storedWood, warehouse.storedStone], [6, 4]); assert.equal(warehouse.uses, 2);
  assert.deepEqual(world.technology.ledger.imported, { wood: 2000, stone: 2000, water: 0 });
  assert.equal(world.technology.ledger.work, researchTicks + craftTicks);
  assert.equal(world.technology.history.filter(e => e.kind === 'research' || e.kind === 'craft').reduce((sum, e) => sum + e.work, 0), researchTicks + craftTicks);
  assertStructures(world.structures, world.tick, world.tiles); assertTechnology(world);
  person.x = 41; assert.equal(workshopWorkFactor(world, person), 1);
});

test('workshop constitutive bonus and kiln tier require completed, functional local assets', () => {
  const state = scene(), s = building(state, 36, 12, framed(2, ['hearth']));
  assert.equal(computeStructureSynergy(state.world, s).kilnTier, 1);
  s.installed = [{ id: 'fixed', recipeId: null, mass: 1000, containment: 1, insulation: 1, cohesion: 1, binding: 1, condition: 1 }];
  const warehouse = building(state, 39, 12, framed(2)); warehouse.storedWood = 1;
  s.synergy = computeStructureSynergy(state.world, s);
  assert.equal(s.synergy.kilnTier, 2); assert.equal(s.synergy.workshopBonus, 0.30);
  near(workshopWorkFactor(state.world, state.person), 0.70);
  s.condition = 0.1; assert.equal(workshopWorkFactor(state.world, state.person), 1);
  assert.equal(computeStructureSynergy(state.world, s).kilnTier, 0);
});

test('strict validation rejects disconnected, duplicate, missing-anchor, cross-chunk and overlapping polyominoes', () => {
  const state = scene(), { s } = build(state, framed(4));
  const original = structuredClone(s);
  for (const cells of [[], [{ x: 36, y: 12 }, { x: 38, y: 12 }], [{ x: 36, y: 12 }, { x: 36, y: 12 }],
    [{ x: 37, y: 12 }], [{ x: 36, y: 12 }, { x: 48, y: 12 }], [{ x: 36.5, y: 12 }],
    Array.from({ length: 7 }, (_, i) => ({ x: 36 + i, y: 12 }))]) {
    const copy = { ...original, cells }; assert.throws(() => assertStructures([copy], state.world.tick, state.world.tiles));
  }
  const collision = { ...original, id: 'collision' };
  assert.throws(() => assertStructures([original, collision], state.world.tick, state.world.tiles));
  assert.equal(isFootprintFree(state.world, [{ x: 37, y: 12 }]), false);
  blueprint(state.world, state.person, framed(5)); state.person.work = 1;
  completeConstruction(state.world, state.person, tileAt(state.world, state.person)!, state.emit);
  assert.ok(s.site?.expansion?.cells);
  s.site.expansion.cells = [{ x: 36, y: 12 }, { x: 38, y: 12 }];
  assert.throws(() => assertStructures([s], state.world.tick, state.world.tiles));
});

test('strict validation rejects malformed material, synergy, compound masses and paved states', () => {
  const state = scene(), { s } = build(state, framed(1)); tick(state);
  for (const patch of [
    { materialProfile: { strength: NaN, insulation: 0, seal: 0, tint: '#aaaaaa' } },
    { materialProfile: { strength: 0, insulation: 2, seal: 0, tint: '#aaaaaa' } },
    { materialProfile: { strength: 0, insulation: 0, seal: -1, tint: '#aaaaaa' } },
    { materialProfile: { strength: 0, insulation: 0, seal: 0, tint: 'invalid' } },
    { synergy: { sharedEdges: -1, heated: false, irrigated: false, workshopBonus: 0 } },
    { synergy: { sharedEdges: 0.5, heated: false, irrigated: false, workshopBonus: 0 } },
    { synergy: { sharedEdges: 0, heated: 1, irrigated: false, workshopBonus: 0 } },
    { synergy: { sharedEdges: 0, heated: false, irrigated: false, workshopBonus: 0.31 } },
    { synergy: { sharedEdges: 0, heated: false, irrigated: false, workshopBonus: 0, kilnTier: 3 } },
    { storedCompounds: [{ mass: -1 }] }, { storedCompounds: [{ mass: Infinity }] },
  ]) assert.throws(() => assertStructures([{ ...s, ...patch }], state.world.tick, state.world.tiles));
  const tile = tileAt(state.world, state.person)!;
  for (const paved of [-0.1, 1.1, NaN, Infinity]) assert.throws(() => assertEcosystemTile({ ...tile, paved }, false));
  for (const paved of [0, 0.5, 1]) assertEcosystemTile({ ...tile, paved }, false);
});
