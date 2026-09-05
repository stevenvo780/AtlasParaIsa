import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld, tileAt, projectWorld, assertWorld, cloneWorld, type World } from '../src/world/index.js';
import { parseGesture } from '../src/server/app.js';

function scene() {
  const world=createWorld(51926), person=world.people[2]!;
  world.reproductionEnabled=false;
  for (const p of world.people) {
    p.action='rest'; p.target={x:p.x,y:p.y}; p.decisionAt=10000;
    p.hunger=p.thirst=p.fatigue=0.1; p.energy=0.9;
  }
  person.x=36; person.y=12; person.target={x:36,y:12};
  person.inventory=0; person.action='forage'; person.work=16;
  const tile=tileAt(world,person)!; tile.food=0.5;
  return {world,person,tile};
}
const near = (a:number,b:number) => assert.ok(Math.abs(a-b)<1e-12,`${a} != ${b}`);

test('foraging stores real biomass only after work, spends energy and does not directly satiate hunger', () => {
  const {world,person,tile}=scene(), idle=cloneWorld(world);
  idle.people[2]!.action='approach';
  const food=tile.food, energy=person.energy;
  stepWorld(world); stepWorld(idle);
  assert.equal(person.inventory,0); assert.equal(tile.food,food);
  assert.equal(projectWorld(world).people[2]!.working,true);
  stepWorld(world); stepWorld(idle);
  near(person.inventory,0.06); near(tile.food,food-0.06);
  near(world.totals.foodHarvested!,0.06);
  near(person.hunger,idle.people[2]!.hunger);
  assert.ok(person.energy<energy && person.energy<idle.people[2]!.energy);
  assert.equal(person.activity.forage,1); assert.ok(person.skills.forage!>0);
  const view=projectWorld(world).people[2]!;
  near(view.foodReserve!,person.inventory); assert.equal(view.foodReserveCapacity,0.25);
  assertWorld(world);
});

test('a fractional carry remainder limits extraction; full capacity leaves biomass untouched', () => {
  const {world,person,tile}=scene(); person.inventory=0.249; person.work=17;
  const before=tile.food; stepWorld(world);
  near(person.inventory,0.25); near(before-tile.food,0.001);
  person.action='forage'; person.decisionAt=10000; person.work=17;
  const remaining=tile.food, practices=person.activity.forage;
  stepWorld(world); assert.equal(tile.food,remaining); assert.equal(person.inventory,0.25);
  assert.equal(person.activity.forage,practices);
});

test('depleting a work site makes a forager choose another site without teleporting or carrying old work', () => {
  const {world,person}=scene();
  for (const tile of world.tiles) tile.food=0;
  const next=tileAt(world,{x:38,y:12})!; next.food=0.5;
  person.command={order:'forage',x:person.x,y:person.y}; person.controlMode='directed';
  stepWorld(world);
  assert.deepEqual(person.target,{x:38,y:12}); assert.equal(person.x,36);
  assert.equal(person.work,0); assert.equal(person.inventory,0);
});

test('the forage command crosses both allowlists and ends after one paid harvest; urgent thirst still interrupts', () => {
  const {world,person,tile}=scene(); person.action='rest'; person.work=0;
  const command={id:'forage-command-test',kind:'command' as const,agentId:person.id,order:'forage' as const,x:person.x,y:person.y};
  assert.ok(parseGesture(command));
  assert.equal(stepWorld(world,[command])[0]!.accepted,true);
  for(let n=0;n<17;n++) stepWorld(world);
  assert.ok(person.inventory>0); assert.equal(person.command,null); assert.equal(person.controlMode,'auto');
  person.thirst=0.99; tile.drinkingWater=0.5;
  assert.equal(stepWorld(world,[{...command,id:'urgent-forage-command'}])[0]!.accepted,true);
  assert.equal(person.action,'drink'); assert.ok(person.thirst<0.99); assert.equal(world.people[2]!.command?.order,'forage');
});

function familyScene() {
  const world=createWorld(51926), a=world.people[2]!, b=world.people[3]!;
  for(const p of world.people) {
    p.x=10; p.y=20; p.target={x:10,y:20}; p.action='rest'; p.decisionAt=10000;
    p.hunger=p.thirst=p.fatigue=0.1; p.energy=0.95;
  }
  const id='test-family';
  for(const p of [a,b]) {
    p.x=17; p.y=13; p.target={x:17,y:13}; p.inventory=0; p.decisionAt=0;
    p.communityId=id; p.lastBirth=-2400;
  }
  a.bonds[b.id]=b.bonds[a.id]=0.7;
  world.communities=[{id,name:'Familia de prueba',x:17,y:13,color:'#aabbcc',members:[a.id,b.id],culture:{...a.culture},formedAt:0,cooperation:0,disputes:0}];
  world.communityCounter=1; world.tick=4800;
  for(const p of world.people) p.demography.age=world.tick-p.bornAt;
  tileAt(world,a)!.food=0.8;
  return {world,a,b};
}

test('an autonomous local pair prepares real food before a costly birth; a depleted environment cannot fund it', () => {
  const {world,a,b}=familyScene(), empty=cloneWorld(world);
  for(const tile of empty.tiles) { tile.food=0; tile.vegetation=0; tile.moisture=0; tile.drinkingWater=0; }
  empty.animals=[];
  for(let n=0;n<120;n++) { stepWorld(world); stepWorld(empty); }
  assert.ok((a.activity.forage??0)>0 && (b.activity.forage??0)>0);
  assert.equal(world.birthCounter,1); assert.equal(empty.birthCounter,0);
  const child=world.people.at(-1)!;
  assert.deepEqual(child.genome.parents,[a.id,b.id]); assert.deepEqual(child.skills,{});
  near(a.inventory+b.inventory+child.inventory,world.totals.foodHarvested!-0.06);
  assert.ok(world.totals.foodHarvested!>=0.24);
});

test('stored resources cannot bypass mutual trust at the birth boundary', () => {
  const {world,a,b}=familyScene(); world.tick=5999;
  for(const p of world.people) { p.demography.age=world.tick-p.bornAt; p.decisionAt=10000; }
  a.inventory=b.inventory=0.2; b.bonds[a.id]=0;
  const mutual=cloneWorld(world); mutual.people[3]!.bonds[a.id]=0.3;
  stepWorld(world); stepWorld(mutual);
  assert.equal(world.birthCounter,0); assert.equal(mutual.birthCounter,1);
  near(a.inventory+b.inventory,0.4);
  assertWorld(world); assertWorld(mutual);
});
