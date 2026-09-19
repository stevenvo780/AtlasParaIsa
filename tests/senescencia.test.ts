import test from 'node:test';
import assert from 'node:assert/strict';
import type { DemographicActor, DemographicTransition, SenescenceLaw } from '../src/shared/demography.js';
import { demographicTraits, DEMOGRAPHY_TICKS_PER_DAY as DAY, initialDemography,
  PROTECTED_HEALTH_FLOOR, PROTECTED_VITALITY_FLOOR, updateDemography } from '../src/world/demography.js';
import { DEFAULT_PARAMS } from '../src/world/params.js';

const traits = demographicTraits({ alleles: Array<number>(14).fill(0.5) });
const safe = { exposure: 0, shelter: 0, protected: false } as const;
function body(age: number, health = 1, vitality = 1, id = 'subject'): DemographicActor {
  return { id, state: { ...initialDemography(age), health, vitality }, traits, hunger: 0.1, thirst: 0.1, energy: 0.85, fatigue: 0.1 };
}
function forcedDeathAge(seed: number, health: number, vitality: number, dt: number): number | null {
  let age = traits.senescenceStart;
  while (age < traits.maximumAge * 2) {
    const result = updateDemography(body(age, health, vitality), { ...safe, seed, tick: age }, Math.min(dt, traits.maximumAge * 2 - age));
    if (result.death) { assert.equal(result.death, 'senescence'); return result.state.age; }
    age = result.state.age;
  }
  return null;
}
function cohort(dt: number, health: number, vitality: number): number[] {
  return Array.from({ length: 2000 }, (_, seed) => forcedDeathAge(seed, health, vitality, dt)).filter((age): age is number => age !== null);
}
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

test('maximum age is a risk threshold rather than a death decree', context => {
  let risk = 0, deaths = 0;
  for (let seed = 0; seed < 2000; seed++) {
    const result = updateDemography(body(traits.maximumAge), { ...safe, seed, tick: traits.maximumAge }, 1);
    risk = result.senescenceRisk; if (result.death) deaths++;
  }
  assert.ok(risk > 0); assert.equal(deaths, 0);
  context.diagnostic(JSON.stringify({ seeds: 2000, age: traits.maximumAge, dt: 1, senescenceRisk: risk, deaths }));
});

test('care separates cumulative mortality without making healthy elders immortal', context => {
  const neglected = cohort(240, 0.2, 0.2), full = cohort(240, 1, 1);
  const neglectedFraction = neglected.length / 2000, fullFraction = full.length / 2000;
  assert.ok(neglectedFraction > 0.95); assert.ok(fullFraction > 0.05 && fullFraction < 0.5); assert.ok(fullFraction < neglectedFraction);
  context.diagnostic(JSON.stringify({ seeds: 2000, dt: 240, neglectedFraction, fullFraction,
    neglectedMedianDeathAge: median(neglected), fullMedianDeathAge: median(full) }));
});

test('senescence draws are deterministic, identity-scoped and independent of wall clock', () => {
  const person = body(traits.maximumAge * 2, 1, 1, 'same'), environment = { ...safe, seed: 431, tick: 99 };
  const first = updateDemography(person, environment, DAY), second = updateDemography(person, environment, DAY);
  assert.deepEqual(first, second);
  const originalNow = Date.now;
  try { Date.now = () => { throw new Error('wall clock used'); }; assert.deepEqual(updateDemography(person, environment, DAY), first); }
  finally { Date.now = originalNow; }
  let identityScoped = false;
  for (let seed = 0; seed < 200 && !identityScoped; seed++) {
    const a = updateDemography(body(traits.maximumAge * 2, 1, 1, 'a'), { ...safe, seed, tick: 99 }, DAY);
    const b = updateDemography(body(traits.maximumAge * 2, 1, 1, 'b'), { ...safe, seed, tick: 99 }, DAY);
    identityScoped = a.death !== b.death;
  }
  assert.equal(identityScoped, true);
});

test('exact integrated hazard is stable across step sizes', context => {
  const fine = cohort(240, 1, 1).length / 2000, coarse = cohort(480, 1, 1).length / 2000;
  assert.ok(Math.abs(fine - coarse) < 0.05);
  context.diagnostic(JSON.stringify({ seeds: 2000, fineDt: 240, coarseDt: 480, fine, coarse, difference: Math.abs(fine - coarse) }));
});

test('external continuity protection still preserves S and I bodies', () => {
  for (const id of ['S', 'I']) {
    const result = updateDemography(body(traits.maximumAge * 3, 0.00001, 0.01, id),
      { ...safe, protected: true, seed: 17, tick: traits.maximumAge * 3 }, 1);
    assert.equal(result.death, null); assert.equal(result.preventedDeath, 'senescence'); assert.equal(result.state.deathCause, null);
    assert.equal(result.state.health, PROTECTED_HEALTH_FLOOR); assert.equal(result.state.vitality, PROTECTED_VITALITY_FLOOR);
  }
});

test('senescence wear is gradual at maximum age and increases monotonically', () => {
  const noHazard: SenescenceLaw = { ...DEFAULT_PARAMS.cuerpo, riesgoSenescenciaDiario: 0 };
  const ages = [traits.senescenceStart, Math.floor((traits.senescenceStart + traits.maximumAge) / 2), traits.maximumAge];
  const damage = ages.map(age => updateDemography(body(age), { ...safe, senescence: noHazard }, 1).damage.senescence);
  assert.ok(damage[0]! < damage[1]! && damage[1]! < damage[2]!);
  const crossing = updateDemography(body(traits.maximumAge - 1), { ...safe, senescence: noHazard }, 1);
  const healthLoss = 1 - crossing.state.health;
  assert.equal(crossing.death, null); assert.ok(healthLoss > 0 && healthLoss < 0.01);
});

test('neglected old bodies still die from senescence without rescue', () => {
  for (let seed = 0; seed < 20; seed++) {
    let person = { ...body(traits.senescenceStart, 0.2, 0.2, `neglected-${seed}`), hunger: 0.7, thirst: 0.65, energy: 0.2, fatigue: 0.8 };
    let result: DemographicTransition = updateDemography(person, { ...safe, seed, tick: person.state.age }, 0);
    while (!result.death && person.state.age < traits.maximumAge * 3) {
      result = updateDemography(person, { ...safe, seed, tick: person.state.age }, Math.min(240, traits.maximumAge * 3 - person.state.age));
      person = { ...person, state: result.state };
    }
    assert.equal(result.death, 'senescence'); assert.ok(result.state.age < traits.maximumAge * 3);
  }
});

test('an unbounded age saturates the risk at certainty and never loops back into immunity', () => {
  for (const multiple of [2, 15, 200, 5000]) {
    const result = updateDemography(body(traits.maximumAge * multiple), { ...safe, seed: 7, tick: 7 }, 1);
    assert.ok(result.senescenceRisk > 0, `edad ${multiple}× maximumAge no puede tener riesgo nulo`);
  }
  assert.equal(updateDemography(body(traits.maximumAge * 200), { ...safe, seed: 7, tick: 7 }, 1).senescenceRisk, 1);
});

test('optional deterministic hazard inputs reject invalid values', () => {
  const invalidId = { ...body(0), id: 42 } as unknown as DemographicActor;
  assert.throws(() => updateDemography(invalidId, safe), RangeError);
  assert.throws(() => updateDemography(body(0), { ...safe, seed: 1.5 }), RangeError);
  assert.throws(() => updateDemography(body(0), { ...safe, tick: Number.POSITIVE_INFINITY }), RangeError);
  assert.throws(() => updateDemography(body(0), { ...safe, senescence: { ...DEFAULT_PARAMS.cuerpo, riesgoSenescenciaDiario: -1 } }), RangeError);
  assert.throws(() => updateDemography(body(0), { ...safe, senescence: { ...DEFAULT_PARAMS.cuerpo, cuidadoReduceRiesgo: 2 } }), RangeError);
});
