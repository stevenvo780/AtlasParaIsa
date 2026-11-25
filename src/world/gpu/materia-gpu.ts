/**
 * INTERFAZ PUENTE del paso material en la tarjeta (carril g). El esqueleto lo fijó la preparación de la oleada: g
 * rellena los cuerpos y puede añadir exportaciones, pero no cambia estas firmas (las consume w).
 *
 * La tarjeta nunca es autoridad: recibe una copia de los lotes, devuelve cuántas veces aplicar cada reacción y la CPU
 * las aplica con `ArenaMateria.aplicar` (así el libro y el recorte a existencias siguen siendo los de la arena). Si
 * falla o vence el plazo lanza `ErrorDispositivo` y w da ese paso en CPU en el mismo tick.
 */
import { sinImplementar } from '../motor/acceso.js';
import type { CanalGpu } from '../motor/contratos.js';
import type { CtxPaso } from '../materia/paso.js';
import type { LoteRef } from '../materia/tipos.js';

/** Resultado de un lote de pasos: por cada lote de entrada, a partir de `desde[i]`, tripletas (a, b, veces) de las
 * reacciones que la CPU debe aplicar en ese orden (la reacción se relee de la química con el nivel del lote). */
export interface VecesGpu { desde: Int32Array; tripletas: Float64Array }

export interface PasoMateriaGpu {
  /** Sube los lotes (composición, calor, κ con paso 4) y lanza el kernel con la misma semántica que `pasoLote`
   * (materia.cierre2, «G, kernel GPU»). No bloquea. */
  lanzar(c: CtxPaso, lotes: ArrayLike<LoteRef>, kappas: ArrayLike<number>, dt: number, tick: number): void;
  /** Espera el resultado del último `lanzar`. `ErrorDispositivo` si vence el plazo, cae el servidor o el eco de tick no
   * casa. */
  esperar(plazoMs: number): VecesGpu;
  cerrar(): void;
}

export function crearPasoMateriaGpu(canal: CanalGpu): PasoMateriaGpu { return sinImplementar('g: crearPasoMateriaGpu'); }
