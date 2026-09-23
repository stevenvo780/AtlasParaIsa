import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Store, DEEP_CHECKPOINT_EVERY_SAVES, DEEP_VALIDATION_EVERY_SAVES, deepValidationDue } from '../src/server/store.js';
import { createWorld, cloneWorld, type World } from '../src/world/index.js';
import { parseParams, setParams } from '../src/world/params.js';
import { recordChronicleEvent } from '../src/world/chronicle-journal.js';
import { generateChunk } from '../src/world/terrain.js';
import { type ConLimpieza, laboratorio } from './lib/store.js';

/** Las pruebas fijan el momento del mundo sin simular: los cuerpos envejecen con él. */
function fixtureTick(world: World, tick: number): void {
  world.tick = tick; for (const person of world.people) person.demography.age = tick - person.bornAt;
}
function emit(world: World): void {
  const event = recordChronicleEvent(world, { kind: 'ecology', actors: [], text: 'Observación sintética.', cause: 'Fixture de prueba.', source: 'simulation' });
  world.events.push(event); if (world.events.length > 120) world.events.shift();
}
const laboratory = (t: ConLimpieza) => laboratorio(t, 'atlas-persistence-test-');
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

test('la revisión completa rechaza un estado que load() rechazaría y conserva el último guardado válido', t => {
  const { store } = laboratory(t);
  const world = createWorld(11);
  store.save(world); // guardado 0: siempre lleva revisión completa
  const invalid = () => { const draft = cloneWorld(world, store.context); draft.tiles[0]!.wood = 99; return draft; };
  // La revisión completa vuelve a tocar tras DEEP_VALIDATION_EVERY_SAVES guardados.
  for (let n = 1; n < DEEP_VALIDATION_EVERY_SAVES; n++) { const valid = cloneWorld(world, store.context); fixtureTick(valid, n); store.save(valid); }
  const draft = invalid();
  fixtureTick(draft, DEEP_VALIDATION_EVERY_SAVES);
  assert.throws(() => store.save(draft), /procedural|Invalid|inválido/i); // fuera del rango que assertWorld exige al cargar
  const loaded = store.load()!;
  assert.equal(loaded.world.tick, DEEP_VALIDATION_EVERY_SAVES - 1);
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

test('la cadena de respaldo rescata el guardado anterior cuando la instantánea vigente se corrompe y el archivo no ha avanzado', t => {
  const { store } = laboratory(t);
  const world = createWorld(3);
  store.save(world);
  fixtureTick(world, 1); store.save(world);
  assert.equal(JSON.parse(savedBody(store, 1)!).tick, 0);
  store.db.exec("UPDATE snapshots SET body='{}' WHERE slot=0");
  const loaded = store.load()!;
  assert.equal(loaded.world.tick, 0, 'la cadena adopta el slot 1 cuando el slot 0 no se puede verificar');
  assert.equal(loaded.slot, 1, 'la carga declara de qué eslabón salió el mundo');
  assert.equal(loaded.skipped.length, 1, 'y por qué se saltó el anterior');
  assert.match(loaded.skipped[0]!, /slot 0: snapshot checksum mismatch/);
  assert.equal(savedBody(store, 0), '{}', 'cargar no repara la cadena: escribir sigue siendo explícito');
});

test('un guardado tras el rescate no copia el slot 0 podrido encima del respaldo que lo salvó', t => {
  const { store } = laboratory(t);
  const world = createWorld(3);
  store.save(world);                         // slot 0 = tick 0
  fixtureTick(world, 1); store.save(world);  // slot 0 = tick 1, slot 1 = tick 0
  store.db.exec("UPDATE snapshots SET body='{}' WHERE slot=0");
  const rescued = store.load()!;
  assert.equal(rescued.slot, 1, 'el arranque salió del respaldo');

  // Sin esta ley, `save()` copiaba el slot 0 —ahora podrido— al slot 1 y el rescate
  // destruía en ~2 s el único respaldo bueno: fallar cerrado con red se convertía en
  // arrancar solo y sin red. Un cuerpo no verificado no entra nunca en un respaldo.
  fixtureTick(rescued.world, 2); store.save(rescued.world);
  assert.notEqual(savedBody(store, 1), '{}', 'el respaldo que salvó el arranque sobrevive al primer guardado');
  assert.equal(JSON.parse(savedBody(store, 1)!).tick, 0);
  assert.equal(JSON.parse(savedBody(store, 0)!).tick, 2, 'y el slot 0 ya es un guardado verificado');

  // Reparada la cadena, la rotación se reanuda sola: la profundidad no se pierde para siempre.
  fixtureTick(rescued.world, 3); store.save(rescued.world);
  assert.equal(JSON.parse(savedBody(store, 1)!).tick, 2);
  assert.equal(store.load()!.slot, 0, 'el siguiente arranque ya no necesita respaldo');
});

test('el respaldo profundo tampoco hereda un slot 0 sin verificar', t => {
  const { store } = laboratory(t);
  const world = createWorld(3);
  for (let n = 1; n < DEEP_CHECKPOINT_EVERY_SAVES; n++) { fixtureTick(world, n); store.save(world); }
  store.db.exec("UPDATE snapshots SET body='{}' WHERE slot=0");
  const rescued = store.load()!;
  assert.equal(rescued.slot, 1);
  // El guardado número cien es justo el que copia al slot 2: tampoco puede propagar basura.
  fixtureTick(rescued.world, DEEP_CHECKPOINT_EVERY_SAVES); store.save(rescued.world);
  assert.equal(savedBody(store, 2), undefined, 'un slot 0 podrido no se convierte en el respaldo profundo');
  assert.equal(JSON.parse(savedBody(store, 1)!).tick, DEEP_CHECKPOINT_EVERY_SAVES - 2, 'ni en el respaldo cercano');
});

test('una conexión que nunca cargó no puede guardar sobre un slot 0 ilegible: falla cerrada', t => {
  const { store, path } = laboratory(t);
  const world = createWorld(3);
  store.save(world);
  fixtureTick(world, 1); store.save(world);
  store.db.exec("UPDATE snapshots SET body='{}' WHERE slot=0");
  // El rescate de `load()` es la ÚNICA puerta por la que un slot 0 podrido llega a un
  // guardado: sin la prueba de crónica que deja la carga, el guardado se niega antes de
  // escribir nada, así que la rotación no llega a ocurrir y el respaldo sigue intacto.
  const otro = new Store(path);
  try {
    fixtureTick(world, 2);
    assert.throws(() => otro.save(world), /baseline snapshot checksum mismatch/);
    assert.equal(JSON.parse(savedBody(otro, 1)!).tick, 0, 'el respaldo bueno sigue ahí');
  } finally { otro.close(); }
});

test('una copia de respaldo no se adopta en caliente si el archivo durable guarda algo posterior', t => {
  const { store } = laboratory(t);
  const world = createWorld(3);
  store.save(world);
  fixtureTick(world, 1);
  const chunk = generateChunk(world.seed, -4, 7); chunk.discovered = true; chunk.lastTick = 1; world.retiredChunks = [chunk];
  store.save(world); // el archivo de terreno dormido avanza con el segundo guardado
  store.db.exec("UPDATE snapshots SET body='{}' WHERE slot=0");
  assert.throws(() => store.load(), /Backup snapshot is behind the durable archive/,
    'adoptar el respaldo tiraría la región ya archivada: la recuperación tiene que ser explícita');
  assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS n FROM chunks').get()!.n), 1, 'un arranque fallido no borra nada');
});

test('con los dos puntos recientes inutilizados, la cadena alcanza el tercer respaldo y previous() lo restaura', t => {
  const { store, path } = laboratory(t);
  const world = createWorld(3);
  for (let n = 1; n <= DEEP_CHECKPOINT_EVERY_SAVES; n++) { fixtureTick(world, n); store.save(world); }
  assert.equal(JSON.parse(savedBody(store, 2)!).tick, DEEP_CHECKPOINT_EVERY_SAVES - 1, 'el tercer respaldo existe tras cien guardados');
  store.db.exec("UPDATE snapshots SET body='{}' WHERE slot IN (0,1)");
  assert.equal(store.load()!.world.tick, DEEP_CHECKPOINT_EVERY_SAVES - 1, 'la cadena 0 → 1 → 2 llega al respaldo profundo');
  const destination = join(dirname(path), 'desde-slot-2.sqlite');
  assert.equal(store.previous(destination), 2, 'previous() informa del respaldo que restauró');
  const recovered = new Store(destination);
  try {
    assert.equal(recovered.load()!.world.tick, DEEP_CHECKPOINT_EVERY_SAVES - 1);
    assert.equal(Number(recovered.db.prepare('SELECT COUNT(*) AS n FROM snapshots').get()!.n), 1,
      'la copia recuperada empieza su propia cadena: no hereda respaldos inservibles');
  } finally { recovered.close(); }
});

test('previous() cede el turno al respaldo profundo solo cuando el guardado anterior no se puede verificar', t => {
  const { store, path } = laboratory(t);
  const world = createWorld(3);
  for (let n = 1; n <= DEEP_CHECKPOINT_EVERY_SAVES; n++) { fixtureTick(world, n); store.save(world); }
  const destination = join(dirname(path), 'desde-slot-1.sqlite');
  assert.equal(store.previous(destination), 1, 'con el slot 1 sano la profundidad no cambia');
  const recovered = new Store(destination);
  try { assert.equal(recovered.load()!.world.tick, DEEP_CHECKPOINT_EVERY_SAVES - 1); } finally { recovered.close(); }
  store.db.exec('DELETE FROM snapshots WHERE slot=2');
  store.db.exec("UPDATE snapshots SET body='{}' WHERE slot=1");
  const refused = join(dirname(path), 'sin-cadena.sqlite');
  assert.throws(() => store.previous(refused), /No valid previous checkpoint/);
  assert.equal(existsSync(refused), false, 'una recuperación imposible no deja copia a medias');
});

test('el guardado 0 no repite la revisión completa cuando load() ya la hizo; sin carga, sí', () => {
  assert.equal(deepValidationDue(0, false), true, 'proceso que crea el mundo: revisión completa en el primer guardado');
  assert.equal(deepValidationDue(0, true), false, 'proceso que cargó el mundo: load() ya lo revisó entero');
  for (const n of [1, 5, 9]) assert.equal(deepValidationDue(n, true), false);
  assert.equal(deepValidationDue(DEEP_VALIDATION_EVERY_SAVES, true), true, 'la cadencia sigue intacta tras la carga');
  assert.equal(deepValidationDue(DEEP_VALIDATION_EVERY_SAVES * 3, false), true);
});
