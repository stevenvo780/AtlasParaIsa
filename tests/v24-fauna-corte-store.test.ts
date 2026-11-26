import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { readStoredSnapshot, SnapshotParts } from '../src/server/snapshot-parts.js';
import { SnapshotPhysicalError } from '../src/server/snapshot.js';
import { stringifyExact } from '../src/shared/exact-json.js';
import type { Animal } from '../src/world/animals.js';
import { createWorld, type World } from '../src/world/index.js';
import { vincularFaunaCorte, type BloqueFaunaCorte } from '../src/world/motor/fauna-corte.js';
import { parseParams } from '../src/world/params.js';
import { filaInstantanea, laboratorio, todasLasTablas } from './lib/store.js';

const params = parseParams('v23.guardadoCompleto=true');

function mundo(): World {
  const world = createWorld(42, params);
  world.animals[1]!.reason = 'Señal 🦌\n\u2028\uFEFF';
  world.animals[1]!.work = -0;
  world.animals[4]!.reason = '\uFFFD';
  return world;
}

function bloque(animals: readonly Animal[]): BloqueFaunaCorte {
  return { filas: animals.length, cuerpo: Buffer.from(animals.map(animal => stringifyExact(animal)).join('\n')) };
}

function partes(db: DatabaseSync) {
  return db.prepare('SELECT digest, typeof(body) AS tipo, hex(CAST(body AS BLOB)) AS bytes FROM snapshot_parts ORDER BY digest').all();
}

for (const packedPeople of [false, true]) {
  test(`corte de fauna conserva manifiesto, páginas y bytes de snapshot-parts-v${packedPeople ? 3 : 2}`, () => {
    const world = mundo(), animals = world.animals, db = new DatabaseSync(':memory:');
    try {
      SnapshotParts.install(db);
      db.exec('BEGIN');
      const maxBytes = Buffer.byteLength(stringifyExact(animals[0])) + 2;
      const parts = new SnapshotParts(db, 5, undefined, maxBytes, packedPeople);
      const canonical = parts.write(parts.prepare(world, params, 32768));
      const bodies = partes(db);
      const manifest = JSON.parse(canonical.body);
      assert.equal(manifest.snapshotEncoding, `snapshot-parts-v${packedPeople ? 3 : 2}`);
      assert.equal(manifest.animals.pages[0].count, 1);
      assert.ok(manifest.animals.pages.length > 1);

      vincularFaunaCorte(animals, [
        { desde: 0, bloques: [bloque(animals.slice(0, 3)), bloque(animals.slice(3, 4))] },
        { desde: 5, bloques: [bloque(animals.slice(5, 7))] },
      ]);
      const remote = parts.write(parts.prepare(world, params, 32768));
      parts.assertWritten(remote);
      parts.verify(remote.body);
      assert.deepEqual(remote, canonical);
      assert.deepEqual(partes(db), bodies);
      assert.deepEqual(parts.faunaCorteStats, { compared: 6, accepted: 6, rejected: 0 });
      const restored = parts.read(remote.body) as World;
      assert.equal(restored.animals[1]!.reason, animals[1]!.reason);
      assert.ok(Object.is(restored.animals[1]!.work, -0));
      db.exec('COMMIT');
    } finally { db.close(); }
  });
}

test('Store recurre a fauna canónica ante filas divergentes y conserva validación y rollback', t => {
  const { store: control } = laboratorio(t, 'atlas-fauna-canonica-');
  const { store } = laboratorio(t, 'atlas-fauna-remota-');
  const world = mundo(), animals = world.animals, controlWorld = mundo();
  control.guardar({ world: controlWorld, materia: null });
  store.guardar({ world, materia: null });
  assert.deepEqual(store.snapshotFaunaCorteStats, { compared: 0, accepted: 0, rejected: 0 });

  const utf8 = Buffer.from(stringifyExact(animals[4])), reemplazo = Buffer.from('\uFFFD');
  const position = utf8.indexOf(reemplazo);
  assert.ok(position >= 0);
  const bytesCorruptos = Buffer.concat([utf8.subarray(0, position), Buffer.of(0xFF), utf8.subarray(position + reemplazo.length)]);
  animals[0]!.reason = 'Cambio canónico';
  controlWorld.animals[0]!.reason = animals[0]!.reason;
  control.guardar({ world: controlWorld, materia: null });
  vincularFaunaCorte(animals, [
    { desde: 1, bloques: [bloque([animals[1]!, animals[3]!, animals[3]!])] },
    { desde: 4, bloques: [
      { filas: 1, cuerpo: bytesCorruptos },
      { filas: 1, cuerpo: Buffer.from(stringifyExact(animals[5]) + '\n') },
      { filas: 1, cuerpo: Buffer.from('\uFEFF' + stringifyExact(animals[6])) },
    ] },
    { desde: animals.length, bloques: [bloque([animals[0]!])] },
  ]);
  store.guardar({ world, materia: null });
  assert.deepEqual(store.snapshotFaunaCorteStats, { compared: 4, accepted: 2, rejected: 5 });
  assert.deepEqual(filaInstantanea(store), filaInstantanea(control));
  assert.deepEqual(filaInstantanea(store, 1), filaInstantanea(control, 1));
  assert.deepEqual(partes(store.db), partes(control.db));
  const restored = readStoredSnapshot(store.db)!.value as World;
  assert.equal(stringifyExact(restored.animals), stringifyExact(animals));

  const before = todasLasTablas(store);
  animals[1]!.health = -1;
  assert.throws(() => store.guardar({ world, materia: null }), /Animal individual inválido/);
  assert.deepEqual(todasLasTablas(store), before);
  animals[1]!.health = restored.animals[1]!.health;

  store.db.exec(`CREATE TRIGGER corrupt_fauna AFTER INSERT ON snapshots WHEN NEW.slot=0 BEGIN
      UPDATE snapshot_parts SET body=body||' ' WHERE digest=json_extract(NEW.body,'$.animals.pages[0].digest');
    END`);
  animals[0]!.reason = 'Guardado que revierte';
  assert.throws(() => store.guardar({ world, materia: null }), SnapshotPhysicalError);
  assert.deepEqual(todasLasTablas(store), before);
  assert.equal(store.db.isTransaction, false);
});
