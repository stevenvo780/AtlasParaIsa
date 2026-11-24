/** V21 DVR: immutable gzip keyframes and incremental frames in an independent WAL database. */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { Tile, Viewport, WorldView } from '../shared/types.js';
import {
  TAPE_DEFAULT_MAX_FRAMES, TAPE_KEYFRAME_INTERVAL,
  type ITapeReader, type ITapeWriter, type TapeBackgroundTileFn, type TapeChunkResponse,
  type TapeMetaResponse, type TapeReaderOptions, type TapeTimelinePoint, type TapeWriterOptions,
  type TapeChunkEncoding, type TapeClientDelta,
} from '../shared/tape.js';

type Header = Omit<WorldView, 'tiles' | 'people' | 'animals' | 'structures' | 'events'>;
type Compact = Omit<WorldView, 'tiles'> & { modifiedTiles: Tile[] };
type Identified = { id: string };
type PartialUpsert = { id: string; _p: 1; _u?: string[] } & Record<string, unknown>;
type Patch<T extends Identified> = { upserts: (T | PartialUpsert)[]; removed: string[]; order?: string[] };
type TechPatch = {
  itemsPatch?: Patch<NonNullable<WorldView['technology']>['items'][number]>;
  recipesPatch?: Patch<NonNullable<WorldView['technology']>['recipes'][number]>;
  knowledge?: NonNullable<WorldView['technology']>['knowledge'];
  unsetKnowledge?: true;
  dynamics?: NonNullable<WorldView['technology']>['dynamics'];
  budgets?: NonNullable<WorldView['technology']>['budgets'];
};
type ObjectPatch = { set: Record<string, unknown>; unset?: string[] };
type Delta = Partial<Header> & {
  unset?: string[];
  peoplePatch?: Patch<WorldView['people'][number]>;
  animalsPatch?: Patch<NonNullable<WorldView['animals']>[number]>;
  structuresPatch?: Patch<NonNullable<WorldView['structures']>[number]>;
  blueprintsPatch?: Patch<NonNullable<WorldView['blueprints']>[number]>;
  communitiesPatch?: Patch<NonNullable<WorldView['communities']>[number]>;
  techPatch?: TechPatch;
  statsPatch?: ObjectPatch;
  tilesPatch?: Tile[];
  removedTiles?: string[];
  tileOrder?: string[];
  newEvents?: WorldView['events'];
  eventOrder?: string[];
};
type State = { view: Omit<WorldView, 'tiles'>; tiles: Map<string, Tile> };
type FrameRow = { tick: number; keyframe_tick: number; data: Uint8Array };
type Bounds = { minTick: number; maxTick: number; totalFrames: number };
type Pending = { tick: number; anchor: number; point: TapeTimelinePoint; at: number; data: Buffer; keyframe?: Buffer };

const coord = (t: { x: number; y: number }): string => `${t.x},${t.y}`;
const encode = (v: unknown): Buffer => gzipSync(JSON.stringify(v), { level: 1 });
const decode = <T>(data: Uint8Array): T => JSON.parse(gunzipSync(data).toString()) as T;
const jsonCopy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const jsonCache = new WeakMap<object, string>();
function fastJson(v: unknown): string {
  if (v !== null && typeof v === 'object') {
    let cached = jsonCache.get(v);
    if (cached === undefined) { cached = JSON.stringify(v); jsonCache.set(v, cached); }
    return cached;
  }
  return JSON.stringify(v);
}
const equal = (a: unknown, b: unknown): boolean => a === b || fastJson(a) === fastJson(b);
type Equality = (a: unknown, b: unknown) => boolean;
const isMember = (v: unknown): boolean => v !== undefined && typeof v !== 'function' && typeof v !== 'symbol';
/**
 * V24 writer: in-place JSON normalization of a value the writer owns (a structured clone from the
 * simulation thread), with exactly what a JSON round trip keeps: members that JSON drops are deleted
 * (null inside arrays), non-finite numbers become null and -0 becomes 0. Anything but a plain object
 * or array takes the real round trip.
 */
function normalizeOwned(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? value === 0 ? 0 : value : null;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = isMember(value[i]) ? normalizeOwned(value[i]) : null;
    return value;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return jsonCopy(value);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const member = record[key];
    if (isMember(member)) record[key] = normalizeOwned(member); else delete record[key];
  }
  return value;
}
/** Structural equality of two JSON-normalized values: the same verdict as comparing their JSON texts
 * (key order included), without building them. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i] || !jsonEqual((a as Record<string, unknown>)[ka[i]!], (b as Record<string, unknown>)[ka[i]!])) return false;
  }
  return true;
}
/** Exact equality of two public tile projections (every field the wire carries). */
export function tileEqual(a: Tile | undefined, b: Tile | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.terrain === b.terrain
    && a.moisture === b.moisture && a.vegetation === b.vegetation && a.food === b.food
    && a.biome === b.biome && a.elevation === b.elevation
    && a.wood === b.wood && a.stone === b.stone && a.feature === b.feature
    && a.variety === b.variety && a.growth === b.growth && a.fertility === b.fertility
    && a.cultivation === b.cultivation && a.traffic === b.traffic && a.paved === b.paved
    && a.drinkingWater === b.drinkingWater && a.species === b.species
    && a.fauna === b.fauna && a.life === b.life;
}
function tileChangedSignificantly(a: Tile, b: Tile): boolean {
  if (
    a.terrain !== b.terrain || a.biome !== b.biome || a.feature !== b.feature
    || a.species !== b.species || a.wood !== b.wood || a.stone !== b.stone
    || a.paved !== b.paved
  ) return true;
  if (Math.abs((a.cultivation ?? 0) - (b.cultivation ?? 0)) >= 0.04) return true;
  if (Math.abs((a.traffic ?? 0) - (b.traffic ?? 0)) >= 0.05 && ((a.traffic ?? 0) >= 0.25 || (b.traffic ?? 0) >= 0.25)) return true;
  return Math.abs((a.food ?? 0) - (b.food ?? 0)) >= 0.12
    || Math.abs((a.drinkingWater ?? 0) - (b.drinkingWater ?? 0)) >= 0.12
    || Math.abs((a.vegetation ?? 0) - (b.vegetation ?? 0)) >= 0.12
    || Math.abs((a.moisture ?? 0) - (b.moisture ?? 0)) >= 0.15
    || Math.abs((a.growth ?? 0) - (b.growth ?? 0)) >= 0.12;
}
function diffObject(cur: Record<string, unknown>, prev: Record<string, unknown>, eq: Equality = equal): ObjectPatch | undefined {
  const set: Record<string, unknown> = {};
  let hasChange = false;
  for (const key in cur) {
    if (!eq(cur[key], prev[key])) { set[key] = cur[key]; hasChange = true; }
  }
  const unset: string[] = [];
  for (const key in prev) if (!(key in cur)) { unset.push(key); hasChange = true; }
  if (!hasChange) return undefined;
  return unset.length ? { set, unset } : { set };
}
function applyObjectPatch<T extends Record<string, unknown>>(prev: T, change: ObjectPatch): T {
  const next: Record<string, unknown> = { ...prev, ...change.set };
  for (const key of change.unset ?? []) delete next[key];
  return next as T;
}
function patchNonEmpty<T extends Identified>(p: Patch<T>): boolean {
  return p.upserts.length > 0 || p.removed.length > 0 || p.order !== undefined;
}
/** `state.tiles` entries are flat immutable Tile records (never mutated in place), so a Map copy suffices. */
function cloneState(state: State): State {
  return { view: structuredClone(state.view), tiles: new Map(state.tiles) };
}
const interesting = (t: Tile): boolean => t.terrain === 'shelter' || (t.cultivation ?? 0) > 0
  || (t.paved ?? 0) > 0 || (t.traffic ?? 0) >= 0.25 || (t.wood ?? 0) > 0;

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value!)) : fallback;
}

export function tapePathForWorld(worldPath: string): string {
  return worldPath.endsWith('.sqlite') ? `${worldPath.slice(0, -7)}.tape.sqlite` : `${worldPath}.tape.sqlite`;
}

function bounds(db: DatabaseSync): Bounds {
  return db.prepare('SELECT COALESCE(MIN(tick),0) AS minTick, COALESCE(MAX(tick),0) AS maxTick, COUNT(*) AS totalFrames FROM tape_frames').get() as Bounds;
}

function compact(state: State): Compact {
  return { ...state.view, modifiedTiles: [...state.tiles.values()] };
}

function unpack(data: Uint8Array): State {
  const { modifiedTiles, ...view } = decode<Compact>(data);
  // Defensive even for tapes produced by an older writer. Raw world seeds never reach playback.
  delete (view as unknown as Record<string, unknown>).seed;
  return { view, tiles: new Map(modifiedTiles.map(t => [coord(t), t])) };
}

function patch<T extends Identified>(current: T[], previous: T[], eq: Equality = equal): Patch<T> {
  const old = new Map(previous.map(v => [v.id, v]));
  const ids = new Set(current.map(v => v.id));
  const upserts: (T | PartialUpsert)[] = [];
  for (const v of current) {
    const prev = old.get(v.id);
    if (!prev) { upserts.push(v); continue; }
    const curRec = v as Record<string, unknown>;
    const prevRec = prev as Record<string, unknown>;
    let diff: PartialUpsert | undefined;
    let unset: string[] | undefined;
    for (const key in curRec) {
      if (key === 'id') continue;
      const val = curRec[key];
      if (!eq(val, prevRec[key])) (diff ??= { id: v.id, _p: 1 })[key] = val;
    }
    for (const key in prevRec) {
      if (key !== 'id' && !(key in curRec)) (unset ??= []).push(key);
    }
    if (unset) (diff ??= { id: v.id, _p: 1 })._u = unset;
    if (diff) upserts.push(diff);
  }
  const result: Patch<T> = {
    upserts,
    removed: previous.filter(v => !ids.has(v.id)).map(v => v.id),
  };
  const naturalOrder = previous.filter(v => ids.has(v.id)).map(v => v.id)
    .concat(current.filter(v => !old.has(v.id)).map(v => v.id));
  if (!eq(naturalOrder, current.map(v => v.id))) result.order = current.map(v => v.id);
  return result;
}

function applyPatch<T extends Identified>(current: T[], change: Patch<T>): T[] {
  const values = new Map(current.map(v => [v.id, v]));
  for (const id of change.removed) values.delete(id);
  for (const v of change.upserts) {
    if ('_p' in v && v._p === 1) {
      const prev = values.get(v.id);
      const next = (prev ? { ...prev } : { id: v.id }) as Record<string, unknown>;
      for (const [k, val] of Object.entries(v)) {
        if (k === '_p' || k === '_u') continue;
        next[k] = val;
      }
      for (const k of (v._u as string[] | undefined) ?? []) delete next[k];
      values.set(v.id, next as T);
    } else {
      values.set(v.id, v as T);
    }
  }
  return change.order ? change.order.map(id => values.get(id)!) : [...values.values()];
}

function apply(state: State, data: Uint8Array): Delta {
  const delta = decode<Delta>(data);
  const { peoplePatch, animalsPatch, structuresPatch, blueprintsPatch, communitiesPatch,
    techPatch, statsPatch, tilesPatch, removedTiles, tileOrder,
    newEvents, eventOrder, unset, ...header } = delta;
  Object.assign(state.view, header);
  if (peoplePatch) state.view.people = applyPatch(state.view.people, peoplePatch);
  if (animalsPatch) state.view.animals = applyPatch(state.view.animals ?? [], animalsPatch);
  if (structuresPatch) state.view.structures = applyPatch(state.view.structures ?? [], structuresPatch);
  if (blueprintsPatch) state.view.blueprints = applyPatch(state.view.blueprints ?? [], blueprintsPatch);
  if (communitiesPatch) state.view.communities = applyPatch(state.view.communities ?? [], communitiesPatch);
  if (techPatch && state.view.technology) {
    const tech = { ...state.view.technology };
    if (techPatch.itemsPatch) tech.items = applyPatch(tech.items, techPatch.itemsPatch);
    if (techPatch.recipesPatch) tech.recipes = applyPatch(tech.recipes, techPatch.recipesPatch);
    if (techPatch.knowledge !== undefined) tech.knowledge = techPatch.knowledge;
    else if (techPatch.unsetKnowledge) delete tech.knowledge;
    if (techPatch.dynamics !== undefined) tech.dynamics = techPatch.dynamics;
    if (techPatch.budgets !== undefined) tech.budgets = techPatch.budgets;
    state.view.technology = tech;
  }
  if (statsPatch && state.view.stats) {
    state.view.stats = applyObjectPatch(state.view.stats as unknown as Record<string, unknown>, statsPatch) as unknown as WorldView['stats'];
  }
  for (const key of removedTiles ?? []) state.tiles.delete(key);
  for (const tile of tilesPatch ?? []) state.tiles.set(coord(tile), tile);
  if (tileOrder) state.tiles = new Map(tileOrder.map(key => [key, state.tiles.get(key)!]));
  const events = new Map(state.view.events.map(e => [e.id, e]));
  for (const e of newEvents ?? []) events.set(e.id, e);
  if (eventOrder) state.view.events = eventOrder.map(id => events.get(id)!);
  else if (newEvents?.length) state.view.events = [...events.values()];
  for (const key of unset ?? []) delete (state.view as unknown as Record<string, unknown>)[key];
  delete (state.view as unknown as Record<string, unknown>).seed;
  return delta;
}

function reconstruct(db: DatabaseSync, row: FrameRow, cached?: State, after?: number): State {
  const state = cached ?? unpack((db.prepare('SELECT data FROM tape_keyframes WHERE tick=?').get(row.keyframe_tick) as { data: Uint8Array }).data);
  const deltas = db.prepare('SELECT data FROM tape_frames WHERE tick>? AND tick<=? ORDER BY tick').all(after ?? row.keyframe_tick, row.tick) as { data: Uint8Array }[];
  for (const delta of deltas) apply(state, delta.data);
  return state;
}

export class TapeWriter implements ITapeWriter {
  private readonly db: DatabaseSync;
  private readonly insertFrame: StatementSync;
  private readonly insertKeyframe: StatementSync;
  private readonly setMeta: StatementSync;
  private readonly keyframeInterval: number;
  private readonly maxFrames: number;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private pending: Pending[] = [];
  private previous?: Omit<WorldView, 'tiles'>;
  private previousTiles = new Map<string, Tile>();
  private recordedTiles = new Map<string, Tile>();
  private anchor = -1;
  private count: number;
  private tick: number;
  private lastFlushAt = Date.now();
  private closed = false;

  constructor(options: TapeWriterOptions) {
    this.keyframeInterval = positive(options.keyframeInterval, TAPE_KEYFRAME_INTERVAL);
    this.maxFrames = positive(options.maxFrames, TAPE_DEFAULT_MAX_FRAMES);
    this.batchSize = positive(options.batchSize, 25);
    this.flushIntervalMs = Number.isFinite(options.flushIntervalMs) ? Math.max(0, options.flushIntervalMs!) : 250;
    if (options.path !== ':memory:') mkdirSync(dirname(resolve(options.path)), { recursive: true });
    this.db = new DatabaseSync(options.path);
    try {
      const preVersion = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
      if (preVersion === 0) this.db.exec('PRAGMA auto_vacuum=INCREMENTAL;');
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY;');
      const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
      if (version !== 0 && version !== 1) throw new Error(`Unsupported tape schema version: ${version}`);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tape_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tape_keyframes(tick INTEGER PRIMARY KEY, day INTEGER NOT NULL,
          pop INTEGER NOT NULL, saved_at INTEGER NOT NULL, data BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS tape_frames(tick INTEGER PRIMARY KEY, keyframe_tick INTEGER NOT NULL,
          day INTEGER NOT NULL, phase TEXT NOT NULL, weather TEXT NOT NULL, pop INTEGER NOT NULL,
          births INTEGER NOT NULL, deaths INTEGER NOT NULL, structures INTEGER NOT NULL, formulas INTEGER NOT NULL,
          paved INTEGER NOT NULL, sim_hz REAL NOT NULL, saved_at INTEGER NOT NULL, data BLOB NOT NULL);
        CREATE INDEX IF NOT EXISTS tape_frames_anchor ON tape_frames(keyframe_tick);
        PRAGMA user_version=1;
      `);
      this.insertFrame = this.db.prepare('INSERT INTO tape_frames VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      this.insertKeyframe = this.db.prepare('INSERT INTO tape_keyframes VALUES (?,?,?,?,?)');
      this.setMeta = this.db.prepare('INSERT OR REPLACE INTO tape_meta VALUES (?,?)');
      const saved = bounds(this.db);
      this.count = saved.totalFrames;
      this.tick = saved.totalFrames ? saved.maxTick : -1;
      this.setMeta.run('keyframeInterval', String(this.keyframeInterval));
      this.setMeta.run('maxFrames', String(this.maxFrames));
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  get frameCount(): number { return this.count; }
  get latestTick(): number { return this.tick; }

  /** `owned`: the caller hands over `view` (a structured clone nobody else holds), normalized in place
   * instead of copied; top-level values identical to the previous frame's are already normalized. */
  record(view: WorldView, simHz: number, partialTiles = false, owned = false): void {
    if (this.closed) throw new Error('TapeWriter is closed');
    if (!Number.isSafeInteger(view.tick) || view.tick < 0) throw new Error('Tape tick must be a nonnegative safe integer');
    // A tape is append-only. Repeated broadcasts of the same simulation tick add no frame.
    if (view.tick <= this.tick) return;
    const { tiles, ...raw } = view;
    let current: typeof raw;
    if (owned) {
      const previous = this.previous as Record<string, unknown> | undefined, fields = raw as Record<string, unknown>;
      for (const key of Object.keys(fields)) {
        const value = fields[key];
        if (!isMember(value)) delete fields[key];
        else if (value !== previous?.[key]) fields[key] = normalizeOwned(value);
      }
      current = raw;
    } else current = jsonCopy(raw);
    delete (current as unknown as Record<string, unknown>).seed;
    const { people, animals, structures, events, blueprints, communities, technology, stats, ...header } = current;
    const sparseMode = tiles.length > 4096 || (partialTiles && this.previousTiles.size > 4096);
    const small = !partialTiles && !sparseMode;
    const nextTiles = partialTiles ? this.previousTiles : new Map<string, Tile>();
    const tilesPatch: Tile[] = [];
    const removedTiles: string[] = [];
    // Clone only changed cells, never JSON-encode an entire large landscape.
    for (const tile of tiles) {
      const key = coord(tile);
      const old = this.previousTiles.get(key);
      const changed = old !== undefined && (sparseMode ? tileChangedSignificantly(old, tile) : !tileEqual(old, tile));
      const copy = old && !changed ? old : { ...tile };
      if (!partialTiles || !old || changed) nextTiles.set(key, copy);
      if (small || interesting(tile) || changed || this.recordedTiles.has(key)) {
        const rec = this.recordedTiles.get(key);
        const recDiff = rec !== copy && (rec === undefined || (sparseMode ? tileChangedSignificantly(rec, copy) : !tileEqual(copy, rec)));
        if (recDiff) {
          tilesPatch.push(copy);
          this.recordedTiles.set(key, copy);
        }
      }
    }
    if (!partialTiles) {
      for (const key of this.recordedTiles.keys()) {
        if (!nextTiles.has(key)) { removedTiles.push(key); this.recordedTiles.delete(key); }
      }
    }
    const tileOrder = small ? [...nextTiles.keys()] : undefined;
    if (small) this.recordedTiles = new Map(nextTiles);
    const oldEvents = new Map(this.previous?.events.map(e => [e.id, e]));
    const eventEdited = events.some(e => oldEvents.has(e.id) && !jsonEqual(e, oldEvents.get(e.id)));
    const isKeyframe = !this.previous || view.tick - this.anchor >= this.keyframeInterval || eventEdited;
    let keyframe: Buffer | undefined;
    let data: Buffer;
    if (isKeyframe) {
      this.anchor = view.tick;
      keyframe = encode({ ...current, modifiedTiles: [...this.recordedTiles.values()] } satisfies Compact);
      data = encode({ keyframe: true });
    } else {
      const { people: oldPeople, animals: oldAnimals, structures: oldStructures, events: _oldEvents,
        blueprints: oldBlueprints, communities: oldCommunities, technology: oldTech, stats: oldStats, ...oldHeader } = this.previous!;
      const delta: Delta = {
        tick: view.tick, sequence: view.sequence, day: view.day, phase: view.phase, weather: view.weather,
        peoplePatch: patch(people, oldPeople, jsonEqual), tilesPatch, newEvents: events.filter(e => !oldEvents.has(e.id)),
      };
      const changes = delta as Record<string, unknown>;
      for (const [key, value] of Object.entries(header)) {
        if (!jsonEqual(value, (oldHeader as unknown as Record<string, unknown>)[key])) changes[key] = value;
      }
      const unset = Object.keys(oldHeader).filter(key => !(key in header));
      if (animals) delta.animalsPatch = patch(animals, oldAnimals ?? [], jsonEqual);
      else if (oldAnimals) unset.push('animals');
      if (structures) delta.structuresPatch = patch(structures, oldStructures ?? [], jsonEqual);
      else if (oldStructures) unset.push('structures');
      if (blueprints && oldBlueprints) {
        const bp = patch(blueprints, oldBlueprints, jsonEqual);
        if (patchNonEmpty(bp)) delta.blueprintsPatch = bp;
      } else if (blueprints) delta.blueprints = blueprints;
      else if (oldBlueprints) unset.push('blueprints');
      if (communities && oldCommunities) {
        const cp = patch(communities, oldCommunities, jsonEqual);
        if (patchNonEmpty(cp)) delta.communitiesPatch = cp;
      } else if (communities) delta.communities = communities;
      else if (oldCommunities) unset.push('communities');
      if (technology && oldTech) {
        const tp: TechPatch = {};
        let techChanged = false;
        const ip = patch(technology.items, oldTech.items, jsonEqual);
        if (patchNonEmpty(ip)) { tp.itemsPatch = ip; techChanged = true; }
        const rp = patch(technology.recipes, oldTech.recipes, jsonEqual);
        if (patchNonEmpty(rp)) { tp.recipesPatch = rp; techChanged = true; }
        if (technology.knowledge !== undefined && !jsonEqual(technology.knowledge, oldTech.knowledge)) { tp.knowledge = technology.knowledge; techChanged = true; }
        else if (technology.knowledge === undefined && oldTech.knowledge !== undefined) { tp.unsetKnowledge = true; techChanged = true; }
        if (!jsonEqual(technology.dynamics, oldTech.dynamics)) { tp.dynamics = technology.dynamics; techChanged = true; }
        if (!jsonEqual(technology.budgets, oldTech.budgets)) { tp.budgets = technology.budgets; techChanged = true; }
        if (techChanged) delta.techPatch = tp;
      } else if (technology) delta.technology = technology;
      else if (oldTech) unset.push('technology');
      if (stats && oldStats) {
        const sp = diffObject(stats as unknown as Record<string, unknown>, oldStats as unknown as Record<string, unknown>, jsonEqual);
        if (sp) delta.statsPatch = sp;
      } else if (stats) delta.stats = stats;
      else if (oldStats) unset.push('stats');
      if (unset.length) delta.unset = unset;
      if (removedTiles.length) delta.removedTiles = removedTiles;
      if (tileOrder && !jsonEqual(tileOrder, [...this.previousTiles.keys()])) delta.tileOrder = tileOrder;
      if (!jsonEqual(events.map(e => e.id), this.previous!.events.map(e => e.id))) delta.eventOrder = events.map(e => e.id);
      data = encode(delta);
    }
    const point: TapeTimelinePoint = {
      tick: view.tick, day: view.day, phase: view.phase, weather: view.weather,
      pop: view.stats?.population ?? people.length, births: view.stats?.totals.births ?? 0,
      deaths: view.demography?.deaths ?? 0, structures: structures?.length ?? 0,
      formulas: view.chemistry?.totalFormulas ?? view.stats?.chemicalFormulas ?? 0,
      paved: view.stats?.pavedTiles ?? 0, simHz: Number.isFinite(simHz) ? simHz : 0,
    };
    this.pending.push({ tick: view.tick, anchor: this.anchor, point, at: Date.now(), data, keyframe });
    this.previous = current;
    this.previousTiles = nextTiles;
    this.tick = view.tick;
    this.count++;
    if (this.pending.length >= this.batchSize || Date.now() - this.lastFlushAt >= this.flushIntervalMs) this.flush();
  }

  flush(): void {
    if (this.closed) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of this.pending) {
        const p = row.point;
        if (row.keyframe) this.insertKeyframe.run(row.tick, p.day, p.pop, row.at, row.keyframe);
        this.insertFrame.run(row.tick, row.anchor, p.day, p.phase, p.weather, p.pop, p.births,
          p.deaths, p.structures, p.formulas, p.paved, p.simHz, row.at, row.data);
      }
      if (this.previous) {
        this.setMeta.run('worldInstanceId', this.previous.instanceId ?? '');
        this.setMeta.run('geologyKey', JSON.stringify(this.previous.geologyKey ?? null));
      }
      const pruned = this.prune();
      const retained = bounds(this.db).totalFrames;
      this.db.exec('COMMIT');
      if (pruned) this.db.exec('PRAGMA incremental_vacuum(200);');
      this.count = retained;
      this.pending = [];
      this.lastFlushAt = Date.now();
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private prune(): boolean {
    const cutoff = this.db.prepare('SELECT tick,keyframe_tick,data,day,pop,saved_at FROM tape_frames ORDER BY tick DESC LIMIT 1 OFFSET ?')
      .get(this.maxFrames - 1) as (FrameRow & { day: number; pop: number; saved_at: number }) | undefined;
    if (!cutoff) return false;
    if (cutoff.tick !== cutoff.keyframe_tick) {
      // Keeping just the old anchor is insufficient: intermediate deltas would be lost.
      // Promote the boundary BEFORE removing the prefix, in the same transaction.
      const state = reconstruct(this.db, cutoff);
      this.insertKeyframe.run(cutoff.tick, cutoff.day, cutoff.pop, cutoff.saved_at, encode(compact(state)));
      this.db.prepare('UPDATE tape_frames SET keyframe_tick=? WHERE keyframe_tick=? AND tick>=?')
        .run(cutoff.tick, cutoff.keyframe_tick, cutoff.tick);
      this.db.prepare('UPDATE tape_frames SET data=? WHERE tick=?').run(encode({ keyframe: true }), cutoff.tick);
      if (this.anchor === cutoff.keyframe_tick) this.anchor = cutoff.tick;
    }
    const deleted = this.db.prepare('DELETE FROM tape_frames WHERE tick<?').run(cutoff.tick);
    this.db.exec('DELETE FROM tape_keyframes WHERE tick < (SELECT MIN(keyframe_tick) FROM tape_frames)');
    return Number(deleted.changes) > 0;
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.db.close();
    this.closed = true;
  }
}

function project(state: State, viewport?: Viewport, backgroundTile?: TapeBackgroundTileFn, headerOnly = false): WorldView {
  // Reconstructed records are immutable: apply() replaces rather than mutates nested values.
  // Delta mode only needs a shallow projection, with no background landscape materialization.
  const result = (headerOnly ? { ...state.view, ...(state.view.technology ? { technology: { ...state.view.technology } } : {}) }
    : structuredClone(state.view)) as WorldView;
  delete (result as unknown as Record<string, unknown>).seed;
  if (!viewport) return { ...result, tiles: headerOnly ? [] : [...state.tiles.values()].map(tile => ({ ...tile })) };
  const visible = (p: { x: number; y: number }, margin = 0): boolean => p.x >= viewport.x - margin
    && p.y >= viewport.y - margin && p.x < viewport.x + viewport.width + margin
    && p.y < viewport.y + viewport.height + margin;
  result.originX = viewport.x; result.originY = viewport.y;
  result.width = viewport.width; result.height = viewport.height;
  result.tiles = [];
  if (!headerOnly) for (let y = viewport.y; y < viewport.y + viewport.height; y++) {
    for (let x = viewport.x; x < viewport.x + viewport.width; x++) {
      const tile = state.tiles.get(`${x},${y}`) ?? backgroundTile?.(x, y, result.tick);
      if (tile) result.tiles.push({ ...tile });
    }
  }
  result.people = result.people.filter(p => visible(p, 1));
  const ids = new Set(result.people.map(p => p.id));
  if (result.animals) result.animals = result.animals.filter(p => visible(p));
  if (result.structures) result.structures = result.structures.filter(s => {
    if (visible(s, 1) || s.cells?.some(c => visible(c, 1))) return true;
    const footprint = s.footprint;
    return !!footprint && s.x < viewport.x + viewport.width + 1 && s.y < viewport.y + viewport.height + 1
      && s.x + footprint.width > viewport.x - 1 && s.y + footprint.height > viewport.y - 1;
  });
  result.places = result.places.filter(p => visible(p));
  const blueprints = new Set(result.structures?.map(s => s.blueprintId));
  if (result.blueprints) result.blueprints = result.blueprints.filter(b => blueprints.has(b.id));
  if (result.communities) result.communities = result.communities.map(c => ({ ...c, members: c.members.filter(id => ids.has(id)) }));
  if (result.technology) {
    result.technology.items = result.technology.items.filter(item => ids.has(item.ownerId));
    if (result.technology.knowledge) result.technology.knowledge = result.technology.knowledge.filter(k => ids.has(k.actorId));
  }
  return result;
}

/** Diff projected public records, including optional-field deletion and entity ordering. */
function clientDelta(previous: WorldView, current: WorldView): TapeClientDelta {
  const delta: TapeClientDelta = { tick: current.tick, sequence: current.sequence,
    day: current.day, phase: current.phase, weather: current.weather };
  const special = new Set(['tiles', 'people', 'animals', 'structures', 'places', 'blueprints',
    'communities', 'technology', 'stats', 'events']);
  const old = previous as unknown as Record<string, unknown>;
  const changes = delta as unknown as Record<string, unknown>;
  const unset = Object.keys(previous).filter(key => !(key in current));
  for (const [key, value] of Object.entries(current)) {
    if (!special.has(key) && !equal(value, old[key])) changes[key] = value;
  }
  for (const field of ['people', 'animals', 'structures', 'places', 'blueprints', 'communities'] as const) {
    const values = current[field];
    if (values) {
      const p = patch<Identified>(values, previous[field] ?? []);
      // An absent optional list must become [] even when the patch is otherwise empty.
      if (!previous[field] || patchNonEmpty(p)) changes[`${field}Patch`] = p;
    }
  }
  const tech = current.technology, prevTech = previous.technology;
  if (tech && prevTech) {
    const tp: TechPatch = {};
    const items = patch(tech.items, prevTech.items), recipes = patch(tech.recipes, prevTech.recipes);
    if (patchNonEmpty(items)) tp.itemsPatch = items;
    if (patchNonEmpty(recipes)) tp.recipesPatch = recipes;
    if (!equal(tech.knowledge, prevTech.knowledge)) {
      if (tech.knowledge === undefined) tp.unsetKnowledge = true;
      else tp.knowledge = tech.knowledge;
    }
    if (!equal(tech.dynamics, prevTech.dynamics)) tp.dynamics = tech.dynamics;
    if (!equal(tech.budgets, prevTech.budgets)) tp.budgets = tech.budgets;
    // The shared patch has no unset for dynamics/budgets; replacement preserves exact absence.
    if (Object.keys(prevTech).some(key => !(key in tech) && key !== 'knowledge')) delta.technology = tech;
    else if (Object.keys(tp).length) delta.techPatch = tp;
  } else if (tech) delta.technology = tech;
  if (current.stats && previous.stats) {
    const sp = diffObject(current.stats as unknown as Record<string, unknown>, previous.stats as unknown as Record<string, unknown>);
    if (sp) delta.statsPatch = sp;
  } else if (current.stats) delta.stats = current.stats;
  const events = new Map(previous.events.map(event => [event.id, event]));
  const newEvents = current.events.filter(event => !equal(event, events.get(event.id)));
  if (newEvents.length) delta.newEvents = newEvents;
  if (!equal(current.events.map(event => event.id), previous.events.map(event => event.id))) {
    delta.eventOrder = current.events.map(event => event.id);
  }
  if (unset.length) delta.unset = unset;
  return delta;
}

export class TapeReader implements ITapeReader {
  private db?: DatabaseSync;
  private closed = false;
  private dataVersion = -1;
  private readonly cache = new Map<number, { anchor: number; state: State }>();
  constructor(private readonly options: TapeReaderOptions) {}

  private open(): DatabaseSync | undefined {
    if (this.closed) throw new Error('TapeReader is closed');
    if (this.db) return this.db;
    if (!existsSync(this.options.path)) return undefined;
    const db = new DatabaseSync(this.options.path, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout=5000');
      const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
      // The writer may have created the file without installing its schema yet.
      if (version === 0) { db.close(); return undefined; }
      if (version !== 1) throw new Error('Unsupported tape schema version');
      this.db = db;
      return db;
    } catch (error) { db.close(); throw error; }
  }

  private transaction<T>(db: DatabaseSync, fn: () => T): T {
    db.exec('BEGIN');
    try {
      const version = Number(db.prepare('PRAGMA data_version').get()!.data_version);
      if (version !== this.dataVersion) { this.cache.clear(); this.dataVersion = version; }
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) { db.exec('ROLLBACK'); this.cache.clear(); throw error; }
  }

  readMeta(maxTimelinePoints = 240): TapeMetaResponse {
    const empty: TapeMetaResponse = {
      enabled: true, observerOnly: !!this.options.observerOnly, turbo: !!this.options.turbo,
      minTick: 0, maxTick: 0, latestDay: 1, totalFrames: 0,
      keyframeInterval: TAPE_KEYFRAME_INTERVAL, simHz: 0, keyframeTicks: [], timeline: [],
    };
    const db = this.open();
    if (!db) return empty;
    return this.transaction(db, () => {
      const saved = bounds(db);
      const interval = db.prepare("SELECT value FROM tape_meta WHERE key='keyframeInterval'").get();
      empty.keyframeInterval = Number(interval?.value ?? TAPE_KEYFRAME_INTERVAL);
      if (!saved.totalFrames) return empty;
      const last = db.prepare('SELECT day,sim_hz FROM tape_frames ORDER BY tick DESC LIMIT 1').get()!;
      const points = Math.min(saved.totalFrames, Math.max(2, positive(maxTimelinePoints, 240)));
      // Indexed rank lookups: no blob reads or full timeline materialization in JS.
      const sample = db.prepare(`SELECT tick,day,phase,weather,pop,births,deaths,structures,formulas,paved,sim_hz AS simHz
        FROM tape_frames ORDER BY tick LIMIT 1 OFFSET ?`);
      const timeline: TapeTimelinePoint[] = [];
      for (let i = 0; i < points; i++) timeline.push(sample.get(points === 1 ? 0 : Math.round(i * (saved.totalFrames - 1) / (points - 1))) as unknown as TapeTimelinePoint);
      return {
        ...empty, ...saved, latestDay: Number(last.day), simHz: Number(last.sim_hz), timeline,
        keyframeTicks: (db.prepare('SELECT tick FROM tape_keyframes ORDER BY tick').all() as { tick: number }[]).map(r => r.tick),
      };
    });
  }

  readChunk(fromTick: number, count: number, viewport?: Viewport, backgroundTile?: TapeBackgroundTileFn, encoding: TapeChunkEncoding = 'full'): TapeChunkResponse {
    const empty: TapeChunkResponse = { fromTick, toTick: fromTick, minTick: 0, maxTick: 0, simHz: 0, hasMore: false, frames: [],
      ...(encoding === 'delta' ? { encoding, deltas: [] } : {}) };
    const db = this.open();
    if (!db) return empty;
    return this.transaction(db, () => {
      const saved = bounds(db);
      if (!saved.totalFrames) return empty;
      const hz = Number(db.prepare('SELECT sim_hz FROM tape_frames ORDER BY tick DESC LIMIT 1').get()!.sim_hz);
      const rows = db.prepare('SELECT tick,keyframe_tick,data FROM tape_frames WHERE tick>=? ORDER BY tick LIMIT ?')
        .all(Number.isFinite(fromTick) ? fromTick : saved.minTick, Math.min(240, positive(count, 1))) as FrameRow[];
      const frames: WorldView[] = [];
      let baseFrame: WorldView | undefined, previous: WorldView | undefined;
      const deltas: TapeClientDelta[] = [];
      let projectedTiles = new Map<string, Tile>();
      let state: State | undefined;
      let anchor = -1;
      for (const row of rows) {
        let candidates: Iterable<string> = [];
        if (!state || anchor !== row.keyframe_tick) {
          const oldTiles = state?.tiles;
          let nearest = -1;
          for (const [tick, value] of this.cache) {
            if (value.anchor === row.keyframe_tick && tick <= row.tick && tick > nearest) nearest = tick;
          }
          const cached = this.cache.get(nearest);
          state = reconstruct(db, row, cached ? cloneState(cached.state) : undefined, cached ? nearest : undefined);
          if (cached) { this.cache.delete(nearest); this.cache.set(nearest, cached); }
          anchor = row.keyframe_tick;
          if (previous) candidates = new Set([...(oldTiles?.keys() ?? []), ...state.tiles.keys()]);
        } else {
          const change = apply(state, row.data);
          candidates = new Set([...(change.tilesPatch?.map(coord) ?? []), ...(change.removedTiles ?? [])]);
        }
        if (encoding !== 'delta') frames.push(project(state, viewport, backgroundTile));
        else if (!previous) {
          baseFrame = previous = project(state, viewport, backgroundTile);
          projectedTiles = new Map(baseFrame.tiles.map(tile => [coord(tile), tile]));
        } else {
          const current = project(state, viewport, undefined, true);
          const delta = clientDelta(previous, current);
          const tilesPatch: Tile[] = [], removedTiles: string[] = [];
          const oldOrder = [...projectedTiles.keys()];
          let membershipChanged = false;
          for (const key of candidates) {
            const [x, y] = key.split(',').map(Number) as [number, number];
            if (viewport && (x < viewport.x || y < viewport.y || x >= viewport.x + viewport.width || y >= viewport.y + viewport.height)) continue;
            const tile = state.tiles.get(key) ?? (viewport ? backgroundTile?.(x, y, current.tick) : undefined);
            const oldTile = projectedTiles.get(key);
            if (tileEqual(tile, oldTile)) continue;
            if (tile) {
              tilesPatch.push(tile);
              projectedTiles.set(key, tile);
              if (!oldTile) membershipChanged = true;
            } else if (oldTile) {
              removedTiles.push(key); projectedTiles.delete(key); membershipChanged = true;
            }
          }
          // A camera is row-major; without a camera preserve the tape's recorded tile order.
          // Rare reordered/inserted sparse cells need replacement because the frozen wire has no tileOrder.
          const desired = viewport ? (membershipChanged ? [...projectedTiles.values()].sort((a, b) => a.y - b.y || a.x - b.x).map(coord) : undefined)
            : [...state.tiles.keys()];
          if (desired && !equal(desired, [...projectedTiles.keys()])) {
            delta.removedTiles = oldOrder;
            delta.tilesPatch = desired.map(key => projectedTiles.get(key)!);
            projectedTiles = new Map(delta.tilesPatch.map(tile => [coord(tile), tile]));
          } else {
            if (tilesPatch.length) delta.tilesPatch = tilesPatch;
            if (removedTiles.length) delta.removedTiles = removedTiles;
          }
          deltas.push(delta);
          previous = current;
        }
        if (row.tick === row.keyframe_tick || row === rows[rows.length - 1]) {
          this.cache.delete(row.tick);
          this.cache.set(row.tick, { anchor, state: cloneState(state) });
          while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value!);
        }
      }
      return {
        fromTick: baseFrame?.tick ?? frames[0]?.tick ?? fromTick, toTick: previous?.tick ?? frames.at(-1)?.tick ?? fromTick,
        minTick: saved.minTick, maxTick: saved.maxTick, simHz: hz,
        hasMore: !!rows.length && rows.at(-1)!.tick < saved.maxTick, frames,
        ...(encoding === 'delta' ? { encoding, ...(baseFrame ? { baseFrame } : {}), deltas } : {}),
      };
    });
  }

  close(): void {
    if (this.closed) return;
    this.db?.close(); this.db = undefined; this.cache.clear(); this.closed = true;
  }
}
