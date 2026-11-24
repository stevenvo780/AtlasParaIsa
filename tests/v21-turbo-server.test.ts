/**
 * V21 — Uncapped turbo loop, DVR tape API and observer-only mode on the real HTTP/WS server.
 *
 * The tape store in this branch may be the in-memory stub (one store per thread) or the SQLite WAL
 * implementation. Every assertion about the worker-side recording goes through `flushTape()` (an RPC
 * answered by the worker's own TapeWriter), so it holds for both. Frames read back by the gateway's
 * TapeReader (main thread) are required when the tape file exists on disk (SQLite); with the stub the
 * same-thread `createApp` tests below prove the content end to end.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import { gunzipSync } from 'node:zlib';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { WebSocket } from 'ws';
import { createWorkerGateway, type WorkerGatewayOptions } from '../src/server/gateway.js';
import { createApp, MENSAJE_MODO_OBSERVADOR, type AppOptions } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { TapeReader, tapePathForWorld } from '../src/server/tape-store.js';
import { parseParams } from '../src/world/params.js';
import type { TapeChunkResponse, TapeMetaResponse } from '../src/shared/tape.js';
import type { WorldView } from '../src/shared/types.js';

const origin = 'https://carta.test', password = 'private-v21-turbo-password';
const params = parseParams('motor.hilos=1,persistencia.cadaTicks=200');
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
type Response = { status: number; headers: IncomingHttpHeaders; body: Buffer; text: string; json(): any };
type Server = { server: import('node:http').Server };

/** Real Node HTTP parser and ws framing; falls back to in-memory sockets when TCP bind is denied. */
function harness(t: TestContext, getServer: () => Server) {
  let port = 0, cookie = '', memory = false;
  function connection(): Socket {
    class Endpoint extends Duplex {
      peer!: Endpoint;
      remoteAddress = '127.0.0.1';
      _read() {}
      _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
        queueMicrotask(() => { if (!this.peer.destroyed) this.peer.push(Buffer.from(chunk)); }); done();
      }
      _final(done: () => void) { queueMicrotask(() => this.peer.push(null)); done(); }
      setTimeout() { return this; }
      setNoDelay() { return this; }
      setKeepAlive() { return this; }
      ref() { return this; }
      unref() { return this; }
      address() { return { address: '127.0.0.1', port: 80, family: 'IPv4' }; }
    }
    const client = new Endpoint(), server = new Endpoint(); client.peer = server; server.peer = client;
    getServer().server.emit('connection', server);
    return client as unknown as Socket;
  }
  return {
    async listen() {
      const { server } = getServer();
      try {
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
        port = (server.address() as { port: number }).port; memory = false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
        memory = true; port = 80; t.diagnostic('TCP listen denied by sandbox: using in-memory HTTP/WS connections.');
      }
    },
    http(path: string, value?: unknown, headers: Record<string, string> = {}, method = value === undefined ? 'GET' : 'POST') {
      return new Promise<Response>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port, path, method,
          ...(memory ? { createConnection: connection } : {}),
          headers: { Host: 'carta.test', Origin: origin, ...(cookie ? { Cookie: cookie } : {}), Connection: 'close',
            ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers } }, res => {
          const parts: Buffer[] = [];
          res.on('data', part => parts.push(part));
          res.on('end', () => {
            const raw = Buffer.concat(parts);
            const body = res.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw;
            const text = body.toString();
            resolve({ status: res.statusCode!, headers: res.headers, body: raw, text, json: () => JSON.parse(text) });
          });
        });
        req.on('error', reject); if (value !== undefined) req.write(JSON.stringify(value)); req.end();
      });
    },
    async login() {
      const res = await this.http('/api/login', { password }); assert.equal(res.status, 200, res.text);
      cookie = res.headers['set-cookie']![0]!.split(';')[0]!;
    },
    logout() { cookie = ''; },
    async socket() {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ack=1&x=12&y=8&width=20&height=20`,
        { headers: { Host: 'carta.test', Origin: origin, Cookie: cookie }, perMessageDeflate: false,
          ...(memory ? { createConnection: connection } : {}) });
      const errors: string[] = [], errorWaiters: ((message: string) => void)[] = [];
      let chunks = 0, parts: string[] = [];
      ws.on('message', data => {
        let text = data.toString();
        if (chunks) { parts.push(text); if (--chunks) return; text = parts.join(''); parts = []; }
        const message = JSON.parse(text);
        if (message.type === 'trozos') { chunks = message.partes; return; }
        if (message.type === 'state') ws.send(JSON.stringify({ type: 'ack', sequence: (message.world as WorldView).sequence }));
        if (message.type === 'error') { const waiter = errorWaiters.shift(); if (waiter) waiter(message.message); else errors.push(message.message); }
      });
      t.after(() => ws.terminate());
      await once(ws, 'open');
      return { ws, nextError: () => errors.length ? Promise.resolve(errors.shift()!) : new Promise<string>(resolve => errorWaiters.push(resolve)) };
    },
  };
}

type Gateway = ReturnType<typeof createWorkerGateway>;
async function gatewayFixture(t: TestContext, overrides: Partial<WorkerGatewayOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'carta-v21-'));
  const staticDir = join(dir, 'client'); mkdirSync(staticDir);
  writeFileSync(join(staticDir, 'index.html'), '<html>v21</html>');
  const worldPath = join(dir, 'world.sqlite');
  let app!: Gateway;
  const h = harness(t, () => app);
  t.after(async () => { try { await app?.close(); } finally { rmSync(dir, { recursive: true, force: true }); } });
  app = createWorkerGateway({ worldPath, staticDir, origin, secure: true, password, seed: 42, params, manual: true, tickMs: 40, ...overrides });
  await app.ready;
  await h.listen();
  return { ...h, app, worldPath, tapeOnDisk: () => existsSync(tapePathForWorld(worldPath)) };
}

async function appFixture(t: TestContext, overrides: Partial<AppOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'carta-v21-app-'));
  const worldPath = join(dir, 'world.sqlite');
  const store = new Store(worldPath);
  const app = createApp({ store, password, origin, secure: true, seed: 42, params, manual: true, ...overrides });
  const h = harness(t, () => app);
  t.after(async () => { try { await app.close(); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); } });
  await h.listen();
  return { ...h, app, store, worldPath };
}

test('turbo worker: uncapped loop advances many ticks per second, tape records every tick, mirror is throttled', { timeout: 20_000 }, async t => {
  const f = await gatewayFixture(t, { turbo: true, tape: true });
  await f.login();
  let mirrors = 0;
  f.app.events.on('mirror', () => { mirrors++; });
  const before = await f.app.flushTape();
  assert.equal(before.enabled, true);
  assert.equal(before.frames, 1, 'the initial frame is recorded before ready');
  f.app.start();
  const started = performance.now();
  await wait(2000);
  const after = await f.app.flushTape();
  const elapsed = performance.now() - started;
  const ticks = after.latestTick - before.latestTick;
  t.diagnostic(`turbo: ${ticks} ticks in ${elapsed.toFixed(0)} ms, ${mirrors} mirror posts, ${after.frames} tape frames`);
  assert.ok(ticks > 30, `more than 30 ticks in ~2 s with tickMs=0 (got ${ticks})`);
  assert.equal(after.frames, after.latestTick + 1, 'one tape frame per simulated tick, none skipped');
  // At most one post per 250 ms (+ the initial post and scheduling slack): far fewer than ticks.
  assert.ok(mirrors <= Math.ceil(elapsed / 250) + 2, `mirror throttled to 250 ms (got ${mirrors} posts in ${elapsed.toFixed(0)} ms)`);
  assert.ok(mirrors >= 2, 'the live mirror keeps moving while turbo runs');
  const world = (await f.http('/api/world?x=12&y=8&width=20&height=20')).json() as WorldView;
  assert.ok(world.tick > 0);
  assert.ok(world.performance!.tickHz > 0, 'simHz is published in runtime.tickHz');
  assert.equal(world.performance!.tickHzObjetivo, 0, 'turbo has no target rate');
});

test('turbo worker: DVR tape endpoints are private, validated, gzip-aware and never stall the simulation', { timeout: 20_000 }, async t => {
  const f = await gatewayFixture(t, { turbo: true });
  for (const path of ['/api/tape/meta', '/api/tape/chunk?fromTick=0&count=10']) assert.equal((await f.http(path)).status, 401, path);
  await f.login();
  const session = (await f.http('/api/session')).json();
  assert.deepEqual(session, { authenticated: true, tapeEnabled: true, turbo: true }, 'tape follows turbo by default');
  f.app.start();
  await wait(600);
  const { latestTick: tickBefore } = await f.app.flushTape();
  const metaRes = await f.http('/api/tape/meta');
  assert.equal(metaRes.status, 200, metaRes.text);
  const meta = metaRes.json() as TapeMetaResponse;
  assert.equal(meta.enabled, true); assert.equal(meta.turbo, true); assert.equal(meta.observerOnly, false);
  assert.ok(Array.isArray(meta.timeline) && meta.timeline.length <= 240);
  const onDisk = f.tapeOnDisk();
  if (onDisk) {
    assert.ok(meta.totalFrames > 0 && meta.maxTick >= meta.minTick, 'the gateway reads the worker-written tape');
  } else t.diagnostic('tape store is the in-memory stub: the gateway thread sees its own (empty) tape; content is covered by the createApp tests.');
  const plain = await f.http(`/api/tape/chunk?fromTick=${meta.minTick}&count=20`);
  assert.equal(plain.status, 200, plain.text); assert.equal(plain.headers['content-encoding'], undefined);
  const chunk = plain.json() as TapeChunkResponse;
  assert.ok(Array.isArray(chunk.frames) && chunk.frames.length <= 20);
  const gz = await f.http(`/api/tape/chunk?fromTick=${meta.minTick}&count=20&x=12&y=8&width=20&height=20`, undefined, { 'Accept-Encoding': 'gzip' });
  assert.equal(gz.status, 200, gz.text);
  assert.equal(gz.headers['content-encoding'], 'gzip'); assert.equal(gz.headers.vary, 'Accept-Encoding');
  const clipped = gz.json() as TapeChunkResponse;
  if (onDisk) {
    assert.ok(chunk.frames.length > 0 && clipped.frames.length > 0);
    for (const frame of clipped.frames) {
      assert.equal(frame.originX, 12); assert.equal(frame.originY, 8);
      assert.ok(frame.tiles.every(tile => tile.x >= 12 && tile.x < 32 && tile.y >= 8 && tile.y < 28));
    }
  }
  for (const bad of ['count=0', 'count=241', 'fromTick=-1', 'fromTick=1.5', 'count=abc', 'x=1&y=2', 'x=0&y=0&width=500&height=10']) {
    assert.equal((await f.http(`/api/tape/chunk?${bad}`)).status, 400, bad);
  }
  // Scrubbing reads the tape only: the worker keeps stepping while a burst of chunk requests is served.
  await Promise.all(Array.from({ length: 12 }, (_, i) => f.http(`/api/tape/chunk?fromTick=${i * 3}&count=60&x=0&y=0&width=40&height=28`, undefined, { 'Accept-Encoding': 'gzip' })));
  await wait(300);
  const { latestTick: tickAfter } = await f.app.flushTape();
  assert.ok(tickAfter > tickBefore + 5, `simulation kept advancing during scrubbing (${tickBefore} → ${tickAfter})`);
});

test('observer-only: session advertises flags, direct NPC orders get 410 over HTTP and WS, other gestures still apply', { timeout: 20_000 }, async t => {
  const f = await gatewayFixture(t, { observerOnly: true, turbo: true, tape: true });
  assert.deepEqual((await f.http('/api/session')).json(), { authenticated: false, observerOnly: true, tapeEnabled: true, turbo: true });
  await f.login();
  assert.deepEqual((await f.http('/api/session')).json(), { authenticated: true, observerOnly: true, tapeEnabled: true, turbo: true });
  f.app.start();
  const order = await f.http('/api/gesture', { id: 'observer-order-01', kind: 'order', x: 20, y: 14, agentId: 'p1', order: 'gather' });
  assert.equal(order.status, 410, order.text);
  assert.equal(order.json().error, MENSAJE_MODO_OBSERVADOR);
  const command = await f.http('/api/gesture', { id: 'observer-command-01', kind: 'command', x: 20, y: 14, agentId: 'p1', order: 'gather' });
  assert.equal(command.status, 410, command.text);
  assert.equal((await f.http('/api/gestures', { id: 'observer-command-02', kind: 'command', x: 20, y: 14, agentId: 'p1', order: 'rest' })).status, 410);
  const plant = await f.http('/api/gesture', { id: 'observer-plant-0001', kind: 'plant', x: 20, y: 14 });
  assert.equal(plant.status, 200, plant.text);
  assert.equal(plant.json().id, 'observer-plant-0001');
  const socket = await f.socket();
  socket.ws.send(JSON.stringify({ type: 'gesture', gesture: { id: 'observer-ws-order-1', kind: 'command', x: 20, y: 14, agentId: 'p1', order: 'move' } }));
  assert.equal(await socket.nextError(), MENSAJE_MODO_OBSERVADOR);
  socket.ws.send(JSON.stringify({ type: 'gesture', gesture: { id: 'observer-ws-order-2', kind: 'order', x: 20, y: 14 } }));
  assert.equal(await socket.nextError(), MENSAJE_MODO_OBSERVADOR);
  assert.equal(socket.ws.readyState, WebSocket.OPEN, 'a rejected order does not drop the connection');
});

test('classic gateway: no V21 flags in the session and no tape endpoints', { timeout: 15_000 }, async t => {
  const f = await gatewayFixture(t);
  assert.deepEqual((await f.http('/api/session')).json(), { authenticated: false });
  await f.login();
  assert.deepEqual((await f.http('/api/session')).json(), { authenticated: true });
  assert.equal((await f.http('/api/tape/meta')).status, 404);
  assert.equal((await f.http('/api/tape/chunk?fromTick=0')).status, 404);
  assert.deepEqual(await f.app.flushTape(), { enabled: false, frames: 0, latestTick: -1 });
});

test('turbo worker: graceful shutdown flushes the tape and joins the worker', { timeout: 20_000 }, async t => {
  const f = await gatewayFixture(t, { turbo: true });
  await f.login();
  f.app.start();
  await wait(700);
  const recorded = await f.app.flushTape();
  assert.ok(recorded.frames > 1);
  await f.app.close();
  assert.equal(f.app.workerExited, true);
  assert.equal(f.app.workerThreadId, -1);
  await f.app.close(); // idempotent
  await assert.rejects(f.app.flushTape(), 'no RPC after the worker exited');
  const saved = new Store(f.worldPath, { readOnly: true });
  let savedTick: number;
  try { savedTick = saved.load()!.world.tick; } finally { saved.close(); }
  assert.ok(savedTick >= recorded.latestTick, 'the world was saved at or after the last flushed frame');
  if (f.tapeOnDisk()) {
    const reader = new TapeReader({ path: tapePathForWorld(f.worldPath), turbo: true });
    try {
      const meta = reader.readMeta(10);
      assert.equal(meta.maxTick, savedTick, 'every buffered frame up to the final tick reached disk on close');
    } finally { reader.close(); }
  }
});

test('createApp turbo + tape: same-thread DVR content, viewport clipping, gzip, simHz and no leaked immediates', { timeout: 20_000 }, async t => {
  const resources = () => process.getActiveResourcesInfo().filter(kind => kind === 'Immediate').length;
  const baseline = resources();
  const f = await appFixture(t, { turbo: true });
  await f.login();
  assert.deepEqual((await f.http('/api/session')).json(), { authenticated: true, tapeEnabled: true, turbo: true });
  const tick0 = f.app.world.tick;
  f.app.start();
  f.app.start(); // idempotent: never two loops
  const started = performance.now();
  await wait(1500);
  const ticks = f.app.world.tick - tick0, elapsed = performance.now() - started;
  t.diagnostic(`createApp turbo: ${ticks} ticks in ${elapsed.toFixed(0)} ms, tickHz=${f.app.runtime.tickHz.toFixed(1)}`);
  assert.ok(ticks > 20, `uncapped loop advanced ${ticks} ticks`);
  assert.ok(f.app.runtime.tickHz > 0);
  assert.equal(f.app.runtime.tickHzObjetivo, 0);
  const meta = (await f.http('/api/tape/meta')).json() as TapeMetaResponse;
  assert.equal(meta.enabled, true); assert.equal(meta.turbo, true);
  assert.equal(meta.minTick, tick0, 'the tape starts at the initial frame');
  assert.ok(meta.maxTick >= tick0 + ticks - 1 && meta.totalFrames >= ticks, JSON.stringify({ ...meta, timeline: meta.timeline.length }));
  assert.ok(meta.timeline.length > 0 && meta.timeline.length <= 240);
  const res = await f.http(`/api/tape/chunk?fromTick=${tick0}&count=30&x=10&y=6&width=24&height=16`, undefined, { 'Accept-Encoding': 'gzip' });
  assert.equal(res.status, 200, res.text); assert.equal(res.headers['content-encoding'], 'gzip');
  const chunk = res.json() as TapeChunkResponse;
  assert.equal(chunk.frames.length, 30);
  assert.equal(chunk.fromTick, tick0); assert.equal(chunk.toTick, tick0 + 29);
  assert.equal(chunk.hasMore, true);
  for (let i = 1; i < chunk.frames.length; i++) assert.equal(chunk.frames[i]!.tick, chunk.frames[i - 1]!.tick + 1, 'tick-by-tick history');
  const first = chunk.frames[0]!;
  assert.equal(first.originX, 10); assert.equal(first.width, 24);
  assert.ok(first.tiles.length > 0 && first.tiles.every(tile => tile.x >= 10 && tile.x < 34 && tile.y >= 6 && tile.y < 22));
  assert.equal(typeof first.geologyKey, 'number');
  assert.ok(first.instanceId && first.performance && first.stats && first.demography && first.technology);
  assert.ok(first.people.every(p => p.x >= 9 && p.x < 35 && p.y >= 5 && p.y < 23));
  await f.app.close();
  assert.equal(resources(), baseline, 'close() cancels the pending setImmediate of the turbo loop');
  const closedTick = f.app.world.tick;
  await wait(50);
  assert.equal(f.app.world.tick, closedTick, 'no step after close');
  // The writer flushed on close: a fresh reader sees the final tick.
  const reader = new TapeReader({ path: tapePathForWorld(f.worldPath) });
  try { assert.equal(reader.readMeta(10).maxTick, closedTick); } finally { reader.close(); }
});

test('createApp observer-only (classic speed): orders rejected in requestGesture too, gestures step without cloning', { timeout: 15_000 }, async t => {
  const f = await appFixture(t, { observerOnly: true });
  await f.login();
  assert.deepEqual((await f.http('/api/session')).json(), { authenticated: true, observerOnly: true });
  assert.equal((await f.http('/api/tape/meta')).status, 404);
  assert.throws(() => f.app.requestGesture({ id: 'observer-direct-01', kind: 'command', x: 1, y: 1, agentId: 'p1', order: 'rest' }, 'any'),
    (error: Error & { status?: number }) => error.status === 410 && error.message === MENSAJE_MODO_OBSERVADOR);
  const pending = f.http('/api/gesture', { id: 'observer-plant-app-1', kind: 'plant', x: 20, y: 14 });
  while (f.app.gestosPendientes === 0) await wait(5);
  const tick = f.app.world.tick;
  f.app.stepOnce();
  const result = await pending;
  assert.equal(result.status, 200, result.text);
  assert.equal(f.app.world.tick, tick + 1);
  assert.equal(f.app.failed, false);
  // The step with a gesture keeps its undo with a restoration point, never a world copy: the world
  // object that existed before the step is still the live one (`cloneWorld` would have replaced it).
  const live = f.app.world;
  const second = f.http('/api/gesture', { id: 'observer-plant-app-2', kind: 'plant', x: 21, y: 14 });
  while (f.app.gestosPendientes === 0) await wait(5);
  f.app.stepOnce();
  assert.equal((await second).status, 200);
  assert.equal(f.app.world, live, 'observer-only steps run in place, never on a cloned world');
});

test('createApp turbo with tape explicitly off: uncapped loop, no tape writer, no tape endpoints', { timeout: 15_000 }, async t => {
  const f = await appFixture(t, { turbo: true, tape: false });
  await f.login();
  assert.deepEqual((await f.http('/api/session')).json(), { authenticated: true, turbo: true });
  assert.equal((await f.http('/api/tape/meta')).status, 404);
  const tick0 = f.app.world.tick;
  f.app.start();
  await wait(500);
  assert.ok(f.app.world.tick - tick0 > 10, 'still uncapped');
  await f.app.close();
  // Nothing was ever recorded under this world's tape path (the sim worker relies on this to own the only writer).
  let frames = 0;
  try {
    const reader = new TapeReader({ path: tapePathForWorld(f.worldPath) });
    try { frames = reader.readMeta(10).totalFrames; } finally { reader.close(); }
  } catch { /* a file-backed store has no tape file to open: nothing was recorded either */ }
  assert.equal(frames, 0);
});
