/** V23 · vfichas — panel «Materia»: lectura de cantidades grandes, reparto, luz del libro, ciclo y firma. */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { MateriaMundoVisible } from '../src/shared/vistas-v23.js';
import { anotarCiclo, cantidadCompacta, cicloVacio, compartimentoQueSeMueve, energiaTotal, firmaMateria, leerEntero, leerMateria, luzMateria, proporcion, renderPanelMateria, repartoPorElemento } from '../src/client/panel-materia.js';

const base = (): MateriaMundoVisible => ({
  tick: 4800, compartimentos: ['roca', 'agua', 'vida'],
  atomos: [['0', '0', '0', '100', '0', '50', '0', '0'], ['200', '0', '0', '100', '0', '0', '0', '0'], ['0', '10', '0', '0', '0', '0', '0', '0']],
  energia: ['-5', '9007199254740993', '12'], cuentas: { sol: '1000', respiracion: '-3' },
  sustancias: [{ id: 7, masa: 3.5, desde: 100 }], conserva: true,
});

test('enteros decimales: bigint y texto inválido', () => {
  assert.equal(leerEntero('9007199254740993'), 9007199254740993n);
  assert.equal(leerEntero('1.5'), null); assert.equal(leerEntero(5), null);
  assert.equal(cantidadCompacta(999n), '999'); assert.equal(cantidadCompacta(-1234567n), '−1,23·10⁶');
  assert.equal(proporcion(1n, 4n), .25); assert.equal(proporcion(1n, 0n), 0);
});

test('lectura: forma incoherente se rechaza', () => {
  assert.ok(leerMateria(base()));
  assert.equal(leerMateria(undefined), null);
  assert.equal(leerMateria({ ...base(), atomos: [['1']] }), null);
  const mala = base(); mala.atomos[0]![0] = 'x'; assert.equal(leerMateria(mala), null);
  const sinEnergia = leerMateria({ ...base(), energia: [] })!; assert.equal(energiaTotal(sinEnergia).completa, false);
});

test('reparto por elemento suma 1 y la energía total usa bigint', () => {
  const v = leerMateria(base())!;
  const r = repartoPorElemento(v);
  assert.equal(r.length, 8);
  assert.equal(r[3]!.reduce((a, b) => a + b, 0), 1); assert.equal(r[3]![0], .5);
  assert.equal(r[2]!.reduce((a, b) => a + b, 0), 0);
  assert.equal(energiaTotal(v).total, 9007199254740993n - 5n + 12n);
});

test('luz del libro', () => {
  assert.equal(luzMateria(null).estado, 'sin-dato');
  assert.equal(luzMateria(leerMateria(base()))!.estado, 'sano');
  assert.equal(luzMateria(leerMateria({ ...base(), conserva: false })).estado, 'grave');
});

test('ciclo: muestras por tick, reinicio al cambiar compartimentos y serie del que se mueve', () => {
  const c = cicloVacio(), v = leerMateria(base())!;
  anotarCiclo(c, v); anotarCiclo(c, v); assert.equal(c.ticks.length, 1);
  const otro = base(); otro.tick = 5000; otro.atomos[0]![3] = '300'; anotarCiclo(c, leerMateria(otro)!);
  assert.equal(c.ticks.length, 2);
  const m = compartimentoQueSeMueve(c, 3)!;
  assert.ok(m.rango > 0); assert.equal(m.serie.length, 2);
  anotarCiclo(c, leerMateria({ ...otro, tick: 5100, compartimentos: ['a', 'b', 'c'] })!); assert.equal(c.ticks.length, 1);
  const largo = cicloVacio(); for (let i = 0; i < 10; i++) anotarCiclo(largo, leerMateria({ ...base(), tick: i })!, 4); assert.equal(largo.ticks.length, 4);
});

test('render y firma: sin dato, completo y estable ante tick', () => {
  assert.match(renderPanelMateria(null), /sin la ley de materia/);
  const v = leerMateria(base())!, c = cicloVacio();
  const html = renderPanelMateria(v, c, undefined, 4800);
  assert.match(html, /data-materia-reparto/); assert.match(html, /sustancia nº 7/); assert.match(html, /data-cuenta="sol"/); assert.match(html, /aún hay 0/);
  const v2 = leerMateria({ ...base(), tick: 4801 })!;
  assert.equal(firmaMateria(v, c), firmaMateria(v2, c));
  assert.notEqual(firmaMateria(v, c), firmaMateria(leerMateria({ ...base(), conserva: false })!, c));
  assert.equal(firmaMateria(null, c), 'sin-materia');
});
