import { stringifyExact } from '../../shared/exact-json.js';
import type { Animal } from '../animals.js';

export interface BloqueFaunaCorte {
  readonly filas: number;
  readonly cuerpo: Uint8Array;
}

export interface TramoFaunaCorte {
  readonly desde: number;
  readonly bloques: readonly BloqueFaunaCorte[];
}

const cortes = new WeakMap<readonly Animal[], readonly TramoFaunaCorte[]>();
const TAMANO_BLOQUE = 4 * 1024 * 1024;
const utf8 = new TextEncoder();

/** Las filas preparadas viven lo que vive el array de la instantánea. */
export function vincularFaunaCorte(animales: readonly Animal[], tramos: readonly TramoFaunaCorte[]): void {
  cortes.set(animales, tramos);
}

export function faunaCorteDe(animales: readonly Animal[]): readonly TramoFaunaCorte[] | undefined {
  return cortes.get(animales);
}

/** Una fila por línea, con el JSON exacto del guardado y un buffer transferible por bloque. */
export function prepararFaunaCorte(animales: readonly Animal[]): BloqueFaunaCorte[] {
  const bloques: BloqueFaunaCorte[] = [], filas: string[] = [];
  let bytes = 0;
  const volcar = (): void => {
    bloques.push({ filas: filas.length, cuerpo: utf8.encode(filas.join('\n')) });
    filas.length = 0;
    bytes = 0;
  };
  for (const animal of animales) {
    const fila = stringifyExact(animal);
    if (typeof fila !== 'string' || !fila.startsWith('{')) throw new Error('Fila de fauna inválida en el corte.');
    const tamano = Buffer.byteLength(fila);
    if (filas.length && bytes + 1 + tamano > TAMANO_BLOQUE) volcar();
    bytes += tamano + Number(filas.length > 0);
    filas.push(fila);
    if (bytes >= TAMANO_BLOQUE) volcar();
  }
  if (filas.length) volcar();
  return bloques;
}
