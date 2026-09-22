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
const slot = (x: number, y: number): number => ((y & 15) << 4) | (x & 15);
interface Grid {
  blocks: Map<number, (Cell | undefined)[]>;
  others: Map<number, Map<number, Cell>>;
  lastKey: number;
  lastBlock: (Cell | undefined)[] | undefined;
}
interface TileIndex {
  length: number;
  /** Modo numérico: última tesela de cada par de coordenadas; `null` si alguna no es número. */
  grid: Grid | null;
  /** Modo cadena: la clave `"x,y"` histórica. */
  strings: Map<string, Cell> | null;
  /** Hay dos teselas con las mismas coordenadas: `firstTileAt` recorre como `find`. */
  duplicates: boolean;
}
const indexes = new WeakMap<readonly Cell[], TileIndex>();

function gridGet(grid: Grid, x: number, y: number): Cell | undefined {
  if (inGrid(x) && inGrid(y)) {
    const key = blockKey(x, y);
    let block = grid.lastBlock;
    if (key !== grid.lastKey) { block = grid.blocks.get(key); grid.lastKey = key; grid.lastBlock = block; }
    return block?.[slot(x, y)];
  }
  return grid.others.get(x)?.get(y);
}

function build(tiles: readonly Cell[]): TileIndex {
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
  if (!numeric) return { length: tiles.length, grid: null, strings: new Map(tiles.map(t => [`${t.x},${t.y}`, t])), duplicates: true };
  return { length: tiles.length, grid, strings: null, duplicates };
}

function indexOf(tiles: readonly Cell[]): TileIndex {
  let index = indexes.get(tiles);
  if (!index || index.length !== tiles.length) { index = build(tiles); indexes.set(tiles, index); }
  return index;
}

/** Misma respuesta que `new Map(tiles.map(t => [`${t.x},${t.y}`, t])).get(`${x},${y}`)`. */
export function lastTileAt<T extends Cell>(tiles: readonly T[], x: unknown, y: unknown): T | undefined {
  const index = indexOf(tiles);
  if (index.grid && typeof x === 'number' && typeof y === 'number') return gridGet(index.grid, x, y) as T | undefined;
  return (index.strings ?? stringIndex(tiles, index)).get(`${x},${y}`) as T | undefined;
}

/** El índice VIGENTE al llamar, fijado: equivale a construir en ese momento
 * `new Map(tiles.map(t => [`${t.x},${t.y}`, t]))` y consultarlo con números (la fauna lo toma al
 * empezar su paso y, como antes, no ve teselas que se añadan después). */
export function tileLookup<T extends Cell>(tiles: readonly T[]): (x: number, y: number) => T | undefined {
  const index = indexOf(tiles), grid = index.grid;
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
  if (index.duplicates || !index.grid || typeof x !== 'number' || typeof y !== 'number') return tiles.find(t => t.x === x && t.y === y);
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
