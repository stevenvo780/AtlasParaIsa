import type { Tile } from '../shared/types.js';

/**
 * Agua superficial en cuencas (T035, SC-004). `initializeEcosystem` (ecosystem.ts) gatea el
 * agua potable (manantial/charca/humedal) de cada tesela con `ruidoCuenca`: fuera de la cuenca
 * (ruido ≥ `agua.cuencas`) la tesela pierde su agua potable de origen, aunque conserva `moisture`
 * (la lluvia sigue). Con `cuencas = 1` (default) el ruido nunca alcanza el umbral: comportamiento
 * bit a bit igual al actual. Este módulo también expone las métricas de SC-004 (regiones sin agua
 * superficial, distancia media a agua potable) para el orquestador de `worldStatistics`.
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

const regionKey = (x: number, y: number, tamRegion: number): string => `${Math.floor(x / tamRegion)},${Math.floor(y / tamRegion)}`;

/**
 * Fracción [0,1] de regiones (cuadrículas de `tamRegion`×`tamRegion` sobre las teselas dadas) sin
 * ninguna tesela con agua potable superficial (`drinkingWater > 0`). SC-004 parte 2: objetivo ≥ 0,30.
 */
export function regionesSinAgua(tiles: readonly Tile[], tamRegion = 16): number {
  const regiones = new Map<string, boolean>();
  for (const tile of tiles) {
    const clave = regionKey(tile.x, tile.y, tamRegion);
    const tieneAgua = (tile.drinkingWater ?? 0) > 0;
    regiones.set(clave, (regiones.get(clave) ?? false) || tieneAgua);
  }
  if (regiones.size === 0) return 0;
  let sinAgua = 0;
  for (const tieneAgua of regiones.values()) if (!tieneAgua) sinAgua++;
  return sinAgua / regiones.size;
}

/**
 * Distancia Manhattan media (en celdas) desde una muestra determinista de teselas de tierra hasta
 * la tesela de agua potable (`drinkingWater > 0`) más cercana de las mismas `tiles`. La muestra
 * toma como mucho `muestras` teselas de tierra repartidas uniformemente en el orden recibido (sin
 * `Math.random`). Si no hay ninguna tesela con agua potable, la distancia es `Infinity` (no hay
 * agua alcanzable en el conjunto dado). SC-004 parte 3: objetivo > 6.
 */
export function distanciaMediaAgua(tiles: readonly Tile[], muestras = 200): number {
  const tierra = tiles.filter(tile => tile.terrain !== 'water');
  const agua = tiles.filter(tile => (tile.drinkingWater ?? 0) > 0);
  if (tierra.length === 0) return 0;
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
  return contadas === 0 ? 0 : total / contadas;
}
