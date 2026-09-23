/**
 * Geometría del SoA de terreno (T112). La región de 256 × 256 celdas es la unidad de partición
 * (T115 reparte regiones, T117 compara por región); dentro de ella la unidad de almacenamiento es
 * la PÁGINA de 16 × 16 = un chunk (`CHUNK_SIZE`), porque el conjunto activo se activa y se retira
 * por chunks. Una región no guarda un buffer denso de 65 536 celdas por campo: guarda una tabla de
 * sus 256 páginas → ranura de la arena (`arena.ts`), y cada campo es un buffer por ranura. Así un
 * mundo disperso (unos pocos chunks en cuatro regiones alrededor del origen) no reserva memoria
 * para celdas que no existen, y el vecino de una celda en otra región se lee del mismo buffer.
 *
 * Las coordenadas NO se almacenan: la celda `ranura · 256 + offset` está en
 * `(paginaX · 16 + offset % 16, paginaY · 16 + ⌊offset / 16⌋)`, con `(paginaX, paginaY)` el chunk
 * de la ranura, que a su vez es `(regionX · 16 + página % 16, regionY · 16 + ⌊página / 16⌋)`.
 */
export const PAGE_SIDE = 16;
export const PAGE_CELLS = PAGE_SIDE * PAGE_SIDE;
export const REGION_SIDE = 256;
export const REGION_PAGES = (REGION_SIDE / PAGE_SIDE) ** 2;
/** Dominio aritmético: enteros en [-2^30, 2^30), para que `x ± 1` y los desplazamientos de bits sigan en
 * int32. Contiene de sobra `MAX_COORDINATE` (10^7); cualquier otra coordenada se queda en el camino de
 * objetos. */
export const SOA_COORDINATE_LIMIT = 2 ** 30;
export const admissibleCoordinate = (v: number): boolean => (v | 0) === v && v >= -SOA_COORDINATE_LIMIT && v < SOA_COORDINATE_LIMIT;

/** Chunk (página global) de una coordenada admitida: `⌊v / 16⌋` también para negativos. */
export const pageOf = (v: number): number => v >> 4;
/** Offset de la celda dentro de su página, fila mayor. */
export const pageOffset = (x: number, y: number): number => ((y & 15) << 4) | (x & 15);
/** Offset de la celda dentro de su región de 256 × 256, fila mayor. */
export const regionOffset = (x: number, y: number): number => ((y & 255) << 8) | (x & 255);
/** Clave numérica e inyectiva de la región que contiene el chunk `(pageX, pageY)`. */
const REGION_BIAS = 2 ** 23, REGION_SPAN = 2 ** 24;
export const regionKey = (pageX: number, pageY: number): number => ((pageX >> 4) + REGION_BIAS) * REGION_SPAN + ((pageY >> 4) + REGION_BIAS);
/** Página dentro de su región (0‥255), fila mayor. */
export const pageInRegion = (pageX: number, pageY: number): number => ((pageY & 15) << 4) | (pageX & 15);

/** Tabla de páginas de una región: página en región → ranura de la arena, `-1` si no está reservada. */
export interface Region { readonly regionX: number; readonly regionY: number; readonly slots: Int32Array; used: number; }

/** Regiones por clave numérica (sin cadenas), con la última consultada a mano: el conjunto activo llega
 * en rachas de 256 teselas del mismo chunk. */
export class RegionTable {
  private readonly regions = new Map<number, Region>();
  private lastKey = Number.NaN;
  private last: Region | undefined;

  get size(): number { return this.regions.size; }
  get bytes(): number { return this.regions.size * REGION_PAGES * Int32Array.BYTES_PER_ELEMENT; }

  region(pageX: number, pageY: number, create: boolean): Region | undefined {
    const key = regionKey(pageX, pageY);
    if (key === this.lastKey && (this.last || !create)) return this.last;
    let region = this.regions.get(key);
    if (!region && create) {
      region = { regionX: pageX >> 4, regionY: pageY >> 4, slots: new Int32Array(REGION_PAGES).fill(-1), used: 0 };
      this.regions.set(key, region);
    }
    this.lastKey = key; this.last = region;
    return region;
  }

  /** Ranura del chunk `(pageX, pageY)`, `-1` si no tiene. */
  slot(pageX: number, pageY: number): number {
    return this.region(pageX, pageY, false)?.slots[pageInRegion(pageX, pageY)] ?? -1;
  }

  assign(pageX: number, pageY: number, slot: number): void {
    const region = this.region(pageX, pageY, true)!;
    region.slots[pageInRegion(pageX, pageY)] = slot; region.used++;
  }

  release(pageX: number, pageY: number): void {
    const region = this.region(pageX, pageY, false);
    if (!region) return;
    region.slots[pageInRegion(pageX, pageY)] = -1;
    if (--region.used === 0) { this.regions.delete(regionKey(pageX, pageY)); this.lastKey = Number.NaN; this.last = undefined; }
  }

  /** Regiones en orden `(regionY, regionX)`: el orden por contenido que usarán las colas de T115. */
  ordered(): Region[] {
    return [...this.regions.values()].sort((a, b) => a.regionY - b.regionY || a.regionX - b.regionX);
  }
}
