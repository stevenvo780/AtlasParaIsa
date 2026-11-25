/**
 * INTERFAZ PUENTE de las piezas de obra como lotes (carril t2). El esqueleto lo fijó la preparación de la oleada: t2
 * rellena los cuerpos y puede añadir exportaciones, pero no cambia estas firmas (las consumen act y m6).
 */
import { sinImplementar, type CtxLeyMateria, type Ley } from '../motor/acceso.js';
import type { LoteRef, VistaLote } from './tipos.js';

export const leyObra: Ley = { id: 't2', interruptor: 'obra', sustituye: ['estructuras'] };

/** Coloca un lote con forma, propio y en esa celda, como pieza (rol Pieza) de la estructura `estructura` (su id). */
export function colocarPieza(c: CtxLeyMateria, estructura: string, lote: LoteRef, celda: number): void { return sinImplementar('t2: colocarPieza'); }
/** Las piezas de una estructura propia, en `out`. */
export function piezasDe(c: CtxLeyMateria, estructura: string, out: LoteRef[]): LoteRef[] { return sinImplementar('t2: piezasDe'); }
/** Servicio que una estructura propia presta por lo que son sus piezas (sellado, aislamiento, dureza y tenacidad
 * agregados de sus lotes: `VistaLote`), no por una lista de componentes. */
export function servicioDe(c: CtxLeyMateria, estructura: string): Pick<VistaLote, 'sellado' | 'aislamiento' | 'dureza' | 'tenacidad' | 'masa'> { return sinImplementar('t2: servicioDe'); }
