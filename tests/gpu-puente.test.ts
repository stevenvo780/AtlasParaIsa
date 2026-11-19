import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld, phaseAt } from '../src/world/index.js';
import { parseParams, paramsOf } from '../src/world/params.js';
import { closeEcosystemWorkers, ecosystemGpuDiagnostics, killGpuSubprocessForTest } from '../src/world/ecosystem.js';
import { stepEcosystem, stepLocalEcology } from '../src/world/ecosystem.js';
import { gpuNvrtcAvailable } from '../src/world/gpu/puente.js';
import { finalCanonicalDigest } from './hardware/contrato.js';
import type { EcosystemBarrierEvent } from '../src/world/ecosystem-kernel.js';

const available = gpuNvrtcAvailable();
const skip = available ? false : 'Sin NVRTC/CUDA: COMPUTE_NVRTC no está definido y /opt/cuda/lib64/libnvrtc.so no existe; backend GPU omitido (skip, nunca pass).';
after(async () => { await closeEcosystemWorkers(); });

function worldWith(gpu: readonly number[]) {
  return createWorld(51926, parseParams(gpu.length ? `motor.gpu=[${gpu.join(',')}],motor.hilos=1` : 'motor.hilos=1'));
}

for (const gpu of [[0], [1], [0, 1]] as const) {
  test(`T122 GPU residente gpu=[${gpu.join(',')}] da el mismo digesto que CPU 1 hilo en 600 pasos`, { skip }, () => {
    const cpu = worldWith([]);
    for (let i = 0; i < 600; i++) stepWorld(cpu);
    const expected = finalCanonicalDigest(cpu);
    const gpuWorld = worldWith(gpu);
    for (let i = 0; i < 600; i++) stepWorld(gpuWorld);
    assert.equal(finalCanonicalDigest(gpuWorld), expected);
  });
}

test('T122 subida dispersa <= 1 MB/paso y subida/bajada medidas por separado', { skip }, () => {
  const world = worldWith([0]);
  for (let i = 0; i < 20; i++) stepWorld(world);
  // Cambio local de actor: una sola tesela (una página) entre ticks ecológicos.
  const tile = world.tiles.find(t => t.terrain !== 'water')!;
  tile.food = Math.min(1, tile.food + 0.01);
  const events: EcosystemBarrierEvent[] = [];
  stepLocalEcology(world.tiles, 30, world.weather, phaseAt(30), paramsOf(world).recursos,
    { gpu: [0], hilos: 1, onBarrier: e => events.push(e) });
  assert.equal(events.length, 1);
  const pass1 = events[0]!.gpuStats!;
  assert.ok(pass1.uploadedBytes > 0 && pass1.uploadedBytes <= 1_000_000, `uploadedBytes=${pass1.uploadedBytes}`);
  assert.ok(pass1.downloadedBytes > 0, `downloadedBytes=${pass1.downloadedBytes}`);
  assert.notEqual(pass1.uploadedBytes, pass1.downloadedBytes);
  stepEcosystem(world.tiles, 30, world.weather, phaseAt(30), false,
    { gpu: [0], hilos: 1, seed: world.seed, cuencas: paramsOf(world).agua.cuencas,
      decaimientoFertilidad: paramsOf(world).recursos.decaimientoFertilidad, onBarrier: e => events.push(e) });
  assert.equal(events.length, 2);
  const pass2 = events[1]!.gpuStats!;
  assert.ok(pass2.uploadedBytes <= 1_000_000, `pass2 uploadedBytes=${pass2.uploadedBytes}`);
  assert.ok(pass2.downloadedBytes > 0);
  assert.ok(ecosystemGpuDiagnostics());
});

test('T122 matar el subproceso GPU aborta antes del swap y el mundo no queda a medias', { skip }, () => {
  const world = worldWith([0]);
  for (let i = 0; i < 20; i++) stepWorld(world);
  const before = world.tiles.map(t => ({ ...t }));
  const digestBefore = finalCanonicalDigest(world);
  killGpuSubprocessForTest();
  assert.throws(() => stepLocalEcology(world.tiles, 30, world.weather, phaseAt(30), paramsOf(world).recursos,
    { gpu: [0], hilos: 1 }), /ResidentGpuBridge|GPU|closed|exited|killed/i);
  const afterTiles = world.tiles.map(t => ({ ...t }));
  assert.deepStrictEqual(afterTiles, before);
  assert.equal(finalCanonicalDigest(world), digestBefore);
});
