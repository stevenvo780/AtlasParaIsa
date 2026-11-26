import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { paramsDeEncender } from '../scripts/lab/encender.mjs';
import { SNAPSHOT_INLINE_TILE_LIMIT } from '../src/server/snapshot-parts.js';
import { Store } from '../src/server/store.js';
import { cloneWorld, createWorld } from '../src/world/index.js';
import { codificarCheckpoint } from '../src/world/materia/checkpoint.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { unSoloDueno } from '../src/world/motor/contratos.js';
import { parseParams } from '../src/world/params.js';
import { AgendaTerritorial } from '../src/world/territorio/agenda.js';
import { filaInstantanea, laboratorio, reescribirInstantanea } from './lib/store.js';

test('confirma y recupera junta la agenda de un mundo material paginado', async t => {
  const { directory, store } = laboratorio(t, 'agenda-material-', { snapshotInlineTileLimit: 0 });
  const world = createWorld(7, paramsDeEncender({ regimen: 'abierto', hasta: 'materia' }));
  const motor = crearMotor(world, unSoloDueno(7));
  t.after(() => motor.cerrar());
  motor.paso([]);
  const inicial = motor.instantanea();
  const materia = inicial.materia!;
  assert.ok(materia);
  const agenda = new AgendaTerritorial(inicial.world.tick);
  const pendiente = agenda.programar('0,0', 'reactivar', inicial.world.tick + 1);
  const origen = agenda.corte(materia.epoca);
  assert.throws(() => store.guardar(inicial, { ...origen, epoca: materia.epoca + 1 }), /otro tick o época/);
  assert.throws(() => store.guardar(inicial, { ...origen, tick: origen.tick - 1 }), /otro tick o época/);
  store.guardar(inicial, origen);
  const fila = filaInstantanea(store);
  assert.equal(JSON.parse(fila.body).snapshotEncoding, 'snapshot-parts-v2');
  const claveEpoca = 'v23-complete-epoch-v1';
  store.db.prepare('DELETE FROM metadata WHERE key=?').run(claveEpoca);
  assert.throws(() => store.verificarGuardado(), /agenda territorial requiere guardado completo/);
  store.db.prepare('INSERT INTO metadata VALUES (?,?)').run(claveEpoca, String(materia.epoca));

  // El registro opaco puede cambiar con el mismo tick y época y conservar el libro material.
  // El adjunto tiene que identificar exactamente los bytes que acompañaron a ese mundo.
  const blob = codificarCheckpoint(materia);
  const sustituir = store.db.prepare('UPDATE snapshot_matter SET body=? WHERE slot=0');
  sustituir.run(codificarCheckpoint({ ...materia, registro: Uint8Array.of(123, 45) }));
  assert.throws(() => store.cargarInstantanea(), /agenda territorial no corresponde a la materia/);
  assert.throws(() => store.verificarGuardado(), /agenda territorial no corresponde a la materia/);
  sustituir.run(blob);
  const cargar = () => {
    const carga = store.cargarInstantanea()!;
    assert.deepEqual(carga.corteAgenda, origen);
    assert.equal(Object.hasOwn(carga.instantanea.world, 'agendaTerritorialV1'), false);
    assert.deepEqual(carga.instantanea.materia, materia);
    assert.ok(carga.epoca > origen.epoca);
    const seguir = AgendaTerritorial.restaurar(carga.corteAgenda, origen.epoca, origen.tick);
    motor.cargar(carga.instantanea, carga.epoca);
    motor.paso([]);
    const i = motor.instantanea();
    assert.deepEqual(seguir.extraerHasta(i.world.tick), [pendiente]);
    i.world.people[0]!.energy = 0.625;
    return { i, corte: seguir.corte(carga.epoca) };
  };

  const intento = cargar();
  assert.equal(intento.corte.epoca, origen.epoca + 1, 'las lecturas rechazadas no reservan una época');
  store.db.exec(`CREATE TEMP TRIGGER interrumpir_agenda AFTER INSERT ON main.snapshot_matter
    WHEN NEW.slot=0 BEGIN SELECT RAISE(ABORT, 'guardado interrumpido'); END`);
  assert.throws(() => store.guardar(intento.i, intento.corte), /guardado interrumpido/);
  assert.deepEqual(filaInstantanea(store), fila);
  assert.equal(store.db.prepare('SELECT 1 FROM snapshots WHERE slot=1').get(), undefined);
  store.db.exec('DROP TRIGGER interrumpir_agenda');

  const confirmar = cargar();
  assert.throws(() => store.guardar(intento.i, intento.corte), /época reservada del motor/);
  store.guardar(confirmar.i, confirmar.corte);
  assert.deepEqual(filaInstantanea(store, 1), fila);
  const guardado = store.cargarGuardadoCompleto()!;
  assert.deepEqual(guardado.corteAgenda, confirmar.corte);
  assert.equal(guardado.instantanea.world.people[0]!.energy, 0.625);
  assert.deepEqual(AgendaTerritorial.restaurar(guardado.corteAgenda, confirmar.corte.epoca, confirmar.corte.tick)
    .extraerHasta(confirmar.corte.tick), []);

  const rutaRecuperada = join(directory, 'anterior.sqlite');
  assert.equal(store.previous(rutaRecuperada), 1);
  const anterior = new Store(rutaRecuperada);
  try {
    const respaldo = anterior.cargarGuardadoCompleto()!;
    assert.equal(respaldo.instantanea.world.tick, origen.tick);
    assert.deepEqual(respaldo.instantanea.materia, materia);
    assert.deepEqual(respaldo.corteAgenda, origen);
    assert.deepEqual(AgendaTerritorial.restaurar(respaldo.corteAgenda, origen.epoca, origen.tick).extraerHasta(pendiente.tick), [pendiente]);
  } finally { anterior.close(); }
});

test('sólo la recuperación explícita permite volver a un slot anterior a la agenda', t => {
  const { directory, store } = laboratorio(t, 'agenda-anterior-', { snapshotInlineTileLimit: SNAPSHOT_INLINE_TILE_LIMIT });
  const world = createWorld(51926, parseParams('v23.guardadoCompleto=true'));
  store.guardar({ world, materia: null });
  const carga = store.cargarInstantanea()!;
  assert.equal(Object.hasOwn(carga, 'corteAgenda'), false);
  const siguiente = cloneWorld(carga.instantanea.world);
  siguiente.tick++;
  for (const persona of siguiente.people) persona.demography.age++;
  const agenda = new AgendaTerritorial(siguiente.tick);
  agenda.programar('0,0', 'reactivar', siguiente.tick + 1);
  const corte = agenda.corte(carga.epoca);
  store.guardar({ world: siguiente, materia: null }, corte);
  const fila = filaInstantanea(store), raw = JSON.parse(fila.body);
  assert.equal(raw.snapshotEncoding, 'snapshot-parts-v2');
  assert.deepEqual(raw.world.agendaTerritorialV1, { corte, materiaDigest: null });
  assert.throws(() => store.guardar({ world: siguiente, materia: null }), /requiere guardar su corte de agenda/);
  assert.deepEqual(filaInstantanea(store), fila);
  delete raw.world.agendaTerritorialV1;
  reescribirInstantanea(store, JSON.stringify(raw));
  assert.throws(() => store.cargarInstantanea(), /Falta el corte territorial/);
  reescribirInstantanea(store, fila.body);
  assert.deepEqual(store.cargarInstantanea()!.corteAgenda, corte);

  store.db.prepare('UPDATE snapshots SET digest=? WHERE slot=0').run('0'.repeat(64));
  assert.throws(() => store.cargarGuardadoCompleto(), /Falta el corte territorial.*slot 1/);
  assert.throws(() => store.verificarGuardado(), /Falta el corte territorial.*slot 1/);

  const ruta = join(directory, 'antes-de-activar.sqlite');
  assert.equal(store.previous(ruta), 1);
  const sinAgenda = new Store(ruta);
  try {
    const recuperado = sinAgenda.cargarInstantanea()!;
    assert.equal(recuperado.instantanea.world.tick, world.tick);
    assert.equal(Object.hasOwn(recuperado, 'corteAgenda'), false);
    sinAgenda.guardar(recuperado.instantanea);
  } finally { sinAgenda.close(); }
});
