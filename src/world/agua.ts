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

const regionKey = (x: number, y: number, tamRegion: number): string => `${Math.floor(x / tamRegion)},${Math.floor(y / tamRegion)}`;

/**
 * Fracción [0,1] de regiones CON TIERRA (cuadrículas de `tamRegion`×`tamRegion` sobre las teselas
 * dadas) sin ninguna tesela con agua potable superficial (`drinkingWater > 0`). SC-004 parte 2:
 * objetivo ≥ 0,30. Una región 100 % océano (`terrain === 'water'`) no cuenta ni como seca ni como
 * húmeda: no tiene tierra donde alguien pueda pasar sed, así que incluirla infla artificialmente
 * la fracción sin que la regla de cuencas haya hecho nada (T035 ronda de arreglo, hallazgo
 * importante: «regionesSinAgua cuenta las regiones 100 % océano como "sin agua"»).
 */
export function regionesSinAgua(tiles: readonly Tile[], tamRegion = 16): number {
  const regiones = new Map<string, { tierra: boolean; agua: boolean }>();
  for (const tile of tiles) {
    const clave = regionKey(tile.x, tile.y, tamRegion);
    const entrada = regiones.get(clave) ?? { tierra: false, agua: false };
    if (tile.terrain !== 'water') entrada.tierra = true;
    if ((tile.drinkingWater ?? 0) > 0) entrada.agua = true;
    regiones.set(clave, entrada);
  }
  const conTierra = [...regiones.values()].filter(r => r.tierra);
  if (conTierra.length === 0) return 0;
  let sinAgua = 0;
  for (const r of conTierra) if (!r.agua) sinAgua++;
  return sinAgua / conTierra.length;
}
