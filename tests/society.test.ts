import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorld, cloneWorld, createWorld, migrateWorld, RULES_VERSION, stepWorld, tileAt, type Person, type World } from '../src/world/index.js';
import { cooperate, cooperationOpportunity, culturalDistance, resourceDispute, updateCommunities, settlementOpportunity } from '../src/world/society.js';
import { materializeAnimals, syncFauna } from '../src/world/animals.js';
import { expressGenome, inheritGenome } from '../src/world/genetics.js';
import { recordSample, worldStatistics } from '../src/world/statistics.js';
import type { ChronicleEvent } from '../src/shared/types.js';

function emit(w: World) { return (event: Omit<ChronicleEvent, 'id' | 'tick'>) => {
  const result = { ...event, id: `e${++w.eventCounter}`, tick: w.tick }; w.events.push(result); return result;
}; }
function scene() {
  const w = createWorld(51926), a = w.people[2]!, b = w.people[3]!;
  for (const p of w.people) { p.x = 10; p.y = 20; p.action = 'rest'; p.target = {x:p.x,y:p.y}; p.decisionAt = 999; p.hunger = 0.1; p.thirst = 0.1; p.fatigue = 0.1; p.energy = 0.9; p.skills = {}; }
  for (const p of [a,b]) { p.x = 36; p.y = 12; p.target = {x:36,y:12}; }
  return { w,a,b };
}
function group(w: World, members: Person[], id: string) {
  for (const p of members) p.communityId = id;
  w.communityCounter++;
  w.communities.push({id,name:id,x:members[0]!.x,y:members[0]!.y,color:'#aaccee',members:members.map(p=>p.id),culture:{...members[0]!.culture},formedAt:w.tick,cooperation:0,disputes:0});
}

test('thirst consumes a finite visible stock; exhaustion chooses and physically reaches another source', () => {
  const {w,a,b} = scene(); b.x = 10; b.y = 20; b.target = {x:10,y:20};
  for (const tile of w.tiles) { tile.drinkingWater = 0; tile.fauna = 0; }
  a.thirst = 0.8; a.action = 'drink'; a.decisionAt = 999;
  const first = tileAt(w,a)!; first.feature = 'pool'; first.drinkingWater = 0.006;
  const next = tileAt(w,{x:38,y:12})!; next.feature = 'pool'; next.drinkingWater = 0.5;
  const before = a.thirst; stepWorld(w);
  assert.equal(first.drinkingWater,0); assert.ok(a.thirst < before); assert.equal(w.totals.waterConsumed,0.006);
  stepWorld(w); assert.equal(a.action,'drink'); assert.deepEqual(a.target,{x:38,y:12});
  for(let n=0;n<12;n++) { const old={x:a.x,y:a.y}; stepWorld(w); assert.ok(Math.abs(a.x-old.x)+Math.abs(a.y-old.y)<=1); }
  assert.equal(a.x,38); assert.ok(next.drinkingWater! < 0.5); assert.ok(a.thirst < before);
});

test('hunting requires work and debits one actual animal before producing finite food', () => {
  const {w,a} = scene(); a.action='hunt'; a.work=43; a.inventory=0; a.hunger=0.7;
  const source=tileAt(w,a)!; source.species='hare'; source.fauna=2;
  w.animals=materializeAnimals(w.seed,[source],w.tick);syncFauna(w.tiles,w.animals);
  for(const animal of w.animals){animal.lastDecision=0;animal.lastMove=0;animal.action='rest';}
  stepWorld(w); assert.equal(source.fauna,2); assert.equal(a.inventory,0);
  stepWorld(w); assert.equal(source.fauna,1); assert.equal(w.totals.hunts,1); assert.equal(w.totals.foodHarvested,0.12);
  assert.equal(a.inventory,0.06); assert.ok(a.hunger<0.5);
  w.animals=[];syncFauna(w.tiles,w.animals); a.work=44; a.action='hunt'; a.decisionAt=w.tick+100; const inventory=a.inventory;
  stepWorld(w); assert.equal(a.inventory,inventory); assert.equal(w.totals.hunts,1);
});

test('supply, exchange and work assistance preserve inventories and have different real effects', () => {
  const {w,a,b}=scene(); b.action='build'; b.materials={wood:5,stone:3}; a.materials={wood:2,stone:0};
  const wood=a.materials.wood+b.materials.wood;
  assert.equal(cooperationOpportunity(w,a)?.kind,'supply'); assert.equal(cooperate(w,a,emit(w)),true);
  assert.equal(b.materials.wood,6); assert.equal(a.materials.wood+b.materials.wood,wood); assert.equal(w.totals.cooperation,1);
  w.tick=30;b.work=10; assert.equal(cooperationOpportunity(w,a)?.kind,'assist'); cooperate(w,a,emit(w)); assert.equal(b.work,22); assert.equal(w.totals.constructionHelp,1);
  w.tick=60;b.action='rest';a.materials={wood:3,stone:0};b.materials={wood:0,stone:3};
  assert.equal(cooperationOpportunity(w,a)?.kind,'trade'); cooperate(w,a,emit(w));
  assert.deepEqual(a.materials,{wood:2,stone:1}); assert.deepEqual(b.materials,{wood:1,stone:2}); assert.equal(w.totals.trade,1);
  const control=cloneWorld(w); control.cooperationEnabled=false;
  assert.equal(cooperate(control,control.people[2]!,emit(control)),false); assert.equal(control.totals.cooperation,w.totals.cooperation);
  assert.ok(w.events.at(-1)!.cause.includes('transferidos')); assert.ok(a.bonds[b.id]!>0.2);
});

test('teaching requires a practiced technique and changes the learner without copying genes or episodes', () => {
  const {w,a,b}=scene(); a.skills={hunt:0.7}; b.skills={hunt:0.1};
  const genome=structuredClone(b.genome), before=culturalDistance(a.culture,b.culture);
  assert.equal(cooperationOpportunity(w,a)?.kind,'teach'); cooperate(w,a,emit(w));
  assert.ok(b.skills.hunt!>0.1); assert.equal(a.skills.hunt,0.7); assert.deepEqual(b.genome,genome); assert.equal(w.totals.teaching,1);
  assert.ok(culturalDistance(a.culture,b.culture)<before); assert.equal(b.experiences.length,1);
});

test('communities arise from nearby trust and compatible practices; labels alone do not create membership', () => {
  const {w,a,b}=scene(), c=w.people[4]!; c.x=a.x;c.y=a.y;
  w.places.push({id:'test-place',x:a.x,y:a.y,name:'Lugar de prueba',description:'Sintético',gatherings:0}); w.tick=120;
  for(const p of [a,b,c]) p.culture={sharing:0.8,stewardship:0.8,openness:0.8};
  const noTrust=cloneWorld(w); updateCommunities(noTrust,emit(noTrust)); assert.equal(noTrust.communities.length,0);
  a.bonds[b.id]=a.bonds[c.id]=0.5; updateCommunities(w,emit(w));
  assert.equal(w.communities.length,1); assert.equal(a.communityId,b.communityId); assert.equal(b.communityId,c.communityId);
  assert.ok(w.events.at(-1)!.cause.includes('Confianza'));
});

test('membership changes only with incompatible practice, low internal trust and compatible local alternatives', () => {
  const {w,a,b}=scene(), c=w.people[4]!, d=w.people[5]!;
  for(const p of [a,c,d]) { p.x=36;p.y=12;p.culture={sharing:0.9,stewardship:0.9,openness:0.9}; }
  b.culture={sharing:0.1,stewardship:0.1,openness:0.1}; group(w,[b,a],'old'); group(w,[c,d],'new');
  a.bonds[b.id]=0.1; a.bonds[c.id]=a.bonds[d.id]=0.6; w.tick=120;
  const loyal=cloneWorld(w); loyal.people[2]!.bonds[b.id]=0.8; updateCommunities(loyal,emit(loyal)); assert.equal(loyal.people[2]!.communityId,'old');
  updateCommunities(w,emit(w)); assert.equal(a.communityId,'new'); assert.deepEqual(w.communities[0]!.members,[b.id]);
});

test('resource conflicts require the same scarce stock and urgent bodies; trust permits a costly turn instead', () => {
  const {w,a,b}=scene(); a.action=b.action='drink';a.thirst=b.thirst=0.95;a.culture.openness=b.culture.openness=0.1;
  group(w,[a],'one');group(w,[b],'two');const source=tileAt(w,a)!;source.drinkingWater=0.05;
  const abundant=cloneWorld(w);tileAt(abundant,a)!.drinkingWater=0.8;assert.equal(resourceDispute(abundant,abundant.people[2]!,emit(abundant)),false);
  const differentResource=cloneWorld(w);differentResource.people[3]!.action='hunt';assert.equal(resourceDispute(differentResource,differentResource.people[2]!,emit(differentResource)),false);
  const satisfied=cloneWorld(w);satisfied.people[3]!.thirst=0.1;assert.equal(resourceDispute(satisfied,satisfied.people[2]!,emit(satisfied)),false);
  const trust=cloneWorld(w);trust.people[2]!.bonds[b.id]=0.8;assert.equal(resourceDispute(trust,trust.people[2]!,emit(trust)),true);
  assert.equal(trust.totals.conflicts,0);assert.equal(trust.totals.cooperation,1);assert.equal(tileAt(trust,a)!.drinkingWater,0.05);
  stepWorld(trust);assert.equal(trust.people[2]!.action,'retreat','urgent thirst must respect the agreed turn');
  assert.equal(resourceDispute(w,a,emit(w)),true);assert.equal(w.totals.conflicts,1);assert.equal(source.drinkingWater,0.05);assert.ok(a.socialLoad>0);assert.equal(a.action,'retreat');
});

test('diploid inheritance is deterministic, recombines both parents and mutation changes bounded alleles', () => {
  const {w,a,b}=scene(); const rng=w.rng;
  const child=inheritGenome(w.seed,'child',[a,b],0), again=inheritGenome(w.seed,'child',[a,b],0);
  assert.deepEqual(child,again);assert.equal(child.generation,1);assert.deepEqual(child.parents,[a.id,b.id]);assert.equal(child.mutations,0);assert.equal(w.rng,rng);
  for(let locus=0;locus<7;locus++) {assert.ok(a.genome.alleles.slice(locus*2,locus*2+2).includes(child.alleles[locus*2]!));assert.ok(b.genome.alleles.slice(locus*2,locus*2+2).includes(child.alleles[locus*2+1]!));}
  const mutated=inheritGenome(w.seed,'child',[a,b],1);assert.equal(mutated.mutations,14);assert.notDeepEqual(mutated.alleles,child.alleles);assert.ok(mutated.alleles.every(n=>n>=0&&n<=1));assert.ok(expressGenome(mutated).care>=0);
});

test('resource-dependent birth spends parental reserves, inherits parameters and starts a new learning history', () => {
  const {w,a,b}=scene();a.x=b.x=17;a.y=b.y=13; a.target=b.target={x:17,y:13};
  group(w,[a,b],'parents');a.bonds[b.id]=b.bonds[a.id]=0.7;a.inventory=b.inventory=0.2;
  a.skills={hunt:0.9};a.values={'ready:hunt':0.25};a.lastSocial=12; a.experiences=[{tick:0,text:'Only the parent learned this',causeId:'e1',placeId:''}];
  w.tick=599;for(const p of w.people)p.demography.age=w.tick-p.bornAt;const noFood=cloneWorld(w);noFood.people[2]!.inventory=0;stepWorld(noFood);assert.equal(noFood.people.length,16);
  stepWorld(w);const child=w.people.at(-1)!;assert.equal(w.people.length,17);assert.equal(child.genome.generation,1);assert.equal(child.bornAt,600);
  assert.ok(Math.abs(a.inventory+b.inventory+child.inventory-0.34)<1e-12);assert.deepEqual(child.skills,{});assert.deepEqual(child.values,{});assert.deepEqual(child.habits,[]);
  assert.ok(child.experiences.every(e=>!e.text.includes('Only the parent')));assert.equal(child.lastSocial,600);assert.equal(w.totals.births,1);assertWorld(w);
});

test('learning rate controls acquired preferences, and statistics reflect stock with an explicitly bounded scope', () => {
  const {w,a}=scene();a.action='gather';a.work=17;tileAt(w,a)!.wood=3;const low=cloneWorld(w);low.people[2]!.genome.learningRate=0.04;a.genome.learningRate=0.2;
  stepWorld(w);stepWorld(low);assert.deepEqual(a.materials,low.people[2]!.materials);assert.ok(a.values['ready:gather']!>low.people[2]!.values['ready:gather']!);
  const stats=worldStatistics(w);assert.equal(stats.scope,'active-regions');assert.equal(Object.values(stats.biomes).reduce((a,b)=>a+b,0),w.tiles.length);
  assert.equal(Object.values(stats.wildlife).reduce((a,b)=>a+b,0),w.tiles.reduce((sum,t)=>sum+(t.fauna??0),0));
  for(let i=1;i<=110;i++){w.tick=i*60;recordSample(w);}assert.equal(w.history.length,96);assert.equal(w.history.at(-1)!.tick,6600);
});

test('V2 migration preserves old learning, zero resources and weather, and optimized clones cannot mutate their source', () => {
  const w=createWorld(51926), old=structuredClone(w) as unknown as Record<string,unknown>;old.version=2;
  const people=old.people as Record<string,unknown>[];const tiles=old.tiles as Record<string,unknown>[];
  for(const key of ['cooperationEnabled','reproductionEnabled','communities','communityCounter','birthCounter','history','totals','animals','animalCounter','animalDynamics','blueprints','structures','blueprintCounter','structureCounter','inventionDynamics'])delete old[key];
  for(const p of people)for(const key of ['thirst','genome','bornAt','lastBirth','lastSocial','lastDispute','lastPracticeMemory','culture','communityId','bonds'])delete p[key];
  for(const tile of tiles)for(const key of ['feature','variety','growth','fertility','cultivation','traffic','drinkingWater','life','fauna','species'])delete tile[key];
  tiles[0]!.wood=0;people[2]!.skills={gather:0.5};const before=structuredClone(old);const migrated=migrateWorld(old);
  assert.deepEqual(old,before);assert.equal(migrated.version,RULES_VERSION);assert.equal(migrated.rng,old.rng);assert.equal(migrated.tiles[0]!.wood,0);assert.deepEqual(migrated.people[2]!.skills,{gather:0.5});assertWorld(migrated);
  const cloned=cloneWorld(migrated);assert.deepEqual(cloned,structuredClone(migrated));cloned.people[2]!.genome.alleles[0]=1;cloned.tiles[0]!.food=1;assert.notDeepEqual(cloned,migrated);
});

test('home return depends on observed provision and useful contacts; empty resources release exploration without teleporting', () => {
  const world=createWorld(51926),person=world.people[2]!;
  person.x=22;person.y=13;person.target={x:22,y:13};person.home={x:17,y:13,quality:0.8,observedAt:0};person.hunger=person.thirst=0.2;person.fatigue=0.1;person.socialLoad=0;person.sociability=0.8;person.curiosity=0.2;
  for(const p of world.people.filter(p=>p!==person)){p.x=17;p.y=13;person.bonds[p.id]=0.7;}
  for(const tile of world.tiles)if(Math.hypot(tile.x-17,tile.y-13)<=4){tile.food=0.2;tile.drinkingWater=0.2;}
  const depleted=cloneWorld(world);for(const tile of depleted.tiles){tile.food=0;tile.drinkingWater=0;tile.fauna=0;}depleted.animals=[];
  const home=settlementOpportunity(world,person);assert.ok(home);assert.deepEqual(home.target,{x:17,y:13});assert.ok(home.score>0.6);
  assert.equal(settlementOpportunity(depleted,depleted.people[2]!),undefined);assert.equal(depleted.people[2]!.home,undefined);
  person.decisionAt=0;const before={x:person.x,y:person.y};stepWorld(world);assert.ok(Math.abs(person.x-before.x)+Math.abs(person.y-before.y)<=1);assert.equal(person.action,'approach');assert.deepEqual(person.target,{x:17,y:13});
  const stale=cloneWorld(world);stale.tick=4000;stale.people[2]!.x=100;stale.people[2]!.y=100;assert.equal(settlementOpportunity(stale,stale.people[2]!),undefined,'distant stale memories cannot see replenished stock');
});

test('autonomous seed develops and retains a community, births and useful inventions through real interactions', () => {
  const world=createWorld(51926);assert.equal(world.communities.length,0);assert.equal(world.people.some(p=>p.communityId!==null),false);
  for(let n=0;n<600;n++)stepWorld(world);
  const early=new Set(world.communities.map(c=>c.id));assert.ok(early.size>0);assert.ok(world.totals.cooperation!>0);
  for(let n=600;n<2400;n++)stepWorld(world);
  assertWorld(world);assert.ok(world.communities.some(c=>early.has(c.id)&&c.members.length>=3));assert.ok(world.totals.cooperation!>10);assert.ok(world.totals.births!>0);
  assert.ok(world.people.filter(p=>world.people.some(q=>q!==p&&Math.hypot(q.x-p.x,q.y-p.y)<=7)).length>=world.people.length/2);
  assert.ok(world.inventionDynamics.attempts>0);assert.ok(world.blueprints.some(b=>b.generation>0));assert.ok(world.structures.some(s=>s.blueprintId!=='blueprint-base'),'a new design must actually be built');
  assert.ok(world.people.some(p=>(p.activity.build??0)>0),'practice must precede the displayed profession');
});

test('a cistern earns observed utility only when the human action actually consumes its finite reserve',()=>{
  const {w,a}=scene(),tile=tileAt(w,a)!;tile.terrain='shelter';tile.drinkingWater=0;a.action='drink';a.thirst=0.8;
  for(const p of w.people.filter(p=>p!==a)){p.x=10;p.y=20;p.target={x:10,y:20};}
  const blueprint={...structuredClone(w.blueprints[0]!),id:'blueprint-1',generation:1,parents:['blueprint-base'],inventorId:a.id,components:['frame','roof','cistern'] as const,cost:{wood:8,stone:6,work:130}};
  w.blueprints.push({...blueprint,components:[...blueprint.components]});w.blueprintCounter=1;w.structureCounter=1;
  const structure={...structuredClone(w.structures[0]!),id:'structure-1',x:a.x,y:a.y,blueprintId:blueprint.id,components:[...blueprint.components],water:0.1};w.structures.push(structure);
  const idle=cloneWorld(w);idle.people[2]!.action='explore';idle.people[2]!.hunger=idle.people[2]!.thirst=0.1;
  stepWorld(idle);assert.equal(idle.structures.find(s=>s.id===structure.id)!.water,0.1);assert.equal(idle.blueprints[1]!.uses,0);
  stepWorld(w);assert.ok(Math.abs(structure.water-0.094)<1e-12);assert.equal(tile.drinkingWater,0);assert.equal(w.totals.waterConsumed,0.006);assert.ok(a.thirst<0.8);assert.ok(w.blueprints[1]!.uses>0);assert.ok(w.blueprints[1]!.usefulness>0);assertWorld(w);
});
