import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWorld, assertWorld, stepWorld } from '../src/world/index.js';
import { decodeSnapshot, encodeSnapshot } from '../src/server/snapshot.js';
import { Store } from '../src/server/store.js';

test('compact snapshots round-trip every scalar exactly and substantially reduce repeated JSON keys', () => {
  const world=createWorld(51926);for(let i=0;i<21;i++)stepWorld(world);
  const tile=world.tiles[0]!;tile.food=Number.MIN_VALUE;tile.moisture=0.12345678901234567;tile.wood=0;tile.stone=0;tile.drinkingWater=0;tile.species=undefined;tile.fauna=0;
  world.retiredChunks=[];
  const plain=JSON.stringify(world),compact=encodeSnapshot(world);
  assert.deepEqual(decodeSnapshot(compact),JSON.parse(plain));assert.ok(compact.length<plain.length*0.75);
  assert.deepEqual(decodeSnapshot(plain),JSON.parse(plain));assertWorld(decodeSnapshot(compact));
});

test('unknown tuple versions, truncated rows and semantically malformed fields fail closed even with a matching checksum', () => {
  const w=createWorld(),encoded=JSON.parse(encodeSnapshot(w));
  assert.throws(()=>decodeSnapshot(JSON.stringify({...encoded,tileEncoding:'future-v999'})));
  const short=structuredClone(encoded);short.tiles[0].pop();assert.throws(()=>decodeSnapshot(JSON.stringify(short)));
  const malformed=structuredClone(encoded);malformed.tiles[0][16]='a-lake';const body=JSON.stringify(malformed);
  const store=new Store(':memory:');try{store.save(w);store.db.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=0').run(body,createHash('sha256').update(body).digest('hex'));assert.throws(()=>store.load());}finally{store.close();}
});

test('invalid genealogies, incomplete history and asymmetric community membership are rejected', () => {
  for(const mutate of [
    (w:ReturnType<typeof createWorld>)=>{w.history=[{tick:0,population:16} as never];},
    (w:ReturnType<typeof createWorld>)=>{w.people[2]!.genome.parents=['missing','missing'];w.people[2]!.genome.generation=5;},
    (w:ReturnType<typeof createWorld>)=>{w.people[2]!.genome.parents=['s','i'];w.people[2]!.genome.generation=1;},
    (w:ReturnType<typeof createWorld>)=>{w.people[2]!.communityId='one';w.communities=[{id:'one',name:'one',x:17,y:13,color:'#ffffff',culture:{} as never,members:[],formedAt:0,cooperation:0,disputes:0}];},
  ]){const w=createWorld();mutate(w);assert.throws(()=>assertWorld(w));}
});

test('non-finite and null optional values cannot be mistaken for absent resources or replace the committed checkpoint', () => {
  const w=createWorld(),store=new Store(':memory:');
  try {
    store.save(w);const before=store.load();
    for(const field of ['wood','stone','elevation','drinkingWater'] as const)for(const value of [NaN,Infinity,null]){
      const invalid=structuredClone(w);(invalid.tiles[0] as unknown as Record<string,unknown>)[field]=value;
      assert.throws(()=>store.save(invalid));assert.deepEqual(store.load(),before);
    }
    const optional=structuredClone(w);delete optional.tiles[0]!.wood;delete optional.tiles[0]!.stone;delete optional.tiles[0]!.elevation;
    store.save(optional);assert.deepEqual(store.load()!.world,optional);
  }finally{store.close();}
});

test('a resumed world continues identically when sharing updates a place and its regional metadata', () => {
  const world=createWorld(51926),donor=world.people[2]!,recipient=world.people[3]!;
  donor.x=recipient.x=17;donor.y=recipient.y=13;donor.action='share';donor.inventory=0.2;donor.hunger=0.1;donor.thirst=0.1;donor.decisionAt=100;donor.target={x:17,y:13};
  recipient.action='rest';recipient.hunger=0.6;recipient.decisionAt=100;recipient.target={x:17,y:13};
  const resumed=decodeSnapshot(encodeSnapshot(world)) as typeof world;
  stepWorld(world);stepWorld(resumed);assert.deepEqual(resumed,world);
  assert.ok(world.places.find(p=>p.id==='claro')!.gatherings>0);
});
