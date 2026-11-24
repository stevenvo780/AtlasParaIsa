import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { WebSocket as NodeWebSocket } from 'ws';
import { createWorld, stepWorld, projectWorld } from '../src/world/index.js';
import { parseParams } from '../src/world/params.js';
import { computeStateDelta, applyStateDelta } from '../src/shared/deltas.js';
import { PROTOCOL_VERSION, type ServerMessage, type StateDelta, type Viewport, type WorldView } from '../src/shared/types.js';
import { Connection } from '../src/client/connection.js';
import { Store } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';
import { barreraWs } from './lib/net.js';

const KIB = 1024;
const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const sinRendimiento = (v: WorldView): WorldView => { const c = wire(v); delete c.performance; return c; };
const VIEWPORT: Viewport = { x: 0, y: 0, width: 12, height: 8 };

test('deltas por campo convergen tras la cuantización durante 120 pasos con ticks ecológicos', t => {
  const world = createWorld(51926, parseParams('red.deltas=true'));
  let prev = projectWorld(world, VIEWPORT);
  let recon = wire(prev);
  let ecoDelta = 0, ecoFull = 0, normalDelta = 0, normalFull = 0;
  for (let i = 0; i < 120; i++) {
    stepWorld(world);
    const view = projectWorld(world, VIEWPORT);
    const delta = wire(computeStateDelta(prev, view));
    recon = wire(applyStateDelta(recon, delta));
    assert.deepEqual(sinRendimiento(recon), sinRendimiento(view), `paso ${world.tick}`);
    const dBytes = Buffer.byteLength(JSON.stringify(delta)), fBytes = Buffer.byteLength(JSON.stringify({ type: 'state', world: view }));
    if (world.tick % 10 === 0) { ecoDelta = dBytes; ecoFull = fBytes; } else if (!normalDelta) { normalDelta = dBytes; normalFull = fBytes; }
    // Solo campos cambiados: ninguna subida de un paso normal es un Tile completo típico (17 claves).
    for (const up of Array.isArray(delta.tileUpserts) ? delta.tileUpserts : []) assert.ok(Object.keys(up).length < 10, `upsert con ${Object.keys(up).length} campos`);
    prev = view;
  }
  t.diagnostic(`viewport 12x8 · delta normal ${normalDelta} B vs state ${normalFull} B · delta tras tick ecológico ${ecoDelta} B vs state ${ecoFull} B`);
  assert.ok(ecoDelta > 0 && ecoDelta < 120 * KIB && ecoDelta < ecoFull, `delta eco ${ecoDelta} vs state ${ecoFull}`);
  assert.ok(normalDelta > 0 && normalDelta < 120 * KIB && normalDelta < normalFull, `delta normal ${normalDelta} vs state ${normalFull}`);
});

test('tileUpserts como Record también se aplica (forma aceptada del protocolo)', () => {
  const world = createWorld(7, parseParams('red.deltas=true'));
  const prev = projectWorld(world, VIEWPORT);
  stepWorld(world);
  const view = projectWorld(world, VIEWPORT);
  const delta = computeStateDelta(prev, view);
  const record: Record<string, unknown> = {};
  for (const up of Array.isArray(delta.tileUpserts) ? delta.tileUpserts : []) record[`${up.x},${up.y}`] = up;
  const applied = applyStateDelta(wire(prev), { ...delta, tileUpserts: record as StateDelta['tileUpserts'] });
  assert.deepEqual(sinRendimiento(wire(applied)), sinRendimiento(view));
});

/* ---- Cliente real (Connection) con socket de navegador simulado ---- */
class BrowserSocket {
  static readonly OPEN = 1;
  static instances: BrowserSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(readonly url = '') { BrowserSocket.instances.push(this); }
  open(): void { this.readyState = 1; this.onopen?.(); }
  send(v: string): void { this.sent.push(v); }
  message(m: ServerMessage): void { this.onmessage?.({ data: JSON.stringify(m) }); }
  close(code = 1006): void { this.readyState = 3; this.onclose?.({ code }); }
}
const view = (sequence: number): WorldView => ({ version: PROTOCOL_VERSION, sequence, tick: sequence, day: 1, phase: 'day', weather: 'clear', width: 40, height: 28, tiles: [{ x: 0, y: 0, terrain: 'soil', moisture: 0.1, vegetation: 0.2, food: 0.3 }], people: [], places: [], events: [], memories: [] });
const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test('cliente: delta con base perdida dispara exactamente un resync y se recupera con el siguiente state', async t => {
  const originalFetch = globalThis.fetch, originalSocket = globalThis.WebSocket;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  BrowserSocket.instances = [];
  const worlds: WorldView[] = [];
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'http:', host: 'example.test' } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  globalThis.WebSocket = BrowserSocket as unknown as typeof WebSocket;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (typeof input === 'string' && input.split('?')[0] === '/api/world') return Response.json(view(40));
    throw new Error('ruta inesperada');
  }) as typeof fetch;
  const connection = new Connection({ world: w => worlds.push(w), result: () => {}, status: () => {}, error: () => {}, expired: () => {}, pending: () => {} });
  t.after(() => { connection.stop(); globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket;
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation); else Reflect.deleteProperty(globalThis, 'location');
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window'); });
  connection.start(); await flush();
  const socket = BrowserSocket.instances[0]!; socket.open();
  // Delta válido: se aplica y se acusa.
  socket.message({ type: 'state-delta', baseSequence: 40, sequence: 41, tileUpserts: [{ x: 0, y: 0, food: 0.9 }], tileRemovals: [], peopleUpserts: [], peopleRemovals: [], worldPatch: { tick: 41, sequence: 41 } });
  assert.equal(worlds.at(-1)?.tiles[0]?.food, 0.9);
  assert.deepEqual(socket.sent.map(s => JSON.parse(s)), [{ type: 'ack', sequence: 41 }]);
  // Base perdida (dos veces el mismo delta): exactamente un resync, ningún mundo nuevo.
  const perdido: StateDelta = { type: 'state-delta', baseSequence: 999, sequence: 42, tileUpserts: [], tileRemovals: [], peopleUpserts: [], peopleRemovals: [], worldPatch: { tick: 42 } };
  socket.message(perdido); socket.message(perdido);
  const resyncs = socket.sent.map(s => JSON.parse(s)).filter(m => m.type === 'resync');
  assert.equal(resyncs.length, 1);
  assert.equal(worlds.length, 2, 'solo el state inicial y el delta válido');
  // Recuperación: el siguiente state completo se aplica y un delta sobre él vuelve a funcionar.
  socket.message({ type: 'state', world: view(50) });
  assert.equal(worlds.at(-1)?.sequence, 50);
  socket.message({ type: 'state-delta', baseSequence: 50, sequence: 51, tileUpserts: [{ x: 0, y: 0, moisture: 0.7 }], tileRemovals: [], peopleUpserts: [], peopleRemovals: [], worldPatch: { tick: 51, sequence: 51 } });
  assert.equal(worlds.at(-1)?.tiles[0]?.moisture, 0.7);
});

/* ---- Servidor real ---- */
async function freePort(): Promise<number> {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(r => probe.close(() => r())); return port;
}
async function fixture(t: TestContext, deltas: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'carta-red-deltas-'));
  const store = new Store(join(dir, 'world.sqlite'));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const password = 'synthetic-red-deltas-password';
  const app = createApp({ store, password, origin, manual: true, seed: 51926, params: parseParams(deltas ? 'red.deltas=true' : 'red.deltas=false') });
  app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  async function connect(): Promise<{ socket: NodeWebSocket; mensajes: { raw: string; msg: ServerMessage }[]; cookie: string }> {
    const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const socket = new NodeWebSocket(origin.replace('http:', 'ws:') + `/ws?ack=1&x=0&y=0&width=12&height=8`, { headers: { Origin: origin, Cookie: cookie } });
    const mensajes: { raw: string; msg: ServerMessage }[] = [];
    let trozos: string[] | null = null, total = 0;
    socket.on('message', data => {
      const text = data.toString();
      if (trozos) { trozos.push(text); if (trozos.length < total) return; mensajes.push({ raw: trozos.join(''), msg: JSON.parse(trozos.join('')) as ServerMessage }); trozos = null; return; }
      const msg = JSON.parse(text) as ServerMessage;
      if (msg.type === 'trozos') { trozos = []; total = msg.partes; return; }
      mensajes.push({ raw: text, msg });
    });
    await once(socket, 'open');
    await barreraWs(socket);
    return { socket, mensajes, cookie };
  }
  return { app, connect, origin };
}

test('servidor con red.deltas=true: deltas convergen al state completo en ≥100 pasos, payload menor y 0 sockets terminados', async t => {
  const { app, connect, origin } = await fixture(t, true);
  const cliente = await connect();
  const reconstruccion: { vista?: WorldView } = {};
  const sizes: { sequence: number; delta: number }[] = [];
  let cursor = 0;
  const drain = (): void => {
    for (; cursor < cliente.mensajes.length; cursor++) {
      const { raw, msg } = cliente.mensajes[cursor]!;
      if (msg.type === 'state') { reconstruccion.vista = wire(msg.world); cliente.socket.send(JSON.stringify({ type: 'ack', sequence: msg.world.sequence })); }
      else if (msg.type === 'state-delta') {
        assert.ok(reconstruccion.vista, 'delta sin base previa');
        reconstruccion.vista = wire(applyStateDelta(reconstruccion.vista, msg));
        sizes.push({ sequence: msg.sequence, delta: Buffer.byteLength(raw) });
        cliente.socket.send(JSON.stringify({ type: 'ack', sequence: msg.sequence }));
      }
    }
  };
  drain();
  assert.equal(cliente.mensajes[0]?.msg.type, 'state', 'la primera conexión recibe un state completo');
  await barreraWs(cliente.socket);
  for (let i = 0; i < 120; i++) {
    app.stepOnce();
    if (app.world.tick % 5 !== 0) continue;
    await barreraWs(cliente.socket);
    drain();
    await barreraWs(cliente.socket);
  }
  const vista = reconstruccion.vista;
  assert.ok(vista);
  t.diagnostic(`servidor · ${sizes.length} deltas · mayor ${Math.max(...sizes.map(s => s.delta))} B · secuencias eco ${sizes.filter(s => s.sequence % 10 === 0).map(s => s.sequence).join(',')}`);
  assert.ok(sizes.length >= 10, `deltas recibidos: ${sizes.length}`);
  assert.ok(sizes.every(s => s.delta < 120 * KIB), `delta mayor: ${Math.max(...sizes.map(s => s.delta))}`);
  assert.ok(sizes.some(s => s.sequence % 10 === 0), 'hubo deltas tras ticks ecológicos');
  // Convergencia contra un state completo del mismo tick (vía HTTP, mismo viewport).
  const full = await (await fetch(`${origin}/api/world?x=0&y=0&width=12&height=8`, { headers: { Cookie: cliente.cookie } })).json() as WorldView;
  assert.equal(vista.sequence, full.sequence, 'ambas vistas corresponden al mismo paso');
  assert.deepEqual(sinRendimiento(vista), sinRendimiento(full));
  const fullBytes = Buffer.byteLength(JSON.stringify({ type: 'state', world: full }));
  assert.ok(Math.max(...sizes.map(s => s.delta)) < fullBytes, 'el delta mayor sigue por debajo del state completo');
  assert.equal(cliente.socket.readyState, NodeWebSocket.OPEN, '0 sockets terminados');
  // resync del cliente ⇒ state completo de recuperación.
  const antes = cliente.mensajes.length;
  cliente.socket.send(JSON.stringify({ type: 'resync' }));
  await barreraWs(cliente.socket); drain();
  assert.ok(cliente.mensajes.slice(antes).some(m => m.msg.type === 'state'), 'tras resync llega un state completo');
  cliente.socket.terminate();
});

test('servidor con red.deltas=false: el protocolo es idéntico al actual (solo state)', async t => {
  assert.equal(parseParams('red.deltas=false').red.deltas, false);
  const { app, connect } = await fixture(t, false);
  const cliente = await connect();
  const inicial = cliente.mensajes[0]?.msg;
  assert.ok(inicial?.type === 'state');
  cliente.socket.send(JSON.stringify({ type: 'ack', sequence: inicial.world.sequence }));
  await barreraWs(cliente.socket);
  for (let i = 0; i < 5; i++) app.stepOnce();
  await barreraWs(cliente.socket);
  assert.equal(cliente.mensajes.filter(({ msg }) => msg.type === 'state').length, 2);
  const tipos = new Set(cliente.mensajes.map(m => m.msg.type));
  assert.deepEqual([...tipos].filter(x => x !== 'latido'), ['state']);
  assert.equal(cliente.mensajes.some(m => m.msg.type === 'state-delta'), false);
  cliente.socket.terminate();
});
