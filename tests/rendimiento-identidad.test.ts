/**
 * Control de identidad del sprint noche-perf (2026-09-22). Las optimizaciones de rendimiento del paso
 * (índice de teselas compartido, claves numéricas de la fauna, memoria de recetas archivadas del Store…)
 * sólo son admisibles si NO cambian un solo bit del mundo: `digestoCanonico` tras 1200 y 2400 pasos
 * debe ser idéntico al del árbol sin tocar, en el mismo régimen que el laboratorio (`replica.ts`:
 * Store temporal guardado antes del primer paso y cada `persistencia.cadaTicks`).
 *
 * Cómo se obtuvieron los hashes literales de abajo: `npx tsx scripts/lab/rendimiento.ts digestos`
 * ejecutado el 2026-09-22 sobre una copia (`git archive`) del commit e1adaaf —la consolidación R2,
 * `sprint/noche-r2-20260922`, ANTES de cualquier cambio de este sprint—, con la misma función
 * `digestosControl` que usa esta prueba. Si una ley cambia a propósito, estos hashes cambian con ella y
 * hay que regenerarlos del mismo modo (con el árbol de la ley nueva sin optimizaciones pendientes);
 * si cambian sin que ninguna ley cambie, la optimización alteró el mundo y debe revertirse.
 *
 * Coste: ~25 s + ~50 s + ~195 s de CPU (la semilla 42 usa `persistencia.cadaTicks` = 1 por defecto:
 * guarda en cada paso). Con la torre cargada el reloj de pared puede multiplicarse; de ahí el tope propio.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { digestosControl, LEYES_CANDIDATAS } from '../scripts/lab/rendimiento.js';
import { firstTileAt, lastTileAt, tileLookup } from '../src/world/tile-index.js';
import { primero, primeroConFiltroCaro, primerosDos } from '../src/world/orden.js';

/** Generador determinista pequeño (xorshift32) para las pruebas de equivalencia. */
function aleatorio(seed: number): () => number {
  let n = seed >>> 0 || 1;
  return () => { n ^= n << 13; n >>>= 0; n ^= n >>> 17; n ^= n << 5; n >>>= 0; return n / 4294967296; };
}

test('tile-index responde como el Map de claves "x,y" (última) y como find (primera), también en los bordes', () => {
  const r = aleatorio(20260922);
  type T = { x: number; y: number; n: number };
  const tiles: T[] = [];
  for (let n = 0; n < 3000; n++) tiles.push({ x: Math.floor(r() * 120) - 60, y: Math.floor(r() * 90) - 45, n });
  // Bordes: -0, fuera de la rejilla, no enteros, NaN, límites de bloque.
  tiles.push({ x: -0, y: 5, n: -1 }, { x: 2 ** 24, y: -(2 ** 24) - 1, n: -2 }, { x: 1.5, y: -2.25, n: -3 }, { x: -16, y: -17, n: -4 }, { x: 15, y: 16, n: -5 });
  const unicas = [...new Map(tiles.map(t => [`${t.x},${t.y}`, t])).values()].filter((t, i, all) => all.findIndex(o => o.x === t.x && o.y === t.y) === i);
  const consultas: [number, number][] = [[0, 5], [-0, 5], [2 ** 24, -(2 ** 24) - 1], [1.5, -2.25], [NaN, 5], [-16, -17], [15, 16], [-1, -1], [1e9, 3], [-61, 0]];
  for (let n = 0; n < 4000; n++) consultas.push([Math.floor(r() * 130) - 65, Math.floor(r() * 100) - 50]);
  for (const conjunto of [tiles, unicas]) {
    const porCadena = new Map(conjunto.map(t => [`${t.x},${t.y}`, t]));
    const lookup = tileLookup(conjunto);
    for (const [x, y] of consultas) {
      assert.equal(lastTileAt(conjunto, x, y), porCadena.get(`${x},${y}`), `lastTileAt(${x}, ${y})`);
      assert.equal(lookup(x, y), porCadena.get(`${x},${y}`), `tileLookup(${x}, ${y})`);
      assert.equal(firstTileAt(conjunto, x, y), conjunto.find(t => t.x === x && t.y === y), `firstTileAt(${x}, ${y})`);
    }
  }
  // Una coordenada que no es número pone el índice en el modo de cadena de siempre.
  const mixtas = [{ x: '3' as unknown as number, y: 4 }, { x: 3, y: 4 }];
  assert.equal(lastTileAt(mixtas, 3, 4), mixtas[1]);
  assert.equal(lastTileAt(mixtas, '3', 4), mixtas[1]);
  assert.equal(firstTileAt(mixtas, 3, 4), mixtas[1]);
});

test('primero, primeroConFiltroCaro y primerosDos dan los mismos elementos que filter + sort estable', () => {
  const r = aleatorio(7);
  for (let caso = 0; caso < 400; caso++) {
    const items = Array.from({ length: Math.floor(r() * 40) }, (_, id) => ({ id, a: Math.floor(r() * 6), b: Math.round(r() * 4) / 4 }));
    const compare = (p: typeof items[number], q: typeof items[number]) => p.a - q.a || q.b - p.b;
    const keep = (p: typeof items[number]) => (p.id + caso) % 3 !== 0;
    const ordenados = items.filter(keep).sort(compare);
    assert.equal(primero(items, compare, keep), ordenados[0]);
    assert.equal(primeroConFiltroCaro(items, compare, keep), ordenados[0]);
    assert.deepEqual(primerosDos(items, compare, keep), ordenados.slice(0, 2));
    assert.equal(primero(items, compare), [...items].sort(compare)[0]);
  }
});

const REFERENCIA: readonly { seed: number; params?: string; digestos: Record<'1200' | '2400', string> }[] = [
  { seed: 51926, params: LEYES_CANDIDATAS, digestos: {
    1200: '846f36fe7b2766130429979704868dc301ea34f73ab0f511ec95395efeb74a77',
    2400: '3629949dd8df3432faf3df0b77f82a5683bc3fadcbca7ddc5fb153c03023b2eb' } },
  { seed: 7, params: LEYES_CANDIDATAS, digestos: {
    1200: '6e378d73d46b90df176a42f31d4f86c4f566d35db365ddb0163159f81a94618a',
    2400: 'ea9cb210139a3cf75c8fe9cac66bfd6e3497b02fefd9480df215a38286975b11' } },
  { seed: 42, digestos: {
    1200: 'b58515151286b85a7e8bfc29ceb8da04f0adce10aa9b991daa00721344fd9f25',
    2400: 'a74f2704b25bbc382c4ead56c86434c76ff271ee7660c91b0c9eea931112e844' } },
];

test('las leyes candidatas del laboratorio son las del control', () => {
  assert.equal(LEYES_CANDIDATAS, 'persistencia.cadaTicks=300,poblacion.cortejo=2,poblacion.radioCortejo=128,poblacion.exigeComunidad=false,poblacion.comprobacionContinua=true,conducta.habituacion=0.35');
});

for (const { seed, params, digestos } of REFERENCIA) {
  test(`semilla ${seed} (${params ? 'leyes candidatas' : 'parámetros por defecto'}): digestoCanonico idéntico al árbol sin optimizar tras 1200 y 2400 pasos`, { timeout: 3_600_000 }, () => {
    assert.deepEqual(digestosControl(seed, params, [1200, 2400]), digestos);
  });
}
