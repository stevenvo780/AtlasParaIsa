/**
 * M10: regiones vivas frente a zonas en reposo. El servidor manda en `regionesVivas` las regiones de
 * 16 × 16 casillas que simula dentro de la ventana; lo demás es estado guardado o vista previa. Puro.
 */
import type { WorldView } from '../shared/types.js';

/** Lado de una región en casillas (`CHUNK_SIZE` de world/terrain.ts; fijado por prueba). */
export const LADO_REGION = 16;
export const claveRegion = (x: number, y: number): string => `${Math.floor(x / LADO_REGION)},${Math.floor(y / LADO_REGION)}`;

/** true = la casilla está en una región en reposo; false = viva; null = el servidor no lo dijo. */
export function enReposo(view: Pick<WorldView, 'regionesVivas'> | null | undefined, x: number, y: number): boolean | null {
  if (!view?.regionesVivas) return null;
  return !view.regionesVivas.includes(claveRegion(x, y));
}
