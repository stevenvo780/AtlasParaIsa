import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { cloneWorld, createWorld, stepWorld } from '../src/world/index.js';
import { activate } from '../src/world/spatial.js';
import { enableContinuousEcology } from '../src/world/offscreen-state.js';
import { prepareEcology } from '../src/world/offscreen.js';
import { materializeAnimals, syncFauna } from '../src/world/animals.js';
import { chunkKey } from '../src/world/terrain.js';

test('an untrusted SQL trigger cannot corrupt cold identities and receive a successful snapshot acknowledgement', () => {
  for (const temporary of [false, true]) {
    const store = new Store(':memory:');
    try {
      const opening = createWorld(42); enableContinuousEcology(opening); store.save(opening);
      const world = cloneWorld(opening, store.context);
      for (let n = 0; n < 12; n++) activate(world, (10 + n) * 16, 160, store.context);
      assert.equal(prepareEcology(world, store.context).ready, true); stepWorld(world, [], store.context); store.save(world);
      const beforeIds = store.db.prepare('SELECT * FROM ecology_identities ORDER BY id').all(); assert.ok(beforeIds.length > 0);
      store.db.exec(`CREATE ${temporary ? 'TEMP ' : ''}TRIGGER corrupt_ecology AFTER INSERT ON snapshots BEGIN DELETE FROM ecology_identities; END;`);
      const draft = cloneWorld(world, store.context);
      if (prepareEcology(draft, store.context).ready) stepWorld(draft, [], store.context);
      const pending = structuredClone(draft.ecology), row = store.db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get();
      assert.throws(() => store.save(draft), /trigger/i);
      assert.deepEqual(draft.ecology, pending); assert.deepEqual(store.db.prepare('SELECT * FROM ecology_identities ORDER BY id').all(), beforeIds);
      assert.deepEqual(store.db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get(), row);
      store.db.exec('DROP TRIGGER corrupt_ecology'); store.save(draft); assert.deepEqual(store.load()!.world, draft);
    } finally { store.close(); }
  }
});

test('a checksum-valid latest climate observation must agree with the committed snapshot weather', () => {
  const store = new Store(':memory:');
  try {
    const world = createWorld(42); enableContinuousEcology(world); store.save(world);
    assert.equal(world.weather, 'clear');
    const digest = createHash('sha256').update(JSON.stringify([0,'rain'])).digest('hex');
    store.db.prepare("UPDATE ecology_climate SET weather='rain',digest=? WHERE tick=0").run(digest);
    assert.throws(() => store.load(), /Ecology archive/);
  } finally { store.close(); }
});

test('previous removes newly observed historical deaths by event serial even when their physical tick is earlier', () => {
  const directory = mkdtempSync(join(tmpdir(),'atlas-offscreen-events-')),store = new Store(join(directory,'world.sqlite'));
  try {
    let world = createWorld(42); enableContinuousEcology(world); store.save(world);
    for (let pulse=0;pulse<3;pulse++) {
      const draft=cloneWorld(world,store.context);
      if(pulse===0) {
        for(let n=0;n<12;n++)activate(draft,(10+n)*16,160,store.context);
        const tile=draft.tiles.find(tile=>tile.x===21*16+8&&tile.y===168)!;
        tile.terrain='meadow';tile.fauna=1;tile.species='hare';
        const animal=materializeAnimals(draft.seed,[tile],draft.tick)[0]!;animal.thirst=1;animal.health=.001;
        draft.animals.push(animal);
      }
      assert.equal(prepareEcology(draft,store.context).ready,true);stepWorld(draft,[],store.context);store.save(draft);world=draft;
    }
    const previous=structuredClone(world),draft=cloneWorld(world,store.context);
    prepareEcology(draft,store.context);store.save(draft);
    const late=draft.events.filter(event=>Number(event.id.slice(1))>previous.eventCounter&&event.tick<previous.tick);
    assert.ok(late.length>0);assert.equal(draft.tick,previous.tick);
    const destination=join(directory,'previous.sqlite');store.previous(destination);
    const recovered=new Store(destination,{readOnly:true});
    try {
      assert.equal(recovered.load()!.world.ecology!.revision,previous.ecology!.revision);
      for(const event of late)assert.equal(recovered.db.prepare('SELECT 1 FROM events WHERE id=?').get(event.id),undefined);
      for(const event of previous.events)assert.ok(recovered.db.prepare('SELECT 1 FROM events WHERE id=?').get(event.id));
    } finally {recovered.close();}
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});

test('a cold cohort records all 128 paid births durably even when they exceed the visual event ring', () => {
  const store=new Store(':memory:');
  try {
    let world=createWorld(42);enableContinuousEcology(world);store.save(world);
    for(let pulse=0;pulse<3;pulse++) {
      const draft=cloneWorld(world,store.context);
      if(pulse===0) {
        for(let n=0;n<12;n++)activate(draft,(10+n)*16,160,store.context);
        draft.animals=draft.animals.filter(animal=>chunkKey(animal.x,animal.y)!=='21,10');
        for(const tile of draft.tiles.filter(tile=>chunkKey(tile.x,tile.y)==='21,10')) {
          tile.terrain='meadow';tile.growth=1;tile.drinkingWater=1;tile.fauna=(tile.x+tile.y)%2===0?2:0;
          if(!tile.fauna){delete tile.species;continue;}
          tile.species='hare';
          const parents=materializeAnimals(draft.seed,[tile],draft.tick);
          for(const parent of parents){parent.hunger=parent.thirst=.2;parent.energy=1;parent.health=1;parent.action='rest';parent.lastDecision=parent.lastMove=0;parent.target={x:parent.x,y:parent.y};}
          draft.animals.push(...parents);
        }
      }
      prepareEcology(draft,store.context);stepWorld(draft,[],store.context);store.save(draft);world=draft;
    }
    const draft=cloneWorld(world,store.context),before=draft.animalDynamics.births;
    prepareEcology(draft,store.context);
    assert.equal(draft.animalDynamics.births-before,128);
    const events=structuredClone(draft.ecology!.pendingEvents);
    assert.equal(events.length,128);assert.equal(draft.events.length,120);
    assert.ok(events.every(event=>event.tick===1&&event.observedAt===3));
    const region=draft.ecology!.pending.find(item=>item.key==='21,10')!.chunk!;
    assert.equal(region.animals!.filter(animal=>animal.generation>0).length,128);
    assert.ok(draft.animalDynamics.waterConsumed>=128*.012);assert.ok(draft.animalDynamics.plantConsumed>=128*.06);
    store.save(draft);assert.equal(draft.ecology!.pendingEvents.length,0);
    for(const event of events)assert.deepEqual(JSON.parse(store.db.prepare('SELECT body FROM events WHERE id=?').get(event.id)!.body as string),event);
    assert.deepEqual(store.load()!.world,draft);
  } finally {store.close();}
});

test('a synchronized seam charges its work budget and transfers one real animal between active and cold storage', () => {
  const store=new Store(':memory:');
  try {
    const initial=createWorld(42);enableContinuousEcology(initial);store.save(initial);
    const world=cloneWorld(initial,store.context);activate(world,48,0,store.context);
    world.animals=world.animals.filter(animal=>animal.x<40);
    for(const tile of world.tiles.filter(tile=>tile.x>=40)) {tile.terrain='meadow';tile.drinkingWater=tile.x<48?0:.8;}
    const tile=world.tiles.find(tile=>tile.x===47&&tile.y===8)!;tile.species='hare';tile.fauna=1;
    const traveler=materializeAnimals(world.seed,[tile],world.tick)[0]!;traveler.thirst=.8;world.animals.push(traveler);syncFauna(world.tiles,world.animals);
    const energy=traveler.energy,prepared=prepareEcology(world,store.context);
    assert.equal(prepared.ready,true);assert.ok(world.ecology!.preparedSeams.includes('3,0'));
    stepWorld(world,[],store.context);store.save(world);
    assert.equal(world.ecology!.workedChunkTicks,1);assert.equal(world.ecology!.migrations,1);
    assert.equal(world.animals.filter(animal=>animal.id===traveler.id).length,0);
    const cold=store.ecologyArchive.read('3,0',world.ecology!.revision)!;
    const arrived=cold.animals!.filter(animal=>animal.id===traveler.id);assert.equal(arrived.length,1);
    assert.equal(arrived[0]!.x,48);assert.ok(arrived[0]!.energy<energy-.0015);assert.equal(cold.lastTick,world.tick);
    assert.deepEqual(store.load()!.world,world);
  } finally {store.close();}
});

test('previous refuses inherited SQL triggers before creating a recovery copy', () => {
  const directory=mkdtempSync(join(tmpdir(),'atlas-offscreen-recovery-trigger-')),store=new Store(join(directory,'world.sqlite'));
  try {
    const world=createWorld(42);enableContinuousEcology(world);store.save(world);
    const draft=cloneWorld(world,store.context);prepareEcology(draft,store.context);stepWorld(draft,[],store.context);store.save(draft);
    store.db.exec('CREATE TRIGGER corrupt_recovery AFTER UPDATE ON snapshots BEGIN DELETE FROM ecology_climate; END;');
    const destination=join(directory,'previous.sqlite');
    let failure: unknown;
    try {store.previous(destination);} catch(error) {failure=error;}
    assert.equal(existsSync(destination),false);assert.ok(failure instanceof Error && /trigger/i.test(failure.message));
    assert.deepEqual(store.load()!.world,draft);
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});
