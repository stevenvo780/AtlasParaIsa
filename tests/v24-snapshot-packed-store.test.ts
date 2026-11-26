import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { encodePackedPeoplePage } from '../src/server/snapshot-packed-people.js';
import { hasCanonicalSnapshotPartsPrefix, readStoredSnapshot, SnapshotParts } from '../src/server/snapshot-parts.js';
import { SnapshotPhysicalError, SnapshotSemanticError } from '../src/server/snapshot.js';
import { Store } from '../src/server/store.js';
import { stringifyExact } from '../src/shared/exact-json.js';
import { createWorld, type World } from '../src/world/index.js';
import { parseParams } from '../src/world/params.js';
import { founderPolicy } from '../src/world/politica.js';
import { directorioTemporal, filaInstantanea, sha256, todasLasTablas } from './lib/store.js';

interface Page { index: number; digest: string; count: number; bytes: number }
interface Pages { count: number; pages: Page[] }
interface Manifest {
  snapshotEncoding: string; world: Record<string, unknown>; tiles: Pages; people: Pages; animals: Pages;
}
const params = parseParams('v23.guardadoCompleto=true');
const manifest = (body: string): Manifest => JSON.parse(body) as Manifest;
const bodyPage = (db: DatabaseSync, page: Page): string | Uint8Array =>
  db.prepare('SELECT body FROM main.snapshot_parts WHERE digest=?').get(page.digest)!.body as string | Uint8Array;
const pageSlot = (db: DatabaseSync, slot = 0): Page => manifest(filaInstantanea(db, slot).body).people.pages[0]!;

test('WPG3 conserva orden y bytes con BLOB solo en personas y lee los tres formatos', () => {
  const db = new DatabaseSync(':memory:');
  try {
    SnapshotParts.install(db);
    db.exec('BEGIN');
    const packed = new SnapshotParts(db, 5, undefined, 8 * 1024, true);
    const legacy = new SnapshotParts(db, 5, undefined, 8 * 1024);
    const world = createWorld(42, params);
    world.people.reverse();
    world.people[0]!.name += ' ñ ✳';
    world.people[0]!.inventory = -0;
    const policy = world.people[0]!.policy = founderPolicy(42, world.people[0]!.id);
    policy.weights[0] = -0;
    world.animals[0]!.work = -0;
    const original = legacy.write(legacy.prepare(world, params, 0));
    Object.defineProperty(world.people, 'toJSON', { value: () => { throw new Error('colección entera'); } });
    const written = packed.write(packed.prepare(world, params, 0));
    assert.ok(hasCanonicalSnapshotPartsPrefix(written.body));
    assert.equal(written.digest, sha256(written.body));
    const decoded = manifest(written.body);
    assert.equal(decoded.snapshotEncoding, 'snapshot-parts-v3');
    assert.equal(decoded.world.people, null);
    assert.equal(decoded.world.animals, null);
    assert.ok(decoded.people.pages.length > 1);
    let withWeights = 0, bytes = Buffer.byteLength(written.body);
    for (const field of ['tiles', 'people', 'animals'] as const) {
      for (const page of decoded[field].pages) {
        const body = bodyPage(db, page);
        if (field === 'people') {
          assert.ok(body instanceof Uint8Array);
          const binary = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
          assert.equal(binary.toString('ascii', 0, 4), 'WPF1');
          withWeights += binary.readUInt32LE(12);
          assert.ok(page.bytes <= 8 * 1024 || page.count === 1);
        } else assert.equal(typeof body, 'string');
        assert.equal(page.digest, sha256(body));
        assert.equal(page.bytes, Buffer.byteLength(body));
        bytes += page.bytes;
      }
    }
    assert.equal(withWeights, 1);
    assert.equal(written.bytes, bytes);
    packed.verify(written.body);
    const loaded = legacy.readWithInfo(written.body);
    assert.equal(loaded.bytes, written.bytes);
    assert.equal(stringifyExact(loaded.value), stringifyExact(packed.read(original.body)));
    assert.ok(Object.is((loaded.value as World).people[0]!.policy!.weights[0], -0));
    assert.ok(Object.is((loaded.value as World).people[0]!.inventory, -0));
    assert.ok(Object.is((loaded.value as World).animals[0]!.work, -0));

    const ordinary = createWorld(42), ordinaryParams = parseParams('');
    const paged = packed.write(packed.prepare(ordinary, ordinaryParams, 0));
    assert.equal(manifest(paged.body).snapshotEncoding, 'snapshot-parts-v1');
    const inline = packed.write(packed.prepare(ordinary, ordinaryParams, Infinity));
    packed.verify(inline.body);
    assert.equal(stringifyExact(legacy.read(paged.body)), stringifyExact(packed.read(inline.body)));

    const textPage = decoded.tiles.pages[0]!;
    db.prepare('UPDATE snapshot_parts SET body=CAST(body AS BLOB) WHERE digest=?').run(textPage.digest);
    assert.throws(() => packed.read(written.body), SnapshotPhysicalError);
    db.exec('ROLLBACK');
  } finally { db.close(); }
});

test('WPG3 rechaza descriptores, JSON y tipo de página alterados incluso con checksum nuevo', () => {
  const db = new DatabaseSync(':memory:');
  try {
    SnapshotParts.install(db);
    db.exec('BEGIN');
    const parts = new SnapshotParts(db, 5, undefined, undefined, true);
    const world = createWorld(42, params);
    const written = parts.write(parts.prepare(world, params, 0));
    const badBytes = manifest(written.body);
    badBytes.people.pages[0]!.bytes++;
    assert.throws(() => parts.read(JSON.stringify(badBytes)), /page byte count/);
    const badCount = manifest(written.body);
    badCount.people.pages[0]!.count = badCount.people.count = 0xffff_ffff;
    assert.throws(() => parts.read(JSON.stringify(badCount)), /organism page descriptor/);
    for (const [json, disagreement] of [
      ['{"id":"a","id":"b"}', SnapshotSemanticError],
      ['{"id":}', SnapshotPhysicalError],
      ['{"id":"a","data":{"a":0,"\\u0061":0}}', SnapshotSemanticError],
    ] as const) {
      const body = encodePackedPeoplePage([{ json, bytes: Buffer.byteLength(json) }]);
      const digest = sha256(body);
      db.prepare('INSERT INTO snapshot_parts VALUES (?,?)').run(digest, body);
      const value = manifest(written.body);
      value.people = { count: 1, pages: [{ index: 0, digest, bytes: body.byteLength, count: 1 }] };
      assert.throws(() => parts.verify(JSON.stringify(value)), disagreement);
    }
    const page = manifest(written.body).people.pages[0]!;
    db.prepare('UPDATE snapshot_parts SET body=CAST(body AS TEXT) WHERE digest=?').run(page.digest);
    assert.throws(() => parts.read(written.body), SnapshotPhysicalError);
    db.exec('ROLLBACK');
  } finally { db.close(); }
});

test('WPG3 separa una persona histórica de más de 4 MiB', () => {
  const db = new DatabaseSync(':memory:');
  try {
    SnapshotParts.install(db);
    db.exec('BEGIN');
    const parts = new SnapshotParts(db, 5, undefined, undefined, true);
    const world = createWorld(42, params);
    const note = 'ñ'.repeat(2 * 1024 * 1024);
    Object.assign(world.people[1]!, { note });
    const written = parts.write(parts.prepare(world, params, 0));
    const value = manifest(written.body);
    const large = value.people.pages.filter(page => page.bytes > 4 * 1024 * 1024);
    assert.equal(large.length, 1);
    assert.equal(large[0]!.count, 1);
    const loaded = parts.read(written.body) as World;
    assert.deepEqual(loaded.people.map(p => p.id), world.people.map(p => p.id));
    assert.equal((loaded.people[1] as { note?: string }).note, note);
    large[0]!.count++;
    value.people.count++;
    assert.throws(() => parts.read(JSON.stringify(value)), /organism page descriptor/);
    db.exec('ROLLBACK');
  } finally { db.close(); }
});

test('Store conserva slots WPG2 y WPG3 y revierte si un trigger daña una página binaria', t => {
  const directory = directorioTemporal(t, 'atlas-wpg3-'), path = join(directory, 'world.sqlite');
  const world = createWorld(42, params);
  const inventory = world.people[0]!.inventory;
  const old = new Store(path);
  try {
    old.guardar({ world, materia: null });
    assert.equal(manifest(filaInstantanea(old).body).snapshotEncoding, 'snapshot-parts-v2');
    old.db.exec('INSERT INTO snapshots SELECT 2,body,digest,saved_at FROM snapshots WHERE slot=0');
    old.db.exec('INSERT INTO snapshot_matter SELECT 2,world_digest,body FROM snapshot_matter WHERE slot=0');
  } finally { old.close(); }
  const store = new Store(path, { snapshotPackedPeople: true });
  try {
    const { db } = store;
    const save = (value: number) => {
      world.people[0]!.inventory = value;
      store.guardar({ world, materia: null });
      assert.equal(manifest(filaInstantanea(store).body).snapshotEncoding, 'snapshot-parts-v3');
      return pageSlot(db);
    };
    const noLongerUsed = save(0.137), previous = save(0.148), current = save(0.159);
    assert.equal(db.prepare('SELECT 1 FROM snapshot_parts WHERE digest=?').get(noLongerUsed.digest), undefined);
    assert.equal(pageSlot(db, 1).digest, previous.digest);
    const archive = readStoredSnapshot(db, 2)!;
    assert.equal((archive.value as World).people[0]!.inventory, inventory);
    const read = readStoredSnapshot(db)!;
    assert.equal((read.value as World).people[0]!.inventory, 0.159);
    assert.equal(read.snapshotBytes, store.lastSnapshotBytes);

    const binary = bodyPage(db, current);
    assert.ok(binary instanceof Uint8Array);
    const corrupt = Uint8Array.from(binary);
    corrupt[0] = corrupt[0]! ^ 1;
    db.prepare('UPDATE snapshot_parts SET body=? WHERE digest=?').run(corrupt, current.digest);
    assert.throws(() => readStoredSnapshot(db), SnapshotPhysicalError);
    assert.equal(store.verificarGuardado()!.slot, 1);
    db.prepare('UPDATE snapshot_parts SET body=? WHERE digest=?').run(binary, current.digest);

    db.exec("CREATE TRIGGER corrupt_wpg3 AFTER INSERT ON snapshots WHEN NEW.slot=0 BEGIN "
      + "UPDATE snapshot_parts SET body=X'00' WHERE digest=json_extract(NEW.body,'$.people.pages[0].digest'); END");
    const before = todasLasTablas(store);
    assert.throws(() => save(0.161), SnapshotPhysicalError);
    assert.deepEqual(todasLasTablas(store), before);
    db.exec('DROP TRIGGER corrupt_wpg3');
    assert.equal(store.verificarGuardado()!.slot, 0);

    const destination = join(directory, 'previous.sqlite');
    assert.equal(store.previous(destination), 1);
    const recovered = new Store(destination);
    try {
      assert.equal(recovered.verificarGuardado()!.world.people[0]!.inventory, 0.148);
      assert.equal(pageSlot(recovered.db).digest, previous.digest);
    } finally { recovered.close(); }
  } finally { store.close(); }
  const resumed = new Store(path);
  try {
    world.people[0]!.inventory = 0.172;
    resumed.guardar({ world, materia: null });
    assert.equal(manifest(filaInstantanea(resumed).body).snapshotEncoding, 'snapshot-parts-v2');
    assert.equal((readStoredSnapshot(resumed.db)!.value as World).people[0]!.inventory, 0.172);
    assert.equal(manifest(filaInstantanea(resumed, 1).body).snapshotEncoding, 'snapshot-parts-v3');
    assert.equal((readStoredSnapshot(resumed.db, 1)!.value as World).people[0]!.inventory, 0.159);
    assert.equal((readStoredSnapshot(resumed.db, 2)!.value as World).people[0]!.inventory, inventory);
  } finally { resumed.close(); }
});
