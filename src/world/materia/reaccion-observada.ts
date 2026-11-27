/**
 * Una muestra de reacción aplicada por arena. La ventana es la de las métricas caras de la cinta
 * (`ESTADISTICAS_CARAS_CADA_TICKS` en `world/statistics.ts`, 200 pasos): como mucho un registro
 * nuevo por ventana. Sin otra reacción, se conserva el anterior con su tick y la cabecera no cambia
 * por este campo. No viaja en el guardado: solo el WeakMap de la arena viva.
 */
import type { ReaccionObservada } from '../../shared/reaccion-observada.js';
import type { ArenaMateria, LoteRef, Reaccion } from './tipos.js';

/** Igual que `ESTADISTICAS_CARAS_CADA_TICKS`. El test de muestra lo comprueba contra esa constante. */
export const VENTANA_MUESTRA_REACCION = 200;

const muestra = new WeakMap<ArenaMateria, ReaccionObservada>();
/** La misma observación, copiada al mundo reunido: su arena es otra y el WeakMap no viaja. */
const publicada = new WeakMap<object, ReaccionObservada>();

const ventanaDe = (tick: number): number => Math.floor(tick / VENTANA_MUESTRA_REACCION);

/** Cabe otra muestra: no hay ninguna, o la guardada es de una ventana anterior. */
export function muestraAbierta(arena: ArenaMateria | undefined, tick: number): boolean {
  if (!arena || !Number.isFinite(tick) || tick < 0) return false;
  const previa = muestra.get(arena);
  return !previa || ventanaDe(previa.tick) !== ventanaDe(tick);
}

export function fijarReaccionPublicada(mundo: object, obs: ReaccionObservada): void {
  publicada.set(mundo, obs);
}

export function reaccionPublicada(mundo: object | undefined): ReaccionObservada | undefined {
  return mundo ? publicada.get(mundo) : undefined;
}

export function anotarReaccionAplicada(arena: ArenaMateria, reaccion: Reaccion, veces: number, lote: LoteRef, tick: number): void {
  if (!(veces > 0) || !muestraAbierta(arena, tick)) return;
  muestra.set(arena, { tick, veces, a: reaccion.a, b: reaccion.b, nivel: reaccion.nivelT, lote });
}

/**
 * Arma el callback solo si esta ventana todavía no tiene muestra. Tras guardarla, el callback se quita
 * y el paso deja de llamarlo. `tickActual` se lee al aplicar, no al armar.
 */
export function rearmarMuestraReaccion(
  ctx: { anotar?: (reaccion: Reaccion, veces: number, lote: LoteRef) => void },
  arena: ArenaMateria,
  tickActual: () => number,
): void {
  if (ctx.anotar || !muestraAbierta(arena, tickActual())) return;
  ctx.anotar = (reaccion, veces, lote) => {
    const tick = tickActual();
    anotarReaccionAplicada(arena, reaccion, veces, lote, tick);
    if (!muestraAbierta(arena, tick)) ctx.anotar = undefined;
  };
}

export function reaccionObservadaDe(arena: ArenaMateria | undefined): ReaccionObservada | undefined {
  return arena ? muestra.get(arena) : undefined;
}
