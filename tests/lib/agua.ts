import type { Tile } from '../../src/shared/types.js';

/**
 * Distancia Manhattan EN LÍNEA RECTA media (en celdas) desde una muestra determinista de teselas
 * de tierra hasta la tesela de agua potable (`drinkingWater > 0`) más cercana de las mismas
 * `tiles`. La muestra toma como mucho `muestras` teselas de tierra repartidas uniformemente en el
 * orden recibido (sin `Math.random`). Si no hay ninguna tesela con agua potable, devuelve `-1`.
 *
 * Solo la usan las pruebas de cuencas (SC-004 parte 3: objetivo > 6), que fijan sus umbrales con
 * ESTA métrica. No es `distanciaMediaAgua` de `src/world/statistics.ts`: aquella es una BFS de
 * conectividad real (no cruza mar ni montaña y cuenta el mar como fuente); esta es una línea recta
 * muestreada que no cuenta el mar. Sustituir una por otra cambiaría los umbrales.
 */
export function distanciaMediaAguaManhattan(tiles: readonly Tile[], muestras = 200): number {
  const tierra = tiles.filter(tile => tile.terrain !== 'water');
  const agua = tiles.filter(tile => (tile.drinkingWater ?? 0) > 0);
  if (tierra.length === 0 || agua.length === 0) return -1;
  const paso = Math.max(1, Math.floor(tierra.length / muestras));
  let total = 0, contadas = 0;
  for (let i = 0; i < tierra.length && contadas < muestras; i += paso) {
    const origen = tierra[i]!;
    let mejor = Infinity;
    for (const destino of agua) {
      const distancia = Math.abs(destino.x - origen.x) + Math.abs(destino.y - origen.y);
      if (distancia < mejor) mejor = distancia;
    }
    total += mejor; contadas++;
  }
  return contadas === 0 ? -1 : total / contadas;
}
