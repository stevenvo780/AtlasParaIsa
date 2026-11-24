import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { encodeSnapshotTileRows } from '../src/server/snapshot.js';
import { SnapshotParts, type SnapshotReuseTicket } from '../src/server/snapshot-parts.js';
import type { Gesture, GestureResult } from '../src/shared/types.js';
import { bindWorldContext, createWorld, worldContext, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { paramsOf, parseParams } from '../src/world/params.js';
import { activate } from '../src/world/spatial.js';
import { ResidentTopologyOwner } from '../src/world/soa/topologia.js';
import { TileStore } from '../src/world/soa/terreno.js';
import { sha256, todasLasTablas } from './lib/store.js';

/**
 * v18: memorización incremental fail-closed de páginas limpias de `snapshot_parts`. El control de cada
 * prueba es el camino histórico (teselas planas sin `ResidentTopologyOwner`, que jamás reutiliza): los
 * bytes durables deben coincidir byte a byte y solo cambian los contadores `snapshotPageStats`.
 */
interface PageDesc { index: number; digest: string; count: number; bytes: number; }

function laboratory(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-v18-dirty-'));
  const path = join(directory, 'world.sqlite');
  let current: Store | undefined = new Store(path, { snapshotInlineTileLimit: 0 });
  const close = (): void => { const previous = current; current = undefined; previous?.close(); };
  t.after(() => { close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    path,
    get store(): Store { return current!; },
    close,
    reopen(): Store { close(); current = new Store(path, { snapshotInlineTileLimit: 0 }); return current; },
  };
}

/** 9 472 teselas = 3 páginas de instantánea (4 096 + 4 096 + 1 280). */
function makeWorld(wrap: boolean): { world: World; owner?: ResidentTopologyOwner } {
  const world = createWorld(42);
  for (let cx = 10; cx < 41; cx++) activate(world, cx * 16, 0);
  assert.equal(world.tiles.length, 9472);
  if (!wrap) return { world };
  const owner = new ResidentTopologyOwner();
  world.tiles = owner.tiles(world.tiles.map(tile => owner.tile(tile)));
  bindWorldContext(world, { ...worldContext(world), tileOwnership: owner });
  return { world, owner };
}
const PAGES = 3;

function slotBody(store: Store, slot = 0): string {
  const row = store.db.prepare('SELECT body,digest FROM snapshots WHERE slot=?').get(slot) as { body: string; digest: string } | undefined;
  assert.ok(row, `existe el slot ${slot}`);
  assert.equal(sha256(row.body), row.digest);
  return row.body;
}
const pagesOf = (store: Store): PageDesc[] => (JSON.parse(slotBody(store)) as { tiles: { pages: PageDesc[] } }).tiles.pages;
const partsOf = (store: Store): [string, string][] =>
  (store.db.prepare('SELECT digest,body FROM snapshot_parts ORDER BY digest').all() as { digest: string; body: string }[])
    .map(row => [row.digest, row.body]);
function statsDelta(store: Store, run: () => void): { reused: number; encoded: number } {
  const before = store.snapshotPageStats;
  run();
  const after = store.snapshotPageStats;
  return { reused: after.reused - before.reused, encoded: after.encoded - before.encoded };
}
/** Digesto de página calculado por el camino histórico, sin pasar por la caché. */
const pageDigestOf = (world: World, page: number): string =>
  sha256(JSON.stringify(encodeSnapshotTileRows(world.tiles.slice(page * 4096, page * 4096 + 4096))));

test('v18: paridad byte a byte de body, digest, bytes y páginas contra un Store sin reutilización', t => {
  const cachedLab = laboratory(t), controlLab = laboratory(t);
  const { world: cached } = makeWorld(true);
  const { world: control } = makeWorld(false);
  const both = (mutate: (world: World) => void): void => {
    mutate(cached); mutate(control);
    cachedLab.store.save(cached); controlLab.store.save(control);
  };
  cachedLab.store.save(cached); controlLab.store.save(control);
  both(world => { world.tiles[0]!.food = world.tiles[0]!.food === 0.3125 ? 0.4375 : 0.3125; });
  both(world => { world.tiles[5000]!.food = 0.25; world.tiles[9471]!.moisture = 0.75; });
  both(() => {});
  assert.ok(cachedLab.store.snapshotPageStats.reused > 0, 'el lado con caché reutilizó de verdad');
  assert.equal(controlLab.store.snapshotPageStats.reused, 0, 'el control (teselas planas) nunca reutiliza');
  for (const slot of [0, 1]) assert.equal(slotBody(cachedLab.store, slot), slotBody(controlLab.store, slot), `slot ${slot} idéntico`);
  assert.deepEqual(pagesOf(cachedLab.store), pagesOf(controlLab.store));
  assert.deepEqual(partsOf(cachedLab.store), partsOf(controlLab.store), 'mismos cuerpos de página durables');
  assert.equal(cachedLab.store.lastSnapshotBytes, controlLab.store.lastSnapshotBytes);
  const expected = digestoCanonico(cached);
  assert.equal(digestoCanonico(control), expected);
  assert.equal(digestoCanonico(cachedLab.reopen().load()!.world), expected);
  assert.equal(digestoCanonico(controlLab.reopen().load()!.world), expected);
});

test('v18: mutar 1 tesela por setter invalida solo su página; drainChangedTiles no se roba', t => {
  const lab = laboratory(t);
  const { world, owner } = makeWorld(true);
  assert.deepEqual(statsDelta(lab.store, () => lab.store.save(world)), { reused: 0, encoded: PAGES });
  assert.deepEqual(statsDelta(lab.store, () => lab.store.save(world)), { reused: PAGES, encoded: 0 }, 'sin cambios: todo reutilizado');
  const first = world.tiles[0]!;
  const beforeManifest = pagesOf(lab.store);
  first.food = first.food === 0.3125 ? 0.4375 : 0.3125;
  assert.deepEqual(statsDelta(lab.store, () => lab.store.save(world)), { reused: PAGES - 1, encoded: 1 });
  const afterManifest = pagesOf(lab.store);
  assert.notEqual(afterManifest[0]!.digest, beforeManifest[0]!.digest);
  assert.deepEqual(afterManifest.slice(1), beforeManifest.slice(1), 'las demás páginas conservan digesto y bytes');
  assert.deepEqual(owner!.drainChangedTiles(), [first], 'el guardado no drenó el canal de digesto/hardware');
  const last = world.tiles.at(-1)!;
  last.food = 0.125;
  assert.deepEqual(statsDelta(lab.store, () => lab.store.save(world)), { reused: PAGES - 1, encoded: 1 });
  assert.deepEqual(owner!.drainChangedTiles(), [last]);
  // Un chunk nuevo al final solo ensucia la última página (crece su count): push bajo el mismo owner.
  activate(world, 60 * 16, 0);
  assert.equal(world.tiles.length, 9728);
  assert.deepEqual(statsDelta(lab.store, () => lab.store.save(world)), { reused: PAGES - 1, encoded: 1 });
  const expected = digestoCanonico(world);
  assert.equal(digestoCanonico(lab.reopen().load()!.world), expected);
});

test('v18: la validación profunda (cada 10 guardados) recodifica todo y la siguiente vuelve a reutilizar', t => {
  const lab = laboratory(t);
  const { world } = makeWorld(true);
  const deltas: { reused: number; encoded: number }[] = [];
  for (let n = 0; n < 12; n++) deltas.push(statsDelta(lab.store, () => lab.store.save(world)));
  assert.deepEqual(deltas[0], { reused: 0, encoded: PAGES }, 'primer guardado del proceso: profundo');
  for (let n = 1; n < 10; n++) assert.deepEqual(deltas[n], { reused: PAGES, encoded: 0 }, `guardado ${n + 1}`);
  assert.deepEqual(deltas[10], { reused: 0, encoded: PAGES }, 'guardado 11 (saves=10): validación profunda');
  assert.deepEqual(deltas[11], { reused: PAGES, encoded: 0 }, 'el directorio se reconstruyó en el profundo');
});

test('v18: una escritura de sesión propia no condena el siguiente guardado a recodificar', t => {
  const lab = laboratory(t);
  const { world } = makeWorld(true);
  lab.store.save(world);
  lab.store.addSession('v18-session-hash', Date.now() + 60_000);
  assert.deepEqual(statsDelta(lab.store, () => lab.store.save(world)), { reused: PAGES, encoded: 0 });
  lab.store.revoke('v18-session-hash');
  assert.deepEqual(statsDelta(lab.store, () => lab.store.save(world)), { reused: PAGES, encoded: 0 });
});

test('v18: array plano sin ResidentTopologyOwner jamás reutiliza (y una tesela ajena revoca el token)', t => {
  const lab = laboratory(t);
  const { world } = makeWorld(false);
  lab.store.save(world);
  world.tiles[0]!.food = 0.3125;
  lab.store.save(world);
  assert.equal(lab.store.snapshotPageStats.reused, 0);
  assert.equal(lab.reopen().load()!.world.tiles[0]!.food, 0.3125);

  const lab2 = laboratory(t);
  const wrapped = makeWorld(true).world;
  lab2.store.save(wrapped);
  lab2.store.save(wrapped);
  assert.equal(lab2.store.snapshotPageStats.reused, PAGES);
  wrapped.tiles[0] = { ...wrapped.tiles[0]! }; // tesela no emitida por el owner: token revocado
  assert.deepEqual(statsDelta(lab2.store, () => lab2.store.save(wrapped)), { reused: 0, encoded: PAGES });
  assert.equal(digestoCanonico(lab2.reopen().load()!.world), digestoCanonico(wrapped));
});

/** Simula un despacho worker/GPU fiel: copia frente→fondo de todos los campos residentes, escribe UNA
 * celda del fondo sin pasar por ningún setter y confirma con `commitParallel`. */
function parallelWriteFood(soa: TileStore, tiles: World['tiles'], index: number, value: number): void {
  const terrain = soa.prepareParallel(tiles);
  soa.beginParallel();
  for (const key of Object.keys(terrain.buffers).filter(k => k.endsWith('Back')))
    new Uint8Array(terrain.buffers[key]!).set(new Uint8Array(terrain.buffers[key.slice(0, -4)]!));
  const cells = new Int32Array(terrain.buffers.cells!);
  new Float64Array(terrain.buffers.foodBack!)[cells[index]!] = value;
  soa.commitParallel();
}

test('v18: commitParallel (SAB sin setters) invalida las páginas y nunca sirve digestos obsoletos', t => {
  const lab = laboratory(t);
  const { world } = makeWorld(true);
  const soa = new TileStore();
  soa.prepareParallel(world.tiles);
  assert.deepEqual(statsDelta(lab.store, () => lab.store.save(world)), { reused: 0, encoded: PAGES });
  assert.deepEqual(statsDelta(lab.store, () => lab.store.save(world)), { reused: PAGES, encoded: 0 }, 'ligado y limpio: reutiliza');
  const index = 5000, before = pagesOf(lab.store);
  parallelWriteFood(soa, world.tiles, index, 0.999);
  assert.equal(world.tiles[index]!.food, 0.999, 'el valor del SAB es el valor lógico tras la barrera');
  assert.deepEqual(statsDelta(lab.store, () => lab.store.save(world)), { reused: 0, encoded: PAGES },
    'la confirmación paralela sella todas las ranuras: ninguna página se da por limpia');
  assert.notEqual(pagesOf(lab.store)[1]!.digest, before[1]!.digest, 'la página tocada cambió de digesto');
  assert.deepEqual(statsDelta(lab.store, () => lab.store.save(world)), { reused: PAGES, encoded: 0 }, 'recache tras el paralelo');
  const tile = world.tiles[10]!;
  tile.food = tile.food === 0.5 ? 0.625 : 0.5; // setter JS sobre tesela ligada (accesor residente)
  assert.deepEqual(statsDelta(lab.store, () => lab.store.save(world)), { reused: PAGES - 1, encoded: 1 });
  const expected = digestoCanonico(world), loaded = lab.reopen().load()!.world;
  assert.equal(loaded.tiles[index]!.food, 0.999);
  assert.equal(digestoCanonico(loaded), expected);
});

test('v18: una escritura de otra conexión entre guardados rompe el sello y fuerza recodificación exacta', t => {
  const lab = laboratory(t);
  const { world } = makeWorld(true);
  lab.store.save(world);
  assert.deepEqual(statsDelta(lab.store, () => lab.store.save(world)), { reused: PAGES, encoded: 0 });
  const bodyBefore = slotBody(lab.store);
  const writer = new Store(lab.path, { snapshotInlineTileLimit: 0 });
  writer.db.prepare('UPDATE snapshots SET saved_at=saved_at+7 WHERE slot=0').run();
  writer.close();
  assert.deepEqual(statsDelta(lab.store, () => lab.store.save(world)), { reused: 0, encoded: PAGES },
    'data_version se movió: sin vale, camino completo');
  assert.equal(slotBody(lab.store), bodyBefore, 'el cuerpo recodificado es byte a byte el mismo');
  assert.deepEqual(statsDelta(lab.store, () => lab.store.save(world)), { reused: PAGES, encoded: 0 }, 'sello retomado tras COMMIT');
});

for (const damage of ['borrado externo de una página referenciada', 'cuerpo de página alterado externamente'] as const) {
  test(`v18: ${damage} entre guardados falla cerrado sin tocar la base`, t => {
    const lab = laboratory(t);
    const { world } = makeWorld(true);
    lab.store.save(world);
    lab.store.save(world);
    const page = pagesOf(lab.store)[1]!;
    const writer = new Store(lab.path, { snapshotInlineTileLimit: 0 });
    if (damage.startsWith('borrado')) writer.db.prepare('DELETE FROM snapshot_parts WHERE digest=?').run(page.digest);
    else writer.db.prepare("UPDATE snapshot_parts SET body=body||' ' WHERE digest=?").run(page.digest);
    writer.close();
    const afterDamage = todasLasTablas(lab.store);
    world.tiles[0]!.food = 0.3125;
    assert.throws(() => lab.store.save(world), /page missing|checksum|disagrees|snapshot part/i,
      'ni sirve el digesto cacheado ni repara en silencio: la prueba de línea base detecta el daño');
    assert.equal(lab.store.db.isTransaction, false);
    assert.deepEqual(todasLasTablas(lab.store), afterDamage, 'el intento fallido no escribió nada');
  });
}

test('v18: SnapshotParts recodifica exactamente una página reutilizable cuyo digesto ya no está en la tabla', t => {
  // Unidad del lote de presencia dentro de la transacción: con un vale cuyos campos coinciden con la
  // realidad actual, la página ausente se recodifica y se reinserta; las presentes se reutilizan.
  const lab = laboratory(t);
  const { world } = makeWorld(true);
  const db = lab.store.db, parts = new SnapshotParts(db, 5);
  const prepared = parts.prepare(world, paramsOf(world), 0);
  db.exec('BEGIN IMMEDIATE');
  const first = parts.write(prepared);
  db.exec('COMMIT');
  parts.confirmPendingPages();
  assert.deepEqual(parts.pageStats, { reused: 0, encoded: PAGES });
  db.prepare('DELETE FROM snapshot_parts WHERE digest=?').run(first.pages[0]!);
  const ticket: SnapshotReuseTicket = {
    dataVersion: Number(db.prepare('PRAGMA data_version').get()!.data_version),
    schemaCookie: Number(db.prepare('PRAGMA schema_version').get()!.schema_version),
    tempSchemaCookie: Number(db.prepare('PRAGMA temp.schema_version').get()!.schema_version),
  };
  db.exec('BEGIN IMMEDIATE');
  const second = parts.write(prepared, ticket);
  parts.assertWritten(second);
  db.exec('COMMIT');
  assert.deepEqual(parts.pageStats, { reused: PAGES - 1, encoded: PAGES + 1 }, 'solo la ausente se recodificó');
  assert.equal(second.body, first.body);
  assert.equal(second.digest, first.digest);
  assert.equal(second.bytes, first.bytes);
  assert.deepEqual(second.pages, first.pages);
  assert.ok(db.prepare('SELECT 1 FROM snapshot_parts WHERE digest=?').get(first.pages[0]!), 'la fila volvió a insertarse');
});

test('v18: ROLLBACK tras escribir páginas no confirma el directorio ni deja la página abortada en la tabla', t => {
  const lab = laboratory(t);
  const { world } = makeWorld(true);
  const gesture: Gesture = { id: 'v18-rollback-01', kind: 'command', x: 20, y: 14, agentId: 's', order: 'move' };
  const result: GestureResult = { id: gesture.id, accepted: true, tick: world.tick, order: 0, message: 'Orden sintética.' };
  lab.store.save(world, [{ gesture, result }]);
  const bodyBefore = slotBody(lab.store);
  world.tiles[0]!.food = world.tiles[0]!.food === 0.3125 ? 0.4375 : 0.3125;
  const abortedPageDigest = pageDigestOf(world, 0);
  // El mismo gesto otra vez: la inserción en `inputs` choca DESPUÉS de escribir las páginas -> ROLLBACK.
  assert.throws(() => lab.store.save(world, [{ gesture, result }]), /UNIQUE constraint/i);
  assert.equal(lab.store.db.isTransaction, false);
  assert.equal(slotBody(lab.store), bodyBefore, 'el slot 0 sigue siendo el del COMMIT anterior');
  assert.equal(lab.store.db.prepare('SELECT 1 FROM snapshot_parts WHERE digest=?').get(abortedPageDigest), undefined,
    'la página de la transacción abortada no quedó en la tabla');
  const delta = statsDelta(lab.store, () => lab.store.save(world));
  assert.ok(delta.encoded >= 1, 'la página abortada se recodifica en el reintento, no se sirve de un directorio sin confirmar');
  assert.equal(pagesOf(lab.store)[0]!.digest, abortedPageDigest, 'y produce exactamente el mismo digesto');
  const expected = digestoCanonico(world);
  assert.equal(digestoCanonico(lab.reopen().load()!.world), expected);
});

test('v18: con un trigger SQL presente no se reutiliza; al quitarlo, un guardado completo y luego caché', t => {
  const lab = laboratory(t);
  const { world } = makeWorld(true);
  lab.store.save(world);
  assert.deepEqual(statsDelta(lab.store, () => lab.store.save(world)), { reused: PAGES, encoded: 0 });
  lab.store.db.exec('CREATE TRIGGER v18_benign AFTER INSERT ON snapshot_parts BEGIN SELECT 1; END');
  world.tiles[0]!.food = world.tiles[0]!.food === 0.3125 ? 0.4375 : 0.3125;
  assert.deepEqual(statsDelta(lab.store, () => lab.store.save(world)), { reused: 0, encoded: PAGES });
  lab.store.db.exec('DROP TRIGGER v18_benign');
  assert.deepEqual(statsDelta(lab.store, () => lab.store.save(world)), { reused: 0, encoded: PAGES },
    'crear/borrar el trigger movió la cookie de esquema: el primer guardado limpio recodifica y resella');
  assert.deepEqual(statsDelta(lab.store, () => lab.store.save(world)), { reused: PAGES, encoded: 0 });
  assert.equal(digestoCanonico(lab.reopen().load()!.world), digestoCanonico(world));
});

test('v18: un trigger que corrompe la página insertada hace fallar el guardado entero (fail-closed)', t => {
  const lab = laboratory(t);
  const { world } = makeWorld(true);
  lab.store.save(world);
  lab.store.save(world);
  lab.store.db.exec("CREATE TRIGGER v18_bad AFTER INSERT ON snapshot_parts BEGIN UPDATE snapshot_parts SET body=body||' ' WHERE digest=NEW.digest; END");
  const baseline = todasLasTablas(lab.store);
  world.tiles[0]!.food = world.tiles[0]!.food === 0.3125 ? 0.4375 : 0.3125;
  assert.throws(() => lab.store.save(world), /checksum mismatch/i, 'verifyRetained detecta el cuerpo alterado antes de COMMIT');
  assert.equal(lab.store.db.isTransaction, false);
  assert.deepEqual(todasLasTablas(lab.store), baseline);
  lab.store.db.exec('DROP TRIGGER v18_bad');
  lab.store.save(world);
  assert.equal(digestoCanonico(lab.reopen().load()!.world), digestoCanonico(world), 'sin el trigger, la mutación se guarda exacta');
});

test('v18: el guardado caliente solo codifica la página sucia entre ~125k teselas y conserva los bytes', t => {
  const warmSaves = 5;
  const makeBigWorld = (wrap: boolean): World => {
    const world = createWorld(42, parseParams('limites.teselasActivas=262144,limites.chunks=1024'));
    for (let cy = 0; cy < 22; cy++) for (let cx = 0; cx < 22; cx++) activate(world, cx * 16, cy * 16);
    if (wrap) {
      const owner = new ResidentTopologyOwner();
      world.tiles = owner.tiles(world.tiles.map(tile => owner.tile(tile)));
      bindWorldContext(world, { ...worldContext(world), tileOwnership: owner });
    }
    return world;
  };
  const saveDirtyPage = (store: Store, world: World): void => {
    store.save(world); // El primer guardado construye el directorio completo.
    for (let n = 0; n < warmSaves; n++) {
      world.tiles[12345]!.food = 0.31 + n * 0.01;
      store.save(world);
    }
  };
  const cachedLab = laboratory(t), controlLab = laboratory(t);
  const cached = makeBigWorld(true), control = makeBigWorld(false);
  const pages = Math.ceil(cached.tiles.length / 4096);
  assert.equal(cached.tiles.length, control.tiles.length);
  assert.ok(cached.tiles.length >= 65536 && pages >= 16 && pages <= 32, `escala de la prueba: ${cached.tiles.length} teselas, ${pages} páginas`);
  saveDirtyPage(cachedLab.store, cached);
  saveDirtyPage(controlLab.store, control);
  assert.deepEqual(cachedLab.store.snapshotPageStats, { reused: warmSaves * (pages - 1), encoded: pages + warmSaves },
    'en caliente solo se codifica la página sucia; el trabajo de páginas cae en un factor ~páginas');
  assert.deepEqual(controlLab.store.snapshotPageStats, { reused: 0, encoded: (1 + warmSaves) * pages },
    'sin caché se codifican todas las páginas en cada guardado');
  assert.equal(slotBody(cachedLab.store), slotBody(controlLab.store), 'a esta escala el cuerpo también es byte a byte idéntico');
});
