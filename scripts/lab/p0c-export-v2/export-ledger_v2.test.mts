/** TEST_FIXTURE only: no World import, model, RNG, C8 evaluator or historical raw. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { attachApproachObserver, captureApproachDecision, createApproachObserver } from './approach-observer_v2.mts';
import { ExportLedger, jsonSnapshot, sha256Json } from './export-ledger_v2.mts';
import { EpochReader } from './reader_v2.mts';
import { createLegacyProbe, LEGACY_KEYS } from './sonda_v2.mts';
import { DAYS, type LedgerEntry, type SealedDay, type TripTiming } from './schema_v2.mts';

function person(id: string) {
  return { id, role: 'neighbor', action: 'rest', reason: '', x: 0, y: 0,
    decisionAt: 0, target: { x: 0, y: 0 }, communityId: 'g', inventory: 0.2,
    hunger: 0.4, thirst: 0.2, fatigue: 0.2, energy: 0.6,
    genome: { parents: [] as string[] }, bonds: {} as Record<string, number>,
    bornAt: 0, intentContext: 'ready', culture: { sharing: 0.4, stewardship: 0.2, openness: 0.3 },
    skills: {}, demography: { age: 0, health: 1 } };
}
function scenario(closeTick = 3, finalActive = false, ticksPerDay = 2) {
  const a = person('family'), b = person('partner'), h = person('home');
  const world = { tick: 0, people: [a, b, h], places: [{ id: 'p', x: 0, y: 0 }],
    demographyDynamics: { deaths: 0 }, legacy: [{ marker: 'boundary' }],
    nested: { tickMarker: 0, arrays: [[0, 1]] } };
  const observer = createApproachObserver({ ticksPerDay }); attachApproachObserver(world, observer);
  const legacy = createLegacyProbe(world, ticksPerDay), scheduler = new ExportLedger(observer, ticksPerDay);
  const rows: SealedDay[] = [], ledger: LedgerEntry[] = [], trips: TripTiming[] = [];
  const snapshots: unknown[] = [], legacyRows: unknown[] = [], boundaryStats: Record<string, number>[] = [];
  let oldEarly: unknown, finishCalls = 0;
  const emit = (result: ReturnType<typeof scheduler.emitAfterProcessing>) => {
    if (result) { rows.push(result.row); ledger.push(result.ledger); }
  };
  function decide(p: ReturnType<typeof person>, action: string, family: boolean) {
    p.action = action; p.reason = action !== 'approach' ? 'rest' : family ? 'Tiene reservas synthetic' : 'Vuelve a un lugar conocido synthetic';
    p.decisionAt = world.tick + 30;
    captureApproachDecision(world, p, { ...(family && action === 'approach' ? { partner: b } : {}), placeId: 'p' });
  }
  for (let tick = 1; tick <= DAYS * ticksPerDay; tick++) {
    observer.beginTick(world); world.tick = tick;
    world.demographyDynamics.deaths = tick; world.nested.tickMarker = tick;
    for (const p of world.people) p.demography.age = tick;
    const start = finalActive ? DAYS * ticksPerDay - 1 : 1;
    if (tick === start) { decide(a, 'approach', true); decide(h, 'approach', false); }
    if (!finalActive && tick === closeTick) { decide(a, 'rest', true); decide(h, 'rest', false); }
    observer.endTick(world); emit(scheduler.emitAfterProcessing(tick));
    trips.push(...observer.exportTrips()); legacy.record(world);
    if (tick % ticksPerDay === 0) {
      const day = tick / ticksPerDay, row = legacy.closeDay(world);
      legacyRows.push(jsonSnapshot(row)); snapshots.push(jsonSnapshot(world));
      boundaryStats.push(observer.boundaryState(day).stats);
      scheduler.captureBoundary({ world, demography: { dynamics: world.demographyDynamics,
        people: world.people.map(p => ({ id: p.id, demography: p.demography })) }, legacy: row,
        census: { day, tick, mortalCount: world.people.length },
        coverage: { day, fromTickExclusive: tick - ticksPerDay, throughTickInclusive: tick,
          observedTicks: ticksPerDay, complete: true } });
      if (day === 1) oldEarly = jsonSnapshot(observer.exportDay(1));
      if (day === DAYS) {
        observer.finish(world); finishCalls++; trips.push(...observer.exportTrips());
        emit(scheduler.emitAfterProcessing(tick, true));
      }
    }
  }
  assert.equal(scheduler.complete().length, DAYS);
  return { rows, ledger, trips, world, observer, scheduler, snapshots, legacyRows, boundaryStats, oldEarly, finishCalls };
}
function read(f: ReturnType<typeof scenario>) {
  const reader = new EpochReader(f.rows, f.ledger, f.observer.ticksPerDay);
  for (const trip of f.trips) reader.observeTrip(trip);
  return reader.complete();
}

test('family and home cross N to processing N+1; raw closure reconciles exactly per day and kind', () => {
  const f = scenario();
  assert.equal(f.rows.length, 60); assert.equal(f.ledger.length, 60); assert.equal(f.trips.length, 2);
  for (const kind of ['familia', 'hogar']) {
    const trip = f.trips.find(t => t.kind === kind)!;
    assert.equal(trip.endTick, 2); assert.equal(trip.closedProcessingTick, 3);
    assert.equal(trip.maturedProcessingTick, 32); assert.equal(trip.emittedAtTick, 32);
    assert.equal(f.rows[0]!.stats[`${kind}.closed`], 1);
    assert.equal(f.rows[0]!.boundarySnapshot.observer.stats[`${kind}.closed`], 0);
  }
  assert.equal(f.rows[0]!.boundaryTick, 2); assert.equal(f.rows[0]!.processedThroughTick, 3);
  assert.equal(f.rows[0]!.activeTrips, 2); assert.equal(f.rows[0]!.pendingTrips, 0);
  assert.equal(f.rows[0]!.processedActiveTrips, 0); assert.equal(f.rows[0]!.processedPendingTrips, 2);
  assert.deepEqual(read(f), { epoch: 'p0c-export-ledger-v2', days: 60, rawTrips: 2,
    reconciled: true, scientificGateEvidence: false, historical72Attribution: 'UNKNOWN' });
});
test('real export clock remains 2400; one synthetic cross-boundary close and all 60 rows', () => {
  const f = scenario(2401, false, 2400);
  for (const trip of f.trips) { assert.equal(trip.endTick, 2400); assert.equal(trip.closedProcessingTick, 2401); }
  assert.equal(f.rows[0]!.boundaryTick, 2400); assert.equal(f.rows[0]!.emittedAtTick, 2401);
  assert.equal(f.rows[59]!.emittedAtTick, 144000); assert.equal(read(f).reconciled, true);
});
test('all boundary world fields, demography, exact legacy14 and active/pending stay at N', () => {
  const f = scenario();
  for (let i = 0; i < DAYS; i++) {
    const row = f.rows[i]!;
    assert.deepEqual(row.boundarySnapshot.world, f.snapshots[i]);
    assert.deepEqual(row.boundarySnapshot.legacy, f.legacyRows[i]);
    assert.deepEqual(Object.keys(row.boundarySnapshot.legacy), [...LEGACY_KEYS]);
    assert.deepEqual(row.boundarySnapshot.observer.stats, f.boundaryStats[i]);
    assert.equal(row.boundarySnapshotSha256, sha256Json(row.boundarySnapshot));
    assert.equal(f.ledger[i]!.rowSha256, sha256Json(row));
  }
  assert.equal(f.rows[0]!.boundarySnapshot.world.tick, 2);
  assert.equal(f.world.tick, 120);
  assert.throws(() => { (f.rows[0]!.boundarySnapshot.world.nested as { tickMarker: number }).tickMarker = 999; });
  assert.equal(read(f).reconciled, true);
});
test('postseal increment and reseal are rejected without changing exported bytes', () => {
  const f = scenario(), before = sha256Json(f.rows);
  const count = Reflect.get(f.observer, 'count');
  assert.equal(typeof count, 'function');
  const statsBefore = sha256Json(f.observer.exportDay(1));
  assert.throws(() => Reflect.apply(count, f.observer, [2, 'familia.closed', 1]), /sealed/);
  assert.equal(sha256Json(f.observer.exportDay(1)), statsBefore);
  assert.throws(() => f.observer.assertCountWritable(2), /sealed/);
  assert.throws(() => f.observer.sealDay(1, false), /seal/);
  assert.equal(sha256Json(f.rows), before);
});
test('old immediate export and missing processing metadata are rejected, never repaired', () => {
  const f = scenario();
  assert.equal((f.oldEarly as { stats: Record<string, number> }).stats['familia.closed'], 0);
  assert.throws(() => new EpochReader([f.oldEarly, ...f.rows.slice(1)], f.ledger, 2));
  const legacyRawReader = new EpochReader(f.rows, f.ledger, 2);
  assert.throws(() => legacyRawReader.observeTrip({ ...f.trips[0], schema: 'p0c-viajes-v1' }), /Old raw epoch/);
  const r = new EpochReader(f.rows, f.ledger, 2), old = { ...f.trips[0] };
  delete old.closedProcessingTick;
  assert.throws(() => r.observeTrip(old), /processing metadata/);
  const missed = jsonSnapshot(f.rows); missed[0]!.stats['familia.closed'] = 0;
  const matchingHash = jsonSnapshot(f.ledger); matchingHash[0]!.rowSha256 = sha256Json(missed[0]);
  const bad = new EpochReader(missed, matchingHash, 2);
  for (const t of f.trips) bad.observeTrip(t);
  assert.throws(() => bad.complete(), /raw.closed !== daily.closed/);
});
test('noncrossing closure keeps its original bucket and counters', () => {
  const f = scenario(2);
  for (const t of f.trips) { assert.equal(t.endTick, 1); assert.equal(t.closedProcessingTick, 2); }
  for (const kind of ['familia', 'hogar']) {
    assert.equal(f.rows[0]!.stats[`${kind}.closed`], 1);
    assert.equal(f.rows[0]!.boundarySnapshot.observer.stats[`${kind}.closed`], 1);
  }
  assert.equal(read(f).reconciled, true);
});
test('finish precedes unique day60 export; boundary active differs from finalized zero', () => {
  const f = scenario(0, true), last = f.rows[59]!;
  assert.equal(f.finishCalls, 1); assert.equal(last.finalized, true);
  assert.equal(last.boundaryTick, 120); assert.equal(last.emittedAtTick, 120);
  assert.equal(last.activeTrips, 2); assert.equal(last.processedActiveTrips, 0); assert.equal(last.processedPendingTrips, 0);
  assert.equal(f.ledger.filter(e => e.day === 60).length, 1);
  for (const t of f.trips) {
    assert.equal(t.closedProcessingTick, 120); assert.equal(t.maturedProcessingTick, 120); assert.equal(t.emittedAtTick, 120);
    assert.equal(t.censored, true); assert.equal(t.attributionCensored, true);
  }
  assert.equal(read(f).reconciled, true);
});
test('reader rejects missing/duplicate seal, wrong clock, snapshot and row drift', () => {
  const f = scenario();
  assert.throws(() => new EpochReader(f.rows.slice(1), f.ledger, 2));
  assert.throws(() => new EpochReader([f.rows[0], f.rows[0], ...f.rows.slice(2)], f.ledger, 2));
  for (const mutation of [
    (r: SealedDay) => { r.sealed = false as true; },
    (r: SealedDay) => { r.processedThroughTick = 2; },
    (r: SealedDay) => { r.boundarySnapshot.census.tick = 3; },
    (r: SealedDay) => { r.stats['familia.closed'] = 99; },
  ]) {
    const rows = jsonSnapshot(f.rows); mutation(rows[0]!);
    assert.throws(() => new EpochReader(rows, f.ledger, 2));
  }
});
