import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import type { Tile } from '../src/shared/types.js';
import { publicGeologyKey, type ChemicalFormulaView, type CompoundLot } from '../src/shared/chemistry.js';
import {
  cloneWorld, closePolicyGpuBatchers,
  createWorld, projectWorld, roadEffortFactor, stepWorld, tileAt, type World,
} from '../src/world/index.js';
import { DEFAULT_PARAMS, parseParams } from '../src/world/params.js';
import { closeEcosystemWorkers, initializeEcosystem, stepEcosystem, stepLocalEcology } from '../src/world/ecosystem.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { projectMirrorTile, projectMirrorWorld } from '../src/server/sim-worker.js';
import { decodeSnapshotTileRows, encodeSnapshotTileRows } from '../src/server/snapshot.js';
import { ResidentTopologyOwner } from '../src/world/soa/topologia.js';
import { residentFastAccess, TileStore } from '../src/world/soa/terreno.js';
import { worldStatistics } from '../src/world/statistics.js';
import { assertWaterExecution, containedWaterQuanta, fillContainedWater } from '../src/world/technology-water.js';
import { researchTechnology } from '../src/world/technology.js';
import { proyectoInvestigacion } from './lib/escenas.js';

after(async () => {
  closePolicyGpuBatchers();
  await closeEcosystemWorkers();
});

function walking(roads = true, traffic = 0, paved?: number, parallel = false) {
  const world = createWorld(42, parseParams({ terreno: { caminosFisicos: roads },
    motor: { particionarPersonas: parallel, hilos: parallel ? 2 : 1 } }));
  world.tick = 5;
  world.reproductionEnabled = false;
  for (const p of world.people) {
    p.action = 'rest'; p.target = { x: p.x, y: p.y }; p.decisionAt = 1_000_000;
    p.hunger = p.thirst = 0.2; p.energy = 0.8; p.fatigue = 0.2;
  }
  const actor = world.people[2]!;
  Object.assign(actor, { x: 16, y: 12, action: 'explore', target: { x: 22, y: 12 },
    command: { order: 'move', x: 22, y: 12 }, materials: { wood: 0, stone: 0 } });
  for (let y = 10; y <= 21; y++) for (let x = 14; x <= 26; x++) {
    const tile = tileAt(world, { x, y })!;
    assert.ok(tile);
    Object.assign(tile, { terrain: 'meadow', biome: 'grassland', traffic, moisture: 0.5, vegetation: 0.4, growth: 0.4 });
    if (paved !== undefined) tile.paved = paved;
  }
  return { world, actor, destination: tileAt(world, { x: 17, y: 12 })! };
}

// V23: the reference digest (shared with v19-phase1-lsfrm) was re-recorded when M2a removed the fauna caps (1aae52f).
test('roads OFF preserves the reference digest and never adds paving/chemistry state or zero totals', () => {
  const world = createWorld(42, parseParams('terreno.caminosFisicos=false'));
  for (let i = 0; i < 60; i++) stepWorld(world);
  const legacy = cloneWorld(world); legacy.version = 12;
  assert.equal(digestoCanonico(legacy), 'ae19695dd28c5585405706dbf7a7c559a07e254ec90a010a498be2254f5edc09');
  assert.ok(world.tiles.every(t => !Object.hasOwn(t, 'paved')));
  assert.ok(world.people.every(p => !Object.hasOwn(p, 'compounds')));
  assert.ok(!Object.hasOwn(world, 'chemistry'));
  assert.ok(!Object.hasOwn(world.totals, 'roadsPaved'));
  const stats = worldStatistics(world);
  for (const key of ['pavedTiles', 'polyominoStructures', 'synergyLinks', 'chemicalFormulas']) assert.ok(!Object.hasOwn(stats, key));
  assert.equal(initializeEcosystem(42, { x: 0, y: 0, terrain: 'meadow', food: 0, moisture: 0.5, vegetation: 0.5 }).paved, undefined);
});

test('road effort is bounded and real stepWorld walking spends less energy and fatigue on trails and paving', () => {
  assert.equal(roadEffortFactor(undefined), 1);
  assert.equal(roadEffortFactor({}), 1);
  assert.equal(roadEffortFactor({ traffic: 1 }), 0.55);
  assert.ok(Math.abs(roadEffortFactor({ traffic: 1, paved: 1 }) - 0.45) < 1e-15);
  assert.equal(roadEffortFactor({ traffic: -9, paved: -3 }), 1);
  assert.ok(Math.abs(roadEffortFactor({ traffic: 100, paved: 100 }) - 0.45) < 1e-15);
  const dirt = walking(), trail = walking(true, 1), stone = walking(true, 1, 1);
  for (const f of [dirt, trail, stone]) { stepWorld(f.world); assert.equal(f.actor.x, 17); assert.equal(f.actor.y, 12); }
  assert.ok(dirt.actor.energy < trail.actor.energy && trail.actor.energy < stone.actor.energy);
  assert.ok(dirt.actor.fatigue > trail.actor.fatigue && trail.actor.fatigue > stone.actor.fatigue);
  assert.ok(Math.abs((trail.actor.energy - dirt.actor.energy) - 0.0008 * 0.45) < 1e-14);
  const offDirt = walking(false), offRoad = walking(false, 1, 1);
  offRoad.actor.materials.stone = 8;
  stepWorld(offDirt.world); stepWorld(offRoad.world);
  assert.equal(offDirt.actor.energy, offRoad.actor.energy);
  assert.equal(offDirt.actor.fatigue, offRoad.actor.fatigue);
  assert.equal(offRoad.actor.materials.stone, 8);
  assert.equal(offRoad.world.totals.roadsPaved, undefined);
});

for (const parallel of [false, true]) test(`local road preference follows equal/near-equal trails, respects 0.15 and water (${parallel ? 'worker route' : 'serial route'})`, () => {
  for (const [dx, dy, expectedY] of [[6, 6, 13], [7, 6, 13], [7, 5, 12]] as const) {
    const f = walking(true, 0, undefined, parallel);
    f.actor.target = { x: 16 + dx, y: 12 + dy }; f.actor.command = { order: 'move', ...f.actor.target };
    const trail = tileAt(f.world, { x: 16, y: 13 })!;
    trail.traffic = 1; trail.paved = 1;
    stepWorld(f.world);
    assert.equal(f.actor.y, expectedY, `target offset ${dx},${dy}`);
    assert.equal(f.actor.x, expectedY === 13 ? 16 : 17);
  }
  const blocked = walking(true, 0, undefined, parallel);
  blocked.actor.target = { x: 22, y: 18 }; blocked.actor.command = { order: 'move', ...blocked.actor.target };
  const water = tileAt(blocked.world, { x: 16, y: 13 })!;
  water.terrain = 'water'; water.traffic = 1; water.paved = 1;
  stepWorld(blocked.world);
  assert.deepEqual({ x: blocked.actor.x, y: blocked.actor.y }, { x: 17, y: 12 });
});

test('stone consolidation consumes one integer stone and pays real work once; thresholds forbid free paving', () => {
  const f = walking(true, 0.72), control = walking(true, 0.72);
  f.actor.materials.stone = 4;
  stepWorld(f.world); stepWorld(control.world);
  assert.equal(f.actor.materials.stone, 3);
  assert.equal(f.destination.paved, 1);
  assert.equal(f.world.totals.roadsPaved, 1);
  assert.ok(Math.abs(control.actor.energy - f.actor.energy - 0.004) < 1e-14);
  assert.ok(Math.abs(f.actor.fatigue - control.actor.fatigue - 0.004) < 1e-14);
  for (const [traffic, stone, energy, terrain, paved] of [
    [0.6, 8, 0.8, 'meadow', undefined], [0.8, 3, 0.8, 'meadow', undefined],
    [0.8, 8, 0.35, 'meadow', undefined], [0.8, 8, 0.8, 'shelter', undefined],
    [0.8, 8, 0.8, 'meadow', 1],
  ] as const) {
    const no = walking(true, traffic, paved);
    no.actor.materials.stone = stone; no.actor.energy = energy; no.destination.terrain = terrain;
    stepWorld(no.world);
    assert.equal(no.actor.materials.stone, stone);
    assert.equal(no.destination.paved, paved);
    assert.equal(no.world.totals.roadsPaved, undefined);
  }
});

const ecoTile = (x: number, overrides: Partial<Tile> = {}): Tile => ({
  x, y: 0, terrain: 'meadow', biome: 'grassland', food: 0.2, moisture: 0.5, vegetation: 0.4,
  growth: 0.4, fertility: 0.5, life: 0.2, traffic: 0.8, ...overrides,
});

for (const parallel of [false, true]) test(`paved traffic decays 10× slower across the ecological tick, abandoned stone weathers (${parallel ? 'SoA workers' : 'objects'})`, () => {
  let tiles = [ecoTile(0), ecoTile(1, { paved: 1 }), ecoTile(2, { traffic: 0.01, paved: 0.5 }), ecoTile(3, { traffic: 0, paved: 0.0012 })];
  if (parallel) { const owner = new ResidentTopologyOwner(); tiles = owner.tiles(tiles.map(t => owner.tile(t))); }
  const options = { hilos: parallel ? 2 : 1, caminosFisicos: true };
  // The moisture/food pass preserves traffic; decay belongs to the following life kernel.
  if (parallel) {
    stepLocalEcology(tiles, 10, 'clear', 'day', DEFAULT_PARAMS.recursos, options);
    assert.equal(tiles[1]!.traffic, 0.8);
    assert.ok(residentFastAccess(tiles));
  }
  stepEcosystem(tiles, 10, 'clear', 'day', false, options);
  assert.equal(tiles[0]!.traffic, 0.8 - 0.0005);
  assert.equal(tiles[1]!.traffic, 0.8 - 0.00005);
  assert.ok(Math.abs((0.8 - tiles[0]!.traffic!) / (0.8 - tiles[1]!.traffic!) - 10) < 1e-10);
  assert.equal(tiles[1]!.paved, 1);
  assert.equal(tiles[2]!.paved, 0.5 - 0.0005);
  assert.ok(!Object.hasOwn(tiles[3]!, 'paved'));
  if (parallel) assert.equal(residentFastAccess(tiles)!.trafficArr[residentFastAccess(tiles)!.cellOf(tiles[1]!)]!, tiles[1]!.traffic);
  const off = [ecoTile(0, { paved: 1 })];
  stepEcosystem(off, 10, 'clear', 'day', false, { hilos: 1, caminosFisicos: false });
  assert.equal(off[0]!.traffic, 0.8 - 0.0005);
});

test('absent/zero paving has 0 ULP ecology parity with roads enabled in object and SoA kernels', () => {
  for (const hilos of [1, 2]) {
    const off = [ecoTile(0), ecoTile(1, { paved: 0 })], on = off.map(t => ({ ...t }));
    for (let tick = 10; tick <= 50; tick += 10) {
      stepEcosystem(off, tick, 'rain', 'day', false, { hilos, caminosFisicos: false });
      stepEcosystem(on, tick, 'rain', 'day', false, { hilos, caminosFisicos: true });
      assert.deepEqual(on, off);
    }
  }
});

test('carrying relief reduces fatigue while every water quantum and v1 energy receipt remains conserved', () => {
  const f = walking();
  f.actor.materials = { wood: 12, stone: 8 };
  f.actor.technology.project = proyectoInvestigacion({ inputs: [{ source: 'raw', material: 'stone', mass: 2000 }],
    steps: [{ op: 'form', intensity: 4, shape: 'hollow' }, { op: 'compress', intensity: 2 }] }, f.world.tick);
  for (let n = 0; f.actor.technology.project && n < 250; n++) { f.world.tick++; researchTechnology(f.world, f.actor); }
  assert.equal(f.actor.technology.project, null);
  const item = f.actor.technology.items.at(-1)!;
  tileAt(f.world, f.actor)!.drinkingWater = 0.8;
  f.world.tick++;
  assert.ok(fillContainedWater(f.world, f.actor, item.id) > 0);
  const tick = Math.ceil((f.world.tick + 1) / 30) * 30 + 5;
  f.world.tick = tick;
  f.actor.energy = 0.8; f.actor.fatigue = 0.2; f.actor.materials = { wood: 0, stone: 0 };
  const dirt = cloneWorld(f.world), road = cloneWorld(f.world);
  tileAt(road, f.actor)!.traffic = 1; tileAt(road, f.actor)!.paved = 1;
  stepWorld(dirt); stepWorld(road);
  const a = dirt.people[2]!, b = road.people[2]!;
  assert.equal(a.x, 17); assert.equal(b.x, 17);
  assert.equal(a.energy, b.energy, 'same destination and unchanged conserved carry energy');
  assert.ok(b.fatigue < a.fatigue, 'the road under the carrier relieves the payload fatigue');
  assert.equal(containedWaterQuanta(a), containedWaterQuanta(b));
  assert.deepEqual(dirt.technology.water, road.technology.water);
  for (const w of [dirt, road]) {
    const ledger = w.technology.water!;
    assert.equal(ledger.filled, w.people.reduce((sum, p) => sum + containedWaterQuanta(p), 0) + ledger.consumed + ledger.environmentalLoss);
    const carries = w.technology.history.filter(e => e.water?.action === 'carry');
    assert.equal(carries.length, 1);
    for (const receipt of w.technology.history) assertWaterExecution(receipt);
  }
});

const composition = { C: 0, Si: 10, Ca: 0, Fe: 0, S: 0, H: 0 };
const properties = { hardness: 0.6, toughness: 0.4, seal: 0.3, insulation: 0.2, fuelPower: 0, colorHex: '#999999' };
const formula: ChemicalFormulaView = { id: 'f1', signature: 'Si:ground', name: 'Mineral', composition,
  properties, phase: 'ground', temperatureTier: 0, operator: 'grind', discoveredAt: 1, discovererId: null, uses: 2 };
const lot: CompoundLot = { id: 'lot1', formulaId: 'f1', composition, properties, phase: 'ground', mass: 10 };

for (const soa of [false, true]) test(`world/mirror projection, V20 statistics and snapshot paving round-trip (${soa ? 'resident SoA' : 'objects'})`, () => {
  const world = createWorld(42);
  const [a, b, c] = world.tiles;
  a!.paved = 0.87654; b!.paved = 0; c!.paved = 0.49;
  world.people[2]!.compounds = [structuredClone(lot)];
  world.chemistry = { formulas: [structuredClone(formula)], privateLedger: 'must not cross the wire' } as unknown as typeof world.chemistry;
  const structure = { ...world.structures[0]!, cells: [{ x: 1, y: 1 }, { x: 2, y: 1 }],
    synergy: { sharedEdges: 2, heated: true, irrigated: true, workshopBonus: 0.25 } };
  assert.ok(structure.id);
  world.structures.push(structure, { ...structure, id: 'footprint', cells: undefined, footprint: { width: 2, height: 2 }, synergy: undefined });
  let store: TileStore | undefined;
  if (soa) {
    const owner = new ResidentTopologyOwner(); store = new TileStore();
    world.tiles = owner.tiles(world.tiles.map(t => owner.tile({ ...t })));
    store.prepareParallel(world.tiles);
  }
  try {
    const fast = residentFastAccess(world.tiles);
    for (const t of world.tiles.slice(0, 4)) {
      const mirrored = projectMirrorTile(t, fast);
      assert.equal(mirrored.paved, t.paved ? Math.round(t.paved * 1000) / 1000 : undefined);
      if (!t.paved) assert.ok(!Object.hasOwn(mirrored, 'paved'));
    }
    const view = projectWorld(world), mirror = projectMirrorWorld(world);
    for (const v of [view, mirror]) {
      assert.equal(v.geologyKey, publicGeologyKey(world.seed));
      assert.ok(!('seed' in v));
      assert.equal(v.stats!.pavedTiles, 1);
      assert.equal(v.stats!.polyominoStructures, 2);
      assert.equal(v.stats!.synergyLinks, 5);
      assert.equal(v.stats!.chemicalFormulas, 1);
      const person = v.people.find(p => p.id === world.people[2]!.id)!;
      assert.deepEqual(person.compounds, [lot]);
      assert.notEqual(person.compounds![0]!.composition, world.people[2]!.compounds![0]!.composition);
      assert.notEqual(person.compounds![0]!.properties, world.people[2]!.compounds![0]!.properties);
      assert.ok(!Object.hasOwn(v.chemistry!, 'privateLedger'));
      assert.equal(v.chemistry!.totalLots, 1);
      assert.equal(v.chemistry!.totalFormulas, 1);
      assert.deepEqual(v.chemistry!.byOperator, { grind: 1, wash: 0, heat: 0, bind: 0 });
      v.chemistry!.formulas[0]!.composition.Si = 999;
      assert.equal((world.chemistry as { formulas: ChemicalFormulaView[] }).formulas[0]!.composition.Si, 10);
    }
    for (const t of view.tiles) if (t.x === a!.x && t.y === a!.y) assert.equal(t.paved, 0.877);
    const rows = JSON.parse(JSON.stringify(encodeSnapshotTileRows(world.tiles.slice(0, 4)))) as unknown[];
    const restored = decodeSnapshotTileRows(rows);
    assert.deepEqual(restored.map(t => t.paved), [0.87654, 0, 0.49, undefined]);
    assert.ok(!Object.hasOwn(restored[3]!, 'paved'));
  } finally { store?.releaseParallelObjects(); }
});
