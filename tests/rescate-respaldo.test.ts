import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { freePort } from './lib/net.js';
import { once } from 'node:events';
import { Store } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';
import { createWorld, type World } from '../src/world/index.js';
import { type ConLimpieza, directorioTemporal, filaInstantanea } from './lib/store.js';

/**
 * R2 (ronda de corrección): arrancar desde un respaldo es un hecho que Isa lee en la
 * crónica y que el operador tiene que poder ver. Mientras el rescate fue silencioso, el
 * suceso de pausa publicaba «el mundo retoma desde su último momento guardado», que tras
 * un rescate es literalmente falso: se retrocede y se pierde lo simulado en medio.
 */
const password = 'synthetic-test-password-only';
const laboratory = (t: ConLimpieza) => ({ path: join(directorioTemporal(t, 'atlas-rescate-test-'), 'world.sqlite') });
/** Deja un archivo con dos guardados y el vigente ilegible; devuelve el retroceso simulado. */
function archivoConElVigenteDaniado(path: string, retrocesoSegundos: number): void {
  const store = new Store(path);
  try {
    const world = createWorld(42);
    store.save(world);
    world.tick = 1; store.save(world);
    store.db.exec("UPDATE snapshots SET body='{}' WHERE slot=0");
    const respaldo = (store.db.prepare('SELECT saved_at FROM snapshots WHERE slot=1').get() as { saved_at: number }).saved_at;
    store.db.prepare('UPDATE snapshots SET saved_at=? WHERE slot=0').run(respaldo + retrocesoSegundos * 1000);
  } finally { store.close(); }
}
const pausa = (world: World) => world.events.filter(event => event.kind === 'pause').at(-1)!;

test('arrancar desde un respaldo se dice en la crónica, en /health y por consola', async t => {
  const { path } = laboratory(t);
  archivoConElVigenteDaniado(path, 42);
  const store = new Store(path);
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const avisos: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { avisos.push(args.map(String).join(' ')); };
  let app;
  try { app = createApp({ store, password, origin, manual: true, seed: 42 }); }
  finally { console.warn = warn; }
  app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app!.close(); store.close(); });

  assert.equal(app.world.tick, 0, 'el mundo servido es el del respaldo');
  const evento = pausa(app.world);
  assert.match(evento.text, /respaldo/, 'la crónica no puede decir que retoma el último momento guardado');
  assert.doesNotMatch(evento.text, /su último momento guardado/);
  assert.match(evento.cause, /42 s/, 'declara cuánto se retrocedió');
  assert.match(evento.cause, /respaldo 1/, 'y de qué eslabón salió');

  const salud = await (await fetch(origin + '/health')).json() as { status: string; respaldo?: { slot: number; retrocesoSegundos: number } };
  assert.equal(salud.status, 'ok');
  assert.deepEqual(salud.respaldo, { slot: 1, retrocesoSegundos: 42 }, '/health deja la degradación a la vista del operador');

  assert.equal(avisos.length, 1, 'el operador se entera por consola una vez, al arrancar');
  assert.match(avisos[0]!, /respaldo 1/);
  assert.match(avisos[0]!, /42 s/);

  // El guardado de `createApp` no destruye el respaldo del que acaba de salir.
  const respaldo = filaInstantanea(store, 1);
  assert.equal(JSON.parse(respaldo.body).tick, 0);
});

test('sin rescate la crónica conserva su frase de siempre y /health no inventa un respaldo', async t => {
  const { path } = laboratory(t);
  const primero = new Store(path);
  try { primero.save(createWorld(42)); } finally { primero.close(); }
  const store = new Store(path);
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const app = createApp({ store, password, origin, manual: true, seed: 42 });
  app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.close(); store.close(); });

  const evento = pausa(app.world);
  assert.equal(evento.text, 'El servicio estuvo en pausa. El mundo retoma desde su último momento guardado.');
  assert.equal(evento.cause, 'Reinicio del servicio; sin avance retrospectivo.');
  const salud = await (await fetch(origin + '/health')).json() as { status: string; respaldo?: unknown };
  assert.equal(salud.status, 'ok');
  assert.equal('respaldo' in salud, false, 'sin degradación no hay nada que declarar');
});
