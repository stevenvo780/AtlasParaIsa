import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tile } from '../src/shared/types.js';
import { TileStore } from '../src/world/soa/terreno.js';
import { ResidentTopologyOwner, residentTopologyToken } from '../src/world/soa/topologia.js';

function fixture(x = 0): Tile {
  return {
    x, y: 0, terrain: 'meadow', moisture: 0.7, vegetation: 0.6, food: 0.5,
    biome: 'forest', elevation: 0.4, wood: 0.3, stone: 0.2, feature: 'tree',
    variety: 0.1, growth: 0.8, fertility: 0.9, cultivation: 0.05, traffic: 0.04,
    drinkingWater: 0.03, species: 'hare', fauna: 2, life: 0.75,
  };
}

function different(key: string, value: unknown): unknown {
  if (typeof value === 'number') return value + 1;
  if (key === 'terrain') return 'water';
  if (key === 'biome') return 'grassland';
  if (key === 'feature') return 'pool';
  if (key === 'species') return 'wolf';
  throw new Error(`Valor de prueba no cubierto: ${key}`);
}

test('registra set de todas las claves Tile y drena en O(tocados)', () => {
  const owner = new ResidentTopologyOwner();
  for (const key of Object.keys(fixture())) {
    const tile = owner.tile(fixture());
    assert.deepEqual(owner.drainChangedTiles(), [], 'el constructor no es una escritura lógica');
    assert.equal(Reflect.set(tile, key, different(key, Reflect.get(tile, key))), true);
    assert.deepEqual(owner.drainChangedTiles(), [tile], key);
    assert.deepEqual(owner.drainChangedTiles(), [], `${key}: el drenaje limpia`);
  }
});

test('deduplica set/defineProperty, altas y deletes reales', () => {
  const owner = new ResidentTopologyOwner(), tile = owner.tile(fixture());
  tile.food = 0.25;
  Object.defineProperty(tile, 'stone', { value: 8, writable: true, configurable: true, enumerable: true });
  Reflect.set(tile, 'runtimeOnly', 1);
  delete tile.species;
  assert.deepEqual(owner.drainChangedTiles(), [tile]);
  assert.deepEqual(owner.drainChangedTiles(), []);

  assert.equal(Reflect.deleteProperty(tile, 'species'), true, 'delete ausente sigue siendo válido');
  Object.defineProperty(tile, 'stone', { value: 8, writable: true, configurable: true, enumerable: true });
  assert.deepEqual(owner.drainChangedTiles(), [], 'operaciones sin cambio real no ensucian');
});

test('funciona sin observer h1 y sobrevive al desvinculado del TileStore', () => {
  const owner = new ResidentTopologyOwner(), neverBound = owner.tile(fixture()), bound = owner.tile(fixture(1));
  neverBound.fauna = 7;
  assert.deepEqual(owner.drainChangedTiles(), [neverBound]);

  const tiles = owner.tiles([bound]), store = new TileStore();
  store.prepareParallel(tiles);
  assert.deepEqual(owner.drainChangedTiles(), [], 'attach de accessors residentes es mantenimiento');
  store.releaseParallelObjects();
  assert.deepEqual(owner.drainChangedTiles(), [], 'detach que materializa valores es mantenimiento');
  bound.stone = 11;
  assert.deepEqual(owner.drainChangedTiles(), [bound], 'el registro del owner no dependía del observer del store');
});

test('un raw revoca el token pero no finge tracking del owner', () => {
  const owner = new ResidentTopologyOwner(), observed = owner.tile(fixture()), raw = fixture(2);
  const tiles = owner.tiles([observed]);
  tiles.push(raw);
  assert.equal(residentTopologyToken(tiles), undefined);
  raw.food = 9;
  assert.deepEqual(owner.drainChangedTiles(), []);
  observed.food = 9;
  assert.deepEqual(owner.drainChangedTiles(), [observed]);
});
