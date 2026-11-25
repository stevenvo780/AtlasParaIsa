/**
 * INTERFAZ PUENTE del campo de alarma por celda (carril f; leyes-opus §2 y §3e): una muerte violenta lo sube en su
 * celda y decae solo. Sustituye a `alarmHerd`. f rellena los cuerpos; lo leen la fauna (miedo) y act (caza).
 */
import { sinImplementar, type CtxLey } from '../motor/acceso.js';

/** Alarma en [0, ∞) de una celda residente, propia o ajena (lectura por `c.terreno`, un tick atrás si es ajena). */
export function alarmaEn(c: CtxLey, celda: number): number { return sinImplementar('f: alarmaEn'); }
/** Sube la alarma de una celda PROPIA (en una ajena, el dueño la sube al aplicar el `Golpear` que mata). */
export function subirAlarma(c: CtxLey, celda: number, cuanto: number): void { return sinImplementar('f: subirAlarma'); }
