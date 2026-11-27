/**
 * Una reacción que `ArenaMateria.aplicar` ejecutó de verdad. No se infiere de una fórmula ni de
 * comparar dos fotos. Ausente en la vista = este fotograma no trae la observación.
 */
export interface ReaccionObservada {
  /** Paso del mundo en que se aplicó. */
  tick: number;
  /** Veces que esa aplicación consumió. */
  veces: number;
  /** Sustancia de entrada. `b === 0` es unaria. */
  a: number;
  b: number;
  nivel: number;
  /** Lote en el que corrió. Alcance: ese lote, no la casa ni el mundo entero. */
  lote: number;
}
