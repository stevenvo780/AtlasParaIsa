import type { Biome, Feature, Species, Terrain, Tile } from '../../shared/types.js';
import { PageArena } from './arena.js';
import { Presence } from './presencia.js';
import { PAGE_CELLS, RegionTable, admissibleCoordinate } from './region.js';

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
  get bytes(): number { return this.arena.bytes + this.regions.bytes + this.cellsOf.byteLength + this.counts.byteLength; }
  get bytesPerTile(): number { return this.loaded ? this.bytes / this.loaded : 0; }

  /**
   * Topología del kernel: sella la presencia y copia `life ?? 0` al frente. `false` (sin haber marcado
   * nada como cargado) si alguna coordenada no es un entero del dominio aritmético: el llamador se queda
   * con el camino de objetos. Coordenadas repetidas lanzan el error del kernel antes de tocar teselas.
   */
  loadLife(tiles: readonly Tile[]): boolean {
    if (!this.map(tiles, true)) return false;
    this.mode = 'life'; return true;
  }

  /** Todos los campos. Lanza `RangeError` si una tesela no es representable (clave, enumerado o
   * coordenada desconocidos, `NaN`, `-0` en coordenadas). */
  pack(tiles: readonly Tile[]): void {
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
    this.back(); this.parity ^= 1;
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
