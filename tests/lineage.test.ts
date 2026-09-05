import test from 'node:test';
import assert from 'node:assert/strict';
import type { LegacyRecord } from '../src/shared/demography.js';
import type { TechnologyRecipe } from '../src/shared/technology.js';
import type { ChronicleEvent, CommunityView } from '../src/shared/types.js';
import { createWorld, type Person, type World } from '../src/world/index.js';
import { demographicTraits, initialDemography } from '../src/world/demography.js';
import { founderGenome } from '../src/world/genetics.js';
import { advancePopulation, assertLegacyRecord, assertPopulation, MAX_LEGACY_CACHE, RECENT_LEGACY_COUNT, referencedLegacy, retainLegacy } from '../src/world/lineage.js';

function emitFor(world: World) {
  return (event: Omit<ChronicleEvent, 'id' | 'tick'>): ChronicleEvent => {
    const result = { ...event, id: `e${++world.eventCounter}`, tick: world.tick }; world.events.push(result); return result;
  };
}
function scene() {
  const world = createWorld(51926); world.weather = 'clear'; world.people = world.people.slice(0, 4); world.communities = [];
  for (const person of world.people) {
    person.inventory = 0; person.materials = { wood: 0, stone: 0 }; person.hunger = person.thirst = person.fatigue = 0.1; person.energy = 0.9;
    person.demography = initialDemography(world.tick - person.bornAt); person.communityId = null; person.bonds = {};
  }
  return { world, s: world.people[0]!, i: world.people[1]!, a: world.people[2]!, b: world.people[3]!, emit: emitFor(world) };
}
function fatal(person: Person) { person.thirst = 1; person.demography = { ...person.demography, health: 1e-8, vitality: 0.1 }; }
function legacy(index: number, diedAt = index + 1): LegacyRecord {
  const genes = founderGenome(431, `dead-${index}`, { curiosity: 0.5, sociability: 0.5, industriousness: 0.5, care: 0.5, resilience: 0.5 });
  return { id: `dead-${index}`, name: `Antecesor ${index}`, role: 'neighbor', generation: 0, parents: [], bornAt: -4800, diedAt,
    cause: 'dehydration', genome: genes, traits: demographicTraits(genes), communityId: null };
}
function community(id: string, people: Person[]): CommunityView {
  return { id, name: id, x: people[0]!.x, y: people[0]!.y, color: '#abcdef', members: people.map(person => person.id),
    culture: { sharing: 0.5, stewardship: 0.5, openness: 0.5 }, formedAt: 0, cooperation: 0, disputes: 0 };
}
function alignClock(world: World, tick: number) {
  world.tick = tick; for (const person of world.people) person.demography.age = tick - person.bornAt;
}

test('a death preserves immutable identity evidence and a pending archive row while cleaning living relations', () => {
  const { world, s, i, a, b, emit } = scene();
  s.bonds[a.id] = 0.8; s.bonds[i.id] = 0.6;
  world.communities = [community('shared', [s, a]), community('departed', [b])];
  s.communityId = a.communityId = 'shared'; b.communityId = 'departed';
  const genome = structuredClone(a.genome); fatal(a); fatal(b); world.tick++;
  advancePopulation(world, { emit });
  assert.deepEqual(world.people.map(person => person.id), [s.id, i.id]); assert.equal(world.people.length, 2);
  assert.equal(world.demographyDynamics.deaths, 2); assert.equal(world.demographyDynamics.causes.dehydration, 2);
  assert.equal(world.legacy.length, 2); assert.equal(world.retiredLegacy.length, 2);
  assert.equal(s.bonds[a.id], undefined); assert.equal(s.bonds[i.id], 0.6);
  assert.deepEqual(world.communities.map(group => ({ id: group.id, members: group.members })), [{ id: 'shared', members: [s.id] }]);
  const record = world.legacy.find(row => row.id === a.id)!;
  assert.equal(record.communityId, 'shared'); assert.equal(record.diedAt, world.tick); assert.equal(record.bornAt, a.bornAt); assert.deepEqual(record.genome, genome);
  a.genome.alleles[8] = 0.123; assert.deepEqual(record.genome, genome);
  assertLegacyRecord(JSON.parse(JSON.stringify(record)), world.tick); assertPopulation(world);
  const queue = world.retiredLegacy, deaths = world.demographyDynamics.deaths;
  world.tick++; advancePopulation(world, { emit });
  assert.equal(world.retiredLegacy, queue); assert.equal(world.retiredLegacy.length, 2); assert.equal(world.demographyDynamics.deaths, deaths);
  assert.equal(world.events.filter(event => event.kind === 'death').length, 2);
});

test('protected identities retain continuity while the same physiological crisis removes an ordinary neighbor', () => {
  const { world, s, a, emit } = scene(); fatal(s); fatal(a); world.tick++;
  advancePopulation(world, { emit });
  assert.ok(world.people.includes(s)); assert.ok(!world.people.includes(a)); assert.equal(s.demography.deathCause, null); assert.ok(s.demography.health > 0);
  assert.equal(world.demographyDynamics.deaths, 1); assert.equal(world.retiredLegacy[0]!.id, a.id); assert.equal(s.thirst, 1);
  assertPopulation(world);
});

test('all simultaneous deaths are marked before the estate callback and materials remain its explicit responsibility', () => {
  const { world, s, a, b, emit } = scene(); fatal(a); fatal(b); a.inventory = 0.2; a.materials = { wood: 3, stone: 2 }; world.tick++;
  const calls: string[] = [], before = structuredClone(a.demography);
  assert.throws(() => advancePopulation(world, { emit }), /liquidación explícita/);
  assert.deepEqual(a.demography, before); assert.equal(world.retiredLegacy.length, 0); assert.ok(world.people.includes(a));
  advancePopulation(world, { emit, beforeDeath: (host, person) => {
    calls.push(person.id); assert.ok(host.people.includes(person)); assert.equal(a.demography.deathCause, 'dehydration'); assert.equal(b.demography.deathCause, 'dehydration');
    // Controlled callback books unrecovered stocks as losses; the production callback owns proximity/caps/transfers.
    host.demographyDynamics.foodLost += person.inventory; host.demographyDynamics.woodLost += person.materials.wood; host.demographyDynamics.stoneLost += person.materials.stone;
    person.inventory = 0; person.materials.wood = person.materials.stone = 0;
  } });
  assert.deepEqual(calls, [a.id, b.id].sort()); assert.equal(world.demographyDynamics.foodLost, 0.2); assert.equal(world.demographyDynamics.woodLost, 3); assert.equal(world.demographyDynamics.stoneLost, 2);
  assert.equal(s.inventory, 0); assert.equal(s.materials.wood, 0); assert.equal(world.retiredLegacy.length, 2); assertPopulation(world);
});

test('references include dead direct parents and inventors but exclude living identities and unrelated ancestors', () => {
  const { world, s, a } = scene();
  a.genome = { ...a.genome, generation: 1, parents: ['dead-parent', s.id] };
  world.blueprints.push({ ...world.blueprints[0]!, id: 'example-blueprint', inventorId: 'dead-builder' });
  world.technology.recipes = [{ id: 'example-recipe', inventorId: 'dead-maker' } as TechnologyRecipe];
  world.legacy = [{ ...legacy(1), id: 'unrelated-ancestor' }];
  assert.deepEqual([...referencedLegacy(world)].sort(), ['dead-builder', 'dead-maker', 'dead-parent']);
});

test('retention keeps required identities plus exactly 32 recent deaths without consuming the pending queue', () => {
  const { world, a } = scene(); alignClock(world, 2000);
  const records = Array.from({ length: 1000 }, (_, index) => legacy(index)); world.legacy = [...records]; world.retiredLegacy = [...records];
  world.demographyDynamics.deaths = world.demographyDynamics.causes.dehydration = records.length;
  a.genome = { ...a.genome, generation: 1, parents: ['dead-0', 'dead-1'] };
  // This fixture stresses only identity references, not blueprint/technology grammar.
  world.blueprints = Array.from({ length: 64 }, (_, index) => ({ ...world.blueprints[0]!, id: `blueprint-ref-${index}`, inventorId: `dead-${index + 2}` }));
  world.technology.recipes = Array.from({ length: 256 }, (_, index) => ({ id: `recipe-ref-${index}`, inventorId: `dead-${index + 66}` } as TechnologyRecipe));
  const queue = world.retiredLegacy, serialized = JSON.stringify(queue), required = referencedLegacy(world);
  retainLegacy(world);
  assert.equal(world.legacy.length, 2 + 64 + 256 + RECENT_LEGACY_COUNT); assert.ok(world.legacy.length <= MAX_LEGACY_CACHE);
  assert.ok([...required].every(id => world.legacy.some(record => record.id === id)));
  assert.ok(records.slice(-RECENT_LEGACY_COUNT).every(record => world.legacy.includes(record)));
  assert.equal(world.retiredLegacy, queue); assert.equal(JSON.stringify(queue), serialized); assertPopulation(world);
  const once = [...world.legacy]; retainLegacy(world); assert.deepEqual(world.legacy, once);
  a.genome = { ...a.genome, generation: 0, parents: [] }; world.blueprints = []; world.technology.recipes = [];
  retainLegacy(world); assert.equal(world.legacy.length, RECENT_LEGACY_COUNT); assert.equal(world.retiredLegacy.length, 1000);
});

test('cache pressure never silently drops a required identity', () => {
  const { world } = scene(); alignClock(world, 1000);
  world.legacy = Array.from({ length: MAX_LEGACY_CACHE + 1 }, (_, index) => legacy(index));
  world.technology.recipes = world.legacy.map(record => ({ inventorId: record.id } as TechnologyRecipe));
  const previous = world.legacy;
  assert.throws(() => retainLegacy(world), /no se descartaron ancestros/); assert.equal(world.legacy, previous);
});

test('legacy validation rejects future evidence, genetic inconsistencies, malformed IDs and extra data', () => {
  const valid = legacy(4); assertLegacyRecord(valid, 5);
  for (const change of [
    (record: LegacyRecord) => { record.diedAt = 6; },
    (record: LegacyRecord) => { record.bornAt = 6; },
    (record: LegacyRecord) => { record.id = 'id with spaces'; },
    (record: LegacyRecord) => { record.genome.alleles[8] = Number.NaN; },
    (record: LegacyRecord) => { record.traits.foodDemand += 0.01; },
    (record: LegacyRecord) => { record.generation = 1; record.parents = ['parent-a', 'parent-b']; },
    (record: LegacyRecord) => { record.parents = [record.id, record.id]; },
    (record: LegacyRecord) => { record.cause = 'senescence'; },
    (record: LegacyRecord) => { (record as unknown as Record<string, unknown>).privateHistory = 'not part of identity'; },
  ]) { const corrupt = structuredClone(valid); change(corrupt); assert.throws(() => assertLegacyRecord(corrupt, 5)); }
  const child = { ...structuredClone(valid), generation: 1, parents: ['parent-a', 'parent-b'] };
  child.genome = { ...child.genome, generation: 1, parents: [...child.parents] }; assertLegacyRecord(child, 5);
  child.genome.parents.reverse(); assert.throws(() => assertLegacyRecord(child, 5));
});

test('population validation rejects dead identities reappearing, duplicate rows and inconsistent death totals', () => {
  const { world, a, emit } = scene(); fatal(a); world.tick++; advancePopulation(world, { emit }); assertPopulation(world);
  const original = structuredClone(world);
  for (const change of [
    (state: World) => { state.people.push({ ...a, demography: initialDemography(state.tick - a.bornAt) }); },
    (state: World) => { state.legacy.push(structuredClone(state.legacy[0]!)); },
    (state: World) => { state.retiredLegacy.push(structuredClone(state.retiredLegacy[0]!)); },
    (state: World) => { state.demographyDynamics.deaths++; },
    (state: World) => { state.demographyDynamics.foodLost = -1; },
    (state: World) => { state.people[0]!.demography.age++; },
    (state: World) => { state.people[0]!.demography.health = 0; },
    (state: World) => { state.retiredLegacy[0] = { ...state.retiredLegacy[0]!, name: 'Conflicting identity' }; },
  ]) { const corrupt = structuredClone(original); change(corrupt); assert.throws(() => assertPopulation(corrupt)); }
  world.people.push({ ...a, demography: initialDemography(world.tick - a.bornAt) });
  const deaths = world.demographyDynamics.deaths;
  assert.throws(() => advancePopulation(world, { emit }), /fallecida reapareció/); assert.equal(world.demographyDynamics.deaths, deaths);
});
