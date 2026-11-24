import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bindWorldContext, closePolicyGpuBatchers, createWorld, stepWorld,
} from '../src/world/index.js';
import { parseParams } from '../src/world/params.js';
import { ResidentTopologyOwner } from '../src/world/soa/topologia.js';
import { residentFaunaCapacity, TileStore } from '../src/world/soa/terreno.js';
import { PolicyGpuBatcher } from '../src/world/gpu/politica-gpu.js';
import { POLICY_ACTIONS, POLICY_INPUTS, POLICY_WEIGHTS } from '../src/world/politica.js';
import { closeEcosystemWorkers } from '../src/world/ecosystem.js';

function oracleFaunaCapacity(tiles: readonly { terrain: string; growth?: number }[]): number {
  let count = 0;
  for (const t of tiles) if (t.terrain !== 'shelter' && (t.growth ?? 0) > 0.04) count++;
  return count * 3;
}

test('residentFaunaCapacity coincide exactamente con el oráculo y cae al bucle ante mutaciones de descriptor', () => {
  const world = createWorld(42, parseParams('motor.soaTerreno=true,motor.hilos=1'));
  const owner = new ResidentTopologyOwner();
  world.tiles = owner.tiles(world.tiles.map(t => owner.tile(t)));
  const store = new TileStore();
  store.prepareParallel(world.tiles, 256);

  assert.equal(residentFaunaCapacity(world.tiles), oracleFaunaCapacity(world.tiles));

  // Mutar growth y terrain sobre el Proxy residente actualiza SAB directamente sin romper paridad.
  const t0 = world.tiles[0]!;
  t0.growth = 0.5;
  assert.equal(residentFaunaCapacity(world.tiles), oracleFaunaCapacity(world.tiles));
  t0.terrain = 'shelter';
  assert.equal(residentFaunaCapacity(world.tiles), oracleFaunaCapacity(world.tiles));
  t0.growth = 0.01;
  assert.equal(residentFaunaCapacity(world.tiles), oracleFaunaCapacity(world.tiles));

  // Una reflexión/borrado marca residentModified y fuerza fallback seguro (undefined).
  delete (t0 as unknown as Record<string, unknown>).growth;
  assert.equal(residentFaunaCapacity(world.tiles), undefined);

  // Tras nuevo prepareParallel vuelve a estar activo y exacto.
  store.prepareParallel(world.tiles, 256);
  assert.equal(residentFaunaCapacity(world.tiles), oracleFaunaCapacity(world.tiles));

  // Al desligar, residentFaunaCapacity devuelve undefined.
  store.releaseParallelObjects();
  assert.equal(residentFaunaCapacity(world.tiles), undefined);
});

test('PolicyGpuBatcher no produce aliasing entre llamadas consecutivas al reutilizar SharedArrayBuffer', () => {
  const batcher = new PolicyGpuBatcher([0]);
  try {
    const obsA = new Float64Array(2 * POLICY_INPUTS).fill(0.25);
    const obsB = new Float64Array(2 * POLICY_INPUTS).fill(0.85);
    const weights = new Float64Array(2 * POLICY_WEIGHTS).fill(0.15);
    const biases = new Float64Array(2 * POLICY_ACTIONS.length).fill(0.05);

    const outA = batcher.evaluate(obsA, weights, biases, 2);
    const snapshotA = Float64Array.from(outA);
    const outB = batcher.evaluate(obsB, weights, biases, 2);

    assert.notEqual(outA, outB);
    assert.deepEqual(outA, snapshotA, 'La segunda evaluación no debe sobrescribir la salida previa');
    assert.notDeepEqual(outA, outB);
  } finally {
    batcher.close();
  }
});

test('paso completo con ResidentTopologyOwner + fast-paths coincide con referencia plana', async () => {
  const params = parseParams('poblacion.natalidadVecindad=true,social.maxComunidades=0,conducta.politicaPeso=0.35,conducta.aptitud=0.35,motor.soaTerreno=true,motor.hilos=1');
  const plain = createWorld(42, params);
  const owned = createWorld(42, params);
  const owner = new ResidentTopologyOwner();
  owned.tiles = owner.tiles(owned.tiles.map(t => owner.tile(t)));
  bindWorldContext(owned, { tileOwnership: owner });
  try {
    for (let t = 0; t < 36; t++) {
      stepWorld(plain);
      stepWorld(owned);
    }
    assert.equal(owned.people.length, plain.people.length);
    assert.equal(owned.animals.length, plain.animals.length);
    assert.equal(owned.tiles.length, plain.tiles.length);
    for (let i = 0; i < plain.people.length; i++) {
      assert.equal(owned.people[i]!.x, plain.people[i]!.x);
      assert.equal(owned.people[i]!.y, plain.people[i]!.y);
      assert.equal(owned.people[i]!.action, plain.people[i]!.action);
    }
  } finally {
    closePolicyGpuBatchers();
    await closeEcosystemWorkers();
  }
});
