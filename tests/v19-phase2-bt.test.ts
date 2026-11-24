import test from 'node:test';
import assert from 'node:assert/strict';
import type { BlueprintView, StructureComponent, StructureView } from '../src/shared/life.js';
import type { ChronicleEvent } from '../src/shared/types.js';
import type { TechnologyProgram } from '../src/shared/technology.js';
import { createWorld, tileAt, type World, type Person } from '../src/world/index.js';
import { paramsOf, parseParams, setParams } from '../src/world/params.js';
import { blueprintAffordances, blueprintCost, blueprintSignature, completeConstruction, constructionCost,
  constructionOpportunity, contributeConstruction, defaultBlueprint, facilityRestQuality, foodAvailable, invent,
  inventionCandidates, inventionContext, locallyUsefulBlueprint, repair, stepStructures, structureAffordances,
  validBlueprint, waterAvailable, depositMaterials, isFootprintFree, materialCapacity, structureFootprintCells,
  storedMaterialsNear, takeWater } from '../src/world/inventions.js';
import { assertBlueprint, assertChunkLife, assertStructures } from '../src/world/validation.js';
import { cooperate } from '../src/world/society.js';
import { assertTechnology, consumeConstructionTools, installTechnologyItem, materialCapacities, projectTechnology,
  researchTechnology, settleTechnologyEstate, technologyWorkCost } from '../src/world/technology.js';

function scene(modular = false, properties = false, seed = 51926) {
  const world = createWorld(seed), person = world.people[2]!, helper = world.people[3]!;
  setParams(world, parseParams(`construccion.modular=${modular},tecnologia.obrasPorPropiedades=${properties}`));
  world.people = [person, helper]; world.structures = []; world.places = []; world.blueprints = [defaultBlueprint()];
  world.blueprintCounter = 0; world.structureCounter = 0; world.tick = 600; world.weather = 'rain';
  for (const tile of world.tiles) { tile.terrain = 'meadow'; tile.food = 0.2; tile.moisture = 0.5; tile.drinkingWater = 0; tile.wood = 0; tile.stone = 0; }
  for (const p of world.people) {
    p.x = 36; p.y = 12; p.target = { x: p.x, y: p.y }; p.materials = { wood: 12, stone: 8 };
    p.work = 0; p.inventory = 0; p.skills = { build: 0.3 }; p.activity = { build: 2 }; p.energy = 1; p.fatigue = 0.1;
    p.hunger = 0.1; p.thirst = 0.1; p.blueprintId = null; p.lastInvention = undefined; p.lastSocial = -30;
  }
  const emit = (e: Omit<ChronicleEvent, 'id' | 'tick'>): ChronicleEvent => {
    const event = { ...e, id: `event-${world.events.length}`, tick: world.tick }; world.events.push(event); return event;
  };
  return { world, person, helper, tile: tileAt(world, person)!, emit };
}
function blueprint(world: World, person: Person, components: StructureComponent[]): BlueprintView {
  const b = { ...defaultBlueprint(), components, cost: blueprintCost(components, paramsOf(world).construccion.modular), id: `blueprint-${++world.blueprintCounter}`,
    inventorId: person.id, generation: 1, parents: ['blueprint-base'], tick: world.tick };
  world.blueprints.push(b); person.blueprintId = b.id; return b;
}
const storage: StructureComponent[] = ['frame', 'roof', 'cistern', 'granary'];
const large: StructureComponent[] = ['frame', 'frame', 'roof', 'roof', 'cistern', 'granary', 'hearth'];
const vessel: TechnologyProgram = { inputs: [{ source: 'raw', material: 'wood', mass: 2000 }], steps: [{ op: 'form', intensity: 4, shape: 'hollow' }] };
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
function manufacture(world: World, actor: Person, program = vessel) {
  actor.technology.project = { kind: 'research', program: structuredClone(program), parents: [], recipeId: null,
    startedAt: world.tick, requiredWork: technologyWorkCost(program), progress: 0, energyPaid: 0 };
  let success = false;
  for (let i = 0; actor.technology.project && i < 250; i++) { world.tick++; success = researchTechnology(world, actor); }
  return success;
}

test('disabled B/T retain legacy 17 genotypes, carry limits, exact debits and no installations', () => {
  const signatures = new Set<string>();
  for (let f = 1; f <= 2; f++) for (let r = 1; r <= 2; r++) for (let c = 0; c <= 2; c++)
    for (let g = 0; g <= 2; g++) for (let d = 0; d <= 2; d++) for (let h = 0; h <= 1; h++) {
      const components = (['frame', 'roof', 'cistern', 'granary', 'garden', 'hearth'] as const)
        .flatMap((v, i) => Array.from({ length: [f, r, c, g, d, h][i]! }, () => v));
      if (validBlueprint(components)) signatures.add(blueprintSignature(components));
    }
  assert.equal(signatures.size, 17);
  const { world, person, tile, emit } = scene();
  assert.ok(manufacture(world, person)); const item = person.technology.items[0]!;
  person.materials = { wood: 12, stone: 8 }; const b = blueprint(world, person, storage);
  person.work = b.cost.work - 1; assert.equal(completeConstruction(world, person, tile, emit), null);
  assert.deepEqual(person.materials, { wood: 12, stone: 8 });
  person.work++; const s = completeConstruction(world, person, tile, emit)!;
  assert.equal(s.site, undefined); assert.equal(s.installed, undefined); assert.equal(person.technology.items[0], item);
  assert.equal(s.footprint, undefined); assert.equal(s.storedWood, undefined); assert.equal(s.storedStone, undefined);
  person.materials = { wood: 12, stone: 8 };
  assert.equal(depositMaterials(world, person, s), false); assert.equal(s.storedWood, undefined); assert.equal(s.storedStone, undefined);
  assert.deepEqual(storedMaterialsNear(world, person), { wood: 0, stone: 0 });
  person.materials = { wood: 1, stone: 1 };
  assert.deepEqual(person.materials, { wood: 1, stone: 1 }); assert.equal(person.work, 0);
  assert.equal(installTechnologyItem(world, person, s), false);
  assert.equal(validBlueprint(large), false);
  blueprint(world, person, ['frame', 'frame', 'roof']); person.materials = { wood: 12, stone: 8 }; person.work = 600;
  const before = structuredClone(s);
  assert.equal(completeConstruction(world, person, tile, emit), null); assert.deepEqual(s, before);
});

test('explicitly disabled and historical defaults produce identical deterministic local trajectories', () => {
  for (const seed of [7, 42, 51926, 104729]) {
    const a = scene(false, false, seed), b = scene(false, false, seed);
    setParams(b.world, parseParams(''));
    for (const state of [a, b]) {
      state.person.work = 60; invent(state.world, state.person, state.emit);
      assert.ok(manufacture(state.world, state.person));
      state.person.materials = { wood: 12, stone: 8 }; state.person.work = 600;
      completeConstruction(state.world, state.person, state.tile, state.emit);
      for (let n = 0; n < 12; n++) { state.world.tick += 10; stepStructures(state.world, state.emit); }
    }
    assert.deepEqual(a.world, b.world);
  }
});

test('modular grammar exceeds 25 signatures and rejects unsupported and malformed structures', () => {
  const signatures = new Set<string>();
  for (let frames = 1; frames <= 6; frames++) for (let roofs = 1; roofs <= frames; roofs++) for (let cisterns = 0; cisterns <= 6; cisterns++) {
    const components: StructureComponent[] = [...Array<StructureComponent>(frames).fill('frame'), ...Array<StructureComponent>(roofs).fill('roof'), ...Array<StructureComponent>(cisterns).fill('cistern')];
    if (validBlueprint(components, true)) signatures.add(blueprintSignature(components));
  }
  assert.ok(signatures.size > 25, `${signatures.size}`);
  assert.equal(validBlueprint(['frame', 'roof', ...Array(6).fill('cistern')], true), false);
  assert.equal(validBlueprint(['frame', 'roof', 'magic'], true), false);
  assert.ok(validBlueprint(large, true)); assert.deepEqual(blueprintCost(large), { wood: 18, stone: 12, work: 285 });
});

test('local Pareto admits a cheaper specialized cistern below the best aggregate value', () => {
  const { world, person } = scene(true), context = { ...inventionContext(world, person), water: 1, food: 0.7, foodSurplus: 1, rainPotential: 1 };
  const expensive = blueprint(world, person, ['frame', 'frame', 'roof', 'roof', 'cistern', 'granary', 'granary']);
  const cheap: StructureComponent[] = ['frame', 'roof', 'cistern'];
  assert.ok(blueprintCost(cheap).wood < expensive.cost.wood);
  assert.equal(locallyUsefulBlueprint(cheap, [expensive], context), true);
});

test('a remote catalogue signature does not block paid local rediscovery or leak knowledge', () => {
  const a = scene(true), b = scene(true);
  const candidates = inventionCandidates(a.world, a.person);
  for (const candidate of candidates) {
    const remote = blueprint(b.world, b.helper, candidate.components); remote.inventorId = b.helper.id;
  }
  b.helper.x += 2000; a.helper.x += 2000;
  assert.deepEqual(inventionCandidates(a.world, a.person), inventionCandidates(b.world, b.person));
  a.person.work = 60; b.person.work = 60;
  assert.equal(invent(a.world, a.person, a.emit), true); assert.equal(invent(b.world, b.person, b.emit), true);
  const selected = (s: typeof a) => s.world.blueprints.find(p => p.id === s.person.blueprintId)!.components;
  assert.deepEqual(selected(a), selected(b)); assert.equal(b.person.work, 0); assert.equal(b.person.materials.wood, 11);
  assert.equal(new Set(b.world.blueprints.map(p => blueprintSignature(p.components))).size, b.world.blueprints.length);
});

test('18/12 shared site accepts trips and cooperative work, conserves exactly, and supplies zero unfinished service', () => {
  const { world, person, helper, tile, emit } = scene(true);
  const b = blueprint(world, person, large); person.action = 'build'; helper.action = 'cooperate';
  assert.deepEqual(constructionCost(world, person), { wood: 12, stone: 8, work: 30 });
  person.work = 100; const s = completeConstruction(world, person, tile, emit)!;
  assert.ok(s.site); assert.deepEqual(person.materials, { wood: 0, stone: 0 });
  assert.deepEqual([s.site.depositedWood, s.site.depositedStone, s.site.completedWork], [12, 8, 100]);
  assert.equal(tile.terrain, 'meadow'); assert.equal(world.settlementCount, 0);
  assert.equal(facilityRestQuality(world, person), 0.2); assert.equal(waterAvailable(world, person), 0); assert.equal(foodAvailable(world, person), 0);
  person.inventory = 0.24; const before = JSON.stringify(s); world.tick += 10; stepStructures(world, emit);
  assert.equal(JSON.stringify(s), before); assert.equal(person.inventory, 0.24);
  assertStructures(world.structures, world.tick, world.tiles);
  assert.deepEqual(constructionOpportunity(world, person)?.target, { x: s.x, y: s.y });
  helper.work = 80; assert.equal(cooperate(world, helper, emit), true);
  assert.equal(s.site!.completedWork, 180); assert.deepEqual(helper.materials, { wood: 6, stone: 4 });
  assert.equal(helper.work, 0); assert.equal(s.site!.depositedWood, 18); assert.equal(s.site!.depositedStone, 12);
  person.work = 104; assert.ok(completeConstruction(world, person, tile, emit)?.site);
  person.work = 1; assert.ok(completeConstruction(world, person, tile, emit)); assert.equal(s.site, undefined);
  assert.equal(person.materials.wood + helper.materials.wood + b.cost.wood, 24);
  assert.equal(person.materials.stone + helper.materials.stone + b.cost.stone, 16);
  assert.equal(person.work + helper.work, 0); assert.equal(world.settlementCount, 1);
  assert.equal(tile.terrain, 'shelter'); assert.ok(facilityRestQuality(world, person) > 0.2);
  assert.equal(completeConstruction(world, person, tile, emit), null);
  assertStructures(world.structures, world.tick, world.tiles); assertBlueprint(b, world.tick, 64, true);
});

test('site paid work cannot be contributed from afar or counted twice', () => {
  const { world, person, helper, tile, emit } = scene(true); blueprint(world, person, large);
  person.work = 30; const s = completeConstruction(world, person, tile, emit)!;
  helper.x += 10; helper.work = 30; const snapshot = structuredClone(s);
  assert.equal(contributeConstruction(world, helper, s, emit), false); assert.deepEqual(s, snapshot); assert.equal(helper.work, 30);
  assert.equal(contributeConstruction(world, person, s, emit), false); assert.deepEqual(s, snapshot);
});

test('manufactured installations transfer exact mass, survive estates, and physically change capacity/loss by >10%', () => {
  const { world, person, tile, emit } = scene(false, true);
  assert.ok(manufacture(world, person)); const item = structuredClone(person.technology.items[0]!);
  assert.ok(materialCapacities(item).storage > 0.15);
  person.materials = { wood: 12, stone: 8 }; const b = blueprint(world, person, storage); person.work = b.cost.work;
  const s = completeConstruction(world, person, tile, emit)!;
  assert.equal(person.technology.items.length, 0); assert.equal(s.installed!.length, 1); assert.equal(s.installed![0]!.id, item.id);
  assert.deepEqual(s.installed![0]!.composition, item.composition); assert.equal(s.installed![0]!.mass, item.mass);
  const basic = blueprintAffordances(s.components), enhanced = structureAffordances(world, s);
  assert.ok(enhanced.waterCapacity >= basic.waterCapacity * 1.1); assert.ok(enhanced.foodCapacity >= basic.foodCapacity * 1.1);
  assertTechnology(world); assert.equal(projectTechnology(world).dynamics.massError, 0);
  const control = structuredClone(s); delete control.installed; control.id = 'structure-control'; control.x += 2;
  tileAt(world, control)!.terrain = 'shelter'; world.structures.push(control);
  s.water = control.water = 0.4; s.food = control.food = 0.3; world.weather = 'clear'; person.inventory = 0;
  world.tick += 10; stepStructures(world, emit);
  assert.ok((0.4 - s.water) <= (0.4 - control.water) * 0.9); assert.ok((0.3 - s.food) <= (0.3 - control.food) * 0.9);
  assert.ok(s.installed![0]!.condition < 1); close(s.water + s.losses!.water, 0.4); close(s.food + s.losses!.food, 0.3);
  s.installed![0]!.condition = 0; assert.deepEqual(structureAffordances(world, s), basic);
  s.water = control.water = 0.4; s.food = control.food = 0.3;
  world.tick += 10; stepStructures(world, emit); assert.equal(s.water, control.water); assert.equal(s.food, control.food);
  const installed = s.installed; delete s.installed; assert.deepEqual(structureAffordances(world, s), basic); s.installed = installed;
  settleTechnologyEstate(world, person); world.people = world.people.filter(p => p !== person);
  assertTechnology(world); assert.equal(projectTechnology(world).dynamics.massError, 0);
  assert.equal(s.installed![0]!.mass, item.mass); assertStructures([s], world.tick, world.tiles);
});

test('paid repair can install a replacement product and restore lost service without a fabricated reward floor', () => {
  const { world, person, tile, emit } = scene(false, true);
  const b = blueprint(world, person, storage); person.work = b.cost.work;
  const s = completeConstruction(world, person, tile, emit)!; s.condition = 0.3;
  person.materials.wood = 6; assert.ok(manufacture(world, person));
  const before = facilityRestQuality(world, person); person.work = 30;
  assert.equal(repair(world, person, s, emit), true); assert.ok(facilityRestQuality(world, person) > before);
  assert.equal(s.installed!.length, 1); assert.equal(person.technology.items.length, 0); assertTechnology(world);
  assert.equal(world.technology.recipes[0]!.utility, 0); // Installation itself delivers no service.
});

test('local recipe comparison ignores remote hot cache but recognizes nearby observed artifacts', () => {
  const a = scene(false, true), b = scene(false, true);
  assert.ok(manufacture(a.world, a.helper)); assert.ok(manufacture(b.world, b.helper));
  a.helper.x += 2000;
  assert.equal(manufacture(a.world, a.person), true);
  assert.equal(manufacture(b.world, b.person), false);
  assert.equal(a.world.technology.recipes.length, 1); // signature interning, paid rediscovery
  assert.equal(a.person.technology.knownRecipes.length, 1);
  assert.equal(b.person.technology.knownRecipes.length, 0);
  assertTechnology(a.world); assertTechnology(b.world);
});

test('malformed sites and installations fail validation, including duplicate portable/fixed matter', () => {
  const { world, person, tile, emit } = scene(true, true); blueprint(world, person, large);
  assert.ok(manufacture(world, person)); person.work = 30;
  const s = completeConstruction(world, person, tile, emit)!;
  assertStructures([s], world.tick, world.tiles); assertTechnology(world);
  for (const corrupt of [
    () => { s.site!.depositedWood = s.site!.requiredWood + 1; },
    () => { s.condition = 1; },
    () => { s.installed![0]!.condition = NaN; },
    () => { s.installed![0]!.mass++; },
  ]) {
    const before = structuredClone(s); corrupt(); assert.throws(() => assertStructures([s], world.tick, world.tiles)); Object.assign(s, before);
  }
  world.structures.push({ ...s, id: 'structure-duplicate', x: s.x + 1 });
  assert.throws(() => assertTechnology(world));
});

const framed = (frames: number, modules: StructureComponent[] = []): StructureComponent[] => [...Array<StructureComponent>(frames).fill('frame'), 'roof', ...modules];

/** Each load is an explicit fixture inflow; return the entire paid material budget. */
function buildFunded(state: ReturnType<typeof scene>, components: StructureComponent[]) {
  const { world, person, emit } = state, b = blueprint(world, person, components);
  let suppliedWood = 12, suppliedStone = 8;
  person.materials = { wood: 12, stone: 8 }; person.work = b.cost.work;
  const structure = completeConstruction(world, person, tileAt(world, person)!, emit)!;
  assert.ok(structure);
  for (let i = 0; structure.site && i < 20; i++) {
    suppliedWood += 12 - person.materials.wood; suppliedStone += 8 - person.materials.stone;
    person.materials = { wood: 12, stone: 8 };
    assert.equal(contributeConstruction(world, person, structure, emit), true);
  }
  assert.equal(structure.site, undefined);
  assert.equal(suppliedWood - person.materials.wood, b.cost.wood);
  assert.equal(suppliedStone - person.materials.stone, b.cost.stone);
  assert.equal(person.work, 0); assertBlueprint(b, world.tick, 64, true);
  assertStructures(world.structures, world.tick, world.tiles);
  return { structure, b };
}

test('modular footprints charge super-linear integer costs and protect every completed land tile', () => {
  for (const frames of [1, 2, 3, 4, 5, 6]) {
    const state = scene(true), components = framed(frames), linear = blueprintCost(components);
    const { structure: s, b } = buildFunded(state, components);
    const load = 1 + 0.15 * Math.max(0, frames - 1);
    assert.deepEqual(b.cost, frames < 3 ? linear : { wood: Math.ceil(linear.wood * load), stone: Math.ceil(linear.stone * load), work: Math.ceil(linear.work * load) });
    assert.equal(structureFootprintCells(s).length, frames < 3 ? 1 : frames < 5 ? 2 : 4);
    if (frames < 3) assert.equal(s.footprint, undefined);
    for (const cell of structureFootprintCells(s)) assert.equal(tileAt(state.world, cell)!.terrain, 'shelter');
    state.person.x += (s.footprint?.width ?? 1) - 1; state.person.y += (s.footprint?.height ?? 1) - 1;
    state.person.target = { x: state.person.x, y: state.person.y };
    assert.ok(facilityRestQuality(state.world, state.person) > 0.2);
  }
});

test('footprints reject occupied secondary cells, water and inactive land; deterministic vertical fallback and adjacency succeed', () => {
  const state = scene(true), { world, person, emit } = state;
  const { structure: hut } = buildFunded(state, framed(1));
  const anchor = { x: hut.x - 1, y: hut.y };
  person.x = anchor.x; person.y = anchor.y;
  blueprint(world, person, framed(3)); person.materials = { wood: 12, stone: 8 }; person.work = 0;
  const vertical = completeConstruction(world, person, tileAt(world, person)!, emit)!;
  assert.ok(vertical); assert.deepEqual(vertical.footprint, { width: 1, height: 2 });
  assert.equal(isFootprintFree(world, [{ x: vertical.x, y: vertical.y + 1 }]), false);
  person.y++; const before = structuredClone(person.materials);
  assert.equal(completeConstruction(world, person, tileAt(world, person)!, emit), null);
  assert.deepEqual(person.materials, before);
  assertStructures(world.structures, world.tick, world.tiles);

  for (const obstruction of ['water', 'inactive', 'occupied'] as const) {
    const s = scene(true), secondary = tileAt(s.world, { x: s.person.x + 1, y: s.person.y + 1 })!;
    if (obstruction === 'water') secondary.terrain = 'water';
    else if (obstruction === 'inactive') s.world.tiles = s.world.tiles.filter(t => t !== secondary);
    else {
      const x = s.person.x, y = s.person.y; s.person.x = secondary.x; s.person.y = secondary.y;
      buildFunded(s, framed(1)); s.person.x = x; s.person.y = y;
    }
    blueprint(s.world, s.person, framed(5)); s.person.work = 60; s.person.materials = { wood: 12, stone: 8 };
    const before = structuredClone({ materials: s.person.materials, work: s.person.work, structures: s.world.structures });
    assert.equal(completeConstruction(s.world, s.person, tileAt(s.world, s.person)!, s.emit), null, obstruction);
    assert.deepEqual({ materials: s.person.materials, work: s.person.work, structures: s.world.structures }, before);
  }
  const adjacent = scene(true); buildFunded(adjacent, framed(3)); adjacent.person.x += 2;
  const next = buildFunded(adjacent, framed(3)); assert.ok(next.structure);
  assert.equal(new Set(adjacent.world.structures.flatMap(structureFootprintCells).map(c => `${c.x},${c.y}`)).size, 4);
});

test('warehouse capacities scale with physical area, retain integer deposits and grant no utility for stockpiling', () => {
  for (const [frames, wood, stone] of [[1, 0, 0], [2, 12, 8], [3, 24, 16], [5, 48, 32]]) {
    const state = scene(true), { world, person } = state;
    const { structure: s, b } = buildFunded(state, framed(frames!));
    assert.deepEqual(materialCapacity(s), { wood, stone });
    let depositedWood = 0, depositedStone = 0;
    for (let n = 0; n < 20; n++) {
      person.materials = { wood: 12, stone: 8 };
      depositMaterials(world, person, s);
      depositedWood += 12 - person.materials.wood; depositedStone += 8 - person.materials.stone;
    }
    assert.equal(s.storedWood ?? 0, wood); assert.equal(s.storedStone ?? 0, stone);
    assert.equal(depositedWood, wood); assert.equal(depositedStone, stone);
    assert.equal(s.uses, 0); assert.equal(b.uses, 0); assert.equal(b.usefulness, 0);
    assert.equal(depositMaterials(world, person, s), false);
    assertStructures(world.structures, world.tick, world.tiles);
  }
});

test('deposit → warehouse → shared site conserves wood/stone exactly and credits only real local withdrawal', () => {
  const state = scene(true), { world, person, helper, emit } = state;
  const { structure: warehouse, b: warehouseBlueprint } = buildFunded(state, framed(3));
  person.materials = { wood: 12, stone: 8 };
  assert.equal(depositMaterials(world, person, warehouse), true);
  assert.deepEqual(person.materials, { wood: 4, stone: 3 });
  assert.deepEqual([warehouse.storedWood, warehouse.storedStone], [8, 5]);
  assert.equal(warehouseBlueprint.uses, 0);
  const target = blueprint(world, person, framed(5));
  person.x += 2; person.materials = { wood: 0, stone: 0 }; person.work = 1;
  const site = completeConstruction(world, person, tileAt(world, person)!, emit)!;
  assert.ok(site.site);
  assert.deepEqual([site.site.depositedWood, site.site.depositedStone], [8, 5]);
  assert.deepEqual([warehouse.storedWood, warehouse.storedStone], [0, 0]);
  assert.equal(warehouseBlueprint.uses, 1); assert.ok(warehouseBlueprint.usefulness > 0);
  assert.equal(site.site.depositedWood + warehouse.storedWood!, 8);
  assert.equal(site.site.depositedStone + warehouse.storedStone!, 5);
  assert.equal(contributeConstruction(world, person, site, emit), false); assert.equal(warehouseBlueprint.uses, 1);
  // A second fixture inflow cannot reach a builder outside physical contact.
  helper.materials = { wood: 12, stone: 8 }; depositMaterials(world, helper, warehouse);
  person.x += 4;
  const snapshot = structuredClone(world.structures);
  assert.equal(contributeConstruction(world, person, site, emit), false); assert.deepEqual(world.structures, snapshot);
  assert.equal(storedMaterialsNear(world, person).wood, 0);
  assert.equal(target.uses, 0); assertStructures(world.structures, world.tick, world.tiles);
});

test('autonomous material deposit, physical repair withdrawal and size-dependent wear retain exact stocks', () => {
  const state = scene(true), { world, person, helper, emit } = state;
  const { structure: s, b } = buildFunded(state, framed(5));
  helper.x += 100; person.materials = { wood: 12, stone: 8 }; world.tick += 10;
  stepStructures(world, emit);
  assert.deepEqual([s.storedWood, s.storedStone], [8, 5]); assert.equal(b.uses, 0);
  s.condition = 0.3; person.materials = { wood: 0, stone: 0 }; person.work = 210;
  const before = s.storedWood!;
  assert.equal(repair(world, person, s, emit), true);
  assert.equal(before - s.storedWood!, 7); assert.equal(s.storedStone, 5); assert.equal(person.work, 0); assert.equal(b.uses, 1);
  const small = scene(true), { structure: hut } = buildFunded(small, framed(1));
  s.condition = 1; hut.condition = 1; world.tick += 10; small.world.tick += 10;
  stepStructures(world, emit); stepStructures(small.world, small.emit);
  assert.ok(1 - s.condition > 1 - hut.condition);
  s.condition = 0; const stock = [s.storedWood, s.storedStone];
  person.materials = { wood: 12, stone: 8 };
  assert.equal(depositMaterials(world, person, s), false); assert.deepEqual([s.storedWood, s.storedStone], stock);
  assertStructures(world.structures, world.tick, world.tiles); // Broken roofs retain their terrain, as in V18.
});

test('in-place expansion retains old services and installed matter, reserves land, and charges only the super-linear delta', () => {
  for (const frames of [3, 5]) {
    const state = scene(true, true), { world, person, helper, emit } = state;
    assert.ok(manufacture(world, person));
    const { structure: s, b: original } = buildFunded(state, storage);
    const installed = structuredClone(s.installed), id = s.id, builtAt = s.builtAt;
    assert.ok(installed?.length); s.water = 0.4; s.food = 0.3;
    const water = s.water, food = s.food, quality = facilityRestQuality(world, person), settlementCount = world.settlementCount;
    const target = blueprint(world, person, framed(frames, ['cistern', 'granary']));
    person.materials = { wood: 12, stone: 8 }; helper.x += 100;
    // Visible local surplus admits upgrading, with no global catalogue lookups for builders.
    tileAt(world, { x: person.x - 2, y: person.y })!.wood = target.cost.wood;
    tileAt(world, { x: person.x - 2, y: person.y })!.stone = target.cost.stone;
    assert.deepEqual(constructionOpportunity(world, person)?.target, { x: s.x, y: s.y });
    person.work = 1;
    assert.equal(completeConstruction(world, person, tileAt(world, person)!, emit), s);
    assert.ok(s.site?.expansion); assert.equal(world.structures.length, 1); assert.equal(s.blueprintId, original.id);
    assert.equal(s.footprint, undefined); assert.equal(facilityRestQuality(world, person), quality);
    assert.equal(s.water, water); assert.equal(s.food, food); assert.deepEqual(s.installed, installed);
    const delta = { wood: target.cost.wood - original.cost.wood, stone: target.cost.stone - original.cost.stone, work: target.cost.work - original.cost.work };
    assert.deepEqual([s.site.requiredWood, s.site.requiredStone, s.site.requiredWork], [delta.wood, delta.stone, delta.work]);
    assert.equal(isFootprintFree(world, [{ x: s.x + 1, y: s.y }]), false);
    assertStructures(world.structures, world.tick, world.tiles);
    let totalWood = 12, totalStone = 8;
    for (let i = 0; s.site && i < 20; i++) {
      totalWood += 12 - person.materials.wood; totalStone += 8 - person.materials.stone;
      person.materials = { wood: 12, stone: 8 }; person.work = s.site.requiredWork - s.site.completedWork;
      assert.equal(contributeConstruction(world, person, s, emit), true);
    }
    assert.equal(s.site, undefined); assert.equal(s.id, id); assert.equal(s.builtAt, builtAt);
    assert.equal(world.structures.length, 1); assert.equal(world.settlementCount, settlementCount);
    assert.equal(s.blueprintId, target.id); assert.deepEqual(s.components, target.components); assert.deepEqual(s.installed, installed);
    assert.equal(totalWood - person.materials.wood + original.cost.wood, target.cost.wood);
    assert.equal(totalStone - person.materials.stone + original.cost.stone, target.cost.stone);
    assert.equal(s.water, water); assert.equal(s.food, food);
    for (const cell of structureFootprintCells(s)) assert.equal(tileAt(world, cell)!.terrain, 'shelter');
    person.x++; person.target = { x: person.x, y: person.y }; person.action = 'drink'; person.thirst = 0.5;
    assert.equal(waterAvailable(world, person), water); assert.equal(takeWater(world, person, 0.05), 0.05);
    assert.equal(s.water, water - 0.05); assertStructures(world.structures, world.tick, world.tiles); assertTechnology(world);
  }
});

test('blocked expansion never debits stock, and invalid footprints, warehouse stocks and paid deltas are rejected', () => {
  const state = scene(true), { world, person, emit } = state;
  const { structure: s } = buildFunded(state, framed(1));
  blueprint(world, person, framed(5)); person.work = 100; person.materials = { wood: 12, stone: 8 };
  tileAt(world, { x: s.x + 1, y: s.y + 1 })!.terrain = 'water';
  const before = structuredClone({ structure: s, materials: person.materials, work: person.work });
  assert.equal(completeConstruction(world, person, tileAt(world, person)!, emit), null);
  assert.deepEqual({ structure: s, materials: person.materials, work: person.work }, before);
  tileAt(world, { x: s.x + 1, y: s.y + 1 })!.terrain = 'meadow'; person.work = 1;
  assert.equal(completeConstruction(world, person, tileAt(world, person)!, emit), s);
  const corruptions: Array<(s: StructureView) => void> = [
    s => { s.storedWood = 1; }, s => { s.storedStone = NaN; }, s => { s.storedWood = -1; },
    s => { s.storedStone = 0.5; }, s => { s.site!.requiredWood--; },
    s => { s.site!.expansion!.footprint = { width: 2, height: 1 }; },
  ];
  for (const corrupt of corruptions) {
    const copy = structuredClone(s); corrupt(copy);
    assert.throws(() => assertStructures([copy], world.tick, world.tiles));
  }
  const w = scene(true), { structure: depot } = buildFunded(w, framed(3));
  depot.storedWood = materialCapacity(depot).wood + 1;
  assert.throws(() => assertStructures([depot], w.world.tick, w.world.tiles)); delete depot.storedWood;
  const overlapping = { ...depot, id: 'collision', x: depot.x + 1 };
  assert.throws(() => assertStructures([depot, overlapping], w.world.tick, w.world.tiles));
});

test('installed storage adds real capacity without destroying stored integers when its condition wears out', () => {
  const state = scene(true, true), { world, person } = state;
  assert.ok(manufacture(world, person));
  const { structure: s } = buildFunded(state, framed(3, ['granary'])), enhanced = materialCapacity(s);
  assert.ok(enhanced.wood > 24); assert.ok(enhanced.stone > 16);
  for (let i = 0; i < 20; i++) { person.materials = { wood: 12, stone: 8 }; depositMaterials(world, person, s); }
  assert.equal(s.storedWood, enhanced.wood); assert.equal(s.storedStone, enhanced.stone);
  s.installed![0]!.condition = 0;
  assert.deepEqual(materialCapacity(s), enhanced); assertStructures([s], world.tick, world.tiles);
  assertTechnology(world);
});

test('footprints stay intact inside their archival chunk and footprint reservations replay deterministically', () => {
  for (const seed of [7, 42, 51926]) {
    const a = scene(true, false, seed), b = scene(true, false, seed);
    for (const state of [a, b]) {
      const { world, person, emit } = state;
      const { structure: s } = buildFunded(state, framed(3));
      const components = framed(5), target = blueprint(world, person, components);
      person.work = 1; person.materials = { wood: 12, stone: 8 };
      assert.equal(completeConstruction(world, person, tileAt(world, person)!, emit), s); assert.ok(s.site?.expansion);
      const chunk = Object.values(world.chunks).find(c => c.cx === Math.floor(s.x / 16) && c.cy === Math.floor(s.y / 16))!;
      const tiles = world.tiles.filter(t => Math.floor(t.x / 16) === chunk.cx && Math.floor(t.y / 16) === chunk.cy);
      const archived = { ...chunk, tiles, structures: [structuredClone(s)], animals: undefined, lifeVersion: undefined };
      assertChunkLife(archived, world.tick);
      while (s.site) {
        person.materials = { wood: 12, stone: 8 }; person.work = target.cost.work;
        assert.equal(contributeConstruction(world, person, s, emit), true);
      }
      archived.structures = [structuredClone(s)]; assertChunkLife(archived, world.tick);
    }
    assert.deepEqual(a.world, b.world);
  }
  const boundary = scene(true);
  boundary.person.x = 47; boundary.person.y = 12; // Last column of the anchor's chunk.
  blueprint(boundary.world, boundary.person, framed(5)); boundary.person.work = 30;
  assert.equal(completeConstruction(boundary.world, boundary.person, tileAt(boundary.world, boundary.person)!, boundary.emit), null);
  boundary.person.x = 46;
  assert.ok(completeConstruction(boundary.world, boundary.person, tileAt(boundary.world, boundary.person)!, boundary.emit));
});
