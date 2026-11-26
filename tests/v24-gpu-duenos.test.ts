import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as esperar } from 'node:timers/promises';
import { hostOpenWorldParams } from '../src/server/hardware-limits.js';
import { escalon } from '../src/shared/interruptores.js';
import { percepcionDe } from '../src/world/decision/percepcion.js';
import { PLAN } from '../src/world/decision/planes.js';
import { BrokerPercepcionGpu, PercibidorBroker } from '../src/world/gpu/broker-percepcion.js';
import type { Plan } from '../src/world/motor/contratos.js';
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

test('dos dueños despachan por un corredor y una generación nueva descarta la anterior', { timeout: 10_000 }, async t => {
  const broker = new BrokerPercepcionGpu({ script, entorno: { CARTA_GPU_PRUEBA_FASE: 'broker', CARTA_GPU_PRUEBA_MARCA: '' } });
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
  const nueva = new PercibidorBroker(percepcion.vista, broker.abrirEpoca(19), 0);
  t.after(() => nueva.cerrar());
  clientes[0]!.lanzar(lote, planes);
  assert.equal(clientes[0]!.esperar(100).despacho, lote.despacho);
  assert.equal(broker.medidas().peticiones, 2, 'un cliente antiguo ejecuta en CPU');
  nueva.lanzar(lote, planes);
  assert.equal(nueva.esperar(100).tick, lote.tick);
  assert.deepEqual(broker.medidas().completadas, [2, 1]);
  nueva.lanzar({ ...lote, despacho: 2 }, planes);
  const cierre = broker.cerrar();
  assert.throws(() => nueva.esperar(100), /no confirmó el despacho/);
  await cierre;
});

for (const fallo of ['broker-rancio', 'broker-expira']) {
  test(`el dueño pierde el búfer y conserva el tick ante ${fallo}`, { timeout: 10_000 }, async t => {
    const broker = new BrokerPercepcionGpu({ script, entorno: { CARTA_GPU_PRUEBA_FASE: fallo, CARTA_GPU_PRUEBA_MARCA: '' } });
    t.after(() => broker.cerrar());
    assert.equal(await broker.listo, true);
    const { percepcion, lote, mundo, tiles } = mundoParaPercibir();
    const cliente = new PercibidorBroker(percepcion.vista, broker.abrirEpoca(12), 0);
    t.after(() => cliente.cerrar());
    percepcion.percibidor = cliente;
    const salida = percepcion.percibir(mundo.people, lote.tick,
      { tick: lote.tick, slots: Int32Array.of(0), plan: Uint16Array.of(PLAN.sinCerebro) }, tiles, undefined, () => {});
    percepcion.cerrar();
    assert.equal(salida.tick, lote.tick);
    assert.equal(percepcion.respaldos, 1, 'el mismo despacho se repite en CPU');
    assert.equal(broker.medidas().completadas[0], 0);
    cliente.lanzar({ ...lote, despacho: 2 }, planes);
    assert.equal(cliente.esperar(100).despacho, 2, 'CPU toma el despacho siguiente con una salida propia');
  });
}

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
