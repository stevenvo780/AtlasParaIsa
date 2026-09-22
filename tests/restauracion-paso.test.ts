/** T104 — punto de restauración del paso. Con `motor.clonPorPaso=false` el paso corre sobre el
 * mundo vigente: la atomicidad ya no la regala el clon, la sostiene `puntoDeRestauracion`. La
 * puerta de calidad es `digestoCanonico`, que sí mira `retiredChunks` (el hash durable los borra). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { Store, SessionRevoked } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';
import { cloneWorld, createWorld, puntoDeRestauracion, stepWorld, type World } from '../src/world/index.js';
import { digestoCanonico, diferenciaCanonica } from '../src/world/digesto.js';
import { DEFAULT_PARAMS, parseParams, setParams } from '../src/world/params.js';
import { chunkKey } from '../src/world/terrain.js';

/** `digestoCanonico` incluye los params efectivos, y `motor.clonPorPaso` es uno de ellos: para
 * comparar dos motores hay que mirar el mundo, no la clave que eligió el motor. */
const digestoDelMundo = (world: World): string => {
  const copia = cloneWorld(world); setParams(copia, DEFAULT_PARAMS); return digestoCanonico(copia);
};

async function freePort(): Promise<number> {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}
type Harness = { app: ReturnType<typeof createApp>; store: Store; origin: string; close: () => Promise<void> };
async function harness(clonPorPaso: boolean, extra = '', seed = 51926): Promise<Harness> {
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const store = new Store(':memory:');
  const params = parseParams(`motor.clonPorPaso=${clonPorPaso}${extra}`, DEFAULT_PARAMS);
  const app = createApp({ store, origin, password: 'restauracion-t104-password', manual: true, seed, params });
  return { app, store, origin, close: async () => { await app.close(); store.close(); } };
}
/** Lleva a todos los habitantes a un chunk vecino: el paso siguiente reanima terreno y retira el viejo. */
function mudar(world: World, dx: number, dy: number): void {
  for (const person of world.people) { person.x += dx; person.y += dy; person.target = { x: person.x, y: person.y }; }
}

test('(1) un fallo de store.save deja el digesto canónico exactamente como estaba antes del paso', async () => {
  const { app, store, close } = await harness(false);
  try {
    for (let n = 0; n < 12; n++) app.stepOnce();
    const antes = digestoCanonico(app.world), tick = app.world.tick;
    const mundoAntes = cloneWorld(app.world);
    store.save = () => { throw new Error('synthetic disk failure'); };
    assert.doesNotThrow(() => app.stepOnce());
    assert.equal(app.failed, true);
    assert.equal(app.world.tick, tick, 'el mundo no puede quedarse un tick por delante de lo confirmado');
    assert.equal(diferenciaCanonica(mundoAntes, app.world), null);
    assert.equal(digestoCanonico(app.world), antes);
  } finally { await close(); }
});

test('(2) el mismo fallo con un chunk reanimado en ese paso: el terreno dormido vuelve a su sitio', async () => {
  const { app, store, close } = await harness(false);
  try {
    // Alejarse retira el chunk de origen (y `save` lo archiva, vaciando `retiredChunks`); volver
    // lo reanima desde el archivo del anfitrión, que es el caso que el hash durable no ve.
    for (let n = 0; n < 4; n++) app.stepOnce();
    const origen = chunkKey(app.world.people[0]!.x, app.world.people[0]!.y);
    mudar(app.world, 40, 0);
    for (let n = 0; n < 3; n++) app.stepOnce();
    assert.equal(origen in app.world.chunks, false, 'el chunk de origen debería haberse retirado');
    mudar(app.world, -40, 0);
    let lecturas = 0;
    const leer = store.loadChunk.bind(store);
    store.loadChunk = (key, atTick) => { lecturas++; return leer(key, atTick); };
    const antes = digestoCanonico(app.world), teselas = app.world.tiles.length;
    const mundoAntes = cloneWorld(app.world);
    store.save = () => { throw new Error('synthetic disk failure') };
    assert.doesNotThrow(() => app.stepOnce());
    assert.equal(app.failed, true);
    assert.ok(lecturas > 0, 'el paso fallido tenía que haber reanimado terreno archivado');
    assert.equal(origen in app.world.chunks, false, 'la reanimación del chunk tiene que quedar deshecha');
    assert.equal(app.world.tiles.length, teselas);
    assert.equal(diferenciaCanonica(mundoAntes, app.world), null);
    assert.equal(digestoCanonico(app.world), antes);
  } finally { await close(); }
});

test('(3) `stepWorld` que lanza a mitad deja el mundo restaurado, no a medio paso', async () => {
  const { app, store, close } = await harness(false);
  try {
    for (let n = 0; n < 6; n++) app.stepOnce();
    // `activate` pide el chunk archivado al anfitrión desde dentro de `maintainRegions`, o sea
    // después de `world.tick++` y antes de la ecología: un fallo aquí es un paso a medias real.
    mudar(app.world, 40, 40);
    const antes = digestoCanonico(app.world), tick = app.world.tick;
    store.loadChunk = () => { throw new Error('synthetic mid-step failure'); };
    assert.doesNotThrow(() => app.stepOnce());
    assert.equal(app.failed, true);
    assert.equal(app.world.tick, tick);
    assert.equal(digestoCanonico(app.world), antes);
  } finally { await close(); }
});

test('(4) SessionRevoked: el mundo no avanza con un gesto aplicado y no confirmado', async () => {
  const { app, store, origin, close } = await harness(false);
  try {
    for (let n = 0; n < 6; n++) app.stepOnce();
    app.server.listen(Number(new URL(origin).port), '127.0.0.1'); await once(app.server, 'listening');
    const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'restauracion-t104-password' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const persona = app.world.people[0]!;
    const gesture = { id: 'restauracion-t104-gesto', kind: 'plant', x: persona.x + 1, y: persona.y };
    const enviado = fetch(origin + '/api/gesture', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(gesture) });
    for (let w = 0; w < 12; w++) await new Promise<void>(resolve => setImmediate(resolve));
    const antes = digestoCanonico(app.world), tick = app.world.tick;
    // Guardado real que revoca la sesión justo antes de confirmar: es la ruta viva, no un doble.
    const original = store.save.bind(store);
    store.save = (world, inputs, requiredSessions) => { store.revoke(requiredSessions?.[0]); return original(world, inputs, requiredSessions); };
    assert.doesNotThrow(() => app.stepOnce());
    assert.equal(app.failed, false, 'una sesión revocada no pausa el mundo');
    assert.equal(app.world.tick, tick, 'el gesto no confirmado no puede dejar el mundo un tick por delante');
    assert.equal(digestoCanonico(app.world), antes);
    assert.equal((await enviado).status, 401);
  } finally { await close(); }
});

test('(5) `motor.clonPorPaso=true` reproduce exactamente el mundo de hoy, tick a tick', async () => {
  // El gobernador (ruling R17) es el único punto donde el reloj de pared entra en el mundo:
  // apaga los nacimientos cuando el p95 supera su presupuesto. Comparar dos motores que corren
  // a velocidades distintas exige un presupuesto que ninguno de los dos alcance; si no, la
  // divergencia que se mide es la del host, no la del cambio.
  const presupuesto = ',gobernador.presupuestoMs=5000';
  const conClon = await harness(true, presupuesto), sinClon = await harness(false, presupuesto);
  try {
    for (let n = 0; n < 60; n++) {
      conClon.app.stepOnce(); sinClon.app.stepOnce();
      assert.equal(digestoDelMundo(sinClon.app.world), digestoDelMundo(conClon.app.world), `divergencia en el paso ${n + 1}`);
    }
    assert.equal(sinClon.app.world.tick, 60);
  } finally { await conClon.close(); await sinClon.close(); }
});

test('el punto de restauración deshace un paso completo sin servidor, paso a paso y en tres semillas', () => {
  for (const seed of [1, 7, 51926]) {
    let world = createWorld(seed);
    for (let n = 0; n < 40; n++) {
      const antes = digestoCanonico(world);
      const punto = puntoDeRestauracion(world);
      stepWorld(world);
      assert.notEqual(digestoCanonico(world), antes, `el paso ${n + 1} de la semilla ${seed} no cambió nada`);
      punto.restaurar();
      assert.equal(digestoCanonico(world), antes, `restauración incompleta en el paso ${n + 1} de la semilla ${seed}`);
      assert.throws(() => punto.restaurar(), /ya se consumió/);
      // Y después de deshacer, el mundo sigue siendo un mundo: el paso vuelve a dar lo mismo.
      const control = cloneWorld(world);
      stepWorld(world); stepWorld(control);
      assert.equal(digestoCanonico(world), digestoCanonico(control));
      world = control;
    }
  }
});

test('SessionRevoked con clon por paso sigue sin pausar el mundo ni avanzarlo', async () => {
  const { app, store, close } = await harness(true);
  try {
    for (let n = 0; n < 4; n++) app.stepOnce();
    const antes = digestoCanonico(app.world);
    store.save = () => { throw new SessionRevoked('Session revoked before commit.'); };
    assert.doesNotThrow(() => app.stepOnce());
    assert.equal(app.failed, false);
    assert.equal(digestoCanonico(app.world), antes);
  } finally { await close(); }
});
