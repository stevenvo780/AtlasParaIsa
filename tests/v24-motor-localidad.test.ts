import assert from 'node:assert/strict';
import test from 'node:test';
import { compararLocalidad } from '../src/world/motor/localidad.js';
import { repartir, type MedidaReparto } from '../src/world/motor/rebalanceo.js';

function cuadrado() {
  return {
    chunks: Int32Array.from({ length: 16 }, (_, i) => i),
    px: Int32Array.from({ length: 16 }, (_, i) => i % 4),
    py: Int32Array.from({ length: 16 }, (_, i) => Math.floor(i / 4)),
    costeMs: new Float64Array(16).fill(1),
    dueno: Int16Array.from({ length: 16 }, (_, i) => i === 0 ? -1 : Number(i % 4 >= 2)),
    hiloMs: new Float64Array(2),
  } satisfies MedidaReparto;
}

test('compara Morton original y transpuesto y contabiliza la cesión de los chunks existentes', () => {
  const m = cuadrado(), anterior = m.dueno.slice();
  const r = compararLocalidad(m, 2, { calibracion: {
    pasos: 10, serieMs: 0, haloMsPorExtremo: 0, otroDominioMsPorExtremo: 0, cesionMsPorExtremo: 10,
  } });
  const [normal, transpuesto] = r.planes;
  assert.deepEqual(normal!.dueños, repartir(m, 2));
  assert.equal(normal!.paresDeHalo, 10, 'incluye bordes y esquinas, una vez por par');
  assert.equal(transpuesto!.paresDeHalo, 10);
  assert.equal(normal!.chunksCedidos, 8);
  assert.deepEqual(normal!.cesionAmortizadaMsPorHilo, [8, 8]);
  assert.equal(transpuesto!.chunksCedidos, 0);
  assert.equal(transpuesto!.desequilibrio, 1);
  assert.equal(transpuesto!.pasoEstimadoMs, 8);
  assert.equal(r.preferido, 'mortonTranspuesto');
  assert.deepEqual(m.dueno, anterior);
});

test('separa la carga, el coste de halo entre dominios y la holgura observada', () => {
  const m = { chunks: Int32Array.of(1, 2), px: Int32Array.of(-1, 0), py: Int32Array.of(0, 0), costeMs: Float64Array.of(5, 10),
    dueno: Int16Array.of(0, 1), hiloMs: Float64Array.of(8, 15) };
  const r = compararLocalidad(m, 2, { dominioPorHilo: [0, 1], presupuestoPasoMs: 20, pasoObservadoMs: 22,
    calibracion: { pasos: 10, serieMs: 3, haloMsPorExtremo: 1, otroDominioMsPorExtremo: 2, cesionMsPorExtremo: 40 } });
  const vigente = r.planes[0]!;
  assert.equal(vigente.nombre, 'vigente');
  assert.deepEqual(vigente.cargaMsPorHilo, [5, 10]);
  assert.equal(vigente.paresEntreDominios, 1);
  assert.deepEqual(vigente.haloMsPorHilo, [3, 3]);
  assert.equal(vigente.pasoEstimadoMs, 16);
  assert.equal(vigente.holguraEstimadaMs, 4);
  assert.equal(r.holguraObservadaMs, -2);
  assert.equal(r.desequilibrioObservado, 15 / 11.5);
});

test('sin calibración sólo hay cargas y geometría, con coste medio para chunks nuevos', () => {
  const m = cuadrado();
  m.costeMs[0] = 0;
  const r = compararLocalidad(m, 2, { presupuestoPasoMs: 8 });
  assert.equal(r.chunksMedidos, 15);
  assert.equal(r.holguraObservadaMs, null);
  for (const plan of r.planes) {
    assert.deepEqual(plan.cargaMsPorHilo, [8, 8]);
    assert.equal(plan.pasoEstimadoMs, null);
    assert.equal(plan.paresEntreDominios, null);
  }
  assert.throws(() => compararLocalidad(m, 2, { dominioPorHilo: [0] }), RangeError);
});
