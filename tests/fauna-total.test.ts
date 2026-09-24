import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world/index.js';
import { generateChunk } from '../src/world/terrain.js';
import { faunaTotal, registrarFaunaRetirada } from '../scripts/lab/fauna-total.js';

test('faunaTotal conserva el censo retirado tras el guardado y excluye chunks reactivados', () => {
  const world = createWorld(42), censos = new Map<string, number>();
  const activos = world.animals.filter(animal => animal.health > 0).length;
  const chunk = generateChunk(world.seed, 100, 100);
  chunk.animals = [
    { ...world.animals[0]!, x: 1600, y: 1600, health: 1 },
    { ...world.animals[1]!, x: 1601, y: 1600, health: 0 },
  ];
  world.retiredChunks.push(chunk);
  registrarFaunaRetirada(world, censos);
  world.retiredChunks = []; // Store.save hace esto después de archivar.
  assert.equal(faunaTotal(world, censos), activos + 1);
  world.chunks[chunk.key] = { key: chunk.key, cx: chunk.cx, cy: chunk.cy,
    discovered: chunk.discovered, places: [], lastTick: chunk.lastTick };
  assert.equal(faunaTotal(world, censos), activos);
  delete world.chunks[chunk.key];
  chunk.animals = [{ ...world.animals[0]!, x: 1600, y: 1600, health: 0 }];
  world.retiredChunks.push(chunk);
  registrarFaunaRetirada(world, censos);
  world.retiredChunks = [];
  assert.equal(faunaTotal(world, censos), activos);
});
