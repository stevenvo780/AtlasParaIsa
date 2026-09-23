import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { EcosystemKernel } from '../src/world/ecosystem-kernel.js';
import { stepEcosystem } from '../src/world/ecosystem.js';
import { createWorld, stepWorld, cloneWorld, ecology, phaseAt, type World } from '../src/world/index.js';
import { parseParams, paramsOf, HISTORICAL_PARAMS } from '../src/world/params.js';
import { generateChunk } from '../src/world/terrain.js';
import { ruidoCuenca } from '../src/world/agua.js';
// Isolated .mjs benchmark helpers intentionally have no application wiring.
// @ts-ignore benchmark-only JavaScript module
import { topology, pack, unpack, stepArrays, compare, basinNoise, validateLiveKernel } from '../scripts/compute-ecology-core.mjs';
// @ts-ignore benchmark-only JavaScript module
import { CPUWorkers, GPUWorker } from '../scripts/compute-ecology-clients.mjs';
import type { Tile } from '../src/shared/types.js';

const clone=(tiles:Tile[])=>tiles.map(tile=>({...tile}));
function fixture():Tile[] {
  const tiles=generateChunk(51926,-1,0).tiles.filter((_,i)=>i%17!==0);
  tiles.push({x:200,y:-200,terrain:'water',biome:'ocean',moisture:0.9,vegetation:0.4,food:0.3,drinkingWater:0.7});
  tiles.push({x:201,y:-200,terrain:'meadow',biome:'mountain',feature:'stump',wood:0.999,growth:0.9,fertility:0.9,moisture:0.9,vegetation:0.7,food:0.5});
  for(const x of [-49,-25,-24,-1,0,23,24,49]) tiles.push({x,y:-300,terrain:'meadow',biome:'grassland',feature:'spring',fertility:0.9,moisture:0.9,vegetation:0.7,food:0.5,drinkingWater:0.2});
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
test('GPU requests cover stdin backpressure and close escalates only their owned unresponsive child',async()=>{
  // Real pipes and an owned child that acknowledges readiness but never reads input.
  const child=spawn(process.execPath,['--eval',"process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000);"],{stdio:['pipe','pipe','pipe']});
  const completed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  await once(child.stdout,'data');
  const gpu=new GPUWorker();gpu.process=child;gpu.completion=completed;
  gpu.reader={frame:()=>new Promise(()=>{})};child.stdin.on('error',()=>{});
  const deadline=gpu.deadline.bind(gpu);let deadlines=0;
  gpu.deadline=(promise:Promise<unknown>)=>{deadlines++;return deadline(promise,30);};
  try {
    await assert.rejects(gpu.setup(131072,new Int32Array(262144)),/deadline exceeded/);
    assert.equal(deadlines,1);assert.equal(child.stdin.writableNeedDrain,true);
    await assert.rejects(gpu.step(new Float64Array(131072),10,false,1),/deadline exceeded/);
    assert.equal(deadlines,2);
    await gpu.close();
    assert.equal(child.signalCode,'SIGKILL');
    await gpu.close(); // Repeated cleanup awaits the same already completed close.
  } finally {
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    await completed;
  }
});
test('the live contract accepts the engine and rejects a changed physical result',()=>{
  const kernel=new EcosystemKernel();
  const reference=(tiles:Tile[],tick:number,rain:boolean,light:number,options:import('../src/world/ecosystem-kernel.js').EcosystemOptions)=>
    kernel.step(tiles,tick,rain?'rain':'clear',light===1?'day':light===0?'night':'dawn',options);
  const result=validateLiveKernel(reference);
  assert.equal(result.comparisons,192);
  assert.equal(result.differentValues,0);
  assert.throws(()=>validateLiveKernel((...args:Parameters<typeof reference>)=>{
    reference(...args); args[0][0].fertility!+=0.01;
  }),/Live ecology contract.*differs/);
  assert.throws(()=>validateLiveKernel((...args:Parameters<typeof reference>)=>{
    reference(...args); args[0][0].food+=0.125;
  }),/Live ecology contract.*tile fields differ/,'una regla nueva sobre un campo no empaquetado también invalida el port');
});

test('basin hashing preserves signed seeds, negative floors and boundaries exactly',()=>{
  for(const seed of [0,42,51926,-1,2147483647,4294967295])
    for(const x of [-10000000,-49,-48,-25,-24,-1,0,1,23,24,25,9999999])
      for(const y of [-49,-24,-1,0,23,24,49])
        assert.ok(Object.is(basinNoise(seed,x,y),ruidoCuenca(seed,x,y)),`${seed},${x},${y}`);
});

for(const cuencas of [1,0.4])for(const decaimientoFertilidad of [0,0.001])test(`SoA agrees with live engine over 120 varied updates, basins=${cuencas}, decay=${decaimientoFertilidad}`,()=>{
  let actual=fixture(),expected=clone(actual);const kernel=new EcosystemKernel();
  const options={seed:51926,cuencas,decaimientoFertilidad};
  for(let j=0;j<120;j++){
    const tick=(j+1)*10,phase=['day','night','dawn'][j%3],rain=j%4===0;
    if(j===30){actual.reverse();expected.reverse();}
    if(j===60){actual[3].x+=1000;expected[3].x+=1000;}
    actual=clone(actual);expected=clone(expected);
    const input=pack(actual),output=new Float64Array(input.length);
    stepArrays(input,output,topology(actual),actual.length,tick,rain,phase==='day'?1:phase==='night'?0:0.4,0,actual.length,options);
    unpack(output,actual,tick);kernel.step(expected,tick,rain?'rain':'clear',phase,options);
    assert.deepStrictEqual(actual,expected,`update ${j}`);
  }
});
test('worker partitions read old neighbor state across partition boundaries and preserve every output',async()=>{
  const actual=fixture(),expected=clone(actual),neighbors=topology(actual);
  const workers=await CPUWorkers.create(actual.length,neighbors,4);
  try{
    for(let j=0;j<12;j++){
      const options={seed:51926,cuencas:j%2===0?0.4:1,decaimientoFertilidad:j%4<2?0:0.001};
      const tick=(j+1)*100;pack(actual,workers.input);
      const result=await workers.step(tick,j%2===0,1,options);unpack(result.data,actual,tick);
      new EcosystemKernel().step(expected,tick,j%2===0?'rain':'clear','day',options);
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

// T114 (refutación G4): el tick ecológico íntegro de `advanceTick` es `ecology()` y luego el kernel, en ese orden;
// `food` sólo lo escribe la primera. El oráculo es esa composición viva; el candidato, la misma `ecology()` sobre
// objetos (su port es de T120) seguida del kernel SoA.
const lightOf=(phase:string)=>phase==='day'?1:phase==='night'?0:0.4;
const kernelOptions=(world:World)=>({decaimientoFertilidad:paramsOf(world).recursos.decaimientoFertilidad,seed:world.seed,cuencas:paramsOf(world).agua.cuencas});
function liveTick(world:World):void {
  ecology(world);
  stepEcosystem(world.tiles,world.tick,world.weather,phaseAt(world.tick),false,kernelOptions(world));
}
async function soaTick(world:World,neighbors:Int32Array,workers?:InstanceType<typeof CPUWorkers>):Promise<void> {
  ecology(world);
  const n=world.tiles.length,rain=world.weather==='rain',light=lightOf(phaseAt(world.tick));
  if(workers){pack(world.tiles,workers.input);unpack((await workers.step(world.tick,rain,light,kernelOptions(world))).data,world.tiles,world.tick);return;}
  const input=pack(world.tiles),output=new Float64Array(input.length);
  stepArrays(input,output,neighbors,n,world.tick,rain,light,0,n,kernelOptions(world));
  unpack(output,world.tiles,world.tick);
}
function assertSameTick(live:World,soa:World,label:string):void {
  assert.deepEqual(compare(pack(live.tiles),pack(soa.tiles)),{different:0,maximumAbsoluteError:0},label);
  for(let i=0;i<live.tiles.length;i++)for(const field of ['food','moisture','vegetation'] as const)
    if(!Object.is(live.tiles[i][field],soa.tiles[i][field]))assert.fail(`${label}: ${field} differs at tile ${i}`);
  assert.equal(soa.weather,live.weather,label);assert.equal(soa.rng,live.rng,label);assert.equal(soa.events.length,live.events.length,label);
}
const BASIN_EDGES=[-49,-48,-25,-24,-1,0,23,24,25,47,48];
/** Chunks generados de x,y ∈ [-50,50] (cruzan todos los múltiplos de 24 con signo), con huecos, reservorios en los bordes del ruido, tocones y tráfico/cultivo. */
function basinEdgeTiles(seed:number,cuencas:number):Tile[] {
  const tiles:Tile[]=[];
  for(let cy=-4;cy<4;cy++)for(let cx=-4;cx<4;cx++)for(const tile of generateChunk(seed,cx,cy,cuencas).tiles){
    const {x,y}=tile,edge=BASIN_EDGES.includes(x)&&BASIN_EDGES.includes(y);
    if(Math.abs(x)>50||Math.abs(y)>50||(!edge&&(Math.imul(x,7)+Math.imul(y,13)&15)===0))continue;
    if(edge){if(tile.terrain==='water')tile.terrain='meadow';tile.feature=(x+y)&1?'spring':'pool';if(x===y)tile.biome='wetland';}
    else if((x*y)%37===0&&tile.terrain!=='water')Object.assign(tile,{feature:'stump',wood:0.999,growth:0.9,fertility:0.9,moisture:0.9,traffic:0});
    if((x+2*y)%5===0)tile.traffic=0.2;
    if((2*x+y)%7===0)tile.cultivation=0.3;
    tiles.push(tile);
  }
  return tiles;
}
const worldParams=(cuencas:number,decaimientoFertilidad:number)=>parseParams(`agua.cuencas=${cuencas},recursos.decaimientoFertilidad=${decaimientoFertilidad}`,HISTORICAL_PARAMS);
async function compareEcologicalTicks(base:World,ticks:number,label:string,workerCount=0):Promise<{rainTicks:number;fedTiles:number}> {
  const live=cloneWorld(base),soa=cloneWorld(base),neighbors=topology(soa.tiles),initialFood=base.tiles.map(tile=>tile.food);
  const workers=workerCount?await CPUWorkers.create(soa.tiles.length,neighbors,workerCount):undefined;
  let rainTicks=0;
  try{
    for(let j=0;j<ticks;j++){
      live.tick+=10;soa.tick+=10;
      liveTick(live);await soaTick(soa,neighbors,workers);
      if(live.weather==='rain')rainTicks++;
      assertSameTick(live,soa,`${label} tick ${live.tick}`);
      if(j%40===39)assert.deepStrictEqual(soa.tiles,live.tiles,`${label} tick ${live.tick}`);
    }
  }finally{await workers?.close();}
  assert.deepStrictEqual(soa.tiles,live.tiles,label);
  return {rainTicks,fedTiles:live.tiles.filter((tile,i)=>!Object.is(tile.food,initialFood[i])).length};
}
for(const cuencas of [1,0.4])for(const decaimientoFertilidad of [0,0.001])test(`whole ecological tick: ecology() then SoA kernel equals ecology() then live kernel, basins=${cuencas}, decay=${decaimientoFertilidad}`,async()=>{
  const params=worldParams(cuencas,decaimientoFertilidad);
  // Mundo real envejecido: tráfico de habitantes, teselas activadas por maintainRegions y reloj en marcha.
  const aged=createWorld(51926,params);
  for(let step=0;step<600;step++)stepWorld(aged);
  assert.equal(paramsOf(cloneWorld(aged)).agua.cuencas,cuencas);
  assert.ok(aged.tiles.some(tile=>(tile.traffic??0)>0));
  const real=await compareEcologicalTicks(aged,240,'aged world');
  assert.ok(real.fedTiles>0,'ecology() must write food during the comparison');
  // Conjunto disperso sobre coordenadas negativas y los bordes de la escala 24 del ruido, bajo lluvia.
  const edges=createWorld(51926,params);
  edges.tiles=basinEdgeTiles(51926,cuencas);edges.tick=1400;edges.weather='rain';
  const gated=edges.tiles.filter(tile=>tile.terrain!=='water'&&(tile.feature==='spring'||tile.feature==='pool'||tile.biome==='wetland')&&ruidoCuenca(51926,tile.x,tile.y)>=cuencas).length;
  assert.equal(gated>0,cuencas<1,'the basin gate must be exercised exactly when cuencas < 1');
  const synthetic=await compareEcologicalTicks(edges,120,'basin edges');
  assert.ok(synthetic.rainTicks>0&&synthetic.fedTiles>0);
});
test('whole ecological tick through CPU workers: the partition decides who computes, never what comes out',async()=>{
  const edges=createWorld(51926,worldParams(0.4,0.001));
  edges.tiles=basinEdgeTiles(51926,0.4);edges.tick=1400;edges.weather='rain';
  for(const workers of [1,3,4])await compareEcologicalTicks(edges,60,`${workers} workers`,workers);
});
for(const devices of ['0','1','0,1'])test(`CUDA ${devices} agrees with live-state CPU reference over 12 updates`,async context=>{
  const nvrtc=process.env.COMPUTE_NVRTC;
  if(!nvrtc){context.skip('COMPUTE_NVRTC absent: no GPU parity was checked');return;}
  const gpu=await GPUWorker.create(devices,nvrtc);
  try{
    const actual=fixture(),expected=clone(actual);await gpu.setup(actual.length,topology(actual));
    const kernel=new EcosystemKernel();
    for(let j=0;j<12;j++){
      const options={seed:j%2===0?51926:4294967295,cuencas:j%2===0?0.4:1,decaimientoFertilidad:j%4<2?0:0.001};
      const tick=j===0?1:(j+1)*100,light=j%3===0?0:j%3===1?0.4:1,rain=j%2===0;
      const result=await gpu.step(pack(actual),tick,rain,light,options);unpack(result.data,actual,tick);
      kernel.step(expected,tick,rain?'rain':'clear',light===0?'night':light===1?'day':'dawn',options);
      assert.deepEqual(compare(pack(expected),result.data),{different:0,maximumAbsoluteError:0},'incluye la respuesta cruda cuando unpack no hace nada');
      assert.deepStrictEqual(actual,expected,`GPU ${devices} update ${j}`);
    }
  }finally{await gpu.close();}
});
