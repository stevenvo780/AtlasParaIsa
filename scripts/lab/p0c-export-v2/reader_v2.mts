import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256Json } from './export-ledger_v2.mts';
import { DAYS, DAY_SCHEMA, EXPORT_EPOCH, LEDGER_SCHEMA, TRIP_SCHEMA, TICKS_PER_DAY,
  type Kind, type LedgerEntry, type SealedDay, type TripTiming } from './schema_v2.mts';

const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const kinds: readonly Kind[] = ['familia', 'hogar'];
const legacyKeys = ['dia', 'n', 'pob', 'oficios', 'oficiosSinApproach', 'dom', 'fracApproachDominante', 'approachPorMotivo',
  'ticksPorContexto', 'sharingMedia', 'distCulturalGrupos', 'gruposG3', 'jovenes', 'sigmaHabilidad'];

/** No legacy adapter, implicit metadata, absent-counter fallback or scientific verdict. */
export class EpochReader {
  private closed = Array.from({ length: DAYS }, () => ({ familia: 0, hogar: 0 }));
  private matured = Array.from({ length: DAYS }, () => ({ familia: 0, hogar: 0 }));
  private ids = new Set<number>();
  private readonly days: SealedDay[];
  constructor(days: unknown[], ledger: unknown[], readonly ticksPerDay = TICKS_PER_DAY) {
    assert.ok(integer(ticksPerDay) && ticksPerDay > 0, 'Invalid epoch clock');
    assert.equal(days.length, DAYS, 'Exactly 60 day rows required');
    assert.equal(ledger.length, DAYS, 'Exactly 60 ledger entries required');
    // Own the validated rows so callers cannot mutate a seal after validation.
    this.days = JSON.parse(JSON.stringify(days));
    const seenDays = new Set<number>(), seenLedger = new Set<number>();
    for (let i = 0; i < DAYS; i++) {
      const row: any = this.days[i], entry: any = ledger[i], day = i + 1, boundary = day * ticksPerDay;
      const processed = boundary + (day === DAYS ? 0 : 1);
      assert.ok(object(row) && object(entry), 'Day/ledger objects required');
      assert.equal(row.schema, DAY_SCHEMA); assert.equal(row.epoch, EXPORT_EPOCH); assert.equal(row.version, 2);
      assert.equal(entry.schema, LEDGER_SCHEMA); assert.equal(entry.epoch, EXPORT_EPOCH);
      assert.equal(row.day, day, 'Day rows must be ordered'); assert.equal(entry.day, day, 'Ledger must be ordered');
      assert.ok(!seenDays.has(row.day) && !seenLedger.has(entry.day), 'Duplicate day or ledger seal');
      seenDays.add(row.day); seenLedger.add(entry.day);
      assert.equal(row.ticksPerDay, ticksPerDay);
      for (const item of [row, entry]) {
        assert.equal(item.sealed, true, 'Missing seal'); assert.equal(item.boundaryTick, boundary);
        assert.equal(item.processedThroughTick, processed); assert.equal(item.emittedAtTick, processed);
        assert.equal(item.finalized, day === DAYS);
        assert.ok(digest(item.boundarySnapshotSha256), 'Boundary digest missing');
      }
      assert.ok(object(row.stats) && object(row.boundarySnapshot), 'Stats and boundary snapshot required');
      const snap = row.boundarySnapshot;
      for (const key of ['world', 'legacy', 'census', 'coverage', 'observer']) assert.ok(object(snap[key]), `Missing boundary ${key}`);
      assert.ok(Object.hasOwn(snap, 'demography') && object(snap.demography), 'Missing boundary demography');
      assert.ok(Array.isArray(snap.world.people), 'Boundary people required');
      assert.deepEqual(snap.demography, { dynamics: snap.world.demographyDynamics,
        people: snap.world.people.map((p: { id: string; demography: unknown }) => ({ id: p.id, demography: p.demography })) });
      assert.equal(snap.world.tick, boundary); assert.equal(snap.census.tick, boundary); assert.equal(snap.census.day, day);
      assert.equal(snap.legacy.dia, day); assert.deepEqual(Object.keys(snap.legacy), legacyKeys, 'Legacy14 identity/order');
      assert.equal(snap.coverage.day, day); assert.equal(snap.coverage.throughTickInclusive, boundary);
      assert.equal(snap.coverage.fromTickExclusive, boundary - ticksPerDay);
      assert.equal(snap.coverage.observedTicks, ticksPerDay); assert.equal(snap.coverage.complete, true);
      assert.ok(integer(snap.observer.activeTrips) && integer(snap.observer.pendingTrips) && object(snap.observer.stats));
      assert.equal(row.activeTrips, snap.observer.activeTrips); assert.equal(row.pendingTrips, snap.observer.pendingTrips);
      assert.equal(entry.activeTripsAtBoundary, snap.observer.activeTrips);
      assert.equal(entry.pendingTripsAtBoundary, snap.observer.pendingTrips);
      assert.ok(integer(row.processedActiveTrips) && integer(row.processedPendingTrips));
      if (day === DAYS) { assert.equal(row.processedActiveTrips, 0); assert.equal(row.processedPendingTrips, 0); }
      for (const [key, value] of Object.entries(row.stats)) assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0, `Invalid stat ${key}`);
      for (const kind of kinds) for (const counter of ['closed', 'matured']) {
        assert.ok(integer(row.stats[`${kind}.${counter}`]), 'Required counter absent/invalid');
        assert.ok(integer(snap.observer.stats[`${kind}.${counter}`]), 'Required boundary counter absent/invalid');
      }
      assert.equal(row.boundarySnapshotSha256, sha256Json(snap), 'Boundary snapshot drift');
      assert.equal(entry.boundarySnapshotSha256, row.boundarySnapshotSha256);
      assert.ok(digest(entry.rowSha256)); assert.equal(entry.rowSha256, sha256Json(row), 'Sealed row drift');
    }
  }
  observeTrip(value: unknown): void {
    assert.ok(object(value), 'Raw trip object required');
    const t = value as unknown as TripTiming;
    assert.equal(t.schema, TRIP_SCHEMA, 'Old raw epoch rejected'); assert.equal(t.epoch, EXPORT_EPOCH); assert.equal(t.version, 2);
    assert.ok(integer(t.id) && t.id > 0 && !this.ids.has(t.id), 'Duplicate/invalid raw trip ID'); this.ids.add(t.id);
    assert.ok(kinds.includes(t.kind));
    assert.ok(integer(t.startTick) && t.startTick > 0 && integer(t.endTick) && t.endTick >= t.startTick - 1);
    assert.ok(integer(t.closedProcessingTick) && integer(t.maturedProcessingTick) && integer(t.emittedAtTick), 'Missing processing metadata');
    assert.ok(t.closedProcessingTick >= t.endTick && t.closedProcessingTick <= t.endTick + 1);
    assert.ok(t.maturedProcessingTick >= t.closedProcessingTick && t.emittedAtTick >= t.maturedProcessingTick);
    assert.ok(t.emittedAtTick <= DAYS * this.ticksPerDay && t.startTick <= DAYS * this.ticksPerDay);
    assert.equal(t.outcomeWindowEnd, t.endTick + 30, 'Scientific outcome window changed');
    assert.ok(typeof t.closure === 'string' && t.closure.length > 0);
    assert.equal(typeof t.censored, 'boolean'); assert.equal(typeof t.attributionCensored, 'boolean');
    if (t.censored) {
      assert.ok(integer(t.censorTick) && t.censorTick <= t.maturedProcessingTick && typeof t.censorReason === 'string');
    } else {
      assert.equal(t.censorTick, null); assert.equal(t.censorReason, null); assert.equal(t.attributionCensored, false);
    }
    if (t.maturedProcessingTick < t.outcomeWindowEnd) {
      assert.equal(t.maturedProcessingTick, DAYS * this.ticksPerDay);
      assert.equal(t.censored, true); assert.equal(t.attributionCensored, true);
    }
    const closeDay = Math.max(1, Math.ceil(t.endTick / this.ticksPerDay));
    const matureDay = Math.max(1, Math.ceil(t.maturedProcessingTick / this.ticksPerDay));
    assert.ok(closeDay <= DAYS && matureDay <= DAYS);
    assert.ok(t.closedProcessingTick <= this.days[closeDay - 1]!.processedThroughTick, 'Raw closure processed after day seal');
    this.closed[closeDay - 1]![t.kind]++; this.matured[matureDay - 1]![t.kind]++;
  }
  complete() {
    for (let i = 0; i < DAYS; i++) for (const kind of kinds) {
      assert.equal(this.closed[i]![kind], this.days[i]!.stats[`${kind}.closed`], `raw.closed !== daily.closed: day${i + 1} ${kind}`);
      assert.equal(this.matured[i]![kind], this.days[i]!.stats[`${kind}.matured`], `raw.matured !== daily.matured: day${i + 1} ${kind}`);
    }
    return { epoch: EXPORT_EPOCH, days: DAYS, rawTrips: this.ids.size, reconciled: true,
      scientificGateEvidence: false, historical72Attribution: 'UNKNOWN' as const };
  }
}

async function* jsonLines(path: string) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let line = 0;
  try {
    for await (const text of lines) {
      line++; assert.ok(text.trim(), `Blank JSONL row ${path}:${line}`);
      yield JSON.parse(text);
    }
  } finally { lines.close(); }
}
export async function readEpochFiles(daysPath: string, ledgerPath: string, tripsPath: string) {
  const days: unknown[] = [], ledger: unknown[] = [];
  for await (const row of jsonLines(daysPath)) { assert.ok(days.length < DAYS, 'Too many day rows'); days.push(row); }
  for await (const row of jsonLines(ledgerPath)) { assert.ok(ledger.length < DAYS, 'Too many ledger rows'); ledger.push(row); }
  const reader = new EpochReader(days, ledger);
  for await (const row of jsonLines(tripsPath)) reader.observeTrip(row);
  return reader.complete();
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv.length, 5, 'reader_v2.mts DAYS.jsonl LEDGER.jsonl TRIPS.jsonl');
  console.log(JSON.stringify(await readEpochFiles(process.argv[2]!, process.argv[3]!, process.argv[4]!)));
}
