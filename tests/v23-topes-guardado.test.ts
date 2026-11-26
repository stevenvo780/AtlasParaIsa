import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../src/server/store.js';
import { decodeSnapshot, encodeSnapshot } from '../src/server/snapshot.js';
import { escalon } from '../src/shared/interruptores.js';
import { assertWorld, createWorld } from '../src/world/index.js';
import { paramsOf, parseParams, setParams } from '../src/world/params.js';
import { chunkKey, generateChunk } from '../src/world/terrain.js';

for (const snapshotInlineTileLimit of [0, 32768]) {
  test(`el guardado completo admite comunidades sin cupo (umbral en línea: ${snapshotInlineTileLimit})`, t => {
    const store = new Store(':memory:', { snapshotInlineTileLimit });
    t.after(() => store.close());
    const params = parseParams({ v23: { guardadoCompleto: true, comunidades: true } });
    const world = createWorld(7, params);
    world.communities = world.people.slice(2, 11).map((p, i) => {
      const id = `community-${i + 1}`;
      p.communityId = id;
      return { id, name: id, members: [p.id], x: p.x, y: p.y, color: '#112233', culture: { ...p.culture },
        formedAt: 0, cooperation: 0, disputes: 0 };
    });
    world.communityCounter = 9;
    store.guardar({ world, materia: null });
    const loaded = store.cargarInstantanea()!.instantanea.world;
    assert.deepEqual(loaded.communities, world.communities);
    assert.deepEqual((decodeSnapshot(encodeSnapshot(loaded, paramsOf(loaded))) as typeof world).communities, world.communities);

    loaded.communities[0]!.members.push('desconocido');
    assert.throws(() => assertWorld(loaded), /Estado procedural inválido/);
    setParams(world, parseParams({ v23: { comunidades: false } }, params));
    assert.throws(() => assertWorld(world), /Estado procedural inválido/);
    assert.throws(() => encodeSnapshot(world, paramsOf(world)), /collection limit/);
  });
}

test('el guardado conserva lugares y existencias por encima de los límites escalares heredados', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const world = createWorld(7, parseParams({ v23: escalon('obra') }));
  const p = world.people[0]!;
  p.inventory = 0.7;
  p.materials = { wood: 20, stone: 13 };
  const tile = world.tiles.find(t => t.x === p.x && t.y === p.y)!;
  tile.wood = 20;
  tile.stone = 13;
  const chunk = world.chunks[chunkKey(tile.x, tile.y)]!;
  const lugares = Array.from({ length: 2050 }, (_, i) => ({
    id: `lugar-${i}`, name: `Lugar ${i}`, description: '', x: tile.x, y: tile.y, gatherings: 0,
  }));
  world.places.push(...lugares);
  chunk.places.push(...lugares);
  const dormido = generateChunk(world.seed, 30, 30);
  dormido.tiles[0]!.stone = 15;
  dormido.places = lugares.slice(0, 257).map(lugar => ({ ...lugar, x: 480, y: 480 }));
  world.retiredChunks.push(dormido);
  store.guardar({ world, materia: null });
  const loaded = store.cargarInstantanea()!.instantanea.world;
  assert.deepEqual(loaded.places, world.places);
  assert.deepEqual(loaded.chunks[chunk.key]!.places, chunk.places);
  assert.deepEqual(loaded.people[0]!.materials, p.materials);
  assert.equal(loaded.people[0]!.inventory, p.inventory);
  const restored = loaded.tiles.find(t => t.x === tile.x && t.y === tile.y)!;
  assert.equal(restored.wood, tile.wood);
  assert.equal(restored.stone, tile.stone);
  assert.deepEqual(store.loadChunk(dormido.key), dormido);

  restored.stone = Infinity;
  assert.throws(() => assertWorld(loaded), /Piedra fuera de rango/);
  restored.stone = 13;
  loaded.people[0]!.inventory = -0.1;
  assert.throws(() => assertWorld(loaded), /Estado del mundo inválido/);
  loaded.people[0]!.inventory = 0.7;
  loaded.places.pop();
  assert.throws(() => assertWorld(loaded), /Estado procedural inválido/);
});
