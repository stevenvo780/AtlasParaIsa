/**
 * Mundo material en sombra (carril W, etapa 1): vistas exactas al levantar, conservación exacta con las fuentes y
 * sumideros declarados, reproducibilidad con semilla, actos (extraer, beber, quemar) y la descomposición de la Vida.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ELEMENTOS, NE } from '../src/shared/naturaleza.js';
import type { Tile } from '../src/shared/types.js';
import { createWorld } from '../src/world/mundo/crear.js';
import { crearServicioQuimico } from '../src/world/materia/servicio.js';
import { CUENTA, MundoMaterial, totalesVacios, type Forzamiento } from '../src/world/materia/mundo.js';
import { unidadesVacias, unidadesVida, vistaVacia, type Organos } from '../src/world/materia/vistas.js';

const pagina = (semilla: number): Tile[] => createWorld(semilla).tiles.filter((t) => t.x >= 0 && t.y >= 0 && t.x < 16 && t.y < 16);
const CLIMA: Forzamiento[] = [{ dt: 10, luz: 1, lluvia: false }, { dt: 10, luz: 0.4, lluvia: true }, { dt: 10, luz: 0, lluvia: false }];

function levantar(semilla = 7) {
  const tiles = pagina(semilla), q = crearServicioQuimico({ modo: 'inmediato' });
  const m = MundoMaterial.levantar(tiles, q, { semilla });
  const tot = totalesVacios();
  m.plegar(tot);
  return { tiles, q, m, tot, exacto: () => m.saldo().every((x, k) => x === tot.esperado[k]) };
}

function correr(m: MundoMaterial, tot: ReturnType<typeof totalesVacios>, pasos: number): void {
  for (let k = 0; k < pasos; k++) { m.prepararPaso(); m.pasar(CLIMA[k % CLIMA.length]!); m.plegar(tot); }
}

test('las vistas reproducen los escalares de la tesela al levantar (dentro de medio cuanto)', async () => {
  const { tiles, q, m, exacto } = levantar();
  const por = new Map(tiles.map((t) => [`${t.x},${t.y}`, t]));
  const e = m.params.escalas, v = vistaVacia();
  assert.equal(m.n, 256);
  for (let i = 0; i < m.n; i++) {
    m.vista(i, v);
    const t = por.get(`${m.x[i]},${m.y[i]}`)!;
    assert.ok(Math.abs(v.food - t.food) * e.alimento <= 0.5 + 1e-9, 'alimento');
    assert.ok(Math.abs(v.vegetation - t.vegetation) * e.vegetacion <= 0.5 + 1e-9, 'vegetación');
    assert.ok(Math.abs(v.moisture - t.moisture) * e.humedad <= 0.5 + 1e-9, 'humedad');
    assert.ok(Math.abs(v.drinkingWater - (t.drinkingWater ?? 0)) * e.agua <= 0.5 + 1e-9, 'agua');
    assert.ok(Math.abs(v.wood - (t.wood ?? 0)) * e.madera <= 0.5 + 1e-9, 'madera');
    assert.ok(Math.abs(v.stone - (t.stone ?? 0)) * e.piedra <= 0.5 + 1e-9, 'piedra');
  }
  assert.ok(exacto());
  await q.cerrar();
});

test('el libro cuadra exacto en cada paso y los átomos solo cambian por el agua declarada con el exterior', async () => {
  const { q, m, tot, exacto } = levantar();
  const s0 = m.saldo();
  for (let k = 0; k < 12; k++) { correr(m, tot, 1); assert.ok(exacto(), `paso ${k}`); }
  const s1 = m.saldo(), c = tot.cuentas, neto = c[CUENTA.CIELO_ENTRA]! - c[CUENTA.CIELO_SALE]! - c[CUENTA.DESAGUE]!;
  for (let e = 0; e < NE; e++) assert.equal(s1[e]! - s0[e]!, ELEMENTOS[e] === 'H' ? 2n * neto : ELEMENTOS[e] === 'O' ? neto : 0n, ELEMENTOS[e]);
  assert.notEqual(s1[NE], s0[NE], 'el sol y la radiación mueven energía');
  await q.cerrar();
});

test('con la misma semilla el mundo material es reproducible', async () => {
  const uno = levantar(), dos = levantar();
  correr(uno.m, uno.tot, 9); correr(dos.m, dos.tot, 9);
  assert.deepEqual(uno.m.saldo(), dos.m.saldo());
  const a = vistaVacia(), b = vistaVacia();
  for (let i = 0; i < uno.m.n; i++) assert.deepEqual(uno.m.vista(i, a), dos.m.vista(i, b));
  await uno.q.cerrar(); await dos.q.cerrar();
});

test('extraer y beber sacan unidades enteras por el sumidero declarado', async () => {
  const { q, m, tot, exacto } = levantar();
  const u = unidadesVacias(), v = vistaVacia();
  let i = 0;
  while (m.unidades(i, u).fruto < 10) i++;
  const antes = m.vista(i, v).food;
  assert.equal(m.extraer(i, 'fruto', 7), 7);
  assert.ok(Math.abs(antes - m.vista(i, v).food - 7 / m.params.escalas.alimento) < 1e-12);
  let j = 0;
  while (m.agua[j]! < 0) j++;
  const agua = m.vista(j, v).drinkingWater;
  assert.equal(m.beber(j, 1000), 1000);
  assert.ok(Math.abs(agua - m.vista(j, v).drinkingWater - 1000 / m.params.escalas.agua) < 1e-12);
  m.plegar(tot);
  assert.ok(exacto());
  await q.cerrar();
});

test('una tesela quemada pierde su vida, conserva la materia y rebrota', async () => {
  const { q, m, tot, exacto } = levantar();
  const u = unidadesVacias(), v = vistaVacia();
  let i = 0;
  while (m.unidades(i, u).hoja < 1500) i++;
  const antes = m.vista(i, v).vegetation;
  m.quemar(i, 0.9);
  m.plegar(tot);
  assert.ok(exacto());
  const quemada = m.vista(i, v).vegetation;
  assert.ok(quemada < 0.11 * antes + 1e-9);
  for (let k = 0; k < 60; k++) { m.prepararPaso(); m.pasar({ dt: 10, luz: 1, lluvia: false }); m.plegar(tot); }
  assert.ok(m.vista(i, v).vegetation > quemada, 'rebrota');
  assert.ok(exacto());
  await q.cerrar();
});

test('la Vida se descompone en sus órganos por composición', () => {
  const o: Organos = { marcas: [1, 2, 3], hoja: [20, 2, 2], fruto: [0, 4, 1], tronco: [1, 0, 0] };
  const cuenta = new Map<number, number>([[1, 20 * 7 + 13], [2, 2 * 7 + 4 * 5], [3, 2 * 7 + 5]]);
  assert.deepEqual(unidadesVida((_, id) => cuenta.get(id) ?? 0, 0, o, unidadesVacias()), { hoja: 7, fruto: 5, tronco: 13 });
});
