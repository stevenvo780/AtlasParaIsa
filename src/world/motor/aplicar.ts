/**
 * INTERFAZ PUENTE del aplicador de intentos (carril m5; ARQ-motor §3.2). El esqueleto lo fijó la preparación de la
 * oleada: m5 rellena los cuerpos y puede añadir exportaciones, pero no cambia estas firmas (las consume m4a).
 *
 * El dueño destino aplica cada intento contra su estado actual. Orden de resolución de un intento: los `Ley.aplicar`
 * de las leyes encendidas, en el orden de `LEYES`, hasta que una devuelva 'hecho' o 'rechazo'; si todas pasan, el
 * aplicador genérico de la materia (Tomar, Depositar, Dar, Concedido y Devuelto sobre lotes, con recorte a existencias).
 * Toda garantía termina en ≤ 2 ticks: abonada, devuelta al emisor o depositada en el Suelo (I-B). Un (nonce, tipo) ya
 * aplicado no se repite.
 */
import { sinImplementar, type CtxLey, type Ley } from './acceso.js';
import type { Cola } from './contratos.js';

/** Encuentros y reparto entre personas por intentos (los pasos heredados `encounters` y `share`). */
export const leyInteracciones: Ley = { id: 'm5', interruptor: 'intentos', sustituye: ['encuentros'] };

/** Vacía una cola de este dueño ('M' y 'B' en F1, 'A' en F5) y aplica cada intento. Devuelve cuántos aplicó. */
export function aplicarCola(c: CtxLey, cola: Cola): number { return sinImplementar('m5: aplicarCola'); }
