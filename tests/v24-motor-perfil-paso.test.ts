import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import test from 'node:test';
import { acreditarGpu, validacionConfiguracion } from '../scripts/perf/banco-motor-v24.mjs';
import { escalon } from '../src/shared/interruptores.js';
import { createWorld } from '../src/world/index.js';
import type { TelemetriaBrokerGpu, TelemetriaDispositivoBrokerGpu } from '../src/world/motor/contratos.js';
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

const medido: TelemetriaBrokerGpu = { lotes: 1, completadas: [1, 0], aceptadas: [1, 0], rechazadas: 0, cpuArranque: 0,
  cpuOcupada: 0, cpuSinCanal: 0, erroresCanal: 0, subidaConfirmadaBytes: 1, bajadaConfirmadaBytes: 1,
  cudaConfirmadaMicros: 1, recorridoConfirmadoMicros: 1, preparacionMicros: 0 };

test('el banco distingue GPU degradada de desvíos esperados a CPU', () => {
  const brazoGpu = { id: 'adaptativo', hilos: 2, gpu: [0], rutaGpu: 'porCoste' as const };
  const gpu = (lista: boolean, cambios: Partial<TelemetriaBrokerGpu> = {}) =>
    [{ dispositivo: 0, lista, detalle: { ...medido, cpuPorCoste: 0, ...cambios } }];
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

test('el banco distingue las asignaciones por dueño y rechaza mapeos repetidos o inválidos',
  { skip: availableParallelism() < 2 }, () => {
    const config = { repeticiones: 1, escenas: [{ id: 'ejemplo', semilla: 7, siembra: 7, n: 20, zona: '0,0,48,32', calentar: 1, medir: 1 }] };
    const a = { id: 'a', hilos: 2, gpu: [0], duenosPercepcionGpu: [0] };
    const b = { ...a, id: 'b', duenosPercepcionGpu: [1] };
    assert.deepEqual(validacionConfiguracion({ ...config, brazos: [a, b] }), [a, b]);
    assert.throws(() => validacionConfiguracion({ ...config, brazos: [a, { ...a, id: 'b' }] }), /Configuraciones de brazos repetidas/);
    for (const invalido of [
      { ...b, duenosPercepcionGpu: [2] }, { ...b, duenosPercepcionGpu: [0.5] },
      { ...b, gpu: [], duenosPercepcionGpu: [] }, { ...b, gpu: [0, 1], duenosPercepcionGpu: [1, 1] },
      { ...b, gruposPercepcionGpu: [[0, 1]] }, { ...b, duenosPercepcionGpu: undefined, gruposPercepcionGpu: [[1, 1]] },
    ]) assert.throws(() => validacionConfiguracion({ ...config, brazos: [a, invalido] }), /mapeo de dueños válido/);
    const unaGpu = { id: 'viejo', hilos: 2, gpu: [0] };
    const agrupado = { ...unaGpu, id: 'grupo', gruposPercepcionGpu: [[0, 1]] };
    assert.deepEqual(validacionConfiguracion({ ...config, brazos: [unaGpu, agrupado] }), [unaGpu, agrupado]);
});

test('el banco coteja el mapeo global en ventana y calentamiento y deja vacía la ranura sobrante', () => {
  const brazo = { id: 'dual-cpu4', hilos: 4, gpu: [0, 1], duenosPercepcionGpu: [3, 1] };
  const primera: TelemetriaDispositivoBrokerGpu = { dispositivo: 0, lista: true, detalle: medido, duenosPorRanura: [3, null] };
  const segunda: TelemetriaDispositivoBrokerGpu = { dispositivo: 1, lista: true, detalle: medido, duenosPorRanura: [1, null] };
  const ventana = [primera, segunda];
  assert.equal(acreditarGpu(brazo, ventana, ventana).estado, 'completo');
  assert.equal(acreditarGpu(brazo, ventana).estado, 'completo');
  assert.throws(() => acreditarGpu(brazo, [primera, { ...segunda, duenosPorRanura: undefined }]), /Mapeo por ranura GPU1/);
  assert.throws(() => acreditarGpu(brazo, ventana, [{ ...primera, duenosPorRanura: [0, null] }, segunda]), /Mapeo por ranura GPU0/);
  assert.throws(() => acreditarGpu(brazo, ventana, [primera, { ...segunda, duenosPorRanura: undefined }]), /Mapeo por ranura GPU1/);
  const completaFuera: TelemetriaDispositivoBrokerGpu = { ...segunda, detalle: { ...medido, completadas: [1, 1] } };
  const aceptaFuera: TelemetriaDispositivoBrokerGpu = { ...segunda, detalle: { ...medido, aceptadas: [1, 1] } };
  assert.throws(() => acreditarGpu(brazo, [primera, completaFuera]), /ranura sin dueño/);
  assert.throws(() => acreditarGpu(brazo, ventana, [primera, aceptaFuera]), /ranura sin dueño/);
  assert.deepEqual(acreditarGpu(brazo, [primera, { ...segunda, lista: false }]).gpuDegradadas, [1]);

  const legado = { id: 'dual-cpu2', hilos: 2, gpu: [0, 1] };
  const antigua0 = { ...primera, duenosPorRanura: undefined };
  const antigua1: TelemetriaDispositivoBrokerGpu = { ...segunda, duenosPorRanura: undefined,
    detalle: { ...medido, completadas: [0, 1], aceptadas: [0, 1] } };
  assert.equal(acreditarGpu(legado, [antigua0, antigua1]).estado, 'completo');
  assert.throws(() => acreditarGpu(legado, [antigua0, { ...antigua1, duenosPorRanura: [1, null] }]), /Mapeo por ranura GPU1/);
});

test('el banco de grupos acredita cada dueño por salidas que F2 aceptó', () => {
  const brazo = { id: 'dual-cpu4', hilos: 4, gpu: [0, 1], gruposPercepcionGpu: [[3, 0, 2], [1]] };
  const primera: TelemetriaDispositivoBrokerGpu = { dispositivo: 0, lista: true, duenosPorRanura: [3, 0, 2],
    detalle: { ...medido, completadas: [1, 2, 1], aceptadas: [1, 0, 1] } };
  const segunda: TelemetriaDispositivoBrokerGpu = { dispositivo: 1, lista: true, duenosPorRanura: [1],
    detalle: { ...medido, completadas: [1], aceptadas: [1] } };
  const ventana = [primera, segunda];
  const calentamiento = [{ ...primera, detalle: { ...primera.detalle!, aceptadas: [1, 2, 1] } }, segunda];
  assert.deepEqual(acreditarGpu(brazo, ventana, calentamiento), {
    estado: 'sin-actividad-gpu', sinGpu: [0], gpuDegradadas: [], duenosSinGpu: [{ dispositivo: 0, duenos: [0] }],
  });
  assert.equal(acreditarGpu(brazo, calentamiento).estado, 'completo');
  const adaptativo = (v: TelemetriaDispositivoBrokerGpu[]) => v.map(t => ({ ...t, detalle: { ...t.detalle!, cpuPorCoste: 1 } }));
  assert.equal(acreditarGpu({ ...brazo, rutaGpu: 'porCoste' }, adaptativo(ventana), adaptativo(calentamiento)).estado, 'completo');
  const truncada = { ...primera, detalle: { ...primera.detalle!, aceptadas: [1, 1] } };
  assert.throws(() => acreditarGpu(brazo, [truncada, segunda]), /Contadores por ranura GPU0 incompletos/);
});
