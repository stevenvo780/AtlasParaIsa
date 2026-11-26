import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { LegacyRecord } from '../src/shared/demography.js';
import { demographicTraits } from '../src/world/demography.js';
import { inheritGenome } from '../src/world/genetics.js';
import { createWorld } from '../src/world/index.js';
import { parseParams } from '../src/world/params.js';
import { filaInstantanea, laboratorio, sha256 } from './lib/store.js';

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
    assert.equal(store.load()!.world.tick, corromper ? 0 : 1);
  });
}
