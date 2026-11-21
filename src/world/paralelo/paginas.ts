/**
 * Tabla hash de páginas 16 × 16 que comparten los motores de personas y de fauna (empaquetador y
 * workers). Sin dependencias: se puede importar desde un worker.
 */

export const LADO_PAGINA = 16;
export const CELDAS_POR_PAGINA = LADO_PAGINA * LADO_PAGINA;

export interface TablaPaginas {
  paginasX: Int32Array; paginasY: Int32Array; paginasSlot: Int32Array;
  params: { hashMask: number };
}

export const siguientePotencia = (n: number): number => { let p = 1; while (p < n) p *= 2; return p; };
/** Capacidad que cubre `necesario`, creciendo al menos al doble (la misma si ya cabe). */
export const crecerCapacidad = (actual: number, necesario: number): number => necesario > actual ? Math.max(necesario, actual * 2) : actual;
/** Clave de `Map` de una página en [-2^21, 2^21) por eje (cabe en 2^44). */
export const clavePagina = (px: number, py: number): number => (px + 0x200000) * 0x400000 + (py + 0x200000);

/** Hash de página determinista (enteros de 32 bits). */
export function hashPagina(px: number, py: number, mask: number): number {
  let h = Math.imul(px, 0x9e3779b1) ^ Math.imul(py ^ 0x5bd1e995, 0x85ebca77);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return h & mask;
}

/** Ranura de la página `(px, py)` o −1 si no está cargada. */
export function buscarPagina(tabla: TablaPaginas, px: number, py: number): number {
  const mask = tabla.params.hashMask;
  for (let h = hashPagina(px, py, mask); ; h = (h + 1) & mask) {
    const slot = tabla.paginasSlot[h]!;
    if (slot < 0) return -1;
    if (tabla.paginasX[h] === px && tabla.paginasY[h] === py) return slot;
  }
}

/** Inserta la página `slot` = `(pagX[slot], pagY[slot])` con sondeo lineal; `capHash` es potencia de 2. */
export function llenarTablaPaginas(tabla: Omit<TablaPaginas, 'params'>, pagX: readonly number[], pagY: readonly number[], capHash: number): void {
  const { paginasX, paginasY, paginasSlot } = tabla, mask = capHash - 1;
  paginasSlot.fill(-1, 0, capHash);
  for (let slot = 0; slot < pagX.length; slot++) {
    let h = hashPagina(pagX[slot]!, pagY[slot]!, mask);
    while (paginasSlot[h]! >= 0) h = (h + 1) & mask;
    paginasX[h] = pagX[slot]!; paginasY[h] = pagY[slot]!; paginasSlot[h] = slot;
  }
}
