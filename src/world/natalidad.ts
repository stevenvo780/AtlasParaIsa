/** INTERFAZ PUENTE de la natalidad pagada, sin cupo ni ventana (carril n). n rellena los ganchos: con `v23.natalidad`
 * sustituye a `reproduce` (el paso heredado 'reproduccion'). */
import type { Ley } from './motor/acceso.js';

export const leyNatalidad: Ley = { id: 'n', interruptor: 'natalidad', sustituye: ['reproduccion'] };
