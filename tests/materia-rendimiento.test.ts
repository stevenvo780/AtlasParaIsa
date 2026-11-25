/**
 * W1c: los arreglos de rendimiento del paso material no cambian ningún resultado. La identidad completa (libro, vistas y
 * lotes de cada paso de un mundo de 64 × 64) la mide el banco (`scripts/banco-mundo-material.mts huella` y `comparar`);
 * aquí van las piezas de las que depende: las ramas de argumento pequeño de expm1/log1p son las de V8 bit a bit, y la
 * arena sin Map conserva el orden de ranuras de antes (un par que llega a 0 sale y corre los siguientes; uno nuevo va al
 * final), del que dependen el orden de los sorteos del intercambio con el aire y la huella de los lotes.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { expm1, log1p } from '../src/world/materia/paso.js';
import { Parte } from '../src/world/materia/tipos.js';
import { materiaReal } from './lib/materia-real.js';

function azar(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => { a = (Math.imul(a, 1103515245) + 12345) >>> 0; return a / 2 ** 32; };
}

test('expm1 y log1p de paso.ts dan lo mismo que Math.expm1 y Math.log1p, bit a bit', () => {
  const u = azar(7);
  let n = 0;
  for (let e = -1074; e <= 3; e++) for (let r = 0; r < 200; r++) for (const signo of [1, -1]) {
    const x = signo * (1 + u() + u() * 2 ** -32) * 2 ** e;
    n++;
    assert.ok(Object.is(expm1(x), Math.expm1(x)), `expm1(${x})`);
    if (x > -1) assert.ok(Object.is(log1p(x), Math.log1p(x)), `log1p(${x})`);
  }
  for (const x of [0, -0, 2 ** -54, -(2 ** -54), 2 ** -29, -(2 ** -29), 2 ** -54 * (1 - 2 ** -53), 2 ** -29 * (1 - 2 ** -53),
    Number.MIN_VALUE, -Number.MIN_VALUE, -40, -1e300, 1e-300]) {
    assert.ok(Object.is(expm1(x), Math.expm1(x)), `expm1(${x})`);
    assert.ok(Object.is(log1p(x), Math.log1p(x)), `log1p(${x})`);
  }
  assert.ok(n > 400_000);
});

test('la arena conserva el orden de las ranuras: lo que llega a 0 sale y lo nuevo va al final', async () => {
  const mr = materiaReal();
  try {
    const { arena, S, libro } = mr;
    const orden = (l: number) => { const ids = new Uint32Array(32); return Array.from(ids.subarray(0, arena.especies(l, ids))); };
    // Más de 8 sustancias: las últimas van al desborde.
    const a = mr.lote({ H2O: 10, O2: 5, N2: 7, CO2: 3, NH3: 2, CH4: 4, H2: 6, SiO2: 9, CaCO3: 8, H3PO4: 1 }, 300);
    const b = mr.lote({ H2O: 1 }, 300);
    const antes = orden(a);
    assert.equal(antes.length, 10);
    // Sacar todo el CO₂ (en una ranura) corre las siguientes, también las del desborde.
    assert.equal(arena.moverParte(a, b, { parte: Parte.Exacta, esp: S.CO2, cuantos: 3, kappa: null }), 3);
    assert.deepEqual(orden(a), antes.filter((id) => id !== S.CO2));
    // Devolverlo lo pone al final; en b, el CO₂ quedó tras su H₂O.
    assert.deepEqual(orden(b), [S.H2O, S.CO2]);
    arena.mover({ de: b, a, esp: S.CO2, cuantos: 3 });
    assert.deepEqual(orden(a), [...antes.filter((id) => id !== S.CO2), S.CO2]);
    assert.deepEqual(orden(b), [S.H2O]);
    // Un sumidero que pide más de lo que hay se recorta a lo que hay y quita lo que no está, en el orden pedido.
    const salida = arena.sumidero(a, Float64Array.of(S.NH3, 5, S.H2, 2, S.C2H6, 4, 0, 1), libro);
    assert.deepEqual(Array.from(salida), [S.NH3, 2, S.H2, 2, 0, 1]);
    assert.deepEqual(orden(a), [...antes.filter((id) => id !== S.CO2 && id !== S.NH3), S.CO2]);
    assert.equal(arena.cuantos(a, S.H2), 4);
    assert.equal(arena.cuantos(a, 0), 0);
    const saldo = arena.saldo(), esperado = mr.esperado();
    assert.deepEqual(saldo, esperado);
  } finally {
    await mr.cerrar();
  }
});
