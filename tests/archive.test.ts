import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, fingerprint } from '../src/server/store.js';
import { createWorld, RULES_VERSION, assertWorld, migrateWorld, projectWorld, type World } from '../src/world/index.js';
import { activate, maintainRegions } from '../src/world/spatial.js';
import { harvestAt, materializeAnimals, syncFauna, stepAnimals, MAX_ACTIVE_ANIMALS } from '../src/world/animals.js';
import { decodeSnapshot,encodeSnapshot } from '../src/server/snapshot.js';
import { generateChunk, type Chunk } from '../src/world/terrain.js';
import type { Gesture, GestureResult } from '../src/shared/types.js';

const digest = (body: string): string => createHash('sha256').update(body).digest('hex');
const gesture: Gesture = { id: 'archive-command-01', kind: 'command', x: 20, y: 14, agentId: 's', order: 'move' };
const resultAt = (tick: number): GestureResult => ({ id: gesture.id, accepted: true, tick, order: 0, message: 'Orden sintética guardada.' });

/** Archive fixtures hold bodies fixed while choosing an explicit historical timestamp. */
function fixtureTick(world: World, tick: number): void { world.tick=tick; for(const person of world.people) person.demography.age=tick-person.bornAt; }

function archived(world: World, tick: number, food: number): Chunk {
  const chunk = generateChunk(world.seed, -4, 7);
  chunk.discovered = true; chunk.lastTick = tick;
  chunk.tiles[0]!.food = food;
  return chunk;
}

function fixture(t: { after: (callback: () => void) => void }): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'carta-archive-'));
  const store = new Store(join(dir, 'world.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, dir };
}

test('archive versions restore exact edited terrain at the latest permitted world tick', t => {
  const { store } = fixture(t);
  const world = createWorld(42); fixtureTick(world,11);
  const first = archived(world, 11, 0.12345);
  world.retiredChunks = [first];
  const expected: World = { ...structuredClone(world), retiredChunks: [] };
  store.save(world);
  assert.deepEqual(world, expected);
  assert.deepEqual(store.load()!.world, expected);
  assert.deepEqual(store.loadChunk(first.key), first);
  assert.deepEqual(JSON.parse((store.db.prepare('SELECT body FROM snapshots WHERE slot=0').get() as { body: string }).body).retiredChunks, []);

  fixtureTick(world,20);
  const second = archived(world, 20, 0.0123);
  world.retiredChunks = [second]; store.save(world);
  assert.equal(store.loadChunk(first.key, 10), null);
  assert.deepEqual(store.loadChunk(first.key, 11), first);
  assert.deepEqual(store.loadChunk(first.key, 19), first);
  assert.deepEqual(store.loadChunk(first.key, 20), second);
  assert.deepEqual(store.loadChunk(first.key), second);
  assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n, 2);
});

test('input failure rolls back archive, world, events and ledger while preserving the pending caller queue', t => {
  const { store } = fixture(t);
  const world = createWorld(42); store.save(world);
  const before = store.load();
  const draft = structuredClone(world); fixtureTick(draft,1);
  const chunk = archived(draft, 1, 0.42); draft.retiredChunks = [chunk];
  const eventId = `e${++draft.eventCounter}`;
  draft.events.push({ id: eventId, tick: 1, kind: 'discovery', actors: [], source: 'simulation', text: 'Hallazgo sintético.', cause: 'Escena de rollback del archivo.' });
  const uncommitted = structuredClone(draft);
  store.db.exec("CREATE TRIGGER fail_archive_input BEFORE INSERT ON inputs BEGIN SELECT RAISE(ABORT, 'injected archive transaction failure'); END;");
  assert.throws(() => store.save(draft, [{ gesture, result: resultAt(1) }]), /injected archive transaction failure/);
  assert.deepEqual(draft, uncommitted, 'failure must preserve the full caller state and pending chunks');
  assert.deepEqual(store.load(), before);
  assert.equal(store.loadChunk(chunk.key), null);
  assert.equal(store.result(gesture), null);
  assert.equal(store.db.prepare('SELECT id FROM events WHERE id=?').get(eventId), undefined);

  store.db.exec('DROP TRIGGER fail_archive_input');
  store.save(draft, [{ gesture, result: resultAt(1) }]);
  assert.deepEqual(draft.retiredChunks, []);
  assert.deepEqual(store.loadChunk(chunk.key), chunk);
  assert.deepEqual(store.result(gesture), resultAt(1));
});

test('archive checksum and structural corruption fail closed instead of generating replacement terrain', t => {
  const { store } = fixture(t);
  const world = createWorld(42); fixtureTick(world,2);
  const chunk = archived(world, 2, 0.1); world.retiredChunks = [chunk]; store.save(world);
  store.db.exec("UPDATE chunks SET body='{}'");
  assert.throws(() => store.loadChunk(chunk.key), /checksum/);
  const corrupt = structuredClone(chunk); corrupt.tiles[1]!.x = corrupt.tiles[0]!.x;
  const body = JSON.stringify(corrupt);
  store.db.prepare('UPDATE chunks SET body=?,digest=?').run(body, digest(body));
  assert.throws(() => store.loadChunk(chunk.key), /Invalid archived chunk state/);
  assert.throws(() => store.loadChunk('00,0'), /key/);
  assert.throws(() => store.loadChunk(chunk.key, NaN), /tick/);
  assert.throws(() => store.loadChunk(chunk.key, -1), /tick/);
});

test('backup retains terrain versions and reopening reproduces the archived edits', t => {
  const { store, dir } = fixture(t);
  const world = createWorld(42); fixtureTick(world,4);
  const first = archived(world, 4, 0.22); world.retiredChunks = [first]; store.save(world);
  fixtureTick(world,9);
  const second = archived(world, 9, 0.33); world.retiredChunks = [second]; store.save(world);
  const destination = join(dir, 'copy.sqlite'); store.backup(destination);
  const copy = new Store(destination, { readOnly: true });
  try {
    assert.deepEqual(copy.load()!.world, world);
    assert.deepEqual(copy.loadChunk(first.key, 4), first);
    assert.deepEqual(copy.loadChunk(first.key), second);
  } finally { copy.close(); }
});

test('previous recovery removes future terrain versions and inputs without altering the source', t => {
  const { store, dir } = fixture(t);
  const world = createWorld(42); fixtureTick(world,10);
  const first = archived(world, 10, 0.22); world.retiredChunks = [first]; store.save(world);
  const previous = structuredClone(world);
  fixtureTick(world,20);
  const second = archived(world, 20, 0.33); world.retiredChunks = [second];
  store.save(world, [{ gesture, result: resultAt(20) }]);
  store.addSession('synthetic-session-hash', Date.now() + 60_000);
  const destination = join(dir, 'previous.sqlite'); store.previous(destination);
  const recovered = new Store(destination);
  try {
    assert.deepEqual(recovered.load()!.world, previous);
    assert.deepEqual(recovered.loadChunk(first.key), first);
    assert.equal((recovered.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE tick>10').get() as { n: number }).n, 0);
    assert.equal(recovered.result(gesture), null);
    assert.equal(recovered.sessionValid('synthetic-session-hash'), false);
    assert.deepEqual(store.loadChunk(first.key), second);
    assert.deepEqual(store.load()!.world, world);
    assert.deepEqual(store.result(gesture), resultAt(20));
    assert.equal(store.sessionValid('synthetic-session-hash'), true);
  } finally { recovered.close(); }
});

/** A genuine old shape: no chunk metadata, procedural resources or V2 person extensions. */
function legacyWorld() {
  const source = createWorld(42);
  const { chunks: _chunks, retiredChunks: _retired, discoveredChunks: _discovered, settlementCount: _settlements,
    adaptationEnabled: _adaptation, noveltyEnabled: _novelty, shelterBenefitEnabled: _shelter,
    cooperationEnabled: _cooperation, reproductionEnabled: _reproduction, communities: _communities, communityCounter: _communityCounter, birthCounter: _birthCounter, history: _history, totals: _totals,
    animals:_animals,animalCounter:_animalCounter,animalDynamics:_animalDynamics,blueprints:_blueprints,structures:_structures,blueprintCounter:_blueprintCounter,structureCounter:_structureCounter,inventionDynamics:_inventionDynamics,...base } = source;
  const legacy = {
    ...base, version: 1, tick: 37,
    tiles: source.tiles.filter(t => t.x >= 0 && t.x < 40 && t.y >= 0 && t.y < 28)
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map(({ x, y, terrain, moisture, vegetation, food }) => ({ x, y, terrain, moisture, vegetation, food })),
    places: source.places.filter(p => ['claro', 'refugio', 'huerta'].includes(p.id)),
    people: source.people.map(p => {
      const { traits: _traits, skills: _skills, materials: _materials, activity: _activity, values: _values,
        visited: _visited, heading: _heading, command: _command, work: _work, lastOutcome: _last, controlMode: _mode,
        specialty: _specialty, thirst: _thirst, genome: _genome, bornAt: _bornAt, lastBirth: _lastBirth, lastSocial: _lastSocial,
        lastDispute: _lastDispute, lastPracticeMemory: _lastPracticeMemory, culture: _culture, communityId: _communityId, bonds: _bonds, intentContext: _intentContext, ...old } = p;
      return old;
    }),
  };
  legacy.people[0]!.energy = 0.42; legacy.people[0]!.hunger = 0.43; legacy.people[0]!.fatigue = 0.44;
  legacy.people[0]!.recentMemory = 'Experiencia sintética del formato anterior.';
  legacy.people[0]!.experiences = [{ tick: 3, text: 'Experiencia sintética del formato anterior.', causeId: 'e1', placeId: 'claro' }];
  legacy.tiles[17 + 13 * 40]!.food = 0.123;
  return legacy;
}

const oldGesture: Gesture = { id: 'old-plant-0001', kind: 'plant', x: 17, y: 13 };
function createV1Database(path: string): ReturnType<typeof legacyWorld> {
  const legacy = legacyWorld(), body = JSON.stringify(legacy);
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE snapshots (slot INTEGER PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL, saved_at INTEGER NOT NULL);
      CREATE TABLE events (id TEXT PRIMARY KEY, tick INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE inputs (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, tick INTEGER NOT NULL, ordinal INTEGER NOT NULL, body TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA application_id=1128354388; PRAGMA user_version=1;`);
    db.prepare('INSERT INTO snapshots VALUES (0,?,?,?)').run(body, digest(body), 1000);
    db.prepare('INSERT INTO snapshots VALUES (1,?,?,?)').run(body, digest(body), 900);
    db.prepare("INSERT INTO metadata VALUES ('initialized','1')").run();
    const oldFingerprint = digest(JSON.stringify(['plant', 17, 13, null]));
    const oldResult = { id: oldGesture.id, accepted: true, tick: 12, order: 0, message: 'Gesto sintético anterior.' };
    db.prepare('INSERT INTO inputs VALUES (?,?,?,?,?,?)').run(oldGesture.id, oldFingerprint, 12, 0, JSON.stringify(oldGesture), JSON.stringify(oldResult));
  } finally { db.close(); }
  return legacy;
}

test('V1 schema migration preserves old snapshots, cells, bodies, experiences and gesture fingerprints', t => {
  const dir = mkdtempSync(join(tmpdir(), 'carta-migrate-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'legacy.sqlite'); const legacy = createV1Database(path);
  const store = new Store(path);
  try {
    assert.equal((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 3);
    const migrated = store.load()!.world;
    assert.equal(migrated.version, RULES_VERSION); assert.equal(migrated.tick, legacy.tick); assert.equal(migrated.rng, legacy.rng);
    for (const tile of legacy.tiles) {
      const restored = migrated.tiles.find(t => t.x === tile.x && t.y === tile.y)!;
      for (const [field, value] of Object.entries(tile)) assert.equal(restored[field as keyof typeof restored], value);
    }
    for (const [field, value] of Object.entries(legacy.people[0]!)) assert.deepEqual(migrated.people[0]![field as keyof World['people'][number]], value);
    assert.equal((store.db.prepare('SELECT body FROM snapshots WHERE slot=0').get() as { body: string }).body, JSON.stringify(legacy), 'schema migration must not rewrite the old evidence');
    assert.equal(store.result(oldGesture)!.tick, 12);
    assert.equal(fingerprint(oldGesture), digest(JSON.stringify(['plant', 17, 13, null])));
    assert.notEqual(fingerprint(gesture), fingerprint({ ...gesture, agentId: 'i' }));
    assert.notEqual(fingerprint(gesture), fingerprint({ ...gesture, order: 'rest' }));
    store.save(migrated);
    assert.equal(JSON.parse((store.db.prepare('SELECT body FROM snapshots WHERE slot=0').get() as { body: string }).body).version, RULES_VERSION);
  } finally { store.close(); }
});

test('read-only V1 recovery migrates the view without changing schema or creating an archive', t => {
  const dir = mkdtempSync(join(tmpdir(), 'carta-read-legacy-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'legacy.sqlite'); createV1Database(path);
  const store = new Store(path, { readOnly: true });
  try {
    assert.equal(store.load()!.world.version, RULES_VERSION);
    assert.equal(store.loadChunk('0,0'), null);
    assert.equal((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1);
    assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name='chunks'").get(), undefined);
    const destination = join(dir, 'recovered.sqlite'); store.previous(destination);
    const recovered = new Store(destination);
    try { assert.equal(recovered.load()!.world.version, RULES_VERSION); } finally { recovered.close(); }
    assert.equal((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1);
  } finally { store.close(); }
});

test('incomplete old schema is not upgraded and an incomplete V2 archive is not silently rebuilt', t => {
  const dir = mkdtempSync(join(tmpdir(), 'carta-schema-archive-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const legacyPath = join(dir, 'legacy.sqlite'); createV1Database(legacyPath);
  const broken = new DatabaseSync(legacyPath); broken.exec('DROP TABLE inputs'); broken.close();
  assert.throws(() => new Store(legacyPath), /schema is incomplete/);
  const check = new DatabaseSync(legacyPath, { readOnly: true });
  try {
    assert.equal((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1);
    assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='chunks'").get(), undefined);
  } finally { check.close(); }

  const path = join(dir, 'v2.sqlite'); const store = new Store(path); store.save(createWorld(42));
  store.db.exec('DROP TABLE chunks'); store.close();
  assert.throws(() => new Store(path), /Archive schema is incomplete/);
  const untouched = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(untouched.prepare("SELECT name FROM sqlite_master WHERE name='chunks'").get(), undefined); }
  finally { untouched.close(); }
});

test('V3 migration validates first and preserves bodies, culture, resources and exact individual stock without rewriting its source', () => {
  const source=createWorld(51926) as unknown as Record<string,unknown>;
  source.version=3;source.tick=120;
  for(const key of ['animals','animalCounter','animalDynamics','blueprints','structures','blueprintCounter','structureCounter','inventionDynamics'])delete source[key];
  const people=source.people as World['people'];people[2]!.skills={build:0.4};people[2]!.bonds.s=0.7;
  const tiles=source.tiles as World['tiles'];tiles[0]!.food=0;tiles[0]!.wood=0;tiles[0]!.drinkingWater=0;tiles[0]!.fauna=0;delete tiles[0]!.species;
  const before=structuredClone(source),migrated=migrateWorld(source);
  assert.deepEqual(source,before);assert.equal(migrated.version,RULES_VERSION);assert.deepEqual(migrated.people.map(({demography:_demography,technology:_technology,...person})=>person),people.map(({demography:_demography,technology:_technology,...person})=>person));assert.deepEqual(migrated.tiles,tiles);
  assert.equal(migrated.animals.length,tiles.reduce((sum,t)=>sum+(t.fauna??0),0));assert.deepEqual(migrateWorld(source),migrated);
  assert.ok(migrated.structures.every(s=>s.water===0&&s.food===0&&s.components.join(',')==='frame,roof'));
  const corrupt=structuredClone(source);(corrupt.tiles as World['tiles'])[0]!.drinkingWater=NaN;
  assert.throws(()=>migrateWorld(corrupt));assert.equal(corrupt.version,3);
  const manyRoofs=structuredClone(source);for(const tile of (manyRoofs.tiles as World['tiles']).slice(0,600))tile.terrain='shelter';
  const migratedRoofs=migrateWorld(manyRoofs);assert.equal(migratedRoofs.structures.length,(manyRoofs.tiles as World['tiles']).filter(t=>t.terrain==='shelter').length);assert.ok(migratedRoofs.structures.length>512);
});

test('V4 region retirement, storage and return preserve living identities, depleted stock, structures and resources exactly', t => {
  const {store}=fixture(t),world=createWorld(51926),originalPositions=world.people.map(p=>({x:p.x,y:p.y}));
  fixtureTick(world,10);
  const origin=world.tiles.filter(tile=>tile.x>=0&&tile.x<16&&tile.y>=0&&tile.y<16);
  for(const tile of origin){tile.fauna=0;delete tile.species;}
  const source=origin.find(t=>t.terrain!=='water'&&t.terrain!=='shelter')!;source.fauna=2;source.species='hare';
  world.animals=world.animals.filter(a=>!(a.x>=0&&a.x<16&&a.y>=0&&a.y<16));world.animals.push(...materializeAnimals(world.seed,[source],world.tick));syncFauna(world.tiles,world.animals);
  const removed=world.animals.find(a=>a.x===source.x&&a.y===source.y)!.id;assert.equal(harvestAt(world,source,'s'),0.12);
  source.food=0;source.drinkingWater=0;source.wood=0;
  const expectedAnimals=structuredClone(world.animals.filter(a=>a.x>=0&&a.x<16&&a.y>=0&&a.y<16));
  const expectedTiles=structuredClone(origin);
  const structure=world.structures[0]!;structure.condition=0.35;structure.uses=7;const expectedStructure=structuredClone(structure);
  for(const p of world.people){p.x=120;p.y=120;p.target={x:120,y:120};}
  maintainRegions(world);world.tiles.find(t=>t.x===120&&t.y===120)!.terrain='meadow';
  assert.equal(world.animals.some(a=>expectedAnimals.some(b=>a.id===b.id)),false);assert.ok(world.retiredChunks.find(c=>c.key==='0,0')!.animals);
  store.save(world);const resumed=store.load()!.world;
  const beforeCamera=structuredClone(resumed);const view=projectWorld(resumed,{x:0,y:0,width:40,height:28},{loadChunk:(k,t)=>store.loadChunk(k,t)});
  assert.ok(view.animals!.some(a=>a.id===expectedAnimals[0]!.id));assert.equal(view.animals!.some(a=>a.id===removed),false);assert.deepEqual(resumed,beforeCamera);
  fixtureTick(resumed,30000);for(const [i,p] of resumed.people.entries()){Object.assign(p,originalPositions[i]);p.target={x:p.x,y:p.y};}
  maintainRegions(resumed,{loadChunk:(k,t)=>store.loadChunk(k,t)});
  assert.deepEqual(resumed.tiles.filter(t=>t.x>=0&&t.x<16&&t.y>=0&&t.y<16),expectedTiles);
  assert.deepEqual(resumed.animals.filter(a=>a.x>=0&&a.x<16&&a.y>=0&&a.y<16),expectedAnimals);
  assert.deepEqual(resumed.structures.find(s=>s.id===expectedStructure.id),expectedStructure);assert.equal(resumed.animals.some(a=>a.id===removed),false);
  const returning=expectedAnimals[0]!;fixtureTick(resumed,resumed.tick+1);stepAnimals(resumed);
  assert.equal(resumed.animals.find(a=>a.id===returning.id)!.age,returning.age+1,'dormant time cannot become biological aging or a backlog');
  assertWorld(resumed);
});

test('empty V4 archives stay empty, while old stock materializes lazily only on activation and malformed life fails closed', t => {
  const {store}=fixture(t),world=createWorld(51926);fixtureTick(world,10);
  const legacy=archived(world,10,0);for(const tile of legacy.tiles){tile.fauna=0;delete tile.species;}legacy.tiles[0]!.fauna=2;legacy.tiles[0]!.species='hare';
  world.retiredChunks=[legacy];store.save(world);const before=structuredClone(world);
  const camera={x:legacy.cx*16,y:legacy.cy*16,width:16,height:16};projectWorld(world,camera,{loadChunk:(k,t)=>store.loadChunk(k,t)});assert.deepEqual(world,before);
  activate(world,camera.x,camera.y,{loadChunk:(k,t)=>store.loadChunk(k,t)});
  assert.equal(world.animals.filter(a=>a.x===camera.x&&a.y===camera.y).length,2);
  const empty={...legacy,lifeVersion:4 as const,animals:[],structures:[]};for(const tile of empty.tiles){tile.fauna=0;delete tile.species;}
  world.retiredChunks=[empty];store.save(world);assert.deepEqual(store.loadChunk(empty.key)!.animals,[]);
  for(const field of ['animals','structures'] as const){const invalid=structuredClone(empty);delete invalid[field];const body=JSON.stringify(invalid);store.db.prepare('UPDATE chunks SET body=?,digest=? WHERE key=?').run(body,digest(body),empty.key);assert.throws(()=>store.loadChunk(empty.key));}
});

test('a structure counter cannot move backward behind an identity that only exists in an archived region', t=>{
  const {store}=fixture(t),world=createWorld(51926);fixtureTick(world,10);world.structureCounter=7;
  const chunk=archived(world,10,0),tile=chunk.tiles[0]!;tile.terrain='shelter';
  chunk.structures=[{...structuredClone(world.structures[0]!),id:'structure-7',x:tile.x,y:tile.y}];world.retiredChunks=[chunk];store.save(world);
  assert.equal(store.load()!.world.structureCounter,7);
  const saved=store.db.prepare('SELECT body FROM snapshots WHERE slot=0').get() as {body:string};const invalid=decodeSnapshot(saved.body) as World;invalid.structureCounter=6;
  const body=encodeSnapshot(invalid);store.db.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=0').run(body,digest(body));
  assert.throws(()=>store.load(),/Archived structure identity exceeds snapshot counter/);
});

test('activating another region above the per-step animal budget preserves every identity and advances a bounded cohort',()=>{
  const world=createWorld(42);world.animals=[];world.reproductionEnabled=false;
  for(let cy=0;cy<4;cy++)for(let cx=0;cx<4;cx++)activate(world,cx*16,cy*16);
  let remaining=MAX_ACTIVE_ANIMALS;for(const tile of world.tiles){tile.fauna=Math.min(6,remaining);remaining-=tile.fauna;if(tile.fauna)tile.species=tile.terrain==='water'?'fish':'hare';else delete tile.species;}
  world.animals=materializeAnimals(world.seed,world.tiles,world.tick);assert.equal(world.animals.length,MAX_ACTIVE_ANIMALS);
  for(let cx=10;cx<30&&world.animals.length===MAX_ACTIVE_ANIMALS;cx++)activate(world,cx*16,0);
  assert.ok(world.animals.length>MAX_ACTIVE_ANIMALS);const ages=new Map(world.animals.map(a=>[a.id,a.age]));fixtureTick(world,world.tick+1);stepAnimals(world);
  assert.equal(world.animals.length,ages.size);assert.equal(world.animals.reduce((sum,a)=>sum+a.age-ages.get(a.id)!,0),MAX_ACTIVE_ANIMALS);assertWorld(world);
});
