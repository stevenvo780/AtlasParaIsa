import assert from 'node:assert/strict';
import test from 'node:test';
import { acreditarGpu } from '../scripts/perf/banco-motor-v24.mjs';
import { escalon } from '../src/shared/interruptores.js';
import { createWorld } from '../src/world/index.js';
import type { TelemetriaBrokerGpu } from '../src/world/motor/contratos.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { parseParams } from '../src/world/params.js';

for (const hilos of [1, 2]) test(`el perfil confirma el paso y la época con ${hilos} dueños`, async t => {
  const semilla = 7;
  const params = parseParams({ motor: { hilos }, v23: escalon('duenos') });
  const config = { hilos, gpu: [], decisionGpu: 'siempre', verificar: false, semilla } as const;
  const motor = crearMotor(createWorld(semilla, params), { ...config, medirPaso: true });
  t.after(() => motor.cerrar());
  assert.equal(motor.muestraPerfilPaso(), undefined);
  assert.equal(motor.paso([]).tick, 1);
  const paso = motor.muestraPerfilPaso();
  assert.ok(paso);
  assert.deepEqual([paso.tick, paso.epoca], [1, 0]);
  assert.ok(paso.paredMs >= paso.F0Ms && paso.F0Ms > 0);
  assert.equal(paso.fasesPorDuenoMs.length, hilos);
  if (hilos === 1) {
    assert.equal(paso.cierreMs, null);
    assert.deepEqual(paso.tramos, []);
    assert.deepEqual([paso.fasesPorDuenoMs[0]?.F3, paso.fasesPorDuenoMs[0]?.F4], [null, null]);
  } else {
    assert.ok(paso.cierreMs !== null && paso.cierreMs >= 0);
    assert.deepEqual(paso.tramos.map(tramo => tramo.tramo), ['percibir', 'actuar', 'aplicar', 'publicar']);
    const totalTramos = paso.tramos.reduce((ms, tramo) => ms + tramo.paredMs, 0);
    assert.ok(paso.F0Ms + totalTramos + paso.cierreMs <= paso.paredMs + 1e-6);
    for (const tramo of paso.tramos) {
      assert.ok(tramo.esperaCoordinadorMs >= 0 && tramo.paredMs >= tramo.esperaCoordinadorMs);
    }
    const carga = motor.muestraCarga();
    for (const [dueno, fase] of paso.fasesPorDuenoMs.entries()) {
      assert.equal(fase.F1, carga?.fasesPorDuenoMs?.[dueno]?.F1);
      assert.equal(fase.F2, carga?.fasesPorDuenoMs?.[dueno]?.F2);
      assert.ok(fase.F3 !== null && fase.F3 >= 0 && fase.F4 !== null && fase.F4 >= 0);
      assert.ok(Math.abs(fase.F3 + fase.F4 - fase.F3F4) < 1e-6);
      const total = fase.F1 + fase.eco + fase.F2 + fase.F3F4 + fase.F5 + fase.F6;
      assert.ok(Math.abs(total - (motor.reparto()?.msPorHilo[dueno] ?? NaN)) < 1e-6);
    }
  }

  const snapshot = JSON.stringify(paso);
  motor.cargar(motor.instantanea(), 9);
  assert.equal(motor.muestraPerfilPaso(), undefined);
  assert.equal(motor.paso([]).tick, 2);
  const siguiente = motor.muestraPerfilPaso();
  assert.deepEqual([siguiente?.tick, siguiente?.epoca], [2, 9]);
  assert.equal(JSON.stringify(paso), snapshot);
  await motor.cerrar();
  assert.equal(motor.muestraPerfilPaso(), undefined);
});

test('el motor por defecto no publica el perfil', async t => {
  const semilla = 7, hilos = 2;
  const params = parseParams({ motor: { hilos }, v23: escalon('duenos') });
  const motor = crearMotor(createWorld(semilla, params), { hilos, gpu: [], decisionGpu: 'siempre', verificar: false, semilla });
  t.after(() => motor.cerrar());
  motor.paso([]);
  assert.equal(motor.muestraPerfilPaso(), undefined);
});

test('el banco distingue GPU degradada de desvíos esperados a CPU', () => {
  const brazoGpu = { id: 'adaptativo', hilos: 2, gpu: [0], rutaGpu: 'porCoste' as const };
  const medido: TelemetriaBrokerGpu = { lotes: 1, completadas: [1, 0], aceptadas: [1, 0], rechazadas: 0, cpuArranque: 0,
    cpuOcupada: 0, cpuSinCanal: 0, cpuPorCoste: 0, erroresCanal: 0, subidaConfirmadaBytes: 1, bajadaConfirmadaBytes: 1,
    cudaConfirmadaMicros: 1, recorridoConfirmadoMicros: 1, preparacionMicros: 0 };
  const gpu = (lista: boolean, cambios: Partial<TelemetriaBrokerGpu> = {}) =>
    [{ dispositivo: 0, lista, detalle: { ...medido, ...cambios } }];
  assert.equal(acreditarGpu(brazoGpu, gpu(true, { cpuOcupada: 1, cpuPorCoste: 1 })).estado, 'completo');
  const soloCpu = { completadas: [0, 0], aceptadas: [0, 0], subidaConfirmadaBytes: 0, bajadaConfirmadaBytes: 0, cpuPorCoste: 1 } satisfies Partial<TelemetriaBrokerGpu>;
  assert.equal(acreditarGpu(brazoGpu, gpu(true, soloCpu), gpu(true)).estado, 'completo');
  assert.equal(acreditarGpu(brazoGpu, gpu(true, soloCpu)).estado, 'sin-actividad-gpu');
  assert.deepEqual(acreditarGpu(brazoGpu, gpu(false, soloCpu), gpu(true)), { estado: 'gpu-degradada', sinGpu: [], gpuDegradadas: [0] });
  for (const cambios of [{ erroresCanal: 1 }, { cpuSinCanal: 1 }]) {
    const resultado = acreditarGpu(brazoGpu, gpu(true, cambios));
    assert.equal(resultado.estado, 'gpu-degradada');
    assert.deepEqual(resultado.gpuDegradadas, [0]);
  }
});
