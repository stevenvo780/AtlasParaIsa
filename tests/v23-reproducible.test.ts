import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorld, createWorld, stepWorld, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { DEFAULT_PARAMS, paramsOf } from '../src/world/params.js';

// El mundo público ya no es reproducible bit a bit (hilos y GPU cambian el resultado). Se conserva
// la reproducibilidad del modo de un solo dueño: un hilo, sin GPU, con semilla explícita.
const PASOS = 600;

function correr(seed: number): World {
  const world = createWorld(seed, DEFAULT_PARAMS);
  const { motor } = paramsOf(world);
  assert.equal(motor.hilos, 1, 'el modo reproducible usa un solo hilo');
  assert.deepEqual(motor.gpu, [], 'el modo reproducible no usa GPU');
  for (let tick = 1; tick <= PASOS; tick++) stepWorld(world);
  return world;
}

test('misma semilla, un hilo, sin GPU: dos corridas de 600 pasos dan el mismo digesto', { timeout: 600_000 }, () => {
  const a = correr(7);
  const b = correr(7);
  assertWorld(a);
  assert.equal(digestoCanonico(a), digestoCanonico(b), 'misma semilla: mismo mundo');
});

test('semillas distintas dan digestos distintos tras 600 pasos', { timeout: 600_000 }, () => {
  assert.notEqual(digestoCanonico(correr(7)), digestoCanonico(correr(8)));
});
