import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setImmediate as siguienteVuelta } from 'node:timers/promises';
import { createApp } from '../src/server/app.js';
import { PersistidorGuardado } from '../src/server/guardado-worker.js';
import { Store } from '../src/server/store.js';
import { escalon } from '../src/shared/interruptores.js';
import { codificarCheckpoint } from '../src/world/materia/checkpoint.js';
import { repartirPorTramos } from '../src/world/motor/bloques.js';
import { duenoSi } from '../src/world/motor/contexto.js';
import { inyectarFalloConfirmarGuardadoParaPrueba } from '../src/world/motor/coordinador.js';
import { createWorld } from '../src/world/mundo/crear.js';
import { parseParams } from '../src/world/params.js';
import { filaInstantanea, laboratorio } from './lib/store.js';

function afinidadDe(status: string): string {
  const lista = /^Cpus_allowed_list:[\t ]+([0-9,-]+)$/m.exec(readFileSync(status, 'utf8'))?.[1];
  assert.ok(lista, `Falta la lista de CPU permitidos en ${status}.`);
  return lista;
}

test('el guardado rutinario cede el event loop y conserva dueños, pesos y materia', async t => {
  const entorno = {
    CARTA_MOTOR_HILOS: '2', CARTA_CORTE_TRANSFERIBLE: '1', CARTA_FAUNA_CORTE_DIRECTA: '1',
    CARTA_TESELAS_CORTE_DIRECTAS: '1', CARTA_PERSONAS_CORTE_DIRECTAS: '1', CARTA_SNAPSHOT_PESOS_SEPARADOS: '1',
  };
  const anteriores = Object.keys(entorno).map(clave => [clave, process.env[clave]] as const);
  Object.assign(process.env, entorno);
  t.after(() => {
    for (const [clave, valor] of anteriores) {
      if (valor === undefined) delete process.env[clave];
      else process.env[clave] = valor;
    }
  });

  const { directory, path, store } = laboratorio(t, 'atlas-guardado-en-hilo-');
  const semilla = 7;
  const inicial = createWorld(semilla, parseParams({
    v23: escalon('duenos'), persistencia: { cadaTicks: 1 }, conducta: { politicaPeso: 1 },
  }));
  inicial.adaptationEnabled = false;
  const paginas = Object.values(inicial.chunks);
  const reparto = repartirPorTramos(paginas.map(p => p.cx), paginas.map(p => p.cy), 2);
  const destino = inicial.tiles.find(tesela => tesela.terrain !== 'water'
    && (tesela.x & 15) >= 4 && (tesela.x & 15) < 12 && (tesela.y & 15) >= 4 && (tesela.y & 15) < 12
    && paginas.some((pagina, i) => reparto[i] === 1 && pagina.cx === (tesela.x >> 4) && pagina.cy === (tesela.y >> 4)));
  const remota = inicial.people.find(p => p.role === 'neighbor');
  assert.ok(destino && remota?.policy);
  remota.x = destino.x;
  remota.y = destino.y;
  remota.target = { x: destino.x, y: destino.y };
  remota.policy.weights[0] = -0;
  remota.policy.weights[1] = Number.MIN_VALUE;
  store.guardar({ world: inicial, materia: null });

  let afinidadInicial: string | undefined;
  let cpuPersistidor: number | undefined;
  if (process.platform === 'linux') {
    const taskset = spawnSync('taskset', ['--version'], { stdio: 'ignore' });
    if ((taskset.error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      assert.ifError(taskset.error);
      assert.equal(taskset.status, 0);
      afinidadInicial = afinidadDe('/proc/thread-self/status');
      cpuPersistidor = Number.parseInt(afinidadInicial, 10);
      assert.ok(Number.isSafeInteger(cpuPersistidor));
    }
  }
  if (cpuPersistidor === undefined) t.diagnostic('La comprobación de afinidad requiere Linux y taskset.');
  const persistir = t.mock.method(PersistidorGuardado.prototype, 'guardar');
  const app = createApp({
    store, origin: 'http://127.0.0.1:3000', password: 'guardado-en-hilo-v24', seed: semilla,
    tape: false, manual: true, confirmarGuardadoVivo: true,
    guardadoEnHilo: { snapshotPackedPeople: true, snapshotSplitPeopleWeights: true,
      ...(cpuPersistidor === undefined ? {} : { cpuPersistidor }) },
  });
  try {
    const mundo = app.world;
    const dueno = duenoSi(mundo);
    assert.ok(dueno);
    assert.ok(!mundo.people.some(p => p.id === remota.id), 'la persona con pesos extremos reside en el dueño remoto');
    const epoca = app.guardado.epoca;
    const cabezaInicial = filaInstantanea(store);
    const sesion = 'sesion-guardado-en-hilo';
    store.addSession(sesion, Date.now() + 60_000);

    // El bloqueo de escritura impide el COMMIT hasta que el hilo de la app vuelve al event loop.
    const bloqueo = new DatabaseSync(path);
    try {
      bloqueo.exec('BEGIN IMMEDIATE');
      const paso = app.stepOnce();
      const acuse = app.esperarGuardado();
      assert.ok(acuse, 'el paso rutinario debe iniciar un guardado en el hilo');
      await siguienteVuelta();
      assert.equal(app.stepOnce(), acuse, 'otra llamada comparte el paso pendiente');
      assert.equal(app.world.tick, 1);
      assert.equal(app.guardado.ultimoTickGuardado, 0);
      assert.deepEqual(filaInstantanea(store), cabezaInicial);
      assert.equal(store.sessionValid(sesion), true);
      bloqueo.exec('COMMIT');
      await paso;
      await acuse;
    } finally {
      if (bloqueo.isTransaction) bloqueo.exec('ROLLBACK');
      bloqueo.close();
    }

    assert.equal(app.guardado.ultimoTickGuardado, 1);
    await app.stepOnce();
    await app.esperarGuardado();
    assert.equal(app.guardado.ultimoTickGuardado, 2);
    assert.equal(app.guardado.epoca, epoca);
    assert.equal(app.world, mundo);
    assert.equal(duenoSi(app.world), dueno);
    assert.equal(app.salud().recargas, 0);
    assert.ok(!mundo.people.some(p => p.id === remota.id));

    assert.equal(persistir.mock.callCount(), 2);
    for (const [index, llamada] of persistir.mock.calls.entries()) {
      const acuse = await llamada.result;
      assert.ok(acuse);
      assert.equal(acuse.tick, index + 1);
      const perfil = acuse.perfilPersistidor;
      assert.ok(perfil);
      for (const fase of [perfil.materializar, perfil.guardar]) {
        assert.ok(Number.isFinite(fase.paredMs) && fase.paredMs >= 0);
        if (typeof process.threadCpuUsage === 'function') assert.notEqual(fase.cpuMs, null);
        if (fase.cpuMs !== null) assert.ok(Number.isFinite(fase.cpuMs) && fase.cpuMs >= 0);
      }
      if (cpuPersistidor !== undefined) {
        assert.ok(perfil.tid !== null && Number.isSafeInteger(perfil.tid) && perfil.tid > 0);
        assert.notEqual(perfil.tid, process.pid);
        assert.equal(perfil.afinidad, String(cpuPersistidor));
        assert.equal(afinidadDe(`/proc/self/task/${perfil.tid}/status`), String(cpuPersistidor));
        assert.equal(afinidadDe('/proc/thread-self/status'), afinidadInicial);
      }
    }

    const manifiesto = JSON.parse(filaInstantanea(store).body);
    assert.equal(manifiesto.snapshotEncoding, 'snapshot-parts-v5');
    assert.ok(manifiesto.policies?.count > 0);
    const vista = app.mundoParaEmision(true);
    const materiaViva = dueno.instantaneaMateria(dueno.pendientes());
    assert.ok(materiaViva);
    const copia = join(directory, 'confirmado.sqlite');
    store.backup(copia);
    const reabierto = new Store(copia);
    try {
      const carga = reabierto.cargarGuardadoCompleto();
      assert.ok(carga?.instantanea.materia);
      assert.equal(carga.metadatos.slot, 0);
      assert.equal(carga.instantanea.world.tick, 2);
      assert.equal(carga.instantanea.materia.epoca, epoca);
      assert.equal(Buffer.compare(codificarCheckpoint(carga.instantanea.materia), codificarCheckpoint(materiaViva)), 0);
      const pesos = carga.instantanea.world.people.find(p => p.id === remota.id)?.policy?.weights;
      assert.ok(pesos && Object.is(pesos[0], -0));
      assert.equal(pesos[1], Number.MIN_VALUE);
      assert.deepEqual(carga.instantanea.world.people.map(p => [p.id, p.policy?.weights]),
        vista.people.map(p => [p.id, p.policy?.weights]));
      assert.equal(reabierto.sessionValid(sesion), true);
    } finally { reabierto.close(); }

    const gesto = { id: 'gesto-durable-en-rutina', kind: 'invite' as const, x: destino.x, y: destino.y };
    const promesa = app.requestGesture(gesto, sesion);
    const pasoConEntrada = app.stepOnce();
    assert.equal(app.esperarGuardado(), undefined, 'el paso con sesión y gesto usa el guardado local');
    assert.equal(app.guardado.ultimoTickGuardado, 3);
    const recibo = store.result(gesto);
    assert.ok(recibo?.accepted);
    assert.equal(recibo.tick, 3);
    await pasoConEntrada;
    assert.deepEqual(await promesa, recibo);
    assert.equal(app.failed, false);

    t.after(() => inyectarFalloConfirmarGuardadoParaPrueba(null));
    inyectarFalloConfirmarGuardadoParaPrueba(1);
    await app.stepOnce();
    assert.equal(app.world.tick, 4);
    assert.equal(app.guardado.ultimoTickGuardado, 4);
    assert.equal(app.salud().recargas, 1);
    assert.ok(app.guardado.epoca > epoca);
    assert.deepEqual(store.result(gesto), recibo);
    await app.stepOnce();
    assert.equal(app.guardado.ultimoTickGuardado, 5);
    assert.equal(app.failed, false);
  } finally { await app.close(); }
});
