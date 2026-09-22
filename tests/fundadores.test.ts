import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorld, createWorld } from '../src/world/index.js';
import { expressGenome } from '../src/world/genetics.js';
import { DEFAULT_PARAMS, parseParams } from '../src/world/params.js';

/**
 * Hipótesis FUND (noche 2026-09-22): `poblacion.fundadores` es una CONDICIÓN INICIAL de escala, no
 * una ley. Estas pruebas la refutan si toca a los 16 de la carta, si el default no es el mundo de
 * siempre o si los adicionales no salen del mismo molde que los 14 vecinos con nombre. El control
 * bit a bit contra `main` con el default vive en `tests/leyes-candidatas.test.ts` (i).
 */

const SEEDS = [7, 42, 104729, 51926];

test('FUND: con el default hay 16 fundadores y el mundo es el de siempre', () => {
  assert.equal(DEFAULT_PARAMS.poblacion.fundadores, 16);
  for (const seed of SEEDS) {
    const hoy = createWorld(seed), explicito = createWorld(seed, parseParams('poblacion.fundadores=16'));
    assert.equal(hoy.people.length, 16);
    assert.equal(JSON.stringify(explicito), JSON.stringify(hoy), `semilla ${seed}: fundadores=16 explícito cambia el mundo`);
  }
});

test('FUND: los 16 de la carta no cambian con más fundadores; S e I siguen primero', () => {
  for (const seed of SEEDS) {
    const hoy = createWorld(seed), grande = createWorld(seed, parseParams('poblacion.fundadores=32'));
    assertWorld(grande);
    assert.equal(grande.people.length, 32);
    assert.deepEqual(grande.people.slice(0, 16), hoy.people, `semilla ${seed}: algún fundador original cambió`);
    assert.deepEqual(grande.people.slice(0, 2).map(p => [p.id, p.role, p.name]), [['s', 'S', 'S'], ['i', 'I', 'I']]);
    // Mismo terreno, mismos lugares y mismos animales: la escala sólo añade personas.
    assert.deepEqual(grande.tiles, hoy.tiles);
    assert.deepEqual(grande.places, hoy.places);
    assert.deepEqual(grande.animals, hoy.animals);
  }
});

test('FUND: los adicionales son vecinos del mismo molde, en tierra libre y deterministas', () => {
  for (const seed of SEEDS) {
    const world = createWorld(seed, parseParams('poblacion.fundadores=64'));
    const otra = createWorld(seed, parseParams('poblacion.fundadores=64'));
    assert.equal(JSON.stringify(otra), JSON.stringify(world), `semilla ${seed}: la creación no es determinista`);
    const plantilla = world.people[2]!;
    const extras = world.people.slice(16);
    assert.deepEqual(extras.map(p => p.id), Array.from({ length: 48 }, (_, k) => `neighbor-${k + 15}`));
    assert.equal(new Set(world.people.map(p => p.name)).size, world.people.length, 'nombres repetidos');
    assert.equal(new Set(world.people.map(p => `${p.x},${p.y}`)).size, world.people.length, 'dos fundadores en la misma celda');
    for (const p of extras) {
      assert.equal(p.role, 'neighbor');
      const tile = world.tiles.find(t => t.x === p.x && t.y === p.y)!;
      assert.ok(tile.terrain !== 'water' && tile.terrain !== 'shelter', `${p.id} empieza en ${tile.terrain}`);
      assert.deepEqual(p.traits, expressGenome(p.genome));
      assert.deepEqual(p.genome.parents, []);
      assert.equal(p.bornAt, plantilla.bornAt);
      assert.equal(p.lastBirth, plantilla.lastBirth);
      assert.deepEqual(p.demography, plantilla.demography);
      assert.equal(p.inventory, plantilla.inventory);
      assert.equal(p.closeness, plantilla.closeness);
      assert.equal(p.thirst, plantilla.thirst);
    }
  }
});

test('FUND: el rango es [16, 256] y entero', () => {
  assert.throws(() => parseParams('poblacion.fundadores=15'), /fuera de rango/);
  assert.throws(() => parseParams('poblacion.fundadores=257'), /fuera de rango/);
  assert.throws(() => parseParams('poblacion.fundadores=20.5'), /entero/);
  const tope = createWorld(51926, parseParams('poblacion.fundadores=256'));
  assertWorld(tope);
  assert.equal(tope.people.length, 256);
});
