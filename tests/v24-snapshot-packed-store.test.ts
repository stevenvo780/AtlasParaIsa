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
  policies?: Pages;
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

test('Store mezcla páginas WPF1 crudas y comprimidas entre slots y reabre sin la opción de escritura', t => {
  const path = join(directorioTemporal(t, 'atlas-wpg4-'), 'world.sqlite');
  const world = createWorld(42, params);
  const persona = world.people[0]!;
  persona.policy = founderPolicy(42, persona.id);
  persona.policy.weights[0] = -0;
  persona.inventory = 0.125;
  const anterior = new Store(path, { snapshotPackedPeople: true });
  try { anterior.guardar({ world, materia: null }); }
  finally { anterior.close(); }

  const store = new Store(path, { snapshotCompressedPeople: true });
  try {
    persona.inventory = -0;
    store.guardar({ world, materia: null });
    const viejo = manifest(filaInstantanea(store, 1).body);
    const actual = manifest(filaInstantanea(store).body);
    assert.equal(viejo.snapshotEncoding, 'snapshot-parts-v3');
    assert.equal(actual.snapshotEncoding, 'snapshot-parts-v4');
    const page = actual.people.pages[0]!;
    const body = bodyPage(store.db, page);
    assert.ok(body instanceof Uint8Array);
    assert.equal(Buffer.from(body.subarray(0, 4)).toString('ascii'), 'WZP1');
    assert.equal(sha256(body), page.digest);
    assert.equal(body.byteLength, page.bytes);
    assert.ok(page.bytes < viejo.people.pages[0]!.bytes);

    const alterada = Uint8Array.from(body);
    alterada[alterada.length - 1]! ^= 1;
    const reemplazar = store.db.prepare('UPDATE snapshot_parts SET body=? WHERE digest=?');
    reemplazar.run(alterada, page.digest);
    assert.throws(() => readStoredSnapshot(store.db), SnapshotPhysicalError);
    assert.equal(store.verificarGuardado()!.slot, 1);
    reemplazar.run(body, page.digest);
  } finally { store.close(); }

  const lector = new Store(path, { readOnly: true });
  try {
    const corte = lector.verificarGuardado()!;
    assert.equal(corte.slot, 0);
    assert.ok(Object.is(corte.world.people[0]!.inventory, -0));
    assert.ok(Object.is(corte.world.people[0]!.policy!.weights[0], -0));
    assert.equal((readStoredSnapshot(lector.db, 1)!.value as World).people[0]!.inventory, 0.125);
  } finally { lector.close(); }
});

test('WPG5 conserva las páginas de pesos entre cambios de estado y protege las versiones retenidas', t => {
  const directory = directorioTemporal(t, 'atlas-wpg5-'), path = join(directory, 'world.sqlite');
  const world = createWorld(42, params);
  const persona = world.people[0]!, policy = persona.policy = founderPolicy(42, persona.id);
  persona.uid = 2049;
  world.siguienteUid = 2050;
  const sinUid = world.people[1]!;
  sinUid.policy = founderPolicy(42, sinUid.id);
  delete sinUid.uid;
  policy.weights[0] = -0;
  persona.inventory = 0.18;
  const viejo = new Store(path, { snapshotCompressedPeople: true });
  try { viejo.guardar({ world, materia: null }); }
  finally { viejo.close(); }

  const store = new Store(path, { snapshotSplitPeopleWeights: true });
  try {
    const { db } = store;
    const save = (inventory: number) => {
      persona.inventory = inventory;
      store.guardar({ world, materia: null });
      const value = manifest(filaInstantanea(store).body);
      assert.equal(value.snapshotEncoding, 'snapshot-parts-v5');
      assert.ok(value.policies?.count && value.policies.pages.length);
      return value as Manifest & { policies: Pages };
    };
    const primero = save(-0);
    assert.equal(primero.policies.count, 1);
    assert.equal(manifest(filaInstantanea(store, 1).body).snapshotEncoding, 'snapshot-parts-v4');
    const lote = primero.policies.pages[0]!, contenido = bodyPage(db, lote);
    assert.ok(contenido instanceof Uint8Array);
    assert.equal(Buffer.from(contenido.subarray(0, 4)).toString('ascii'), 'WGP1');
    const segundo = save(0.19);
    assert.notDeepEqual(segundo.people, primero.people);
    assert.deepEqual(segundo.policies, primero.policies);
    assert.ok(Object.is((readStoredSnapshot(db, 1)!.value as World).people[0]!.inventory, -0));

    // Una clave ya presente debe volver a probar sus bytes después de una alteración externa.
    const ajena = new DatabaseSync(path);
    try {
      const cambiar = ajena.prepare('UPDATE main.snapshot_parts SET body=? WHERE digest=?');
      cambiar.run(Buffer.alloc(1), lote.digest);
      assert.throws(() => save(0.20), SnapshotPhysicalError);
      cambiar.run(contenido, lote.digest);
    } finally { ajena.close(); }

    db.exec(`CREATE TRIGGER dano_wpg5 AFTER INSERT ON snapshots WHEN NEW.slot=0 BEGIN
      UPDATE snapshot_parts SET body=X'00' WHERE digest=json_extract(NEW.body,'$.policies.pages[0].digest'); END`);
    assert.throws(() => save(0.21), SnapshotPhysicalError);
    db.exec('DROP TRIGGER dano_wpg5');
    assert.equal((readStoredSnapshot(db)!.value as World).people[0]!.inventory, 0.19);
    policy.weights[0] = 0.5;
    const tercero = save(0.22);
    assert.notDeepEqual(tercero.policies, segundo.policies);
    assert.deepEqual(bodyPage(db, lote), contenido);
    assert.equal(readStoredSnapshot(db)!.snapshotBytes, store.lastSnapshotBytes);
    assert.equal(store.previous(join(directory, 'previous.sqlite')), 1);
    const copia = new Store(join(directory, 'previous.sqlite'), { readOnly: true });
    try { assert.ok(Object.is(copia.verificarGuardado()!.world.people[0]!.policy!.weights[0], -0)); }
    finally { copia.close(); }
  } finally { store.close(); }

  const lector = new Store(path, { readOnly: true });
  try {
    const actual = readStoredSnapshot(lector.db)!;
    assert.equal((actual.value as World).people[0]!.policy!.weights[0], 0.5);
    assert.deepEqual((actual.value as World).people[1]!.policy, sinUid.policy);
    assert.equal(lector.verificarGuardado()!.slot, 0);
    assert.ok(Object.is((readStoredSnapshot(lector.db, 1)!.value as World).people[0]!.policy!.weights[0], -0));
  } finally { lector.close(); }
});
