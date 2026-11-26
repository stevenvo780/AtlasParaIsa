import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { createApp } from '../src/server/app.js';
import { createWorkerGateway, type WorkerGatewayOptions } from '../src/server/gateway.js';
import { Store } from '../src/server/store.js';
import { escalon } from '../src/shared/interruptores.js';
import type { WorldView } from '../src/shared/types.js';
import { parseParams } from '../src/world/params.js';

const ORIGIN = 'https://carta.test';
const PASSWORD = 'v24-pulso-espejo-password';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function prepararDir(t: TestContext): { worldPath: string; staticDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'carta-pulso-'));
  const staticDir = join(dir, 'client');
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, 'index.html'), '<html>pulso</html>');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { worldPath: join(dir, 'world.sqlite'), staticDir };
}

function conexionEnMemoria(server: ReturnType<typeof createWorkerGateway>['server']): Socket {
  class Endpoint extends Duplex {
    peer!: Endpoint;
    remoteAddress = '127.0.0.1';
    _read() {}
    _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
      queueMicrotask(() => { if (!this.peer.destroyed) this.peer.push(Buffer.from(chunk)); });
      done();
    }
    _final(done: () => void) { queueMicrotask(() => this.peer.push(null)); done(); }
    setTimeout() { return this; }
    setNoDelay() { return this; }
    setKeepAlive() { return this; }
    ref() { return this; }
    unref() { return this; }
    address() { return { address: '127.0.0.1', port: 80, family: 'IPv4' }; }
  }
  const client = new Endpoint(), srv = new Endpoint();
  client.peer = srv; srv.peer = client;
  server.emit('connection', srv);
  return client as unknown as Socket;
}

function loginCookie(server: ReturnType<typeof createWorkerGateway>['server']): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ password: PASSWORD });
    const req = request({
      hostname: '127.0.0.1', port: 80, path: '/api/login', method: 'POST',
      createConnection: () => conexionEnMemoria(server),
      headers: { Host: 'carta.test', Origin: ORIGIN, Connection: 'close', 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) },
    }, res => {
      res.resume();
      res.on('end', () => {
        if (res.statusCode !== 200) reject(new Error(`login ${res.statusCode}`));
        else resolve(res.headers['set-cookie']![0]!.split(';')[0]!);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function esperarHasta(condicion: () => boolean, limiteMs = 10_000): Promise<void> {
  const fin = performance.now() + limiteMs;
  while (!condicion()) {
    if (performance.now() >= fin) throw new Error('Plazo agotado esperando condición.');
    await wait(25);
  }
}

test('sin demanda: pulso ligero mantiene reloj y salud vivos sin disparar motor.vista ni espejos rutinarios', { timeout: 30_000 }, async t => {
  const prevHilos = process.env.CARTA_MOTOR_HILOS;
  process.env.CARTA_MOTOR_HILOS = '2';
  const { worldPath, staticDir } = prepararDir(t);
  const params = parseParams({ v23: escalon('duenos'), persistencia: { cadaTicks: 5000 } });
  const gateway = createWorkerGateway({
    worldPath, staticDir, origin: ORIGIN, secure: true, password: PASSWORD,
    seed: 17, params, manual: true, turbo: true, tape: false, turboSaveIntervalMs: 300_000,
  });
  t.after(async () => {
    await gateway.close();
    if (prevHilos === undefined) delete process.env.CARTA_MOTOR_HILOS; else process.env.CARTA_MOTOR_HILOS = prevHilos;
  });

  await gateway.ready;
  // Arranque inicial conservado: el espejo inicial ya sirve mapa y salud.
  assert.equal(gateway.observador.espejos, 1);
  assert.ok(gateway.worldmap().chunks.length > 0);
  const vistasTrasArranque = gateway.observador.vistasMotor;
  const mapaTickInicial = gateway.worldmap().tick;

  gateway.start();
  await esperarHasta(() => gateway.observador.pulsos >= 2 && gateway.salud().tick >= 4);

  const salud = gateway.salud();
  const traza = gateway.observador;
  assert.equal(salud.estado, 'ok', 'la salud sigue ok vía pulso ligero aunque el mapa esté viejo');
  assert.ok(salud.tick > mapaTickInicial, `el reloj avanzó (${salud.tick} > ${mapaTickInicial})`);
  assert.ok(salud.ticksPorSegundo > 0, 'el reloj independiente publica ticksPorSegundo');
  assert.equal(traza.espejos, 1, 'sin demanda no se enviaron espejos rutinarios tras el arranque');
  assert.equal(traza.vistasMotor, vistasTrasArranque, 'sin demanda no se volvió a llamar motor.vista()');
  assert.ok(traza.espejosSinDemanda >= 2, `debe registrar cadencias omitidas (${traza.espejosSinDemanda})`);
  assert.ok(gateway.runtime.activeTiles > 0, 'activeTiles sigue vivo sin vista global');
});

test('visor vivo sin cinta recupera espejos, aplica contrapresión de 1 en vuelo y vuelve a pulso al desconectar', { timeout: 30_000 }, async t => {
  const prevHilos = process.env.CARTA_MOTOR_HILOS;
  process.env.CARTA_MOTOR_HILOS = '2';
  const { worldPath, staticDir } = prepararDir(t);
  const params = parseParams({ v23: escalon('duenos'), persistencia: { cadaTicks: 5000 } });
  const gateway = createWorkerGateway({
    worldPath, staticDir, origin: ORIGIN, secure: true, password: PASSWORD,
    seed: 29, params, manual: true, turbo: true, tape: false, turboSaveIntervalMs: 300_000,
    testMirrorApplyDelayMs: 350,
  } satisfies WorkerGatewayOptions);
  t.after(async () => {
    await gateway.close();
    if (prevHilos === undefined) delete process.env.CARTA_MOTOR_HILOS; else process.env.CARTA_MOTOR_HILOS = prevHilos;
  });

  await gateway.ready;
  const cookie = await loginCookie(gateway.server);
  gateway.start();
  await esperarHasta(() => gateway.observador.pulsos >= 1 && gateway.salud().tick >= 2);
  assert.equal(gateway.observador.espejos, 1, 'antes del visor vivo no hubo espejos extra');

  // Conecta un visor WS vivo sin cinta: debe recuperar espejos y sostener 1 en vuelo como máximo.
  let maxEnVuelo = 0;
  gateway.events.on('pulso', () => { maxEnVuelo = Math.max(maxEnVuelo, gateway.observador.enVuelo); });
  const ws = new WebSocket('ws://127.0.0.1:80/ws?ack=1&x=0&y=0&width=20&height=20', {
    headers: { Host: 'carta.test', Origin: ORIGIN, Cookie: cookie }, perMessageDeflate: false,
    createConnection: () => conexionEnMemoria(gateway.server),
  });
  const ticksRecibidos: number[] = [];
  let trozos = 0;
  const partes: string[] = [];
  ws.on('message', data => {
    let text = data.toString();
    if (trozos) { partes.push(text); if (--trozos) return; text = partes.join(''); partes.length = 0; }
    const msg = JSON.parse(text) as { type: string; partes?: number; world?: WorldView; sequence?: number };
    if (msg.type === 'trozos' && msg.partes) { trozos = msg.partes; return; }
    if (msg.type === 'state' && msg.world) {
      ticksRecibidos.push(msg.world.tick);
      ws.send(JSON.stringify({ type: 'ack', sequence: msg.world.sequence }));
    } else if (msg.type === 'delta' && typeof msg.sequence === 'number') {
      ticksRecibidos.push(msg.sequence);
      ws.send(JSON.stringify({ type: 'ack', sequence: msg.sequence }));
    }
  });
  t.after(() => ws.terminate());
  await once(ws, 'open');

  await esperarHasta(() => ticksRecibidos.some(tk => tk > 0) && gateway.observador.espejosEnVueloOmitidos >= 1, 12_000);
  assert.ok(gateway.observador.espejos >= 2, 'el visor vivo recuperó espejos');
  assert.ok(maxEnVuelo <= 1, `nunca más de 1 espejo rutinario en vuelo (visto ${maxEnVuelo})`);
  assert.ok(gateway.observador.espejosEnVueloOmitidos >= 1, 'la contrapresión aplazó cadencias mientras applyMirror seguía ocupado');
  assert.equal(gateway.salud().estado, 'ok');

  // Al cerrar el visor vivo, deja de emitir espejos rutinarios y vuelve a pulso ligero.
  ws.close();
  await once(ws, 'close');
  await wait(450); // drena el único espejo que pudiera seguir en applyMirror
  const espejosAlSalir = gateway.observador.espejos;
  const vistasAlSalir = gateway.observador.vistasMotor;
  const pulsosAlSalir = gateway.observador.pulsos;
  await esperarHasta(() => gateway.observador.pulsos >= pulsosAlSalir + 2);
  assert.equal(gateway.observador.espejos, espejosAlSalir, 'sin visor conectado no se generan más espejos');
  assert.equal(gateway.observador.vistasMotor, vistasAlSalir, 'sin visor conectado no se llama motor.vista()');
});

test('transporte local sin sim-worker evita motor.vista sin clientes WS y conserva la ficha exacta; fallback espejoSiempre', { timeout: 30_000 }, async t => {
  const prevHilos = process.env.CARTA_MOTOR_HILOS;
  process.env.CARTA_MOTOR_HILOS = '2';
  const params = parseParams({ v23: escalon('duenos'), persistencia: { cadaTicks: 5000 } });
  const store = new Store(':memory:');
  let reloj = 0;
  const app = createApp({
    store, origin: ORIGIN, password: PASSWORD, seed: 31, params,
    manual: true, turbo: true, tape: false, turboSaveIntervalMs: 300_000,
    monotonicNow: () => reloj,
  });
  const { worldPath, staticDir } = prepararDir(t);
  const fallback = createWorkerGateway({
    worldPath, staticDir, origin: ORIGIN, secure: true, password: PASSWORD,
    seed: 31, params, manual: true, turbo: true, tape: false, turboSaveIntervalMs: 300_000,
    espejoSiempre: true,
  });
  t.after(async () => {
    await fallback.close();
    await app.close();
    store.close();
    if (prevHilos === undefined) delete process.env.CARTA_MOTOR_HILOS; else process.env.CARTA_MOTOR_HILOS = prevHilos;
  });

  // Transporte local sin clientes WS: avanzar pasos cruzando TURBO_MIRROR_MS (reloj real) no llama motor.vista().
  const vistasIniciales = app.vistasMotor;
  app.stepOnce();
  await wait(280);
  app.stepOnce();
  assert.equal(app.vistasMotor, vistasIniciales, 'app local sin clientes WS evita motor.vista() en difundir');
  assert.ok(app.runtime.activeTiles > 0);
  // La ficha sigue trayendo datos exactos del habitante vivo (sin cambios a detallePersona).
  const primero = app.mundoParaEmision(true).people[0]!;
  const pendienteFicha = app.detallePersona(primero.id);
  app.stepOnce();
  const ficha = await pendienteFicha;
  assert.ok(ficha && ficha.id === primero.id && ficha.vivo === true && ficha.familia !== undefined);

  // Ruta de fallback explícita (`espejoSiempre: true`): vuelve a emitir espejos aunque no haya demanda.
  await fallback.ready;
  fallback.start();
  await esperarHasta(() => fallback.observador.espejos >= 3);
  assert.equal(fallback.observador.espejosSinDemanda, 0, 'en fallback espejoSiempre no se omiten espejos por falta de demanda');
});
