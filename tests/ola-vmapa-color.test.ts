import test from 'node:test';
import assert from 'node:assert/strict';
import { aPaleta, brilloTermico, colorCuerpoNegro, colorTermico, escarcha, rgbDeEntero, sustanciaDelPixel, umbralBayer, PUNTO_DRAPER_K, BRILLO_PLENO_K, FUSION_HIELO_K } from '../src/client/terrain-field.js';
import { firmaMat, mismaMat, PaletaSustancias } from '../src/client/tile-cache.js';
import { vetasDeComposicion, veinsAt, paintVetasComposicion, VETA_FRACCION_MINIMA } from '../src/client/road-geology-art.js';
import { colorDeDueno, capasDelMapa, capasV23Disponibles, activeLayersSummary, renderLayersPopoverHtml, isMapLayerId, MAP_LAYER_CATALOG } from '../src/client/layers-control.js';
import { intensidadLluvia, AtmosphereSmoother, LLUVIA_PLENA_MM_H } from '../src/client/visual-state.js';
import type { SustanciaVista } from '../src/shared/materia.js';
import type { Tile } from '../src/shared/types.js';

const sustancia = (id: number, color: number, densidad = 2): SustanciaVista => ({
  id, clase: 0 as unknown as SustanciaVista['clase'], atomos: [], enlaces: [], masa: 60,
  prop: { r: 0, dMedia: 0, tFusion: 0, tEbullicion: 0, qOxidacion: 0, dureza: 0, tenacidad: 0, flexibilidad: 0, polaridad: 0, densidad, color },
});
const tesela = (extra: Partial<Tile>): Tile => ({ x: 3, y: 4, terrain: 'soil', moisture: .3, vegetation: 0, food: 0, ...extra });

test('rgbDeEntero y aPaleta: 0xRRGGBB a canales y paleta finita', () => {
  assert.deepEqual(rgbDeEntero(0x12ab34), [0x12, 0xab, 0x34]);
  assert.deepEqual(rgbDeEntero(Number.NaN), [0, 0, 0]);
  for (const v of aPaleta([13, 130, 251])) assert.equal(v % 8, 0);
});

test('cuerpo negro: rojo apagado cerca de Draper, más blanco cuanto más caliente', () => {
  const rojo = colorCuerpoNegro(PUNTO_DRAPER_K), blanco = colorCuerpoNegro(6500);
  assert.equal(rojo[0], 255); assert.ok(rojo[1] < 80 && rojo[2] === 0);
  assert.ok(blanco[1] > 240 && blanco[2] > 240);
  assert.ok(colorCuerpoNegro(1500)[1] > rojo[1], 'el verde sube con T');
});

test('brillo térmico: 0 hasta Draper o sin dato, 1 en el brillo pleno; el color frío no cambia', () => {
  assert.equal(brilloTermico(undefined), 0);
  assert.equal(brilloTermico(300), 0);
  assert.equal(brilloTermico(PUNTO_DRAPER_K), 0);
  assert.equal(brilloTermico(BRILLO_PLENO_K), 1);
  const base: [number, number, number] = [80, 80, 80];
  assert.equal(colorTermico(base, 300), base);
  assert.notDeepEqual(colorTermico(base, 1200), base);
});

test('escarcha: solo bajo la fusión y con humedad', () => {
  assert.equal(escarcha(undefined, 1), 0);
  assert.equal(escarcha(FUSION_HIELO_K + 1, 1), 0);
  assert.equal(escarcha(FUSION_HIELO_K - 50, 0), 0);
  assert.equal(escarcha(FUSION_HIELO_K - 50, 1), 1);
});

test('tramado: cada sustancia ocupa su fracción de los píxeles de la tesela, sin mezclar colores', () => {
  assert.equal(sustanciaDelPixel([], 0, 0), -1);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { const u = umbralBayer(x, y); assert.ok(u > 0 && u < 1); }
  const cuenta = [0, 0, 0];
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) cuenta[sustanciaDelPixel([.6, .3, .1], x, y)]!++;
  const total = 64 * 64;
  assert.ok(Math.abs(cuenta[0]! / total - .6) < .05); assert.ok(Math.abs(cuenta[1]! / total - .3) < .05); assert.ok(Math.abs(cuenta[2]! / total - .1) < .05);
  assert.equal(sustanciaDelPixel([.2, .2], 5, 9), sustanciaDelPixel([.2, .2], 5, 9), 'determinista');
});

test('mismaMat compara por valor; firmaMat es 0 sin materia y cambia con lo que se ve', () => {
  assert.ok(mismaMat(undefined, undefined));
  assert.ok(mismaMat([[1, .5], [2, .5]], [[1, .5], [2, .5]]));
  assert.ok(!mismaMat([[1, .5]], [[1, .6]]));
  assert.ok(!mismaMat([[1, .5]], undefined));
  assert.equal(firmaMat(undefined, undefined, .5), 0);
  const a = firmaMat([[1, .5], [2, .5]], 290, .5);
  assert.notEqual(a, 0);
  assert.equal(firmaMat([[1, .501], [2, .499]], 290, .5), a, 'diferencias invisibles no rehornean');
  assert.notEqual(firmaMat([[1, .8], [2, .2]], 290, .5), a);
  assert.notEqual(firmaMat([[1, .5], [2, .5]], 1300, .5), a, 'al rojo rehornea');
  assert.notEqual(firmaMat([[1, .5]], undefined, .5, () => false), firmaMat([[1, .5]], undefined, .5, () => true), 'aprender el color rehornea');
});

test('PaletaSustancias: aprende colores, sube versión solo con lo nuevo y olvida al cambiar de mundo', () => {
  const p = new PaletaSustancias();
  const lista = [sustancia(7, 0xff0000, 2.6)];
  assert.ok(p.ingest(lista)); assert.equal(p.version, 1);
  assert.ok(!p.ingest(lista)); assert.ok(!p.ingest([sustancia(7, 0xff0000, 2.6)]));
  assert.equal(p.version, 1);
  assert.deepEqual(p.color(7), [255, 0, 0]); assert.equal(p.densidad(7), 2.6); assert.ok(p.conoce(7)); assert.ok(!p.conoce(8));
  assert.ok(!p.ingest(undefined));
  p.clear(); assert.ok(!p.conoce(7)); assert.equal(p.version, 2);
});

test('vetas: con composición salen de ella (no de la geología latente); en agua no hay', () => {
  const t = tesela({ biome: 'mountain', mat: [[1, .6], [2, .3], [3, .1]] });
  assert.deepEqual(veinsAt(t, 47), [], 'la geología latente calla si hay composición');
  const vetas = vetasDeComposicion(t);
  assert.deepEqual(vetas.map(v => v.id), [2]);
  assert.ok(.1 < VETA_FRACCION_MINIMA);
  assert.deepEqual(vetasDeComposicion({ ...t, terrain: 'water' }), []);
  const rects: string[] = [];
  const g = { fillStyle: '', fillRect(this: { fillStyle: unknown }) { rects.push(String(this.fillStyle)); } } as unknown as CanvasRenderingContext2D;
  assert.deepEqual(paintVetasComposicion(g, t, id => id === 2 ? [200, 40, 40] : undefined), [2]);
  assert.ok(rects.length > 0);
  rects.length = 0;
  assert.deepEqual(paintVetasComposicion(g, t, () => undefined), [], 'sin color conocido no se inventa');
  assert.equal(rects.length, 0);
});

test('capa Hilos: un color estable por dueño, distinto entre dueños vecinos y en la paleta', () => {
  assert.deepEqual(colorDeDueno(3), colorDeDueno(3));
  const vistos = new Set<string>();
  for (let d = 0; d < 32; d++) { const c = colorDeDueno(d); for (const v of c) assert.ok(v >= 0 && v <= 255 && v % 8 === 0); vistos.add(c.join(',')); }
  assert.ok(vistos.size >= 24, 'casi todos los 32 hilos se distinguen');
  assert.notDeepEqual(colorDeDueno(0), colorDeDueno(1));
});

test('capas V23: solo se ofrecen si la vista trae su dato; el catálogo de siempre queda igual', () => {
  assert.equal(capasDelMapa().length, MAP_LAYER_CATALOG.length);
  assert.deepEqual([...capasV23Disponibles({})], []);
  const todas = capasV23Disponibles({ reparto: { paginas: [[0, 0, 1]], msPorHilo: [] }, aire: { '0,0': { humedadRelativa: .5, lluvia: 0, T: 290 } } });
  assert.deepEqual([...todas].sort(), ['aire', 'hilos']);
  assert.deepEqual(capasDelMapa(todas).slice(-2).map(c => c.id), ['hilos', 'aire']);
  assert.ok(isMapLayerId('hilos') && isMapLayerId('aire'));
  assert.ok(!renderLayersPopoverHtml(new Set()).includes('data-layer="hilos"'));
  assert.ok(renderLayersPopoverHtml(new Set(['hilos']), todas).includes('data-layer="hilos" checked'));
  assert.equal(activeLayersSummary(new Set(['hilos'])), 'Hilos');
});

test('lluvia: intensidad 0 sin dato, crece sin tope duro y la atmósfera la acepta como número', () => {
  assert.equal(intensidadLluvia(undefined), 0);
  assert.equal(intensidadLluvia(0), 0);
  assert.ok(intensidadLluvia(LLUVIA_PLENA_MM_H) > .9 && intensidadLluvia(LLUVIA_PLENA_MM_H) < 1);
  assert.ok(intensidadLluvia(1) < intensidadLluvia(2));
  const luz = { color: 'rgb(10,20,30)', alpha: .2, shadowX: 0, shadowY: 0, shadowAlpha: 0 } as Parameters<AtmosphereSmoother['step']>[0];
  assert.equal(new AtmosphereSmoother().step(luz, .4, 0).rain, .4);
  assert.equal(new AtmosphereSmoother().step(luz, true, 0).rain, 1);
});
