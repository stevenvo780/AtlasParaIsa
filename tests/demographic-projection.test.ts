import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, projectWorld } from '../src/world/index.js';
import { demographicTraits } from '../src/world/demography.js';

test('life stages use each inherited maturity and senescence boundary without changing the World or its RNG', () => {
  for (const seed of [51926, 42, 20260905]) {
    const world = createWorld(seed);
    // Boundary fixtures only: no engine actions, births or survival claims.
    for (const person of world.people.slice(0, 4)) {
      const traits = demographicTraits(person.genome);
      for (const [age, stage] of [
        [0, 'juvenile'], [traits.maturityAge - 1, 'juvenile'], [traits.maturityAge, 'adult'],
        [traits.senescenceStart - 1, 'adult'], [traits.senescenceStart, 'senescent'],
        [traits.maximumAge + 1, 'senescent'],
      ] as const) {
        person.demography.age = age; person.bornAt = world.tick - age;
        const before = structuredClone(world);
        const projected = projectWorld(world).people.find(p => p.id === person.id)!;
        assert.equal(projected.lifeStage, stage);
        assert.equal(projected.continuityProtected, person.role !== 'neighbor');
        assert.ok(!Object.hasOwn(projected.genome!, 'alleles'), 'inherited raw parameters remain private');
        assert.deepEqual(world, before, 'projection changes neither state nor the saved random stream');
      }
    }
  }
});

test('same generation and age can have different life stages because inherited thresholds differ', () => {
  const world = createWorld(51926);
  const neighbors = world.people.filter(p => p.role === 'neighbor');
  for (const boundary of ['maturityAge', 'senescenceStart'] as const) {
    const ordered = [...neighbors].sort((a, b) => demographicTraits(a.genome)[boundary] - demographicTraits(b.genome)[boundary]);
    const earlier = ordered[0]!, later = ordered.at(-1)!;
    const age = demographicTraits(earlier.genome)[boundary];
    assert.ok(age < demographicTraits(later.genome)[boundary]);
    for (const person of [earlier, later]) { person.demography.age = age; person.bornAt = world.tick - age; }
    const view = projectWorld(world), a = view.people.find(p => p.id === earlier.id)!, b = view.people.find(p => p.id === later.id)!;
    assert.equal(a.age, b.age); assert.equal(a.genome!.generation, b.genome!.generation);
    assert.equal(a.lifeStage, boundary === 'maturityAge' ? 'adult' : 'senescent');
    assert.equal(b.lifeStage, boundary === 'maturityAge' ? 'juvenile' : 'adult');
  }
});

test('the age-stage census includes every human regardless of camera and is not a snapshot field', () => {
  const world = createWorld(42), before = structuredClone(world);
  const local = projectWorld(world), distant = projectWorld(world, { x: 500, y: -500, width: 20, height: 20 });
  assert.deepEqual(local.people, distant.people);
  assert.equal(local.people.length, world.people.length);
  assert.ok(local.people.every(p => p.lifeStage !== undefined));
  local.people[0]!.lifeStage = 'senescent';
  assert.deepEqual(world, before);
  assert.ok(world.people.every(p => !Object.hasOwn(p, 'lifeStage')), 'stage is derived, not a new durable physical variable');
});
