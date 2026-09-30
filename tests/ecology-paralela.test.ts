import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import type { ChronicleEvent, Tile } from '../src/shared/types.js';
import { recordChronicleEvent } from '../src/world/chronicle-journal.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { closeEcosystemWorkers } from '../src/world/ecosystem.js';
import { cloneWorld, createWorld, ecology, stepWorld, type World, type WorldContext } from '../src/world/index.js';
import { paramsOf, setParams, type WorldParams } from '../src/world/params.js';

const WORKERS = [1, 2, 4, 8, 28] as const;
const FIELDS = ['moisture', 'vegetation', 'food', 'wood', 'growth', 'fertility', 'cultivation',
  'traffic', 'drinkingWater', 'life', 'terrain', 'biome', 'feature'] as const satisfies readonly (keyof Tile)[];

after(async () => { await closeEcosystemWorkers(); });

/**
 * Oraculo privado de T120: cuerpo literal de ecology() en 2e5c0bf. No llama al kernel nuevo ni a
 * un perfil de laboratorio. Mantener los literales y el orden aritmetico hace que una refactorizacion
 * comun al camino de uno y varios hilos no pueda convertir este control en una comparacion consigo misma.
 */
function literalEcology(world: World): void {
  if (world.tick % 600 === 0) {
    const previous = world.weather;
    world.rng = (Math.imul(world.rng, 1664525) + 1013904223) >>> 0;
    world.weather = world.rng / 4294967296 < 0.4 ? 'rain' : 'clear';
    if (world.weather !== previous) {
      const input: Omit<ChronicleEvent, 'id' | 'tick'> = {
        kind: 'ecology', actors: [], source: 'simulation',
        text: world.weather === 'rain'
          ? 'La lluvia humedece la tierra; el alimento crecerá si también hay luz.'
          : 'La lluvia deja paso al cielo abierto.',
        cause: 'Cambio de tiempo del generador guardado; la lluvia aporta agua, no alimento instantáneo.',
      };
      const event = recordChronicleEvent(world, input);
      world.events.push(event);
      if (world.events.length > 120) world.events.shift();
    }
  }
  if (world.tick % 10 !== 0) return;
  const time = world.tick % 2400;
  const light = time < 300 ? 0.4 : time < 1500 ? 1 : time < 1800 ? 0.4 : 0;
  const { capacidadBosque, capacidadPastizal, capacidadOtros, velocidadRegeneracion, decaimientoComida } = paramsOf(world).recursos;
  const byPosition = new Map(world.tiles.map(tile => [`${tile.x},${tile.y}`, tile]));
  const waterAt = (x: number, y: number): boolean => byPosition.get(`${x},${y}`)?.terrain === 'water';
  const clamp = (value: number): number => Math.max(0, Math.min(1, value));
  for (const tile of world.tiles) {
    if (tile.terrain === 'water') continue;
    const nearWater = waterAt(tile.x - 1, tile.y) || waterAt(tile.x + 1, tile.y)
      || waterAt(tile.x, tile.y - 1) || waterAt(tile.x, tile.y + 1);
    tile.moisture = clamp(tile.moisture + (world.weather === 'rain' ? 0.012 : 0)
      + (nearWater ? 0.008 : 0) - 0.0015 - light * 0.001);
    const K = tile.biome === 'forest' ? capacidadBosque
      : tile.biome === 'grassland' ? capacidadPastizal : capacidadOtros;
    const headroom = K > 0 ? 1 - tile.vegetation / K : 0;
    const growth = velocidadRegeneracion * light * tile.moisture * 0.007 * headroom;
    tile.vegetation = clamp(tile.vegetation + growth - (tile.moisture < 0.15 ? 0.0015 : 0.0001));
    const foodHeadroom = K > 0 ? 1 - tile.food / K : 0;
    tile.food = clamp(tile.food + velocidadRegeneracion * light * tile.moisture * tile.vegetation
      * 0.006 * foodHeadroom - decaimientoComida);
  }
}

function executionParams(world: World, workers: number): WorldParams {
  const params = structuredClone(paramsOf(world));
  Object.assign(params.motor, { hilos: workers, orden: 'natural', gpu: [], soaTerreno: workers > 1 });
  return params;
}

function normalizedDigest(world: World): string {
  const copy = cloneWorld(world);
  const params = structuredClone(paramsOf(copy));
  Object.assign(params.motor, { hilos: 1, orden: 'natural', gpu: [], soaTerreno: false });
  setParams(copy, params);
  return digestoCanonico(copy);
}

function snapshotTiles(tiles: readonly Tile[]): Tile[] {
  return tiles.map(tile => ({ ...tile }));
}

function assertTilesExact(actual: readonly Tile[], expected: readonly Tile[], label: string): void {
  assert.equal(actual.length, expected.length, `${label}: cantidad`);
  for (let index = 0; index < actual.length; index++) {
    const left = actual[index]!, right = expected[index]!;
    assert.deepEqual(Object.keys(left), Object.keys(right), `${label}: claves tile ${index}`);
    for (const key of Object.keys(right) as (keyof Tile)[]) {
      assert.ok(Object.is(left[key], right[key]),
        `${label}: tile ${index} (${right.x},${right.y}).${String(key)}: ${String(left[key])} !== ${String(right[key])}`);
    }
  }
}

function tile(x: number, y: number, overrides: Partial<Tile> = {}): Tile {
  return { x, y, terrain: 'meadow', biome: 'grassland', elevation: 0.42,
    moisture: 0.43, vegetation: 0.37, food: 0.19, wood: 0.81, stone: 0.27,
    feature: 'tree', variety: 2, growth: 0.61, fertility: 0.73, cultivation: 0.17,
    traffic: 0.09, drinkingWater: 0.11, species: 'hare', fauna: 2, life: 0.58, ...overrides };
}

/** Agua a ambos lados de limites de pagina de 256 y 512, regiones negativas y celdas aisladas. */
function sparseBoundaryTiles(): Tile[] {
  return [
    tile(-513, -512, { biome: 'forest', moisture: 0.14, vegetation: 0.82, food: 0.64 }),
    tile(-512, -512, { terrain: 'water', biome: 'ocean', moisture: -0, vegetation: -0, food: -0,
      feature: undefined, species: undefined, fauna: 0 }),
    tile(-257, -256, { biome: 'desert', feature: 'cactus', moisture: 0.91, vegetation: 0.03, food: 0.02 }),
    tile(-256, -256, { terrain: 'water', biome: 'wetland', feature: 'reeds' }),
    tile(255, 0, { biome: 'forest', moisture: 0.001, vegetation: 0.99, food: 0.99 }),
    tile(256, 0, { terrain: 'water', biome: 'ocean', drinkingWater: 0, species: 'fish' }),
    tile(511, 1, { biome: 'grassland', moisture: 0.72, vegetation: 0.21, food: 0.07 }),
    tile(512, 1, { terrain: 'water', biome: 'wetland', feature: 'pool' }),
    tile(1024, -1024, { biome: undefined, feature: undefined, species: undefined,
      moisture: 0.151, vegetation: 0.49, food: 0.31 }),
    tile(-2049, 2048, { biome: 'mountain', feature: 'rock', moisture: 0.149, vegetation: 0.7, food: 0.8 }),
  ];
}

function fixture(seed = 51926): World {
  // createWorld corre aun con hilos=1; los objetos propios se construyen antes de exponer el mundo al pool.
  const world = createWorld(seed);
  world.tiles = sparseBoundaryTiles();
  world.tick = 10; world.weather = 'rain';
  return world;
}

for (const regionSide of [256, 512] as const) {
  test(`T120 ecology literal: agua en bordes, disperso y negativos; geometria ${regionSide}`, async t => {
    const base = fixture(), expected = cloneWorld(base);
    literalEcology(expected);
    for (let index = 0; index < base.tiles.length; index++) {
      const before = base.tiles[index]!, afterEcology = expected.tiles[index]!;
      if (before.terrain === 'water') {
        for (const field of ['moisture', 'vegetation', 'food'] as const)
          assert.ok(Object.is(afterEcology[field], before[field]), `agua ${before.x},${before.y}.${field}`);
      } else {
        for (const field of ['moisture', 'vegetation', 'food'] as const)
          assert.ok(!Object.is(afterEcology[field], before[field]), `tierra ${before.x},${before.y}.${field} debe regenerarse`);
      }
    }
    for (const workers of WORKERS) await t.test(`${workers} hilos`, () => {
      const actual = cloneWorld(base);
      setParams(actual, executionParams(actual, workers));
      ecology(actual, { regionSide });
      assertTilesExact(actual.tiles, expected.tiles, `${workers} hilos / ${regionSide}`);
      assert.equal(actual.rng, expected.rng);
      assert.equal(actual.weather, expected.weather);
      assert.deepEqual(actual.events, expected.events);
      assert.deepEqual(actual.chronicleJournal, expected.chronicleJournal);
    });
  });
}

test('T120 clima del coordinador conserva RNG y eventos exactos en 600/1200', () => {
  const base = fixture(2); base.rng = 2; base.weather = 'clear'; base.tick = 600;
  const expected = cloneWorld(base), actual = cloneWorld(base);
  setParams(actual, executionParams(actual, 28));
  for (const tick of [600, 1200]) {
    expected.tick = tick; actual.tick = tick;
    literalEcology(expected); ecology(actual, { regionSide: 512 });
    assert.equal(actual.rng, expected.rng, `rng en ${tick}`);
    assert.equal(actual.weather, expected.weather, `clima en ${tick}`);
    assert.equal(actual.eventCounter, expected.eventCounter, `contador en ${tick}`);
    assert.deepEqual(actual.events, expected.events, `orden visible de eventos en ${tick}`);
    assert.deepEqual(actual.chronicleJournal, expected.chronicleJournal, `orden durable de eventos en ${tick}`);
    assertTilesExact(actual.tiles, expected.tiles, `campos tras clima ${tick}`);
  }
  const ecologyEvents = actual.events.filter(event => event.kind === 'ecology').slice(-2);
  assert.deepEqual(ecologyEvents.map(event => [event.tick, event.text]), [
    [600, 'La lluvia humedece la tierra; el alimento crecerá si también hay luz.'],
    [1200, 'La lluvia deja paso al cielo abierto.'],
  ]);
});

test('T120 el tick publica ecology antes del kernel, copia todo el fondo y conserva el mismo pool', () => {
  const base = createWorld(51926);
  const target = base.tiles.find(candidate => candidate.terrain !== 'water')!;
  Object.assign(target, { biome: 'forest', moisture: 0.71, vegetation: 0.66, food: 0.44,
    wood: 0.37, growth: 0.72, fertility: 0.83, cultivation: 0.19, traffic: 0.13,
    drinkingWater: 0.17, life: 0.57, feature: 'tree' });
  base.tick = 99; base.weather = 'clear';
  // Ambos clones nacen de objetos hilos=1. Solo despues se enlaza el candidato a buffers residentes.
  const expected = cloneWorld(base), actual = cloneWorld(base);
  setParams(expected, executionParams(expected, 1));
  setParams(actual, executionParams(actual, 4));

  const expectedBarriers: { phase: 'ecologia' | 'kernel'; tiles: Tile[] }[] = [];
  const actualBarriers: { phase: 'ecologia' | 'kernel'; tiles: Tile[];
    diagnostics: NonNullable<Parameters<NonNullable<NonNullable<WorldContext['ecologyExecution']>['onBarrier']>>[0]['diagnostics']> | null }[] = [];
  const referenceContext: WorldContext = { ecologyExecution: { regionSide: 512, onBarrier(event) {
    expectedBarriers.push({ phase: event.phase, tiles: snapshotTiles(expected.tiles) });
  } } };
  const candidateContext: WorldContext = { ecologyExecution: { regionSide: 512, onBarrier(event) {
    actualBarriers.push({ phase: event.phase, tiles: snapshotTiles(actual.tiles), diagnostics: event.diagnostics });
  } } };

  for (const nextTick of [100, 110]) {
    expected.tick = nextTick - 1; actual.tick = nextTick - 1;
    stepWorld(expected, [], referenceContext);
    stepWorld(actual, [], candidateContext);
  }
  assert.deepEqual(expectedBarriers.map(barrier => barrier.phase), ['ecologia', 'kernel', 'ecologia', 'kernel']);
  assert.deepEqual(actualBarriers.map(barrier => barrier.phase), ['ecologia', 'kernel', 'ecologia', 'kernel']);
  for (let index = 0; index < actualBarriers.length; index++) {
    assertTilesExact(actualBarriers[index]!.tiles, expectedBarriers[index]!.tiles,
      `barrera ${index} ${actualBarriers[index]!.phase}`);
  }
  const diagnostics = actualBarriers.map(barrier => {
    assert.ok(barrier.diagnostics, `la barrera ${barrier.phase} debe proceder de workers reales`);
    return barrier.diagnostics;
  });
  for (let index = 1; index < diagnostics.length; index++) {
    assert.equal(diagnostics[index]!.dispatches, diagnostics[index - 1]!.dispatches + 1,
      'cada pasada hace exactamente un despacho fisico');
    assert.deepEqual(diagnostics[index]!.threadIds, diagnostics[0]!.threadIds,
      'ecology y kernel reutilizan los mismos worker_threads entre ticks');
  }
  assert.equal(new Set(diagnostics[0]!.threadIds).size, 4);
  assert.ok(diagnostics[0]!.threadIds.every(id => id > 0));
  assert.equal(normalizedDigest(actual), normalizedDigest(expected),
    'la composicion completa solo difiere en selectores de ejecucion');

  // Los trece campos residentes tienen un testigo no trivial en el cruce ecology -> kernel.
  const afterEcology = actualBarriers[0]!.tiles.find(tile => tile.x === target.x && tile.y === target.y)!;
  const afterKernel = actualBarriers[1]!.tiles.find(tile => tile.x === target.x && tile.y === target.y)!;
  for (const field of FIELDS) assert.ok(Object.hasOwn(afterEcology, field), `campo residente ${field}`);
  assert.ok(!Object.is(afterEcology.moisture, 0.71) && !Object.is(afterEcology.food, 0.44));
  assert.ok(!Object.is(afterKernel.life, afterEcology.life) || !Object.is(afterKernel.fertility, afterEcology.fertility));
});

test('T120 trayectoria normal createWorld coincide por digestos al normalizar solo cuatro selectores', () => {
  const base = createWorld(20260905);
  const worlds = WORKERS.map(workers => {
    const world = cloneWorld(base);
    setParams(world, executionParams(world, workers));
    return world;
  });
  for (let step = 0; step < 20; step++) for (const world of worlds) stepWorld(world);
  const expected = normalizedDigest(worlds[0]!);
  for (let index = 1; index < worlds.length; index++) {
    assert.equal(normalizedDigest(worlds[index]!), expected, `${WORKERS[index]} hilos`);
    assertTilesExact(worlds[index]!.tiles, worlds[0]!.tiles, `${WORKERS[index]} hilos, trayectoria normal`);
  }
});
