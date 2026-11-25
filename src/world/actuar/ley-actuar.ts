/** INTERFAZ PUENTE del tick de las personas por intentos (carril act): el gancho con el motor. act rellena los ganchos:
 * con `v23.intentos`, F3 elige y F4 actúa para las personas propias del dueño, leyendo a los demás por el frente y
 * escribiéndoles por intento (motor/acceso.ts, DISCIPLINA DE DUEÑO). */
import type { Ley } from '../motor/acceso.js';

export const leyActuar: Ley = { id: 'act', interruptor: 'intentos', sustituye: ['personas', 'susurros'] };
