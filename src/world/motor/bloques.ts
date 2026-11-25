/**
 * Reparto de chunks entre dueños en tramos contiguos del orden Morton (carril m4a; ARQ-motor §3.8). Funciones puras:
 * el coordinador las usa al abrir una época y al dar dueño a un chunk nuevo; el reparto por coste medido es de m7
 * (`motor/rebalanceo.ts`) y entra por aquí cuando `v23.rebalanceo` está encendido.
 */
import { mortonCode } from '../soa/morton.js';

/** Índices de los chunks (posiciones en `px` y `py`) en orden Morton de su página. */
export function ordenMorton(px: ArrayLike<number>, py: ArrayLike<number>): Int32Array {
  const n = px.length, codigos = Array.from({ length: n }, (_, i) => mortonCode(px[i]!, py[i]!));
  return Int32Array.from({ length: n }, (_, i) => i).sort((a, b) => codigos[a]! < codigos[b]! ? -1 : codigos[a]! > codigos[b]! ? 1 : 0);
}

/**
 * Corta el orden Morton en `hilos` tramos contiguos de peso parecido y devuelve el dueño de cada chunk (alineado con
 * `px`). Sin `peso`, todos pesan lo mismo; un peso no positivo cuenta como la media de los positivos (un chunk recién
 * activado aún no tiene coste). Cada chunk va al tramo donde cae su punto medio, así que un chunk muy pesado no parte
 * el tramo de sus vecinos.
 */
export function repartirPorTramos(px: ArrayLike<number>, py: ArrayLike<number>, hilos: number, peso?: ArrayLike<number>): Int16Array {
  if (!Number.isSafeInteger(hilos) || hilos < 1 || hilos > 0x7fff) throw new RangeError(`Cantidad de dueños inválida: ${hilos}.`);
  const n = px.length, dueno = new Int16Array(n);
  if (n === 0 || hilos === 1) return dueno;
  let suma = 0, positivos = 0;
  if (peso) for (let i = 0; i < n; i++) if (peso[i]! > 0) { suma += peso[i]!; positivos++; }
  const medio = positivos ? suma / positivos : 1;
  const de = (i: number): number => peso && peso[i]! > 0 ? peso[i]! : medio;
  let total = 0;
  for (let i = 0; i < n; i++) total += de(i);
  let acumulado = 0;
  for (const i of ordenMorton(px, py)) {
    const w = de(i);
    dueno[i] = Math.min(hilos - 1, Math.floor((acumulado + w / 2) / total * hilos));
    acumulado += w;
  }
  return dueno;
}

/**
 * Dueño de un chunk que se activa: el del chunk residente más cercano (distancia de Chebyshev en páginas), para que
 * caiga en el tramo de sus vecinos sin rehacer el reparto. `pedido` desempata y vale si no hay ninguno (el dueño de la
 * persona cuyo halo lo pide). El siguiente rebalanceo lo recoloca si hace falta.
 */
export function duenoDeVecino(cx: number, cy: number, px: ArrayLike<number>, py: ArrayLike<number>, dueno: ArrayLike<number>, pedido: number): number {
  let mejor = pedido, distancia = Infinity;
  for (let i = 0; i < px.length; i++) {
    if (dueno[i]! < 0) continue;
    const d = Math.max(Math.abs(px[i]! - cx), Math.abs(py[i]! - cy));
    if (d < distancia || (d === distancia && dueno[i] === pedido)) { distancia = d; mejor = dueno[i]!; }
  }
  return mejor;
}

/** Cuántos chunks tiene cada dueño en un reparto. */
export function cuentaPorDueno(dueno: ArrayLike<number>, hilos: number): Int32Array {
  const cuenta = new Int32Array(hilos);
  for (let i = 0; i < dueno.length; i++) if (dueno[i]! >= 0) cuenta[dueno[i]!]!++;
  return cuenta;
}
