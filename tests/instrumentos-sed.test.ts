import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld, TICKS_PER_DAY } from '../src/world/index.js';
import { parseParams } from '../src/world/params.js';
import {
  aguaCercana, fichaMuerteSed, InstrumentosConducta, SED_UMBRAL_AGUA,
  type PuntoRastro, type PuntosAgua, type UltimoSed,
} from '../scripts/lab/instrumentos.js';

/**
 * Diagnóstico sequía (2026-09-28): búsqueda de agua cercana, ficha de muerte por
 * deshidratación e integración con un mundo real (claves sed* + agregados por región).
 */

const pt = (x: number, y: number, fuente: 'tesela' | 'cisterna' = 'tesela') => ({ x, y, fuente });
const mapa = (pts: { x: number; y: number; fuente: 'tesela' | 'cisterna' }[]): PuntosAgua =>
  new Map(pts.map(p => [`${p.x},${p.y}`, p]));

test('aguaCercana encuentra la más próxima y marca cisternas', () => {
  const m = mapa([pt(10, 0), pt(3, 4, 'cisterna'), pt(0, 2)]);
  const mejor = aguaCercana(m, 0, 0);
  assert.deepEqual(mejor, { dist: 2, x: 0, y: 2, fuente: 'tesela' });
  const solo = aguaCercana(mapa([pt(3, 4, 'cisterna')]), 0, 0);
  assert.deepEqual(solo, { dist: 5, x: 3, y: 4, fuente: 'cisterna' });
});

test('aguaCercana devuelve null más allá del radio y empata determinista', () => {
  assert.equal(aguaCercana(mapa([pt(200, 0)]), 0, 0), null);
  // Empate a distancia 1: el orden de anillos visita (0,1) antes que (1,0).
  assert.deepEqual(aguaCercana(mapa([pt(1, 0), pt(0, 1)]), 0, 0), { dist: 1, x: 0, y: 1, fuente: 'tesela' });
});

const rastroBase: PuntoRastro[] = [
  { t: 100, x: 5, y: 5, accion: 'explore', sed: 0.5 },
  { t: 150, x: 7, y: 5, accion: 'drink', sed: 0.9 },
];
const ultimoBase: UltimoSed = { motivo: 'La sed persiste', sed: 0.9, llevada: 0, contenedores: 0, memoria: { x: 1, y: 1 } };

test('fichaMuerteSed mapea la ficha y los tres estados de memoria', () => {
  const base = {
    record: { id: 'm1', diedAt: 4800, bornAt: 0 },
    rastro: rastroBase, ultimo: ultimoBase,
    aguaActiva: mapa([pt(7, 6)]), aguaInactiva: mapa([pt(100, 100)]),
  };
  const conAgua = fichaMuerteSed({ ...base, aguaEn: () => 0.5 });
  assert.equal(conAgua.x, 7); assert.equal(conAgua.accion, 'drink');
  assert.equal(conAgua.edadDias, 4800 / TICKS_PER_DAY);
  assert.equal(conAgua.memoriaEstado, 'conAgua');
  assert.deepEqual(conAgua.cercaActiva, { dist: 1, x: 7, y: 6, fuente: 'tesela' });
  assert.equal(conAgua.region, '0,0');
  assert.equal(fichaMuerteSed({ ...base, aguaEn: () => SED_UMBRAL_AGUA }).memoriaEstado, 'seca');
  assert.equal(fichaMuerteSed({ ...base, aguaEn: () => null }).memoriaEstado, 'fueraDeVista');
  const sinMemoria = fichaMuerteSed({ ...base, ultimo: { ...ultimoBase, memoria: null }, aguaEn: () => 0.5 });
  assert.equal(sinMemoria.memoriaEstado, null);
  assert.equal(sinMemoria.memoriaDist, null);
});

test('fichaMuerteSed falla sin rastro', () => {
  assert.throws(() => fichaMuerteSed({
    record: { id: 'm2', diedAt: 4800, bornAt: 0 }, rastro: [], ultimo: ultimoBase,
    aguaActiva: new Map(), aguaInactiva: new Map(), aguaEn: () => null,
  }), /sin rastro previo/);
});

test('integración: sedRegiones cuadra con el mundo y sedMuertes/sedFuentes existen', () => {
  const world = createWorld(7, parseParams('persistencia.cadaTicks=300'));
  const inst = new InstrumentosConducta(world);
  for (let i = 0; i < 120; i++) { inst.antesDelPaso(world); stepWorld(world); inst.despuesDelPaso(world); }
  const m = inst.metricasDia(world);
  assert.ok(Array.isArray(m.sedMuertes));
  assert.deepEqual(Object.keys(m.sedFuentes).every(k => /^-?\d+,-?\d+$/.test(k)), true);
  const aguaTeselas = world.tiles.reduce((s, t) => s + ((t.drinkingWater ?? 0) > 0 ? (t.drinkingWater ?? 0) : 0), 0);
  assert.ok(Math.abs(m.sedRegiones.aguaTeselas - aguaTeselas) < 1e-9);
  const fuentes = world.tiles.filter(t => (t.drinkingWater ?? 0) > 0).length;
  assert.equal(m.sedRegiones.regiones.reduce((s, r) => s + r.fuentes, 0), fuentes);
  assert.equal(m.sedRegiones.regiones.reduce((s, r) => s + r.poblacion, 0), world.people.length);
  assert.ok(m.sedRegiones.lluviaTicks >= 0 && m.sedRegiones.lluviaTicks <= 120);
});
