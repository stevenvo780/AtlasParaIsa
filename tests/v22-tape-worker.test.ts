import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorld } from '../src/world/index.js';
import { parseParams } from '../src/world/params.js';
import { projectMirrorWorld } from '../src/server/sim-worker.js';
import { TapeReader, TapeWriter, tapePathForWorld } from '../src/server/tape-store.js';
import { Store } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';
import { createWorkerGateway } from '../src/server/gateway.js';
import { applyClientTapeDelta, indexTiles, type TapeChunkResponse } from '../src/shared/tape.js';
import type { Tile, Viewport, WorldView } from '../src/shared/types.js';

const params = parseParams('motor.hilos=1,persistencia.cadaTicks=200');
const background = (x: number, y: number): Tile => ({ x, y, terrain: 'meadow', moisture: 0.4, vegetation: 0.7, food: 0.3 });
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const template = wire(projectMirrorWorld(createWorld(42, params)));

function directory(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'v22-tape-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Public categories change independently, including crossing viewport margins and optional unsets. */
function frameAt(tick: number): WorldView {
  const view = wire(template);
  const era = Math.floor(tick / 10);
  view.tick = view.sequence = tick;
  view.day = 1 + Math.floor(tick / 24);
  view.performance = { stepMs: tick / 100, p95StepMs: 2, saveMs: 1, projectionMs: 0.1, snapshotBytes: 200,
    activeTiles: 16, processRssMiB: 10, tickHz: 60, fraccionSerial: 1,
    fases: { maintainRegions: 0, ecologia: 0, kernel: 0, fauna: 0, personas: 0, encuentros: 0,
      demografia: 0, comunidades: 0, reproduccion: 0, checkpoint: 0, muestreo: 0, save: 0, broadcast: 0 } };
  view.demography!.deaths = era;
  view.phase = tick % 2 ? 'day' : 'night';
  view.weather = era % 2 ? 'rain' : 'clear';
  view.tiles = [background(0, 0), { ...background(1, 0), food: tick / 1000 }, background(2, 0)];
  if (tick % 3) view.tiles.push({ ...background(-1, -1), paved: 1 });
  if (tick % 9 === 0) view.tiles.reverse();
  view.people = [
    { ...view.people[0]!, id: 'p0', x: 0, y: 0, energy: 0.8 - tick / 1000 },
    { ...view.people[1]!, id: 'p1', x: era % 2 ? 20 : 1, y: 1 },
  ];
  if (era % 2) delete view.people[0]!.health;
  if (era % 3 === 1) view.people.push({ ...view.people[0]!, id: 'arrival' });
  if (tick % 7 === 0) view.people.reverse();
  view.animals = template.animals?.slice(0, 2).map((a, i) => ({ ...a, id: `a${i}`, x: i ? (era % 2 ? 20 : 1) : tick / 100, y: 0 }));
  if (era % 4 === 1) delete view.animals;
  view.structures = [{ id: 's0', blueprintId: 'b0', name: 'Refugio', x: 0, y: 0,
    components: ['frame'], condition: 1 - tick / 1000, water: era, food: 2, uses: 1, builtAt: 0, builderId: 'p0' }];
  if (era % 2) view.structures.push({ ...view.structures[0]!, id: 's1', blueprintId: 'b1', x: 20,
    cells: [{ x: 0, y: 1 }] });
  if (era % 4 === 2) delete view.structures;
  view.blueprints = ['b0', 'b1'].map(id => ({ id, name: id, components: ['frame'], generation: 1,
    parents: [], inventorId: 'p0', tick: 0, uses: era, usefulness: 1, cost: { wood: 1, stone: 0, work: 2 } }));
  if (era % 4 === 3) delete view.blueprints;
  view.places = [{ id: 'place', x: era % 2 ? 20 : 0, y: 0, name: `Lugar ${era}`, description: 'Claro', gatherings: era }];
  view.communities = [{ id: 'c0', name: 'Comunidad', x: 0, y: 0, color: '#fff',
    members: view.people.map(p => p.id), memberCount: view.people.length, culture: { sharing: 0.5, stewardship: 0.4, openness: 0.3 },
    formedAt: 0, cooperation: era, disputes: 0 }];
  if (era % 4 === 1) view.communities = [];
  if (era % 4 === 2) delete view.communities;
  const capacities = { cutting: 1, storage: 2, insulation: 0, cultivation: 0, binding: 0, abrasion: 0 };
  view.technology!.recipes = [{ id: 'r0', name: 'Cuenco', generation: 1, capacities }];
  if (era % 2) view.technology!.recipes.unshift({ id: 'r1', name: 'Otro', generation: 2, capacities });
  view.technology!.items = view.people.map(p => ({ id: `i-${p.id}`, ownerId: p.id, x: p.x, y: p.y,
    recipeId: 'r0', mass: era + 1, generation: 1, capacities }));
  view.technology!.knowledge = view.people.map(p => ({ actorId: p.id, recipeIds: ['r0'] }));
  if (era % 3 === 1) delete view.technology!.knowledge;
  if (era % 5 === 1) delete view.technology;
  view.stats!.population = view.people.length;
  view.stats!.history = Array.from({ length: 240 }, (_, i) => ({ tick: i, population: 32, energy: 0.8, hunger: 0.2,
    fatigue: 0.1, thirst: 0.1, discoveries: 2, settlements: 0, cooperation: 0.5, births: 0 }));
  view.stats!.statsTick = era;
  if (era % 2) delete view.stats!.statsTick;
  if (era % 5 === 2) delete view.stats;
  view.events = Array.from({ length: Math.min(4, era + 1) }, (_, i) => ({ id: `e${era - i}`, tick: (era - i) * 10,
    kind: 'ecology', actors: [], text: `Evento ${era - i}`, cause: 'Prueba', source: 'simulation' }));
  if (tick === 61) view.events[0]!.text = 'Evento corregido';
  if (era % 2) { view.paused = false; view.pauseReason = 'Prueba'; }
  else { delete view.paused; delete view.pauseReason; delete view.chemistry; delete view.organization; }
  if (era % 3 === 2) delete view.performance;
  return view;
}

function expand(chunk: TapeChunkResponse): WorldView[] {
  if (!chunk.baseFrame) return [];
  const frames = [chunk.baseFrame], tileIndex = indexTiles(chunk.baseFrame.tiles);
  for (const delta of chunk.deltas!) frames.push(applyClientTapeDelta(frames.at(-1)!, delta, tileIndex).frame);
  return frames;
}

test('delta reconstructs 90 frames exactly across keyframes, clipping, tile reversions, ordering and unsets', t => {
  const path = join(directory(t), 'tape.sqlite');
  const writer = new TapeWriter({ path, keyframeInterval: 17, batchSize: 200 });
  for (let tick = 0; tick < 125; tick++) writer.record(frameAt(tick), 60);
  writer.close();
  const reader = new TapeReader({ path });
  t.after(() => reader.close());
  const cameras: (Viewport | undefined)[] = [undefined, { x: -2, y: -2, width: 8, height: 6 }, { x: 0, y: 0, width: 96, height: 64 }];
  for (const viewport of cameras) {
    for (const start of [0, 13, 35]) {
      const full = reader.readChunk(start, 90, viewport, background);
      let backgrounds = 0;
      const delta = reader.readChunk(start, 90, viewport, (x, y) => { backgrounds++; return background(x, y); }, 'delta');
      assert.equal(delta.encoding, 'delta'); assert.deepEqual(delta.frames, []);
      assert.equal(delta.deltas!.length, 89);
      assert.deepEqual(expand(delta), full.frames, `camera=${JSON.stringify(viewport)}, start=${start}`);
      assert.deepEqual({ ...delta, frames: full.frames, encoding: undefined, baseFrame: undefined, deltas: undefined },
        { ...full, encoding: undefined, baseFrame: undefined, deltas: undefined });
      assert.ok(backgrounds <= (viewport ? viewport.width * viewport.height + 90 : 0), `background generated once plus reversions (${backgrounds})`);
      assert.ok(delta.deltas!.every(d => (d.tilesPatch?.length ?? 0) <= 4));
      assert.ok(delta.deltas!.some(d => d.unset?.length));
      assert.ok(delta.deltas!.some(d => d.techPatch));
      assert.ok(delta.deltas!.some(d => d.statsPatch));
    }
  }
  assert.deepEqual(expand(reader.readChunk(124, 90, undefined, undefined, 'delta')), reader.readChunk(124, 90).frames);
  const empty = reader.readChunk(999, 90, undefined, undefined, 'delta');
  assert.equal(empty.encoding, 'delta'); assert.equal(empty.baseFrame, undefined); assert.deepEqual(empty.deltas, []);
});

test('96×64 delta chunk is at least 10× smaller and avoids repeated background projection', t => {
  const path = join(directory(t), 'tape.sqlite');
  const writer = new TapeWriter({ path, keyframeInterval: 60, batchSize: 100 });
  for (let tick = 0; tick < 90; tick++) writer.record(frameAt(tick), 60);
  writer.close();
  const viewport = { x: 0, y: 0, width: 96, height: 64 };
  function measure(encoding: 'full' | 'delta') {
    const reader = new TapeReader({ path });
    let calls = 0;
    const start = performance.now();
    const result = reader.readChunk(0, 90, viewport, (x, y) => { calls++; return background(x, y); }, encoding);
    const ms = performance.now() - start;
    reader.close();
    return { bytes: Buffer.byteLength(JSON.stringify(result)), ms, calls };
  }
  const full = measure('full'), delta = measure('delta');
  t.diagnostic(JSON.stringify({ full, delta, sizeRatio: full.bytes / delta.bytes, readSpeedup: full.ms / delta.ms }));
  assert.ok(full.bytes >= delta.bytes * 10);
  assert.ok(delta.calls < 6144 + 90);
  assert.ok(full.calls > delta.calls * 50);
});

/** Real HTTP parser over in-memory duplex sockets, also usable in a sandbox without TCP bind. */
function http(server: import('node:http').Server) {
  let cookie = '';
  function connection(): Socket {
    class Endpoint extends Duplex {
      peer!: Endpoint;
      remoteAddress = '127.0.0.1';
      _read() {}
      _write(data: Buffer, _encoding: BufferEncoding, done: () => void) {
        queueMicrotask(() => { if (!this.peer.destroyed) this.peer.push(Buffer.from(data)); }); done();
      }
      _final(done: () => void) { queueMicrotask(() => this.peer.push(null)); done(); }
      setTimeout() { return this; }
      setNoDelay() { return this; }
      setKeepAlive() { return this; }
    }
    const client = new Endpoint(), remote = new Endpoint(); client.peer = remote; remote.peer = client;
    server.emit('connection', remote);
    return client as unknown as Socket;
  }
  return async (path: string, body?: unknown) => new Promise<{ status: number; value: any }>((resolve, reject) => {
    const req = request({ host: 'localhost', path, method: body ? 'POST' : 'GET', createConnection: connection,
      headers: { Host: 'carta.test', Origin: 'https://carta.test', Cookie: cookie, Connection: 'close', 'Content-Type': 'application/json' } }, res => {
      const parts: Buffer[] = [];
      if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0]!.split(';')[0]!;
      res.on('data', part => parts.push(part));
      res.on('end', () => resolve({ status: res.statusCode!, value: JSON.parse(Buffer.concat(parts).toString()) }));
    });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}

test('HTTP full/delta validation in createApp and gateway; async writer flush and shutdown lose no ticks', { timeout: 30_000 }, async t => {
  const dir = directory(t);
  const worldPath = join(dir, 'worker.sqlite');
  const gateway = createWorkerGateway({ worldPath, params, seed: 42, manual: true, turbo: true, tape: true,
    origin: 'https://carta.test', password: 'v22-test-password', tapeKeyframeInterval: 17 });
  t.after(() => gateway.close());
  await gateway.ready;
  assert.deepEqual(await gateway.flushTape(), { enabled: true, frames: 1, latestTick: 0 });
  const workerHttp = http(gateway.server);
  assert.equal((await workerHttp('/api/login', { password: 'v22-test-password' })).status, 200);
  gateway.start();
  await delay(1500);
  const flushed = await gateway.flushTape();
  assert.ok(flushed.latestTick > 30, `turbo advances smoothly (${flushed.latestTick} ticks)`);
  assert.equal(flushed.frames, flushed.latestTick + 1);
  const reader = new TapeReader({ path: tapePathForWorld(worldPath) });
  assert.ok(reader.readMeta().maxTick >= flushed.latestTick, 'flush is a durable FIFO barrier');
  reader.close();

  const store = new Store(join(dir, 'app.sqlite'));
  const app = createApp({ store, params, seed: 42, manual: true, tape: true, origin: 'https://carta.test', password: 'v22-test-password' });
  t.after(async () => { try { await app.close(); } finally { store.close(); } });
  const appHttp = http(app.server);
  assert.equal((await appHttp('/api/login', { password: 'v22-test-password' })).status, 200);
  for (const query of [appHttp, workerHttp]) {
    const res = await query('/api/tape/chunk?fromTick=0&count=10&encoding=delta');
    assert.equal(res.status, 200); assert.equal(res.value.encoding, 'delta');
    assert.ok(res.value.baseFrame); assert.ok(Array.isArray(res.value.deltas)); assert.deepEqual(res.value.frames, []);
    const full = await query('/api/tape/chunk?fromTick=0&count=1&encoding=full');
    assert.equal(full.status, 200); assert.equal(full.value.frames.length, 1);
    for (const encoding of ['bogus', '', 'DELTA']) assert.equal((await query(`/api/tape/chunk?encoding=${encoding}`)).status, 400);
  }
  await gateway.close();
  assert.equal(gateway.workerExited, true);
  const saved = new Store(worldPath, { readOnly: true });
  const finalTick = saved.load()!.world.tick; saved.close();
  const finalReader = new TapeReader({ path: tapePathForWorld(worldPath) });
  try {
    const meta = finalReader.readMeta();
    assert.ok(finalTick >= flushed.latestTick);
    assert.equal(meta.maxTick, finalTick); assert.equal(meta.totalFrames, finalTick + 1);
    for (let start = 0; start <= finalTick; start += 90) {
      const frames = expand(finalReader.readChunk(start, 90, undefined, undefined, 'delta'));
      frames.forEach((frame, i) => assert.equal(frame.tick, start + i));
    }
  } finally { finalReader.close(); }
  await assert.rejects(gateway.flushTape());
});

test('turbo persistence honors tick cadence AND wall time, but gestures and close save immediately', async t => {
  for (const interval of [undefined, 100, 0]) {
    const store = new Store(join(directory(t), 'world.sqlite'));
    let clock = 0, saves = 0;
    const save = store.save.bind(store);
    store.save = (...args: Parameters<Store['save']>) => { saves++; return save(...args); };
    const app = createApp({ store, params: parseParams('motor.hilos=1,persistencia.cadaTicks=2'), manual: true,
      turbo: true, tape: false, turboSaveIntervalMs: interval, monotonicNow: () => clock,
      seed: 42, origin: 'https://carta.test', password: 'v22-test-password' });
    t.after(async () => { try { await app.close(); } finally { store.close(); } });
    assert.equal(saves, 1, 'initial save bypasses the minimum interval');
    app.stepOnce(); app.stepOnce();
    assert.equal(saves, interval === 0 ? 2 : 1, 'tick cadence alone is insufficient in turbo');
    clock = interval ?? 30_000;
    const before = saves;
    app.stepOnce(); assert.equal(saves, before, 'wall time alone is insufficient');
    app.stepOnce(); assert.equal(saves, before + 1);
    store.addSession('test-session', Date.now() + 60_000);
    const gesture = app.requestGesture({ id: 'v22-gesture-0001', kind: 'plant', x: 20, y: 14 }, 'test-session');
    const beforeGesture = saves;
    app.stepOnce(); await gesture;
    assert.equal(saves, beforeGesture + 1, 'gesture persists outside cadence and minimum interval');
    const beforeClose = saves;
    await app.close(); assert.equal(saves, beforeClose + 1, 'close persists immediately');
    assert.equal(store.load()!.world.tick, app.world.tick);
  }
});
