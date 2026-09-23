import type { Person } from './index.js';
import type { Chunk } from './terrain.js';

export interface TechoArchivo {
  blueprint: number;
  structure: number;
  blueprintCorrupto: boolean;
  structureCorrupto: boolean;
}

const techoPorChunk = new WeakMap<Chunk, TechoArchivo>();
const techoPorArreglo = new WeakMap<readonly Chunk[], { length: number; first: Chunk | undefined; last: Chunk | undefined; techo: TechoArchivo }>();
const miembrosPorArreglo = new WeakMap<readonly Person[], { length: number; set: Set<Person> }>();
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

export function techoDelArchivo(retiredChunks: readonly Chunk[]): TechoArchivo {
  const cached = techoPorArreglo.get(retiredChunks);
  if (cached?.length === retiredChunks.length && cached.first === retiredChunks[0] && cached.last === retiredChunks.at(-1)) return cached.techo;
  const techo: TechoArchivo = { blueprint: 0, structure: 0, blueprintCorrupto: false, structureCorrupto: false };
  for (const chunk of retiredChunks) {
    const current = techoDeChunk(chunk);
    techo.blueprint = Math.max(techo.blueprint, current.blueprint);
    techo.structure = Math.max(techo.structure, current.structure);
    techo.blueprintCorrupto ||= current.blueprintCorrupto;
    techo.structureCorrupto ||= current.structureCorrupto;
  }
  techoPorArreglo.set(retiredChunks, { length: retiredChunks.length, first: retiredChunks[0], last: retiredChunks.at(-1), techo });
  return techo;
}

export function esMiembro(people: readonly Person[], person: Person): boolean {
  let cached = miembrosPorArreglo.get(people);
  if (!cached || cached.length !== people.length) {
    cached = { length: people.length, set: new Set(people) };
    miembrosPorArreglo.set(people, cached);
  }
  return cached.set.has(person);
}

export function reiniciarEscaneosDeArchivoParaPruebas(): void { escaneosPorChunk = 0; }
export function escaneosDeArchivoParaPruebas(): number { return escaneosPorChunk ?? 0; }
