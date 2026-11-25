// Paridad del camino caliente serie de la fauna (`stepAnimals` sin despacho paralelo).
//
// Las referencias son del commit base 819fc31, anterior a la optimización de animals.ts: el digesto
// canónico de mundos completos (tres semillas × 1 200 pasos) y una huella exacta (conserva −0) de un
// escenario de escala con ≈ 2 500 animales sobre 8 064 teselas, con teselas planas y residentes (lector
// SoA). Cada paso del escenario comprueba además las invariantes de la fauna.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Tile } from '../../src/shared/types.js';
import { assertAnimals, MAX_ANIMALS_PER_TILE, materializeAnimals, stepAnimals, type AnimalWorld } from '../../src/world/animals.js';
import { closePolicyGpuBatchers, createWorld, stepWorld } from '../../src/world/index.js';
import { closeEcosystemWorkers } from '../../src/world/ecosystem.js';
import { digestoCanonico } from '../../src/world/digesto.js';
import { parseParams } from '../../src/world/params.js';
import { ResidentTopologyOwner } from '../../src/world/soa/topologia.js';
import { residentTileReader, TileStore } from '../../src/world/soa/terreno.js';

after(async () => {
  closePolicyGpuBatchers();
  await closeEcosystemWorkers();
});

const BASE_DIGESTS: Record<number, string> = {
  7: '30c6e92e39cc733716fea72611407eee647b0e85361c3075b4105a9680b6a579',
  51926: '0e2cceeedec617f2bf9cb0ce71c6bb1968838064b7dde6f870c66c4f00688ab8',
  2002: '52edaca1c9dd6ab186a930ad8a7b499ee85b17244c7d2a432602dedb21190ca1',
};

for (const [seed, expected] of Object.entries(BASE_DIGESTS)) {
  test(`semilla ${seed}: digesto canónico tras 1 200 pasos idéntico al de la base`, () => {
    const world = createWorld(Number(seed), parseParams('motor.hilos=1'));
    for (let tick = 0; tick < 1200; tick++) stepWorld(world);
    assert.equal(digestoCanonico(world), expected);
  });
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const SPECIES = ['hare', 'deer', 'boar', 'wolf', 'fox'] as const;
/** 96 × 84 teselas que cruzan los ejes (con −0 en ellos), agua con peces, refugios y desierto. */
function scaleTiles(): Tile[] {
  const random = lcg(2002), tiles: Tile[] = [];
  for (let y = -42; y < 42; y++) for (let x = -48; x < 48; x++) {
    const r = random(), water = r < 0.08, shelter = !water && r < 0.1;
    const tile: Tile = { x: x === 0 ? -0 : x, y: y === 0 ? -0 : y, terrain: water ? 'water' : shelter ? 'shelter' : 'meadow',
      biome: water && random() < 0.3 ? 'ocean' : random() < 0.1 ? 'desert' : 'forest',
      moisture: random(), vegetation: random(), food: 0.2, growth: random() < 0.05 ? undefined : random(), drinkingWater: random() < 0.1 ? undefined : random() * 0.6 };
    const fauna = !shelter && random() < 0.11 ? 1 + Math.floor(random() * 5) : 0;
    if (fauna) { tile.fauna = fauna; tile.species = water ? 'fish' : SPECIES[Math.floor(random() * SPECIES.length)]!; }
    tiles.push(tile);
  }
  return tiles;
}
function scaleWorld(tiles: Tile[]): AnimalWorld {
  return { seed: 2002, tick: 0, tiles, animals: materializeAnimals(2002, tiles, 0), animalCounter: 0,
    animalDynamics: { births: 0, deaths: 0, predations: 0, humanHunts: 0, waterConsumed: 0, plantConsumed: 0 } };
}
const FIELDS = ['x', 'y', 'terrain', 'biome', 'moisture', 'vegetation', 'growth', 'drinkingWater', 'fauna', 'species'] as const;
/** Huella de todo lo que la fauna escribe, por [[Get]] (atraviesa los Proxies residentes) y con −0. */
function footprint(world: AnimalWorld): string {
  const exact = (_: string, v: unknown): unknown => Object.is(v, -0) ? '-0' : v === undefined ? '∅' : v;
  const tiles = world.tiles.map(t => FIELDS.map(f => t[f]));
  return createHash('sha256').update(JSON.stringify([world.animals, world.animalCounter, world.animalDynamics, tiles], exact)).digest('hex');
}
function assertInvariants(world: AnimalWorld): void {
  assertAnimals(world.animals, world.tick, world.tiles, 1e6);
  for (let i = 1; i < world.animals.length; i++) assert.ok(world.animals[i - 1]!.id < world.animals[i]!.id, 'orden canónico estricto');
  const counts = new Map<string, { count: number; species: string }>();
  for (const a of world.animals) {
    const key = `${a.x},${a.y}`, c = counts.get(key);
    if (c) { c.count++; if (a.species < c.species) c.species = a.species; } else counts.set(key, { count: 1, species: a.species });
  }
  for (const t of world.tiles) {
    const c = counts.get(`${t.x},${t.y}`);
    assert.equal(t.fauna ?? 0, c?.count ?? 0, `fauna en ${t.x},${t.y}`);
    assert.equal(t.species, c?.species, `especie en ${t.x},${t.y}`);
  }
}
function own(source: Tile[]): Tile[] {
  const owner = new ResidentTopologyOwner();
  return owner.tiles(source.map(t => owner.tile({ ...t })));
}

const SCALE_TICKS = 600;
// V23: re-grabada al quitar los topes de fauna (M2a, 1aae52f); 9d98c103… pasó sin cambios hasta 98e750c
// (sprint/v23l-motor). Residente = plana se sigue comprobando paso a paso.
const BASE_SCALE_FOOTPRINT = '930d0bdc279f9a06715e896a327f090a81424ab9424972a6b563ff9acc8552b7';

test(`escala: ≈ 2 500 animales sobre 8 064 teselas, ${SCALE_TICKS} pasos, planas y residentes idénticas a la base`, () => {
  const source = scaleTiles(), plain = scaleWorld(source.map(t => ({ ...t }))), resident = scaleWorld(own(source));
  assert.equal(plain.tiles.length, 8064);
  assert.ok(plain.animals.length >= 2400 && plain.animals.length <= 2700, `animales: ${plain.animals.length}`);
  const store = new TileStore();
  try {
    store.prepareParallel(resident.tiles);
    assert.ok(residentTileReader(resident.tiles), 'el escenario residente ejercita el lector');
    for (let tick = 1; tick <= SCALE_TICKS; tick++) {
      for (const world of [plain, resident]) { world.tick = tick; stepAnimals(world); }
      if (tick % 50 === 0) {
        assertInvariants(plain);
        assert.equal(footprint(resident), footprint(plain), `residente = plana en el paso ${tick}`);
      }
    }
    assert.ok(plain.animalDynamics.births > 0 && plain.animalDynamics.deaths > 0 && plain.animalDynamics.predations > 0,
      `el escenario ejercita cría, muerte y caza: ${JSON.stringify(plain.animalDynamics)}`);
    assert.equal(footprint(plain), BASE_SCALE_FOOTPRINT);
  } finally { store.releaseParallelObjects(); }
});
