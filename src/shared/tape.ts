/**
 * V21 — Shared contract for Uncapped Turbo Simulation, Recorded DVR Tape,
 * 60 fps Cinema Player, and Observer-Only Mode (server + client).
 */
import type { Tile, Viewport, WorldView } from './types.js';

/** Playback speeds supported by the 60 fps DVR Cinema Player (1x = 6 ticks/sec calm observation). */
export const TAPE_SPEEDS = [0.5, 1, 2, 5, 10, 25] as const;
export type TapeSpeed = (typeof TAPE_SPEEDS)[number];

/** Base ticks/sec at 1x speed (matches classic ~166 ms/tick observation rhythm smoothly interpolated at 60 fps). */
export const TAPE_BASE_TICKS_PER_SEC = 6;

/** Default number of ticks between full compressed keyframes in tape.sqlite. */
export const TAPE_KEYFRAME_INTERVAL = 60;

/** Default rolling frame retention cap in tape.sqlite (~21 simulated days of tick-by-tick history). */
export const TAPE_DEFAULT_MAX_FRAMES = 50_000;

/** Lightweight summary point for the DVR timeline scrubber and sparkline. */
export interface TapeTimelinePoint {
  tick: number;
  day: number;
  phase: WorldView['phase'];
  weather: WorldView['weather'];
  pop: number;
  births: number;
  deaths: number;
  structures: number;
  formulas: number;
  paved: number;
  simHz: number;
}

/** Response of GET /api/tape/meta. */
export interface TapeMetaResponse {
  enabled: boolean;
  observerOnly: boolean;
  turbo: boolean;
  minTick: number;
  maxTick: number;
  latestDay: number;
  totalFrames: number;
  keyframeInterval: number;
  simHz: number;
  keyframeTicks: number[];
  timeline: TapeTimelinePoint[];
}

/** Response of GET /api/tape/chunk?fromTick=T&count=N&x=..&y=..&width=..&height=.. */
export interface TapeChunkResponse {
  fromTick: number;
  toTick: number;
  minTick: number;
  maxTick: number;
  simHz: number;
  hasMore: boolean;
  frames: WorldView[];
}

/** Optional tile provider used by TapeReader to fill static/unmodified background tiles in a viewport. */
export type TapeBackgroundTileFn = (x: number, y: number, tick: number) => Tile;

/** Writer options for TapeWriter (sibling SQLite DB `tape.sqlite`). */
export interface TapeWriterOptions {
  /** Path to tape.sqlite (created if missing, WAL mode). */
  path: string;
  /** Ticks between full keyframes (default TAPE_KEYFRAME_INTERVAL = 60). */
  keyframeInterval?: number;
  /** Maximum retained frames in rolling ring (default TAPE_DEFAULT_MAX_FRAMES = 50_000). */
  maxFrames?: number;
  /** Frames buffered before flushing in a single SQLite transaction (default 25). */
  batchSize?: number;
  /** Max milliseconds before flushing pending frames (default 250). */
  flushIntervalMs?: number;
}

/** Reader options for TapeReader (read-only WAL connection on main gateway thread). */
export interface TapeReaderOptions {
  /** Path to tape.sqlite. */
  path: string;
  /** Observer-only flag exposed in meta. */
  observerOnly?: boolean;
  /** Turbo flag exposed in meta. */
  turbo?: boolean;
}

/** Shared writer contract implemented by src/server/tape-store.ts. */
export interface ITapeWriter {
  /** Record one projected world snapshot (already stripped of private fields).
   * Pass `partialTiles = true` when `view.tiles` contains only changed chunks so unchanged resident tiles are preserved. */
  record(view: WorldView, simHz: number, partialTiles?: boolean): void;
  /** Flush any buffered frames to SQLite synchronously in one transaction. */
  flush(): void;
  /** Total frames recorded in this DB (including buffered). */
  readonly frameCount: number;
  /** Highest recorded tick (-1 if empty). */
  readonly latestTick: number;
  /** Flush pending frames and close the SQLite handle cleanly. */
  close(): void;
}

/** Shared reader contract implemented by src/server/tape-store.ts. */
export interface ITapeReader {
  /** Read timeline metadata + downsampled sparkline points. */
  readMeta(maxTimelinePoints?: number): TapeMetaResponse;
  /**
   * Reconstruct up to `count` sequential frames starting at the first recorded tick >= `fromTick`,
   * clipped cleanly to `viewport` (using `backgroundTile` for static unmodified tiles).
   */
  readChunk(
    fromTick: number,
    count: number,
    viewport?: Viewport,
    backgroundTile?: TapeBackgroundTileFn,
  ): TapeChunkResponse;
  /** Close the read-only SQLite handle cleanly. */
  close(): void;
}
