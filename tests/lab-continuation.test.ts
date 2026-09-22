import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createWorld, stepWorld } from '../src/world/index.js';
import { parseParams, paramsOf } from '../src/world/params.js';
import { Store } from '../src/server/store.js';
import { completedCheckpoint, copyCheckpoint, exactLoaded, fileSetHash, files, hash, logicalHash, nextWindow, readCheckpoint, readJson, validateDays, type Manifest, type Original } from '../scripts/lab/continuation-audit/common.js';
import { activityStrata, RECIPE_CAUSE } from '../scripts/lab/continuation-audit/strata.js';
import { identities, runOwned } from '../scripts/lab/continuation-audit/process.js';
import { continueJob } from '../scripts/lab/continuation-audit/worker.js';
import { comparison } from '../scripts/lab/continuation-audit/runner.js';

function temporary(t:TestContext):string {const dir=mkdtempSync(join(tmpdir(),"atlas-continuation-'"));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function daily(day:number){return {day,tick:day*2400,activity:{vecinosMortales:day,ventanaActividad:{desdeTickExclusivo:(day-1)*2400,hastaTickInclusivo:day*2400}}};}

test('completed continuation requires the durable horizon, original laws and identity, and a valid checksum',t=>{
  const dir=temporary(t),db=new DatabaseSync(join(dir,'final.sqlite'));t.after(()=>db.close());
  db.exec('CREATE TABLE snapshots(slot INTEGER,body TEXT,digest TEXT,saved_at INTEGER)');
  const base={tick:2340,version:7,seed:51926,params:{persistencia:{cadaTicks:20}}};
  const write=(value:unknown,digest?:string)=>{const body=JSON.stringify(value);db.exec('DELETE FROM snapshots');db.prepare('INSERT INTO snapshots VALUES(0,?,?,0)').run(body,digest??hash(body));};
  write(base);const expected=readCheckpoint(db);
  assert.throws(()=>completedCheckpoint(db,expected,2400),/Final durable/);
  const final={...base,tick:2400};write(final);assert.equal(completedCheckpoint(db,expected,2400).tick,2400);
  for(const change of [{seed:1},{version:8},{params:{persistencia:{cadaTicks:10}}}]){
    write({...final,...change});assert.throws(()=>completedCheckpoint(db,expected,2400),/Final durable/);
  }
  write(final,'corrupt');assert.throws(()=>completedCheckpoint(db,expected,2400),/checksum/);
  db.exec('DELETE FROM snapshots');assert.throws(()=>completedCheckpoint(db,expected,2400),/missing/);
});

test('continuation preserves absolute day boundaries and rejects unrecoverable historical gaps',()=>{
  assert.deepEqual(nextWindow(46760),{day:20,after:45600,end:48000,steps:1240});
  assert.deepEqual(nextWindow(69600),{day:30,after:69600,end:72000,steps:2400});
  assert.throws(()=>nextWindow(72000),/horizon/);
  assert.deepEqual(validateDays([{day:1,record:daily(1)}],4800),{missingBoundary:true});
  assert.throws(()=>validateDays([{day:1,record:daily(1)}],4820),/cannot be reconstructed/);
  assert.throws(()=>validateDays([{day:1,record:daily(1)},{day:3,record:daily(3)}],7200),/window/);
  assert.throws(()=>exactLoaded({world:{tick:20,version:7,seed:1},slot:1,skipped:['broken']},{tick:20,version:7,seed:1,digest:'',savedAt:0,params:{}},{}, {}, {}),/rewound/);
  assert.throws(()=>exactLoaded({world:{tick:20,version:7,seed:1,value:2},slot:0,skipped:[]},{tick:20,version:7,seed:1,digest:'',savedAt:0,params:{}},{tick:20,version:7,seed:1,value:1},{},{}),/changed resident/);
});

test('readonly VACUUM copy includes WAL and quotes paths; damaged newest checkpoint is rejected without fallback',t=>{
  const dir=temporary(t),path=join(dir,'source.sqlite'),store=new Store(path),world=createWorld(51926,parseParams('persistencia.cadaTicks=20'));
  t.after(()=>store.close());store.save(world);for(let i=0;i<20;i++)stepWorld(world);store.save(world);
  const before=readCheckpoint(store.db),target=join(dir,"checkpoint's copy.sqlite"),digest=copyCheckpoint(path,target,before);
  assert.match(digest,/^[a-f0-9]{64}$/);assert.deepEqual(readCheckpoint(store.db),before);
  const ro=new Store(target,{readOnly:true});try{const loaded=ro.load()!;assert.equal(loaded.slot,0);assert.equal(loaded.world.tick,20);assert.equal(logicalHash({world,params:paramsOf(world)}),logicalHash({world:loaded.world,params:paramsOf(loaded.world)}));}finally{ro.close();}
  store.db.prepare("UPDATE snapshots SET digest='bad' WHERE slot=0").run();
  const refused=join(dir,'refused.sqlite');assert.throws(()=>copyCheckpoint(path,refused,before),/checksum/);assert.equal(existsSync(refused),false);
});

test('activity stratification counts dead mortal actors, separates S/I and inventor, and keeps teaching views distinct',t=>{
  const dir=temporary(t),db=new DatabaseSync(join(dir,'metrics.sqlite'));t.after(()=>db.close());
  db.exec('CREATE TABLE snapshots(slot INTEGER,body TEXT,digest TEXT);CREATE TABLE legacy(body TEXT,digest TEXT);CREATE TABLE technology_definitions(id TEXT,body TEXT,digest TEXT);CREATE TABLE technology_executions(serial INTEGER,tick INTEGER,body TEXT,digest TEXT);CREATE TABLE events(id TEXT,tick INTEGER,body TEXT)');
  const living=[{id:'S',role:'S',bornAt:0},{id:'I',role:'I',bornAt:0},{id:'learner',role:'neighbor',bornAt:0}];
  const body=JSON.stringify({people:living});db.prepare('INSERT INTO snapshots VALUES(0,?,?)').run(body,hash(body));
  const dead=JSON.stringify({id:'dead',role:'neighbor',bornAt:0,diedAt:15});db.prepare('INSERT INTO legacy VALUES(?,?)').run(dead,hash(dead));
  for(const [id,inventorId]of [['m','dead'],['s','S']]){const b=JSON.stringify({inventorId});db.prepare('INSERT INTO technology_definitions VALUES(?,?,?)').run(id,b,hash(b));}
  for(const [serial,tick,actorId,recipeId,benefit]of [[1,10,'dead','s',2],[2,12,'S','m',3],[3,14,'I','m',5],[4,20,'dead','m',7]] as const){const b=JSON.stringify({tick,actorId,recipeId,benefit,success:true,kind:'use'});db.prepare('INSERT INTO technology_executions VALUES(?,?,?,?)').run(serial,tick,b,hash(b));}
  for(const [id,kind,cause]of [['e1','learning',RECIPE_CAUSE],['e2','cooperation','Estrategia teach; fixture'],['e3','learning','Different learning cause']]){db.prepare('INSERT INTO events VALUES(?,?,?)').run(id,12,JSON.stringify({tick:12,kind,cause,source:'simulation',actors:['dead','learner']}));}
  const result=activityStrata(db,0,20);
  assert.deepEqual(result.byActor,{mortal:{uses:1,benefit:2},S:{uses:1,benefit:3},I:{uses:1,benefit:5},unknown:{uses:1,benefit:7}});
  assert.equal(result.actorAuthor.find(r=>r.actor==='mortal')!.author,'S');
  assert.deepEqual(result.teaching.map(r=>[r.kind,r.teacher,r.learner,r.episodes]),[['cooperation','mortal','mortal',1],['recipe','mortal','mortal',1]]);
  assert.equal(activityStrata(db,10,20).byActor.mortal.uses,0,'interval lower bound is exclusive');
});

test('owned process group kills a TERM-resistant descendant after its leader exits; unrelated process survives',async t=>{
  const dir=temporary(t),fd=openSync(join(dir,'log'),'w'),leaf=join(dir,'leaf.pid');t.after(()=>closeSync(fd));
  const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});t.after(()=>unrelated.kill('SIGKILL'));
  const childCode=`process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(leaf)},String(process.pid));setInterval(()=>{},1000);`;
  const leader=`const fs=require('fs');const watch=fs.watch(${JSON.stringify(dir)},(_,name)=>{if(name==='leaf.pid'){watch.close();process.exit(0);}});require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});setTimeout(()=>process.exit(9),2000);`;
  const result=await runOwned(process.execPath,['-e',leader],{cwd:dir,env:{PATH:'/usr/bin:/bin'},logFd:fd,timeoutMs:3000,graceMs:100});
  assert.equal(result.code,0,JSON.stringify(result));assert.equal(result.timedOut,false);assert.equal(result.descendantsFound,true);assert.equal(result.groupClear,true);
  const pid=Number(readFileSync(leaf,'utf8'));assert.equal(identities().some(p=>p.pid===pid&&!['Z','X'].includes(p.state)),false);
  assert.ok(identities().some(p=>p.pid===unrelated.pid&&!['Z','X'].includes(p.state)));
});

test('owned deadline remains a timeout when the leader ignores TERM',async t=>{
  const dir=temporary(t),fd=openSync(join(dir,'log'),'w');t.after(()=>closeSync(fd));
  const result=await runOwned(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{cwd:dir,env:{PATH:'/usr/bin:/bin'},logFd:fd,timeoutMs:150,graceMs:100});
  assert.equal(result.timedOut,true);assert.equal(result.groupClear,true);assert.notEqual(result.code,0);
});

test('a setup-recording failure terminates the newly spawned owned process',async t=>{
  const dir=temporary(t),fd=openSync(join(dir,'log'),'w');t.after(()=>closeSync(fd));
  const result=await runOwned(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:dir,env:{PATH:'/usr/bin:/bin'},logFd:fd,timeoutMs:1000,graceMs:100,onSpawn:()=>{throw new Error('fixture recording failure');}});
  assert.match(result.error??'',/recording failure/);assert.equal(result.groupClear,true);assert.notEqual(result.code,0);
});

test('real checkpoint continuation matches uninterrupted day and preserves original data and timing unknowns',async t=>{
  const dir=temporary(t),original=join(dir,'original');mkdirSync(original);
  const store=new Store(join(original,'world.sqlite')),world=createWorld(51926,parseParams('persistencia.cadaTicks=20'));t.after(()=>store.close());store.save(world);
  while(world.tick<2340){stepWorld(world);if(world.tick%20===0)store.save(world);}
  const checkpoint=readCheckpoint(store.db),root=resolve('.');
  const source={root,originSha:'0'.repeat(40),rootDirty:true,sourceHash:fileSetHash(root,['src/world','src/server','src/shared'].flatMap(folder=>readdirSync(join(root,folder)).filter(p=>p.endsWith('.ts')).sort().map(p=>`${folder}/${p}`))),fullHash:fileSetHash(root,['package.json',...files(root,'src')])};
  const instrumentHash=createHash('sha256').update(readFileSync('scripts/lab/coherence.ts')).update(readFileSync('scripts/lab/metrics.ts')).digest('hex');
  const job:Original={id:'candidate-51926',side:'candidate',seed:51926,output:original,status:'fixture',result:null,checkpoint,daily:[],eligible:true,reason:'bounded control',processes:[],validComplete:false};
  const output=join(dir,'continuation');mkdirSync(output);mkdirSync(join(output,'attempts'));
  const manifest:Manifest={continuationSchema:1,metricasVersion:2,mode:'control',createdAt:new Date().toISOString(),cutoff:new Date().toISOString(),directory:output,originalBatch:original,originalManifestHash:'fixture',sources:{baseline:source,candidate:source},instrumentRoot:root,instrumentHash,driverHash:'fixture',loader:'',workers:1,timeoutMs:600000,horizon:2400,cadence:20,diskBudgetBytes:8*1024**3,reserveBytes:0,originals:[job],selected:[job.id],scope:'bounded fixture'};
  const result=await continueJob(manifest,job);assert.equal(result.complete,true);assert.equal(result.finalTick,2400);assert.deepEqual(readCheckpoint(store.db),checkpoint,'original database remains at its checkpoint');
  while(world.tick<2400){stepWorld(world);if(world.tick%20===0)store.save(world);}
  const resumed=new Store(join(output,'attempts',job.id,'world.sqlite'),{readOnly:true});try{const loaded=resumed.load()!;assert.equal(logicalHash({world,params:paramsOf(world)}),logicalHash({world:loaded.world,params:paramsOf(loaded.world)}));}finally{resumed.close();}
  const day=readJson(join(output,'attempts',job.id,'days/day-001.json'));assert.equal(day.p95StepMs,null);assert.equal(day.operational,null);assert.equal(day.continuation.timingCoverage,'partial-or-reconstructed');assert.deepEqual(day.activity.ventanaActividad,{desdeTickExclusivo:0,hastaTickInclusivo:2400});
  const summary=comparison(manifest);assert.equal(summary.horizons[0].matchedPairs,0,'one available arm never forms a comparison pair');
});
