/**
 * Cobertura que se fue con `gpu/reparto.ts` (M2b lo borró: ya no lo importa nadie) y que sigue vigente mientras el
 * puente de ecología reparta celdas entre tarjetas por tramos: un paso de ecología partido en tramos contiguos de
 * páginas da exactamente lo mismo que el paso entero, con cualquier proporción (c73221b:tests/gpu-reparto.test.ts:48
 * y :74). Los tramos se calculan aquí directamente; el orden Morton de las páginas y sus límites son de M1
 * (`soa/morton.ts`) y no se prueban aquí.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parityFixture } from '../src/world/gpu/autoprueba.js';
import { HISTORICAL_PARAMS } from '../src/world/params.js';
// @ts-ignore utilidades aisladas del banco de ecología
import { pack, topology, localEcologyArrays, stepArrays, stepEcologyArrays, compare } from '../scripts/compute-ecology-core.mjs';
// @ts-ignore utilidades aisladas del banco de ecología
import { GPUWorker } from '../scripts/compute-ecology-clients.mjs';

const PROPORCIONES = [[79, 21], [50, 50], [100, 0]] as const;
const opciones = { seed: 51926, cuencas: 0.4, decaimientoFertilidad: 0.001, localEcology: true, recursos: HISTORICAL_PARAMS.recursos };

/** 100 páginas de 16×16 con coordenadas con signo, en orden invertido. */
function paginas() {
  const sinteticas = parityFixture();
  return Array.from({ length: 100 }, (_, i) => ({
    x: i % 10 - 5, y: Math.floor(i / 10) - 5,
    tiles: Array.from({ length: 256 }, (_, j) => ({ ...sinteticas[(i * 97 + j) % sinteticas.length]!, x: (i % 10 - 5) * 16 + j % 16, y: (Math.floor(i / 10) - 5) * 16 + Math.floor(j / 16) })),
  })).reverse();
}

/** Tramos de celdas [inicio, fin) de cada tarjeta para `proporcion`, en páginas enteras. */
const tramos = (proporcion: readonly number[], n: number) => {
  let cursor = 0;
  return proporcion.map((p, d) => { const inicio = cursor; cursor = d === proporcion.length - 1 ? n : cursor + Math.round(n / 256 * p / 100) * 256; return { device: d, begin: inicio, end: cursor }; });
};

test('un paso de ecología en tramos 79:21, 50:50 y 100:0 da cero diferencias y los mismos bytes que el paso entero', () => {
  const tiles = paginas().flatMap(p => p.tiles), n = tiles.length, vecinos = topology(tiles), entrada = pack(tiles);
  let control: Buffer | undefined;
  for (const proporcion of PROPORCIONES) {
    const partes = tramos(proporcion, n);
    assert.deepEqual(partes.map(t => (t.end - t.begin) / 256), [...proporcion]);
    const medio = new Float64Array(entrada.length), salida = new Float64Array(entrada.length), esperado = new Float64Array(entrada.length);
    // Barrera completa entre pasadas, también cuando un vecino cardinal es de la otra tarjeta.
    localEcologyArrays(entrada, medio, vecinos, n, 100, true, 1, opciones);
    for (const t of partes) stepArrays(medio, salida, vecinos, n, 100, true, 1, t.begin, t.end, opciones);
    stepEcologyArrays(entrada, esperado, vecinos, n, 100, true, 1, opciones);
    assert.deepEqual(compare(esperado, salida), { different: 0, maximumAbsoluteError: 0 });
    const bytes = Buffer.from(salida.buffer);
    if (control) assert.deepEqual(bytes, control); else control = bytes;
  }
});

test('en dos tarjetas reales, los tramos 79:21, 50:50 y 100:0 dan los mismos bytes', async contexto => {
  const nvrtc = process.env.COMPUTE_NVRTC;
  if (!nvrtc) { contexto.skip('sin COMPUTE_NVRTC'); return; }
  const sonda = spawnSync('python3', ['-c', 'import ctypes; print(ctypes.CDLL("libcuda.so.1").cuInit(0))'], { encoding: 'utf8', timeout: 5000 });
  if (sonda.stdout.trim() !== '0') { contexto.skip(`CUDA no disponible: cuInit=${sonda.stdout.trim() || sonda.stderr.trim()}`); return; }
  const gpu = await GPUWorker.create('0,1', nvrtc), tiles = paginas().flatMap(p => p.tiles), n = tiles.length, vecinos = topology(tiles), entrada = pack(tiles);
  let control: Buffer | undefined;
  try {
    for (const proporcion of PROPORCIONES) {
      await gpu.setup(n, vecinos, { ranges: tramos(proporcion, n) });
      const real = (await gpu.step(entrada, 100, true, 1, opciones)).data, esperado = new Float64Array(entrada.length);
      stepEcologyArrays(entrada, esperado, vecinos, n, 100, true, 1, opciones);
      assert.deepEqual(compare(esperado, real), { different: 0, maximumAbsoluteError: 0 });
      const bytes = Buffer.from(real.buffer, real.byteOffset, real.byteLength);
      if (control) assert.deepEqual(bytes, control); else control = Buffer.from(bytes);
    }
  } finally { await gpu.close(); }
});
