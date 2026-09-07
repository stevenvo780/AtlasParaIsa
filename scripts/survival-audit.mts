import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { World, Person, assertWorld as AssertWorld } from '../src/world/index.js';
import type { ChronicleEvent } from '../src/shared/types.js';
import type { demographicTraits as TraitsOf } from '../src/world/demography.js';
import type { reproductiveReadiness as Ready, familyOpportunity as Family } from '../src/world/family.js';
import {mkdirSync,writeFileSync,readFileSync,openSync,writeSync,closeSync,fsyncSync,createReadStream,readdirSync,lstatSync,readSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {setImmediate as yieldEventLoop} from 'node:timers/promises';
export function auditStep(previous:number,counter:number,events:Pick<ChronicleEvent, 'id'|'tick'>[],tick:number){
 assert.ok(Number.isSafeInteger(previous)&&previous>=0&&Number.isSafeInteger(counter)&&counter>=previous,'EVENT_COUNTER_INVALID');
 assert.ok(Number.isSafeInteger(tick)&&tick>=0,'EVENT_TICK_INVALID');
 const fresh=events.filter(e=>{assert.match(e.id,/^e[1-9]\d*$/,'NON_SERIAL_EVENT');return Number(e.id.slice(1))>previous;});
 assert.equal(fresh.length,counter-previous,`EVENT_GAP_AT_TICK_${tick}`);
 return fresh.map((e,i)=>{assert.equal(e.id,`e${previous+i+1}`,'EVENT_ORDER_OR_DUPLICATE');assert.equal(e.tick,tick,'EVENT_TICK_MISMATCH');return {id:e.id,tick:e.tick,digest:createHash('sha256').update(JSON.stringify(e)).digest('hex')};});
}
export async function reconcileChronicle(db:DatabaseSync,path:string,counter:number,target:number){
 const lookup=db.prepare('SELECT tick,body FROM events WHERE id=?');let serial=0,tick=0;
 for await(const line of createInterface({input:createReadStream(path),crlfDelay:Infinity})){
  const row=JSON.parse(line);assert.equal(row.tick,tick++,'AUDIT_STEP_GAP');assert.equal(row.first,serial+1);assert.equal(row.count,row.events.length);
  for(const e of row.events){assert.equal(e.id,`e${++serial}`);assert.equal(e.tick,row.tick);const stored=lookup.get(e.id);assert.ok(stored&&typeof stored.body==='string',`SQLITE_MISSING_EVENT_${serial}`);assert.equal(stored.tick,e.tick);assert.equal(createHash('sha256').update(stored.body).digest('hex'),e.digest,'SQLITE_EVENT_BODY_MISMATCH');}
  assert.equal(row.last,serial);
 }
 assert.equal(tick,target+1);assert.equal(serial,counter);assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n),counter,'SQLITE_EXTRA_OR_MISSING_EVENTS');
 return {complete:true,steps:target,records:serial,sqliteExact:true};
}
export function fileDigest(path:string){const h=createHash('sha256'),fd=openSync(path,'r'),buffer=Buffer.allocUnsafe(65536);try{let n;while((n=readSync(fd,buffer,0,buffer.length,null))>0)h.update(buffer.subarray(0,n));return h.digest('hex');}finally{closeSync(fd);}}
export function sourceFiles(source:string){const paths=execFileSync('git',['ls-files','-z','src/world','src/shared','src/server','package.json','package-lock.json','tsconfig.json','tsconfig.server.json'],{cwd:source,encoding:'utf8'}).split('\0').filter(Boolean);return Object.fromEntries(paths.map(p=>[p,createHash('sha256').update(readFileSync(`${source}/${p}`)).digest('hex')]));}
export interface ExperimentConfig {source:string;seed:number;target:number;dir:string;saveEvery:'auto'|1|120;restartAt:number;sampleEvery:number;checkpointEvery:number;maxSnapshots:number;maxDiskMiB:number;maxWallSeconds:number;}
export function parseConfig(args:string[]):ExperimentConfig {
 const [source,seedText,targetText,dir,...options]=args;
 const config:ExperimentConfig={source,seed:Number(seedText),target:Number(targetText),dir,saveEvery:'auto',restartAt:30000,sampleEvery:120,checkpointEvery:12000,maxSnapshots:16,maxDiskMiB:8192,maxWallSeconds:21600};
 const names:Record<string,'restartAt'|'sampleEvery'|'checkpointEvery'|'maxSnapshots'|'maxDiskMiB'|'maxWallSeconds'>={'restart-at':'restartAt','sample-every':'sampleEvery','checkpoint-every':'checkpointEvery','max-snapshots':'maxSnapshots','max-disk-mib':'maxDiskMiB','max-wall-seconds':'maxWallSeconds'};
 for(const option of options){const match=/^--([a-z-]+)=(.+)$/.exec(option);assert.ok(match,'Unsupported option');const [,name,value]=match;
  if(name==='save-every'){assert.ok(['auto','1','120'].includes(value));config.saveEvery=value==='auto'?'auto':Number(value) as 1|120;}
  else{const key=names[name];assert.ok(key&&/^\d+$/.test(value),'Unsupported option');config[key]=Number(value);}}
 assert.ok(source&&dir&&Number.isSafeInteger(config.seed)&&config.seed>=0&&config.seed<=0xffffffff&&Number.isSafeInteger(config.target)&&config.target>0,'Invalid experiment arguments');
 for(const key of ['restartAt','sampleEvery','maxDiskMiB','maxWallSeconds'] as const)assert.ok(Number.isSafeInteger(config[key])&&config[key]>0,`Invalid ${key}`);
 for(const key of ['checkpointEvery','maxSnapshots'] as const)assert.ok(Number.isSafeInteger(config[key])&&config[key]>=0,`Invalid ${key}`);
 assert.ok(config.restartAt<config.target&&Math.ceil(config.target/config.sampleEvery)<=4096,'Restart or sample quota invalid');return {...config,source:resolve(source),dir:resolve(dir)};
}
export function bodySummary(people:Person[]){
 const out={count:people.length} as {count:number}&Record<'hunger'|'thirst'|'energy'|'fatigue'|'health'|'vitality'|'age'|'food'|'wood'|'stone'|'waterQuanta',{mean:number|null;min:number|null;max:number|null}>;for(const key of ['hunger','thirst','energy','fatigue','health','vitality','age','food','wood','stone','waterQuanta'] as const){
  const values=people.map(p=>key==='food'?p.inventory:key==='wood'||key==='stone'?p.materials[key]:key==='waterQuanta'?p.technology.items.reduce((n,i)=>n+(i.contents?.water??0),0):(key==='health'||key==='vitality'||key==='age')?p.demography[key]:p[key]);
  out[key]={mean:values.length?values.reduce((a,b)=>a+b,0)/values.length:null,min:values.length?Math.min(...values):null,max:values.length?Math.max(...values):null};
 }return out;
}
export function reproductiveObservation(world:World,traitsOf:typeof TraitsOf,ready:typeof Ready,family:typeof Family){
 const people=world.people.filter((p)=>p.role==='neighbor'),dist=(a:{x:number;y:number},b:{x:number;y:number})=>Math.hypot(a.x-b.x,a.y-b.y);
 const readiness=new Map(people.map((p)=>[p.id,ready(world,p)]));
 const out={stage:'post-step, after possible birth and its paid costs',enabled:world.reproductionEnabled,capacityAvailable:world.people.length<32,birthBoundary:world.tick%120===0,neighbors:people.length,age:{immature:0,eligibleAge:0,senescent:0},cooldownReady:0,ready:0,readyWithBirthFood:0,familyOpportunityActors:0,familyActions:{} as Record<string,number>,partnerFunnel:{other:0,sameCommunity:0,within7:0,mutuallyTrusted:0,partnerReady:0,visiblePlace:0},postStepBirthOrderedPairs:0};
 for(const p of people){const traits=traitsOf(p.genome);out.age[p.demography.age<traits.maturityAge?'immature':p.demography.age<traits.senescenceStart?'eligibleAge':'senescent']++;if(world.tick-p.lastBirth>=traits.fertilityCooldown)out.cooldownReady++;
  if(readiness.get(p.id)){out.ready++;if(p.inventory>=.1)out.readyWithBirthFood++;}
  if(family(world,p)){out.familyOpportunityActors++;out.familyActions[p.action]=(out.familyActions[p.action]??0)+1;}
  let partners=people.filter((q)=>q.id!==p.id);out.partnerFunnel.other+=partners.length;
  partners=partners.filter((q)=>p.communityId&&q.communityId===p.communityId);out.partnerFunnel.sameCommunity+=partners.length;
  partners=partners.filter((q)=>dist(p,q)<=7);out.partnerFunnel.within7+=partners.length;
  partners=partners.filter((q)=>(p.bonds[q.id]??0)>=.3&&(q.bonds[p.id]??0)>=.3);out.partnerFunnel.mutuallyTrusted+=partners.length;
  partners=partners.filter((q)=>readiness.get(q.id));out.partnerFunnel.partnerReady+=partners.length;
  partners=partners.filter((q)=>world.places.some((place)=>dist(p,place)<=7&&(dist(p,place)<=4||dist(q,place)<=4)));out.partnerFunnel.visiblePlace+=partners.length;
  if(readiness.get(p.id)&&p.inventory>=.1)out.postStepBirthOrderedPairs+=partners.filter((q)=>q.inventory>=.1&&dist(p,q)<=3&&world.places.some((place)=>dist(p,place)<=4)).length;
 }return out;
}
function directoryBytes(path:string):number {let n=0;for(const name of readdirSync(path)){const p=`${path}/${name}`,st=lstatSync(p);assert.ok(!st.isSymbolicLink(),'Output symlink is not permitted');n+=st.isDirectory()?directoryBytes(p):st.size;}return n;}
export async function runExperiment(config:ExperimentConfig){
 const {source,seed,target,dir,restartAt,sampleEvery}=config;
 let saveEvery=1;
 const fingerprints=sourceFiles(source),runnerPath=fileURLToPath(import.meta.url),runnerSha256=createHash('sha256').update(readFileSync(runnerPath)).digest('hex');
const worldModule=await import(pathToFileURL(`${source}/src/world/index.ts`).href) as typeof import('../src/world/index.js');
const {createWorld,stepWorld}=worldModule;const assertWorld:typeof AssertWorld=worldModule.assertWorld;
const {tileAt}=await import(pathToFileURL(`${source}/src/world/spatial.ts`).href) as typeof import('../src/world/spatial.js');
const {waterAvailable}=await import(pathToFileURL(`${source}/src/world/inventions.ts`).href) as typeof import('../src/world/inventions.js');
const {demographicTraits}=await import(pathToFileURL(`${source}/src/world/demography.ts`).href) as typeof import('../src/world/demography.js');
const {reproductiveReadiness,familyOpportunity}=await import(pathToFileURL(`${source}/src/world/family.ts`).href) as typeof import('../src/world/family.js');
const {Store}=await import(pathToFileURL(`${source}/src/server/store.ts`).href) as typeof import('../src/server/store.js');
const sha=execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim(),indexHash=createHash('sha256').update(readFileSync(`${source}/src/world/index.ts`)).digest('hex');
mkdirSync(dir,{mode:0o700});
let world=createWorld(seed);
saveEvery=config.saveEvery==='auto'?(world.chronicleJournal?120:1):config.saveEvery;
assert.ok(restartAt%saveEvery===0&&sampleEvery%saveEvery===0&&(!config.checkpointEvery||config.checkpointEvery%saveEvery===0),'Cadences must align with saved checkpoints');
let store=new Store(`${dir}/world.sqlite`);
const timing={stepMs:0,saveMs:0,loadMs:0,observationMs:0,backupMs:0,saves:0},auditPath=`${dir}/event-audit.jsonl`,auditFd=openSync(auditPath,'wx',0o600);
let auditedCounter=0,maxEventsPerStep=0,auditedSteps=0,verifiedCounter=0,durableCounter=0,durableTick=0;
let auditPending:ReturnType<typeof auditStep>=[];let stopping=false;const stop=()=>{stopping=true;};process.on('SIGTERM',stop);process.on('SIGINT',stop);
const snapshots:{tick:number;observedAt:number;reasons:string[];file:string;bytes:number;sha256:string;snapshotDigest:string;validatedLoad:boolean;eventCounter:number}[]=[],snapshotOmissions:{reason:string;observedAt:number;durableTick:number;why:string}[]=[],riskSeen=new Set<string>();
const startedWall=performance.now();const checkQuota=()=>{assert.ok(!stopping,'OWNED_PROCESS_STOP_REQUESTED');assert.ok(performance.now()-startedWall<=config.maxWallSeconds*1000,'WALL_TIME_QUOTA');assert.ok(directoryBytes(dir)<=config.maxDiskMiB*1024*1024,'DISK_QUOTA');};
const observe=()=>{const started=performance.now(),records=auditStep(auditedCounter,world.eventCounter,world.chronicleJournal?.pending??world.events,world.tick);auditPending.push(...records);assert.ok(auditPending.length<=65536,'AUDIT_PENDING_QUOTA');writeSync(auditFd,JSON.stringify({tick:world.tick,first:auditedCounter+1,last:world.eventCounter,count:records.length,events:records})+'\n');auditedCounter=world.eventCounter;if(world.tick>0){auditedSteps++;maxEventsPerStep=Math.max(maxEventsPerStep,records.length);}timing.observationMs+=performance.now()-started;};
const save=()=>{const started=performance.now();store.save(world);durableTick=world.tick;durableCounter=world.eventCounter;const lookup=store.db.prepare('SELECT tick,body FROM events WHERE id=?');for(const e of auditPending){assert.equal(e.id,`e${verifiedCounter+1}`);const row=lookup.get(e.id);assert.ok(row&&typeof row.body==='string',`SQLITE_MISSING_EVENT_${verifiedCounter}`);assert.equal(row.tick,e.tick);assert.equal(createHash('sha256').update(row.body).digest('hex'),e.digest,'COMMITTED_EVENT_CHANGED');verifiedCounter++;}assert.equal(verifiedCounter,world.eventCounter);auditPending=[];timing.saveMs+=performance.now()-started;timing.saves++;};
const load=()=>{const started=performance.now();store.db.exec('BEGIN');try{store.technologyArchive.beginHostTransaction();const loaded=store.load()!.world;store.db.exec('COMMIT');store.technologyArchive.acknowledgeHostCommit();return loaded;}catch(error){if(store.db.isTransaction)store.db.exec('ROLLBACK');store.technologyArchive.invalidateVerification();throw error;}finally{timing.loadMs+=performance.now()-started;}};
const checkpoint=(reason:string,observedAt=world.tick)=>{
 const previous=snapshots.find(s=>s.tick===durableTick);if(previous){if(!previous.reasons.includes(reason))previous.reasons.push(reason);return;}
 if(snapshots.length>=config.maxSnapshots){snapshotOmissions.push({reason,observedAt,durableTick,why:'snapshot-count-quota'});return;}
 checkQuota();const started=performance.now(),path=`${dir}/checkpoint-${durableTick}.sqlite`;
 const expectedBytes=Number(store.db.prepare('PRAGMA page_count').get()!.page_count)*Number(store.db.prepare('PRAGMA page_size').get()!.page_size);assert.ok(directoryBytes(dir)+expectedBytes<=config.maxDiskMiB*1024*1024,'DISK_QUOTA_BEFORE_BACKUP');
 const original=store.db.prepare('SELECT body,digest,saved_at FROM snapshots WHERE slot=0').get()!;store.backup(path);
 const copy=new Store(path,{readOnly:true});let loaded:World;
 try{copy.db.exec('BEGIN');copy.technologyArchive.beginHostTransaction();assert.deepEqual(copy.db.prepare('SELECT body,digest,saved_at FROM snapshots WHERE slot=0').get(),original);loaded=copy.load()!.world;assert.equal(loaded.tick,durableTick);assert.equal(loaded.eventCounter,verifiedCounter);assert.equal(Number(copy.db.prepare('SELECT COUNT(*) n FROM events').get()!.n),verifiedCounter);copy.db.exec('COMMIT');copy.technologyArchive.acknowledgeHostCommit();}finally{if(copy.db.isTransaction){copy.db.exec('ROLLBACK');copy.technologyArchive.invalidateVerification();}copy.close();}
 const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
 snapshots.push({tick:durableTick,observedAt,reasons:[reason],file:path,bytes:lstatSync(path).size,sha256:fileDigest(path),snapshotDigest:String(original.digest),validatedLoad:true,eventCounter:verifiedCounter});timing.backupMs+=performance.now()-started;checkQuota();
};
try{
observe();save();if(config.maxSnapshots)checkpoint('initial');
const startTick=world.tick,started=performance.now(),samples:Record<string,unknown>[]=[],deaths:Record<string,unknown>[]=[],births:Record<string,unknown>[]=[],climates:Record<string,unknown>[]=[],urgent:Record<string,number>={},all:Record<string,number>={};
let movedSteps=0,urgentMoves=0,waterSteps=0,visible=0,invisible=0,previousBirths=world.totals.births,restartPassed=false,extinctionTick:number|null=null;
let intervalAll:Record<string,number>={},intervalUrgent:Record<string,number>={};
const protectedAll:Record<string,number>={},personTicks={neighbors:0,protected:0},pressureTicks={hungerHigh:0,thirstHigh:0,healthLow:0,energyLow:0,fatigueHigh:0};let peakNeighbors=world.people.filter((p)=>p.role==='neighbor').length;
const increment=(m:Record<string,number>,k:string)=>m[k]=(m[k]??0)+1;
let report!:Record<string,unknown>&{chronicle:Record<string,unknown>};
for(;world.tick<target;){
 if(stopping)throw new Error('OWNED_PROCESS_STOP_REQUESTED');
 const before=new Map(world.people.map((p)=>[p.id,{x:p.x,y:p.y,thirst:p.thirst,hunger:p.hunger,energy:p.energy,fatigue:p.fatigue,role:p.role,action:p.action,health:p.demography.health,vitality:p.demography.vitality,food:p.inventory,age:p.demography.age,generation:p.genome.generation}]));
 const consumed=world.totals.waterConsumed,weather=world.weather;
 const stepStarted=performance.now();stepWorld(world,[],store.context);timing.stepMs+=performance.now()-stepStarted;observe();
 if(world.weather!==weather)climates.push({tick:world.tick,weather:world.weather});
 if(world.totals.waterConsumed>consumed)waterSteps++;
 if(extinctionTick===null&&!world.people.some((p)=>p.role==='neighbor'))extinctionTick=world.tick;
 for(const p of world.people){
  if(p.role!=='neighbor'){increment(protectedAll,p.action);personTicks.protected++;continue;}
  personTicks.neighbors++;if(p.hunger>=.8)pressureTicks.hungerHigh++;if(p.thirst>=.8)pressureTicks.thirstHigh++;if(p.demography.health<=.25)pressureTicks.healthLow++;if(p.energy<=.2)pressureTicks.energyLow++;if(p.fatigue>=.8)pressureTicks.fatigueHigh++;
  increment(all,p.action);increment(intervalAll,p.action);
  const previous=before.get(p.id),moved=previous&&(previous.x!==p.x||previous.y!==p.y);if(moved)movedSteps++;
  if(p.thirst>.7){
   increment(urgent,p.action);increment(intervalUrgent,p.action);if(moved)urgentMoves++;
   if(world.tick%30===0){let found=false;for(let dy=-7;dy<=7&&!found;dy++)for(let dx=-7;dx<=7;dx++)if(dx*dx+dy*dy<=49){const pt={x:p.x+dx,y:p.y+dy},t=tileAt(world,pt);if(t&&t.terrain!=='water'&&waterAvailable(world,pt)>.005){found=true;break;}}if(found)visible++;else invisible++;}
  }
 }
 if(world.totals.births!==previousBirths){assert.ok(world.totals.births>previousBirths);births.push({tick:world.tick,count:world.totals.births-previousBirths,population:world.people.length});previousBirths=world.totals.births;}
 for(const [id,p]of before)if(!world.people.some((q)=>q.id===id)){const record=world.retiredLegacy.find((q)=>q.id===id)??world.legacy.find((q)=>q.id===id);assert.ok(record,'MISSING_DEATH_IDENTITY');deaths.push({tick:world.tick,cause:record.cause,...p});}
 const neighbors=world.people.filter((p)=>p.role==='neighbor');peakNeighbors=Math.max(peakNeighbors,neighbors.length);
 const risk=neighbors.length?neighbors.filter((p)=>p.hunger>=.9||p.thirst>=.9||p.demography.health<=.25).length/neighbors.length:1;
 for(const threshold of [.25,.5,.75]){const reason=`risk-fraction-${threshold}`;if(risk>=threshold&&!riskSeen.has(reason)){riskSeen.add(reason);checkpoint(reason);}}
 for(const fraction of [.75,.5,.25]){const reason=`population-below-peak-${fraction}`;if(neighbors.length<=peakNeighbors*fraction&&!riskSeen.has(reason)){riskSeen.add(reason);checkpoint(reason);}}
 if(world.tick%saveEvery===0||world.tick===target){save();}
 if(config.checkpointEvery&&world.tick%config.checkpointEvery===0)checkpoint('periodic');
 if(world.tick===restartAt){if(config.maxSnapshots)checkpoint('restart');fsyncSync(auditFd);const before=world;store.close();store=new Store(`${dir}/world.sqlite`);const loaded=load();assert.deepEqual(loaded,before);world=loaded;restartPassed=true;}
 if(world.tick%sampleEvery===0||world.tick===target){
  assertWorld(world);assert.equal(world.people.length,16+world.totals.births-world.demographyDynamics.deaths);assert.ok(world.people.every((p)=>p.command===null));
  const people=world.people.filter((p)=>p.role==='neighbor'),mean=(key:'thirst'|'hunger'|'energy'|'fatigue')=>people.reduce((s,p)=>s+p[key],0)/Math.max(1,people.length);
  const sample={tick:world.tick,population:world.people.length,births:world.totals.births,deaths:world.demographyDynamics.deaths,causes:{...world.demographyDynamics.causes},weather:world.weather,meanThirst:mean('thirst'),meanHunger:mean('hunger'),meanEnergy:mean('energy'),meanFatigue:mean('fatigue'),minHealth:people.length?Math.min(...people.map((p)=>p.demography.health)):null,fertileAge:people.filter((p)=>p.demography.age>=demographicTraits(p.genome).maturityAge&&p.demography.age<demographicTraits(p.genome).senescenceStart).length,waterConsumed:world.totals.waterConsumed,animalWater:world.animalDynamics.waterConsumed,activeAmbientWater:world.tiles.reduce((s,t)=>s+(t.drinkingWater??0),0),activeCisternWater:world.structures.reduce((s,t)=>s+t.water,0),settlements:world.settlementCount,activeStructures:world.structures.length,usedStructures:world.structures.filter((s)=>s.uses>0).length,technology:structuredClone(world.technology.ledger),bodies:{neighbors:bodySummary(people),protected:bodySummary(world.people.filter((p)=>p.role!=='neighbor'))},reproduction:reproductiveObservation(world,demographicTraits,reproductiveReadiness,familyOpportunity),intervalAll,intervalUrgent};
  samples.push(sample);intervalAll={};intervalUrgent={};
  report={seed,source:sha,indexHash,target,startTick,config,snapshots:structuredClone(snapshots),snapshotOmissions:structuredClone(snapshotOmissions),protectedAll,personTicks,pressureTicks,waterObservationScope:'Geometric ambient/cistern water within7; no pathfinding, action budget or portable inventory eligibility',mode:`natural no-input fixed-step; SQLite every${saveEvery}ticks; external event audit each step; fresh only`,saveEvery,restartAt,runnerSha256,chronicle:{auditedSteps,auditedCounter,maxEventsPerStep,complete:false},timing:{...timing},completedTick:world.tick,wallSeconds:(performance.now()-started)/1000,extinctionTick,restartPassed,urgent,all,movedSteps,urgentMoves,nominalMovementEnergy:movedSteps*.0008,waterSteps,visible,invisible,births,deaths,climates,samples};
  writeFileSync(`${dir}/report.json`,JSON.stringify(report,null,2));checkQuota();await yieldEventLoop();
  if(world.tick%2400===0)console.log(JSON.stringify({tick:world.tick,population:world.people.length,births:world.totals.births,thirst:sample.meanThirst,causes:sample.causes,seconds:report.wallSeconds}));
 }
}
assert.equal(createHash('sha256').update(readFileSync(`${source}/src/world/index.ts`)).digest('hex'),indexHash);
assert.deepEqual(load(),world);fsyncSync(auditFd);
for(const snapshot of snapshots)assert.equal(fileDigest(snapshot.file),snapshot.sha256,'CHECKPOINT_CHANGED');
const chronicle=await reconcileChronicle(store.db,auditPath,world.eventCounter,world.tick);
assert.deepEqual(sourceFiles(source),fingerprints,'SOURCE_CHANGED');assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim(),sha,'SOURCE_HEAD_CHANGED');assert.equal(createHash('sha256').update(readFileSync(runnerPath)).digest('hex'),runnerSha256,'RUNNER_CHANGED');
report.status='completed';report.checkpointsUnchanged=true;report.snapshots=structuredClone(snapshots);report.snapshotOmissions=structuredClone(snapshotOmissions);report.chronicle={...report.chronicle,...chronicle,auditSha256:fileDigest(auditPath)};report.timing={...timing};report.wallSeconds=(performance.now()-started)/1000;report.sourceFiles=fingerprints;report.sourceUnchanged=true;report.runnerUnchanged=true;
const legacy=[...store.db.prepare('SELECT body FROM legacy ORDER BY tick,id').iterate()].map((r)=>JSON.parse(String(r.body)));
report.final={population:world.people.length,births:world.totals.births,demography:world.demographyDynamics,totals:world.totals,technology:world.technology.ledger,settlements:world.settlementCount,cohorts:[...legacy.map((p)=>({generation:p.genome.generation,bornAt:p.bornAt,diedAt:p.diedAt,cause:p.cause})),...world.people.filter((p)=>p.role==='neighbor').map((p)=>({generation:p.genome.generation,bornAt:p.bornAt,diedAt:null,cause:null,health:p.demography.health}))],inputs:Number(store.db.prepare('SELECT COUNT(*) AS n FROM inputs').get()!.n),finalLoadEquality:true};
writeFileSync(`${dir}/report.json`,JSON.stringify(report,null,2));
} catch(error){writeFileSync(`${dir}/failure.json`,JSON.stringify({status:'failed',tick:world.tick,durableTick,durableEventCounter:durableCounter,verifiedEventCounter:verifiedCounter,error:error instanceof Error?error.message:String(error),snapshots,snapshotOmissions},null,2));throw error;} finally {process.off('SIGTERM',stop);process.off('SIGINT',stop);closeSync(auditFd);store.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))runExperiment(parseConfig(process.argv.slice(2))).catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
