import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/server/app.js';
import { motorConfig } from '../src/server/hardware-limits.js';
import { Store } from '../src/server/store.js';
import { escalon } from '../src/shared/interruptores.js';
import { assertChronicleJournal } from '../src/world/chronicle-journal.js';
import { demographicTraits } from '../src/world/demography.js';
import { pedidoComida } from '../src/world/materia/cuerpo.js';
import { ctxMateriaDe } from '../src/world/motor/acceso.js';
import { repartirPorTramos } from '../src/world/motor/bloques.js';
import { duenoSi } from '../src/world/motor/contexto.js';
import { REF_NULA, TipoIntento, unSoloDueno, type Motor } from '../src/world/motor/contratos.js';
import {
  crearMotor,
  inyectarFalloConfirmarGuardadoParaPrueba,
  tecnologiaEquivalenteParaConfirmar,
} from '../src/world/motor/coordinador.js';
import { createWorld } from '../src/world/mundo/crear.js';
import { assertWorld } from '../src/world/mundo/validar.js';
import { ErrorFatalMotor } from '../src/world/paralelo/barrera.js';
import type { DiagnosticoPiscina } from '../src/world/paralelo/piscina.js';
import { parseParams } from '../src/world/params.js';
import { activate, tomarChunk, worldContext } from '../src/world/spatial.js';
import { enableTechnologyCatalogue } from '../src/world/technology-catalogue.js';
import { filaInstantanea } from './lib/store.js';

type MotorInspeccion = Motor & { diagnosticoPiscina?: DiagnosticoPiscina; cronicaDesfasada?: number };

function comprobarBalanceExacto(mundo: ReturnType<typeof createWorld>, etiqueta: string): void {
  const d = duenoSi(mundo);
  assert.ok(d, `${etiqueta}: falta Dueno`);
  const bal = d.balanceMateria();
  assert.deepEqual(bal.hallado, bal.esperado, `${etiqueta}: desbalance material`);
}

function situarEnDueno(mundo: ReturnType<typeof createWorld>, hilos: number, persona: ReturnType<typeof createWorld>['people'][number], dueno: number) {
  const paginas = Object.values(mundo.chunks);
  const reparto = repartirPorTramos(paginas.map(p => p.cx), paginas.map(p => p.cy), hilos);
  const tile = mundo.tiles.find(t => t.terrain !== 'water' && paginas.some((pagina, i) =>
    reparto[i] === dueno && pagina.cx === (t.x >> 4) && pagina.cy === (t.y >> 4)));
  assert.ok(tile, `sin tesela transitable en dueño ${dueno}`);
  persona.x = tile.x; persona.y = tile.y; persona.target = { x: tile.x, y: tile.y };
  return tile;
}

test('opción de laboratorio confirmarGuardadoVivo: desactivada por defecto y rechazo sin mutación', async () => {
  assert.equal(motorConfig(7, {}).confirmarGuardadoVivo, undefined);
  assert.equal(motorConfig(7, { CARTA_GUARDADO_VIVO: '1' }).confirmarGuardadoVivo, true);

  const semilla = 7, hilos = 2;
  const params = parseParams({ v23: escalon('duenos'), motor: { hilos } });
  const mundo = createWorld(semilla, params);
  const motor = crearMotor(mundo, { ...unSoloDueno(semilla), hilos }) as MotorInspeccion;
  const store = new Store(':memory:');
  try {
    motor.cargar({ world: mundo, materia: null }, 0);
    motor.paso([]);
    const hilosAntes = motor.diagnosticoPiscina?.threadIds;
    const pendientesAntes = mundo.chronicleJournal?.pending.length ?? 0;
    const inst = motor.instantanea();
    store.guardar(inst);
    assert.equal(motor.confirmarGuardado(inst), false, 'apagada por defecto debe devolver false');
    assert.deepEqual(motor.diagnosticoPiscina?.threadIds, hilosAntes, 'el rechazo no toca la piscina');
    assert.equal(mundo.chronicleJournal?.pending.length ?? 0, pendientesAntes, 'el rechazo no muta el diario vivo');
  } finally {
    store.close();
    await motor.cerrar();
  }
});

test('confirmarGuardadoVivo mantiene dueños vivos y garantías en vuelo sin reasignar, con balance exacto y recuperación durable', async () => {
  const semilla = 13, hilos = 2;
  const params = parseParams({ v23: escalon('duenos'), motor: { hilos } });
  const mundo = createWorld(semilla, params);
  const motor = crearMotor(mundo, { ...unSoloDueno(semilla), hilos, confirmarGuardadoVivo: true }) as MotorInspeccion;
  const store = new Store(':memory:');
  try {
    motor.cargar({ world: mundo, materia: null }, 0);
    const hilosIniciales = motor.diagnosticoPiscina?.threadIds;
    const duenoInicial = duenoSi(mundo);
    assert.ok(hilosIniciales && hilosIniciales.length === hilos && duenoInicial);

    // Guardado inicial (tick 0) confirmado sobre dueños vivos.
    const inst0 = motor.instantanea();
    store.guardar(inst0);
    assert.equal(motor.confirmarGuardado(inst0), true);
    assert.deepEqual(motor.diagnosticoPiscina?.threadIds, hilosIniciales);
    assert.equal(duenoSi(mundo), duenoInicial);

    motor.paso([]);
    const c = ctxMateriaDe(mundo);
    const emisor = [...duenoInicial.personas.values()].find(p => p.cuerpo);
    assert.ok(emisor?.cuerpo);
    const celda = c.terreno.celda(emisor.x, emisor.y);
    assert.ok(celda >= 0);
    const materia = Float64Array.from(c.materia.garantizar(emisor.cuerpo.reserva, pedidoComida(c, emisor.cuerpo, 0.025), c.libro));
    assert.ok(materia.length > 0);
    const nonceGarantia = c.id('nonce');
    const refEmisor = duenoInicial.ref(emisor.uid!);
    duenoInicial.buzon.enviar(c.hilo, {
      tipo: TipoIntento.Depositar, de: refEmisor, a: REF_NULA, celda, lote: REF_NULA,
      nonce: nonceGarantia, materia, dato: null, bytes: null,
    });

    const pendientesAntes = duenoInicial.pendientes();
    const garantiaAntes = pendientesAntes.find(i => i.nonce === nonceGarantia);
    assert.ok(garantiaAntes, 'la garantía debe existir en buzón antes del guardado');
    comprobarBalanceExacto(mundo, 'antes de confirmar tick 1');

    const inst1 = motor.instantanea();
    // `instantanea()` pliega los libros de todos los hilos en libros[0]; `confirmarGuardado` no debe alterar el saldo en vuelo.
    const enVueloTrasInstantanea = c.libro.enVuelo.slice();
    assert.ok(enVueloTrasInstantanea.some(v => v !== 0), 'el saldo en vuelo neto de la garantía sigue presente');
    store.guardar(inst1);
    assert.equal(motor.confirmarGuardado(inst1), true);

    // Mismos dueños, misma piscina y garantía en vuelo sin reasignar ni recircular.
    assert.deepEqual(motor.diagnosticoPiscina?.threadIds, hilosIniciales, 'los workers siguen siendo los mismos');
    assert.equal(duenoSi(mundo), duenoInicial, 'el dueño 0 conserva su instancia');
    const pendientesDespues = duenoInicial.pendientes();
    assert.equal(pendientesDespues.length, pendientesAntes.length);
    const garantiaDespues = pendientesDespues.find(i => i.nonce === nonceGarantia);
    assert.ok(garantiaDespues, 'la garantía sigue en el mismo buzón tras confirmar');
    assert.equal(garantiaDespues.de, garantiaAntes.de);
    assert.equal(garantiaDespues.a, garantiaAntes.a);
    assert.equal(garantiaDespues.celda, garantiaAntes.celda);
    assert.deepEqual(garantiaDespues.materia, garantiaAntes.materia);
    assert.deepEqual(c.libro.enVuelo, enVueloTrasInstantanea, 'el saldo en vuelo no se altera al confirmar');
    comprobarBalanceExacto(mundo, 'justo tras confirmar tick 1');

    // Al avanzar al tick 2, la garantía se entrega sin fugas y un nuevo guardado vivo vuelve a cerrar limpio.
    motor.paso([]);
    assert.ok(c.libro.enVuelo.every(v => v === 0), 'la garantía en vuelo se entregó en el tick siguiente');
    comprobarBalanceExacto(mundo, 'tras entregar garantía en tick 2');
    const inst2 = motor.instantanea();
    store.guardar(inst2);
    assert.equal(motor.confirmarGuardado(inst2), true);
    assert.deepEqual(motor.diagnosticoPiscina?.threadIds, hilosIniciales);

    // Recuperación durable en corte sellado sobre un motor nuevo.
    const cargado = store.cargarGuardadoCompleto();
    assert.ok(cargado);
    assertWorld(cargado.instantanea.world);
    assertChronicleJournal(cargado.instantanea.world);
    assert.equal(cargado.instantanea.world.tick, 2);
    const motorReabierto = crearMotor(cargado.instantanea.world, { ...unSoloDueno(semilla), hilos });
    try {
      motorReabierto.cargar(cargado.instantanea, cargado.epoca);
      comprobarBalanceExacto(cargado.instantanea.world, 'tras reabrir corte sellado');
      motorReabierto.paso([]);
      comprobarBalanceExacto(cargado.instantanea.world, 'tras avanzar corte sellado');
      assertWorld(motorReabierto.vista());
    } finally {
      await motorReabierto.cerrar();
    }
  } finally {
    store.close();
    await motor.cerrar();
  }
});

for (const cooperacion of [true, false]) test(`bajas remotas con cooperación ${cooperacion ? 'activa' : 'apagada'}`, async () => {
  const semilla = 7, hilos = 2;
  const params = parseParams({ v23: escalon('duenos'), motor: { hilos } });
  const mundo = createWorld(semilla, params);
  mundo.cooperationEnabled = cooperacion;
  const [victima, superviviente, vecina] = mundo.people.filter(p => p.role === 'neighbor');
  assert.ok(victima && superviviente && vecina);
  situarEnDueno(mundo, hilos, victima, 1);
  situarEnDueno(mundo, hilos, superviviente, 0);
  const edad = demographicTraits(victima.genome, params.cuerpo);
  victima.demography.age = Math.floor((edad.senescenceStart + edad.maximumAge) / 2);
  victima.bornAt = -victima.demography.age;
  victima.demography.health = Number.MIN_VALUE;
  superviviente.bonds[victima.id] = 0.8;
  const grupo = {
    id: 'comunidad-baja-viva', name: 'Grupo', x: superviviente.x, y: superviviente.y, color: '#aaaaaa',
    members: [victima.id, superviviente.id, vecina.id], memberCount: 3, culture: { ...superviviente.culture },
    formedAt: 0, cooperation: 0, disputes: 0,
  };
  mundo.communities = [grupo];
  mundo.communityCounter = 1;
  for (const p of [victima, superviviente, vecina]) p.communityId = grupo.id;

  const motor = crearMotor(mundo, { ...unSoloDueno(semilla), hilos, confirmarGuardadoVivo: true }) as MotorInspeccion;
  const store = new Store(':memory:');
  try {
    motor.cargar({ world: mundo, materia: null }, 0);
    const hilosAntes = motor.diagnosticoPiscina?.threadIds;
    motor.paso([]);
    const inst1 = motor.instantanea();
    assert.ok(inst1.world.retiredLegacy.some(p => p.id === victima.id && p.diedAt === 1));
    store.guardar(inst1);
    assert.equal(motor.confirmarGuardado(inst1), cooperacion);
    assert.deepEqual(motor.diagnosticoPiscina?.threadIds, hilosAntes);

    if (!cooperacion) {
      const cargado = store.cargarGuardadoCompleto();
      assert.ok(cargado);
      motor.cargar(cargado.instantanea, cargado.epoca);
      motor.paso([]);
      const reabierto = motor.vista();
      assert.deepEqual(reabierto.communities.find(c => c.id === grupo.id)?.members, [superviviente.id, vecina.id]);
      assertWorld(reabierto);
      return;
    }

    // Segunda lectura y segunda instantánea en el MISMO tick 1: retiredLegacy vacío en TODOS los dueños,
    // pero vínculos y comunidades siguen podados y pasan assertWorld.
    const vistaRep = motor.vista();
    assert.equal(vistaRep.retiredLegacy.length, 0, 'el worker 1 también limpió retiredLegacy');
    assert.ok(!Object.hasOwn(vistaRep.people.find(p => p.id === superviviente.id)!.bonds, victima.id));
    assert.deepEqual(vistaRep.communities.find(c => c.id === grupo.id)?.members, [superviviente.id, vecina.id]);
    assertWorld(vistaRep);

    const instRep = motor.instantanea();
    assert.equal(instRep.world.retiredLegacy.length, 0);
    assertWorld(instRep.world);
    store.guardar(instRep);

    motor.paso([]);
    assertWorld(motor.vista());
  } finally {
    store.close();
    await motor.cerrar();
  }
});

test('el corte WPF1 conserva los bytes al podar un vínculo del sobreviviente remoto', async t => {
  const semilla = 7, hilos = 2;
  const params = parseParams({ v23: escalon('duenos'), motor: { hilos }, conducta: { politicaPeso: 0.8 } });
  const mundo = createWorld(semilla, params);
  enableTechnologyCatalogue(mundo.technology);
  const [victima, superviviente] = mundo.people.filter(p => p.role === 'neighbor');
  assert.ok(victima && superviviente);
  situarEnDueno(mundo, hilos, victima, 0);
  situarEnDueno(mundo, hilos, superviviente, 1);
  const edad = demographicTraits(victima.genome, params.cuerpo);
  victima.demography.age = Math.floor((edad.senescenceStart + edad.maximumAge) / 2);
  victima.bornAt = -victima.demography.age;
  victima.demography.health = Number.MIN_VALUE;
  superviviente.bonds[victima.id] = 0.8;
  assert.ok(superviviente.policy);
  superviviente.policy.weights[0] = -0;
  const motor = crearMotor(mundo, { ...unSoloDueno(semilla), hilos,
    instantaneaTransferible: true, personasCorteDirectas: true });
  const opciones = { snapshotPackedPeople: true };
  const canonico = new Store(':memory:', opciones), directo = new Store(':memory:', opciones);
  t.after(async () => { await motor.cerrar(); canonico.close(); directo.close(); });

  motor.cargar({ world: mundo, materia: null }, 0);
  motor.paso([]);
  const referencia = motor.instantanea();
  assert.ok(referencia.world.retiredLegacy.some(p => p.id === victima.id && p.diedAt === 1));
  canonico.guardar(referencia);
  const sello = motor.corteGuardadoSellado?.();
  assert.ok(sello);
  directo.guardarCorteSellado(sello, [], []);
  const paginas = (store: Store) => store.db.prepare('SELECT digest, body FROM snapshot_parts ORDER BY digest').all();
  assert.deepEqual(filaInstantanea(directo), filaInstantanea(canonico));
  assert.deepEqual(paginas(directo), paginas(canonico));
  assert.ok(directo.snapshotPersonasCorteStats.reused > 0);
  assert.equal(directo.snapshotPersonasCorteStats.recoded, 1);

  const corte = directo.cargarGuardadoCompleto()!;
  const leido = corte.instantanea.world.people.find(p => p.id === superviviente.id);
  assert.ok(leido && !Object.hasOwn(leido.bonds, victima.id));
  assert.ok(Object.is(leido.policy?.weights[0], -0));
  motor.cargar(corte.instantanea, corte.epoca);
  assert.equal(motor.paso([]).tick, 2);
});

test('mundos nuevos con retiros conservan la ruta de Store en arranque y al reactivar chunks', async () => {
  const prevHilos = process.env.CARTA_MOTOR_HILOS;
  process.env.CARTA_MOTOR_HILOS = '2';
  const store = new Store(':memory:');
  const app = createApp({
    store, origin: 'http://127.0.0.1:3000', password: 'v24-confirmar-guardado-retiros',
    manual: true, turbo: true, tape: false, turboSaveIntervalMs: 0, seed: 19,
    confirmarGuardadoVivo: true,
    params: parseParams({ v23: escalon('duenos'), persistencia: { cadaTicks: 1 } }),
  });
  const storeDefecto = new Store(':memory:');
  const appDefecto = createApp({
    store: storeDefecto, origin: 'http://127.0.0.1:3000', password: 'v24-confirmar-guardado-defecto',
    manual: true, turbo: true, tape: false, turboSaveIntervalMs: 0, seed: 19,
    params: parseParams({ v23: escalon('duenos'), persistencia: { cadaTicks: 1 } }),
  });
  try {
    assert.ok(worldContext(app.world).loadChunk, 'un mundo nuevo debe nacer con store.context enlazado');
    const mundoInicial = app.world;
    const duenoInicial = duenoSi(mundoInicial);
    assert.ok(duenoInicial);

    // Con la opción apagada por defecto, el guardado rutinario sigue recreando el mundo vía motor.cargar.
    const mundoDefectoAntes = appDefecto.world;
    appDefecto.stepOnce();
    assert.notEqual(appDefecto.world, mundoDefectoAntes, 'con la opción apagada por defecto adoptarGuardado sigue usando cargar');

    // Con la opción activa, avanzar pasos con guardado rutinario conserva el mismo mundo y dueño vivos.
    app.stepOnce();
    assert.equal(app.world, mundoInicial, 'createApp conserva el mundo vivo tras guardado rutinario');
    assert.equal(duenoSi(app.world), duenoInicial, 'createApp conserva el mismo dueño 0 vivo');

    // Ciclo completo en mundo nuevo sin store.context previo: retiro -> guardado vivo -> reactivación desde Store.
    const cxLejano = 4, cyLejano = 4;
    const xLejano = cxLejano * 16 + 2, yLejano = cyLejano * 16 + 2;
    const keyLejana = `${cxLejano},${cyLejano}`;
    const storeDirecto = new Store(':memory:');
    const lecturasDirectas: string[] = [];
    const leerDirecto = storeDirecto.loadChunk.bind(storeDirecto);
    storeDirecto.loadChunk = (key, atTick, v23) => {
      lecturasDirectas.push(key);
      return leerDirecto(key, atTick, v23);
    };
    const mundoDirecto = createWorld(23, parseParams({ v23: escalon('duenos'), motor: { hilos: 2 } }));
    activate(mundoDirecto, xLejano, yLejano);
    const tileMarca = mundoDirecto.tiles.find(t => (t.x >> 4) === cxLejano && (t.y >> 4) === cyLejano && t.terrain !== 'water')
      ?? mundoDirecto.tiles.find(t => (t.x >> 4) === cxLejano && (t.y >> 4) === cyLejano)!;
    assert.ok(tileMarca);
    tileMarca.terrain = 'shelter';
    const idEstructuraMarca = `structure-${++mundoDirecto.structureCounter}`;
    mundoDirecto.structures.push({
      id: idEstructuraMarca, x: tileMarca.x, y: tileMarca.y, blueprintId: mundoDirecto.blueprints[0]!.id,
      name: 'Marca de retiro', components: ['frame', 'roof'], condition: 1, water: 0, food: 0, uses: 0,
      builtAt: 0, builderId: mundoDirecto.people[0]!.id,
    });
    const motor = crearMotor(mundoDirecto, { ...unSoloDueno(23), hilos: 2, confirmarGuardadoVivo: true }) as MotorInspeccion;
    try {
      motor.cargar({ world: mundoDirecto, materia: null }, 0);
      const hilosAntes = motor.diagnosticoPiscina?.threadIds;
      // Guardado tick 0 sin tener store.context previamente enlazado en mundoDirecto.
      const inst0 = motor.instantanea();
      storeDirecto.guardar(inst0);
      assert.equal(motor.confirmarGuardado(inst0), true);
      assert.ok(worldContext(mundoDirecto).loadChunk, 'confirmarGuardado propaga store.context a mundos nuevos');

      // Avanzamos ticks hasta que el chunk alejado se retire al archivo y se guarde en vivo.
      for (let t = 0; t < 3; t++) {
        motor.paso([]);
        const inst = motor.instantanea();
        storeDirecto.guardar(inst);
        assert.equal(motor.confirmarGuardado(inst), true);
        assert.deepEqual(motor.diagnosticoPiscina?.threadIds, hilosAntes);
        assert.equal(mundoDirecto.retiredChunks.length, 0, 'retiredChunks se limpia tras confirmar');
      }
      assert.ok(!motor.vista().chunks[keyLejana], 'el chunk alejado quedó retirado');

      // Reactivación leyendo de Store (no regenerado): conserva la estructura archivada.
      const reactivado = tomarChunk(mundoDirecto, keyLejana, cxLejano, cyLejano);
      assert.ok(lecturasDirectas.includes(keyLejana), 'tomarChunk leyó el chunk retirado desde Store');
      assert.ok(reactivado.structures?.some(s => s.id === idEstructuraMarca),
        'el chunk reactivado conserva sus estructuras archivadas y no se regeneró');
    } finally {
      storeDirecto.close();
      await motor.cerrar();
    }
  } finally {
    await appDefecto.close();
    storeDefecto.close();
    await app.close();
    store.close();
    if (prevHilos === undefined) delete process.env.CARTA_MOTOR_HILOS; else process.env.CARTA_MOTOR_HILOS = prevHilos;
  }
});

test('tecnología remota: no certifica por tamaños ni contadores y hace fallback limpio antes de mutar', async () => {
  // 1) Prueba estructural exacta sobre mutaciones del MISMO tamaño y MISMO contador (bitmap y campo de receta).
  const base = createWorld(31, parseParams({ v23: escalon('duenos') }));
  const storeBase = new Store(':memory:');
  try {
    storeBase.guardar({ world: base, materia: null });
  } finally {
    storeBase.close();
  }
  const inicial = structuredClone(base.technology);
  const remotaMismoBit = structuredClone(base.technology);
  assert.ok(remotaMismoBit.catalogue && remotaMismoBit.catalogue.functions.length > 0);
  remotaMismoBit.catalogue.functions[0] = (remotaMismoBit.catalogue.functions[0]! ^ 1);
  assert.equal(remotaMismoBit.catalogue.functions.length, inicial.catalogue!.functions.length);
  assert.equal(remotaMismoBit.recipeCounter, inicial.recipeCounter);
  assert.equal(remotaMismoBit.executionCounter, inicial.executionCounter);
  assert.equal(
    tecnologiaEquivalenteParaConfirmar(base.technology, inicial, [remotaMismoBit], base.technology),
    false,
    'un bit cambiado en catalogue.functions con idéntico tamaño y contadores debe rechazar',
  );

  // 2) En MotorDuenos cargado: cambio de 1 bit del mismo tamaño en la tecnología confirmada rechaza antes de mutar.
  const semilla = 31, hilos = 2;
  const params = parseParams({ v23: escalon('duenos'), motor: { hilos } });
  const mundo = createWorld(semilla, params);
  const store = new Store(':memory:');
  const motor = crearMotor(mundo, { ...unSoloDueno(semilla), hilos, confirmarGuardadoVivo: true }) as MotorInspeccion;
  try {
    motor.cargar({ world: mundo, materia: null }, 0);
    const inst0 = motor.instantanea();
    store.guardar(inst0);
    // Recargamos una época que ya nace con `catalogue` poblado en cabecera y workers.
    const cargado = store.cargarGuardadoCompleto()!;
    motor.cargar(cargado.instantanea, cargado.epoca);
    const mundoCargado = cargado.instantanea.world;
    const hilosAntes = motor.diagnosticoPiscina?.threadIds;
    motor.paso([]);
    const pendientesAntes = mundoCargado.chronicleJournal?.pending.length ?? 0;
    const inst1 = motor.instantanea();
    store.guardar(inst1);
    assert.ok(inst1.world.technology.catalogue);
    inst1.world.technology.catalogue.functions[0] = (inst1.world.technology.catalogue.functions[0]! ^ 1);
    assert.equal(motor.confirmarGuardado(inst1), false, 'debe rechazar cambio del mismo tamaño no preservable por fundir');
    assert.deepEqual(motor.diagnosticoPiscina?.threadIds, hilosAntes, 'el rechazo no cierra ni recrea la piscina');
    assert.equal(motor.diagnosticoPiscina?.fatal, false, 'el rechazo previo no marca la piscina fatal');
    assert.equal(mundoCargado.chronicleJournal?.pending.length ?? 0, pendientesAntes, 'no se mutó el diario vivo');
  } finally {
    store.close();
    await motor.cerrar();
  }

  // 3) Mutación remota real en worker 1 (settleTechnologyEstate al morir con residuo heredado):
  // confirmarGuardado devuelve false antes de mutar y el fallback a motor.cargar cierra limpio.
  const mundoRemoto = createWorld(37, params);
  const [victima] = mundoRemoto.people.filter(p => p.role === 'neighbor');
  assert.ok(victima);
  situarEnDueno(mundoRemoto, hilos, victima, 1);
  const edad = demographicTraits(victima.genome, params.cuerpo);
  victima.demography.age = Math.floor((edad.senescenceStart + edad.maximumAge) / 2);
  victima.bornAt = -victima.demography.age;
  victima.demography.health = Number.MIN_VALUE;
  victima.technology.residue.wood = 1;
  mundoRemoto.technology.ledger.imported.wood += 1;
  const storeRemoto = new Store(':memory:');
  const motorRemoto = crearMotor(mundoRemoto, { ...unSoloDueno(37), hilos, confirmarGuardadoVivo: true }) as MotorInspeccion;
  try {
    motorRemoto.cargar({ world: mundoRemoto, materia: null }, 0);
    const hilosAntes = motorRemoto.diagnosticoPiscina?.threadIds;
    motorRemoto.paso([]);
    const pendientesAntes = mundoRemoto.chronicleJournal?.pending.length ?? 0;
    const inst = motorRemoto.instantanea();
    storeRemoto.guardar(inst);
    assert.equal(motorRemoto.confirmarGuardado(inst), false, 'una mutación de tecnología en worker remoto debe rechazar antes de mutar');
    assert.deepEqual(motorRemoto.diagnosticoPiscina?.threadIds, hilosAntes);
    assert.equal(motorRemoto.diagnosticoPiscina?.fatal, false);
    assert.equal(mundoRemoto.chronicleJournal?.pending.length ?? 0, pendientesAntes, 'el coordinador no fue mutado');
    // Fallback limpio a cargar.
    motorRemoto.cargar(inst, 0);
    motorRemoto.paso([]);
    assertWorld(motorRemoto.vista());
  } finally {
    storeRemoto.close();
    await motorRemoto.cerrar();
  }
});

test('fallo parcial tras COMMIT en worker: piscina fatal y reapertura durable en app sin duplicar gestos ni recibos', async () => {
  const prevHilos = process.env.CARTA_MOTOR_HILOS;
  process.env.CARTA_MOTOR_HILOS = '3';
  const store = new Store(':memory:');
  const salidas: number[] = [];
  const app = createApp({
    store, origin: 'http://127.0.0.1:3000', password: 'v24-fallo-parcial-commit',
    manual: true, turbo: true, tape: false, turboSaveIntervalMs: 0, seed: 41,
    confirmarGuardadoVivo: true,
    params: parseParams({ v23: escalon('duenos'), persistencia: { cadaTicks: 1 } }),
    onFatalExit: codigo => { salidas.push(codigo); },
  });
  try {
    const hash = 'sesion-fallo-parcial-v24';
    store.addSession(hash, Date.now() + 3600_000);
    const vista0 = app.mundoParaEmision(true);
    const persona = vista0.people[0]!;
    const tile = vista0.tiles.find(t => t.x === persona.x && t.y === persona.y && t.terrain !== 'water')!;
    assert.ok(tile);

    const epocaAntes = app.guardado.epoca;
    const promesaGesto = app.requestGesture({ id: 'gesto-commit-unico', kind: 'invite', x: tile.x, y: tile.y }, hash);
    // Worker 1 vacía retiredLegacy (mutación parcial real) y worker 2 falla tras el COMMIT de SQLite.
    inyectarFalloConfirmarGuardadoParaPrueba(2);
    app.stepOnce();

    const resultado = await promesaGesto;
    assert.equal(resultado.accepted, true, 'el gesto ya quedó confirmado y respondido con el COMMIT');
    assert.equal(resultado.tick, 1);
    assert.deepEqual(salidas, [], 'la recuperación por corte sellado no mata el proceso');
    assert.equal(app.failed, false);
    assert.equal(app.salud().recargas, 1, 'el fallo parcial dispara recarga durable');
    assert.equal(app.guardado.epoca, epocaAntes + 1, 'la recarga abre una época nueva');
    assert.equal(app.world.tick, 1, 'se reabre exactamente el tick durable recién confirmado');
    assert.equal(app.gestosPendientes, 0, 'el gesto ya resuelto no queda pendiente para reaplicarse');

    const recibosTrasRecarga = store.db.prepare('SELECT id, tick FROM inputs WHERE id = ?').all('gesto-commit-unico') as { id: string; tick: number }[];
    assert.equal(recibosTrasRecarga.length, 1, 'exactamente un recibo en SQLite');
    assert.equal(recibosTrasRecarga[0]!.tick, 1);

    // El siguiente paso avanza al tick 2 sin reaplicar el gesto ni duplicar recibos o eventos.
    app.stepOnce();
    assert.equal(app.world.tick, 2);
    assert.equal(app.salud().recargas, 1);
    const recibosTick2 = store.db.prepare('SELECT id, tick FROM inputs WHERE id = ?').all('gesto-commit-unico') as { id: string; tick: number }[];
    assert.equal(recibosTick2.length, 1, 'el recibo no se duplicó al avanzar tras la recarga');
    const vista2 = app.mundoParaEmision(true);
    assert.equal(vista2.events.filter(e => e.kind === 'gesture' && e.x === tile.x && e.y === tile.y).length, 1,
      'el evento del gesto no se duplicó');
    assertChronicleJournal(vista2);
    comprobarBalanceExacto(app.world, 'tras recarga de fallo parcial y avance a tick 2');
  } finally {
    inyectarFalloConfirmarGuardadoParaPrueba(null);
    await app.close();
    store.close();
    if (prevHilos === undefined) delete process.env.CARTA_MOTOR_HILOS; else process.env.CARTA_MOTOR_HILOS = prevHilos;
  }
});

test('fallo parcial en el coordinador tras mutar workers: lanza ErrorFatalMotor y sella la piscina', async () => {
  const semilla = 43, hilos = 2;
  const params = parseParams({ v23: escalon('duenos'), motor: { hilos } });
  const mundo = createWorld(semilla, params);
  const motor = crearMotor(mundo, { ...unSoloDueno(semilla), hilos, confirmarGuardadoVivo: true }) as MotorInspeccion;
  const store = new Store(':memory:');
  try {
    motor.cargar({ world: mundo, materia: null }, 0);
    motor.paso([]);
    const inst = motor.instantanea();
    store.guardar(inst);
    inyectarFalloConfirmarGuardadoParaPrueba(0);
    assert.throws(() => motor.confirmarGuardado(inst), error => error instanceof ErrorFatalMotor,
      'un fallo tras mutar workers nunca devuelve false: es fatal');
    assert.throws(() => motor.paso([]), error => error instanceof ErrorFatalMotor, 'la piscina fatal no vuelve a dar paso');
    assert.throws(() => motor.vista(), error => error instanceof ErrorFatalMotor, 'la piscina fatal no entrega vista');
    assert.throws(() => motor.instantanea(), error => error instanceof ErrorFatalMotor, 'la piscina fatal no entrega instantánea');
    assert.throws(() => motor.confirmarGuardado(inst), error => error instanceof ErrorFatalMotor, 'la piscina fatal no vuelve a confirmar');
  } finally {
    inyectarFalloConfirmarGuardadoParaPrueba(null);
    store.close();
    await motor.cerrar();
  }
});
