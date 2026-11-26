import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SnapshotParts, readStoredSnapshot } from '../src/server/snapshot-parts.js';
import { SnapshotPhysicalError, decodeSnapshot, encodeSnapshot, snapshotRecord } from '../src/server/snapshot.js';
import { Store } from '../src/server/store.js';
import { stringifyExact } from '../src/shared/exact-json.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { createWorld, type World } from '../src/world/index.js';
import { parseParams } from '../src/world/params.js';
import { sha256, todasLasTablas } from './lib/store.js';

const params = parseParams('v23.guardadoCompleto=true');
interface Page { index: number; digest: string; count: number; bytes: number; }
interface Manifest {
  snapshotEncoding: string; world: Record<string, unknown>;
  tiles: { count: number; pages: Page[] }; people: { count: number; pages: Page[] }; animals: { count: number; pages: Page[] };
}

function manifest(db: DatabaseSync, slot = 0): Manifest {
  const fila = db.prepare('SELECT body,digest FROM snapshots WHERE slot=?').get(slot) as { body: string; digest: string };
  assert.equal(fila.digest, sha256(fila.body));
  return JSON.parse(fila.body) as Manifest;
}

test('partes de población respetan cupo UTF-8, orden y -0 sin serializar las colecciones', () => {
  const world = createWorld(42, params);
  world.people.reverse();
  world.animals.reverse();
  world.people[0]!.inventory = -0;
  world.people[0]!.name += 'ñ'.repeat(64);
  world.animals[0]!.work = -0;
  const expected = decodeSnapshot(encodeSnapshot(world, params)) as World;
  expected.people = JSON.parse(stringifyExact(world.people));
  expected.animals = JSON.parse(stringifyExact(world.animals));
  const maxBytes = Math.max(...[...world.people, ...world.animals].map(actor => Buffer.byteLength(stringifyExact(actor)) + 2));
  const db = new DatabaseSync(':memory:');
  try {
    SnapshotParts.install(db);
    db.exec('BEGIN');
    const parts = new SnapshotParts(db, 5, undefined, maxBytes);
    // Detecta una regresión que pase la colección entera a JSON.stringify.
    Object.defineProperty(world.people, 'toJSON', { value: () => { throw new Error('colección entera'); } });
    Object.defineProperty(world.animals, 'toJSON', { value: () => { throw new Error('colección entera'); } });
    const written = parts.write(parts.prepare(world, params, 32768));
    parts.assertWritten(written);
    parts.verify(written.body);
    const value = JSON.parse(written.body) as Manifest;
    assert.equal(value.snapshotEncoding, 'snapshot-parts-v2');
    assert.equal(value.world.people, null);
    assert.equal(value.world.animals, null);
    for (const field of ['people', 'animals'] as const) {
      assert.equal(value[field].count, world[field].length);
      assert.ok(value[field].pages.length > 1);
      for (const [index, page] of value[field].pages.entries()) {
        assert.equal(page.index, index);
        assert.ok(page.bytes <= maxBytes);
        const { body } = db.prepare('SELECT body FROM snapshot_parts WHERE digest=?').get(page.digest) as { body: string };
        assert.equal(Buffer.byteLength(body), page.bytes);
        assert.equal(sha256(body), page.digest);
        assert.equal((JSON.parse(body) as unknown[]).length, page.count);
      }
    }
    const { value: loaded, bytes } = parts.readWithInfo(written.body);
    assert.equal(bytes, written.bytes);
    assert.equal(written.digest, sha256(written.body));
    assert.deepEqual(Object.keys(loaded as World), Object.keys(expected));
    assert.ok(stringifyExact(loaded) === stringifyExact(expected));
    assert.ok(Object.is((loaded as World).people[0]!.inventory, -0));
    assert.ok(Object.is((loaded as World).animals[0]!.work, -0));

    for (const alterar of [
      (m: Manifest) => { m.people.count++; },
      (m: Manifest) => { m.animals.pages[0]!.index++; },
      (m: Manifest) => { m.world.people = []; },
    ]) {
      const m = structuredClone(value);
      alterar(m);
      assert.throws(() => parts.read(JSON.stringify(m)), /organism/i);
    }

    const objetivo = maxBytes - 1, conObjetivoBajo = new SnapshotParts(db, 5, undefined, objetivo);
    const alternativo = conObjetivoBajo.write(conObjetivoBajo.prepare(world, params, 32768));
    const descriptores = JSON.parse(alternativo.body) as Manifest;
    const grandes = [...descriptores.people.pages, ...descriptores.animals.pages].filter(page => page.bytes > objetivo);
    assert.ok(grandes.length > 0 && grandes.every(page => page.count === 1));
    assert.ok(stringifyExact(conObjetivoBajo.read(alternativo.body)) === stringifyExact(expected));
    db.exec('ROLLBACK');
    assert.equal(db.prepare('SELECT count(*) AS n FROM snapshot_parts').get()!.n, 0);
  } finally { db.close(); }
});

test('un organismo de más de 4 MiB ocupa una página propia y conserva los límites de las demás páginas', () => {
  const world = createWorld(42, params);
  const transportFixture = 'ñ'.repeat(2 * 1024 * 1024);
  world.people[1] = { ...world.people[1]!, transportFixture } as World['people'][number];
  const db = new DatabaseSync(':memory:');
  try {
    SnapshotParts.install(db);
    db.exec('BEGIN');
    const parts = new SnapshotParts(db, 5);
    const written = parts.write(parts.prepare(world, params, 32768));
    const value = JSON.parse(written.body) as Manifest;
    const grandes = value.people.pages.filter(page => page.bytes > 4 * 1024 * 1024);
    assert.equal(grandes.length, 1);
    const grande = grandes[0]!;
    assert.equal(grande.count, 1);
    assert.equal(grande.index, 1, 'la fila anterior queda en su propia página');
    assert.ok(value.people.pages.length > grande.index + 1);
    parts.verify(written.body);
    const loaded = parts.read(written.body) as World;
    assert.deepEqual(loaded.people.map(p => p.id), world.people.map(p => p.id));
    assert.ok((loaded.people[1] as { transportFixture?: string }).transportFixture === transportFixture);

    const varias = structuredClone(value);
    varias.people.pages[grande.index]!.count++;
    varias.people.count++;
    assert.throws(() => parts.read(JSON.stringify(varias)), /organism page descriptor/);
    const teselas = structuredClone(value);
    teselas.tiles.pages[0]!.bytes = grande.bytes;
    assert.throws(() => parts.read(JSON.stringify(teselas)), /page descriptor/);
    const bytesFalsos = structuredClone(value);
    bytesFalsos.people.pages[grande.index]!.bytes++;
    assert.throws(() => parts.read(JSON.stringify(bytesFalsos)), /page byte count/);
    db.exec('ROLLBACK');
  } finally { db.close(); }
});

test('el lector conserva guardados completos en línea y por partes v1', () => {
  const world = createWorld(42, params);
  const inline = encodeSnapshot(world, params), expected = decodeSnapshot(inline);
  const db = new DatabaseSync(':memory:');
  try {
    SnapshotParts.install(db);
    db.exec('BEGIN');
    const parts = new SnapshotParts(db, 5);
    const anterior = parts.write({
      metadata: stringifyExact(snapshotRecord(world, params, null), true), tiles: world.tiles, nativo: true,
    });
    assert.equal(JSON.parse(anterior.body).snapshotEncoding, 'snapshot-parts-v1');
    assert.ok(stringifyExact(parts.read(anterior.body)) === stringifyExact(expected));
    assert.ok(stringifyExact(parts.read(inline)) === stringifyExact(expected));
    db.exec('ROLLBACK');
  } finally { db.close(); }
});

test('Store retiene las páginas de población de los tres slots y revierte un guardado corrupto', t => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-snapshot-poblacion-'));
  const store = new Store(join(dir, 'world.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const world = createWorld(42, params);
  const { db } = store;
  const guarda = (inventory: number) => {
    world.people[0]!.inventory = inventory;
    store.guardar({ world, materia: null });
    return manifest(db).people.pages[0]!.digest;
  };
  const inventarioInicial = world.people[0]!.inventory;
  const inicial = guarda(inventarioInicial);
  db.exec('INSERT INTO snapshots SELECT 2,body,digest,saved_at FROM snapshots WHERE slot=0');
  db.exec('INSERT INTO snapshot_matter SELECT 2,world_digest,body FROM snapshot_matter WHERE slot=0');
  const sobra = guarda(0.137), anterior = guarda(0.148), actual = guarda(0.159);
  const retenidas = new Set((db.prepare('SELECT digest FROM snapshot_parts').all() as { digest: string }[]).map(row => row.digest));
  assert.ok(retenidas.has(inicial) && retenidas.has(anterior) && retenidas.has(actual));
  assert.ok(!retenidas.has(sobra));
  assert.equal(manifest(db, 1).people.pages[0]!.digest, anterior);
  assert.equal(manifest(db, 2).people.pages[0]!.digest, inicial);
  assert.equal(digestoCanonico(store.verificarGuardado()!.world), digestoCanonico(world));
  assert.equal(store.lastSnapshotBytes, readStoredSnapshot(db)!.snapshotBytes);
  const original = db.prepare('SELECT body FROM snapshot_parts WHERE digest=?').get(actual)!.body as string;
  for (const dañar of [
    () => db.prepare('UPDATE snapshot_parts SET body=body||\' \' WHERE digest=?').run(actual),
    () => db.prepare('DELETE FROM snapshot_parts WHERE digest=?').run(actual),
  ]) {
    dañar();
    assert.throws(() => readStoredSnapshot(db), SnapshotPhysicalError);
    assert.equal(store.verificarGuardado()!.slot, 1);
    db.prepare('INSERT OR REPLACE INTO snapshot_parts VALUES (?,?)').run(actual, original);
  }

  db.exec(`CREATE TRIGGER corrupt_population AFTER INSERT ON snapshots WHEN NEW.slot=0 BEGIN
      UPDATE snapshot_parts SET body=body||' ' WHERE digest=json_extract(NEW.body,'$.people.pages[0].digest');
    END`);
  const antes = todasLasTablas(store);
  assert.throws(() => guarda(0.161), /page missing or checksum mismatch/);
  assert.deepEqual(todasLasTablas(store), antes);
  db.exec('DROP TRIGGER corrupt_population');
  assert.equal(store.verificarGuardado()!.slot, 0);
  const recuperada = join(dir, 'anterior.sqlite');
  assert.equal(store.previous(recuperada), 1);
  const copia = new Store(recuperada);
  try {
    assert.equal(copia.verificarGuardado()!.world.people[0]!.inventory, 0.148);
    assert.equal(manifest(copia.db).people.pages[0]!.digest, anterior);
  } finally { copia.close(); }
  assert.equal((readStoredSnapshot(db, 2)!.value as World).people[0]!.inventory, inventarioInicial);
});
