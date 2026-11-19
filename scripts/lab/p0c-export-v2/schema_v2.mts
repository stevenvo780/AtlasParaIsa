/** Export epoch only. Biological protocol and clocks remain unchanged. */
export const EXPORT_EPOCH = 'p0c-export-ledger-v2' as const;
export const DAY_SCHEMA = 'p0c-approach-dias-v2' as const;
export const TRIP_SCHEMA = 'p0c-viajes-v2' as const;
export const LEDGER_SCHEMA = 'p0c-export-ledger-v2' as const;
export const DAYS = 60;
export const TICKS_PER_DAY = 2400;
export type Kind = 'familia' | 'hogar';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export interface BoundaryState {
  stats: Record<string, number>;
  activeTrips: number;
  pendingTrips: number;
}
export interface BoundarySnapshot {
  world: JsonObject;
  demography: Json;
  legacy: JsonObject;
  census: JsonObject;
  coverage: JsonObject;
  observer: BoundaryState;
}
export interface ApproachDay {
  schema: typeof DAY_SCHEMA;
  epoch: typeof EXPORT_EPOCH;
  version: 2;
  day: number;
  ticksPerDay: number;
  stats: Record<string, number>;
  activeTrips: number;
  pendingTrips: number;
  denominators: Record<string, string>;
  protocol: object;
}
export interface SealedDay extends ApproachDay {
  sealed: true;
  boundaryTick: number;
  processedThroughTick: number;
  emittedAtTick: number;
  boundarySnapshot: BoundarySnapshot;
  boundarySnapshotSha256: string;
  processedActiveTrips: number;
  processedPendingTrips: number;
  finalized: boolean;
}
export interface LedgerEntry {
  schema: typeof LEDGER_SCHEMA;
  epoch: typeof EXPORT_EPOCH;
  day: number;
  boundaryTick: number;
  processedThroughTick: number;
  emittedAtTick: number;
  activeTripsAtBoundary: number;
  pendingTripsAtBoundary: number;
  sealed: true;
  finalized: boolean;
  boundarySnapshotSha256: string;
  rowSha256: string;
}
/** Temporal envelope of every raw trip; all original scientific fields survive. */
export interface TripTiming {
  schema: typeof TRIP_SCHEMA;
  epoch: typeof EXPORT_EPOCH;
  version: 2;
  id: number;
  kind: Kind;
  startTick: number;
  endTick: number | null;
  closedProcessingTick: number | null;
  maturedProcessingTick: number | null;
  emittedAtTick: number | null;
  closure: string | null;
  outcomeWindowEnd: number | null;
  censored: boolean;
  attributionCensored: boolean;
  censorTick: number | null;
  censorReason: string | null;
}
