import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { GPUParitySession, parityFixture, type ParityBackend, type ParityDiagnostic, type ParityOptions } from '../src/world/gpu/autoprueba.js';
import { createWorld, cloneWorld, stepWorld } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
// @ts-ignore isolated benchmark helpers
import { stepEcologyArrays, topology } from '../scripts/compute-ecology-core.mjs';

function backend(divergentIndex?: number): ParityBackend & { closed: boolean; calls: number } {
  let neighbors: Int32Array, n: number;
  return {
    initialization: { fmad: false, devices: [{ index: 0, architecture: 'compute_120', driver: 13000, compileOptions: ['--fmad=false'] }] },
    closed: false, calls: 0,
    async setup(count, around) { n = count; neighbors = around; },
    async step(input, tick, rain, light, options: ParityOptions) {
      this.calls++;
      const data = new Float64Array(input.length);
      stepEcologyArrays(input, data, neighbors, n, tick, rain, light, options);
      if (divergentIndex !== undefined) new BigUint64Array(data.buffer)[divergentIndex] ^= 1n;
      return { data };
    },
    async close() { this.closed = true; },
  };
}

test('4096 synthetic cells cover every biome, feature, cardinal neighbor and signed basin boundary', () => {
  const tiles = parityFixture();
  assert.equal(tiles.length,4096);
  assert.equal(new Set(tiles.map(tile => tile.biome)).size,6);
  assert.equal(new Set(tiles.map(tile => tile.feature)).size,14);
  for (const edge of [-25,-24,-1,0,23,24,25]) assert.ok(tiles.some(tile => tile.x === edge && tile.y === edge));
  assert.ok(tiles.some(tile => tile.growth === undefined));
  assert.equal(topology(tiles).length,4096*8);
});

test('a single ULP disables the GPU for the session, logs the first index and leaves the world digest intact', async () => {
  const world = createWorld(51926), control = cloneWorld(world), digest = digestoCanonico(world);
  const gpu = backend(37), diagnostics: ParityDiagnostic[] = [], session = new GPUParitySession();
  const result = await session.initialize(0,{nvrtc:'/injected',createBackend:async()=>gpu,log:value=>diagnostics.push(value)});
  assert.equal(result.available,true); assert.equal(result.enabled,false); assert.equal(gpu.closed,true);
  assert.equal(session.isEnabled(0),false); assert.equal(result.diagnostic?.firstDivergentIndex,37);
  assert.equal(diagnostics.length,1); assert.equal(diagnostics[0].architecture,'compute_120');
  assert.equal(diagnostics[0].device,0); assert.equal(diagnostics[0].driver,13000);
  const bits = new Float64Array([diagnostics[0].expected!,diagnostics[0].actual!]);
  assert.equal(new BigUint64Array(bits.buffer)[0]^new BigUint64Array(bits.buffer)[1],1n);
  assert.deepEqual(await session.initialize(0,{createBackend:async()=>{throw new Error('must not reinitialize');}}),result);
  assert.equal(gpu.calls,1); assert.equal(session.performance[0].enabled,false);
  assert.equal(digestoCanonico(world),digest);
  stepWorld(world); stepWorld(control); assert.equal(digestoCanonico(world),digestoCanonico(control));
});

test('without CUDA initialization is nonfatal and reports no disponible',async()=>{
  const session = new GPUParitySession();
  const result = await session.initialize(0,{nvrtc:'/unavailable',createBackend:async()=>{throw new Error('CUDA/NVRTC result 100');}});
  assert.equal(result.available,false); assert.equal(result.enabled,false); assert.equal(result.reason,'no disponible');
  assert.equal(result.comparisons,0); assert.equal(session.isEnabled(0),false);
  const withoutLibrary=await new GPUParitySession().initialize(0,{nvrtc:'',createBackend:async()=>{throw new Error('must not start');}});
  assert.equal(withoutLibrary.available,false);assert.equal(withoutLibrary.reason,'no disponible');
});

test('the full live CPU reference accepts an exact backend in all four parameter quadrants',async context=>{
  const gpu=backend(),session=new GPUParitySession();
  const result=await session.initialize(0,{nvrtc:'/injected',createBackend:async()=>gpu});
  assert.equal(result.available,true);assert.equal(result.enabled,true,JSON.stringify(result));
  assert.equal(result.comparisons,4);assert.ok(result.verificationMs<=200);
  assert.equal(session.isEnabled(0),true);assert.equal(gpu.closed,true);
  context.diagnostic(JSON.stringify(result));
});

test('a stalled parity dispatch expires its 200 ms budget and closes its backend',async()=>{
  const gpu=backend();gpu.step=()=>new Promise(()=>{});
  const session=new GPUParitySession();
  const result=await session.initialize(0,{nvrtc:'/injected',createBackend:async()=>gpu});
  assert.equal(result.enabled,false);assert.match(result.reason!,/200 ms/);assert.equal(gpu.closed,true);
});

test('NVRTC contraction enabled is rejected by the parity verifier before executing sensitive ecology formulas',
  {skip:!process.env.COMPUTE_NVRTC&&'COMPUTE_NVRTC absent'},async()=>{
  // Negative control is independent of driver access: NVRTC must really compile the contracted code.
  const nvrtc=process.env.COMPUTE_NVRTC;
    const compiled=spawnSync('python3',[new URL('../scripts/compute-ecology-gpu.py',import.meta.url).pathname,
      '--nvrtc',nvrtc!,'--compile-only','compute_120','--test-fmad','true'],{encoding:'utf8',timeout:15000});
    assert.equal(compiled.status,0,compiled.stdout||compiled.stderr);
    const compilation=JSON.parse(compiled.stdout);
    assert.ok(compilation.fmaInstructions>0);
    const gpu=backend();gpu.initialization.fmad=true;gpu.initialization.devices[0].compileOptions=compilation.options;
    const result=await new GPUParitySession().initialize(0,{nvrtc,createBackend:async()=>gpu});
    assert.equal(result.enabled,false);assert.match(result.reason!,/fmad=false/);
    assert.equal(gpu.calls,0);assert.equal(gpu.closed,true);
});

for(const device of [0,1])test(`real CUDA GPU ${device}: full tick parity on 4096 cells within 200 ms after initialization`,async context=>{
  const nvrtc=process.env.COMPUTE_NVRTC;
  if(!nvrtc){context.skip('COMPUTE_NVRTC absent');return;}
  const probe=spawnSync('python3',['-c','import ctypes; print(ctypes.CDLL("libcuda.so.1").cuInit(0))'],{encoding:'utf8',timeout:5000});
  if(probe.stdout.trim()!=='0'){context.skip(`CUDA no disponible: cuInit=${probe.stdout.trim()||probe.stderr.trim()}`);return;}
  const session=new GPUParitySession(), result=await session.initialize(device,{nvrtc});
  assert.equal(result.available,true);assert.equal(result.enabled,true,JSON.stringify(result));
  assert.equal(session.isEnabled(device),true);assert.equal(result.cells,4096);assert.equal(result.comparisons,4);
  assert.ok(result.verificationMs<=200,JSON.stringify(result));
  context.diagnostic(JSON.stringify(result));
});
