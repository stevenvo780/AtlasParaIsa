import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneWorld, createWorld, tileAt, type World } from '../src/world/index.js';
import { activate, activeAreaBudget, evictColdChunks, maintainRegions } from '../src/world/spatial.js';
import { ChunkLruCache } from '../src/world/lru.js';
import { chunkKey, CHUNK_SIZE, type Chunk } from '../src/world/terrain.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { Store } from '../src/server/store.js';

const REACH = [-8, 0, 8] as const;
function haloKeys(world: World): string[] {
  const keys = new Set<string>();
  for (const person of world.people) for (const dx of REACH) for (const dy of REACH) keys.add(chunkKey(person.x + dx, person.y + dy));
  return [...keys];
}
function solo(world: World): void {
  const person = world.people[0]!;
  person.x = 0; person.y = 0; person.target = { x: 0, y: 0 };
  world.people = [person];
}
const inChunk = (key: string) => (p: { x: number; y: number }) => chunkKey(p.x, p.y) === key;
const sortedTiles = (tiles: { x: number; y: number }[]) => [...tiles].sort((a, b) => a.x - b.x || a.y - b.y);

test('T163: sin presupuesto, evictColdChunks es un no-op y el digesto no cambia', () => {
  const world = createWorld(51926);
  const before = digestoCanonico(world);
  assert.deepEqual(evictColdChunks(world), []);
  assert.deepEqual(evictColdChunks(world, {}), []);
  assert.equal(activeAreaBudget(world), undefined);
  assert.equal(digestoCanonico(world), before);
  assert.throws(() => evictColdChunks(world, { maxActiveChunks: -1 }), RangeError);
  assert.throws(() => evictColdChunks(world, { maxActiveTiles: 1.5 }), RangeError);
});

test('T163: una persona que camina 1 000 celdas nunca ve ausente una página obligatoria, con presupuesto estricto', () => {
  const world = createWorld(7);
  solo(world);
  maintainRegions(world);
  assert.deepEqual(evictColdChunks(world, { maxActiveChunks: 4, maxActiveTiles: 4 * CHUNK_SIZE ** 2 }), []);
  assert.deepEqual(activeAreaBudget(world), { maxActiveChunks: 4, maxActiveTiles: 4 * CHUNK_SIZE ** 2 });
  const person = world.people[0]!;
  for (let step = 0; step < 1000; step++) {
    person.x++; world.tick++;
    person.target = { x: person.x, y: person.y };
    maintainRegions(world);
    // Presión fría en cada paso: una página lejana activa que el presupuesto debe retirar.
    activate(world, person.x + 800, person.y + 800);
    evictColdChunks(world, { maxActiveChunks: 4, maxActiveTiles: 4 * CHUNK_SIZE ** 2 });
    for (const key of haloKeys(world)) {
      assert.ok(world.chunks[key], `paso ${step}: falta la página obligatoria ${key} en (${person.x},${person.y})`);
      assert.ok(tileAt(world, person), `paso ${step}: sin tesela bajo la persona`);
    }
    assert.ok(Object.keys(world.chunks).length <= 4, `paso ${step}: ${Object.keys(world.chunks).length} chunks activos > 4`);
    assert.ok(world.tiles.length <= 4 * CHUNK_SIZE ** 2, `paso ${step}: ${world.tiles.length} teselas activas`);
  }
  assert.equal(person.x, 1000);
});

test('T163: el orden de desalojo es (distancia mínima DESC, lastTick ASC, key ASC) y nunca toca el halo', () => {
  const world = createWorld(11);
  solo(world);
  maintainRegions(world);
  const halo = new Set(haloKeys(world));
  // ±8 celdas desde (0,0) toca 2×2 chunks de 16: el halo obligatorio real de maintainRegions.
  assert.equal(halo.size, 4);
  // (cx, cy, lastTick): distancias Chebyshev en chunks a la persona en (0,0).
  const cold: [number, number, number][] = [
    [5, 0, 30],   // distancia 5
    [4, 3, 10],   // distancia 4, lastTick mayor que su pareja
    [4, -3, 5],   // distancia 4, lastTick menor: va antes aunque su clave es menor también
    [3, 3, 7],    // distancia 3, misma lastTick que (3,-3): manda la clave
    [3, -3, 7],
  ];
  for (const [cx, cy, lastTick] of cold) {
    activate(world, cx * CHUNK_SIZE, cy * CHUNK_SIZE);
    world.chunks[`${cx},${cy}`]!.lastTick = lastTick;
  }
  // Una página del halo con lastTick antiquísimo tampoco puede salir.
  world.chunks[[...halo][0]!]!.lastTick = 0;
  const evicted = evictColdChunks(world, { maxActiveChunks: halo.size });
  assert.deepEqual(evicted, ['5,0', '4,-3', '4,3', '3,-3', '3,3']);
  for (const key of evicted) {
    assert.ok(!halo.has(key), `desalojado un chunk del halo: ${key}`);
    assert.ok(!world.chunks[key]);
    assert.ok(world.retiredChunks.some(chunk => chunk.key === key), `${key} no quedó dormido`);
  }
  for (const key of halo) assert.ok(world.chunks[key], `halo desalojado: ${key}`);
  assert.equal(Object.keys(world.chunks).length, halo.size);
  // Sin candidatos no se fuerza el techo a costa del halo.
  assert.deepEqual(evictColdChunks(world, { maxActiveChunks: 1 }), []);
  assert.equal(Object.keys(world.chunks).length, halo.size);
});

test('T163: ChunkLruCache es acotada, expulsa la menos reciente y promociona al leer', () => {
  const cache = new ChunkLruCache(2);
  const chunk = (key: string): Chunk => ({ key, cx: 0, cy: 0, tiles: [], discovered: false, places: [], lastTick: 0 });
  cache.set(chunk('0,0')); cache.set(chunk('1,0')); cache.set(chunk('2,0'));
  assert.deepEqual(cache.keys(), ['1,0', '2,0']);
  assert.equal(cache.get('1,0')?.key, '1,0');
  cache.set(chunk('3,0'));
  assert.deepEqual(cache.keys(), ['1,0', '3,0'], 'la lectura promocionó 1,0 y salió 2,0');
  assert.equal(cache.size, 2);
  assert.throws(() => new ChunkLruCache(-1), RangeError);
});

test('T163: reanimar tras guardar en Store usa la LRU antes que volver a SQLite', () => {
  const world = createWorld(13);
  solo(world);
  maintainRegions(world);
  let reads = 0;
  const key = '20,20';
  activate(world, 20 * CHUNK_SIZE, 20 * CHUNK_SIZE, { loadChunk: (k, tick) => { reads++; assert.equal(k, key); assert.ok(tick >= 0); return null; } });
  assert.ok(world.chunks[key]);
  assert.deepEqual(evictColdChunks(world, { maxActiveChunks: haloKeys(world).length }), [key]);
  // Como hace Store.save al confirmar: la cola dormida se drena y solo queda el respaldo.
  world.retiredChunks = [];
  activate(world, 20 * CHUNK_SIZE, 20 * CHUNK_SIZE, { loadChunk: () => { reads++; return null; } });
  assert.ok(world.chunks[key], 'la LRU reanimó la página sin leer el respaldo');
  assert.equal(reads, 1, 'solo la primera activación (sin respaldo) llegó al lector');
});

test('T163: guardar en Store, recargar y reanimar los desalojados conserva el mundo (digesto idéntico)', t => {
  const dir = mkdtempSync(join(tmpdir(), 'carta-desalojo-'));
  const store = new Store(join(dir, 'world.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const world = createWorld(51926);
  maintainRegions(world);
  activate(world, 20 * CHUNK_SIZE, 20 * CHUNK_SIZE);
  activate(world, -20 * CHUNK_SIZE, 24 * CHUNK_SIZE);
  const keys = ['20,20', '-20,24'];
  // Estado de tesela que solo existe en la página que se va a desalojar.
  const marked = world.tiles.find(tile => chunkKey(tile.x, tile.y) === keys[0])!;
  marked.food = 0.123456789;
  const expectedTiles = new Map(keys.map(key => [key, structuredClone(world.tiles.filter(inChunk(key)))]));
  const expectedAnimals = new Map(keys.map(key => [key, structuredClone(world.animals.filter(inChunk(key)))]));
  const expectedStructures = new Map(keys.map(key => [key, structuredClone(world.structures.filter(inChunk(key)))]));
  const expectedPlaces = new Map(keys.map(key => [key, structuredClone(world.chunks[key]!.places)]));
  const beforeEvict = cloneWorld(world);

  const evicted = evictColdChunks(world, { maxActiveChunks: Object.keys(world.chunks).length - keys.length });
  assert.deepEqual(new Set(evicted), new Set(keys));
  assert.ok(Object.keys(world.chunks).length <= Object.keys(beforeEvict.chunks).length - keys.length);
  for (const key of keys) assert.ok(world.retiredChunks.some(chunk => chunk.key === key));
  const expectedChunks = new Map(world.retiredChunks.filter(chunk => keys.includes(chunk.key)).map(chunk => [chunk.key, structuredClone(chunk)]));

  store.save(world);
  assert.deepEqual(world.retiredChunks, [], 'save confirma y drena la cola dormida');
  for (const key of keys) assert.deepEqual(store.loadChunk(key), expectedChunks.get(key), `respaldo de ${key}`);

  const resumed = store.load()!.world;
  const reference = cloneWorld(resumed);
  for (const key of keys) {
    const [cx] = key.split(',').map(Number);
    activate(reference, (cx as number) * CHUNK_SIZE, Number(key.split(',')[1]) * CHUNK_SIZE, { loadChunk: () => structuredClone(expectedChunks.get(key)!) });
    activate(resumed, (cx as number) * CHUNK_SIZE, Number(key.split(',')[1]) * CHUNK_SIZE, store.context);
  }
  assert.equal(digestoCanonico(resumed), digestoCanonico(reference), 'recargar y reanimar da el mismo mundo que la referencia en memoria');
  for (const key of keys) {
    assert.deepEqual(sortedTiles(resumed.tiles.filter(inChunk(key))), sortedTiles(expectedTiles.get(key)!), `teselas de ${key}`);
    assert.deepEqual(resumed.animals.filter(inChunk(key)), expectedAnimals.get(key), `animales de ${key}`);
    assert.deepEqual(resumed.structures.filter(inChunk(key)), expectedStructures.get(key), `estructuras de ${key}`);
    for (const place of expectedPlaces.get(key)!) assert.ok(resumed.places.some(p => p.id === place.id), `lugar ${place.id} de ${key}`);
  }
  assert.equal(resumed.tiles.find(tile => chunkKey(tile.x, tile.y) === keys[0] && tile.food === 0.123456789)?.food, 0.123456789);
});
