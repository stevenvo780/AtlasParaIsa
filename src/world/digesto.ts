import { createHash } from 'node:crypto';
import type { World } from './index.js';
import { paramsOf } from './params.js';

type Canonical = null | boolean | number | string | Canonical[] | { [key: string]: Canonical };
const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Sort records, never simulation slots or chronological/program arrays. */
function canonical(value: unknown): Canonical {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite canonical world value.');
    return value;
  }
  if (Array.isArray(value)) {
    // The live laws use find() and stable distance ties. Reordering even places
    // or tiles can change the next action; equal sets are not equal trajectories.
    return value.map(item => canonical(item));
  }
  if (typeof value !== 'object') throw new TypeError('Unsupported canonical world value.');
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => compareText(a, b)).map(([key, entry]) => [key, canonical(entry)]));
}

/** T101: full resident + pending dormant state, including effective laws and pending history.
 * External host capabilities cannot be serialized or inferred from resident state.
 * Persisted archive contents must be checked separately; a digest cannot read a host's disk.
 */
function canonicalWorld(world: World): Canonical {
  return canonical({ world, params: paramsParaDigesto(world) });
}

/** T148: `motor.depuracion` es un interruptor de diagnóstico (guardia de la fase B), no una ley: no cambia
 * ninguna dinámica, así que queda fuera del digesto. Así activar la guardia no mueve el digesto y los
 * digestos de mundos anteriores a la clave siguen iguales byte a byte. */
function paramsParaDigesto(world: World): object {
  const params = paramsOf(world);
  const { depuracion: _depuracion, ...motor } = params.motor;
  return { ...params, motor };
}

// Object.fromEntries (the original canonicalizer) enumerates array-index keys
// numerically before other sorted keys. Preserve those exact historical bytes.
function compareKeys(a: string, b: string): number {
  const index = (key: string): boolean => {
    const n = Number(key); return Number.isInteger(n) && n >= 0 && n < 0xffffffff && String(n) === key;
  };
  const ai = index(a), bi = index(b);
  return ai && bi ? Number(a) - Number(b) : ai ? -1 : bi ? 1 : compareText(a, b);
}

function emitCanonical(value: unknown, emit: (text: string) => void): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite canonical world value.');
    emit(Object.is(value, -0) ? '-0' : JSON.stringify(value)); return;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') { emit(JSON.stringify(value)); return; }
  if (Array.isArray(value)) {
    emit('[');
    for (let i = 0; i < value.length; i++) {
      if (i) emit(',');
      if (i in value) emitCanonical(value[i], emit);
    }
    emit(']'); return;
  }
  if (typeof value !== 'object') throw new TypeError('Unsupported canonical world value.');
  emit('{');
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => compareKeys(a, b));
  for (let i = 0; i < entries.length; i++) {
    if (i) emit(',');
    const [key, entry] = entries[i]!; emit(JSON.stringify(key)); emit(':'); emitCanonical(entry, emit);
  }
  emit('}');
}

export function digestoCanonico(world: World): string {
  const hash = createHash('sha256');
  let pieces: string[] = [], length = 0;
  const flush = () => { if (pieces.length) hash.update(pieces.join('')); pieces = []; length = 0; };
  emitCanonical({ world, params: paramsParaDigesto(world) }, text => {
    pieces.push(text); length += text.length;
    // No full-world copy or string: a large valid world can exceed V8's string limit.
    // Flush only between complete JSON tokens so UTF-16 pairs are never split.
    if (length >= 64 * 1024) flush();
  });
  flush(); return hash.digest('hex');
}

export interface CanonicalDifference { path: string; before: Canonical | undefined; after: Canonical | undefined; }
function firstDifference(a: Canonical | undefined, b: Canonical | undefined, path: string): CanonicalDifference | null {
  if (Object.is(a, b)) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return { path, before: a, after: b };
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
      const difference = firstDifference(a[index], b[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return null;
  }
  const left = a as Record<string, Canonical>, right = b as Record<string, Canonical>;
  for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort(compareText)) {
    const difference = firstDifference(left[key], right[key], `${path}.${key}`);
    if (difference) return difference;
  }
  return null;
}

export function diferenciaCanonica(a: World, b: World): CanonicalDifference | null {
  return firstDifference(canonicalWorld(a), canonicalWorld(b), '$');
}

export interface RegionHashPage { pageX: number; pageY: number; }
/** The owner must change revision on slot/order/coordinate changes, including same-length edits.
 * A certificate is evidence of a validated topology, not a substitute for validating it.
 * Its tiles identity is checked independently, so a clone cannot inherit stale tile bindings. */
export interface RegionHashTopologyCertificate { tiles: World['tiles']; revision: unknown; }
export interface RegionHasherOptions {
  /** Compare CPU/SoA execution against hilos=1, natural, gpu=[], soaTerreno=false.
   * All other effective parameters, including motor's other switches, remain in the hash. */
  normalizeExecution?: boolean;
  topologyOf?: (world: World) => RegionHashTopologyCertificate | undefined;
}
export interface RegionHashCapture {
  /** Live views owned by this hasher. Compare immediately; copy explicitly for an old snapshot. */
  regionHashes: Map<string, string>;
  pageHashes: Map<string, string>;
  /** Non-active-tile state only. Compare this AND regionHashes to compare a whole world. */
  globalHash: string;
  updatedPages: number;
  rebuiltTopology: boolean;
  /** Visits to active tiles for topology checks/builds; zero on a stable certified barrier. */
  topologyScannedTiles: number;
  changedPages: string[];
  changedRegions: string[];
}
interface HashTileBinding { index: number; tile: World['tiles'][number]; x: number; y: number; }
interface HashPage { pageX: number; pageY: number; region: string; bindings: HashTileBinding[]; }
const hashPageKey = (x: number, y: number): string => `${x},${y}`;

/** Separate encoding for incremental captures: explicit undefined and array holes preserve own
 * key/presence state as well as -0. Record key insertion order is still immaterial. The historical
 * canonical digest/difference above deliberately retain their existing contracts and bytes. */
function emitRegionValue(value: unknown, emit: (text: string) => void): void {
  if (value === undefined) { emit('undefined'); return; }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite canonical world value.');
    emit(Object.is(value, -0) ? '-0' : JSON.stringify(value)); return;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') { emit(JSON.stringify(value)); return; }
  if (Array.isArray(value)) {
    emit('[');
    for (let i = 0; i < value.length; i++) {
      if (i) emit(',');
      if (Object.hasOwn(value, i)) emitRegionValue(value[i], emit); else emit('hole');
    }
    emit(']'); return;
  }
  if (typeof value !== 'object') throw new TypeError('Unsupported canonical world value.');
  emit('{');
  const keys = Object.keys(value).sort(compareKeys);
  for (let i = 0; i < keys.length; i++) {
    if (i) emit(',');
    const key = keys[i]!; emit(JSON.stringify(key)); emit(':');
    emitRegionValue((value as Record<string, unknown>)[key], emit);
  }
  emit('}');
}

function regionValueHash(value: unknown): string {
  const hash = createHash('sha256');
  let pieces: string[] = [], length = 0;
  const flush = (): void => { if (pieces.length) hash.update(pieces.join('')); pieces = []; length = 0; };
  emitRegionValue(value, text => {
    pieces.push(text); length += text.length;
    if (length >= 64 * 1024) flush();
  });
  flush(); return hash.digest('hex');
}

/** T117: page masks rehash only touched pages, then only their changed regions. Original Tile
 * slots are hashed, never sorted by position or reduced by region: FP64 values remain exact.
 *
 * Costs are intentionally explicit. First capture/topology changes/full refresh cost O(T).
 * Without a topology certificate, checking arbitrary mutable arrays also costs O(T) per call.
 * Stable certified updates cost touched page contents + pages in changed regions (a valid region
 * has at most 256/1024 pages), plus ALL non-tile globals. Dormant terrain/history/people are globals
 * and still traversed: this is not an O(touched) claim for the entire world's state. Returned Maps
 * are live so returning a capture does not copy every page/region on every barrier.
 * Dirty masks must cover every active-tile value/key mutation; undefined requests a full refresh. */
export class IncrementalRegionHasher {
  private tiles: World['tiles'] | undefined;
  private bindings: HashTileBinding[] = [];
  private pages = new Map<string, HashPage>();
  private regions = new Map<string, Set<string>>();
  private readonly pageHashes = new Map<string, string>();
  private readonly regionHashes = new Map<string, string>();
  private certified = false;
  private revision: unknown;

  constructor(readonly regionSide: 256 | 512, private readonly options: RegionHasherOptions = {}) {
    if (regionSide !== 256 && regionSide !== 512) throw new RangeError('Region side must be 256 or 512.');
  }

  update(world: World, dirtyPages?: readonly RegionHashPage[]): RegionHashCapture {
    const requested = new Set<string>();
    if (dirtyPages !== undefined) for (const page of dirtyPages) {
      if (!Number.isSafeInteger(page.pageX) || !Number.isSafeInteger(page.pageY)) throw new RangeError('Dirty page coordinates must be safe integers.');
      requested.add(hashPageKey(page.pageX, page.pageY));
    }
    const certificate = this.options.topologyOf?.(world);
    if (certificate !== undefined && certificate.tiles !== world.tiles) throw new Error('Topology certificate belongs to a different Tile array.');
    let topologyScannedTiles = 0;
    let rebuiltTopology = dirtyPages === undefined || this.tiles !== world.tiles || this.bindings.length !== world.tiles.length;
    if (!rebuiltTopology && certificate !== undefined) {
      rebuiltTopology = !this.certified || !Object.is(this.revision, certificate.revision);
    } else if (!rebuiltTopology) {
      // No owner certificate: never infer unchanged order/coordinates merely from array identity.
      for (let i = 0; i < world.tiles.length; i++) {
        topologyScannedTiles++;
        const binding = this.bindings[i]!, tile = world.tiles[i]!;
        if (tile !== binding.tile || !Object.is(tile.x, binding.x) || !Object.is(tile.y, binding.y)) { rebuiltTopology = true; break; }
      }
    }
    const changedPages: string[] = [], changedRegions: string[] = [];
    const touchedRegions = new Set<string>();
    let previousPages: Map<string, string> | undefined, previousRegions: Map<string, string> | undefined;
    if (rebuiltTopology) {
      // A rebuild may remove the last page in a region. Report those removals as changes too.
      previousPages = new Map(this.pageHashes); previousRegions = new Map(this.regionHashes);
      this.rebuild(world); topologyScannedTiles += world.tiles.length;
      for (const key of this.pages.keys()) requested.add(key);
      for (const key of previousPages.keys()) if (!this.pages.has(key)) changedPages.push(key);
      for (const key of previousRegions.keys()) if (!this.regions.has(key)) changedRegions.push(key);
    }
    this.certified = certificate !== undefined; this.revision = certificate?.revision;
    let updatedPages = 0;
    for (const key of requested) {
      const page = this.pages.get(key);
      if (!page) continue;
      const hash = regionValueHash({ pageX: page.pageX, pageY: page.pageY,
        tiles: page.bindings.map(binding => ({ index: binding.index, tile: binding.tile })) });
      updatedPages++;
      if ((previousPages ?? this.pageHashes).get(key) !== hash) changedPages.push(key);
      if (rebuiltTopology || this.pageHashes.get(key) !== hash) touchedRegions.add(page.region);
      this.pageHashes.set(key, hash);
    }
    for (const key of touchedRegions) {
      const pages = [...this.regions.get(key)!].sort(compareText).map(page => [page, this.pageHashes.get(page)!]);
      const hash = regionValueHash({ regionSide: this.regionSide, region: key, pages });
      if ((previousRegions ?? this.regionHashes).get(key) !== hash) changedRegions.push(key);
      this.regionHashes.set(key, hash);
    }
    const { tiles: _tiles, ...globals } = world;
    const params = paramsOf(world);
    const effectiveParams = this.options.normalizeExecution ? { ...params,
      motor: { ...params.motor, hilos: 1, orden: 'natural', gpu: [], soaTerreno: false } } : params;
    return { regionHashes: this.regionHashes, pageHashes: this.pageHashes,
      globalHash: regionValueHash({ world: globals, params: effectiveParams }), updatedPages, rebuiltTopology,
      topologyScannedTiles, changedPages, changedRegions };
  }

  private rebuild(world: World): void {
    const pages = new Map<string, HashPage>(), regions = new Map<string, Set<string>>();
    const bindings: HashTileBinding[] = [];
    for (let index = 0; index < world.tiles.length; index++) {
      const tile = world.tiles[index]!;
      if (!tile || !Number.isSafeInteger(tile.x) || !Number.isSafeInteger(tile.y)) throw new RangeError('Tile coordinates must be safe integers.');
      const pageX = Math.floor(tile.x / 16), pageY = Math.floor(tile.y / 16), key = hashPageKey(pageX, pageY);
      const region = hashPageKey(Math.floor(pageX / (this.regionSide / 16)), Math.floor(pageY / (this.regionSide / 16)));
      const binding = { index, tile, x: tile.x, y: tile.y }; bindings.push(binding);
      let page = pages.get(key);
      if (!page) { page = { pageX, pageY, region, bindings: [] }; pages.set(key, page); }
      page.bindings.push(binding);
      let members = regions.get(region);
      if (!members) { members = new Set(); regions.set(region, members); }
      members.add(key);
    }
    this.tiles = world.tiles; this.bindings = bindings; this.pages = pages; this.regions = regions;
    this.pageHashes.clear(); this.regionHashes.clear();
  }
}
