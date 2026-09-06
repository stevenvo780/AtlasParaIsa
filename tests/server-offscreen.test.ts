import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { cloneWorld, createWorld, stepWorld, type World } from '../src/world/index.js';
import { enableContinuousEcology } from '../src/world/offscreen-state.js';
import { prepareEcology } from '../src/world/offscreen.js';
import { activate } from '../src/world/spatial.js';
import type { ServerMessage, Gesture } from '../src/shared/types.js';

const password = 'synthetic-offscreen-server-password';
function nextState(socket: WebSocket): Promise<Extract<ServerMessage, { type: 'state' }>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off('message', receive); reject(new Error('Missing state')); }, 3000);
    function receive(data: import('ws').RawData) {
      const message = JSON.parse(data.toString()) as ServerMessage;
      if (message.type === 'state') { clearTimeout(timeout); socket.off('message', receive); resolve(message); }
    }
    socket.on('message', receive);
  });
}

/** Synthetic backlog exercises the HTTP/WS commit boundary, not natural migration. */
function promotionFixture(store: Store): World {
  let world = createWorld(42);
  enableContinuousEcology(world, { chunkTicksPerJob: 2 }); store.save(world);
  const pulse = (mutate?: (draft: World) => void) => {
    const draft = cloneWorld(world, store.context); mutate?.(draft);
    const preparation = prepareEcology(draft, store.context);
    if (preparation.ready) stepWorld(draft, [], store.context);
    store.save(draft); world = draft; return preparation;
  };
  pulse(draft => {
    activate(draft, 48, 0, store.context);
    for (let n = 0; n < 40; n++) activate(draft, (10 + n) * 16, 160, store.context);
  });
  for (let n = 0; n < 25; n++) pulse();
  const preparation = pulse(draft => {
    const actor = draft.people[0]!, place = draft.tiles.find(tile => tile.x === 40 && tile.y === 8)!;
    assert.ok(place); place.terrain = 'meadow';
    actor.x = place.x; actor.y = place.y; actor.target = { x: actor.x, y: actor.y };
  });
  assert.equal(preparation.ready, false); assert.ok(world.ecology!.preparing.includes('3,0'));
  return world;
}

async function fixture(t: TestContext, barrier = true) {
  const { createServer } = await import('node:net');
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const activeStore = new Store(':memory:'); if (barrier) promotionFixture(activeStore);
  const origin = `http://127.0.0.1:${port}`;
  const activeApp = createApp({ store: activeStore, password, origin, manual: true });
  activeApp.server.listen(port, '127.0.0.1'); await once(activeApp.server, 'listening');
  t.after(async () => { await activeApp.close(); activeStore.close(); });
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
  const initial = await nextState(socket); t.after(() => socket.terminate());
  return { store: activeStore, app: activeApp, origin, cookie, socket, initial };
}

test('only newly created app worlds enable continuous ecology; existing worlds retain their law', async () => {
  const fresh = new Store(':memory:'), existing = new Store(':memory:');
  existing.save(createWorld(42));
  const options = { password, origin: 'http://127.0.0.1:0', manual: true };
  const a = createApp({ ...options, store: fresh }), b = createApp({ ...options, store: existing });
  try {
    assert.equal(a.world.tick, 0); assert.ok(a.world.ecology); assert.equal(b.world.ecology, undefined);
    a.stepOnce(); b.stepOnce(); assert.equal(a.failed, false); assert.equal(b.failed, false);
    assert.equal(a.world.tick, 1); assert.equal(a.world.ecology!.revision, 1); assert.equal(b.world.tick, 1);
    assert.deepEqual(fresh.load()!.world, a.world); assert.deepEqual(existing.load()!.world, b.world);
  } finally { await a.close(); await b.close(); fresh.close(); existing.close(); }
});

test('restarting a continuous world records one durable service event without advancing its physics', async () => {
  const store = new Store(':memory:'), options = { store, password, origin: 'http://127.0.0.1:0', manual: true };
  const first = createApp(options);
  for (let n = 0; n < 3; n++) first.stepOnce();
  const before = structuredClone(first.world);
  const heads = store.db.prepare('SELECT * FROM ecology_heads ORDER BY key').all();
  const identity = store.db.prepare("SELECT value FROM metadata WHERE key='world-instance-id'").get();
  await first.close();
  const restarted = createApp(options);
  try {
    const after = restarted.world;
    assert.equal(after.tick, before.tick); assert.equal(after.ecology!.revision, before.ecology!.revision + 1);
    assert.equal(after.eventCounter, before.eventCounter + 1); assert.equal(after.events.at(-1)!.kind, 'pause');
    assert.equal(after.events.at(-1)!.id, `e${after.eventCounter}`);
    const physical = (world: World) => { const { ecology, events, eventCounter, ...rest } = world; return rest; };
    assert.deepEqual(physical(after), physical(before));
    assert.equal(after.ecology!.workedChunkTicks, before.ecology!.workedChunkTicks);
    assert.deepEqual(after.ecology!.preparing, before.ecology!.preparing);
    assert.deepEqual(store.db.prepare('SELECT * FROM ecology_heads ORDER BY key').all(), heads);
    assert.deepEqual(store.db.prepare("SELECT value FROM metadata WHERE key='world-instance-id'").get(), identity);
    assert.deepEqual(store.load()!.world, after);
  } finally { await restarted.close(); store.close(); }
});

test('maintenance publishes committed revisions at the same tick and preserves queued orders until promotion', async t => {
  const f = await fixture(t), messages: ServerMessage[] = [];
  f.socket.on('message', data => messages.push(JSON.parse(data.toString()) as ServerMessage));
  const actor = f.app.world.people[0]!, gesture: Gesture = { id: 'server-cold-pending', kind: 'command', agentId: actor.id, order: 'rest', x: actor.x, y: actor.y };
  const opening = structuredClone(f.app.world), initialTables = f.store.db.prepare('SELECT key,tick FROM ecology_heads ORDER BY key').all();
  const fence = nextState(f.socket);
  f.socket.send(JSON.stringify({ type: 'gesture', gesture }));
  f.socket.send(JSON.stringify({ type: 'viewport', viewport: { x: 160, y: 160, width: 16, height: 16 } })); await fence;
  assert.deepEqual(f.app.world, opening, 'a camera request cannot service the backlog');
  let pulses = 0;
  while (f.app.world.tick === opening.tick && pulses++ < 100) {
    const state = nextState(f.socket); f.app.stepOnce(); const received = (await state).world;
    assert.equal(f.app.failed, false); assert.deepEqual(f.store.load()!.world, f.app.world);
    assert.equal(received.sequence, f.app.world.ecology!.revision);
    if (received.tick === opening.tick) {
      assert.deepEqual(f.app.world.people, opening.people);
      assert.equal(messages.filter(message => message.type === 'result').length, 0);
      assert.equal(f.store.result(gesture), null);
      assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM inputs').get() as { n: number }).n, 0);
    }
  }
  assert.ok(pulses > 1 && pulses < 100); assert.equal(f.app.world.tick, opening.tick + 1);
  assert.ok(f.store.result(gesture)?.accepted);
  const finalFence = nextState(f.socket); f.socket.send(JSON.stringify({ type: 'viewport', viewport: { x: 0, y: 0, width: 16, height: 16 } })); await finalFence;
  assert.equal(messages.filter(message => message.type === 'result').length, 1);
  assert.notDeepEqual(f.store.db.prepare('SELECT key,tick FROM ecology_heads ORDER BY key').all(), initialTables);
});

test('failed maintenance discards its draft and never confirms an order or exposes uncommitted ecology', async t => {
  const f = await fixture(t), messages: ServerMessage[] = [];
  f.socket.on('message', data => messages.push(JSON.parse(data.toString()) as ServerMessage));
  const actor = f.app.world.people[0]!, gesture: Gesture = { id: 'failed-cold-pending', kind: 'command', agentId: actor.id, order: 'rest', x: actor.x, y: actor.y };
  const fence = nextState(f.socket); f.socket.send(JSON.stringify({ type: 'gesture', gesture }));
  f.socket.send(JSON.stringify({ type: 'viewport', viewport: { x: 160, y: 160, width: 16, height: 16 } })); await fence;
  const before = structuredClone(f.app.world), heads = f.store.db.prepare('SELECT * FROM ecology_heads ORDER BY key').all();
  f.store.save = () => { throw new Error('synthetic storage failure'); };
  const state = nextState(f.socket); f.app.stepOnce(); const received = (await state).world;
  assert.equal(f.app.failed, true); assert.equal(received.paused, true);
  assert.equal(received.sequence, before.ecology!.revision); assert.deepEqual(f.app.world, before);
  assert.deepEqual(f.store.load()!.world, before); assert.equal(f.store.result(gesture), null);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM ecology_heads ORDER BY key').all(), heads);
  assert.equal(messages.filter(message => message.type === 'result').length, 0);
});
