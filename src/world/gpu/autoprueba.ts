import { existsSync } from 'node:fs';
import type { Tile, Biome, Feature } from '../../shared/types.js';
import { ecology, phaseAt, type World } from '../index.js';
import { EcosystemKernel } from '../ecosystem-kernel.js';
import { HISTORICAL_PARAMS, setParams } from '../params.js';

export interface ParityDiagnostic {
  device: number; architecture: string; driver?: number; firstDivergentIndex: number | null;
  expected: number | null; actual: number | null; reason: string;
}
export interface GPUInfo { index: number; architecture: string; driver?: number; compileOptions: string[] }
export interface ParityBackend {
  initialization: { devices: GPUInfo[]; fmad: boolean };
  setup(n: number, neighbors: Int32Array): Promise<unknown>;
  step(input: Float64Array, tick: number, rain: boolean, light: number, options: ParityOptions): Promise<{ data: Float64Array }>;
  close(): Promise<void>;
}
export interface ParityOptions {
  seed: number; cuencas: number; decaimientoFertilidad: number; localEcology: true;
  recursos: typeof HISTORICAL_PARAMS.recursos;
}
export interface ParityResult {
  device: number; available: boolean; enabled: boolean; reason?: string; diagnostic?: ParityDiagnostic;
  initializationMs: number; verificationMs: number; cells: number; comparisons: number;
}
interface ComputeHelpers {
  pack(tiles: Tile[]): Float64Array;
  topology(tiles: Tile[]): Int32Array;
}
export interface AutopruebaOptions {
  nvrtc?: string;
  budgetMs?: number;
  createBackend?: (device: number, nvrtc: string) => Promise<ParityBackend>;
  log?: (diagnostic: ParityDiagnostic) => void;
}
const elapsed = (start: bigint): number => Number(process.hrtime.bigint() - start) / 1e6;
const BUDGET_MS = 200;

// Both source execution and dist/server resolve the versioned scripts in this checkout.
async function computeModule<T>(name: string): Promise<T> {
  const relative = `scripts/${name}.mjs`;
  const path = [new URL(`../../../${relative}`, import.meta.url), new URL(`../../../../${relative}`, import.meta.url)]
    .find(candidate => existsSync(candidate));
  if (!path) throw new Error('No se encontró el runner CUDA.');
  return import(path.href);
}
export async function createParityBackend(device: number, nvrtc: string): Promise<ParityBackend> {
  const { GPUWorker } = await computeModule<{ GPUWorker: { create(devices: string, library: string): Promise<ParityBackend> } }>('compute-ecology-clients');
  return GPUWorker.create(String(device), nvrtc);
}

/** Dense signed coordinates straddle every multiple of 24; all biomes/features and optional growth. */
export function parityFixture(): Tile[] {
  const biomes: Biome[] = ['grassland', 'forest', 'desert', 'mountain', 'wetland', 'ocean'];
  const features: (Feature | undefined)[] = [undefined, 'none', 'tree', 'pine', 'palm', 'cactus', 'reeds', 'stump', 'spring', 'pool', 'berries', 'flowers', 'rock', 'clay'];
  return Array.from({ length: 4096 }, (_, i) => ({
    x: i % 64 - 32, y: Math.floor(i / 64) - 32,
    terrain: i % 11 === 0 ? 'water' : 'meadow', biome: biomes[i % biomes.length], feature: features[i % features.length],
    moisture: [0, 0.14999999999999997, 0.15, 0.9, 1][i % 5], vegetation: (i % 997) / 997,
    food: (i % 991) / 991, fertility: (i % 983) / 983, life: i % 2 ? 0.45 : 0.44999999999999996,
    ...(i % 3 ? { growth: 0.9 } : {}), ...(i % 4 ? { wood: 0.999 } : {}),
    traffic: i % 7 ? 0 : 0.2, cultivation: i % 13 ? 0 : 0.3, drinkingWater: 0.2,
  }));
}

/** Execution state only. A failed device can never be re-enabled by a later initialization in this session. */
export class GPUParitySession {
  private readonly results = new Map<number, ParityResult>();
  private readonly pending = new Map<number, Promise<ParityResult>>();
  get performance(): readonly ParityResult[] { return [...this.results.values()].map(value => structuredClone(value)); }
  isEnabled(device: number): boolean { return this.results.get(device)?.enabled === true; }

  initialize(device: number, options: AutopruebaOptions = {}): Promise<ParityResult> {
    const previous = this.results.get(device);
    if (previous) return Promise.resolve(structuredClone(previous));
    const pending = this.pending.get(device);
    if (pending) return pending;
    const job = this.verify(device, options).then(result => {
      this.results.set(device, result); this.pending.delete(device); return structuredClone(result);
    });
    this.pending.set(device, job); return job;
  }

  private async verify(device: number, options: AutopruebaOptions): Promise<ParityResult> {
    const start = process.hrtime.bigint();
    let backend: ParityBackend | undefined;
    let info: GPUInfo | undefined, verificationStart: bigint | undefined;
    let comparisons = 0, timer: ReturnType<typeof setTimeout> | undefined, expired = false;
    let failure: ParityResult | undefined;
    const result = (available: boolean, enabled: boolean, reason?: string, diagnostic?: ParityDiagnostic): ParityResult => ({
      device, available, enabled, ...(reason ? { reason } : {}), ...(diagnostic ? { diagnostic } : {}),
      initializationMs: verificationStart ? Number(verificationStart - start) / 1e6 : elapsed(start),
      verificationMs: verificationStart ? elapsed(verificationStart) : 0, cells: 4096, comparisons,
    });
    const disable = (reason: string, index: number | null = null, expected: number | null = null, actual: number | null = null): ParityResult => {
      if (failure) return failure;
      const diagnostic = { device, architecture: info?.architecture ?? 'desconocida', driver: info?.driver,
        firstDivergentIndex: index, expected, actual, reason };
      failure = result(true, false, reason, diagnostic);
      options.log?.(diagnostic);
      return failure;
    };
    try {
      const nvrtc = options.nvrtc ?? process.env.COMPUTE_NVRTC;
      if (!nvrtc) return result(false, false, 'no disponible');
      backend = await (options.createBackend ?? createParityBackend)(device, nvrtc);
      info = backend.initialization.devices.find(candidate => candidate.index === device);
      if (!info || backend.initialization.fmad || !info.compileOptions.includes('--fmad=false')
        || info.compileOptions.some(option => option === '--fmad=true' || option.includes('fast_math')))
        return disable('Opciones NVRTC incompatibles con paridad FP64 (--fmad=false requerido).');
      const helpers = await computeModule<ComputeHelpers>('compute-ecology-core');
      const tiles = parityFixture(), packedInput = helpers.pack(tiles);
      await backend.setup(tiles.length, helpers.topology(tiles));
      const kernel = new EcosystemKernel();
      const quadrants: { tick: number; rain: boolean; light: number; args: ParityOptions; expected: Float64Array }[] = [];
      let qIndex = 0;
      for (const cuencas of [1, 0.4]) for (const decaimientoFertilidad of [0, 0.001]) {
        const tick = [100, 310, 1600, 1900][qIndex]!, phase = phaseAt(tick), rain = qIndex % 2 === 0;
        const light = phase === 'day' ? 1 : phase === 'night' ? 0 : 0.4;
        const params = { ...HISTORICAL_PARAMS, recursos: { ...HISTORICAL_PARAMS.recursos, decaimientoFertilidad }, agua: { ...HISTORICAL_PARAMS.agua, cuencas } };
        const reference = { tiles: tiles.map(tile => ({ ...tile })), tick, seed: 51926, weather: rain ? 'rain' : 'clear' } as World;
        setParams(reference, params);
        const args: ParityOptions = { seed: 51926, cuencas, decaimientoFertilidad, localEcology: true, recursos: params.recursos };
        ecology(reference); kernel.step(reference.tiles, tick, reference.weather, phase, args);
        quadrants.push({ tick, rain, light, args, expected: helpers.pack(reference.tiles) });
        qIndex++;
      }
      // Context creation, NVRTC, topology setup and CPU oracle preparation are initialization costs, recorded separately.
      const budgetMs = options.budgetMs ?? BUDGET_MS;
      verificationStart = process.hrtime.bigint();
      const check = async (): Promise<ParityResult> => {
        for (const { tick, rain, light, args, expected } of quadrants) {
          const actual = (await backend!.step(packedInput, tick, rain, light, args)).data;
          if (expired) return failure!;
          comparisons++;
          if (actual.length !== expected.length) return disable('Tamaño de salida distinto.', Math.min(actual.length, expected.length));
          for (let i = 0; i < expected.length; i++) if (!Object.is(expected[i], actual[i]))
            return disable('Divergencia FP64.', i, expected[i], actual[i]);
          if (elapsed(verificationStart!) > budgetMs) return disable(`Autoprueba excedió ${budgetMs} ms.`);
        }
        return result(true, true);
      };
      return await Promise.race([check(), new Promise<ParityResult>(resolve => {
        timer = setTimeout(() => { expired = true; resolve(disable(`Autoprueba excedió ${budgetMs} ms.`)); }, budgetMs);
      })]);
    } catch (error) {
      if (!backend) return result(false, false, 'no disponible');
      return disable(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
      await backend?.close().catch(() => {});
    }
  }
}

export const gpuParitySession = new GPUParitySession();
