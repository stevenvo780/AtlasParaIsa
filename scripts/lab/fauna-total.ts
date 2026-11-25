import type { World } from '../../src/world/index.js';
import { AREA_CELDA, GEN, huella } from '../../src/world/decision/fauna.js';

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

/** Censo de la fauna V23 para el experimento F1 (leyes-opus §3c): biomasa de herbívoros (carnivoría < 0,5) y de
 * carnívoros, ocupación máxima de huella por celda (debe quedar ≤ 1) y cautela y habituación medias (H1). `masa` es
 * la del cuerpo de cada animal (`masaDe` con el contexto del dueño). Los animales sin cuerpo no cuentan. */
export interface CensoFaunaV23 {
  vivos: number; herbivoros: { n: number; kg: number }; carnivoros: { n: number; kg: number };
  ocupacionMax: number; cautelaMedia: number; habituacionMedia: number;
}
export function censoFaunaV23(world: Pick<World, 'animals'>, masa: (animal: World['animals'][number]) => number): CensoFaunaV23 {
  const censo: CensoFaunaV23 = { vivos: 0, herbivoros: { n: 0, kg: 0 }, carnivoros: { n: 0, kg: 0 }, ocupacionMax: 0, cautelaMedia: 0, habituacionMedia: 0 };
  const ocupacion = new Map<string, number>();
  for (const animal of world.animals) {
    if (!animal.fauna || !animal.cuerpo || !(animal.health > 0)) continue;
    const kg = masa(animal), grupo = (animal.fauna.genoma[GEN.carnivoria] ?? 0) < 0.5 ? censo.herbivoros : censo.carnivoros;
    censo.vivos++; grupo.n++; grupo.kg += kg;
    censo.cautelaMedia += animal.fauna.genoma[GEN.cautela] ?? 0; censo.habituacionMedia += animal.fauna.habituacion;
    const clave = `${animal.x},${animal.y}`;
    ocupacion.set(clave, (ocupacion.get(clave) ?? 0) + huella(kg) / AREA_CELDA);
  }
  for (const o of ocupacion.values()) censo.ocupacionMax = Math.max(censo.ocupacionMax, o);
  if (censo.vivos) { censo.cautelaMedia /= censo.vivos; censo.habituacionMedia /= censo.vivos; }
  return censo;
}
