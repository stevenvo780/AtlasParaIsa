import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ELEMENTS, emptyVector, evaluateMaterialProperties, vectorMass,
} from '../src/shared/chemistry.js';
import type { CompoundLot, ElementVector, ThermalPhase } from '../src/shared/chemistry.js';
import {
  CHEM_QUANTA_PER_UNIT, ENRICH_SPEND, FORGE_MAX_QUANTA, FORGE_MIN_QUANTA,
  FORMULA_PRUNE_TARGET, FORMULA_PRUNE_TRIGGER, PROJECTED_FORMULAS,
  applyChemOperator, compoundCarryBonus, compoundCarryUnits, compoundFertilityBonus,
  compoundHuntBonus, compoundToolBonus, defaultChemistryState, dominantCraftProfile,
  enrichSoilFromLots, forgeWithCompound, formulaSignature, infuseCompound, performChemistryExperiment,
  pruneFormulaCatalog,
} from '../src/world/chemistry.js';
import type { ChemOperatorResult, ChemistryState } from '../src/world/chemistry.js';
import { rawMaterial } from '../src/world/technology.js';
import type { MaterialBatch } from '../src/shared/technology.js';

const EPS = 1e-9;
const PHASES: readonly ThermalPhase[] = ['raw', 'ground', 'washed', 'fired', 'smelted', 'vitrified'];
const PROPERTY_KEYS = ['hardness', 'toughness', 'seal', 'insulation', 'fuelPower', 'fertility', 'lightness'] as const;
const FORGE_KEYS = ['hardness', 'toughness', 'containment', 'insulation', 'edge', 'leverage'] as const;

const PURE_C: ElementVector = { C: 1, Si: 0, Ca: 0, Fe: 0, S: 0, H: 0 };
const PURE_FE: ElementVector = { C: 0, Si: 0, Ca: 0, Fe: 1, S: 0, H: 0 };
const PURE_H: ElementVector = { C: 0, Si: 0, Ca: 0, Fe: 0, S: 0, H: 1 };
/** Lime, carbon and water: the mix the fertility term is written for. */
const ORGANIC: ElementVector = { C: 0.45, Si: 0, Ca: 0.35, Fe: 0, S: 0, H: 0.2 };
/** Ore plus carbon charge that crosses the carbothermic threshold. */
const ORE: ElementVector = { C: 0.05, Si: 0.3, Ca: 0.08, Fe: 0.5, S: 0.05, H: 0.02 };
const CHARCOAL: ElementVector = { C: 0.8, Si: 0.05, Ca: 0, Fe: 0, S: 0, H: 0.15 };
/** Silica and salt, too little iron to smelt, enough to vitrify. */
const GLASS: ElementVector = { C: 0.02, Si: 0.6, Ca: 0.08, Fe: 0.02, S: 0.22, H: 0.06 };

function makeLot(id: string, composition: ElementVector, phase: ThermalPhase, mass = 1): CompoundLot {
  const total = vectorMass(composition);
  const scaled = emptyVector();
  if (total > 0) for (const element of ELEMENTS) scaled[element] = composition[element] / total * mass;
  return {
    id, formulaId: `src-${id}`, composition: scaled, phase, mass: vectorMass(scaled),
    properties: evaluateMaterialProperties(scaled, phase),
  };
}

function snapshot(lot: CompoundLot): string {
  return JSON.stringify(lot);
}

function assertConserved(inputs: readonly CompoundLot[], result: ChemOperatorResult, label: string): void {
  const input = emptyVector();
  for (const lot of inputs) for (const element of ELEMENTS) input[element] += lot.composition[element];
  for (const element of ELEMENTS) {
    const out = result.product.composition[element] + (result.byproduct?.[element] ?? 0) + (element === 'H' ? result.evaporatedH : 0);
    assert.ok(Math.abs(input[element] - out) <= EPS, `${label} ${element}: in ${input[element]} out ${out}`);
    assert.ok(result.product.composition[element] >= -EPS, `${label} ${element} product went negative`);
    assert.ok((result.byproduct?.[element] ?? 0) >= -EPS, `${label} ${element} byproduct went negative`);
  }
  assert.ok(result.evaporatedH >= -EPS, `${label} evaporated hydrogen went negative`);
  const inMass = inputs.reduce((sum, lot) => sum + lot.mass, 0);
  const outMass = result.product.mass + (result.byproduct ? vectorMass(result.byproduct) : 0) + result.evaporatedH;
  assert.ok(Math.abs(inMass - outMass) <= EPS, `${label} mass ${inMass} vs ${outMass}`);
  assert.ok(Math.abs(result.product.mass - vectorMass(result.product.composition)) <= EPS, `${label} product mass drifted from its vector`);
}

function slot(index: number): string {
  return `G${String(index).padStart(4, '0')}`;
}

/** Equal-utility ground formulas in discovery order, so eviction is a pure function of age and the published caps. */
function groundCatalog(count = FORMULA_PRUNE_TRIGGER): ChemistryState {
  const state = defaultChemistryState();
  const properties = evaluateMaterialProperties(PURE_C, 'ground');
  for (let index = 0; index < count; index++) {
    state.formulas.push({
      id: slot(index), signature: `ground:slot${index}`, name: `mezcla ${index}`,
      composition: { C: 0.2, Si: 0.2, Ca: 0.2, Fe: 0.2, S: 0.1, H: 0.1 },
      phase: 'ground', temperatureTier: 0, operator: 'grind', discoveredAt: index, discovererId: null, uses: 1,
      properties: { ...properties },
    });
  }
  state.formulaCounter = count;
  return state;
}

function idsOf(state: ChemistryState): string[] {
  return state.formulas.map(formula => formula.id);
}

function zeroForge(material: 'wood' | 'stone' = 'wood'): MaterialBatch {
  const batch = rawMaterial(material, 1000);
  for (const key of FORGE_KEYS) batch.properties[key] = 0;
  return batch;
}

test('the seven material properties are fixed by the element vector and the thermal phase, and stay inside [0, 1]', () => {
  const vectors: ElementVector[] = [emptyVector(), PURE_C, PURE_FE, PURE_H, ORGANIC, ORE, GLASS];
  for (let index = 0; index < 24; index++) {
    const vector = emptyVector();
    for (let cursor = 0; cursor < ELEMENTS.length; cursor++) vector[ELEMENTS[cursor]!] = ((index + 1) * (cursor + 3) * 7) % 11;
    vectors.push(vector);
  }
  for (const phase of PHASES) for (const vector of vectors) {
    const once = evaluateMaterialProperties(vector, phase);
    const twice = evaluateMaterialProperties({ ...vector }, phase);
    const scaled = emptyVector();
    for (const element of ELEMENTS) scaled[element] = vector[element] * 7;
    assert.deepEqual(twice, once, `${phase} properties changed between identical calls`);
    assert.deepEqual(evaluateMaterialProperties(scaled, phase), once, `${phase} properties changed when the same mix was scaled`);
    for (const key of PROPERTY_KEYS) {
      const value = once[key];
      assert.equal(typeof value, 'number', `${key} missing`);
      assert.ok(value! >= 0 && value! <= 1, `${phase} ${key} = ${value} left [0, 1]`);
    }
    assert.match(once.colorHex, /^#[0-9a-f]{6}$/);
    for (const offset of [1, 3, 5]) {
      const channel = parseInt(once.colorHex.slice(offset, offset + 2), 16);
      assert.ok(channel >= 38 && channel <= 228, `${once.colorHex} channel ${channel} left the documented 38..228 range`);
    }
  }
  const carbon = evaluateMaterialProperties(PURE_C, 'raw');
  const carbonFired = evaluateMaterialProperties(PURE_C, 'fired');
  const iron = evaluateMaterialProperties(PURE_FE, 'raw');
  assert.ok(iron.hardness > carbon.hardness, 'iron is harder than charcoal');
  assert.equal(carbonFired.fuelPower, 1);
  assert.ok(carbonFired.fuelPower > carbon.fuelPower, 'firing carbon raises fuel power');
  assert.equal(evaluateMaterialProperties(PURE_FE, 'fired').fuelPower, 0);
  assert.notDeepEqual(evaluateMaterialProperties(ORGANIC, 'raw'), evaluateMaterialProperties(ORGANIC, 'fired'));
});

test('grind, wash, heat and bind conserve every element into the product plus the declared byproduct', () => {
  const samples = [ORE, CHARCOAL, GLASS, ORGANIC, PURE_C, PURE_H, { C: 0.33, Si: 0.33, Ca: 0.33, Fe: 0.33, S: 0.33, H: 0.33 }];
  const state = defaultChemistryState();
  for (const [index, vector] of samples.entries()) {
    const raw = makeLot(`raw-${index}`, vector, 'raw', 0.5 + index);
    const before = snapshot(raw);
    const ground = applyChemOperator('grind', raw, { temperatureTier: 0 }, state);
    assert.equal(snapshot(raw), before, 'grind mutates its input');
    assert.deepEqual(ground.product.composition, raw.composition);
    assert.equal(ground.byproduct, undefined);
    assert.equal(ground.evaporatedH, 0);
    assertConserved([raw], ground, `grind ${index}`);

    const washed = applyChemOperator('wash', raw, { temperatureTier: 0, waterAvailable: 1 }, state);
    assert.equal(snapshot(raw), before, 'wash mutates its input');
    assert.equal(washed.waterConsumed, 0.02);
    assert.ok(Math.abs(washed.byproduct!.S - raw.composition.S * 0.65) <= EPS);
    assert.ok(Math.abs(washed.byproduct!.H - raw.composition.H * 0.5) <= EPS);
    assert.equal(washed.evaporatedH, 0);
    assertConserved([raw], washed, `wash ${index}`);

    const fired = applyChemOperator('heat', raw, { temperatureTier: 1 }, state);
    assert.equal(snapshot(raw), before, 'heat mutates its input');
    assert.equal(fired.byproduct, undefined);
    assert.ok(Math.abs(fired.evaporatedH - raw.composition.H * 0.85) <= EPS);
    assertConserved([raw], fired, `heat T1 ${index}`);

    const hot = applyChemOperator('heat', raw, { temperatureTier: 2 }, state);
    assert.ok(Math.abs(hot.evaporatedH - raw.composition.H * 0.98) <= EPS);
    assertConserved([raw], hot, `heat T2 ${index}`);

    const partner = makeLot(`partner-${index}`, samples[(index + 1) % samples.length]!, 'fired', 1);
    const bound = applyChemOperator('bind', raw, { b: partner, temperatureTier: 0 }, state);
    assert.equal(snapshot(raw), before, 'bind mutates its input');
    for (const element of ELEMENTS) assert.equal(bound.product.composition[element], raw.composition[element] + partner.composition[element]);
    assert.equal(bound.byproduct, undefined);
    assert.equal(bound.evaporatedH, 0);
    assertConserved([raw, partner], bound, `bind ${index}`);

    const charged = applyChemOperator('heat', raw, { b: partner, temperatureTier: 2 }, state);
    assertConserved([raw, partner], charged, `heat charge ${index}`);
  }

  const ore = makeLot('ore', ORE, 'raw', 1);
  const charcoal = makeLot('charcoal', CHARCOAL, 'fired', 1);
  const smelt = applyChemOperator('heat', ore, { b: charcoal, temperatureTier: 2 }, state);
  assert.equal(smelt.product.phase, 'smelted');
  assert.ok(smelt.byproduct!.Si > 0 && smelt.byproduct!.C > 0);
  assert.equal(smelt.byproduct!.Fe, 0);
  assert.equal(smelt.byproduct!.Ca, 0);
  assertConserved([ore, charcoal], smelt, 'smelt');

  const sand = makeLot('sand', GLASS, 'washed', 1);
  const glass = applyChemOperator('heat', sand, { temperatureTier: 2 }, state);
  assert.equal(glass.product.phase, 'vitrified');
  assert.equal(glass.byproduct, undefined);
  assertConserved([sand], glass, 'vitrify');

  const chainState = defaultChemistryState();
  const start = makeLot('chain', ORGANIC, 'raw', 1.25);
  const stepGrind = applyChemOperator('grind', start, { temperatureTier: 0 }, chainState);
  const stepWash = applyChemOperator('wash', stepGrind.product, { temperatureTier: 0, waterAvailable: 0.5 }, chainState);
  const stepHeat = applyChemOperator('heat', stepWash.product, { temperatureTier: 1 }, chainState);
  const extra = makeLot('chain-b', PURE_C, 'ground', 0.4);
  const stepBind = applyChemOperator('bind', stepHeat.product, { b: extra, temperatureTier: 0 }, chainState);
  const gained = emptyVector();
  for (const element of ELEMENTS) {
    gained[element] = stepBind.product.composition[element]
      + (stepWash.byproduct?.[element] ?? 0)
      + (element === 'H' ? stepHeat.evaporatedH : 0);
  }
  for (const element of ELEMENTS) {
    assert.ok(Math.abs(gained[element] - (start.composition[element] + extra.composition[element])) <= EPS, `chain ${element}`);
  }
  assert.throws(() => applyChemOperator('wash', start, { temperatureTier: 0, waterAvailable: 0.01 }, chainState), /agua/);
  assert.throws(() => applyChemOperator('heat', start, { temperatureTier: 0 }, chainState), /temperatureTier/);
});

test('at the prune trigger the catalog keeps the projected head and evicts the least-used, then the oldest', () => {
  const evict = FORMULA_PRUNE_TRIGGER - FORMULA_PRUNE_TARGET;
  const head = PROJECTED_FORMULAS;
  assert.ok(evict > 0 && head > 0 && head + evict < FORMULA_PRUNE_TRIGGER);

  const pure = groundCatalog();
  const pureOrder = idsOf(pure);
  assert.equal(pruneFormulaCatalog(pure), evict);
  assert.equal(pure.formulas.length, FORMULA_PRUNE_TARGET);
  const pureLeft = new Set(idsOf(pure));
  assert.equal(pureLeft.has(slot(0)), true, 'the oldest formula is inside the projected head');
  assert.equal(pureLeft.has(slot(head - 1)), true, 'the last projected slot stays');
  assert.equal(pureLeft.has(slot(head)), false, 'the first formula outside the head is the first victim');
  assert.equal(pureLeft.has(slot(head + evict - 1)), false, 'the victim window has the published length');
  assert.equal(pureLeft.has(slot(head + evict)), true, 'a newer formula of equal use survives');
  assert.equal(pureLeft.has(slot(FORMULA_PRUNE_TRIGGER - 1)), true);
  let cursor = 0;
  for (const id of idsOf(pure)) {
    const at = pureOrder.indexOf(id, cursor);
    assert.ok(at >= cursor, 'prune reordered discovery');
    cursor = at + 1;
  }
  assert.equal(pruneFormulaCatalog(pure), 0, 'a second prune of an already-shrunk catalog still removes formulas');

  const popular = groundCatalog();
  popular.formulas[head]!.uses = 80;
  const popularLeft = new Set(idsOf(popular));
  pruneFormulaCatalog(popular);
  popularLeft.clear();
  for (const id of idsOf(popular)) popularLeft.add(id);
  assert.equal(popular.formulas.length, FORMULA_PRUNE_TARGET);
  assert.equal(popularLeft.has(slot(head)), true, 'a heavily used formula in the victim band stays');
  assert.equal(popularLeft.has(slot(head - 1)), false, 'that popular formula takes a projected slot and the marginal old formula becomes evictable');
  assert.equal(popularLeft.has(slot(head + 1)), false);
  assert.equal(popularLeft.has(slot(head + evict - 1)), false);
  assert.equal(popularLeft.has(slot(head + evict)), true);

  const advanced = groundCatalog();
  const last = advanced.formulas[advanced.formulas.length - 1]!;
  last.phase = 'smelted';
  last.signature = 'smelted:last';
  last.discoveredAt = 99999;
  last.uses = 1;
  pruneFormulaCatalog(advanced);
  const advancedLeft = new Set(idsOf(advanced));
  assert.equal(advancedLeft.has(slot(FORMULA_PRUNE_TRIGGER - 1)), true, 'one smelted formula outranks a ground formula with the same use count');
  assert.equal(advancedLeft.has(slot(head - 1)), false, 'protecting the smelted formula pushes the youngest projected ground formula into the victim window');
  assert.equal(advancedLeft.has(slot(head + evict - 1)), true);

  const again = groundCatalog();
  again.formulas[head]!.uses = 80;
  pruneFormulaCatalog(again);
  assert.deepEqual(idsOf(again), idsOf(popular));

  const settled = groundCatalog(FORMULA_PRUNE_TARGET);
  assert.equal(pruneFormulaCatalog(settled), 0);
  assert.equal(settled.formulas.length, FORMULA_PRUNE_TARGET);

  const oneOver = groundCatalog(FORMULA_PRUNE_TARGET + 1);
  assert.equal(pruneFormulaCatalog(oneOver), 1);
  const oneLeft = new Set(idsOf(oneOver));
  assert.equal(oneLeft.has(slot(head)), false, 'the single spare eviction still hits the oldest formula outside the head');
  assert.equal(oneLeft.has(slot(FORMULA_PRUNE_TARGET)), true, 'the newest equal-use formula is not the one removed');
});

test('autonomous experimentation prunes when the catalog reaches the trigger and still registers the next formula', () => {
  const head = PROJECTED_FORMULAS;
  const ready = groundCatalog();
  const world = {
    seed: 4821, tick: 11, chemistry: ready, params: { quimica: { emergente: true } },
  };
  const person = {
    id: 'ada', x: 2, y: 5, materials: { wood: 2, stone: 0 }, compounds: [] as CompoundLot[], skills: { craft: 0 },
  };
  const tile = { x: 2, y: 5, biome: 'forest', feature: 'tree', wood: 4, stone: 0, drinkingWater: 0 };
  const result = performChemistryExperiment(world, person, tile, []);
  assert.ok(result);
  assert.equal(result.isNew, true, 'a full catalog refused a new discovery');
  assert.equal(result.formula.id, `F${FORMULA_PRUNE_TRIGGER + 1}`);
  assert.equal(ready.formulas.length, FORMULA_PRUNE_TARGET + 1);
  assert.ok(ready.formulas.length < FORMULA_PRUNE_TRIGGER);
  assert.equal(idsOf(ready).includes(slot(0)), true);
  assert.equal(idsOf(ready).includes(slot(head)), false, 'the trigger path did not evict the low-utility band');
  assert.equal(result.formula.signature, formulaSignature(result.lot.phase, result.lot.composition));

  const early = groundCatalog(FORMULA_PRUNE_TRIGGER - 1);
  const earlyWorld = { seed: 4821, tick: 11, chemistry: early, params: { quimica: { emergente: true } } };
  const earlyPerson = {
    id: 'ada', x: 2, y: 5, materials: { wood: 2, stone: 0 }, compounds: [] as CompoundLot[], skills: { craft: 0 },
  };
  performChemistryExperiment(earlyWorld, earlyPerson, { ...tile }, []);
  assert.equal(early.formulas.length, FORMULA_PRUNE_TRIGGER, 'experimentation pruned before the trigger');
  assert.equal(idsOf(early).includes(slot(head)), true);
});

test('pruning leaves a carried lot and a forged tool intact, and the same mix keeps its signature', () => {
  const head = PROJECTED_FORMULAS;
  const citedByLot = slot(head);
  const citedByTool = slot(head + 1);
  const uncited = slot(head + 2);
  const state = groundCatalog();
  const carried = makeLot('carried', ORGANIC, 'ground', 1);
  carried.formulaId = citedByLot;
  const toolSource = makeLot('tool-source', PURE_FE, 'smelted', 1);
  toolSource.formulaId = citedByTool;
  const tool = zeroForge('stone');
  assert.equal(infuseCompound(tool, [toolSource])?.formulaId, citedByTool);

  const world = { seed: 7, tick: 4, chemistry: state, params: { quimica: { emergente: true } } };
  const person = {
    id: 'ada', x: 1, y: 1, materials: { wood: 2, stone: 0 }, compounds: [carried], skills: { craft: 1 },
  };
  const tile = { x: 1, y: 1, biome: 'grassland', feature: 'rock', wood: 0, stone: 0, drinkingWater: 0 };
  const before = snapshot(carried);
  const result = performChemistryExperiment(world, person, tile, []);
  assert.ok(result, 'the trigger experiment did not run');
  const left = new Set(idsOf(state));
  assert.equal(left.has(slot(0)), true, 'the projected head was evicted');
  assert.equal(left.has(uncited), false, 'a low-utility formula with no live role was kept');
  const still = person.compounds!.find(lot => lot.id === 'carried');
  assert.ok(still);
  assert.equal(snapshot(still), before, 'pruning rewrote the carried lot');
  assert.equal(still.formulaId, citedByLot);
  assert.equal(tool.chemFormulaId, citedByTool);
  assert.equal(tool.chemPhase, 'smelted');
  assert.equal(tool.materialTint, evaluateMaterialProperties(PURE_FE, 'smelted').colorHex);

  const replay = applyChemOperator('grind', makeLot('replay', carried.composition, 'raw', carried.mass), { temperatureTier: 0, tick: 8, actorId: 'ada' }, state);
  assert.equal(replay.formula.signature, formulaSignature('ground', carried.composition));
  assert.equal(replay.formula.signature, formulaSignature(carried.phase, carried.composition));
  const repeat = applyChemOperator('grind', makeLot('replay-2', carried.composition, 'raw', carried.mass), { temperatureTier: 0, tick: 9, actorId: 'bea' }, state);
  assert.equal(repeat.formula.id, replay.formula.id);
  assert.equal(repeat.isNew, false);
});

// se borra en la ola 3 (carril T1)
test.skip('a formula cited by a carried lot or a forged tool is never evicted by the trigger prune', () => {
  const head = PROJECTED_FORMULAS;
  const state = groundCatalog();
  const lot = makeLot('carried-ref', ORGANIC, 'ground', 1);
  lot.formulaId = slot(head);
  const tool = zeroForge('stone');
  const source = makeLot('tool-ref', PURE_FE, 'smelted', 1);
  source.formulaId = slot(head + 1);
  infuseCompound(tool, [source]);
  pruneFormulaCatalog(state);
  const left = new Set(idsOf(state));
  assert.equal(left.has(lot.formulaId), true, 'a formula cited by a carried lot was evicted');
  assert.equal(left.has(tool.chemFormulaId!), true, 'a formula cited by a forged tool was evicted');
});

test('the same inputs in the same order always register the same formula id', () => {
  const nearA = { C: 0.5, Si: 0.1, Ca: 0.1, Fe: 0.1, S: 0.1, H: 0.1 };
  const nearB = { C: 0.52, Si: 0.096, Ca: 0.096, Fe: 0.096, S: 0.096, H: 0.096 };
  const far = { C: 0.9, Si: 0.02, Ca: 0.02, Fe: 0.02, S: 0.02, H: 0.02 };
  assert.equal(formulaSignature('ground', nearA), formulaSignature('ground', nearB));
  assert.notEqual(formulaSignature('ground', nearA), formulaSignature('ground', far));
  assert.equal(formulaSignature('ground', nearA), formulaSignature('ground', { ...nearA, C: nearA.C * 4, Si: nearA.Si * 4, Ca: nearA.Ca * 4, Fe: nearA.Fe * 4, S: nearA.S * 4, H: nearA.H * 4 }));

  const run = () => {
    const state = defaultChemistryState();
    const first = applyChemOperator('grind', makeLot('a', nearA, 'raw'), { temperatureTier: 0, tick: 3, actorId: 'ada' }, state);
    const second = applyChemOperator('grind', makeLot('b', nearB, 'raw'), { temperatureTier: 0, tick: 99, actorId: 'bea' }, state);
    const third = applyChemOperator('wash', makeLot('c', far, 'raw'), { temperatureTier: 0, waterAvailable: 1, tick: 4, actorId: 'ada' }, state);
    const fourth = applyChemOperator('heat', makeLot('d', PURE_C, 'raw'), { temperatureTier: 1, tick: 5, actorId: 'ada' }, state);
    const fifth = applyChemOperator('bind', first.product, { b: third.product, temperatureTier: 0, tick: 6, actorId: 'ada' }, state);
    return {
      ids: [first.formula.id, second.formula.id, third.formula.id, fourth.formula.id, fifth.formula.id],
      reused: second.isNew, uses: second.formula.uses, discoveredAt: second.formula.discoveredAt, discovererId: second.formula.discovererId,
      signatures: state.formulas.map(formula => [formula.id, formula.signature]),
    };
  };
  const forward = run();
  assert.deepEqual(forward, run());
  assert.deepEqual(forward.ids, ['F1', 'F1', 'F2', 'F3', 'F4']);
  assert.equal(forward.reused, false);
  assert.equal(forward.uses, 2);
  assert.equal(forward.discoveredAt, 3, 'a repeat registration replaced the original discovery tick');
  assert.equal(forward.discovererId, 'ada');

  const swapped = defaultChemistryState();
  const farFirst = applyChemOperator('wash', makeLot('c', far, 'raw'), { temperatureTier: 0, waterAvailable: 1, tick: 4, actorId: 'ada' }, swapped);
  const nearSecond = applyChemOperator('grind', makeLot('a', nearA, 'raw'), { temperatureTier: 0, tick: 3, actorId: 'ada' }, swapped);
  assert.equal(farFirst.formula.id, 'F1');
  assert.notEqual(farFirst.formula.signature, forward.signatures[0]![1], 'formula ids followed composition hashes instead of registration order');
  assert.equal(nearSecond.formula.id, 'F2');

  const experiment = () => {
    const world = { seed: 4821, tick: 19, chemistry: defaultChemistryState(), params: { quimica: { emergente: true } } };
    const person = {
      id: 'ada', x: 4, y: 9, materials: { wood: 1, stone: 1 }, skills: { craft: 0.4 },
      compounds: [makeLot('ore', ORE, 'raw', 1), makeLot('fuel', CHARCOAL, 'fired', 1)],
    };
    const tile = { x: 4, y: 9, biome: 'mountain', feature: 'rock', wood: 2, stone: 3, drinkingWater: 0.2 };
    const structures = [{ components: ['roof', 'hearth', 'hearth'], condition: 1, water: 0.1, installed: [{ insulation: 0.2 }, { insulation: 0.2 }] }];
    const result = performChemistryExperiment(world, person, tile, structures);
    return {
      operator: result?.operator, id: result?.formula.id, signature: result?.formula.signature, isNew: result?.isNew,
      catalog: world.chemistry.formulas.map(formula => [formula.id, formula.signature, formula.uses]),
    };
  };
  const left = experiment();
  assert.deepEqual(left, experiment());
  assert.match(left.id ?? '', /^F\d+$/);
  assert.notEqual(left.operator, undefined);
});

test('forged tools record the compound they consumed and their bonus stays inside the published bounds', () => {
  assert.equal(FORGE_MIN_QUANTA, 15);
  assert.equal(FORGE_MAX_QUANTA, 40);
  const minMass = FORGE_MIN_QUANTA / CHEM_QUANTA_PER_UNIT;
  const maxMass = FORGE_MAX_QUANTA / CHEM_QUANTA_PER_UNIT;

  const metal = makeLot('ore', PURE_FE, 'smelted', 1);
  metal.formulaId = 'F-ore-9';
  const batch = zeroForge();
  const spentBefore = snapshot(metal);
  const infusion = infuseCompound(batch, [metal]);
  assert.ok(infusion);
  assert.equal(infusion.formulaId, 'F-ore-9');
  assert.equal(infusion.phase, 'smelted');
  assert.equal(infusion.spentMass, maxMass);
  assert.equal(batch.chemFormulaId, 'F-ore-9');
  assert.equal(batch.chemPhase, 'smelted');
  assert.equal(batch.materialTint, metal.properties.colorHex);
  assert.equal(batch.properties.hardness, 0.5);
  assert.equal(batch.properties.toughness, 0.5);
  assert.equal(batch.properties.edge, 0.5);
  assert.equal(batch.properties.leverage, 0, 'iron with no lightness raised leverage');
  assert.equal(batch.properties.insulation, 0);
  for (const key of FORGE_KEYS) assert.ok(batch.properties[key] >= 0 && batch.properties[key] <= 1, `${key} left [0, 1]`);
  assert.ok(Math.abs(metal.mass - (1 - maxMass)) <= EPS);
  assert.ok(Math.abs(metal.composition.Fe - (1 - maxMass)) <= EPS);
  assert.ok(Math.abs(infusion.spent.Fe - maxMass) <= EPS);
  assert.notEqual(snapshot(metal), spentBefore);

  const capped = zeroForge();
  for (const key of FORGE_KEYS) capped.properties[key] = 1;
  infuseCompound(capped, [makeLot('cap', PURE_FE, 'smelted', 1)]);
  for (const key of FORGE_KEYS) assert.equal(capped.properties[key], 1, `${key} exceeded 1 or was lowered`);

  const fiber = makeLot('fiber', PURE_C, 'raw', 1);
  fiber.formulaId = 'F-fiber';
  const pack = zeroForge();
  const fiberInfusion = infuseCompound(pack, [fiber]);
  assert.ok(fiberInfusion);
  assert.equal(pack.chemFormulaId, 'F-fiber');
  assert.equal(pack.chemPhase, 'raw');
  assert.equal(pack.materialTint, evaluateMaterialProperties(PURE_C, 'raw').colorHex);
  assert.ok(pack.properties.leverage > 0.3 && pack.properties.leverage <= 0.5, `light stock leverage ${pack.properties.leverage} is outside the strength cap`);
  assert.ok(pack.properties.hardness <= 0.5);

  const twinA = zeroForge();
  const twinB = zeroForge();
  const lotA = makeLot('twin', PURE_FE, 'smelted', 1);
  const lotB = makeLot('twin', PURE_FE, 'smelted', 1);
  lotA.formulaId = 'F-twin';
  lotB.formulaId = 'F-twin';
  assert.deepEqual(infuseCompound(twinA, [lotA]), infuseCompound(twinB, [lotB]));
  assert.deepEqual(twinA.properties, twinB.properties);

  const rejected = zeroForge('stone');
  const hydrogen = makeLot('water', PURE_H, 'raw', 1);
  const speck = makeLot('speck', PURE_FE, 'smelted', minMass / 2);
  assert.equal(infuseCompound(rejected, [hydrogen]), null);
  assert.equal(hydrogen.mass, 1);
  assert.equal(rejected.chemFormulaId, undefined);
  assert.equal(forgeWithCompound(zeroForge(), [speck]), false);
  assert.equal(speck.mass, minMass / 2);
  const barely = makeLot('barely', PURE_FE, 'smelted', minMass);
  barely.formulaId = 'F-barely';
  const thin = zeroForge();
  const thinInfusion = infuseCompound(thin, [barely]);
  assert.ok(thinInfusion);
  assert.equal(thin.chemFormulaId, 'F-barely');
  assert.ok(thinInfusion.spentMass <= maxMass && thinInfusion.spentMass > 0);
  assert.ok(thin.properties.hardness > 0 && thin.properties.hardness < 0.5);

  const cutting = makeLot('blade', PURE_FE, 'smelted', 1);
  const soft = makeLot('soft', PURE_C, 'raw', 1);
  assert.equal(compoundToolBonus([cutting], 'cutting'), 0.45);
  assert.equal(compoundToolBonus([soft], 'cutting'), 0);
  assert.equal(compoundToolBonus([makeLot('dust', PURE_FE, 'smelted', 0.049)], 'cutting'), 0);
  assert.ok(compoundToolBonus([makeLot('chip', PURE_FE, 'smelted', 0.05)], 'cutting') > 0);
  for (const capability of ['cutting', 'abrasion', 'containment', 'insulation'] as const) {
    const bonus = compoundToolBonus([cutting, soft, makeLot('org', ORGANIC, 'ground', 1)], capability);
    assert.ok(bonus >= 0 && bonus <= 0.45, `${capability} bonus ${bonus} left [0, 0.45]`);
  }
  assert.equal(compoundToolBonus(undefined, 'cutting'), 0);
});

test('fertility enriches soil and lightness lightens a carry load, and neither one borrows the other effect', () => {
  const organic = makeLot('organic', ORGANIC, 'ground', 1);
  const organicRaw = makeLot('organic-raw', ORGANIC, 'raw', 1);
  const organicWashed = makeLot('organic-washed', ORGANIC, 'washed', 1);
  const organicSmelted = makeLot('organic-hot', ORGANIC, 'smelted', 1);
  const fiber = makeLot('fiber', PURE_C, 'raw', 1);
  const metal = makeLot('metal', PURE_FE, 'smelted', 1);
  const hydrogen = makeLot('hydrogen', PURE_H, 'raw', 1);

  assert.ok(organic.properties.fertility! > organicRaw.properties.fertility!, 'grinding the same mix raises fertility');
  assert.ok(organicRaw.properties.fertility! > organicSmelted.properties.fertility!, 'smelting the same mix lowers fertility');
  assert.ok(organicWashed.properties.lightness! > organic.properties.lightness!, 'washing the same mix raises lightness');
  assert.ok(organic.properties.lightness! > organicSmelted.properties.lightness!, 'smelting the same mix lowers lightness');
  assert.ok(fiber.properties.lightness! > metal.properties.lightness!);
  assert.ok(organic.properties.fertility! > metal.properties.fertility!);

  assert.equal(compoundFertilityBonus([organic]), 1);
  assert.equal(compoundFertilityBonus([metal]), 0);
  assert.ok(compoundFertilityBonus([hydrogen]) > 0.4, 'hydrogen-rich stock is fertile even though it cannot be forged');
  assert.equal(compoundCarryBonus([fiber]), 1);
  assert.equal(compoundCarryUnits([fiber]), 4);
  assert.equal(compoundCarryBonus([metal]), 0);
  assert.equal(compoundCarryUnits([metal]), 0);
  assert.equal(compoundCarryUnits([organic]), 1, 'a partly light fertile mix still adds a carry unit');
  assert.equal(compoundHuntBonus([metal]), 1);
  assert.equal(compoundHuntBonus([fiber]), 0, 'lightness does not sharpen a hunt');
  assert.equal(compoundToolBonus([hydrogen], 'cutting'), 0);

  const legacy = makeLot('legacy', ORGANIC, 'ground', 1);
  delete legacy.properties.fertility;
  delete legacy.properties.lightness;
  assert.equal(compoundFertilityBonus([legacy]), 1, 'a V20 lot without the two new fields lost its fertility');
  assert.ok(compoundCarryBonus([legacy]) > 0, 'a V20 lot without the two new fields lost its lightness');

  const bankedOrganic = makeLot('banked', ORGANIC, 'ground', 1);
  const bankedMetal = makeLot('banked-metal', PURE_FE, 'smelted', 1);
  const organicMass = bankedOrganic.mass;
  const metalMass = bankedMetal.mass;
  const enriched = enrichSoilFromLots([bankedMetal, bankedOrganic], 0.3);
  assert.equal(enriched, 0.3 + 0.05 * (1 - 0.3));
  assert.ok(Math.abs(bankedOrganic.mass - (organicMass - ENRICH_SPEND)) <= EPS, 'the fertile lot was not the one debited');
  assert.equal(bankedMetal.mass, metalMass, 'the infertile lot lost mass');
  const saturated = makeLot('full', ORGANIC, 'ground', 1);
  const saturatedMass = saturated.mass;
  assert.equal(enrichSoilFromLots([saturated], 0.9), 0.9);
  assert.equal(saturated.mass, saturatedMass);
  const speck = makeLot('speck', ORGANIC, 'ground', FORGE_MIN_QUANTA / CHEM_QUANTA_PER_UNIT / 2);
  assert.equal(enrichSoilFromLots([speck], 0.3), 0.3);
  assert.equal(speck.mass, FORGE_MIN_QUANTA / CHEM_QUANTA_PER_UNIT / 2);
  assert.equal(compoundFertilityBonus([metal, organic]), compoundFertilityBonus([organic]));

  assert.deepEqual(dominantCraftProfile([organic]), { craftTint: organic.properties.colorHex, craftFocus: 'fibra+cal/abono' });
  assert.deepEqual(dominantCraftProfile([fiber]), { craftTint: fiber.properties.colorHex, craftFocus: 'fibra/transporte' });
  assert.deepEqual(dominantCraftProfile([metal]), { craftTint: metal.properties.colorHex, craftFocus: 'metal/filo·fundición' });
  assert.deepEqual(dominantCraftProfile([speck]), {});
  assert.equal(dominantCraftProfile([hydrogen]).craftFocus?.includes('abono'), true);
  assert.equal(dominantCraftProfile([hydrogen]).craftFocus?.includes('transporte'), false);
});
