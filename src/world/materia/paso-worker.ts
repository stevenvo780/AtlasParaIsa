/**
 * Reparto de `pasoLote` entre hilos (carril P). Cada hilo avanza un tramo contiguo de la lista de lotes, así que los de
 * una misma página caen en el mismo hilo y, con dueños por chunk (ola 2), cada dueño pasa la lista de sus páginas.
 * La piscina es de M1: de ella solo se espera que llame en cada hilo a la función que devuelve `manejador` con los SAB del
 * despacho, `params` y el índice del hilo. Cómo se abre la arena de A y la química de Q en un hilo lo da `abrir`.
 */
import type { LoteRef } from './tipos.js';
import { pasoLote, type CtxPaso } from './paso.js';

/** Tramo [desde, hasta) del hilo `h` de `hilos` sobre `n` lotes: los primeros n mod hilos llevan uno más. */
export function tramo(n: number, hilos: number, h: number): [number, number] {
  const base = Math.floor(n / hilos), resto = n % hilos;
  const desde = h * base + Math.min(h, resto);
  return [desde, desde + base + (h < resto ? 1 : 0)];
}

/** Avanza dt los lotes [desde, hasta) de `lotes`; `kappas` lleva 3 por lote (C–O, C–N, C–C/C–H). Devuelve Σ veces. */
export function pasarLotes(c: CtxPaso, lotes: ArrayLike<LoteRef>, kappas: ArrayLike<number>,
  desde: number, hasta: number, dt: number): number {
  const kappa: [number, number, number] = [0, 0, 0];
  let total = 0;
  for (let i = desde; i < hasta; i++) {
    kappa[0] = kappas[3 * i]!; kappa[1] = kappas[3 * i + 1]!; kappa[2] = kappas[3 * i + 2]!;
    total += pasoLote(c, lotes[i]!, dt, kappa);
  }
  return total;
}

/** Lo que lleva un despacho: SAB `lotes` (Float64, n) y `kappas` (Float64, 3·n); dt y cuántos hilos se reparten. */
export interface TrabajoPaso {
  buffers: { lotes: SharedArrayBuffer; kappas: SharedArrayBuffer } & Record<string, SharedArrayBuffer>;
  params: { n: number; dt: number; hilos: number };
  workerIndex: number;
}

/** Función por hilo para la piscina. `abrir` se llama una vez por hilo, con el primer despacho. */
export function manejador(abrir: (t: TrabajoPaso) => CtxPaso): (t: TrabajoPaso) => number {
  let c: CtxPaso | null = null;
  return t => {
    c ??= abrir(t);
    const [desde, hasta] = tramo(t.params.n, t.params.hilos, t.workerIndex);
    return pasarLotes(c, new Float64Array(t.buffers.lotes), new Float64Array(t.buffers.kappas), desde, hasta, t.params.dt);
  };
}
