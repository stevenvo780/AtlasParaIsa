import test from 'node:test';
import assert from 'node:assert/strict';
import { availableParallelism, totalmem } from 'node:os';
import { deploymentParams } from '../src/server/deployment-params.js';
import {
  NVIDIA_SMI_TIMEOUT_MS,
  detectHostHardware,
  hostFullHardwareParams,
  hostLimits,
  hostMemory,
  hostParams,
  parseNvidiaSmiIndices,
  recommendedMotorForHost,
  type HostHardware,
  type HostMemory,
} from '../src/server/hardware-limits.js';
import { createWorld, stepWorld } from '../src/world/index.js';
import { DEFAULT_PARAMS, assertWorldLimits, parseParams } from '../src/world/params.js';

const GiB = 1024 ** 3;

test('parseNvidiaSmiIndices: parsea, deduplica, ordena y descarta basura', () => {
  assert.deepEqual(parseNvidiaSmiIndices('0\n1\n'), [0, 1]);
  assert.deepEqual(parseNvidiaSmiIndices(' 2 \r\n 0 \n 2 \n -1 \n foo \n 1, 3 '), [0, 1, 2, 3]);
  assert.deepEqual(parseNvidiaSmiIndices(''), []);
  assert.deepEqual(parseNvidiaSmiIndices('   \n\t '), []);
  assert.deepEqual(parseNvidiaSmiIndices('No devices were found\n'), []);
  assert.deepEqual(parseNvidiaSmiIndices(null), []);
  assert.deepEqual(parseNvidiaSmiIndices(undefined), []);
  assert.ok(Number.isSafeInteger(NVIDIA_SMI_TIMEOUT_MS) && NVIDIA_SMI_TIMEOUT_MS > 0 && NVIDIA_SMI_TIMEOUT_MS <= 5000);
});

test('detectHostHardware: usa probe determinista sin tocar GPU real', () => {
  const tower = detectHostHardware({
    cpuThreads: () => 32,
    totalRamBytes: () => 128 * GiB,
    nvrtcAvailable: () => true,
    nvidiaSmi: () => '1\n0\n1\n',
  });
  assert.deepEqual(tower, {
    cpuThreads: 32,
    totalRamBytes: 128 * GiB,
    cudaDevices: [0, 1],
  });

  // Sin NVRTC no debe invocar nvidia-smi y debe devolver cudaDevices vacío.
  let smiCalled = false;
  const noNvrtc = detectHostHardware({
    cpuThreads: () => 16,
    totalRamBytes: () => 32 * GiB,
    nvrtcAvailable: () => false,
    nvidiaSmi: () => { smiCalled = true; return '0\n'; },
  });
  assert.equal(smiCalled, false);
  assert.deepEqual(noNvrtc, {
    cpuThreads: 16,
    totalRamBytes: 32 * GiB,
    cudaDevices: [],
  });

  // Si nvidia-smi falla o vence el timeout, degrada limpio a [].
  const smiFailed = detectHostHardware({
    cpuThreads: () => 8,
    totalRamBytes: () => 16 * GiB,
    nvrtcAvailable: () => true,
    nvidiaSmi: () => { throw new Error('ENOENT: nvidia-smi'); },
  });
  assert.deepEqual(smiFailed.cudaDevices, []);

  // Valores anómalos de sonda se acotan sin romper.
  const degenerate = detectHostHardware({
    cpuThreads: () => Number.NaN,
    totalRamBytes: () => -10,
    nvrtcAvailable: () => false,
  });
  assert.deepEqual(degenerate, { cpuThreads: 1, totalRamBytes: 0, cudaDevices: [] });
});

test('recommendedMotorForHost: mapeo puro por tamaño de máquina y GPUs', () => {
  assert.deepEqual(recommendedMotorForHost({ cpuThreads: 1, totalRamBytes: 2 * GiB, cudaDevices: [] }), {
    hilos: 1, gpu: [], soaTerreno: false, particionarPersonas: false, clonPorPaso: true,
  });

  assert.deepEqual(recommendedMotorForHost({ cpuThreads: 1, totalRamBytes: 4 * GiB, cudaDevices: [0] }), {
    hilos: 1, gpu: [0], soaTerreno: true, particionarPersonas: false, clonPorPaso: true,
  });

  assert.deepEqual(recommendedMotorForHost({ cpuThreads: 2, totalRamBytes: 8 * GiB, cudaDevices: [] }), {
    hilos: 2, gpu: [], soaTerreno: true, particionarPersonas: false, clonPorPaso: true,
  });

  assert.deepEqual(recommendedMotorForHost({ cpuThreads: 4, totalRamBytes: 16 * GiB, cudaDevices: [] }), {
    hilos: 4, gpu: [], soaTerreno: true, particionarPersonas: true, clonPorPaso: true,
  });

  assert.deepEqual(recommendedMotorForHost({ cpuThreads: 7, totalRamBytes: 16 * GiB, cudaDevices: [] }), {
    hilos: 7, gpu: [], soaTerreno: true, particionarPersonas: true, clonPorPaso: true,
  });

  // Sin reserva: todos los hilos de la máquina van al motor.
  assert.deepEqual(recommendedMotorForHost({ cpuThreads: 8, totalRamBytes: 32 * GiB, cudaDevices: [] }), {
    hilos: 8, gpu: [], soaTerreno: true, particionarPersonas: true, clonPorPaso: true,
  });

  // Torre de 32 hilos y 2 GPUs CUDA → 32 hilos (sin reserva) + gpu [0, 1].
  const hw32: HostHardware = { cpuThreads: 32, totalRamBytes: 125 * GiB, cudaDevices: [0, 1] };
  const motor32 = recommendedMotorForHost(hw32);
  assert.deepEqual(motor32, {
    hilos: 32, gpu: [0, 1], soaTerreno: true, particionarPersonas: true, clonPorPaso: true,
  });

  // Copia defensiva y deduplicación de cudaDevices.
  hw32.cudaDevices.push(9);
  assert.deepEqual(motor32.gpu, [0, 1]);
  assert.deepEqual(recommendedMotorForHost({ cpuThreads: 1024, totalRamBytes: 512 * GiB, cudaDevices: [0, 0, -1, 1] }), {
    hilos: 512, gpu: [0, 1], soaTerreno: true, particionarPersonas: true, clonPorPaso: true,
  });
});

test('hostFullHardwareParams: integra límites, motor y persistencia', () => {
  const memory: HostMemory = { fisicaBytes: 128 * GiB, heapBytes: 8 * GiB };
  const customBase = parseParams('social.radioConvivencia=12,persistencia.paginasSucias=true');

  const resolved = hostFullHardwareParams(customBase, {
    cpuThreads: () => 32,
    totalRamBytes: () => 128 * GiB,
    nvrtcAvailable: () => true,
    nvidiaSmi: () => '0\n1\n',
    memory: () => memory,
  });

  assert.equal(Object.isFrozen(resolved), true);
  assert.deepEqual({ ...resolved.limites }, { ...hostLimits(memory), aplicacion: DEFAULT_PARAMS.limites.aplicacion });
  assert.deepEqual(resolved.motor, {
    clonPorPaso: true,
    hilos: 32,
    soaTerreno: true,
    particionarPersonas: true,
    gpu: [0, 1],
    orden: 'natural',
    depuracion: false,
  });
  assert.equal(Object.hasOwn(resolved, 'gobernador'), false);
  assert.deepEqual(resolved.persistencia, {
    cadaTicks: 100,
    ventanaEventosTicks: 24000,
    paginasSucias: true,
  });
  assert.equal(resolved.social.radioConvivencia, 12, 'conserva las leyes de la base');

  // Precedencia: overrides explícitos de despliegue siguen mandando encima.
  const deployed = deploymentParams(resolved, 'persistencia.cadaTicks=60,motor.hilos=8,motor.gpu=[]');
  assert.equal(deployed.persistencia.cadaTicks, 60);
  assert.equal(deployed.motor.hilos, 8);
  assert.deepEqual(deployed.motor.gpu, []);
  assert.equal(deployed.motor.soaTerreno, true);
  assert.equal(deployed.motor.particionarPersonas, true);
  assert.equal(deployed.motor.clonPorPaso, true);

  // hostParams() deriva únicamente los límites.
  const legacyHost = hostParams(DEFAULT_PARAMS, memory);
  assert.deepEqual(legacyHost.motor, DEFAULT_PARAMS.motor);
  assert.deepEqual(legacyHost.persistencia, DEFAULT_PARAMS.persistencia);

  // Un mundo creado con estos params (sin GPU real en el test unitario) avanza sin errores.
  const cpuOnly = hostFullHardwareParams(DEFAULT_PARAMS, {
    cpuThreads: () => 4,
    totalRamBytes: () => 16 * GiB,
    nvrtcAvailable: () => false,
    memory: () => memory,
  });
  const world = createWorld(17, cpuOnly);
  stepWorld(world);
  assert.equal(world.tick, 1);
});

test('anfitrión real: detectHostHardware y hostFullHardwareParams son coherentes con esta máquina', () => {
  const hw = detectHostHardware();
  assert.equal(hw.cpuThreads, availableParallelism());
  assert.equal(hw.totalRamBytes, totalmem());
  assert.equal(new Set(hw.cudaDevices).size, hw.cudaDevices.length);
  for (let i = 0; i < hw.cudaDevices.length; i++) {
    assert.ok(Number.isSafeInteger(hw.cudaDevices[i]) && hw.cudaDevices[i]! >= 0);
    if (i > 0) assert.ok(hw.cudaDevices[i]! > hw.cudaDevices[i - 1]!);
  }

  const params = hostFullHardwareParams();
  assert.deepEqual({ ...params.limites }, { ...hostLimits(hostMemory()), aplicacion: 'parametros' });
  assertWorldLimits(params.limites, true);
  assert.equal(params.motor.hilos, Math.min(512, Math.max(1, hw.cpuThreads)));
  assert.deepEqual(params.motor.gpu, hw.cudaDevices);
  assert.equal(params.motor.soaTerreno, hw.cpuThreads > 1 || hw.cudaDevices.length > 0);
  assert.equal(params.motor.particionarPersonas, hw.cpuThreads >= 4);
  assert.equal(params.motor.clonPorPaso, true);
  assert.equal(params.persistencia.cadaTicks, 100);
  assert.equal(params.persistencia.ventanaEventosTicks, 24000);
  console.log(`Hardware real detectado: ${hw.cpuThreads} hilos CPU → motor.hilos=${params.motor.hilos}, GPUs CUDA=${JSON.stringify(hw.cudaDevices)}.`);
});
