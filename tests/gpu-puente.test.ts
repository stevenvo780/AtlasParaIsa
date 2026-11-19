import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld, phaseAt } from '../src/world/index.js';
import { parseParams, paramsOf } from '../src/world/params.js';
import { closeEcosystemWorkers, ecosystemGpuDiagnostics, killGpuSubprocessForTest } from '../src/world/ecosystem.js';
import { stepEcosystem, stepLocalEcology } from '../src/world/ecosystem.js';
import { gpuNvrtcAvailable, ResidentGpuBridge, GPU_FIELDS } from '../src/world/gpu/puente.js';
import { runParallelEcosystem } from '../src/world/ecosystem-kernel.js';
import { DEFAULT_PARAMS } from '../src/world/params.js';
import type { SharedTerrain } from '../src/world/soa/terreno.js';
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

test('T122 VRAM sharded Dual-GPU [0,1] (70/30) produce 0 diferencias Object.is frente a CPU 1 hilo con mutaciones sobre la costura', { skip }, async () => {
  const N = 65_536, pages = N / 256, gridW = 16, VERSION = 1, TICK = 100;
  const makeTerrain = (): SharedTerrain => {
    const sab = (b: number) => new SharedArrayBuffer(b);
    const cells = new Int32Array(sab(N * 4));
    for (let i = 0; i < N; i++) cells[i] = i;
    const stamps = new Uint32Array(sab(N * 4)); stamps.fill(VERSION);
    const pageX = new Int32Array(sab(pages * 4)), pageY = new Int32Array(sab(pages * 4));
    for (let s = 0; s < pages; s++) { pageX[s] = s % gridW; pageY[s] = Math.floor(s / gridW); }
    const around = new Int32Array(sab(pages * 9 * 4));
    for (let s = 0; s < pages; s++) {
      const px = pageX[s]!, py = pageY[s]!;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = px + dx, ny = py + dy;
        around[s * 9 + (dy + 1) * 3 + (dx + 1)] = (nx < 0 || ny < 0 || nx >= gridW) ? -1 : (ny * gridW + nx < pages ? ny * gridW + nx : -1);
      }
    }
    const buffers: Record<string, SharedArrayBuffer> = {
      cells: cells.buffer as SharedArrayBuffer, stamps: stamps.buffer as SharedArrayBuffer,
      around: around.buffer as SharedArrayBuffer, pageX: pageX.buffer as SharedArrayBuffer,
      pageY: pageY.buffer as SharedArrayBuffer,
      dirty: sab(pages), woodAdded: sab(pages), woodAddedQueue: sab((pages + 2) * 4),
    };
    for (let fi = 0; fi < GPU_FIELDS.length; fi++) {
      const f = GPU_FIELDS[fi]!;
      const front = f.bytes === 8 ? new Float64Array(sab(N * 8)) : new Uint8Array(sab(N));
      const back = f.bytes === 8 ? new Float64Array(sab(N * 8)) : new Uint8Array(sab(N));
      if (f.name === 'terrain') { (front as Uint8Array).fill(2); for (let i = 0; i < N; i += 89) (front as Uint8Array)[i] = 1; }
      else if (f.name === 'biome') { (front as Uint8Array).fill(1); for (let i = 0; i < N; i += 7) (front as Uint8Array)[i] = 2; }
      else if (f.name === 'feature') { (front as Uint8Array).fill(13); for (let i = 0; i < N; i += 53) (front as Uint8Array)[i] = 1; }
      else for (let i = 0; i < N; i++) (front as Float64Array)[i] = (((i * 2654435761 + (fi + 1) * 40503) >>> 0) % 10000) / 10000;
      buffers[f.name] = front.buffer as SharedArrayBuffer;
      buffers[`${f.name}Back`] = back.buffer as SharedArrayBuffer;
    }
    return { regions: [{ id: 0, begin: 0, end: N }], buffers, version: VERSION };
  };
  const swap = (t: SharedTerrain) => {
    for (const f of GPU_FIELDS) { const x = t.buffers[f.name]!; t.buffers[f.name] = t.buffers[`${f.name}Back`]!; t.buffers[`${f.name}Back`] = x; }
  };
  const R = DEFAULT_PARAMS.recursos;
  const p1Cpu = { phase: 'ecologia' as const, weather: 'clear' as const, light: 1, version: VERSION, recursos: R };
  const p1Gpu = { version: VERSION, rain: 0, light: 1, capacidadBosque: R.capacidadBosque, capacidadPastizal: R.capacidadPastizal, capacidadOtros: R.capacidadOtros, velocidadRegeneracion: R.velocidadRegeneracion, decaimientoComida: R.decaimientoComida };
  const p2Gpu = { tick: TICK, version: VERSION, rain: 0, light: 1, decaimientoFertilidad: R.decaimientoFertilidad, seed: 7, cuencas: 1 };
  const tCpu = makeTerrain(), tGpu = makeTerrain();
  const bridge = new ResidentGpuBridge([0, 1], { sharded: true, weights: [0.70, 0.30] });
  const seam = Math.floor(pages * 0.70);
  const dirtySlots = [0, seam - 1, seam, seam + 1, pages - 1];
  try {
    for (let s = 0; s < 20; s++) {
      const tick = TICK + s * 10;
      if (s === 8) {
        for (const t of [tCpu, tGpu]) {
          const m = new Float64Array(t.buffers.moisture!), l = new Float64Array(t.buffers.life!), d = new Uint8Array(t.buffers.dirty!);
          for (const slot of dirtySlots) { m[slot * 256 + 11] = 0.77; l[slot * 256 + 11] = 0.88; d[slot] = 1; }
        }
      }
      runParallelEcosystem({ regions: tCpu.regions, buffers: tCpu.buffers, params: p1Cpu, workerIndex: 0 }); swap(tCpu);
      runParallelEcosystem({ regions: tCpu.regions, buffers: tCpu.buffers, params: { tick, weather: 'clear', light: 1, decaimientoFertilidad: R.decaimientoFertilidad, seed: 7, cuencas: 1, version: VERSION }, workerIndex: 0 }); swap(tCpu);
      bridge.runTick(tGpu, 0, p1Gpu, { ...p2Gpu, tick }, 256, { downloadSlots: dirtySlots });
    }
    bridge.flushToHost(tGpu);
  } finally {
    await bridge.close();
  }
  let diffs = 0;
  for (const f of GPU_FIELDS) {
    if (f.bytes === 8) {
      const a = new Float64Array(tCpu.buffers[f.name]!), b = new Float64Array(tGpu.buffers[f.name]!);
      for (let i = 0; i < N; i++) if (!Object.is(a[i], b[i])) diffs++;
    } else {
      const a = new Uint8Array(tCpu.buffers[f.name]!), b = new Uint8Array(tGpu.buffers[f.name]!);
      for (let i = 0; i < N; i++) if (a[i] !== b[i]) diffs++;
    }
  }
  assert.equal(diffs, 0);
});
