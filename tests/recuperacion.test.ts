/**
 * Carril 0D (operación): un fallo del paso ya no pausa el mundo para siempre.
 * En turbo el paso sin gestos corre en el sitio (sin reserva): un error a mitad deja el mundo
 * a medias, se descarta y se recarga el último guardado. Tres fallos seguidos intentando salir
 * del mismo tick salen del proceso con 75. Un fallo del puente GPU en plena fase la termina CPU.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freePort } from './lib/net.js';
import { Store } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';
import { cloneWorld, createWorld, stepWorld, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { DEFAULT_PARAMS, parseParams, setParams } from '../src/world/params.js';
import { gpuNvrtcAvailable } from '../src/world/gpu/puente.js';
import { dispositivosGpuApagados } from '../src/world/ecosystem-kernel.js';
import { closeEcosystemWorkers, killGpuSubprocessForTest } from '../src/world/ecosystem.js';

/** Lleva a todos los habitantes a un chunk vecino no residente: el paso siguiente reanima terreno. */
function mudar(world: World, dx: number, dy: number): void {
  for (const person of world.people) { person.x += dx; person.y += dy; person.target = { x: person.x, y: person.y }; }
}

/** El digesto incluye los params efectivos: se comparan los mundos, no su `motor.gpu`. */
const digestoDelMundo = (world: World): string => {
  const copia = cloneWorld(world); setParams(copia, DEFAULT_PARAMS); return digestoCanonico(copia);
};

/** Mundo turbo en memoria que guarda en cada paso, detenido en manual y con las salidas observadas. */
function mundoTurbo(salidas: number[]) {
  const store = new Store(':memory:');
  const app = createApp({ store, origin: 'http://127.0.0.1:3000', password: 'recuperacion-0d-password',
    manual: true, turbo: true, tape: false, turboSaveIntervalMs: 0, seed: 51926,
    onFatalExit: codigo => { salidas.push(codigo); } });
  return { app, store, close: async () => { await app.close(); store.close(); } };
}

test('una excepción a mitad de paso sin reserva recarga el último guardado y el mundo sigue', async () => {
  const salidas: number[] = [];
  const { app, store, close } = mundoTurbo(salidas);
  try {
    for (let n = 0; n < 6; n++) app.stepOnce();
    const tickGuardado = store.load()!.world.tick;
    assert.equal(tickGuardado, app.world.tick, 'cada paso quedó guardado');
    // Mudanza solo en memoria, sin guardar: si tras el fallo el mundo vuelve a las posiciones
    // guardadas, la recuperación vino del disco y no de una restauración en memoria.
    const posicionesGuardadas = app.world.people.map(p => `${p.x},${p.y}`);
    mudar(app.world, 40, 40);
    const leer = store.loadChunk.bind(store);
    let armado = true;
    store.loadChunk = (key, atTick) => {
      if (armado) { armado = false; throw new Error('fallo sintético a mitad de paso'); }
      return leer(key, atTick);
    };
    app.stepOnce();
    assert.equal(app.failed, false, 'el mundo no queda pausado');
    assert.equal(app.world.tick, tickGuardado, 'volvió al tick del guardado');
    assert.deepEqual(app.world.people.map(p => `${p.x},${p.y}`), posicionesGuardadas, 'la mudanza sin guardar se perdió: vino del disco');
    assert.equal(app.salud().recargas, 1);
    assert.equal(app.salud().estado, 'ok');
    assert.deepEqual(salidas, []);
    app.stepOnce();
    assert.equal(app.world.tick, tickGuardado + 1, 'y sigue avanzando');
  } finally { await close(); }
});

test('tres fallos seguidos intentando salir del mismo tick salen con 75', async () => {
  const salidas: number[] = [];
  const { app, store, close } = mundoTurbo(salidas);
  try {
    for (let n = 0; n < 4; n++) app.stepOnce();
    const tickGuardado = store.load()!.world.tick;
    store.loadChunk = () => { throw new Error('fallo persistente a mitad de paso'); };
    for (let intento = 1; intento <= 3; intento++) {
      // La recarga perdió la mudanza: se repite para volver a estrellarse al salir del mismo tick.
      mudar(app.world, 40, 40);
      app.stepOnce();
      assert.equal(app.world.tick, tickGuardado, `tras el intento ${intento} el mundo está en el guardado`);
      assert.deepEqual(salidas, intento < 3 ? [] : [75], `la salida solo llega al tercer fallo (intento ${intento})`);
    }
    assert.equal(app.salud().recargas, 3);
    assert.equal(app.failed, true, 'con la salida pedida el mundo queda detenido');
  } finally { await close(); }
});

test('/health sirve la Salud y responde 200 con el mundo avanzando', async (t) => {
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const store = new Store(':memory:');
  const app = createApp({ store, origin, password: 'recuperacion-0d-password', manual: true, seed: 51926 });
  t.after(async () => { await app.close(); store.close(); });
  app.stepOnce(); app.stepOnce();
  app.server.listen(port, '127.0.0.1');
  await once(app.server, 'listening');
  const respuesta = await fetch(`${origin}/health`);
  assert.equal(respuesta.status, 200);
  const salud = await respuesta.json() as Record<string, unknown>;
  assert.equal(salud.estado, 'ok');
  assert.equal(salud.tick, app.world.tick);
  assert.equal(typeof salud.ticksPorSegundo, 'number');
  assert.ok((salud.segundosDesdeUltimoPaso as number) >= 0 && (salud.segundosDesdeUltimoPaso as number) < 60);
  assert.equal(typeof salud.ultimoGuardado, 'number');
  assert.deepEqual(salud.gpu, [], 'sin GPU configurada no hay tarjetas que informar');
  assert.equal(salud.recargas, 0);
  assert.equal(salud.status, 'ok', 'el campo histórico se conserva para quien lo consume');
});

after(async () => { await closeEcosystemWorkers(); });

test('un fallo del puente GPU a mitad de paso termina el tick por CPU y apaga la tarjeta',
  { skip: gpuNvrtcAvailable() ? false : 'sin NVRTC/CUDA en esta máquina' }, () => {
    const conGpu = createWorld(51926, parseParams('motor.gpu=[0],motor.hilos=1'));
    const soloCpu = createWorld(51926, parseParams('motor.hilos=1'));
    for (let i = 0; i < 19; i++) { stepWorld(conGpu); stepWorld(soloCpu); }
    killGpuSubprocessForTest();
    // El paso a tick 20 corre las fases ecológicas: el puente muerto ya no lanza, la CPU las acaba.
    assert.doesNotThrow(() => stepWorld(conGpu));
    stepWorld(soloCpu);
    assert.equal(conGpu.tick, 20);
    assert.ok(dispositivosGpuApagados.has(0), 'la tarjeta queda apagada hasta el siguiente arranque');
    assert.equal(digestoDelMundo(conGpu), digestoDelMundo(soloCpu), 'el tick por CPU es el mismo mundo');
  });
