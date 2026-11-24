/**
 * V21 — Tape store contract stub (replaced by full SQLite WAL + gzipped Keyframe/Delta implementation in v21-tape-store).
 * Exported class names and method signatures are frozen by src/shared/tape.ts.
 */
import type { Viewport, WorldView } from '../shared/types.js';
import {
  TAPE_DEFAULT_MAX_FRAMES,
  TAPE_KEYFRAME_INTERVAL,
  type ITapeReader,
  type ITapeWriter,
  type TapeBackgroundTileFn,
  type TapeChunkResponse,
  type TapeMetaResponse,
  type TapeReaderOptions,
  type TapeTimelinePoint,
  type TapeWriterOptions,
} from '../shared/tape.js';

const memoryStore = new Map<string, { frames: { view: WorldView; simHz: number }[]; keyframeInterval: number; maxFrames: number }>();

export function tapePathForWorld(worldPath: string): string {
  return worldPath.endsWith('.sqlite') ? `${worldPath.slice(0, -7)}.tape.sqlite` : `${worldPath}.tape.sqlite`;
}

export class TapeWriter implements ITapeWriter {
  private readonly bucket: { frames: { view: WorldView; simHz: number }[]; keyframeInterval: number; maxFrames: number };
  constructor(private readonly options: TapeWriterOptions) {
    let existing = memoryStore.get(options.path);
    if (!existing) {
      existing = {
        frames: [],
        keyframeInterval: Math.max(1, options.keyframeInterval ?? TAPE_KEYFRAME_INTERVAL),
        maxFrames: Math.max(2, options.maxFrames ?? TAPE_DEFAULT_MAX_FRAMES),
      };
      memoryStore.set(options.path, existing);
    }
    this.bucket = existing;
  }
  get frameCount(): number { return this.bucket.frames.length; }
  get latestTick(): number { return this.bucket.frames.length ? this.bucket.frames[this.bucket.frames.length - 1]!.view.tick : -1; }
  record(view: WorldView, simHz: number): void {
    const list = this.bucket.frames;
    if (list.length && list[list.length - 1]!.view.tick === view.tick) list[list.length - 1] = { view: structuredClone(view), simHz };
    else list.push({ view: structuredClone(view), simHz });
    while (list.length > this.bucket.maxFrames) list.shift();
  }
  flush(): void { /* implemented in SQLite WAL TapeWriter */ }
  close(): void { this.flush(); }
}

export class TapeReader implements ITapeReader {
  constructor(private readonly options: TapeReaderOptions) {}
  readMeta(maxTimelinePoints = 240): TapeMetaResponse {
    const bucket = memoryStore.get(this.options.path);
    const list = bucket?.frames ?? [];
    if (!list.length) {
      return {
        enabled: true, observerOnly: !!this.options.observerOnly, turbo: !!this.options.turbo,
        minTick: 0, maxTick: 0, latestDay: 1, totalFrames: 0,
        keyframeInterval: bucket?.keyframeInterval ?? TAPE_KEYFRAME_INTERVAL, simHz: 0,
        keyframeTicks: [], timeline: [],
      };
    }
    const stride = Math.max(1, Math.ceil(list.length / Math.max(1, maxTimelinePoints)));
    const timeline: TapeTimelinePoint[] = [];
    for (let i = 0; i < list.length; i += stride) {
      const { view, simHz } = list[i]!;
      timeline.push({
        tick: view.tick, day: view.day, phase: view.phase, weather: view.weather,
        pop: view.stats?.population ?? view.people.length,
        births: view.stats?.totals?.births ?? 0, deaths: view.demography?.deaths ?? 0,
        structures: view.structures?.length ?? 0,
        formulas: view.chemistry?.totalFormulas ?? (view.stats?.chemicalFormulas ?? 0),
        paved: view.stats?.pavedTiles ?? 0, simHz,
      });
    }
    const last = list[list.length - 1]!;
    return {
      enabled: true, observerOnly: !!this.options.observerOnly, turbo: !!this.options.turbo,
      minTick: list[0]!.view.tick, maxTick: last.view.tick, latestDay: last.view.day,
      totalFrames: list.length, keyframeInterval: bucket!.keyframeInterval, simHz: last.simHz,
      keyframeTicks: [list[0]!.view.tick], timeline,
    };
  }
  readChunk(fromTick: number, count: number, viewport?: Viewport, _backgroundTile?: TapeBackgroundTileFn): TapeChunkResponse {
    const bucket = memoryStore.get(this.options.path);
    const list = bucket?.frames ?? [];
    if (!list.length) {
      return { fromTick, toTick: fromTick, minTick: 0, maxTick: 0, simHz: 0, hasMore: false, frames: [] };
    }
    const startIdx = list.findIndex(entry => entry.view.tick >= fromTick);
    const safeCount = Math.max(1, Math.min(240, Math.floor(count)));
    const slice = startIdx < 0 ? [] : list.slice(startIdx, startIdx + safeCount);
    const frames = slice.map(({ view }) => {
      if (!viewport) return structuredClone(view);
      const visible = (p: { x: number; y: number }, m = 0) => p.x >= viewport.x - m && p.y >= viewport.y - m
        && p.x < viewport.x + viewport.width + m && p.y < viewport.y + viewport.height + m;
      return {
        ...structuredClone(view),
        originX: viewport.x, originY: viewport.y, width: viewport.width, height: viewport.height,
        tiles: view.tiles.filter(t => visible(t)),
        people: view.people.filter(p => visible(p, 1)),
        animals: view.animals?.filter(a => visible(a)),
        structures: view.structures?.filter(s => visible(s, 1)),
        places: view.places.filter(p => visible(p)),
      };
    });
    const last = list[list.length - 1]!;
    return {
      fromTick: frames[0]?.tick ?? fromTick,
      toTick: frames[frames.length - 1]?.tick ?? fromTick,
      minTick: list[0]!.view.tick,
      maxTick: last.view.tick,
      simHz: last.simHz,
      hasMore: startIdx >= 0 && startIdx + slice.length < list.length,
      frames,
    };
  }
  close(): void { /* no-op for stub */ }
}
