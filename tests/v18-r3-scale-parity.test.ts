import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tile } from '../src/shared/types.js';
import { createWorld, bindWorldContext, worldContext } from '../src/world/index.js';
import { stepEcosystem } from '../src/world/ecosystem.js';
import { activate, evictColdChunks } from '../src/world/spatial.js';
import { generateChunk } from '../src/world/terrain.js';
import { DEFAULT_PARAMS } from '../src/world/params.js';
import { constructionOpportunity, inventionContext, waterAvailable } from '../src/world/inventions.js';
import { worldStatistics } from '../src/world/statistics.js';
import { stepAnimals } from '../src/world/animals.js';
import { ResidentTopologyOwner } from '../src/world/soa/topologia.js';
import { sinUndefined } from './lib/comparar.js';
import { notifyResidentSubset, residentFaunaCapacity, residentTileReader, TileStore } from '../src/world/soa/terreno.js';

const snapshot = (tiles: readonly Tile[]) => tiles.map(tile => sinUndefined({ ...tile }));

test('V18-r3: retiro certificado conserva lecturas SoA, capacidad y paridad plana; altas y próximo paso ecológico', () => {
  const world = createWorld(51926);
  const owner = new ResidentTopologyOwner();
  const original = world.tiles.map(tile => owner.tile({ ...tile }));
  world.tiles = owner.tiles(original);
  bindWorldContext(world, { ...worldContext(world), tileOwnership: owner });
  const store = new TileStore();
  try {
    store.prepareParallel(world.tiles);
    const oldTiles = world.tiles;
    const retireCount = Math.min(256, oldTiles.length);
    assert.equal(retireCount, 256, 'la fixture inicial contiene un bloque completo');
    const next = owner.subsetBlocks(oldTiles, Array.from({ length: oldTiles.length / 256 - 1 }, (_, i) => (i + 1) * 256), 256);
    const retired = oldTiles.slice(0, 256);
    assert.equal(notifyResidentSubset(oldTiles, next, retired), true);
    world.tiles = next;
    const reader = residentTileReader(next);
    assert.ok(reader, 'el lector exacto continúa disponible antes del próximo tick de ecología');
    assert.equal(reader.cellAt(retired[0]!.x, retired[0]!.y), -1, 'las coordenadas retiradas pierden presencia inmediatamente');
    assert.ok(reader.cellAt(next[0]!.x, next[0]!.y) >= 0);

    const reference = snapshot(next);
    const referenceCapacity = reference.filter(tile => tile.terrain !== 'shelter' && (tile.growth ?? tile.vegetation) > 0.04).length * 3;
    assert.equal(residentFaunaCapacity(next), referenceCapacity);
    assert.deepEqual(worldStatistics(world), worldStatistics({ ...world, tiles: reference }));
    const person = world.people[0]!;
    assert.equal(waterAvailable(world, person), waterAvailable({ ...world, tiles: reference }, person));
    assert.deepEqual(inventionContext(world, person), inventionContext({ ...world, tiles: reference }, person));
    assert.deepEqual(constructionOpportunity(world, person), constructionOpportunity({ ...world, tiles: reference }, person));

    const residentAnimals = { ...world, animals: structuredClone(world.animals), animalDynamics: structuredClone(world.animalDynamics) };
    const plainAnimals = { ...world, tiles: reference, animals: structuredClone(world.animals), animalDynamics: structuredClone(world.animalDynamics) };
    stepAnimals(residentAnimals, undefined);
    stepAnimals(plainAnimals, undefined);
    assert.deepEqual(residentAnimals.animals, plainAnimals.animals, 'stepAnimals conserva la secuencia y todos los bits frente a Tile planos');
    assert.deepEqual(residentAnimals.animalDynamics, plainAnimals.animalDynamics);
    assert.deepEqual(snapshot(residentAnimals.tiles), snapshot(plainAnimals.tiles));

    const appended: Tile = owner.tile({ ...next[0]!, x: next[0]!.x + 10_000, y: next[0]!.y, growth: 0.9 });
    next.push(appended);
    const withTail = snapshot(next);
    assert.equal(residentFaunaCapacity(next), withTail.filter(tile => tile.terrain !== 'shelter' && (tile.growth ?? tile.vegetation) > 0.04).length * 3,
      'un append puro cuenta el prefijo SoA y solo inspecciona la cola');

    const plainTiles = snapshot(next);
    stepEcosystem(next, world.tick, world.weather, 'day', false);
    stepEcosystem(plainTiles, world.tick, world.weather, 'day', false);
    store.prepareParallel(next);
    assert.deepEqual(snapshot(next), plainTiles, 'prepareParallel vuelve a sincronizar la topología incremental sin cambiar valores');
    assert.ok(residentTileReader(next));
  } finally {
    store.releaseParallelObjects();
  }
});

test('V18-r3: el handoff de retiro falla cerrado si hubo mutación externa', () => {
  const world = createWorld(51926), owner = new ResidentTopologyOwner(), store = new TileStore();
  world.tiles = owner.tiles(world.tiles.map(tile => owner.tile({ ...tile })));
  store.prepareParallel(world.tiles);
  const previous = world.tiles;
  const next = owner.subsetBlocks(previous, Array.from({ length: previous.length / 256 - 1 }, (_, i) => (i + 1) * 256), 256);
  previous[0]!.x += 1;
  assert.equal(notifyResidentSubset(previous, next, previous.slice(0, 256)), false);
  assert.equal(residentTileReader(next), undefined);
  store.releaseParallelObjects();
});

test('V18-r3: retireActiveChunks y activateChunk conservan lector y capacidad antes del siguiente tick', () => {
  const world = createWorld(51926), owner = new ResidentTopologyOwner(), store = new TileStore();
  world.people = []; world.animals = []; world.structures = []; world.places = []; world.retiredChunks = [];
  world.chunks = {};
  const tiles: Tile[] = [];
  for (const [cx, cy] of [[0, 0], [8, 0]] as const) {
    const { tiles: chunkTiles, animals: _animals, structures: _structures, ...meta } = generateChunk(world.seed, cx, cy, DEFAULT_PARAMS.agua.cuencas);
    world.chunks[meta.key] = meta;
    for (const tile of chunkTiles) tiles.push(owner.tile(tile));
  }
  world.tiles = owner.tiles(tiles);
  bindWorldContext(world, { ...worldContext(world), tileOwnership: owner });
  try {
    store.prepareParallel(world.tiles);
    const before = world.tiles;
    assert.equal(evictColdChunks(world, { maxActiveChunks: 1 }).length, 1);
    assert.equal(world.tiles.length, 256);
    const reader = residentTileReader(world.tiles);
    assert.ok(reader, 'el retiro real conserva lectura residente sin esperar al tick de ecología');
    const active = new Set(world.tiles);
    const retired = before.find(tile => !active.has(tile))!;
    assert.equal(reader.cellAt(retired.x, retired.y), -1);
    const chunk = world.retiredChunks[0]!;
    activate(world, chunk.cx * 16, chunk.cy * 16, worldContext(world));
    const plain = snapshot(world.tiles);
    assert.equal(residentFaunaCapacity(world.tiles), plain.filter(tile => tile.terrain !== 'shelter' && (tile.growth ?? tile.vegetation) > 0.04).length * 3);
    store.prepareParallel(world.tiles);
    assert.ok(residentTileReader(world.tiles), 'prepareParallel vuelve a enlazar el bloque reactivado');
  } finally {
    store.releaseParallelObjects();
  }
});
