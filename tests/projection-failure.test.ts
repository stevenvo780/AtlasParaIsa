import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { Store } from '../src/server/store.js';
import { createApp, VISTA_RESERVA_PASOS } from '../src/server/app.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { DEFAULT_PARAMS, parseParams } from '../src/world/params.js';
import type { ServerMessage, WorldView } from '../src/shared/types.js';
import type { World } from '../src/world/index.js';
import { freePort } from './lib/net.js';

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
    const readsBefore = reads;
    const paused = new Promise<ServerMessage>(resolve => client!.on('message', data => { const message = JSON.parse(data.toString()) as ServerMessage; if (message.type === 'state' && message.world.paused) resolve(message); }));
    store.save = () => { throw new Error('synthetic disk failure'); };
    assert.doesNotThrow(() => app.stepOnce());
    const message = await paused;
    assert.equal(message.type, 'state'); assert.equal(reads, readsBefore);
    // PERF3: sin gestos el paso corrió en el sitio y `app.world` quedó a medio paso; que nada lo sirva ni
    // lo guarde lo prueban las pruebas PERF3 de abajo. Lo confirmado sigue siendo el paso 5.
    assert.equal(app.failed, true); assert.equal(store.load()!.world.tick, 5);
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

/** Lleva a todos los habitantes lejos: el paso siguiente reanima terreno, y `activate` lee el archivo desde
 * `maintainRegions`, después de `world.tick++`. Si esa lectura falla, el paso queda a medias de verdad. */
function mudarLejos(world: World): void {
  for (const person of world.people) { person.x += 40; person.y += 40; person.target = { x: person.x, y: person.y }; }
}
async function servidorConSesion(seed: number) {
  const port = await freePort(), origin = `http://127.0.0.1:${port}`, store = new Store(':memory:');
  // Params por defecto: `motor.clonPorPaso=true`, el camino de producción.
  const app = createApp({ store, origin, password: 'synthetic-failure-password', manual: true, seed });
  app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'synthetic-failure-password' }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const ws = () => new WebSocket(origin.replace('http:', 'ws:') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
  const recibir = async (socket: WebSocket) => JSON.parse((await once(socket, 'message'))[0].toString()) as ServerMessage;
  return { app, store, origin, cookie, ws, recibir };
}

/** PERF3: con clon por paso (default y producción) el paso SIN gestos corre en el sitio, sin reserva. Si falla,
 * `app.world` queda a medio paso y el mundo se pausa como siempre; además ni `/api/world`, ni un cliente que
 * llega por WS, ni una consulta de biografía o de receta lo ven, y nada vuelve a guardarse. Lo que se sirve es
 * la última vista proyectada, marcada en pausa y con su paso. */
test('PERF3: un paso sin gestos que falla en el sitio pausa, y nada a medio paso se sirve ni se guarda', async () => {
  for (const fallo of ['a mitad del paso', 'al guardar'] as const) {
    const { app, store, origin, cookie, ws, recibir } = await servidorConSesion(42);
    let nuevo: WebSocket | undefined;
    try {
      for (let n = 0; n < 6; n++) app.stepOnce();
      const ultima = await (await fetch(origin + '/api/world', { headers: { Cookie: cookie } })).json() as WorldView;
      assert.equal(ultima.tick, 6); assert.equal(ultima.paused, undefined);
      let guardados = 0;
      const guardar = store.save.bind(store);
      if (fallo === 'a mitad del paso') {
        mudarLejos(app.world);
        store.loadChunk = () => { throw new Error('synthetic mid-step failure'); };
        store.save = (...args) => { guardados++; return guardar(...args); };
      } else store.save = () => { guardados++; throw new Error('synthetic disk failure'); };
      const mundo = app.world;
      assert.doesNotThrow(() => app.stepOnce());
      assert.equal(app.failed, true, fallo);
      assert.equal(app.world, mundo, 'sin gestos el paso corrió sobre el mundo vigente');
      assert.equal(app.world.tick, 7, `${fallo}: el mundo en memoria quedó a medio paso (o sin confirmar)`);
      const intentos = guardados;
      assert.equal(intentos, fallo === 'al guardar' ? 1 : 0);
      // `/api/world`, con otra cámara y con y sin gzip: la última vista, en pausa; nunca el paso 7.
      for (const encoding of ['gzip', 'identity']) {
        const respuesta = await fetch(origin + '/api/world?x=100&y=100&width=20&height=20',
          { headers: { Cookie: cookie, 'Accept-Encoding': encoding } });
        assert.equal(respuesta.status, 200);
        const servida = await respuesta.json() as WorldView;
        assert.equal(servida.tick, 6, `${fallo}/${encoding}`); assert.equal(servida.paused, true);
        assert.match(servida.pauseReason!, /a medias.*paso 6/);
        assert.deepEqual(servida.tiles, ultima.tiles); assert.deepEqual(servida.people, ultima.people);
      }
      // Un cliente que llega ahora recibe lo mismo; su cámara no provoca una proyección.
      nuevo = ws();
      const estado = await recibir(nuevo);
      assert.equal(estado.type, 'state');
      if (estado.type === 'state') { assert.equal(estado.world.tick, 6); assert.equal(estado.world.paused, true); }
      nuevo.send(JSON.stringify({ type: 'viewport', viewport: { x: -50, y: -50, width: 30, height: 20 } }));
      const camara = await recibir(nuevo);
      assert.equal(camara.type === 'state' && camara.world.tick, 6);
      for (const consulta of [{ type: 'persona', id: mundo.people[0]!.id }, { type: 'recipe', id: 'recipe-1' }]) {
        nuevo.send(JSON.stringify(consulta));
        const respuesta = await recibir(nuevo);
        assert.equal(respuesta.type, 'error', `${consulta.type} sobre un mundo a medio paso`);
        if (respuesta.type === 'error') assert.match(respuesta.message, /a medias/);
      }
      assert.equal((await fetch(origin + '/health')).status, 503);
      // Ni otro paso ni el cierre guardan.
      app.stepOnce();
      assert.equal(app.world.tick, 7);
      nuevo.terminate(); nuevo = undefined;
      await app.close();
      assert.equal(guardados, intentos, 'nada se guardó después del fallo');
      assert.equal(store.load()!.world.tick, 6, 'lo durable sigue siendo el paso 6');
    } finally { nuevo?.terminate(); await app.close(); store.close(); }
  }
});

/** Verificación PERF3 (2026-09-23): el servicio pasa horas sin visores. Sin vista de reserva, un paso sin gestos
 * que fallaba entonces dejaba `/api/world` en 503 para siempre y el cliente lo tomaba por «sin conexión»; la base
 * servía el mundo en pausa. Ahora `createApp` proyecta una vista al arrancar y la renueva cada
 * `VISTA_RESERVA_PASOS` pasos que nadie mira: lo servido es un estado completo, en pausa y con su paso. */
test('PERF3: sin visores, un mundo a medio paso sirve la vista de reserva del arranque o la renovada', async () => {
  for (const pasos of [3, VISTA_RESERVA_PASOS + 5]) {
    const { app, store, origin, cookie, ws, recibir } = await servidorConSesion(42);
    let nuevo: WebSocket | undefined;
    try {
      const inicio = app.world.tick, reserva = pasos < VISTA_RESERVA_PASOS ? inicio : inicio + VISTA_RESERVA_PASOS;
      for (let n = 0; n < pasos; n++) app.stepOnce();
      assert.equal(app.failed, false);
      mudarLejos(app.world);
      store.loadChunk = () => { throw new Error('synthetic mid-step failure'); };
      app.stepOnce();
      assert.equal(app.failed, true); assert.equal(app.world.tick, inicio + pasos + 1, 'el mundo en memoria quedó a medio paso');
      for (const encoding of ['gzip', 'identity']) {
        const respuesta = await fetch(origin + '/api/world', { headers: { Cookie: cookie, 'Accept-Encoding': encoding } });
        assert.equal(respuesta.status, 200, `${pasos} pasos/${encoding}: en pausa, no «sin conexión»`);
        const servida = await respuesta.json() as WorldView;
        assert.equal(servida.tick, reserva, `${pasos} pasos/${encoding}`); assert.equal(servida.paused, true);
        assert.match(servida.pauseReason!, new RegExp(`a medias.*paso ${reserva}\\)`));
      }
      nuevo = ws();
      const estado = await recibir(nuevo);
      assert.equal(estado.type === 'state' && estado.world.tick, reserva);
      assert.equal(estado.type === 'state' && estado.world.paused, true);
      assert.equal(store.load()!.world.tick, inicio + pasos, 'lo durable es el último paso confirmado');
    } finally { nuevo?.terminate(); await app.close(); store.close(); }
  }
});

test('PERF3: una región ilegible no impide arrancar; sin ninguna vista, un mundo a medio paso responde 503 «en pausa»', async () => {
  const port = await freePort(), origin = `http://127.0.0.1:${port}`, store = new Store(':memory:');
  const opciones = { store, origin, password: 'synthetic-failure-password', manual: true, seed: 42 };
  // Como la primera prueba: con todos en la esquina, la cámara por defecto pasa a leer regiones archivadas.
  const antes = createApp(opciones);
  for (const p of antes.world.people) { p.x = 39; p.y = 27; p.target = { x: p.x, y: p.y }; p.action = 'rest'; p.decisionAt = 1000; }
  for (let n = 0; n < 5; n++) antes.stepOnce();
  await antes.close();
  let lecturas = 0, nuevo: WebSocket | undefined;
  store.loadChunk = () => { lecturas++; throw new Error('synthetic archive read failure'); };
  const app = createApp(opciones);
  try {
    assert.ok(lecturas > 0, 'la vista de reserva del arranque leyó el archivo y falló, sin tumbar el arranque');
    const tick = app.world.tick;
    app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
    const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: opciones.password }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    mudarLejos(app.world);
    app.stepOnce();
    assert.equal(app.failed, true); assert.equal(app.world.tick, tick + 1);
    const respuesta = await fetch(origin + '/api/world', { headers: { Cookie: cookie } });
    assert.equal(respuesta.status, 503);
    assert.match((await respuesta.json() as { error: string }).error, /pausa.*a medias/);
    nuevo = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
    const primero = JSON.parse((await once(nuevo, 'message'))[0].toString()) as ServerMessage;
    assert.equal(primero.type, 'error');
    if (primero.type === 'error') assert.match(primero.message, /pausa.*a medias/);
    assert.equal(store.load()!.world.tick, tick);
  } finally { nuevo?.terminate(); await app.close(); store.close(); }
});
