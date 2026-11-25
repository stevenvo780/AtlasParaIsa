import test from 'node:test';
import assert from 'node:assert/strict';
import { chi2, emparejar, gammaQ, ks, permutacion, qKolmogorov, signos, tCuantil } from './v23-decision-equivalencia.js';

const cerca = (a: number, b: number, tol: number, msg?: string) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} ≠ ${b} ± ${tol}`);

test('KS: dos muestras idénticas dan D = 0 y p = 1; dos muy distintas, p ≈ 0', () => {
  const a = Array.from({ length: 500 }, (_, i) => Math.sin(i) * 3);
  assert.deepEqual(ks(a, a), { d: 0, p: 1 });
  assert.deepEqual(ks(a, [...a].reverse()), { d: 0, p: 1 });
  const b = a.map(x => x + 2);
  assert.ok(ks(a, b).p < 1e-10);
});

test('la distribución de Kolmogorov da sus valores tabulados y es continua donde cambia de forma', () => {
  cerca(qKolmogorov(1.358), 0.05, 5e-4, 'α = 0,05');
  cerca(qKolmogorov(1.628), 0.01, 5e-4, 'α = 0,01');
  cerca(qKolmogorov(1), 0.2700, 5e-4);
  cerca(qKolmogorov(0.5), 0.9639, 5e-4);
  cerca(qKolmogorov(1.18 - 1e-9), qKolmogorov(1.18 + 1e-9), 1e-8, 'en 1,18');
  assert.equal(qKolmogorov(0), 1);
  for (let l = 0.05; l < 3; l += 0.05) assert.ok(qKolmogorov(l) >= qKolmogorov(l + 0.05), `decrece en ${l}`);
});

test('χ², t de Student y la prueba de signos dan sus valores conocidos', () => {
  cerca(gammaQ(0.5, 3.841 / 2), 0.05, 1e-4, 'χ²(1) = 3,841');
  cerca(gammaQ(2.5, 11.07 / 2), 0.05, 1e-4, 'χ²(5) = 11,07');
  cerca(tCuantil(0.975, 5), 2.5706, 1e-3);
  cerca(tCuantil(0.95, 30), 1.6973, 1e-3);
  const c = chi2({ a: 50, b: 50 }, { a: 50, b: 50 });
  assert.equal(c.chi2, 0); assert.equal(c.p, 1);
  // Con cuatro pares el p bilateral mínimo es 2/16, por mucho que se muevan todos en el mismo sentido.
  assert.equal(signos([1, 2, 3, 4]).p, 0.125);
  assert.equal(signos([0, 0, 0]).p, 1);
});

test('las permutaciones de réplica son fijas, la 0 es la identidad y cada una reordena todas las posiciones', () => {
  assert.deepEqual(permutacion(6, 7, 0), [0, 1, 2, 3, 4, 5]);
  for (const orden of [1, 2, 3]) {
    const p = permutacion(30, 51926, orden);
    assert.deepEqual([...p].sort((a, b) => a - b), Array.from({ length: 30 }, (_, i) => i));
    assert.deepEqual(p, permutacion(30, 51926, orden));
    assert.notDeepEqual(p, permutacion(30, 51926, orden + 1));
  }
});

test('el emparejado separa semilla, orden y motor y da las semillas que harían falta', () => {
  // Tres semillas × tres órdenes; el brazo B suma 0,1 en todas: diferencia constante, varianza entre semillas casi nula.
  const pares = [1, 2, 3].flatMap(s => [0, 1, 2].map(o => ({ semilla: s, a: s * 10 + o, b: s * 10 + o + 0.1 + 0.001 * ((s * 3 + o) % 2) })));
  const e = emparejar(pares, 0.05, 1);
  cerca(e.mediaD, 0.1, 1e-3);
  assert.ok(e.equivalente, `IC ${e.ic}`);
  cerca(e.sigmaOrden, 1, 1e-3, 'los órdenes de una semilla difieren en 1');
  assert.ok(e.sigmaInteraccion < 0.01);
  assert.ok(e.necesarias <= 3);
  // Con diferencias que cambian de signo según la semilla, el IC es ancho y hacen falta más semillas.
  const ruido = [1, 2, 3, 4].flatMap(s => [0, 1].map(o => ({ semilla: s, a: 0, b: (s % 2 ? 1 : -1) * 2 })));
  const r = emparejar(ruido, 0.05 / 8, 1);
  assert.ok(!r.equivalente && r.necesarias > 4, `${r.ic} ${r.necesarias}`);
});
