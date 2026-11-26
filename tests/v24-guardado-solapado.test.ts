import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { setImmediate as siguienteVuelta } from 'node:timers/promises';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { stringifyExact } from '../src/shared/exact-json.js';
import { escalon } from '../src/shared/interruptores.js';
import { assertChronicleJournal } from '../src/world/chronicle-journal.js';
import { Dueno, duenoSi } from '../src/world/motor/contexto.js';
import { createWorld } from '../src/world/mundo/crear.js';
import { parseParams } from '../src/world/params.js';
import { filaInstantanea, laboratorio } from './lib/store.js';

const maxTicksSolapados = 3;
const sesion = 'sesion-guardado-solapado';
const textoMarca = 'Suceso de prueba del guardado solapado';

function escenario(t: TestContext, cadaTicks: number) {
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

  const { path, store } = laboratorio(t, 'atlas-guardado-solapado-');
  const semilla = 7;
  const inicial = createWorld(semilla, parseParams({
    v23: escalon('duenos'), persistencia: { cadaTicks }, conducta: { politicaPeso: 1 },
  }));
  // Los halos de la huerta y el refugio cubren los seis chunks iniciales mientras descansan.
  const destinos = inicial.places.filter(lugar => lugar.id === 'huerta' || lugar.id === 'refugio');
  assert.equal(destinos.length, 2);
  for (const [i, persona] of inicial.people.entries()) {
    const destino = destinos[i % destinos.length];
    assert.ok(destino);
    persona.x = destino.x;
    persona.y = destino.y;
    persona.target = { x: destino.x, y: destino.y };
    persona.action = 'rest';
    persona.decisionAt = 120;
  }
  store.guardar({ world: inicial, materia: null });

  const gancho = Dueno.prototype.gancho;
  t.mock.method(Dueno.prototype, 'gancho', function (this: Dueno, fase: Parameters<Dueno['gancho']>[0]) {
    gancho.call(this, fase);
    if (fase === 'F6' && this.hilo === 0 && this.mundo.tick >= cadaTicks) {
      this.suceso({ kind: 'ecology', actors: [], text: textoMarca, cause: 'Marcador emitido por el dueño 0 en F6.', source: 'simulation' });
    }
  });

  const app = createApp({
    store, origin: 'http://127.0.0.1:3000', password: 'guardado-solapado-v24', seed: semilla,
    tape: false, manual: true, confirmarGuardadoVivo: true,
    guardadoEnHilo: { snapshotPackedPeople: true, snapshotSplitPeopleWeights: true, maxTicksSolapados },
    onFatalExit: codigo => assert.fail(`Salida fatal inesperada (${codigo}).`),
  });
  const { x, y } = destinos[0]!;
  store.addSession(sesion, Date.now() + 60_000);
  return { app, path, store, gesto: { id: 'gesto-tras-guardado-solapado', kind: 'invite' as const, x, y } };
}

function abrirCabeza(path: string) {
  const lector = new Store(path, { readOnly: true });
  try {
    const carga = lector.verificarGuardado();
    assert.ok(carga);
    assert.equal(carga.slot, 0);
    return carga.world;
  } finally { lector.close(); }
}

for (const { motivo, cadaTicks, posteriores } of [
  { motivo: 'una entrada', cadaTicks: 4, posteriores: 2 },
  { motivo: 'la siguiente cadencia', cadaTicks: 3, posteriores: 2 },
  { motivo: 'el límite de atraso', cadaTicks: 5, posteriores: maxTicksSolapados },
]) test(`el motor avanza durante el guardado y drena antes de ${motivo}`, async t => {
  const { app, path, store, gesto } = escenario(t, cadaTicks);
  const bloqueo = new DatabaseSync(path);
  try {
    const vivo = app.world, dueno = duenoSi(vivo), epoca = app.guardado.epoca;
    const anterior = filaInstantanea(store);
    assert.ok(dueno);
    bloqueo.exec('BEGIN IMMEDIATE');
    for (let tick = 1; tick <= cadaTicks; tick++) {
      app.stepOnce();
      assert.equal(vivo.tick, tick);
    }
    const acuse = app.esperarGuardado();
    assert.ok(acuse, 'la cadencia debe abrir un guardado en vuelo');
    assert.equal(vivo.retiredChunks.length, 0, 'el corte de la prueba puede solaparse');
    const corte = app.mundoParaEmision(true);
    const contadorCorte = vivo.eventCounter;
    const tickVivo = cadaTicks + posteriores;
    for (let tick = cadaTicks + 1; tick <= tickVivo; tick++) {
      app.stepOnce();
      assert.equal(vivo.tick, tick, 'cada paso posterior se ejecuta con SQLite bloqueado');
      assert.equal(app.guardado.ultimoTickGuardado, 0);
    }
    const eventosVivos = structuredClone(vivo.events);
    const contadorVivo = vivo.eventCounter;
    const sufijo = structuredClone(vivo.chronicleJournal!.pending.filter(e => e.tick > cadaTicks));
    assert.deepEqual(sufijo.filter(e => e.text === textoMarca).map(e => e.tick),
      Array.from({ length: posteriores }, (_, i) => cadaTicks + i + 1));

    // Esta continuación observa el acuse antes de que se ejecute el paso bloqueado.
    const comprobacion = acuse.then(() => {
      assert.equal(app.world, vivo);
      assert.equal(duenoSi(app.world), dueno);
      assert.equal(app.guardado.epoca, epoca);
      assert.equal(vivo.tick, tickVivo);
      assert.equal(vivo.eventCounter, contadorVivo);
      assert.deepEqual(vivo.events, eventosVivos);
      assert.equal(vivo.chronicleJournal?.committedThrough, contadorCorte);
      assert.deepEqual(vivo.chronicleJournal?.pending, sufijo);
      assertChronicleJournal(vivo);
      assert.equal(app.guardado.ultimoTickGuardado, cadaTicks);
      const duradero = abrirCabeza(path);
      assert.equal(duradero.tick, cadaTicks);
      assert.equal(duradero.eventCounter, contadorCorte);
      assert.equal(stringifyExact(duradero.people), stringifyExact(corte.people));
      assert.deepEqual(duradero.events, corte.events);
    });
    const recibo = motivo === 'una entrada' ? app.requestGesture(gesto, sesion) : undefined;
    const siguiente = app.stepOnce();
    assert.ok(siguiente, 'el paso siguiente debe esperar el acuse');
    await siguienteVuelta();
    assert.equal(vivo.tick, tickVivo);
    assert.equal(app.guardado.ultimoTickGuardado, 0);
    assert.deepEqual(filaInstantanea(store), anterior);
    assert.equal(store.result(gesto), null);

    bloqueo.exec('COMMIT');
    await Promise.all([comprobacion, siguiente]);
    assert.equal(vivo.tick, tickVivo + 1);
    if (recibo) {
      const guardado = await recibo;
      assert.ok(guardado.accepted);
      assert.equal(guardado.tick, tickVivo + 1);
      assert.deepEqual(store.result(gesto), guardado);
      assert.equal(abrirCabeza(path).tick, tickVivo + 1);
    } else if (motivo === 'la siguiente cadencia') {
      await app.esperarGuardado();
      assert.equal(abrirCabeza(path).tick, tickVivo + 1);
    } else {
      assert.equal(app.guardado.ultimoTickGuardado, cadaTicks);
    }
    assert.equal(app.failed, false);
  } finally {
    if (bloqueo.isTransaction) bloqueo.exec('ROLLBACK');
    bloqueo.close();
    await app.close();
  }
});

test('un rechazo del guardado solapado pausa antes de aceptar entradas y conserva la cabeza durable', async t => {
  const { app, path, store, gesto } = escenario(t, 3);
  const anterior = filaInstantanea(store);
  const bloqueo = new DatabaseSync(path);
  try {
    bloqueo.exec('BEGIN IMMEDIATE');
    // El coordinador admite el corte sobre el esquema visible. Al liberar el escritor,
    // el persistidor encuentra el nuevo trigger en su propia transacción y rechaza el corte.
    bloqueo.exec(`CREATE TRIGGER fallar_corte BEFORE INSERT ON snapshots WHEN NEW.slot=0
      BEGIN SELECT RAISE(ABORT,'Fallo de guardado para la prueba'); END`);
    for (let tick = 1; tick <= 5; tick++) {
      app.stepOnce();
      assert.equal(app.world.tick, tick);
    }
    const acuse = app.esperarGuardado();
    assert.ok(acuse);
    assert.deepEqual(app.world.events.filter(e => e.text === textoMarca).map(e => e.tick), [3, 4, 5]);
    const rechazo = assert.rejects(app.requestGesture(gesto, sesion), { status: 503 });
    const siguiente = app.stepOnce();
    assert.ok(siguiente);
    await siguienteVuelta();
    assert.equal(app.world.tick, 5);

    bloqueo.exec('COMMIT');
    await Promise.allSettled([acuse, siguiente]);
    await rechazo;
    assert.equal(app.failed, true);
    assert.equal(app.guardado.ultimoTickGuardado, 0);
    assert.equal(store.result(gesto), null);
    await app.close();
    assert.deepEqual(filaInstantanea(store), anterior);
    assert.equal(abrirCabeza(path).tick, 0);
  } finally {
    if (bloqueo.isTransaction) bloqueo.exec('ROLLBACK');
    bloqueo.close();
    await app.close();
  }
});
