import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { setImmediate as siguienteVuelta } from 'node:timers/promises';
import { createApp } from '../src/server/app.js';
import {
  PersistidorGuardado, RechazoBasePesosGuardadoError,
  type GuardadoConfirmado, type ResultadoAutorizacionTicket,
} from '../src/server/guardado-worker.js';
import { WPF1_WEIGHT_BYTES, WPF1_WEIGHT_COUNT } from '../src/server/snapshot-packed-people.js';
import { Store } from '../src/server/store.js';
import { escalon } from '../src/shared/interruptores.js';
import { assertChronicleJournal } from '../src/world/chronicle-journal.js';
import { codificarCheckpoint } from '../src/world/materia/checkpoint.js';
import {
  abrirLectorBasePesos, abrirLectorReconstruccionBasePesos, construirBasePesosDesdeFilasWgp1,
  type DescriptorBasePesosCorte, type IdentidadBasePesos,
} from '../src/world/motor/base-pesos-corte.js';
import { repartirPorTramos } from '../src/world/motor/bloques.js';
import { Dueno, duenoSi } from '../src/world/motor/contexto.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import type { CapturaCorteTransferido, IdentidadCorteTransferido } from '../src/world/motor/corte-transferido.js';
import {
  CanalesCorte, decodificarCorteRemoto, enviarParteCorte, inspeccionarReferenciasCorte,
  reconstruirCorteRemotoFull, type CorteRemotoBinario,
} from '../src/world/motor/mensajes-corte.js';
import {
  prepararPersonasDirectas, recibirPersonasDirectas, reconstruirBloquesPersonasFull, RechazoBasePesosError,
  type BasePesosActiva, type BloquePersonasCorte,
} from '../src/world/motor/personas-corte.js';
import { parteCorteDe } from '../src/world/motor/reunir.js';
import { createWorld } from '../src/world/mundo/crear.js';
import { stepWorld } from '../src/world/mundo/paso.js';
import { paramsOf, parseParams, setParams } from '../src/world/params.js';
import { bindWorldContext } from '../src/world/spatial.js';
import { filaInstantanea, laboratorio } from './lib/store.js';

const MAX_TICKS_SOLAPADOS = 3;
const TEXTO_MARCA = 'Suceso de prueba REF solapado';

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

function crearEscenarioSolapado(t: TestContext, hilos: number, cadaTicks: number) {
  conEntorno(t, {
    CARTA_MOTOR_HILOS: String(hilos), CARTA_CORTE_TRANSFERIBLE: '1', CARTA_FAUNA_CORTE_DIRECTA: '1',
    CARTA_TESELAS_CORTE_DIRECTAS: '1', CARTA_PERSONAS_CORTE_DIRECTAS: '1', CARTA_SNAPSHOT_PESOS_SEPARADOS: '1',
    CARTA_BASE_PESOS_CORTE: undefined,
  });
  const { directory, path, store } = laboratorio(t, 'atlas-ref-solapado-');
  const semilla = 7;
  const inicial = createWorld(semilla, parseParams({
    v23: escalon('duenos'), persistencia: { cadaTicks }, conducta: { politicaPeso: 1 },
  }));
  inicial.adaptationEnabled = false;
  const destinos = inicial.places.filter(lugar => lugar.id === 'huerta' || lugar.id === 'refugio');
  assert.equal(destinos.length, 2);
  for (const [i, persona] of inicial.people.entries()) {
    const destino = destinos[i % destinos.length]!;
    persona.x = destino.x;
    persona.y = destino.y;
    persona.target = { x: destino.x, y: destino.y };
    persona.action = 'rest';
    persona.decisionAt = 120;
  }
  const paginas = Object.values(inicial.chunks);
  const reparto = repartirPorTramos(paginas.map(p => p.cx), paginas.map(p => p.cy), hilos);
  const duenoDeChunk = new Map(paginas.map((p, i) => [`${p.cx},${p.cy}`, reparto[i]!] as const));
  const remotas = inicial.people.filter(p => p.role === 'neighbor' && p.policy);
  assert.ok(remotas.length >= hilos - 1);
  const colocadas: typeof remotas = [];
  for (let h = 1; h < hilos; h++) {
    const destino = inicial.tiles.find(tesela => tesela.terrain !== 'water'
      && (tesela.x & 15) >= 4 && (tesela.x & 15) < 12 && (tesela.y & 15) >= 4 && (tesela.y & 15) < 12
      && duenoDeChunk.get(`${tesela.x >> 4},${tesela.y >> 4}`) === h);
    const persona = remotas[h - 1];
    assert.ok(destino && persona?.policy);
    persona.x = destino.x;
    persona.y = destino.y;
    persona.target = { x: destino.x, y: destino.y };
    persona.action = 'rest';
    persona.decisionAt = 120;
    persona.policy.weights[0] = -0;
    persona.policy.weights[1] = Number.MIN_VALUE;
    persona.policy.weights[2] = -0.25 * h;
    colocadas.push(persona);
  }
  store.guardar({ world: inicial, materia: null });

  const gancho = Dueno.prototype.gancho;
  t.mock.method(Dueno.prototype, 'gancho', function (this: Dueno, fase: Parameters<Dueno['gancho']>[0]) {
    gancho.call(this, fase);
    if (fase === 'F6' && this.hilo === 0 && this.mundo.tick >= cadaTicks) {
      this.suceso({ kind: 'ecology', actors: [], text: TEXTO_MARCA, cause: 'Marcador REF solapado.', source: 'simulation' });
    }
  });

  const abrirApp = () => createApp({
    store, origin: 'http://127.0.0.1:3000', password: 'ref-solapado-v24', seed: semilla,
    tape: false, manual: true, confirmarGuardadoVivo: true,
    guardadoEnHilo: {
      snapshotPackedPeople: true, snapshotSplitPeopleWeights: true,
      maxTicksSolapados: MAX_TICKS_SOLAPADOS, basePesosCorte: true,
    },
    onFatalExit: codigo => assert.fail(`Salida fatal inesperada (${codigo}).`),
  });
  return { directory, path, store, colocadas, abrirApp };
}

test('ruta real solapada: con el mundo ya 3 ticks adelante cambia/revoca la base, reconstruye FULL exacto y reabre T con -0', async t => {
  const cadaTicks = 4;
  const { directory, store, colocadas, abrirApp } = crearEscenarioSolapado(t, 3, cadaTicks);
  const originalGuardar = PersistidorGuardado.prototype.guardar;
  let soltarCorte2: (() => void) | undefined;
  let persistidorCapturado: PersistidorGuardado | undefined;
  let corte2Retenido: Promise<void> | undefined;
  let refsEnCorte2 = 0;
  let tokenEnCorte2: string | undefined;
  const acuses: GuardadoConfirmado[] = [];

  t.mock.method(
    PersistidorGuardado.prototype,
    'guardar',
    function (this: PersistidorGuardado, captura: CapturaCorteTransferido, solapado = false, token?: string) {
      if (captura.corte.tick === 2 * cadaTicks && solapado) {
        persistidorCapturado = this;
        refsEnCorte2 = inspeccionarReferenciasCorte(captura.corte.remoto).totalRefs;
        tokenEnCorte2 = token;
        const espera = new Promise<void>(resolve => { soltarCorte2 = resolve; });
        corte2Retenido = espera;
        // Retenemos la entrega al worker mientras el motor avanza a T+1..T+3 y la base se revoca.
        return espera.then(() => originalGuardar.call(this, captura, solapado, token)).then(acuse => {
          acuses.push(acuse);
          return acuse;
        });
      }
      return originalGuardar.call(this, captura, solapado, token).then(acuse => {
        acuses.push(acuse);
        return acuse;
      });
    },
  );

  const app = abrirApp();
  try {
    const epoca = app.guardado.epoca;
    const vivo = app.world;
    const dueno = duenoSi(vivo);
    assert.ok(dueno);
    for (const remota of colocadas) {
      assert.ok(!vivo.people.some(p => p.id === remota.id), 'las personas con -0 residen en dueños remotos');
    }

    // Corte 1 (tick 4): FULL + publica Base1.
    for (let tick = 1; tick <= cadaTicks; tick++) {
      await app.stepOnce();
      await app.esperarGuardado();
    }
    assert.equal(app.guardado.ultimoTickGuardado, cadaTicks);
    assert.equal(acuses.length, 1);
    const base1 = acuses[0]!.basePesos;
    assert.ok(base1 && abrirLectorBasePesos(base1).estaPublicada());

    // Corte 2 (tick 8): captura con REF + autoriza ticket + inicia guardado solapado.
    for (let tick = cadaTicks + 1; tick <= 2 * cadaTicks; tick++) {
      await app.stepOnce();
    }
    const enVuelo = app.esperarGuardado();
    assert.ok(enVuelo && corte2Retenido && soltarCorte2 && persistidorCapturado);
    assert.ok(refsEnCorte2 >= colocadas.length, 'el corte 2 solapado debía emitirse con REFs');
    assert.ok(typeof tokenEnCorte2 === 'string' && tokenEnCorte2.length > 0);
    const fotoTick8 = app.mundoParaEmision(true);
    const materiaTick8 = dueno.instantaneaMateria(dueno.pendientes());
    const contadorTick8 = vivo.eventCounter;
    assert.equal(fotoTick8.tick, 2 * cadaTicks);
    assert.ok(materiaTick8);

    // El motor avanza 3 ticks POR DELANTE del corte T=8 (ticks 9, 10, 11) antes de confirmar T=8.
    for (let tick = 2 * cadaTicks + 1; tick <= 2 * cadaTicks + MAX_TICKS_SOLAPADOS; tick++) {
      app.stepOnce();
      assert.equal(vivo.tick, tick);
      assert.equal(app.guardado.ultimoTickGuardado, cadaTicks);
    }
    assert.equal(vivo.tick, 11);

    // Revocación natural de Base1 cuando el mundo YA está 3 ticks adelante (imposible recapturar tick 8).
    persistidorCapturado.revocarBasePesos();
    soltarCorte2();
    await enVuelo;

    assert.equal(abrirLectorBasePesos(base1).estaPublicada(), false, 'Base1 quedó revocada antes de confirmar tick 8');
    assert.equal(app.failed, false);
    assert.equal(app.salud().recargas, 0);
    assert.equal(vivo.tick, 11);
    assert.equal(app.guardado.ultimoTickGuardado, 2 * cadaTicks);
    assert.equal(app.guardado.epoca, epoca);
    assertChronicleJournal(vivo);
    assert.equal(vivo.chronicleJournal?.committedThrough, contadorTick8);

    const acuse2 = acuses[1]!;
    assert.equal(acuse2.tick, 2 * cadaTicks);
    assert.equal(acuse2.perfilPersistidor.ticketAutorizado, true);
    assert.equal(acuse2.perfilPersistidor.reconstruidoFullPorRevocacion, true);
    assert.equal(acuse2.perfilPersistidor.ticketsRetenidos, 0);
    assert.ok(acuse2.basePesos && acuse2.basePesos.secuencia === 2);
    assert.notEqual(acuse2.basePesos.publicacion, base1.publicacion);
    assert.equal(abrirLectorBasePesos(acuse2.basePesos).estaPublicada(), true);

    // Reapertura desde copia de SQLite: preserva exactamente T=8 con -0 y Number.MIN_VALUE bit a bit.
    const copia = join(directory, 'tick8-reconstruido.sqlite');
    store.backup(copia);
    const reabierto = new Store(copia);
    try {
      const carga = reabierto.cargarGuardadoCompleto();
      assert.ok(carga?.instantanea.materia);
      assert.equal(carga.metadatos.slot, 0);
      assert.equal(carga.instantanea.world.tick, 2 * cadaTicks);
      assert.equal(carga.instantanea.world.eventCounter, contadorTick8);
      assert.equal(Buffer.compare(codificarCheckpoint(carga.instantanea.materia), codificarCheckpoint(materiaTick8)), 0);
      assert.equal(carga.instantanea.world.people.length, fotoTick8.people.length);
      for (const persona of fotoTick8.people) {
        const cargada = carga.instantanea.world.people.find(p => p.id === persona.id);
        assert.ok(cargada);
        assertPesosBitABit(cargada.policy?.weights, persona.policy?.weights, persona.id);
      }
      colocadas.forEach((remota, indice) => {
        const cargada = carga.instantanea.world.people.find(p => p.id === remota.id);
        assert.ok(cargada?.policy);
        assert.ok(Object.is(cargada.policy.weights[0], -0));
        assert.equal(cargada.policy.weights[1], Number.MIN_VALUE);
        assert.equal(cargada.policy.weights[2], -0.25 * (indice + 1));
      });
    } finally { reabierto.close(); }

    // Corte 3 (tick 12): vuelve a usar Base2 por camino rápido REF solapado sin reconstrucción.
    await app.stepOnce();
    await app.esperarGuardado();
    assert.equal(app.guardado.ultimoTickGuardado, 3 * cadaTicks);
    const acuse3 = acuses[2]!;
    assert.equal(acuse3.perfilPersistidor.ticketAutorizado, true);
    assert.equal(acuse3.perfilPersistidor.reconstruidoFullPorRevocacion, false);
    assert.ok((acuse3.perfilPersistidor.personasRef ?? 0) >= colocadas.length);
    assert.equal(acuse3.perfilPersistidor.ticketsRetenidos, 0);
    assert.equal(app.failed, false);
  } finally { await app.close(); }
});

test('fallback FULL preventivo cuando la base se revoca antes de autorizar el ticket solapado', async t => {
  const cadaTicks = 4;
  const { directory, store, colocadas, abrirApp } = crearEscenarioSolapado(t, 2, cadaTicks);
  const originalAutorizar = PersistidorGuardado.prototype.autorizarTicket;
  const originalGuardar = PersistidorGuardado.prototype.guardar;
  let denegadoObservado: ResultadoAutorizacionTicket | undefined;
  let refsEnGuardadoTick8 = -1;
  let tokenEnGuardadoTick8: string | undefined = 'sin-observar';
  const acuses: GuardadoConfirmado[] = [];

  t.mock.method(
    PersistidorGuardado.prototype,
    'autorizarTicket',
    function (this: PersistidorGuardado, id: IdentidadCorteTransferido, base: IdentidadBasePesos) {
      if (id.tick === 2 * cadaTicks) {
        // La base se revoca ANTES de que el escritor autorice el ticket -> debe denegar y caer a FULL preventivo.
        this.revocarBasePesos();
        return originalAutorizar.call(this, id, base).then(res => {
          denegadoObservado = res;
          return res;
        });
      }
      return originalAutorizar.call(this, id, base);
    },
  );
  t.mock.method(
    PersistidorGuardado.prototype,
    'guardar',
    function (this: PersistidorGuardado, captura: CapturaCorteTransferido, solapado = false, token?: string) {
      if (captura.corte.tick === 2 * cadaTicks) {
        refsEnGuardadoTick8 = inspeccionarReferenciasCorte(captura.corte.remoto).totalRefs;
        tokenEnGuardadoTick8 = token;
      }
      return originalGuardar.call(this, captura, solapado, token).then(acuse => {
        acuses.push(acuse);
        return acuse;
      });
    },
  );

  const app = abrirApp();
  try {
    for (let tick = 1; tick <= 2 * cadaTicks; tick++) {
      await app.stepOnce();
      await app.esperarGuardado();
    }
    assert.equal(denegadoObservado?.autorizado, false);
    assert.equal(denegadoObservado?.motivo, 'sin_base');
    assert.equal(refsEnGuardadoTick8, 0, 'el fallback preventivo recapturó el tick 8 100 % FULL');
    assert.equal(tokenEnGuardadoTick8, undefined);
    assert.equal(app.guardado.ultimoTickGuardado, 2 * cadaTicks);
    assert.equal(app.failed, false);
    assert.equal(app.salud().recargas, 0);

    const acuse2 = acuses[1]!;
    assert.equal(acuse2.perfilPersistidor.personasRef, 0);
    assert.ok((acuse2.perfilPersistidor.personasFull ?? 0) >= colocadas.length);
    assert.equal(acuse2.perfilPersistidor.ticketAutorizado, false);
    assert.equal(acuse2.perfilPersistidor.reconstruidoFullPorRevocacion, false);
    assert.equal(acuse2.perfilPersistidor.ticketsRetenidos, 0);

    const copia = join(directory, 'preventivo.sqlite');
    store.backup(copia);
    const reabierto = new Store(copia);
    try {
      const carga = reabierto.cargarGuardadoCompleto();
      assert.ok(carga);
      assert.equal(carga.instantanea.world.tick, 2 * cadaTicks);
      const cargada = carga.instantanea.world.people.find(p => p.id === colocadas[0]!.id);
      assert.ok(cargada?.policy && Object.is(cargada.policy.weights[0], -0));
      assert.equal(cargada.policy.weights[1], Number.MIN_VALUE);
    } finally { reabierto.close(); }
  } finally { await app.close(); }
});

test('rechazo de ticket ajeno/no registrado, otra vida tras reinicio y terminación del escritor en medio', async t => {
  const cadaTicks = 4;
  const { path, store, colocadas, abrirApp } = crearEscenarioSolapado(t, 2, cadaTicks);

  // Parte A: rechazo de ticket no registrado, token ajeno, ticket de otra vida y límite acotado + abortarTicket.
  const inicial = store.cargarGuardadoCompleto();
  assert.ok(inicial);
  const motor = crearMotor(inicial.instantanea.world, {
    hilos: 2, gpu: [], decisionGpu: 'siempre', verificar: false, semilla: 7,
    instantaneaTransferible: true, faunaCorteDirecta: true, teselasCorteDirectas: true,
    personasCorteDirectas: true, confirmarGuardadoVivo: true, solapeGuardado: true, basePesosCorte: true,
  });
  let p1: PersistidorGuardado | undefined;
  let p2: PersistidorGuardado | undefined;
  try {
    motor.cargar(inicial.instantanea, inicial.epoca);
    p1 = new PersistidorGuardado({
      path, snapshotPackedPeople: true, snapshotSplitPeopleWeights: true, basePesosCorte: true,
    });
    motor.paso([]);
    const c1 = motor.capturarCorteTransferido?.(false);
    assert.ok(c1);
    const acuse1 = await p1.guardar(c1, false);
    assert.ok(acuse1.basePesos);
    const idBase1: IdentidadBasePesos = {
      version: acuse1.basePesos.version,
      publicacion: acuse1.basePesos.publicacion,
      instancia: acuse1.basePesos.instancia,
      epoca: acuse1.basePesos.epoca,
      secuencia: acuse1.basePesos.secuencia,
      digesto: acuse1.basePesos.digesto,
    };
    assert.equal(motor.confirmarCorteTransferido?.(acuse1), true);
    motor.publicarBasePesosCorte?.(acuse1.basePesos);

    motor.paso([]);
    const cabezaAntes = filaInstantanea(store);

    // 1) Sin ticket registrado en un corte solapado con REF -> rechazado, BD durable intacta.
    const cSinTicket = motor.capturarCorteTransferido?.(true);
    assert.ok(cSinTicket?.admiteSolape && inspeccionarReferenciasCorte(cSinTicket.corte.remoto).totalRefs > 0);
    await assert.rejects(
      p1.guardar(cSinTicket, true),
      (err: unknown) => err instanceof RechazoBasePesosGuardadoError && err.baseRechazada === true,
    );
    assert.deepEqual(filaInstantanea(store), cabezaAntes);

    // 2) Token ajeno con ticket registrado (y descriptor con buffers embebidos denegado) -> rechazado, BD durable intacta.
    const cTokenAjeno = motor.capturarCorteTransferido?.(true);
    assert.ok(cTokenAjeno?.admiteSolape);
    const idAjeno = {
      solicitud: cTokenAjeno.corte.solicitud, epoca: cTokenAjeno.corte.epoca,
      tick: cTokenAjeno.corte.tick, eventCounter: cTokenAjeno.corte.eventCounter,
    };
    const authConBuffers = await p1.autorizarTicket(idAjeno, acuse1.basePesos);
    assert.equal(authConBuffers.autorizado, false);
    assert.equal(authConBuffers.motivo, 'identidad_base_invalida');
    const authReal = await p1.autorizarTicket(idAjeno, idBase1);
    assert.equal(authReal.autorizado, true);
    assert.ok(authReal.tokenAutorizacion);
    const otraEpoca = await p1.autorizarTicket({ ...idAjeno, epoca: idAjeno.epoca + 1 }, idBase1);
    assert.equal(otraEpoca.motivo, 'epoca_cambiada');
    assert.equal((await p1.autorizarTicket(idAjeno, idBase1)).motivo, 'ticket_duplicado');
    await assert.rejects(
      p1.guardar(cTokenAjeno, true, 'token-ajeno-invalido'),
      (err: unknown) => err instanceof RechazoBasePesosGuardadoError,
    );
    assert.deepEqual(filaInstantanea(store), cabezaAntes);

    // 3) Límite acotado de tickets en vuelo (MAX_TICKETS_EN_VUELO = 2) + liberación inmediata por abortarTicket.
    const idExtra1 = { solicitud: 9001n, epoca: inicial.epoca, tick: 2, eventCounter: 0 };
    const idExtra2 = { solicitud: 9002n, epoca: inicial.epoca, tick: 2, eventCounter: 0 };
    const a1 = await p1.autorizarTicket(idExtra1, idBase1);
    assert.equal(a1.autorizado, true);
    const a2 = await p1.autorizarTicket(idExtra2, idBase1);
    assert.equal(a2.autorizado, false);
    assert.equal(a2.motivo, 'limite_tickets');
    p1.abortarTicket(idAjeno, authReal.tokenAutorizacion);
    p1.abortarTicket(idExtra1, a1.tokenAutorizacion);
    const a3 = await p1.autorizarTicket(idExtra2, idBase1);
    assert.equal(a3.autorizado, true);
    p1.abortarTicket(idExtra2, a3.tokenAutorizacion);

    // 4) Otra vida del escritor (nuevo PersistidorGuardado con nueva instancia): rechaza ticket y deniega autorización.
    p2 = new PersistidorGuardado({
      path, snapshotPackedPeople: true, snapshotSplitPeopleWeights: true, basePesosCorte: true,
    });
    const cOtraVida = motor.capturarCorteTransferido?.(true);
    assert.ok(cOtraVida?.admiteSolape && inspeccionarReferenciasCorte(cOtraVida.corte.remoto).totalRefs > 0);
    const authOtraVida = await p2.autorizarTicket({
      solicitud: cOtraVida.corte.solicitud, epoca: cOtraVida.corte.epoca,
      tick: cOtraVida.corte.tick, eventCounter: cOtraVida.corte.eventCounter,
    }, idBase1);
    assert.equal(authOtraVida.autorizado, false);
    await assert.rejects(
      p2.guardar(cOtraVida, true, authReal.tokenAutorizacion),
      (err: unknown) => err instanceof RechazoBasePesosGuardadoError,
    );
    assert.deepEqual(filaInstantanea(store), cabezaAntes);

    // Una escritura externa válida en WAL, incluso en la misma época, invalida el prefijo esperado.
    const preparado = motor.capturarCorteTransferido?.(true);
    assert.ok(preparado?.admiteSolape);
    const autorizado = await p1.autorizarTicket(preparado.corte, idBase1);
    assert.ok(autorizado.tokenAutorizacion);
    const otroEscritor = new Store(path, { snapshotPackedPeople: true, snapshotSplitPeopleWeights: true });
    const lectorExterno = new Store(path, { readOnly: true });
    try {
      const carga = lectorExterno.leerCorteParaProyeccion(0);
      assert.equal(carga.epoca, preparado.corte.epoca);
      carga.instantanea.world.people[0]!.name += ' externo';
      otroEscritor.guardar(carga.instantanea);
      const cabezaExterna = filaInstantanea(store);
      assert.notEqual(cabezaExterna.digest, cabezaAntes.digest);
      await assert.rejects(p1.guardar(preparado, true, autorizado.tokenAutorizacion), /La cabeza durable cambió/);
      assert.deepEqual(filaInstantanea(store), cabezaExterna);
    } finally {
      lectorExterno.close();
      otroEscritor.close();
    }
  } finally {
    await p1?.cerrar().catch(() => undefined);
    await p2?.cerrar().catch(() => undefined);
    await motor.cerrar();
  }

  // Parte B: terminación abrupta del hilo escritor en medio de un guardado solapado con REF -> conserva cabeza y reinicia limpio.
  const originalGuardar = PersistidorGuardado.prototype.guardar;
  let trabajadorVivo: { terminate(): Promise<number> } | undefined;
  let matado = false;
  t.mock.method(
    PersistidorGuardado.prototype,
    'guardar',
    function (this: PersistidorGuardado, captura: CapturaCorteTransferido, solapado = false, token?: string) {
      if (solapado && !matado && typeof token === 'string') {
        trabajadorVivo = (this as unknown as { hilo: { terminate(): Promise<number> } }).hilo;
      }
      return originalGuardar.call(this, captura, solapado, token);
    },
  );

  const app = abrirApp();
  const bloqueo = new DatabaseSync(path);
  try {
    // Corte 1 (tick 4): durable y publica Base1.
    for (let tick = 1; tick <= cadaTicks; tick++) {
      await app.stepOnce();
      await app.esperarGuardado();
    }
    const tickDurable = app.guardado.ultimoTickGuardado;
    const cabezaDurable = filaInstantanea(store);

    // Bloquea SQLite antes del corte 2 (tick 8) para que el escritor quede en vuelo mientras el motor avanza.
    for (let tick = 1; tick < cadaTicks; tick++) app.stepOnce();
    bloqueo.exec('BEGIN IMMEDIATE');
    await app.stepOnce(); // autoriza ticket (sin tocar SQLite) y lanza guardado solapado con REF
    const vuelo = app.esperarGuardado();
    assert.ok(vuelo && trabajadorVivo);
    // Avanza 2 ticks adelante mientras el escritor está bloqueado en SQLite.
    app.stepOnce();
    app.stepOnce();
    assert.equal(app.world.tick, tickDurable + cadaTicks + 2);
    await siguienteVuelta();

    // Termina el hilo escritor en medio del vuelo.
    matado = true;
    await trabajadorVivo.terminate();
    bloqueo.exec('COMMIT');
    await vuelo;

    assert.equal(app.failed, true, 'la terminación abrupta del escritor pausa de forma segura');
    assert.equal(app.guardado.ultimoTickGuardado, tickDurable);
    assert.deepEqual(filaInstantanea(store), cabezaDurable, 'la cabeza durable en SQLite permanece intacta');
    await assert.rejects(
      app.close(),
      (err: unknown) => err instanceof Error && err.name === 'GuardadoIndeterminado',
    );
  } finally {
    if (bloqueo.isTransaction) bloqueo.exec('ROLLBACK');
    bloqueo.close();
    await app.close().catch(() => undefined);
  }

  // Reinicio completo sobre la misma BD: reabre tickDurable y completa nuevos cortes solapados con nueva instancia.
  const acusesReinicio: GuardadoConfirmado[] = [];
  t.mock.method(
    PersistidorGuardado.prototype,
    'guardar',
    function (this: PersistidorGuardado, captura: CapturaCorteTransferido, solapado = false, token?: string) {
      return originalGuardar.call(this, captura, solapado, token).then(acuse => {
        acusesReinicio.push(acuse);
        return acuse;
      });
    },
  );
  const reiniciada = abrirApp();
  try {
    const tickInicio = reiniciada.guardado.ultimoTickGuardado;
    for (let tick = 1; tick <= 2 * cadaTicks; tick++) {
      await reiniciada.stepOnce();
      await reiniciada.esperarGuardado();
    }
    assert.equal(reiniciada.guardado.ultimoTickGuardado, tickInicio + 2 * cadaTicks);
    assert.equal(reiniciada.failed, false);
    assert.equal(acusesReinicio.length, 2);
    assert.equal(acusesReinicio[0]!.perfilPersistidor.personasRef, 0, 'el primer corte tras reinicio es FULL');
    assert.equal(acusesReinicio[0]!.basePesos?.secuencia, 1);
    assert.ok((acusesReinicio[1]!.perfilPersistidor.personasRef ?? 0) > 0, 'el segundo corte tras reinicio vuelve a usar REF solapado');
    assert.equal(acusesReinicio[1]!.perfilPersistidor.ticketAutorizado, true);
    assert.equal(acusesReinicio[1]!.perfilPersistidor.ticketsRetenidos, 0);
    const reabierto = new Store(path, { readOnly: true });
    try {
      const carga = reabierto.verificarGuardado();
      assert.ok(carga);
      const cargada = carga.world.people.find(p => p.id === colocadas[0]!.id);
      assert.ok(cargada?.policy && Object.is(cargada.policy.weights[0], -0));
      assert.equal(cargada.policy.weights[1], Number.MIN_VALUE);
    } finally { reabierto.close(); }
  } finally { await reiniciada.close(); }
});

test('migración entre dueños bajo revocación natural, rechazo de corrupción/UID/SAB, división >4 MiB y sobres no destructivos', t => {
  const { store } = laboratorio(t, 'atlas-ref-solapado-borde-', {
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
  personaB.policy.weights[0] = 0; // +0

  store.guardar({ world: baseMundo, materia: null });
  const carga1 = store.cargarGuardadoCompleto();
  const digestGuardado = store.ultimoDigestGuardado;
  assert.ok(carga1 && digestGuardado);
  const publicador = store.construirBasePesosDurable('inst-borde', carga1.epoca, 1, digestGuardado);
  assert.ok(publicador);
  const descriptor = publicador.publicarTrasAcuse({ ...publicador.identidad, confirmado: true });
  const baseActiva: BasePesosActiva = {
    lector: abrirLectorBasePesos(descriptor),
    contexto: {
      instancia: descriptor.instancia, epoca: descriptor.epoca,
      secuencia: descriptor.secuencia, publicacion: descriptor.publicacion,
      digesto: descriptor.digesto,
    },
  };

  // PersonaA migra del dueño 1 al dueño 2 conservando -0; PersonaB invierte +0 -> -0.
  const mundoRemoto = structuredClone(baseMundo);
  const copiaA = mundoRemoto.people.find(p => p.id === personaA.id)!;
  const copiaB = mundoRemoto.people.find(p => p.id === personaB.id)!;
  copiaB.policy!.weights[0] = -0;
  mundoRemoto.people = [copiaA, copiaB];

  const canales = CanalesCorte.abrir(1);
  assert.ok(canales);
  try {
    const solicitud = canales.pedir(false, false, true, false, true);
    enviarParteCorte(canales.puertosRemotos[0]!, canales.solicitud, carga1.epoca, 1, mundoRemoto, undefined, baseActiva);
    const remoto: CorteRemotoBinario = canales.retirarCorte(solicitud, carga1.epoca, mundoRemoto.tick);
    assert.equal(inspeccionarReferenciasCorte(remoto).totalRefs, 1);

    // Revocación natural tras emisión: `decodificarCorteRemoto` falla de forma NO destructiva (sobres y buffers intactos!).
    publicador.revocar();
    assert.throws(
      () => decodificarCorteRemoto(remoto, baseActiva),
      (error: unknown) => error instanceof RechazoBasePesosError && error.motivo === 'base_revocada',
    );
    assert.equal(remoto.sobres.length, 1, 'un fallo en prevalidación no debe vaciar corte.sobres');
    assert.ok(remoto.sobres[0]!.bytes.buffer.byteLength > 0);
    assert.ok(remoto.sobres[0]!.personas![0]!.cuerpo.buffer.byteLength > 0);
    assert.ok(remoto.sobres[0]!.personas![0]!.refs!.pares.buffer.byteLength > 0);

    // Reconstrucción FULL con lector autorizado tras revocación natural -> conserva migrante (-0) y mutado (-0).
    const lectorPrivado = publicador.abrirLectorDelEscritor();
    const lectorReconstruccion = abrirLectorReconstruccionBasePesos(descriptor, publicador.identidad, lectorPrivado);
    const remotoFull = reconstruirCorteRemotoFull(remoto, lectorReconstruccion);
    assert.equal(inspeccionarReferenciasCorte(remotoFull).totalRefs, 0);
    const { partes } = decodificarCorteRemoto(remotoFull);
    const mundoCorte2 = structuredClone(baseMundo);
    setParams(mundoCorte2, paramsOf(baseMundo));
    bindWorldContext(mundoCorte2, store.context);
    mundoCorte2.people[mundoCorte2.people.findIndex(p => p.id === personaA.id)] = partes[0]!.people[0]!;
    mundoCorte2.people[mundoCorte2.people.findIndex(p => p.id === personaB.id)] = partes[0]!.people[1]!;
    store.guardar({ world: mundoCorte2, materia: null });

    const carga2 = store.cargarGuardadoCompleto();
    assert.ok(carga2);
    const cargadaA = carga2.instantanea.world.people.find(p => p.id === personaA.id)!;
    const cargadaB = carga2.instantanea.world.people.find(p => p.id === personaB.id)!;
    assert.ok(Object.is(cargadaA.policy!.weights[0], -0));
    assert.equal(cargadaA.policy!.weights[1], Number.MIN_VALUE);
    assert.ok(Object.is(cargadaB.policy!.weights[0], -0));

    // Rechazo de UID distinto y referencia malformada (con buffer embebido) sin mutar sobres.
    const bloqueOriginal = remoto.sobres[0]!.personas![0]!;
    const paresMalUid = new Uint32Array([0, baseActiva.lector.buscarIndicePorUid(personaB.uid)]);
    assert.throws(
      () => reconstruirBloquesPersonasFull(
        [{ ...bloqueOriginal, refs: { identidad: bloqueOriginal.refs!.identidad, pares: paresMalUid } }],
        2,
        lectorReconstruccion,
      ),
      (error: unknown) => error instanceof RechazoBasePesosError && error.motivo === 'uid_no_coincide',
    );
    const identidadMalformada = { ...bloqueOriginal.refs!.identidad, slabs: descriptor.slabs } as unknown as IdentidadBasePesos;
    assert.throws(
      () => reconstruirBloquesPersonasFull(
        [{ ...bloqueOriginal, refs: { identidad: identidadMalformada, pares: bloqueOriginal.refs!.pares } }],
        2,
        lectorReconstruccion,
      ),
      (error: unknown) => error instanceof RechazoBasePesosError && error.motivo === 'referencia_invalida',
    );

    // Mutación fuera de contrato en un solo bit del SAB (+0 -> -0): SHA-256 rechaza la reconstrucción.
    const sabDatos = new Uint8Array(descriptor.slabs[0]!);
    sabDatos[7] ^= 0x80;
    assert.throws(() => lectorReconstruccion.copiarPesosExactosEn(
      lectorPrivado.uidEn(0), 0, new Uint8Array(WPF1_WEIGHT_BYTES), 0,
    ), /fila F64 copiada/);
    assert.throws(() => abrirLectorReconstruccionBasePesos(descriptor, publicador.identidad), /digesto SHA-256/);
  } finally {
    canales.cerrar();
  }

  // División automática de bloque al expandir REF->FULL por encima de BYTES_POR_BLOQUE (4 MiB):
  // 2600 filas * 1696 B = 4,41 MB > 4 MiB, mientras que en REF el bloque ocupa < 300 KB.
  const cantidad = 2600;
  const pesoBytes = new Uint8Array(WPF1_WEIGHT_BYTES);
  const pesoVista = new DataView(pesoBytes.buffer);
  pesoVista.setFloat64(0, -0, true);
  pesoVista.setFloat64(8, Number.MIN_VALUE, true);
  const filasWgp1 = Array.from({ length: cantidad }, (_, i) => ({ uid: i + 1, body: pesoBytes, offset: 0 }));
  const pubGrande = construirBasePesosDesdeFilasWgp1(filasWgp1, { instancia: 'inst-split', epoca: 1, secuencia: 1 });
  const descGrande: DescriptorBasePesosCorte = pubGrande.publicarTrasAcuse({ ...pubGrande.identidad, confirmado: true });
  const parteGrande = parteCorteDe(baseMundo);
  const pesosJs = new Array<number>(WPF1_WEIGHT_COUNT).fill(0);
  pesosJs[0] = -0;
  pesosJs[1] = Number.MIN_VALUE;
  parteGrande.people = Array.from({ length: cantidad }, (_, i) => ({
    id: `p-${i + 1}`, uid: i + 1, x: 1, y: 1, policy: { weights: pesosJs.slice() },
  })) as typeof parteGrande.people;
  const baseGrande: BasePesosActiva = {
    lector: abrirLectorBasePesos(descGrande),
    contexto: {
      instancia: descGrande.instancia, epoca: descGrande.epoca,
      secuencia: descGrande.secuencia, publicacion: descGrande.publicacion,
    },
  };
  const bloquesRef = prepararPersonasDirectas(parteGrande, baseGrande);
  assert.ok(bloquesRef && bloquesRef.length === 1 && bloquesRef[0]!.refs?.pares.length === cantidad * 2);
  pubGrande.revocar();

  const lectorSplit = abrirLectorReconstruccionBasePesos(descGrande, pubGrande.identidad);
  const bloquesFull: BloquePersonasCorte[] = reconstruirBloquesPersonasFull(bloquesRef, cantidad, lectorSplit);
  lectorSplit.verificarIntegridadFinal();
  assert.ok(bloquesFull.length >= 2, 'el bloque REF expandido > 4 MiB debe dividirse en múltiples bloques FULL válidos');
  assert.ok(bloquesFull.every(b => b.refs === undefined && b.cuerpo.byteLength + b.pesos.byteLength <= 4 * 1024 * 1024));
  const recibidas = recibirPersonasDirectas(bloquesFull, cantidad, { transferirCuerpo: true, transferirPesos: true });
  assert.equal(recibidas.length, cantidad);
  assert.ok(Object.is(recibidas[0]!.policy!.weights[0], -0));
  assert.equal(recibidas[0]!.policy!.weights[1], Number.MIN_VALUE);
  assert.ok(Object.is(recibidas[cantidad - 1]!.policy!.weights[0], -0));
});
