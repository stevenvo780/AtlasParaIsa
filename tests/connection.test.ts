import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Connection, type ConnectionStatus } from '../src/client/connection.js';
import { PROTOCOL_VERSION, type Gesture, type ServerMessage, type WorldView } from '../src/shared/types.js';

class BrowserSocket {
  static readonly OPEN = 1;
  static instances: BrowserSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor() { BrowserSocket.instances.push(this); }
  open(): void { this.readyState = 1; this.onopen?.(); }
  send(value: string): void { this.sent.push(value); }
  message(message: ServerMessage): void { this.onmessage?.({ data: JSON.stringify(message) }); }
  close(code = 1006): void { this.readyState = 3; this.onclose?.({ code }); }
}

function view(sequence: number): WorldView {
  return { version: PROTOCOL_VERSION, sequence, tick: sequence, day: 1, phase: 'day', weather: 'clear', width: 40, height: 28, tiles: [], people: [], places: [], events: [], memories: [] };
}
const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const gesture: Gesture = { id: 'request-stays-the-same', kind: 'plant', x: 2, y: 3 };

function harness(t: TestContext, snapshots: WorldView[], rejectHttp = false, httpResponse?: (input: Gesture) => Promise<Response>) {
  const originalFetch = globalThis.fetch;
  const originalSocket = globalThis.WebSocket;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browserEvents = new EventTarget();
  BrowserSocket.instances = [];
  const worlds: WorldView[] = [], errors: string[] = [], pending: boolean[] = [], posted: Gesture[] = [];
  const statuses: ConnectionStatus[] = [];
  let expired = false;
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'http:', host: 'example.test' } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browserEvents });
  globalThis.WebSocket = BrowserSocket as unknown as typeof WebSocket;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (input === '/api/world') return Response.json(snapshots.shift() ?? view(40));
    if (input === '/api/gesture') {
      const postedGesture = JSON.parse(String(init?.body)) as Gesture;
      posted.push(postedGesture);
      if (httpResponse) return httpResponse(postedGesture);
      return rejectHttp ? Response.json({ error: 'Objetivo inválido.' }, { status: 422 }) : Response.json({ ...gesture, accepted: true, tick: 41, order: 1, message: 'Semilla guardada.' });
    }
    throw new Error(`Unexpected route ${String(input)}`);
  }) as typeof fetch;
  const connection = new Connection({ world: world => worlds.push(world), result: () => {}, status: value => statuses.push(value), error: message => errors.push(message), expired: () => { expired = true; }, pending: value => pending.push(value) });
  t.after(() => {
    connection.stop(); globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket;
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
    else Reflect.deleteProperty(globalThis, 'location');
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  return { connection, worlds, errors, pending, posted, statuses, browserEvents, expired: () => expired };
}

test('same-sequence pause is shown while older state is discarded, including version negotiation', async t => {
  const h = harness(t, [view(100)]);
  h.connection.start(); await flush();
  const socket = BrowserSocket.instances[0]!; socket.open();
  socket.message({ type: 'state', world: { ...view(100), paused: true, pauseReason: 'No se pudo guardar.' } });
  socket.message({ type: 'state', world: view(99) });
  assert.equal(h.worlds.length, 2);
  assert.equal(h.worlds.at(-1)?.paused, true);
  socket.message({ type: 'state', world: { ...view(100), version: PROTOCOL_VERSION + 1, paused: true, pauseReason: 'No se pudo guardar.' } });
  assert.match(h.errors[0]!, /actualices la página/);
  assert.equal(socket.readyState, 3);
});

test('authoritative reconnect can recover a lower sequence and discard older messages thereafter', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t, [view(100), view(40)]);
  h.connection.start(); await flush();
  BrowserSocket.instances[0]!.open(); BrowserSocket.instances[0]!.close();
  t.mock.timers.tick(1000); await flush();
  const second = BrowserSocket.instances[1]!; second.open();
  second.message({ type: 'state', world: view(39) });
  second.message({ type: 'state', world: view(41) });
  assert.deepEqual(h.worlds.map(world => world.sequence), [100, 40, 41]);
});

test('HTTP fallback preserves the input ID and terminal rejection unlocks the next input', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t, [view(40)], true);
  h.connection.start(); await flush();
  BrowserSocket.instances[0]!.open();
  assert.equal(h.connection.send(gesture), true);
  assert.deepEqual(h.pending, [true]);
  t.mock.timers.tick(6000); await flush();
  assert.deepEqual(h.posted, [gesture]);
  assert.deepEqual(h.pending, [true, false]);
  assert.match(h.errors[0]!, /Objetivo inválido/);
  assert.equal(h.connection.send({ ...gesture, id: 'new-request' }), true);
});

test('session revocation close 4001 removes private session', async t => {
  const h = harness(t, [view(100)]);
  h.connection.start(); await flush();
  BrowserSocket.instances[0]!.open(); BrowserSocket.instances[0]!.close(4001);
  assert.equal(h.expired(), true);
  assert.equal(h.connection.send(gesture), false);
});

test('browser offline is immediate; online resends the original pending input once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t, [view(40), view(42)]);
  h.connection.start(); await flush(); BrowserSocket.instances[0]!.open();
  h.connection.send(gesture);
  h.browserEvents.dispatchEvent(new Event('offline'));
  assert.equal(h.statuses.at(-1), 'offline');
  assert.equal(h.connection.send({ ...gesture, id: 'other' }), false);
  t.mock.timers.tick(7000); await flush();
  assert.equal(h.posted.length, 0, 'No HTTP fallback attempts while the browser is offline.');
  h.browserEvents.dispatchEvent(new Event('online')); await flush();
  BrowserSocket.instances[1]!.open();
  assert.equal(h.statuses.at(-1), 'live');
  assert.deepEqual(BrowserSocket.instances[1]!.sent.map(value => JSON.parse(value).gesture), [gesture]);
});

test('a silent connection stops claiming live after eight seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t, [view(40)]);
  h.connection.start(); await flush(); BrowserSocket.instances[0]!.open();
  t.mock.timers.tick(8000); await flush();
  assert.equal(h.statuses.at(-1), 'offline');
  assert.equal(BrowserSocket.instances[0]!.readyState, 3);
  assert.equal(h.connection.send(gesture), false);
});

for (const staleResponse of ['conflict', 'network-error'] as const) {
  test(`late HTTP ${staleResponse} for confirmed A cannot erase pending B`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let resolveA!: (response: Response) => void;
    let rejectA!: (error: Error) => void;
    const pendingResponse = new Promise<Response>((resolve, reject) => { resolveA = resolve; rejectA = reject; });
    const h = harness(t, [view(40), view(41)], false, () => pendingResponse);
    h.connection.start(); await flush();
    const first = BrowserSocket.instances[0]!; first.open();
    h.connection.send(gesture);
    t.mock.timers.tick(6000); await flush();
    assert.deepEqual(h.posted, [gesture]);
    first.message({ type: 'result', result: { id: gesture.id, accepted: true, tick: 40, order: 0, message: 'A confirmado.' } });
    const secondGesture = { ...gesture, id: 'pending-B' };
    assert.equal(h.connection.send(secondGesture), true);
    if (staleResponse === 'conflict') resolveA(Response.json({ error: 'Respuesta tardía de A.' }, { status: 409 }));
    else rejectA(new Error('The old request lost its connection.'));
    await flush();
    assert.deepEqual(h.pending, [true, false, true], 'B must remain pending after the stale response.');
    assert.deepEqual(h.errors, [], 'A must not replace B status with a stale error.');
    assert.equal(h.connection.send({ ...gesture, id: 'C' }), false);
    first.close(); t.mock.timers.tick(1000); await flush();
    const second = BrowserSocket.instances[1]!; second.open();
    assert.deepEqual(second.sent.map(value => JSON.parse(value).gesture), [secondGesture], 'B must retain its original ID across reconnect.');
  });
}

test('an unanswered WebSocket handshake times out and reconnects', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t, [view(40), view(41)]);
  h.connection.start(); await flush();
  assert.equal(BrowserSocket.instances[0]!.readyState, 0);
  t.mock.timers.tick(8000); await flush();
  assert.equal(BrowserSocket.instances[0]!.readyState, 3);
  assert.equal(h.statuses.at(-1), 'offline');
  t.mock.timers.tick(1000); await flush();
  assert.equal(BrowserSocket.instances.length, 2);
  BrowserSocket.instances[1]!.open();
  assert.equal(h.statuses.at(-1), 'live');
});

test('HTTP for confirmed A cannot block the fallback for a newer pending B', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolveA!: (response: Response) => void;
  const delayedA = new Promise<Response>(resolve => { resolveA = resolve; });
  const secondGesture = { ...gesture, id: 'B-needs-http' };
  const h = harness(t, [view(40)], false, async input => input.id === gesture.id ? delayedA : Response.json({ id: input.id, accepted: true, tick: 42, order: 0, message: 'B confirmado.' }));
  h.connection.start(); await flush();
  const socket = BrowserSocket.instances[0]!; socket.open();
  h.connection.send(gesture);
  t.mock.timers.tick(6000); await flush();
  socket.message({ type: 'result', result: { id: gesture.id, accepted: true, tick: 40, order: 0, message: 'A confirmado.' } });
  h.connection.send(secondGesture);
  t.mock.timers.tick(6000); await flush();
  assert.deepEqual(h.posted.map(input => input.id), [gesture.id, secondGesture.id]);
  assert.deepEqual(h.pending, [true, false, true, false]);
  resolveA(Response.json({ error: 'A ya estaba confirmado.' }, { status: 409 })); await flush();
  assert.deepEqual(h.errors, []);
});
