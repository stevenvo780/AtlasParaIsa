import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneWorld, createWorld, stepWorld, tileAt, type Person, type World } from '../src/world/index.js';
import { demographicTraits, initialDemography } from '../src/world/demography.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { paramsOf, parseParams, setParams } from '../src/world/params.js';
import { activate } from '../src/world/spatial.js';
import {
  conRejilla,
  consultasRejillaParaPruebas,
  personaMovida,
  primerVecino,
  reiniciarConsultasRejillaParaPruebas,
  sinRejillaParaPruebas,
  vecinos,
} from '../src/world/rejilla.js';

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

function xorshift(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return state >>> 0;
  };
}

function persona(id: string, x: number, y: number): Person {
  return { id, x, y } as Person;
}

function mismasReferencias(actual: Person[], expected: Person[]): void {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index++) assert.equal(actual[index], expected[index], `slot devuelto ${index}`);
}

test('10 000 consultas reproducen filter/find por slot con 50, 500 y 5 000 personas', { timeout: 180_000 }, t => {
  const sizes = [50, 500, 5_000] as const, queries = [3_334, 3_333, 3_333] as const;
  let total = 0;
  for (let batch = 0; batch < sizes.length; batch++) {
    const size = sizes[batch]!, random = xorshift(0x9e3779b9 ^ size), people: Person[] = [];
    for (let slot = 0; slot < size; slot++) {
      const fraction = [0, 0.25, 0.5, 0.999999][slot & 3]!;
      people.push(persona(`p-${slot}`, (random() % 401) - 200 + fraction, (random() % 401) - 200 - fraction));
    }
    people[0]!.x = -0; people[0]!.y = -0;
    people[1]!.x = -4; people[1]!.y = 4;
    people[2]!.x = -4.000001; people[2]!.y = 3.999999;
    people[3]!.x = 7.999999; people[3]!.y = -8;
    const world = { people } as World, radios = [2, 3, 6, 7, 32] as const;
    conRejilla(world, () => {
      for (let query = 0; query < queries[batch]!; query++) {
        if (query > 0 && query % 137 === 0) {
          const moved = world.people[random() % world.people.length]!;
          moved.x += query % 274 === 0 ? 9.25 : -5.5;
          moved.y += query % 411 === 0 ? -8.75 : 4.25;
          personaMovida(world, moved);
        }
        if (query === 211) world.people.push(persona(`p-${size}-nuevo`, -12.5, 8));
        if (query === 733) world.people = world.people.slice();
        const anchor = world.people[random() % world.people.length]!;
        const center = { x: anchor.x + ((random() % 9) - 4) / 4, y: anchor.y + ((random() % 9) - 4) / 4 };
        const radius = radios[random() % radios.length]!, salt = random() % 11;
        const predicate = (candidate: Person) => distance(center, candidate) <= radius
          && ((Number(candidate.id.match(/\d+/)?.[0] ?? 0) + salt) % 3 !== 0);
        const expected = world.people.filter(predicate), first = world.people.find(predicate);
        mismasReferencias(vecinos(world, center, radius + 1, predicate), expected);
        assert.equal(primerVecino(world, center, radius + 1, predicate), first);
        total++;
      }
    });
  }
  t.diagnostic(JSON.stringify({ consultas: total, poblaciones: sizes, radios: [2, 3, 6, 7, 32] }));
  assert.equal(total, 10_000);
});

test('fuera del ámbito se usa el recorrido lineal y se ven posiciones mutadas a mano', () => {
  const a = persona('a', 0, 0), b = persona('b', 1, 0), world = { people: [a, b] } as World;
  assert.deepEqual(vecinos(world, a, 3, p => p !== a && distance(a, p) <= 2), [b]);
  b.x = 20;
  assert.deepEqual(vecinos(world, a, 3, p => p !== a && distance(a, p) <= 2), []);
  conRejilla(world, () => assert.deepEqual(vecinos(world, a, 3, p => p !== a && distance(a, p) <= 2), []));
  b.x = -1;
  assert.equal(primerVecino(world, a, 3, p => p !== a && distance(a, p) <= 2), b);
});

test('coordenadas no finitas, fuera de rango y personas repetidas caen al filtro exacto', () => {
  const repeated = persona('repetida', 0, 0);
  const people = [repeated, persona('infinita', Number.POSITIVE_INFINITY, 0), repeated, persona('lejana', 2 ** 27, -(2 ** 27))];
  const world = { people } as World, predicate = (p: Person) => p.id !== 'ninguna';
  conRejilla(world, () => {
    mismasReferencias(vecinos(world, { x: 0, y: 0 }, 3, predicate), people);
    assert.equal(primerVecino(world, { x: 0, y: 0 }, 3, predicate), repeated);
  });
});

function cluster(people: readonly { x: number; y: number }[]): { x: number; y: number }[] {
  for (const center of people) {
    const nearby = people.filter(p => distance(center, p) <= 3);
    if (nearby.length >= 16) return nearby.slice(0, 16).map(p => ({ x: p.x, y: p.y }));
  }
  throw new Error('La escena no contiene un grupo transitable suficiente.');
}

function mundoPoblado(): World {
  const world = createWorld(51926);
  for (let cy = -1; cy <= 5; cy++) for (let cx = -1; cx <= 8; cx++) activate(world, cx * 16, cy * 16);
  const walkable = world.tiles.filter(tile => tile.terrain !== 'water').map(tile => ({ x: tile.x, y: tile.y }));
  assert.ok(walkable.length >= 2_000);
  const close = cluster(walkable), closeKeys = new Set(close.map(p => `${p.x},${p.y}`));
  const positions = [...close, ...walkable.filter(p => !closeKeys.has(`${p.x},${p.y}`))].slice(0, 2_000);
  const template = world.people.find(p => p.role === 'neighbor')!;
  while (world.people.length < 2_000) {
    const slot = world.people.length, person = structuredClone(template);
    person.id = `grid-person-${slot}`; person.name = `Persona ${slot}`;
    world.people.push(person);
  }
  world.tick = 119;
  for (let slot = 0; slot < world.people.length; slot++) {
    const person = world.people[slot]!, point = positions[slot]!;
    person.x = point.x; person.y = point.y; person.target = { ...point };
    person.action = 'rest'; person.command = null; person.controlMode = 'auto'; person.decisionAt = 999;
    person.hunger = person.thirst = person.fatigue = 0.1; person.energy = 0.9; person.inventory = 0;
    person.materials = { wood: 0, stone: 0 }; person.bonds = {}; person.communityId = null;
    person.lastShared = -1_000; person.lastSocial = -1_000; person.lastDispute = -1_000;
    person.culture = { sharing: 0.6, stewardship: 0.6, openness: 0.6 };
    person.demography = initialDemography(6_000); person.bornAt = world.tick - 6_000; person.lastBirth = -10_000;
  }

  setParams(world, parseParams('social.radioConvivencia=6', paramsOf(world)));
  const [explorer, donor, recipient, disputed, contender, parentA, parentB, doomed, divergent, memberA, memberB, memberC] = world.people.slice(2, 14) as Person[];

  explorer!.command = { order: 'explore', x: explorer!.x, y: explorer!.y }; explorer!.controlMode = 'directed'; explorer!.decisionAt = 0;
  donor!.action = 'share'; donor!.inventory = 0.2; donor!.demography.health = 0.5;
  recipient!.hunger = 0.4;
  world.places.push({ id: 'grid-place', x: donor!.x, y: donor!.y, name: 'Lugar de rejilla', description: 'Escena sintética', gatherings: 0 });

  for (const person of [disputed!, contender!]) {
    person.action = 'eat'; person.hunger = 0.9; person.communityId = 'grid-community';
    person.target = { x: disputed!.x, y: disputed!.y };
  }
  contender!.x = disputed!.x + 1; contender!.y = disputed!.y; contender!.target = { ...disputed!.target };
  tileAt(world, disputed!)!.food = 0.03;

  for (const person of [parentA!, parentB!]) {
    person.inventory = 0.2; person.hunger = person.thirst = person.fatigue = 0.1; person.energy = 0.9;
    person.demography = initialDemography(6_000); person.bornAt = world.tick - 6_000; person.lastBirth = -10_000;
  }
  parentB!.x = parentA!.x + 1; parentB!.y = parentA!.y; parentB!.target = { x: parentB!.x, y: parentB!.y };
  parentA!.bonds[parentB!.id] = parentB!.bonds[parentA!.id] = 0.6;
  world.places.push({ id: 'grid-family-place', x: parentA!.x, y: parentA!.y, name: 'Lugar familiar', description: 'Escena sintética', gatherings: 0 });

  const traits = demographicTraits(doomed!.genome, paramsOf(world).cuerpo);
  doomed!.demography = initialDemography(traits.senescenceStart); doomed!.demography.health = 0.000001;
  doomed!.bornAt = world.tick - traits.senescenceStart; doomed!.inventory = 0.1;
  doomed!.hunger = doomed!.thirst = doomed!.fatigue = 1; doomed!.energy = 0;

  divergent!.communityId = memberA!.communityId = memberB!.communityId = memberC!.communityId = 'grid-community';
  divergent!.culture = { sharing: 1, stewardship: 1, openness: 1 };
  world.communities = [{ id: 'grid-community', name: 'Comunidad rejilla', x: disputed!.x, y: disputed!.y,
    members: [disputed!, contender!, divergent!, memberA!, memberB!, memberC!].map(p => p.id), color: '#abcdef',
    culture: { sharing: 0, stewardship: 0, openness: 0 }, formedAt: 0, cooperation: 0, disputes: 0 }];
  return world;
}

interface Integracion { digest: string; counters: ReadonlyMap<string, number>; population: number }
let integracion: Integracion | undefined;

function resultadoIntegracion(): Integracion {
  if (integracion) return integracion;
  const indexed = mundoPoblado(), linear = cloneWorld(indexed);
  reiniciarConsultasRejillaParaPruebas(indexed);
  stepWorld(indexed);
  sinRejillaParaPruebas(linear, () => stepWorld(linear));
  assert.equal(digestoCanonico(indexed), digestoCanonico(linear), 'la rejilla no puede cambiar un bit del mundo de 2 000 personas');
  integracion = { digest: digestoCanonico(indexed), counters: consultasRejillaParaPruebas(indexed), population: indexed.people.length };
  return integracion;
}

const SITIOS = [
  'choose',
  'explorationTarget',
  'share:recipient',
  'share:observers',
  'transferEstate',
  'reproduce',
  'settlementOpportunity',
  'cooperationOpportunity',
  'updateCommunities:alternatives',
  'updateCommunities:cohabitation',
  'updateCommunities:foundation',
  'resourceDispute',
] as const;

for (const site of SITIOS) test(`sitio migrado ${site}: paridad lineal con 2 000 personas y consulta real de rejilla`, { timeout: 180_000 }, t => {
  const result = resultadoIntegracion();
  assert.ok((result.counters.get(site) ?? 0) > 0, `${site} no pasó por la rejilla`);
  t.diagnostic(JSON.stringify({ site, consultas: result.counters.get(site), poblacionFinal: result.population, digesto: result.digest }));
});

/** Trayectoria densa: además de la escena por sitio, 2 000 personas con vínculos locales, cuatro
 * comunidades, decisiones escalonadas (1/30 por tick) y 13 pasos (movimiento en 120, 126 y 132;
 * comunidades y nacimientos en 120): el mundo con rejilla y el lineal coinciden paso a paso. */
function mundoDenso(): World {
  const world = mundoPoblado(), ids = ['grid-a', 'grid-b', 'grid-c', 'grid-d'];
  world.tick = 118;
  const celdas = new Map<string, number[]>(), celda = (p: Person) => `${Math.floor(p.x / 4)},${Math.floor(p.y / 4)}`;
  world.people.forEach((p, i) => { const k = celda(p); (celdas.get(k) ?? celdas.set(k, []).get(k)!).push(i); });
  world.people.forEach((p, i) => {
    if (i < 14) return;
    p.decisionAt = world.tick + 1 + (i % 30); p.hunger = 0.2 + (i % 7) * 0.05; p.inventory = 0.1;
    p.culture = { sharing: 0.3 + (i % 5) * 0.1, stewardship: 0.5, openness: 0.4 + (i % 3) * 0.1 };
    p.communityId = i % 9 === 0 ? null : ids[Math.floor((p.x + 4096) / 24) % ids.length]!;
    const cx = Math.floor(p.x / 4), cy = Math.floor(p.y / 4);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const j of celdas.get(`${cx + dx},${cy + dy}`) ?? []) {
      const q = world.people[j]!;
      if (j !== i && distance(p, q) <= 4) p.bonds[q.id] = 0.2 + ((i + j) % 5) * 0.1;
    }
  });
  const s = world.people.find(p => p.role === 'S')!;
  for (const id of ids) world.communities.push({ id, name: `Comunidad ${id}`, x: s.x, y: s.y, members: world.people.filter(p => p.communityId === id).map(p => p.id),
    color: '#aabbcc', culture: { sharing: 0.5, stewardship: 0.5, openness: 0.5 }, formedAt: 0, cooperation: 0, disputes: 0 });
  return world;
}

test('trayectoria densa de 2 000 personas: 13 pasos con rejilla ≡ sin rejilla, paso a paso', { timeout: 600_000 }, t => {
  const indexed = mundoDenso(), linear = cloneWorld(indexed);
  reiniciarConsultasRejillaParaPruebas(indexed);
  for (let paso = 0; paso < 13; paso++) {
    stepWorld(indexed);
    sinRejillaParaPruebas(linear, () => stepWorld(linear));
    assert.equal(digestoCanonico(indexed), digestoCanonico(linear), `tick ${indexed.tick}`);
  }
  const counters = consultasRejillaParaPruebas(indexed);
  for (const site of ['choose', 'settlementOpportunity', 'cooperationOpportunity', 'updateCommunities:alternatives', 'updateCommunities:foundation', 'reproduce'])
    assert.ok((counters.get(site) ?? 0) > 0, `${site} no pasó por la rejilla`);
  t.diagnostic(JSON.stringify({ tick: indexed.tick, poblacion: indexed.people.length, consultas: Object.fromEntries(counters) }));
});
