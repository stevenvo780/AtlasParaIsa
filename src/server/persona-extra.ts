/**
 * La ficha a demanda de UN habitante (`{type:'persona', id}`), ampliada para la interfaz sin tocar
 * `src/world`: parte de `personDetail` (biografía) y añade lo que el cliente no puede saber cuando
 * esa persona está fuera de su cámara. Solo lee el mundo; nunca lo escribe ni avanza.
 *
 * M3: nombre y posición exacta (x, y) para encontrar a S, a I o a cualquiera fuera de cuadro.
 */
import type { PersonDetail } from '../shared/types.js';
import { personDetail, type World } from '../world/index.js';

export function enriquecerPersona(world: World, id: string): PersonDetail | undefined {
  const detail = personDetail(world, id);
  if (!detail) return undefined;
  const person = world.people.find(p => p.id === id)!;
  return { ...detail, name: person.name, x: person.x, y: person.y, vivo: true };
}
