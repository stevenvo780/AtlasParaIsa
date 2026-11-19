import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  beginObservationAttempt, bindObservation, coverageStatus, createObservationSession,
  drainObservation, emitObserved, endObservationAttempt, enterObservationPhase, markObservationAttempt,
  observedEvents, unbindObservation,
} from '../src/world/observation.js';

// Manual oracle: a disabled world never evaluates the payload factory.
test('observer off leaves the source untouched and creates no event', () => {
  const world = {};
  let called = 0;
  emitObserved(world, 'manual.off', () => { called++; return { actorId: 'n-1' }; });
  assert.equal(called, 0);
});

test('copies and freezes a source receipt without freezing motor objects', () => {
  const world = {};
  const source = { actorId: 'n-1', amounts: [1, 2], nested: { value: 3 } };
  const session = createObservationSession({ runId: 'r', epochId: 'e', sourceSHA: 'a'.repeat(40) });
  bindObservation(world, session);
  const attemptId = beginObservationAttempt(world, 7);
  enterObservationPhase(world, 'technology');
  emitObserved(world, 'technology.payment', () => source);
  source.amounts[0] = 99;
  source.nested.value = 10;
  const events = observedEvents(session);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.attemptId, attemptId);
  assert.deepEqual(events[0]?.payload, { actorId: 'n-1', amounts: [1, 2], nested: { value: 3 } });
  assert.throws(() => { (events[0]!.payload as { nested: { value: number } }).nested.value = 5; });
  source.nested.value = 11;
  assert.equal(coverageStatus(session).quality, 'COMPLETE');
  unbindObservation(world);
});

test('same physical tick after rollback keeps separate attempt identities and history', () => {
  const world = {};
  const session = createObservationSession({ runId: 'r', epochId: 'e', sourceSHA: 'b'.repeat(40) });
  bindObservation(world, session);
  const first = beginObservationAttempt(world, 8);
  markObservationAttempt(world, 'discarded');
  const second = beginObservationAttempt(world, 8);
  markObservationAttempt(world, 'durable', 'commit-8');
  markObservationAttempt(world, 'adopted');
  assert.notEqual(first, second);
  assert.deepEqual(session.attemptHistory.get(first)?.map(x => x.state), ['started', 'discarded']);
  assert.deepEqual(session.attemptHistory.get(second)?.map(x => x.state), ['started', 'durable', 'adopted']);
  unbindObservation(world);
});

test('discarded and restored attempts remain diagnostic source, never canonical adopted effects', () => {
  const world = {};
  const session = createObservationSession({ runId: 'rollback', epochId: 'e', sourceSHA: '5'.repeat(40) });
  bindObservation(world, session);
  beginObservationAttempt(world, 8);
  emitObserved(world, 'manual.service', () => ({ family: 'service', payload: {
    subjectId: 'roof', eventType: 'shelter-recovery' } }));
  markObservationAttempt(world, 'restored');
  beginObservationAttempt(world, 8);
  emitObserved(world, 'manual.service', () => ({ family: 'service', payload: {
    subjectId: 'roof', eventType: 'shelter-recovery' } }));
  markObservationAttempt(world, 'adopted');
  const projected = projectObservedEvents(observedEvents(session), { gaps: coverageStatus(session).gaps, attemptHistory: session.attemptHistory });
  assert.equal(projected.sourceEvents.length, 2);
  assert.equal(projected.records.length, 1);
  assert.ok(projected.modelGaps.some(gap => gap.endsWith(':unadopted-or-rolled-back')));
  unbindObservation(world);
});

test('callback failure and bounded queue overflow degrade coverage without throwing into the world', async () => {
  const world = {};
  const session = createObservationSession({ runId: 'r', epochId: 'e', sourceSHA: 'c'.repeat(40), capacity: 1 });
  bindObservation(world, session);
  beginObservationAttempt(world, 1);
  emitObserved(world, 'one', () => ({ value: 1 }));
  emitObserved(world, 'two', () => ({ value: 2 }));
  assert.equal(coverageStatus(session).quality, 'PARTIAL');
  assert.equal(coverageStatus(session).lostEvents, 1);
  await drainObservation(session, async () => { throw new Error('sink failed'); });
  assert.equal(coverageStatus(session).quality, 'PARTIAL');
  assert.ok(coverageStatus(session).lostGaps > 0); // bounded diagnostic queue still reports the callback loss
  unbindObservation(world);
});

test('failed payload copy creates UNKNOWN coverage, never an invented zero effect', () => {
  const world = {};
  const session = createObservationSession({ runId: 'r', epochId: 'e', sourceSHA: 'd'.repeat(40) });
  bindObservation(world, session);
  beginObservationAttempt(world, 1);
  emitObserved(world, 'bad', () => ({ impossible: () => 1 }));
  assert.equal(observedEvents(session).length, 0);
  assert.equal(coverageStatus(session).quality, 'PARTIAL');
  assert.ok(coverageStatus(session).gaps.some(g => g.reason === 'serialization-failed'));
  unbindObservation(world);
});

import { projectObservedEvents } from '../scripts/lab/realismo-observer.js';
import { EVIDENCE_KINDS, FAMILIES } from '../scripts/lab/realismo-contract.js';
import { createWorld, stepWorld } from '../src/world/index.js';
import { parseParams } from '../src/world/params.js';
import { demographicTraits, initialDemography } from '../src/world/demography.js';
import { invent, MAX_BLUEPRINTS, stepStructures } from '../src/world/inventions.js';
import { INTERVALO_ECOLOGIA_TICKS } from '../src/world/ecologia-constantes.js';
import { activate, maintainRegions } from '../src/world/spatial.js';
import { advancePopulation } from '../src/world/lineage.js';
import { recordTechnologyBenefit, researchTechnology, settleTechnologyEstate, transferTechnologyItem, useTool } from '../src/world/technology.js';
import { PROGRAMA_FILO, proyectoInvestigacion } from './lib/escenas.js';
import { makeRealismoSourceManifest } from '../scripts/lab/instrumentos.js';
import { Store } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { freePort } from './lib/net.js';
import { InstrumentosRealismo } from '../scripts/lab/instrumentos.js';

test('same base HEAD with one changed hook byte receives a different verified source identity', () => {
  const runtime = { node: 'v-test', v8: 'test', modules: 'test', platform: 'linux', arch: 'x64' };
  const baseCommit = 'b'.repeat(40);
  const before = makeRealismoSourceManifest({ baseCommit, runtime,
    files: [{ path: 'src/world/index.ts', sha256: 'a'.repeat(64) }] });
  const after = makeRealismoSourceManifest({ baseCommit, runtime,
    files: [{ path: 'src/world/index.ts', sha256: 'c'.repeat(64) }] });
  assert.equal(before.baseCommit, after.baseCommit);
  assert.notEqual(before.sourceSHA, after.sourceSHA);
  assert.notEqual(before.sourceTreeDigest, after.sourceTreeDigest);
  assert.match(after.sourceSHA, /^[a-f0-9]{40}$/);
});

async function syntheticViewTick(app: ReturnType<typeof createApp>, origin: string, password: string): Promise<{ tick: number; paused: boolean }> {
  if (!app.server.listening) { app.server.listen(Number(new URL(origin).port), '127.0.0.1'); await once(app.server, 'listening'); }
  const login = await fetch(origin + '/api/login', { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const response = await fetch(origin + '/api/world', { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  return await response.json() as { tick: number; paused: boolean };
}

for (const fault of ['clock-after-save', 'store-after-commit'] as const)
for (const observerOn of [false, true] as const) test(`app keeps resident/view/store coherent on ${fault} observer=${observerOn}`, async () => {
  const store = new Store(':memory:');
  const session = createObservationSession({ runId: `commit-${fault}`, epochId: 'e', sourceSHA: '8'.repeat(40) });
  const password = 'synthetic-observer-test-only', origin = `http://127.0.0.1:${await freePort()}`;
  const app = createApp({ store, origin, password, manual: true,
    params: parseParams('persistencia.cadaTicks=1,motor.clonPorPaso=false'),
    ...(observerOn ? { observationSession: session } : {}),
    decisionClock: (siteId, _attemptId, _tick, _domain, readReal) => {
      if (fault === 'clock-after-save' && siteId === 'save-end') throw new Error('synthetic clock failure after COMMIT');
      return readReal();
    } });
  try {
    if (fault === 'store-after-commit') {
      const realSave = store.save.bind(store);
      store.save = ((...args: Parameters<Store['save']>) => {
        realSave(...args);
        throw new Error('synthetic post-COMMIT failure');
      }) as Store['save'];
    }
    app.stepOnce();
    assert.equal(app.failed, true);
    const committed = store.load();
    assert.ok(committed && committed.slot === 0);
    assert.equal(app.world.tick, committed.world.tick);
    assert.equal(digestoCanonico(app.world), digestoCanonico(committed.world));
    const view = await syntheticViewTick(app, origin, password);
    assert.equal(view.tick, committed.world.tick);
    assert.equal(view.paused, true);
    if (observerOn) {
      const states = [...session.attemptHistory.values()].at(-1)!.map(transition => transition.state);
      assert.ok(states.includes('durable'));
      assert.ok(states.includes('partial'));
      assert.equal(states.includes('adopted'), false);
      assert.equal(states.includes('discarded'), false);
    }
  } finally { await app.close(); store.close(); }
});

test('real revoked gesture retries the same physical tick with a distinct attempt', async () => {
  for (const clonPorPaso of [false, true]) {
    const store = new Store(':memory:');
    const session = createObservationSession({ runId: `revoke-${clonPorPaso}`, epochId: 'e', sourceSHA: '8'.repeat(40) });
    const password = 'synthetic-revocation-only', origin = `http://127.0.0.1:${await freePort()}`;
    const app = createApp({ store, origin, password, manual: true, observationSession: session,
      params: parseParams(`persistencia.cadaTicks=1,motor.clonPorPaso=${clonPorPaso},gobernador.presupuestoMs=5000`) });
    try {
      app.server.listen(Number(new URL(origin).port), '127.0.0.1'); await once(app.server, 'listening');
      const login = await fetch(origin + '/api/login', { method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
      const person = app.world.people[0]!;
      const gesture = { id: `synthetic-revoke-${clonPorPaso}`, kind: 'plant', x: Math.round(person.x) + 1, y: Math.round(person.y) };
      const response = fetch(origin + '/api/gesture', { method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(gesture) });
      let responded = false; void response.then(() => { responded = true; }, () => { responded = true; });
      for (let n = 0; n < 2000 && app.gestosPendientes === 0 && !responded; n++)
        await new Promise<void>(resolve => setTimeout(resolve, 1));
      assert.equal(app.gestosPendientes, 1);
      const beforeTick = app.world.tick, beforeDigest = digestoCanonico(app.world);
      const realSave = store.save.bind(store);
      store.save = ((...args: Parameters<Store['save']>) => {
        store.revoke(args[2]?.[0]);
        return realSave(...args);
      }) as Store['save'];
      app.stepOnce(); store.save = realSave;
      assert.equal((await response).status, 401);
      assert.equal(app.failed, false);
      assert.equal(app.world.tick, beforeTick);
      assert.equal(digestoCanonico(app.world), beforeDigest);
      const aborted = [...session.attemptHistory.entries()].at(-1)!;
      const abortedStates = aborted[1].map(transition => transition.state);
      assert.ok(abortedStates.includes(clonPorPaso ? 'discarded' : 'restored'));
      assert.equal(abortedStates.includes('durable'), false);
      app.stepOnce();
      const retried = [...session.attemptHistory.entries()].at(-1)!;
      assert.notEqual(retried[0], aborted[0]);
      assert.equal(app.world.tick, beforeTick + 1);
      assert.ok(retried[1].some(transition => transition.state === 'adopted'));
      assert.ok(retried[1].some(transition => transition.state === 'durable'));
    } finally { await app.close(); store.close(); }
  }
});

test('a failed save before COMMIT restores the resident world and keeps durable history absent', async () => {
  for (const observerOn of [false, true]) {
    const store = new Store(':memory:');
    const session = createObservationSession({ runId: `precommit-${observerOn}`, epochId: 'e', sourceSHA: '8'.repeat(40) });
    const password = 'synthetic-precommit-only', origin = `http://127.0.0.1:${await freePort()}`;
    const app = createApp({ store, origin, password, manual: true,
      params: parseParams('persistencia.cadaTicks=1,motor.clonPorPaso=false'),
      ...(observerOn ? { observationSession: session } : {}) });
    try {
      const beforeTick = app.world.tick, beforeDigest = digestoCanonico(app.world);
      store.save = () => { throw new Error('synthetic pre-COMMIT failure'); };
      app.stepOnce();
      assert.equal(app.failed, true);
      assert.equal(app.world.tick, beforeTick);
      assert.equal(digestoCanonico(app.world), beforeDigest);
      const durable = store.load(); assert.ok(durable);
      assert.equal(durable.world.tick, beforeTick);
      const view = await syntheticViewTick(app, origin, password);
      assert.equal(view.tick, beforeTick);
      assert.equal(view.paused, true);
      if (observerOn) {
        const states = [...session.attemptHistory.values()].at(-1)!.map(transition => transition.state);
        assert.ok(states.includes('restored'));
        assert.equal(states.includes('durable'), false);
      }
    } finally { await app.close(); store.close(); }
  }
});

test('post-COMMIT failure on a cloned gesture reconciles resident world and durable reply', async () => {
  for (const observerOn of [false, true]) {
    const store = new Store(':memory:');
    const session = createObservationSession({ runId: `cloned-commit-${observerOn}`, epochId: 'e', sourceSHA: '8'.repeat(40) });
    const password = 'synthetic-clone-only', origin = `http://127.0.0.1:${await freePort()}`;
    const app = createApp({ store, origin, password, manual: true,
      params: parseParams('persistencia.cadaTicks=1,motor.clonPorPaso=true'),
      ...(observerOn ? { observationSession: session } : {}) });
    try {
      app.server.listen(Number(new URL(origin).port), '127.0.0.1'); await once(app.server, 'listening');
      const login = await fetch(origin + '/api/login', { method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
      const person = app.world.people[0]!;
      const gesture = { id: `clone-commit-${observerOn}`, kind: 'plant', x: Math.round(person.x) + 1, y: Math.round(person.y) };
      const response = fetch(origin + '/api/gesture', { method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(gesture) });
      let responded = false; void response.then(() => { responded = true; }, () => { responded = true; });
      for (let n = 0; n < 2000 && app.gestosPendientes === 0 && !responded; n++)
        await new Promise<void>(resolve => setTimeout(resolve, 1));
      assert.equal(app.gestosPendientes, 1);
      const realSave = store.save.bind(store);
      store.save = ((...args: Parameters<Store['save']>) => {
        realSave(...args); throw new Error('synthetic post-COMMIT failure with draft');
      }) as Store['save'];
      app.stepOnce(); store.save = realSave;
      assert.equal(app.failed, true);
      const durable = store.load(); assert.ok(durable && durable.slot === 0);
      assert.equal(app.world.tick, durable.world.tick);
      assert.equal(digestoCanonico(app.world), digestoCanonico(durable.world));
      assert.equal((await response).status, 200);
      const view = await syntheticViewTick(app, origin, password);
      assert.equal(view.tick, durable.world.tick);
      assert.equal(view.paused, true);
      if (observerOn) {
        const states = [...session.attemptHistory.values()].at(-1)!.map(transition => transition.state);
        assert.ok(states.includes('durable'));
        assert.ok(states.includes('partial'));
        assert.equal(states.includes('adopted'), false);
      }
    } finally { await app.close(); store.close(); }
  }
});

test('Store internal post-COMMIT acknowledgement failure is detected before in-place rollback', async () => {
  const store = new Store(':memory:');
  const session = createObservationSession({ runId: 'internal-commit', epochId: 'e', sourceSHA: '8'.repeat(40) });
  const password = 'synthetic-internal-commit-only', origin = `http://127.0.0.1:${await freePort()}`;
  const app = createApp({ store, origin, password, manual: true, observationSession: session,
    params: parseParams('persistencia.cadaTicks=1,motor.clonPorPaso=false') });
  try {
    const archive = (store as unknown as { technologyArchive: { acknowledgeHostCommit: () => void } }).technologyArchive;
    const realAcknowledge = archive.acknowledgeHostCommit.bind(archive);
    const realSave = store.save.bind(store);
    const initialDigest = (store.db.prepare('SELECT digest FROM snapshots WHERE slot=0').get() as { digest: string }).digest;
    let insideSave = false, injected = false, committedAtInjection = false;
    try {
      store.save = ((...args: Parameters<Store['save']>) => {
        insideSave = true;
        try { return realSave(...args); }
        finally { insideSave = false; }
      }) as Store['save'];
      archive.acknowledgeHostCommit = () => {
        realAcknowledge();
        // prepareTechnology can acknowledge an earlier read transaction. Inject only
        // inside Store.save, after its own COMMIT has advanced durable slot 0.
        if (insideSave && !injected) {
          const current = store.db.prepare('SELECT digest FROM snapshots WHERE slot=0').get() as { digest: string } | undefined;
          committedAtInjection = !store.db.isTransaction && current !== undefined && current.digest !== initialDigest;
          if (committedAtInjection) {
            injected = true;
            throw new Error('synthetic internal post-COMMIT acknowledgement failure');
          }
        }
      };
      app.stepOnce();
    } finally {
      archive.acknowledgeHostCommit = realAcknowledge;
      store.save = realSave;
    }
    assert.equal(injected, true);
    assert.equal(committedAtInjection, true);
    assert.equal(insideSave, false);
    assert.equal(app.failed, true);
    const durable = store.load(); assert.ok(durable && durable.slot === 0);
    assert.equal(app.world.tick, durable.world.tick);
    assert.equal(digestoCanonico(app.world), digestoCanonico(durable.world));
    const view = await syntheticViewTick(app, origin, password);
    assert.equal(view.tick, durable.world.tick);
    assert.equal(view.paused, true);
    const states = [...session.attemptHistory.values()].at(-1)!.map(transition => transition.state);
    assert.ok(states.includes('durable'));
    assert.ok(states.includes('partial'));
    assert.equal(states.includes('adopted'), false);
    assert.equal(states.includes('restored'), false);
  } finally { await app.close(); store.close(); }
});

test('sidecar manifest seals the actual NDJSON bytes and detects an incomplete line', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-observer-seal-'));
  const world = createWorld(51926);
  const source = makeRealismoSourceManifest({ baseCommit: 'b'.repeat(40),
    runtime: { node: 'test', v8: 'test', modules: 'test', platform: 'linux', arch: 'x64' },
    files: [{ path: 'src/world/index.ts', sha256: 'a'.repeat(64) }] });
  try {
    const observer = new InstrumentosRealismo(world, 'seal', 'e', source, directory);
    observer.beginOpening(world);
    emitObserved(world, 'index.step-inputs', () => ({ kind: 'technical-input', tick: world.tick }));
    observer.state(world, 'adopted'); observer.state(world, 'durable');
    await observer.drain(); observer.end(world); observer.finish(source);
    const path = join(directory, 'realismo-source-events.ndjson');
    const body = readFileSync(path);
    const manifestPath = join(directory, 'realismo-observer.json');
    const sealed = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      sourceEventsSha256: string; sourceEventsBytes: number; sourceEventsLines: number;
      sourceEventsWritten: number; sourceEventsCompleteLines: boolean; quality: string;
    };
    assert.equal(sealed.sourceEventsSha256, createHash('sha256').update(body).digest('hex'));
    assert.equal(sealed.sourceEventsBytes, body.length);
    assert.equal(sealed.sourceEventsLines, 1);
    assert.equal(sealed.sourceEventsWritten, 1);
    assert.equal(sealed.sourceEventsCompleteLines, true);
    assert.equal(sealed.quality, 'COMPLETE');
    appendFileSync(path, 'partial');
    observer.finish(source);
    const damaged = JSON.parse(readFileSync(manifestPath, 'utf8')) as { quality: string; sourceEventsCompleteLines: boolean; sourceEventsSha256: string };
    assert.equal(damaged.quality, 'PARTIAL');
    assert.equal(damaged.sourceEventsCompleteLines, false);
    assert.equal(damaged.sourceEventsSha256, createHash('sha256').update(readFileSync(path)).digest('hex'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('sidecar seal rejects equal-length same-line corruption before the final manifest', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-observer-byte-seal-'));
  const world = createWorld(51926);
  const source = makeRealismoSourceManifest({ baseCommit: 'b'.repeat(40),
    runtime: { node: 'test', v8: 'test', modules: 'test', platform: 'linux', arch: 'x64' },
    files: [{ path: 'src/world/index.ts', sha256: 'a'.repeat(64) }] });
  try {
    const observer = new InstrumentosRealismo(world, 'byte-seal', 'e', source, directory);
    observer.beginOpening(world);
    emitObserved(world, 'index.step-inputs', () => ({ kind: 'technical-input', tick: world.tick }));
    observer.state(world, 'adopted'); observer.state(world, 'durable');
    await observer.drain(); observer.end(world);
    const path = join(directory, 'realismo-source-events.ndjson');
    const intended = readFileSync(path);
    const altered = Buffer.from(intended);
    const offset = altered.indexOf(Buffer.from('technical-input'));
    assert.ok(offset >= 0);
    altered[offset] = 'u'.charCodeAt(0);
    assert.equal(altered.length, intended.length);
    assert.equal(altered.filter(byte => byte === 10).length, intended.filter(byte => byte === 10).length);
    writeFileSync(path, altered, { mode: 0o600 });
    observer.finish(source);
    const sealed = JSON.parse(readFileSync(join(directory, 'realismo-observer.json'), 'utf8')) as {
      sourceEventsSha256: string; sourceEventsIntendedSha256: string; sourceEventsBytes: number;
      sourceEventsIntendedBytes: number; sourceEventsLines: number; sourceEventsCompleteLines: boolean;
      sourceEventsSealMatchesWriter: boolean; quality: string; gaps: { reason: string }[];
    };
    assert.equal(sealed.sourceEventsBytes, sealed.sourceEventsIntendedBytes);
    assert.equal(sealed.sourceEventsLines, 1);
    assert.equal(sealed.sourceEventsCompleteLines, true);
    assert.notEqual(sealed.sourceEventsSha256, sealed.sourceEventsIntendedSha256);
    assert.equal(sealed.sourceEventsSealMatchesWriter, false);
    assert.equal(sealed.quality, 'PARTIAL');
    assert.ok(sealed.gaps.some(gap => gap.reason === 'sidecar-content-mismatch'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function boundWorld(seed = 51926) {
  const world = createWorld(seed);
  const session = createObservationSession({ runId: 'directed', epochId: 'e', sourceSHA: '2'.repeat(40) });
  bindObservation(world, session);
  beginObservationAttempt(world, world.tick);
  enterObservationPhase(world, 'directed');
  return { world, session };
}

test('the real failed invention branch records its paid debit without a product', () => {
  const { world, session } = boundWorld();
  const actor = world.people[2]!;
  actor.work = 60;
  actor.materials.wood = 2;
  actor.skills.build = 1;
  // The last available catalogue slot is already occupied. invent still pays the trial.
  const base = world.blueprints[0]!;
  for (let n = world.blueprints.length; n < MAX_BLUEPRINTS; n++)
    world.blueprints.push({ ...structuredClone(base), id: `blueprint-${n + 2}` });
  const beforeWood = actor.materials.wood, beforeWork = actor.work;
  assert.equal(invent(world, actor, () => ({ id: 'unused' } as never)), false);
  assert.equal(actor.materials.wood, beforeWood - 1);
  assert.equal(actor.work, beforeWork - 60);
  const trial = observedEvents(session).find(event => event.siteId === 'inventions.paid-trial');
  assert.equal((trial?.payload as { success?: boolean } | undefined)?.success, false);
  assert.equal((trial?.payload as { blueprintId?: string | null } | undefined)?.blueprintId, null);
  unbindObservation(world);
});

test('a real unfinished technology project pays each step without claiming manufacture', () => {
  const { world, session } = boundWorld();
  const actor = world.people[2]!;
  actor.materials.stone = 2;
  actor.energy = 1; actor.fatigue = 0;
  actor.technology.project = proyectoInvestigacion(PROGRAMA_FILO, world.tick);
  const beforeWork = world.technology.ledger.work;
  assert.equal(researchTechnology(world, actor), false);
  assert.equal(actor.technology.project?.progress, 1);
  assert.equal(world.technology.ledger.work, beforeWork + 1);
  const events = observedEvents(session);
  assert.equal(events.filter(event => event.siteId === 'technology.project-paid-step').length, 1);
  assert.equal(events.filter(event => event.siteId === 'technology.product-manufactured').length, 0);
  unbindObservation(world);
});

test('real manufacture, transfer, wear, late benefit and estate preserve source receipt links', () => {
  const { world, session } = boundWorld();
  const actor = world.people[2]!, recipient = world.people[3]!;
  actor.materials.stone = 2;
  actor.energy = 1; actor.fatigue = 0;
  actor.technology.project = proyectoInvestigacion(PROGRAMA_FILO, world.tick);
  for (let n = 0; actor.technology.project && n < 250; n++) {
    endObservationAttempt(world); world.tick++; beginObservationAttempt(world, world.tick);
    researchTechnology(world, actor);
  }
  const item = actor.technology.items.at(-1);
  assert.ok(item);
  const manufacture = observedEvents(session).find(event => event.siteId === 'technology.product-manufactured');
  assert.equal((manufacture?.payload as { itemId?: string } | undefined)?.itemId, item.id);
  const receipt = useTool(world, actor, 'cutting', 1);
  assert.ok(receipt);
  recordTechnologyBenefit(world, actor, receipt, 0.08);
  const benefit = observedEvents(session).find(event => event.siteId === 'technology.benefit-applied');
  assert.equal((benefit?.payload as { executionId?: string } | undefined)?.executionId, receipt.executionId);
  recipient.x = actor.x; recipient.y = actor.y;
  const senderBefore = actor.technology.items.length, receiverBefore = recipient.technology.items.length;
  assert.equal(transferTechnologyItem(world, actor, recipient, item.id), true);
  assert.equal(actor.technology.items.length, senderBefore - 1);
  assert.equal(recipient.technology.items.length, receiverBefore + 1);
  assert.equal(actor.technology.items.some(owned => owned.id === item.id), false);
  assert.equal(recipient.technology.items.filter(owned => owned.id === item.id).length, 1);
  const transfer = observedEvents(session).find(event => event.siteId === 'technology.transfer');
  assert.equal((transfer?.payload as { receiptEnds?: string[] } | undefined)?.receiptEnds?.length, 2);
  const transferId = (transfer?.payload as { transferId?: string } | undefined)?.transferId;
  const paired = world.technology.history.filter(execution => execution.transferId === transferId);
  assert.equal(paired.length, 2);
  assert.deepEqual(paired.map(execution => execution.actorId), [actor.id, recipient.id]);
  assert.equal(paired[0]!.balance.externalLoss.reduce((sum, resource) => sum + resource.mass, 0), item.mass);
  assert.equal(paired[1]!.balance.externalInputs.reduce((sum, resource) => sum + resource.mass, 0), item.mass);
  const estate = settleTechnologyEstate(world, recipient, []);
  assert.ok(estate.executionIds.length >= 1);
  assert.equal(recipient.technology.items.some(owned => owned.id === item.id), false);
  const loss = world.technology.history.find(execution => execution.id === estate.executionIds.at(-1));
  assert.equal(loss?.kind, 'estate');
  assert.ok((loss?.balance.externalLoss.reduce((sum, resource) => sum + resource.mass, 0) ?? 0) >= item.mass);
  assert.ok(observedEvents(session).some(event => event.siteId === 'technology-execution.append'
    && (event.payload as { receiptKind?: string }).receiptKind === 'estate'));
  unbindObservation(world);
});

test('real region retirement records dormant stocks and ends structure exposure', () => {
  const { world, session } = boundWorld();
  const originalStructure = world.structures[0]!;
  const originalStructureId = originalStructure.id;
  for (const person of world.people) {
    person.x = 120; person.y = 120; person.target = { x: 120, y: 120 };
  }
  maintainRegions(world);
  const retired = observedEvents(session).find(event => event.siteId === 'spatial.retire'
    && (event.payload as { structureIds?: string[] }).structureIds?.includes(originalStructureId));
  assert.ok(retired);
  assert.equal((retired.payload as { localTick?: number }).localTick, world.tick);
  assert.ok(observedEvents(session).some(event => event.siteId === 'spatial.structure-archived'
    && (event.payload as { payload?: { subjectId?: string } }).payload?.subjectId === originalStructureId));
  activate(world, originalStructure.x, originalStructure.y);
  assert.ok(observedEvents(session).some(event => event.siteId === 'spatial.activate'
    && (event.payload as { structureIds?: string[] }).structureIds?.includes(originalStructureId)));
  assert.ok(observedEvents(session).some(event => event.siteId === 'spatial.structure-active'
    && (event.payload as { payload?: { subjectId?: string } }).payload?.subjectId === originalStructureId));
  unbindObservation(world);
});

test('procedural activation reports exactly the animals actually appended', () => {
  const { world, session } = boundWorld();
  let found = false;
  for (let n = 0; n < 40 && !found; n++) {
    const x = (12 + n) * 16, before = world.animals.length;
    activate(world, x, 0);
    const added = world.animals.slice(before).map(animal => animal.id);
    const event = observedEvents(session).find(source => source.siteId === 'spatial.activate'
      && (source.payload as { regionId?: string }).regionId === `${12 + n},0`);
    assert.ok(event);
    assert.deepEqual((event.payload as { animalIds: string[] }).animalIds, added);
    found = added.length > 0;
  }
  assert.equal(found, true, 'fixture must reach materializeAnimals with nonempty output');
  unbindObservation(world);
});

test('real structure deterioration records actual condition even when no service occurs', () => {
  const { world, session } = boundWorld();
  world.tick = INTERVALO_ECOLOGIA_TICKS;
  endObservationAttempt(world); beginObservationAttempt(world, world.tick);
  world.weather = 'clear';
  const structure = world.structures[0]!;
  const before = structure.condition;
  stepStructures(world, () => ({ id: 'unused' } as never));
  const after = structure.condition;
  assert.ok(after < before);
  const event = observedEvents(session).find(item => item.siteId === 'inventions.condition'
    && (item.payload as { structureId?: string }).structureId === structure.id);
  assert.ok(event);
  assert.equal((event.payload as { conditionBefore: number }).conditionBefore, before);
  assert.equal((event.payload as { conditionAfter: number }).conditionAfter, after);
  unbindObservation(world);
});

test('a real mortal death records the archived identity without private narrative', () => {
  const { world, session } = boundWorld();
  const actor = world.people[2]!;
  actor.inventory = 0; actor.materials = { wood: 0, stone: 0 };
  actor.thirst = 1;
  actor.demography = { ...actor.demography, health: 1e-8, vitality: 0.1 };
  endObservationAttempt(world); world.tick++; beginObservationAttempt(world, world.tick);
  advancePopulation(world, { beforeDeath: (host, person) => { settleTechnologyEstate(host, person, []); },
    emit: event => ({ ...event, id: `directed-${++world.eventCounter}`, tick: world.tick }) });
  assert.equal(world.people.some(person => person.id === actor.id), false);
  assert.equal(world.retiredLegacy.some(person => person.id === actor.id), true);
  const receipt = observedEvents(session).find(event => event.siteId === 'lineage.death'
    && (event.payload as { payload?: { actorId?: string } }).payload?.actorId === actor.id);
  assert.ok(receipt);
  assert.equal((receipt.payload as { payload: { deathTick: number } }).payload.deathTick, world.tick);
  assert.ok(!JSON.stringify(receipt).includes(actor.name));
  unbindObservation(world);
});

test('empty stream is unavailable, never observed zero for a phenomenon', () => {
  const projected = projectObservedEvents([], { gaps: [], attemptHistory: new Map() });
  assert.equal(projected.records.length, 0);
  assert.equal(projected.capabilities.length, FAMILIES.length);
  assert.equal(projected.evidenceCoverage.length, EVIDENCE_KINDS.length);
  assert.ok(projected.capabilities.every(capability => capability.status === 'unavailable'));
  assert.ok(projected.evidenceCoverage.every(capability => capability.status === 'unavailable'));
});

test('canonical partial payload preserves observed fields, missing fields and protected actor', () => {
  const world = {};
  const session = createObservationSession({ runId: 'coverage', epochId: 'e', sourceSHA: 'e'.repeat(40) });
  bindObservation(world, session); beginObservationAttempt(world, 3); enterObservationPhase(world, 'opening');
  emitObserved(world, 'manual.person', () => ({ family: 'person', actorIds: ['s'],
    payload: { actorId: 's', role: 'S', birthTick: -4800 } }));
  markObservationAttempt(world, 'adopted');
  const projected = projectObservedEvents(observedEvents(session), { gaps: [], attemptHistory: session.attemptHistory });
  assert.equal(projected.records.length, 1);
  const personRecord = projected.records[0];
  if (personRecord?.family !== 'person') throw new Error('Expected person record');
  assert.deepEqual(personRecord.protectedOriginIds, ['s']);
  assert.equal(personRecord.fieldCoverage.birthTick.status, 'observed');
  assert.equal(personRecord.fieldCoverage.deathTick.status, 'missing');
  assert.equal(projected.capabilities.find(capability => capability.family === 'person')?.status, 'partial');
  unbindObservation(world);
});

test('missing attempt history or a lost event never certifies family fields or evidence coverage', () => {
  const world = {};
  const session = createObservationSession({ runId: 'gap', epochId: 'e', sourceSHA: '9'.repeat(40) });
  bindObservation(world, session); beginObservationAttempt(world, 3);
  emitObserved(world, 'index.birth', () => ({ family: 'person', actorIds: ['neighbor-1'],
    payload: { actorId: 'neighbor-1', birthTick: 3 } }));
  markObservationAttempt(world, 'adopted');
  const absentHistory = projectObservedEvents(observedEvents(session), { gaps: [], attemptHistory: new Map() });
  assert.equal(absentHistory.records.length, 0);
  assert.equal(absentHistory.sourceEvents.length, 1);
  const noLedger = projectObservedEvents(observedEvents(session), undefined as never);
  assert.equal(noLedger.records.length, 0);
  assert.equal(noLedger.capabilities.find(capability => capability.family === 'person')?.status, 'unavailable');
  assert.ok(noLedger.modelGaps.includes('attempt-history-unavailable'));
  const lossy = projectObservedEvents(observedEvents(session), { gaps: [], attemptHistory: session.attemptHistory, lostEvents: 1 });
  assert.equal(lossy.records.length, 1);
  assert.equal(lossy.capabilities.find(capability => capability.family === 'person')?.status, 'unavailable');
  assert.equal(lossy.evidenceCoverage.find(capability => capability.kind === 'cohort')?.status, 'unavailable');
  const person = lossy.records[0];
  if (person?.family !== 'person') throw new Error('Expected person');
  assert.equal(person.fieldCoverage.deathTick.reason, 'observation-gap-or-not-captured');
  unbindObservation(world);
});

test('early reproduction stop remains a source fact, not invented rejected pairs', () => {
  const world = {};
  const session = createObservationSession({ runId: 'c20', epochId: 'e', sourceSHA: 'f'.repeat(40) });
  bindObservation(world, session); beginObservationAttempt(world, 120);
  emitObserved(world, 'index.reproduce.global-stop', () => ({ kind: 'reproduction-period', gate: 'enabled-false', tick: 120 }));
  markObservationAttempt(world, 'adopted');
  const projected = projectObservedEvents(observedEvents(session), { gaps: [], attemptHistory: session.attemptHistory });
  assert.equal(projected.records.filter(record => record.family === 'rejection').length, 0);
  assert.equal(projected.sourceEvents.length, 1);
  assert.equal(projected.evidenceCoverage.find(capability => capability.kind === 'reproduction-gates')?.status, 'partial');
  unbindObservation(world);
});

test('only evaluated local reproduction gate and actual birth become partial outcomes', () => {
  const world = {};
  const session = createObservationSession({ runId: 'gates', epochId: 'e', sourceSHA: '4'.repeat(40) });
  bindObservation(world, session); beginObservationAttempt(world, 120);
  emitObserved(world, 'index.reproduce.fit', () => ({ kind: 'reproduction-gate', gate: 'fit',
    actorIds: ['neighbor-1'], passed: false }));
  markObservationAttempt(world, 'adopted');
  endObservationAttempt(world); beginObservationAttempt(world, 121);
  emitObserved(world, 'index.reproduce.accepted', () => ({ kind: 'reproduction-accepted',
    childId: 'descendant-4', actorIds: ['neighbor-2', 'neighbor-3'], tick: 121 }));
  markObservationAttempt(world, 'adopted');
  const records = projectObservedEvents(observedEvents(session), { gaps: [], attemptHistory: session.attemptHistory }).records.filter(record => record.family === 'rejection');
  assert.equal(records.length, 2);
  if (records[0]?.family !== 'rejection' || records[1]?.family !== 'rejection') throw new Error('Expected attempt outcomes');
  assert.equal(records[0].payload.outcome, 'rejected');
  assert.equal(records[1].payload.outcome, 'accepted');
  assert.equal(records[1].fieldCoverage.allGateResultsRef.status, 'missing');
  unbindObservation(world);
});

test('real C20 short circuits global, cadence, quota and evaluates local gates only when reached', () => {
  const cases = [
    { name: 'global', params: '', enabled: false, expected: 'index.reproduce.global-stop', local: false },
    { name: 'cadence', params: 'poblacion.comprobacionContinua=false', enabled: true,
      expected: 'index.reproduce.cadence-stop', local: false },
    { name: 'quota', params: 'poblacion.comprobacionContinua=true,poblacion.nacimientosPorComprobacion=0',
      enabled: true, expected: 'index.reproduce.quota-stop', local: false },
    { name: 'local', params: 'poblacion.comprobacionContinua=true,poblacion.nacimientosPorComprobacion=1,poblacion.exigeComunidad=false',
      enabled: true, expected: 'index.reproduce.fit', local: true },
  ] as const;
  for (const scene of cases) {
    const world = scene.params ? createWorld(51926, parseParams(scene.params)) : createWorld(51926);
    world.reproductionEnabled = scene.enabled;
    const session = createObservationSession({ runId: `c20-${scene.name}`, epochId: 'e', sourceSHA: '7'.repeat(40) });
    bindObservation(world, session); beginObservationAttempt(world, world.tick + 1);
    stepWorld(world); markObservationAttempt(world, 'adopted');
    const events = observedEvents(session), names = new Set(events.map(event => event.siteId));
    assert.equal(names.has(scene.expected), true, `missing real gate ${scene.name}`);
    assert.equal(events.find(event => event.siteId === scene.expected)?.tick, world.tick);
    assert.equal(names.has('index.reproduce.fit'), scene.local);
    if (!scene.local) assert.equal(events.some(event => event.siteId === 'index.reproduce.match'), false);
    const projected = projectObservedEvents(events, { gaps: coverageStatus(session).gaps, attemptHistory: session.attemptHistory });
    if (!scene.local) assert.equal(projected.records.some(record => record.family === 'rejection'), false);
    unbindObservation(world);
  }
});

test('a real accepted birth projects only its observed partial C20 outcome', () => {
  const world = createWorld(51926);
  const [a, b, c] = [world.people[2]!, world.people[3]!, world.people[4]!];
  world.tick = 599;
  world.communities = [];
  for (const person of world.people) {
    person.communityId = null; person.bonds = {}; person.action = 'rest'; person.decisionAt = 999;
    person.hunger = person.thirst = person.fatigue = 0.1; person.energy = 0.9; person.inventory = 0.2;
    person.target = { x: person.x, y: person.y };
    const traits = demographicTraits(person.genome);
    if (person.genome.parents.length === 0) person.bornAt = world.tick - traits.maturityAge - 10;
    person.demography = initialDemography(world.tick - person.bornAt);
    if (world.tick - person.lastBirth < traits.fertilityCooldown)
      person.lastBirth = Math.max(-2400, world.tick - traits.fertilityCooldown);
  }
  world.communities.push({ id: 'shared', name: 'shared', x: 17, y: 13, color: '#aabbcc',
    members: [a.id, b.id, c.id], culture: { ...a.culture }, formedAt: 0, cooperation: 0, disputes: 0 });
  for (const person of [a, b, c]) {
    person.x = 17; person.y = 13; person.target = { x: 17, y: 13 }; person.communityId = 'shared';
  }
  a.bonds[b.id] = b.bonds[a.id] = 0.3; b.x = 20;
  a.bonds[c.id] = c.bonds[a.id] = 0.9;
  b.bonds[c.id] = c.bonds[b.id] = 0.3;
  const session = createObservationSession({ runId: 'c20-accepted', epochId: 'e', sourceSHA: '0'.repeat(40) });
  bindObservation(world, session); beginObservationAttempt(world, world.tick + 1);
  stepWorld(world); markObservationAttempt(world, 'adopted');
  assert.equal(world.totals.births, 1);
  const accepted = observedEvents(session).filter(event => event.siteId === 'index.reproduce.accepted');
  assert.equal(accepted.length, 1);
  const outcomes = projectObservedEvents(observedEvents(session), {
    gaps: coverageStatus(session).gaps, attemptHistory: session.attemptHistory,
  }).records.filter(record => record.family === 'rejection' && record.payload.outcome === 'accepted');
  assert.equal(outcomes.length, 1);
  if (outcomes[0]?.family !== 'rejection') throw new Error('Expected accepted outcome');
  assert.equal(outcomes[0].fieldCoverage.allGateResultsRef.status, 'missing');
  unbindObservation(world);
});

test('the last physical step keeps its own tick and phase before observationEnd', () => {
  const world = {};
  const session = createObservationSession({ runId: 'boundary', epochId: 'e', sourceSHA: '6'.repeat(40) });
  const observationEnd = 144000;
  bindObservation(world, session);
  beginObservationAttempt(world, observationEnd - 1);
  enterObservationPhase(world, 'inputs');
  enterObservationPhase(world, 'personas');
  emitObserved(world, 'manual.last-service', () => ({ family: 'service', actorIds: ['neighbor-1'],
    payload: { subjectId: 'roof-1', eventType: 'shelter-recovery' } }));
  markObservationAttempt(world, 'adopted');
  const [source] = observedEvents(session);
  const [record] = projectObservedEvents(observedEvents(session), { gaps: [], attemptHistory: session.attemptHistory }).records;
  assert.equal(source?.tick, observationEnd - 1);
  assert.equal(source?.phaseId, 'personas');
  assert.equal(source?.phaseOrdinal, 2);
  assert.equal(record?.tick, observationEnd - 1);
  assert.ok(record!.tick < observationEnd);
  unbindObservation(world);
});

test('late benefit becomes service only for an applied-world receipt, never catalyst properties', () => {
  const world = {};
  const session = createObservationSession({ runId: 'benefit', epochId: 'e', sourceSHA: '1'.repeat(40) });
  bindObservation(world, session); beginObservationAttempt(world, 9);
  emitObserved(world, 'technology-execution.append', () => ({ kind: 'technology-execution',
    executionId: 'process-7', receiptKind: 'use', actorId: 'neighbor-1', recipeId: null, benefitAtAppend: 0 }));
  emitObserved(world, 'technology.tool-wear', () => ({ kind: 'technology-tool-wear',
    executionId: 'process-7', actorId: 'neighbor-1', recipeId: null, itemId: 'product-4', capability: 'cutting' }));
  emitObserved(world, 'technology.benefit-applied', () => ({ kind: 'technology-benefit-update',
    executionId: 'process-7', actorId: 'neighbor-1', recipeId: null, itemId: 'product-4', capability: 'cutting',
    actualBenefit: 0.12, benefitContext: 'process-property' }));
  markObservationAttempt(world, 'adopted');
  assert.equal(projectObservedEvents(observedEvents(session), { gaps: [], attemptHistory: session.attemptHistory }).records.filter(record => record.family === 'service').length, 0);
  endObservationAttempt(world); beginObservationAttempt(world, 10);
  emitObserved(world, 'technology-execution.append', () => ({ kind: 'technology-execution',
    executionId: 'process-8', receiptKind: 'use', actorId: 'neighbor-1', recipeId: null, benefitAtAppend: 0 }));
  emitObserved(world, 'technology.tool-wear', () => ({ kind: 'technology-tool-wear',
    executionId: 'process-8', actorId: 'neighbor-1', recipeId: null, itemId: 'product-4', capability: 'cutting' }));
  emitObserved(world, 'technology.benefit-applied', () => ({ kind: 'technology-benefit-update',
    executionId: 'process-8', actorId: 'neighbor-1', recipeId: null, itemId: 'product-4', capability: 'cutting',
    actualBenefit: 0.08, benefitContext: 'applied-world' }));
  markObservationAttempt(world, 'adopted');
  const projected = projectObservedEvents(observedEvents(session), { gaps: [], attemptHistory: session.attemptHistory });
  const services = projected.records.filter(record => record.family === 'service');
  assert.equal(services.length, 1);
  if (services[0]?.family !== 'service') throw new Error('Expected service');
  assert.equal(services[0].payload.subjectId, 'product-4');
  assert.equal(services[0].payload.appliedBenefit?.value, 0.08);
  assert.equal(services[0].payload.inputRefs?.length, 2);
  endObservationAttempt(world); beginObservationAttempt(world, 11);
  emitObserved(world, 'technology.benefit-applied', () => ({ kind: 'technology-benefit-update',
    executionId: 'process-9', actorId: 'neighbor-1', recipeId: null, itemId: 'product-4', capability: 'cutting',
    actualBenefit: 0.05, benefitContext: 'applied-world' }));
  markObservationAttempt(world, 'adopted');
  endObservationAttempt(world); beginObservationAttempt(world, 12);
  emitObserved(world, 'technology-execution.append', () => ({ kind: 'technology-execution',
    executionId: 'process-10', receiptKind: 'use', actorId: 'neighbor-1', recipeId: null, benefitAtAppend: 0 }));
  emitObserved(world, 'technology.tool-wear', () => ({ kind: 'technology-tool-wear',
    executionId: 'process-10', actorId: 'neighbor-1', recipeId: null, itemId: 'product-4', capability: 'cutting' }));
  markObservationAttempt(world, 'adopted');
  endObservationAttempt(world); beginObservationAttempt(world, 13);
  emitObserved(world, 'technology.benefit-applied', () => ({ kind: 'technology-benefit-update',
    executionId: 'process-10', actorId: 'neighbor-1', recipeId: null, itemId: 'product-4', capability: 'cutting',
    actualBenefit: 0.03, benefitContext: 'applied-world' }));
  markObservationAttempt(world, 'adopted');
  const incomplete = projectObservedEvents(observedEvents(session), { gaps: [], attemptHistory: session.attemptHistory });
  assert.equal(incomplete.records.filter(record => record.family === 'service').length, 1);
  assert.equal(incomplete.modelGaps.filter(gap => gap.includes('applied-benefit-without-same-attempt-use-and-wear')).length, 2);
  unbindObservation(world);
});

test('a source debit links to applied bodily relief without assigning the whole benefit to one roof', () => {
  const world = {};
  const session = createObservationSession({ runId: 'food', epochId: 'e', sourceSHA: '3'.repeat(40) });
  bindObservation(world, session); beginObservationAttempt(world, 4);
  emitObserved(world, 'inventions.take-food', () => ({ kind: 'structure-food-debit', structureId: 'roof-a',
    actorId: 'neighbor-a', amount: 0.001, consumptionId: 'eat:4:neighbor-a' }));
  emitObserved(world, 'inventions.take-food', () => ({ kind: 'structure-food-debit', structureId: 'roof-b',
    actorId: 'neighbor-a', amount: 0.001, consumptionId: 'eat:4:neighbor-a' }));
  emitObserved(world, 'index.food-applied', () => ({ kind: 'food-applied', actorId: 'neighbor-a',
    consumptionId: 'eat:4:neighbor-a', fromStructure: 0.002, totalConsumed: 0.002,
    hungerBefore: 0.6, hungerAfter: 0.58 }));
  markObservationAttempt(world, 'adopted');
  const records = projectObservedEvents(observedEvents(session), { gaps: [], attemptHistory: session.attemptHistory }).records;
  assert.equal(records.filter(record => record.family === 'flow').length, 2);
  const services = records.filter(record => record.family === 'service');
  assert.equal(services.length, 1);
  if (services[0]?.family !== 'service') throw new Error('Expected service');
  assert.deepEqual(services[0].payload.consumptionRefs, ['eat:4:neighbor-a']);
  assert.equal(services[0].payload.subjectId, 'neighbor-a');
  unbindObservation(world);
});
