import type { Feature, Tile } from '../shared/types.js';
import { enCuenca } from './agua.js';
import { TileStore } from './soa/terreno.js';
import { StaticWorkerPool, type StaticWorkerDiagnostics, type StaticWorkerHandlerJob } from './paralelo/piscina.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runParallelEcology, type ParallelEcologyParams } from './ecology-kernel.js';
import type { WorldParams } from './params.js';
import { ResidentGpuBridge, type GpuBridgeStats } from './gpu/puente.js';

const clamp = (n: number): number => Math.max(0, Math.min(1, n));
const TREE_FEATURES = new Set<Feature>(['tree', 'pine', 'palm', 'cactus', 'reeds', 'stump']);
const MAX_TOPOLOGIES = 4;
const NO_NEIGHBORS: Int32Array = new Int32Array(0), NO_LIFE: Float64Array = new Float64Array(0);

/** Opciones de la ecología: T013 (`decaimientoFertilidad`) + T035 (`seed`/`cuencas`) + T112 (`soaTerreno`,
 * la topología sobre el SoA de terreno; `motor.soaTerreno`, default `false` = la caché de hoy). */
export interface EcosystemBarrierEvent {
  tick: number; phase: 'ecologia' | 'kernel'; regionSide: 256 | 512;
  orden: 'natural' | 'inverso' | 'adversarial'; workers: number;
  dirtyPages: readonly { pageX: number; pageY: number }[] | undefined;
  diagnostics: StaticWorkerDiagnostics | null;
  topologyCertificate: { tiles: Tile[]; revision: object } | undefined;
  gpu?: readonly number[];
  gpuStats?: GpuBridgeStats;
}
export interface EcologyExecution {
  regionSide?: 256 | 512;
  onBarrier?: (event: EcosystemBarrierEvent) => void;
}
export interface EcosystemOptions extends EcologyExecution {
  decaimientoFertilidad?: number; seed?: number; cuencas?: number; soaTerreno?: boolean; hilos?: number;
  orden?: 'natural' | 'inverso' | 'adversarial';
  gpu?: readonly number[];
}
export interface EcosystemKernelOptions { createPool?: (workers: number) => StaticWorkerPool }

/**
 * Índice ordenado de vecinos + la ÚNICA instantánea que la regla necesita.
 *
 * R4 (perfilado del bucle caliente): antes se copiaban siete campos de cada tesela a siete
 * `Float64Array` antes de actualizar nada. Solo `life` se lee de OTRA tesela (la vecindad viva);
 * los seis restantes se leían únicamente en el índice `i`, justo antes de que esa misma iteración
 * los reescribiera, así que leerlos de la tesela da exactamente el mismo doble. Se conserva el
 * único campo que de verdad necesita una foto previa.
 */
export interface Topology {
  coordinates: Float64Array;
  neighbors: Int32Array;
  life: Float64Array;
}

function sameCoordinates(topology: Topology, tiles: readonly Tile[]): boolean {
  if (topology.coordinates.length !== tiles.length * 2) return false;
  for (let i = 0; i < tiles.length; i++) {
    if (!Object.is(topology.coordinates[i * 2], tiles[i].x)
      || !Object.is(topology.coordinates[i * 2 + 1], tiles[i].y)) return false;
  }
  return true;
}

/**
 * R4: el índice de posiciones es un mapa de filas (`y` → `x` → índice) con claves NUMÉRICAS. La
 * versión anterior construía una clave de cadena `${x},${y}` por tesela y otra por cada uno de sus
 * ocho vecinos — nueve cadenas por tesela cada vez que el mundo carga o retira un chunk y la
 * topología se reconstruye. El mapa anidado es inyectivo para cualquier par de enteros (no supone
 * ningún rango de coordenadas) y conserva el mismo orden de vecinos, el mismo `-1` para los
 * ausentes y el mismo rechazo de coordenadas duplicadas antes de tocar nada.
 */
export function buildTopology(tiles: readonly Tile[]): Topology {
  const length = tiles.length;
  const coordinates = new Float64Array(length * 2);
  const rows = new Map<number, Map<number, number>>();
  for (let i = 0; i < length; i++) {
    const tile = tiles[i];
    let row = rows.get(tile.y);
    if (row === undefined) { row = new Map<number, number>(); rows.set(tile.y, row); }
    if (row.has(tile.x)) throw new Error('El ecosistema requiere coordenadas únicas.');
    row.set(tile.x, i);
    coordinates[i * 2] = tile.x; coordinates[i * 2 + 1] = tile.y;
  }
  const neighbors = new Int32Array(length * 8).fill(-1);
  for (let i = 0; i < length; i++) {
    const tile = tiles[i];
    let offset = i * 8;
    for (let dy = -1; dy <= 1; dy++) {
      const row = rows.get(tile.y + dy);
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        neighbors[offset++] = row === undefined ? -1 : row.get(tile.x + dx) ?? -1;
      }
    }
  }
  return { coordinates, neighbors, life: new Float64Array(length) };
}

/** Scratch storage only: no Tile references or ecological values are reused between calls.
 * Ordered coordinates are checked even when cloneWorld replaces every object.
 * A cache hit changes allocation cost, never the rules or their arithmetic order.
 */
export class EcosystemKernel {
  private readonly topologies: Topology[] = [];
  private soa: TileStore | null = null;
  private readonly pools = new Map<number, StaticWorkerPool>();
  private readonly gpuBridges = new Map<string, ResidentGpuBridge>();
  private lastGpuBridge: ResidentGpuBridge | null = null;
  private lastPool: StaticWorkerPool | null = null;
  private readonly createPool: (workers: number) => StaticWorkerPool;

  constructor(options?: EcosystemKernelOptions) {
    this.createPool = options?.createPool ?? (workers => {
      const js = new URL('./ecosystem-kernel.js', import.meta.url);
      return new StaticWorkerPool({ workers, moduleURL: existsSync(fileURLToPath(js)) ? js : new URL('./ecosystem-kernel.ts', import.meta.url), exportName: 'runParallelEcosystem' });
    });
  }
  get parallelDiagnostics(): StaticWorkerDiagnostics | null { return this.lastPool?.diagnostics() ?? null; }
  get gpuDiagnostics(): GpuBridgeStats | null { return this.lastGpuBridge?.lastStats ?? null; }
  /** Solo para la prueba de aborto: mata el subproceso del puente activo sin tocar el mundo. */
  killGpuSubprocessForTest(): void { this.lastGpuBridge?.killSubprocessForTest(); }
  private gpuBridge(devices: readonly number[]): ResidentGpuBridge {
    const key = devices.join(',');
    let bridge = this.gpuBridges.get(key);
    if (!bridge) { bridge = new ResidentGpuBridge(devices); this.gpuBridges.set(key, bridge); }
    this.lastGpuBridge = bridge; return bridge;
  }
  private dropGpuBridge(bridge: ResidentGpuBridge): void {
    for (const [key, value] of this.gpuBridges) if (value === bridge) this.gpuBridges.delete(key);
    if (this.lastGpuBridge === bridge) this.lastGpuBridge = null;
    void bridge.close().catch(() => undefined);
  }
  async closeParallelPool(): Promise<void> {
    await Promise.all([...this.pools.values()].map(pool => pool.close()));
    this.pools.clear(); this.lastPool = null;
    await Promise.all([...this.gpuBridges.values()].map(bridge => bridge.close()));
    this.gpuBridges.clear(); this.lastGpuBridge = null;
  }
  async closeGpuBridges(): Promise<void> {
    await Promise.all([...this.gpuBridges.values()].map(bridge => bridge.close()));
    this.gpuBridges.clear(); this.lastGpuBridge = null;
  }

  get cachedTopologyCount(): number { return this.topologies.length; }
  /** T112: el `TileStore` de la topología SoA, si alguna pasada lo usó (para medir sus bytes). */
  get soaStore(): TileStore | null { return this.soa; }

  /** Primera pasada, sobre el MISMO pool residente, completada antes del kernel de vida. */
  stepEcology(tiles: Tile[], tick: number, weather: 'clear' | 'rain', phase: string,
    recursos: WorldParams['recursos'], options: EcosystemOptions): void {
    if (tick % 10 !== 0) return;
    const gpu = options.gpu;
    if (gpu && gpu.length > 0) {
      const store = this.soa ??= new TileStore(), terrain = store.prepareParallel(tiles, options.regionSide);
      this.topologies.length = 0;
      const bridge = this.gpuBridge(gpu);
      store.beginParallel();
      let result;
      try {
        result = bridge.run(terrain, store.pageSetVersion, 'ecologia', {
          version: terrain.version, rain: weather === 'rain' ? 1 : 0,
          light: phase === 'day' ? 1 : phase === 'night' ? 0 : 0.4,
          capacidadBosque: recursos.capacidadBosque, capacidadPastizal: recursos.capacidadPastizal,
          capacidadOtros: recursos.capacidadOtros, velocidadRegeneracion: recursos.velocidadRegeneracion,
          decaimientoComida: recursos.decaimientoComida,
        }, options.regionSide ?? 256);
        store.commitParallel('ecologia');
      } catch (error) { store.abortParallel(); this.dropGpuBridge(bridge); throw error; }
      options.onBarrier?.({ tick, phase: 'ecologia', regionSide: options.regionSide ?? 256,
        orden: options.orden ?? 'natural', workers: gpu.length, dirtyPages: result.dirtyPages,
        diagnostics: null, topologyCertificate: store.parallelTopologyCertificate(tiles), gpu, gpuStats: result });
      return;
    }
    const workers = options.hilos ?? 1;
    if (!Number.isSafeInteger(workers) || workers <= 1) throw new RangeError('El despacho paralelo de ecology requiere hilos > 1.');
    const store = this.soa ??= new TileStore(), terrain = store.prepareParallel(tiles, options.regionSide);
    let pool = this.pools.get(workers);
    if (!pool) { pool = this.createPool(workers); this.pools.set(workers, pool); }
    this.lastPool = pool; this.topologies.length = 0;
    store.beginParallel();
    try {
      const params: ParallelEcologyParams = { phase: 'ecologia', weather,
        light: phase === 'day' ? 1 : phase === 'night' ? 0 : 0.4, recursos, version: terrain.version };
      pool.run({ regions: terrain.regions, buffers: terrain.buffers, orden: options.orden, params });
      store.commitParallel('ecologia');
    } catch (error) { store.abortParallel(); throw error; }
    options.onBarrier?.({ tick, phase: 'ecologia', regionSide: options.regionSide ?? 256,
      orden: options.orden ?? 'natural', workers, dirtyPages: store.dirtyPageCoordinates(),
      diagnostics: pool.diagnostics(), topologyCertificate: store.parallelTopologyCertificate(tiles) });
  }

  /**
   * `seed`/`cuencas` (T035 ronda de arreglo, hallazgo crítico #1): con el default `cuencas=1` el
   * gateo de cuenca nunca excluye nada (bit a bit igual a hoy para cualquier llamador que no los
   * pase). El llamador real (`stepEcosystem` en `ecosystem.ts`, cableado desde `stepWorld`) pasa
   * `world.seed`/`paramsOf(world).agua.cuencas` para que una tesela fuera de cuenca NO se rellene
   * con la lluvia (antes: `reservoir` ignoraba la cuenca y la regla de T035 se deshacía en la
   * siguiente lluvia).
   */
  step(tiles: Tile[], tick: number, weather: 'clear' | 'rain', phase: string, options?: EcosystemOptions): void {
    if (tick % 10 !== 0) return;
    const workers = options?.hilos ?? 1;
    if (!Number.isSafeInteger(workers) || workers < 1) throw new RangeError('hilos debe ser un entero positivo.');
    const gpu = options?.gpu;
    if (gpu && gpu.length > 0) {
      const store = this.soa ??= new TileStore();
      const terrain = store.prepareParallel(tiles, options?.regionSide);
      this.topologies.length = 0;
      const bridge = this.gpuBridge(gpu);
      store.beginParallel();
      let result;
      try {
        result = bridge.run(terrain, store.pageSetVersion, 'kernel', {
          tick, version: terrain.version, rain: weather === 'rain' ? 1 : 0,
          light: phase === 'day' ? 1 : phase === 'night' ? 0 : 0.4,
          decaimientoFertilidad: options?.decaimientoFertilidad ?? 0,
          seed: (options?.seed ?? 0) >>> 0, cuencas: options?.cuencas ?? 1,
        }, options.regionSide ?? 256);
        store.commitParallel();
      } catch (error) { store.abortParallel(); this.dropGpuBridge(bridge); throw error; }
      options?.onBarrier?.({ tick, phase: 'kernel', regionSide: options.regionSide ?? 256,
        orden: options.orden ?? 'natural', workers: gpu.length, dirtyPages: result.dirtyPages,
        diagnostics: null, topologyCertificate: store.parallelTopologyCertificate(tiles), gpu, gpuStats: result });
      return;
    }
    if (workers > 1) {
      const store = this.soa ??= new TileStore();
      const terrain = store.prepareParallel(tiles, options?.regionSide);
      let pool = this.pools.get(workers);
      if (!pool) { pool = this.createPool(workers); this.pools.set(workers, pool); }
      this.lastPool = pool; this.topologies.length = 0;
      store.beginParallel();
      try {
        pool.run({ regions: terrain.regions, buffers: terrain.buffers, orden: options?.orden, params: {
          tick, weather, light: phase === 'day' ? 1 : phase === 'night' ? 0 : 0.4,
          decaimientoFertilidad: options?.decaimientoFertilidad ?? 0,
          seed: options?.seed ?? 0, cuencas: options?.cuencas ?? 1, version: terrain.version,
        } });
        store.commitParallel();
      } catch (error) { store.abortParallel(); throw error; }
      options?.onBarrier?.({ tick, phase: 'kernel', regionSide: options.regionSide ?? 256,
        orden: options.orden ?? 'natural', workers, dirtyPages: store.dirtyPageCoordinates(),
        diagnostics: pool.diagnostics(), topologyCertificate: store.parallelTopologyCertificate(tiles) });
      return;
    }
    this.soa?.releaseParallelObjects();
    const decaimientoFertilidad = options?.decaimientoFertilidad ?? 0;
    const seed = options?.seed ?? 0, cuencas = options?.cuencas ?? 1;
    // T112: con `soaTerreno` la foto de `life` y la presencia van al SoA y los vecinos salen por aritmética;
    // no se retiene ninguna topología. Coordenadas fuera del dominio entero del SoA: camino de objetos.
    const store = options?.soaTerreno === true ? this.soaTopology(tiles) : null;
    const length = tiles.length, cells = store?.cells, living = store?.livingNeighborCounts(0.45), front = store?.lifeFront;
    let neighbors = NO_NEIGHBORS, lifeBefore = NO_LIFE;
    if (store === null) {
      const index = this.topologies.findIndex(topology => sameCoordinates(topology, tiles));
      // Build and reject duplicate coordinates before modifying any tile or cache.
      const previous = index < 0 ? buildTopology(tiles) : this.topologies[index];
      if (index >= 0) this.topologies.splice(index, 1);
      this.topologies.unshift(previous);
      if (this.topologies.length > MAX_TOPOLOGIES) this.topologies.pop();
      neighbors = previous.neighbors; lifeBefore = previous.life;
      // La vecindad viva se lee de la foto previa; el resto de campos se lee de la propia tesela en
      // su iteración, antes de que esa misma iteración los reescriba (mismo valor, mismo orden).
      for (let i = 0; i < length; i++) lifeBefore[i] = tiles[i].life ?? 0;
    }
    const light = phase === 'day' ? 1 : phase === 'night' ? 0 : 0.4;
    for (let i = 0; i < length; i++) {
      const tile = tiles[i];
      // R4: cada campo se lee UNA vez. `terrain`, `biome` y `feature` se leían entre dos y tres
      // veces por tesela, y las teselas vivas no tienen forma estable (`animals.ts:101` hace
      // `delete tile.species` en cada paso), así que cada lectura repetida es una búsqueda en tabla
      // hash en vez de un acceso a ranura.
      const vegetation = tile.vegetation, moisture = tile.moisture;
      const terrain = tile.terrain, biome = tile.biome, feature = tile.feature;
      const growth = tile.growth ?? vegetation, fertility = tile.fertility ?? 0;
      const drinkingWater = tile.drinkingWater ?? 0, cultivation = tile.cultivation ?? 0, traffic = tile.traffic ?? 0;
      let livingNeighbors = 0, life: number;
      if (store !== null) {
        life = front![cells![i]]; livingNeighbors = living![i];
      } else {
        life = lifeBefore[i];
        const base = i * 8;
        for (let offset = 0; offset < 8; offset++) {
          const neighbor = neighbors[base + offset];
          if (neighbor >= 0 && lifeBefore[neighbor] >= 0.45) livingNeighbors++;
        }
      }
      const fertilePattern = livingNeighbors === 3 || (life >= 0.45 && livingNeighbors === 2);
      const cellularEnergy = light * moisture * (0.6 + fertility * 0.4);
      tile.life = clamp(life + ((fertilePattern ? 1 : 0) - life) * 0.2 * cellularEnergy
        - (moisture < 0.15 ? 0.015 : 0) - traffic * 0.004);
      tile.fertility = clamp(fertility + life * 0.0012 - traffic * 0.0007 - cultivation * 0.0002 - decaimientoFertilidad * fertility);
      const produced = light * moisture * fertility * (0.25 + life * 0.75)
        * (1 - growth) * (1 - traffic * 0.9) * 0.005;
      tile.growth = clamp(growth + produced - 0.0002 - traffic * 0.002 - (moisture < 0.15 ? 0.001 : 0));
      if (terrain !== 'water') tile.vegetation = clamp(vegetation + produced * 0.25 - traffic * 0.001);
      tile.traffic = clamp(traffic - 0.0005);
      tile.cultivation = clamp(cultivation - 0.00002);
      // Rain remains restricted to the same visible reservoirs as the object kernel.
      const reservoirSource = feature === 'pool' || feature === 'spring' || biome === 'wetland' || terrain === 'water';
      // T035 (hallazgo crítico #1): fuera de cuenca, un manantial/charca/humedal NO recarga con la
      // lluvia (ni con el goteo fijo del manantial) — el mar (`terrain==='water'`) queda exento del
      // ruido, igual que en la generación, y de todos modos su `drinkingWater` se fuerza a 0 abajo.
      const reservoir = reservoirSource && (terrain === 'water' || enCuenca(seed, tile.x, tile.y, cuencas));
      tile.drinkingWater = biome === 'ocean' ? 0 : clamp(drinkingWater
        + (reservoir && weather === 'rain' ? 0.008 * (0.4 + fertility * 0.6) : 0)
        + (reservoir && feature === 'spring' ? 0.002 : 0) - (light ? 0.00015 : 0.00003));
      if (terrain === 'water') tile.moisture = clamp(moisture + (biome === 'ocean' ? 0.003 : 0) + (weather === 'rain' ? 0.008 : 0));
      // Wood consumes local growth; feature changes still use this tile's old growth.
      if (tick % 100 === 0 && TREE_FEATURES.has(feature ?? 'none') && growth > 0.65
        && fertility > 0.4 && moisture > 0.35 && traffic < 0.35 && light > 0) {
        const capacity = feature === 'reeds' || feature === 'cactus' ? 2 : feature === 'palm' ? 6 : 12;
        const regrowth = Math.min(capacity - (tile.wood ?? 0), 0.025 * light * moisture * fertility);
        if (regrowth > 0) {
          tile.wood = (tile.wood ?? 0) + regrowth;
          tile.growth = clamp(tile.growth! - regrowth * 0.05);
          if (feature === 'stump' && tile.wood >= 1) tile.feature = biome === 'mountain' ? 'pine' : 'tree';
        }
      }
    }
    options?.onBarrier?.({ tick, phase: 'kernel', regionSide: options.regionSide ?? 256,
      orden: options.orden ?? 'natural', workers: 1, dirtyPages: undefined,
      diagnostics: null, topologyCertificate: undefined });
  }

  /** Carga la topología en el SoA (sella presencia, copia `life`); `null` si alguna coordenada no cabe en su
   * dominio entero. Con éxito, suelta la caché de topologías del camino de objetos. */
  private soaTopology(tiles: readonly Tile[]): TileStore | null {
    const store = this.soa ??= new TileStore();
    if (!store.loadLife(tiles)) return null;
    this.topologies.length = 0;
    return store;
  }
}

interface ParallelEcosystemParams {
  tick: number; weather: 'clear' | 'rain'; light: number; decaimientoFertilidad: number;
  seed: number; cuencas: number; version: number;
}

/** Cuerpo FP64 del kernel vivo, con el mismo orden de operaciones y sin reducciones entre celdas.
 * Los vecinos siempre se leen del frente compartido, incluso al cruzar la región de la cola. */
export function runParallelEcosystem(job: StaticWorkerHandlerJob<ParallelEcosystemParams | ParallelEcologyParams>): void {
  if ('phase' in job.params && job.params.phase === 'ecologia') {
    runParallelEcology(job as StaticWorkerHandlerJob<ParallelEcologyParams>); return;
  }
  const { regions, buffers, params } = job as StaticWorkerHandlerJob<ParallelEcosystemParams>;
  const { tick, weather, light, decaimientoFertilidad, seed, cuencas, version } = params;
  const cells = new Int32Array(buffers.cells!), stamps = new Uint32Array(buffers.stamps!);
  const around = new Int32Array(buffers.around!), pageX = new Int32Array(buffers.pageX!), pageY = new Int32Array(buffers.pageY!);
  const lifeFront = new Float64Array(buffers.life!), lifeBack = new Float64Array(buffers.lifeBack!);
  const terrain = new Uint8Array(buffers.terrain!), biome = new Uint8Array(buffers.biome!), feature = new Uint8Array(buffers.feature!);
  const terrainBack = new Uint8Array(buffers.terrainBack!), biomeBack = new Uint8Array(buffers.biomeBack!), featureBack = new Uint8Array(buffers.featureBack!);
  const moistureFront = new Float64Array(buffers.moisture!), moistureBack = new Float64Array(buffers.moistureBack!);
  const vegetationFront = new Float64Array(buffers.vegetation!), vegetationBack = new Float64Array(buffers.vegetationBack!);
  const fertilityFront = new Float64Array(buffers.fertility!), fertilityBack = new Float64Array(buffers.fertilityBack!);
  const growthFront = new Float64Array(buffers.growth!), growthBack = new Float64Array(buffers.growthBack!);
  const trafficFront = new Float64Array(buffers.traffic!), trafficBack = new Float64Array(buffers.trafficBack!);
  const cultivationFront = new Float64Array(buffers.cultivation!), cultivationBack = new Float64Array(buffers.cultivationBack!);
  const drinkingFront = new Float64Array(buffers.drinkingWater!), drinkingBack = new Float64Array(buffers.drinkingWaterBack!);
  const woodFront = new Float64Array(buffers.wood!), woodBack = new Float64Array(buffers.woodBack!);
  const foodFront = buffers.food ? new Float64Array(buffers.food) : undefined;
  const foodBack = buffers.foodBack ? new Float64Array(buffers.foodBack) : undefined;
  const dirty = new Uint8Array(buffers.dirty!), woodAdded = new Uint8Array(buffers.woodAdded!);
  const woodAddedQueue = buffers.woodAddedQueue ? new Int32Array(buffers.woodAddedQueue) : undefined;
  if (woodAddedQueue) Atomics.store(woodAddedQueue, 0, 1);
  for (const region of regions) for (let i = region.begin; i < region.end; i++) {
    const cell = cells[i]!, slot = cell >>> 8, lx = cell & 15, ly = (cell >> 4) & 15;
    const vegetation = vegetationFront[cell]!, moisture = moistureFront[cell]!;
    const growth = Number.isNaN(growthFront[cell]!) ? vegetation : growthFront[cell]!;
    const fertility = Number.isNaN(fertilityFront[cell]!) ? 0 : fertilityFront[cell]!;
    const traffic = Number.isNaN(trafficFront[cell]!) ? 0 : trafficFront[cell]!;
    const cultivation = Number.isNaN(cultivationFront[cell]!) ? 0 : cultivationFront[cell]!;
    const drinkingWater = Number.isNaN(drinkingFront[cell]!) ? 0 : drinkingFront[cell]!;
    const life = Number.isNaN(lifeFront[cell]!) ? 0 : lifeFront[cell]!;
    const localTerrain = terrain[cell]!, localBiome = biome[cell]!, localFeature = feature[cell]!;
    let livingNeighbors = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = lx + dx, ny = ly + dy;
      const target = around[slot * 9 + (ny < 0 ? 0 : ny > 15 ? 6 : 3) + (nx < 0 ? 0 : nx > 15 ? 2 : 1)]!;
      if (target < 0) continue;
      const neighbor = (target << 8) | ((ny & 15) << 4) | (nx & 15);
      if (stamps[neighbor] === version && lifeFront[neighbor]! >= 0.45) livingNeighbors++;
    }
    const fertilePattern = livingNeighbors === 3 || (life >= 0.45 && livingNeighbors === 2);
    const cellularEnergy = light * moisture * (0.6 + fertility * 0.4);
    lifeBack[cell] = clamp(life + ((fertilePattern ? 1 : 0) - life) * 0.2 * cellularEnergy
      - (moisture < 0.15 ? 0.015 : 0) - traffic * 0.004);
    fertilityBack[cell] = clamp(fertility + life * 0.0012 - traffic * 0.0007 - cultivation * 0.0002 - decaimientoFertilidad * fertility);
    const produced = light * moisture * fertility * (0.25 + life * 0.75)
      * (1 - growth) * (1 - traffic * 0.9) * 0.005;
    growthBack[cell] = clamp(growth + produced - 0.0002 - traffic * 0.002 - (moisture < 0.15 ? 0.001 : 0));
    vegetationBack[cell] = localTerrain !== 1 ? clamp(vegetation + produced * 0.25 - traffic * 0.001) : vegetation;
    trafficBack[cell] = clamp(traffic - 0.0005); cultivationBack[cell] = clamp(cultivation - 0.00002);
    const reservoirSource = localFeature === 12 || localFeature === 11 || localBiome === 5 || localTerrain === 1;
    const reservoir = reservoirSource && (localTerrain === 1 || enCuenca(seed, pageX[slot]! * 16 + lx, pageY[slot]! * 16 + ly, cuencas));
    drinkingBack[cell] = localBiome === 6 ? 0 : clamp(drinkingWater
      + (reservoir && weather === 'rain' ? 0.008 * (0.4 + fertility * 0.6) : 0)
      + (reservoir && localFeature === 11 ? 0.002 : 0) - (light ? 0.00015 : 0.00003));
    moistureBack[cell] = localTerrain === 1 ? clamp(moisture + (localBiome === 6 ? 0.003 : 0) + (weather === 'rain' ? 0.008 : 0)) : moisture;
    woodBack[cell] = woodFront[cell]!; featureBack[cell] = localFeature;
    terrainBack[cell] = localTerrain; biomeBack[cell] = localBiome;
    if (foodFront && foodBack) foodBack[cell] = foodFront[cell]!;
    if (tick % 100 === 0 && ((localFeature >= 1 && localFeature <= 5) || localFeature === 10) && growth > 0.65
      && fertility > 0.4 && moisture > 0.35 && traffic < 0.35 && light > 0) {
      const capacity = localFeature === 5 || localFeature === 4 ? 2 : localFeature === 3 ? 6 : 12;
      const wood = Number.isNaN(woodFront[cell]!) ? 0 : woodFront[cell]!;
      const regrowth = Math.min(capacity - wood, 0.025 * light * moisture * fertility);
      if (regrowth > 0) {
        woodBack[cell] = wood + regrowth;
        growthBack[cell] = clamp(growthBack[cell]! - regrowth * 0.05);
        if (Number.isNaN(woodFront[cell]!) && woodAdded[slot] === 0) {
          woodAdded[slot] = 1;
          // Cada página pertenece a una sola región/worker. La barrera publica la cola entera.
          if (woodAddedQueue) woodAddedQueue[2 + Atomics.add(woodAddedQueue, 1, 1)] = slot;
        }
        if (localFeature === 10 && woodBack[cell]! >= 1) featureBack[cell] = localBiome === 4 ? 2 : 1;
      }
    }
    dirty[slot] = 1;
  }
}
