import type { World } from '../../src/world/index.js';

/** Store.save vacía retiredChunks; conservar el último censo vivo de cada chunk antes de guardarlo. */
export function registrarFaunaRetirada(world: Pick<World, 'retiredChunks'>, censos: Map<string, number>): void {
  for (const chunk of world.retiredChunks)
    censos.set(chunk.key, chunk.animals?.filter(animal => animal.health > 0).length ?? 0);
}

/** Fauna viva activa más el último censo retirado de cada chunk que sigue inactivo. */
export function faunaTotal(world: Pick<World, 'animals' | 'chunks'>, censos: ReadonlyMap<string, number>): number {
  let total = world.animals.filter(animal => animal.health > 0).length;
  for (const [key, count] of censos) if (!Object.hasOwn(world.chunks, key)) total += count;
  return total;
}
