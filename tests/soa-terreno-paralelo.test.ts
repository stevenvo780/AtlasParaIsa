import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tile } from '../src/shared/types.js';
import { TileStore, type SharedTerrain } from '../src/world/soa/terreno.js';
import { EcosystemKernel, type EcosystemOptions } from '../src/world/ecosystem-kernel.js';

const clone = (tiles: readonly Tile[]): Tile[] => tiles.map(tile => ({ ...tile }));
const bytes = (tiles: readonly Tile[]): Buffer => Buffer.from(new Float64Array(tiles.flatMap(tile =>
  Object.values(tile).filter((value): value is number => typeof value === 'number'))).buffer);

function assertExact(actual: readonly Tile[], expected: readonly Tile[], label: string): void {
  assert.equal(actual.length, expected.length, label);
  for (let i = 0; i < actual.length; i++) {
    assert.deepEqual(Object.keys(actual[i]!), Object.keys(expected[i]!), `${label}: claves de ${i}`);
    for (const key of Object.keys(expected[i]!) as (keyof Tile)[])
      assert.ok(Object.is(actual[i]![key], expected[i]![key]), `${label}: ${i}.${key}`);
  }
  assert.deepEqual(bytes(actual), bytes(expected), `${label}: bytes FP64`);
}

function fixture(x = -16, y = -16): Tile[] {
  return [{ x, y, terrain: 'meadow', biome: 'forest', moisture: 0.9, vegetation: -0, food: -0,
    life: 0.75, growth: 0.9, fertility: 0.9, cultivation: 0, traffic: -0, drinkingWater: 0,
    feature: undefined, wood: undefined, species: undefined },
  { x: x + 1, y, terrain: 'meadow', biome: 'forest', moisture: 0.4, vegetation: 0.5, food: 0.2,
    life: undefined, growth: undefined, fertility: undefined, cultivation: undefined, traffic: undefined,
    drinkingWater: undefined, feature: undefined }];
}

// Emula sólo la escritura de una pasada completa: nunca publica el fondo al objeto.
function copyBacks(terrain: SharedTerrain): void {
  for (const [key, buffer] of Object.entries(terrain.buffers)) if (key.endsWith('Back'))
    new Uint8Array(buffer).set(new Uint8Array(terrain.buffers[key.slice(0, -4)]!));
}

test('beginParallel excluye setters y cargas; abort conserva frente, claves y campos antes de devolver la autoridad', () => {
  const store = new TileStore(), tiles = fixture();
  tiles.push({ x: -16, y: -15, terrain: 'soil', moisture: 0.1, vegetation: 0.2, food: 0 });
  const before = clone(tiles), terrain = store.prepareParallel(tiles), front = store.lifeFront;
  const frontBytes = Buffer.from(front.buffer).slice(), index = store.cells[0]!;
  store.beginParallel();
  assert.throws(() => { tiles[0]!.life = 0.01; }, /escrituras sin volcar/);
  assert.throws(() => { tiles[0]!.moisture = 0; }, /escrituras sin volcar/);
  assert.throws(() => { tiles[0]!.wood = 5; }, /escrituras sin volcar/);
  assert.throws(() => { tiles[0]!.feature = 'tree'; }, /escrituras sin volcar/);
  assert.throws(() => store.beginParallel(), /escrituras sin volcar/);
  assert.throws(() => store.loadLife(tiles), /escrituras sin volcar/);
  assert.throws(() => store.pack(tiles), /escrituras sin volcar/);
  assert.throws(() => store.prepareParallel(tiles), /escrituras sin volcar/);
  assert.throws(() => store.releaseParallelObjects(), /escrituras sin volcar/);
  new Float64Array(terrain.buffers.lifeBack!)[index] = 0.123;
  new Float64Array(terrain.buffers.moistureBack!)[index] = 0.456;
  assertExact(tiles, before, 'scratch no publicado durante la pasada');
  store.abortParallel();
  assert.equal(store.lifeFront, front);
  assert.deepEqual(Buffer.from(store.lifeFront.buffer), frontBytes);
  assertExact(tiles, before, 'abortar no añade las claves ecológicas ausentes ni publica el fondo');
  assert.throws(() => store.commitParallel(), /escritura sin autoridad/);
  tiles[0]!.life = -0;
  assert.ok(Object.is(store.lifeFront[index], -0), 'después del abort el setter vuelve a escribir el frente');
});

test('commitParallel publica el fondo una sola vez; el frente anterior y la forma de los objetos se conservan', () => {
  const store = new TileStore(), tiles = fixture(), expected = clone(tiles);
  const terrain = store.prepareParallel(tiles), front = store.lifeFront, index = store.cells[0]!;
  const frontBytes = Buffer.from(front.buffer).slice();
  assert.throws(() => store.commitParallel(), /escritura sin autoridad/);
  store.beginParallel();
  copyBacks(terrain);
  new Float64Array(terrain.buffers.lifeBack!)[index] = 0.123;
  new Float64Array(terrain.buffers.moistureBack!)[index] = -0;
  new Float64Array(terrain.buffers.fertilityBack!)[index] = 0.8;
  expected[0]!.life = 0.123; expected[0]!.moisture = -0; expected[0]!.fertility = 0.8;
  assert.notEqual(tiles[0]!.life, expected[0]!.life, 'los Tile todavía leen el frente');
  store.commitParallel();
  assert.equal(store.lifeFront.buffer, terrain.buffers.lifeBack);
  assert.notEqual(store.lifeFront, front);
  assert.deepEqual(Buffer.from(front.buffer), frontBytes, 'el worker sólo escribió el fondo');
  assertExact(tiles, expected, 'publicación completa');
  assert.throws(() => store.commitParallel(), /escritura sin autoridad/, 'no admite un segundo swap sin otra pasada');
  tiles[0]!.traffic = 0.125;
  assert.equal(tiles[0]!.traffic, 0.125, 'la publicación devuelve la autoridad de escritura a objetos');
});

for (const method of ['loadLife', 'pack'] as const) {
  test(`${method} materializa residentes antes de cargar otra foto o reutilizar su ranura`, () => {
    const store = new TileStore(), a = fixture(), beforeA = clone(a);
    store.prepareParallel(a);
    const slot = store.cells[0]! >>> 8;
    const reload = (tiles: Tile[]): void => {
      if (method === 'loadLife') assert.ok(store.loadLife(tiles));
      else store.pack(tiles);
    };
    const sameCoordinates = fixture().map(tile => ({ ...tile, life: 0.02 }));
    reload(sameCoordinates);
    assertExact(a, beforeA, 'la foto con otro life no alcanza a los objetos anteriores');
    assert.equal(Object.getOwnPropertyDescriptor(a[0]!, 'life')?.get, undefined);
    store.prepareParallel(a);
    reload([]);
    assert.equal(store.pages, 0, 'la página original se retira');
    const otherRegion = fixture(512, -512).map(tile => ({ ...tile, life: 0.03125 }));
    const beforeOther = clone(otherRegion);
    reload(otherRegion);
    assert.equal(store.cells[0]! >>> 8, slot, 'se reutiliza realmente la ranura de la arena');
    assertExact(a, beforeA, 'una región nueva no puede aparecer en los objetos dormidos');
    assertExact(otherRegion, beforeOther, 'cargar no modifica los objetos nuevos');
    assert.ok(Object.is(store.lifeFront[store.cells[0]!], 0.03125));
    a[0]!.life = -0;
    assert.ok(Object.is(store.lifeFront[store.cells[0]!], 0.03125), 'el objeto desligado ya no escribe la ranura reutilizada');
    assertExact(otherRegion, beforeOther, 'independencia al escribir el objeto anterior');
  });
}

test('desligar materializa sólo los accessors propios y conserva wood o life ordinarios creados después', () => {
  const store = new TileStore(), tile: Tile = { x: -1, y: -1, terrain: 'meadow', biome: 'forest', moisture: 0.9,
    vegetation: 0.7, food: -0, life: 0.5, growth: 0.9, fertility: 0.9, traffic: -0, feature: undefined, species: undefined };
  store.prepareParallel([tile]);
  assert.equal(Object.hasOwn(tile, 'wood'), false);
  tile.wood = 0.125;
  Object.defineProperty(tile, 'life', { value: -0, writable: true, enumerable: true, configurable: true });
  const expected = clone([tile]);
  store.releaseParallelObjects();
  assertExact([tile], expected, 'desligar conserva las propiedades ordinarias nuevas');
  assert.equal(Object.getOwnPropertyDescriptor(tile, 'wood')?.get, undefined);
  assert.equal(Object.getOwnPropertyDescriptor(tile, 'life')?.get, undefined);
  const terrain = store.prepareParallel([tile]), index = store.cells[0]!;
  assert.equal(new Float64Array(terrain.buffers.wood!)[index], 0.125);
  assert.ok(Object.is(new Float64Array(terrain.buffers.life!)[index], -0));
  assertExact([tile], expected, 'el siguiente enlace parte de las propiedades ordinarias conservadas');
});

test('wood y feature ordinarios creados entre despachos del mismo array entran en ambos frentes sin alterar la referencia serial', async t => {
  const parallel = new EcosystemKernel(), serial = new EcosystemKernel();
  t.after(async () => { await Promise.all([parallel.closeParallelPool(), serial.closeParallelPool()]); });
  const actual = fixture();
  for (const tile of actual) { delete tile.wood; delete tile.feature; }
  const expected = clone(actual), references = actual.slice();
  const options: EcosystemOptions = { hilos: 2, soaTerreno: true, seed: 51926, cuencas: 1, decaimientoFertilidad: 0.001 };
  serial.step(expected, 10, 'clear', 'day', { ...options, hilos: 1, soaTerreno: false });
  parallel.step(actual, 10, 'clear', 'day', options);
  assertExact(actual, expected, 'primer despacho sin claves opcionales');
  assert.ok(actual.every(tile => !Object.hasOwn(tile, 'wood') && !Object.hasOwn(tile, 'feature')));
  const front = parallel.soaStore!.lifeFront, dispatches = parallel.parallelDiagnostics!.dispatches;
  for (const set of [actual, expected]) for (const tile of set) { tile.wood = 7; tile.feature = 'spring'; }
  assert.equal(Object.getOwnPropertyDescriptor(actual[0]!, 'wood')?.get, undefined);
  assert.equal(Object.getOwnPropertyDescriptor(actual[0]!, 'feature')?.get, undefined);
  for (const tick of [20, 30, 40]) {
    serial.step(expected, tick, 'rain', 'day', { ...options, hilos: 1, soaTerreno: false });
    parallel.step(actual, tick, 'rain', 'day', options);
    assertExact(actual, expected, `claves creadas entre despachos, tick ${tick}`);
    assert.ok(actual.every((tile, i) => tile === references[i]), 'mismo array y mismos objetos durante todos los despachos');
    assert.ok(actual.every(tile => tile.wood === 7 && tile.feature === 'spring'));
    assert.ok(Object.is(actual[0]!.food, -0) && Object.hasOwn(actual[0]!, 'species') && actual[0]!.species === undefined);
    assert.equal(parallel.parallelDiagnostics!.dispatches, dispatches + (tick - 10) / 10);
    if (tick === 30) assert.equal(parallel.soaStore!.lifeFront, front, 'se vuelve también al frente del primer despacho');
    else assert.notEqual(parallel.soaStore!.lifeFront, front, 'el otro frente también conserva las claves nuevas');
  }
});

test('NaN y enumerados inválidos se rechazan antes de enlazar cualquier Tile y conservan el estado inválido', () => {
  const invalid: [keyof Tile, unknown][] = [['life', Number.NaN], ['growth', Number.NaN], ['wood', Number.NaN],
    ['feature', 'volcán'], ['terrain', 'lava'], ['biome', 'tundra'], ['moisture', '0.9']];
  for (const [key, value] of invalid) {
    const store = new TileStore(), tiles = fixture();
    (tiles[1]! as unknown as Record<string, unknown>)[key] = value;
    const before = clone(tiles), descriptors = tiles.map(tile => Object.getOwnPropertyDescriptors(tile));
    assert.throws(() => store.prepareParallel(tiles), RangeError, `rechazo de ${key}=${String(value)}`);
    assertExact(tiles, before, `rechazar ${key} no sanea ni sustituye el valor`);
    assert.deepEqual(tiles.map(tile => Object.getOwnPropertyDescriptors(tile)), descriptors, 'ni siquiera el primer Tile válido queda enlazado');
    assert.equal(store.tileCount, 0); assert.equal(store.pages, 0);
    const valid = fixture();
    store.prepareParallel(valid);
    assertExact(tiles, before, 'el rechazo no dejó enlaces que alcancen una carga posterior');
  }
});

test('otra arena no puede tomar los mismos Tile mientras la autoridad paralela está en curso', () => {
  const a = new TileStore(), b = new TileStore(), tiles = fixture();
  const terrain = a.prepareParallel(tiles), before = clone(tiles), front = a.lifeFront;
  const descriptors = tiles.map(tile => Object.getOwnPropertyDescriptors(tile));
  const frontBytes = Buffer.from(front.buffer).slice(), index = a.cells[0]!;
  a.beginParallel();
  new Float64Array(terrain.buffers.lifeBack!)[index] = 0.123;
  assert.throws(() => b.prepareParallel(tiles), /escrituras sin volcar/);
  assertExact(tiles, before, 'el intento de otra arena no cambia valores ni claves');
  assert.deepEqual(tiles.map(tile => Object.getOwnPropertyDescriptors(tile)), descriptors, 'se preservan los accessors del dueño en curso');
  assert.equal(a.lifeFront, front); assert.deepEqual(Buffer.from(front.buffer), frontBytes);
  assert.equal(b.tileCount, 0); assert.equal(b.pages, 0);
  assert.throws(() => { tiles[0]!.life = 0.25; }, /escrituras sin volcar/, 'el intento fallido no libera la autoridad original');
  a.abortParallel();
  tiles[0]!.life = -0;
  const afterAbort = clone(tiles);
  b.prepareParallel(tiles);
  assertExact(tiles, afterAbort, 'la transferencia se permite después de devolver la autoridad');
  tiles[0]!.life = 0.375;
  assert.equal(b.lifeFront[b.cells[0]!], 0.375);
  assert.ok(Object.is(a.lifeFront[index], -0), 'el nuevo dueño ya no escribe en la arena anterior');
});
