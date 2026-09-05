import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store, SessionRevoked } from '../src/server/store.js';
import { assertWorld, cloneWorld, createWorld, migrateWorld, projectWorld, stepWorld, tileAt, type World } from '../src/world/index.js';
import { initialDemography } from '../src/world/demography.js';
import { technologyWorkCost, projectTechnology, settleTechnologyEstate } from '../src/world/technology.js';
import type { TechnologyProgram } from '../src/shared/technology.js';

function fixture(t: TestContext) {
  const directory=mkdtempSync(join(tmpdir(),'atlas-lifecycle-'));
  const store=new Store(join(directory,'world.sqlite'));
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,directory};
}
function setDying(world: World, index=2) {
  const person=world.people[index]!;
  person.demography.health=1e-10;person.hunger=1;person.thirst=1;person.energy=0.1;person.fatigue=0.9;
  return person;
}
function makeTool(world: World) {
  const person=world.people[2]!;
  const program:TechnologyProgram={inputs:[{source:'raw',material:'stone',mass:1000}],steps:[{op:'form',shape:'edge',intensity:4},{op:'compress',intensity:2}]};
  person.materials={wood:8,stone:8};person.energy=1;person.hunger=0.1;person.thirst=0.1;person.fatigue=0.1;
  person.command={order:'research',x:person.x,y:person.y};person.controlMode='directed';person.decisionAt=0;
  person.technology.project={kind:'research',program,parents:[],recipeId:null,progress:0,requiredWork:technologyWorkCost(program),energyPaid:0,startedAt:world.tick};
  for(let n=0;n<100&&!person.technology.items.length;n++) stepWorld(world);
  assert.ok(person.technology.items.length);assertWorld(world);
  return person;
}
function makeChild(world: World) {
  world.tick=599;
  for(const person of world.people) {
    person.x=10;person.y=20;person.action='rest';person.target={x:10,y:20};person.decisionAt=999;
    person.hunger=0.1;person.thirst=0.1;person.fatigue=0.1;person.energy=0.9;person.demography.age=world.tick-person.bornAt;
  }
  const a=world.people[2]!,b=world.people[3]!;
  for(const person of [a,b]) {person.x=17;person.y=13;person.target={x:17,y:13};person.communityId='community-1';person.inventory=0.2;}
  a.bonds[b.id]=0.7;world.communityCounter=1;
  world.communities=[{id:'community-1',name:'Comunidad de prueba',x:17,y:13,color:'#aaccee',members:[a.id,b.id],culture:{...a.culture},formedAt:world.tick,cooperation:0,disputes:0}];
  stepWorld(world);assert.equal(world.people.length,17);assertWorld(world);
  return world.people.at(-1)!;
}

test('V4 migration preserves all existing fields and adds separate bodies and technology without mutating source',()=>{
  const original=structuredClone(createWorld(51926)) as unknown as Record<string,unknown>;
  original.version=4;original.tick=170;
  for(const key of ['technology','legacy','retiredLegacy','demographyDynamics']) delete original[key];
  for(const person of original.people as Record<string,unknown>[]) {delete person.technology;delete person.demography;}
  const before=structuredClone(original), migrated=migrateWorld(original);
  assert.deepEqual(original,before);
  for(const [key,value] of Object.entries(original)) {
    if(key==='version'||key==='people')continue;
    assert.deepEqual(migrated[key as keyof World],value,key);
  }
  for(const [i,person] of (original.people as Record<string,unknown>[]).entries()) for(const [key,value] of Object.entries(person)) assert.deepEqual((migrated.people[i] as unknown as Record<string,unknown>)[key],value,key);
  assert.equal(migrated.people[2]!.demography.age,4970);assert.equal(migrated.technology.recipes.length,0);assertWorld(migrated);
});

test('death is durable, reference authors survive, and restart cannot resurrect a body',t=>{
  const {store}=fixture(t),world=createWorld(51926),person=makeTool(world),id=person.id;
  const recipeId=person.technology.items[0]!.recipeId!;
  store.save(world);setDying(world);stepWorld(world);assertWorld(world);
  assert.ok(!world.people.some(p=>p.id===id));assert.equal(world.demographyDynamics.deaths,1);
  assert.equal(world.retiredLegacy.length,1);store.save(world);assert.equal(world.retiredLegacy.length,0);
  const restored=store.load()!.world;assert.deepEqual(restored,world);assert.equal(store.loadLegacy(id,world.tick-1),null);
  assert.equal(store.loadLegacy(id,world.tick)!.id,id);
  assert.equal(restored.technology.recipes.find(r=>r.id===recipeId)!.inventorId,id);
  assert.equal(projectTechnology(restored).dynamics.massError,0);
  assert.ok(projectWorld(restored).demography!.recent.some(p=>p.id===id));
  for(const p of restored.people)assert.ok(!(id in p.bonds));
});

test('revoked transaction preserves pending identities and commits neither death nor snapshot',t=>{
  const {store}=fixture(t),world=createWorld(51926);store.save(world);
  const before=cloneWorld(world);setDying(world);stepWorld(world);
  assert.throws(()=>store.save(world,[],['revoked-session']),SessionRevoked);
  assert.equal(world.retiredLegacy.length,1);assert.equal(store.loadLegacy(world.retiredLegacy[0]!.id),null);
  assert.deepEqual(store.load()!.world,before);
  store.save(world);assert.equal(world.retiredLegacy.length,0);assert.deepEqual(store.load()!.world,world);
});

test('previous checkpoint prunes future deaths only in its new recovery copy',t=>{
  const {store,directory}=fixture(t),world=createWorld(51926);store.save(world);const id=setDying(world).id;
  stepWorld(world);store.save(world);
  const path=join(directory,'previous.sqlite');store.previous(path);
  const previous=new Store(path);
  try { assert.equal(previous.load()!.world.tick,0);assert.equal(previous.loadLegacy(id),null);assert.ok(previous.load()!.world.people.some(p=>p.id===id)); }
  finally {previous.close();}
  assert.equal(store.load()!.world.tick,1);assert.ok(store.loadLegacy(id));
});

test('checksum-consistent archive identity forgery still fails validation',t=>{
  const {store}=fixture(t),world=createWorld(51926);const id=setDying(world).id;stepWorld(world);store.save(world);
  const record=store.loadLegacy(id)!;record.diedAt=world.tick+10;
  const body=JSON.stringify(record),digest=createHash('sha256').update(body).digest('hex');
  store.db.prepare('UPDATE legacy SET body=?,digest=? WHERE id=?').run(body,digest,id);
  assert.throws(()=>store.load());
});

test('a counter cannot move behind a living descendant, and a refused collision spends no parental reserves',t=>{
  const {store}=fixture(t),world=createWorld(51926),child=makeChild(world);assert.equal(child.id,'descendant-1');
  world.birthCounter=0;assert.throws(()=>assertWorld(world));store.save(world);assert.throws(()=>store.load());
  world.birthCounter=1;assertWorld(world);
  world.tick=4799;
  for(const person of world.people) {person.demography.age=world.tick-person.bornAt;person.action='rest';person.decisionAt=9999;person.hunger=0.1;person.thirst=0.1;person.fatigue=0.1;person.energy=0.9;person.inventory=0.2;}
  world.birthCounter=0;
  const a=world.people[2]!,b=world.people[3]!,reserved=a.inventory+b.inventory;
  assert.throws(()=>stepWorld(world),/identidad de un nacimiento/);assert.equal(a.inventory+b.inventory,reserved);
});

test('a deceased parent remains a valid identity, but cannot predate its own child birth',t=>{
  const {store}=fixture(t),world=createWorld(51926),child=makeChild(world);
  const parent=setDying(world);stepWorld(world);assertWorld(world);store.save(world);assert.deepEqual(store.load()!.world,world);
  const record=world.legacy.find(p=>p.id===parent.id)!;record.diedAt=child.bornAt-1;
  assert.throws(()=>assertWorld(world));
  const body=JSON.stringify(record),digest=createHash('sha256').update(body).digest('hex');
  store.db.prepare('UPDATE legacy SET tick=?,body=?,digest=? WHERE id=?').run(record.diedAt,body,digest,parent.id);
  assert.throws(()=>store.load());
});

test('a physical edge improves bounded harvesting, wears, and credits only the additional extraction',()=>{
  const world=createWorld(51926),person=makeTool(world);
  person.command={order:'gather',x:person.x,y:person.y};person.controlMode='directed';person.action='gather';person.target={x:person.x,y:person.y};person.decisionAt=world.tick+100;
  person.materials.wood=0;person.work=17;person.hunger=0.2;person.thirst=0.2;person.energy=0.8;person.fatigue=0.2;
  const tile=tileAt(world,person)!;tile.wood=6;
  const control=cloneWorld(world),bare=control.people.find(p=>p.id===person.id)!;
  settleTechnologyEstate(control,bare,[]);
  const beforeMass=person.technology.items.reduce((sum,item)=>sum+item.mass,0),beforeWood=tile.wood;
  stepWorld(world);stepWorld(control);
  const delta=person.materials.wood-bare.materials.wood;
  assert.ok(delta>0);assert.ok(person.technology.items.reduce((sum,item)=>sum+item.mass,0)<beforeMass);
  assert.equal(beforeWood-tile.wood,person.materials.wood);
  const receipt=[...world.technology.history].reverse().find(e=>e.kind==='use'&&e.actorId===person.id)!;
  assert.ok(Math.abs(receipt.benefit-delta)<1e-12);assert.equal(projectTechnology(world).dynamics.massError,0);
  assertWorld(world);assertWorld(control);
});

test('switching a paid research project to an explicit craft order preserves effort and releases the incompatible project',()=>{
  const world=createWorld(51926),person=makeTool(world),recipe=world.technology.recipes.find(r=>r.id===person.technology.knownRecipes[0])!;
  person.technology.project={kind:'research',program:structuredClone(recipe.program),parents:[...recipe.parents],recipeId:null,progress:1,requiredWork:technologyWorkCost(recipe.program),energyPaid:0.00045,startedAt:world.tick};
  person.energy-=0.00045;world.technology.ledger.energy+=0.00045;world.technology.ledger.work++;
  const stone=person.materials.stone,items=person.technology.items.length,failures=world.technology.ledger.failures;
  const [ack]=stepWorld(world,[{id:'switch-to-craft',kind:'command',agentId:person.id,order:'craft',x:person.x,y:person.y}]);
  assert.ok(ack!.accepted);assert.equal(world.technology.ledger.failures,failures+1);assert.equal(person.materials.stone,stone);assert.equal(person.technology.items.length,items);
  assert.equal(person.technology.project?.kind,'craft');
  for(let tick=0;tick<100&&person.technology.items.length===items;tick++)stepWorld(world);
  assert.equal(person.technology.items.length,items+1);assert.equal(person.materials.stone,stone-1);assertWorld(world);
});

test('the explicit continuity policy protects S and I without supplying food or copying biological youth',()=>{
  const world=createWorld(51926),s=setDying(world,0);s.demography=initialDemography(world.tick-s.bornAt);s.demography.health=1e-10;
  const before=s.inventory;stepWorld(world);assert.ok(world.people.some(p=>p.id===s.id));assert.ok(s.demography.health>0);
  assert.equal(s.demography.age,4801);assert.ok(s.inventory<=before);assert.equal(world.demographyDynamics.deaths,0);
});
