import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { SNAPSHOT_PAGE_TILES } from '../src/server/snapshot-parts.js';
import { encodeSnapshotTileRows, SnapshotPhysicalError } from '../src/server/snapshot.js';
import { Store } from '../src/server/store.js';
import { createWorld, type World } from '../src/world/index.js';
import { crearCorteGuardado } from '../src/world/motor/corte-sellado.js';
import { vincularTeselasVerificadas } from '../src/world/motor/teselas-corte.js';
import { parseParams } from '../src/world/params.js';
import { activate } from '../src/world/spatial.js';
import { filaInstantanea, laboratorio, todasLasTablas } from './lib/store.js';

const params = parseParams('v23.guardadoCompleto=true');
const opciones = { snapshotPackedPeople: true };
const salto = SNAPSHOT_PAGE_TILES;
const desde = 37, comienzoHueco = salto + 9, finHueco = salto + 11;
const sucias = [salto - 1, salto, comienzoHueco - 1];

function mundo(): World {
  const world = createWorld(42, params);
  for (let cx = 3; cx < 15; cx++) activate(world, cx * 16, 0);
  assert.equal(world.tiles.length, 4608);
  world.tiles[desde]!.paved = -0;
  return world;
}

function filas(world: World, inicio: number, fin: number): string[] {
  return encodeSnapshotTileRows(world.tiles, inicio, fin - inicio, true).map(fila => JSON.stringify(fila));
}

function vincularDosTramos(world: World): number {
  const tramos = [
    { desde, filas: filas(world, desde, comienzoHueco) },
    { desde: finHueco, filas: filas(world, finHueco, world.tiles.length - 17) },
  ];
  vincularTeselasVerificadas(world.tiles, {
    tramos, modificadas: new Set([...sucias, comienzoHueco].map(i => world.tiles[i]!)),
  });
  return tramos[0]!.filas.length + tramos[1]!.filas.length;
}

function editarCorte(world: World): void {
  for (const [n, i] of [...sucias, comienzoHueco].entries()) world.tiles[i]!.traffic = (n + 1) / 8;
}

function partes(store: Store) {
  return store.db.prepare('SELECT digest, typeof(body) AS tipo, hex(CAST(body AS BLOB)) AS bytes FROM snapshot_parts ORDER BY digest').all();
}

test('el corte sellado de teselas mantiene las páginas WPG3 exactas con huecos y filas sucias', t => {
  const { store: control } = laboratorio(t, 'atlas-teselas-canonicas-', opciones);
  const { store, directory } = laboratorio(t, 'atlas-teselas-selladas-', opciones);
  const world = mundo(), canonico = mundo();
  let verificadas = 0;
  const sello = crearCorteGuardado(() => {
    verificadas = vincularDosTramos(world);
    editarCorte(world);
    return { world, materia: null };
  });
  editarCorte(canonico);
  control.guardar({ world: canonico, materia: null });
  const instantanea = store.guardarCorteSellado(sello, [], []);

  const primera = filaInstantanea(store);
  assert.deepEqual(primera, filaInstantanea(control));
  assert.deepEqual(partes(store), partes(control));
  const manifiesto = JSON.parse(primera.body);
  assert.equal(manifiesto.snapshotEncoding, 'snapshot-parts-v3');
  assert.deepEqual(manifiesto.tiles.pages.map((pagina: { count: number }) => pagina.count), [4096, 512]);
  const stats = { reused: verificadas - sucias.length, recoded: sucias.length };
  assert.deepEqual(store.snapshotTeselasCorteStats, stats);
  assert.throws(() => store.guardarCorteSellado(sello, [], []), /ya consumido/);
  const leido = store.cargarGuardadoCompleto()!.instantanea.world;
  assert.deepEqual(filas(leido, 0, leido.tiles.length), filas(canonico, 0, canonico.tiles.length));

  // El mundo vuelve editable al commit. Aunque se asocien otras filas, guardar por la vía
  // ordinaria siempre escribe el estado actual.
  vincularDosTramos(instantanea.world);
  instantanea.world.tiles[desde]!.traffic = 0.875;
  canonico.tiles[desde]!.traffic = 0.875;
  store.guardar(instantanea);
  control.guardar({ world: canonico, materia: null });
  assert.deepEqual(store.snapshotTeselasCorteStats, stats);
  assert.deepEqual(filaInstantanea(store), filaInstantanea(control));
  assert.deepEqual(filaInstantanea(store, 1), primera);
  assert.deepEqual(partes(store), partes(control));

  const previo = join(directory, 'anterior.sqlite');
  assert.equal(store.previous(previo), 1);
  const recuperado = new Store(previo, opciones);
  t.after(() => recuperado.close());
  const restaurado = recuperado.cargarGuardadoCompleto()!.instantanea.world;
  assert.deepEqual(filas(restaurado, 0, restaurado.tiles.length), filas(leido, 0, leido.tiles.length));
});

test('Store valida y revierte una página alterada durante el guardado de teselas selladas', t => {
  const { store } = laboratorio(t, 'atlas-teselas-rollback-', opciones);
  const world = mundo();
  store.guardar({ world, materia: null });
  const antes = todasLasTablas(store);

  const invalido = crearCorteGuardado(() => {
    vincularDosTramos(world);
    world.tiles[sucias[0]!]!.traffic = -1;
    return { world, materia: null };
  });
  assert.throws(() => store.guardarCorteSellado(invalido, [], []), /Elemento del ecosistema inválido/);
  assert.deepEqual(todasLasTablas(store), antes);
  world.tiles[sucias[0]!]!.traffic = 0;

  const sello = crearCorteGuardado(() => {
    vincularDosTramos(world);
    editarCorte(world);
    return { world, materia: null };
  });
  store.db.exec(`CREATE TRIGGER corrupt_tiles AFTER INSERT ON snapshots WHEN NEW.slot=0 BEGIN
      UPDATE snapshot_parts SET body=body||' ' WHERE digest=json_extract(NEW.body,'$.tiles.pages[0].digest');
    END`);
  assert.throws(() => store.guardarCorteSellado(sello, [], []), SnapshotPhysicalError);
  assert.equal(store.db.isTransaction, false);
  assert.deepEqual(todasLasTablas(store), antes);
  assert.throws(() => store.guardarCorteSellado(sello, [], []), /ya consumido/);
});
