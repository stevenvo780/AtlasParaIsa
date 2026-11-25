import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidatosAuto, desequilibrio, hilosAuto, mediaMovil, repartir, tocaRebalancear,
  PERIODO_REBALANCEO_TICKS, UMBRAL_DESEQUILIBRIO, VENTANAS_DESEQUILIBRADAS, type MedidaReparto,
} from '../src/world/motor/rebalanceo.js';
import { mortonCode } from '../src/world/soa/morton.js';

/** Cuadrícula `lado × lado` de chunks con coste dado por `coste(px, py)`; `dueno` y `hiloMs` salen del reparto vigente. */
function malla(lado: number, hilos: number, coste: (px: number, py: number) => number, dueno?: Int16Array, hiloMs?: number[]): MedidaReparto {
  const n = lado * lado;
  const m: MedidaReparto = {
    chunks: new Int32Array(n), px: new Int32Array(n), py: new Int32Array(n),
    costeMs: new Float64Array(n), dueno: dueno ?? new Int16Array(n).fill(-1), hiloMs: Float64Array.from(hiloMs ?? new Array(hilos).fill(0)),
  };
  for (let i = 0; i < n; i++) {
    // Posiciones negativas incluidas: la malla se desplaza para cruzar el origen.
    m.chunks[i] = 1000 + i; m.px[i] = (i % lado) - (lado >> 1); m.py[i] = Math.floor(i / lado) - (lado >> 1);
    m.costeMs[i] = coste(m.px[i]!, m.py[i]!);
  }
  return m;
}
const ordenMorton = (m: MedidaReparto): number[] =>
  [...m.chunks.keys()].sort((a, b) => {
    const ca = mortonCode(m.px[a]!, m.py[a]!), cb = mortonCode(m.px[b]!, m.py[b]!);
    return ca < cb ? -1 : ca > cb ? 1 : 0;
  });
const costePorHilo = (m: MedidaReparto, dueno: Int16Array, hilos: number): number[] => {
  const c = new Array<number>(hilos).fill(0);
  for (let i = 0; i < dueno.length; i++) c[dueno[i]!]! += m.costeMs[i]!;
  return c;
};

test('desequilibrio: 1 si es perfecto, máximo sobre media si no, 1 sin medidas', () => {
  const base = malla(2, 4, () => 1);
  assert.equal(desequilibrio({ ...base, hiloMs: Float64Array.from([5, 5, 5, 5]) }), 1);
  assert.equal(desequilibrio({ ...base, hiloMs: Float64Array.from([8, 4, 4, 4]) }), 8 / 5);
  assert.equal(desequilibrio({ ...base, hiloMs: new Float64Array(4) }), 1);
  assert.equal(desequilibrio({ ...base, hiloMs: new Float64Array(0) }), 1);
});

test('repartir: tramos contiguos en Morton y todo chunk con dueño válido', () => {
  const hilos = 5, m = malla(8, hilos, (x, y) => 1 + ((x * 7 + y * 3) & 3));
  const dueno = repartir(m, hilos);
  assert.equal(dueno.length, m.chunks.length);
  assert.ok(dueno.every(d => d >= 0 && d < hilos));
  const secuencia = ordenMorton(m).map(i => dueno[i]!);
  for (let k = 1; k < secuencia.length; k++) assert.ok(secuencia[k]! >= secuencia[k - 1]!, 'dueños no decrecen en Morton');
  assert.deepEqual([...new Set(secuencia)], [0, 1, 2, 3, 4], 'ningún hilo se queda sin tramo');
});

test('repartir: el coste por hilo queda parecido con costes desiguales', () => {
  const hilos = 4, m = malla(16, hilos, (x, y) => (x < 0 && y < 0 ? 10 : 1));
  const por = costePorHilo(m, repartir(m, hilos), hilos);
  const media = por.reduce((a, b) => a + b, 0) / hilos;
  for (const c of por) assert.ok(Math.abs(c - media) <= 0.2 * media, `coste ${c} lejos de ${media}`);
});

test('repartir: un chunk nuevo (coste 0) cuenta con el coste medio y sigue teniendo dueño', () => {
  const hilos = 3, m = malla(4, hilos, () => 6);
  m.costeMs[0] = 0; m.costeMs[5] = 0;
  const dueno = repartir(m, hilos);
  assert.ok(dueno.every(d => d >= 0 && d < hilos));
  const por = costePorHilo({ ...m, costeMs: m.costeMs.map(c => c || 6) }, dueno, hilos);
  assert.ok(Math.max(...por) - Math.min(...por) <= 12);
});

test('repartir: un hilo retrasado por la máquina recibe menos coste', () => {
  const hilos = 4, m0 = malla(16, hilos, () => 1);
  const parejo = repartir(m0, hilos);
  const base = costePorHilo(m0, parejo, hilos);
  // Con el reparto parejo vigente, el hilo 2 tarda el doble de pared que el coste que se le asignó.
  const m1 = malla(16, hilos, () => 1, parejo, base.map((c, h) => (h === 2 ? 2 * c : c)));
  const nuevo = costePorHilo(m1, repartir(m1, hilos), hilos);
  assert.ok(nuevo[2]! < base[2]! * 0.75, `hilo retrasado: ${nuevo[2]} vs ${base[2]}`);
  for (const h of [0, 1, 3]) assert.ok(nuevo[h]! > base[h]!, `hilo ${h} debe absorber lo que pierde el retrasado`);
  assert.equal(nuevo.reduce((a, b) => a + b, 0), base.reduce((a, b) => a + b, 0), 'ningún chunk se pierde');
});

test('repartir: estable, no cambia el reparto si el desequilibrio ya es ≤ umbral', () => {
  const hilos = 4, m0 = malla(8, hilos, () => 1);
  const parejo = repartir(m0, hilos);
  // Reparto vigente algo desigual a propósito (1,2 de desequilibrio) pero contiguo: se respeta.
  const vigente = Int16Array.from(parejo);
  const hiloMs = [12, 10, 9, 9];
  const m = malla(8, hilos, () => 1, vigente, hiloMs);
  assert.ok(desequilibrio(m) <= UMBRAL_DESEQUILIBRIO);
  assert.deepEqual([...repartir(m, hilos)], [...vigente]);
  // Y por encima del umbral sí se rehace.
  const peor = malla(8, hilos, () => 1, vigente, [30, 4, 3, 3]);
  assert.ok(desequilibrio(peor) > UMBRAL_DESEQUILIBRIO);
  assert.notDeepEqual([...repartir(peor, hilos)], [...vigente]);
});

test('repartir: un reparto vigente incompleto o partido no se conserva aunque el desequilibrio sea bajo', () => {
  const hilos = 3, m0 = malla(6, hilos, () => 1);
  const parejo = repartir(m0, hilos);
  const orden = ordenMorton(m0);
  const hiloMs = [10, 10, 10];
  const conNuevo = Int16Array.from(parejo); conNuevo[orden[0]!] = -1;
  assert.ok(repartir(malla(6, hilos, () => 1, conNuevo, hiloMs), hilos).every(d => d >= 0 && d < hilos));
  const partido = Int16Array.from(parejo); partido[orden[1]!] = 2; // 0, 2, 0 …: el hilo 0 tendría dos tramos
  const rehecho = repartir(malla(6, hilos, () => 1, partido, hiloMs), hilos);
  const sec = orden.map(i => rehecho[i]!);
  for (let k = 1; k < sec.length; k++) assert.ok(sec[k]! >= sec[k - 1]!);
});

test('repartir: cambia el número de hilos, vacío, un hilo y menos chunks que hilos', () => {
  const m = malla(4, 4, () => 2, new Int16Array(16).fill(3), [0, 0, 0, 100]);
  assert.ok(repartir(m, 2).every(d => d === 0 || d === 1));
  assert.equal(repartir(malla(4, 1, () => 1), 1).every(d => d === 0), true);
  const vacio: MedidaReparto = { chunks: new Int32Array(0), px: new Int32Array(0), py: new Int32Array(0), costeMs: new Float64Array(0), dueno: new Int16Array(0), hiloMs: new Float64Array(8) };
  assert.equal(repartir(vacio, 8).length, 0);
  const pocos = repartir(malla(2, 8, () => 1), 8);
  assert.equal(pocos.length, 4);
  assert.ok(pocos.every(d => d >= 0 && d < 8));
  assert.throws(() => repartir(vacio, 0), RangeError);
});

test('repartir: determinista y no toca la medida', () => {
  const m = malla(8, 3, (x, y) => 1 + Math.abs(x) + Math.abs(y));
  const antes = JSON.stringify([...m.costeMs]);
  assert.deepEqual([...repartir(m, 3)], [...repartir(m, 3)]);
  assert.equal(JSON.stringify([...m.costeMs]), antes);
});

test('tocaRebalancear: cada 240 ticks o tras 3 ventanas por encima del umbral', () => {
  assert.equal(tocaRebalancear(0, []), false);
  assert.equal(tocaRebalancear(PERIODO_REBALANCEO_TICKS, []), true);
  assert.equal(tocaRebalancear(PERIODO_REBALANCEO_TICKS * 3, [1]), true);
  assert.equal(tocaRebalancear(61, [1.1, 1.0]), false);
  assert.equal(tocaRebalancear(61, [2, 2]), false, 'dos ventanas no bastan');
  assert.equal(tocaRebalancear(61, [2, 2, 2]), true);
  assert.equal(tocaRebalancear(61, [1, 1.4, 1.5, 1.31]), true, 'cuentan las tres últimas');
  assert.equal(tocaRebalancear(61, [1.4, 1.5, 1.2]), false);
  assert.equal(tocaRebalancear(61, [UMBRAL_DESEQUILIBRIO, UMBRAL_DESEQUILIBRIO, UMBRAL_DESEQUILIBRIO]), false, 'en el umbral exacto no');
  assert.equal(VENTANAS_DESEQUILIBRADAS, 3);
});

test('hilosAuto: el mejor Hz entre T y ¾T; en empate, el menor; sin medidas, el máximo', () => {
  assert.equal(hilosAuto(new Map([[28, 40], [21, 55]]), 28), 21);
  assert.equal(hilosAuto(new Map([[28, 60], [21, 45]]), 28), 28);
  assert.equal(hilosAuto(new Map([[28, 50], [21, 49.5]]), 28), 21, 'empate técnico: deja CPU a la torre');
  assert.equal(hilosAuto(new Map(), 12), 12);
  assert.equal(hilosAuto(new Map([[8, NaN], [6, 0]]), 8), 8);
  assert.equal(hilosAuto(new Map([[40, 99], [16, 50]]), 16), 16, 'ignora lo que pasa del máximo');
  assert.deepEqual(candidatosAuto(28), [28, 21]);
  assert.deepEqual(candidatosAuto(1), [1]);
  assert.deepEqual(candidatosAuto(2), [2, 1]);
});

test('mediaMovil: arranca en la muestra y converge', () => {
  assert.equal(mediaMovil(0, 5), 5);
  assert.equal(mediaMovil(NaN, 5), 5);
  assert.equal(mediaMovil(4, NaN), 4 + 0.25 * (0 - 4));
  let v = 0;
  for (let i = 0; i < 60; i++) v = mediaMovil(v, 10);
  assert.ok(Math.abs(v - 10) < 1e-6);
});
