import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as esperar } from 'node:timers/promises';
import { BroadcastChannel } from 'node:worker_threads';
import { hostOpenWorldParams } from '../src/server/hardware-limits.js';
import { escalon } from '../src/shared/interruptores.js';
import { percepcionDe } from '../src/world/decision/percepcion.js';
import { PLAN } from '../src/world/decision/planes.js';
import { admiteBrokerPercepcionGpu, BrokerPercepcionGpu, PercibidorBroker, resolverDuenosPercepcionGpu,
  type DuenosBroker } from '../src/world/gpu/broker-percepcion.js';
import { COLUMNAS_CEREBRO, type Plan } from '../src/world/motor/contratos.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { createWorld } from '../src/world/mundo/crear.js';
import { paramsOf, parseParams } from '../src/world/params.js';
import { tileLookup } from '../src/world/tile-index.js';

const script = fileURLToPath(new URL('./fixtures/fallo-gpu-percibir.py', import.meta.url));
const planes: Plan[] = [{ id: 0, transitable: new Float32Array(), celdas: [], organismos: [], acciones: 0, w: null }];

function mundoParaPercibir() {
  const mundo = createWorld(7);
  const percepcion = percepcionDe(mundo), tiles = tileLookup(mundo.tiles);
  percepcion.vista.capturar(mundo.people, 0, [0], tiles, undefined);
  const lote = { tick: 0, despacho: 1, slots: Int32Array.of(percepcion.vista.slot(mundo.people[0]!)), plan: Uint16Array.of(0) };
  return { percepcion, lote, mundo, tiles };
}

function corredorMedido(porCoste: boolean, duenosPorRanura?: DuenosBroker) {
  const anterior = process.env.CARTA_PERCEPCION_COSTE_DUENOS;
  process.env.CARTA_PERCEPCION_COSTE_DUENOS = porCoste ? '1' : '0';
  try {
    return new BrokerPercepcionGpu({ script, entorno: { CARTA_GPU_PRUEBA_FASE: 'broker', CARTA_GPU_PRUEBA_MARCA: '' } },
      !porCoste, 0, duenosPorRanura);
  } finally {
    if (anterior === undefined) delete process.env.CARTA_PERCEPCION_COSTE_DUENOS;
    else process.env.CARTA_PERCEPCION_COSTE_DUENOS = anterior;
  }
}

test('la asignación de GPU conserva las ranuras de dos dueños y valida los índices globales', () => {
  assert.deepEqual(resolverDuenosPercepcionGpu(2, [0]), [[0, 1]]);
  assert.deepEqual(resolverDuenosPercepcionGpu(2, [1]), [[0, 1]]);
  assert.deepEqual(resolverDuenosPercepcionGpu(2, [0, 1]), [[0, null], [null, 1]]);
  assert.deepEqual(resolverDuenosPercepcionGpu(4, [1], [3]), [[3, null]]);
  assert.deepEqual(resolverDuenosPercepcionGpu(8, [0, 1], [2, 5]), [[2, null], [5, null]]);
  assert.equal(admiteBrokerPercepcionGpu(12, [0, 1], [11, 3]), true);
  assert.equal(admiteBrokerPercepcionGpu(8, [0, 1]), false, 'hace falta una selección explícita');
  for (const duenos of [[], [2], [2, 2], [2, 8], [-1, 5], [2.5, 5], [2, 3, 5]])
    assert.equal(resolverDuenosPercepcionGpu(8, [0, 1], duenos), undefined);
  assert.equal(admiteBrokerPercepcionGpu(1, [1], [0]), false);
  assert.equal(admiteBrokerPercepcionGpu(8, [0, 0], [2, 5]), false);
  assert.throws(() => corredorMedido(false, [5, 5]), /Asignación de dueños inválida/);
});

test('los grupos GPU son opcionales, disjuntos y ordenados por tarjeta', () => {
  const grupos = [[7, 4, 3], [5, 1]];
  const resueltos = resolverDuenosPercepcionGpu(8, [0, 1], undefined, grupos);
  assert.deepEqual(resueltos, grupos);
  grupos[0]!.push(2);
  assert.deepEqual(resueltos, [[7, 4, 3], [5, 1]]);
  for (const invalidos of [[], [[1]], [[1], []], [[1], [1]], [[2, 2], [1]], [[8], [1]], [[2.5], [1]]])
    assert.equal(resolverDuenosPercepcionGpu(8, [0, 1], undefined, invalidos), undefined);
  assert.equal(admiteBrokerPercepcionGpu(8, [0, 1], [0, 1], [[0, 1], [2]]), false);
  assert.equal(admiteBrokerPercepcionGpu(8, [], undefined, [[0]]), false);
});

test('tres ranuras del grupo despachan y una recarga descarta los clientes de la generación previa', { timeout: 10_000 }, async t => {
  const duenos = [8, 17, 28];
  const broker = corredorMedido(false, duenos);
  t.after(() => broker.cerrar());
  assert.equal(await broker.listo, true);
  const { percepcion, lote } = mundoParaPercibir();
  const epoca = broker.abrirEpoca(18);
  const clientes = duenos.map(dueno => new PercibidorBroker(percepcion.vista, epoca, dueno));
  t.after(() => clientes.forEach(cliente => cliente.cerrar()));
  for (const [i, cliente] of clientes.entries()) cliente.lanzar({ ...lote, despacho: i + 1 }, planes);
  for (const [i, cliente] of clientes.entries()) {
    assert.equal(cliente.esperar(100).despacho, i + 1);
    cliente.confirmar(true);
  }
  assert.deepEqual(broker.medidas().detalle?.aceptadas, [1, 1, 1]);
  const nueva = broker.abrirEpoca(18);
  assert.equal(broker.medidas().aceptaEnEpoca, false);
  clientes[2]!.lanzar(lote, planes);
  assert.equal(clientes[2]!.esperar(100).despacho, lote.despacho);
  assert.equal(broker.medidas().peticiones, 3);
  const renovado = new PercibidorBroker(percepcion.vista, nueva, duenos[2]!);
  t.after(() => renovado.cerrar());
  renovado.lanzar(lote, planes);
  assert.equal(renovado.esperar(100).despacho, lote.despacho);
  renovado.confirmar(true);
  assert.deepEqual(broker.medidas().detalle?.aceptadas, [1, 1, 2]);
});

test('un vencimiento antes de enviar protege ambas GPU y el dueño recupera su ranura', { timeout: 10_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-cola-gpu-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marca = join(dir, 'orden');
  const entorno = { CARTA_GPU_PRUEBA_FASE: 'broker-retiene', CARTA_GPU_PRUEBA_MARCA: marca };
  const broker = new BrokerPercepcionGpu({ script, entorno }, true, 1, [8, 17, 28]);
  const otra = new BrokerPercepcionGpu({ script, entorno: { ...entorno, CARTA_GPU_PRUEBA_FASE: 'broker' } }, true, 0);
  t.after(() => Promise.all([broker.cerrar(), otra.cerrar()]));
  assert.deepEqual(await Promise.all([broker.listo, otra.listo]), [true, true]);
  const { mundo, percepcion, lote, tiles } = mundoParaPercibir();
  const epoca = broker.abrirEpoca(18);
  const primero = new PercibidorBroker(percepcion.vista, epoca, 8);
  const retrasado = new PercibidorBroker(percepcion.vista, epoca, 17);
  const duplicado = new PercibidorBroker(percepcion.vista, epoca, 8);
  const independiente = new PercibidorBroker(percepcion.vista, otra.abrirEpoca(18), 0);
  t.after(() => [primero, retrasado, duplicado, independiente].forEach(cliente => cliente.cerrar()));
  const paquetes: Uint8Array[] = [];
  const observar = new BroadcastChannel(`${epoca.canal}:1`);
  observar.onmessage = ({ data }) => paquetes.push(data.datos);
  const entrada = watch(dir);
  t.after(() => { entrada.close(); observar.close(); });
  const enServidor = new Promise<void>(resolve => {
    entrada.on('change', (_, nombre) => { if (nombre === 'orden') resolve(); });
  });
  primero.lanzar(lote, planes);
  await enServidor;
  try {
    duplicado.lanzar(lote, planes);
    assert.equal(duplicado.esperar(100).despacho, lote.despacho);
    independiente.lanzar(lote, planes);
    assert.equal(independiente.esperar(100).despacho, lote.despacho);
    independiente.confirmar(true);
    assert.deepEqual(otra.medidas().detalle?.aceptadas, [1, 0]);
    const esperarRetrasado = retrasado.esperar.bind(retrasado);
    const plazoInmediato = t.mock.method(retrasado, 'esperar', () => esperarRetrasado(0));
    percepcion.percibidor = retrasado;
    const salida = percepcion.percibir(mundo.people, lote.tick,
      { tick: lote.tick, slots: Int32Array.of(0), plan: Uint16Array.of(PLAN.conCerebro) }, tiles, undefined,
      (vista, despacho) => vista.escribirPesos(despacho.slots[0]!, new Float64Array(COLUMNAS_CEREBRO.politica).fill(0.25)));
    percepcion.cerrar();
    assert.equal(salida.tick, lote.tick);
    assert.equal(percepcion.respaldos, 1);
    plazoInmediato.mock.restore();
  } finally { writeFileSync(marca + '.libre', ''); }
  assert.equal(primero.esperar(100).despacho, lote.despacho);
  primero.confirmar(true);
  // Un nuevo paquete de otro dueño sirve de corte después del descarte en la misma cola.
  const tercero = new PercibidorBroker(percepcion.vista, epoca, 28);
  t.after(() => tercero.cerrar());
  tercero.lanzar(lote, planes);
  assert.equal(tercero.esperar(100).despacho, lote.despacho);
  tercero.confirmar(true);
  // Los BroadcastChannel de slots distintos no garantizan orden entre sí.
  for (let i = 0; i < 3 && broker.medidas().detalle?.aceptadas[1] === 0; i++) {
    retrasado.lanzar({ ...lote, despacho: i + 2 }, percepcion.planes);
    assert.equal(retrasado.esperar(100).despacho, i + 2);
    retrasado.confirmar(true);
    if (broker.medidas().detalle?.aceptadas[1] === 0) await esperar(1);
  }
  const medida = broker.medidas();
  assert.equal(medida.lista, true);
  assert.equal(medida.peticiones, 3, 'el despacho abandonado no llegó al servidor');
  assert.deepEqual(medida.detalle?.aceptadas, [1, 1, 1]);
  assert.equal(medida.detalle?.cpuColaVencida, 1);
  assert.equal(medida.detalle?.erroresCanal, 0);
  assert.ok(medida.detalle!.cpuOcupada >= 1 && medida.detalle!.colaMicros! > 0);
  await esperar(0);
  assert.equal(paquetes.length, 2);
  const valorNuevo = paquetes[1]![0]!;
  paquetes[0]![0] ^= 0xff;
  assert.equal(paquetes[1]![0], valorNuevo, 'el nuevo despacho tiene otro búfer');
});

test('la ranura del corredor conserva la identidad global del dueño en el despacho', { timeout: 10_000 }, async t => {
  const broker = corredorMedido(false, [5, null]);
  t.after(() => broker.cerrar());
  assert.equal(await broker.listo, true);
  const epoca = broker.abrirEpoca(18);
  const { percepcion, lote } = mundoParaPercibir();
  assert.throws(() => new PercibidorBroker(percepcion.vista, epoca, 0), /El dueño 0 no está asignado/);
  const cliente = new PercibidorBroker(percepcion.vista, epoca, 5);
  t.after(() => cliente.cerrar());
  const observador = new BroadcastChannel(`${epoca.canal}:0`);
  t.after(() => observador.close());
  const identidad = new Promise(resolve => {
    observador.onmessage = ({ data }) => resolve(data.identidad);
  });
  cliente.lanzar(lote, planes);
  assert.equal(cliente.esperar(100).despacho, lote.despacho);
  cliente.confirmar(true);
  assert.deepEqual(await identidad, { generacion: epoca.generacion, epoca: 18, dueno: 5, tick: lote.tick, despacho: lote.despacho });
  assert.deepEqual(broker.medidas().completadas, [1, 0]);
  assert.deepEqual(broker.medidas().detalle?.aceptadas, [1, 0]);
  assert.equal(broker.medidas().aceptaEnEpoca, true);
});

test('dos dueños despachan por un corredor y una generación nueva descarta la anterior', { timeout: 10_000 }, async t => {
  const broker = corredorMedido(false);
  t.after(() => broker.cerrar());
  assert.equal(await broker.listo, true);
  const epoca = broker.abrirEpoca(18);
  const { percepcion, lote } = mundoParaPercibir();
  const clientes = [0, 1].map(dueno => new PercibidorBroker(percepcion.vista, epoca, dueno));
  t.after(() => clientes.forEach(c => c.cerrar()));
  for (const c of clientes) {
    c.lanzar(lote, planes);
    assert.equal(c.esperar(100).despacho, lote.despacho);
  }
  assert.deepEqual(broker.medidas().completadas, [1, 1]);
  assert.equal(broker.medidas().peticiones, 2);
  assert.equal(broker.medidas().aceptaEnEpoca, false, 'el eco no prueba que F2 aceptó la tanda');
  clientes[0]!.confirmar(true);
  assert.equal(broker.medidas().aceptaEnEpoca, true);
  assert.ok(!Object.hasOwn(broker.medidas().detalle!, 'cpuPorCoste'), 'la telemetría fija conserva su esquema');
  const nueva = new PercibidorBroker(percepcion.vista, broker.abrirEpoca(19), 0);
  t.after(() => nueva.cerrar());
  clientes[1]!.confirmar(true);
  assert.equal(broker.medidas().aceptaEnEpoca, false, 'la generación anterior no acredita la nueva');
  clientes[0]!.lanzar(lote, planes);
  assert.equal(clientes[0]!.esperar(100).despacho, lote.despacho);
  assert.equal(broker.medidas().peticiones, 2, 'un cliente antiguo ejecuta en CPU');
  nueva.lanzar(lote, planes);
  assert.equal(nueva.esperar(100).tick, lote.tick);
  nueva.confirmar(false);
  assert.equal(broker.medidas().aceptaEnEpoca, false);
  assert.deepEqual(broker.medidas().completadas, [2, 1]);
  nueva.lanzar({ ...lote, despacho: 2 }, planes);
  const cierre = broker.cerrar();
  assert.throws(() => nueva.esperar(100), /no confirmó el despacho/);
  await cierre;
});

test('los 50 ms de tránsito empiezan después de preparar la tanda', { timeout: 10_000 }, async t => {
  const broker = corredorMedido(false);
  t.after(() => broker.cerrar());
  assert.equal(await broker.listo, true);
  const { percepcion, lote } = mundoParaPercibir();
  const terreno = percepcion.vista.terreno;
  const leerCelda = terreno.celda.bind(terreno);
  const pausa = new Int32Array(new SharedArrayBuffer(4));
  let primeraLectura = true;
  t.mock.method(terreno, 'celda', (x: number, y: number) => {
    if (primeraLectura) {
      primeraLectura = false;
      Atomics.wait(pausa, 0, 0, 65);
    }
    return leerCelda(x, y);
  });
  const cliente = new PercibidorBroker(percepcion.vista, broker.abrirEpoca(18), 0);
  t.after(() => cliente.cerrar());
  cliente.lanzar(lote, planes);
  assert.equal(cliente.esperar(100).despacho, lote.despacho);
  cliente.confirmar(true);
  const detalle = broker.medidas().detalle!;
  assert.ok(detalle.preparacionMicros >= 60_000);
  assert.ok(detalle.recorridoConfirmadoMicros > detalle.preparacionMicros);
  assert.deepEqual(detalle.aceptadas, [1, 0]);
});

test('el dueño descarta una respuesta lista si ya alcanzó el plazo de tránsito', { timeout: 10_000 }, async t => {
  const broker = corredorMedido(false);
  t.after(() => broker.cerrar());
  assert.equal(await broker.listo, true);
  const { percepcion, lote } = mundoParaPercibir();
  const cliente = new PercibidorBroker(percepcion.vista, broker.abrirEpoca(18), 0);
  t.after(() => cliente.cerrar());
  cliente.lanzar(lote, planes);
  await esperar(70);
  assert.deepEqual(broker.medidas().completadas, [1, 0]);
  assert.throws(() => cliente.esperar(100), /no confirmó el despacho/);
  assert.deepEqual(broker.medidas().detalle?.aceptadas, [0, 0]);
});

test('el coste del corredor selecciona CPU o GPU por tamaño y distingue un canal viejo', { timeout: 10_000 }, async t => {
  const broker = corredorMedido(true);
  t.after(() => broker.cerrar());
  assert.equal(await broker.listo, true);
  const { percepcion, lote } = mundoParaPercibir();
  let ahora = 0, despacho = 0;
  const cliente = new PercibidorBroker(percepcion.vista, broker.abrirEpoca(18), 0, () => ahora);
  t.after(() => cliente.cerrar());
  const loteGrande = { ...lote, slots: new Int32Array(16).fill(lote.slots[0]!), plan: new Uint16Array(16) };
  function ejecutar(grande = false) {
    const peticiones = broker.medidas().peticiones;
    cliente.lanzar({ ...(grande ? loteGrande : lote), despacho: ++despacho }, planes);
    assert.equal(cliente.esperar(100).despacho, despacho);
    const gpu = broker.medidas().peticiones > peticiones;
    ahora += gpu === grande ? 0.5 : 2;
    cliente.confirmar(true);
    return gpu;
  }
  const calibracion = [false, true, false, true];
  assert.deepEqual(Array.from({ length: 8 }, () => ejecutar()), [...calibracion, false, false, false, false]);
  assert.deepEqual(Array.from({ length: 8 }, () => ejecutar(true)), [...calibracion, true, true, true, true]);
  assert.equal(ejecutar(), false);
  assert.deepEqual(broker.medidas().detalle?.completadas, [8, 0]);
  assert.equal(broker.medidas().detalle?.cpuPorCoste, 9);
  assert.equal(broker.medidas().detalle?.cpuSinCanal, 0);
  broker.abrirEpoca(19);
  assert.equal(ejecutar(true), false);
  assert.equal(broker.medidas().detalle?.cpuPorCoste, 9);
  assert.equal(broker.medidas().detalle?.cpuSinCanal, 1);
});

test('el coste del corredor descarta respuestas GPU incoherentes en la ruta real de F2', { timeout: 10_000 }, async t => {
  const broker = corredorMedido(true);
  t.after(() => broker.cerrar());
  assert.equal(await broker.listo, true);
  const { percepcion, mundo, tiles } = mundoParaPercibir();
  const cliente = new PercibidorBroker(percepcion.vista, broker.abrirEpoca(18), 0);
  t.after(() => cliente.cerrar());
  const confirmar = t.mock.method(cliente, 'confirmar');
  percepcion.percibidor = cliente;
  const lote = { tick: 0, slots: Int32Array.of(0), plan: Uint16Array.of(PLAN.sinCerebro) };
  function ejecutar() {
    const salida = percepcion.percibir(mundo.people, lote.tick, lote, tiles, undefined, () => {});
    assert.equal(salida.tick, lote.tick);
    percepcion.cerrar();
  }
  for (let i = 0; i < 6; i++) ejecutar();
  assert.equal(percepcion.respaldos, 1);
  assert.deepEqual(confirmar.mock.calls.map(c => c.arguments[0]), [true, false, true, true, true, true]);
  assert.deepEqual(broker.medidas().detalle?.completadas, [1, 0], 'el corredor sí recibió una respuesta con el eco correcto');
  assert.deepEqual(broker.medidas().detalle?.aceptadas, [0, 0]);
  assert.equal(broker.medidas().aceptaEnEpoca, false);
  assert.equal(broker.medidas().detalle?.rechazadas, 1);
  assert.equal(broker.medidas().detalle?.cpuPorCoste, 5, 'pospone otra sonda de la ruta observada como inválida');
  for (let i = 0; i < 60; i++) ejecutar();
  assert.deepEqual(broker.medidas().detalle?.completadas, [2, 0], 'la calibración vuelve a sondear pasado el intervalo');
  assert.equal(percepcion.respaldos, 2);
});

for (const { fallo, duenos } of [
  { fallo: 'broker-rancio', duenos: [5, null] },
  { fallo: 'broker-expira', duenos: [5, null] },
  { fallo: 'broker-rancio', duenos: [8, 17, 5] },
]) {
  test(`el dueño pierde el búfer y conserva el tick ante ${fallo} en ${duenos.length} ranuras`, { timeout: 10_000 }, async t => {
    const broker = new BrokerPercepcionGpu({ script, entorno: { CARTA_GPU_PRUEBA_FASE: fallo, CARTA_GPU_PRUEBA_MARCA: '' } },
      false, 0, duenos);
    t.after(() => broker.cerrar());
    assert.equal(await broker.listo, true);
    const { percepcion, lote, mundo, tiles } = mundoParaPercibir();
    const cliente = new PercibidorBroker(percepcion.vista, broker.abrirEpoca(12), 5);
    t.after(() => cliente.cerrar());
    percepcion.percibidor = cliente;
    const salida = percepcion.percibir(mundo.people, lote.tick,
      { tick: lote.tick, slots: Int32Array.of(0), plan: Uint16Array.of(PLAN.sinCerebro) }, tiles, undefined, () => {});
    percepcion.cerrar();
    assert.equal(salida.tick, lote.tick);
    assert.equal(percepcion.respaldos, 1, 'el mismo despacho se repite en CPU');
    assert.deepEqual(broker.medidas().completadas, duenos.map(() => 0));
    cliente.lanzar({ ...lote, despacho: 2 }, planes);
    assert.equal(cliente.esperar(100).despacho, 2, 'CPU toma el despacho siguiente con una salida propia');
  });
}

test('el motor distribuye los grupos CUDA y conserva los modos compartido y dual de dos dueños', { timeout: 20_000 }, async t => {
  const python = execFileSync('which', ['python3'], { encoding: 'utf8' }).trim();
  const dir = mkdtempSync(join(tmpdir(), 'atlas-v24-gpu-simulada-'));
  writeFileSync(join(dir, 'python3'), [
    '#!/bin/sh', 'modo="$1"', 'shift 2', 'exec "$CARTA_GPU_PRUEBA_PYTHON" "$modo" "$CARTA_GPU_PRUEBA_SCRIPT" "$@"',
  ].join('\n') + '\n', { mode: 0o700 });
  const entorno = {
    PATH: `${dir}:${process.env.PATH}`, COMPUTE_NVRTC: 'solo-para-el-servidor-simulado',
    CARTA_PERCEPCION_DUENOS: '1', CARTA_PERCEPCION_COSTE_DUENOS: '0',
    CARTA_GPU_PRUEBA_PYTHON: python, CARTA_GPU_PRUEBA_SCRIPT: script, CARTA_GPU_PRUEBA_FASE: 'broker-valido',
    CARTA_GPU_PRUEBA_MARCA: join(dir, 'fallo'), CARTA_GPU_PRUEBA_FASE_GPU0: 'broker-rancio',
  };
  const anterior = Object.fromEntries(Object.keys(entorno).map(k => [k, process.env[k]]));
  Object.assign(process.env, entorno);
  t.after(() => {
    for (const [k, v] of Object.entries(anterior)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const semilla = 2321171583, base = hostOpenWorldParams();
  for (const { gpu, faseGpu0, arranca } of [
    { gpu: [1], faseGpu0: 'broker-rancio', arranca: true },
    { gpu: [0, 1], faseGpu0: 'broker-valido', arranca: true },
    { gpu: [0, 1], faseGpu0: 'broker-rancio', arranca: true },
    { gpu: [0, 1], faseGpu0: 'arranque', arranca: false },
  ]) {
    process.env.CARTA_GPU_PRUEBA_FASE_GPU0 = faseGpu0;
    const params = parseParams({ v23: escalon('duenos'), motor: { ...base.motor, hilos: 2, gpu } }, base);
    const mundo = createWorld(semilla, params);
    const destino = mundo.tiles.find(celda => celda.x >= 32 && celda.terrain !== 'water')!;
    const { x, y } = destino;
    // El este pertenece al dueño 1. Escalonar los vencimientos deja despachos de ambos dueños en la GPU compartida.
    for (const persona of mundo.people.slice(-3)) Object.assign(persona, { x, y, target: { x, y }, decisionAt: 2 });
    mundo.people[2]!.decisionAt = 3;
    const motor = crearMotor(mundo, { hilos: 2, gpu, decisionGpu: 'siempre', verificar: true, semilla, medirBrokerGpu: true });
    try {
      assert.equal(await motor.prepararBrokerGpu?.(), arranca);
      assert.deepEqual(motor.telemetria().gpuBrokers?.map(tarjeta => tarjeta.lista), gpu.map(d => arranca || d === 1));
      for (let i = 1; i <= 3; i++) assert.equal(motor.paso([]).tick, i);
      const tarjeta = motor.telemetria().gpuBrokers!;
      assert.deepEqual(tarjeta.map(d => d.dispositivo), gpu);
      const gpu1 = tarjeta.at(-1)!.detalle!;
      assert.ok(gpu1.aceptadas[1] > 0 && gpu1.subidaConfirmadaBytes > 0 && gpu1.bajadaConfirmadaBytes > 0,
        JSON.stringify({ gpu, faseGpu0, tarjeta }));
      if (gpu.length === 1) {
        assert.ok(gpu1.aceptadas[0] > 0, 'los dos dueños comparten GPU1');
        assert.deepEqual(motor.telemetria().gpuBroker, gpu1);
      } else {
        assert.equal(gpu1.lotes, gpu1.aceptadas[1], 'GPU1 atiende solo al dueño 1');
        assert.deepEqual(gpu1.aceptadas, [0, gpu1.aceptadas[1]]);
        const gpu0 = tarjeta[0]!.detalle!;
        if (faseGpu0 === 'broker-valido') {
          assert.ok(gpu0.aceptadas[0] > 0);
          assert.equal(gpu0.lotes, gpu0.aceptadas[0], 'GPU0 atiende solo al dueño 0');
          assert.deepEqual(motor.telemetria().gpuEstado, ['ok', 'ok']);
        } else {
          assert.equal(tarjeta[0]!.lista, false);
          assert.ok(gpu0.lotes > 0 && gpu0.cpuSinCanal > 0, 'el dueño 0 conserva la ruta CPU');
          assert.equal(gpu0.erroresCanal, arranca ? 1 : 0);
          assert.deepEqual(motor.telemetria().gpuEstado, ['cpu', 'ok']);
        }
      }
    } finally { await motor.cerrar(); }
  }
  process.env.CARTA_GPU_PRUEBA_FASE_GPU0 = 'broker-valido';
  const hilos = 3, gpu = [0, 1], gruposPercepcionGpu = [[2, 0], [1]];
  const params = parseParams({ v23: escalon('duenos'), motor: { ...base.motor, hilos, gpu } }, base);
  const mundo = createWorld(semilla, params);
  const { x, y } = mundo.tiles.find(celda => celda.x >= 32 && celda.terrain !== 'water')!;
  for (const persona of mundo.people.slice(-2)) Object.assign(persona, { x, y, target: { x, y }, decisionAt: 2 });
  const motor = crearMotor(mundo, { hilos, gpu, gruposPercepcionGpu, decisionGpu: 'siempre', verificar: true, semilla, medirBrokerGpu: true });
  try {
    assert.equal(await motor.prepararBrokerGpu?.(), true);
    for (let i = 1; i <= 3; i++) assert.equal(motor.paso([]).tick, i);
    const tarjetas = motor.telemetria().gpuBrokers!;
    assert.deepEqual(tarjetas.map(tarjeta => tarjeta.duenosPorRanura), gruposPercepcionGpu);
    assert.ok(tarjetas.every(tarjeta => tarjeta.detalle!.aceptadas.every(n => n > 0)), JSON.stringify(tarjetas));
  } finally { await motor.cerrar(); }
});

test('CUDA real: F2 distribuida usa el corredor desde el motor de dos dueños', {
  timeout: 15_000, skip: !process.env.COMPUTE_NVRTC && 'Se requiere GPU0 y COMPUTE_NVRTC',
}, async () => {
  const anterior = process.env.CARTA_PERCEPCION_DUENOS;
  process.env.CARTA_PERCEPCION_DUENOS = '1';
  const semilla = 2321171583;
  const base = hostOpenWorldParams();
  const params = parseParams({ v23: escalon('duenos'), motor: { ...base.motor, hilos: 2, gpu: [0] } }, base);
  const mundo = createWorld(semilla, params);
  const motor = crearMotor(mundo, { hilos: 2, gpu: [0], decisionGpu: 'siempre', verificar: true, semilla });
  try {
    motor.paso([]);
    if (motor.telemetria().gpuEstado[0] !== 'ok') await esperar(1000);
    for (let i = 0; i < 20 && motor.telemetria().gpuEstado[0] !== 'ok'; i++) motor.paso([]);
    assert.equal(motor.telemetria().gpuEstado[0], 'ok');
    assert.ok(motor.telemetria().gpuBytes[0]! > 0);
    assert.ok(mundo.tick >= 1);
  } finally {
    if (anterior === undefined) delete process.env.CARTA_PERCEPCION_DUENOS;
    else process.env.CARTA_PERCEPCION_DUENOS = anterior;
    await motor.cerrar();
  }
});

test('la recarga conserva mundo y época si intenta cambiar el uso de CUDA en cualquier sentido', {
  timeout: 15_000, skip: !process.env.COMPUTE_NVRTC && 'Se requiere GPU0 y COMPUTE_NVRTC',
}, async t => {
  const anterior = process.env.CARTA_PERCEPCION_DUENOS;
  process.env.CARTA_PERCEPCION_DUENOS = '1';
  t.after(() => {
    if (anterior === undefined) delete process.env.CARTA_PERCEPCION_DUENOS;
    else process.env.CARTA_PERCEPCION_DUENOS = anterior;
  });
  const base = hostOpenWorldParams();
  const crearMundo = (seed: number, materiaGpu: boolean) => createWorld(seed, parseParams({
    v23: { ...escalon('duenos'), materiaGpu }, motor: { ...base.motor, hilos: 2, gpu: [0] },
  }, base));
  for (const materiaGpu of [false, true]) {
    const semilla = 2321171583;
    const motor = crearMotor(crearMundo(semilla, false), { hilos: 2, gpu: [0], decisionGpu: 'siempre', verificar: true, semilla });
    try {
      motor.cargar({ world: crearMundo(semilla, materiaGpu), materia: null }, 2);
      const opuesto = crearMundo(semilla + 1, !materiaGpu);
      assert.throws(() => motor.cargar({ world: opuesto, materia: null }, 3), /requiere cerrar y crear un motor nuevo/);
      assert.equal(motor.muestraCarga()?.epoca, 2);
      const { world } = motor.instantanea();
      assert.equal(world.seed, semilla);
      assert.equal(paramsOf(world).v23.materiaGpu, materiaGpu);
      motor.cargar({ world: crearMundo(semilla + 2, materiaGpu), materia: null }, 4);
      assert.equal(motor.muestraCarga()?.epoca, 4);
      assert.equal(motor.instantanea().world.seed, semilla + 2);
    } finally { await motor.cerrar(); }
  }
});
