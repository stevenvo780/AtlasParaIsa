/**
 * Primera reacción que esta arena aplicó. Las siguientes no se reanotan: el camino caliente
 * deja de llamar, y la cinta no reescribe la cabecera en cada tick.
 */
import type { ReaccionObservada } from '../../shared/reaccion-observada.js';
import type { ArenaMateria, LoteRef, Reaccion } from './tipos.js';

const primera = new WeakMap<ArenaMateria, ReaccionObservada>();

export function anotarReaccionAplicada(arena: ArenaMateria, reaccion: Reaccion, veces: number, lote: LoteRef, tick: number): void {
  if (!(veces > 0) || !Number.isFinite(tick) || tick < 0 || primera.has(arena)) return;
  primera.set(arena, { tick, veces, a: reaccion.a, b: reaccion.b, nivel: reaccion.nivelT, lote });
}

export function reaccionObservadaDe(arena: ArenaMateria | undefined): ReaccionObservada | undefined {
  return arena ? primera.get(arena) : undefined;
}
