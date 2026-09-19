import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorld, cloneWorld, createWorld, stepWorld, type Person } from '../src/world/index.js';
import { demographicTraits, initialDemography, updateDemography } from '../src/world/demography.js';
import { availableToShare, chooseReproductivePartner, closeKin, familyOpportunity, FAMILY_RESERVE_TARGET, pairAffinity, reproductiveReadiness } from '../src/world/family.js';
import { DEFAULT_PARAMS, paramsOf, parseParams, setParams } from '../src/world/params.js';
import { founderGenome } from '../src/world/genetics.js';

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

test('mutual local trust allows different communities without inventing affiliation or trust', () => {
  const { world, a, b } = scene();
  assert.equal(familyOpportunity(world, a)?.partner, b);
  delete b.bonds[a.id]; assert.equal(familyOpportunity(world, a), null);
  b.bonds[a.id] = 0.3; a.bonds[b.id] = 0.299; assert.equal(familyOpportunity(world, a), null);
  a.bonds[b.id] = 0.3; b.communityId = 'other';
  const before = structuredClone(world);
  assert.equal(familyOpportunity(world, a)?.partner, b);
  assert.equal(familyOpportunity(world, b)?.partner, a);
  assert.deepEqual(world, before, 'a prospective family cannot alter communities, bodies or trust');
  b.communityId = null; assert.equal(familyOpportunity(world, a), null);
  b.communityId = 'other'; a.communityId = null; assert.equal(familyOpportunity(world, a), null);
});

test('cross-community birth keeps both memberships and pays the same food and energy costs', () => {
  const world = createWorld(51926), a = world.people[2]!, b = world.people[3]!;
  world.tick = 599; world.communities = [];
  for (const person of world.people) {
    person.communityId = null; person.bonds = {}; person.action = 'rest'; person.decisionAt = 999;
    person.hunger = person.thirst = person.fatigue = 0.1; person.energy = 0.9;
    person.demography = initialDemography(world.tick - person.bornAt);
    person.target = { x: person.x, y: person.y };
  }
  for (const [index, person] of [a, b].entries()) {
    person.x = 17; person.y = 13; person.target = { x: 17, y: 13 }; person.inventory = 0.2;
    person.communityId = `family-test-${index}`;
    world.communities.push({ id: person.communityId, name: person.communityId, x: 17, y: 13,
      color: '#aabbcc', members: [person.id], culture: { ...person.culture }, formedAt: 0, cooperation: 0, disputes: 0 });
  }
  a.bonds[b.id] = b.bonds[a.id] = 0.7;
  const control = cloneWorld(world); control.reproductionEnabled = false;
  const missingFood = cloneWorld(world); missingFood.people[2]!.inventory = 0.09;
  const untrusted = cloneWorld(world); untrusted.people[3]!.bonds[a.id] = 0.299;
  const exhausted = cloneWorld(world); exhausted.people[3]!.energy = 0.5;
  const senescent = cloneWorld(world), elder = senescent.people[3]!;
  elder.bornAt = world.tick - demographicTraits(elder.genome).senescenceStart;
  elder.demography.age = world.tick - elder.bornAt;
  for (const blocked of [missingFood, untrusted, exhausted, senescent]) {
    stepWorld(blocked); assert.equal(blocked.totals.births, 0); assert.equal(blocked.people.length, 16);
  }
  stepWorld(control); stepWorld(world);
  assert.equal(world.totals.births, 1); assert.equal(world.people.length, 17);
  const child = world.people.at(-1)!;
  assert.deepEqual(child.genome.parents, [a.id, b.id]); assert.equal(child.bornAt, 600);
  assert.equal(a.communityId, 'family-test-0'); assert.equal(b.communityId, 'family-test-1');
  assert.equal(child.communityId, a.communityId);
  assert.deepEqual(world.communities.find(c => c.id === a.communityId)!.members, [a.id, child.id]);
  assert.deepEqual(world.communities.find(c => c.id === b.communityId)!.members, [b.id]);
  for (const parent of [a, b]) {
    const unchanged = control.people.find(p => p.id === parent.id)!;
    assert.ok(Math.abs(unchanged.inventory - parent.inventory - 0.08) < 1e-12);
    assert.ok(Math.abs(unchanged.energy - parent.energy - 0.08) < 1e-12);
  }
  assert.equal(child.inventory, 0.1); assert.deepEqual(child.skills, {}); assert.deepEqual(child.technology.knownRecipes, []);
  assertWorld(world);
});

test('partners and places stay perceptible and a place must be within four of either partner', () => {
  const { world, a, b } = scene();
  b.x = a.x + 8; assert.equal(familyOpportunity(world, a), null);
  b.x = a.x + 7; assert.equal(familyOpportunity(world, a)?.partner, b);
  world.places[0]!.x = b.x + 4; assert.equal(familyOpportunity(world, a), null);
  world.places[0]!.x = a.x + 7; assert.equal(familyOpportunity(world, a)?.partner, b);
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

function ripePerson(world: { tick: number }, person: Person): void {
  person.hunger = person.thirst = person.fatigue = 0.1; person.energy = 0.9; person.inventory = 0.2;
  person.action = 'rest'; person.decisionAt = world.tick + 999; person.target = { x: person.x, y: person.y };
  const traits = demographicTraits(person.genome);
  if (person.genome.parents.length === 0) person.bornAt = world.tick - traits.maturityAge - 10;
  person.demography = initialDemography(world.tick - person.bornAt);
  if (world.tick - person.lastBirth < traits.fertilityCooldown) person.lastBirth = Math.max(-2400, world.tick - traits.fertilityCooldown);
}

function colony(seed = 51926, extras = 0) {
  const world = createWorld(seed);
  world.tick = 599;
  const template = world.people.find(person => person.role === 'neighbor')!;
  for (let n = 0; n < extras; n++) {
    const id = `neighbor-extra-${n}`;
    const copy: Person = { ...structuredClone(template), id, name: id, genome: founderGenome(world.seed, id, template.traits), bonds: {}, communityId: null };
    world.people.push(copy);
  }
  const neighbors = world.people.filter(person => person.role === 'neighbor');
  world.communities = [{ id: 'shared', name: 'shared', x: 17, y: 13, color: '#aabbcc', members: [], culture: { ...template.culture }, formedAt: 0, cooperation: 0, disputes: 0 }];
  for (const [index, person] of neighbors.entries()) {
    person.x = 17; person.y = 13;
    person.communityId = 'shared'; person.bonds = {};
    ripePerson(world, person);
    world.communities[0]!.members.push(person.id);
  }
  for (const a of neighbors) for (const b of neighbors) if (a !== b) a.bonds[b.id] = 0.3;
  world.places = [{ ...world.places[0]!, x: 17, y: 13 }];
  return { world, neighbors };
}

test('affinity chooses the closer trusted partner; insertion order keeps the first eligible', () => {
  const { world, a, b, c } = scene();
  a.bonds[c.id] = c.bonds[a.id] = 0.9; b.x = a.x + 3; c.x = a.x + 1;
  const candidates = [b, c];
  assert.equal(chooseReproductivePartner(world, a, candidates, false), b);
  assert.equal(chooseReproductivePartner(world, a, candidates, true), c);
  assert.ok(pairAffinity(a, c) > pairAffinity(a, b));
  world.people.reverse();
  assert.equal(chooseReproductivePartner(world, a, [c, b], false), c);
  assert.equal(chooseReproductivePartner(world, a, [c, b], true), c);
});

test('a birth picks the affine partner rather than the first neighbor in insertion order', () => {
  const world = createWorld(51926), a = world.people[2]!, b = world.people[3]!, c = world.people[4]!;
  world.tick = 599; world.communities = [];
  for (const person of world.people) {
    person.communityId = null; person.bonds = {}; person.action = 'rest'; person.decisionAt = 999;
    ripePerson(world, person);
  }
  world.communities.push({ id: 'shared', name: 'shared', x: 17, y: 13, color: '#aabbcc', members: [a.id, b.id, c.id], culture: { ...a.culture }, formedAt: 0, cooperation: 0, disputes: 0 });
  for (const person of [a, b, c]) { person.x = 17; person.y = 13; person.target = { x: 17, y: 13 }; person.communityId = 'shared'; }
  a.bonds[b.id] = b.bonds[a.id] = 0.3; b.x = 20;
  a.bonds[c.id] = c.bonds[a.id] = 0.9; c.x = 17;
  b.bonds[c.id] = c.bonds[b.id] = 0.3;
  stepWorld(world);
  assert.equal(world.totals.births, 1);
  const child = world.people.at(-1)!;
  assert.deepEqual(child.genome.parents, [a.id, c.id]);
  const event = world.events.find(entry => entry.kind === 'birth')!;
  assert.ok(event.cause.includes(a.name) && event.cause.includes(c.name));
  assert.ok(event.cause.includes(world.places[0]!.name));
  assert.ok(event.cause.includes(`${world.places[0]!.x},${world.places[0]!.y}`));
  assertWorld(world);
});

test('direct parent-child and full siblings cannot be a reproducing pair', () => {
  const world = createWorld(51926), parent = world.people[2]!, other = world.people[3]!, siblingA = world.people[4]!, siblingB = world.people[5]!;
  world.tick = 599; world.communities = [];
  for (const person of world.people) { person.communityId = null; person.bonds = {}; ripePerson(world, person); }
  siblingA.genome = { ...structuredClone(parent.genome), generation: 1, parents: [parent.id, other.id] };
  siblingB.genome = { ...structuredClone(other.genome), generation: 1, parents: [parent.id, other.id] };
  assert.equal(closeKin(parent, siblingA), true); assert.equal(closeKin(siblingA, siblingB), true);
  assert.equal(closeKin(parent, other), false);
  world.communities.push({ id: 'kin', name: 'kin', x: 17, y: 13, color: '#aabbcc', members: [parent.id, siblingA.id], culture: { ...parent.culture }, formedAt: 0, cooperation: 0, disputes: 0 });
  for (const person of [parent, siblingA]) {
    person.x = 17; person.y = 13; person.target = { x: 17, y: 13 }; person.communityId = 'kin';
    person.bonds = { [parent.id]: 0.9, [siblingA.id]: 0.9 }; delete person.bonds[person.id];
  }
  stepWorld(world); assert.equal(world.totals.births, 0); assert.equal(world.people.length, 16);
  world.tick = 719;
  world.communities[0]!.members = [siblingA.id, siblingB.id];
  parent.communityId = null;
  for (const person of [siblingA, siblingB]) {
    person.x = 17; person.y = 13; person.target = { x: 17, y: 13 }; person.communityId = 'kin';
    person.bonds = { [siblingA.id]: 0.9, [siblingB.id]: 0.9 }; delete person.bonds[person.id];
    ripePerson(world, person);
  }
  stepWorld(world); assert.equal(world.totals.births, 0); assert.equal(world.people.length, 16);
});

test('legacy params (maxima 32, one birth per check) keep one birth per 120 ticks and a living cap of 32', () => {
  const { world, neighbors } = colony();
  setParams(world, parseParams('poblacion.maxima=32,poblacion.nacimientosPorComprobacion=1'));
  assert.equal(paramsOf(world).poblacion.maxima, 32);
  assert.equal(paramsOf(world).poblacion.intervaloComprobacionTicks, 120);
  assert.equal(paramsOf(world).poblacion.nacimientosPorComprobacion, 1);
  assert.equal(DEFAULT_PARAMS.poblacion.maxima, 40); // calibrado 2026-09-19 (ruling R14)
  stepWorld(world);
  assert.equal(world.tick % 120, 0); assert.equal(world.totals.births, 1); assert.equal(world.people.length, 17);
  const firstBirthTick = world.tick;
  stepWorld(world); assert.equal(world.totals.births, 1);
  world.tick = firstBirthTick + 118;
  for (const person of world.people) person.demography.age = world.tick - person.bornAt;
  for (const person of neighbors) { person.inventory = 0.2; person.energy = 0.9; person.hunger = person.thirst = person.fatigue = 0.1; }
  stepWorld(world); assert.equal(world.totals.births, 1); assert.equal(world.tick % 120, 119);
  stepWorld(world); assert.equal(world.totals.births, 2); assert.equal(world.people.length, 18); assert.equal(world.tick % 120, 0);
  while (world.people.length < 32 && world.totals.births < 20) {
    world.tick += 119;
    for (const person of world.people) {
      person.demography.age = world.tick - person.bornAt;
      if (person.role !== 'neighbor' || person.genome.parents.length) continue;
      person.inventory = 0.2; person.energy = 0.9; person.hunger = person.thirst = person.fatigue = 0.1;
      person.x = person.y = 17; person.target = { x: 17, y: 13 }; person.action = 'rest'; person.decisionAt = world.tick + 999;
    }
    stepWorld(world);
  }
  assert.equal(world.people.length, 32); assert.equal(world.totals.births, 16);
  const frozen = world.totals.births;
  world.tick += 119;
  for (const person of world.people) {
    person.demography.age = world.tick - person.bornAt;
    if (person.role === 'neighbor' && !person.genome.parents.length) {
      person.inventory = 0.2; person.energy = 0.9; person.x = person.y = 17; person.target = { x: 17, y: 13 };
    }
  }
  stepWorld(world);
  assert.equal(world.people.length, 32); assert.equal(world.totals.births, frozen);
});

test('two births in one check use four distinct parents when the param allows it', () => {
  const { world, neighbors } = colony();
  setParams(world, parseParams('poblacion.nacimientosPorComprobacion=2'));
  const four = neighbors.slice(0, 4);
  world.people.filter(person => !four.includes(person)).forEach(person => { person.communityId = null; });
  world.communities[0]!.members = four.map(person => person.id);
  for (const person of four) { person.x = 17; person.y = 13; person.bonds = Object.fromEntries(four.filter(other => other !== person).map(other => [other.id, 0.5])); }
  stepWorld(world);
  assert.equal(world.totals.births, 2); assert.equal(world.people.length, 18);
  const children = world.people.filter(person => person.genome.parents.length);
  assert.equal(children.length, 2);
  const parents = children.flatMap(person => person.genome.parents);
  assert.equal(new Set(parents).size, 4);
});

test('the same seed repeats the same parents in the same order', () => {
  const run = () => {
    const { world } = colony(771);
    const births: string[][] = [];
    for (let n = 0; n < 6; n++) {
      if (n) world.tick += 119;
      for (const person of world.people) {
        person.demography.age = world.tick - person.bornAt;
        if (person.role === 'neighbor' && !person.genome.parents.length) {
          person.inventory = 0.2; person.energy = 0.9; person.hunger = person.thirst = person.fatigue = 0.1;
        }
      }
      stepWorld(world);
      const child = world.people.find(person => person.bornAt === world.tick);
      if (child) births.push([...child.genome.parents]);
    }
    return births;
  };
  const first = run(), second = run();
  assert.ok(first.length >= 4);
  assert.deepEqual(first, second);
  assert.ok(first.every(pair => pair.length === 2 && pair[0] !== pair[1]));
});
