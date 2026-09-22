import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { getHeapStatistics } from 'node:v8';
import { MAX_ANIMALS_PER_TILE } from '../world/animals.js';
import { CHUNK_SIZE } from '../world/terrain.js';
import { DEFAULT_PARAMS, parseParams, type WorldLimits, type WorldParams } from '../world/params.js';

/**
 * T100, fase 4b: los topes de admisión de un mundo NUEVO se resuelven aquí, en el host, y
 * se persisten en sus params. El motor (`src/world`) nunca pregunta por la máquina: una vez
 * escritos, los mismos params y el mismo estado dan la misma ejecución en cualquier torre.
 * Este módulo se llama SOLO cuando `Store.load()` no devuelve mundo; jamás en `load`,
 * `previous`, migración ni validación de respaldos.
 *
 * Es un límite de ADMISIÓN, no una promesa de RSS: dice hasta dónde se acepta un mundo antes
 * de considerarlo corrupto, no que ese mundo quepa cómodo ni que el paso llegue a tiempo
 * (de eso responde el gobernador por p95, ruling R17).
 */
const TILES_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;
/**
 * Coste de admisión por tesela activa, MEDIDO el 2026-09-22 en este árbol con la prueba de
 * escala (`CARTA_TEST_ESCALA=1`, `tests/limites-anticorrupcion.test.ts`): 2 097 152 teselas
 * y 8192 chunks, RSS pico 3415 MiB y 240 783 360 bytes en SQLite ⇒ 1707 B/tesela de RSS pico
 * y 115 B/tesela en disco. Se redondea a 1750 B, el pico de memoria, que es el recurso escaso.
 */
export const BYTES_PER_ACTIVE_TILE = 1750;
/** Mitad de la RAM física: la otra mitad queda para SO, caché de páginas, SQLite y el resto del proceso. */
export const HOST_RAM_SHARE = 0.5;
/** Del heap de V8 configurado, la fracción que puede ocupar el mundo residente: el paso, el clon
 * acotado y el cuerpo de la instantánea necesitan el resto (la prueba de 2 M usó 3415 de 6144 MiB). */
export const HEAP_SHARE = 0.6;

export interface HostMemory { fisicaBytes: number; heapBytes: number; cgroupBytes?: number }

const positive = (value: number | undefined): number => Number.isFinite(value) && (value as number) > 0 ? value as number : Infinity;

/** cgroup v2: un contenedor con `MemoryMax` manda sobre la RAM física de la torre. */
function cgroupMemory(): number | undefined {
  try {
    const raw = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    return raw === 'max' ? undefined : positive(Number(raw));
  } catch { return undefined; }
}

export function hostMemory(): HostMemory {
  return { fisicaBytes: totalmem(), heapBytes: getHeapStatistics().heap_size_limit, cgroupBytes: cgroupMemory() };
}

/**
 * Fórmula: `presupuesto = min(RAM física, cgroup) · 0,5` acotado por `heap de V8 · 0,6`;
 * de ahí salen regiones ENTERAS (`presupuesto / (1750 B · 256 teselas)`) y de las regiones,
 * las teselas y la fauna (6 animales por tesela, ley estructural). Nunca por debajo de los
 * defaults deterministas de hoy: una máquina pequeña no puede rechazar un mundo que el
 * binario anterior aceptaba. `comunidades` NO se deriva del hardware: desde T100 ese número
 * es además el tope de fundación de `society.ts`, y la máquina no decide conductas.
 */
export function hostLimits(memory: HostMemory): WorldLimits {
  const budget = Math.min(Math.min(positive(memory.fisicaBytes), positive(memory.cgroupBytes)) * HOST_RAM_SHARE,
    positive(memory.heapBytes) * HEAP_SHARE);
  const chunks = Math.max(DEFAULT_PARAMS.limites.chunks,
    Number.isFinite(budget) ? Math.floor(budget / (BYTES_PER_ACTIVE_TILE * TILES_PER_CHUNK)) : 0);
  const teselasActivas = chunks * TILES_PER_CHUNK;
  return { teselasActivas, chunks, comunidades: DEFAULT_PARAMS.limites.comunidades, fauna: teselasActivas * MAX_ANIMALS_PER_TILE };
}

/** Precedencia: defaults deterministas → límites resueltos aquí → overrides explícitos del
 * operador (que se aplican DESPUÉS, en `deploymentParams`, aunque repitan el default). */
export function hostParams(base: WorldParams = DEFAULT_PARAMS, memory: HostMemory = hostMemory()): WorldParams {
  return parseParams({ limites: hostLimits(memory) }, base);
}
