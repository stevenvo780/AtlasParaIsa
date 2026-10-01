import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneWorld, createWorld, puntoDeRestauracion, stepWorld, tileAt, type World } from '../src/world/index.js';
import type { StructureView } from '../src/shared/life.js';
import { createMaterialObserver, type MaterialObserver } from '../src/world/material-observer.js';
import { completeConstruction, defaultBlueprint, facilityRestQuality, recordFacilityRest, repair,
  REST_ENERGY_RATE, REST_FATIGUE_RATE, stepStructures, takeFood, takeWater } from '../src/world/inventions.js';
import { activate, maintainRegions } from '../src/world/spatial.js';
import { chunkKey, generateChunk } from '../src/world/terrain.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { recordChronicleEvent } from '../src/world/chronicle-journal.js';
import { decodeSnapshot, encodeSnapshot, takeSnapshotParams } from '../src/server/snapshot.js';
import { setParams } from '../src/world/params.js';
import { Store } from '../src/server/store.js';
import { todasLasTablas } from './lib/store.js';

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const emitFor = (world: World) => (event: Parameters<typeof recordChronicleEvent>[1]) => {
  const result = recordChronicleEvent(world, event); world.events.push(result); return result;
};
function scene(condition = 1) {
  const world = createWorld(51926), person = world.people[2]!, protectedPerson = world.people[0]!;
  world.people = [person, protectedPerson]; world.structures = []; world.places = []; world.animals = []; world.learningEnabled = false;
  const point = { x: 36, y: 12 }, tile = tileAt(world, point)!;
  tile.terrain = 'shelter'; tile.drinkingWater = 0;
  for (const p of world.people) {
    p.x = point.x; p.y = point.y; p.target = { ...point }; p.hunger = p.thirst = p.fatigue = 0.5;
    p.energy = 0.5; p.inventory = 0; p.materials = { wood: 12, stone: 8 }; p.work = 300;
  }
  const structure: StructureView = { id: 'structure-1', ...point, blueprintId: 'blueprint-base', name: 'Fixture',
    components: ['frame', 'roof', 'cistern', 'granary'], condition, water: 0.4, food: 0.4, uses: 0, builtAt: 0, builderId: null };
  world.structures.push(structure); world.structureCounter = 1;
  return { world, person, protectedPerson, structure, tile, emit: emitFor(world) };
}
function row(observer: MaterialObserver, id = 'structure-1') {
  const result = observer.exportRows().structures.find(s => s.id === id); assert.ok(result); return result;
}
function daily(observer: MaterialObserver, day = 1) {
  const result = observer.exportRows().daily.find(s => s.structureId === 'structure-1' && s.day === day); assert.ok(result); return result;
}
function frozen<T>(value: T, seen = new Set<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value); for (const child of Object.values(value)) frozen(child, seen); Object.freeze(value);
  }
  return value;
}

test('food and cistern utility retain kind, actual amount, distinct users and protected status; transfers alone earn no use', () => {
  const { world, person, protectedPerson, structure, tile } = scene(), observer = createMaterialObserver(); observer.ingest(world);
  person.action = 'eat'; close(takeFood(world, person, 0.03), 0.03);
  protectedPerson.action = 'eat'; close(takeFood(world, protectedPerson, 0.02), 0.02);
  person.action = 'explore'; close(takeFood(world, person, 0.01), 0.01);
  close(takeFood(world, { x: person.x, y: person.y }, 0.01), 0.01);
  person.action = 'drink'; close(takeWater(world, person, 0.02), 0.02);
  tile.drinkingWater = 0.02; close(takeWater(world, person, 0.01), 0.01); // Ambient supply is not a cistern use.
  person.thirst = 0; close(takeWater(world, person, 0.01), 0);
  observer.ingest(world);
  const result = daily(observer);
  assert.deepEqual(result.uses, { food: 2, water: 1, rest: 0 });
  assert.deepEqual(result.useCountsByClass, { mortal: 2, protected: 1, unknown: 0 });
  assert.deepEqual(result.usersByClass, { mortal: [person.id], protected: [protectedPerson.id], unknown: [] });
  close(result.amountByKind.food, 0.05); close(result.amountByKind.water, 0.02);
  close(result.stockFoodFinal, structure.food); close(result.stockWaterFinal, structure.water);
  assert.equal(result.uses.food + result.uses.water, structure.uses);
});

test('rest is observed only for body recovery above the outdoor counterfactual, including saturation and degraded roofs', () => {
  const { world, person, structure, emit } = scene(0.4), observer = createMaterialObserver(); observer.ingest(world);
  person.action = 'rest';
  const recover = () => {
    const before = { fatigue: person.fatigue, energy: person.energy }, quality = facilityRestQuality(world, person);
    person.fatigue = Math.max(0, before.fatigue - REST_FATIGUE_RATE * quality);
    person.energy = Math.min(1, before.energy + REST_ENERGY_RATE * quality);
    recordFacilityRest(world, person, before);
  };
  recover(); // This worn roof cannot outperform outdoors.
  assert.ok(repair(world, person, structure, emit));
  recover();
  person.fatigue = 0; person.energy = 1; recover();
  observer.ingest(world);
  assert.equal(daily(observer).uses.rest, 1);
  assert.ok(daily(observer).benefitByKind.rest > 0);
  assert.equal(structure.uses, 1);
});

test('wear crossing the broken threshold survives a repair in the same tick, with actual maintenance debits', () => {
  const { world, person, structure, emit } = scene(0.1001), observer = createMaterialObserver(); observer.ingest(world);
  const wood = person.materials.wood, work = person.work; world.tick = 10;
  stepStructures(world, emit); const minimum = structure.condition;
  assert.ok(minimum <= 0.1); assert.ok(repair(world, person, structure, emit));
  observer.ingest(world);
  const result = row(observer), day = daily(observer);
  assert.equal(result.brokenCrossings, 1); assert.equal(result.conditionZeroObserved, false);
  assert.equal(result.brokenObserved, true); assert.equal(result.explicitRuinInModel, false);
  close(result.conditionMinimum, minimum); close(result.conditionFinal, structure.condition);
  assert.equal(result.wearEvaluations, 1); assert.equal(result.repairCount, 1);
  assert.equal(result.repairWoodPaid, wood - person.materials.wood);
  assert.equal(result.repairWorkPaid, work - person.work);
  assert.equal(day.brokenCrossings, 1); close(day.conditionMinimum, minimum); assert.equal(day.repairWoodPaid, 1);
  assert.equal(repair(world, person, { ...structure }, emit), false);
  observer.ingest(world); assert.equal(row(observer).repairCount, 1);
});

test('zero is a distinct observed state and is retained even when repaired before confirmation', () => {
  const { world, person, structure, emit } = scene(0.0001), observer = createMaterialObserver(); observer.ingest(world);
  world.tick = 10; world.weather = 'rain'; stepStructures(world, emit); assert.equal(structure.condition, 0);
  assert.ok(repair(world, person, structure, emit)); observer.ingest(world);
  const result = row(observer);
  assert.equal(result.conditionZeroObserved, true); assert.equal(result.zeroCrossings, 1);
  assert.equal(result.conditionMinimum, 0); assert.equal(result.explicitRuinInModel, false);
  close(result.conditionFinal, 0.4); close(result.stockFoodFinal, 0.4); close(result.stockWaterFinal, 0.4);
});

test('active intervals close on retirement and reopen on activation; dormant time is neither wear nor active exposure', () => {
  const { world, person, structure, emit } = scene(), observer = createMaterialObserver(); observer.ingest(world);
  world.tick = 10; stepStructures(world, emit); observer.ingest(world);
  world.people = []; world.tick = 20; maintainRegions(world); observer.ingest(world);
  assert.equal(world.structures.length, 0); assert.equal(daily(observer).retirementCount, 1);
  world.tick = 90; observer.ingest(world); assert.equal(row(observer).activeExposureTicks, 20);
  const frozenCondition = row(observer).conditionFinal;
  activate(world, structure.x, structure.y); observer.ingest(world);
  close(world.structures[0]!.condition, frozenCondition); assert.equal(daily(observer).activationCount, 1);
  world.people = [person]; world.tick = 100; stepStructures(world, emit); observer.ingest(world);
  assert.equal(row(observer).activeExposureTicks, 30); assert.equal(row(observer).wearEvaluations, 2);
});

test('activation during stepWorld at 2400 earns a real wear evaluation but zero elapsed residence at that mark', () => {
  const { world, person } = scene(); world.people = []; maintainRegions(world);
  world.tick = 2399; world.reproductionEnabled = false;
  const observer = createMaterialObserver(); observer.ingest(world);
  world.people = [person]; person.action = 'rest'; person.decisionAt = 2402;
  stepWorld(world); observer.ingest(world);
  assert.equal(world.tick, 2400); assert.equal(daily(observer).activationCount, 1);
  assert.equal(row(observer).wearEvaluations, 1); assert.equal(row(observer).activeExposureTicks, 0);
  assert.equal(daily(observer).exposureTicks, 0);
  stepWorld(world); observer.ingest(world);
  assert.equal(world.tick, 2401); assert.equal(daily(observer, 2).exposureTicks, 1);
  world.people = []; maintainRegions(world); observer.ingest(world);
  assert.equal(daily(observer, 2).retirementCount, 1); assert.equal(row(observer).activeExposureTicks, 1);
  activate(world, person.x, person.y); maintainRegions(world); observer.ingest(world);
  assert.equal(row(observer).activeExposureTicks, 1, 'activation and retirement at the same clock mark add zero elapsed residence');
});

test('a known archived legacy structure is left censored, with a nominal cost bound but no invented original payment', () => {
  const { world, structure } = scene(), archived = generateChunk(world.seed, 9, 9);
  const archivedStructure = { ...structure, id: 'structure-legacy-144-144', x: 144, y: 144, components: ['frame', 'roof'] as StructureView['components'], builtAt: -100 };
  archived.structures = [archivedStructure]; world.retiredChunks.push(archived);
  const observer = createMaterialObserver(); observer.ingest(world);
  const result = row(observer, archivedStructure.id);
  assert.equal(result.historyCoverage, 'left-censored'); assert.equal(result.constructionSeen, false);
  assert.equal(result.salvagePotential.originalPaidCost, null);
  assert.equal(result.salvagePotential.wood, defaultBlueprint().cost.wood);
  assert.equal(result.salvagePotential.stone, defaultBlueprint().cost.stone);
  assert.equal(result.salvagePotential.recoveryImplemented, false); assert.equal(result.activeExposureTicks, 0);
  assert.equal(observer.exportRows().coverage.unseenArchivedStructures, 'unknown');
  assert.equal(observer.exportRows().coverage.attachments[0]!.pendingDormantStructures, 1);
  assert.equal(archivedStructure.condition, 1);
});

test('only a witnessed completed build establishes full history and original paid cost; unknown components are not zero', () => {
  const { world, person, tile } = scene(); world.structures = []; world.structureCounter = 0; tile.terrain = 'meadow';
  const observer = createMaterialObserver(); observer.ingest(world);
  const before = { ...person.materials, work: person.work };
  const structure = completeConstruction(world, person, tile, emitFor(world)); assert.ok(structure); observer.ingest(world);
  const result = row(observer, structure.id);
  assert.equal(result.historyCoverage, 'full-since-built'); assert.equal(result.constructionSeen, true);
  assert.deepEqual(result.salvagePotential.originalPaidCost, { wood: before.wood - person.materials.wood,
    stone: before.stone - person.materials.stone, work: before.work - person.work });
  const foreign = scene().world; foreign.structures[0]!.components = ['unrecognized-material'] as never;
  const unknown = createMaterialObserver(); unknown.ingest(foreign);
  assert.equal(row(unknown).salvagePotential.wood, null); assert.equal(row(unknown).salvagePotential.stone, null);
});

test('candidate logs are isolated: discard cannot leak usage, repairs, activation or retirement into the chosen branch', () => {
  const { world } = scene(), observer = createMaterialObserver(); observer.ingest(world);
  const abandoned = cloneWorld(world), chosen = cloneWorld(world);
  abandoned.tick = 10; const person = abandoned.people[0]!; person.action = 'eat';
  takeFood(abandoned, person, 0.02); stepStructures(abandoned, emitFor(abandoned)); repair(abandoned, person, abandoned.structures[0]!, emitFor(abandoned));
  abandoned.people = []; maintainRegions(abandoned); observer.discard(abandoned);
  assert.throws(() => observer.ingest(abandoned), /discarded/);
  chosen.tick = 10; stepStructures(chosen, emitFor(chosen)); observer.ingest(chosen);
  assert.equal(daily(observer).uses.food, 0); assert.equal(row(observer).repairCount, 0);
  assert.equal(daily(observer).retirementCount, 0); assert.equal(row(observer).wearEvaluations, 1);
  assert.equal(row(observer).activeExposureTicks, 10);
  const stale = cloneWorld(chosen), accepted = cloneWorld(chosen); accepted.tick = 20; observer.ingest(accepted);
  stale.tick = 20; assert.throws(() => observer.ingest(stale), /diverged/);
});

test('an unconfirmed chain of clones commits only its own immutable event path, even if the source changes later', () => {
  const { world } = scene(), observer = createMaterialObserver(); observer.ingest(world);
  world.people[0]!.action = 'eat'; takeFood(world, world.people[0]!, 0.01);
  const candidate = cloneWorld(world); candidate.tick = 1;
  takeFood(world, world.people[0]!, 0.02); // This event belongs to a different branch after the clone.
  takeFood(candidate, candidate.people[0]!, 0.03);
  const child = cloneWorld(candidate); child.tick = 2; takeFood(child, child.people[0]!, 0.04);
  observer.ingest(child); assert.equal(daily(observer).uses.food, 3); close(daily(observer).amountByKind.food, 0.08);
  close(daily(observer).stockFoodFinal, child.structures[0]!.food);
});

test('the existing in-place rollback point also discards observations of a failed step without losing earlier unconfirmed events', () => {
  const { world, person } = scene(0.6), observer = createMaterialObserver(); observer.ingest(world);
  person.action = 'eat'; takeFood(world, person, 0.01);
  const json = JSON.stringify(world), digest = digestoCanonico(world), point = puntoDeRestauracion(world);
  world.tick = 10; takeFood(world, person, 0.02); stepStructures(world, emitFor(world));
  assert.ok(repair(world, person, world.structures[0]!, emitFor(world)));
  point.restaurar(); assert.equal(JSON.stringify(world), json); assert.equal(digestoCanonico(world), digest);
  observer.ingest(world); assert.equal(daily(observer).uses.food, 1); close(daily(observer).amountByKind.food, 0.01);
  assert.equal(row(observer).wearEvaluations, 0); assert.equal(row(observer).repairCount, 0);
  const forbidden = puntoDeRestauracion(world); world.tick++; observer.ingest(world);
  assert.throws(() => forbidden.restaurar(), /already confirmed/);
});

test('day one is (0,2400], tick 2401 belongs to day two, and a 1200 tick window is explicitly partial', () => {
  const { world, person } = scene(), observer = createMaterialObserver(); observer.ingest(world);
  world.tick = 1200; observer.ingest(world);
  assert.equal(daily(observer).partial, true); assert.equal(daily(observer).exposureTicks, 1200);
  world.tick = 2400; person.action = 'eat'; takeFood(world, person, 0.01); observer.ingest(world);
  assert.equal(daily(observer).uses.food, 1); assert.equal(daily(observer).partial, false); assert.equal(daily(observer).exposureTicks, 2400);
  world.tick = 2401; takeFood(world, person, 0.02); observer.ingest(world);
  assert.equal(daily(observer).uses.food, 1); assert.equal(daily(observer, 2).uses.food, 1);
  assert.equal(daily(observer, 2).exposureTicks, 1); assert.equal(daily(observer, 2).partial, true);
});

test('attaching and exporting a frozen world is read only, independent and does not change JSON, digest or RNG', () => {
  const { world } = scene(), json = JSON.stringify(world), rng = world.rng, digest = digestoCanonico(world);
  frozen(world); const observer = createMaterialObserver(); observer.ingest(world);
  const first = observer.exportRows(), second = observer.exportRows(); assert.deepEqual(first, second);
  first.structures[0]!.components.length = 0; first.daily[0]!.usersByClass.mortal.push('external-mutation');
  first.coverage.attachments.length = 0;
  assert.deepEqual(observer.exportRows(), second); assert.equal(JSON.stringify(world), json);
  assert.equal(digestoCanonico(world), digest); assert.equal(world.rng, rng);
});

test('instrumented and uninstrumented engines have identical state, RNG and snapshots through ordinary ticks and clones', () => {
  let plain = createWorld(900921), instrumented = createWorld(900921); const observer = createMaterialObserver(); observer.ingest(instrumented);
  for (let tick = 1; tick <= 120; tick++) {
    if (tick % 20 === 0) { plain = cloneWorld(plain); instrumented = cloneWorld(instrumented); }
    stepWorld(plain); stepWorld(instrumented); observer.ingest(instrumented);
    if (tick % 30 === 0) { assert.equal(instrumented.rng, plain.rng); assert.equal(digestoCanonico(instrumented), digestoCanonico(plain)); }
  }
  assert.equal(encodeSnapshot(instrumented), encodeSnapshot(plain));
});

test('snapshot loading starts a declared attachment; missing observation time is a gap, not invented exposure', () => {
  const { world } = scene(), observer = createMaterialObserver(); observer.ingest(world);
  world.tick = 20; observer.ingest(world);
  const restored = decodeSnapshot(encodeSnapshot(world)) as World; setParams(restored, takeSnapshotParams(restored));
  restored.tick = 80; observer.ingest(restored); restored.tick = 100; observer.ingest(restored);
  assert.equal(observer.exportRows().coverage.attachments[1]!.reason, 'loaded-world');
  assert.deepEqual(observer.exportRows().coverage.observationGaps, [{ fromTick: 20, toTick: 80 }]);
  assert.equal(row(observer).activeExposureTicks, 40); assert.equal(daily(observer).hasObservationGap, true);
  assert.equal(daily(observer).observedTicks, 40);
});

test('Store can clear pending dormant chunks without erasing confirmed measurements; load sees an honest unknown archive scope', () => {
  const world = createWorld(901030), chunk = generateChunk(world.seed, 9, 9);
  const tile = chunk.tiles.find(t => t.terrain !== 'water')!; tile.terrain = 'shelter';
  chunk.structures = [{ id: `structure-legacy-${tile.x}-${tile.y}`, x: tile.x, y: tile.y, blueprintId: 'blueprint-base',
    name: 'Refugio', components: ['frame', 'roof'], condition: 0, food: 0, water: 0, uses: 0, builtAt: 0, builderId: null }];
  world.retiredChunks.push(chunk); const observer = createMaterialObserver(); observer.ingest(world);
  const store = new Store(':memory:');
  try {
    store.save(world); assert.equal(world.retiredChunks.length, 0);
    const before = todasLasTablas(store), json = JSON.stringify(world); observer.ingest(world); observer.exportRows();
    assert.deepEqual(todasLasTablas(store), before); assert.equal(JSON.stringify(world), json);
    assert.equal(row(observer, chunk.structures[0]!.id).conditionZeroObserved, true);
    const loaded = store.load()!.world, fresh = createMaterialObserver(); fresh.ingest(loaded);
    assert.equal(fresh.exportRows().coverage.unseenArchivedStructures, 'unknown');
    assert.equal(fresh.exportRows().structures.some(s => s.id === chunk.structures![0]!.id), false);
    observer.ingest(loaded); assert.equal(row(observer, chunk.structures[0]!.id).activeExposureTicks, 0);
    activate(loaded, tile.x, tile.y, store.context); fresh.ingest(loaded);
    assert.equal(row(fresh, chunk.structures[0]!.id).historyCoverage, 'left-censored');
    assert.equal(row(fresh, chunk.structures[0]!.id).constructionSeen, false);
    assert.equal(chunkKey(tile.x, tile.y), chunk.key);
  } finally { store.close(); }
});
