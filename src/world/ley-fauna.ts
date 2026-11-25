/** INTERFAZ PUENTE de la fauna sobre átomos (carril f): el gancho con el motor. f rellena los ganchos. */
import type { Ley } from './motor/acceso.js';

export const leyFauna: Ley = { id: 'f', interruptor: 'fauna', sustituye: ['fauna'] };
