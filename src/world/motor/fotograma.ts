/**
 * INTERFAZ PUENTE del fotograma binario (carril m6; ARQ-motor §3.6 y shared/fotograma.ts). El esqueleto lo fijó la
 * preparación de la oleada: m6 rellena los cuerpos y puede añadir exportaciones, pero no cambia estas firmas (las
 * consume m4a).
 */
import type { EnlaceCinta } from '../../shared/fotograma.js';
import { sinImplementar, type CtxF0, type CtxLey } from './acceso.js';

/** Estado del fotograma en curso, que el coordinador abre en F0 y los dueños rellenan en F6. */
export interface FotogramaEnCurso { readonly ranura: SharedArrayBuffer; readonly completo: boolean; readonly tick: number; readonly epoca: number }

/** F0 (coordinador): si toca fotograma (cadencia) y hay crédito, toma uno, dimensiona la ranura para los organismos y
 * páginas de este tick con holgura y la devuelve; si no, null (y cuenta un saltado si tocaba). `completo` si la cinta lo
 * pidió o la época acaba de abrir. */
export function abrirFotograma(c: CtxF0, enlace: EnlaceCinta, epoca: number): FotogramaEnCurso | null { return sinImplementar('m6: abrirFotograma'); }
/** F6 (cada dueño, en paralelo): escribe en la ranura sus filas vivas (ESQUEMA_ORGANISMO) y sus páginas con cambio
 * visible desde el último entregado (ESQUEMA_CELDA), reservando sitio con Atomics.add. Devuelve false si no cupo. */
export function escribirFotograma(c: CtxLey, f: FotogramaEnCurso): boolean { return sinImplementar('m6: escribirFotograma'); }
/** Tras la barrera B4 (coordinador): escribe sucesos y serie, publica el fotograma (`entregados`) o, si algún dueño no
 * cupo, lo aborta devolviendo el crédito y contando un saltado. */
export function cerrarFotograma(c: CtxF0, enlace: EnlaceCinta, f: FotogramaEnCurso, valido: boolean): void { return sinImplementar('m6: cerrarFotograma'); }
