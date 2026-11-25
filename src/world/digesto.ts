import { createHash } from 'node:crypto';
import type { World } from './index.js';
import { paramsOf } from './params.js';
import { todosApagados } from '../shared/interruptores.js';

type Canonical = null | boolean | number | string | Canonical[] | { [key: string]: Canonical };
const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export interface GobernadorLegado {
  presupuestoMs: number;
  senales: readonly string[];
  politica?: 'apagar' | 'techo';
}
// Parte del formato canónico histórico, aun cuando el mundo ya no tiene esos parámetros.
export const GOBERNADOR_DIGESTO_HISTORICO = { presupuestoMs: 50, senales: ['p95'], politica: 'techo' } as const;

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
  return canonical({ world: sinUidsDelMotor(world), params: paramsParaDigesto(world) });
}
/** V23: el uid de la tabla de organismos (`uid`, `siguienteUid`) es una etiqueta del motor que ninguna ley lee: queda
 * fuera del digesto, así que los digestos históricos no cambian. Su durabilidad la prueban sus propias pruebas. */
function sinUidsDelMotor(world: World): World {
  const sinUid = <T extends { uid?: number }>(o: T): T => o.uid === undefined ? o : { ...o, uid: undefined };
  const conUid = (lista: readonly { uid?: number }[] | undefined) => lista?.some(o => o.uid !== undefined) ?? false;
  if (world.siguienteUid === undefined && !conUid(world.people) && !conUid(world.animals)
    && !world.retiredChunks.some(c => conUid(c.animals))) return world;
  return { ...world, siguienteUid: undefined, people: world.people.map(sinUid), animals: world.animals.map(sinUid),
    retiredChunks: world.retiredChunks.map(c => conUid(c.animals) ? { ...c, animals: c.animals!.map(sinUid) } : c) };
}

/** T148 + V16: `motor.depuracion` es diagnóstico y las claves opt-in de V16 cuando están apagadas
 * (0 / false) no mueven el mundo; omitirlas en su valor neutro conserva byte a byte todos los digestos
 * históricos previos y las incluye en el hash en cuanto cualquier ley V16 se activa. */
function paramsParaDigesto(world: World, gobernador: GobernadorLegado = GOBERNADOR_DIGESTO_HISTORICO): object {
  const params = paramsOf(world);
  const { depuracion: _depuracion, ...motor } = params.motor;
  const out: Record<string, unknown> = { ...params, motor, gobernador };
  // V23: con todos los interruptores apagados el grupo no mueve el mundo y se omite (digestos anteriores intactos).
  if (todosApagados(params.v23)) delete out.v23;
  const conducta: Record<string, unknown> = { ...params.conducta };
  if (params.conducta && params.conducta.politicaAutonomia === 0) delete conducta.politicaAutonomia;
  // V19: un interruptor apagado deja su constante asociada inerte; ambos se omiten (digestos V18 intactos).
  if (params.conducta && params.conducta.aprendizajeCausal === false) { delete conducta.aprendizajeCausal; delete conducta.memoriaResultadoTicks; }
  out.conducta = conducta;
  if (params.social) {
    const social: Record<string, unknown> = { ...params.social };
    if (params.social.derivaCultural === 0) delete social.derivaCultural;
    if (params.social.vinculoEncuentro === 0) delete social.vinculoEncuentro;
    if (params.social.acuerdosMateriales === false) { delete social.acuerdosMateriales; delete social.memoriaResultadosDias; }
    out.social = social;
  }
  if (params.tecnologia) {
    const tecnologia: Record<string, unknown> = { ...params.tecnologia };
    if (params.tecnologia.efectosHerramientas === false) delete tecnologia.efectosHerramientas;
    if (params.tecnologia.obrasPorPropiedades === false) delete tecnologia.obrasPorPropiedades;
    out.tecnologia = tecnologia;
  }
  const fauna = params.fauna;
  if (!fauna || !(fauna.contactoContinuo || fauna.reservaReproductiva || fauna.encuentroFertil)) delete out.fauna;
  if (!params.construccion || (!params.construccion.modular && !params.construccion.poliminosYSinergia)) delete out.construccion;
  else if (!params.construccion.poliminosYSinergia) out.construccion = { modular: params.construccion.modular };
  if (!params.terreno || !params.terreno.caminosFisicos) delete out.terreno;
  if (!params.quimica || !params.quimica.emergente) delete out.quimica;
  if (!params.ecologia || params.ecologia.amplitudEstacional === 0) delete out.ecologia;
  return out;
}

// Object.fromEntries (the original canonicalizer) enumerates array-index keys
// numerically before other sorted keys. Preserve those exact historical bytes.
function isArrayIndexKey(key: string): boolean {
  const c0 = key.charCodeAt(0);
  if (c0 < 48 || c0 > 57) return false;
  const n = Number(key);
  return Number.isInteger(n) && n >= 0 && n < 0xffffffff && String(n) === key;
}
function compareKeys(a: string, b: string): number {
  const ca = a.charCodeAt(0), cb = b.charCodeAt(0);
  if ((ca < 48 || ca > 57) && (cb < 48 || cb > 57)) return a < b ? -1 : a > b ? 1 : 0;
  const ai = isArrayIndexKey(a), bi = isArrayIndexKey(b);
  return ai && bi ? Number(a) - Number(b) : ai ? -1 : bi ? 1 : a < b ? -1 : a > b ? 1 : 0;
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

export function digestoCanonico(world: World, gobernadorLegado?: GobernadorLegado): string {
  const hash = createHash('sha256');
  let pieces: string[] = [], length = 0;
  const flush = () => { if (pieces.length) hash.update(pieces.join('')); pieces = []; length = 0; };
  emitCanonical({ world: sinUidsDelMotor(world), params: paramsParaDigesto(world, gobernadorLegado) }, text => {
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
const SIMPLE_REGION_STRING = /^[\x20\x21\x23-\x5b\x5d-\x7e]*$/;
const quotedRegionKeyCache = new Map<string, string>();
function quotedRegionKey(key: string): string {
  let cached = quotedRegionKeyCache.get(key);
  if (cached !== undefined) return cached;
  cached = SIMPLE_REGION_STRING.test(key) ? `"${key}":` : `${JSON.stringify(key)}:`;
  if (quotedRegionKeyCache.size < 4096) quotedRegionKeyCache.set(key, cached);
  return cached;
}

function regionValueHash(value: unknown): string {
  const hash = createHash('sha256');
  let buf = '';
  const flush = (): void => { if (buf.length) { hash.update(buf); buf = ''; } };
  const emit = (v: unknown): void => {
    if (v === undefined) { buf += 'undefined'; return; }
    const type = typeof v;
    if (type === 'number') {
      if (!Number.isFinite(v as number)) throw new TypeError('Non-finite canonical world value.');
      buf += Object.is(v, -0) ? '-0' : `${v as number}`; return;
    }
    if (v === null) { buf += 'null'; return; }
    if (type === 'boolean') { buf += v ? 'true' : 'false'; return; }
    if (type === 'string') {
      buf += SIMPLE_REGION_STRING.test(v as string) ? `"${v as string}"` : JSON.stringify(v); return;
    }
    if (Array.isArray(v)) {
      buf += '[';
      for (let i = 0; i < v.length; i++) {
        if (i) buf += ',';
        if (Object.hasOwn(v, i)) emit(v[i]); else buf += 'hole';
      }
      buf += ']';
      if (buf.length >= 64 * 1024) flush();
      return;
    }
    if (type !== 'object') throw new TypeError('Unsupported canonical world value.');
    buf += '{';
    const keys = Object.keys(v as object);
    let sorted = keys.length <= 1 || keys[0]!.charCodeAt(0) > 57;
    if (sorted) {
      for (let i = 1; i < keys.length; i++) {
        if (keys[i]!.charCodeAt(0) <= 57 || keys[i - 1]! > keys[i]!) { sorted = false; break; }
      }
    }
    if (!sorted) keys.sort(compareKeys);
    for (let i = 0; i < keys.length; i++) {
      if (i) buf += ',';
      const key = keys[i]!;
      buf += quotedRegionKey(key);
      emit((v as Record<string, unknown>)[key]);
    }
    buf += '}';
    if (buf.length >= 64 * 1024) flush();
  };
  emit(value);
  flush();
  return hash.digest('hex');
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
