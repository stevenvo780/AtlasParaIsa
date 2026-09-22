import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { activityStrata } from './strata.js';
import { atomicJson, copyCheckpoint, exactLoaded, hash, logicalHash, nextWindow, readJson, storageCheck, validateDays, verifySources, type Json, type Manifest, type Original } from './common.js';

export async function continueJob(manifest:Manifest,job:Original):Promise<Json> {
  if(!job.eligible||!job.checkpoint||manifest.mode==='production'&&job.status!=='timeout')throw new Error('Only admitted terminal timeouts may continue');
  const dir=join(manifest.directory,'attempts',job.id);mkdirSync(dir,{mode:0o700});mkdirSync(join(dir,'days'),{mode:0o700});mkdirSync(join(dir,'strata'),{mode:0o700});
  const meta:Json={continuationSchema:1,metricasVersion:2,id:job.id,seed:job.seed,side:job.side,startedAt:new Date().toISOString(),originalStatus:job.status,
    originalCheckpoint:job.checkpoint,originalBatch:manifest.originalBatch,source:manifest.sources[job.side],instrumentHash:manifest.instrumentHash,driverHash:manifest.driverHash,
    targetTick:manifest.horizon,timingsHistorical:'unknown',scope:manifest.scope,state:'admitting',complete:false};
  atomicJson(join(dir,'attempt.json'),meta);
  let store:any,world:any,lastCompletedDay=job.daily.length;
  try {
    verifySources(manifest);const source=manifest.sources[job.side],expected=job.checkpoint;
    if(expected.seed!==job.seed||expected.tick>manifest.horizon||expected.tick%20!==0||manifest.mode==='production'&&expected.version!==(job.side==='baseline'?6:7))throw new Error('Unexpected checkpoint rules, seed, cadence or horizon');
    const input=join(job.output,'world.sqlite'),sourceBytes=statSync(input).size+(existsSync(`${input}-wal`)?statSync(`${input}-wal`).size:0);
    storageCheck(manifest,sourceBytes*2);
    meta.checkpointFileHash=copyCheckpoint(input,join(dir,'checkpoint.sqlite'),expected);
    const imp=async(path:string)=>import(pathToFileURL(join(source.root,path)).href);
    const [api,storage,parameters,snapshot,family,diversity,metrics]=await Promise.all([imp('src/world/index.ts'),imp('src/server/store.ts'),imp('src/world/params.ts'),imp('src/server/snapshot.ts'),imp('src/world/family.ts'),imp('src/world/diversidad.ts'),import(pathToFileURL(join(manifest.instrumentRoot,'scripts/lab/metrics.ts')).href)]);
    if(api.RULES_VERSION!==expected.version||api.TICKS_PER_DAY!==2400)throw new Error('Frozen engine would migrate the checkpoint');
    const working=join(dir,'world.sqlite');copyFileSync(join(dir,'checkpoint.sqlite'),working);chmodSync(working,0o600);store=new storage.Store(working);
    const before=snapshot.decodeSnapshot(store.db.prepare('SELECT body FROM snapshots WHERE slot=0').get().body),params=snapshot.takeSnapshotParams(before);
    if(params.persistencia.cadaTicks!==20||params.persistencia.ventanaEventosTicks!==0)throw new Error('Unsupported persistence parameters');
    const loaded=store.load();exactLoaded(loaded,expected,before,params,loaded?parameters.paramsOf(loaded.world):null);world=loaded.world;
    if(!world.reproductionEnabled)throw new Error('Governor-free prefix is not certified');
    const days=job.daily.map(d=>({day:d.day,record:readJson(d.path)}));
    for(const d of job.daily)if(hash(readFileSync(d.path))!==d.hash)throw new Error('Frozen historical diary changed');
    const missing=validateDays(days,world.tick).missingBoundary;
    meta.params=params;meta.admission={slot:loaded.slot,skipped:loaded.skipped,residentHash:logicalHash({world,params}),copyHash:meta.checkpointFileHash};
    meta.state='running';atomicJson(join(dir,'attempt.json'),meta);
    // Keep original daily bytes in their frozen evidence directory; derived strata
    // use a complete historical roster and never change those original records.
    for(const day of days)atomicJson(join(dir,'strata',`day-${String(day.day).padStart(3,'0')}.json`),activityStrata(store.db,(day.day-1)*2400,day.day*2400));
    function record(day:number,fromTick:number,times:number[],saves:number[],reconstructed=false):void {
      const after=(day-1)*2400;
      if(world.tick!==day*2400||world.tick>manifest.horizon)throw new Error('Invalid absolute daily endpoint');
      api.assertWorld(world);
      const sorted=(xs:number[],p:number)=>[...xs].sort((a,b)=>a-b)[Math.min(xs.length-1,Math.floor(xs.length*p))]??null;
      const coverage=fromTick===after&&!reconstructed?'complete-new-process':'partial-or-reconstructed';
      const entry=structuredClone({day,tick:world.tick,population:world.people.length,births:world.totals.births,deaths:world.demographyDynamics,reproductionPausedTicks:0,
        neighborsReady:world.people.filter((p:any)=>family.reproductiveReadiness(world,p)).length,totals:world.totals,diversity:diversity.indiceDiversidad(world),activity:metrics.durableActivityMetrics(world,store.db,after),runtime:null,
        p50StepMs:null,p95StepMs:null,maxStepMs:null,p95SaveMs:null,rss:null,
        continuation:{attempt:job.id,fromCheckpointTick:expected.tick,timingCoverage:coverage,historicalTiming:'unknown'},
        operational:coverage==='complete-new-process'?{scope:'new attempt only; not comparable to original concurrent timings',p50StepMs:sorted(times,.5),p95StepMs:sorted(times,.95),maxStepMs:times.length?Math.max(...times):null,p95SaveMs:sorted(saves,.95),rss:process.memoryUsage().rss}:null});
      atomicJson(join(dir,'days',`day-${String(day).padStart(3,'0')}.json`),entry);
      atomicJson(join(dir,'strata',`day-${String(day).padStart(3,'0')}.json`),activityStrata(store.db,after,world.tick));
      lastCompletedDay=day;atomicJson(join(dir,'progress.json'),{tick:world.tick,lastCompletedDay:day,mortals:entry.activity.vecinosMortales});
      console.log(JSON.stringify({id:job.id,day,tick:world.tick,mortals:entry.activity.vecinosMortales,timingCoverage:coverage}));
    }
    if(missing)record(world.tick/2400,world.tick,[],[],true);
    while(world.tick<manifest.horizon) {
      storageCheck(manifest);const window=nextWindow(world.tick,manifest.horizon),from=world.tick,times:number[]=[],saves:number[]=[];
      if(window.steps>2400)throw new Error('Daily step budget exceeded');
      while(world.tick<window.end) {
        const started=performance.now();api.stepWorld(world);
        if(!world.reproductionEnabled)throw new Error('Unexpected governor state');
        if(world.tick%20===0){const at=performance.now();store.save(world);saves.push(performance.now()-at);}
        times.push(performance.now()-started);
      }
      record(window.day,from,times,saves);
    }
    store.save(world);verifySources(manifest);
    if(hash(readFileSync(join(dir,'checkpoint.sqlite')))!==meta.checkpointFileHash)throw new Error('Immutable checkpoint copy changed');
    atomicJson(join(dir,'strata-total.json'),activityStrata(store.db,0,world.tick));
    if(lastCompletedDay!==manifest.horizon/2400)throw new Error('Incomplete daily coverage');
    Object.assign(meta,{state:'completed_via_checkpoint',complete:true,finalTick:world.tick,lastCompletedDay,finishedAt:new Date().toISOString()});
    atomicJson(join(dir,'attempt.json'),meta);return meta;
  }catch(error){Object.assign(meta,{state:meta.state==='admitting'?'admission_error':'error',message:String(error),lastTick:world?.tick??null,lastCompletedDay,finishedAt:new Date().toISOString()});atomicJson(join(dir,'attempt.json'),meta);throw error;}
  finally{store?.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const manifest=readJson(process.argv[2]!) as Manifest,job=manifest.originals.find(j=>j.id===process.argv[3]);
  if(!job||!manifest.selected.includes(job.id))throw new Error('Job not selected by the immutable manifest');
  await continueJob(manifest,job);
}
