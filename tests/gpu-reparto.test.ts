import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { repartirPaginas, mortonCode } from '../src/world/gpu/reparto.js';
import { parityFixture } from '../src/world/gpu/autoprueba.js';
import { createWorld } from '../src/world/index.js';
import { encodeSnapshot } from '../src/server/snapshot.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { HISTORICAL_PARAMS } from '../src/world/params.js';
// @ts-ignore isolated benchmark helpers
import { pack, topology, localEcologyArrays, stepArrays, stepEcologyArrays, compare } from '../scripts/compute-ecology-core.mjs';
// @ts-ignore isolated benchmark helpers
import { GPUWorker } from '../scripts/compute-ecology-clients.mjs';

const ratios = [[79,21],[50,50],[100,0]];
const ratesOf = (ratios: number[]) => ratios.map((throughput,device) => ({device,throughput}));
function pageFixture() {
  const synthetic=parityFixture();
  return Array.from({length:100},(_,i)=>({x:i%10-5,y:Math.floor(i/10)-5,
    tiles:Array.from({length:256},(_,j)=>({...synthetic[(i*97+j)%synthetic.length],x:(i%10-5)*16+j%16,y:(Math.floor(i/10)-5)*16+Math.floor(j/16)})),
  })).reverse();
}
const options={seed:51926,cuencas:0.4,decaimientoFertilidad:0.001,localEcology:true,recursos:HISTORICAL_PARAMS.recursos};

test('measured throughput rounds to complete pages in contiguous Morton order, including signed coordinates',()=>{
  const pages=pageFixture(), original=[...pages], plan=repartirPaginas(pages);
  assert.deepEqual(plan.map(part=>part.pages.length),[79,21]);
  assert.deepEqual(plan.map(part=>[part.pageBegin,part.pageEnd]),[[0,79],[79,100]]);
  const ordered=plan.flatMap(part=>part.pages), codes=ordered.map(page=>mortonCode(page.x,page.y));
  assert.ok(codes.every((code,i)=>i===0||codes[i-1]<code));
  assert.equal(new Set(ordered).size,pages.length);assert.deepEqual(pages,original);
  assert.deepEqual([mortonCode(0,0),mortonCode(1,0),mortonCode(0,1),mortonCode(1,1)].map(code=>code-mortonCode(0,0)),[0n,1n,2n,3n]);
  for(const ratio of ratios)assert.deepEqual(repartirPaginas(pages,ratesOf(ratio)).map(part=>part.pages.length),ratio);
  assert.deepEqual(repartirPaginas([]).map(part=>part.pages.length),[0,0]);
  assert.deepEqual(repartirPaginas(pages,[{device:1,throughput:680000}])[0].pages,ordered);
});

test('invalid rates, duplicate pages and out-of-domain coordinates reject before scheduling',()=>{
  const pages=[{x:0,y:0}];
  for(const rates of [[],[{device:0,throughput:0}],[{device:0,throughput:-1}],
    [{device:0,throughput:NaN}],[{device:0,throughput:Infinity}],[{device:-1,throughput:1}],
    [{device:0,throughput:1},{device:0,throughput:1}]])assert.throws(()=>repartirPaginas(pages,rates));
  assert.throws(()=>repartirPaginas([...pages,...pages]),/duplicada/);
  for(const coordinate of [NaN,Infinity,0.5,-2147483649,2147483648])assert.throws(()=>mortonCode(coordinate,0),/int32/);
  assert.notEqual(mortonCode(-2147483648,2147483647),mortonCode(2147483647,-2147483648));
});

test('79:21, 50:50 and 100:0 produce Object.is zero differences and identical output bytes across page boundaries',()=>{
  const pages=pageFixture();let control:Buffer|undefined;
  for(const ratio of ratios) {
    const plan=repartirPaginas(pages,ratesOf(ratio)), tiles=plan.flatMap(part=>part.pages.flatMap(page=>page.tiles));
    const n=tiles.length, neighbors=topology(tiles), input=pack(tiles);
    const middle=new Float64Array(input.length), output=new Float64Array(input.length), expected=new Float64Array(input.length);
    // Complete barrier between passes, even when a cardinal/living neighbor belongs to the other GPU.
    localEcologyArrays(input,middle,neighbors,n,100,true,1,options);
    for(const part of plan)stepArrays(middle,output,neighbors,n,100,true,1,part.pageBegin*256,part.pageEnd*256,options);
    stepEcologyArrays(input,expected,neighbors,n,100,true,1,options);
    assert.deepEqual(compare(expected,output),{different:0,maximumAbsoluteError:0});
    const bytes=Buffer.from(output.buffer);
    if(control)assert.deepEqual(bytes,control);else control=bytes;
  }
});

test('runtime assignment and throughput never enter the world snapshot or canonical digest',()=>{
  const world=createWorld(51926), before=encodeSnapshot(world), digest=digestoCanonico(world);
  const pages=pageFixture();
  for(const ratio of ratios) {
    const plan=repartirPaginas(pages,ratesOf(ratio));assert.equal(plan.length,2);
    assert.equal(encodeSnapshot(world),before);assert.equal(digestoCanonico(world),digest);
  }
  assert.doesNotMatch(before,/throughput|pageBegin|pageEnd|reparto|assignment/);
});

test('real multi-GPU page schedules 79:21, 50:50 and 100:0 are byte identical',async context=>{
  const nvrtc=process.env.COMPUTE_NVRTC;
  if(!nvrtc){context.skip('COMPUTE_NVRTC absent');return;}
  const probe=spawnSync('python3',['-c','import ctypes; print(ctypes.CDLL("libcuda.so.1").cuInit(0))'],{encoding:'utf8',timeout:5000});
  if(probe.stdout.trim()!=='0'){context.skip(`CUDA no disponible: cuInit=${probe.stdout.trim()||probe.stderr.trim()}`);return;}
  const gpu=await GPUWorker.create('0,1',nvrtc), pages=pageFixture();let control:Buffer|undefined;
  try {
    for(const ratio of ratios) {
      const plan=repartirPaginas(pages,ratesOf(ratio)), tiles=plan.flatMap(part=>part.pages.flatMap(page=>page.tiles));
      const input=pack(tiles), n=tiles.length, neighbors=topology(tiles);
      await gpu.setup(n,neighbors,{ranges:plan.map(part=>({device:part.device,begin:part.pageBegin*256,end:part.pageEnd*256}))});
      const actual=(await gpu.step(input,100,true,1,options)).data, expected=new Float64Array(input.length);
      stepEcologyArrays(input,expected,neighbors,n,100,true,1,options);
      assert.deepEqual(compare(expected,actual),{different:0,maximumAbsoluteError:0});
      const bytes=Buffer.from(actual.buffer,actual.byteOffset,actual.byteLength);
      if(control)assert.deepEqual(bytes,control);else control=Buffer.from(bytes);
    }
  } finally {await gpu.close();}
});
