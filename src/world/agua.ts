import type { Tile } from '../shared/types.js';

/**
 * Agua superficial en cuencas (T035, SC-004). `initializeEcosystem` (ecosystem.ts) gatea el
 * agua potable (manantial/charca/humedal) de cada tesela con `ruidoCuenca`: fuera de la cuenca
 * (ruido ≥ `agua.cuencas`) la tesela pierde su agua potable de origen, aunque conserva `moisture`
 * (la lluvia sigue). Con `cuencas = 1` (default) el ruido nunca alcanza el umbral: comportamiento
 * bit a bit igual al actual. Este módulo también expone la métrica de SC-004 de regiones sin agua
 * superficial; la distancia media a agua potable de `worldStatistics` es la BFS de `statistics.ts`.
 *
 * Ronda de arreglo (2026-09-19): el gateo por sí solo NO era duradero — `EcosystemKernel.step`
 * (`ecosystem-kernel.ts`) recargaba cualquier manantial/charca/humedal con la lluvia sin mirar la
 * cuenca. Se exporta `enCuenca` precisamente para que `ecosystem-kernel.ts` use la MISMA regla al
 * decidir si una tesela puede recargarse: fuera de cuenca, ni la lluvia ni el goteo fijo del
 * manantial rellenan `drinkingWater`.
 */

const CUENCA_SCALE = 24;
const CUENCA_SALT = 1400;

/** Mismo hash entero de retícula que usa `terrain.ts`: determinista, sin `Math.random`. */
function hash(seed: number, x: number, y: number, salt: number): number {
  let value = seed ^ salt ^ Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77);
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

function unit(seed: number, x: number, y: number, salt: number): number {
  return hash(seed, x, y, salt) / 0x1_0000_0000;
}

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Ruido espacial de baja frecuencia en [0, 1) (escala ~24 celdas), misma técnica de retícula +
 * interpolación suave que el ruido de `terrain.ts` (hash entero, `fade`, bilinear). Determinista:
 * misma semilla y coordenadas globales → mismo valor siempre.
 */
export function ruidoCuenca(seed: number, x: number, y: number): number {
  const px = x / CUENCA_SCALE, py = y / CUENCA_SCALE;
  const ix = Math.floor(px), iy = Math.floor(py);
  const tx = fade(px - ix), ty = fade(py - iy);
  return lerp(
    lerp(unit(seed, ix, iy, CUENCA_SALT), unit(seed, ix + 1, iy, CUENCA_SALT), tx),
    lerp(unit(seed, ix, iy + 1, CUENCA_SALT), unit(seed, ix + 1, iy + 1, CUENCA_SALT), tx),
    ty,
  );
}

/** true si la tesela cae dentro de una cuenca (conserva su agua potable de origen). */
export function enCuenca(seed: number, x: number, y: number, cuencas: number): boolean {
  return ruidoCuenca(seed, x, y) < cuencas;
}

/** Clave de región como cadena: solo para coordenadas que no caben en la clave empaquetada (NaN, ±Infinity, tamaños extremos). */
const regionKey = (rx: number, ry: number): string => `${rx},${ry}`;
const REGION_BITS = 2 ** 25, REGION_STRIDE = 2 * REGION_BITS;
/** Bits de la máscara por región: 1 = hay tierra, 2 = hay agua potable superficial. */
const TIERRA = 1, AGUA = 2;
const inRange = (r: number): boolean => r >= -REGION_BITS && r < REGION_BITS && Number.isInteger(r);

/**
 * Fracción [0,1] de regiones CON TIERRA (cuadrículas de `tamRegion`×`tamRegion` sobre las teselas
 * dadas) sin ninguna tesela con agua potable superficial (`drinkingWater > 0`). SC-004 parte 2:
 * objetivo ≥ 0,30. Una región 100 % océano (`terrain === 'water'`) no cuenta ni como seca ni como
 * húmeda: no tiene tierra donde alguien pueda pasar sed, así que incluirla infla artificialmente
 * la fracción sin que la regla de cuencas haya hecho nada (T035 ronda de arreglo, hallazgo
 * importante: «regionesSinAgua cuenta las regiones 100 % océano como "sin agua"»).
 */
export function regionesSinAgua(tiles: readonly Tile[], tamRegion = 16): number {
  // Clave numérica empaquetada (|región| < 2^25 → entero seguro) y máscara de bits: sin cadenas ni objetos por tesela.
  // Las regiones fuera de rango (coordenadas extremas o no finitas) caen en un mapa de cadenas con la clave de siempre.
  const regiones = new Map<number, number>();
  let extremas: Map<string, number> | undefined;
  let claveActual = NaN, mascaraActual = 0;
  for (const tile of tiles) {
    const rx = Math.floor(tile.x / tamRegion), ry = Math.floor(tile.y / tamRegion);
    const bits = (tile.terrain !== 'water' ? TIERRA : 0) | ((tile.drinkingWater ?? 0) > 0 ? AGUA : 0);
    if (inRange(rx) && inRange(ry)) {
      const clave = (rx + REGION_BITS) * REGION_STRIDE + (ry + REGION_BITS);
      // Las teselas suelen llegar agrupadas por región: se acumula la racha y se vuelca al cambiar de clave.
      if (clave !== claveActual) {
        if (mascaraActual !== 0) regiones.set(claveActual, (regiones.get(claveActual) ?? 0) | mascaraActual);
        claveActual = clave; mascaraActual = 0;
      }
      mascaraActual |= bits;
    } else {
      extremas ??= new Map();
      const clave = regionKey(rx, ry);
      extremas.set(clave, (extremas.get(clave) ?? 0) | bits);
    }
  }
  if (mascaraActual !== 0) regiones.set(claveActual, (regiones.get(claveActual) ?? 0) | mascaraActual);
  let conTierra = 0, sinAgua = 0;
  const contar = (mascara: number): void => { if (mascara & TIERRA) { conTierra++; if (!(mascara & AGUA)) sinAgua++; } };
  for (const mascara of regiones.values()) contar(mascara);
  if (extremas) for (const mascara of extremas.values()) contar(mascara);
  return conTierra === 0 ? 0 : sinAgua / conTierra;
}
