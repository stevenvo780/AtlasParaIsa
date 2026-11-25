/**
 * INTERFAZ PUENTE del reparto de chunks entre dueños por tiempo de pared (carril m7; ARQ-motor §3.8). El esqueleto lo
 * fijó la preparación de la oleada: m7 rellena los cuerpos y puede añadir exportaciones, pero no cambia estas firmas
 * (las consume m4a). Son funciones puras: se prueban sin motor.
 */
const sinImplementar = (que: string): never => { throw new Error(`sin implementar: ${que}`); };

/** Lo que el coordinador mide y m7 lee: por chunk residente, su posición de página y la media móvil de los ms de pared
 * que costó a su dueño; por hilo, los ms de pared de su último tramo de ventanas. */
export interface MedidaReparto {
  chunks: Int32Array;      // ChunkId residentes
  px: Int32Array; py: Int32Array;
  costeMs: Float64Array;   // EMA por chunk, alineada con `chunks`
  dueno: Int16Array;       // dueño vigente de cada uno
  hiloMs: Float64Array;    // por hilo
}

/** Desequilibrio del reparto vigente: máximo de `hiloMs` sobre su media (1 = perfecto). */
export function desequilibrio(m: MedidaReparto): number { return sinImplementar('m7: desequilibrio'); }
/** Reparto nuevo: los chunks en orden Morton, cortados en `hilos` tramos contiguos de coste parecido, dando menos a
 * los hilos que la máquina está retrasando (`hiloMs` alto con el mismo coste asignado). Devuelve el dueño de cada chunk
 * de `m.chunks`. Un chunk recién activado (coste 0) cuenta con el coste medio. */
export function repartir(m: MedidaReparto, hilos: number): Int16Array { return sinImplementar('m7: repartir'); }
/** Si toca rebalancear en este tick, dado el historial de desequilibrios de las últimas ventanas. */
export function tocaRebalancear(tick: number, historial: readonly number[]): boolean { return sinImplementar('m7: tocaRebalancear'); }
/** `hilos: 'auto'`: cuántos dueños usar, dados los Hz medidos con cada número de hilos probado. */
export function hilosAuto(medidas: ReadonlyMap<number, number>, maximo: number): number { return sinImplementar('m7: hilosAuto'); }
