/**
 * INTERFAZ PUENTE: del fotograma binario del motor al `Corte` que graba la cinta (carril m6). El esqueleto lo fijó la
 * preparación de la oleada: m6 rellena los cuerpos y puede añadir exportaciones, pero no cambia estas firmas (las
 * consumen cinta, en `tape-worker.ts`, y srv).
 */
import type { Corte } from '../../shared/cinta.js';
import type { EnlaceCinta, Fotograma, Suceso } from '../../shared/fotograma.js';

const sinImplementar = (que: string): never => { throw new Error(`sin implementar: ${que}`); };

/** Lo que el hilo de la cinta recuerda entre fotogramas para rehacer un `WorldView`: las vistas lentas y los textos
 * vivos (llegan como sucesos), las teselas ya vistas y el catálogo de sustancias. Uno por época. */
export interface EstadoVista { readonly epoca: number }
export function estadoVista(epoca: number): EstadoVista { return sinImplementar('m6: estadoVista'); }

/** Aplica al estado los sucesos anteriores al fotograma (en orden) y lo convierte en un `Corte` con el mismo contenido
 * que `projectTapeFrame` daría sobre ese estado del mundo. `seq` lo pone quien llama. */
export function fotogramaAVista(estado: EstadoVista, f: Fotograma, sucesos: readonly Suceso[], seq: number): Corte { return sinImplementar('m6: fotogramaAVista'); }

/** Lee del enlace el siguiente fotograma entregado y sus sucesos, llama a `usar` con ellos mientras la ranura es válida
 * y devuelve el crédito. Devuelve false si no había ninguno pendiente. Es el lado «cinta» del protocolo de
 * `shared/fotograma.ts`. */
export function leerFotograma(enlace: EnlaceCinta, leidos: bigint, usar: (f: Fotograma, sucesos: readonly Suceso[]) => void): boolean { return sinImplementar('m6: leerFotograma'); }
