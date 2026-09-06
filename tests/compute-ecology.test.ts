import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EcosystemKernel } from '../src/world/ecosystem-kernel.js';
import { generateChunk } from '../src/world/terrain.js';
// Isolated .mjs benchmark helpers intentionally have no application wiring.
// @ts-ignore benchmark-only JavaScript module
import { topology, pack, unpack, stepArrays, compare } from '../scripts/compute-ecology-core.mjs';
// @ts-ignore benchmark-only JavaScript module
import { CPUWorkers, GPUWorker } from '../scripts/compute-ecology-clients.mjs';
import type { Tile } from '../src/shared/types.js';

const clone=(tiles:Tile[])=>tiles.map(tile=>({...tile}));
function fixture():Tile[] {
  const tiles=generateChunk(51926,-1,0).tiles.filter((_,i)=>i%17!==0);
  tiles.push({x:200,y:-200,terrain:'water',biome:'ocean',moisture:0.9,vegetation:0.4,food:0.3,drinkingWater:0.7});
  tiles.push({x:201,y:-200,terrain:'meadow',biome:'mountain',feature:'stump',wood:0.999,growth:0.9,fertility:0.9,moisture:0.9,vegetation:0.7,food:0.5});
  return tiles;
}
test('missing Python rejects GPU setup and completes owned cleanup without an exit event',()=>{
  const clientURL = new URL('../scripts/compute-ecology-clients.mjs', import.meta.url).href;
  const probe = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { GPUWorker } from ${JSON.stringify(clientURL)};
    await assert.rejects(GPUWorker.create('0', '/unused-nvrtc'), error => error.code === 'ENOENT');
    process.stdout.write('rejected-and-closed');
  `], { env: { PATH: '/nonexistent-atlas-compute-python' }, encoding: 'utf8', timeout: 3000 });
  assert.equal(probe.error, undefined);
  assert.equal(probe.status, 0);
  assert.equal(probe.stdout, 'rejected-and-closed');
});
test('SoA port agrees exactly with the unchanged engine through 120 varied updates, gaps and feature transitions',()=>{
  let actual=fixture(),expected=clone(actual);const kernel=new EcosystemKernel();
  for(let j=0;j<120;j++){
    const tick=(j+1)*10,phase=['day','night','dawn'][j%3],rain=j%4===0;
    if(j===30){actual.reverse();expected.reverse();}
    if(j===60){actual[3].x+=1000;expected[3].x+=1000;}
    actual=clone(actual);expected=clone(expected);
    const input=pack(actual),output=new Float64Array(input.length);
    stepArrays(input,output,topology(actual),actual.length,tick,rain,phase==='day'?1:phase==='night'?0:0.4);
    unpack(output,actual,tick);kernel.step(expected,tick,rain?'rain':'clear',phase);
    assert.deepStrictEqual(actual,expected,`update ${j}`);
  }
});
test('worker partitions read old neighbor state across partition boundaries and preserve every output',async()=>{
  const actual=fixture(),expected=clone(actual),neighbors=topology(actual);
  const workers=await CPUWorkers.create(actual.length,neighbors,4);
  try{
    for(let j=0;j<12;j++){
      const tick=(j+1)*100;pack(actual,workers.input);
      const result=await workers.step(tick,j%2===0,1);unpack(result.data,actual,tick);
      new EcosystemKernel().step(expected,tick,j%2===0?'rain':'clear','day');
      assert.deepStrictEqual(actual,expected);
    }
  }finally{await workers.close();}
});
test('duplicate coordinates reject before execution and comparator rejects missing or nonfinite outputs',()=>{
  const tiles=fixture();tiles.push({...tiles[0]});
  assert.throws(()=>topology(tiles),/Duplicate/);
  assert.throws(()=>compare(new Float64Array(1),new Float64Array(2)),/length/);
  assert.throws(()=>compare(new Float64Array(1),new Float64Array([NaN])),/Nonfinite/);
  assert.deepEqual(compare(new Float64Array([1]),new Float64Array([1+Number.EPSILON])),{different:1,maximumAbsoluteError:Number.EPSILON});
  assert.deepEqual(compare(new Float64Array([0]),new Float64Array([-0])),{different:1,maximumAbsoluteError:0});
});
test('wood consumes local growth, rain cannot fill ordinary soil, and ocean water stays undrinkable',()=>{
  const cells:Tile[]=[
    {x:0,y:0,terrain:'meadow',biome:'mountain',feature:'stump',wood:0.999,growth:0.9,fertility:0.9,life:0.5,moisture:0.9,vegetation:0.7,food:0.5,stone:2},
    {x:10,y:10,terrain:'soil',biome:'grassland',moisture:0.7,vegetation:0.5,food:0.2,drinkingWater:0},
    {x:20,y:20,terrain:'water',biome:'ocean',moisture:0.7,vegetation:0.2,food:0.3,drinkingWater:0.9},
  ];
  const old=clone(cells),input=pack(cells),at100=new Float64Array(input.length),at90=new Float64Array(input.length);
  stepArrays(input,at100,topology(cells),cells.length,100,true,1);
  stepArrays(input,at90,topology(cells),cells.length,90,true,1);
  unpack(at100,cells,100);
  const paidWood=0.025*1*0.9*0.9;
  assert.equal(cells[0].wood,old[0].wood!+paidWood);
  assert.equal(cells[0].growth,Math.max(0,Math.min(1,at90[0]-paidWood*0.05)));
  assert.equal(cells[0].feature,'pine');
  assert.equal(cells[1].drinkingWater,0);
  assert.equal(cells[2].drinkingWater,0);
  assert.deepEqual(cells.map(x=>[x.food,x.stone]),old.map(x=>[x.food,x.stone]));
});
for(const devices of ['0','1','0,1'])test(`CUDA ${devices} agrees with live-state CPU reference over 12 updates`,async context=>{
  const nvrtc=process.env.COMPUTE_NVRTC;
  if(!nvrtc){context.skip('COMPUTE_NVRTC absent: no GPU parity was checked');return;}
  const gpu=await GPUWorker.create(devices,nvrtc);
  try{
    const actual=fixture(),expected=clone(actual);await gpu.setup(actual.length,topology(actual));
    const kernel=new EcosystemKernel();
    for(let j=0;j<12;j++){
      const tick=(j+1)*100,light=j%3===0?0:j%3===1?0.4:1,rain=j%2===0;
      const result=await gpu.step(pack(actual),tick,rain,light);unpack(result.data,actual,tick);
      kernel.step(expected,tick,rain?'rain':'clear',light===0?'night':light===1?'day':'dawn');
      assert.deepStrictEqual(actual,expected,`GPU ${devices} update ${j}`);
    }
  }finally{await gpu.close();}
});
