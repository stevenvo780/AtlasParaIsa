/**
 * INTERFAZ PUENTE de los procesos técnicos sobre lotes (carril t1; ARQ-materia §3.5). El esqueleto lo fijó la
 * preparación de la oleada: t1 rellena los cuerpos y puede añadir exportaciones, pero no cambia estas firmas (las
 * consumen t2 y act).
 */
import { sinImplementar, type CtxLeyMateria, type Ley } from '../motor/acceso.js';
import type { Cuerpo, LoteRef, Paso, ProcesoMaterial } from './tipos.js';

export const leyTecnica: Ley = { id: 't1', interruptor: 'tecnica', sustituye: ['memoriaTecnica'] };

/** Qué pasó al avanzar un proceso un tick: sigue en su paso, pasó al siguiente, terminó, o espera algo del mundo (un
 * insumo que no está, un fuego, agua) sin gastar nada. */
export type AvanceProceso = 'sigue' | 'paso' | 'hecho' | 'espera';

/** Empieza un proceso sobre un lote propio que está en la celda (x, y) o a cuestas de quien lo hace. */
export function iniciarProceso(c: CtxLeyMateria, lote: LoteRef, pasos: readonly Paso[], x: number, y: number): ProcesoMaterial { return sinImplementar('t1: iniciarProceso'); }
/** Avanza un tick el paso en curso. `quien` es el cuerpo que trabaja (paga con `pagar` el trabajo de romper y de
 * unir; null si el paso solo espera al mundo: calentar junto a un fuego, mojar). Si se interrumpe, el lote intermedio se
 * queda donde está: el proceso es dato, no un cerrojo. */
export function avanzarProceso(c: CtxLeyMateria, p: ProcesoMaterial, quien: Cuerpo | null): AvanceProceso { return sinImplementar('t1: avanzarProceso'); }
