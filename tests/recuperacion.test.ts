/**
 * Carril 0D (operación): un fallo del paso ya no pausa el mundo para siempre.
 * En turbo el paso sin gestos corre en el sitio (sin reserva): un error a mitad deja el mundo
 * a medias, se descarta y se recarga el último guardado. Tres fallos seguidos intentando salir
 * del mismo tick salen del proceso con 75. Un fallo del puente GPU en plena fase la termina CPU.
 */
import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freePort } from './lib/net.js';
import { Store } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';
import { bindWorldContext, cloneWorld, createWorld, stepWorld, worldContext, type World } from '../src/world/index.js';
import { ResidentTopologyOwner } from '../src/world/soa/topologia.js';
import { primeraDiferencia } from './lib/comparar.js';
import { DEFAULT_PARAMS, parseParams, setParams } from '../src/world/params.js';
import { gpuNvrtcAvailable } from '../src/world/gpu/puente.js';
import { dispositivosGpuApagados } from '../src/world/ecosystem-kernel.js';
import { closeEcosystemWorkers, killGpuSubprocessForTest } from '../src/world/ecosystem.js';
import { registrar, type Violacion } from '../src/world/invariantes.js';

/** Lleva a todos los habitantes a un chunk vecino no residente: el paso siguiente reanima terreno. */
function mudar(world: World, dx: number, dy: number): void {
  for (const person of world.people) { person.x += dx; person.y += dy; person.target = { x: person.x, y: person.y }; }
}

/**
 * Los params efectivos quedan fuera (se comparan los mundos, no su `motor.gpu`) y los números se comparan con tolerancia
 * relativa de 1e-9: desde V23 la tarjeta compila con FMA (sin paridad de 0 ULP con la CPU, decisión del 24-nov), así que
 * el mundo que corrió algunos ticks en la tarjeta y el gemelo de solo CPU difieren en el último dígito.
 */
const diferenciaDeMundos = (a: World, b: World): string | null => {
  const ca = cloneWorld(a), cb = cloneWorld(b); setParams(ca, DEFAULT_PARAMS); setParams(cb, DEFAULT_PARAMS);
  return primeraDiferencia(ca, cb);
};

/** Mundo turbo en memoria que guarda en cada paso (o según `params`), detenido en manual y con las salidas observadas. */
function mundoTurbo(salidas: number[], params = '') {
  const store = new Store(':memory:');
  const app = createApp({ store, origin: 'http://127.0.0.1:3000', password: 'recuperacion-0d-password',
    manual: true, turbo: true, tape: false, turboSaveIntervalMs: 0, seed: 51926, params: parseParams(params, DEFAULT_PARAMS),
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
      // El tercero sale sin recargar: el proceso muere y el siguiente arranca sobre el mismo guardado.
      if (intento < 3) assert.equal(app.world.tick, tickGuardado, `tras el intento ${intento} el mundo está en el guardado`);
      assert.deepEqual(salidas, intento < 3 ? [] : [75], `la salida solo llega al tercer fallo (intento ${intento})`);
    }
    assert.equal(app.salud().recargas, 2);
    assert.equal(app.failed, true, 'con la salida pedida el mundo queda detenido');
  } finally { await close(); }
});

test('la cuenta de fallos sobrevive a la recarga: tres intentos de superar el mismo tick salen con 75', async () => {
  // Guarda en el tick 5 y falla siempre al llegar al 8: tras cada recarga los pasos 6 y 7 salen bien,
  // y una cuenta que se borrara con cada paso exitoso no llegaría nunca a tres.
  const salidas: number[] = [];
  const { app, store, close } = mundoTurbo(salidas, 'persistencia.cadaTicks=5');
  try {
    for (let n = 0; n < 7; n++) app.stepOnce();
    assert.equal(store.load()!.world.tick, 5);
    const leer = store.loadChunk.bind(store);
    let falla = false;
    store.loadChunk = (key, atTick) => { if (falla) throw new Error('fallo persistente al llegar al tick 8'); return leer(key, atTick); };
    for (let intento = 1; intento <= 3; intento++) {
      while (app.world.tick < 7) app.stepOnce();
      mudar(app.world, 40, 40); falla = true;
      app.stepOnce(); falla = false;
      if (intento < 3) assert.equal(app.world.tick, 5, `tras el intento ${intento} el mundo volvió al guardado`);
      assert.deepEqual(salidas, intento < 3 ? [] : [75], `intento ${intento}`);
    }
    assert.equal(app.salud().recargas, 2, 'el tercer fallo sale sin gastar otra recarga');
  } finally { await close(); }
});

test('la recarga devuelve al mundo la propiedad residente de las teselas que le dio el arranque', async () => {
  const salidas: number[] = [];
  const { app, store, close } = mundoTurbo(salidas, 'motor.hilos=2');
  try {
    // Lo que hacen main.ts y el worker de simulación tras crear el mundo con un motor paralelo.
    const tileOwnership = new ResidentTopologyOwner();
    app.world.tiles = tileOwnership.tiles(app.world.tiles.map(tile => tileOwnership.tile(tile)));
    bindWorldContext(app.world, { ...worldContext(app.world), tileOwnership });
    for (let n = 0; n < 4; n++) app.stepOnce();
    const leer = store.loadChunk.bind(store);
    let falla = true;
    store.loadChunk = (key, atTick) => { if (falla) { falla = false; throw new Error('fallo sintético a mitad de paso'); } return leer(key, atTick); };
    mudar(app.world, 40, 40);
    app.stepOnce();
    assert.equal(app.salud().recargas, 1);
    assert.ok(worldContext(app.world).tileOwnership, 'el mundo recargado trae la propiedad residente');
    app.stepOnce(); app.stepOnce();
    assert.equal(app.failed, false);
    assert.deepEqual(salidas, []);
  } finally { await close(); }
});

test('una piscina de cómputo caída sale con 75 al primer fallo, sin recargar', async () => {
  const salidas: number[] = [];
  const { app, store, close } = mundoTurbo(salidas);
  try {
    for (let n = 0; n < 4; n++) app.stepOnce();
    store.loadChunk = () => { throw new Error('StaticWorkerPool abortado: Supervisor salió inesperadamente (código 1).'); };
    mudar(app.world, 40, 40);
    app.stepOnce();
    assert.deepEqual(salidas, [75]);
    assert.equal(app.salud().recargas, 0, 'una recarga no recrea las piscinas: solo un proceso nuevo lo hace');
    assert.equal(app.failed, true);
  } finally { await close(); }
});

test('tras una recarga con páginas sucias el guardado sigue y un reinicio posterior arranca', async () => {
  const salidas: number[] = [];
  const { app, store } = mundoTurbo(salidas, 'persistencia.paginasSucias=true,persistencia.cadaTicks=3');
  try {
    for (let n = 0; n < 8; n++) app.stepOnce();
    const leer = store.loadChunk.bind(store);
    let falla = true;
    store.loadChunk = (key, atTick) => { if (falla) { falla = false; throw new Error('fallo sintético a mitad de paso'); } return leer(key, atTick); };
    mudar(app.world, 40, 40);
    app.stepOnce();
    assert.equal(app.salud().recargas, 1);
    assert.equal(app.world.tick, 6);
    while (app.world.tick < 12) app.stepOnce();
    assert.equal(app.failed, false, 'el guardado siguiente reprodujo el mundo recargado');
    assert.equal(store.load()!.world.tick, 12);
    await app.close();
    const otro = createApp({ store, origin: 'http://127.0.0.1:3000', password: 'recuperacion-0d-password', manual: true, turbo: true, tape: false });
    try {
      otro.stepOnce();
      assert.equal(otro.world.tick, 13);
      assert.equal(otro.failed, false);
    } finally { await otro.close(); }
  } finally { store.close(); }
});

test('un mundo guardado con los nacimientos apagados por el gobernador antiguo los recupera; la pausa manual no sobrevive al reinicio', async () => {
  const salidas: number[] = [];
  const { app, store } = mundoTurbo(salidas);
  try {
    app.world.reproductionEnabled = false;
    app.stepOnce();
    assert.equal(store.load()!.world.reproductionEnabled, false, 'el guardado lleva el valor heredado');
    await app.close();
    const otro = createApp({ store, origin: 'http://127.0.0.1:3000', password: 'recuperacion-0d-password', manual: true, turbo: true, tape: false });
    try {
      assert.equal(otro.world.reproductionEnabled, true, 'al cargarlo se rehabilita');
      otro.setReproduccionManual(false);
      assert.equal(otro.world.reproductionEnabled, false);
      otro.stepOnce();
      assert.equal(otro.world.reproductionEnabled, false, 'la pausa manual manda mientras el proceso la mantenga');
      otro.setReproduccionManual(null);
      assert.equal(otro.world.reproductionEnabled, true);
    } finally { await otro.close(); }
  } finally { store.close(); }
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
  assert.deepEqual(salud.diagnostico, { duras24h: 0, blandas24h: 0, ultimaViolacion: null, errorBitacora: null, registrosSinBitacora: 0 });
  assert.equal(salud.status, 'ok', 'el campo histórico se conserva para quien lo consume');
});

test('una violación dura degrada /health, deja avanzar y queda en bitácora al cerrar', async (t) => {
  const base = '/tmp/atlas-v23-i0a';
  mkdirSync(base, { recursive: true });
  const directorio = mkdtempSync(join(base, 'diagnostico-'));
  const store = new Store(join(directorio, 'world.sqlite'));
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const id = 'prueba.salud';
  const retirar = registrar({ id, carril: 'I0a', gravedad: 'dura', alcance: 'global', cadaTicks: 120,
    comprobar: mundo => [{ id, tick: mundo.tick, gravedad: 'dura', detalle: 'Incidencia de prueba' }] });
  let ahora = 0;
  const app = createApp({ store, origin, password: 'recuperacion-0d-password', manual: true, commit: 'commit-prueba',
    monotonicNow: () => ahora += 1000 });
  t.after(async () => {
    retirar();
    try { await app.close(); } finally { store.close(); rmSync(directorio, { recursive: true, force: true }); }
  });
  for (let n = 0; n < 10 && !app.salud().diagnostico.duras24h; n++) app.stepOnce();
  const tick = app.world.tick;
  app.stepOnce();
  assert.equal(app.world.tick, tick + 1);
  app.server.listen(port, '127.0.0.1');
  await once(app.server, 'listening');
  const respuesta = await fetch(`${origin}/health`);
  assert.equal(respuesta.status, 200);
  const salud = await respuesta.json();
  assert.equal(salud.estado, 'degradado');
  assert.equal(salud.diagnostico.duras24h, 1);
  assert.equal(salud.diagnostico.ultimaViolacion, id);
  await app.close();
  const registro = JSON.parse(readFileSync(join(directorio, 'diagnostico', 'invariantes.jsonl'), 'utf8'));
  assert.equal(registro.commit, 'commit-prueba');
  assert.equal(registro.violacion.id, id);
});

/** Mundo en un directorio de datos propio con una invariante dura que dispara en el primer paso. */
function mundoConIncidencia(t: TestContext, id: string, comprobar: (mundo: World) => Violacion[]) {
  const base = '/tmp/atlas-v23-i0a';
  mkdirSync(base, { recursive: true });
  const directorio = mkdtempSync(join(base, 'diagnostico-'));
  const store = new Store(join(directorio, 'world.sqlite'));
  const retirar = registrar({ id, carril: 'I0a', gravedad: 'dura', alcance: 'global', cadaTicks: 120, comprobar });
  let ahora = 0;
  const app = createApp({ store, origin: 'http://127.0.0.1:1', password: 'recuperacion-0d-password', manual: true,
    monotonicNow: () => ahora += 1000 });
  t.after(async () => {
    retirar();
    try { await app.close().catch(() => undefined); } finally { store.close(); rmSync(directorio, { recursive: true, force: true }); }
  });
  return { app, directorio };
}

test('un fallo del muestreador no se salta la telemetría del paso ni detiene el mundo', t => {
  const aviso = t.mock.method(console, 'warn', () => undefined);
  const id = 'prueba.muestreo-roto';
  const { app } = mundoConIncidencia(t, id, mundo => [{ id, tick: mundo.tick, gravedad: 'dura', detalle: 'Contexto ilegible',
    contexto: { get x(): number { throw new Error('contexto corrupto'); } } }]);
  const avisos = () => aviso.mock.calls.filter(c => String(c.arguments[0]).includes('muestreador de invariantes'));
  const tick = app.world.tick;
  // El crédito del muestreador es una fracción del paso: con la torre cargada la invariante puede tardar unos pasos.
  let pasos = 0;
  while (!avisos().length && pasos < 40) { app.stepOnce(); pasos++; }
  assert.ok(avisos().length >= 1, 'el fallo del muestreador se anota');
  assert.equal(app.world.tick, tick + pasos, 'el mundo siguió avanzando');
  assert.ok(app.runtime.p95StepMs > 0, 'la medición del paso se completa pese al fallo del diagnóstico');
  assert.equal(app.salud().estado, 'degradado', 'la violación dura sí cuenta');
});

test('/health no revela rutas cuando la bitácora falla y cerrar el servidor no falla por ello', async t => {
  const id = 'prueba.bitacora-rota';
  const { app, directorio } = mundoConIncidencia(t, id, mundo => [{ id, tick: mundo.tick, gravedad: 'dura', detalle: 'Incidencia de prueba' }]);
  writeFileSync(join(directorio, 'diagnostico'), 'no es un directorio');
  for (let n = 0; n < 40 && !app.salud().diagnostico.duras24h; n++) app.stepOnce();
  for (let n = 0; n < 500 && !app.salud().diagnostico.errorBitacora; n++) await new Promise(resolve => setTimeout(resolve, 10));
  const { diagnostico } = app.salud();
  assert.equal(diagnostico.errorBitacora, 'EEXIST');
  assert.equal(diagnostico.registrosSinBitacora, 1);
  const puerto = await freePort();
  app.server.listen(puerto, '127.0.0.1');
  await once(app.server, 'listening');
  const cuerpo = await (await fetch(`http://127.0.0.1:${puerto}/health`)).text();
  assert.ok(!cuerpo.includes(directorio) && !cuerpo.includes('diagnostico/'), 'ninguna ruta del servidor sale por /health');
  await assert.doesNotReject(app.close());
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
    assert.equal(diferenciaDeMundos(conGpu, soloCpu), null, 'el tick por CPU es el mismo mundo');
    // Los ticks ecológicos siguientes, ya con la tarjeta apagada y un solo hilo, también los acaba la CPU.
    for (let i = 0; i < 20; i++) { assert.doesNotThrow(() => stepWorld(conGpu)); stepWorld(soloCpu); }
    assert.equal(diferenciaDeMundos(conGpu, soloCpu), null, 'y siguen siendo el mismo mundo');
  });
