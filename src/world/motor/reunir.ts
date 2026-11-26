/**
 * Partir y reunir el mundo entre dueños (carril m4a; ARQ-motor §3.7). `cabeceraDe` es lo que cada dueño recibe al
 * abrir una época: el mundo sin su contenido espacial (que le llega chunk a chunk como `Migrante`) y sin lo que solo
 * lleva el coordinador (crónica, historia, archivo). `reunir` arma, en una barrera, un `World` de arrays normales con
 * la parte de cada dueño, para `Instantanea`.
 *
 * Cómo se reparte lo que no es espacial (decisión de m4a):
 *  - Contadores y acumulados (`totals`, las dinámicas, `technology`, `chemistry`…): cada dueño parte de la copia de la
 *    cabecera y suma lo suyo; al reunir, el valor es base + Σ (dueño − base), campo a campo (`fundir`).
 *  - Listas con identidad (`memories`, `blueprints`, `places`, `whispers`…): base más lo nuevo de cada dueño.
 *  - Crónica, historia, legado y chunks archivados: los lleva el coordinador (los sucesos le llegan cada tick); los
 *    demás dueños empiezan con ellos vacíos y lo que añadan se suma al reunir.
 *  - Ids: los da el contador común (`Contadores`), y `reunir` deja en el mundo el siguiente de cada uno.
 */
import type { Tile } from '../../shared/types.js';
import type { World } from '../mundo/tipos.js';
import { boundParamsOf, setParams } from '../params.js';
import { bindWorldContext, worldContext } from '../spatial.js';
import type { TipoId } from './contadores.js';

/** Campos que cada dueño acumula sobre la copia de la cabecera. */
const ADITIVOS = ['totals', 'demographyDynamics', 'animalDynamics', 'inventionDynamics', 'technology', 'chemistry',
  'settlementCount', 'discoveredChunks', 'birthCounter', 'animalCounter', 'blueprintCounter'] as const satisfies readonly (keyof World)[];
/** Listas que todos los dueños reciben enteras y a las que cada uno puede añadir. */
const UNIDAS = ['memories', 'blueprints', 'places', 'whispers', 'invitations', 'reminders'] as const satisfies readonly (keyof World)[];
/** Listas que solo lleva el coordinador: los demás empiezan vacíos. */
const DEL_COORDINADOR = ['legacy', 'retiredLegacy', 'retiredChunks'] as const satisfies readonly (keyof World)[];

const CAMPOS_BASE = [...UNIDAS, ...ADITIVOS] as const;
const CAMPOS_PARTE = ['tick', 'tiles', 'people', 'animals', 'structures', 'chunks', ...ADITIVOS, ...UNIDAS, ...DEL_COORDINADOR] as const;
type TecnologiaSinCheckpoint = Omit<World['technology'], 'checkpoint'>;
export type ParteMundo = Pick<World, Exclude<typeof CAMPOS_PARTE[number], 'technology'>> & { technology: TecnologiaSinCheckpoint };
export type BaseReunion = Pick<World, typeof CAMPOS_BASE[number]>;

export function sinCheckpointTecnologia(tech: World['technology'] | undefined): TecnologiaSinCheckpoint | undefined {
  if (!tech) return tech;
  const { checkpoint: _checkpoint, ...resto } = tech;
  return resto;
}

/** Selecciona lo que se reúne en el coordinador sin copiar los valores que serializará V8. */
export function parteCorteDe(mundo: World): ParteMundo {
  const parte = Object.fromEntries(CAMPOS_PARTE
    .filter(campo => Object.hasOwn(mundo, campo))
    .map(campo => [campo, mundo[campo]])) as ParteMundo;
  const tecnologia = sinCheckpointTecnologia(mundo.technology);
  if (tecnologia) parte.technology = tecnologia;
  return parte;
}

/** La base que usa el guardado se toma en el tick del corte: el F0 poda invitaciones y recordatorios. */
export function baseReunionDe(cabecera: World): BaseReunion {
  const base = Object.fromEntries(CAMPOS_BASE.map(campo => [campo, cabecera[campo]])) as BaseReunion;
  if (base.technology) base.technology = sinCheckpointTecnologia(base.technology)!;
  return base;
}

/** El mundo que recibe cada dueño al abrir la época (se serializa: no comparte nada con `mundo`). */
export function cabeceraDe(mundo: World): World {
  return {
    ...mundo, tiles: [], people: [], animals: [], structures: [], chunks: {}, retiredChunks: [], legacy: [], retiredLegacy: [],
    events: [], history: [], chronicleJournal: undefined,
  };
}

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v);
const idDe = (v: unknown): unknown => esObjeto(v) && 'id' in v ? v.id : undefined;

/** Lo que `lista` añade a `base`: por `id` si sus elementos lo tienen; si no, lo que sigue a la longitud de la base. */
export function nuevosDe(base: readonly unknown[], lista: readonly unknown[]): unknown[] {
  if (lista.length && idDe(lista[0]) !== undefined) {
    const vistos = new Set(base.map(idDe));
    return lista.filter(v => !vistos.has(idDe(v)));
  }
  return lista.slice(base.length);
}

/**
 * Funde el valor de un campo en varios dueños que partieron de `base`: los números suman sus diferencias con la base;
 * las listas, la base más lo nuevo de cada dueño (sin repetir un `id`); los objetos, clave a clave; lo demás (textos,
 * banderas) toma el valor del primer dueño que lo cambió.
 */
export function fundir(base: unknown, valores: readonly unknown[]): unknown {
  const presentes = valores.filter(v => v !== undefined);
  if (!presentes.length) return base;
  const muestra = base ?? presentes[0];
  if (typeof muestra === 'number') {
    const b = typeof base === 'number' ? base : 0;
    let suma = b;
    for (const v of presentes) if (typeof v === 'number') suma += v - b;
    return suma;
  }
  if (Array.isArray(muestra)) {
    const b = Array.isArray(base) ? base : [], salida = [...b], vistos = new Set(b.map(idDe));
    for (const v of presentes) if (Array.isArray(v)) for (const nuevo of nuevosDe(b, v)) {
      const id = idDe(nuevo);
      if (id !== undefined) { if (vistos.has(id)) continue; vistos.add(id); }
      salida.push(nuevo);
    }
    return salida;
  }
  if (esObjeto(muestra)) {
    const b = esObjeto(base) ? base : {}, salida: Record<string, unknown> = {};
    const claves = new Set(Object.keys(b));
    for (const v of presentes) if (esObjeto(v)) for (const k of Object.keys(v)) claves.add(k);
    for (const k of claves) salida[k] = fundir(b[k], presentes.map(v => esObjeto(v) ? v[k] : undefined));
    return salida;
  }
  return presentes.find(v => v !== base) ?? base;
}

/**
 * Arma el `World` de una instantánea. `coordinador` es el mundo del dueño 0 (que además lleva la crónica y el archivo),
 * `cabecera` la base de la que partieron todos y `partes` los mundos parciales de los demás dueños, ya deserializados.
 * `siguientes` son los contadores comunes. El coordinador vivo conserva sus objetos y el corte recibe copias.
 * Un coordinador deserializado exclusivamente para este corte ya es del receptor y sus arrays se pueden adoptar.
 */
export function reunir(coordinador: World, cabecera: BaseReunion, partes: readonly ParteMundo[], siguientes: Record<TipoId, number>,
  adoptarCoordinador = false): World {
  const todos = [coordinador, ...partes];
  const copia = <T>(v: T): T => adoptarCoordinador ? v : structuredClone(v);
  const mundo: World = { ...coordinador };
  mundo.tiles = adoptarCoordinador ? coordinador.tiles : coordinador.tiles.map(t => ({ ...t }) as Tile);
  mundo.people = copia(coordinador.people);
  mundo.animals = copia(coordinador.animals);
  mundo.structures = copia(coordinador.structures);
  // Los arrays de destino ya son del corte. Los objetos remotos se deserializaron para este corte.
  for (const parte of partes) {
    for (const tile of parte.tiles) mundo.tiles.push(tile);
    for (const persona of parte.people) mundo.people.push(persona);
    for (const animal of parte.animals) mundo.animals.push(animal);
    for (const estructura of parte.structures) mundo.structures.push(estructura);
  }
  mundo.chunks = Object.assign({}, ...todos.map(p => copia(p.chunks)));
  mundo.communities = copia(coordinador.communities);
  mundo.events = copia(coordinador.events);
  mundo.history = copia(coordinador.history);
  if (coordinador.chronicleJournal) mundo.chronicleJournal = copia(coordinador.chronicleJournal);
  const campos = mundo as unknown as Record<string, unknown>;
  for (const k of DEL_COORDINADOR) campos[k] = [...copia(coordinador[k]), ...partes.flatMap(p => p[k] as unknown[])];
  for (const k of CAMPOS_BASE) if (todos.some(m => m[k] !== undefined)) campos[k] = fundir(copia(cabecera[k]), todos.map(m => m[k]));
  // El punto de control técnico describe a las personas de un solo heap: el siguiente paso lo vuelve a capturar.
  if (mundo.technology) mundo.technology = { ...mundo.technology, checkpoint: undefined };
  mundo.siguienteUid = siguientes.uid;
  mundo.communityCounter = Math.max(coordinador.communityCounter, siguientes.comunidad);
  mundo.structureCounter = Math.max(coordinador.structureCounter, siguientes.estructura);
  // Es otro objeto: lleva los parámetros y las capacidades del anfitrión del mundo del que sale.
  const params = boundParamsOf(coordinador);
  if (params) setParams(mundo, params);
  bindWorldContext(mundo, worldContext(coordinador));
  return mundo;
}
