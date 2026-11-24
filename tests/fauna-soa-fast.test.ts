import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { Tile } from '../src/shared/types.js';
import { materializeAnimals, stepAnimals, type AnimalWorld } from '../src/world/animals.js';
import { bindWorldContext, closePolicyGpuBatchers, createWorld, stepWorld } from '../src/world/index.js';
import { closeEcosystemWorkers } from '../src/world/ecosystem.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { paramsOf, parseParams, setParams } from '../src/world/params.js';
import { ResidentTopologyOwner } from '../src/world/soa/topologia.js';
import { residentTileReader, TileStore, type SharedTerrain } from '../src/world/soa/terreno.js';
import { SOA_COORDINATE_LIMIT } from '../src/world/soa/region.js';

after(async () => {
  closePolicyGpuBatchers();
  await closeEcosystemWorkers();
});

function tile(x = -16, y = -16, overrides: Partial<Tile> = {}): Tile {
  return { x, y, terrain: 'meadow', biome: 'forest', moisture: 0.8, vegetation: 0.7,
    food: 0.2, growth: 0.6, drinkingWater: 0.5, wood: 0.4, ...overrides };
}
function own(source: Tile[]): Tile[] {
  const owner = new ResidentTopologyOwner();
  return owner.tiles(source.map(t => owner.tile(t)));
}
function copyBacks(shared: SharedTerrain): void {
  for (const [key, buffer] of Object.entries(shared.buffers)) if (key.endsWith('Back'))
    new Uint8Array(buffer).set(new Uint8Array(shared.buffers[key.slice(0, -4)]!));
}

test('lector residente: campos FP64 exactos, ausentes, códigos, coordenadas negativas y presencia dispersa', () => {
  const terrains = ['water', 'soil', 'meadow', 'shelter'] as const;
  const biomes = ['grassland', 'forest', 'desert', 'mountain', 'wetland', 'ocean'] as const;
  const fields = ['growth', 'vegetation', 'moisture', 'drinkingWater', 'food', 'wood'] as const;
  const values = [undefined, -0, Number.MIN_VALUE, 0.1 + 0.2, 1 - Number.EPSILON, Number.MAX_VALUE];
  const source = values.map((v, i) => tile(-257 + i * 256, -17 + i * 16,
    { terrain: terrains[i % terrains.length], biome: biomes[i], ...Object.fromEntries(fields.map(f => [f, v])) }));
  source.push(tile(SOA_COORDINATE_LIMIT - 1, -SOA_COORDINATE_LIMIT), tile(-512, -512, { terrain: undefined, biome: undefined }));
  const owned = own(source), store = new TileStore();
  try {
    assert.equal(residentTileReader(owned), undefined);
    store.prepareParallel(owned);
    const reader = residentTileReader(owned)!;
    assert.ok(reader);
    assert.equal(reader.TERRAIN_WATER, 1); assert.equal(reader.TERRAIN_SHELTER, 4);
    assert.equal(reader.BIOME_DESERT, 3); assert.equal(reader.BIOME_OCEAN, 6);
    for (const t of owned) {
      const at = reader.cellAt(t.x, t.y);
      assert.ok(at >= 0);
      assert.equal(reader.terrainCode(at), terrains.indexOf(t.terrain) + 1);
      assert.equal(reader.biomeCode(at), biomes.indexOf(t.biome!) + 1);
      for (const f of fields) assert.ok(Object.is(reader[f](at), t[f]), `${t.x},${t.y}.${f}`);
      assert.equal(reader.cellAt(t.x - 1, t.y), -1, 'hueco dentro de una página o página ausente');
    }
    for (const [x, y] of [[0, 0], [-256, -17], [NaN, 0], [0, Infinity], [0.5, 0],
      [SOA_COORDINATE_LIMIT, 0], [-SOA_COORDINATE_LIMIT - 1, 0], [2 ** 32 - 257, -17]])
      assert.equal(reader.cellAt(x!, y!), -1);

    const t = owned[0]!, at = reader.cellAt(t.x, t.y);
    t.growth = -0; t.terrain = 'shelter'; t.biome = 'ocean'; t.drinkingWater = 0.125;
    assert.ok(Object.is(reader.growth(at), -0), 'setter escribe en el mismo frente');
    assert.equal(reader.terrainCode(at), reader.TERRAIN_SHELTER);
    assert.equal(reader.biomeCode(at), reader.BIOME_OCEAN);
    assert.equal(reader.drinkingWater(at), 0.125);
  } finally { store.releaseParallelObjects(); }
});

test('lector falla cerrado sin certificado, ante reflexión/topología/worker y después de detach', () => {
  const raw = [tile()], generic = new TileStore();
  generic.prepareParallel(raw);
  assert.equal(residentTileReader(raw), undefined, 'los objetos ordinarios no certifican descriptores');
  generic.releaseParallelObjects();
  const tiles = own([tile(), tile(-15, -16)]), store = new TileStore();
  try {
    store.prepareParallel(tiles);
    assert.ok(residentTileReader(tiles));
    assert.equal(residentTileReader(tiles.slice()), undefined);
    store.beginParallel(); assert.equal(residentTileReader(tiles), undefined); store.abortParallel();
    assert.ok(residentTileReader(tiles));
    for (const mutate of [
      () => { delete tiles[0]!.growth; },
      () => { Object.defineProperty(tiles[0]!, 'vegetation', { value: -0, writable: true, configurable: true, enumerable: true }); },
      () => { tiles[0]!.x = -17; },
      () => { tiles.reverse(); },
      () => { tiles.pop(); },
    ]) {
      mutate(); assert.equal(residentTileReader(tiles), undefined);
      store.prepareParallel(tiles); assert.ok(residentTileReader(tiles));
    }
  } finally { store.releaseParallelObjects(); }
  assert.equal(residentTileReader(tiles), undefined);
});

test('lector se renueva después de crecer la arena, cambiar frente y reutilizar páginas', () => {
  const owner = new ResidentTopologyOwner(), tiles = owner.tiles([owner.tile(tile())]), store = new TileStore();
  try {
    store.prepareParallel(tiles);
    // Muchas páginas separadas fuerzan varias generaciones nuevas de arena.
    for (let i = 1; i <= 80; i++) tiles.push(owner.tile(tile(i * 16, -16, { growth: i / 128 })));
    const shared = store.prepareParallel(tiles);
    let reader = residentTileReader(tiles)!;
    for (const t of tiles) assert.ok(Object.is(reader.growth(reader.cellAt(t.x, t.y)), t.growth));
    copyBacks(shared);
    const at = reader.cellAt(tiles[0]!.x, tiles[0]!.y);
    new Float64Array(shared.buffers.growthBack!)[at] = -0;
    store.beginParallel(); store.commitParallel();
    reader = residentTileReader(tiles)!;
    assert.ok(Object.is(reader.growth(at), -0));
    const removed = tiles.pop()!;
    store.prepareParallel(tiles);
    reader = residentTileReader(tiles)!;
    assert.equal(reader.cellAt(removed.x, removed.y), -1, 'el sello descarta datos antiguos');
    tiles.push(owner.tile(tile(-1024, -1024)));
    store.prepareParallel(tiles);
    reader = residentTileReader(tiles)!;
    assert.equal(reader.cellAt(removed.x, removed.y), -1);
    assert.equal(reader.growth(reader.cellAt(-1024, -1024)), 0.6);
  } finally { store.releaseParallelObjects(); }
});

// Digestos de ea9b879, ANTES de cambiar fauna, con los mismos defaults y 1200 pasos.
// Además de comparar las dos representaciones, esto detecta una deriva compartida por ambos caminos.
const ORIGINAL_DIGESTS: Record<number, string> = {
  7: '30c6e92e39cc733716fea72611407eee647b0e85361c3075b4105a9680b6a579',
  42: 'a1c32baa8d8ed263d51d88087a3196227c01b75bc55c75e359edd9ae9d548757',
  51926: '0e2cceeedec617f2bf9cb0ce71c6bb1968838064b7dde6f870c66c4f00688ab8',
};
for (const seed of [7, 42, 51926]) test(`1200 pasos: digestoCanonico exacto en CADA paso plano/residente, semilla ${seed}`, () => {
  const plain = createWorld(seed), resident = createWorld(seed, parseParams('motor.soaTerreno=true,motor.hilos=4'));
  const owner = new ResidentTopologyOwner();
  resident.tiles = owner.tiles(resident.tiles.map(t => owner.tile(t)));
  bindWorldContext(resident, { tileOwnership: owner });
  const referenceParams = paramsOf(plain), executionParams = paramsOf(resident);
  let readerHits = 0;
  for (let tick = 1; tick <= 1200; tick++) {
    stepWorld(plain); stepWorld(resident);
    if (residentTileReader(resident.tiles)) readerHits++;
    // El digesto incluye motor: normalizar exclusivamente la selección de ejecución durante el hash.
    // Ningún paso corre con parámetros normalizados; todos los campos, -0 y órdenes se comparan.
    setParams(resident, referenceParams);
    try { assert.equal(digestoCanonico(resident), digestoCanonico(plain), `digesto semilla=${seed} paso=${tick}`); }
    finally { setParams(resident, executionParams); }
  }
  assert.ok(readerHits > 0, 'el test ejercita el lector, no sólo el fallback');
  assert.equal(digestoCanonico(plain), ORIGINAL_DIGESTS[seed]);
});

function faunaWorld(tiles: Tile[]): AnimalWorld {
  return { seed: 42, tick: 0, tiles, animals: materializeAnimals(42, tiles, 0), animalCounter: 0,
    reproductionEnabled: false,
    animalDynamics: { births: 0, deaths: 0, predations: 0, humanHunts: 0, waterConsumed: 0, plantConsumed: 0 } };
}

test('rombo máximo, empates, -0, peces/depredadores y memoria caducada conservan cada campo y su orden', () => {
  const source: Tile[] = [], species = ['hare', 'deer', 'boar', 'wolf', 'fox'] as const;
  for (let y = -8; y <= 8; y++) for (let x = -8; x <= 8; x++) {
    const i = source.length, water = x > 0 && y > 0;
    source.push(tile(x === 0 ? -0 : x, y === 0 ? -0 : y, {
      terrain: water ? 'water' : i % 19 === 0 ? 'shelter' : 'meadow',
      biome: i % 7 === 0 ? 'ocean' : i % 11 === 0 ? 'desert' : 'forest',
      growth: i % 3 === 0 ? undefined : 0.3, vegetation: i % 4 === 0 ? -0 : 0.3,
      drinkingWater: i % 3 === 0 ? undefined : i % 4 === 0 ? -0 : 0.2,
      fauna: i % 5 === 0 && (water || i % 19 !== 0) ? 1 : 0,
      species: water ? 'fish' : species[Math.floor(i / 5) % species.length],
    }));
  }
  const plain = faunaWorld(source.map(t => ({ ...t }))), resident = faunaWorld(own(source)), store = new TileStore();
  for (const w of [plain, resident]) {
    w.tick = 483; w.reproductionEnabled = true;
    for (const [i, a] of w.animals.entries()) {
      a.genes.perception = i % 2 === 0 ? 1 : 0;
      a.hunger = i % 3 === 0 ? 0.7 : 0.2; a.thirst = i % 3 === 1 ? 0.8 : 0.2;
      // Esta visita ya caducó: remember debe encontrar visited ANTES de filtrar por TTL.
      a.memory = [{ x: a.x, y: a.y, tick: 0, food: -0, water: -0, visited: true },
        { x: -8, y: -8, tick: 482, food: 0.3, water: 0.2, visited: false }];
    }
  }
  try {
    store.prepareParallel(resident.tiles);
    for (let tick = 0; tick < 128; tick++) {
      plain.tick++; resident.tick++; stepAnimals(plain); stepAnimals(resident);
      assert.deepEqual(resident.animals, plain.animals, `paso ${tick}`);
      assert.deepEqual(resident.animalDynamics, plain.animalDynamics);
      assert.deepEqual(resident.tiles.map(t => ({ ...t })), plain.tiles);
    }
  } finally { store.releaseParallelObjects(); }
});

test('microbenchmark stepAnimals: 20480 teselas / 4096 animales, plano vs getters residentes vs lector', () => {
  const source: Tile[] = [];
  for (let y = 64; y < 192; y++) for (let x = 64; x < 224; x++) {
    const i = source.length;
    source.push(tile(x, y, { fauna: i % 5 === 0 ? 1 : 0, species: i % 5 === 0 ? 'hare' : undefined }));
  }
  const plain = faunaWorld(source.map(t => ({ ...t }))), fallback = faunaWorld(own(source)), fast = faunaWorld(own(source));
  const fallbackStore = new TileStore(), fastStore = new TileStore();
  try {
    fallbackStore.prepareParallel(fallback.tiles); fastStore.prepareParallel(fast.tiles);
    // Mismos Proxies/getters y valores: un descriptor equivalente fuerza la ruta de objetos.
    const t = fallback.tiles.at(-1)!;
    Object.defineProperty(t, 'growth', { value: t.growth, writable: true, configurable: true, enumerable: true });
    assert.equal(residentTileReader(fallback.tiles), undefined); assert.ok(residentTileReader(fast.tiles));
    assert.equal(fast.tiles.length, 20480); assert.equal(fast.animals.length, 4096);
    const worlds = [plain, fallback, fast], elapsed = [0, 0, 0], samples: number[][] = [[], [], []];
    // Calentar todos los caminos, y alternar el orden medido para repartir JIT/GC/carga del host.
    for (let tick = 1; tick <= 96; tick++) for (let n = 0; n < worlds.length; n++) {
      const i = (n + tick) % worlds.length, w = worlds[i]!;
      w.tick++;
      const before = performance.now(); stepAnimals(w); const ms = performance.now() - before;
      if (tick > 32) { elapsed[i]! += ms; samples[i]!.push(ms); }
    }
    for (const candidate of [fallback, fast]) {
      assert.deepEqual(candidate.animals, plain.animals);
      assert.deepEqual(candidate.animalDynamics, plain.animalDynamics);
      assert.deepEqual(candidate.tiles.map(t => ({ ...t })), plain.tiles);
    }
    const median = (xs: number[]): number => { xs.sort((a, b) => a - b); return (xs[31]! + xs[32]!) / 2; };
    console.log(JSON.stringify({ benchmark: 'stepAnimals', tiles: fast.tiles.length, animals: fast.animals.length,
      warmup: 32, measuredTicks: 64, plainMs: elapsed[0], residentGettersMs: elapsed[1], residentReaderMs: elapsed[2],
      medianMs: samples.map(median), speedupVsResidentGetters: elapsed[1]! / elapsed[2]! }));
  } finally { fallbackStore.releaseParallelObjects(); fastStore.releaseParallelObjects(); }
});
