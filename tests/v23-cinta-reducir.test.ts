import assert from 'node:assert/strict';
import test from 'node:test';
import { clientDelta, codificarBloque, decodificarBloque } from '../src/server/cinta/formato.js';
import { reducir, type DensidadCinta } from '../src/server/cinta/reducir.js';
import { applyClientTapeDelta } from '../src/shared/tape-delta.js';
import type { AnimalView, PersonView, WorldView } from '../src/shared/types.js';

function persona(id: string, x: number, y: number): PersonView {
  return {
    id, x, y, name: id, color: '#aaaaaa', role: 'neighbor', action: 'rest',
    reason: 'Reposo', need: 'descanso', recentMemory: null, communityId: 'c',
    hunger: 0, fatigue: 0.2, energy: 0.8, thirst: 0.3, health: 0.9,
  };
}

function animal(id: string, x: number, y: number, species: AnimalView['species']): AnimalView {
  return {
    id, x, y, species, action: 'graze', reason: 'Pasto', age: 60, generation: 2, parents: [],
    hunger: 0.1, thirst: 0.3, energy: 0.8, fatigue: 0.2, health: 0.9, reproReserve: 0,
    genes: { speed: 1, perception: 1, metabolism: 1, carnivory: 1, waterEfficiency: 1, camouflage: 1 },
  };
}

function vista(): WorldView {
  return {
    version: 10, sequence: 2, tick: 32, day: 1, phase: 'dawn', weather: 'clear', width: 64, height: 48,
    originX: -32, originY: -16, infinite: true, geologyKey: 12,
    people: [persona('a', -0.1, 0), persona('b', 0, 0), persona('c', -16, 0)],
    animals: [animal('a0', -16.1, -0.1, 'hare'), animal('a1', -16.1, -0.1, 'hare'),
      animal('a2', -16.1, -0.1, 'wolf'), animal('a3', -16, 0, 'hare')],
    tiles: [{ x: -16, y: 0, terrain: 'shelter', biome: 'grassland', moisture: 0.52, vegetation: 0.42,
      food: 0.12, cultivation: 0.23, traffic: 0.249, paved: 1 }],
    structures: [{ id: 's', x: -16, y: 0, name: 'Refugio', blueprintId: 'bp', components: ['frame', 'roof'],
      condition: 0.8, water: 2, food: 3, uses: 1, builtAt: 0, builderId: 'c', cells: [{ x: -16, y: 0 }, { x: -15, y: 0 }] }],
    communities: [{ id: 'c', name: 'Comunidad', x: -16, y: 0, color: '#bbbbbb', members: ['a', 'b', 'c'],
      culture: { sharing: 1, stewardship: 1, openness: 1 }, formedAt: 0, cooperation: 0, disputes: 0 }],
    events: [{ id: 'h', tick: 32, actors: ['c'], kind: 'discovery', cause: 'Exploración', text: 'Hallazgo', source: 'simulation' }],
    memories: [], places: [],
  };
}

test('I3: L0 conserva la vista y L1 conserva individuos sin telemetría ni deriva en la banda de tesela', () => {
  const completa = vista();
  const copia = structuredClone(completa);
  assert.deepEqual(reducir(0, completa), copia);
  const l1 = reducir(1, reducir(0, completa));
  assert.deepEqual(l1, reducir(1, completa));
  assert.deepEqual(l1.people.map(p => [p.id, p.x, p.y, p.action, p.communityId]),
    completa.people.map(p => [p.id, p.x, p.y, p.action, p.communityId]));
  assert.deepEqual(l1.animals?.map(a => [a.id, a.x, a.y, a.action, a.species]),
    completa.animals?.map(a => [a.id, a.x, a.y, a.action, a.species]));
  for (const entidad of [...l1.people, ...l1.animals!]) {
    for (const campo of ['hunger', 'fatigue', 'energy', 'thirst', 'health', 'age', 'reproReserve']) {
      assert.equal(Object.hasOwn(entidad, campo), false, campo);
    }
  }
  const [tesela] = completa.tiles;
  assert.deepEqual(reducir(1, { ...completa, tiles: [{ ...tesela, food: 0.14 }] }).tiles, l1.tiles);
  assert.notDeepEqual(reducir(1, { ...completa, tiles: [{ ...tesela, food: 0.23 }] }).tiles, l1.tiles);
  assert.notDeepEqual(reducir(1, { ...completa, tiles: [{ ...tesela, terrain: 'meadow' }] }).tiles, l1.tiles);
  assert.deepEqual(completa, copia);
});

test('I3: L2–L4 contabilizan densidades en chunks con coordenadas negativas y sólo L3 muestra individuos notables', () => {
  const completa = vista();
  const copia = structuredClone(completa);
  const notables = new Set(completa.events[0].actors);
  const l0 = reducir(0, completa);
  const [l2, l3, l4] = ([2, 3, 4] as const).map(nivel => reducir(nivel, l0, notables));
  assert.deepEqual(l2.people.map(p => p.id), ['a', 'b', 'c']);
  assert.equal(Object.hasOwn(l2.people[0], 'lifeStage'), false);
  assert.equal(Object.hasOwn(l2, 'instanceId'), false);
  assert.deepEqual(l2.tiles, [{ x: -16, y: 0, terrain: 'shelter', biome: 'grassland' }]);
  const fauna: DensidadCinta[] = [
    { chunkX: -2, chunkY: -1, fauna: { hare: 2, wolf: 1 } },
    { chunkX: -1, chunkY: 0, fauna: { hare: 1 } },
  ];
  assert.deepEqual(l2.densidades, fauna);
  const personas: DensidadCinta[] = [
    { chunkX: -1, chunkY: 0, personas: 2 },
    { chunkX: 0, chunkY: 0, personas: 1 },
  ];
  assert.deepEqual(l3.densidades, personas);
  assert.deepEqual(l3.people.map(p => p.id), ['c']);
  assert.deepEqual(l4.densidades, [fauna[0], { ...personas[0], fauna: fauna[1].fauna }, personas[1]]);
  assert.deepEqual(l4.people, []);
  for (const nivel of [l2, l3, l4]) {
    assert.equal(nivel.animals, undefined);
    assert.deepEqual(nivel.structures, completa.structures);
    assert.equal(nivel.communities?.[0].id, 'c');
  }
  assert.deepEqual(l3.communities?.[0].members, []);
  assert.equal(l3.communities?.[0].memberCount, 3);
  assert.deepEqual(l3.tiles, []);
  assert.deepEqual(l4.tiles, []);
  assert.deepEqual(completa, copia);
});

test('I3: la clave y el delta decodificados coinciden con la reducción de los mismos cortes L0', () => {
  const inicial = vista();
  const siguiente = { ...inicial, tick: inicial.tick + 24000, sequence: inicial.sequence + 1,
    people: inicial.people.slice(1), animals: [], tiles: [{ ...inicial.tiles[0], food: 0.5 }] };
  const bloquesL0 = codificarBloque(0, inicial, [clientDelta(inicial, siguiente)]);
  const baseL0 = decodificarBloque(bloquesL0);
  const siguienteL0 = applyClientTapeDelta(baseL0.baseFrame, baseL0.deltas[0]).frame;
  for (const nivel of [1, 2, 3, 4] as const) {
    const notables = new Set(inicial.events[0].actors);
    const base = reducir(nivel, inicial, notables), fin = reducir(nivel, siguiente, notables);
    const bloque = decodificarBloque(codificarBloque(nivel, base, [clientDelta(base, fin)]));
    assert.deepEqual(bloque.baseFrame, reducir(nivel, baseL0.baseFrame, notables));
    assert.deepEqual(applyClientTapeDelta(bloque.baseFrame, bloque.deltas[0]).frame, reducir(nivel, siguienteL0, notables));
  }
});
