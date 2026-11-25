import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/server/store.js';
import { SNAPSHOT_INLINE_TILE_LIMIT } from '../src/server/snapshot-parts.js';
import { assertWorld, cloneWorld, createWorld, type World } from '../src/world/index.js';
import { parseParams, paramsOf, setParams } from '../src/world/params.js';
import { codificarCheckpoint, codificarEnVuelo, codificarPaginas } from '../src/world/materia/checkpoint.js';
import { plegarLibros } from '../src/world/materia/libro.js';
import { serializarSustancias } from '../src/world/materia/servicio.js';
import { NE } from '../src/shared/naturaleza.js';
import { Rol, type MateriaCheckpoint } from '../src/world/materia/tipos.js';
import { COLUMNAS_CEREBRO, GENOMA_ANCHO } from '../src/world/motor/contratos.js';
import { materiaReal } from './lib/materia-real.js';
import { filaInstantanea, laboratorio, reescribirInstantanea } from './lib/store.js';

const params = parseParams('v23.guardadoCompleto=true,persistencia.paginasSucias=true');

async function prepararMateria(world: World): Promise<MateriaCheckpoint> {
  const { arena, libro, lote, quimica, cerrar } = materiaReal();
  try {
    const tejido = lote({ H2O: 10 }, 300, Rol.Tejido);
    const reserva = lote({ O2: 3 }, 300, Rol.Reserva);
    const digestivo = lote({}, 0, Rol.Digestivo);
    const embrion = lote({ H2O: 3 }, 300, Rol.Embrion);
    const carga = lote({ H2O: 1 }, 300);
    const persona = world.people[0]!;
    persona.cuerpo = { tejido, reserva, digestivo, plantilla: 0, gestacion: {
      embrion, otro: 1, inicio: world.tick, bajoBasalDesde: -1,
      genoma: [...Array<number>(GENOMA_ANCHO).fill(0.5), 2, 3], politica: Array<number>(COLUMNAS_CEREBRO.politica).fill(0),
    } };
    persona.carga = [carga];
    const epoca = 5;
    const cero = Array<bigint>(NE + 1).fill(0n);
    const pasado = cero.slice();
    pasado[0] = 2n ** 85n;
    return {
      epoca, tick: world.tick, sustancias: serializarSustancias(quimica), registro: Uint8Array.of(5),
      paginas: codificarPaginas(epoca, arena.muestras(), arena.libres()),
      enVuelo: codificarEnVuelo([]),
      ...plegarLibros([libro], { inicial: pasado, fuentes: cero, sumideros: pasado }),
    };
  } finally { await cerrar(); }
}

test('guardado completo paginado: mundo, materia, clon y épocas tras reabrir', async t => {
  const { store, path } = laboratorio(t, 'ps-partes-', { snapshotInlineTileLimit: 0 });
  assert.equal(store.cargarInstantanea(), null);
  const world = createWorld(7, params);
  const materia = await prepararMateria(world);
  const clon = cloneWorld(world);
  const original = world.people[0]!, copia = clon.people[0]!;
  assert.deepEqual(copia.cuerpo, original.cuerpo);
  assert.deepEqual(copia.carga, original.carga);
  copia.cuerpo!.gestacion!.genoma[0] = 0;
  copia.cuerpo!.gestacion!.politica![0] = 1;
  copia.carga!.push(0);
  assert.equal(original.cuerpo!.gestacion!.genoma[0], 0.5);
  assert.equal(original.cuerpo!.gestacion!.politica![0], 0);
  assert.equal(original.carga!.length, 1);

  store.guardar({ world, materia });
  const body = JSON.parse(filaInstantanea(store).body);
  assert.equal(body.snapshotEncoding, 'snapshot-parts-v1');
  assert.equal(Object.hasOwn(body.world, 'materia'), false);
  assert.equal(store.db.prepare("SELECT 1 FROM metadata WHERE key GLOB 'snapshot-replay-v1:*'").get(), undefined);
  const blob = store.db.prepare('SELECT body FROM snapshot_matter WHERE slot=0').get()!.body;
  assert.deepEqual(blob, codificarCheckpoint(materia));
  assert.throws(() => store.load(), /Store.cargarInstantanea/);
  assert.deepEqual(store.cargarInstantanea(), { instantanea: { world, materia }, epoca: 6 });
  store.close();

  const reopened = new Store(path);
  try {
    const siguiente = reopened.cargarInstantanea()!;
    assert.deepEqual(siguiente, { instantanea: { world, materia }, epoca: 7 });
    assert.equal(paramsOf(siguiente.instantanea.world).v23.guardadoCompleto, true);
  } finally { reopened.close(); }
});

for (const snapshotInlineTileLimit of [0, SNAPSHOT_INLINE_TILE_LIMIT]) {
  test(`mundo sin materia en JSON nativo (límite en línea ${snapshotInlineTileLimit})`, t => {
    const { store } = laboratorio(t, 'ps-json-', { snapshotInlineTileLimit });
    const world = createWorld(7, params);
    const tile = world.tiles[0]!;
    tile.elevation = -0;
    world.people[0]!.heading = -0;
    store.guardar({ world, materia: null });
    const loaded = store.cargarInstantanea()!;
    assert.equal(loaded.instantanea.materia, null);
    assert.equal(loaded.epoca, 1);
    assert.equal(loaded.instantanea.world.people[0]!.heading, 0);
    assert.equal(loaded.instantanea.world.tiles[0]!.elevation, 0);
  });
}

test('el guardado completo exige un mundo nuevo y los dos componentes en el mismo tick', async t => {
  const { store } = laboratorio(t, 'ps-nuevo-');
  const world = createWorld(7);
  assert.throws(() => store.guardar({ world, materia: null }), /v23.guardadoCompleto/);
  store.save(world);
  const previo = filaInstantanea(store);
  assert.throws(() => store.cargarInstantanea(), /mundo nuevo/);
  setParams(world, params);
  const materia = await prepararMateria(world);
  assert.throws(() => store.guardar({ world, materia: { ...materia, tick: 1 } }), /ticks de mundo y materia/);
  assert.throws(() => store.guardar({ world, materia }), /mundo nuevo/);
  assert.deepEqual(filaInstantanea(store), previo);
});

test('la validación de cuerpo, gestación y carga se activa por ley', async () => {
  const world = createWorld(7, params);
  await prepararMateria(world);
  const persona = world.people[0]!;
  const animal = world.animals[0]!;
  animal.cuerpo = { tejido: 0, reserva: 1, digestivo: 2, plantilla: 3, gestacion: {
    embrion: 4, otro: 1, inicio: 0, bajoBasalDesde: 0, genoma: [0.5],
  } };
  assertWorld(world);
  const copia = cloneWorld(world).animals[0]!;
  assert.deepEqual(copia.cuerpo, animal.cuerpo);
  copia.cuerpo!.gestacion!.genoma[0] = 0;
  assert.equal(animal.cuerpo.gestacion!.genoma[0], 0.5);
  persona.carga = [0, -1];
  assert.throws(() => assertWorld(world), /Carga de lotes inválida/);
  persona.carga = [0];
  persona.cuerpo!.gestacion!.bajoBasalDesde = -2;
  assert.throws(() => assertWorld(world), /Gestación inválida/);
  persona.cuerpo!.gestacion!.bajoBasalDesde = -1;
  animal.cuerpo.reserva = 0.5;
  assert.throws(() => assertWorld(world), /Cuerpo inválido/);
  setParams(world, parseParams('v23.guardadoCompleto=false'));
  assertWorld(world);
});

test('la carga deja visible el diagnóstico del genoma de siete genes', t => {
  const { store } = laboratorio(t, 'ps-genoma-');
  store.save(createWorld(7));
  const body = JSON.parse(filaInstantanea(store).body);
  body.people[0].genome.alleles.length = 14;
  reescribirInstantanea(store, JSON.stringify(body));
  assert.throws(() => store.load(), /Genoma de 7 genes.*falta «escucha»/);
});

test('la verificación y la recuperación explícita preservan la materia sin abrir una época', async t => {
  const { directory, path, store } = laboratorio(t, 'ps-respaldo-');
  const world = createWorld(7, params);
  const materia = await prepararMateria(world);
  store.guardar({ world, materia });
  assert.equal(store.cargarInstantanea()!.epoca, 6);
  const nuevo = cloneWorld(world);
  nuevo.tick++;
  for (const persona of nuevo.people) persona.demography.age++;
  store.guardar({ world: nuevo, materia: { ...materia, tick: nuevo.tick } });

  const origen = new Store(path, { readOnly: true });
  const recuperadoPath = join(directory, 'anterior.sqlite');
  const copiaPath = join(directory, 'copia.sqlite');
  try {
    assert.equal(origen.verificarGuardado()!.world.tick, nuevo.tick);
    origen.backup(copiaPath);
    assert.equal(origen.previous(recuperadoPath), 1);
  } finally { origen.close(); }

  const recuperado = new Store(recuperadoPath), copia = new Store(copiaPath);
  try {
    assert.deepEqual(recuperado.cargarInstantanea(), { instantanea: { world, materia }, epoca: 7 });
    assert.deepEqual(copia.cargarInstantanea(), {
      instantanea: { world: nuevo, materia: { ...materia, tick: nuevo.tick } }, epoca: 7,
    });
    assert.equal(store.cargarInstantanea()!.epoca, 7);
  } finally { copia.close(); recuperado.close(); }
});

test('un binario de materia corrupto se rechaza antes de abrir una época', async t => {
  const { store } = laboratorio(t, 'ps-crc-');
  const world = createWorld(7, params);
  const materia = await prepararMateria(world);
  store.guardar({ world, materia });
  const bytes = codificarCheckpoint(materia), corruptos = bytes.slice();
  corruptos[8] ^= 1;
  const sustituir = store.db.prepare('UPDATE snapshot_matter SET body=? WHERE slot=0');
  sustituir.run(corruptos);
  assert.throws(() => store.cargarInstantanea(), /CRC32/);
  sustituir.run(bytes);
  assert.equal(store.cargarInstantanea()!.epoca, 6);
});

test('SIGKILL entre las escrituras y COMMIT conserva el mundo y el binario anteriores', async t => {
  const { store, path } = laboratorio(t, 'ps-sigkill-', { snapshotInlineTileLimit: 0 });
  const world = createWorld(7, params);
  const materia = await prepararMateria(world);
  store.guardar({ world, materia });
  const previo = filaInstantanea(store);
  store.close();

  const hijo = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
    import { writeSync } from 'node:fs';
    import { Store } from './src/server/store.ts';
    const store = new Store(process.argv[1], { snapshotInlineTileLimit: 0 });
    const { instantanea } = store.cargarInstantanea();
    const { world, materia } = instantanea;
    world.tick++;
    materia.tick++;
    for (const persona of world.people) persona.demography.age++;
    store.db.function('interrumpir', () => {
      writeSync(1, 'mundo y materia nuevos escritos, sin COMMIT\\n');
      process.kill(process.pid, 'SIGKILL');
      return null;
    });
    store.db.exec(\`
      PRAGMA cache_size=5;
      CREATE TEMP TRIGGER interrumpir_guardado AFTER INSERT ON main.snapshot_matter
      WHEN NEW.slot=0 AND EXISTS (
        SELECT 1 FROM main.snapshots WHERE slot=0 AND digest=NEW.world_digest
          AND json_extract(body, '$.world.tick')=1
      ) BEGIN SELECT interrumpir(); END;
    \`);
    store.guardar(instantanea);
  `, path], { encoding: 'utf8', timeout: 30_000 });
  assert.ifError(hijo.error);
  assert.equal(hijo.signal, 'SIGKILL', hijo.stderr);
  assert.match(hijo.stdout, /mundo y materia nuevos escritos, sin COMMIT/);

  const reopened = new Store(path);
  try {
    assert.deepEqual(filaInstantanea(reopened), previo);
    assert.deepEqual(reopened.cargarInstantanea(), { instantanea: { world, materia }, epoca: 7 });
    assert.equal(reopened.db.prepare('SELECT 1 FROM snapshots WHERE slot=1').get(), undefined);
  } finally { reopened.close(); }
});
