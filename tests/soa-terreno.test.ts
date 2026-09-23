import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tile } from '../src/shared/types.js';
import { EcosystemKernel, buildTopology, type EcosystemOptions } from '../src/world/ecosystem-kernel.js';
import { initializeEcosystem } from '../src/world/ecosystem.js';
import { generateChunk } from '../src/world/terrain.js';
import { cloneWorld, createWorld, stepWorld } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { HISTORICAL_PARAMS, paramsOf, parseParams, setParams } from '../src/world/params.js';
import { TileStore } from '../src/world/soa/terreno.js';

/**
 * T112: `TileStore` SoA con máscara de presencia y doble buffer, y la topología del kernel de ecología
 * sobre él (`motor.soaTerreno`). La comparación es siempre contra el camino de objetos de hoy, con
 * `Object.is` (vía `deepStrictEqual`) y además el JSON de las teselas, que fija el orden de claves.
 */
const cloneTiles = (tiles: Tile[]): Tile[] => tiles.map(tile => ({ ...tile }));
const chunk = (seed: number, cx: number, cy: number, keep: (i: number) => boolean = () => true): Tile[] =>
  generateChunk(seed, cx, cy).tiles.filter((_, i) => keep(i)).map(tile => initializeEcosystem(seed, tile, 0.4));
function cell(x: number, y: number, changes: Partial<Tile> = {}): Tile {
  return { x, y, terrain: 'meadow', biome: 'grassland', moisture: 0.8, vegetation: 0.5, food: 0.2, ...changes };
}
/** Conjunto disperso: chunks negativos y a ambos lados de la frontera de región 256, con huecos,
 * chunks parciales y celdas sueltas lejos de todo. */
function sparse(seed = 51926): Tile[] {
  const tiles: Tile[] = [];
  for (const [cx, cy] of [[-1, -1], [0, -1], [-1, 0], [0, 0], [15, 0], [16, 0], [16, 1], [-17, -16], [-16, -16]] as const)
    tiles.push(...chunk(seed, cx, cy, i => (i * 7 + cx) % 11 !== 0));
  tiles.push(cell(1000, -1000, { life: 1 }), cell(1001, -999, { life: 0.9 }), cell(-4097, 4095, { life: 1 }));
  return tiles;
}

test('empaquetar y desempaquetar un mundo real da el mismo digestoCanonico, también por volcado', () => {
  const world = createWorld(51926, HISTORICAL_PARAMS);
  for (let n = 0; n < 200; n++) stepWorld(world);
  const store = new TileStore();
  store.pack(world.tiles);
  const unpacked = cloneWorld(world); unpacked.tiles = store.unpack();
  assert.equal(digestoCanonico(unpacked), digestoCanonico(world));
  assert.deepStrictEqual(unpacked.tiles, world.tiles);
  // Autoridad de la SoA y volcado sobre objetos rancios: vuelve exactamente el mundo empaquetado.
  const stale = cloneWorld(world);
  for (const tile of stale.tiles) { tile.moisture = 0; delete tile.life; tile.species = 'wolf'; }
  store.take(); store.flush(stale.tiles);
  assert.equal(digestoCanonico(stale), digestoCanonico(world));
});

test('la ida y vuelta conserva -0, campos ausentes, chunks parciales, negativos y varias regiones', () => {
  const tiles = [...sparse(),
    cell(300, 5, { food: -0, wood: -0, fauna: 0, species: 'fish', terrain: 'water', biome: 'ocean' }),
    { x: 301, y: 5, terrain: 'soil', moisture: 0, vegetation: 0, food: 0 } as Tile,
    cell(-257, -256, { elevation: 0.999, variety: 3, stone: 4, feature: 'rock', growth: 1e-300 })];
  const store = new TileStore();
  store.pack(tiles);
  const back = store.unpack();
  assert.deepStrictEqual(back, tiles);
  assert.ok(Object.is(back.at(-3)!.food, -0) && Object.is(back.at(-3)!.wood, -0));
  assert.equal('biome' in back.at(-2)!, false);
  assert.ok(store.regionCount >= 6, `regiones: ${store.regionCount}`);
  assert.throws(() => store.pack([cell(0, 0, { feature: 'volcán' as never })]), RangeError);
  assert.throws(() => store.pack([{ ...cell(0, 0), extra: 1 } as Tile]), RangeError);
  assert.throws(() => store.pack([cell(-0, 0)]), RangeError);
  assert.throws(() => store.pack([cell(0.5, 0)]), RangeError);
  assert.throws(() => store.pack([cell(0, 0, { growth: Number.NaN })]), RangeError);
});

test('los vecinos por aritmética coinciden uno a uno con buildTopology en un conjunto activo disperso', () => {
  const tiles = sparse(), store = new TileStore();
  assert.ok(store.loadLife(tiles));
  const topology = buildTopology(tiles), tileOf = new Map<number, number>(), out = new Int32Array(8);
  for (let i = 0; i < tiles.length; i++) tileOf.set(store.cells[i]!, i);
  let borders = 0;
  for (let i = 0; i < tiles.length; i++) {
    const cells = store.neighbors(store.cells[i]!, out);
    const expected = [...topology.neighbors.subarray(i * 8, i * 8 + 8)];
    assert.deepStrictEqual([...cells].map(c => c < 0 ? -1 : tileOf.get(c)!), expected, `tesela ${i} (${tiles[i]!.x},${tiles[i]!.y})`);
    if (expected.includes(-1)) borders++;
    const { x, y } = store.coordinates(store.cells[i]!);
    assert.ok(Object.is(x, tiles[i]!.x) && Object.is(y, tiles[i]!.y));
  }
  assert.ok(borders > 500, `el conjunto debe tener mucho borde: ${borders}`);
});

test('la máscara de presencia existe por esto: sin ella una celda ausente aparece como vecina viva', () => {
  const full = chunk(7, 3, -2).map(tile => ({ ...tile, life: 1 }));
  const store = new TileStore();
  assert.ok(store.loadLife(full));
  // Misma página, una celda menos: su ranura conserva el `life` = 1 de la carga anterior.
  const missing = full.findIndex(tile => tile.x === 3 * 16 + 5 && tile.y === -2 * 16 + 5);
  const partial = full.filter((_, i) => i !== missing);
  assert.ok(store.loadLife(partial));
  const probe = partial.findIndex(tile => tile.x === 3 * 16 + 6 && tile.y === -2 * 16 + 5), probeCell = store.cells[probe]!;
  const topology = buildTopology(partial), expected = [...topology.neighbors.subarray(probe * 8, probe * 8 + 8)];
  const masked = [...store.neighbors(probeCell, new Int32Array(8))], unmasked = [...store.neighbors(probeCell, new Int32Array(8), false)];
  assert.equal(expected[3], -1, 'buildTopology: la vecina de la izquierda no está');
  assert.equal(masked[3], -1, 'con máscara conserva el -1');
  assert.ok(unmasked[3]! >= 0, 'sin máscara la ranura reservada aparece como vecina');
  const living = (cells: number[]) => cells.filter(c => c >= 0 && store.lifeFront[c]! >= 0.45).length;
  assert.equal(living(masked), 7); assert.equal(store.livingNeighbors(probeCell, 0.45), 7);
  assert.equal(living(unmasked), 8, 'sin máscara livingNeighbors cambia de 7 a 8');
  // Y el kernel con SoA reproduce el de objetos sobre el conjunto parcial.
  const soa = cloneTiles(partial), objects = cloneTiles(partial);
  new EcosystemKernel().step(soa, 10, 'clear', 'day', { soaTerreno: true });
  new EcosystemKernel().step(objects, 10, 'clear', 'day');
  assert.deepStrictEqual(soa, objects);
});

for (const cuencas of [1, 0.4]) for (const decaimientoFertilidad of [0, 0.001]) {
  test(`kernel con topología SoA = kernel de objetos en 120 actualizaciones, cuencas=${cuencas}, decaimiento=${decaimientoFertilidad}`, () => {
    let objects = sparse(42);
    objects.push(cell(2000, 0, { terrain: 'water', biome: 'ocean', drinkingWater: 0.9 }),
      cell(2001, 0, { feature: 'stump', wood: 0.999, growth: 0.9, fertility: 0.9, moisture: 0.9 }));
    for (const x of [-49, -25, -24, -1, 0, 23, 24, 49]) objects.push(cell(x, -300, { feature: 'spring', fertility: 0.9, moisture: 0.9, drinkingWater: 0.2 }));
    let soa = cloneTiles(objects);
    const soaKernel = new EcosystemKernel(), objectKernel = new EcosystemKernel();
    const extra = chunk(42, 40, 40);
    let regrown = false;
    for (let n = 0; n < 120; n++) {
      // El mismo reemplazo de objetos que hace cloneWorld, y altas, bajas y reordenaciones del conjunto.
      objects = cloneTiles(objects); soa = cloneTiles(soa);
      if (n === 20) { objects.reverse(); soa.reverse(); }
      if (n === 40) { objects.push(...cloneTiles(extra)); soa.push(...cloneTiles(extra)); }
      const outsideExtra = (t: Tile): boolean => t.x < 640 || t.x >= 656 || t.y < 640 || t.y >= 656;
      if (n === 60) { objects = objects.filter(outsideExtra); soa = soa.filter(outsideExtra); }
      if (n === 80) { objects = objects.filter((_, i) => i % 5 !== 2); soa = soa.filter((_, i) => i % 5 !== 2); }
      const tick = (n + 1) * 10, weather = n % 3 ? 'clear' : 'rain', phase = ['day', 'night', 'dawn', 'dusk'][n % 4]!;
      const options: EcosystemOptions = { decaimientoFertilidad, seed: 42, cuencas };
      objectKernel.step(objects, tick, weather, phase, options);
      soaKernel.step(soa, tick, weather, phase, { ...options, soaTerreno: true });
      assert.deepStrictEqual(soa, objects, `actualización ${n}`);
      assert.equal(JSON.stringify(soa), JSON.stringify(objects), `orden de claves, actualización ${n}`);
      assert.equal(soaKernel.cachedTopologyCount, 0);
      regrown ||= soa.some(tile => tile.x === 2001 && tile.feature === 'tree');
    }
    assert.ok(regrown, 'el tocón rebrota: la rama de madera se ejerce');
  });
}

test('con SoA las coordenadas duplicadas lanzan igual sin tocar teselas; fuera del dominio entero vuelve a objetos', () => {
  const kernel = new EcosystemKernel(), actual = [cell(0, 0, { life: 1 }), cell(1, 0, { life: 1 }), cell(0, 1, { life: 1 })];
  kernel.step(actual, 10, 'rain', 'day', { soaTerreno: true });
  actual[1]!.x = 0; actual[1]!.y = 1;
  const before = cloneTiles(actual);
  assert.throws(() => kernel.step(actual, 20, 'rain', 'day', { soaTerreno: true }), /coordenadas únicas/);
  assert.deepStrictEqual(actual, before);
  actual[1]!.x = 1; actual[1]!.y = 1;
  const expected = cloneTiles(actual);
  kernel.step(actual, 20, 'rain', 'day', { soaTerreno: true }); new EcosystemKernel().step(expected, 20, 'rain', 'day');
  assert.deepStrictEqual(actual, expected); assert.equal(kernel.cachedTopologyCount, 0);
  const odd = [cell(0.5, 0, { life: 1 }), cell(1.5, 0, { life: 1 })], oddExpected = cloneTiles(odd);
  kernel.step(odd, 30, 'clear', 'day', { soaTerreno: true }); new EcosystemKernel().step(oddExpected, 30, 'clear', 'day');
  assert.deepStrictEqual(odd, oddExpected); assert.equal(kernel.cachedTopologyCount, 1, 'camino de objetos documentado');
});

test('una sola autoridad por página: objeto y SoA nunca son escribibles a la vez', () => {
  const tiles = chunk(51926, 0, 0), store = new TileStore();
  store.pack(tiles);
  const target = store.cells[17]!;
  assert.throws(() => store.write('moisture', target, 0.5), /sin autoridad/);
  assert.throws(() => store.writeLife(target, 0.5), /sin autoridad/);
  assert.throws(() => store.swapLife(), /sin autoridad/);
  store.take();
  store.write('moisture', target, 0.5);
  assert.deepStrictEqual(store.dirtyPages(), [target >>> 8]);
  assert.throws(() => store.pack(tiles), /objeto y SoA/);
  assert.throws(() => store.loadLife(tiles), /objeto y SoA/);
  // Doble buffer: las escrituras van al fondo y el frente no cambia hasta el intercambio.
  const before = store.lifeAt(target);
  for (let i = 0; i < tiles.length; i++) store.writeLife(store.cells[i]!, i / 1000);
  assert.equal(store.lifeAt(target), before);
  store.swapLife();
  assert.equal(store.lifeAt(target), 17 / 1000);
  const objects = cloneTiles(tiles);
  store.flush(objects);
  assert.equal(objects[17]!.moisture, 0.5); assert.equal(objects[17]!.life, 17 / 1000);
  assert.throws(() => store.write('moisture', target, 0.25), /sin autoridad/);
  store.clearDirty(); assert.deepStrictEqual(store.dirtyPages(), []);
  // Un fallo antes del volcado se descarta: los objetos no se tocaron y la siguiente carga funciona.
  store.pack(objects); store.take(); store.write('food', target, 0.75); store.discard();
  assert.equal(objects[17]!.food, tiles[17]!.food);
  store.pack(objects); assert.deepStrictEqual(store.unpack(), objects);
  assert.throws(() => new TileStore().take(), /carga completa/);
});

test('bytes por tesela medidos sobre los buffers reales, scratch incluido: ≤ 256', t => {
  const world = createWorld(51926, HISTORICAL_PARAMS);
  for (let n = 0; n < 60; n++) stepWorld(world);
  const kernel = new EcosystemKernel();
  kernel.step(cloneTiles(world.tiles), 10, 'rain', 'day', { soaTerreno: true });
  const real = kernel.soaStore!;
  const dense: Tile[] = [];
  for (let c = 0; c < 1024; c++) dense.push(...chunk(51926, (c % 32) - 16, Math.floor(c / 32) - 16));
  const denseKernel = new EcosystemKernel();
  denseKernel.step(dense, 10, 'rain', 'day', { soaTerreno: true });
  const packed = new TileStore(); packed.pack(dense); packed.take(); packed.writeLife(packed.cells[0]!, 0); packed.discard(); packed.pack(dense);
  const figures = {
    kernelRealTiles: real.tileCount, kernelReal: real.bytesPerTile,
    kernelDenseTiles: denseKernel.soaStore!.tileCount, kernelDense: denseKernel.soaStore!.bytesPerTile,
    fullDenseTiles: packed.tileCount, fullDense: packed.bytesPerTile,
    objectTopologyScratch: 56, objectTopologyScratchFourRetained: 224,
  };
  t.diagnostic(`T112 bytes/tesela ${JSON.stringify(figures)}`);
  assert.equal(denseKernel.cachedTopologyCount, 0);
  for (const value of [figures.kernelReal, figures.kernelDense, figures.fullDense]) assert.ok(value > 0 && value <= 256, `${value} B/tesela`);
});

test('stepWorld con motor.soaTerreno=true da el mismo digestoCanonico que false (300 pasos, semilla 51926)', () => {
  const objects = createWorld(51926, HISTORICAL_PARAMS);
  const soa = createWorld(51926, parseParams('motor.soaTerreno=true', HISTORICAL_PARAMS));
  // El cableado se comprueba, no se supone: cuántas pasadas del kernel cargaron la topología en el SoA.
  const loadLife = TileStore.prototype.loadLife, loads = { objects: 0, soa: 0 };
  let side: 'objects' | 'soa' = 'objects';
  TileStore.prototype.loadLife = function (this: TileStore, tiles) { loads[side]++; return loadLife.call(this, tiles); };
  try {
    for (let n = 0; n < 300; n++) { side = 'objects'; stepWorld(objects); side = 'soa'; stepWorld(soa); }
  } finally { TileStore.prototype.loadLife = loadLife; }
  assert.deepStrictEqual(loads, { objects: 0, soa: 30 });
  assert.equal(paramsOf(soa).motor.soaTerreno, true);
  setParams(soa, paramsOf(objects));
  assert.equal(digestoCanonico(soa), digestoCanonico(objects));
});
