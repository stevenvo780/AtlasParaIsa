import test from 'node:test';
import assert from 'node:assert/strict';
import type { LegacyRecord } from '../src/shared/demography.js';
import type { StructureView } from '../src/shared/life.js';
import type { TechnologyRecipe } from '../src/shared/technology.js';
import type { ChronicleEvent, CommunityView } from '../src/shared/types.js';
import { createWorld, type Person, type World } from '../src/world/index.js';
import { demographicTraits, initialDemography, updateDemography } from '../src/world/demography.js';
import { founderGenome, inheritGenome } from '../src/world/genetics.js';
import { BROKEN_CONDITION } from '../src/world/inventions.js';
import { advancePopulation, assertLegacyRecord, assertPopulation, MAX_LEGACY_CACHE, pruneBonds, RECENT_LEGACY_COUNT, referencedLegacy, retainLegacy } from '../src/world/lineage.js';
import { paramsOf } from '../src/world/params.js';

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

test('simultaneous death events preserve the exact archived identity and position for every person', () => {
  const { world, a: template, emit } = scene();
  world.people = Array.from({ length: 160 }, (_, index): Person => {
    const person = structuredClone(template);
    person.id = `mass-death-${String(index).padStart(3, '0')}`; person.name = `Persona ${index}`;
    person.x = index % 23 - 11; person.y = Math.floor(index / 23) - 3; fatal(person);
    return person;
  });
  const before = new Map(world.people.map(person => [person.id, { x: person.x, y: person.y }]));
  world.tick++; advancePopulation(world, { emit });
  const events = world.events.filter(event => event.kind === 'death');
  assert.equal(events.length, 160); assert.equal(world.retiredLegacy.length, 160);
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!, record = world.retiredLegacy[index]!, position = before.get(record.id)!;
    assert.deepEqual(event.actors, [record.id]); assert.equal(event.x, position.x); assert.equal(event.y, position.y);
  }
});

test('indexed shelter lookup matches the original structure filter and maximum in every cell case', () => {
  const { world, a: template, emit } = scene(), cells = world.tiles.slice(0, 5);
  assert.equal(cells.length, 5); for (const tile of cells) tile.terrain = 'shelter';
  world.people = cells.map((tile, index): Person => {
    const person = structuredClone(template); person.id = `shelter-case-${index}`; person.name = `Caso ${index}`;
    person.x = tile.x; person.y = tile.y; return person;
  });
  const structure = (id: string, cell: typeof cells[number], condition: number, components: StructureView['components']): StructureView =>
    ({ id, x: cell.x, y: cell.y, blueprintId: 'blueprint-base', name: id, components, condition, water: 0, food: 0, uses: 0, builtAt: 0, builderId: null });
  world.structures = [
    structure('single-roof', cells[0]!, 0.6, ['frame', 'roof']),
    structure('lower-roof', cells[1]!, 0.35, ['frame', 'roof']), structure('higher-roof', cells[1]!, 0.9, ['frame', 'roof']),
    structure('broken-roof', cells[2]!, BROKEN_CONDITION, ['frame', 'roof']),
    structure('roofless', cells[3]!, 0.95, ['frame']),
  ];
  world.weather = 'rain'; world.shelterBenefitEnabled = true; world.tick++;
  const law = paramsOf(world).cuerpo;
  const shelters = world.people.map(person => Math.max(0, ...world.structures
    .filter(item => item.x === person.x && item.y === person.y && item.condition > BROKEN_CONDITION && item.components.includes('roof'))
    .map(item => item.condition)));
  assert.deepEqual(shelters, [0.6, 0.9, 0, 0, 0]);
  const expected = new Map(world.people.map((person, index) => [person.id, updateDemography({ id: person.id, state: person.demography,
    traits: demographicTraits(person.genome, law), hunger: person.hunger, thirst: person.thirst, fatigue: person.fatigue, energy: person.energy },
  { exposure: 1, shelter: shelters[index]!, protected: false, seed: world.seed, tick: world.tick, senescence: law }, 1).state]));
  advancePopulation(world, { emit });
  assert.equal(world.people.length, expected.size);
  for (const person of world.people) assert.deepEqual(person.demography, expected.get(person.id));
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

/** T142: la poda de siempre, literal, como referencia de identidad (valores y orden de claves). */
function oldPrune(survivors: readonly Person[], departed: readonly Person[]) {
  const ids = new Set(departed.map(person => person.id));
  for (const person of survivors) for (const id of ids) delete person.bonds[id];
}
function mulberry32(seed: number) {
  return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const entries = (people: readonly Person[]) => people.map(person => [person.id, Object.entries(person.bonds)]);

test('T142: tras 1 000 muertes entre 2 000 personas los bonds quedan idénticos, orden de claves incluido, a la poda de siempre', () => {
  const { world, s, i, a: template, emit } = scene(); const random = mulberry32(142);
  const integerIds = new Map([[7, '7'], [42, '42'], [1000, '1000'], [1500, '3']]);
  world.people = [s, i, ...Array.from({ length: 1998 }, (_, n): Person => ({ ...structuredClone(template), id: integerIds.get(n) ?? `t142-${n}`, bonds: {} }))];
  const pick = () => world.people[Math.floor(random() * world.people.length)]!;
  for (const person of world.people) for (let k = Math.floor(random() * 31); k > 0; k--) {
    const other = pick(), value = Math.round(random() * 1000) / 1000;
    person.bonds[other.id] = value; if (random() < 0.7) other.bonds[person.id] = value;
  }
  const neighbors = world.people.slice(2), dying = new Set<Person>();
  while (dying.size < 1000) dying.add(neighbors[Math.floor(random() * neighbors.length)]!);
  const hub = neighbors.find(person => !dying.has(person))!, lonely = [...dying][0]!;
  for (const person of [...dying].slice(1, 301)) hub.bonds[person.id] = 0.5; // unidireccionales entrantes a fallecidos
  for (const person of world.people) delete person.bonds[lonely.id];
  lonely.bonds = {}; hub.bonds[hub.id] = 0.4;
  for (const person of dying) fatal(person);
  const reference = structuredClone(world.people), gone = new Set([...dying].map(person => person.id));
  const departed = reference.filter(person => gone.has(person.id)), survivors = reference.filter(person => !gone.has(person.id));
  const deadBonds = [...dying].map(person => Object.entries(person.bonds));
  oldPrune(survivors, departed);
  world.tick++; advancePopulation(world, { emit });
  assert.equal(world.demographyDynamics.deaths, 1000); assert.equal(world.people.length, 1000);
  assert.deepStrictEqual(entries(world.people), entries(survivors));
  assert.deepStrictEqual([...dying].map(person => Object.entries(person.bonds)), deadBonds);
  assert.deepStrictEqual(Object.keys(hub.bonds).filter(id => gone.has(id)), []);
  assertPopulation(world);
  // Una muerte más en el mismo mundo: el otro recorrido, contra la misma referencia.
  const next = world.people.find(person => person.role === 'neighbor' && Object.keys(person.bonds).length > 0)!;
  fatal(next); const again = structuredClone(world.people), kept = again.filter(person => person.id !== next.id);
  oldPrune(kept, again.filter(person => person.id === next.id)); world.tick++; advancePopulation(world, { emit });
  assert.deepStrictEqual(entries(world.people), entries(kept));
});

test('T142: pruneBonds da lo mismo que la poda de siempre por los dos recorridos, incluidos vínculos unidireccionales', () => {
  const person = (id: string, bonds: Record<string, number> = {}) => ({ id, bonds }) as unknown as Person;
  const check = (people: Person[], dead: string[], scanned: boolean) => {
    const departed = people.filter(p => dead.includes(p.id)), survivors = people.filter(p => !dead.includes(p.id));
    const reference = structuredClone(people), deadBonds = entries(departed);
    oldPrune(reference.filter(p => !dead.includes(p.id)), reference.filter(p => dead.includes(p.id)));
    const listed = new Set<string>();
    const watched = survivors.map(p => { const bonds = p.bonds; p.bonds = new Proxy(bonds, { ownKeys: target => { listed.add(p.id); return Reflect.ownKeys(target); } }); return [p, bonds] as const; });
    pruneBonds(survivors, departed);
    for (const [p, bonds] of watched) p.bonds = bonds;
    assert.deepStrictEqual(entries(survivors), entries(reference.filter(p => !dead.includes(p.id))));
    assert.deepStrictEqual(entries(departed), deadBonds);
    // Con muchas muertes y pocos vínculos, cada superviviente recorre sus claves (barrido); si no, sondeo.
    assert.equal(survivors.every(p => listed.has(p.id)), scanned);
  };
  // Cero y una muerte: sondeo, con claves enteras mezcladas (JS las enumera antes y en orden numérico).
  const small = () => [person('x', { '10': 0.1, b: 0.2, '2': 0.3, dead: 0.4, '3': 0.5 }), person('b', { x: 0.2, '3': 0.1 }), person('3', { dead: 0.9, x: 0.5 }),
    person('dead', { x: 0.4 }), person('2'), person('10', { x: 0.1 })];
  check(small(), [], false); check(small(), ['dead'], false); check(small(), ['3'], false); check(small(), ['dead', '3'], false);
  // Cincuenta muertes con grado ~2: barrido. `keeper` guarda un vínculo unidireccional con un fallecido que no lo tiene.
  const many = Array.from({ length: 200 }, (_, n) => person(n % 17 === 0 ? String(n) : `p-${n}`));
  for (let n = 0; n < many.length; n++) { const a = many[n]!, b = many[(n * 7 + 3) % many.length]!; a.bonds[b.id] = 0.3; b.bonds[a.id] = 0.3; }
  const dead = many.filter((_, n) => n % 4 === 1).map(p => p.id), keeper = many.find(p => !dead.includes(p.id))!;
  keeper.bonds[dead[10]!] = 0.7; keeper.bonds[keeper.id] = 0.1; keeper.bonds[dead[20]!] = 0.2;
  assert.ok(!Object.hasOwn(many.find(p => p.id === dead[10])!.bonds, keeper.id));
  check(many, dead, true);
  // Muchas muertes pero grado alto: sigue siendo sondeo (más supervivientes que la muestra), mismo resultado.
  const dense = Array.from({ length: 100 }, (_, n) => person(`d-${n}`));
  dense.forEach((a, n) => dense.forEach((b, m) => { if (a !== b && (n * 31 + m) % 3 !== 0) a.bonds[b.id] = 0.5; }));
  check(dense, dense.filter((_, n) => n % 4 === 0).map(p => p.id), false);
});

test('herencia pura (mutationRate 0) combina alelos exactos de los dos padres', () => {
  const seed = 12345;
  const mockTraits = { curiosity: 0.5, sociability: 0.5, industriousness: 0.5, care: 0.5, resilience: 0.5 };
  const parentA = founderGenome(seed, 'padre', mockTraits, 0.5);
  const parentB = founderGenome(seed + 1, 'madre', mockTraits, 0.5);
  
  const child = inheritGenome(seed, 'hijo', [{ id: 'padre', genome: parentA }, { id: 'madre', genome: parentB }], 0);
  
  for (let gene = 0; gene < 7; gene++) {
    const a1 = child.alleles[gene * 2]!;
    const a2 = child.alleles[gene * 2 + 1]!;
    
    const parentAAlleles = [parentA.alleles[gene * 2]!, parentA.alleles[gene * 2 + 1]!];
    const parentBAlleles = [parentB.alleles[gene * 2]!, parentB.alleles[gene * 2 + 1]!];
    
    assert.ok(parentAAlleles.includes(a1), `Alelo ${a1} en locus ${gene} (copia 1) no proviene del padre A`);
    assert.ok(parentBAlleles.includes(a2), `Alelo ${a2} en locus ${gene} (copia 2) no proviene de la madre B`);
  }
});

test('determinismo de herencia: misma llamada da mismo resultado', () => {
  const seed = 999;
  const mockTraits = { curiosity: 0.5, sociability: 0.5, industriousness: 0.5, care: 0.5, resilience: 0.5 };
  const parentA = founderGenome(seed, 'padre', mockTraits, 0.5);
  const parentB = founderGenome(seed + 1, 'madre', mockTraits, 0.5);
  
  const child1 = inheritGenome(seed, 'hijo-det', [{ id: 'padre', genome: parentA }, { id: 'madre', genome: parentB }]);
  const child2 = inheritGenome(seed, 'hijo-det', [{ id: 'padre', genome: parentA }, { id: 'madre', genome: parentB }]);
  
  assert.deepEqual(child1, child2);
});
