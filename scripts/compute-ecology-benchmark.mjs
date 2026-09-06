#!/usr/bin/env node
// Run with node --import tsx. This measures ecology only, never Store or live data.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import { EcosystemKernel } from '../src/world/ecosystem-kernel.ts';
import { generateChunk } from '../src/world/terrain.ts';
import { FIELDS, topology, pack, unpack, stepArrays, compare } from './compute-ecology-core.mjs';
import { CPUWorkers, GPUWorker } from './compute-ecology-clients.mjs';

const SOURCE='95ff0d20aad5a12f08b37aaedd98abe84acfd163';
const args=process.argv.slice(2);
function option(name,fallback){const index=args.indexOf(name);return index<0?fallback:args[index+1];}
if(args.includes('--help')||!args.includes('--output')){
  process.stdout.write('node --import tsx scripts/compute-ecology-benchmark.mjs --output NEW_DIRECTORY --nvrtc /tmp/.../libnvrtc.so.12 [--sizes 256,1024,4096,65536,262144,1000000] [--repetitions 8]\n');process.exit(0);
}
const directory=path.resolve(option('--output')), nvrtc=option('--nvrtc');
const sizes=option('--sizes','256,1024,4096,65536,262144,1000000').split(',').map(Number);
const repetitions=Number(option('--repetitions','8'));
if(sizes.some(n=>!Number.isInteger(n)||n<1||n>1_000_000)||!Number.isInteger(repetitions)||repetitions<3||repetitions>20)throw new Error('Invalid bounded workload');
await mkdir(directory,{recursive:false,mode:0o700});
const sha=data=>createHash('sha256').update(data).digest('hex');
const source=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const base=execFileSync('git',['merge-base',SOURCE,'HEAD'],{encoding:'utf8'}).trim();
if(base!==SOURCE)throw new Error('Benchmark source is not descended from the fixed baseline');
const coreFiles=['src/world/ecosystem-kernel.ts','src/world/ecosystem.ts','src/world/terrain.ts'];
const hashes=async()=>Object.fromEntries(await Promise.all(coreFiles.map(async file=>[file,sha(await readFile(file))])));
const initialHashes=await hashes();
const benchmarkFiles=['scripts/compute-ecology-core.mjs','scripts/compute-ecology-worker.mjs','scripts/compute-ecology-clients.mjs','scripts/compute-ecology-benchmark.mjs','scripts/compute-ecology-gpu.py','scripts/compute-ecology.cu'];
const benchmarkHashes=Object.fromEntries(await Promise.all(benchmarkFiles.map(async file=>[file,sha(await readFile(file))])));
for(const file of coreFiles)if(sha(execFileSync('git',['show',`${SOURCE}:${file}`]))!==initialHashes[file])throw new Error('Baseline core changed: '+file);
async function hardware(){
  const cpuMax=await readFile('/sys/fs/cgroup/cpu.max','utf8');
  const ramMax=await readFile('/sys/fs/cgroup/memory.max','utf8');
  const ramCurrent=await readFile('/sys/fs/cgroup/memory.current','utf8');
  let gpu;try{gpu=execFileSync('nvidia-smi',['--query-gpu=index,name,memory.total,memory.free,utilization.gpu,driver_version','--format=csv,noheader,nounits'],{encoding:'utf8',timeout:10000}).trim().split('\n');}catch(error){gpu={unavailable:error.code??'probe-failed'};}
  return {at:new Date().toISOString(),cpuModel:os.cpus()[0]?.model,logicalCPUs:os.cpus().length,parallelism:os.availableParallelism(),cpuMax:cpuMax.trim(),memoryMax:ramMax.trim(),memoryCurrent:ramCurrent.trim(),hostLoadAverage:os.loadavg(),gpu};
}
function makeTiles(n,seed){
  const chunks=Math.ceil(n/256),width=Math.ceil(Math.sqrt(chunks)),tiles=[];
  for(let j=0;j<chunks;j++)tiles.push(...generateChunk(seed,j%width-Math.floor(width/2),Math.floor(j/width)-Math.floor(width/2)).tiles);
  tiles.length=n;
  // Deterministic stress states complement actual generated terrain, never free resources in an application.
  for(let i=0;i<n;i+=127){tiles[i].life=i%254?0.45:0.44999999999999996;tiles[i].moisture=i%381?0.15:0.14999999999999997;}
  return tiles;
}
function coordinates(tiles){const result=new Float64Array(tiles.length*2);for(let i=0;i<tiles.length;i++){result[2*i]=tiles[i].x;result[2*i+1]=tiles[i].y;}return result;}
function checkCoordinates(tiles,coords){for(let i=0;i<tiles.length;i++)if(!Object.is(tiles[i].x,coords[2*i])||!Object.is(tiles[i].y,coords[2*i+1]))throw new Error('Topology changed; rebuild required');}
const clone=tiles=>tiles.map(tile=>({...tile}));
function summary(values){const sorted=[...values].sort((a,b)=>a-b);return {min:sorted[0],median:sorted[Math.floor(sorted.length/2)],max:sorted.at(-1),mean:values.reduce((a,b)=>a+b,0)/values.length};}
const result={version:2,startedAt:new Date().toISOString(),source,baseline:SOURCE,coreHashes:initialHashes,benchmarkHashes,hardwareBefore:await hardware(),sizes,repetitions,precision:'Float64; NVRTC --fmad=false; no fast-math',scope:'EcosystemKernel only. Does not include stepWorld, raw resource updater, fauna, cloneWorld beyond tiles, JSON, projection or SQLite. Shared host; no exclusive hardware allocation.',coldDefinition:'First invocation after process/context and topology setup; startup, NVRTC compilation and topology allocation/upload are separately charged. Driver disk JIT cache is not disabled. Warm summaries exclude the first invocation but do not hide later JIT/GC outliers.',gpuTransport:'Persistent Python ctypes worker over binary stdio; pageable HtoD and DtoH, synchronized kernel, CUDA event interval, output assembly and Node IPC measured. Dual mode partitions outputs 50/50 and duplicates complete old input uploads, including halo life; no transfers omitted.',sources:['https://docs.nvidia.com/cuda/nvrtc/index.html','https://docs.nvidia.com/cuda/cuda-driver-api/group__CUDA__EXEC.html','https://docs.nvidia.com/cuda/cuda-driver-api/group__CUDA__EVENT.html'],cases:[],gpu:[]};
const gpus=[];
try{
  if(nvrtc){
    result.nvrtc={path:nvrtc,sha256:sha(await readFile(nvrtc)),package:'nvidia-cuda-nvrtc-cu12==12.9.86'};
    for(const devices of ['0','1','0,1']){
      try{const gpu=await GPUWorker.create(devices,nvrtc);gpus.push({name:'gpu-'+devices,gpu});result.gpu.push({devices,startupMs:gpu.startupMs,...gpu.initialization});}
      catch(error){result.gpu.push({devices,error:String(error),available:false});}
    }
  }else result.gpu.push({available:false,error:'No --nvrtc supplied; GPU benchmarks omitted, not simulated'});
  for(const n of sizes){
    process.stderr.write(JSON.stringify({phase:'case',cells:n,at:new Date().toISOString()})+'\n');
    const generatedAt=performance.now();let tiles=makeTiles(n,51926);const generationMs=performance.now()-generatedAt;
    const topologyAt=performance.now(),neighbors=topology(tiles),coords=coordinates(tiles),topologyBuildMs=performance.now()-topologyAt;
    const workers=[],gpuSetup=[];
    const entry={cells:n,generationMs,topologyBuildMs,topologyBytes:neighbors.byteLength+coords.byteLength,stateBytes:n*FIELDS*8,workerStartup:[],gpuSetup,trials:[]};
    try{
      for(const count of [4,8]){const pool=await CPUWorkers.create(n,neighbors,count);workers.push({name:'cpu-workers-'+count,pool});entry.workerStartup.push({workers:count,startupMs:pool.startupMs});}
      for(const item of gpus)gpuSetup.push({name:item.name,...await item.gpu.setup(n,neighbors)});
      const kernel=new EcosystemKernel(),input=new Float64Array(n*FIELDS),output=new Float64Array(n*FIELDS);
      const modes=[{name:'cpu-soa'},...workers,...gpus];
      // First invocation is recorded separately; remaining rounds carry forward the same live state for every backend.
      for(let trial=0;trial<repetitions;trial++){
        const tick=(trial+1)*100,rain=trial%2===0,light=[1,0,0.4][trial%3],phase=light===1?'day':light===0?'night':'dawn';
        const started=performance.now(),expected=clone(tiles),cloned=performance.now();
        kernel.step(expected,tick,rain?'rain':'clear',phase);const finished=performance.now();
        const expectedState=pack(expected);
        entry.trials.push({trial,tick,rain,light,mode:'node-reference',cold:trial===0,totalMs:finished-started,cloneMs:cloned-started,computeMs:finished-cloned,different:0,maximumAbsoluteError:0});
        const order=[...modes.slice(trial%modes.length),...modes.slice(0,trial%modes.length)];
        for(const mode of order){
          const start=performance.now(),actual=clone(tiles),cloneEnd=performance.now();
          checkCoordinates(actual,coords);const indexEnd=performance.now();
          const sourceState=pack(actual,mode.pool?.input??input),packEnd=performance.now();
          let response;
          if(mode.pool)response=await mode.pool.step(tick,rain,light);
          else if(mode.gpu)response=await mode.gpu.step(sourceState,tick,rain,light);
          else{const computeStart=performance.now();stepArrays(sourceState,output,neighbors,n,tick,rain,light);response={data:output,phases:{computeMs:performance.now()-computeStart}};}
          const computed=performance.now();unpack(response.data,actual,tick);const end=performance.now();
          const fidelity=compare(expectedState,response.data);
          if(fidelity.different)throw new Error(`${mode.name} differs at ${n} cells: ${JSON.stringify(fidelity)}`);
          entry.trials.push({trial,tick,rain,light,mode:mode.name,cold:trial===0,totalMs:end-start,cloneMs:cloneEnd-start,coordinateCheckMs:indexEnd-cloneEnd,packMs:packEnd-indexEnd,computeAndTransferMs:computed-packEnd,unpackMs:end-computed,...fidelity,phases:response.phases});
        }
        tiles=expected;
      }
      entry.summary=Object.fromEntries(['node-reference',...modes.map(x=>x.name)].map(mode=>{
        const all=entry.trials.filter(x=>x.mode===mode),warm=all.filter(x=>!x.cold);
        return [mode,{coldInvocationMs:all[0].totalMs,warmTotalMs:summary(warm.map(x=>x.totalMs)),warmComputeAndTransferMs:summary(warm.map(x=>x.computeAndTransferMs??x.computeMs)),maxAbsoluteError:Math.max(...all.map(x=>x.maximumAbsoluteError)),differentValues:all.reduce((sum,x)=>sum+x.different,0)}];
      }));
      result.cases.push(entry);await writeFile(path.join(directory,'result.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
    }finally{for(const item of workers)await item.pool.close();}
  }
  result.completedAt=new Date().toISOString();result.hardwareAfter=await hardware();result.coreHashesAfter=await hashes();
  result.benchmarkHashesAfter=Object.fromEntries(await Promise.all(benchmarkFiles.map(async file=>[file,sha(await readFile(file))])));
  if(JSON.stringify(benchmarkHashes)!==JSON.stringify(result.benchmarkHashesAfter))throw new Error('Benchmark changed during run');
  result.coreUnchanged=JSON.stringify(initialHashes)===JSON.stringify(result.coreHashesAfter);
  if(!result.coreUnchanged)throw new Error('Core source changed during benchmark');
  result.ok=true;
}catch(error){result.ok=false;result.error=String(error);throw error;}
finally{
  for(const item of gpus)await item.gpu.close();
  await writeFile(path.join(directory,'result.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
}
process.stdout.write(JSON.stringify({ok:result.ok,result:path.join(directory,'result.json'),cases:result.cases.length})+'\n');
