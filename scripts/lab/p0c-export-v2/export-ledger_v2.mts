import { createHash } from 'node:crypto';
import type { ApproachObserver, WorldLike } from './approach-observer_v2.mts';
import { DAYS, EXPORT_EPOCH, LEDGER_SCHEMA, TICKS_PER_DAY,
  type BoundarySnapshot, type Json, type JsonObject, type LedgerEntry, type SealedDay } from './schema_v2.mts';

export const sha256Json = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Serialize at N, never retain references into the live World or its daily accumulators. */
export function jsonSnapshot<T>(value: T): T {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('Missing boundary snapshot');
  return JSON.parse(text) as T;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export interface BoundaryInput {
  world: WorldLike;
  demography: unknown;
  legacy: unknown;
  census: unknown;
  coverage: unknown;
}

/** The production runner and fixtures share this one export scheduler. */
export class ExportLedger {
  private pending: { day: number; boundaryTick: number; snapshot: BoundarySnapshot } | null = null;
  private entries: LedgerEntry[] = [];
  constructor(private readonly observer: ApproachObserver, readonly ticksPerDay = TICKS_PER_DAY) {
    if (ticksPerDay !== observer.ticksPerDay) throw new Error('Observer/ledger clock mismatch');
  }
  captureBoundary(input: BoundaryInput): void {
    const day = input.world.tick / this.ticksPerDay;
    if (!Number.isSafeInteger(day) || day < 1 || day > DAYS || this.pending || day !== this.entries.length + 1)
      throw new Error('Missing, duplicate or unordered boundary capture');
    const snapshot = jsonSnapshot<BoundarySnapshot>({
      world: input.world as unknown as JsonObject, demography: input.demography as Json,
      legacy: input.legacy as JsonObject, census: input.census as JsonObject, coverage: input.coverage as JsonObject,
      observer: this.observer.boundaryState(day),
    });
    this.pending = { day, boundaryTick: input.world.tick, snapshot: freeze(snapshot) };
  }
  /** Invoke only after the actual approach.endTick. Day60 requires finish first. */
  emitAfterProcessing(processedTick: number, final = false): { row: SealedDay; ledger: LedgerEntry } | null {
    if (!this.pending) {
      if (final) throw new Error('Missing final boundary');
      return null;
    }
    const { day, boundaryTick, snapshot } = this.pending;
    const dueTick = boundaryTick + (day === DAYS ? 0 : 1);
    if (processedTick < dueTick && !final) return null;
    if (processedTick !== dueTick || final !== (day === DAYS)) throw new Error('Export processing clock/finalization mismatch');
    // sealDay verifies the observer actually processed the supplied tick, and rejects resealing.
    this.observer.sealDay(day, final);
    const processed = this.observer.exportDay(day);
    const row: SealedDay = freeze({ ...processed, sealed: true, boundaryTick,
      processedThroughTick: processedTick, emittedAtTick: processedTick, finalized: final,
      activeTrips: snapshot.observer.activeTrips, pendingTrips: snapshot.observer.pendingTrips,
      processedActiveTrips: processed.activeTrips, processedPendingTrips: processed.pendingTrips,
      boundarySnapshot: snapshot, boundarySnapshotSha256: sha256Json(snapshot),
    });
    const ledger: LedgerEntry = freeze({ schema: LEDGER_SCHEMA, epoch: EXPORT_EPOCH, day, boundaryTick,
      processedThroughTick: processedTick, emittedAtTick: processedTick,
      activeTripsAtBoundary: snapshot.observer.activeTrips, pendingTripsAtBoundary: snapshot.observer.pendingTrips,
      sealed: true, finalized: final,
      boundarySnapshotSha256: row.boundarySnapshotSha256, rowSha256: sha256Json(row),
    });
    this.entries.push(ledger); this.pending = null;
    return { row, ledger };
  }
  complete(): readonly LedgerEntry[] {
    if (this.pending || this.entries.length !== DAYS) throw new Error('Export ledger requires exactly 60 sealed days');
    return Object.freeze([...this.entries]);
  }
}
