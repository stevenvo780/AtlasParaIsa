/**
 * La ficha a demanda de UN habitante (`{type:'persona', id}`), ampliada para la interfaz sin tocar
 * `src/world`: parte de `personDetail` (biografía) y añade lo que el cliente no puede saber cuando
 * esa persona está fuera de su cámara. Solo lee el mundo; nunca lo escribe ni avanza.
 *
 * M3: nombre y posición exacta (x, y) para encontrar a S, a I o a cualquiera fuera de cuadro.
 * M4: si puede criar ahora (y por qué no) y a quién busca si corteja o prepara una crianza.
 * M8: familia con nombres en todo el mundo (vivos y difuntos registrados) y edades clave de su cuerpo.
 * M9: de dónde viene cada procedimiento que recuerda (lo inventó, de quién lo aprendió y cuándo).
 */
import type { PersonDetail } from '../shared/types.js';
import { personDetail, type World } from '../world/index.js';
import { demographicTraits } from '../world/demography.js';
import { paramsOf } from '../world/params.js';
import { aQuienBusca, fertilidad } from './resumen-vivo.js';

type Pariente = NonNullable<PersonDetail['familia']>['progenitores'][number];
/** Hijos por persona: como mucho estos se nombran; el total siempre se cuenta. */
export const MAX_HIJOS_NOMBRADOS = 24;

/** Progenitores e hijos sobre `world.people` y el registro de difuntos que el mundo conserva
 * (`legacy` + `retiredLegacy`); un difunto archivado fuera del mundo servido no se inventa. */
export function familia(world: World, id: string): NonNullable<PersonDetail['familia']> | undefined {
  const person = world.people.find(p => p.id === id);
  if (!person) return undefined;
  const muertos = new Map<string, { id: string; name: string; generation: number; parents: string[] }>();
  for (const record of [...world.legacy, ...world.retiredLegacy]) if (!muertos.has(record.id)) muertos.set(record.id, record);
  const quien = (pid: string): Pariente | null => {
    const vivo = world.people.find(p => p.id === pid);
    if (vivo) return { id: vivo.id, nombre: vivo.name, vivo: true, generacion: vivo.genome.generation };
    const muerto = muertos.get(pid);
    return muerto ? { id: muerto.id, nombre: muerto.name, vivo: false, generacion: muerto.generation } : null;
  };
  const progenitores = person.genome.parents.map(pid => quien(pid) ?? { id: pid, nombre: null, vivo: null, generacion: null });
  const hijos: Pariente[] = [];
  for (const other of world.people) if (other.genome.parents.includes(id)) hijos.push({ id: other.id, nombre: other.name, vivo: true, generacion: other.genome.generation });
  for (const record of muertos.values()) if (record.parents.includes(id)) hijos.push({ id: record.id, nombre: record.name, vivo: false, generacion: record.generation });
  return { progenitores, hijos: hijos.slice(0, MAX_HIJOS_NOMBRADOS), totalHijos: hijos.length, hijosVivos: hijos.filter(h => h.vivo).length };
}

/** Como `inheritedAndLearned` dibuja los primeros 32 procedimientos que recuerda, se explica el origen de esos. */
export const MAX_PROCEDIMIENTOS = 32;

/** M9: origen de cada procedimiento que recuerda: `invento` si la definición residente lo nombra como
 * inventor, `aprendido` con maestro y paso si `learnedFrom` lo registra, y `sin-registro` si el mundo no
 * conserva de dónde vino (nunca se supone que lo descubrió solo). */
export function tecnica(world: World, id: string): Pick<PersonDetail, 'procedimientos' | 'inventadas'> | undefined {
  const person = world.people.find(p => p.id === id);
  if (!person) return undefined;
  const recetas = new Map(world.technology.recipes.map(recipe => [recipe.id, recipe]));
  const maestros = new Map<string, { teacherId: string; tick: number }>();
  for (const learned of person.technology.learnedFrom) maestros.set(learned.recipeId, { teacherId: learned.teacherId, tick: learned.tick });
  const procedimientos = person.technology.knownRecipes.slice(0, MAX_PROCEDIMIENTOS).map(recipeId => {
    const recipe = recetas.get(recipeId), maestro = maestros.get(recipeId);
    if (recipe?.inventorId === id) return { id: recipeId, origen: 'invento' as const, tick: recipe.tick };
    if (maestro) return { id: recipeId, origen: 'aprendido' as const, tick: maestro.tick, maestro: { id: maestro.teacherId, nombre: world.people.find(p => p.id === maestro.teacherId)?.name ?? world.legacy.find(r => r.id === maestro.teacherId)?.name ?? null } };
    return { id: recipeId, origen: 'sin-registro' as const };
  });
  return { procedimientos, inventadas: world.technology.recipes.filter(recipe => recipe.inventorId === id).length };
}

export function enriquecerPersona(world: World, id: string): PersonDetail | undefined {
  const detail = personDetail(world, id);
  if (!detail) return undefined;
  const person = world.people.find(p => p.id === id)!;
  const busca = aQuienBusca(world, person);
  const traits = demographicTraits(person.genome, paramsOf(world).cuerpo);
  // M4: fertilidad y a quién busca, con las funciones de la ley y en solo lectura.
  // M8: familia y edades clave (en pasos de edad corporal; el cliente las dice en días).
  return { ...detail, name: person.name, x: person.x, y: person.y, vivo: true, fertil: fertilidad(world, person), ...(busca ? { busca } : {}),
    familia: familia(world, id), edades: { edad: person.demography.age, madurez: traits.maturityAge, vejez: traits.senescenceStart, maxima: traits.maximumAge },
    // M9: origen de los procedimientos que recuerda.
    ...tecnica(world, id) };
}
