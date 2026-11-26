import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { paramsDeEncender } from '../scripts/lab/encender.mjs';
import { SnapshotMatterParts } from '../src/server/snapshot-matter-parts.js';
import { Store } from '../src/server/store.js';
import { createWorld } from '../src/world/index.js';
import { codificarCheckpoint } from '../src/world/materia/checkpoint.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { unSoloDueno } from '../src/world/motor/contratos.js';
import { AgendaTerritorial } from '../src/world/territorio/agenda.js';
import { filaInstantanea, laboratorio } from './lib/store.js';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const blob = (store: Store, slot = 0): Uint8Array =>
  (store.db.prepare('SELECT body FROM main.snapshot_matter WHERE slot=?').get(slot) as { body: Uint8Array }).body;
const firma = (bytes: Uint8Array): string => Buffer.from(bytes.subarray(0, 4)).toString('ascii');

test('Store rota, verifica y recupera VMAT legado y en partes junto con la agenda', async t => {
  const { store: anterior, path, directory } = laboratorio(t, 'vmat-store-partes-');
  const mundo = createWorld(7, paramsDeEncender({ regimen: 'abierto', hasta: 'materia' }));
  const motor = crearMotor(mundo, unSoloDueno(7));
  t.after(() => motor.cerrar());
  motor.paso([]);
  const inicial = motor.instantanea(), primeraAgenda = new AgendaTerritorial(inicial.world.tick);
  primeraAgenda.programar('0,0', 'reactivar', inicial.world.tick + 5);
  const primerCorte = primeraAgenda.corte(inicial.materia!.epoca);
  anterior.guardar(inicial, primerCorte);
  const vmatAnterior = codificarCheckpoint(inicial.materia!);
  assert.equal(firma(blob(anterior)), 'VMAT');
  anterior.close();

  const store = new Store(path, { snapshotMatterPartBytes: 32 * 1024 });
  t.after(() => store.close());
  const continuar = () => {
    const carga = store.cargarGuardadoCompleto()!;
    const corte = carga.corteAgenda!;
    const agenda = AgendaTerritorial.restaurar(corte, corte.epoca, corte.tick);
    motor.cargar(carga.instantanea, carga.epoca);
    motor.paso([]);
    const siguiente = motor.instantanea();
    agenda.extraerHasta(siguiente.world.tick);
    return { siguiente, corte: agenda.corte(carga.epoca) };
  };
  const segundo = continuar();
  store.guardar(segundo.siguiente, segundo.corte);
  const vmatSegundo = codificarCheckpoint(segundo.siguiente.materia!);
  assert.equal(firma(blob(store)), 'VMPT');
  assert.deepEqual(blob(store, 1), vmatAnterior);
  const documento = JSON.parse(filaInstantanea(store).body);
  assert.equal(documento.world.agendaTerritorialV1.materiaDigest, sha(vmatSegundo));
  assert.ok(SnapshotMatterParts.references(blob(store)).length > 1);

  const tercero = continuar();
  const antes = filaInstantanea(store);
  const digests = () => store.db.prepare('SELECT digest FROM main.snapshot_matter_parts ORDER BY digest').all();
  const partesAntes = digests();
  store.db.exec(`CREATE TEMP TRIGGER parte_alterada AFTER INSERT ON main.snapshot_matter WHEN NEW.slot=0
    BEGIN UPDATE snapshot_matter_parts SET body=zeroblob(length(body))
      WHERE digest=(SELECT digest FROM snapshot_matter_parts ORDER BY digest LIMIT 1); END`);
  assert.throws(() => store.guardar(tercero.siguiente, tercero.corte), /parte de materia|SHA-256/);
  assert.deepEqual(filaInstantanea(store), antes);
  assert.deepEqual(digests(), partesAntes);
  store.db.exec('DROP TRIGGER parte_alterada');
  assert.equal(store.verificarGuardado()?.world.tick, segundo.corte.tick);

  store.guardar(tercero.siguiente, tercero.corte);
  assert.equal(firma(blob(store, 1)), 'VMPT');
  const actual = store.cargarGuardadoCompleto()!;
  assert.deepEqual(actual.corteAgenda, tercero.corte);
  const paginas = actual.instantanea.materia!.paginas;
  assert.ok(!(paginas instanceof Uint8Array) && paginas.tramos.length > 1);
  assert.equal(paginas.tramos.reduce((total, tramo) => total + tramo.byteLength, 0), paginas.byteLength);
  assert.ok(paginas.tramos.every(tramo => tramo.byteLength <= 32 * 1024));
  assert.deepEqual(codificarCheckpoint(actual.instantanea.materia!), codificarCheckpoint(tercero.siguiente.materia!));
  const salvado = join(directory, 'respaldo-segmentado.sqlite');
  assert.equal(store.previous(salvado), 1);
  const respaldo = new Store(salvado, { readOnly: true });
  try {
    assert.equal(firma(blob(respaldo)), 'VMPT');
    assert.equal(respaldo.verificarGuardado()?.world.tick, segundo.corte.tick);
    assert.deepEqual(SnapshotMatterParts.references(blob(respaldo)), SnapshotMatterParts.references(blob(store, 1)));
  } finally { respaldo.close(); }
  const retenidas = new Set(SnapshotMatterParts.references(blob(store, 1)));
  const unica = SnapshotMatterParts.references(blob(store)).find(digest => !retenidas.has(digest));
  assert.ok(unica);
  const respaldoAnterior = blob(store, 1);
  const perdida = store.db.prepare('SELECT body FROM main.snapshot_matter_parts WHERE digest=?').get(unica)?.body;
  assert.ok(perdida instanceof Uint8Array);
  store.db.prepare('DELETE FROM main.snapshot_matter_parts WHERE digest=?').run(unica);
  assert.throws(() => store.verificarGuardado(), /Falta la parte de materia/);
  assert.throws(() => store.cargarGuardadoCompleto(), /Falta la parte de materia/);
  store.db.prepare('INSERT INTO main.snapshot_matter_parts VALUES (?,?)').run(unica, perdida);
  store.db.prepare('UPDATE main.snapshot_matter SET body=? WHERE slot=0').run(respaldoAnterior);
  assert.throws(() => store.verificarGuardado(), /ticks de mundo y materia/);
  // El sustituto es íntegro para otra instantánea. Reparar la cabeza no debe rotarlo como respaldo.
  motor.cargar(actual.instantanea, actual.epoca);
  motor.paso([]);
  const reparado = motor.instantanea();
  const agenda = AgendaTerritorial.restaurar(tercero.corte, tercero.corte.epoca, tercero.corte.tick);
  agenda.extraerHasta(reparado.world.tick);
  store.guardar(reparado, agenda.corte(actual.epoca));
  assert.deepEqual(blob(store, 1), respaldoAnterior);
  assert.equal(store.verificarGuardado()?.world.tick, reparado.world.tick);

  // Un respaldo profundo con un manifiesto ilegible impide conocer todas sus referencias.
  store.db.exec(`INSERT OR REPLACE INTO main.snapshots SELECT 2,body,digest,saved_at FROM main.snapshots WHERE slot=1;
    INSERT OR REPLACE INTO main.snapshot_matter SELECT 2,world_digest,X'564d5054' FROM main.snapshot_matter WHERE slot=1`);
  const quinto = continuar();
  store.guardar(quinto.siguiente, quinto.corte);
  assert.equal(store.verificarGuardado()?.world.tick, quinto.corte.tick);
  assert.deepEqual(blob(store, 2), Uint8Array.of(0x56, 0x4d, 0x50, 0x54));
});
