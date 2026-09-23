import type { Person } from './index.js';
import type { Chunk } from './terrain.js';

export interface TechoArchivo {
  blueprint: number;
  structure: number;
  blueprintCorrupto: boolean;
  structureCorrupto: boolean;
}

const techoPorChunk = new WeakMap<Chunk, TechoArchivo>();
const techoPorArreglo = new WeakMap<readonly Chunk[], { version: number; length: number; techo: TechoArchivo }>();
const miembrosPorArreglo = new WeakMap<readonly Person[], { version: number; length: number; set: Set<Person> }>();
let escaneosPorChunk: number | undefined;

function sufijo(prefix: 'blueprint' | 'structure', id: string, techo: TechoArchivo): number {
  if (!id.startsWith(`${prefix}-`)) return 0;
  const suffix = id.slice(prefix.length + 1); if (!/^\d+$/.test(suffix)) return 0;
  const reserved = Number(suffix);
  if (!Number.isSafeInteger(reserved)) {
    if (prefix === 'blueprint') techo.blueprintCorrupto = true; else techo.structureCorrupto = true;
    return 0;
  }
  return reserved;
}

export function techoDeChunk(chunk: Chunk): TechoArchivo {
  let techo = techoPorChunk.get(chunk);
  if (techo) return techo;
  techo = { blueprint: 0, structure: 0, blueprintCorrupto: false, structureCorrupto: false };
  if (escaneosPorChunk !== undefined) escaneosPorChunk++;
  for (const structure of chunk.structures ?? []) {
    techo.blueprint = Math.max(techo.blueprint, sufijo('blueprint', structure.blueprintId, techo));
    techo.structure = Math.max(techo.structure, sufijo('structure', structure.id, techo));
  }
  techoPorChunk.set(chunk, techo);
  return techo;
}

/**
 * Techo de identidades del archivo dormido (T140 §`nextIdentity`). La capa por chunk
 * (`techoPorChunk`, arriba) es válida para siempre porque un chunk retirado es inmutable una vez
 * archivado. La capa por arreglo (`techoPorArreglo`) solo existe para no recorrer `retiredChunks`
 * en cada llamada dentro del mismo paso: sin ella, cada invención/construcción repetiría el
 * recorrido del archivo entero (barato por chunk gracias a la capa de arriba, pero seguiría
 * siendo O(archivo) por llamada, lo que precisamente T140 quiere evitar en un mundo ilimitado).
 *
 * Hallazgo de la ronda de integración E0-INT2: la versión original de esta capa validaba solo
 * `length` + el primer y el último elemento. Eso no detecta un relevo de un elemento INTERMEDIO
 * (`retiredChunks.splice(i, 1, nuevo)` con `i` distinto de 0 y de `length - 1`): longitud, primero
 * y último quedan iguales, así que se devolvería un techo obsoleto y `nextIdentity` podría
 * reutilizar un id ya usado por `nuevo`. Hoy nada en `src/world` hace ese relevo — `spatial.ts`
 * solo hace `push` (longitud +1) y `splice(pending, 1)` sin insertar (longitud −1) sobre
 * `retiredChunks`, y las únicas reasignaciones completas del arreglo (las migraciones de
 * `index.ts`) crean chunks nuevos, así que cambian de identidad de arreglo — pero PERF3 (E.0 ola
 * 1, ya integrada en esta misma rama) hizo que un paso ya no clone el mundo entero: `retiredChunks`
 * puede ahora conservar la MISMA referencia de arreglo durante sesiones enteras en vez de una sola
 * vez por paso, así que un único descuido futuro (un relevo in situ en vez de push/splice-sin-
 * insertar) quedaría mal cacheado indefinidamente, no solo durante un paso.
 *
 * La corrección: el llamador (único, `nextIdentity` en `inventions.ts`) pasa `version` como
 * `world.tick`, que solo cambia una vez, al principio de `stepWorld` (`world.tick++`, antes de
 * cualquier otra cosa), y permanece fijo durante TODO ese paso — el mismo "ámbito de paso" que ya
 * usa la rejilla de T141 (`rejilla.ts`), aquí como un número en vez de un objeto porque no hace
 * falta más. La capa se reconstruye como mucho una vez por paso: como mucho puede quedar obsoleta
 * DENTRO de ese paso (el mismo límite, ya aceptado, que ya tenían `isHostMember` en
 * `technology.ts`/`technology-water.ts` y la propia rejilla de personas, ninguno de los cuales
 * revalida el contenido de por medio), pero nunca más allá de él — nunca "para siempre" como podía
 * pasar antes con PERF3. Sigue siendo exacta siempre porque recomputar el máximo desde cero un
 * paso, usando `techoDeChunk` (ya cacheado por chunk), da la misma respuesta que el barrido
 * original. Sin `version` (llamadas fuera de un paso, p. ej. pruebas o migraciones) no se cachea
 * nada a nivel de arreglo y cada llamada es exacta por construcción, sin depender de nada.
 */
export function techoDelArchivo(retiredChunks: readonly Chunk[], version?: number): TechoArchivo {
  if (version !== undefined) {
    const cached = techoPorArreglo.get(retiredChunks);
    if (cached && cached.version === version && cached.length === retiredChunks.length) return cached.techo;
  }
  const techo: TechoArchivo = { blueprint: 0, structure: 0, blueprintCorrupto: false, structureCorrupto: false };
  for (const chunk of retiredChunks) {
    const current = techoDeChunk(chunk);
    techo.blueprint = Math.max(techo.blueprint, current.blueprint);
    techo.structure = Math.max(techo.structure, current.structure);
    techo.blueprintCorrupto ||= current.blueprintCorrupto;
    techo.structureCorrupto ||= current.structureCorrupto;
  }
  if (version !== undefined) techoPorArreglo.set(retiredChunks, { version, length: retiredChunks.length, techo });
  return techo;
}

/**
 * Pertenencia O(1) a `people` (T140, mismo grupo que `techoDelArchivo`). Mismo hallazgo de la
 * ronda de integración E0-INT2: la versión original cacheaba un `Set` por arreglo validando solo
 * `length`, así que un relevo de un elemento intermedio (`people[i] = otraPersona`, misma
 * longitud) tampoco se detectaba. Hoy nada en `src/world` reemplaza un elemento de `world.people`
 * en su sitio (solo `push` en un nacimiento y `world.people = world.people.filter(...)` —otra
 * identidad de arreglo— en una muerte), pero la misma exposición de PERF3 descrita arriba aplica
 * igual: `world.people` puede vivir muchos pasos sin cambiar de referencia.
 *
 * Misma corrección y mismo límite aceptado: `version` (siempre `world.tick` en los tres
 * llamadores de `inventions.ts`) acota lo obsoleto a, como mucho, el paso en curso; sin `version`
 * no se cachea nada y cada llamada reconstruye el `Set` desde cero.
 */
export function esMiembro(people: readonly Person[], person: Person, version?: number): boolean {
  if (version !== undefined) {
    const cached = miembrosPorArreglo.get(people);
    if (cached && cached.version === version && cached.length === people.length) return cached.set.has(person);
  }
  const set = new Set(people);
  if (version !== undefined) miembrosPorArreglo.set(people, { version, length: people.length, set });
  return set.has(person);
}

export function reiniciarEscaneosDeArchivoParaPruebas(): void { escaneosPorChunk = 0; }
export function escaneosDeArchivoParaPruebas(): number { return escaneosPorChunk ?? 0; }
