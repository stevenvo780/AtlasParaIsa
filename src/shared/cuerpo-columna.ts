/**
 * La columna binaria del fotograma trae masa, sustancia principal, carga y temperatura.
 * Un cuerpo lento ya proyectado se actualiza con esos números. Sin él, solo se arma cuerpo
 * si la columna trae una observación (sustancia, masa, carga o temperatura por encima de cero).
 * Ceros en una columna muda no fabrican un cuerpo de 0 kg.
 */
import type { CuerpoVisible } from './vistas-v23.js';

export interface ColumnaCuerpo {
  masa: number;
  principal: number;
  /** Ausente = el esquema de ese fotograma no tenía el campo. */
  carga?: number;
  T?: number;
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function cuerpoDeColumna(base: CuerpoVisible | undefined, col: ColumnaCuerpo): CuerpoVisible | undefined {
  if (base) {
    return {
      ...base,
      ...(fin(col.masa) ? { masa: col.masa } : {}),
      ...(col.principal > 0 ? { principal: col.principal } : {}),
      ...(fin(col.carga) ? { carga: col.carga } : {}),
      ...(fin(col.T) ? { T: col.T } : {}),
    };
  }
  const senal = col.principal > 0 || (fin(col.masa) && col.masa > 0) || (fin(col.carga) && col.carga > 0) || (fin(col.T) && col.T > 0);
  if (!senal) return undefined;
  const out: Partial<CuerpoVisible> = {};
  if (fin(col.masa)) out.masa = col.masa;
  if (col.principal > 0) out.principal = col.principal;
  if (fin(col.carga)) out.carga = col.carga;
  if (fin(col.T)) out.T = col.T;
  return out as CuerpoVisible;
}
