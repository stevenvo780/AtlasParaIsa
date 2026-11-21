import type { Biome, Feature, Species, Terrain, Tile } from '../../shared/types.js';
import { PageArena } from './arena.js';
import { Presence } from './presencia.js';
import { PAGE_CELLS, RegionTable, admissibleCoordinate } from './region.js';
import type { StaticRegion } from '../paralelo/particion.js';
import { maintainResidentTile, observeResidentArray, observeResidentTile, residentTopologyOwner,
  residentTopologyToken, sameResidentTopology, type ResidentTopologyOwner, type ResidentTopologyToken } from './topologia.js';

/**
 * `TileStore` (T112): el terreno en estructura de arrays, detrás de `motor.soaTerreno`. Un buffer por
 * campo sobre la arena de páginas (`arena.ts`), regiones de 256 × 256 como tablas de páginas
 * (`region.ts`), coordenadas implícitas en `(página, offset)` y presencia por sello (`presencia.ts`).
 * Enumerados como `Uint8` (0 = ausente); numéricos como `Float64` con `NaN` = ausente, que no choca con
 * ningún valor guardable porque el mundo nunca guarda no finitos (`digestoCanonico` los rechaza); `-0` y
 * todo doble se conservan tal cual.
 *
 * Dos modos de carga:
 * - `loadLife`: la topología del kernel de ecología. Sella la presencia y copia `life ?? 0` al frente;
 *   es un espejo de sólo lectura y los objetos siguen siendo la autoridad.
 * - `pack`: todos los campos, ida y vuelta exacta con `unpack`/`flush`.
 *
 * Autoridad única por página: `objeto` (los `Tile` mandan; la SoA es un espejo que una carga refresca) o
 * `soa` (tras `take`: la SoA manda y los objetos quedan rancios hasta `flush`). Cargar sobre páginas con
 * escrituras sin volcar, o escribir la SoA sin haberla tomado, lanza: objeto y SoA nunca son escribibles
 * a la vez. `discard` abandona las escrituras sin tocar los objetos, así que un paso que falla antes de
 * `flush` sigue siendo atómico.
 *
 * Doble buffer sólo para `life`, el único campo que la ley lee de OTRA celda (la vecindad viva): se lee
 * el frente y se escribe el fondo, y `swapLife` los intercambia al terminar la pasada. El resto de campos
 * los lee y escribe cada celda en su propia ranura, así que no necesitan copia.
 */
const TERRAINS: readonly Terrain[] = ['water', 'soil', 'meadow', 'shelter'];
const BIOMES: readonly Biome[] = ['grassland', 'forest', 'desert', 'mountain', 'wetland', 'ocean'];
const FEATURES: readonly Feature[] = ['tree', 'pine', 'palm', 'cactus', 'reeds', 'berries', 'flowers', 'rock', 'clay', 'stump', 'spring', 'pool', 'none'];
const SPECIES: readonly Species[] = ['hare', 'deer', 'boar', 'fish', 'wolf', 'fox'];
const codes = (values: readonly string[]): Map<string, number> => new Map(values.map((value, index) => [value, index + 1]));

type Slot = { kind: 'enum'; key: keyof Tile; values: readonly string[]; codes: Map<string, number> } | { kind: 'number'; key: keyof Tile } | { kind: 'life' };
/** Orden de claves de la interfaz `Tile` (tras `x`, `y`): el que usa `unpack` al crear objetos. */
const LAYOUT: readonly Slot[] = [
  { kind: 'enum', key: 'terrain', values: TERRAINS, codes: codes(TERRAINS) },
  { kind: 'number', key: 'moisture' }, { kind: 'number', key: 'vegetation' }, { kind: 'number', key: 'food' },
  { kind: 'enum', key: 'biome', values: BIOMES, codes: codes(BIOMES) },
  { kind: 'number', key: 'elevation' }, { kind: 'number', key: 'wood' }, { kind: 'number', key: 'stone' },
  { kind: 'enum', key: 'feature', values: FEATURES, codes: codes(FEATURES) },
  { kind: 'number', key: 'variety' }, { kind: 'number', key: 'growth' }, { kind: 'number', key: 'fertility' },
  { kind: 'number', key: 'cultivation' }, { kind: 'number', key: 'traffic' }, { kind: 'number', key: 'drinkingWater' },
  { kind: 'enum', key: 'species', values: SPECIES, codes: codes(SPECIES) },
  { kind: 'number', key: 'fauna' }, { kind: 'life' },
];
const KEYS = new Set<string>(['x', 'y', ...LAYOUT.map(slot => slot.kind === 'life' ? 'life' : slot.key)]);
const OBJECT = 0, SOA = 1;
const DUPLICATE = 'El ecosistema requiere coordenadas únicas.';
const TWO_WRITERS = 'SoA de terreno: la página tiene escrituras sin volcar; objeto y SoA no pueden ser escribibles a la vez.';
const NO_AUTHORITY = 'SoA de terreno: escritura sin autoridad; la página pertenece a los objetos.';

const RESIDENT_NUMBERS = ['moisture', 'vegetation', 'food', 'wood', 'growth', 'fertility', 'cultivation', 'traffic', 'drinkingWater'] as const;
type ResidentKey = typeof RESIDENT_NUMBERS[number] | 'terrain' | 'biome' | 'feature' | 'life';
interface ResidentBinding { store: TileStore; tile: Tile; cell: number; x: number; y: number; mask: number; }
const bindings = new WeakMap<Tile, ResidentBinding>();
const residentStoreByTiles = new WeakMap<Tile[], TileStore>();
const residentKeys: readonly ResidentKey[] = [...RESIDENT_NUMBERS, 'terrain', 'biome', 'feature', 'life'];
const residentKeySet = new Set<PropertyKey>(residentKeys);
const enumValues: Partial<Record<ResidentKey, readonly string[]>> = { terrain: TERRAINS, biome: BIOMES, feature: FEATURES };
const TERRAIN_IDX = residentKeys.indexOf('terrain');
const GROWTH_IDX = residentKeys.indexOf('growth');
const SHELTER_CODE = TERRAINS.indexOf('shelter') + 1;
const residentAccessors = Object.fromEntries(residentKeys.map((key, idx) => {
  const values = enumValues[key];
  return [key, values ? {
    configurable: true, enumerable: true,
    get(this: Tile) { const binding = bindings.get(this)!; return binding.store.residentReadEnum(idx, binding.cell, values); },
    set(this: Tile, value: unknown) { const binding = bindings.get(this)!; binding.store.residentWriteEnum(idx, key, binding.cell, value, values); },
  } : {
    configurable: true, enumerable: true,
    get(this: Tile) { const binding = bindings.get(this)!; return binding.store.residentReadNumber(idx, binding.cell); },
    set(this: Tile, value: unknown) { const binding = bindings.get(this)!; binding.store.residentWriteNumber(idx, key, binding.cell, value); },
  }];
})) as Record<ResidentKey, PropertyDescriptor>;

/** Camino rápido exacto de `faunaCapacity` sobre el SoA residente (0 llamadas a getters/Proxy). */
export function residentFaunaCapacity(tiles: readonly Tile[]): number | undefined {
  const store = residentStoreByTiles.get(tiles as Tile[]);
  return store?.faunaCapacityIfResident(tiles);
}

type ReaderNumbers = { readonly [K in 'growth' | 'vegetation' | 'moisture' | 'drinkingWater' | 'food' | 'wood']: Float64Array };
/** Vista de solo lectura para una fase síncrona sin cambios de topología ni barreras worker.
 * No expone buffers escribibles. Los setters residentes siguen escribiendo en estos mismos arrays;
 * hay que obtener otra vista tras prepare/commit/detach (pueden cambiar páginas, generación o frente).
 * Los códigos 0 representan un enum ausente; NaN representa un número ausente, igual que los getters
 * de Tile. No convertir mediante `||`: perdería -0. */
export class ResidentTileReader {
  readonly TERRAIN_WATER = TERRAINS.indexOf('water') + 1;
  readonly TERRAIN_SHELTER = SHELTER_CODE;
  readonly BIOME_OCEAN = BIOMES.indexOf('ocean') + 1;
  readonly BIOME_DESERT = BIOMES.indexOf('desert') + 1;
  constructor(private readonly regions: RegionTable, private readonly stamps: Uint32Array,
    private readonly version: number, private readonly terrain: Uint8Array, private readonly biome: Uint8Array,
    private readonly numbers: ReaderNumbers) {}

  cellAt(x: number, y: number): number {
    if (!admissibleCoordinate(x) || !admissibleCoordinate(y)) return -1;
    const page = this.regions.slot(x >> 4, y >> 4);
    if (page < 0) return -1;
    const cell = (page << 8) | ((y & 15) << 4) | (x & 15);
    return this.stamps[cell] === this.version ? cell : -1;
  }
  terrainCode(cell: number): number { return this.terrain[cell]!; }
  biomeCode(cell: number): number { return this.biome[cell]!; }
  growth(cell: number): number | undefined { const v = this.numbers.growth[cell]!; return v === v ? v : undefined; }
  vegetation(cell: number): number | undefined { const v = this.numbers.vegetation[cell]!; return v === v ? v : undefined; }
  moisture(cell: number): number | undefined { const v = this.numbers.moisture[cell]!; return v === v ? v : undefined; }
  drinkingWater(cell: number): number | undefined { const v = this.numbers.drinkingWater[cell]!; return v === v ? v : undefined; }
  food(cell: number): number | undefined { const v = this.numbers.food[cell]!; return v === v ? v : undefined; }
  wood(cell: number): number | undefined { const v = this.numbers.wood[cell]!; return v === v ? v : undefined; }
}

/** Sólo un owner observado puede certificar que los buffers siguen representando estas teselas. */
export function residentTileReader(tiles: readonly Tile[]): ResidentTileReader | undefined {
  return residentStoreByTiles.get(tiles as Tile[])?.tileReaderIfResident(tiles);
}

export interface SharedTerrain {
  regions: readonly StaticRegion[];
  buffers: Record<string, SharedArrayBuffer>;
  version: number;
}

export class TileStore {
  private readonly arena = new PageArena();
  private readonly regions = new RegionTable();
  private readonly presence = new Presence(this.arena);
  private generation = -1;
  private inUse!: Uint8Array;
  private pageX!: Int32Array;
  private pageY!: Int32Array;
  private authority!: Uint8Array;
  private dirty!: Uint8Array;
  /** Por ranura, las 9 ranuras de su vecindad de páginas (índice `(dy + 1) · 3 + dx + 1`; -1 ausente). */
  private around!: Int32Array;
  private lives: [Float64Array, Float64Array | null] = [new Float64Array(0), null];
  private parity = 0;
  private fields: Elements[] = [];
  /** Tesela `i` de la última carga → celda. Scratch: se mide con el resto. */
  private cellsOf = new Int32Array(0);
  /** Vecinas vivas por tesela de la última `livingNeighborCounts` (0‥8). Scratch. */
  private counts = new Uint8Array(0);
  private loaded = 0;
  private mode: 'none' | 'life' | 'full' = 'none';
  private presentPages = 0;
  private sweepPending = true;
  private taken = 0;
  private residentTiles: Tile[] | null = null;
  private residentBindings: ResidentBinding[] = [];
  private residentPairs = new Map<ResidentKey, [Float64Array | Uint8Array, Float64Array | Uint8Array]>();
  private residentCur: (Float64Array | Uint8Array)[] = new Array(residentKeys.length);
  private residentGeneration = -1;
  private residentCells = new Int32Array(new SharedArrayBuffer(0));
  private residentRegions: StaticRegion[] = [];
  private residentBusy = false;
  private residentRegionSide: 256 | 512 = 256;
  private residentRevision: object = {};
  private residentTopology: ResidentTopologyToken | undefined;
  private residentOwner: ResidentTopologyOwner | undefined;
  private readonly residentModified = new Set<ResidentBinding>();
  private readonly topologyCosts = { fastHits: 0, genericCheckedTiles: 0, rebuilds: 0, changedBindings: 0 };
  private residentPending: ResidentBinding[] = [];
  private residentAbsent: { key: ResidentKey; binding: ResidentBinding }[] = [];
  private readonly residentWoodHoles = new Map<number, ResidentBinding[]>();
  private residentWoodAdded = new Uint8Array(new SharedArrayBuffer(0));
  /** [protocolo=1, contador, ...slots]. Sólo se consume tras la barrera; workers viejos dejan 0. */
  private residentWoodAddedQueue = new Int32Array(new SharedArrayBuffer(8));
  /** Versión `Uint32` del conjunto de PÁGINAS: sólo cambia cuando entra o sale un chunk. Es lo que valida
   * la vecindad de páginas; la de celdas es `presence.version`. */
  pageSetVersion = 0;

  constructor() { this.refresh(); }

  get version(): number { return this.presence.version; }
  get tileCount(): number { return this.loaded; }
  get pages(): number { return this.presentPages; }
  get regionCount(): number { return this.regions.size; }
  /** Tesela → celda de la última carga (válido en `[0, tileCount)`). */
  get cells(): Int32Array { return this.cellsOf; }
  /** Frente de `life`: lo que la pasada en curso lee de las vecinas. */
  get lifeFront(): Float64Array { return this.lives[this.parity]!; }

  /** Bytes reservados de verdad: arena (con holgura de crecimiento), tablas de región y scratch. */
  get bytes(): number { return this.arena.bytes + this.regions.bytes + this.cellsOf.byteLength + this.counts.byteLength
    + this.residentCells.byteLength + this.residentWoodAdded.byteLength + this.residentWoodAddedQueue.byteLength; }
  get bytesPerTile(): number { return this.loaded ? this.bytes / this.loaded : 0; }
  /** Sólo diagnóstico del trabajo real del coordinador: el rebuild sigue siendo O(T). */
  get parallelTopologyDiagnostics(): Readonly<typeof this.topologyCosts> { return { ...this.topologyCosts }; }

  /**
   * Topología del kernel: sella la presencia y copia `life ?? 0` al frente. `false` (sin haber marcado
   * nada como cargado) si alguna coordenada no es un entero del dominio aritmético: el llamador se queda
   * con el camino de objetos. Coordenadas repetidas lanzan el error del kernel antes de tocar teselas.
   */
  loadLife(tiles: readonly Tile[]): boolean {
    if (this.residentBusy) throw new Error(TWO_WRITERS);
    if (this.residentBindings.length) this.detachResident();
    if (!this.map(tiles, true)) return false;
    this.mode = 'life'; return true;
  }

  /** Todos los campos. Lanza `RangeError` si una tesela no es representable (clave, enumerado o
   * coordenada desconocidos, `NaN`, `-0` en coordenadas). */
  pack(tiles: readonly Tile[]): void {
    if (this.residentBusy) throw new Error(TWO_WRITERS);
    if (this.residentBindings.length) this.detachResident();
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i]!;
      for (const key in tile) if (!KEYS.has(key)) throw new RangeError(`Tesela no representable en el SoA: clave «${key}».`);
      if (Object.is(tile.x, -0) || Object.is(tile.y, -0)) throw new RangeError('Tesela no representable en el SoA: coordenada -0.');
    }
    if (!this.map(tiles, false)) throw new RangeError('Tesela no representable en el SoA: coordenada fuera del dominio entero.');
    this.mode = 'none';
    this.ensureAllFields();
    const cells = this.cellsOf, life = this.lives[this.parity]!;
    try {
      for (let f = 0; f < LAYOUT.length; f++) {
        const slot = LAYOUT[f]!, array = slot.kind === 'life' ? life : this.fields[f]!;
        for (let i = 0; i < tiles.length; i++) {
          const value = (tiles[i] as unknown as Record<string, unknown>)[slot.kind === 'life' ? 'life' : slot.key];
          array[cells[i]!] = encode(slot, value);
        }
      }
    } catch (error) { this.loaded = 0; throw error; }
    this.mode = 'full';
  }

  /** Teselas nuevas, en el orden de la última `pack`, con coordenadas DERIVADAS de `(página, offset)`. */
  unpack(): Tile[] {
    if (this.mode !== 'full') throw new Error('SoA de terreno: no hay una carga completa que desempaquetar.');
    const tiles: Tile[] = new Array(this.loaded);
    for (let i = 0; i < this.loaded; i++) {
      const cell = this.cellsOf[i]!, tile = this.coordinates(cell) as unknown as Record<string, unknown>;
      for (let f = 0; f < LAYOUT.length; f++) {
        const slot = LAYOUT[f]!, value = decode(slot, (slot.kind === 'life' ? this.lives[this.parity]! : this.fields[f]!)[cell]!);
        if (value !== undefined) tile[slot.kind === 'life' ? 'life' : slot.key] = value;
      }
      tiles[i] = tile as unknown as Tile;
    }
    return tiles;
  }

  /** `(x, y)` de una celda, sólo por aritmética. */
  coordinates(cell: number): { x: number; y: number } {
    const slot = cell >>> 8;
    return { x: this.pageX[slot]! * 16 + (cell & 15), y: this.pageY[slot]! * 16 + ((cell >> 4) & 15) };
  }

  /** La SoA pasa a mandar en todas las páginas cargadas. Sólo con una carga completa. */
  take(): void {
    if (this.mode !== 'full') throw new Error('SoA de terreno: sólo una carga completa puede tomar la autoridad.');
    for (let slot = 0; slot < this.arena.slots; slot++) if (this.inUse[slot] && this.presence.pagePresent(slot) && this.authority[slot] === OBJECT) { this.authority[slot] = SOA; this.taken++; }
  }

  /** Escritura de un campo numérico o enumerado (valor ya codificado) bajo autoridad de la SoA. */
  write(key: keyof Tile, cell: number, value: number): void {
    const index = LAYOUT.findIndex(slot => slot.kind !== 'life' && slot.key === key);
    if (index < 0) throw new RangeError(`Campo SoA desconocido: ${String(key)}.`);
    this.own(cell); this.fields[index]![cell] = value;
  }

  /** Nuevo `life` al fondo; el frente sigue siendo lo que leen las vecinas hasta `swapLife`. */
  writeLife(cell: number, value: number): void { this.own(cell); this.back()[cell] = value; }
  lifeAt(cell: number): number { return this.lives[this.parity]![cell]!; }

  /** Intercambia frente y fondo: la pasada debe haber escrito el fondo de todas las celdas presentes. */
  swapLife(): void {
    if (this.taken === 0) throw new Error(NO_AUTHORITY);
    this.back(); this.parity ^= 1; this.syncResidentCur();
  }

  /** Vuelca la SoA en las mismas teselas de la última `pack` y devuelve la autoridad a los objetos. */
  flush(tiles: Tile[]): void {
    if (this.mode !== 'full' || tiles.length !== this.loaded) throw new Error('SoA de terreno: el volcado no corresponde a la última carga.');
    for (let i = 0; i < tiles.length; i++) {
      const { x, y } = this.coordinates(this.cellsOf[i]!);
      if (!Object.is(tiles[i]!.x, x) || !Object.is(tiles[i]!.y, y)) throw new Error('SoA de terreno: el volcado no corresponde a la última carga.');
    }
    for (let i = 0; i < tiles.length; i++) {
      const cell = this.cellsOf[i]!, tile = tiles[i] as unknown as Record<string, unknown>;
      if (this.authority[cell >>> 8] !== SOA) continue;
      for (let f = 0; f < LAYOUT.length; f++) {
        const slot = LAYOUT[f]!, key = slot.kind === 'life' ? 'life' : slot.key;
        const value = decode(slot, (slot.kind === 'life' ? this.lives[this.parity]! : this.fields[f]!)[cell]!);
        if (value !== undefined) tile[key] = value; else if (key in tile) delete tile[key];
      }
    }
    this.release();
  }

  /** Abandona las escrituras sin volcar; los objetos no se tocaron. */
  discard(): void { this.release(); this.mode = 'none'; this.loaded = 0; }

  /** Ranuras con escrituras desde la última `clearDirty`, en orden de ranura. */
  dirtyPages(): number[] {
    const pages: number[] = [];
    for (let slot = 0; slot < this.arena.slots; slot++) if (this.dirty[slot]) pages.push(slot);
    return pages;
  }
  clearDirty(): void { this.dirty.fill(0); }

  /** T115: los objetos conservan identidad y claves, pero sus campos residentes tienen una sola
   * autoridad sobre SAB. El worker escribe exclusivamente el fondo; no publica valores a los Tile. */
  prepareParallel(tiles: Tile[], regionSide: 256 | 512 = 256): SharedTerrain {
    if (regionSide !== 256 && regionSide !== 512) throw new RangeError('Geometría de región debe ser 256 o 512.');
    if (this.residentBusy) throw new Error(TWO_WRITERS);
    const token = residentTopologyToken(tiles);
    let same = tiles === this.residentTiles && tiles.length === this.residentBindings.length;
    if (same && sameResidentTopology(token, this.residentTopology)) this.topologyCosts.fastHits++;
    else if (same && token && this.residentTopology) same = false; // cambio observado: cargar la foto nueva
    // Sin certificado emitido por interceptores, referencias, coordenadas y reflexión se comprueban.
    else if (same) for (let i = 0; i < tiles.length; i++) {
      this.topologyCosts.genericCheckedTiles++;
      const binding = this.residentBindings[i]!, tile = tiles[i]!;
      if (tile !== binding.tile || !Object.is(tile.x, binding.x) || !Object.is(tile.y, binding.y)) { same = false; break; }
      for (let k = 0; k < residentKeys.length; k++) {
        const key = residentKeys[k]!, descriptor = Object.getOwnPropertyDescriptor(tile, key);
        const own = (binding.mask & (1 << k)) !== 0;
        if (own ? descriptor?.get !== residentAccessors[key].get || descriptor?.set !== residentAccessors[key].set
          : descriptor !== undefined) { same = false; break; }
      }
      if (!same) break;
    }
    if (!same) {
      this.topologyCosts.rebuilds++;
      const owner = residentTopologyOwner(tiles);
      const incremental = Boolean(
        token && owner && this.residentTopology && this.residentOwner === owner
        && this.residentBindings.length > 0,
      );
      if (incremental) {
        for (const binding of this.residentModified) {
          if (bindings.get(binding.tile) !== binding) continue;
          this.topologyCosts.changedBindings++;
          this.refreshModifiedBinding(binding);
        }
        this.residentModified.clear();
        // Validación previa fail-closed antes de desligar o mutar nada.
        for (let i = 0; i < tiles.length; i++) {
          const tile = tiles[i]!;
          if (!admissibleCoordinate(tile.x) || !admissibleCoordinate(tile.y))
            throw new RangeError('Coordenada fuera del dominio entero del SoA paralelo.');
          const prior = bindings.get(tile);
          if (prior?.store.residentBusy) throw new Error(TWO_WRITERS);
          if (!(prior && prior.store === this && Object.is(tile.x, prior.x) && Object.is(tile.y, prior.y))) {
            for (const key of residentKeys) this.encodeResident(key, tile[key as keyof Tile]);
          }
        }
        const nextSet = new Set<Tile>(tiles);
        const kept = new Set<ResidentBinding>();
        const priorBindings = this.residentBindings;
        const priorPending = this.residentPending;
        const priorAbsent = this.residentAbsent;
        const priorWoodHoles = [...this.residentWoodHoles.entries()];
        for (let i = 0; i < priorBindings.length; i++) {
          const binding = priorBindings[i]!;
          if (nextSet.has(binding.tile) && Object.is(binding.tile.x, binding.x) && Object.is(binding.tile.y, binding.y)) {
            kept.add(binding);
          } else {
            this.detachBinding(binding);
          }
        }
        this.residentBindings = [...kept];
        if (!this.map(tiles, false)) throw new RangeError('Coordenada fuera del dominio entero del SoA paralelo.');
        this.back(); this.refreshResident();
        this.residentPending = priorPending.filter(b => kept.has(b));
        this.residentAbsent = priorAbsent.filter(entry => kept.has(entry.binding));
        this.residentWoodHoles.clear();
        for (const [page, holes] of priorWoodHoles) {
          const alive = holes.filter(b => kept.has(b));
          if (alive.length) this.residentWoodHoles.set(page, alive);
        }
        this.residentTiles = tiles;
        residentStoreByTiles.set(tiles, this);
        const nextBindings = new Array<ResidentBinding>(tiles.length);
        for (let i = 0; i < tiles.length; i++) {
          const tile = tiles[i]!, cell = this.cellsOf[i]!;
          const existing = bindings.get(tile);
          if (existing && kept.has(existing) && existing.cell === cell) {
            nextBindings[i] = existing;
            continue;
          }
          if (existing) existing.store.detachBinding(existing);
          const binding: ResidentBinding = { store: this, tile, cell, x: tile.x, y: tile.y, mask: 0 };
          for (const key of residentKeys) this.writeResidentValue(key, cell, tile[key as keyof Tile]);
          this.dirty[cell >>> 8] = 1;
          bindings.set(tile, binding);
          for (const key of residentKeys) if (Object.hasOwn(tile, key)) this.attachResidentAccessor(binding, key);
          observeResidentTile(tile, { before: () => { if (this.residentBusy) throw new Error(TWO_WRITERS); },
            after: (key, descriptorChanged) => { if (descriptorChanged !== false && residentKeySet.has(key)) this.residentModified.add(binding); } });
          for (const key of ['wood', 'feature'] as const) if (!Object.hasOwn(tile, key)) this.residentAbsent.push({ key, binding });
          if (['life', 'fertility', 'growth', 'traffic', 'cultivation', 'drinkingWater'].some(key => !Object.hasOwn(tile, key))) this.residentPending.push(binding);
          if (!Object.hasOwn(tile, 'wood')) {
            const page = cell >>> 8, holes = this.residentWoodHoles.get(page) ?? [];
            holes.push(binding); this.residentWoodHoles.set(page, holes);
          }
          nextBindings[i] = binding;
        }
        this.residentBindings = nextBindings;
        this.residentOwner = owner;
        this.refreshResident();
        this.residentRevision = {};
        if (this.residentWoodAdded.length !== this.arena.capacity) {
          this.residentWoodAdded = new Uint8Array(new SharedArrayBuffer(this.arena.capacity));
        } else {
          this.residentWoodAdded.fill(0);
        }
      } else {
        this.detachResident();
        for (const tile of tiles) {
          const prior = bindings.get(tile);
          if (prior?.store.residentBusy) throw new Error(TWO_WRITERS);
          for (const key of residentKeys) this.encodeResident(key, tile[key as keyof Tile]);
        }
        if (!this.loadLife(tiles)) throw new RangeError('Coordenada fuera del dominio entero del SoA paralelo.');
        this.back(); this.refreshResident();
        this.residentPending = []; this.residentAbsent = []; this.residentWoodHoles.clear();
        this.residentTiles = tiles;
        residentStoreByTiles.set(tiles, this);
        this.residentOwner = owner;
        this.residentBindings = tiles.map((tile, i) => {
          // Otra arena puede retener el mismo Tile (clon/reintento/restauración). Desligar antes de
          // reutilizar páginas: una tesela dormida nunca debe leer la ranura de otra región.
          const prior = bindings.get(tile);
          if (prior) prior.store.detachBinding(prior);
          const binding: ResidentBinding = { store: this, tile, cell: this.cellsOf[i]!, x: tile.x, y: tile.y, mask: 0 };
          for (const key of residentKeys) this.writeResidentValue(key, binding.cell, tile[key as keyof Tile]);
          bindings.set(tile, binding);
          for (const key of residentKeys) if (Object.hasOwn(tile, key)) this.attachResidentAccessor(binding, key);
          observeResidentTile(tile, { before: () => { if (this.residentBusy) throw new Error(TWO_WRITERS); },
            after: (key, descriptorChanged) => { if (descriptorChanged !== false && residentKeySet.has(key)) this.residentModified.add(binding); } });
          for (const key of ['wood', 'feature'] as const) if (!Object.hasOwn(tile, key)) this.residentAbsent.push({ key, binding });
          if (['life', 'fertility', 'growth', 'traffic', 'cultivation', 'drinkingWater'].some(key => !Object.hasOwn(tile, key))) this.residentPending.push(binding);
          if (!Object.hasOwn(tile, 'wood')) {
            const page = binding.cell >>> 8, holes = this.residentWoodHoles.get(page) ?? [];
            holes.push(binding); this.residentWoodHoles.set(page, holes);
          }
          return binding;
        });
        this.refreshResident();
        this.residentRevision = {};
        this.residentWoodAdded = new Uint8Array(new SharedArrayBuffer(this.arena.capacity));
      }
    }
    if (!same || regionSide !== this.residentRegionSide) {
      this.residentRegionSide = regionSide;
      const grouped = new Map<string, { x: number; y: number; slots: number[] }>();
      for (const region of this.regions.ordered()) for (const slot of region.slots) if (slot >= 0) {
        const x = Math.floor(this.pageX[slot]! * 16 / regionSide), y = Math.floor(this.pageY[slot]! * 16 / regionSide);
        const key = `${x},${y}`, group = grouped.get(key) ?? { x, y, slots: [] };
        group.slots.push(slot); grouped.set(key, group);
      }
      const ordered: number[] = []; this.residentRegions = [];
      const stamps = this.presence.stamps, version = this.version;
      for (const region of [...grouped.values()].sort((a, b) => a.y - b.y || a.x - b.x)) {
        const begin = ordered.length;
        for (const slot of region.slots.sort((a, b) => this.pageY[a]! - this.pageY[b]! || this.pageX[a]! - this.pageX[b]!)) {
          for (let offset = 0; offset < PAGE_CELLS; offset++) {
            const cell = slot * PAGE_CELLS + offset;
            if (stamps[cell] === version) ordered.push(cell);
          }
        }
        this.residentRegions.push({ id: this.residentRegions.length, begin, end: ordered.length });
      }
      this.residentCells = new Int32Array(new SharedArrayBuffer(ordered.length * 4)); this.residentCells.set(ordered);
      this.residentWoodAdded = new Uint8Array(new SharedArrayBuffer(this.arena.capacity));
      this.residentWoodAddedQueue = new Int32Array(new SharedArrayBuffer((this.arena.capacity + 2) * 4));
      observeResidentArray(tiles, () => { if (this.residentBusy) throw new Error(TWO_WRITERS); });
    }
    // Los Tile nacidos bajo owner notifican altas, deletes y defineProperty: O(cambios), no O(T).
    for (const binding of this.residentModified) {
      if (bindings.get(binding.tile) !== binding) continue;
      this.topologyCosts.changedBindings++;
      this.refreshModifiedBinding(binding);
    }
    this.residentModified.clear();
    // Dar de alta una clave opcional entre despachos crea una propiedad ordinaria; incorporarla
    // antes de leer SAB, sin pisarla al desligar. Sólo se consultan las claves aún ausentes.
    if (!token) this.residentAbsent = this.residentAbsent.filter(({ key, binding }) => {
      if (!Object.hasOwn(binding.tile, key)) return true;
      this.writeResidentValue(key, binding.cell, binding.tile[key as keyof Tile]);
      this.attachResidentAccessor(binding, key); return false;
    });
    this.residentTopology = residentTopologyToken(tiles);
    // Scratch de este despacho. El protocolo sólo se anuncia desde workers que escriben la cola.
    this.residentWoodAddedQueue[0] = 0; this.residentWoodAddedQueue[1] = 0;
    this.refreshResident();
    const buffers: Record<string, SharedArrayBuffer> = {
      cells: this.residentCells.buffer as SharedArrayBuffer, stamps: this.presence.stamps.buffer as SharedArrayBuffer,
      around: this.around.buffer as SharedArrayBuffer, pageX: this.pageX.buffer as SharedArrayBuffer,
      pageY: this.pageY.buffer as SharedArrayBuffer, dirty: this.dirty.buffer as SharedArrayBuffer,
      woodAdded: this.residentWoodAdded.buffer as SharedArrayBuffer,
      woodAddedQueue: this.residentWoodAddedQueue.buffer as SharedArrayBuffer,
    };
    for (const key of residentKeys) {
      const pair = this.residentPairs.get(key)!;
      buffers[key] = pair[this.parity]!.buffer as SharedArrayBuffer;
      buffers[`${key}Back`] = pair[this.parity ^ 1]!.buffer as SharedArrayBuffer;
    }
    return { regions: this.residentRegions, buffers, version: this.version };
  }

  parallelTopologyCertificate(tiles: Tile[]): { tiles: Tile[]; revision: object } | undefined {
    return this.residentTiles === tiles ? { tiles, revision: this.residentRevision } : undefined;
  }
  dirtyPageCoordinates(): { pageX: number; pageY: number }[] {
    return this.dirtyPages().map(slot => ({ pageX: this.pageX[slot]!, pageY: this.pageY[slot]! }));
  }

  beginParallel(): void {
    if (this.residentBusy || this.taken) throw new Error(TWO_WRITERS);
    this.residentBusy = true;
  }
  abortParallel(): void {
    // Camino excepcional: ninguna alta del fondo fallido puede impedir encolar la del reintento.
    this.residentWoodAdded.fill(0); this.residentWoodAddedQueue[0] = 0; this.residentWoodAddedQueue[1] = 0;
    this.residentBusy = false;
  }
  /** Cambiar al camino serial devuelve los campos a objetos antes de reutilizar la arena. */
  releaseParallelObjects(): void {
    if (this.residentBusy) throw new Error(TWO_WRITERS);
    this.detachResident();
  }
  commitParallel(phase: 'kernel' | 'ecologia' = 'kernel'): void {
    if (!this.residentBusy) throw new Error(NO_AUTHORITY);
    const queue = this.residentWoodAddedQueue, protocol = queue[0]!;
    if (protocol !== 0 && protocol !== 1) throw new Error('SoA de terreno: protocolo de altas de wood desconocido.');
    let addedPages: number[] | null = null;
    if (protocol === 1) {
      const count = queue[1]!;
      if (count < 0 || count > queue.length - 2) throw new Error('SoA de terreno: contador de altas de wood fuera de rango.');
      addedPages = []; const seen = new Set<number>();
      for (let i = 0; i < count; i++) {
        const page = queue[i + 2]!;
        if (page < 0 || page >= this.residentWoodAdded.length || !this.inUse[page]
          || !this.presence.pagePresent(page) || !this.residentWoodAdded[page] || seen.has(page))
          throw new Error('SoA de terreno: cola de altas de wood inválida.');
        seen.add(page); addedPages.push(page);
      }
    }
    this.parity ^= 1; this.syncResidentCur(); this.residentBusy = false;
    // Ausentes al cargar: mismo orden de asignación que el kernel de objetos, sólo tras éxito.
    if (phase === 'kernel') {
      for (const binding of this.residentPending) for (const key of ['life', 'fertility', 'growth', 'traffic', 'cultivation', 'drinkingWater'] as const) {
        if (!Object.hasOwn(binding.tile, key)) this.attachResidentAccessor(binding, key);
      }
      this.residentPending = [];
    }
    // Protocolo real: O(páginas con altas). Compatibilidad explícita: workers viejos O(páginas).
    for (const page of addedPages ?? this.residentWoodHoles.keys()) {
      if (!this.residentWoodAdded[page]) continue;
      const holes = this.residentWoodHoles.get(page) ?? [];
      const remaining: ResidentBinding[] = [];
      for (const binding of holes) {
        if (this.residentRead('wood', binding.cell) !== undefined) this.attachResidentAccessor(binding, 'wood');
        else remaining.push(binding);
      }
      if (remaining.length) this.residentWoodHoles.set(page, remaining); else this.residentWoodHoles.delete(page);
      this.residentWoodAdded[page] = 0;
    }
  }

  residentRead(key: ResidentKey, cell: number): number | string | undefined {
    if (this.residentGeneration !== this.arena.generation) this.refreshResident();
    const value = this.residentPairs.get(key)![this.parity]![cell]!;
    const values = enumValues[key];
    return values ? (value ? values[value - 1] : undefined) : Number.isNaN(value) ? undefined : value;
  }
  residentReadNumber(idx: number, cell: number): number | undefined {
    if (this.residentGeneration !== this.arena.generation) this.refreshResident();
    const value = (this.residentCur[idx] as Float64Array)[cell]!;
    return value === value ? value : undefined;
  }
  residentReadEnum(idx: number, cell: number, values: readonly string[]): string | undefined {
    if (this.residentGeneration !== this.arena.generation) this.refreshResident();
    const value = (this.residentCur[idx] as Uint8Array)[cell]!;
    return value ? values[value - 1] : undefined;
  }
  residentWrite(key: ResidentKey, cell: number, value: unknown): void {
    if (this.residentBusy) throw new Error(TWO_WRITERS);
    if (this.residentGeneration !== this.arena.generation) this.refreshResident();
    this.writeResidentValue(key, cell, value); this.dirty[cell >>> 8] = 1;
  }
  residentWriteNumber(idx: number, key: ResidentKey, cell: number, value: unknown): void {
    if (this.residentBusy) throw new Error(TWO_WRITERS);
    if (this.residentGeneration !== this.arena.generation) this.refreshResident();
    let encoded: number;
    if (value === undefined) encoded = Number.NaN;
    else if (typeof value !== 'number' || Number.isNaN(value)) throw new RangeError(`Tesela no representable en el SoA: ${key}=${String(value)}.`);
    else encoded = value;
    (this.residentCur[idx] as Float64Array)[cell] = encoded;
    this.dirty[cell >>> 8] = 1;
  }
  residentWriteEnum(idx: number, key: ResidentKey, cell: number, value: unknown, values: readonly string[]): void {
    if (this.residentBusy) throw new Error(TWO_WRITERS);
    if (this.residentGeneration !== this.arena.generation) this.refreshResident();
    let encoded: number;
    if (value === undefined) encoded = 0;
    else {
      const code = typeof value === 'string' ? values.indexOf(value) + 1 : 0;
      if (code <= 0) throw new RangeError(`Tesela no representable en el SoA: ${key}=${String(value)}.`);
      encoded = code;
    }
    (this.residentCur[idx] as Uint8Array)[cell] = encoded;
    this.dirty[cell >>> 8] = 1;
  }
  private canReadResident(tiles: readonly Tile[]): boolean {
    if (this.residentTiles !== tiles || this.residentBusy || this.residentModified.size > 0
      || this.residentBindings.length !== tiles.length || this.loaded !== tiles.length) return false;
    return sameResidentTopology(residentTopologyToken(tiles as Tile[]), this.residentTopology);
  }
  tileReaderIfResident(tiles: readonly Tile[]): ResidentTileReader | undefined {
    if (!this.canReadResident(tiles)) return undefined;
    if (this.residentGeneration !== this.arena.generation) this.refreshResident();
    return new ResidentTileReader(this.regions, this.presence.stamps, this.version,
      this.residentCur[TERRAIN_IDX] as Uint8Array, this.residentCur[residentKeys.indexOf('biome')] as Uint8Array,
      { growth: this.residentCur[GROWTH_IDX] as Float64Array,
        vegetation: this.residentCur[residentKeys.indexOf('vegetation')] as Float64Array,
        moisture: this.residentCur[residentKeys.indexOf('moisture')] as Float64Array,
        drinkingWater: this.residentCur[residentKeys.indexOf('drinkingWater')] as Float64Array,
        food: this.residentCur[residentKeys.indexOf('food')] as Float64Array,
        wood: this.residentCur[residentKeys.indexOf('wood')] as Float64Array });
  }
  faunaCapacityIfResident(tiles: readonly Tile[]): number | undefined {
    if (!this.canReadResident(tiles)) return undefined;
    if (this.residentGeneration !== this.arena.generation) this.refreshResident();
    const cells = this.cellsOf, n = this.loaded;
    const terrain = this.residentCur[TERRAIN_IDX] as Uint8Array;
    const growth = this.residentCur[GROWTH_IDX] as Float64Array;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const cell = cells[i]!;
      if (terrain[cell] !== SHELTER_CODE && growth[cell]! > 0.04) count++;
    }
    return count * 3;
  }
  private syncResidentCur(): void {
    const p = this.parity;
    for (let k = 0; k < residentKeys.length; k++) {
      const pair = this.residentPairs.get(residentKeys[k]!);
      if (pair) this.residentCur[k] = pair[p]!;
    }
  }
  private writeResidentValue(key: ResidentKey, cell: number, value: unknown): void {
    this.residentPairs.get(key)![this.parity]![cell] = this.encodeResident(key, value);
  }
  private encodeResident(key: ResidentKey, value: unknown): number {
    const values = enumValues[key];
    if (value === undefined) return values ? 0 : Number.NaN;
    if (values) {
      const code = typeof value === 'string' ? values.indexOf(value) + 1 : 0;
      if (code <= 0) throw new RangeError(`Tesela no representable en el SoA: ${key}=${String(value)}.`);
      return code;
    }
    if (typeof value !== 'number' || Number.isNaN(value)) throw new RangeError(`Tesela no representable en el SoA: ${key}=${String(value)}.`);
    return value;
  }
  private refreshResident(): void {
    if (this.residentGeneration === this.arena.generation) return;
    this.refresh();
    for (const key of residentKeys) {
      this.residentPairs.set(key, key === 'life' ? [this.lives[0], this.back()]
        : enumValues[key] ? [this.arena.field(`resident.${key}.0`, Uint8Array, PAGE_CELLS), this.arena.field(`resident.${key}.1`, Uint8Array, PAGE_CELLS)]
          : [this.arena.field(`resident.${key}.0`, Float64Array, PAGE_CELLS), this.arena.field(`resident.${key}.1`, Float64Array, PAGE_CELLS)]);
    }
    this.refresh(); this.residentPairs.set('life', [this.lives[0], this.lives[1]!]);
    this.residentGeneration = this.arena.generation;
    this.syncResidentCur();
  }
  private attachResidentAccessor(binding: ResidentBinding, key: ResidentKey): void {
    maintainResidentTile(binding.tile, () => Object.defineProperty(binding.tile, key, residentAccessors[key]));
    binding.mask |= 1 << residentKeys.indexOf(key);
  }
  private refreshModifiedBinding(binding: ResidentBinding): void {
    // Validar TODOS los campos alterados antes de escribir ninguno: un NaN no se convierte en ausencia.
    const changes: { key: ResidentKey; value: unknown; own: boolean; index: number }[] = [];
    for (let k = 0; k < residentKeys.length; k++) {
      const key = residentKeys[k]!, descriptor = Object.getOwnPropertyDescriptor(binding.tile, key);
      if (descriptor?.get === residentAccessors[key].get && descriptor?.set === residentAccessors[key].set) continue;
      const own = descriptor !== undefined, value = own ? binding.tile[key as keyof Tile] : undefined;
      this.encodeResident(key, value); changes.push({ key, value, own, index: k });
    }
    for (const { key, value, own, index } of changes) {
      this.writeResidentValue(key, binding.cell, value);
      if (own) this.attachResidentAccessor(binding, key); else binding.mask &= ~(1 << index);
    }
    if (['life', 'fertility', 'growth', 'traffic', 'cultivation', 'drinkingWater'].some(key => !Object.hasOwn(binding.tile, key)))
      this.residentPending.push(binding);
  }
  private detachBinding(binding: ResidentBinding): void {
    if (bindings.get(binding.tile) !== binding) return;
    if (this.residentBusy) throw new Error(TWO_WRITERS);
    for (const key of residentKeys) if (Object.getOwnPropertyDescriptor(binding.tile, key)?.get === residentAccessors[key].get) {
      const value = this.residentRead(key, binding.cell);
      maintainResidentTile(binding.tile, () => Object.defineProperty(binding.tile, key, { value, writable: true, configurable: true, enumerable: true }));
    }
    observeResidentTile(binding.tile, undefined);
    bindings.delete(binding.tile);
    // Cambiar la autoridad desde otra arena obliga a refrescar antes de volver a usar ésta.
    if (this.residentTiles) {
      observeResidentArray(this.residentTiles, undefined);
      residentStoreByTiles.delete(this.residentTiles);
    }
    this.residentTiles = null; this.residentTopology = undefined;
  }
  private detachResident(): void {
    if (this.residentTiles) residentStoreByTiles.delete(this.residentTiles);
    for (const binding of this.residentBindings) this.detachBinding(binding);
    this.residentBindings = []; this.residentTiles = null; this.residentModified.clear(); this.residentTopology = undefined; this.residentOwner = undefined;
  }

  /**
   * `livingNeighbors` de cada tesela de la última carga, en su orden, en una sola pasada con los arrays
   * en variables locales: es la única lectura entre celdas de la ley y la que T115 repartirá por regiones.
   */
  livingNeighborCounts(threshold: number): Uint8Array {
    if (this.counts.length < this.loaded) this.counts = new Uint8Array(Math.max(this.loaded, Math.ceil(this.counts.length * 1.25)));
    const counts = this.counts, cells = this.cellsOf, stamps = this.presence.stamps, version = this.presence.version;
    const life = this.lives[this.parity]!, around = this.around;
    for (let i = 0; i < this.loaded; i++) {
      const cell = cells[i]!, lx = cell & 15, ly = (cell >> 4) & 15;
      let count = 0;
      if (lx > 0 && lx < 15 && ly > 0 && ly < 15) {
        if (stamps[cell - 17] === version && life[cell - 17]! >= threshold) count++;
        if (stamps[cell - 16] === version && life[cell - 16]! >= threshold) count++;
        if (stamps[cell - 15] === version && life[cell - 15]! >= threshold) count++;
        if (stamps[cell - 1] === version && life[cell - 1]! >= threshold) count++;
        if (stamps[cell + 1] === version && life[cell + 1]! >= threshold) count++;
        if (stamps[cell + 15] === version && life[cell + 15]! >= threshold) count++;
        if (stamps[cell + 16] === version && life[cell + 16]! >= threshold) count++;
        if (stamps[cell + 17] === version && life[cell + 17]! >= threshold) count++;
      } else {
        const at = (cell >>> 8) * 9;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = lx + dx, ny = ly + dy;
          const target = around[at + (ny < 0 ? 0 : ny > 15 ? 6 : 3) + (nx < 0 ? 0 : nx > 15 ? 2 : 1)]!;
          if (target < 0) continue;
          const neighbor = (target << 8) | ((ny & 15) << 4) | (nx & 15);
          if (stamps[neighbor] === version && life[neighbor]! >= threshold) count++;
        }
      }
      counts[i] = count;
    }
    return counts;
  }

  /**
   * Las 8 vecinas de `cell` en el orden de `buildTopology` (dy −1‥1, dx −1‥1), como celdas o `-1`. Con
   * `masked = false` (sólo diagnóstico) se omite la máscara de presencia y se devuelve cualquier ranura
   * reservada aunque su celda no esté en el conjunto activo: es lo que la máscara impide.
   */
  neighbors(cell: number, out: Int32Array, masked = true): Int32Array {
    let index = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const neighbor = this.neighborCell(cell, dx, dy);
      out[index++] = neighbor >= 0 && (!masked || this.presence.present(neighbor)) ? neighbor : -1;
    }
    return out;
  }

  private neighborCell(cell: number, dx: number, dy: number): number {
    const slot = cell >>> 8, lx = (cell & 15) + dx, ly = ((cell >> 4) & 15) + dy;
    const sx = lx < 0 ? 0 : lx > 15 ? 2 : 1, sy = ly < 0 ? 0 : ly > 15 ? 2 : 1;
    const target = this.around[slot * 9 + sy * 3 + sx]!;
    return target < 0 ? -1 : (target << 8) | ((ly & 15) << 4) | (lx & 15);
  }

  private own(cell: number): void {
    const slot = cell >>> 8;
    if (this.authority[slot] !== SOA) throw new Error(NO_AUTHORITY);
    this.dirty[slot] = 1;
  }

  private back(): Float64Array {
    if (!this.lives[1]) { this.lives[1] = this.arena.field('life1', Float64Array, PAGE_CELLS); this.generation = -1; this.refresh(); }
    return this.lives[this.parity ^ 1]!;
  }

  private release(): void {
    if (this.taken) for (let slot = 0; slot < this.arena.slots; slot++) this.authority[slot] = OBJECT;
    this.taken = 0;
  }

  private ensureAllFields(): void {
    if (this.fields.length) return;
    this.fields = LAYOUT.map(slot => slot.kind === 'enum' ? this.arena.field(slot.key, Uint8Array, PAGE_CELLS)
      : slot.kind === 'number' ? this.arena.field(slot.key, Float64Array, PAGE_CELLS) : new Float64Array(0));
    this.generation = -1; this.refresh();
  }

  private refresh(): void {
    if (this.generation === this.arena.generation) return;
    this.presence.refresh();
    this.inUse = this.arena.field('pageInUse', Uint8Array, 1);
    this.pageX = this.arena.field('pageX', Int32Array, 1);
    this.pageY = this.arena.field('pageY', Int32Array, 1);
    this.authority = this.arena.field('pageAuthority', Uint8Array, 1);
    this.dirty = this.arena.field('pageDirty', Uint8Array, 1);
    this.around = this.arena.field('pageAround', Int32Array, 9, -1);
    this.lives = [this.arena.field('life0', Float64Array, PAGE_CELLS), this.lives[1] ? this.arena.field('life1', Float64Array, PAGE_CELLS) : null];
    if (this.fields.length) this.fields = LAYOUT.map(slot => slot.kind === 'enum' ? this.arena.field(slot.key, Uint8Array, PAGE_CELLS)
      : slot.kind === 'number' ? this.arena.field(slot.key, Float64Array, PAGE_CELLS) : new Float64Array(0));
    this.generation = this.arena.generation;
  }

  /** Sella presencia y asigna celdas; con `copyLife`, copia además `life ?? 0` al frente en la misma pasada. */
  private map(tiles: readonly Tile[], copyLife: boolean): boolean {
    if (this.taken) throw new Error(TWO_WRITERS);
    this.loaded = 0; this.mode = 'none';
    const presence = this.presence, version = presence.next();
    if (this.cellsOf.length < tiles.length) this.cellsOf = new Int32Array(Math.max(tiles.length, Math.ceil(this.cellsOf.length * 1.25)));
    const cells = this.cellsOf;
    this.refresh();
    let life = this.lives[this.parity]!, stamps = presence.stamps;
    let lastX = Number.NaN, lastY = Number.NaN, base = 0, reserved = 0, stamped = 0;
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i]!, x = tile.x, y = tile.y;
      if (!admissibleCoordinate(x) || !admissibleCoordinate(y)) { this.sweepPending = true; return false; }
      const px = x >> 4, py = y >> 4;
      if (px !== lastX || py !== lastY) {
        let slot = this.regions.slot(px, py);
        if (slot < 0) {
          slot = this.arena.reserve(); reserved++;
          this.refresh(); life = this.lives[this.parity]!; stamps = presence.stamps;
          this.regions.assign(px, py, slot);
          this.inUse[slot] = 1; this.pageX[slot] = px; this.pageY[slot] = py; this.authority[slot] = OBJECT;
        }
        if (presence.markPage(slot)) stamped++;
        lastX = px; lastY = py; base = slot << 8;
      }
      const cell = base | ((y & 15) << 4) | (x & 15);
      if (stamps[cell] === version) { this.sweepPending = true; throw new Error(DUPLICATE); }
      stamps[cell] = version; cells[i] = cell;
      if (copyLife) life[cell] = tile.life ?? 0;
    }
    // Mismo conjunto de páginas que la carga anterior ⇔ ninguna nueva y las mismas selladas: entonces la
    // vecindad de páginas sigue valiendo y no se recorre nada más (validación por versión, no O(T)).
    if (reserved || stamped !== this.presentPages || this.sweepPending) this.sweep();
    this.presentPages = stamped; this.loaded = tiles.length;
    return true;
  }

  /** Libera las páginas que la carga no selló y recalcula la vecindad de páginas: O(páginas). */
  private sweep(): void {
    const presence = this.presence;
    for (let slot = 0; slot < this.arena.slots; slot++) {
      if (!this.inUse[slot] || presence.pagePresent(slot)) continue;
      this.regions.release(this.pageX[slot]!, this.pageY[slot]!);
      this.inUse[slot] = 0; this.authority[slot] = OBJECT; this.dirty[slot] = 0; this.arena.release(slot);
    }
    for (let slot = 0; slot < this.arena.slots; slot++) {
      if (!this.inUse[slot]) continue;
      const px = this.pageX[slot]!, py = this.pageY[slot]!, at = slot * 9;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) this.around[at + (dy + 1) * 3 + dx + 1] = this.regions.slot(px + dx, py + dy);
    }
    this.sweepPending = false; this.pageSetVersion = (this.pageSetVersion + 1) >>> 0;
  }
}

type Elements = Float64Array | Uint8Array;

function encode(slot: Slot, value: unknown): number {
  if (slot.kind === 'enum') {
    if (value === undefined) return 0;
    const code = typeof value === 'string' ? slot.codes.get(value) : undefined;
    if (code === undefined) throw new RangeError(`Tesela no representable en el SoA: ${slot.key}=${String(value)}.`);
    return code;
  }
  if (value === undefined) return Number.NaN;
  if (typeof value !== 'number' || Number.isNaN(value)) throw new RangeError(`Tesela no representable en el SoA: ${slot.kind === 'life' ? 'life' : slot.key}=${String(value)}.`);
  return value;
}

function decode(slot: Slot, stored: number): string | number | undefined {
  if (slot.kind === 'enum') return stored === 0 ? undefined : slot.values[stored - 1];
  return Number.isNaN(stored) ? undefined : stored;
}
