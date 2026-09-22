import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {openSync,closeSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {verifyPlan,verifyEvidence,type Batch} from './default-seed-batch.js';
export async function runPilot(directory: string) {
const batch=JSON.parse(readFileSync(join(resolve(directory),'batch.json'),'utf8')) as Batch;
if (batch.directory !== resolve(directory)) throw new Error('Pilot manifest does not belong to this directory.');
const root=batch.sourceWorkspace;
const pilotHash=createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
if (pilotHash !== batch.pilotHash) throw new Error('Pilot differs from preparation.');
verifyPlan(batch);
// Adversarial contracts use a private manifest clone; no evidence/source files are changed.
for(const altered of [{...batch,days:24},{...batch,workers:3},{...batch,timeoutMs:7200001},{...batch,params:'persistencia.cadaTicks=100'},
 {...batch,effectiveParams:{...batch.effectiveParams as object,agua:{cuencas:.9}}},{...batch,paramsCaptureHash:'0'.repeat(64)},
 {...batch,jobs:batch.jobs.map(j=>({...j,seed:1007}))},{...batch,limits:{...batch.limits,maxArtifactBytes:65*1024**3}}]) assert.throws(()=>verifyPlan(altered));
const pilotRoot=join(directory,'pilot');mkdirSync(pilotRoot);
const pilotBatch={...batch,days:1,ticks:2400};
const results=await Promise.all(batch.jobs.map(async original=>{
 const job={...original,id:'pilot-'+original.id,output:join(pilotRoot,original.id),log:join(pilotRoot,original.id+'.log')};
 const fd=openSync(job.log,'wx'),start=performance.now();
 const child=spawn('nice',['-n','10',process.execPath,'--import',pathToFileURL(join(root,'node_modules/tsx/dist/loader.mjs')).href,
 join(batch.instrumentRoot,'scripts/lab/family-reserve.ts'),'--root',batch.sources[job.side].root,'--revision',batch.sources[job.side].originSha,
 '--seed',String(job.seed),'--days','1','--engine','world','--params',batch.params,'--output',job.output],
 {cwd:batch.sources[job.side].root,stdio:['ignore',fd,fd],detached:true,env:{...process.env,CARTA_DATA_DIR:job.output,TMPDIR:join(directory,'tmp')}});closeSync(fd);
 const result=await new Promise<{code:number|null,signal:string|null}>(resolve=>{const timer=setTimeout(()=>{if(child.pid)process.kill(-child.pid,'SIGKILL');},180000);child.on('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});});
 assert.equal(result.code,0,job.id+' failed');assert.equal(verifyEvidence(pilotBatch,job),undefined,job.id+' evidence invalid');
 const record=JSON.parse(readFileSync(join(job.output,'day-001.json'),'utf8'));
 assert.equal(record.tick,2400);assert.equal(record.reproductionPausedTicks,0);assert.equal(record.runtime,null);
 assert.equal(record.familyObservation.version,1);assert.ok(record.usefulActivityByRole.mortals);assert.ok(record.usefulActivityByRole.protected);
 const paramsModule=await import(pathToFileURL(join(batch.sources[job.side].root,'src/world/params.ts')).href);
 const {Store}=await import(pathToFileURL(join(batch.sources[job.side].root,'src/server/store.ts')).href);
 const store=new Store(join(job.output,'world.sqlite'),{readOnly:true});let checkpoint;
 try{const loaded=store.load();assert.ok(loaded);assert.equal(loaded.slot,0);assert.equal(loaded.world.tick,2400);assert.deepEqual(paramsModule.paramsOf(loaded.world),batch.effectiveParams);assert.equal(Number(store.db.prepare('SELECT COUNT(*) n FROM inputs').get().n),0);checkpoint={tick:loaded.world.tick,version:loaded.world.version,slot:loaded.slot,paramsEqual:true,inputs:0};}finally{store.close();}
 assert.match(verifyEvidence({...pilotBatch,effectiveParams:{bad:true}},job)??'',/persistence cadence/);
 return {job:job.id,code:result.code,durationMs:performance.now()-start,checkpoint,dailyMetrics:true,observedParamsEqual:true};
}));
verifyPlan(batch);
const summary={passed:true,pilotHash,at:new Date().toISOString(),batchHash:createHash('sha256').update(readFileSync(join(directory,'batch.json'))).digest('hex'),instrumentHash:batch.instrumentHash,protocolChecks:8,pilots:results};
writeFileSync(join(directory,'pilot.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
return summary;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory,...extra]=process.argv.slice(2);
  if (!directory || extra.length) { console.error('Usage: tsx scripts/lab/default-seed-pilot.ts batch-directory'); process.exitCode=1; }
  else void runPilot(directory).then(summary=>console.log(JSON.stringify(summary))).catch(error=>{console.error(String(error));process.exitCode=1;});
}
