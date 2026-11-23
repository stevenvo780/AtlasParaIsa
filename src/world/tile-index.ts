/**
 * Índice de teselas por coordenada (sprint noche-perf 2026-09-22). Sustituye, SIN cambiar un solo
 * resultado, a tres búsquedas que el perfil del mundo de 6 días (semilla 51926, leyes candidatas,
 * 27 136 teselas) puso entre las más caras del paso:
 *
 * - `tileAt` (spatial.ts) y `terrainIndex` (animals.ts) construían cada uno su `Map` con claves
 *   `"x,y"`: una cadena nueva por consulta. Aquí las coordenadas numéricas van a una rejilla por
 *   bloques (ver `Grid`). Para cualquier par de NÚMEROS es la misma relación de igualdad que la
 *   cadena: `String` da la representación exacta más corta de cada double, así que dos números
 *   distintos dan cadenas distintas salvo `-0`/`+0`, que la rejilla (`-0 >> 4 === 0`) y `Map`
 *   (SameValueZero) también identifican. Si alguna tesela tuviera una coordenada que no es número,
 *   el índice cae a la clave de cadena de siempre. Como antes, gana la ÚLTIMA tesela con esas
 *   coordenadas (`new Map(tiles.map(...))`).
 * - `host.tiles?.find(t => t.x === X && t.y === Y)` (technology.ts, technology-water.ts): un
 *   recorrido lineal de todas las teselas por cada consulta. `firstTileAt` devuelve la PRIMERA,
 *   como `find`; si hubiera coordenadas repetidas (nunca en un mundo válido) vuelve al `find`.
 *   `===` entre números y `SameValueZero` sólo difieren en `NaN`, que `===` nunca encuentra: se
 *   excluye antes de mirar el índice.
 *
 * T113: el `world.tiles` de un mundo real es la concatenación de chunks COMPLETOS en orden fila-mayor
 * (`activate` añade los 256 de golpe y `maintainRegions` retira chunks enteros conservando el orden).
 * Entonces basta `clave de chunk → posición de su primera tesela` y la consulta es aritmética
 * (`Blocks`): verificarlo cuesta dos comparaciones por tesela, sin `Map` ni arreglo por bloque, y
 * `activate`/`maintainRegions` lo mantienen sin recorrer teselas (`tileIndexAppended`,
 * `splitTileBlocks`). Cualquier otro arreglo usa la rejilla de siempre.
 *
 * Se invalida exactamente como el índice que reemplaza: por identidad del arreglo y longitud
 * (`world.tiles` sólo cambia por reasignación o `push`).
 */
import type { Tile } from '../shared/types.js';
import { residentBackingArray } from './soa/topologia.js';

interface Cell { x: number; y: number; }
const backingOf = <T extends Cell>(tiles: readonly T[]): readonly T[] =>
  residentBackingArray(tiles as unknown as readonly Tile[]) as unknown as readonly T[];
/** Rejilla por bloques de 16 × 16 para coordenadas enteras en [-2^24, 2^24) —todo el dominio del mundo
 * (`MAX_COORDINATE` = 10^7)—: una clave de bloque y un índice dentro del bloque, con el último bloque
 * consultado a mano (las leyes preguntan por celdas vecinas). Cualquier otro número (no entero o fuera
 * de ese rango, incluido `NaN`) va a `others`, el `Map` x → y de siempre. La partición es la misma para
 * teselas y consultas, así que cada consulta mira exactamente donde podría estar su tesela. */
const GRID_LIMIT = 2 ** 24, BLOCK_OFFSET = 2 ** 20, BLOCK_SPAN = 2 ** 21;
const inGrid = (v: number): boolean => Number.isInteger(v) && v >= -GRID_LIMIT && v < GRID_LIMIT;
const blockKey = (x: number, y: number): number => ((x >> 4) + BLOCK_OFFSET) * BLOCK_SPAN + ((y >> 4) + BLOCK_OFFSET);
/** Posición dentro del bloque; con bloques = chunks de `CHUNK_SIZE` 16 es también la de `generateChunk`. */
const slot = (x: number, y: number): number => ((y & 15) << 4) | (x & 15);
const BLOCK = 256;
interface Grid {
  blocks: Map<number, (Cell | undefined)[]>;
  others: Map<number, Map<number, Cell>>;
  lastKey: number;
  lastBlock: (Cell | undefined)[] | undefined;
  lastKey2: number;
  lastBlock2: (Cell | undefined)[] | undefined;
}
/** Disposición por chunks: bloque → posición de su primera tesela, en orden creciente de posición.
 * Cada bloque está una sola vez y sus 256 teselas tienen exactamente las coordenadas de su casilla,
 * así que no hay repetidas ni coordenadas fuera de la rejilla. `blockIds` identifica cada bloque de
 * 256 teselas validadas para reutilización incremental en motores paralelos. */
interface Blocks { bases: Map<number, number>; blockIds: Map<number, number>; lastKey: number; lastBase: number; lastKey2: number; lastBase2: number; }
let nextBlockId = 1;
interface TileIndex {
  length: number;
  /** Backing plano de solo lectura (sin `ProxyGetProperty` para arrays observados por `ResidentTopologyOwner`). */
  raw: readonly Cell[];
  /** Modo aritmético (T113); si es `null`, rejilla o cadena. */
  chunks: Blocks | null;
  /** Modo numérico: última tesela de cada par de coordenadas; `null` si alguna no es número. */
  grid: Grid | null;
  /** Modo cadena: la clave `"x,y"` histórica. */
  strings: Map<string, Cell> | null;
  /** Hay dos teselas con las mismas coordenadas: `firstTileAt` recorre como `find`. */
  duplicates: boolean;
}
const indexes = new WeakMap<readonly Cell[], TileIndex>();
let fullBuilds = 0;
/** Diagnóstico (pruebas y perfiles): índices construidos recorriendo el arreglo entero. */
export const tileIndexBuilds = (): number => fullBuilds;

/** `v === (v | 0)` equivale a «entero int32» (con `-0 === 0`); cruzado con el rango da `inGrid`
 * sin `Number.isInteger` en el camino caliente. Todo lo demás (fracciones, `NaN`, infinitos,
 * enteros fuera de int32 o del rango) cae igual que caía con `inGrid`. */
function gridGet(grid: Grid, x: number, y: number): Cell | undefined {
  if (x === (x | 0) && y === (y | 0) && x >= -GRID_LIMIT && x < GRID_LIMIT && y >= -GRID_LIMIT && y < GRID_LIMIT) {
    const key = blockKey(x, y);
    let block: (Cell | undefined)[] | undefined;
    if (key === grid.lastKey) block = grid.lastBlock;
    else if (key === grid.lastKey2) block = grid.lastBlock2;
    else {
      block = grid.blocks.get(key);
      grid.lastKey2 = grid.lastKey; grid.lastBlock2 = grid.lastBlock; grid.lastKey = key; grid.lastBlock = block;
    }
    return block?.[slot(x, y)];
  }
  return grid.others.get(x)?.get(y);
}

/** `limit`: longitud del arreglo cuando se fijó la consulta; un bloque añadido después no existe para ella. */
function blocksGet(tiles: readonly Cell[], chunks: Blocks, limit: number, x: number, y: number): Cell | undefined {
  if (x !== (x | 0) || y !== (y | 0) || x < -GRID_LIMIT || x >= GRID_LIMIT || y < -GRID_LIMIT || y >= GRID_LIMIT) return undefined;
  const key = blockKey(x, y);
  let base: number;
  if (key === chunks.lastKey) base = chunks.lastBase;
  else if (key === chunks.lastKey2) base = chunks.lastBase2;
  else {
    base = chunks.bases.get(key) ?? -1;
    chunks.lastKey2 = chunks.lastKey; chunks.lastBase2 = chunks.lastBase; chunks.lastKey = key; chunks.lastBase = base;
  }
  return base >= 0 && base < limit ? tiles[base + slot(x, y)] : undefined;
}

/** Comprueba que `raw[from…]` son bloques completos y nuevos y los anota en `added`; `false` si no. */
function readBlocks(raw: readonly Cell[], from: number, known: Map<number, number>, added: Map<number, number>): boolean {
  if (from < 0 || raw.length < from || (raw.length - from) % BLOCK !== 0) return false;
  for (let base = from; base < raw.length; base += BLOCK) {
    const first = raw[base];
    if (first == null) return false;
    const x0 = first.x, y0 = first.y;
    if (typeof x0 !== 'number' || typeof y0 !== 'number' || !inGrid(x0) || !inGrid(y0) || (x0 & 15) !== 0 || (y0 & 15) !== 0) return false;
    const key = blockKey(x0, y0);
    if (known.has(key) || added.has(key)) return false;
    for (let s = 1; s < BLOCK; s++) {
      const tile = raw[base + s];
      if (tile == null || tile.x !== x0 + (s & 15) || tile.y !== y0 + (s >> 4)) return false;
    }
    added.set(key, base);
  }
  return true;
}

function build(tiles: readonly Cell[]): TileIndex {
  fullBuilds++;
  const raw = backingOf(tiles);
  const bases = new Map<number, number>();
  if (readBlocks(raw, 0, new Map(), bases)) {
    const blockIds = new Map<number, number>();
    for (const key of bases.keys()) blockIds.set(key, nextBlockId++);
    return { length: raw.length, raw, chunks: { bases, blockIds, lastKey: -1, lastBase: -1, lastKey2: -1, lastBase2: -1 }, grid: null, strings: null, duplicates: false };
  }
  const grid: Grid = { blocks: new Map(), others: new Map(), lastKey: -1, lastBlock: undefined, lastKey2: -1, lastBlock2: undefined };
  let duplicates = false, numeric = true;
  // `forEach` salta los huecos igual que el `tiles.map` del índice original; gana la última tesela.
  raw.forEach(tile => {
    if (!numeric) return;
    const { x, y } = tile;
    if (typeof x !== 'number' || typeof y !== 'number') { numeric = false; return; }
    if (inGrid(x) && inGrid(y)) {
      const key = blockKey(x, y);
      let block = grid.blocks.get(key);
      if (!block) { block = new Array<Cell | undefined>(256).fill(undefined); grid.blocks.set(key, block); }
      const at = slot(x, y);
      if (block[at] !== undefined) duplicates = true;
      block[at] = tile;
    } else {
      let column = grid.others.get(x);
      if (!column) { column = new Map(); grid.others.set(x, column); }
      if (column.has(y)) duplicates = true;
      column.set(y, tile);
    }
  });
  if (!numeric) return { length: raw.length, raw, chunks: null, grid: null, strings: new Map(raw.map(t => [`${t.x},${t.y}`, t])), duplicates: true };
  return { length: raw.length, raw, chunks: null, grid, strings: null, duplicates };
}

/** Último índice consultado: casi todas las consultas de un paso van al mismo `world.tiles`,
 * así que identidad + longitud (la misma regla de invalidación de siempre) evitan el `WeakMap`
 * por consulta. Retiene sólo ese último arreglo; `tileIndexAppended` lo olvida al descartar. */
let memoTiles: readonly Cell[] | undefined, memoIndex: TileIndex | undefined;
function indexOf(tiles: readonly Cell[]): TileIndex {
  if (tiles === memoTiles && memoIndex && memoIndex.length === memoIndex.raw.length) return memoIndex;
  let index = indexes.get(tiles);
  if (!index || index.length !== index.raw.length) { index = build(tiles); indexes.set(tiles, index); }
  memoTiles = tiles; memoIndex = index;
  return index;
}

/** `activate` acaba de añadir `tiles[from…]` (un chunk). Si el índice vigente es aritmético y lo añadido
 * son bloques completos, se anotan sin recorrer el resto; si no, se descarta y la próxima consulta lo
 * reconstruye como siempre. Las consultas fijadas antes no ven lo añadido (`limit`). */
export function tileIndexAppended(tiles: readonly Cell[], from: number): void {
  const index = indexes.get(tiles);
  if (!index || index.length !== from) return;
  const raw = index.raw;
  const added = new Map<number, number>();
  if (!index.chunks || !readBlocks(raw, from, index.chunks.bases, added)) { indexes.delete(tiles); if (memoTiles === tiles) { memoTiles = undefined; memoIndex = undefined; } return; }
  for (const [key, base] of added) {
    index.chunks.bases.set(key, base);
    index.chunks.blockIds.set(key, nextBlockId++);
  }
  index.chunks.lastKey = -1; index.chunks.lastKey2 = -1;
  index.length = raw.length;
  stringIndexes.delete(index);
}

/** `copy` acaba de salir de `source.map(t => ({ ...t }))`: mismas coordenadas en las mismas posiciones.
 * Hereda la disposición de `source` sin volver a leer cada tesela (sólo el origen de cada bloque, como
 * resguardo); sin disposición vigente en `source`, no hace nada y la primera consulta construye. Es el
 * gancho que `cloneWorld` y `puntoDeRestauracion` necesitan para no pagar un recorrido por paso.
 * `sameObjects = true` (p. ej. envolver el mismo bloque en un `Proxy` de `tileOwnership`) conserva los
 * `blockIds` de identidad de bloque; una copia con teselas nuevas (`cloneWorld`) recibe ids nuevos. */
export function tileIndexCopied(copy: readonly Cell[], source: readonly Cell[], sameObjects = false): void {
  const index = indexes.get(source);
  if (!index?.chunks) return;
  const rawCopy = backingOf(copy), rawSource = index.raw;
  if (index.length !== rawSource.length || rawCopy.length !== rawSource.length) return;
  for (const [key, base] of index.chunks.bases) {
    const first = rawCopy[base];
    if (first == null || typeof first.x !== 'number' || typeof first.y !== 'number'
      || !inGrid(first.x) || !inGrid(first.y) || (first.x & 15) !== 0 || (first.y & 15) !== 0 || blockKey(first.x, first.y) !== key) return;
    if (sameObjects && first !== rawSource[base]) return;
  }
  const blockIds = sameObjects
    ? new Map(index.chunks.blockIds)
    : new Map([...index.chunks.bases.keys()].map(key => [key, nextBlockId++] as const));
  indexes.set(copy, { length: rawCopy.length, raw: rawCopy, chunks: { bases: new Map(index.chunks.bases), blockIds, lastKey: -1, lastBase: -1, lastKey2: -1, lastBase2: -1 }, grid: null, strings: null, duplicates: false });
  if (memoTiles === copy) { memoTiles = undefined; memoIndex = undefined; }
}

/** Reparto de `maintainRegions` por bloques: cada chunk va entero a `destination(primera tesela)` o se
 * queda, en el orden del arreglo, igual que repartir tesela a tesela; el arreglo nuevo hereda la
 * disposición sin recorrer teselas. `null` si `tiles` no tiene disposición por chunks. */
export function splitTileBlocks<T extends Cell>(tiles: readonly T[], destination: (first: T) => T[] | undefined): T[] | null {
  const index = indexOf(tiles), chunks = index.chunks;
  if (!chunks) return null;
  const raw = index.raw as readonly T[];
  const keptBases: number[] = [], bases = new Map<number, number>(), blockIds = new Map<number, number>();
  let keptLen = 0;
  for (const [key, base] of chunks.bases) {
    const target = destination(raw[base]!);
    if (target) {
      for (let i = base; i < base + BLOCK; i++) target.push(raw[i]!);
    } else {
      keptBases.push(base);
      bases.set(key, keptLen);
      blockIds.set(key, chunks.blockIds.get(key)!);
      keptLen += BLOCK;
    }
  }
  const kept = new Array<T>(keptLen);
  let out = 0;
  for (let b = 0; b < keptBases.length; b++) {
    const base = keptBases[b]!;
    for (let i = 0; i < BLOCK; i++) kept[out++] = raw[base + i]!;
  }
  indexes.set(kept, { length: keptLen, raw: kept, chunks: { bases, blockIds, lastKey: -1, lastBase: -1, lastKey2: -1, lastBase2: -1 }, grid: null, strings: null, duplicates: false });
  return kept;
}

/** Reparto de `maintainRegions` por bloques delegando el ensamblado de los bloques conservados en
 * `assemble(keptBases, 256)` (p. ej. `ResidentTopologyOwner.subsetBlocks`, que copia directo del
 * backing privado sin materializar un arreglo intermedio ni revalidar 440k `WeakMap.get`/`Object.hasOwn`).
 * Hereda `bases` y `blockIds` en O(chunks) verificando el origen de cada bloque; `null` sin disposición por chunks. */
export function splitTileBlocksWith<T extends Cell>(
  tiles: readonly T[],
  destination: (first: T) => T[] | undefined,
  assemble: (keptBases: readonly number[], blockLength: number) => T[],
): T[] | null {
  const index = indexOf(tiles), chunks = index.chunks;
  if (!chunks) return null;
  const raw = index.raw as readonly T[];
  const keptBases: number[] = [], bases = new Map<number, number>(), blockIds = new Map<number, number>();
  let keptLen = 0;
  for (const [key, base] of chunks.bases) {
    const target = destination(raw[base]!);
    if (target) {
      for (let i = base; i < base + BLOCK; i++) target.push(raw[i]!);
    } else {
      keptBases.push(base);
      bases.set(key, keptLen);
      blockIds.set(key, chunks.blockIds.get(key)!);
      keptLen += BLOCK;
    }
  }
  const kept = assemble(keptBases, BLOCK);
  const rawKept = backingOf(kept);
  if (rawKept.length === keptLen) {
    let sameObjects = true, sameCoords = true, b = 0;
    for (const [key, keptBase] of bases) {
      const first = rawKept[keptBase];
      const origBase = keptBases[b++]!;
      if (first !== raw[origBase]) {
        sameObjects = false;
        if (first == null || typeof first.x !== 'number' || typeof first.y !== 'number'
          || !inGrid(first.x) || !inGrid(first.y) || (first.x & 15) !== 0 || (first.y & 15) !== 0
          || blockKey(first.x, first.y) !== key) {
          sameCoords = false;
          break;
        }
      }
    }
    if (sameCoords) {
      const nextBlockIds = sameObjects
        ? blockIds
        : new Map([...bases.keys()].map(key => [key, nextBlockId++] as const));
      indexes.set(kept, {
        length: rawKept.length,
        raw: rawKept,
        chunks: { bases, blockIds: nextBlockIds, lastKey: -1, lastBase: -1, lastKey2: -1, lastBase2: -1 },
        grid: null,
        strings: null,
        duplicates: false,
      });
      if (memoTiles === kept) { memoTiles = undefined; memoIndex = undefined; }
    }
  }
  return kept;
}

/** Disposición verificada por chunks de 16 × 16 (solo lectura), o `null` si el arreglo no está alineado por bloques. */
export function verifiedChunkBlocks(tiles: readonly Cell[]): { bases: ReadonlyMap<number, number>; blockIds: ReadonlyMap<number, number> } | null {
  const chunks = indexOf(tiles).chunks;
  return chunks ? { bases: chunks.bases, blockIds: chunks.blockIds } : null;
}

/** Misma respuesta que `new Map(tiles.map(t => [`${t.x},${t.y}`, t])).get(`${x},${y}`)`. */
export function lastTileAt<T extends Cell>(tiles: readonly T[], x: unknown, y: unknown): T | undefined {
  const index = indexOf(tiles);
  if (typeof x === 'number' && typeof y === 'number') {
    if (index.chunks) return blocksGet(index.raw, index.chunks, index.length, x, y) as T | undefined;
    if (index.grid) return gridGet(index.grid, x, y) as T | undefined;
  }
  return (index.strings ?? stringIndex(index.raw, index)).get(`${x},${y}`) as T | undefined;
}

/** El índice VIGENTE al llamar, fijado: equivale a construir en ese momento
 * `new Map(tiles.map(t => [`${t.x},${t.y}`, t]))` y consultarlo con números (la fauna lo toma al
 * empezar su paso y, como antes, no ve teselas que se añadan después). */
export function tileLookup<T extends Cell>(tiles: readonly T[]): (x: number, y: number) => T | undefined {
  const index = indexOf(tiles), chunks = index.chunks, grid = index.grid;
  if (chunks) {
    // Caché local de 4 chunks: el disco de radio 7 de `choose` toca 1–4 chunks (2 × 2) y los
    // recorre por filas, así que el último chunk compartido de `blocksGet` volvía al `Map` en
    // cada fila y entre personas. Las bases no se mueven tras fijar la consulta (un chunk
    // añadido después tiene base ≥ `limit` y se rechaza igual), así que el resultado es el mismo.
    const raw = index.raw as readonly T[];
    const limit = index.length, bases = chunks.bases;
    let k1 = -1, b1 = -1, k2 = -1, b2 = -1, k3 = -1, b3 = -1, k4 = -1, b4 = -1;
    return (x, y) => {
      if (x !== (x | 0) || y !== (y | 0) || x < -GRID_LIMIT || x >= GRID_LIMIT || y < -GRID_LIMIT || y >= GRID_LIMIT) return undefined;
      const key = ((x >> 4) + BLOCK_OFFSET) * BLOCK_SPAN + ((y >> 4) + BLOCK_OFFSET);
      let base: number;
      if (key === k1) base = b1;
      else if (key === k2) base = b2;
      else if (key === k3) base = b3;
      else if (key === k4) base = b4;
      else { base = bases.get(key) ?? -1; k4 = k3; b4 = b3; k3 = k2; b3 = b2; k2 = k1; b2 = b1; k1 = key; b1 = base; }
      return base >= 0 && base < limit ? raw[base + (((y & 15) << 4) | (x & 15))] : undefined;
    };
  }
  if (grid) {
    const blocks = grid.blocks, others = grid.others;
    let k1 = -1, bl1: (Cell | undefined)[] | undefined, k2 = -1, bl2: (Cell | undefined)[] | undefined;
    return (x, y) => {
      if (x === (x | 0) && y === (y | 0) && x >= -GRID_LIMIT && x < GRID_LIMIT && y >= -GRID_LIMIT && y < GRID_LIMIT) {
        const key = ((x >> 4) + BLOCK_OFFSET) * BLOCK_SPAN + ((y >> 4) + BLOCK_OFFSET);
        let block: (Cell | undefined)[] | undefined;
        if (key === k1) block = bl1;
        else if (key === k2) block = bl2;
        else { block = blocks.get(key); k2 = k1; bl2 = bl1; k1 = key; bl1 = block; }
        return block?.[((y & 15) << 4) | (x & 15)] as T | undefined;
      }
      return others.get(x)?.get(y) as T | undefined;
    };
  }
  const strings = index.strings!;
  return (x, y) => strings.get(`${x},${y}`) as T | undefined;
}

/** Misma respuesta que `tiles.find(t => t.x === x && t.y === y)`. */
export function firstTileAt<T extends Cell>(tiles: readonly T[], x: number, y: number): T | undefined {
  // Las copias privadas de una previsión (`dependencyCraft`) llevan una sola tesela: indexarlas
  // costaría más que recorrerlas.
  const raw = tiles === memoTiles && memoIndex ? (memoIndex.raw as readonly T[]) : backingOf(tiles);
  if (raw.length < 64) return raw.find(t => t.x === x && t.y === y);
  const index = indexOf(tiles);
  if (typeof x !== 'number' || typeof y !== 'number') return raw.find(t => t.x === x && t.y === y);
  if (index.chunks) return blocksGet(index.raw, index.chunks, index.length, x, y) as T | undefined;
  if (index.duplicates || !index.grid) return raw.find(t => t.x === x && t.y === y);
  if (Number.isNaN(x) || Number.isNaN(y)) return undefined;
  return gridGet(index.grid, x, y) as T | undefined;
}

/** Claves de cadena pedidas con coordenadas que no son números (nunca en las leyes): se construyen
 * sólo entonces, con la misma regla de «gana la última». */
const stringIndexes = new WeakMap<TileIndex, Map<string, Cell>>();
function stringIndex(tiles: readonly Cell[], index: TileIndex): Map<string, Cell> {
  let strings = stringIndexes.get(index);
  if (!strings) { strings = new Map(tiles.map(t => [`${t.x},${t.y}`, t])); stringIndexes.set(index, strings); }
  return strings;
}
