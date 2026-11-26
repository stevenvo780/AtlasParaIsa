import { types } from 'node:util';
import type { Tile } from '../../shared/types.js';
import { ANCHO_TESELA, SNAPSHOT_TILE_FIELDS, encodeSnapshotTileRows, materializarTuplaTesela, rocaValida } from '../teselas-snapshot.js';
import type { ParteMundo } from './reunir.js';

export interface BloqueTeselasCorte {
  readonly filas: number;
  readonly cuerpo: Uint8Array;
  /** Por fila afectada, su índice seguido de 16 bits para las claves propias con valor undefined. */
  readonly ausenciasPropias?: readonly number[];
}

export interface TramoTeselasVerificadas {
  readonly desde: number;
  readonly filas: readonly string[];
}

export interface TeselasCorteVerificadas {
  readonly tramos: readonly TramoTeselasVerificadas[];
  readonly modificadas: ReadonlySet<Tile>;
}

const verificadas = new WeakMap<readonly Tile[], TeselasCorteVerificadas>();
const FILAS_POR_BLOQUE = 4096, BYTES_POR_BLOQUE = 4 * 1024 * 1024;
const CAMPOS_REQUERIDOS = 6;
const RANGO_MASCARA = 2 ** (SNAPSHOT_TILE_FIELDS.length - CAMPOS_REQUERIDOS);
const indices = new Map<string, number>(SNAPSHOT_TILE_FIELDS.map((campo, i) => [campo, i]));
const utf8 = new TextEncoder();
const utf8Estricto = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function vincularTeselasVerificadas(tiles: readonly Tile[], datos: TeselasCorteVerificadas): void {
  verificadas.set(tiles, datos);
}

export function teselasVerificadasDe(tiles: readonly Tile[]): TeselasCorteVerificadas | undefined {
  return verificadas.get(tiles);
}

export function tomarTeselasVerificadas(tiles: readonly Tile[]): TeselasCorteVerificadas | undefined {
  const datos = verificadas.get(tiles);
  verificadas.delete(tiles);
  return datos;
}

type CampoTesela = typeof SNAPSHOT_TILE_FIELDS[number];
type CampoOpcional = { [K in CampoTesela]: undefined extends Tile[K] ? K : never }[CampoTesela];
const camposOpcionales = SNAPSHOT_TILE_FIELDS.slice(CAMPOS_REQUERIDOS) as CampoOpcional[];
type Catalogos = { [K in CampoTesela as NonNullable<Tile[K]> extends string ? K : never]: Record<NonNullable<Tile[K]> & string, true> };
const catalogos = {
  terrain: { water: true, soil: true, meadow: true, shelter: true },
  biome: { grassland: true, forest: true, desert: true, mountain: true, wetland: true, ocean: true },
  feature: { tree: true, pine: true, palm: true, cactus: true, reeds: true, berries: true, flowers: true, rock: true,
    clay: true, stump: true, spring: true, pool: true, none: true },
  species: { hare: true, deer: true, boar: true, fish: true, wolf: true, fox: true },
} satisfies Catalogos;

function escalarValido(campo: CampoTesela, valor: unknown): boolean {
  switch (campo) {
    case 'terrain': case 'biome': case 'feature': case 'species':
      return typeof valor === 'string' && Object.hasOwn(catalogos[campo], valor);
    default:
      return typeof valor === 'number' && Number.isFinite(valor) && !Object.is(valor, -0)
        && (campo !== 'rocaLatente' || rocaValida(valor));
  }
}

function descriptorDato(objeto: object, clave: PropertyKey): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(objeto, clave);
  return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor : undefined;
}

function mascaraTeselaPlana(tile: unknown): number | undefined {
  if (typeof tile !== 'object' || tile === null || types.isProxy(tile) || Object.getPrototypeOf(tile) !== Object.prototype) return undefined;
  // V8 distingue varias marcas internas incluso si se reemplazó el prototipo del objeto.
  if (Array.isArray(tile) || types.isAnyArrayBuffer(tile) || ArrayBuffer.isView(tile) || types.isMap(tile)
    || types.isSet(tile) || types.isWeakMap(tile) || types.isWeakSet(tile) || types.isPromise(tile)
    || types.isBoxedPrimitive(tile) || types.isDate(tile) || types.isRegExp(tile) || types.isNativeError(tile)) return undefined;
  let requeridos = 0, mascara = 0;
  for (const clave of Reflect.ownKeys(tile)) {
    const i = typeof clave === 'string' ? indices.get(clave) : undefined;
    const descriptor = i === undefined ? undefined : descriptorDato(tile, clave);
    if (i === undefined || !descriptor) return undefined;
    const valor: unknown = descriptor.value;
    if (i < CAMPOS_REQUERIDOS) requeridos++;
    if (valor === undefined) {
      if (i < CAMPOS_REQUERIDOS) return undefined;
      mascara |= 1 << (i - CAMPOS_REQUERIDOS);
    } else if (!escalarValido(SNAPSHOT_TILE_FIELDS[i]!, valor)) return undefined;
  }
  return requeridos === CAMPOS_REQUERIDOS ? mascara : undefined;
}

/** El archivo es la otra rama con teselas en `ParteMundo`. Los dueños retiran cada chunk de las
 * filas activas al archivarlo. Si se detecta un alias, V8 debe mantenerlo durante `syncFauna`. */
function comparteConArchivo(archivo: unknown, vistos: WeakSet<object>): boolean {
  if (archivo === undefined) return false;
  if (types.isProxy(archivo) || !Array.isArray(archivo)) return true;
  for (let i = 0; i < archivo.length; i++) {
    const chunk: unknown = descriptorDato(archivo, i)?.value;
    if (typeof chunk !== 'object' || chunk === null || types.isProxy(chunk)) return true;
    const tiles: unknown = descriptorDato(chunk, 'tiles')?.value;
    if (types.isProxy(tiles) || !Array.isArray(tiles) || vistos.has(tiles)) return true;
    for (let j = 0; j < tiles.length; j++) {
      const descriptor = descriptorDato(tiles, j);
      if (!descriptor || vistos.has(descriptor.value)) return true;
    }
  }
  return false;
}

/** Prepara las filas WPG3 con los valores previos a la proyección de fauna del coordinador. */
export function prepararTeselasDirectas(parte: ParteMundo): BloqueTeselasCorte[] | undefined {
  if (types.isProxy(parte) || 'toJSON' in Array.prototype || SNAPSHOT_TILE_FIELDS.some(campo => campo in Object.prototype)) return undefined;
  const tiles: unknown = descriptorDato(parte, 'tiles')?.value;
  if (types.isProxy(tiles) || !Array.isArray(tiles) || Object.getPrototypeOf(tiles) !== Array.prototype
    || Reflect.ownKeys(tiles).length !== tiles.length + 1) return undefined;
  const vistos = new WeakSet<object>([tiles]);
  try {
    const bloques: BloqueTeselasCorte[] = [];
    for (let desde = 0; desde < tiles.length; desde += FILAS_POR_BLOQUE) {
      const filas = Math.min(FILAS_POR_BLOQUE, tiles.length - desde);
      const ausenciasPropias: number[] = [];
      for (let i = 0; i < filas; i++) {
        const tile = descriptorDato(tiles, desde + i)?.value as Tile;
        const mascara = mascaraTeselaPlana(tile);
        if (mascara === undefined || vistos.has(tile)) return undefined;
        vistos.add(tile);
        if (mascara) ausenciasPropias.push(i * RANGO_MASCARA + mascara);
      }
      const pagina = JSON.stringify(encodeSnapshotTileRows(tiles, desde, filas, true));
      // Las filas contienen exclusivamente escalares. «],[» solo puede separar dos tuplas.
      const cuerpo = utf8.encode(pagina.slice(1, -1).replaceAll('],[', ']\n['));
      if (cuerpo.byteLength > BYTES_POR_BLOQUE) return undefined;
      bloques.push(ausenciasPropias.length ? { filas, cuerpo, ausenciasPropias } : { filas, cuerpo });
    }
    for (const campo of Object.keys(parte)) {
      if (campo === 'tiles') continue;
      const descriptor = descriptorDato(parte, campo);
      if (!descriptor || vistos.has(descriptor.value)) return undefined;
    }
    // Los restantes subárboles del corte se construyen con identidades de organismos y registros
    // propios, y los puntos que guardan son coordenadas independientes de las teselas activas.
    if (comparteConArchivo(descriptorDato(parte, 'retiredChunks')?.value, vistos)) return undefined;
    return bloques;
  } catch {
    return undefined;
  }
}

/** La tupla durable usa null tanto para una clave ausente como para una propia con valor undefined. */
function restaurarAusenciasPropias(bloque: BloqueTeselasCorte, tiles: Tile[], desde: number): void {
  const { ausenciasPropias } = bloque;
  if (ausenciasPropias === undefined) return;
  if (!Array.isArray(ausenciasPropias) || !ausenciasPropias.length || ausenciasPropias.length > bloque.filas)
    throw new Error('Ausencias propias de teselas directas inválidas.');
  let anterior = -1;
  for (const codigo of ausenciasPropias) {
    const fila = Math.floor(codigo / RANGO_MASCARA), mascara = codigo % RANGO_MASCARA;
    if (!Number.isSafeInteger(codigo) || fila <= anterior || fila >= bloque.filas || !mascara)
      throw new Error('Ausencias propias de teselas directas inválidas.');
    const tile = tiles[desde + fila]!;
    for (let i = 0; i < camposOpcionales.length; i++) if (mascara & (1 << i)) {
      const campo = camposOpcionales[i]!;
      if (Object.hasOwn(tile, campo)) throw new Error('Ausencia propia de tesela directa contradice la tupla.');
      tile[campo] = undefined;
    }
    anterior = fila;
  }
}

/** Prueba el transporte y materializa las teselas en su orden original. Las filas quedan disponibles
 * para el escritor WPG3 por la identidad del array, sin volver a serializar las teselas intactas. */
export function recibirTeselasDirectas(bloques: readonly BloqueTeselasCorte[], cantidad: number): Tile[] {
  if (!Number.isSafeInteger(cantidad) || cantidad < 0 || cantidad > 0xffff_ffff || !Array.isArray(bloques))
    throw new Error('Rango de teselas directas inválido.');
  const tiles: Tile[] = [], tramos: TramoTeselasVerificadas[] = [];
  for (const bloque of bloques) {
    if (!Number.isSafeInteger(bloque?.filas) || bloque.filas <= 0 || bloque.filas > FILAS_POR_BLOQUE
      || bloque.filas > cantidad - tiles.length || !(bloque.cuerpo instanceof Uint8Array)
      || !(bloque.cuerpo.buffer instanceof ArrayBuffer) || bloque.cuerpo.byteOffset !== 0
      || bloque.cuerpo.byteLength !== bloque.cuerpo.buffer.byteLength || bloque.cuerpo.byteLength === 0
      || bloque.cuerpo.byteLength > BYTES_POR_BLOQUE) throw new Error('Bloque de teselas directas inválido.');
    const texto = utf8Estricto.decode(bloque.cuerpo);
    const filas = texto.split('\n', bloque.filas + 1);
    // Cada línea debe enmarcar una sola tupla plana. Así la posición de cada fila del JSON
    // parseado coincide con la de su texto, incluso si se recibió un bloque defectuoso.
    if (filas.length !== bloque.filas || filas.some(fila => !/^\[[^\[\]\s]+\]$/u.test(fila)))
      throw new Error('Filas de teselas directas inválidas.');
    const tuplas: unknown[] = JSON.parse(`[${filas.join(',')}]`);
    const desde = tiles.length;
    for (const tupla of tuplas) {
      if (!Array.isArray(tupla) || (tupla.length !== ANCHO_TESELA && tupla.length !== SNAPSHOT_TILE_FIELDS.length)
        || tupla.some((valor, i) => !(valor === null && i >= CAMPOS_REQUERIDOS && i < ANCHO_TESELA)
          && !escalarValido(SNAPSHOT_TILE_FIELDS[i]!, valor))) throw new Error('Tupla de tesela directa inválida.');
      tiles.push(materializarTuplaTesela(tupla));
    }
    restaurarAusenciasPropias(bloque, tiles, desde);
    tramos.push(Object.freeze({ desde, filas: Object.freeze(filas) }));
  }
  if (tiles.length !== cantidad) throw new Error('Cantidad de teselas directas inválida.');
  vincularTeselasVerificadas(tiles, { tramos: Object.freeze(tramos), modificadas: new Set<Tile>() });
  return tiles;
}
