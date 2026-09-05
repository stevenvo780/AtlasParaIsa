import test from 'node:test';
import assert from 'node:assert/strict';
import type { DemographicActor, DemographicEnvironment } from '../src/shared/demography.js';
import { demographicTraits, DEMOGRAPHY_TICKS_PER_DAY as DAY, initialDemography, MAX_DEMOGRAPHY_DT,
  PROTECTED_HEALTH_FLOOR, PROTECTED_VITALITY_FLOOR, updateDemography } from '../src/world/demography.js';
import { assertGenome, founderGenome, inheritGenome, localRandom, type Genome } from '../src/world/genetics.js';

const safe: DemographicEnvironment = { exposure: 0, shelter: 0, protected: false };
function genome(resilience = 0.5, activity = 0.5, id = 'founder'): Genome {
  return founderGenome(431, id, { curiosity: 0.5, sociability: 0.5, industriousness: activity, care: 0.5, resilience });
}
function actor(resilience = 0.5): DemographicActor {
  return { state: initialDemography(), traits: demographicTraits(genome(resilience)), hunger: 0.1, thirst: 0.1, energy: 0.85, fatigue: 0.1 };
}
function untilDeath(person: DemographicActor, environment: DemographicEnvironment, limit = 50 * DAY) {
  let current = { ...person, state: { ...person.state } }, result = updateDemography(current, environment, 0);
  for (let tick = 0; tick < limit && !result.death; tick += 240) { result = updateDemography(current, environment, 240); current = { ...current, state: result.state }; }
  return result;
}
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('healthy young bodies have no invented mortality and advance age exactly once without mutating inputs', () => {
  const person = { ...actor(), inventory: 0.25, materials: { wood: 2, stone: 1 }, skills: { farm: 0.8 } }, original = structuredClone(person);
  const zero = updateDemography(person, safe, 0); assert.deepEqual(zero.state, person.state); assert.notEqual(zero.state, person.state);
  const first = updateDemography(person, safe, DAY), second = updateDemography({ ...person, state: first.state }, safe, DAY);
  assert.equal(second.state.age, DAY * 2); assert.equal(second.state.health, 1); assert.equal(second.state.vitality, 1);
  assert.equal(second.death, null); assert.deepEqual(second.damage, { starvation: 0, dehydration: 0, exposure: 0, senescence: 0 });
  assert.deepEqual(person, original); assert.equal('inventory' in second, false); assert.equal('materials' in second, false); assert.equal('children' in second, false);
});

test('persistent starvation and dehydration cause distinct deaths; matched fed and hydrated controls survive', () => {
  const starving = untilDeath({ ...actor(), hunger: 1 }, safe), thirsty = untilDeath({ ...actor(), thirst: 1 }, safe);
  assert.equal(starving.death, 'starvation'); assert.equal(thirsty.death, 'dehydration');
  assert.equal(starving.state.health, 0); assert.equal(thirsty.state.health, 0);
  assert.ok(starving.state.age < DAY * 2); assert.ok(thirsty.state.age < DAY * 2);
  let healthy = actor();
  for (let n = 0; n < 20; n++) healthy = { ...healthy, state: updateDemography(healthy, safe, 240).state };
  assert.equal(healthy.state.health, 1); assert.equal(healthy.state.deathCause, null);
});

test('shelter causally prevents exposure injury; food and water cannot independently remove exposure', () => {
  const exposed = { ...safe, exposure: 1 }, sheltered = { ...exposed, shelter: 1 };
  const harmed = untilDeath(actor(0.1), exposed), control = updateDemography(actor(0.1), sheltered, DAY);
  assert.equal(harmed.death, 'exposure'); assert.ok(harmed.damage.exposure > 0);
  assert.equal(control.damage.exposure, 0); assert.equal(control.state.health, 1); assert.equal(control.death, null);
  const watered = updateDemography({ ...actor(0.1), hunger: 0, thirst: 0 }, exposed, DAY);
  assert.ok(watered.damage.exposure > 0); assert.ok(watered.state.health < 1);
});

test('removing a resource deficit before the next transition allows recovery without creating food or water', () => {
  const person = { ...actor(), thirst: 1 };
  const stressed = updateDemography(person, safe, 300); assert.equal(stressed.death, null); assert.ok(stressed.state.health < 1);
  const rescued = { ...person, state: stressed.state, thirst: 0.1 }, before = structuredClone(rescued);
  const recovered = updateDemography(rescued, safe, DAY);
  assert.equal(recovered.death, null); assert.ok(recovered.state.health > stressed.state.health); assert.ok(recovered.state.vitality > stressed.state.vitality);
  assert.deepEqual(rescued, before); assert.equal('water' in recovered.state, false); assert.equal('food' in recovered.state, false);
});

test('senescence integrates age pressure and finite lifespan creates a vacancy even with abundant resources', () => {
  const person = actor(); person.state = initialDemography(person.traits.senescenceStart);
  const whole = updateDemography(person, safe, 600);
  const first = updateDemography(person, safe, 300), second = updateDemography({ ...person, state: first.state }, safe, 300);
  close(whole.damage.senescence, first.damage.senescence + second.damage.senescence);
  assert.equal(whole.state.age, second.state.age); assert.ok(whole.damage.senescence > 0);
  const final = updateDemography({ ...person, state: initialDemography(person.traits.maximumAge - 1) }, safe, 1);
  assert.equal(final.death, 'senescence'); assert.equal(final.state.age, person.traits.maximumAge); assert.equal(final.state.health, 0); assert.equal(final.offspringEligible, false);
});

test('continuity protection is an explicit external policy and leaves the physiological cause visible', () => {
  const person = { ...actor(), state: { ...initialDemography(), health: 0.01, vitality: 0.1 }, thirst: 1 };
  const unprotected = updateDemography(person, safe, 300), protectedResult = updateDemography(person, { ...safe, protected: true }, 300);
  assert.equal(unprotected.death, 'dehydration'); assert.equal(protectedResult.death, null); assert.equal(protectedResult.preventedDeath, 'dehydration');
  assert.equal(protectedResult.state.health, PROTECTED_HEALTH_FLOOR); assert.ok(protectedResult.state.vitality >= PROTECTED_VITALITY_FLOOR);
  assert.equal(protectedResult.state.deathCause, null); assert.equal(protectedResult.offspringEligible, false);
  assert.equal(protectedResult.damage.dehydration, unprotected.damage.dehydration); assert.equal(person.thirst, 1);
  const old = { ...actor(), state: initialDemography(person.traits.maximumAge) };
  const continued = updateDemography(old, { ...safe, protected: true });
  assert.equal(continued.death, null); assert.equal(continued.preventedDeath, 'senescence'); assert.equal(continued.state.age, old.state.age + 1);
});

test('recorded death is absorbing and cannot be reversed by later food, shelter or protection', () => {
  const dead = untilDeath({ ...actor(), thirst: 1 }, safe);
  const next = updateDemography({ ...actor(), state: dead.state }, { exposure: 0, shelter: 1, protected: true }, DAY);
  assert.deepEqual(next.state, dead.state); assert.equal(next.death, dead.death); assert.equal(next.preventedDeath, null); assert.equal(next.offspringEligible, false);
});

test('heritable resilience has actual survival benefits and food and reproductive tradeoffs', () => {
  const low = actor(0), high = actor(1), cold = { ...safe, exposure: 1 };
  assert.ok(high.traits.foodDemand > low.traits.foodDemand); assert.ok(high.traits.waterDemand < low.traits.waterDemand);
  assert.ok(high.traits.maturityAge > low.traits.maturityAge); assert.ok(high.traits.fertilityCooldown > low.traits.fertilityCooldown);
  assert.ok(updateDemography(high, cold, 600).state.health > updateDemography(low, cold, 600).state.health);
  assert.ok(updateDemography({ ...high, hunger: 1 }, safe, 240).state.health < updateDemography({ ...low, hunger: 1 }, safe, 240).state.health);
  assert.ok(updateDemography({ ...high, thirst: 1 }, safe, 240).state.health > updateDemography({ ...low, thirst: 1 }, safe, 240).state.health);
});

test('eligibility requires physiological maturity and reserves but never creates an offspring or pays for one', () => {
  const person = actor(), young = updateDemography(person, safe, 0); assert.equal(young.offspringEligible, false);
  const adult = { ...person, state: initialDemography(person.traits.maturityAge) };
  assert.equal(updateDemography(adult, safe, 0).offspringEligible, true);
  for (const changed of [{ hunger: 0.8 }, { thirst: 0.8 }, { energy: 0.3 }, { fatigue: 0.9 },
    { state: { ...adult.state, health: 0.3 } }, { state: { ...adult.state, vitality: 0.2 } }, { state: initialDemography(person.traits.senescenceStart) }]) {
    assert.equal(updateDemography({ ...adult, ...changed }, safe, 0).offspringEligible, false);
  }
  const original = structuredClone(adult); updateDemography(adult, safe, 1); assert.deepEqual(adult, original);
});

test('demographic expression reads alleles, not experience, generation labels or learning rate', () => {
  const inherited = genome(), sameAlleles = { ...structuredClone(inherited), generation: 7, learningRate: 0.2, mutations: 12, skills: { survival: 1 } };
  assert.deepEqual(demographicTraits(inherited), demographicTraits(sameAlleles));
  const changed = structuredClone(inherited); changed.alleles[8] = changed.alleles[9] = 1;
  assert.notDeepEqual(demographicTraits(inherited), demographicTraits(changed)); assert.equal(inherited.alleles[8], 0.5);
});

test('invalid demographics and unbounded elapsed intervals are rejected without mutation', () => {
  const person = actor(), before = structuredClone(person);
  for (const dt of [-1, Number.NaN, Number.POSITIVE_INFINITY, MAX_DEMOGRAPHY_DT + 1]) assert.throws(() => updateDemography(person, safe, dt), RangeError);
  for (const invalid of [{ hunger: 1.1 }, { state: { ...person.state, health: 0 } }, { state: { ...person.state, age: -1 } },
    { traits: { ...person.traits, maximumAge: person.traits.maturityAge } }]) assert.throws(() => updateDemography({ ...person, ...invalid }, safe), RangeError);
  assert.throws(() => updateDemography(person, { ...safe, shelter: 2 }), RangeError); assert.deepEqual(person, before);
  assert.throws(() => demographicTraits({ alleles: [0.5] }), RangeError); assert.throws(() => initialDemography(-1), RangeError);
});

interface ExperimentalIndividual { id: string; genome: Genome; }
interface ExperimentSample { generation: number; meanResilience: number; variance: number; meanFoodDemand: number; meanCooldown: number; }
function summarize(cohort: ExperimentalIndividual[], generation: number): ExperimentSample {
  const traits = cohort.map(p => demographicTraits(p.genome)), mean = traits.reduce((sum, t) => sum + t.resilience, 0) / traits.length;
  return { generation, meanResilience: mean, variance: traits.reduce((sum, t) => sum + (t.resilience - mean) ** 2, 0) / traits.length,
    meanFoodDemand: traits.reduce((sum, t) => sum + t.foodDemand, 0) / traits.length,
    meanCooldown: traits.reduce((sum, t) => sum + t.fertilityCooldown, 0) / traits.length };
}

/** Isolated genetic experiment, not a claim about the autonomous world's resource economy.
 * Both arms share founder alleles, random draws, meiosis and mutations. The selection arm weights
 * parents by measured survival and adult condition after the same imposed exposure assay; the
 * neutral ablation samples uniformly regardless of assay score. No skills or rewards enter DNA. */
function selectionExperiment(seed: number, selected: boolean): ExperimentSample[] {
  let cohort = Array.from({ length: 64 }, (_, i) => ({ id: `founder-${i}`, genome: genome(0.05 + i / 63 * 0.9, 0.5, `founder-${i}`) }));
  const samples = [summarize(cohort, 0)];
  for (let generation = 1; generation <= 8; generation++) {
    const weights = cohort.map(person => {
      const traits = demographicTraits(person.genome);
      let body: DemographicActor = { ...actor(), traits, state: initialDemography(DAY * 3) };
      let result = updateDemography(body, safe, 0);
      for (let day = 0; day < 3 && !result.death; day++) { result = updateDemography(body, { ...safe, exposure: 1 }, DAY); body = { ...body, state: result.state }; }
      const fitness = result.offspringEligible ? result.state.health * result.state.vitality * DAY / traits.fertilityCooldown : 0;
      return selected ? fitness : 1;
    });
    assert.ok(weights.filter(w => w > 0).length >= 2, 'the imposed assay must leave two independently selectable parents');
    const random = localRandom(seed, `paired-parent-draws:${generation}`);
    const pick = (excluded = -1): number => {
      const total = weights.reduce((sum, value, index) => sum + (index === excluded ? 0 : value), 0);
      let roll = random() * total;
      for (let i = 0; i < weights.length; i++) { if (i === excluded) continue; roll -= weights[i]!; if (roll < 0) return i; }
      for (let i = weights.length - 1; i >= 0; i--) if (i !== excluded && weights[i]! > 0) return i;
      throw new Error('No eligible second parent in the controlled experiment.');
    };
    cohort = Array.from({ length: 64 }, (_, i) => {
      const a = pick(), b = pick(a), id = `g${generation}-child-${i}`;
      const inherited = inheritGenome(seed, id, [cohort[a]!, cohort[b]!]); assertGenome(inherited);
      assert.equal(inherited.generation, generation); assert.deepEqual(inherited.parents, [cohort[a]!.id, cohort[b]!.id]);
      return { id, genome: inherited };
    });
    samples.push(summarize(cohort, generation));
  }
  return samples;
}

test('paired eight-generation experiment changes inherited distributions under selection, beyond neutral drift', context => {
  const results = [119, 431, 991, 1601].map(seed => ({ seed, selected: selectionExperiment(seed, true), neutral: selectionExperiment(seed, false) }));
  const selected = results.reduce((sum, result) => sum + result.selected.at(-1)!.meanResilience, 0) / results.length;
  const neutral = results.reduce((sum, result) => sum + result.neutral.at(-1)!.meanResilience, 0) / results.length;
  for (const result of results) {
    close(result.selected[0]!.meanResilience, result.neutral[0]!.meanResilience);
    assert.ok(result.selected.at(-1)!.meanResilience > result.neutral.at(-1)!.meanResilience + 0.2);
    assert.ok(result.selected.at(-1)!.meanFoodDemand > result.neutral.at(-1)!.meanFoodDemand);
    assert.ok(result.selected.at(-1)!.meanCooldown > result.neutral.at(-1)!.meanCooldown);
    assert.ok(result.selected.at(-1)!.variance > 0, 'recombination and mutation have not been replaced by one fixed label');
  }
  assert.ok(selected > neutral + 0.25); assert.ok(Math.abs(neutral - 0.5) < 0.12);
  assert.deepEqual(selectionExperiment(431, true), results[1]!.selected);
  context.diagnostic(JSON.stringify({ experiment: 'paired-inherited-selection', seeds: results.map(r => r.seed), generations: 8, cohort: 64,
    initialMean: 0.5, selectedMean: selected, neutralMean: neutral, difference: selected - neutral,
    limitation: 'controlled exposure assay and weighted parent selection; not evidence of open-ended autonomous evolution' }));
});
