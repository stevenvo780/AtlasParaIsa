import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { MAX_SNAPSHOT_MATTER_PART_BYTES, SnapshotMatterParts } from '../src/server/snapshot-matter-parts.js';
import { NE } from '../src/shared/naturaleza.js';
import { codificarCheckpoint, codificarEnVuelo, codificarPaginas, decodificarCheckpoint } from '../src/world/materia/checkpoint.js';
import type { MateriaCheckpoint } from '../src/world/materia/tipos.js';

function materia(tick: number): MateriaCheckpoint {
  const registro = Uint8Array.from({ length: 45 }, (_, i) => tick + i + 40);
  const cuenta = Array<bigint>(NE + 1).fill(0n);
  return {
    epoca: 7, tick, sustancias: Uint8Array.of(1, 2, 3), registro,
    paginas: codificarPaginas(7, [], []), enVuelo: codificarEnVuelo([]),
    inicial: cuenta, fuentes: cuenta, sumideros: cuenta,
  };
}

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

test('VMPT retiene partes de los tres slots y conserva bytes, SHA de agenda, nulos y VMAT legado', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const parts = new SnapshotMatterParts(db), anterior = materia(3), actual = materia(4);
  const vmAnterior = codificarCheckpoint(anterior), vmActual = codificarCheckpoint(actual);
  const preparado = SnapshotMatterParts.prepare(actual, 9);
  assert.throws(() => SnapshotMatterParts.prepare(actual, 0), /Límite/);
  assert.throws(() => SnapshotMatterParts.prepare(actual, MAX_SNAPSHOT_MATTER_PART_BYTES + 1), /Límite/);
  assert.throws(() => SnapshotMatterParts.install(db), /transacción/);
  assert.throws(() => parts.write(preparado), /transacción/);
  assert.throws(() => parts.collect([]), /transacción/);
  assert.equal(preparado.longitud, vmActual.length);
  assert.equal(preparado.digest, sha(vmActual));

  db.exec('BEGIN IMMEDIATE');
  assert.deepEqual(parts.read(null), { bytes: null, digest: null });
  assert.equal(parts.verify(null), null);
  assert.equal(parts.read(vmAnterior).bytes, vmAnterior);
  assert.equal(parts.verify(vmAnterior), sha(vmAnterior));

  SnapshotMatterParts.install(db);
  db.exec('CREATE TABLE snapshot_matter(slot INTEGER PRIMARY KEY, body BLOB) STRICT');
  const guardar = db.prepare('INSERT OR REPLACE INTO snapshot_matter VALUES (?,?)');
  const viejo = parts.write(SnapshotMatterParts.prepare(anterior, 9));
  const vigente = parts.write(preparado);
  const privado = parts.write(SnapshotMatterParts.prepare(materia(5), 1));
  guardar.run(0, vigente);
  guardar.run(1, vmAnterior);
  guardar.run(2, viejo);
  assert.deepEqual(parts.read(vigente), { bytes: vmActual, digest: preparado.digest });
  assert.equal(parts.verify(vigente), preparado.digest);
  assert.deepEqual(decodificarCheckpoint(parts.read(vigente).bytes!, () => { throw new Error('La arena está vacía.'); }), actual);
  assert.deepEqual(SnapshotMatterParts.references(vmAnterior), []);
  assert.deepEqual(SnapshotMatterParts.references(null), []);

  const refs = new Set([...SnapshotMatterParts.references(vigente), ...SnapshotMatterParts.references(viejo)]);
  assert.ok(SnapshotMatterParts.references(privado).some(digest => !refs.has(digest)));
  const cuerpos = () => (db.prepare('SELECT body FROM snapshot_matter ORDER BY slot').all() as { body: Uint8Array | null }[]).map(row => row.body);
  const lista = () => db.prepare('SELECT digest FROM snapshot_matter_parts ORDER BY digest').all().map(row => row.digest);
  parts.collect(cuerpos());
  assert.deepEqual(lista(), [...refs].sort());
  db.exec('COMMIT');

  db.exec('BEGIN IMMEDIATE');
  guardar.run(0, parts.write(SnapshotMatterParts.prepare(materia(6), 9)));
  guardar.run(2, null);
  parts.collect(cuerpos());
  assert.notDeepEqual(lista(), [...refs].sort());
  db.exec('ROLLBACK');
  db.exec('BEGIN');
  assert.deepEqual(lista(), [...refs].sort());
  assert.deepEqual(cuerpos(), [vigente, vmAnterior, viejo]);
  assert.deepEqual(parts.read(cuerpos()[2]!).bytes, vmAnterior);
  db.exec('COMMIT');
});

test('VMPT rechaza partes ausentes, corruptas o reordenadas y verifica el CRC de extremo a extremo', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const parts = new SnapshotMatterParts(db), preparado = SnapshotMatterParts.prepare(materia(4), 3);
  db.exec('BEGIN IMMEDIATE');
  SnapshotMatterParts.install(db);
  const body = parts.write(preparado);
  const digest = SnapshotMatterParts.references(body)[0]!;
  assert.throws(() => parts.verify(body.subarray(0, -1)), /manifiesto.*truncado/);
  db.exec('SAVEPOINT prueba');
  db.exec('DROP TABLE snapshot_matter_parts');
  assert.throws(() => parts.verify(body), /Falta la tabla de partes/);
  db.exec('ROLLBACK TO prueba');
  db.prepare('DELETE FROM snapshot_matter_parts WHERE digest=?').run(digest);
  assert.throws(() => parts.read(body), /Falta la parte de materia 0/);
  db.exec('ROLLBACK TO prueba');
  db.prepare('UPDATE snapshot_matter_parts SET body=? WHERE digest=?').run(Uint8Array.of(99, 2, 3), digest);
  assert.throws(() => parts.verify(body), /parte de materia 0.*SHA-256/);
  db.exec('ROLLBACK TO prueba');

  const cabecera = 48, entrada = 36;
  const reordenado = body.slice();
  reordenado.set(body.subarray(cabecera + entrada, cabecera + 2 * entrada), cabecera);
  reordenado.set(body.subarray(cabecera, cabecera + entrada), cabecera + entrada);
  assert.throws(() => parts.verify(reordenado), /SHA-256 del VMAT/);

  // Un cuerpo distinto con hashes de transporte válidos aún debe pasar el CRC de VMAT.
  const alterado = body.slice(), canonico = codificarCheckpoint(materia(4));
  canonico[canonico.length - 1] ^= 1;
  const nuevaParte = canonico.subarray(-1), hashParte = sha(nuevaParte);
  db.prepare('INSERT INTO snapshot_matter_parts VALUES (?,?) ON CONFLICT DO NOTHING').run(hashParte, nuevaParte);
  alterado.set(Buffer.from(sha(canonico), 'hex'), 16);
  alterado.set(Buffer.from(hashParte, 'hex'), alterado.length - 32);
  assert.throws(() => parts.verify(alterado), /CRC32 del VMAT/);
  db.exec('RELEASE prueba');
  db.exec('COMMIT');
});
