import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPhysicalOperation, MASS_UNIT, rawMaterial } from '../src/world/technology.js';
import type { MaterialBatch, MaterialShape } from '../src/shared/technology.js';
import { assertWaterContents, capacityOverflowReturns, carriedMassQuanta, containerAffordance, DEFAULT_WATER_POLICY,
  flowQuantized, leakIntegerRemainder, MAX_WATER_STEP_TICKS, WATER_QUANTA_PER_UNIT,
  type WaterContents, type WaterFlowState, type WaterInteractionPolicy } from '../src/world/material-affordances.js';

function formed(shape: MaterialShape = 'hollow'): MaterialBatch {
  const result = applyPhysicalOperation({ op: 'form', shape, intensity: 4 }, [rawMaterial('stone')]);
  assert.equal(result.success, true); assert.ok(result.product);
  return result.product;
}
function flow(overrides: Partial<WaterFlowState> = {}): WaterFlowState {
  return { sourceWater: 1000, destinationWater: 10, destinationCapacity: 1000, requestedQuanta: 600,
    carryFreeQuanta: 1000, elapsedTicks: 4, workAvailable: 4, ...overrides };
}
const policy = (overrides: Partial<WaterInteractionPolicy>): WaterInteractionPolicy => ({ ...DEFAULT_WATER_POLICY, ...overrides });
const sum = (...stocks: number[]): bigint => stocks.reduce((total, stock) => total + BigInt(stock), 0n);

test('existing hollow transformation enables containment; equal-mass rods and sheets cannot carry water', () => {
  const hollow = formed(), rod = formed('rod'), sheet = formed('sheet');
  assert.equal(hollow.mass, rod.mass); assert.equal(hollow.mass, sheet.mass);
  assert.ok(containerAffordance(hollow).capacityQuanta > 0);
  assert.equal(containerAffordance(rod).capacityQuanta, 0);
  assert.equal(containerAffordance(sheet).capacityQuanta, 0);
  const renamed = structuredClone(hollow);
  renamed.id = 'an-unrelated-identity'; renamed.recipeId = 'another-recipe'; renamed.generation = 200; renamed.parentItems = [];
  assert.deepEqual(containerAffordance(renamed), containerAffordance(hollow));
  const namedOnly = structuredClone(rod); namedOnly.id = 'perfect-water-container'; namedOnly.recipeId = 'water-vessel';
  assert.equal(containerAffordance(namedOnly).capacityQuanta, 0);
});

test('porosity and cohesion independently change retention; compression changes actual affordance', () => {
  const original = formed(), initial = containerAffordance(original);
  const porous = structuredClone(original); porous.properties.porosity = 0.8;
  assert.ok(containerAffordance(porous).capacityQuanta < initial.capacityQuanta);
  assert.ok(containerAffordance(porous).leakageNumerator > initial.leakageNumerator);
  const loose = structuredClone(original); loose.properties.cohesion = 0.2;
  assert.ok(containerAffordance(loose).capacityQuanta < initial.capacityQuanta);
  assert.ok(containerAffordance(loose).leakageNumerator > initial.leakageNumerator);
  const retained = (batch: MaterialBatch) => leakIntegerRemainder({ water: 1000, leakRemainder: 0 },
    containerAffordance(batch).leakageNumerator, DEFAULT_WATER_POLICY.fixedPointDenominator, 100).contents.water;
  assert.ok(retained(porous) < retained(original)); assert.ok(retained(loose) < retained(original));
  const compressed = applyPhysicalOperation({ op: 'compress', intensity: 4 }, [original]).product!;
  assert.equal(compressed.mass, original.mass);
  assert.ok(containerAffordance(compressed).capacityQuanta > initial.capacityQuanta);
  assert.ok(containerAffordance(compressed).leakageNumerator < initial.leakageNumerator);
  for (const key of ['containment', 'cohesion'] as const) {
    const removed = structuredClone(original); removed.properties[key] = 0;
    assert.equal(containerAffordance(removed).capacityQuanta, 0);
  }
  const allPores = structuredClone(original); allPores.properties.porosity = 1;
  assert.equal(containerAffordance(allPores).capacityQuanta, 0);
});

test('capacity scales with solid mass and wear also increases leakage', () => {
  const original = formed(), initial = containerAffordance(original);
  const larger = structuredClone(original);
  larger.mass *= 3; larger.initialMass *= 3; larger.composition.stone *= 3;
  const large = containerAffordance(larger);
  assert.ok(large.capacityQuanta >= initial.capacityQuanta * 3 && large.capacityQuanta < (initial.capacityQuanta + 1) * 3);
  assert.equal(large.leakageNumerator, initial.leakageNumerator);
  const worn = structuredClone(original); worn.mass /= 2; worn.composition.stone /= 2;
  const damaged = containerAffordance(worn);
  assert.ok(damaged.capacityQuanta < initial.capacityQuanta);
  assert.ok(damaged.leakageNumerator > initial.leakageNumerator);
  worn.mass = 0; worn.composition.stone = 0;
  assert.equal(containerAffordance(worn).capacityQuanta, 0);
});

test('structural water does not become free contents and fluid alone cannot acquire a vessel capacity', () => {
  const original = formed(), wet = structuredClone(original);
  wet.composition.stone -= 100; wet.composition.water += 100;
  assert.equal(wet.mass, original.mass);
  assert.ok(containerAffordance(wet).capacityQuanta < containerAffordance(original).capacityQuanta);
  const water = rawMaterial('water'); water.properties = { ...original.properties };
  assert.equal(containerAffordance(water).capacityQuanta, 0);
  assert.equal(carriedMassQuanta(wet, { water: 350, leakRemainder: 0 }), wet.mass + 350);
  assert.equal(wet.composition.water, 100);
  assert.equal(WATER_QUANTA_PER_UNIT, MASS_UNIT * 50);
  assert.notEqual(WATER_QUANTA_PER_UNIT, MASS_UNIT);
});

test('each flow bottleneck independently limits a conservative transfer with whole work debit', () => {
  const cases: [Partial<WaterFlowState>, number][] = [
    [{}, 600], [{ sourceWater: 137 }, 137], [{ destinationCapacity: 125 }, 115],
    [{ carryFreeQuanta: 71 }, 71], [{ elapsedTicks: 1 }, 250], [{ workAvailable: 1 }, 250],
  ];
  for (const [override, moved] of cases) {
    const before = flow(override), copy = structuredClone(before), after = flowQuantized(before);
    assert.equal(after.movedQuanta, moved);
    assert.equal(after.sourceDelta, -moved); assert.equal(after.destinationDelta, moved);
    assert.equal(sum(before.sourceWater, before.destinationWater), sum(after.sourceWater, after.destinationWater));
    assert.equal(after.workSpent, Math.ceil(moved / DEFAULT_WATER_POLICY.quantaPerWork));
    assert.equal(after.workRemaining + after.workSpent, before.workAvailable);
    assert.ok(after.workSpent > 0); assert.deepEqual(before, copy);
    assert.equal(Object.hasOwn(after, 'utility'), false); assert.equal(Object.hasOwn(after, 'energy'), false);
  }
});

test('zero requests, empty sources, no carry room, full targets, no time and no work are exact no-ops', () => {
  for (const override of [{ requestedQuanta: 0 }, { sourceWater: 0 }, { carryFreeQuanta: 0 },
    { destinationWater: 1000 }, { elapsedTicks: 0 }, { workAvailable: 0 }]) {
    const before = flow(override), after = flowQuantized(before);
    assert.deepEqual(after, { sourceWater: before.sourceWater, destinationWater: before.destinationWater,
      movedQuanta: 0, sourceDelta: 0, destinationDelta: 0, workSpent: 0, workRemaining: before.workAvailable });
  }
  assert.equal(flowQuantized(flow(), policy({ flowQuantaPerTick: 0 })).movedQuanta, 0);
});

test('reusing returned budgets cannot produce additional water after work or source is exhausted', () => {
  let state = flow({ destinationWater: 0, destinationCapacity: 2000, requestedQuanta: 1000, workAvailable: 2 });
  const first = flowQuantized(state); assert.equal(first.movedQuanta, 500); assert.equal(first.workRemaining, 0);
  state = { ...state, sourceWater: first.sourceWater, destinationWater: first.destinationWater, workAvailable: first.workRemaining };
  assert.equal(flowQuantized(state).movedQuanta, 0);
  const tiny = flowQuantized(flow({ requestedQuanta: 1 })); assert.equal(tiny.workSpent, 1);
});

test('fractional leakage eventually loses a single quantum and emptying clears its remainder', () => {
  let contents: WaterContents = { water: 1, leakRemainder: 0 }, exported = 0;
  for (let tick = 1; tick <= 1000; tick++) {
    const next = leakIntegerRemainder(contents, 1, 1000);
    contents = next.contents; exported += next.leakedQuanta;
    assert.equal(contents.water + exported, 1);
    if (tick < 1000) { assert.equal(contents.water, 1); assert.equal(contents.leakRemainder, tick); }
  }
  assert.deepEqual(contents, { water: 0, leakRemainder: 0 }); assert.equal(exported, 1);
});

test('leak subdivision, zero coefficient and zero-time controls preserve state exactly', () => {
  const start = { water: 1000, leakRemainder: 999 }, whole = leakIntegerRemainder(start, 71, 1000, 37);
  const a = leakIntegerRemainder(start, 71, 1000, 9), b = leakIntegerRemainder(a.contents, 71, 1000, 28);
  assert.deepEqual(whole.contents, b.contents); assert.equal(whole.leakedQuanta, a.leakedQuanta + b.leakedQuanta);
  assert.deepEqual(leakIntegerRemainder(start, 0, 1000, 37), { contents: start, leakedQuanta: 0 });
  assert.deepEqual(leakIntegerRemainder(start, 1000, 1000, 0), { contents: start, leakedQuanta: 0 });
  assert.deepEqual(leakIntegerRemainder(start, 1000, 1000), { contents: { water: 0, leakRemainder: 0 }, leakedQuanta: 1000 });
});

test('overflow and complete destruction account for every quantum, including a saturated local sink', () => {
  const contents = { water: 1000, leakRemainder: 321 };
  const result = capacityOverflowReturns(contents, 300, 600, 1000);
  assert.deepEqual(result, { contents: { water: 300, leakRemainder: 321 }, sinkWater: 1000,
    returnedQuanta: 400, environmentalLossQuanta: 300, containerDelta: -700, sinkDelta: 400 });
  assert.equal(sum(contents.water, 600), sum(result.contents.water, result.sinkWater, result.environmentalLossQuanta));
  const broken = capacityOverflowReturns(contents, 0, 1000, 1000);
  assert.equal(broken.environmentalLossQuanta, 1000); assert.equal(broken.returnedQuanta, 0);
  assert.deepEqual(broken.contents, { water: 0, leakRemainder: 0 });
  const unchanged = capacityOverflowReturns(contents, 2000, 0, 0);
  assert.deepEqual(unchanged.contents, contents); assert.equal(unchanged.environmentalLossQuanta, 0);
});

test('isolated fill, leakage, wear spill and delivery sequence closes all physical water stocks', () => {
  const vessel = formed(), physicalBefore = structuredClone(vessel), initialSource = 10_000;
  const fill = flowQuantized(flow({ sourceWater: initialSource, destinationWater: 0,
    destinationCapacity: containerAffordance(vessel).capacityQuanta, requestedQuanta: 1000 }));
  const leak = leakIntegerRemainder({ water: fill.destinationWater, leakRemainder: 0 }, 1000, 1_000_000, 100);
  const leakedToGround = capacityOverflowReturns({ water: leak.leakedQuanta, leakRemainder: 0 }, 0, 0, 100);
  const spill = capacityOverflowReturns(leak.contents, 400, leakedToGround.sinkWater, 100);
  const delivery = flowQuantized(flow({ sourceWater: spill.contents.water, destinationWater: 0, destinationCapacity: 400,
    requestedQuanta: 400 }));
  const loss = leakedToGround.environmentalLossQuanta + spill.environmentalLossQuanta;
  assert.equal(sum(initialSource), sum(fill.sourceWater, delivery.sourceWater, delivery.destinationWater, spill.sinkWater, loss));
  assert.ok(fill.workSpent > 0 && delivery.workSpent > 0); assert.deepEqual(vessel, physicalBefore);
  // Destination is a generic reservoir. Only the future body adapter can call
  // this hydration or credit benefit; filling or this test does not do so.
  assert.equal(Object.hasOwn(delivery, 'benefit'), false);
});

test('all calls are deterministic and work with deeply frozen inputs', () => {
  const batch = formed(); Object.freeze(batch.properties); Object.freeze(batch.composition); Object.freeze(batch);
  const contents = Object.freeze({ water: 400, leakRemainder: 123 }), state = Object.freeze(flow());
  assert.deepEqual(containerAffordance(batch), containerAffordance(batch));
  assert.equal(carriedMassQuanta(batch, contents), batch.mass + 400);
  assert.deepEqual(flowQuantized(state), flowQuantized(state));
  assert.deepEqual(leakIntegerRemainder(contents, 4), leakIntegerRemainder(contents, 4));
  assert.deepEqual(capacityOverflowReturns(contents, 200, 0, 100), capacityOverflowReturns(contents, 200, 0, 100));
});

test('unsafe or noninteger quantities and invalid physical properties fail without mutation', () => {
  for (const bad of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    for (const key of ['sourceWater', 'destinationWater', 'destinationCapacity', 'requestedQuanta', 'carryFreeQuanta', 'elapsedTicks', 'workAvailable'] as const) {
      const state = flow({ [key]: bad }), before = structuredClone(state);
      assert.throws(() => flowQuantized(state), RangeError); assert.deepEqual(state, before);
    }
    assert.throws(() => leakIntegerRemainder({ water: bad, leakRemainder: 0 }, 1), RangeError);
    assert.throws(() => capacityOverflowReturns({ water: 1, leakRemainder: 0 }, bad, 0, 0), RangeError);
    const batch = formed(); batch.mass = bad; assert.throws(() => containerAffordance(batch), RangeError);
  }
  for (const bad of [-0.1, 1.01, NaN, Infinity]) {
    const batch = formed(); batch.properties.porosity = bad; assert.throws(() => containerAffordance(batch), RangeError);
  }
  const mismatch = formed(); mismatch.composition.water = 1; assert.throws(() => containerAffordance(mismatch), RangeError);
  const unsupported = formed(); Object.assign(unsupported.composition, { unknownMass: 100 });
  assert.throws(() => containerAffordance(unsupported), RangeError);
  assert.throws(() => flowQuantized(flow({ destinationWater: 1001 })), RangeError);
  assert.throws(() => capacityOverflowReturns({ water: 100, leakRemainder: 0 }, 10, 11, 10), RangeError);
  assert.throws(() => flowQuantized(flow({ elapsedTicks: MAX_WATER_STEP_TICKS + 1 })), RangeError);
  assert.throws(() => leakIntegerRemainder({ water: 1, leakRemainder: 0 }, 1, 1000, MAX_WATER_STEP_TICKS + 1), RangeError);
});

test('remainders, denominators and versioned coefficients have strict bounds', () => {
  for (const contents of [{ water: 0, leakRemainder: 1 }, { water: 1, leakRemainder: 1000 },
    { water: 1, leakRemainder: -1 }, { water: 1, leakRemainder: 0.1 }]) {
    assert.throws(() => assertWaterContents(contents, 1000), RangeError);
  }
  assert.throws(() => leakIntegerRemainder({ water: 1, leakRemainder: 0 }, 1, 0), RangeError);
  assert.throws(() => leakIntegerRemainder({ water: 1, leakRemainder: 0 }, 1001, 1000), RangeError);
  for (const override of [{ fixedPointDenominator: 0 }, { quantaPerWork: 0 }, { capacityPerSolidMass: -1 },
    { leakagePerTickNumerator: 1_000_001 }, { flowQuantaPerTick: NaN }, { version: 2 }]) {
    assert.throws(() => containerAffordance(formed(), { ...DEFAULT_WATER_POLICY, ...override } as WaterInteractionPolicy), RangeError);
  }
  assert.equal(containerAffordance(formed(), policy({ capacityPerSolidMass: 0 })).capacityQuanta, 0);
});

test('large safe integers remain exact despite unsafe-number intermediate products', () => {
  const max = Number.MAX_SAFE_INTEGER, exact = rawMaterial('stone', max);
  exact.properties = { ...exact.properties, containment: 1, cohesion: 1, porosity: 0 };
  assert.equal(containerAffordance(exact, policy({ capacityPerSolidMass: 1 })).capacityQuanta, max);
  assert.throws(() => containerAffordance(exact), RangeError);
  assert.throws(() => carriedMassQuanta(exact, { water: 1, leakRemainder: 0 }), RangeError);
  const moved = flowQuantized(flow({ sourceWater: max, destinationWater: 0, destinationCapacity: max, requestedQuanta: max,
    carryFreeQuanta: max, elapsedTicks: MAX_WATER_STEP_TICKS, workAvailable: max }), policy({ flowQuantaPerTick: max, quantaPerWork: max }));
  assert.equal(moved.movedQuanta, max); assert.equal(moved.workSpent, 1); assert.equal(moved.destinationWater, max);
  const leaked = leakIntegerRemainder({ water: max, leakRemainder: 0 }, 999_999);
  assert.equal(BigInt(leaked.leakedQuanta), BigInt(max) * 999_999n / 1_000_000n);
  assert.equal(sum(leaked.contents.water, leaked.leakedQuanta), BigInt(max));
});
