import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { Store } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { DEFAULT_PARAMS, parseParams } from '../src/world/params.js';
import type { ServerMessage } from '../src/shared/types.js';

test('camera archive failure cannot kill or pause a committed simulation; disk-failure fallback performs no archive reads', async () => {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`, store = new Store(':memory:');
  const app = createApp({ store, origin, password: 'synthetic-failure-password', manual: true, seed: 42 });
  let client: WebSocket | undefined;
  try {
    for (const p of app.world.people) { p.x = 39; p.y = 27; p.target = { x: p.x, y: p.y }; p.action = 'rest'; p.decisionAt = 1000; }
    app.stepOnce();
    app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
    const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'synthetic-failure-password' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    client = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    const [initialData] = await once(client, 'message'); const initial = JSON.parse(initialData.toString()) as ServerMessage;
    assert.equal(initial.type, 'state');
    let reads = 0;
    store.loadChunk = () => { reads++; throw new Error('synthetic archive read failure'); };
    const cameraMessage = once(client, 'message');
    for (let n = 0; n < 4; n++) assert.doesNotThrow(() => app.stepOnce());
    const [cameraData] = await cameraMessage;
    assert.equal((JSON.parse(cameraData.toString()) as ServerMessage).type, 'error');
    assert.equal(app.failed, false); assert.equal(store.load()!.world.tick, 5); assert.ok(reads > 0);
    const before = structuredClone(app.world); const readsBefore = reads;
    const paused = new Promise<ServerMessage>(resolve => client!.on('message', data => { const message = JSON.parse(data.toString()) as ServerMessage; if (message.type === 'state' && message.world.paused) resolve(message); }));
    store.save = () => { throw new Error('synthetic disk failure'); };
    assert.doesNotThrow(() => app.stepOnce());
    const message = await paused;
    assert.equal(message.type, 'state'); assert.equal(reads, readsBefore);
    assert.equal(app.failed, true); assert.deepEqual(app.world, before); assert.equal(store.load()!.world.tick, 5);
    if (initial.type === 'state' && message.type === 'state') { assert.equal(message.world.tick, initial.world.tick); assert.deepEqual(message.world.tiles, initial.world.tiles); }
  } finally { client?.terminate(); await app.close(); store.close(); }
});

/** T104: la misma garantía sin clon por paso. Aquí `app.world` ES el mundo que simuló el paso
 * fallido, así que la atomicidad la sostiene el punto de restauración; y la puerta es
 * `digestoCanonico`, que mira `retiredChunks` —el hash durable los borra— además del resto. */
test('sin clon por paso, un fallo de guardado deja el mundo vigente intacto y la cámara no lee el archivo', async () => {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`, store = new Store(':memory:');
  const params = parseParams('motor.clonPorPaso=false', DEFAULT_PARAMS);
  const app = createApp({ store, origin, password: 'synthetic-failure-password', manual: true, seed: 42, params });
  let client: WebSocket | undefined;
  try {
    for (const p of app.world.people) { p.x = 39; p.y = 27; p.target = { x: p.x, y: p.y }; p.action = 'rest'; p.decisionAt = 1000; }
    app.stepOnce();
    app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
    const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'synthetic-failure-password' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    client = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    const [initialData] = await once(client, 'message'); const initial = JSON.parse(initialData.toString()) as ServerMessage;
    assert.equal(initial.type, 'state');
    let reads = 0;
    store.loadChunk = () => { reads++; throw new Error('synthetic archive read failure'); };
    const cameraMessage = once(client, 'message');
    for (let n = 0; n < 4; n++) assert.doesNotThrow(() => app.stepOnce());
    assert.equal((JSON.parse((await cameraMessage)[0].toString()) as ServerMessage).type, 'error');
    assert.equal(app.failed, false); assert.equal(store.load()!.world.tick, 5); assert.ok(reads > 0);
    const before = digestoCanonico(app.world), tick = app.world.tick, readsBefore = reads;
    const paused = new Promise<ServerMessage>(resolve => client!.on('message', data => { const message = JSON.parse(data.toString()) as ServerMessage; if (message.type === 'state' && message.world.paused) resolve(message); }));
    store.save = () => { throw new Error('synthetic disk failure'); };
    assert.doesNotThrow(() => app.stepOnce());
    const message = await paused;
    assert.equal(message.type, 'state'); assert.equal(reads, readsBefore);
    assert.equal(app.failed, true); assert.equal(app.world.tick, tick);
    assert.equal(digestoCanonico(app.world), before);
    assert.equal(store.load()!.world.tick, 5);
    if (initial.type === 'state' && message.type === 'state') { assert.equal(message.world.tick, initial.world.tick); assert.deepEqual(message.world.tiles, initial.world.tiles); }
  } finally { client?.terminate(); await app.close(); store.close(); }
});
