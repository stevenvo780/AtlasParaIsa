/**
 * V21 — Shared contract for Uncapped Turbo Simulation, Recorded DVR Tape,
 * 60 fps Cinema Player, and Observer-Only Mode (server + client).
 */
import type { WorldView } from './types.js';
import type { TapeChunkEncoding, TapeClientDelta } from './tape-delta.js';
export type { TapeClientDelta } from './tape-delta.js';
export { applyClientTapeDelta, indexTiles } from './tape-delta.js';

/** Playback speeds supported by the 60 fps DVR Cinema Player (1x = 6 ticks/sec calm observation). */
export const TAPE_SPEEDS = [0.5, 1, 2, 5, 10, 25] as const;
export type TapeSpeed = (typeof TAPE_SPEEDS)[number];

/** Base ticks/sec at 1x speed (matches classic ~166 ms/tick observation rhythm smoothly interpolated at 60 fps). */
export const TAPE_BASE_TICKS_PER_SEC = 6;

/** Default number of ticks between full compressed keyframes in tape.sqlite. */
export const TAPE_KEYFRAME_INTERVAL = 60;

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

/** Response of GET /api/tape/chunk?fromTick=T&count=N&x=..&y=..&width=..&height=..[&encoding=full|delta] */
export interface TapeChunkResponse {
  fromTick: number;
  toTick: number;
  minTick: number;
  maxTick: number;
  simHz: number;
  hasMore: boolean;
  /** V22: `'full'` (default) populates `frames`; `'delta'` populates `baseFrame` + `deltas` (50x smaller). */
  encoding?: TapeChunkEncoding;
  frames: WorldView[];
  baseFrame?: WorldView;
  deltas?: TapeClientDelta[];
}
