import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Store } from '../src/server/store.js';
import type { LegacyRecord } from '../src/shared/demography.js';
import { demographicTraits } from '../src/world/demography.js';
import { inheritGenome } from '../src/world/genetics.js';
import { createWorld } from '../src/world/index.js';
import { crearCorteGuardado } from '../src/world/motor/corte-sellado.js';
import { parseParams } from '../src/world/params.js';
import { filaInstantanea, laboratorio, sha256 } from './lib/store.js';

test('un fallo del observador tras el COMMIT conserva la confirmación del corte', t => {
  const { store, path } = laboratorio(t, 'atlas-sello-perfil-');
  const world = createWorld(42, parseParams('v23.guardadoCompleto=true'));
  const sello = crearCorteGuardado(() => ({ world, materia: null }));
  const fases: string[] = [];
  const cargada = store.guardarCorteSellado(sello, [], [], undefined, fase => {
    fases.push(fase);
    if (fase === 'commit') throw new Error('Fallo inyectado del reloj de telemetría.');
  });
  assert.equal(fases.at(-1), 'commit');
  assert.equal(store.confirmacionesDeGuardado, 1);
  assert.equal(store.db.isTransaction, false);
  const lector = new Store(path, { readOnly: true });
  try { assert.equal(lector.verificarGuardado()?.world.tick, cargada.world.tick); }
  finally { lector.close(); }
});

test('un escritor frío decodifica una sola vez la cabeza anterior y conserva el respaldo', t => {
  const opciones = { snapshotPackedPeople: true, snapshotSplitPeopleWeights: true };
  const { store, path } = laboratorio(t, 'atlas-sello-cabeza-fria-', opciones);
  const world = createWorld(42, parseParams('v23.guardadoCompleto=true,conducta.politicaPeso=1'));
  store.guardar({ world, materia: null });
  const cabeza = filaInstantanea(store);
  world.tick++;
  for (const persona of world.people) persona.demography.age++;

  const frio = new Store(path, opciones);
  try {
    const lector = frio as unknown as { readSnapshot(body: string): unknown };
    const leer = lector.readSnapshot.bind(lector);
    let decodificaciones = 0;
    t.mock.method(lector, 'readSnapshot', (body: string) => {
      if (body === cabeza.body && frio.db.isTransaction) decodificaciones++;
      return leer(body);
    });
    frio.guardar({ world, materia: null });
    assert.equal(decodificaciones, 1);
    assert.deepEqual(filaInstantanea(frio, 1), cabeza);
    assert.equal(frio.verificarGuardado()?.world.tick, 1);
  } finally { frio.close(); }
});

for (const ventana of ['antes de exportar', 'antes de adquirir el candado'] as const) {
  test(`una escritura ajena ${ventana} invalida la prueba de la cabeza inicial`, t => {
    const opciones = { snapshotPackedPeople: true, snapshotSplitPeopleWeights: true };
    const { store, path } = laboratorio(t, 'atlas-prueba-inicial-wal-', opciones);
    const world = createWorld(42, parseParams('v23.guardadoCompleto=true,conducta.politicaPeso=1'));
    store.guardar({ world, materia: null });
    const carga = store.cargarGuardadoCompleto()!;
    const cabeza = filaInstantanea(store);
    const escritor = new Store(path, opciones);
    const externo = new DatabaseSync(path);
    const tocarCabeza = () => {
      // La escritura cambia data_version aunque el digesto y la época queden idénticos.
      assert.equal(externo.prepare('UPDATE main.snapshots SET saved_at=saved_at+1 WHERE slot=0').run().changes, 1);
    };
    try {
      assert.equal(escritor.anclarPruebaCabeza(), true);
      if (ventana === 'antes de exportar') tocarCabeza();
      const prueba = store.exportarPruebaCabeza();
      assert.equal(prueba !== undefined, ventana === 'antes de adquirir el candado');
      escritor.ofrecerPruebaCabeza(prueba);

      const ejecutar = escritor.db.exec.bind(escritor.db);
      let escrituras = 0;
      const intercalar = t.mock.method(escritor.db, 'exec', (sql: string) => {
        if (sql === 'BEGIN IMMEDIATE' && ventana === 'antes de adquirir el candado') {
          assert.equal(escrituras++, 0);
          tocarCabeza();
        }
        ejecutar(sql);
      });
      try {
        carga.instantanea.world.tick++;
        for (const persona of carga.instantanea.world.people) persona.demography.age++;
        escritor.guardarCorteSellado(crearCorteGuardado(() => carga.instantanea), [], []);
        assert.equal(escritor.reutilizoCabezaInicial, false);
      } finally { intercalar.mock.restore(); }
      assert.equal(filaInstantanea(escritor, 1).digest, cabeza.digest);
      assert.equal(escritor.verificarGuardado()?.world.tick, 1);
    } finally { externo.close(); escritor.close(); }
  });
}

for (const corromper of [false, true]) {
  test(`revalida el candidato tras un commit WAL ajeno ${corromper ? 'en el archivo de identidades' : 'en las sesiones'}`, t => {
    const { store, path } = laboratorio(t, 'atlas-sello-guardado-');
    const world = createWorld(42, parseParams('v23.guardadoCompleto=true'));
    const progenitor = world.people.find(p => p.role === 'neighbor')!;
    const archivado: LegacyRecord = {
      id: 'progenitor-archivado', name: 'Progenitor archivado', role: 'neighbor', generation: 0, parents: [],
      bornAt: progenitor.bornAt, diedAt: world.tick, cause: 'exposure', genome: structuredClone(progenitor.genome),
      traits: demographicTraits(progenitor.genome), communityId: null,
    };
    world.retiredLegacy.push(archivado);
    world.demographyDynamics.deaths++;
    world.demographyDynamics.causes.exposure++;
    store.guardar({ world, materia: null });
    const cabeza = filaInstantanea(store);

    world.tick++;
    for (const p of world.people) p.demography.age++;
    const descendiente = structuredClone(progenitor);
    descendiente.id = 'descendant-1';
    descendiente.genome = inheritGenome(world.seed, descendiente.id, [progenitor, archivado]);
    descendiente.bornAt = archivado.diedAt;
    descendiente.demography.age = world.tick - descendiente.bornAt;
    world.people.push(descendiente);
    world.birthCounter = 1;
    assert.equal(world.legacy.length + world.retiredLegacy.length, 0);

    const lecturas: ('lectura' | 'escritura')[] = [];
    let escribiendo = false;
    const leer = store.loadLegacy.bind(store);
    const observarLecturas = t.mock.method(store, 'loadLegacy', (id: string, atTick?: number) => {
      if (id === archivado.id) {
        assert.equal(store.db.isTransaction, true);
        lecturas.push(escribiendo ? 'escritura' : 'lectura');
      }
      return leer(id, atTick);
    });
    const exec = store.db.exec.bind(store.db);
    const intercalarCommit = t.mock.method(store.db, 'exec', (sql: string) => {
      if (sql !== 'BEGIN IMMEDIATE') return exec(sql);
      assert.equal(store.db.isTransaction, false);
      assert.deepEqual(lecturas, ['lectura']);
      // La primera validación ya terminó. El cambio debe confirmarse antes del bloqueo de escritura.
      const writer = new DatabaseSync(path);
      try {
        assert.equal(writer.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
        if (corromper) {
          const { changes } = writer.prepare('UPDATE main.legacy SET digest=? WHERE id=?')
            .run(sha256('identidad alterada'), archivado.id);
          assert.equal(changes, 1);
        } else {
          writer.prepare('INSERT INTO main.sessions VALUES (?,?)').run('sesion-externa', Number.MAX_SAFE_INTEGER);
        }
      } finally { writer.close(); }
      exec(sql);
      escribiendo = true;
    });

    const guardar = () => store.guardar({ world, materia: null });
    if (corromper) {
      assert.throws(guardar, /Archived identity checksum mismatch/);
      assert.deepEqual(filaInstantanea(store), cabeza);
    } else {
      guardar();
      assert.ok(store.sessionValid('sesion-externa'));
      assert.notEqual(filaInstantanea(store).digest, cabeza.digest);
    }
    assert.deepEqual(lecturas, ['lectura', 'escritura']);
    assert.equal(store.db.isTransaction, false);
    intercalarCommit.mock.restore();
    observarLecturas.mock.restore();
    assert.equal(store.cargarInstantanea()!.instantanea.world.tick, corromper ? 0 : 1);
  });
}
