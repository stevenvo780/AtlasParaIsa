import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { createWorld, stepWorld, projectWorld, assertWorld, tileAt } from '../src/world/index.js';
import { activate } from '../src/world/spatial.js';
import { chunkKey, generateChunk, MAX_COORDINATE } from '../src/world/terrain.js';
import type { Gesture, GestureResult, ServerMessage, Viewport, WorldView } from '../src/shared/types.js';

async function fixture(t: { after: (callback: () => Promise<void>) => void }, manual = true) {
  const dir = mkdtempSync(join(tmpdir(), 'carta-viewport-'));
  const store = new Store(join(dir, 'world.sqlite'));
  // A port is assigned before the first request; the closure's origin is updated by creating on that port.
  const { createServer } = await import('node:net');
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const app = createApp({ store, origin, password: 'synthetic-viewport-password', manual, tickMs: 15, seed: 42 });
  app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const login = await fetch(origin + '/api/login', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'synthetic-viewport-password' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  return { app, store, origin, cookie };
}

const query = (viewport: Viewport): string => `/api/world?x=${viewport.x}&y=${viewport.y}&width=${viewport.width}&height=${viewport.height}`;
async function wsRequest(client: WebSocket, body: unknown): Promise<ServerMessage> {
  const pending = once(client, 'message'); client.send(JSON.stringify(body));
  const [data] = await pending;
  return JSON.parse(data.toString()) as ServerMessage;
}

test('HTTP camera windows require a session, support negative and far origins, and cannot mutate a same-tick world', async t => {
  const f = await fixture(t);
  const before = structuredClone(f.app.world);
  const savedBefore = f.store.load();
  const viewport = { x: -37, y: -22, width: 31, height: 19 };
  assert.equal((await fetch(f.origin + query(viewport))).status, 401);
  const response = await fetch(f.origin + query(viewport), { headers: { Cookie: f.cookie } });
  assert.equal(response.status, 200);
  const view = await response.json() as WorldView;
  assert.equal(view.originX, viewport.x); assert.equal(view.originY, viewport.y);
  assert.equal(view.sequence, before.tick); assert.equal(view.tick, before.tick);
  assert.equal(view.tiles.length, viewport.width * viewport.height);
  assert.deepEqual(view.tiles.map(tile => [tile.x, tile.y]), Array.from({ length: viewport.width * viewport.height }, (_, index) => [viewport.x + index % viewport.width, viewport.y + Math.floor(index / viewport.width)]));
  const far = await fetch(f.origin + query({ x: MAX_COORDINATE - 1, y: -MAX_COORDINATE, width: 1, height: 1 }), { headers: { Cookie: f.cookie } });
  assert.equal(far.status, 200); assert.equal((await far.json() as WorldView).tiles.length, 1);
  for (const bad of [
    { x: -1.5, y: 0, width: 16, height: 16 }, { x: 0, y: 0, width: 97, height: 16 },
    { x: 0, y: 0, width: 16, height: 65 }, { x: MAX_COORDINATE - 1, y: 0, width: 2, height: 16 },
  ]) assert.equal((await fetch(f.origin + query(bad), { headers: { Cookie: f.cookie } })).status, 400);
  assert.deepEqual(f.app.world, before);
  assert.deepEqual(f.store.load(), savedBefore);
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n, 0);
});

test('WebSocket camera messages preserve sequence at one tick, enforce origin/session, and reject invalid bounds', async t => {
  const f = await fixture(t);
  for (const headers of [{ Origin: f.origin }, { Origin: 'http://untrusted.invalid', Cookie: f.cookie }]) {
    const rejected = new WebSocket(f.origin.replace('http:', 'ws:') + '/ws', { headers });
    rejected.on('error', () => {});
    const [request, response] = await once(rejected, 'unexpected-response');
    assert.ok([401, 403].includes(response.statusCode)); request.destroy(); rejected.terminate();
  }
  const client = new WebSocket(f.origin.replace('http:', 'ws:') + '/ws', { headers: { Origin: f.origin, Cookie: f.cookie } });
  const [initialData] = await once(client, 'message');
  const initial = JSON.parse(initialData.toString()) as { type: 'state'; world: WorldView };
  const before = structuredClone(f.app.world);
  const response = await wsRequest(client, { type: 'viewport', viewport: { x: -32, y: -48, width: 16, height: 16 } });
  assert.equal(response.type, 'state');
  if (response.type !== 'state') throw new Error('State expected.');
  assert.equal(response.world.originX, -32); assert.equal(response.world.originY, -48);
  assert.equal(response.world.sequence, initial.world.sequence);
  assert.equal(response.world.tiles.length, 256);
  const invalid = await wsRequest(client, { type: 'viewport', viewport: { x: 0, y: 0, width: 97, height: 16 } });
  assert.equal(invalid.type, 'error');
  const recovered = await wsRequest(client, { type: 'viewport', viewport: { x: -16, y: -16, width: 16, height: 16 } });
  assert.equal(recovered.type, 'state');
  assert.deepEqual(f.app.world, before);
  client.close(); await once(client, 'close');
});

test('command retries retain the committed result while changed person or order conflicts', async t => {
  const f = await fixture(t, false);
  const command: Gesture = { id: 'viewport-command-01', kind: 'command', agentId: 's', order: 'move', x: 23, y: 13 };
  const send = (gesture: Gesture, origin = f.origin) => fetch(f.origin + '/api/gesture', {
    method: 'POST', headers: { Cookie: f.cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(gesture),
  });
  assert.equal((await send(command, 'http://untrusted.invalid')).status, 403);
  const first = await send(command); assert.equal(first.status, 200);
  const result = await first.json() as GestureResult; assert.equal(result.accepted, true);
  assert.deepEqual(await (await send(command)).json(), result);
  assert.equal((await send({ ...command, agentId: 'i' })).status, 409);
  assert.equal((await send({ ...command, order: 'rest' })).status, 409);
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM inputs WHERE id=?').get(command.id) as { n: number }).n, 1);
  assert.deepEqual(f.store.result(command), result);
});

test('a constructed and modified region survives physical eviction, restart, read-only camera and reactivation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'carta-region-return-'));
  const path = join(dir, 'world.sqlite'); let store = new Store(path);
  try {
    const world = createWorld(42);
    const context = { loadChunk: (key: string, tick: number) => store.loadChunk(key, tick) };
    const chunk = generateChunk(world.seed, 20, -10);
    const destination = chunk.tiles.find(tile => tile.terrain !== 'water' && tile.moisture > 0.25 && tile.vegetation > 0.2 && chunk.places.every(p => Math.hypot(p.x - tile.x, p.y - tile.y) >= 6))!;
    assert.ok(destination, 'the construction fixture needs actual suitable procedural land');
    const person = world.people[0]!;
    for (const p of world.people) { p.action = 'rest'; p.decisionAt = 100_000; p.hunger = 0.1; p.energy = 1; p.fatigue = 0.05; p.target = { x: p.x, y: p.y }; }
    person.x = destination.x; person.y = destination.y; person.target = { x: person.x, y: person.y };
    person.materials = { wood: 6, stone: 3 };
    const key = chunkKey(person.x, person.y);
    const construction: Gesture = { id: 'archive-build-0001', kind: 'command', agentId: person.id, order: 'build', x: person.x, y: person.y };
    assert.equal(stepWorld(world, [construction], context)[0]!.accepted, true);
    for (let tick = 1; tick < 90; tick++) stepWorld(world, [], context);
    const settlement = world.places.find(p => p.id === `settlement-${destination.x}-${destination.y}`)!;
    assert.ok(settlement, 'construction must occur through work, not a fabricated settlement counter');
    assert.equal(world.chunks[key]!.discovered, true);
    assert.equal(tileAt(world, destination)!.terrain, 'shelter');
    const tile = tileAt(world, destination)!;
    tile.food = 0.09765; tile.moisture = 0.6789; tile.vegetation = 0.3456; tile.wood = 2; tile.stone = 1;
    const modified = structuredClone(tile);
    store.save(world);
    person.x = 17; person.y = 13; person.target = { x: 17, y: 13 }; person.action = 'rest'; person.decisionAt = 100_000;
    stepWorld(world, [], context);
    assert.equal(world.chunks[key], undefined);
    assert.ok(world.retiredChunks.some(c => c.key === key));
    store.save(world);
    assert.deepEqual(store.loadChunk(key)!.tiles.find(t => t.x === tile.x && t.y === tile.y), modified);
    const discovered = world.discoveredChunks, settlements = world.settlementCount;
    store.close(); store = new Store(path);
    const restarted = store.load()!.world;
    assert.equal(restarted.discoveredChunks, discovered); assert.equal(restarted.settlementCount, settlements);
    const beforeCamera = structuredClone(restarted);
    const snapshotBefore = store.db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get();
    const view = projectWorld(restarted, { x: chunk.cx * 16, y: chunk.cy * 16, width: 16, height: 16 }, context);
    assert.equal(view.tiles.find(t => t.x === modified.x && t.y === modified.y)!.terrain, 'shelter');
    assert.equal(view.tiles.find(t => t.x === modified.x && t.y === modified.y)!.food, 0.098);
    assert.ok(view.places.some(p => p.id === settlement.id));
    assert.deepEqual(restarted, beforeCamera);
    assert.deepEqual(store.db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get(), snapshotBefore);

    activate(restarted, destination.x, destination.y, context);
    assert.deepEqual(tileAt(restarted, destination), modified);
    assert.equal(restarted.chunks[key]!.discovered, true);
    assert.ok(restarted.places.some(p => p.id === settlement.id));
    const returning = restarted.people[0]!;
    returning.x = destination.x; returning.y = destination.y; returning.target = { x: returning.x, y: returning.y };
    stepWorld(restarted, [], context);
    assert.equal(restarted.discoveredChunks, discovered, 'returning to recorded land must not count as a new discovery');
    assert.equal(restarted.settlementCount, settlements);
    assertWorld(restarted);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
