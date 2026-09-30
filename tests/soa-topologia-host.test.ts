import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tile } from '../src/shared/types.js';
import { cloneWorld, createWorld, puntoDeRestauracion, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { parseParams, paramsOf, setParams } from '../src/world/params.js';
import { activate, bindWorldContext, maintainRegions, tileAt, worldContext } from '../src/world/spatial.js';
import { chunkKey, generateChunk } from '../src/world/terrain.js';
import { enableTechnologyCatalogue, findTechnologyRecipe, withArchiveReadBatch,
  type TechnologyCatalogueReader } from '../src/world/technology-catalogue.js';
import { residentTopologyToken, sameResidentTopology } from '../src/world/soa/topologia.js';
import { TileStore } from '../src/world/soa/terreno.js';

const parallelParams = parseParams({ motor: { hilos: 8, soaTerreno: true, gpu: [], orden: 'adversarial' } });
const serialParams = parseParams({ motor: { hilos: 1, soaTerreno: false, gpu: [], orden: 'natural' } });
const snapshot = (tiles: readonly Tile[]): Tile[] => tiles.map(tile => ({ ...tile }));
function exactTiles(actual: readonly Tile[], expected: readonly Tile[]): void {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) {
    assert.deepEqual(Object.keys(actual[i]!), Object.keys(expected[i]!), `claves/orden de tesela ${i}`);
    for (const key of Object.keys(expected[i]!) as (keyof Tile)[])
      assert.ok(Object.is(actual[i]![key], expected[i]![key]), `tesela ${i}.${key}`);
  }
}

/** Sólo los cuatro selectores de ejecución: ninguna ley ni estado se borra/serializa con JSON. */
function normalizedDigest(world: World): string {
  const previous = paramsOf(world);
  const normalized = parseParams({ motor: { hilos: 1, soaTerreno: false, gpu: [], orden: 'natural' } }, previous);
  setParams(world, normalized);
  try { return digestoCanonico(world); } finally { setParams(world, previous); }
}
function protectedState(world: World) {
  return structuredClone({ people: world.people.filter(person => person.role === 'S' || person.role === 'I'), memories: world.memories });
}
function hostReaders(world: World) {
  let chunks = 0, legacy = 0, catalogue = 0, batches = 0;
  const remote = generateChunk(world.seed, 48, -48);
  const loadChunk = (key: string, _tick: number) => { chunks++; return key === remote.key ? remote : null; };
  const loadLegacy = (_id: string, _tick: number) => { legacy++; return null; };
  const catalogueReader: TechnologyCatalogueReader = {
    resolve: () => { catalogue++; return null; },
    findBySignature: () => { catalogue++; return null; },
    readBatch: (_tick, read) => { batches++; return read(); },
  };
  enableTechnologyCatalogue(world.technology);
  bindWorldContext(world, { loadChunk, loadLegacy, catalogueReader });
  return { remote, loadChunk, loadLegacy, catalogueReader, counts: () => ({ chunks, legacy, catalogue, batches }) };
}

for (const seed of [7, 51926]) test(`createWorld 1/8 conserva canon y forma; owner nace antes de exponer (semilla ${seed})`, () => {
  const ordinary = createWorld(seed, serialParams), owned = createWorld(seed, parallelParams);
  assert.equal(worldContext(ordinary).tileOwnership, undefined);
  assert.ok(worldContext(owned).tileOwnership); assert.ok(residentTopologyToken(owned.tiles));
  exactTiles(owned.tiles, ordinary.tiles);
  assert.deepEqual(protectedState(owned), protectedState(ordinary));
  assert.equal(normalizedDigest(owned), normalizedDigest(ordinary));
  assert.equal(paramsOf(owned), parallelParams); assert.equal(paramsOf(ordinary), serialParams);
  const tiles = owned.tiles, refs = tiles.slice(), token = residentTopologyToken(tiles), before = normalizedDigest(owned);
  const store = new TileStore(); store.prepareParallel(owned.tiles); store.prepareParallel(owned.tiles);
  assert.equal(owned.tiles, tiles); assert.ok(tiles.every((tile, i) => tile === refs[i]));
  assert.ok(sameResidentTopology(token, residentTopologyToken(tiles)));
  assert.equal(normalizedDigest(owned), before); exactTiles(owned.tiles, ordinary.tiles);
  assert.equal(store.parallelTopologyDiagnostics.genericCheckedTiles, 0);
  assert.equal(store.parallelTopologyDiagnostics.fastHits, 1);
});

test('cloneWorld crea owner y Tile independientes, hereda lectores reales y conserva foto certificada', () => {
  const source = createWorld(51926, parallelParams), readers = hostReaders(source), before = digestoCanonico(source);
  const sourceOwner = worldContext(source).tileOwnership, sourceToken = residentTopologyToken(source.tiles);
  const copy = cloneWorld(source), copyContext = worldContext(copy);
  assert.notEqual(copy, source); assert.notEqual(copy.tiles, source.tiles); assert.notEqual(copy.technology, source.technology);
  assert.ok(copyContext.tileOwnership); assert.notEqual(copyContext.tileOwnership, sourceOwner);
  assert.ok(residentTopologyToken(copy.tiles)); assert.equal(paramsOf(copy), paramsOf(source));
  assert.equal(digestoCanonico(copy), before); exactTiles(copy.tiles, source.tiles);
  assert.ok(copy.tiles.every((tile, i) => tile !== source.tiles[i]));
  assert.equal(copyContext.loadChunk, readers.loadChunk); assert.equal(copyContext.loadLegacy, readers.loadLegacy);
  assert.equal(copyContext.catalogueReader, readers.catalogueReader);
  withArchiveReadBatch(copy, () => assert.equal(findTechnologyRecipe(copy, 'host-probe'), undefined));
  assert.equal(copyContext.loadLegacy!('host-probe', copy.tick), null);
  assert.deepEqual(readers.counts(), { chunks: 0, legacy: 1, catalogue: 1, batches: 1 });
  const store = new TileStore(), copiedTiles = copy.tiles, token = residentTopologyToken(copy.tiles);
  store.prepareParallel(copy.tiles); copy.tiles[0]!.food = -0; store.prepareParallel(copy.tiles);
  assert.equal(copy.tiles, copiedTiles); assert.ok(sameResidentTopology(token, residentTopologyToken(copy.tiles)));
  assert.ok(Object.is(copy.tiles[0]!.food, -0)); assert.equal(digestoCanonico(source), before);
  assert.ok(sameResidentTopology(sourceToken, residentTopologyToken(source.tiles)));
  assert.doesNotThrow(() => activate(copy, readers.remote.cx * 16, readers.remote.cy * 16));
  assert.equal(readers.counts().chunks, 1); assert.ok(residentTopologyToken(copy.tiles));
  assert.equal(Object.hasOwn(source.chunks, readers.remote.key), false);
  assert.equal(digestoCanonico(source), before, 'lectura/alta en el clon no alcanza al mundo confirmado');
});

test('rollback devuelve array confirmado/canon/lectores después de copia residente y alta remota', () => {
  const world = createWorld(7, parallelParams), readers = hostReaders(world), store = new TileStore();
  store.prepareParallel(world.tiles);
  const before = digestoCanonico(world), protectedBefore = protectedState(world), tiles = world.tiles, refs = tiles.slice();
  const params = paramsOf(world), owner = worldContext(world).tileOwnership, point = puntoDeRestauracion(world);
  assert.notEqual(world.tiles, tiles); assert.ok(world.tiles.every((tile, i) => tile !== refs[i]));
  assert.ok(residentTopologyToken(world.tiles)); assert.equal(worldContext(world).tileOwnership, owner);
  exactTiles(world.tiles, tiles); store.prepareParallel(world.tiles);
  world.tiles[0]!.life = -0; world.tiles[0]!.food = -0; world.tick += 5;
  activate(world, readers.remote.cx * 16, readers.remote.cy * 16); store.prepareParallel(world.tiles);
  assert.notEqual(digestoCanonico(world), before);
  point.restaurar();
  assert.equal(world.tiles, tiles); assert.ok(world.tiles.every((tile, i) => tile === refs[i]));
  assert.equal(paramsOf(world), params); assert.equal(worldContext(world).tileOwnership, owner);
  assert.equal(digestoCanonico(world), before); assert.deepEqual(protectedState(world), protectedBefore);
  assert.equal(Object.hasOwn(world.chunks, readers.remote.key), false); assert.ok(residentTopologyToken(world.tiles));
  store.prepareParallel(world.tiles); assert.equal(digestoCanonico(world), before);
  assert.equal(worldContext(world).catalogueReader, readers.catalogueReader);
  withArchiveReadBatch(world, () => assert.equal(findTechnologyRecipe(world, 'after-rollback'), undefined));
  assert.deepEqual(readers.counts(), { chunks: 1, legacy: 0, catalogue: 1, batches: 1 });
  assert.throws(() => point.restaurar(), /ya se consumió/);
});

test('retirar y reactivar chunk remoto conserva -0/undefined/orden sin mover S/I ni clonar Proxy directamente', () => {
  const owned = createWorld(51926, parallelParams), ordinary = createWorld(51926, serialParams), worlds = [owned, ordinary];
  const protectedBefore = worlds.map(protectedState), point = { x: 16384, y: -16384 }, key = chunkKey(point.x, point.y);
  const stores = worlds.map(() => new TileStore()), remoteRefs: Tile[] = [];
  for (let i = 0; i < worlds.length; i++) {
    const world = worlds[i]!;
    maintainRegions(world); // inicializa las referencias de vecindad sin trasladar a nadie
    activate(world, point.x, point.y);
    const tile = tileAt(world, point)!; remoteRefs.push(tile);
    tile.food = -0; tile.vegetation = -0; tile.traffic = -0; tile.wood = -0; tile.feature = 'stump'; tile.fauna = 0;
    delete tile.species; tile.species = undefined; // ausencia vs propia undefined y orden son observables
    stores[i]!.prepareParallel(world.tiles);
    maintainRegions(world); // el chunk activado explícitamente está fuera de todas las vecindades
    assert.equal(Object.hasOwn(world.chunks, key), false); assert.equal(tileAt(world, point), undefined);
    assert.deepEqual(protectedState(world), protectedBefore[i]);
    stores[i]!.prepareParallel(world.tiles); // materializa el retirado antes de reutilizar páginas
  }
  assert.equal(normalizedDigest(owned), normalizedDigest(ordinary));
  assert.ok(residentTopologyToken(owned.tiles));
  const archived = worlds.map(world => world.retiredChunks.find(chunk => chunk.key === key)!);
  assert.ok(archived.every(Boolean)); exactTiles(archived[0]!.tiles, archived[1]!.tiles);
  for (let i = 0; i < worlds.length; i++) {
    const world = worlds[i]!, retired = archived[i]!, retiredBefore = snapshot(retired.tiles);
    assert.equal(retired.tiles.find(tile => tile.x === point.x && tile.y === point.y), remoteRefs[i]);
    assert.doesNotThrow(() => activate(world, point.x, point.y), 'la frontera materializa foto plana antes de structuredClone');
    const active = world.tiles.filter(tile => chunkKey(tile.x, tile.y) === key);
    exactTiles(active, retiredBefore); assert.equal(world.retiredChunks.some(chunk => chunk.key === key), false);
    const reactivated = tileAt(world, point)!;
    assert.notEqual(reactivated, remoteRefs[i]); assert.ok(Object.is(reactivated.food, -0));
    assert.ok(Object.is(reactivated.wood, -0)); assert.equal(Object.hasOwn(reactivated, 'species'), true);
    assert.equal(reactivated.species, undefined); exactTiles(retired.tiles, retiredBefore);
    stores[i]!.prepareParallel(world.tiles); exactTiles(active, retiredBefore);
    assert.deepEqual(protectedState(world), protectedBefore[i]);
  }
  assert.ok(residentTopologyToken(owned.tiles)); assert.equal(normalizedDigest(owned), normalizedDigest(ordinary));
  for (let i = 0; i < worlds.length; i++) {
    tileAt(worlds[i]!, point)!.food = 0.125;
    assert.ok(Object.is(remoteRefs[i]!.food, -0), 'el Tile reactivado no comparte escritura con el dormido');
  }
});
