/**
 * Ciclo del agua y régimen de la biomasa del mundo material en sombra (carril W, etapa W1b), en pequeño: la lluvia
 * llena las charcas desde la atmósfera libre declarada, el agua que no cabe se va por el desagüe, el viento lleva vapor
 * entre páginas (también entre hilos), la humedad de referencia es la de la ley escalar, la calibración iguala los flujos
 * escalares que se pueden igualar, la vegetación no se dobla de día ni se hunde de noche y el suelo frío descompone más
 * despacio una masa marcada.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KAPPA_SUELO, KAPPA_SUELO_HH } from '../src/shared/naturaleza.js';
import type { Tile } from '../src/shared/types.js';
import { createWorld } from '../src/world/mundo/crear.js';
import { activate } from '../src/world/spatial.js';
import { DEFAULT_PARAMS } from '../src/world/params.js';
import { crearServicioQuimico } from '../src/world/materia/servicio.js';
import { pasoLote } from '../src/world/materia/paso.js';
import { Rol } from '../src/world/materia/tipos.js';
import {
  CUENTA, MundoMaterial, REFERENCIA, humedadMediaEscalar, intercambioBruto, totalesVacios, type Forzamiento,
} from '../src/world/materia/mundo.js';
import { vistaAireVacia, vistaVacia } from '../src/world/materia/vistas.js';

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
  const mundos = [m, ...Array.from({ length: hilos - 1 }, (_, h) => MundoMaterial.conectar(m.d, h + 1))];
  return {
    q, m, tot,
    cuadra: () => m.saldo().every((x, k) => x === tot.esperado[k]),
    paso(f: Forzamiento) { m.prepararPaso(); for (const x of mundos) x.pasarLocal(f); for (const x of mundos) x.recibir(); m.plegar(tot); },
  };
}

const charcas = (m: MundoMaterial) => {
  const v = vistaVacia(), is = Array.from({ length: m.n }, (_, i) => i).filter((i) => m.agua[i]! >= 0);
  return () => is.reduce((a, i) => a + m.vista(i, v).drinkingWater, 0) / is.length;
};

test('la humedad de referencia es la media que da la ley escalar con su tiempo', () => {
  assert.ok(REFERENCIA.humedad > 0.75 && REFERENCIA.humedad < 0.97, `humedad media ${REFERENCIA.humedad}`);
  assert.equal(humedadMediaEscalar(), REFERENCIA.humedad, 'determinista');
});

test('la calibración: el fruto rebrota a media capacidad lo que el escalar y la hoja pierde a capacidad lo que el escalar', async () => {
  const { q, m } = levantar(1, 16);
  const { caida } = m.params, K = REFERENCIA.capacidad;
  assert.ok(Math.abs(caida.hoja * 10 * K - 0.0001) < 1e-12, 'hojarasca a capacidad = pérdida escalar por paso');
  // Rebrote escalar del alimento a media capacidad con la humedad de referencia (ecology(), un día de su reloj).
  const pasosLuz = (1200 + 600 * 0.4) / 10, decae = DEFAULT_PARAMS.recursos.decaimientoComida * 240;
  const rebrote = pasosLuz * REFERENCIA.humedad * K * 0.006 * 0.5 - decae;
  assert.ok(Math.abs(caida.fruto * 2400 * K / 2 - rebrote) < 1e-9, 'fruto');
  await q.cerrar();
});

test('un día de lluvia llena las charcas desde la atmósfera libre; lo que no cabe se va por el desagüe; el libro cuadra', async () => {
  const x = levantar(1, 32), media = charcas(x.m), a0 = media();
  for (let t = 0; t < 2400; t += 20) { x.paso({ dt: 20, luz: t % 2400 < 1800 ? 1 : 0, lluvia: true }); assert.ok(x.cuadra(), `t=${t}`); }
  const c = x.tot.cuentas;
  assert.ok(c[CUENTA.CIELO_ENTRA]! > 0n, 'la lluvia viene de la atmósfera libre');
  assert.ok(c[CUENTA.DESAGUE]! > 0n, 'el agua que no cabe se va por el desagüe');
  assert.ok(media() > Math.max(0.9, a0), `charcas ${a0.toFixed(3)} → ${media().toFixed(3)}`);
  const aire = vistaAireVacia();
  for (let p = 0; p < x.m.np; p++) {
    x.m.vistaAire(p, x.m.temperatura(p, 0) - 4, aire);
    assert.ok(aire.lluvia > 0 && aire.humedadRelativa > 0.95 && aire.humedadRelativa <= 1.001, `página ${p}: ${JSON.stringify(aire)}`);
  }
  // Con tiempo seco la capa límite se seca hacia el punto de rocío de la noche: el agua vuelve a la atmósfera libre.
  const salida = c[CUENTA.CIELO_SALE]!;
  for (let t = 0; t < 2400; t += 20) x.paso({ dt: 20, luz: 1, lluvia: false });
  assert.ok(x.tot.cuentas[CUENTA.CIELO_SALE]! > salida, 'con sol y sin lluvia sale vapor a la atmósfera libre');
  assert.ok(media() < 1, 'las charcas bajan sin lluvia');
  assert.ok(x.cuadra());
  await x.q.cerrar();
});

test('el viento lleva vapor a las páginas vecinas, también entre hilos, y el resultado es el de un hilo', async () => {
  const uno = levantar(5, 32, 1), tres = levantar(5, 32, 3), H2O = uno.m.S.H2O, f = { dt: 20, luz: 1, lluvia: false };
  // Un 10 % más de vapor en la página 0 (por debajo de la saturación de día): manda a la 1 más de lo que recibe de ella.
  for (const x of [uno, tres]) {
    const n = Math.round(0.1 * x.m.arena.cuantos(x.m.aire[0]!, H2O));
    x.m.arena.fuente(x.m.aire[0]!, Float64Array.of(H2O, n, 0, Math.round(295 * 0.025 * 3 * n)), x.m.libro);
    x.m.plegar(x.tot);
  }
  assert.equal(uno.m.vecinas[4 * 0 + 1], 1, 'la página 1 está a la derecha de la 0');
  uno.m.prepararPaso(); uno.m.pasarLocal(f);
  const de0a1 = uno.m.transito[2 * (4 * 0 + 1)]!, de1a0 = uno.m.transito[2 * (4 * 1 + 0)]!;
  assert.ok(de0a1 > de1a0 && de1a0 > 0, `0→1 ${de0a1}, 1→0 ${de1a0}`);
  uno.m.recibir(); uno.m.plegar(uno.tot);
  assert.ok(uno.m.transito.every((x) => x === 0), 'todo lo que estaba en vuelo se abonó');
  assert.ok(uno.cuadra());
  tres.paso(f);
  for (let k = 0; k < 6; k++) {
    const g = { dt: 20, luz: k % 2, lluvia: k === 3 };
    uno.paso(g); tres.paso(g);
    assert.ok(tres.cuadra(), `3 hilos, paso ${k}`);
  }
  assert.deepEqual(tres.m.saldo(), uno.m.saldo());
  assert.deepEqual([0, 1, 2, 3].map((p) => tres.m.arena.cuantos(tres.m.aire[p]!, H2O)), [0, 1, 2, 3].map((p) => uno.m.arena.cuantos(uno.m.aire[p]!, H2O)));
  await uno.q.cerrar(); await tres.q.cerrar();
});

test('la vegetación no se dobla de día ni se hunde de noche (hojas que viven semanas)', async () => {
  const x = levantar(3, 16), v = vistaVacia();
  const veg = () => { let s = 0; for (let i = 0; i < x.m.n; i++) s += x.m.vista(i, v).vegetation; return s / x.m.n; };
  const v0 = veg(), serie: number[] = [];
  for (let t = 0; t < 2 * 2400; t += 60) {
    const h = t % 2400;
    x.paso({ dt: 60, luz: h < 300 || (h >= 1500 && h < 1800) ? 0.4 : h < 1500 ? 1 : 0, lluvia: Math.floor(t / 600) % 3 === 0 });
    serie.push(veg());
  }
  for (const s of serie) assert.ok(Math.abs(s / v0 - 1) < 0.1, `vegetación ${v0.toFixed(3)} → ${s.toFixed(3)}`);
  await x.q.cerrar();
});

test('el suelo frío descompone más despacio una masa marcada de hojarasca', async () => {
  const { q, m } = levantar(1, 16);
  const S = m.S, A = m.arena, c = m.ctx, kappa: [number, number, number, number] = [KAPPA_SUELO, KAPPA_SUELO, KAPPA_SUELO, KAPPA_SUELO_HH];
  const at = (id: number) => q.sustancia(id).atomos.reduce((s, n) => s + n, 0);
  const lote = (cont: [number, number][], T: number) => {
    const l = A.nuevo(Rol.Objeto, -1, 0), pares = cont.flat();
    pares.push(0, Math.round(T * 0.025 * cont.reduce((s, [id, n]) => s + n * at(id), 0)));
    A.fuente(l, Float64Array.from(pares), m.libro);
    return l;
  };
  const queda = (T: number) => {
    const suelo = lote([[S.SiO2, 1_000_000], [S.H2O, 150_000], [S.N2, 7800], [S.O2, 2100], [S.madera, 20_000], [S.CH2, 2000], [S.proteina, 2000]], T);
    const aire = lote([[S.N2, 7_800_000], [S.O2, 2_100_000], [S.CO2, 200_000]], T);
    const org = () => [S.madera, S.CH2, S.proteina].reduce((s, id) => s + A.cuantos(suelo, id), 0), o0 = org();
    for (let t = 0; t < 60; t++) {
      pasoLote(c, suelo, 1, kappa);
      for (const id of [S.O2, S.CO2, S.N2]) intercambioBruto(c, suelo, aire, id, 1, 10, 1000, 1);
      m.termostato(suelo, T); m.termostato(aire, T);
    }
    return org() / o0;
  };
  const templado = queda(291), frio = queda(271);
  assert.ok(templado < 0.95, `el suelo templado descompone (${templado.toFixed(3)})`);
  assert.ok(frio > templado, `frío ${frio.toFixed(3)} > templado ${templado.toFixed(3)}`);
  await q.cerrar();
});
