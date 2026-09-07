import test, {type TestContext} from 'node:test';
import {fileURLToPath} from 'node:url';
const source=fileURLToPath(new URL('../',import.meta.url));
function temporary(t:TestContext,prefix:string){const path=mkdtempSync(prefix);t.after(()=>rmSync(path,{recursive:true,force:true}));return path;}
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {auditStep,reconcileChronicle} from '../scripts/survival-audit.mjs';
const event=(id:string,tick:number)=>({id,tick,kind:'animal',actors:[],text:'synthetic',source:'simulation'});
test('audit is non-mutating, contiguous and accepts zero-event steps',()=>{const events=[event('e1',0),event('e2',1),event('e3',1)],copy=structuredClone(events);assert.equal(auditStep(1,3,events,1).length,2);assert.deepEqual(events,copy);assert.deepEqual(auditStep(3,3,events,2),[]);});
test('audit rejects intrastep truncation, duplicate, wrong tick and decreasing counter',()=>{assert.throws(()=>auditStep(0,155,Array.from({length:120},(_,i)=>event(`e${i+36}`,1)),1),/EVENT_GAP/);assert.throws(()=>auditStep(0,2,[event('e1',1),event('e1',1)],1),/EVENT_ORDER/);assert.throws(()=>auditStep(0,1,[event('e1',0)],1),/EVENT_TICK/);assert.throws(()=>auditStep(2,1,[],1),/EVENT_COUNTER/);});
test('SQL reconciliation rejects missing bodies, tampering and extra events',async(t)=>{const dir=temporary(t,'/tmp/atlas-audit-test-'),path=`${dir}/audit.jsonl`,db=new DatabaseSync(':memory:');db.exec('CREATE TABLE events(id TEXT PRIMARY KEY,tick INTEGER,body TEXT)');const e=event('e1',0);const row={tick:0,first:1,last:1,count:1,events:auditStep(0,1,[e],0)};writeFileSync(path,JSON.stringify(row)+'\n');await assert.rejects(reconcileChronicle(db,path,1,0),/SQLITE_MISSING/);db.prepare('INSERT INTO events VALUES(?,?,?)').run(e.id,0,JSON.stringify(e));assert.equal((await reconcileChronicle(db,path,1,0)).sqliteExact,true);db.prepare('UPDATE events SET body=?').run(JSON.stringify({...e,text:'changed'}));await assert.rejects(reconcileChronicle(db,path,1,0),/SQLITE_EVENT_BODY/);db.prepare('UPDATE events SET body=?').run(JSON.stringify(e));db.prepare('INSERT INTO events VALUES(?,?,?)').run('e2',0,JSON.stringify(event('e2',0)));await assert.rejects(reconcileChronicle(db,path,1,0),/SQLITE_EXTRA/);db.close();});
test('reconciliation requires every audit step including eventless intervals',async(t)=>{const dir=temporary(t,'/tmp/atlas-audit-test-'),path=`${dir}/audit.jsonl`,db=new DatabaseSync(':memory:');db.exec('CREATE TABLE events(id TEXT PRIMARY KEY,tick INTEGER,body TEXT)');writeFileSync(path,[{tick:0,first:1,last:0,count:0,events:[]},{tick:2,first:1,last:0,count:0,events:[]}].map(r=>JSON.stringify(r)).join('\n')+'\n');await assert.rejects(reconcileChronicle(db,path,0,2),/AUDIT_STEP_GAP/);db.close();});

import {bodySummary,reproductiveObservation,parseConfig} from '../scripts/survival-audit.mjs';
import {createWorld,stepWorld,assertWorld,cloneWorld} from '../src/world/index.js';
import {materializeAnimals,syncFauna} from '../src/world/animals.js';
import {Store} from '../src/server/store.js';
import {demographicTraits} from '../src/world/demography.js';
import {familyOpportunity,reproductiveReadiness} from '../src/world/family.js';
test('observer outputs copy all metrics and pure family calls do not mutate the world',()=>{
 const world=createWorld(51926),before=structuredClone(world),bodies=bodySummary(world.people),reproduction=reproductiveObservation(world,demographicTraits,reproductiveReadiness,familyOpportunity);
 assert.deepEqual(world,before);const recorded=structuredClone({bodies,reproduction});world.people[0].hunger=1;world.people[0].demography.health=0;assert.deepEqual({bodies,reproduction},recorded);assert.equal(bodySummary([]).health.mean,null);assert.match(reproduction.stage,/post-step/);
});
test('configuration refuses unknown controls and unbounded sample counts',()=>{
 assert.throws(()=>parseConfig(['source','1','60000','output','--invented=1']));assert.throws(()=>parseConfig(['source','1','60000','output','--sample-every=1']));assert.equal(parseConfig(['source','42','60000','output']).saveEvery,'auto');assert.equal(parseConfig(['.','42','60000','output']).source,process.cwd());
});
test('real physical burst155 survives journal+clone+save while old ring view rejects missing observations',(t)=>{
 const world=createWorld(51926);for(const tile of world.tiles)tile.fauna=0;
 for(const tile of world.tiles.filter(t=>t.terrain!=='water'&&t.terrain!=='shelter').slice(0,22)){tile.fauna=6;tile.species='hare';}
 world.animals=materializeAnimals(world.seed,world.tiles,world.tick);syncFauna(world.tiles,world.animals);
 for(const animal of world.animals.slice(0,128)){animal.thirst=1;animal.health=.0001;}assertWorld(world);
 const directory=temporary(t,'/tmp/atlas-v3-burst-'),store=new Store(directory+'/world.sqlite');
 try{store.save(world);const draft=cloneWorld(world,store.context);stepWorld(draft,[],store.context);assertWorld(draft);
  const n=draft.eventCounter-world.eventCounter;assert.equal(n,155);assert.equal(draft.events.length,120);
  const records=auditStep(world.eventCounter,draft.eventCounter,draft.chronicleJournal?.pending??draft.events,draft.tick);assert.equal(records.length,155);
  assert.throws(()=>auditStep(world.eventCounter,draft.eventCounter,draft.events,draft.tick),/EVENT_GAP/);
  store.save(draft);assert.equal(Number(store.db.prepare('SELECT COUNT(*) n FROM events').get()!.n),draft.eventCounter);assert.deepEqual(store.load()!.world,draft);
 }finally{store.close();}
});

import {runExperiment} from '../scripts/survival-audit.mjs';
import {readFileSync} from 'node:fs';
test('postcommit auditor failure reports durable snapshot separately from verified event prefix',async(t)=>{
 const directory=temporary(t,'/tmp/atlas-v3-postcommit-')+'/run';const original=Store.prototype.save;
 Store.prototype.save=function(world,...args){const result=original.call(this,world,...args);if(world.tick===120)this.db.prepare("UPDATE events SET tick=999 WHERE id='e2'").run();return result;};
 try{await assert.rejects(runExperiment(parseConfig([source,'51926','240',directory,'--restart-at=120','--max-snapshots=0','--checkpoint-every=0'])));
 const failure=JSON.parse(readFileSync(directory+'/failure.json','utf8'));assert.equal(failure.durableTick,120);assert.ok(failure.durableEventCounter>failure.verifiedEventCounter);assert.equal(failure.verifiedEventCounter,1);
 const db=new DatabaseSync(directory+'/world.sqlite',{readOnly:true});try{assert.equal(JSON.parse(String(db.prepare('SELECT body FROM snapshots WHERE slot=0').get()!.body)).tick,120);}finally{db.close();}
 }finally{Store.prototype.save=original;}
});
