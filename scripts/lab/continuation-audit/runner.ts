import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { atomicJson, below, completedCheckpoint, copyEvidence, driverHash, hash, logicalHash, readCheckpoint, readJson, storageCheck, validateDays, verifySources, type Json, type Manifest, type Original } from './common.js';
import { identities, runOwned } from './process.js';
import { activityStrata } from './strata.js';

const DRIVER=dirname(fileURLToPath(import.meta.url));
const WORKSPACE=resolve(DRIVER,'../../..');
const GIB=1024**3;

/** One census only. Raw unrelated argv/environment never enters the evidence. */
export function census(batch:Json,cutoffMs:number):Map<string,number[]> {
  const processes=identities(),direct=new Map<number,string[]>(),result=new Map<string,number[]>();
  for(const job of batch.jobs)result.set(job.id,[]);
  for(const p of processes) {
    if(['Z','X'].includes(p.state))continue;
    let args:string[];try{args=readFileSync(`/proc/${p.pid}/cmdline`,'utf8').split('\0');}catch{continue;}
    const outputIndex=args.indexOf('--output'),output=outputIndex<0?null:args[outputIndex+1];
    const job=batch.jobs.find((j:Json)=>j.output===output);
    if(job)direct.set(p.pid,[job.id]);
    else if(args.some(arg=>Object.values(batch.sources).some((source:any)=>arg===source.root)))direct.set(p.pid,batch.jobs.filter((j:Json)=>args.includes(batch.sources[j.side].root)).map((j:Json)=>j.id));
  }
  for(const p of processes) {
    let pid=p.pid;const seen=new Set<number>();
    while(pid&&!seen.has(pid)) {
      seen.add(pid);const matches=direct.get(pid);
      if(matches){for(const id of matches)result.get(id)!.push(p.pid);break;}
      pid=processes.find(candidate=>candidate.pid===pid)?.ppid??0;
    }
  }
  void cutoffMs;return result;
}

export function prepareManifest(batchPath:string,directory:string):Manifest {
  batchPath=resolve(batchPath);directory=resolve(directory);
  below(join(WORKSPACE,'artifacts'),directory);
  const batch=readJson(batchPath),cutoffMs=Date.now(),cutoff=new Date(cutoffMs).toISOString();
  if(batch.version!==1||batch.jobs.length!==64||batch.days!==30||batch.ticks!==72000||batch.engine!=='world'||batch.params!=='persistencia.cadaTicks=20'||batch.metricasVersion!==2)throw new Error('Unsupported original batch');
  verifySources(batch as Manifest);
  const active=census(batch,cutoffMs);
  mkdirSync(dirname(directory),{recursive:true,mode:0o700});mkdirSync(directory,{mode:0o700});
  for(const folder of ['driver','attempts','results','logs','tmp','original'])mkdirSync(join(directory,folder),{mode:0o700});
  for(const name of readdirSync(DRIVER).filter(n=>n.endsWith('.ts'))){copyFileSync(join(DRIVER,name),join(directory,'driver',name));chmodSync(join(directory,'driver',name),0o400);}
  const originals:Original[]=[];
  for(const job of batch.jobs) {
    if(!/^(baseline|candidate)-10(?:[0-2][0-9]|3[01])$/.test(job.id)||job.id!==`${job.side}-${job.seed}`||job.output!==join(batch.directory,'runs',job.id))throw new Error('Unexpected original job identity');
    const copied=join(directory,'original',job.id);mkdirSync(copied,{mode:0o700});
    const resultPath=join(batch.directory,'results',`${job.id}.json`),runPath=join(job.output,'run.json');
    const result=existsSync(resultPath)&&statSync(resultPath).mtimeMs<=cutoffMs?readJson(resultPath):null;
    const status=result?.status??((active.get(job.id)?.length??0)>0?'running':'unobserved');
    if(result)copyEvidence(resultPath,join(copied,'result.json'),hash(readFileSync(resultPath)));
    const row:Original={id:job.id,side:job.side,seed:job.seed,output:job.output,status,result,eligible:false,reason:'not-terminal-timeout',processes:[...new Set(active.get(job.id)??[])],daily:[],validComplete:false};
    try {
      const run=existsSync(runPath)&&statSync(runPath).mtimeMs<=cutoffMs?readJson(runPath):null;
      if(result&&(result.id!==job.id||result.side!==job.side||result.seed!==job.seed))throw new Error('Original result identity mismatch');
      if(!run||run.seed!==job.seed||run.engine!=='world'||run.days!==30||run.metricasVersion!==2||run.source!==batch.sources[job.side].sourceHash||run.sha!==batch.sources[job.side].originSha||run.instrumentHash!==batch.instrumentHash||run.params?.persistencia?.cadaTicks!==20||run.params?.persistencia?.ventanaEventosTicks!==0)throw new Error('Original run provenance missing or mismatched');
      copyEvidence(runPath,join(copied,'run.json'),hash(readFileSync(runPath)));
      for(let day=1;day<=30;day++) {
        const path=join(job.output,`day-${String(day).padStart(3,'0')}.json`);
        if(!existsSync(path)||statSync(path).mtimeMs>cutoffMs)continue;
        const digest=hash(readFileSync(path)),target=join(copied,`day-${String(day).padStart(3,'0')}.json`);copyEvidence(path,target,digest);row.daily.push({day,path:target,hash:digest});
      }
      if(row.processes.length){row.reason='writer-or-descendant-present';originals.push(row);continue;}
      if(!['timeout','success'].includes(status)){originals.push(row);continue;}
      const db=new DatabaseSync(join(job.output,'world.sqlite'),{readOnly:true});
      try {
        db.exec('BEGIN');row.checkpoint=readCheckpoint(db);
        if(row.checkpoint.savedAt>cutoffMs||row.checkpoint.seed!==row.seed||row.checkpoint.version!==(row.side==='baseline'?6:7)||row.checkpoint.tick>72000||row.checkpoint.tick%20)throw new Error('Checkpoint outside frozen cutoff or source rules');
        if(logicalHash(row.checkpoint.params)!==logicalHash(run.params))throw new Error('Original parameters disagree with checkpoint');
        const missing=validateDays(row.daily.map(d=>({day:d.day,record:readJson(d.path)})),row.checkpoint.tick);
        row.validComplete=status==='success'&&run.complete===true&&run.finalTick===72000&&row.checkpoint.tick===72000&&row.daily.length===30&&!missing.missingBoundary&&!existsSync(join(job.output,'failure.json'));
        row.eligible=status==='timeout';row.reason=row.eligible?'terminal-timeout-without-observed-writer':row.validComplete?'already-complete':'invalid-original-completion';
        if(row.validComplete){
          for(const day of row.daily)atomicJson(join(copied,`strata-${String(day.day).padStart(3,'0')}.json`),activityStrata(db,(day.day-1)*2400,day.day*2400));
          atomicJson(join(copied,'strata-total.json'),activityStrata(db,0,72000));
        }
        db.exec('COMMIT');
      }finally{db.close();}
    }catch(error){row.eligible=false;row.validComplete=false;row.reason=`admission-precheck: ${String(error)}`;}
    originals.push(row);
  }
  if(new Set(originals.map(j=>j.id)).size!==64)throw new Error('Duplicate original jobs');
  const manifest:Manifest={continuationSchema:1,metricasVersion:2,mode:'production',createdAt:new Date().toISOString(),cutoff,directory,
    originalBatch:batch.directory,originalManifestHash:hash(readFileSync(batchPath)),sources:batch.sources,instrumentRoot:batch.instrumentRoot,instrumentHash:batch.instrumentHash,
    driverHash:driverHash(join(directory,'driver')),loader:join(WORKSPACE,'node_modules/tsx/dist/loader.mjs'),workers:4,timeoutMs:21_600_000,horizon:72000,cadence:20,
    diskBudgetBytes:256*GIB,reserveBytes:64*GIB,originals,selected:originals.filter(j=>j.eligible).map(j=>j.id),
    scope:'Frozen stepWorld and Store every20; no governor/app, scheduler, clients or network. Original timeouts preserved. New-process timings never a comparative server gate.'};
  verifySources(manifest);storageCheck(manifest);
  writeFileSync(join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o400});
  writeFileSync(join(directory,'manifest.sha256'),hash(readFileSync(join(directory,'manifest.json')))+'\n',{flag:'wx',mode:0o400});
  return manifest;
}

export function validateManifest(manifest:Manifest,manifestPath:string):void {
  if(manifest.continuationSchema!==1||manifest.metricasVersion!==2||!['production','control'].includes(manifest.mode)||![1,2,3,4].includes(manifest.workers)||!Number.isSafeInteger(manifest.timeoutMs)||manifest.timeoutMs<1||manifest.timeoutMs>21_600_000||manifest.cadence!==20
    ||!Number.isSafeInteger(manifest.horizon)||manifest.horizon%2400||manifest.horizon<2400||manifest.horizon>72000
    ||!Number.isSafeInteger(manifest.diskBudgetBytes)||manifest.diskBudgetBytes<1||manifest.diskBudgetBytes>256*GIB||!Number.isSafeInteger(manifest.reserveBytes)||manifest.reserveBytes<0)throw new Error('Invalid continuation contract');
  if(manifest.mode==='production'&&(manifest.horizon!==72000||manifest.timeoutMs!==21_600_000||manifest.workers!==4||manifest.originals.length!==64))throw new Error('Production contract changed');
  if(hash(readFileSync(manifestPath))!==readFileSync(join(manifest.directory,'manifest.sha256'),'utf8').trim()||driverHash(DRIVER)!==manifest.driverHash)throw new Error('Manifest or frozen driver changed');
  const selected=new Set(manifest.selected);if(selected.size!==manifest.selected.length)throw new Error('Duplicate selected jobs');
  for(const job of manifest.originals){
    if(!/^(baseline|candidate)-\d+$/.test(job.id)||job.id!==`${job.side}-${job.seed}`)throw new Error('Invalid attempt identity');
    if(selected.has(job.id)&&(!job.eligible||job.processes.length||!job.checkpoint||manifest.mode==='production'&&job.status!=='timeout'))throw new Error('Selected job was not terminal and eligible');
  }
  if(manifest.selected.some(id=>!manifest.originals.some(job=>job.id===id)))throw new Error('Unknown selected job');
  verifySources(manifest);
}

export function comparison(manifest:Manifest):Json {
  const statuses:Json={},physical=new Map<string,Map<number,Json>>(),strata=new Map<string,Map<number,Json>>();
  for(const job of manifest.originals){
    const days=new Map<number,Json>(),groups=new Map<number,Json>();
    for(const day of job.daily){if(hash(readFileSync(day.path))!==day.hash)throw new Error('Frozen historical diary changed');days.set(day.day,readJson(day.path));const p=join(manifest.directory,'original',job.id,`strata-${String(day.day).padStart(3,'0')}.json`);if(existsSync(p))groups.set(day.day,readJson(p));}
    const output=join(manifest.directory,'attempts',job.id),resultPath=join(manifest.directory,'results',`${job.id}.json`),result=existsSync(resultPath)?readJson(resultPath):null;
    if(existsSync(join(output,'days')))for(const file of readdirSync(join(output,'days')).filter(f=>/^day-\d{3}\.json$/.test(f))){const d=readJson(join(output,'days',file));days.set(d.day,d);}
    if(existsSync(join(output,'strata')))for(const file of readdirSync(join(output,'strata')).filter(f=>/^day-\d{3}\.json$/.test(f))){const d=Number(file.slice(4,7));groups.set(d,readJson(join(output,'strata',file)));}
    physical.set(job.id,days);strata.set(job.id,groups);statuses[job.id]={original:job.status,continuation:result?.status??(manifest.selected.includes(job.id)?'pending':'not-selected'),complete30d:job.validComplete||result?.status==='completed_via_checkpoint'};
  }
  const horizons=[];
  for(let day=1;day<=manifest.horizon/2400;day++){
    const pairs=[],missing=[];
    for(const seed of [...new Set(manifest.originals.map(j=>j.seed))].sort((a,b)=>a-b)){
      const baseline=physical.get(`baseline-${seed}`)?.get(day),candidate=physical.get(`candidate-${seed}`)?.get(day);
      if(!baseline||!candidate){missing.push(seed);continue;}
      if(day===manifest.horizon/2400&&(!statuses[`baseline-${seed}`]?.complete30d||!statuses[`candidate-${seed}`]?.complete30d)){missing.push(seed);continue;}
      for(const record of [baseline,candidate])if(record.day!==day||record.tick!==day*2400||record.activity?.ventanaActividad?.desdeTickExclusivo!==(day-1)*2400||record.activity?.ventanaActividad?.hastaTickInclusivo!==day*2400)throw new Error('Invalid paired daily interval');
      const bg=strata.get(`baseline-${seed}`)?.get(day),cg=strata.get(`candidate-${seed}`)?.get(day);
      pairs.push({seed,baseline:{mortals:baseline.activity.vecinosMortales,births:baseline.births,usesByActor:bg?.byActor??null},candidate:{mortals:candidate.activity.vecinosMortales,births:candidate.births,usesByActor:cg?.byActor??null},activityStrataComparable:!!bg&&!!cg});
    }
    horizons.push({day,tick:day*2400,matchedPairs:pairs.length,missingSeeds:missing,pairs});
  }
  return {continuationSchema:1,cutoff:manifest.cutoff,statuses,horizons,limits:'Only symmetric paired horizons are compared. Incomplete or absent observations remain censored; completed-only cohorts may select extinct/faster worlds. Unknown actor strata stay null. No timings are compared.'};
}

export async function runManifest(manifest:Manifest,manifestPath:string):Promise<void> {
  validateManifest(manifest,manifestPath);
  writeFileSync(join(manifest.directory,'started.json'),JSON.stringify({at:new Date().toISOString(),pid:process.pid,manifestHash:hash(readFileSync(manifestPath))},null,2),{flag:'wx',mode:0o600});
  let cursor=0,stopping=false;const active=new Map<string,AbortController>(),completed:Json[]=[];
  const stop=()=>{stopping=true;for(const controller of active.values())controller.abort();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
  const progress=()=>atomicJson(join(manifest.directory,'progress.json'),{at:new Date().toISOString(),state:stopping?'stopping':'running',completed:completed.length,running:[...active.keys()],queued:manifest.selected.length-cursor,counts:Object.fromEntries([...new Set(completed.map(r=>r.status))].map(status=>[status,completed.filter(r=>r.status===status).length]))});
  async function launch(id:string):Promise<void>{
    const job=manifest.originals.find(j=>j.id===id)!,controller=new AbortController();active.set(id,controller);let fd:number|undefined;
    let result:Json;
    try{
      fd=openSync(join(manifest.directory,'logs',`${id}.log`),'wx',0o600);
      const outcome=await runOwned(process.execPath,['--import',pathToFileURL(manifest.loader).href,join(manifest.directory,'driver','worker.ts'),manifestPath,id],{
        cwd:manifest.directory,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',TZ:'UTC',TMPDIR:join(manifest.directory,'tmp'),CARTA_DATA_DIR:join(manifest.directory,'attempts',id)},logFd:fd,timeoutMs:manifest.timeoutMs,signal:controller.signal,
        onSpawn:pid=>{atomicJson(join(manifest.directory,'results',`${id}.running.json`),{pid,id,startedAt:new Date().toISOString(),deadlineMs:manifest.timeoutMs});progress();}});
      const attemptPath=join(manifest.directory,'attempts',id,'attempt.json'),attempt=existsSync(attemptPath)?readJson(attemptPath):null;
      let status=!outcome.groupClear?'group_cleanup_error':outcome.timedOut?'timeout':outcome.interrupted?'interrupted':outcome.error?'spawn_or_group_error':outcome.descendantsFound?'descendant_leak':outcome.code!==0?(attempt?.state==='admission_error'?'admission_error':'error'):'invalid-evidence';
      if(!outcome.groupClear)stop();
      if(status==='invalid-evidence'&&attempt?.complete===true&&attempt.finalTick===manifest.horizon&&attempt.lastCompletedDay===manifest.horizon/2400){
        const all=job.daily.map(d=>({day:d.day,record:readJson(d.path)}));for(const file of readdirSync(join(manifest.directory,'attempts',id,'days'))){const record=readJson(join(manifest.directory,'attempts',id,'days',file));all.push({day:record.day,record});}
        if(validateDays(all,manifest.horizon).missingBoundary)throw new Error('Final daily record missing');
        status='completed_via_checkpoint';
      }
      const progressPath=join(manifest.directory,'attempts',id,'progress.json'),lastProgress=existsSync(progressPath)?readJson(progressPath):null;
      let durableTick:number|null=null,checkpointError:string|undefined;
      const database=join(manifest.directory,'attempts',id,'world.sqlite');
      if(outcome.groupClear&&existsSync(database))try{const db=new DatabaseSync(database,{readOnly:true});try{durableTick=(status==='completed_via_checkpoint'?completedCheckpoint(db,job.checkpoint!,manifest.horizon):readCheckpoint(db)).tick;}finally{db.close();}}catch(error){checkpointError=String(error);}
      if(status==='completed_via_checkpoint'&&(checkpointError||durableTick!==manifest.horizon))status='invalid-final-checkpoint';
      result={id,side:job.side,seed:job.seed,status,originalStatus:job.status,...outcome,attemptState:attempt?.state??null,durableTick,checkpointError,
        message:attempt?.message,lastCompletedDay:lastProgress?.lastCompletedDay??attempt?.lastCompletedDay??job.daily.length,finishedAt:new Date().toISOString()};
    }catch(error){result={id,status:'runner_error',message:String(error)};stop();}
    finally{if(fd!==undefined)closeSync(fd);active.delete(id);}
    atomicJson(join(manifest.directory,'results',`${id}.json`),result);completed.push(result);progress();
  }
  try{
    const workers=Array.from({length:manifest.workers},async()=>{while(!stopping&&cursor<manifest.selected.length){
      try{storageCheck(manifest);}catch(error){stopping=true;atomicJson(join(manifest.directory,'budget-stop.json'),{message:String(error)});break;}
      const id=manifest.selected[cursor++]!;await launch(id);
    }});
    try{await Promise.all(workers);}catch(error){stop();await Promise.allSettled(workers);throw error;}
    for(const id of manifest.selected.slice(cursor))atomicJson(join(manifest.directory,'results',`${id}.json`),{id,status:'not-started',reason:'runner stopped before launch'});
    atomicJson(join(manifest.directory,'comparison.json'),comparison(manifest));
    atomicJson(join(manifest.directory,'finished.json'),{at:new Date().toISOString(),pid:process.pid,selected:manifest.selected.length,terminal:completed.length,interrupted:stopping});
    atomicJson(join(manifest.directory,'progress.json'),{at:new Date().toISOString(),state:'finished',completed:completed.length,running:[],queued:0,notStarted:manifest.selected.length-cursor,
      counts:Object.fromEntries([...new Set(completed.map(r=>r.status))].map(status=>[status,completed.filter(r=>r.status===status).length]))});
    if(completed.length!==manifest.selected.length||completed.some(result=>result.status!=='completed_via_checkpoint'))process.exitCode=1;
  }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const command=process.argv[2];
  if(command==='prepare'){const m=prepareManifest(process.argv[3]!,process.argv[4]!);console.log(JSON.stringify({directory:m.directory,selected:m.selected.length,cutoff:m.cutoff}));}
  else if(command==='run'){const path=resolve(process.argv[3]!);await runManifest(readJson(path) as Manifest,path);}
  else if(command==='summarize'){const m=readJson(process.argv[3]!) as Manifest;atomicJson(join(m.directory,'comparison.json'),comparison(m));}
  else throw new Error('Usage: runner.ts prepare <original batch.json> <new artifact directory> | run <manifest.json> | summarize <manifest.json>');
}
