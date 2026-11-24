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
} from '../shared/tape.js';

type Header = Omit<WorldView, 'tiles' | 'people' | 'animals' | 'structures' | 'events'>;
type Compact = Omit<WorldView, 'tiles'> & { modifiedTiles: Tile[] };
type Identified = { id: string };
type Patch<T> = { upserts: T[]; removed: string[]; order?: string[] };
type Delta = Partial<Header> & {
  unset?: string[];
  peoplePatch?: Patch<WorldView['people'][number]>;
  animalsPatch?: Patch<NonNullable<WorldView['animals']>[number]>;
  structuresPatch?: Patch<NonNullable<WorldView['structures']>[number]>;
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
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
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

function patch<T extends Identified>(current: T[], previous: T[]): Patch<T> {
  const old = new Map(previous.map(v => [v.id, v]));
  const ids = new Set(current.map(v => v.id));
  const result: Patch<T> = {
    upserts: current.filter(v => !equal(v, old.get(v.id))),
    removed: previous.filter(v => !ids.has(v.id)).map(v => v.id),
  };
  const naturalOrder = previous.filter(v => ids.has(v.id)).map(v => v.id)
    .concat(current.filter(v => !old.has(v.id)).map(v => v.id));
  if (!equal(naturalOrder, current.map(v => v.id))) result.order = current.map(v => v.id);
  return result;
}

function applyPatch<T extends Identified>(current: T[], change: Patch<T>): T[] {
  const values = new Map(current.map(v => [v.id, v]));
  for (const id of change.removed) values.delete(id);
  for (const v of change.upserts) values.set(v.id, v);
  return change.order ? change.order.map(id => values.get(id)!) : [...values.values()];
}

function apply(state: State, data: Uint8Array): void {
  const { peoplePatch, animalsPatch, structuresPatch, tilesPatch, removedTiles, tileOrder,
    newEvents, eventOrder, unset, ...header } = decode<Delta>(data);
  Object.assign(state.view, header);
  if (peoplePatch) state.view.people = applyPatch(state.view.people, peoplePatch);
  if (animalsPatch) state.view.animals = applyPatch(state.view.animals ?? [], animalsPatch);
  if (structuresPatch) state.view.structures = applyPatch(state.view.structures ?? [], structuresPatch);
  for (const key of removedTiles ?? []) state.tiles.delete(key);
  for (const tile of tilesPatch ?? []) state.tiles.set(coord(tile), tile);
  if (tileOrder) state.tiles = new Map(tileOrder.map(key => [key, state.tiles.get(key)!]));
  const events = new Map(state.view.events.map(e => [e.id, e]));
  for (const e of newEvents ?? []) events.set(e.id, e);
  if (eventOrder) state.view.events = eventOrder.map(id => events.get(id)!);
  else if (newEvents?.length) state.view.events = [...events.values()];
  for (const key of unset ?? []) delete (state.view as unknown as Record<string, unknown>)[key];
  delete (state.view as unknown as Record<string, unknown>).seed;
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

  record(view: WorldView, simHz: number): void {
    if (this.closed) throw new Error('TapeWriter is closed');
    if (!Number.isSafeInteger(view.tick) || view.tick < 0) throw new Error('Tape tick must be a nonnegative safe integer');
    // A tape is append-only. Repeated broadcasts of the same simulation tick add no frame.
    if (view.tick <= this.tick) return;
    const { tiles, ...raw } = view;
    const current = jsonCopy(raw);
    delete (current as unknown as Record<string, unknown>).seed;
    const { people, animals, structures, events, ...header } = current;
    const small = tiles.length <= 4096;
    const nextTiles = new Map<string, Tile>();
    const tilesPatch: Tile[] = [];
    const removedTiles: string[] = [];
    // Clone only changed cells, never JSON-encode an entire large landscape.
    for (const tile of tiles) {
      const key = coord(tile);
      const old = this.previousTiles.get(key);
      const changed = old !== undefined && !equal(old, tile);
      const copy = old && !changed ? old : { ...tile };
      nextTiles.set(key, copy);
      if (small || interesting(tile) || changed || this.recordedTiles.has(key)) {
        if (!equal(copy, this.recordedTiles.get(key))) tilesPatch.push(copy);
        this.recordedTiles.set(key, copy);
      }
    }
    for (const key of this.recordedTiles.keys()) {
      if (!nextTiles.has(key)) { removedTiles.push(key); this.recordedTiles.delete(key); }
    }
    const tileOrder = small ? [...nextTiles.keys()] : undefined;
    if (small) this.recordedTiles = new Map(nextTiles);
    const oldEvents = new Map(this.previous?.events.map(e => [e.id, e]));
    const eventEdited = events.some(e => oldEvents.has(e.id) && !equal(e, oldEvents.get(e.id)));
    const isKeyframe = !this.previous || view.tick - this.anchor >= this.keyframeInterval || eventEdited;
    let keyframe: Buffer | undefined;
    let data: Buffer;
    if (isKeyframe) {
      this.anchor = view.tick;
      keyframe = encode({ ...current, modifiedTiles: [...this.recordedTiles.values()] } satisfies Compact);
      data = encode({ keyframe: true });
    } else {
      const { people: oldPeople, animals: oldAnimals, structures: oldStructures, events: _oldEvents, ...oldHeader } = this.previous!;
      const delta: Delta = {
        tick: view.tick, sequence: view.sequence, day: view.day, phase: view.phase, weather: view.weather,
        peoplePatch: patch(people, oldPeople), tilesPatch, newEvents: events.filter(e => !oldEvents.has(e.id)),
      };
      const changes = delta as Record<string, unknown>;
      for (const [key, value] of Object.entries(header)) {
        if (!equal(value, (oldHeader as unknown as Record<string, unknown>)[key])) changes[key] = value;
      }
      const unset = Object.keys(oldHeader).filter(key => !(key in header));
      if (animals) delta.animalsPatch = patch(animals, oldAnimals ?? []);
      else if (oldAnimals) unset.push('animals');
      if (structures) delta.structuresPatch = patch(structures, oldStructures ?? []);
      else if (oldStructures) unset.push('structures');
      if (unset.length) delta.unset = unset;
      if (removedTiles.length) delta.removedTiles = removedTiles;
      if (tileOrder && !equal(tileOrder, [...this.previousTiles.keys()])) delta.tileOrder = tileOrder;
      if (!equal(events.map(e => e.id), this.previous!.events.map(e => e.id))) delta.eventOrder = events.map(e => e.id);
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
      this.prune();
      const retained = bounds(this.db).totalFrames;
      this.db.exec('COMMIT');
      this.count = retained;
      this.pending = [];
      this.lastFlushAt = Date.now();
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private prune(): void {
    const cutoff = this.db.prepare('SELECT tick,keyframe_tick,data,day,pop,saved_at FROM tape_frames ORDER BY tick DESC LIMIT 1 OFFSET ?')
      .get(this.maxFrames - 1) as (FrameRow & { day: number; pop: number; saved_at: number }) | undefined;
    if (!cutoff) return;
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
    this.db.prepare('DELETE FROM tape_frames WHERE tick<?').run(cutoff.tick);
    this.db.exec('DELETE FROM tape_keyframes WHERE tick < (SELECT MIN(keyframe_tick) FROM tape_frames)');
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.db.close();
    this.closed = true;
  }
}

function project(state: State, viewport?: Viewport, backgroundTile?: TapeBackgroundTileFn): WorldView {
  const result = structuredClone(state.view) as WorldView;
  delete (result as unknown as Record<string, unknown>).seed;
  if (!viewport) return { ...result, tiles: structuredClone([...state.tiles.values()]) };
  const visible = (p: { x: number; y: number }, margin = 0): boolean => p.x >= viewport.x - margin
    && p.y >= viewport.y - margin && p.x < viewport.x + viewport.width + margin
    && p.y < viewport.y + viewport.height + margin;
  result.originX = viewport.x; result.originY = viewport.y;
  result.width = viewport.width; result.height = viewport.height;
  result.tiles = [];
  for (let y = viewport.y; y < viewport.y + viewport.height; y++) {
    for (let x = viewport.x; x < viewport.x + viewport.width; x++) {
      const tile = state.tiles.get(`${x},${y}`) ?? backgroundTile?.(x, y, result.tick);
      if (tile) result.tiles.push(structuredClone(tile));
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

  readChunk(fromTick: number, count: number, viewport?: Viewport, backgroundTile?: TapeBackgroundTileFn): TapeChunkResponse {
    const empty: TapeChunkResponse = { fromTick, toTick: fromTick, minTick: 0, maxTick: 0, simHz: 0, hasMore: false, frames: [] };
    const db = this.open();
    if (!db) return empty;
    return this.transaction(db, () => {
      const saved = bounds(db);
      if (!saved.totalFrames) return empty;
      const hz = Number(db.prepare('SELECT sim_hz FROM tape_frames ORDER BY tick DESC LIMIT 1').get()!.sim_hz);
      const rows = db.prepare('SELECT tick,keyframe_tick,data FROM tape_frames WHERE tick>=? ORDER BY tick LIMIT ?')
        .all(Number.isFinite(fromTick) ? fromTick : saved.minTick, Math.min(240, positive(count, 1))) as FrameRow[];
      const frames: WorldView[] = [];
      let state: State | undefined;
      let anchor = -1;
      for (const row of rows) {
        if (!state || anchor !== row.keyframe_tick) {
          let nearest = -1;
          for (const [tick, value] of this.cache) {
            if (value.anchor === row.keyframe_tick && tick <= row.tick && tick > nearest) nearest = tick;
          }
          const cached = this.cache.get(nearest);
          state = reconstruct(db, row, cached ? structuredClone(cached.state) : undefined, cached ? nearest : undefined);
          if (cached) { this.cache.delete(nearest); this.cache.set(nearest, cached); }
          anchor = row.keyframe_tick;
        } else apply(state, row.data);
        frames.push(project(state, viewport, backgroundTile));
        if (row.tick === row.keyframe_tick || row === rows[rows.length - 1]) {
          this.cache.delete(row.tick);
          this.cache.set(row.tick, { anchor, state: structuredClone(state) });
          while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value!);
        }
      }
      return {
        fromTick: frames[0]?.tick ?? fromTick, toTick: frames.at(-1)?.tick ?? fromTick,
        minTick: saved.minTick, maxTick: saved.maxTick, simHz: hz,
        hasMore: !!frames.length && frames.at(-1)!.tick < saved.maxTick, frames,
      };
    });
  }

  close(): void {
    if (this.closed) return;
    this.db?.close(); this.db = undefined; this.cache.clear(); this.closed = true;
  }
}
