import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, DEEP_CHECKPOINT_EVERY_SAVES } from '../src/server/store.js';
import { createWorld, cloneWorld, type World } from '../src/world/index.js';
import { parseParams, setParams } from '../src/world/params.js';
import { recordChronicleEvent } from '../src/world/chronicle-journal.js';
import { generateChunk } from '../src/world/terrain.js';

/** Las pruebas fijan el momento del mundo sin simular: los cuerpos envejecen con él. */
function fixtureTick(world: World, tick: number): void {
  world.tick = tick; for (const person of world.people) person.demography.age = tick - person.bornAt;
}
function emit(world: World): void {
  const event = recordChronicleEvent(world, { kind: 'ecology', actors: [], text: 'Observación sintética.', cause: 'Fixture de prueba.', source: 'simulation' });
  world.events.push(event); if (world.events.length > 120) world.events.shift();
}
function laboratory(t: { after(callback: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-persistence-test-'));
  const path = join(directory, 'world.sqlite'), store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, path };
}
const serialsInArchive = (store: Store): number[] => (store.db.prepare("SELECT CAST(substr(id,2) AS INTEGER) AS serial FROM events WHERE id GLOB 'e[0-9]*' ORDER BY serial").all() as { serial: number }[]).map(row => row.serial);
const savedBody = (store: Store, slot: number): string | undefined => (store.db.prepare('SELECT body FROM snapshots WHERE slot=?').get(slot) as { body: string } | undefined)?.body;

test('sin ventana de poda el archivo conserva cada suceso y cada versión de terreno (control bit a bit)', t => {
  const { store } = laboratory(t);
  const world = createWorld(51926);
  store.save(world);
  for (let tick = 1; tick <= 12; tick++) {
    fixtureTick(world, tick);
    for (let n = 0; n < 12; n++) emit(world);
    if (tick === 4 || tick === 11) { const chunk = generateChunk(world.seed, -4, 7); chunk.discovered = true; chunk.lastTick = tick; world.retiredChunks = [chunk]; }
    store.save(world);
  }
  assert.equal(serialsInArchive(store).length, world.eventCounter);
  assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS n FROM chunks').get()!.n), 2);
  assert.deepEqual(store.load()!.world, world);
});

test('con ventana de poda el archivo retiene la ventana de sucesos y una sola versión por chunk, y sigue verificándose al cargar', t => {
  const { store, path } = laboratory(t);
  const world = createWorld(51926);
  setParams(world, parseParams('persistencia.ventanaEventosTicks=5'));
  store.save(world);
  for (let tick = 1; tick <= 20; tick++) {
    fixtureTick(world, tick);
    for (let n = 0; n < 10; n++) emit(world);
    if (tick === 4 || tick === 11 || tick === 18) { const chunk = generateChunk(world.seed, -4, 7); chunk.discovered = true; chunk.lastTick = tick; world.retiredChunks = [chunk]; }
    store.save(world);
  }
  const serials = serialsInArchive(store);
  assert.ok(serials.length < world.eventCounter, 'la poda tiene que haber borrado un prefijo del archivo');
  // La ventana viva (tick >= 20-5) y todo lo visible siguen estando.
  const retained = new Set(serials);
  for (const event of world.events) assert.ok(retained.has(Number(event.id.slice(1))), `el suceso visible ${event.id} no puede podarse`);
  for (const row of store.db.prepare('SELECT tick FROM events').all() as { tick: number }[]) assert.ok(row.tick >= 0);
  assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE tick>=?').get(world.tick - 5) as { n: number }).n, 10 * 5 + 10, 'la ventana pedida se conserva entera');
  // Del terreno solo sobrevive la versión más reciente de cada clave.
  assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS n FROM chunks').get()!.n), 1);
  assert.equal((store.db.prepare('SELECT tick FROM chunks').get() as { tick: number }).tick, 18);
  // La cadena de dígestes sigue cerrando contra la instantánea, también en una conexión nueva.
  assert.deepEqual(store.load()!.world, world);
  const reopened = new Store(path);
  try { assert.equal(reopened.load()!.world.eventCounter, world.eventCounter); } finally { reopened.close(); }
});

test('save() rechaza un estado que load() rechazaría y conserva el último guardado válido', t => {
  const { store } = laboratory(t);
  const world = createWorld(11);
  store.save(world);
  const draft = cloneWorld(world, store.context);
  fixtureTick(draft, 1);
  draft.tiles[0]!.wood = 99; // fuera del rango que assertWorld exige al cargar
  assert.throws(() => store.save(draft), /procedural|Invalid|inválido/i);
  const loaded = store.load()!;
  assert.equal(loaded.world.tick, 0);
  assert.equal(loaded.world.tiles[0]!.wood, world.tiles[0]!.wood);
});

test('load() bajo escritura concurrente lee una instantánea coherente en vez de declarar corrupción', t => {
  const { store, path } = laboratory(t);
  const world = createWorld(7);
  store.save(world);
  const reader = new Store(path);
  t.after(() => reader.close());
  const prepare = reader.db.prepare.bind(reader.db);
  let interrupted = false;
  reader.db.prepare = (sql: string) => {
    if (!interrupted && sql === 'SELECT id,tick,body FROM events WHERE id=?') {
      interrupted = true;
      fixtureTick(world, 5); emit(world); store.save(world); // otra conexión confirma en mitad de la lectura
    }
    return prepare(sql);
  };
  const loaded = reader.load();
  reader.db.prepare = prepare;
  assert.ok(interrupted, 'la escritura concurrente tiene que haber ocurrido durante la lectura');
  assert.equal(loaded!.world.tick, 0, 'el lector conserva la instantánea con la que abrió su transacción');
  assert.equal(reader.load()!.world.tick, 5, 'una lectura posterior ya ve el mundo confirmado');
});

test('cada cien guardados un tercer respaldo hereda la instantánea vigente', t => {
  const { store } = laboratory(t);
  const world = createWorld(3);
  for (let n = 1; n < DEEP_CHECKPOINT_EVERY_SAVES; n++) { fixtureTick(world, n); store.save(world); }
  assert.equal(savedBody(store, 2), undefined, 'el tercer respaldo no existe antes del guardado número cien');
  const inherited = savedBody(store, 0);
  fixtureTick(world, DEEP_CHECKPOINT_EVERY_SAVES); store.save(world);
  assert.equal(savedBody(store, 2), inherited);
  assert.equal(JSON.parse(savedBody(store, 1)!).tick, DEEP_CHECKPOINT_EVERY_SAVES - 1);
  assert.equal(JSON.parse(savedBody(store, 0)!).tick, DEEP_CHECKPOINT_EVERY_SAVES);
  assert.equal(JSON.parse(savedBody(store, 2)!).tick, DEEP_CHECKPOINT_EVERY_SAVES - 1);
});
