import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tile } from '../src/shared/types.js';
import { TileStore, type SharedTerrain } from '../src/world/soa/terreno.js';
import { ResidentTopologyOwner, residentTopologyToken, sameResidentTopology } from '../src/world/soa/topologia.js';

function fixture(x = -16, y = -16): Tile {
  return { x, y, terrain: 'meadow', biome: 'forest', moisture: 0.9, vegetation: -0, food: -0,
    life: 0.75, growth: 0.9, fertility: 0.9, cultivation: 0, traffic: -0, drinkingWater: 0,
    species: undefined };
}
const snapshot = (tiles: readonly Tile[]): Tile[] => tiles.map(tile => ({ ...tile }));
function exact(actual: readonly Tile[], expected: readonly Tile[]): void {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) {
    assert.deepEqual(Object.keys(actual[i]!), Object.keys(expected[i]!));
    for (const key of Object.keys(expected[i]!) as (keyof Tile)[]) assert.ok(Object.is(actual[i]![key], expected[i]![key]), `${i}.${key}`);
  }
}
function copyBacks(terrain: SharedTerrain): void {
  for (const [key, buffer] of Object.entries(terrain.buffers)) if (key.endsWith('Back'))
    new Uint8Array(buffer).set(new Uint8Array(terrain.buffers[key.slice(0, -4)]!));
}

test('constructor explícito: backing privado, referencias públicas estables, orden/undefined/-0 exactos', () => {
  const owner = new ResidentTopologyOwner(), source = fixture(), tile = owner.tile(source), input = [tile], tiles = owner.tiles(input);
  assert.notEqual(tile, source); assert.notEqual(tiles, input); assert.equal(tiles[0], tile);
  exact(tiles, [source]);
  source.x = 100; input[0] = fixture(200, 200);
  assert.equal(tiles[0], tile); assert.equal(tile.x, -16, 'ningún backing ordinario puede escaparse');
  const store = new TileStore(), before = snapshot(tiles);
  for (let i = 0; i < 4; i++) { store.prepareParallel(tiles); assert.equal(tiles[0], tile); exact(tiles, before); }
  assert.deepEqual(store.parallelTopologyDiagnostics, { fastHits: 3, genericCheckedTiles: 0, rebuilds: 1, changedBindings: 0 });
  assert.equal(Object.hasOwn(tile, 'wood'), false); assert.equal(Object.hasOwn(tile, 'feature'), false);
  assert.throws(() => structuredClone(tile), { name: 'DataCloneError' });
  assert.throws(() => structuredClone(tiles), { name: 'DataCloneError' });
  exact(structuredClone(snapshot(tiles)), before);
});

test('vacío/altas/remoción de raw recuperan cert; setter de array no expone backing', () => {
  const owner = new ResidentTopologyOwner(), tiles = owner.tiles([]), tile = owner.tile(fixture()), raw = fixture(512, 512);
  assert.ok(residentTopologyToken(tiles)); tiles.push(tile); assert.ok(residentTopologyToken(tiles));
  tiles.push(raw); assert.equal(residentTopologyToken(tiles), undefined);
  assert.equal(tiles.pop(), raw); assert.ok(residentTopologyToken(tiles));
  let receiver: unknown;
  Object.defineProperty(tiles, 'other', { configurable: true, set(this: Tile[], value: Tile) { receiver = this; this[0] = value; } });
  (tiles as unknown as { other: Tile }).other = raw;
  assert.equal(receiver, tiles); assert.equal(tiles[0], raw); assert.equal(residentTopologyToken(tiles), undefined);
  tiles[0] = tile; assert.ok(residentTopologyToken(tiles));
  delete (tiles as unknown as Record<string, unknown>)['0']; assert.equal(residentTopologyToken(tiles), undefined);
  tiles[0] = tile; assert.ok(residentTopologyToken(tiles));
});

test('mismas referencias ordinarias no son certificado; el fallback detecta reemplazo, coordenadas y reflexión', () => {
  const store = new TileStore(), tiles = [fixture(), fixture(-15, -16)];
  store.prepareParallel(tiles); store.prepareParallel(tiles);
  assert.equal(residentTopologyToken(tiles), undefined); assert.equal(store.parallelTopologyDiagnostics.genericCheckedTiles, 2);
  tiles[1] = fixture(512, -512); tiles[0]!.x = -0;
  const before = snapshot(tiles);
  store.prepareParallel(tiles); exact(tiles, before);
  Object.defineProperty(tiles[0]!, 'life', { value: -0, writable: true, configurable: true, enumerable: true });
  const reflected = snapshot(tiles);
  store.prepareParallel(tiles); exact(tiles, reflected);
  assert.ok(Object.is(store.lifeFront[store.cells[0]!], -0));
  delete tiles[0]!.feature;
  store.prepareParallel(tiles); assert.equal(Object.hasOwn(tiles[0]!, 'feature'), false);
});

for (const mutation of ['replace', 'reverse', 'splice', 'pop-push', 'length'] as const) {
  test(`certificado invalida ${mutation} aun con tamaño final idéntico`, () => {
    const owner = new ResidentTopologyOwner(), a = owner.tile(fixture()), b = owner.tile(fixture(-15, -16)), c = owner.tile(fixture(512, -512));
    const tiles = owner.tiles([a, b]), store = new TileStore();
    store.prepareParallel(tiles); const token = residentTopologyToken(tiles);
    if (mutation === 'replace') tiles[0] = c;
    if (mutation === 'reverse') tiles.reverse();
    if (mutation === 'splice') tiles.splice(0, 1, c);
    if (mutation === 'pop-push') { tiles.pop(); tiles.push(c); }
    if (mutation === 'length') { tiles.length = 1; tiles.push(c); }
    assert.equal(tiles.length, 2); assert.equal(sameResidentTopology(token, residentTopologyToken(tiles)), false);
    const before = snapshot(tiles), refs = tiles.slice(); store.prepareParallel(tiles); exact(tiles, before);
    assert.equal(tiles[0], refs[0]); assert.equal(tiles[1], refs[1]);
    for (let i = 0; i < tiles.length; i++) {
      const point = store.coordinates(store.cells[i]!);
      assert.equal(point.x, tiles[i]!.x); assert.equal(point.y, tiles[i]!.y);
    }
    assert.equal(store.parallelTopologyDiagnostics.rebuilds, 2);
  });
}

test('coords por asignación/defineProperty se observan; getters revocan y sus cambios se leen por fallback', () => {
  const owner = new ResidentTopologyOwner(), tile = owner.tile(fixture()), tiles = owner.tiles([tile]), store = new TileStore();
  store.prepareParallel(tiles); tile.x = -0; tile.y = 512;
  store.prepareParallel(tiles); assert.ok(Object.is(tile.x, -0)); assert.equal(store.coordinates(store.cells[0]!).y, 512);
  Object.defineProperty(tile, 'x', { value: 1024, configurable: true, enumerable: true, writable: true });
  store.prepareParallel(tiles); assert.equal(store.coordinates(store.cells[0]!).x, 1024);
  let x = 2048;
  Object.defineProperty(tile, 'x', { get: () => x, configurable: true, enumerable: true });
  assert.equal(residentTopologyToken(tiles), undefined);
  store.prepareParallel(tiles); x = 4096; store.prepareParallel(tiles);
  assert.equal(store.coordinates(store.cells[0]!).x, 4096, 'valor cambiado por closure, sin asignación observable');
  delete (tile as Partial<Tile>).x;
  assert.throws(() => store.prepareParallel(tiles), /Coordenada fuera/);
  assert.equal(Object.hasOwn(tile, 'x'), false);
});

test('raw insertado y getter de índice revocan: no convierten identidades ni ocultan mutaciones', () => {
  const owner = new ResidentTopologyOwner(), a = owner.tile(fixture()), tiles = owner.tiles([a]), store = new TileStore(), raw = fixture(512, 512);
  store.prepareParallel(tiles); tiles[0] = raw;
  assert.equal(tiles[0], raw); assert.equal(residentTopologyToken(tiles), undefined);
  store.prepareParallel(tiles); raw.x = 513; store.prepareParallel(tiles);
  assert.equal(store.coordinates(store.cells[0]!).x, 513);
  tiles[0] = a; assert.ok(residentTopologyToken(tiles)); store.prepareParallel(tiles);
  let current: Tile = a;
  Object.defineProperty(tiles, '0', { get: () => current, configurable: true, enumerable: true });
  assert.equal(residentTopologyToken(tiles), undefined);
  store.prepareParallel(tiles); current = raw; store.prepareParallel(tiles);
  assert.equal(store.coordinates(store.cells[0]!).x, 513);
});

test('alta de wood/feature y reflexión de life entran mediante eventos sin barrer ausentes', () => {
  const owner = new ResidentTopologyOwner(), tile = owner.tile(fixture()), tiles = owner.tiles([tile]), store = new TileStore();
  store.prepareParallel(tiles); const keys = Object.keys(tile), token = residentTopologyToken(tiles);
  tile.wood = -0; tile.feature = 'spring';
  Object.defineProperty(tile, 'life', { value: -0, writable: true, configurable: true, enumerable: true });
  assert.ok(sameResidentTopology(token, residentTopologyToken(tiles)));
  const before = snapshot(tiles), terrain = store.prepareParallel(tiles), cell = store.cells[0]!;
  exact(tiles, before); assert.deepEqual(Object.keys(tile), [...keys, 'wood', 'feature']);
  assert.ok(Object.is(new Float64Array(terrain.buffers.wood!)[cell], -0));
  assert.ok(Object.is(new Float64Array(terrain.buffers.life!)[cell], -0));
  assert.equal(new Uint8Array(terrain.buffers.feature!)[cell], 11);
  assert.equal(store.parallelTopologyDiagnostics.genericCheckedTiles, 0); assert.equal(store.parallelTopologyDiagnostics.changedBindings, 1);
  delete tile.wood; delete tile.life;
  const removed = snapshot(tiles), next = store.prepareParallel(tiles); exact(tiles, removed);
  assert.ok(Number.isNaN(new Float64Array(next.buffers.wood!)[cell]));
  store.beginParallel(); copyBacks(next); store.commitParallel();
  assert.equal(Object.hasOwn(tile, 'wood'), false); assert.equal(Object.hasOwn(tile, 'life'), true);
});

test('NaN/enum inválidos por reflexión owner se rechazan sin saneamiento ni escribir el frente', () => {
  for (const [key, value] of [['life', Number.NaN], ['wood', Number.NaN], ['feature', 'volcán']] as const) {
    const owner = new ResidentTopologyOwner(), tile = owner.tile(fixture()), tiles = owner.tiles([tile]), store = new TileStore();
    store.prepareParallel(tiles); const before = Buffer.from(store.lifeFront.buffer).slice();
    Object.defineProperty(tile, key, { value, writable: true, configurable: true, enumerable: true });
    assert.throws(() => store.prepareParallel(tiles), RangeError);
    assert.ok(Object.is((tile as unknown as Record<string, unknown>)[key], value));
    assert.deepEqual(Buffer.from(store.lifeFront.buffer), before);
    store.releaseParallelObjects(); assert.ok(Object.is((tile as unknown as Record<string, unknown>)[key], value));
  }
});

test('durante autoridad worker, coords/campos/reflexión y array no pueden mutar; abort devuelve permiso', () => {
  const owner = new ResidentTopologyOwner(), tile = owner.tile(fixture()), tiles = owner.tiles([tile]), store = new TileStore();
  store.prepareParallel(tiles); const before = snapshot(tiles), token = residentTopologyToken(tiles);
  store.beginParallel();
  for (const mutation of [() => { tile.x = 2; }, () => { tile.food = 4; }, () => { tile.wood = 4; },
    () => Object.defineProperty(tile, 'x', { value: 2 }), () => { delete tile.life; },
    () => { tiles[0] = owner.tile(fixture(512, 512)); }, () => tiles.pop(),
    () => Object.defineProperty(tiles, '0', { value: owner.tile(fixture(512, 512)) })])
    assert.throws(mutation, /escrituras sin volcar/);
  exact(tiles, before); assert.ok(sameResidentTopology(token, residentTopologyToken(tiles)));
  store.abortParallel(); tile.x = 2; store.prepareParallel(tiles); assert.equal(store.coordinates(store.cells[0]!).x, 2);
});

test('poda/alta/reuso materializan dormidos; clone conserva foto y transferencia excluye dos arenas', () => {
  const owner = new ResidentTopologyOwner(), old = owner.tile(fixture()), tiles = owner.tiles([old]), store = new TileStore();
  store.prepareParallel(tiles); const before = snapshot(tiles), slot = store.cells[0]! >>> 8;
  tiles.pop(); store.prepareParallel(tiles); assert.equal(store.pages, 0);
  const replacement = owner.tile(fixture(512, -512)); tiles.push(replacement); store.prepareParallel(tiles);
  assert.equal(store.cells[0]! >>> 8, slot); exact([old], before);
  old.life = 0.01; assert.equal(replacement.life, 0.75, 'dormido no escribe ranura reutilizada');
  const copyOwner = new ResidentTopologyOwner(), copied = copyOwner.tiles(tiles.map(tile => copyOwner.tile(tile))), other = new TileStore();
  other.prepareParallel(copied); assert.notEqual(copied[0], tiles[0]); exact(copied, snapshot(tiles));
  store.beginParallel(); const sharing = owner.tiles(tiles);
  assert.throws(() => other.prepareParallel(sharing), /escrituras sin volcar/);
  store.abortParallel(); other.prepareParallel(sharing); replacement.life = -0;
  assert.ok(Object.is(other.lifeFront[other.cells[0]!], -0));
  assert.equal(store.lifeFront[store.cells[0]!], 0.75);
});

for (const protocol of [0, 1]) test(`alta de wood sólo publica tras barrera (protocolo ${protocol}, fallback explícito)`, () => {
  const owner = new ResidentTopologyOwner(), tile = owner.tile({ ...fixture(), feature: 'tree' }), tiles = owner.tiles([tile]), store = new TileStore();
  const terrain = store.prepareParallel(tiles), cell = store.cells[0]!, page = cell >>> 8, keys = Object.keys(tile);
  store.beginParallel(); copyBacks(terrain);
  new Float64Array(terrain.buffers.woodBack!)[cell] = 0.125;
  new Uint8Array(terrain.buffers.woodAdded!)[page] = 1;
  const queue = new Int32Array(terrain.buffers.woodAddedQueue!);
  queue[0] = protocol; queue[1] = 1; queue[2] = page;
  assert.equal(Object.hasOwn(tile, 'wood'), false); store.commitParallel();
  assert.equal(tile.wood, 0.125); assert.deepEqual(Object.keys(tile), [...keys, 'wood']);
  assert.equal(new Uint8Array(terrain.buffers.woodAdded!)[page], 0);
  store.prepareParallel(tiles); assert.equal(queue[0], 0); assert.equal(queue[1], 0);
});

test('cola de altas inválida conserva frente/autoridad; abort limpia flags antes de reintentar', () => {
  for (const bad of ['count', 'negative', 'duplicate', 'flag', 'protocol'] as const) {
    const owner = new ResidentTopologyOwner(), tile = owner.tile({ ...fixture(), feature: 'tree' }), tiles = owner.tiles([tile]), store = new TileStore();
    const terrain = store.prepareParallel(tiles), front = store.lifeFront, cell = store.cells[0]!, page = cell >>> 8;
    store.beginParallel(); copyBacks(terrain); new Float64Array(terrain.buffers.lifeBack!)[cell] = 0.125;
    const queue = new Int32Array(terrain.buffers.woodAddedQueue!), flags = new Uint8Array(terrain.buffers.woodAdded!);
    queue[0] = 1; queue[1] = 1; queue[2] = page; flags[page] = 1;
    if (bad === 'count') queue[1] = queue.length;
    if (bad === 'negative') queue[2] = -1;
    if (bad === 'duplicate') { queue[1] = 2; queue[3] = page; }
    if (bad === 'flag') flags[page] = 0;
    if (bad === 'protocol') queue[0] = 2;
    assert.throws(() => store.commitParallel(), /altas de wood/);
    assert.equal(store.lifeFront, front); assert.equal(tile.life, 0.75); assert.equal(Object.hasOwn(tile, 'wood'), false);
    assert.throws(() => { tile.life = 0; }, /escrituras sin volcar/);
    store.abortParallel(); assert.ok(flags.every(flag => flag === 0)); assert.equal(queue[0], 0); assert.equal(queue[1], 0);
    const retry = store.prepareParallel(tiles); store.beginParallel(); copyBacks(retry); store.commitParallel();
    assert.equal(tile.life, 0.75);
  }
});
