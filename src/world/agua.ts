import type { Tile } from '../shared/types.js';
import { verifiedChunkBlocks } from './tile-index.js';
import { residentFastAccess, type ResidentFastAccess } from './soa/terreno.js';
import { residentTopologyToken } from './soa/topologia.js';

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
 * Lectura directa del SoA residente para recorridos de TODAS las teselas (V18 ola 2, carril C).
 * Con `ResidentTopologyOwner` + `motor.soaTerreno`, cada `Tile` es un Proxy cuyos accesores
 * (`terreno.ts`) hacen un `WeakMap.get` por campo y tesela: en un mundo de 278 016 teselas, más de un
 * millón de llamadas por métrica. `residentFastAccess` ya expone los arrays contiguos; aquí se
 * resuelve UNA vez la celda de cada tesela. `cells[i] === -1` → esa tesela no está ligada (alta
 * reciente entre pasos de ecología): el llamador lee el objeto, como siempre (fail-closed).
 *
 * `chunkX/chunkY` (origen de cada chunk de 16 × 16) sólo existen si `tiles` es exactamente una
 * concatenación de chunks completos (`verifiedChunkBlocks`, T113): la tesela `256·k + s` es la casilla
 * `s = ((y & 15) << 4) | (x & 15)` del chunk `k`. Entonces el vecino de una casilla interior es
 * aritmética pura y los 1 086 chunks de un mundo real sustituyen a 278 016 consultas de posición.
 */
export interface LecturaResidente {
  readonly fast: ResidentFastAccess;
  readonly cells: Int32Array;
  /** Todas las teselas ligadas (`cells[i] >= 0` para todo `i`). */
  readonly completa: boolean;
  readonly chunkX: Int32Array | undefined;
  readonly chunkY: Int32Array | undefined;
}
const CHUNK_CELLS = 256;
/** Cota conservadora de coordenada de origen de chunk (< `MAX_COORDINATE` = 10^7 menos margen): ahí el vecino de un chunk de borde no solapa filas en las claves empaquetadas. No se importa `terrain.ts`: ya importa este módulo y los workers de ecología cargan `ecosystem.ts` como entrada (ciclo). */
const CHUNK_LIMIT = 8_000_000;

interface LecturaCacheEntry {
  readonly arrayToken: object;
  readonly coordToken: object;
  readonly length: number;
  readonly fast: ResidentFastAccess;
  readonly result: LecturaResidente;
}
const lecturaCache = new WeakMap<readonly Tile[], LecturaCacheEntry>();

export function lecturaResidente(tiles: readonly Tile[]): LecturaResidente | undefined {
  const fast = residentFastAccess(tiles);
  if (!fast) return undefined;
  const token = residentTopologyToken(tiles as Tile[]);
  const count = tiles.length;
  if (token) {
    const cached = lecturaCache.get(tiles);
    if (cached && cached.arrayToken === token.array && cached.coordToken === token.coordinates
      && cached.length === count && cached.fast === fast) return cached.result;
  }
  const cells = new Int32Array(count);
  let chunkX: Int32Array | undefined, chunkY: Int32Array | undefined;
  const layout = count > 0 && count % CHUNK_CELLS === 0 ? verifiedChunkBlocks(tiles) : null;
  if (layout && layout.bases.size * CHUNK_CELLS === count) {
    const total = count / CHUNK_CELLS, xs = new Int32Array(total), ys = new Int32Array(total), seen = new Uint8Array(total);
    let valid = true;
    for (const base of layout.bases.values()) {
      const ordinal = base / CHUNK_CELLS;
      if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= total || seen[ordinal]) { valid = false; break; }
      seen[ordinal] = 1;
      const first = tiles[base]!, last = tiles[base + CHUNK_CELLS - 1]!, x0 = first.x, y0 = first.y;
      if (!Number.isInteger(x0) || !Number.isInteger(y0) || (x0 & 15) !== 0 || (y0 & 15) !== 0
        || Math.abs(x0) > CHUNK_LIMIT || Math.abs(y0) > CHUNK_LIMIT || last.x !== x0 + 15 || last.y !== y0 + 15) { valid = false; break; }
      xs[ordinal] = x0; ys[ordinal] = y0;
    }
    if (valid) { chunkX = xs; chunkY = ys; }
  }
  let completa = true;
  const exact = fast.exact;
  // Camino exacto: una consulta de página por chunk (1 086 en vez de 278 016) y celdas consecutivas.
  let resolved = false;
  if (chunkX && chunkY && exact) {
    resolved = true;
    for (let k = 0; k < chunkX.length && resolved; k++) {
      const page = exact.pageBase(chunkX[k]! >> 4, chunkY[k]! >> 4);
      if (page < 0) { resolved = false; break; }
      for (let s = 0; s < CHUNK_CELLS; s++) if (!exact.isPresent(page + s)) { resolved = false; break; }
      if (resolved) { const at = k * CHUNK_CELLS; for (let s = 0; s < CHUNK_CELLS; s++) cells[at + s] = page + s; }
    }
  }
  if (!resolved) for (let i = 0; i < count; i++) { const cell = fast.cellOf(tiles[i]!); cells[i] = cell; if (cell < 0) completa = false; }
  const result: LecturaResidente = { fast, cells, completa, chunkX, chunkY };
  if (token) lecturaCache.set(tiles, { arrayToken: token.array, coordToken: token.coordinates, length: count, fast, result });
  return result;
}

/**
 * Fracción [0,1] de regiones CON TIERRA (cuadrículas de `tamRegion`×`tamRegion` sobre las teselas
 * dadas) sin ninguna tesela con agua potable superficial (`drinkingWater > 0`). SC-004 parte 2:
 * objetivo ≥ 0,30. Una región 100 % océano (`terrain === 'water'`) no cuenta ni como seca ni como
 * húmeda: no tiene tierra donde alguien pueda pasar sed, así que incluirla infla artificialmente
 * la fracción sin que la regla de cuencas haya hecho nada (T035 ronda de arreglo, hallazgo
 * importante: «regionesSinAgua cuenta las regiones 100 % océano como "sin agua"»).
 */
export function regionesSinAgua(tiles: readonly Tile[], tamRegion = 16, lectura: LecturaResidente | undefined = lecturaResidente(tiles)): number {
  // Clave numérica empaquetada (|región| < 2^25 → entero seguro) y máscara de bits: sin cadenas ni objetos por tesela.
  // Las regiones fuera de rango (coordenadas extremas o no finitas) caen en un mapa de cadenas con la clave de siempre.
  const regiones = new Map<number, number>();
  let extremas: Map<string, number> | undefined;
  const acumular = (rx: number, ry: number, bits: number): void => {
    if (inRange(rx) && inRange(ry)) {
      const clave = (rx + REGION_BITS) * REGION_STRIDE + (ry + REGION_BITS);
      regiones.set(clave, (regiones.get(clave) ?? 0) | bits);
    } else {
      extremas ??= new Map();
      const clave = regionKey(rx, ry);
      extremas.set(clave, (extremas.get(clave) ?? 0) | bits);
    }
  };
  if (lectura?.chunkX && lectura.chunkY && Number.isInteger(tamRegion) && tamRegion > 0 && tamRegion <= 1 << 20 && tamRegion % 16 === 0) {
    // Una región de `16·k` celdas contiene chunks enteros: cada página de 256 teselas cae en UNA sola región.
    const { fast, cells, chunkX, chunkY } = lectura, terreno = fast.terrainArr, agua = fast.drinkingWaterArr, WATER = fast.TERRAIN_WATER;
    for (let k = 0; k < chunkX.length; k++) {
      let bits = 0;
      for (let i = k << 8, fin = i + 256; i < fin && bits !== (TIERRA | AGUA); i++) {
        const cell = cells[i]!;
        if (cell >= 0) { if (terreno[cell] !== WATER) bits |= TIERRA; if (agua[cell]! > 0) bits |= AGUA; }
        else { const tile = tiles[i]!; if (tile.terrain !== 'water') bits |= TIERRA; if ((tile.drinkingWater ?? 0) > 0) bits |= AGUA; }
      }
      acumular(Math.floor(chunkX[k]! / tamRegion), Math.floor(chunkY[k]! / tamRegion), bits);
    }
  } else {
    let claveActual = NaN, mascaraActual = 0;
    const cells = lectura?.cells, terreno = lectura?.fast.terrainArr, agua = lectura?.fast.drinkingWaterArr, WATER = lectura?.fast.TERRAIN_WATER;
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i]!, cell = cells ? cells[i]! : -1;
      const rx = Math.floor(tile.x / tamRegion), ry = Math.floor(tile.y / tamRegion);
      const bits = cell >= 0 ? (terreno![cell] !== WATER ? TIERRA : 0) | (agua![cell]! > 0 ? AGUA : 0)
        : (tile.terrain !== 'water' ? TIERRA : 0) | ((tile.drinkingWater ?? 0) > 0 ? AGUA : 0);
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
  }
  let conTierra = 0, sinAgua = 0;
  const contar = (mascara: number): void => { if (mascara & TIERRA) { conTierra++; if (!(mascara & AGUA)) sinAgua++; } };
  for (const mascara of regiones.values()) contar(mascara);
  if (extremas) for (const mascara of (extremas as Map<string, number>).values()) contar(mascara);
  return conTierra === 0 ? 0 : sinAgua / conTierra;
}
