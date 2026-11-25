/**
 * Fugas del mundo material en sombra (carril W, etapa 1): caminos por los que un elemento o la energía podrían crearse
 * o perderse sin declararlo (el día, la noche y la lluvia, los lotes que se vacían, el fuego, el reparto entre hilos con
 * páginas vecinas) y que el detector de conservación de verdad detecta una fuga.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NE } from '../src/shared/naturaleza.js';
import type { Tile } from '../src/shared/types.js';
import { createWorld } from '../src/world/mundo/crear.js';
import { activate } from '../src/world/spatial.js';
import { crearServicioQuimico } from '../src/world/materia/servicio.js';
import { MundoMaterial, totalesVacios, type Forzamiento } from '../src/world/materia/mundo.js';
import { unidadesVacias, vistaVacia } from '../src/world/materia/vistas.js';

const CLIMA: Forzamiento[] = [{ dt: 20, luz: 1, lluvia: false }, { dt: 20, luz: 0.4, lluvia: true }, { dt: 20, luz: 0, lluvia: false }];

function teselas(semilla: number, lado: number): Tile[] {
  const w = createWorld(semilla);
  for (let cy = 0; cy < lado / 16; cy++) for (let cx = 0; cx < lado / 16; cx++) activate(w, cx * 16, cy * 16);
  return w.tiles.filter((t) => t.x >= 0 && t.y >= 0 && t.x < lado && t.y < lado);
}

function levantar(semilla: number, lado: number, hilos = 1) {
  const q = crearServicioQuimico({ modo: 'inmediato' });
  const m = MundoMaterial.levantar(teselas(semilla, lado), q, { semilla, hilos });
  const tot = totalesVacios();
  m.plegar(tot);
  // Los demás hilos se emulan uno tras otro: cada uno ve su propia química cargada del registro, como un worker.
  const otros = Array.from({ length: hilos - 1 }, (_, h) => MundoMaterial.conectar(m.d, h + 1));
  return {
    q, m, tot, mundos: [m, ...otros],
    cuadra: () => m.saldo().every((x, k) => x === tot.esperado[k]),
    paso(f: Forzamiento) { m.prepararPaso(); for (const x of this.mundos) x.pasar(f); m.plegar(tot); },
  };
}

const sumaVistas = (m: MundoMaterial): number[] => {
  const v = vistaVacia(), s = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < m.n; i++) { m.vista(i, v); [v.drinkingWater, v.moisture, v.vegetation, v.food, v.wood, v.stone].forEach((x, k) => { s[k]! += x; }); }
  return s;
};

test('el libro cuadra en cada paso con el día, la noche y la lluvia alternándose (la radiación entra y sale)', async () => {
  const x = levantar(3, 16), s0 = x.m.saldo();
  for (let k = 0; k < 36; k++) { x.paso(CLIMA[k % 3]!); assert.ok(x.cuadra(), `paso ${k} (luz ${CLIMA[k % 3]!.luz})`); }
  const s1 = x.m.saldo();
  for (let e = 0; e < NE; e++) assert.equal(s1[e], s0[e], `átomos del elemento ${e}`);
  assert.ok(x.tot.cuentas.every((c) => c >= 0n));
  await x.q.cerrar();
});

test('con páginas vecinas repartidas entre hilos el libro cuadra y el resultado es el de un hilo', async () => {
  const uno = levantar(5, 32, 1), tres = levantar(5, 32, 3);
  assert.equal(tres.m.np, 4);
  for (let k = 0; k < 24; k++) {
    uno.paso(CLIMA[k % 3]!); tres.paso(CLIMA[k % 3]!);
    assert.ok(tres.cuadra(), `3 hilos, paso ${k}`);
  }
  assert.deepEqual(sumaVistas(tres.m), sumaVistas(uno.m));
  assert.deepEqual(tres.m.saldo(), uno.m.saldo());
  await uno.q.cerrar(); await tres.q.cerrar();
});

test('un lote que se vacía (todo comido y bebido) sigue siendo un lote válido y el libro cuadra', async () => {
  const x = levantar(7, 16), v = vistaVacia();
  for (let i = 0; i < x.m.n; i++) { for (const o of ['hoja', 'fruto', 'tronco'] as const) x.m.extraer(i, o, 1e9); x.m.beber(i, 1e12); }
  x.m.plegar(x.tot);
  assert.ok(x.cuadra());
  for (let k = 0; k < 12; k++) { x.paso(CLIMA[k % 3]!); assert.ok(x.cuadra(), `paso ${k}`); }
  for (let i = 0; i < x.m.n; i++) {
    x.m.vista(i, v);
    for (const c of Object.values(v)) assert.ok(Number.isFinite(c) && c >= 0);
    assert.equal(v.vegetation, 0);
    assert.equal(v.food, 0);
  }
  await x.q.cerrar();
});

test('quemar con fracciones extremas (0, 1, > 1) no crea ni pierde nada', async () => {
  const x = levantar(8, 16), u = unidadesVacias();
  for (const fr of [0, 1, 0.3, 1, 5]) {
    for (let i = 0; i < 12; i++) x.m.quemar(i, fr);
    x.m.plegar(x.tot);
    assert.ok(x.cuadra(), `fracción ${fr}`);
  }
  for (let i = 0; i < 12; i++) assert.deepEqual({ ...x.m.unidades(i, u) }, { hoja: 0, fruto: 0, tronco: 0 });
  for (let k = 0; k < 6; k++) { x.paso(CLIMA[k % 3]!); assert.ok(x.cuadra(), `paso ${k}`); }
  await x.q.cerrar();
});

test('el detector de conservación detecta una fuga: sacar materia o energía sin declararla rompe el libro', async () => {
  const fantasma = () => ({ fuentes: new Float64Array(NE + 1), sumideros: new Float64Array(NE + 1), enVuelo: new Float64Array(NE + 1) });
  const x = levantar(3, 16);
  let i = 0;
  while (x.m.unidades(i, unidadesVacias()).fruto < 10) i++;
  assert.ok(x.cuadra());
  x.m.arena.sumidero(x.m.vida[i]!, Float64Array.of(x.m.S.CH2, 1, 0, 0), fantasma());
  assert.ok(!x.cuadra(), 'un cuanto de CH₂ perdido');
  x.m.arena.fuente(x.m.vida[i]!, Float64Array.of(x.m.S.CH2, 1, 0, 0), fantasma());
  assert.ok(x.cuadra());
  x.m.arena.fuente(x.m.suelo[i]!, Float64Array.of(0, 1), fantasma());
  assert.ok(!x.cuadra(), 'un julio de más');
  await x.q.cerrar();
});

test('sin que nadie beba, las charcas conservan buena parte de su agua (el aire no la guarda toda)', async () => {
  const x = levantar(1, 32), v = vistaVacia();
  const charcas = Array.from({ length: x.m.n }, (_, i) => i).filter((i) => x.m.agua[i]! >= 0 && x.m.vista(i, v).drinkingWater > 0.15);
  assert.ok(charcas.length >= 3, 'la página de prueba tiene charcas');
  const media = () => charcas.reduce((a, i) => a + x.m.vista(i, v).drinkingWater, 0) / charcas.length;
  const agua0 = media(), fase = [1, 0.4, 0, 0, 0.4, 1];
  for (let t = 0; t < 2400; t += 20) x.paso({ dt: 20, luz: fase[Math.floor(t / 400) % 6]!, lluvia: Math.floor(t / 600) % 5 === 0 });
  assert.ok(x.cuadra());
  assert.ok(media() > 0.4 * agua0, `queda ${(100 * media() / agua0).toFixed(0)} % del agua de las charcas`);
  await x.q.cerrar();
});
