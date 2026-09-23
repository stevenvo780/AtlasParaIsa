/** Contrapresión WebSocket (2026-09-22, «por el dominio siempre dice sin conexión»).
 *
 * Diagnóstico (`scripts/ws-wan/`): un `state` de escritorio pesa ~733 KiB y a ~2 states/s pide
 * 12 Mbit/s por visor. Por un enlace más lento, `send()` solo veía el búfer de `ws`: el del kernel
 * (hasta 4 MiB) y los del VPS absorbían estados viejos, el retraso crecía a 10–30 s, el ping del
 * latido quedaba detrás y el servidor cortaba; el cliente pasaba 8 s sin un mensaje entero y se
 * declaraba «Sin conexión»; y la reconexión (GET /api/world de hasta 1,4 MB, abortado a 10 s)
 * fallaba en bucle.
 *
 * Contrato que fijan estas pruebas:
 *   - `/ws?ack=1`: a lo sumo un `state` en vuelo por cliente; al llegar el acuse se manda el mundo
 *     de ese momento (uno, no los intermedios). El cliente anterior (`/ws`) no cambia.
 *   - Un `state` grande viaja en trozos; cualquier marco rearma el silencio del cliente.
 *   - Latido de aplicación cuando no hay nada que mandar; nunca detrás de un `state` en vuelo.
 *   - La cámara puede viajar en la URL; la URL de `/ws` sigue siendo estricta.
 *   - Los acuses que liberan no gastan el cupo de mensajes; los sueltos sí.
 *   - `/api/world` viaja con gzip si el navegador lo acepta.
 *   - Por un enlace lento (proxy limitador en proceso) el cliente REAL sigue «live» con estados
 *     recientes, incluso cuando un solo `state` tarda más que el silencio tolerado.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Store } from '../src/server/store.js';
import { createApp, solicitudWs, trocear, TROZO_WS, TROZO_WS_COMPRIMIDO, LATIDO_WS_MS } from '../src/server/app.js';
import { Connection, type ConnectionStatus } from '../src/client/connection.js';
import type { ServerMessage, WorldView } from '../src/shared/types.js';
import { Enlace } from '../scripts/ws-wan/enlace.js';
import { instalarNavegador } from '../scripts/ws-wan/navegador-node.js';

const password = 'synthetic-backpressure-password-only';
const settle = (ms = 30): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve())); return port;
}

async function fixture(t: TestContext, options: { perMessageDeflate?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'carta-contrapresion-'));
  const store = new Store(join(dir, 'world.sqlite'));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const app = createApp({ store, password, origin, manual: true, seed: 7, ...options });
  app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  t.after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { app, store, origin, port, cookie, host: `127.0.0.1:${port}` };
}

/** Cliente WS crudo que reconstruye los `state` en trozos como lo hace `connection.ts`. */
function abrir(f: { origin: string; cookie: string }, path: string) {
  const socket = new WebSocket(f.origin.replace('http:', 'ws:') + path, { headers: { Origin: f.origin, Cookie: f.cookie } });
  const marcos: string[] = [];
  const mensajes: ServerMessage[] = [];
  let trozos: { total: number; partes: string[] } | null = null;
  socket.on('message', data => {
    const texto = data.toString();
    marcos.push(texto);
    if (trozos) {
      trozos.partes.push(texto);
      if (trozos.partes.length < trozos.total) return;
      const completo = trozos.partes.join(''); trozos = null;
      mensajes.push(JSON.parse(completo) as ServerMessage); return;
    }
    const message = JSON.parse(texto) as ServerMessage;
    if (message.type === 'trozos') { trozos = { total: message.partes, partes: [] }; return; }
    mensajes.push(message);
  });
  const states = () => mensajes.filter((m): m is Extract<ServerMessage, { type: 'state' }> => m.type === 'state').map(m => m.world);
  const esperar = async (cond: () => boolean, ms = 5000, que = 'condición') => {
    const hasta = Date.now() + ms;
    while (!cond()) { if (Date.now() > hasta) throw new Error(`Sin ${que} en ${ms} ms`); await settle(10); }
  };
  const bytesCable = () => (socket as unknown as { _socket?: { bytesRead: number } })._socket?.bytesRead ?? 0;
  return { socket, marcos, mensajes, states, esperar, bytesCable, ack: (sequence: number) => socket.send(JSON.stringify({ type: 'ack', sequence })) };
}

test('con acuse nunca hay más de un state en vuelo y al acusar llega uno solo, el más reciente', async t => {
  const f = await fixture(t);
  const c = abrir(f, '/ws?ack=1');
  t.after(() => c.socket.terminate());
  await c.esperar(() => c.states().length === 1, 5000, 'estado inicial');
  const inicial = c.states()[0]!;
  for (let n = 0; n < 25; n++) f.app.stepOnce(); // 5 difusiones mientras el inicial sigue sin acuse
  await settle(100);
  assert.equal(c.states().length, 1, 'sin acuse no sale ningún state más');
  assert.equal(f.app.flujo[0]!.enVuelo, true);
  assert.ok(f.app.flujo[0]!.aplazados >= 5, `las difusiones se apuntan, no se encolan (${f.app.flujo[0]!.aplazados})`);
  c.ack(inicial.sequence);
  await c.esperar(() => c.states().length === 2, 5000, 'state tras el acuse');
  await settle(100);
  assert.equal(c.states().length, 2, 'cinco difusiones saltadas producen UN state, no cinco');
  assert.equal(c.states()[1]!.tick, f.app.world.tick, 'lo que llega al drenar es el mundo de ahora');
  // Acusado el segundo, la cadencia normal vuelve: una difusión = un state.
  c.ack(c.states()[1]!.sequence); await settle(50);
  for (let n = 0; n < 5; n++) f.app.stepOnce();
  await c.esperar(() => c.states().length === 3, 5000, 'state de la difusión siguiente');
  assert.equal(c.states()[2]!.tick, f.app.world.tick);
  assert.equal(f.app.flujo[0]!.acuses, 2);
});

test('el cliente anterior (/ws, sin acuse) conserva su cadencia y recibe texto plano', async t => {
  const f = await fixture(t);
  const antiguo = abrir(f, '/ws');
  const nuevo = abrir(f, '/ws?ack=1');
  t.after(() => { antiguo.socket.terminate(); nuevo.socket.terminate(); });
  await antiguo.esperar(() => antiguo.states().length === 1 && nuevo.states().length === 1, 5000, 'estados iniciales');
  const cable0 = { antiguo: antiguo.bytesCable(), nuevo: nuevo.bytesCable() };
  for (let ronda = 0; ronda < 5; ronda++) {
    nuevo.ack(nuevo.states().at(-1)!.sequence);
    for (let n = 0; n < 5; n++) f.app.stepOnce();
    await nuevo.esperar(() => nuevo.states().length === ronda + 2, 5000, `state ${ronda} del cliente con acuse`);
  }
  await antiguo.esperar(() => antiguo.states().length === 6, 5000, 'las cinco difusiones del cliente anterior');
  assert.deepEqual(antiguo.states().slice(1).map(s => s.tick), [5, 10, 15, 20, 25]);
  assert.ok(antiguo.marcos.every(m => m.startsWith('{')), 'el cliente anterior nunca recibe trozos');
  assert.equal(f.app.flujo.find(x => !x.acuse)!.aplazados, 0);
  const texto = (w: WorldView[]) => w.slice(1).reduce((s, v) => s + Buffer.byteLength(JSON.stringify({ type: 'state', world: v })), 0);
  const cable = { antiguo: antiguo.bytesCable() - cable0.antiguo, nuevo: nuevo.bytesCable() - cable0.nuevo };
  // permessage-deflate se negocia con los dos (el cliente `ws`, como un navegador, lo ofrece), pero
  // solo se comprimen los `state` hacia quien acusa.
  assert.ok(cable.antiguo >= texto(antiguo.states()), `anterior: ${cable.antiguo} B en cable para ${texto(antiguo.states())} B de JSON`);
  assert.ok(cable.nuevo * 3 < texto(nuevo.states()), `con acuse: ${cable.nuevo} B en cable para ${texto(nuevo.states())} B de JSON`);
});

for (const [modo, perMessageDeflate, trozo] of [['comprimido', undefined, TROZO_WS_COMPRIMIDO], ['en claro', false, TROZO_WS]] as const) test(`un state grande viaja en trozos consecutivos que reconstruyen su JSON exacto (${modo})`, async t => {
  const f = await fixture(t, { perMessageDeflate });
  const c = abrir(f, '/ws?ack=1&x=-40&y=-30&width=96&height=64');
  t.after(() => c.socket.terminate());
  await c.esperar(() => c.states().length === 1, 10_000, 'estado inicial grande');
  const cabecera = JSON.parse(c.marcos[0]!) as ServerMessage;
  assert.equal(cabecera.type, 'trozos');
  const partes = cabecera.type === 'trozos' ? cabecera.partes : 0;
  assert.ok(partes > 1);
  assert.equal(c.marcos.length, 1 + partes, 'nada se cuela entre la cabecera y sus trozos');
  assert.ok(c.marcos.slice(1).every(m => m.length <= trozo));
  const minimo = Math.ceil(c.marcos.slice(1).join('').length / trozo);
  assert.ok(partes >= minimo && partes <= minimo + 1, `trozos llenos: ${partes} para ${minimo} como mínimo`);
  const world = c.states()[0]!;
  assert.equal(world.originX, -40); assert.equal(world.originY, -30); assert.equal(world.width, 96); assert.equal(world.height, 64);
  assert.equal(c.marcos.slice(1).join(''), JSON.stringify({ type: 'state', world }), 'el JSON reconstruido es el mismo, byte a byte');
});

test('trocear nunca parte un par sustituto', () => {
  const text = 'a'.repeat(9) + '😀' + 'b'.repeat(7) + '𝄞';
  for (let size = 2; size <= text.length + 1; size++) {
    const partes = trocear(text, size);
    assert.equal(partes.join(''), text);
    for (const parte of partes) {
      assert.ok(parte.length <= size);
      assert.ok(Buffer.from(parte, 'utf8').toString('utf8') === parte, `trozo con medio carácter (size ${size})`);
    }
  }
});

test('la cámara de la URL sirve el primer state; con uno en vuelo, las cámaras nuevas esperan al acuse y llegan como uno', async t => {
  const f = await fixture(t);
  const c = abrir(f, '/ws?ack=1&x=-50&y=10&width=30&height=20');
  t.after(() => c.socket.terminate());
  await c.esperar(() => c.states().length === 1, 5000, 'estado inicial');
  assert.deepEqual([c.states()[0]!.originX, c.states()[0]!.originY, c.states()[0]!.width, c.states()[0]!.height], [-50, 10, 30, 20], 'el primer state ya es el de esta pantalla, no la vista por defecto');
  assert.equal(c.mensajes.length, 1, 'y es el único: nada de vista por defecto antes');
  // Con el primero sin acuse, tres cámaras nuevas no producen tres states.
  for (const x of [5, 7, 9]) c.socket.send(JSON.stringify({ type: 'viewport', viewport: { x, y: 6, width: 12, height: 9 } }));
  await settle(150);
  assert.equal(c.states().length, 1);
  c.ack(c.states()[0]!.sequence);
  await c.esperar(() => c.states().length === 2, 5000, 'state tras el acuse');
  await settle(100);
  assert.equal(c.states().length, 2, 'uno solo, con la última cámara');
  assert.deepEqual([c.states()[1]!.originX, c.states()[1]!.width], [9, 12]);
  // Sin nada en vuelo, una petición de cámara (aunque sea la misma) responde enseguida, como siempre.
  c.ack(c.states()[1]!.sequence); await settle(50);
  c.socket.send(JSON.stringify({ type: 'viewport', viewport: { x: 9, y: 6, width: 12, height: 9 } }));
  await c.esperar(() => c.states().length === 3, 5000, 'state de la cámara pedida');
});

test('la URL de /ws sigue siendo estricta: ruta, parámetros, cámara, origen y sesión', async t => {
  const f = await fixture(t);
  const estado = (path: string, headers: Record<string, string> = { Origin: f.origin, Cookie: f.cookie }) => new Promise<number>(resolve => {
    const client = new WebSocket(f.origin.replace('http:', 'ws:') + path, { headers });
    client.on('error', () => {});
    client.once('unexpected-response', (req, res) => { resolve(res.statusCode ?? 0); req.destroy(); client.terminate(); });
    client.once('open', () => { resolve(101); client.terminate(); });
  });
  for (const path of ['/ws/', '/wss', '/ws?ack=2', '/ws?ack=1&ack=1', '/ws?ack=1&foo=1', '/ws?x=1&y=1&width=2&height=2', '/ws/?ack=1']) assert.equal(await estado(path), 403, path);
  for (const path of ['/ws?ack=1&x=1', '/ws?ack=1&x=1&y=1&width=500&height=10', '/ws?ack=1&x=1.5&y=1&width=5&height=5', '/ws?ack=1&x=&y=1&width=5&height=5', '/ws?ack=1&x=0x10&y=1&width=5&height=5']) assert.equal(await estado(path), 400, path);
  assert.equal(await estado('/ws?ack=1', { Cookie: f.cookie }), 403, 'sin Origin');
  assert.equal(await estado('/ws?ack=1', { Origin: f.origin }), 401, 'sin sesión');
  assert.equal(await estado('/ws?ack=1&x=-3&y=4&width=10&height=10'), 101);
  assert.equal(await estado('/ws'), 101);
  assert.deepEqual(solicitudWs('/ws'), { acuse: false });
  // Lo que un cliente `ws` o un navegador normalizan antes de enviar se prueba sobre la URL cruda.
  for (const raw of ['/ws?', '/ws?&', '/ws?ack', '/ws?ack=0', '//ws', '/ws?ack=1&x=1&y=2&width=3&height=4&x=1', undefined]) assert.throws(() => solicitudWs(raw), String(raw));
  assert.deepEqual(solicitudWs('/ws?ack=1&x=-3&y=4&width=10&height=10'), { acuse: true, viewport: { x: -3, y: 4, width: 10, height: 10 } });
});

test('los acuses que liberan un state no gastan el cupo de mensajes; los sueltos sí', async t => {
  const f = await fixture(t);
  const c = abrir(f, '/ws?ack=1');
  t.after(() => c.socket.terminate());
  await c.esperar(() => c.states().length === 1, 5000, 'estado inicial');
  for (let n = 0; n < 118; n++) c.ack(-5); // acuses sueltos: cuentan y no liberan nada
  await settle(100);
  assert.equal(f.app.flujo[0]!.enVuelo, true, 'un acuse de otra secuencia no libera el state en vuelo');
  for (let ronda = 0; ronda < 5; ronda++) {
    c.ack(c.states().at(-1)!.sequence);
    for (let n = 0; n < 5; n++) f.app.stepOnce();
    await c.esperar(() => c.states().length === ronda + 2, 5000, `state de la ronda ${ronda}`);
  }
  assert.equal(c.socket.readyState, WebSocket.OPEN, '118 sueltos + 5 que liberan: sigue abierto');
  const cierre = once(c.socket, 'close');
  for (let n = 0; n < 3; n++) c.ack(-5);
  const [code] = await cierre;
  assert.equal(code, 4008);
});

test('latido de aplicación cuando no hay nada que mandar, nunca detrás de un state en vuelo', async t => {
  const f = await fixture(t);
  const acusa = abrir(f, '/ws?ack=1');
  const noAcusa = abrir(f, '/ws?ack=1');
  const antiguo = abrir(f, '/ws');
  t.after(() => { acusa.socket.terminate(); noAcusa.socket.terminate(); antiguo.socket.terminate(); });
  await acusa.esperar(() => [acusa, noAcusa, antiguo].every(c => c.states().length === 1), 5000, 'estados iniciales');
  acusa.ack(acusa.states()[0]!.sequence);
  const latidos = (c: ReturnType<typeof abrir>) => c.mensajes.filter(m => m.type === 'latido').length;
  await acusa.esperar(() => latidos(acusa) > 0 && latidos(antiguo) > 0, LATIDO_WS_MS + 3000, 'latido');
  assert.equal(latidos(noAcusa), 0, 'con el state en vuelo no se encola un latido detrás');
});

test('/api/world viaja con gzip si el navegador lo acepta, y en claro si no', async t => {
  const f = await fixture(t);
  const pedir = (acceptEncoding?: string) => new Promise<{ encoding: string | undefined; cuerpo: Buffer; vary: string | undefined }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: f.port, path: '/api/world?x=0&y=0&width=40&height=28', headers: { Cookie: f.cookie, ...(acceptEncoding ? { 'Accept-Encoding': acceptEncoding } : {}) } }, res => {
      const trozos: Buffer[] = []; res.on('data', c => trozos.push(c)); res.on('end', () => resolve({ encoding: res.headers['content-encoding'], cuerpo: Buffer.concat(trozos), vary: res.headers.vary as string | undefined }));
    });
    req.on('error', reject); req.end();
  });
  const plano = await pedir();
  const comprimido = await pedir('gzip, deflate, br');
  const rechazado = await pedir('gzip;q=0, deflate');
  assert.equal(plano.encoding, undefined); assert.equal(rechazado.encoding, undefined);
  assert.equal(comprimido.encoding, 'gzip'); assert.equal(comprimido.vary, 'Accept-Encoding');
  const vista = JSON.parse(gunzipSync(comprimido.cuerpo).toString('utf8')) as WorldView;
  assert.deepEqual(vista.tiles, (JSON.parse(plano.cuerpo.toString('utf8')) as WorldView).tiles);
  assert.ok(comprimido.cuerpo.length * 4 < plano.cuerpo.length, `gzip ${comprimido.cuerpo.length} B frente a ${plano.cuerpo.length} B`);
  assert.equal((await fetch(f.origin + '/api/world')).status, 401, 'la sesión sigue siendo obligatoria');
});

/** El cliente REAL (`Connection`) contra el servidor a través de un enlace limitado, con el mundo
 * avanzando a 10 Hz (difusión cada 5 pasos, como en producción). */
async function clienteLento(t: TestContext, o: { mbps: number; duracionMs: number; perMessageDeflate?: boolean }) {
  const f = await fixture(t, { perMessageDeflate: o.perMessageDeflate });
  const enlace = new Enlace({ host: '127.0.0.1', port: f.port }, { bajadaBps: o.mbps * 1e6, subidaBps: o.mbps * 1e6, retardoMs: 40, colaBytes: 256 * 1024 });
  const puerto = await enlace.abrir();
  const pasoEn = new Map<number, number>();
  const marcos: number[] = [];
  const navegador = instalarNavegador({ host: f.host, origin: f.origin, cookie: f.cookie, puerto, registro: e => { if (e.ev === 'marco') marcos.push(e.t); } });
  const llegadas: { t: number; tick: number; edadMs: number; bytes: number }[] = [];
  const estados: { t: number; status: ConnectionStatus }[] = [];
  let sockets = 0;
  const OriginalSocket = globalThis.WebSocket;
  globalThis.WebSocket = class extends (OriginalSocket as unknown as new (url: string) => object) { constructor(url: string) { super(url); sockets++; } } as unknown as typeof globalThis.WebSocket;
  let conexion: Connection | null = null;
  conexion = new Connection({
    world: world => {
      const t = performance.now();
      llegadas.push({ t, tick: world.tick, edadMs: t - (pasoEn.get(world.tick) ?? t), bytes: Buffer.byteLength(JSON.stringify({ type: 'state', world })) });
      // Como `Landscape`: tras el primer mundo informa la cámara de una pantalla grande alejada.
      if (llegadas.length === 1) conexion!.setViewport({ x: -40, y: -30, width: 96, height: 64 });
    },
    status: status => estados.push({ t: performance.now(), status }), result: () => {}, error: () => {}, expired: () => {}, pending: () => {},
  });
  const inicio = performance.now();
  pasoEn.set(f.app.world.tick, inicio);
  conexion.start();
  const reloj = setInterval(() => { f.app.stepOnce(); pasoEn.set(f.app.world.tick, performance.now()); }, 100);
  await settle(o.duracionMs);
  clearInterval(reloj);
  conexion.stop(); navegador.restaurar(); await enlace.cerrar();
  const huecos = marcos.slice(1).map((m, i) => m - marcos[i]!);
  return { llegadas, estados, sockets, enlace, flujo: f.app.flujo, huecoMaxMs: Math.max(0, ...huecos), inicio };
}

test('por un enlace de 2 Mbit/s el cliente real sigue live con estados recientes (comprimidos)', async t => {
  // Una pantalla grande alejada (96×64) pesa ~1,3 MB en claro: a 10 Hz pide ~20 Mbit/s.
  const r = await clienteLento(t, { mbps: 2, duracionMs: 12_000 });
  const primerLive = r.estados.find(e => e.status === 'live');
  assert.ok(primerLive, 'llega a live');
  assert.deepEqual(r.estados.filter(e => e.t > primerLive.t).map(e => e.status), [], `nunca deja live: ${JSON.stringify(r.estados.map(e => e.status))}`);
  const grandes = r.llegadas.filter(l => l.bytes > 512 * 1024);
  assert.ok(grandes.length >= 4, `llegan estados de la cámara grande (${grandes.length})`);
  const edadMax = Math.max(...grandes.map(l => l.edadMs));
  assert.ok(edadMax < 4000, `el estado que llega es reciente (edad máx. ${edadMax.toFixed(0)} ms)`);
  const planos = r.llegadas.reduce((s, l) => s + l.bytes, 0);
  assert.ok(r.enlace.bajada.bytes * 3 < planos, `viajan comprimidos: ${r.enlace.bajada.bytes} B por el enlace para ${planos} B de JSON`);
});

test('control: el cliente anterior por el mismo enlace acumula retraso (lo que corrige el acuse)', async t => {
  const f = await fixture(t);
  const enlace = new Enlace({ host: '127.0.0.1', port: f.port }, { bajadaBps: 2e6, subidaBps: 2e6, retardoMs: 40, colaBytes: 256 * 1024 });
  const puerto = await enlace.abrir();
  t.after(() => enlace.cerrar());
  const pasoEn = new Map<number, number>([[f.app.world.tick, performance.now()]]);
  const socket = new WebSocket(`ws://127.0.0.1:${puerto}/ws`, { headers: { Host: `127.0.0.1:${f.port}`, Origin: f.origin, Cookie: f.cookie } });
  const edades: number[] = [];
  socket.on('message', data => {
    const m = JSON.parse(data.toString()) as ServerMessage;
    if (m.type !== 'state') return;
    edades.push(performance.now() - (pasoEn.get(m.world.tick) ?? performance.now()));
    if (edades.length === 1) socket.send(JSON.stringify({ type: 'viewport', viewport: { x: -40, y: -30, width: 96, height: 64 } }));
  });
  const reloj = setInterval(() => { f.app.stepOnce(); pasoEn.set(f.app.world.tick, performance.now()); }, 100);
  await settle(15_000);
  clearInterval(reloj); socket.terminate();
  assert.ok(Math.max(...edades) > 5000, `sin acuse el retraso crece por encima de 5 s (${edades.map(e => e.toFixed(0)).join(', ')})`);
});

test('un state que tarda más que el silencio tolerado no tira la conexión: sus trozos la mantienen viva', async t => {
  // Sin compresión (perMessageDeflate: false) un 96×64 de ~1,3 MB tarda ~10 s a 1 Mbit/s: más que los
  // 8 s de silencio de `connection.ts`. Antes eso era «Sin conexión» y reconexión en bucle.
  const r = await clienteLento(t, { mbps: 1, duracionMs: 22_000, perMessageDeflate: false });
  const primerLive = r.estados.find(e => e.status === 'live');
  assert.ok(primerLive, 'llega a live');
  assert.deepEqual(r.estados.filter(e => e.t > primerLive.t).map(e => e.status), [], `nunca deja live: ${JSON.stringify(r.estados.map(e => e.status))}`);
  assert.equal(r.sockets, 1, 'un solo WebSocket en todo el recorrido: ninguna reconexión');
  assert.ok(r.huecoMaxMs < 8000, `siempre llega algún marco antes de 8 s (hueco máx. ${r.huecoMaxMs} ms)`);
  const grande = r.llegadas.find(l => l.bytes > 1024 * 1024);
  assert.ok(grande, `llega entero un state de más de 1 MiB (${r.llegadas.map(l => l.bytes).join(', ')})`);
});
