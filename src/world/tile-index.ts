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
interface Cell { x: number; y: number; }
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
}
/** Disposición por chunks: bloque → posición de su primera tesela, en orden creciente de posición.
 * Cada bloque está una sola vez y sus 256 teselas tienen exactamente las coordenadas de su casilla,
 * así que no hay repetidas ni coordenadas fuera de la rejilla. */
interface Blocks { bases: Map<number, number>; lastKey: number; lastBase: number; }
interface TileIndex {
  length: number;
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

function gridGet(grid: Grid, x: number, y: number): Cell | undefined {
  if (inGrid(x) && inGrid(y)) {
    const key = blockKey(x, y);
    let block = grid.lastBlock;
    if (key !== grid.lastKey) { block = grid.blocks.get(key); grid.lastKey = key; grid.lastBlock = block; }
    return block?.[slot(x, y)];
  }
  return grid.others.get(x)?.get(y);
}

/** `limit`: longitud del arreglo cuando se fijó la consulta; un bloque añadido después no existe para ella. */
function blocksGet(tiles: readonly Cell[], chunks: Blocks, limit: number, x: number, y: number): Cell | undefined {
  if (!inGrid(x) || !inGrid(y)) return undefined;
  const key = blockKey(x, y);
  let base = chunks.lastBase;
  if (key !== chunks.lastKey) { base = chunks.bases.get(key) ?? -1; chunks.lastKey = key; chunks.lastBase = base; }
  return base >= 0 && base < limit ? tiles[base + slot(x, y)] : undefined;
}

/** Comprueba que `tiles[from…]` son bloques completos y nuevos y los anota en `added`; `false` si no. */
function readBlocks(tiles: readonly Cell[], from: number, known: Map<number, number>, added: Map<number, number>): boolean {
  if ((tiles.length - from) % BLOCK !== 0) return false;
  for (let base = from; base < tiles.length; base += BLOCK) {
    const first = tiles[base];
    if (first == null) return false;
    const x0 = first.x, y0 = first.y;
    if (typeof x0 !== 'number' || typeof y0 !== 'number' || !inGrid(x0) || !inGrid(y0) || (x0 & 15) !== 0 || (y0 & 15) !== 0) return false;
    const key = blockKey(x0, y0);
    if (known.has(key) || added.has(key)) return false;
    for (let s = 1; s < BLOCK; s++) {
      const tile = tiles[base + s];
      if (tile == null || tile.x !== x0 + (s & 15) || tile.y !== y0 + (s >> 4)) return false;
    }
    added.set(key, base);
  }
  return true;
}

function build(tiles: readonly Cell[]): TileIndex {
  fullBuilds++;
  const bases = new Map<number, number>();
  if (readBlocks(tiles, 0, new Map(), bases)) return { length: tiles.length, chunks: { bases, lastKey: -1, lastBase: -1 }, grid: null, strings: null, duplicates: false };
  const grid: Grid = { blocks: new Map(), others: new Map(), lastKey: -1, lastBlock: undefined };
  let duplicates = false, numeric = true;
  // `forEach` salta los huecos igual que el `tiles.map` del índice original; gana la última tesela.
  tiles.forEach(tile => {
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
  if (!numeric) return { length: tiles.length, chunks: null, grid: null, strings: new Map(tiles.map(t => [`${t.x},${t.y}`, t])), duplicates: true };
  return { length: tiles.length, chunks: null, grid, strings: null, duplicates };
}

function indexOf(tiles: readonly Cell[]): TileIndex {
  let index = indexes.get(tiles);
  if (!index || index.length !== tiles.length) { index = build(tiles); indexes.set(tiles, index); }
  return index;
}

/** `activate` acaba de añadir `tiles[from…]` (un chunk). Si el índice vigente es aritmético y lo añadido
 * son bloques completos, se anotan sin recorrer el resto; si no, se descarta y la próxima consulta lo
 * reconstruye como siempre. Las consultas fijadas antes no ven lo añadido (`limit`). */
export function tileIndexAppended(tiles: readonly Cell[], from: number): void {
  const index = indexes.get(tiles);
  if (!index || index.length !== from) return;
  const added = new Map<number, number>();
  if (!index.chunks || !readBlocks(tiles, from, index.chunks.bases, added)) { indexes.delete(tiles); return; }
  for (const [key, base] of added) index.chunks.bases.set(key, base);
  index.chunks.lastKey = -1;
  index.length = tiles.length;
  stringIndexes.delete(index);
}

/** `copy` acaba de salir de `source.map(t => ({ ...t }))`: mismas coordenadas en las mismas posiciones.
 * Hereda la disposición de `source` sin volver a leer cada tesela (sólo el origen de cada bloque, como
 * resguardo); sin disposición vigente en `source`, no hace nada y la primera consulta construye. Es el
 * gancho que `cloneWorld` y `puntoDeRestauracion` necesitan para no pagar un recorrido por paso. */
export function tileIndexCopied(copy: readonly Cell[], source: readonly Cell[]): void {
  const index = indexes.get(source);
  if (!index?.chunks || index.length !== source.length || copy.length !== source.length) return;
  for (const [key, base] of index.chunks.bases) {
    const first = copy[base];
    if (first == null || !inGrid(first.x) || !inGrid(first.y) || (first.x & 15) !== 0 || (first.y & 15) !== 0 || blockKey(first.x, first.y) !== key) return;
  }
  indexes.set(copy, { length: copy.length, chunks: { bases: new Map(index.chunks.bases), lastKey: -1, lastBase: -1 }, grid: null, strings: null, duplicates: false });
}

/** Reparto de `maintainRegions` por bloques: cada chunk va entero a `destination(primera tesela)` o se
 * queda, en el orden del arreglo, igual que repartir tesela a tesela; el arreglo nuevo hereda la
 * disposición sin recorrer teselas. `null` si `tiles` no tiene disposición por chunks. */
export function splitTileBlocks<T extends Cell>(tiles: readonly T[], destination: (first: T) => T[] | undefined): T[] | null {
  const chunks = indexOf(tiles).chunks;
  if (!chunks) return null;
  const kept: T[] = [], bases = new Map<number, number>();
  for (const [key, base] of chunks.bases) {
    const target = destination(tiles[base]!);
    if (!target) bases.set(key, kept.length);
    const to = target ?? kept;
    for (let i = base; i < base + BLOCK; i++) to.push(tiles[i]!);
  }
  indexes.set(kept, { length: kept.length, chunks: { bases, lastKey: -1, lastBase: -1 }, grid: null, strings: null, duplicates: false });
  return kept;
}

/** Misma respuesta que `new Map(tiles.map(t => [`${t.x},${t.y}`, t])).get(`${x},${y}`)`. */
export function lastTileAt<T extends Cell>(tiles: readonly T[], x: unknown, y: unknown): T | undefined {
  const index = indexOf(tiles);
  if (typeof x === 'number' && typeof y === 'number') {
    if (index.chunks) return blocksGet(tiles, index.chunks, index.length, x, y) as T | undefined;
    if (index.grid) return gridGet(index.grid, x, y) as T | undefined;
  }
  return (index.strings ?? stringIndex(tiles, index)).get(`${x},${y}`) as T | undefined;
}

/** El índice VIGENTE al llamar, fijado: equivale a construir en ese momento
 * `new Map(tiles.map(t => [`${t.x},${t.y}`, t]))` y consultarlo con números (la fauna lo toma al
 * empezar su paso y, como antes, no ve teselas que se añadan después). */
export function tileLookup<T extends Cell>(tiles: readonly T[]): (x: number, y: number) => T | undefined {
  const index = indexOf(tiles), chunks = index.chunks, grid = index.grid;
  if (chunks) { const limit = index.length; return (x, y) => blocksGet(tiles, chunks, limit, x, y) as T | undefined; }
  if (grid) return (x, y) => gridGet(grid, x, y) as T | undefined;
  const strings = index.strings!;
  return (x, y) => strings.get(`${x},${y}`) as T | undefined;
}

/** Misma respuesta que `tiles.find(t => t.x === x && t.y === y)`. */
export function firstTileAt<T extends Cell>(tiles: readonly T[], x: number, y: number): T | undefined {
  // Las copias privadas de una previsión (`dependencyCraft`) llevan una sola tesela: indexarlas
  // costaría más que recorrerlas.
  if (tiles.length < 64) return tiles.find(t => t.x === x && t.y === y);
  const index = indexOf(tiles);
  if (typeof x !== 'number' || typeof y !== 'number') return tiles.find(t => t.x === x && t.y === y);
  if (index.chunks) return blocksGet(tiles, index.chunks, index.length, x, y) as T | undefined;
  if (index.duplicates || !index.grid) return tiles.find(t => t.x === x && t.y === y);
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
