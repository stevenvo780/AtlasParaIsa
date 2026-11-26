import assert from 'node:assert/strict';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../src/server/app.js';
import {
  PersistidorGuardado, RechazoBasePesosGuardadoError, type GuardadoConfirmado,
} from '../src/server/guardado-worker.js';
import { Store } from '../src/server/store.js';
import { escalon } from '../src/shared/interruptores.js';
import { codificarCheckpoint } from '../src/world/materia/checkpoint.js';
import { abrirLectorBasePesos } from '../src/world/motor/base-pesos-corte.js';
import { repartirPorTramos } from '../src/world/motor/bloques.js';
import { duenoSi } from '../src/world/motor/contexto.js';
import type { CapturaCorteTransferido } from '../src/world/motor/corte-transferido.js';
import { CanalesCorte, enviarParteCorte, type CorteRemotoBinario } from '../src/world/motor/mensajes-corte.js';
import {
  prepararPersonasDirectas, recibirPersonasDirectas, RechazoBasePesosError, type BasePesosActiva,
} from '../src/world/motor/personas-corte.js';
import { parteCorteDe } from '../src/world/motor/reunir.js';
import { createWorld } from '../src/world/mundo/crear.js';
import { stepWorld } from '../src/world/mundo/paso.js';
import { paramsOf, parseParams, setParams } from '../src/world/params.js';
import { bindWorldContext } from '../src/world/spatial.js';
import { filaInstantanea, laboratorio } from './lib/store.js';

function conEntorno(t: TestContext, valores: Record<string, string | undefined>): void {
  const anteriores = Object.keys(valores).map(clave => [clave, process.env[clave]] as const);
  for (const [clave, valor] of Object.entries(valores)) {
    if (valor === undefined) delete process.env[clave];
    else process.env[clave] = valor;
  }
  t.after(() => {
    for (const [clave, valor] of anteriores) {
      if (valor === undefined) delete process.env[clave];
      else process.env[clave] = valor;
    }
  });
}

function assertPesosBitABit(actual: readonly number[] | undefined, esperado: readonly number[] | undefined, etiqueta: string): void {
  if (esperado === undefined) {
    assert.equal(actual, undefined, `${etiqueta}: no debía tener pesos`);
    return;
  }
  assert.ok(actual, `${etiqueta}: faltan pesos`);
  assert.equal(actual.length, esperado.length, `${etiqueta}: longitud distinta`);
  for (let i = 0; i < esperado.length; i++) {
    assert.ok(Object.is(actual[i], esperado[i]), `${etiqueta}[${i}]: ${actual[i]} !== ${esperado[i]}`);
  }
}

function prepararMundoConRemotas(semilla: number, hilos: number) {
  const inicial = createWorld(semilla, parseParams({
    v23: escalon('duenos'), persistencia: { cadaTicks: 1 }, conducta: { politicaPeso: 1 },
  }));
  inicial.adaptationEnabled = false;
  const paginas = Object.values(inicial.chunks);
  const reparto = repartirPorTramos(paginas.map(p => p.cx), paginas.map(p => p.cy), hilos);
  const duenoDeChunk = new Map(paginas.map((pagina, i) => [`${pagina.cx},${pagina.cy}`, reparto[i]!] as const));
  const destinoEn = (hilo: number) => inicial.tiles.find(tesela => tesela.terrain !== 'water'
    && (tesela.x & 15) >= 4 && (tesela.x & 15) < 12 && (tesela.y & 15) >= 4 && (tesela.y & 15) < 12
    && duenoDeChunk.get(`${tesela.x >> 4},${tesela.y >> 4}`) === hilo);
  const remotas = inicial.people.filter(p => p.role === 'neighbor' && p.policy);
  assert.ok(remotas.length >= 2);
  const colocadas: typeof remotas = [];
  for (let h = 1; h < hilos; h++) {
    const destino = destinoEn(h);
    const persona = remotas[h - 1];
    assert.ok(destino && persona?.policy);
    persona.x = destino.x;
    persona.y = destino.y;
    persona.target = { x: destino.x, y: destino.y };
    persona.policy.weights[0] = -0;
    persona.policy.weights[1] = Number.MIN_VALUE;
    persona.policy.weights[2] = -0.25 * h;
    colocadas.push(persona);
  }
  return { inicial, colocadas };
}

test('base F64 compartida en guardado real: dos cortes, REF tras COMMIT y reapertura bit a bit con -0', async t => {
  conEntorno(t, {
    CARTA_MOTOR_HILOS: '3', CARTA_CORTE_TRANSFERIBLE: '1', CARTA_FAUNA_CORTE_DIRECTA: '1',
    CARTA_TESELAS_CORTE_DIRECTAS: '1', CARTA_PERSONAS_CORTE_DIRECTAS: '1', CARTA_SNAPSHOT_PESOS_SEPARADOS: '1',
    CARTA_BASE_PESOS_CORTE: undefined,
  });
  const { directory, store } = laboratorio(t, 'atlas-base-pesos-guardado-');
  const semilla = 7;
  const { inicial, colocadas } = prepararMundoConRemotas(semilla, 3);
  store.guardar({ world: inicial, materia: null });

  const persistir = t.mock.method(PersistidorGuardado.prototype, 'guardar');
  const app = createApp({
    store, origin: 'http://127.0.0.1:3000', password: 'base-pesos-guardado-v24', seed: semilla,
    tape: false, manual: true, confirmarGuardadoVivo: true,
    guardadoEnHilo: { snapshotPackedPeople: true, snapshotSplitPeopleWeights: true, basePesosCorte: true },
  });
  try {
    const mundo = app.world;
    const dueno = duenoSi(mundo);
    assert.ok(dueno);
    for (const remota of colocadas) {
      assert.ok(!mundo.people.some(p => p.id === remota.id), 'las personas con -0 residen en dueños remotos');
    }
    const epoca = app.guardado.epoca;

    // Corte 1: sin base previa publicada -> todo FULL y publica Base1 tras COMMIT.
    await app.stepOnce();
    await app.esperarGuardado();
    assert.equal(app.guardado.ultimoTickGuardado, 1);

    // Corte 2: los dueños remotos ya recibieron Base1 -> emiten REF verificando los 212 F64 bit a bit.
    await app.stepOnce();
    await app.esperarGuardado();
    assert.equal(app.guardado.ultimoTickGuardado, 2);
    assert.equal(app.guardado.epoca, epoca);
    assert.equal(app.salud().recargas, 0);
    assert.equal(app.failed, false);

    assert.equal(persistir.mock.callCount(), 2);
    const acuse1 = await persistir.mock.calls[0]!.result;
    const acuse2 = await persistir.mock.calls[1]!.result;
    assert.ok(acuse1?.basePesos && acuse2?.basePesos);

    assert.equal(acuse1.perfilPersistidor.personasRef, 0);
    assert.ok((acuse1.perfilPersistidor.personasFull ?? 0) >= colocadas.length);
    assert.ok((acuse1.perfilPersistidor.bytesPesos ?? 0) > 0);
    assert.equal(acuse1.perfilPersistidor.basePesosPublicada, true);
    assert.equal(acuse1.basePesos.secuencia, 1);
    assert.equal(acuse1.basePesos.epoca, epoca);

    assert.ok((acuse2.perfilPersistidor.personasRef ?? 0) >= colocadas.length);
    assert.ok((acuse2.perfilPersistidor.bytesPesos ?? Infinity) < acuse1.perfilPersistidor.bytesPesos!);
    assert.equal(acuse2.perfilPersistidor.basePesosPublicada, true);
    assert.equal(acuse2.basePesos.instancia, acuse1.basePesos.instancia);
    assert.equal(acuse2.basePesos.epoca, epoca);
    assert.equal(acuse2.basePesos.secuencia, 2);
    assert.notEqual(acuse2.basePesos.publicacion, acuse1.basePesos.publicacion);
    assert.equal(abrirLectorBasePesos(acuse1.basePesos).estaPublicada(), false, 'Base1 queda revocada tras publicar Base2');
    assert.equal(abrirLectorBasePesos(acuse2.basePesos).estaPublicada(), true, 'Base2 queda publicada tras COMMIT');

    const manifiesto = JSON.parse(filaInstantanea(store).body);
    assert.equal(manifiesto.snapshotEncoding, 'snapshot-parts-v5');
    assert.ok(manifiesto.policies?.count > 0);

    const vista = app.mundoParaEmision(true);
    const materiaViva = dueno.instantaneaMateria(dueno.pendientes());
    assert.ok(materiaViva);
    const copia = join(directory, 'base-pesos-reabrir.sqlite');
    store.backup(copia);
    const reabierto = new Store(copia);
    try {
      const carga = reabierto.cargarGuardadoCompleto();
      assert.ok(carga?.instantanea.materia);
      assert.equal(carga.metadatos.slot, 0);
      assert.equal(carga.instantanea.world.tick, 2);
      assert.equal(carga.instantanea.materia.epoca, epoca);
      assert.equal(Buffer.compare(codificarCheckpoint(carga.instantanea.materia), codificarCheckpoint(materiaViva)), 0);
      assert.equal(carga.instantanea.world.people.length, vista.people.length);
      for (const persona of vista.people) {
        const cargada = carga.instantanea.world.people.find(p => p.id === persona.id);
        assert.ok(cargada);
        assertPesosBitABit(cargada.policy?.weights, persona.policy?.weights, persona.id);
      }
      colocadas.forEach((remota, indice) => {
        const cargada = carga.instantanea.world.people.find(p => p.id === remota.id);
        assert.ok(cargada?.policy);
        assert.ok(Object.is(cargada.policy.weights[0], -0), `remota ${remota.id} conserva -0`);
        assert.equal(cargada.policy.weights[1], Number.MIN_VALUE);
        assert.equal(cargada.policy.weights[2], -0.25 * (indice + 1));
      });
    } finally { reabierto.close(); }
  } finally { await app.close(); }
});

test('ref caducada tras emisión: el persistidor rechaza sin corromper SQLite y la app recupera con FULL', async t => {
  conEntorno(t, {
    CARTA_MOTOR_HILOS: '2', CARTA_CORTE_TRANSFERIBLE: '1', CARTA_FAUNA_CORTE_DIRECTA: '1',
    CARTA_TESELAS_CORTE_DIRECTAS: '1', CARTA_PERSONAS_CORTE_DIRECTAS: '1', CARTA_SNAPSHOT_PESOS_SEPARADOS: '1',
    CARTA_BASE_PESOS_CORTE: undefined,
  });
  const { directory, store } = laboratorio(t, 'atlas-base-pesos-rechazo-');
  const semilla = 7;
  const { inicial, colocadas } = prepararMundoConRemotas(semilla, 2);
  const remota = colocadas[0]!;
  store.guardar({ world: inicial, materia: null });

  const originalGuardar = PersistidorGuardado.prototype.guardar;
  let rechazosObservados = 0;
  let refsEnPrimerIntentoTick2 = 0;
  let refsEnReintentoTick2 = -1;
  const resultados: GuardadoConfirmado[] = [];
  const espia = t.mock.method(
    PersistidorGuardado.prototype,
    'guardar',
    function (this: PersistidorGuardado, captura: CapturaCorteTransferido, solapado = false) {
      const refsBloques = captura.corte.remoto.sobres.reduce(
        (n, sobre) => n + (sobre.personas?.reduce((m, b) => m + (b.refs ? b.refs.pares.length / 2 : 0), 0) ?? 0), 0,
      );
      if (captura.corte.tick === 2 && rechazosObservados === 0) {
        refsEnPrimerIntentoTick2 = refsBloques;
        // La base se revoca en el escritor DESPUÉS de que los dueños ya emitieron sus REFs.
        this.revocarBasePesos();
        return originalGuardar.call(this, captura, solapado).catch(error => {
          assert.ok(error instanceof RechazoBasePesosGuardadoError, 'el persistidor debe señalar rechazo de base');
          assert.equal(error.baseRechazada, true);
          rechazosObservados++;
          throw error;
        });
      }
      if (captura.corte.tick === 2 && rechazosObservados === 1) {
        refsEnReintentoTick2 = refsBloques;
      }
      return originalGuardar.call(this, captura, solapado).then(acuse => {
        resultados.push(acuse);
        return acuse;
      });
    },
  );

  const app = createApp({
    store, origin: 'http://127.0.0.1:3000', password: 'base-pesos-rechazo-v24', seed: semilla,
    tape: false, manual: true, confirmarGuardadoVivo: true,
    guardadoEnHilo: { snapshotPackedPeople: true, snapshotSplitPeopleWeights: true, basePesosCorte: true },
  });
  try {
    const epoca = app.guardado.epoca;
    // Corte 1: FULL + publica Base1.
    await app.stepOnce();
    await app.esperarGuardado();
    assert.equal(app.guardado.ultimoTickGuardado, 1);

    // Corte 2: dueños emiten REF -> base revocada antes de aceptar -> rechazo -> reintento automático FULL.
    await app.stepOnce();
    await app.esperarGuardado();
    assert.equal(rechazosObservados, 1);
    assert.ok(refsEnPrimerIntentoTick2 > 0, 'el primer intento del tick 2 debía transportar REFs');
    assert.equal(refsEnReintentoTick2, 0, 'el reintento tras rechazo debe ir 100% FULL');
    assert.equal(app.guardado.ultimoTickGuardado, 2);
    assert.equal(app.failed, false);
    assert.equal(app.salud().recargas, 0);

    // Corte 3: tras publicar Base2 en el reintento FULL, vuelve a emitir REF.
    await app.stepOnce();
    await app.esperarGuardado();
    assert.equal(app.guardado.ultimoTickGuardado, 3);
    assert.equal(app.guardado.epoca, epoca);
    assert.equal(app.failed, false);
    assert.equal(app.salud().recargas, 0);

    assert.equal(espia.mock.callCount(), 4);
    assert.equal(resultados.length, 3);
    const [acuse1, acuse2, acuse3] = resultados as [GuardadoConfirmado, GuardadoConfirmado, GuardadoConfirmado];
    assert.equal(acuse1.perfilPersistidor.personasRef, 0);
    assert.equal(acuse2.perfilPersistidor.personasRef, 0, 'el reintento confirmado del tick 2 fue FULL');
    assert.ok((acuse2.perfilPersistidor.personasFull ?? 0) > 0);
    assert.ok(acuse2.basePesos && acuse1.basePesos);
    assert.notEqual(acuse2.basePesos.publicacion, acuse1.basePesos.publicacion);
    assert.ok((acuse3.perfilPersistidor.personasRef ?? 0) > 0, 'el tick 3 vuelve a reutilizar la nueva base');

    const vista = app.mundoParaEmision(true);
    const copia = join(directory, 'recuperado.sqlite');
    store.backup(copia);
    const reabierto = new Store(copia);
    try {
      const carga = reabierto.cargarGuardadoCompleto();
      assert.ok(carga);
      assert.equal(carga.metadatos.slot, 0);
      assert.equal(carga.instantanea.world.tick, 3);
      for (const persona of vista.people) {
        const cargada = carga.instantanea.world.people.find(p => p.id === persona.id);
        assert.ok(cargada);
        assertPesosBitABit(cargada.policy?.weights, persona.policy?.weights, persona.id);
      }
      const pesos = carga.instantanea.world.people.find(p => p.id === remota.id)?.policy?.weights;
      assert.ok(pesos && Object.is(pesos[0], -0));
      assert.equal(pesos[1], Number.MIN_VALUE);
    } finally { reabierto.close(); }
  } finally { await app.close(); }
});

test('migración entre dueños remotos y cambio +0→-0: el migrante intacto usa REF y el -0 mutado cae a FULL', t => {
  const { store } = laboratorio(t, 'atlas-base-pesos-migracion-', {
    snapshotPackedPeople: true, snapshotSplitPeopleWeights: true,
  });
  const baseMundo = createWorld(19, parseParams({
    v23: escalon('duenos'), persistencia: { cadaTicks: 1 }, conducta: { politicaPeso: 1 },
  }));
  baseMundo.adaptationEnabled = false;
  stepWorld(baseMundo, []);
  const personaA = baseMundo.people.find(p => p.policy && p.uid !== undefined)!;
  const personaB = baseMundo.people.find(p => p.policy && p.uid !== undefined && p.id !== personaA.id)!;
  assert.ok(personaA.policy && personaB.policy && personaA.uid && personaB.uid);
  personaA.policy.weights[0] = -0;
  personaA.policy.weights[1] = Number.MIN_VALUE;
  personaB.policy.weights[0] = 0; // +0 en el corte 1

  // Corte 1 durable en SQLite (WPG5 + WGP1).
  store.guardar({ world: baseMundo, materia: null });
  const carga1 = store.cargarGuardadoCompleto();
  assert.ok(carga1);
  const publicador = store.construirBasePesosDurable('inst-mig', carga1.epoca, 1);
  assert.ok(publicador);
  const descriptor = publicador.publicarTrasAcuse({ ...publicador.identidad, confirmado: true });
  const baseActiva: BasePesosActiva = {
    lector: abrirLectorBasePesos(descriptor),
    contexto: {
      instancia: descriptor.instancia,
      epoca: descriptor.epoca,
      secuencia: descriptor.secuencia,
      publicacion: descriptor.publicacion,
    },
  };

  // Entre cortes: personaA migra del dueño 1 al dueño 2 conservando sus 212 F64 (-0 incluido);
  // personaB permanece en el dueño 2 pero invierte su peso 0 de +0 a -0.
  const parteDueno2 = parteCorteDe(structuredClone(baseMundo));
  const copiaA = parteDueno2.people.find(p => p.id === personaA.id)!;
  const copiaB = parteDueno2.people.find(p => p.id === personaB.id)!;
  copiaB.policy!.weights[0] = -0;
  parteDueno2.people = [copiaA, copiaB];

  const bloques = prepararPersonasDirectas(parteDueno2, baseActiva);
  assert.ok(bloques && bloques.length === 1);
  const bloque = bloques[0]!;
  assert.ok(bloque.refs, 'personaA migrada sin cambios debe emitir REF');
  assert.equal(bloque.refs.pares.length, 2, 'solo personaA emite REF; personaB cambió +0→-0 y va FULL');
  assert.equal(bloque.refs.pares[0], 0);

  const diagnostico = { personasRef: 0, personasFull: 0 };
  const recibidas = recibirPersonasDirectas(bloques, 2, {
    transferirCuerpo: true, transferirPesos: true, basePesos: baseActiva, diagnostico,
  });
  assert.equal(diagnostico.personasRef, 1);
  assert.equal(diagnostico.personasFull, 1);

  // Al guardar el corte 2 en SQLite y reabrirlo, ambos conservan exactamente -0 y MIN_VALUE,
  // y la fila REF nunca expande su array de 212 pesos durante assertWorld ni SnapshotParts.
  assert.equal(typeof Object.getOwnPropertyDescriptor(recibidas[0]!.policy!, 'weights')?.get, 'function');
  const mundoCorte2 = structuredClone(baseMundo);
  setParams(mundoCorte2, paramsOf(baseMundo));
  bindWorldContext(mundoCorte2, store.context);
  const idxA = mundoCorte2.people.findIndex(p => p.id === personaA.id);
  const idxB = mundoCorte2.people.findIndex(p => p.id === personaB.id);
  mundoCorte2.people[idxA] = recibidas[0]!;
  mundoCorte2.people[idxB] = recibidas[1]!;
  store.guardar({ world: mundoCorte2, materia: null });
  assert.equal(typeof Object.getOwnPropertyDescriptor(recibidas[0]!.policy!, 'weights')?.get, 'function',
    'guardar una fila REF no debe expandir los 212 Float64 en JS');

  const carga2 = store.cargarGuardadoCompleto();
  assert.ok(carga2);
  const cargadaA = carga2.instantanea.world.people.find(p => p.id === personaA.id)!;
  const cargadaB = carga2.instantanea.world.people.find(p => p.id === personaB.id)!;
  assert.ok(Object.is(cargadaA.policy!.weights[0], -0), 'personaA migrada conserva -0 tras REF');
  assert.equal(cargadaA.policy!.weights[1], Number.MIN_VALUE);
  assert.ok(Object.is(cargadaB.policy!.weights[0], -0), 'personaB (+0→-0) persiste -0 por ruta FULL');

  const bloquesAntesDeRevocar = prepararPersonasDirectas(parteDueno2, baseActiva);
  assert.ok(bloquesAntesDeRevocar?.[0]?.refs);
  publicador.revocar();
  // Referencia emitida antes de revocar se rechaza con RechazoBasePesosError sin tocar SQLite;
  // una emisión posterior contra la base ya revocada cae automáticamente a FULL.
  assert.throws(
    () => recibirPersonasDirectas(bloquesAntesDeRevocar, 2, { basePesos: baseActiva }),
    (error: unknown) => error instanceof RechazoBasePesosError && error.motivo === 'base_revocada',
  );
  const canales = CanalesCorte.abrir(1);
  assert.ok(canales);
  try {
    const solicitud = canales.pedir(false, false, true, false, true);
    enviarParteCorte(canales.puertosRemotos[0]!, canales.solicitud, carga1.epoca, 1, baseMundo, undefined, baseActiva);
    const remoto: CorteRemotoBinario = canales.retirarCorte(solicitud, carga1.epoca, baseMundo.tick);
    assert.equal(remoto.sobres[0]!.personas?.some(b => b.refs !== undefined) ?? false, false);
  } finally {
    canales.cerrar();
  }
});

test('opción inicialmente apagada: sin basePesosCorte no publica base y valida requisitos si se activa', async t => {
  conEntorno(t, {
    CARTA_MOTOR_HILOS: '2', CARTA_CORTE_TRANSFERIBLE: '1', CARTA_FAUNA_CORTE_DIRECTA: '1',
    CARTA_TESELAS_CORTE_DIRECTAS: '1', CARTA_PERSONAS_CORTE_DIRECTAS: '1', CARTA_SNAPSHOT_PESOS_SEPARADOS: '1',
    CARTA_BASE_PESOS_CORTE: undefined,
  });
  const { store } = laboratorio(t, 'atlas-base-pesos-apagada-');
  const semilla = 7;
  const { inicial } = prepararMundoConRemotas(semilla, 2);
  store.guardar({ world: inicial, materia: null });

  assert.throws(() => createApp({
    store, origin: 'http://127.0.0.1:3000', password: 'base-pesos-invalida', seed: semilla,
    tape: false, manual: true, confirmarGuardadoVivo: true,
    guardadoEnHilo: { snapshotPackedPeople: true, snapshotSplitPeopleWeights: false, basePesosCorte: true },
  }), /pesos de política separados/);

  const persistir = t.mock.method(PersistidorGuardado.prototype, 'guardar');
  const app = createApp({
    store, origin: 'http://127.0.0.1:3000', password: 'base-pesos-apagada-v24', seed: semilla,
    tape: false, manual: true, confirmarGuardadoVivo: true,
    guardadoEnHilo: { snapshotPackedPeople: true, snapshotSplitPeopleWeights: true },
  });
  try {
    await app.stepOnce();
    await app.esperarGuardado();
    await app.stepOnce();
    await app.esperarGuardado();
    assert.equal(persistir.mock.callCount(), 2);
    for (const llamada of persistir.mock.calls) {
      const acuse = await llamada.result;
      assert.equal(acuse?.basePesos, undefined);
      assert.equal(acuse?.perfilPersistidor.personasRef, undefined);
      assert.equal(acuse?.perfilPersistidor.basePesosPublicada, undefined);
    }
    assert.equal(app.failed, false);
  } finally { await app.close(); }
});
