import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import { join } from 'node:path';
import { getHeapStatistics } from 'node:v8';
import { MAX_ANIMALS_PER_TILE } from '../world/animals.js';
import { gpuNvrtcAvailable } from '../world/gpu/puente.js';
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
 * escala (`CARTA_TEST_ESCALA=1`, `tests/limites-anticorrupcion.test.ts`, heap 6144 MiB):
 * 2 097 152 teselas y 8192 chunks con cuerpos heterogéneos (y `-0`) ⇒ RSS pico del ESCRITOR
 * 2771 MiB (1386 B/tesela), RSS pico del proceso con el mundo escritor y el recargado a la
 * vez 3779 MiB (1888 B/tesela) y 520 249 344 bytes en SQLite (248 B/tesela).
 * Se toma 2000 B, redondeo del pico de DOS mundos residentes, porque esa es la forma real
 * del servidor de hoy: `motor.clonPorPaso=true` clona el mundo en cada paso con gestos (desde
 * PERF3, 2026-09-23, solo en esos; el pico sigue dándose). Si el clon desaparece del todo, esta
 * constante se vuelve a medir, no se adivina.
 * La medida anterior (1707 B/tesela) mezclaba ambos mundos en un RSS instantáneo sobre
 * 2 M copias de una sola tesela: ni era pico ni era de una fase.
 */
export const BYTES_PER_ACTIVE_TILE = 2000;
/** Mitad de la RAM física: la otra mitad queda para SO, caché de páginas, SQLite y el resto del proceso. */
export const HOST_RAM_SHARE = 0.5;
/** Del heap de V8 configurado, la fracción que puede ocupar el mundo residente: el paso, el clon
 * acotado y el cuerpo de la instantánea necesitan el resto: la prueba de 2 M usó 2771 MiB para el
 * mundo escritor y 3779 MiB de pico con el recargado encima, de un heap configurado de 6192 MiB. */
export const HEAP_SHARE = 0.6;

export interface HostMemory { fisicaBytes: number; heapBytes: number; cgroupBytes?: number }

const positive = (value: number | undefined): number => Number.isFinite(value) && (value as number) > 0 ? value as number : Infinity;

/**
 * cgroup v2: un `MemoryMax` manda sobre la RAM física de la torre. Leer
 * `/sys/fs/cgroup/memory.max` NO sirve: ese es el cgroup RAÍZ, que nunca declara el fichero
 * (comprobado en esta torre el 2026-09-22: «No existe el fichero»). El límite efectivo del
 * proceso es el MÍNIMO de `memory.max` de su propio cgroup —el de la línea `0::` de
 * `/proc/self/cgroup`— y el de TODOS sus ancestros, que es donde vive el `MemoryMax=` de un
 * servicio de usuario como `atlas-servidor.service`.
 * cgroup v1 (`N:memory:/…` + `memory.limit_in_bytes`) no se interpreta: la torre y el
 * despliegue son unificados. Sin lectura fiable se devuelve `undefined` y manda la RAM física.
 */
export function cgroupMemory(mount = '/sys/fs/cgroup', self = '/proc/self/cgroup'): number | undefined {
  let own: string | undefined;
  try { own = readFileSync(self, 'utf8').split('\n').find(line => line.startsWith('0::'))?.slice(3); }
  catch { return undefined; }
  if (own === undefined || !own.startsWith('/')) return undefined;
  const segments = own.split('/').filter(Boolean);
  let limit = Infinity;
  for (let depth = segments.length; depth >= 0; depth--) {
    let raw: string;
    try { raw = readFileSync(join(mount, ...segments.slice(0, depth), 'memory.max'), 'utf8').trim(); }
    catch { continue; } // Un ancestro sin el fichero (la raíz, siempre) no acota nada.
    if (raw !== 'max') limit = Math.min(limit, positive(Number(raw)));
  }
  return Number.isFinite(limit) ? limit : undefined;
}

export function hostMemory(): HostMemory {
  return { fisicaBytes: totalmem(), heapBytes: getHeapStatistics().heap_size_limit, cgroupBytes: cgroupMemory() };
}

/**
 * Fórmula: `presupuesto = min(RAM física, cgroup) · 0,5` acotado por `heap de V8 · 0,6`;
 * de ahí salen regiones ENTERAS (`presupuesto / (BYTES_PER_ACTIVE_TILE · 256 teselas)`) y de ellas,
 * las teselas y la fauna (6 animales por tesela, ley estructural). Nunca por debajo de los
 * defaults deterministas de hoy: una máquina pequeña no puede rechazar un mundo que el
 * binario anterior aceptaba. Las comunidades ADMITIDAS siguen el presupuesto de teselas:
 * este tope sólo valida el estado. La fundación lee por separado `social.maxComunidades`
 * (ley de reglas 11), por lo que la máquina nunca decide esa conducta.
 */
export function hostLimits(memory: HostMemory): WorldLimits {
  const budget = Math.min(Math.min(positive(memory.fisicaBytes), positive(memory.cgroupBytes)) * HOST_RAM_SHARE,
    positive(memory.heapBytes) * HEAP_SHARE);
  const chunks = Math.max(DEFAULT_PARAMS.limites.chunks,
    Number.isFinite(budget) ? Math.floor(budget / (BYTES_PER_ACTIVE_TILE * TILES_PER_CHUNK)) : 0);
  const teselasActivas = chunks * TILES_PER_CHUNK;
  return { teselasActivas, chunks, comunidades: teselasActivas, fauna: teselasActivas * MAX_ANIMALS_PER_TILE };
}

/** Precedencia: defaults deterministas → límites resueltos aquí → overrides explícitos del
 * operador (que se aplican DESPUÉS, en `deploymentParams`, aunque repitan el default). */
export function hostParams(base: WorldParams = DEFAULT_PARAMS, memory: HostMemory = hostMemory()): WorldParams {
  return parseParams({ limites: hostLimits(memory) }, base);
}

/** Timeout corto para consultar los índices CUDA con `nvidia-smi` sin bloquear el arranque. */
export const NVIDIA_SMI_TIMEOUT_MS = 2000;
const MAX_MOTOR_HILOS = 512;

export interface HostHardware {
  cpuThreads: number;
  totalRamBytes: number;
  cudaDevices: number[];
}

export interface HostHardwareProbe {
  cpuThreads?: () => number;
  totalRamBytes?: () => number;
  nvrtcAvailable?: () => boolean;
  /** Consulta de índices CUDA (por defecto `nvidia-smi --query-gpu=index --format=csv,noheader`). */
  nvidiaSmi?: () => string | null | undefined;
  /** Permite fijar la memoria completa del anfitrión en pruebas deterministas de `hostFullHardwareParams`. */
  memory?: () => HostMemory;
}

export type RecommendedHostMotor = Pick<
  WorldParams['motor'],
  'hilos' | 'gpu' | 'soaTerreno' | 'particionarPersonas' | 'clonPorPaso'
>;

function defaultNvidiaSmi(): string {
  return execFileSync('nvidia-smi', ['--query-gpu=index', '--format=csv,noheader'], {
    encoding: 'utf8',
    timeout: NVIDIA_SMI_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** Parsea índices CUDA no negativos devueltos por `nvidia-smi`, deduplicados y ordenados. */
export function parseNvidiaSmiIndices(output: string | null | undefined): number[] {
  if (typeof output !== 'string' || output.trim() === '') return [];
  const seen = new Set<number>();
  for (const token of output.split(/[\r\n,]+/)) {
    const trimmed = token.trim();
    if (!/^\d+$/.test(trimmed)) continue;
    const index = Number(trimmed);
    if (Number.isSafeInteger(index) && index >= 0) seen.add(index);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * Detecta los recursos físicos de cómputo del anfitrión (hilos de CPU, RAM total y GPUs CUDA
 * utilizables con NVRTC). Admite `probe` inyectable para pruebas deterministas sin tocar GPU real.
 * Vive únicamente en `src/server/`: el motor (`src/world`) jamás inspecciona el hardware (T171).
 */
export function detectHostHardware(probe?: HostHardwareProbe): HostHardware {
  const rawThreads = probe?.cpuThreads ? probe.cpuThreads() : availableParallelism();
  const cpuThreads = Number.isFinite(rawThreads) && rawThreads >= 1 ? Math.floor(rawThreads) : 1;
  const rawRam = probe?.totalRamBytes ? probe.totalRamBytes() : totalmem();
  const totalRamBytes = Number.isFinite(rawRam) && rawRam > 0 ? Math.floor(rawRam) : 0;

  let cudaDevices: number[] = [];
  const hasNvrtc = probe?.nvrtcAvailable ? probe.nvrtcAvailable() : gpuNvrtcAvailable();
  if (hasNvrtc) {
    try {
      const rawOutput = probe?.nvidiaSmi ? probe.nvidiaSmi() : defaultNvidiaSmi();
      cudaDevices = parseNvidiaSmiIndices(rawOutput);
    } catch {
      cudaDevices = [];
    }
  }
  return { cpuThreads, totalRamBytes, cudaDevices };
}

/**
 * Función pura que deriva el despacho recomendado del motor a partir del hardware detectado.
 * En torres grandes (`cpuThreads >= 8`) reserva 4 hilos para SO, WebSockets y SQLite
 * (p. ej. 32 hilos → 28 hilos + todas las GPUs CUDA disponibles).
 */
export function recommendedMotorForHost(hw: HostHardware): RecommendedHostMotor {
  const cpuThreads = Number.isFinite(hw.cpuThreads) && hw.cpuThreads >= 1 ? Math.floor(hw.cpuThreads) : 1;
  const seenGpu = new Set<number>();
  const gpu: number[] = [];
  for (const device of hw.cudaDevices) {
    if (Number.isSafeInteger(device) && device >= 0 && !seenGpu.has(device)) {
      seenGpu.add(device);
      gpu.push(device);
    }
  }
  const hilos = Math.min(MAX_MOTOR_HILOS, Math.max(1, cpuThreads >= 8 ? cpuThreads - 4 : cpuThreads));
  return {
    hilos,
    gpu,
    soaTerreno: cpuThreads > 1 || gpu.length > 0,
    particionarPersonas: cpuThreads >= 4,
    clonPorPaso: false,
  };
}

/**
 * Combina los límites de admisión del anfitrión (`hostParams`) con el despacho real para todos los
 * chips detectados, gobernador por hardware (`techo` a 100 ms) y cadencia de persistencia de producción.
 */
export function hostFullHardwareParams(base: WorldParams = DEFAULT_PARAMS, probe?: HostHardwareProbe): WorldParams {
  const hw = detectHostHardware(probe);
  const memory: HostMemory = probe?.memory
    ? probe.memory()
    : probe?.totalRamBytes
      ? { ...hostMemory(), fisicaBytes: hw.totalRamBytes }
      : hostMemory();
  const withLimits = hostParams(base, memory);
  const motor = recommendedMotorForHost(hw);
  return parseParams({
    motor,
    gobernador: { ...base.gobernador, politica: 'techo', presupuestoMs: 100 },
    persistencia: { ...base.persistencia, cadaTicks: 100, ventanaEventosTicks: 24000 },
  }, withLimits);
}

/**
 * V15 (`RULES_VERSION 12`): modo de evolución abierta limitada únicamente por el hardware físico.
 * Activa todos los chips detectados (`hostFullHardwareParams`) junto con natalidad estrictamente local
 * (sin cupo global de 40 nacimientos/día), comunidades vivas sin tope ficticio (`maxComunidades=0`),
 * política evolutiva local + plasticidad Baldwin (`politicaPeso=0.35`, `aptitud=0.35`) y señal limpia
 * de innovación tecnológica sin spam de microvariantes (`evitarNoOp=true`, `dosisCuanto=50`).
 */
export function hostOpenWorldParams(base: WorldParams = DEFAULT_PARAMS, probe?: HostHardwareProbe): WorldParams {
  const full = hostFullHardwareParams(base, probe);
  return parseParams({
    poblacion: { ...full.poblacion, natalidadVecindad: true, radioVecindadNatalidad: 16 },
    social: { ...full.social, radioConvivencia: 12, disolucion: 1, maxComunidades: 0 },
    conducta: { ...full.conducta, aptitud: 0.35, politicaPeso: 0.35 },
    tecnologia: { ...full.tecnologia, evitarNoOp: true, dosisCuanto: 50, enfriamiento: 240 },
  }, full);
}
