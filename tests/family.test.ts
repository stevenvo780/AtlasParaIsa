import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, type Person } from '../src/world/index.js';
import { demographicTraits, initialDemography, updateDemography } from '../src/world/demography.js';
import { availableToShare, familyOpportunity, FAMILY_RESERVE_TARGET, reproductiveReadiness } from '../src/world/family.js';

function scene() {
  const world = createWorld(51926);
  world.tick = 6000;
  const [a, b, c] = world.people.filter(person => person.role === 'neighbor').slice(0, 3) as [Person, Person, Person];
  world.people = [a, b, c];
  for (const [index, person] of world.people.entries()) {
    person.x = 8 + index; person.y = 10; person.communityId = 'shared'; person.bonds = {};
    person.hunger = person.thirst = person.fatigue = 0.1; person.energy = 0.9; person.inventory = 0;
    person.demography = initialDemography(world.tick - person.bornAt);
    person.lastBirth = world.tick - demographicTraits(person.genome).fertilityCooldown;
  }
  a.bonds[b.id] = b.bonds[a.id] = 0.3;
  world.places = [{ ...world.places[0]!, x: 8, y: 10 }];
  return { world, a, b, c };
}

test('readiness queries the existing demographic gate exactly and ignores inventory', () => {
  const { world, a } = scene();
  const traits = demographicTraits(a.genome);
  const ready = () => updateDemography({ state: a.demography, traits, hunger: a.hunger, thirst: a.thirst,
    energy: a.energy, fatigue: a.fatigue }, { exposure: 0, shelter: 0, protected: false }, 0).offspringEligible;
  assert.equal(a.inventory, 0); assert.equal(reproductiveReadiness(world, a), true);
  const before = structuredClone(a);
  const changes: ((person: Person) => void)[] = [
    p => { p.demography.age = traits.maturityAge - 1; },
    p => { p.demography.age = traits.senescenceStart; },
    p => { p.demography.health = 0.549; }, p => { p.demography.vitality = 0.499; },
    p => { p.hunger = 0.451; }, p => { p.thirst = 0.451; },
    p => { p.energy = 0.599; }, p => { p.fatigue = 0.651; },
  ];
  for (const change of changes) {
    Object.assign(a, structuredClone(before)); change(a);
    assert.equal(ready(), false); assert.equal(reproductiveReadiness(world, a), ready());
  }
  Object.assign(a, before);
  a.demography.age = traits.maturityAge; a.demography.health = 0.55; a.demography.vitality = 0.5;
  a.hunger = a.thirst = 0.45; a.energy = 0.6; a.fatigue = 0.65;
  assert.equal(reproductiveReadiness(world, a), true);
});

test('cooldown is inherited, inclusive at its boundary, and protected roles cannot be prospective parents', () => {
  const { world, a, b } = scene();
  const cooldown = demographicTraits(a.genome).fertilityCooldown;
  a.lastBirth = world.tick - cooldown + 1;
  assert.equal(reproductiveReadiness(world, a), false); assert.equal(familyOpportunity(world, b), null);
  a.lastBirth--; assert.equal(reproductiveReadiness(world, a), true);
  for (const role of ['S', 'I'] as const) {
    a.role = role; assert.equal(reproductiveReadiness(world, a), false); assert.equal(familyOpportunity(world, a), null);
    assert.equal(familyOpportunity(world, b), null);
  }
});

test('an opportunity requires observed mutual trust and the same nonempty community', () => {
  const { world, a, b } = scene();
  assert.equal(familyOpportunity(world, a)?.partner, b);
  delete b.bonds[a.id]; assert.equal(familyOpportunity(world, a), null);
  b.bonds[a.id] = 0.3; a.bonds[b.id] = 0.299; assert.equal(familyOpportunity(world, a), null);
  a.bonds[b.id] = 0.3; b.communityId = 'other'; assert.equal(familyOpportunity(world, a), null);
  b.communityId = a.communityId = null; assert.equal(familyOpportunity(world, a), null);
});

test('perception stops at seven and a known place must be within four of either partner', () => {
  const { world, a, b } = scene();
  b.x = a.x + 8; assert.equal(familyOpportunity(world, a), null);
  b.x = a.x + 7; assert.equal(familyOpportunity(world, a)?.partner, b);
  world.places[0]!.x = b.x + 4; assert.equal(familyOpportunity(world, a)?.partner, b);
  world.places[0]!.x++; assert.equal(familyOpportunity(world, a), null);
  world.places = []; assert.equal(familyOpportunity(world, a), null);
});

test('both bodies must be ready and disabling reproduction releases the intent without changing physiology', () => {
  const { world, a, b } = scene();
  b.demography.health = 0.54; assert.equal(familyOpportunity(world, a), null);
  b.demography.health = 1; b.hunger = 0.46; assert.equal(familyOpportunity(world, a), null);
  b.hunger = 0.1; assert.ok(familyOpportunity(world, a));
  world.reproductionEnabled = false;
  assert.equal(familyOpportunity(world, a), null); assert.equal(reproductiveReadiness(world, a), true);
});

test('partner selection uses distance then identity without depending on array order or global population capacity', () => {
  const { world, a, b, c } = scene();
  a.bonds[c.id] = c.bonds[a.id] = 0.3;
  b.x = a.x - 1; c.x = a.x + 1;
  const selected = [b, c].sort((x, y) => x.id.localeCompare(y.id))[0]!;
  assert.equal(familyOpportunity(world, a)?.partner, selected);
  world.people.reverse(); assert.equal(familyOpportunity(world, a)?.partner, selected);
  c.x = a.x; assert.equal(familyOpportunity(world, a)?.partner, c);
  world.people.push(...Array.from({ length: 30 }, (_, index) => ({ ...structuredClone(b), id: `remote-${index}`, x: 1000, communityId: null })));
  assert.ok(world.people.length > 32); assert.equal(familyOpportunity(world, a)?.partner, c);
});

test('ordinary sharing preserves a viable local reserve and permits only the actual surplus', () => {
  const { world, a, b } = scene();
  for (const stock of [0, 0.024, 0.025, 0.12, 0.144]) {
    a.inventory = stock; assert.equal(availableToShare(world, a, b), false);
  }
  a.inventory = FAMILY_RESERVE_TARGET + 0.025;
  assert.equal(availableToShare(world, a, b), true);
  assert.equal(a.inventory, 0.145);
  a.inventory = 0.025; world.reproductionEnabled = false;
  assert.equal(availableToShare(world, a, b), true);
  world.reproductionEnabled = true; b.x = a.x + 8;
  assert.equal(availableToShare(world, a, b), true);
  a.inventory = 0.024; assert.equal(availableToShare(world, a, b), false);
});

test('urgent recipient hunger can use an earmarked reserve but never invents a minimum share', () => {
  const { world, a, b, c } = scene();
  a.inventory = 0.025;
  // The ready partner b keeps the family intent active while a different recipient needs care.
  c.hunger = 0.799; assert.ok(familyOpportunity(world, a)); assert.equal(availableToShare(world, a, c), false);
  c.hunger = 0.8; assert.equal(availableToShare(world, a, c), true);
  a.inventory = 0.024; assert.equal(availableToShare(world, a, c), false);
  assert.equal(b.inventory, 0); assert.equal(c.hunger, 0.8);
});

test('queries leave age, bodies, resources, projects, knowledge and random state unchanged', () => {
  const { world, a, b } = scene();
  // No ambient food exists in this control: an intent is not a harvest or a birth.
  for (const tile of world.tiles) tile.food = 0;
  const before = structuredClone(world);
  for (let n = 0; n < 3; n++) {
    assert.equal(reproductiveReadiness(world, a), true);
    assert.deepEqual(familyOpportunity(world, a), { partner: b, reserveTarget: 0.12 });
    assert.equal(availableToShare(world, a, b), false);
  }
  assert.deepEqual(world, before); assert.equal(a.inventory, 0); assert.equal(world.totals.births, 0);
});
