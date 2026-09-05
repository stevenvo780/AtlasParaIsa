import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, fingerprint } from '../src/server/store.js';
import { createWorld, type World } from '../src/world/index.js';
import { generateChunk, type Chunk } from '../src/world/terrain.js';
import type { Gesture, GestureResult } from '../src/shared/types.js';

const digest = (body: string): string => createHash('sha256').update(body).digest('hex');
const gesture: Gesture = { id: 'archive-command-01', kind: 'command', x: 20, y: 14, agentId: 's', order: 'move' };
const resultAt = (tick: number): GestureResult => ({ id: gesture.id, accepted: true, tick, order: 0, message: 'Orden sintética guardada.' });

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
  const world = createWorld(42); world.tick = 11;
  const first = archived(world, 11, 0.12345);
  world.retiredChunks = [first];
  const expected: World = { ...structuredClone(world), retiredChunks: [] };
  store.save(world);
  assert.deepEqual(world, expected);
  assert.deepEqual(store.load()!.world, expected);
  assert.deepEqual(store.loadChunk(first.key), first);
  assert.deepEqual(JSON.parse((store.db.prepare('SELECT body FROM snapshots WHERE slot=0').get() as { body: string }).body).retiredChunks, []);

  world.tick = 20;
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
  const draft = structuredClone(world); draft.tick = 1;
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
  const world = createWorld(42); world.tick = 2;
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
  const world = createWorld(42); world.tick = 4;
  const first = archived(world, 4, 0.22); world.retiredChunks = [first]; store.save(world);
  world.tick = 9;
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
  const world = createWorld(42); world.tick = 10;
  const first = archived(world, 10, 0.22); world.retiredChunks = [first]; store.save(world);
  const previous = structuredClone(world);
  world.tick = 20;
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
    cooperationEnabled: _cooperation, reproductionEnabled: _reproduction, communities: _communities, communityCounter: _communityCounter, birthCounter: _birthCounter, history: _history, totals: _totals, ...base } = source;
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
    assert.equal((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2);
    const migrated = store.load()!.world;
    assert.equal(migrated.version, 3); assert.equal(migrated.tick, legacy.tick); assert.equal(migrated.rng, legacy.rng);
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
    assert.equal(JSON.parse((store.db.prepare('SELECT body FROM snapshots WHERE slot=0').get() as { body: string }).body).version, 3);
  } finally { store.close(); }
});

test('read-only V1 recovery migrates the view without changing schema or creating an archive', t => {
  const dir = mkdtempSync(join(tmpdir(), 'carta-read-legacy-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'legacy.sqlite'); createV1Database(path);
  const store = new Store(path, { readOnly: true });
  try {
    assert.equal(store.load()!.world.version, 3);
    assert.equal(store.loadChunk('0,0'), null);
    assert.equal((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1);
    assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name='chunks'").get(), undefined);
    const destination = join(dir, 'recovered.sqlite'); store.previous(destination);
    const recovered = new Store(destination);
    try { assert.equal(recovered.load()!.world.version, 3); } finally { recovered.close(); }
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
