import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { once } from 'node:events';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { WebSocket } from 'ws';
import { createWorkerGateway, type WorkerGatewayOptions } from '../src/server/gateway.js';
import { Store } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';
import { createWorld, stepWorld, projectWorld } from '../src/world/index.js';
import { parseParams } from '../src/world/params.js';
import { applyStateDelta } from '../src/shared/deltas.js';
import type { Gesture, WorldView } from '../src/shared/types.js';

const origin = 'https://carta.test', password = 'private-worker-test-password';
const params = parseParams('red.deltas=true,motor.hilos=1,persistencia.cadaTicks=200');
type Gateway = ReturnType<typeof createWorkerGateway>;
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
async function fixture(t: TestContext, overrides: Partial<WorkerGatewayOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'carta-worker-'));
  const staticDir = join(dir, 'client'); mkdirSync(staticDir);
  writeFileSync(join(staticDir, 'index.html'), '<html>' + 'read-only gateway '.repeat(300) + '</html>');
  const worldPath = join(dir, 'world.sqlite');
  let app: Gateway;
  let port = 0, cookie = '', memory = false;
  // Real Node HTTP parser and real ws framing, without a TCP bind when the sandbox denies it.
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
    app.server.emit('connection', server);
    return client as unknown as Socket;
  }
  const boot = async (extra: Partial<WorkerGatewayOptions> = {}) => {
    app = createWorkerGateway({ worldPath, staticDir, origin, extraOrigins: ['https://lan.test'], secure: true,
      password, seed: 42, params, manual: true, tickMs: 40, ...overrides, ...extra });
    await app.ready;
    try {
      app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
      port = (app.server.address() as { port: number }).port;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      memory = true; port = 80; t.diagnostic('TCP listen denied by sandbox: using in-memory HTTP/WS connections.');
    }
  };
  const http = (path: string, value?: unknown, headers: Record<string, string> = {}, method = value === undefined ? 'GET' : 'POST') =>
    new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; text: string; json(): any }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method,
        ...(memory ? { createConnection: connection } : {}),
        headers: { Host: 'carta.test', Origin: origin, ...(cookie ? { Cookie: cookie } : {}),
          Connection: 'close',
          ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers } }, res => {
        const parts: Buffer[] = [];
        res.on('data', part => parts.push(part));
        res.on('end', () => { const text = Buffer.concat(parts).toString(); resolve({ status: res.statusCode!, headers: res.headers, text, json: () => JSON.parse(text) }); });
      });
      req.on('error', reject); if (value !== undefined) req.write(JSON.stringify(value)); req.end();
    });
  const login = async () => {
    const res = await http('/api/login', { password }); assert.equal(res.status, 200, res.text);
    cookie = res.headers['set-cookie']![0]!.split(';')[0]!; return res;
  };
  t.after(async () => { try { await app?.close(); } finally { rmSync(dir, { recursive: true, force: true }); } });
  await boot();
  return { get app() { return app; }, worldPath, http, login, boot,
    async socket() {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ack=1&x=12&y=8&width=20&height=20`,
        { headers: { Host: 'carta.test', Origin: origin, Cookie: cookie }, perMessageDeflate: false,
          ...(memory ? { createConnection: connection } : {}) });
      const queue: WorldView[] = [];
      const waiters: ((view: WorldView) => void)[] = [];
      let chunks = 0, parts: string[] = [], previous: WorldView | undefined;
      ws.on('message', data => {
        let text = data.toString();
        if (chunks) { parts.push(text); if (--chunks) return; text = parts.join(''); parts = []; }
        const message = JSON.parse(text);
        if (message.type === 'trozos') { chunks = message.partes; return; }
        if (message.type !== 'state' && message.type !== 'delta') return;
        previous = message.type === 'state' ? message.world : applyStateDelta(previous!, message);
        ws.send(JSON.stringify({ type: 'ack', sequence: previous!.sequence }));
        const waiter = waiters.shift(); if (waiter) waiter(previous!); else queue.push(previous!);
      });
      t.after(() => ws.terminate());
      const next = () => queue.length ? Promise.resolve(queue.shift()!) : new Promise<WorldView>(resolve => waiters.push(resolve));
      await once(ws, 'open'); return { ws, next };
    } };
}

test('worker: HTTP and three WS camera pans remain responsive during a synchronous 1200 ms step', { timeout: 8000 }, async t => {
  const f = await fixture(t, { testStepDelayMs: 1200, tickMs: 200 });
  await f.login();
  const blocked = once(f.app.events, 'step-blocked'); f.app.start(); await blocked;
  await f.login();
  assert.equal((await f.http('/api/session')).json().authenticated, true);
  const socket = await f.socket(); await socket.next();
  const tickBefore = (await f.http('/api/world?x=12&y=8&width=20&height=20')).json().tick;
  const windows = [{ x: 12, y: 8, width: 20, height: 20 }, { x: -96, y: -64, width: 20, height: 20 }, { x: 2048, y: 4096, width: 20, height: 20 }];
  const timings: number[] = [];
  const begun = performance.now();
  for (const viewport of windows) {
    let at = performance.now(); const health = await f.http('/health'); timings.push(performance.now() - at);
    assert.equal(health.status, 200);
    at = performance.now();
    const response = await f.http('/api/world?' + new URLSearchParams(Object.entries(viewport).map(([k, v]) => [k, String(v)])));
    timings.push(performance.now() - at); assert.equal(response.status, 200);
    const world = response.json() as WorldView;
    assert.equal(world.tiles.length, 400); assert.equal(world.tick, tickBefore);
    assert.ok(world.tiles.every(tile => typeof tile.terrain === 'string')); assert.ok(Array.isArray(world.people));
    if (viewport.x === 12) assert.ok(world.people.length > 0);
    at = performance.now(); const pending = socket.next(); socket.ws.send(JSON.stringify({ type: 'viewport', viewport }));
    const pan = await pending; timings.push(performance.now() - at);
    assert.equal(pan.originX, viewport.x); assert.equal(pan.originY, viewport.y); assert.equal(pan.tiles.length, 400);
    assert.equal(pan.tick, tickBefore);
  }
  assert.ok(performance.now() - begun < 1200, 'all probes completed while the simulation thread was blocked');
  assert.ok(timings.every(ms => ms < 150), JSON.stringify(timings));
  t.diagnostic('blocked-worker response times (ms): ' + timings.map(ms => ms.toFixed(1)).join(', '));
});

test('gateway: private endpoints, strict Host/Origin pairs, immediate sessions, logout and no-store assets', { timeout: 7000 }, async t => {
  const f = await fixture(t);
  for (const path of ['/api/world', '/api/regiones', '/api/gestures']) {
    assert.equal((await f.http(path, path === '/api/gestures' ? {} : undefined)).status, 401);
  }
  assert.equal((await f.http('/api/login', { password }, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await f.http('/api/login', { password }, { Host: 'lan.test' })).status, 403);
  assert.equal((await f.http('/health', undefined, { Host: 'evil.test' })).status, 403);
  // The session is locally usable without waiting for the worker to persist it.
  const login = await f.login();
  const setCookie = login.headers['set-cookie']![0]!;
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/); assert.match(setCookie, /Secure/);
  assert.equal((await f.http('/api/session')).json().authenticated, true);
  const asset = await f.http('/'); assert.equal(asset.status, 200); assert.equal(asset.headers['cache-control'], 'no-store');
  assert.equal((await f.http('/api/regiones')).status, 200);
  assert.equal((await f.http('/api/logout', {})).status, 200);
  assert.equal((await f.http('/api/session')).json().authenticated, false);
  assert.equal((await f.http('/api/world')).status, 401);
  // Six login attempts per trusted client key remain in force.
  for (let i = 0; i < 5; i++) assert.equal((await f.http('/api/login', { password: 'wrong' })).status, 401);
  assert.equal((await f.http('/api/login', { password })).status, 429);
});

test('worker: gestures are durable and idempotent, including after gateway/worker restart', { timeout: 8000 }, async t => {
  const f = await fixture(t); await f.login(); f.app.start();
  const gesture: Gesture = { id: 'worker-plant-0001', kind: 'plant', x: 20, y: 14 };
  const first = await f.http('/api/gestures', gesture); assert.equal(first.status, 200, first.text);
  assert.deepEqual((await f.http('/api/gestures', gesture)).json(), first.json());
  assert.equal((await f.http('/api/gestures', { ...gesture, x: 21 })).status, 409);
  const read = new Store(f.worldPath, { readOnly: true });
  try { assert.deepEqual(read.result(gesture), first.json()); } finally { read.close(); }
  const originalThread = f.app.workerThreadId;
  await f.app.close(); assert.equal(f.app.workerExited, true);
  await f.boot();
  assert.notEqual(f.app.workerThreadId, originalThread);
  // Existing unexpired sessions are seeded on restart, without another login.
  assert.equal((await f.http('/api/session')).json().authenticated, true);
  const retry = await f.http('/api/gestures', gesture); assert.equal(retry.status, 200, retry.text);
  assert.deepEqual(retry.json(), first.json());
  assert.equal((await f.http('/api/gestures', { ...gesture, y: 15 })).status, 409);
});

test('worker: graceful close flushes unsaved ticks and joins the worker; projection and simulation retain exact parity', { timeout: 8000 }, async t => {
  const f = await fixture(t); await f.login();
  const referenceStore = new Store(':memory:');
  const reference = createApp({ store: referenceStore, password, origin, seed: 42, params, manual: true });
  t.after(async () => { await reference.close(); referenceStore.close(); });
  const expected = reference.world;
  const initial = (await f.http('/api/world')).json() as WorldView;
  const initialExpected = projectWorld(expected);
  const strip = (view: WorldView) => { const copy = wire(view); delete copy.instanceId; delete copy.performance; delete copy.regionesVivas; return copy; };
  assert.deepEqual(strip(initial), wire(initialExpected), 'initial projection matches the in-process projection');
  const tick = once(f.app.events, 'mirror'); f.app.start(); await tick;
  const next = (await f.http('/api/world')).json() as WorldView;
  for (let i = 0; i < next.tick; i++) reference.stepOnce();
  assert.deepEqual(strip(next), wire(projectWorld(expected)), 'every projected field matches after stepWorld');
  await f.app.close();
  assert.equal(f.app.workerExited, true); assert.equal(f.app.workerThreadId, -1);
  await f.app.close(); // idempotent, including pool/Store disposal
  const read = new Store(f.worldPath, { readOnly: true });
  try {
    const saved = read.load()!.world;
    assert.ok(saved.tick >= next.tick && saved.tick > 0, 'close persisted ticks before the normal save cadence');
    while (reference.world.tick < saved.tick) reference.stepOnce();
    referenceStore.save(reference.world);
    assert.deepEqual(wire(saved), wire(referenceStore.load()!.world), 'durable world is exactly the same trajectory');
  } finally { read.close(); }
});
