import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { Store, DEEP_CHECKPOINT_EVERY_SAVES } from '../src/server/store.js';
import { encodeSnapshot, SnapshotPhysicalError, takeSnapshotParams } from '../src/server/snapshot.js';
import { readStoredSnapshot, SnapshotParts } from '../src/server/snapshot-parts.js';
import { stringifyExact } from '../src/shared/exact-json.js';
import type { LegacyRecord } from '../src/shared/demography.js';
import { assertWorld, cloneWorld, createWorld, type World } from '../src/world/index.js';
import { recordChronicleEvent } from '../src/world/chronicle-journal.js';
import { demographicTraits } from '../src/world/demography.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { paramsOf, parseParams, setParams } from '../src/world/params.js';
import { activate } from '../src/world/spatial.js';
import { generateChunk } from '../src/world/terrain.js';
import { reescribirInstantanea, sha256, todasLasTablas } from './lib/store.js';

type TransportOptions = { readOnly?: boolean; snapshotInlineTileLimit?: number };
interface SnapshotRow { body: string; digest: string; saved_at: number; }
interface Page { index: number; digest: string; count: number; bytes: number; }
interface Manifest {
  snapshotEncoding: string;
  world: Record<string, unknown>;
  tiles: { count: number; pages: Page[] };
}

function openStore(path: string, options: TransportOptions): Store {
  return new Store(path, options);
}

function laboratory(t: TestContext, options: TransportOptions = { snapshotInlineTileLimit: 0 }) {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-snapshot-parts-'));
  const path = join(directory, 'world.sqlite');
  let current: Store | undefined = openStore(path, options);
  function close(): void { const previous = current; current = undefined; previous?.close(); }
  t.after(() => { close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    path,
    get store(): Store { return current!; },
    close,
    reopen(next: TransportOptions = options): Store { close(); current = openStore(path, next); return current; },
  };
}

function snapshot(store: Store, slot = 0): SnapshotRow {
  const row = store.db.prepare('SELECT body,digest,saved_at FROM snapshots WHERE slot=?').get(slot) as unknown as SnapshotRow | undefined;
  assert.ok(row, `existe el slot ${slot}`);
  assert.equal(sha256(row.body), row.digest);
  return row;
}

function manifest(store: Store, slot = 0): Manifest {
  const value = JSON.parse(snapshot(store, slot).body) as Manifest;
  assert.equal(value.snapshotEncoding, 'snapshot-parts-v1');
  assert.equal(value.world.tileEncoding, 'tiles-tuple-v1');
  assert.equal(value.world.tiles, null, 'los datos de tiles sólo aparecen en las piezas; null conserva el orden raíz');
  assert.ok(Array.isArray(value.tiles.pages));
  return value;
}

function pageBody(store: Store, page: Page): string {
  const row = store.db.prepare('SELECT body FROM snapshot_parts WHERE digest=?').get(page.digest) as { body: string } | undefined;
  assert.ok(row, 'la página referenciada existe');
  assert.match(page.digest, /^[0-9a-f]{64}$/);
  assert.equal(sha256(row.body), page.digest);
  assert.equal(Buffer.byteLength(row.body), page.bytes);
  const rows = JSON.parse(row.body) as unknown[][];
  assert.equal(rows.length, page.count);
  assert.ok(rows.length > 0 && rows.length <= 4096);
  for (const row of rows) assert.equal(row.length, 20);
  return row.body;
}


function partDigests(store: Store): string[] {
  return (store.db.prepare('SELECT digest FROM snapshot_parts ORDER BY digest').all() as { digest: string }[]).map(row => row.digest);
}

function rewriteManifest(store: Store, value: Manifest): void {
  const body = stringifyExact(value);
  reescribirInstantanea(store, body);
}

function changeFood(world: World): void {
  world.tiles[0]!.food = world.tiles[0]!.food === 0.3125 ? 0.4375 : 0.3125;
}

function withBackup(t: TestContext) {
  const lab = laboratory(t);
  const world = createWorld(42, parseParams('agua.cuencas=0.8,motor.gpu=[1,0]'));
  lab.store.save(world);
  const backupDigest = digestoCanonico(world), backupParams = paramsOf(world);
  const oldPage = manifest(lab.store).tiles.pages[0]!;
  changeFood(world);
  lab.store.save(world);
  const current = manifest(lab.store);
  assert.notEqual(current.tiles.pages[0]!.digest, oldPage.digest, 'el respaldo no comparte la página que se va a corromper');
  assert.deepEqual(manifest(lab.store, 1).tiles.pages[0], oldPage);
  return { lab, world, current, backupDigest, backupParams };
}

for (const limit of [undefined, 1536]) {
  test(`snapshot pequeño mantiene los bytes compactos con umbral ${limit ?? 'por defecto'}`, t => {
    const lab = laboratory(t, limit === undefined ? {} : { snapshotInlineTileLimit: limit });
    const world = createWorld(42, parseParams('agua.cuencas=0.8'));
    assert.equal(world.tiles.length, 1536);
    lab.store.save(world);
    const committed = digestoCanonico(world), params = paramsOf(world);
    const saved = snapshot(lab.store);
    assert.equal(saved.body, encodeSnapshot(world, params), 'el transporte pequeño conserva los bytes históricos');
    assert.equal(lab.store.lastSnapshotBytes, Buffer.byteLength(saved.body));
    assert.equal(JSON.parse(saved.body).snapshotEncoding, undefined);
    assert.deepEqual(partDigests(lab.store), []);
    assert.equal(lab.store.db.prepare('PRAGMA user_version').get()!.user_version, 5);
    const reopened = lab.reopen(), loaded = reopened.load()!;
    assert.equal(loaded.slot, 0);
    assert.equal(digestoCanonico(loaded.world), committed);
    assert.deepEqual(paramsOf(loaded.world), params);
    assert.deepEqual(snapshot(reopened), saved);
  });
}

test('piezas: 1536 tiles, params y -0 sobreviven al archivo, close y reapertura read-only', t => {
  const lab = laboratory(t);
  const world = createWorld(42, parseParams('agua.cuencas=0.8,motor.gpu=[-0,1]'));
  world.tiles.find(tile => tile.x === 0)!.x = -0;
  world.people[0]!.inventory = -0;
  assertWorld(world);
  lab.store.save(world);
  const committed = digestoCanonico(world), params = paramsOf(world), value = manifest(lab.store);
  assert.equal(value.tiles.count, 1536);
  assert.equal(value.tiles.pages.length, 1);
  assert.equal(value.tiles.pages[0]!.index, 0);
  const rows = JSON.parse(pageBody(lab.store, value.tiles.pages[0]!)) as unknown[][];
  assert.deepEqual(rows, JSON.parse(encodeSnapshot(world, params)).tiles);
  assert.equal(Object.is(rows.find(row => row[0] === 0)![0], -0), true);
  assert.equal(value.world.paramsEncoding, 'params-v1');
  assert.deepEqual(value.world.params, params);
  const before = todasLasTablas(lab.store);
  const reopened = lab.reopen({ readOnly: true }), loaded = reopened.load()!;
  assert.equal(loaded.slot, 0);
  assert.equal(digestoCanonico(loaded.world), committed);
  assert.deepEqual(paramsOf(loaded.world), params);
  assert.equal(Object.is(loaded.world.people[0]!.inventory, -0), true);
  assert.equal(Object.is(loaded.world.tiles.find(tile => tile.x === 0)!.x, -0), true);
  assert.equal(Object.is(paramsOf(loaded.world).motor.gpu[0], -0), true);
  assert.deepEqual(todasLasTablas(reopened), before, 'la lectura no modifica páginas ni archivos');
});

test('piezas: dos páginas conservan las 4352 tuplas en su orden exacto', t => {
  const lab = laboratory(t), world = createWorld(42);
  for (let cx = 10; cx < 21; cx++) activate(world, cx * 16, 0);
  assert.equal(world.tiles.length, 4352);
  assertWorld(world);
  lab.store.save(world);
  const committed = digestoCanonico(world), value = manifest(lab.store);
  assert.deepEqual(value.tiles.pages.map(page => [page.index, page.count]), [[0, 4096], [1, 256]]);
  assert.equal(value.tiles.count, world.tiles.length);
  assert.deepEqual(value.world.params, paramsOf(world), 'el modo de aplicación se declara aun con defaults');
  assert.equal(value.world.paramsEncoding, 'params-v1');
  const rows = value.tiles.pages.flatMap(page => JSON.parse(pageBody(lab.store, page)) as unknown[][]);
  assert.deepEqual(rows, JSON.parse(encodeSnapshot(world, paramsOf(world))).tiles);
  assert.equal(partDigests(lab.store).length, 2);
  const loaded = lab.reopen().load()!.world;
  assert.equal(digestoCanonico(loaded), committed);
  assert.deepEqual(paramsOf(loaded), paramsOf(world));
});

test('schema 4 se lee sin instalar piezas y se migra a 5 sin cambiar el snapshot compacto', t => {
  const lab = laboratory(t, {}), world = createWorld(42);
  lab.store.save(world);
  const committed = digestoCanonico(world), saved = snapshot(lab.store);
  lab.store.db.exec('DROP TABLE IF EXISTS snapshot_parts; PRAGMA user_version=4');
  const old = lab.reopen({ readOnly: true });
  assert.equal(old.db.prepare('PRAGMA user_version').get()!.user_version, 4);
  assert.equal(old.db.prepare("SELECT name FROM sqlite_schema WHERE name='snapshot_parts'").get(), undefined);
  assert.equal(digestoCanonico(old.load()!.world), committed);
  assert.deepEqual(snapshot(old), saved);
  const migrated = lab.reopen({});
  assert.equal(migrated.db.prepare('PRAGMA user_version').get()!.user_version, 5);
  assert.deepEqual(partDigests(migrated), []);
  assert.deepEqual(snapshot(migrated), saved);
  assert.equal(digestoCanonico(migrated.load()!.world), committed);
  const columns = migrated.db.prepare('PRAGMA table_info(snapshot_parts)').all() as { name: string; type: string; notnull: number; pk: number }[];
  assert.deepEqual(columns.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk })), [
    { name: 'digest', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'body', type: 'TEXT', notnull: 1, pk: 0 },
  ]);
});

for (const [label, schema] of [
  ['ausente', ''],
  ['digest nullable', 'CREATE TABLE snapshot_parts(digest TEXT PRIMARY KEY, body TEXT NOT NULL)'],
  ['sin clave primaria', 'CREATE TABLE snapshot_parts(digest TEXT NOT NULL, body TEXT NOT NULL)'],
  ['body nullable', 'CREATE TABLE snapshot_parts(digest TEXT PRIMARY KEY NOT NULL, body TEXT)'],
  ['body con tipo incorrecto', 'CREATE TABLE snapshot_parts(digest TEXT PRIMARY KEY NOT NULL, body INTEGER NOT NULL)'],
] as const) {
  test(`schema 5 rechaza tabla de piezas ${label}, incluso read-only`, t => {
    const lab = laboratory(t, {});
    lab.store.save(createWorld(42));
    lab.store.db.exec(`DROP TABLE IF EXISTS snapshot_parts; ${schema}; PRAGMA user_version=5`);
    lab.close();
    const inspect = new DatabaseSync(lab.path, { readOnly: true });
    const before = inspect.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all();
    inspect.close();
    for (const readOnly of [false, true]) {
      assert.throws(() => { const opened = openStore(lab.path, { readOnly }); opened.close(); }, /schema|snapshot|part/i);
    }
    const after = new DatabaseSync(lab.path, { readOnly: true });
    try {
      assert.equal(after.prepare('PRAGMA user_version').get()!.user_version, 5);
      assert.deepEqual(after.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all(), before);
    } finally { after.close(); }
  });
}

for (const damage of ['missing page', 'checksum mismatch'] as const) {
  test(`piezas: corrupción física ${damage} recupera el slot 1 sin modificar el archivo`, t => {
    const { lab, current, backupDigest, backupParams } = withBackup(t), page = current.tiles.pages[0]!;
    if (damage === 'missing page') lab.store.db.prepare('DELETE FROM snapshot_parts WHERE digest=?').run(page.digest);
    else lab.store.db.prepare('UPDATE snapshot_parts SET body=? WHERE digest=?').run(`${pageBody(lab.store, page)} `, page.digest);
    const before = todasLasTablas(lab.store), reopened = lab.reopen(), loaded = reopened.load()!;
    assert.equal(loaded.slot, 1);
    assert.equal(loaded.skipped.length, 1);
    assert.match(loaded.skipped[0]!, /slot 0/i);
    assert.equal(digestoCanonico(loaded.world), backupDigest);
    assert.deepEqual(paramsOf(loaded.world), backupParams);
    assert.deepEqual(todasLasTablas(reopened), before);
  });
}

const corruptions: readonly [string, (value: Manifest) => void][] = [
  ['índice fuera de orden', value => { value.tiles.pages[0]!.index = 1; }],
  ['índice fraccionario', value => { value.tiles.pages[0]!.index = 0.5; }],
  ['página duplicada', value => { value.tiles.pages.push({ ...value.tiles.pages[0]! }); }],
  ['conteo de página falso', value => { value.tiles.pages[0]!.count--; }],
  ['bytes de página falsos', value => { value.tiles.pages[0]!.bytes++; }],
  ['conteo total falso', value => { value.tiles.count++; }],
  ['sin páginas', value => { value.tiles.pages = []; }],
  ['encoding del manifest desconocido', value => { value.snapshotEncoding = 'snapshot-parts-future'; }],
  ['encoding de tuplas desconocido', value => { value.world.tileEncoding = 'tiles-tuple-future'; }],
  ['tiles duplicados dentro de metadata', value => { value.world.tiles = []; }],
  ['snapshotEncoding duplicado dentro de metadata', value => { value.world.snapshotEncoding = 'snapshot-parts-v1'; }],
  ['params semánticamente inválidos', value => { (value.world.params as { motor: { hilos: number } }).motor.hilos = -1; }],
  ['encoding de params desconocido', value => { value.world.paramsEncoding = 'params-future'; }],
];

for (const [label, corrupt] of corruptions) {
  test(`piezas: ${label} con checksum correcto falla cerrado aunque exista respaldo`, t => {
    const { lab, current } = withBackup(t);
    corrupt(current);
    rewriteManifest(lab.store, current);
    const before = todasLasTablas(lab.store), reopened = lab.reopen();
    assert.throws(() => reopened.load(), /invalid|snapshot|page|part|tile|parameter|encoding/i);
    assert.deepEqual(todasLasTablas(reopened), before);
  });
}

for (const damage of ['tupla incompleta', 'coordenada inválida'] as const) {
  test(`piezas: ${damage} con hashes y tamaños recalculados falla cerrado`, t => {
    const { lab, current } = withBackup(t), page = current.tiles.pages[0]!;
    const rows = JSON.parse(pageBody(lab.store, page)) as unknown[][];
    if (damage === 'tupla incompleta') rows[0]!.pop();
    else rows[0]![0] = 'not-a-coordinate';
    const body = stringifyExact(rows), digest = sha256(body);
    lab.store.db.prepare('INSERT INTO snapshot_parts(digest,body) VALUES (?,?)').run(digest, body);
    page.digest = digest; page.bytes = Buffer.byteLength(body);
    rewriteManifest(lab.store, current);
    assert.equal(sha256(pageBodyUnchecked(lab.store, page)), page.digest, 'la corrupción no es un checksum roto');
    const before = todasLasTablas(lab.store), reopened = lab.reopen();
    assert.throws(() => reopened.load(), /invalid|snapshot|page|part|tile|tuple|procedural|Estado del mundo inválido/i);
    assert.deepEqual(todasLasTablas(reopened), before);
  });
}

function pageBodyUnchecked(store: Store, page: Page): string {
  return (store.db.prepare('SELECT body FROM snapshot_parts WHERE digest=?').get(page.digest) as { body: string }).body;
}

test('piezas: fallo al insertar slot 0 revierte páginas, todas las tablas y todas las colas', t => {
  const lab = laboratory(t), initial = createWorld(42);
  lab.store.save(initial);
  manifest(lab.store);
  const draft = cloneWorld(initial, lab.store.context);
  changeFood(draft);
  draft.retiredChunks = [generateChunk(draft.seed, 0, 10, paramsOf(draft).agua.cuencas)];
  const founder = draft.people.find(person => person.role === 'neighbor')!;
  const legacy: LegacyRecord = {
    id: 'snapshot-parts-rollback', name: 'Archivo sintético', role: 'neighbor', generation: 0, parents: [],
    bornAt: founder.bornAt, diedAt: draft.tick, cause: 'exposure', genome: structuredClone(founder.genome),
    traits: demographicTraits(founder.genome, paramsOf(draft).cuerpo), communityId: null,
  };
  draft.retiredLegacy = [legacy];
  draft.demographyDynamics.deaths++; draft.demographyDynamics.causes.exposure++;
  const event = recordChronicleEvent(draft, { kind: 'ecology', actors: [], text: 'Observación sintética.', cause: 'Atomicidad de piezas.', source: 'simulation' });
  draft.events.push(event);
  assertWorld(draft);
  const count = partDigests(lab.store).length;
  lab.store.db.exec(`CREATE TRIGGER fail_segmented_snapshot BEFORE INSERT ON snapshots WHEN NEW.slot=0 BEGIN
    SELECT CASE WHEN (SELECT COUNT(*) FROM snapshot_parts)<=${count} THEN RAISE(ABORT,'page insert was not observed') END;
    SELECT RAISE(ABORT,'injected after page insert');
  END`);
  const before = todasLasTablas(lab.store), expected = structuredClone(draft);
  const chunks = draft.retiredChunks, identities = draft.retiredLegacy, pending = draft.chronicleJournal!.pending;
  assert.throws(() => lab.store.save(draft), /injected after page insert/);
  assert.equal(lab.store.db.isTransaction, false);
  assert.deepEqual(todasLasTablas(lab.store), before);
  assert.deepEqual(draft, expected);
  assert.equal(draft.retiredChunks, chunks);
  assert.equal(draft.retiredLegacy, identities);
  assert.equal(draft.chronicleJournal!.pending, pending);
  lab.store.db.exec('DROP TRIGGER fail_segmented_snapshot');
  lab.store.save(draft);
  assert.deepEqual(draft.retiredChunks, []); assert.deepEqual(draft.retiredLegacy, []);
  assert.deepEqual(draft.chronicleJournal!.pending, []);
  assert.equal(lab.store.db.prepare('SELECT COUNT(*) AS n FROM chunks').get()!.n, 1);
  assert.equal(lab.store.db.prepare('SELECT COUNT(*) AS n FROM legacy').get()!.n, 1);
  const committed = digestoCanonico(draft);
  assert.equal(digestoCanonico(lab.reopen().load()!.world), committed);
});

test('piezas: GC conserva referencias del slot 2 y páginas compartidas; elimina sólo las huérfanas', t => {
  const lab = laboratory(t), world = createWorld(42);
  lab.store.save(world);
  const first = manifest(lab.store).tiles.pages[0]!.digest, deepDigest = digestoCanonico(world);
  for (let n = 1; n < DEEP_CHECKPOINT_EVERY_SAVES - 1; n++) lab.store.save(world);
  changeFood(world); lab.store.save(world);
  const second = manifest(lab.store).tiles.pages[0]!.digest;
  assert.equal(manifest(lab.store, 2).tiles.pages[0]!.digest, first);
  world.tiles[0]!.food = 0.5625; lab.store.save(world);
  const shared = manifest(lab.store).tiles.pages[0]!.digest;
  assert.equal(new Set([first, second, shared]).size, 3);
  assert.deepEqual(partDigests(lab.store), [first, second, shared].sort());
  lab.store.save(world);
  assert.equal(manifest(lab.store, 0).tiles.pages[0]!.digest, shared);
  assert.equal(manifest(lab.store, 1).tiles.pages[0]!.digest, shared);
  assert.equal(manifest(lab.store, 2).tiles.pages[0]!.digest, first);
  assert.deepEqual(partDigests(lab.store), [first, shared].sort(), 'la pieza sólo referenciada por el slot profundo sigue viva');
  const committed = digestoCanonico(world), reopened = lab.reopen();
  assert.equal(digestoCanonico(reopened.load()!.world), committed);
  reopened.db.prepare('DELETE FROM snapshot_parts WHERE digest=?').run(shared);
  const recovered = lab.reopen().load()!;
  assert.equal(recovered.slot, 2);
  assert.equal(recovered.skipped.length, 2);
  assert.equal(digestoCanonico(recovered.world), deepDigest);
});

test('piezas: previous recupera el mundo seleccionado y sus params en una copia independiente', t => {
  const { lab, backupDigest, backupParams } = withBackup(t);
  const before = todasLasTablas(lab.store), destination = join(dirname(lab.path), 'previous.sqlite');
  assert.equal(lab.store.previous(destination), 1);
  assert.deepEqual(todasLasTablas(lab.store), before, 'la recuperación explícita sólo escribe la copia');
  lab.close();
  const recovered = openStore(destination, { readOnly: true });
  try {
    const loaded = recovered.load()!;
    assert.equal(loaded.slot, 0);
    assert.equal(digestoCanonico(loaded.world), backupDigest);
    assert.deepEqual(paramsOf(loaded.world), backupParams);
    assert.equal(recovered.db.prepare('SELECT COUNT(*) AS n FROM snapshots').get()!.n, 1);
  } finally { recovered.close(); }
});

for (const race of ['rotación de la fila seleccionada', 'página seleccionada eliminada'] as const) {
  test(`piezas: previous rechaza ${race} entre selección y VACUUM`, t => {
    const lab = laboratory(t), world = createWorld(42);
    lab.store.save(world);
    const selectedPage = manifest(lab.store).tiles.pages[0]!.digest;
    // Avanzar sólo el reloj y las edades mantiene archivos compatibles sin simular nacimientos.
    world.tick = 1;
    for (const person of world.people) person.demography.age = world.tick - person.bornAt;
    changeFood(world); lab.store.save(world);
    assert.equal((manifest(lab.store, 1).world.tick), 0);
    const selected = snapshot(lab.store, 1);
    const writer = openStore(lab.path, { snapshotInlineTileLimit: 0 });
    const backup = lab.store.backup.bind(lab.store);
    let interrupted = false, afterInterference: unknown;
    lab.store.backup = destination => {
      interrupted = true;
      if (race === 'rotación de la fila seleccionada') {
        const newer = writer.load()!.world;
        newer.tick = 2;
        for (const person of newer.people) person.demography.age = newer.tick - person.bornAt;
        newer.tiles[0]!.food = 0.5625;
        writer.save(newer);
        assert.notEqual(snapshot(writer, 1).digest, selected.digest);
        assert.equal(manifest(writer, 1).world.tick, 1);
      } else {
        writer.db.prepare('DELETE FROM snapshot_parts WHERE digest=?').run(selectedPage);
        assert.deepEqual(snapshot(writer, 1), selected, 'la fila sigue igual; sólo desapareció una dependencia');
      }
      afterInterference = todasLasTablas(writer);
      backup(destination);
    };
    try {
      const destination = join(dirname(lab.path), 'racing-previous.sqlite');
      assert.throws(() => lab.store.previous(destination), /changed|checkpoint|snapshot|page|part|recover|missing/i,
        'la copia debe volver a verificar la fila elegida y sus páginas, sin fabricar un mundo a partir de memoria obsoleta');
      assert.equal(interrupted, true, 'la interferencia ocurrió justo antes del VACUUM');
      assert.deepEqual(todasLasTablas(lab.store), afterInterference, 'rechazar la copia no altera el escritor concurrente');
    } finally { lab.store.backup = backup; writer.close(); }
  });
}

const invalidOptions: readonly [string, unknown][] = [
  ['clave desconocida', { snapshotInlineTileLimit: 0, unknown: true }],
  ['objeto null', null],
  ['lista', []],
  ['umbral null', { snapshotInlineTileLimit: null }],
  ['umbral NaN', { snapshotInlineTileLimit: NaN }],
  ['umbral Infinity', { snapshotInlineTileLimit: Infinity }],
  ['umbral negativo', { snapshotInlineTileLimit: -1 }],
  ['umbral fraccionario', { snapshotInlineTileLimit: 0.5 }],
  ['umbral inseguro', { snapshotInlineTileLimit: Number.MAX_SAFE_INTEGER + 1 }],
  ['umbral mayor que 32768', { snapshotInlineTileLimit: 32769 }],
  ['umbral string', { snapshotInlineTileLimit: '0' }],
  ['readOnly string', { readOnly: 'false' }],
];

for (const [label, options] of invalidOptions) {
  test(`piezas: StoreOptions rechaza ${label} antes de crear un archivo`, t => {
    const directory = mkdtempSync(join(tmpdir(), 'atlas-snapshot-options-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'invalid.sqlite');
    assert.throws(() => {
      const opened = new Store(path, options as TransportOptions);
      opened.close();
    }, /Invalid StoreOptions/);
    assert.equal(existsSync(path), false);
  });
}

test('piezas: StoreOptions admite ambos extremos y readOnly booleano sin alterar WorldParams', t => {
  const lab = laboratory(t, { snapshotInlineTileLimit: 32768, readOnly: false }), world = createWorld(42);
  const params = paramsOf(world);
  lab.store.save(world);
  assert.equal(JSON.parse(snapshot(lab.store).body).snapshotEncoding, undefined);
  const committed = digestoCanonico(world), writer = lab.reopen({ snapshotInlineTileLimit: 0, readOnly: false });
  const loaded = writer.load()!.world;
  writer.save(loaded);
  manifest(writer);
  assert.equal(digestoCanonico(loaded), committed);
  assert.deepEqual(paramsOf(loaded), params);
  const reader = lab.reopen({ readOnly: true, snapshotInlineTileLimit: 32768 });
  assert.equal(digestoCanonico(reader.load()!.world), committed);
});

for (const level of ['raíz', 'metadata'] as const) {
  test(`piezas: clave JSON escapada repetida en ${level} no se oculta por JSON.parse`, t => {
    const { lab } = withBackup(t), saved = snapshot(lab.store);
    const body = level === 'raíz'
      ? saved.body.replace('"snapshotEncoding":', '"snapshotEncod\\u0069ng":"hidden-future","snapshotEncoding":')
      : saved.body.replace('"tileEncoding":', '"tileEncod\\u0069ng":"hidden-future","tileEncoding":');
    assert.notEqual(body, saved.body, 'la fixture realmente introduce la segunda clave');
    assert.deepEqual(JSON.parse(body), JSON.parse(saved.body), 'JSON.parse por sí solo perdería la primera declaración');
    reescribirInstantanea(lab.store, body);
    const before = todasLasTablas(lab.store), reopened = lab.reopen();
    assert.throws(() => reopened.load(), /duplicate.*key/i);
    assert.deepEqual(todasLasTablas(reopened), before);
  });
}

test('piezas: guard de metadata mayor que 8 MiB mide bytes UTF-8 y rechaza antes del guardado', t => {
  const lab = laboratory(t), world = createWorld(42);
  lab.store.save(world);
  const before = todasLasTablas(lab.store), committed = digestoCanonico(world);
  const draft = Object.assign(cloneWorld(world, lab.store.context), { transportFixture: 'é'.repeat(4 * 1024 * 1024) });
  const metadata = { ...draft, tiles: undefined };
  const body = stringifyExact(metadata);
  assert.ok(body.length < 8 * 1024 * 1024, 'el número de caracteres no excede el límite');
  assert.ok(Buffer.byteLength(body) > 8 * 1024 * 1024, 'los bytes del metadata sí exceden el límite');
  const pending = draft.chronicleJournal!.pending;
  assert.throws(() => lab.store.save(draft), /metadata exceeds transport size/);
  assert.deepEqual(todasLasTablas(lab.store), before);
  assert.equal(draft.chronicleJournal!.pending, pending);
  assert.equal(draft.transportFixture.length, 4 * 1024 * 1024);
  assert.equal(digestoCanonico(lab.reopen().load()!.world), committed);
});

test('piezas: manifest mayor que 8 MiB con checksum válido falla cerrado al reabrir', t => {
  const { lab, current } = withBackup(t);
  current.world.transportFixture = 'é'.repeat(4 * 1024 * 1024);
  rewriteManifest(lab.store, current);
  const body = snapshot(lab.store).body;
  assert.ok(body.length < 8 * 1024 * 1024);
  assert.ok(Buffer.byteLength(body) > 8 * 1024 * 1024);
  const before = todasLasTablas(lab.store), reopened = lab.reopen();
  assert.throws(() => reopened.load(), /manifest exceeds transport size/);
  assert.deepEqual(todasLasTablas(reopened), before);
});

test('piezas: lastSnapshotBytes cuenta manifest y páginas lógicas incluso al reutilizarlas', t => {
  const lab = laboratory(t), world = createWorld(42);
  for (let iteration = 0; iteration < 3; iteration++) {
    if (iteration === 2) changeFood(world);
    lab.store.save(world);
    const value = manifest(lab.store), saved = snapshot(lab.store);
    const logical = Buffer.byteLength(saved.body) + value.tiles.pages.reduce((bytes, page) => bytes + Buffer.byteLength(pageBody(lab.store, page)), 0);
    assert.equal(lab.store.lastSnapshotBytes, logical);
    assert.ok(logical > Buffer.byteLength(saved.body), 'la medida no se limita al manifest');
    assert.equal(partDigests(lab.store).length, iteration === 2 ? 2 : 1);
  }
  const committed = digestoCanonico(world);
  assert.equal(digestoCanonico(lab.reopen().load()!.world), committed);
});

for (const moment of ['después de INSERT page', 'después de INSERT snapshot0'] as const) {
  test(`piezas: trigger que cambia body ${moment} no produce un guardado falsamente exitoso`, t => {
    const lab = laboratory(t), world = createWorld(42);
    lab.store.save(world);
    const committed = digestoCanonico(world), draft = cloneWorld(world, lab.store.context);
    changeFood(draft);
    draft.retiredChunks = [generateChunk(draft.seed, 0, 10, paramsOf(draft).agua.cuencas)];
    draft.events.push(recordChronicleEvent(draft, { kind: 'ecology', actors: [], text: 'Observación sintética.', cause: 'Trigger de corrupción de página.', source: 'simulation' }));
    let touched = 0;
    lab.store.db.function('observe_page_mutation', () => { touched++; return 0; });
    lab.store.db.exec(moment === 'después de INSERT page'
      ? `CREATE TRIGGER mutate_page AFTER INSERT ON snapshot_parts BEGIN
          UPDATE snapshot_parts SET body=body||' ' WHERE digest=NEW.digest;
          SELECT observe_page_mutation();
        END`
      : `CREATE TRIGGER mutate_page AFTER INSERT ON snapshots WHEN NEW.slot=0 BEGIN
          UPDATE snapshot_parts SET body=body||' ' WHERE digest=json_extract(NEW.body,'$.tiles.pages[0].digest');
          SELECT observe_page_mutation();
        END`);
    const before = todasLasTablas(lab.store), expected = structuredClone(draft);
    const chunks = draft.retiredChunks, pending = draft.chronicleJournal!.pending;
    assert.throws(() => lab.store.save(draft), /page missing or checksum mismatch/i);
    assert.equal(touched, 1, 'el trigger cambió la página antes del rechazo, sin RAISE que falsee el resultado');
    assert.equal(lab.store.db.isTransaction, false);
    assert.deepEqual(todasLasTablas(lab.store), before);
    assert.deepEqual(draft, expected);
    assert.equal(draft.retiredChunks, chunks);
    assert.equal(draft.chronicleJournal!.pending, pending);
    lab.store.db.exec('DROP TRIGGER mutate_page');
    assert.equal(digestoCanonico(lab.reopen().load()!.world), committed);
    lab.store.save(draft);
    const retried = digestoCanonico(draft);
    assert.equal(digestoCanonico(lab.reopen().load()!.world), retried);
  });
}

for (const operation of ['load', 'save'] as const) {
  test(`piezas: shadow TEMP snapshot_parts impide ${operation} sin tocar tablas durables`, t => {
    const lab = laboratory(t), world = createWorld(42);
    lab.store.save(world);
    const before = todasLasTablas(lab.store), committed = digestoCanonico(world);
    lab.store.db.exec('CREATE TEMP TABLE snapshot_parts(digest TEXT PRIMARY KEY NOT NULL,body TEXT NOT NULL)');
    const draft = cloneWorld(world, lab.store.context); changeFood(draft);
    assert.throws(() => operation === 'load' ? lab.store.load() : lab.store.save(draft), /shadow|temporary|temp|schema/i);
    assert.deepEqual(todasLasTablas(lab.store), before);
    assert.equal(lab.store.db.prepare('SELECT COUNT(*) AS n FROM temp.snapshot_parts').get()!.n, 0);
    lab.store.db.exec('DROP TABLE temp.snapshot_parts');
    assert.equal(digestoCanonico(lab.reopen().load()!.world), committed);
  });
}

function storedWorld(value: unknown): World {
  const world = value as World;
  setParams(world, takeSnapshotParams(world));
  assertWorld(world);
  return world;
}

for (const snapshotInlineTileLimit of [32768, 0]) {
  test(`readStoredSnapshot conserva params, -0, bytes y digest con umbral ${snapshotInlineTileLimit}`, t => {
    const lab = laboratory(t, { snapshotInlineTileLimit });
    const world = createWorld(42, parseParams('agua.cuencas=0.8,motor.gpu=[-0,1]'));
    world.tiles.find(tile => tile.x === 0)!.x = -0;
    world.people[0]!.inventory = -0;
    lab.store.save(world);
    const committed = digestoCanonico(world), params = paramsOf(world), saved = snapshot(lab.store);
    const logicalBytes = Buffer.byteLength(saved.body) + (snapshotInlineTileLimit === 0
      ? manifest(lab.store).tiles.pages.reduce((sum, page) => sum + Buffer.byteLength(pageBody(lab.store, page)), 0) : 0);
    lab.close();
    const db = new DatabaseSync(lab.path, { readOnly: true });
    try {
      const result = readStoredSnapshot(db)!;
      assert.equal(db.isTransaction, false, 'el lector cierra su propia transacción');
      assert.equal(result.bodyDigest, saved.digest);
      assert.equal(result.bodyBytes, Buffer.byteLength(saved.body));
      assert.equal(result.snapshotBytes, logicalBytes);
      assert.equal(result.savedAt, saved.saved_at);
      const decoded = storedWorld(result.value);
      assert.equal(digestoCanonico(decoded), committed);
      assert.deepEqual(paramsOf(decoded), params);
      assert.ok(Object.is(paramsOf(decoded).motor.gpu[0], -0));
      assert.ok(Object.is(decoded.people[0]!.inventory, -0));
      assert.ok(Object.is(decoded.tiles.find(tile => tile.x === 0)!.x, -0));
      assert.equal(readStoredSnapshot(db, 2), null);
      assert.equal(db.isTransaction, false, 'un slot ausente también cierra su transacción');
      db.exec('BEGIN');
      assert.equal(digestoCanonico(storedWorld(readStoredSnapshot(db)!.value)), committed);
      assert.equal(readStoredSnapshot(db, 2), null);
      assert.equal(db.isTransaction, true, 'la transacción ajena sobrevive a lectura y slot ausente');
      db.exec('ROLLBACK');
    } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
  });
}

for (const damage of ['checksum del slot', 'página ausente'] as const) {
  test(`readStoredSnapshot rechaza ${damage} sin fallback y respeta transacciones propias y ajenas`, t => {
    const { lab, current, backupDigest } = withBackup(t), db = lab.store.db;
    if (damage === 'checksum del slot') db.prepare("UPDATE snapshots SET body=body||' ' WHERE slot=0").run();
    else db.prepare('DELETE FROM snapshot_parts WHERE digest=?').run(current.tiles.pages[0]!.digest);
    const before = todasLasTablas(lab.store);
    assert.throws(() => readStoredSnapshot(db), SnapshotPhysicalError);
    assert.equal(db.isTransaction, false, 'el error revierte la transacción del propio lector');
    assert.equal(digestoCanonico(storedWorld(readStoredSnapshot(db, 1)!.value)), backupDigest, 'el slot 1 sí es legible cuando se solicita explícitamente');
    db.exec('BEGIN');
    try {
      db.prepare("INSERT INTO metadata(key,value) VALUES ('reader-transaction-fixture','pending')").run();
      assert.throws(() => readStoredSnapshot(db), SnapshotPhysicalError);
      assert.equal(db.isTransaction, true, 'el error no cierra la transacción del caller');
      assert.equal(db.prepare("SELECT value FROM metadata WHERE key='reader-transaction-fixture'").get()!.value, 'pending');
    } finally { if (db.isTransaction) db.exec('ROLLBACK'); }
    assert.deepEqual(todasLasTablas(lab.store), before, 'el caller todavía puede revertir su cambio');
  });
}

test('readStoredSnapshot mantiene una vista coherente si otra conexión rota y elimina la página durante la lectura', t => {
  const lab = laboratory(t), world = createWorld(42);
  lab.store.save(world);
  const committed = digestoCanonico(world), saved = snapshot(lab.store), oldPage = manifest(lab.store).tiles.pages[0]!.digest;
  const writer = openStore(lab.path, { snapshotInlineTileLimit: 0 }), newer = writer.load()!.world;
  const prepare = lab.store.db.prepare.bind(lab.store.db);
  let interrupted = false, latestDigest: string | undefined;
  lab.store.db.prepare = (sql: string) => {
    if (!interrupted && sql === 'SELECT body FROM main.snapshot_parts WHERE digest=?') {
      interrupted = true;
      assert.equal(lab.store.db.isTransaction, true, 'la fila y la página se leen dentro de una sola transacción');
      changeFood(newer); writer.save(newer);
      newer.tiles[0]!.food = 0.5625; writer.save(newer);
      latestDigest = digestoCanonico(newer);
      assert.equal(partDigests(writer).includes(oldPage), false, 'el GC concurrente sí retiró la página del primer estado');
    }
    return prepare(sql);
  };
  try {
    const result = readStoredSnapshot(lab.store.db)!;
    assert.equal(interrupted, true);
    assert.equal(lab.store.db.isTransaction, false);
    assert.equal(result.bodyDigest, saved.digest);
    assert.equal(digestoCanonico(storedWorld(result.value)), committed, 'la página anterior sigue visible en la vista SQLite original');
    assert.equal(digestoCanonico(storedWorld(readStoredSnapshot(lab.store.db)!.value)), latestDigest, 'la siguiente lectura ve el último guardado');
  } finally { lab.store.db.prepare = prepare; writer.close(); }
});

test('piezas: GC conserva páginas ante un respaldo ilegible y un rollback posterior restaura las recolectadas', t => {
  const { lab, world } = withBackup(t);
  const first = snapshot(lab.store, 1), firstPage = manifest(lab.store, 1).tiles.pages[0]!.digest;
  const orphan = manifest(lab.store).tiles.pages[0]!.digest;
  // La cadencia real del slot 2 ya se prueba arriba; aquí se aísla su cuerpo ilegible.
  lab.store.db.prepare('INSERT INTO snapshots(slot,body,digest,saved_at) VALUES (2,?,?,?)').run('{broken', sha256('{broken'), first.saved_at);
  world.tiles[0]!.food = 0.5625; lab.store.save(world); lab.store.save(world);
  const latest = manifest(lab.store).tiles.pages[0]!.digest;
  assert.deepEqual(partDigests(lab.store), [firstPage, orphan, latest].sort(), 'un cuerpo opaco no demuestra que sus páginas sean huérfanas');
  lab.store.db.prepare('UPDATE snapshots SET body=?,digest=?,saved_at=? WHERE slot=2').run(first.body, first.digest, first.saved_at);
  const before = todasLasTablas(lab.store), exec = lab.store.db.exec.bind(lab.store.db);
  let collected = false;
  lab.store.db.exec = (sql: string) => {
    // La preparación puede cerrar lecturas propias antes del guardado; sólo
    // interrumpir el COMMIT cuya transacción ya ejecutó la recolección.
    if (sql === 'COMMIT' && !partDigests(lab.store).includes(orphan)) {
      collected = true;
      throw new Error('injected after parts collection');
    }
    return exec(sql);
  };
  try { assert.throws(() => lab.store.save(world), /injected after parts collection/); }
  finally { lab.store.db.exec = exec; }
  assert.equal(collected, true, 'el fallo ocurre después de borrar la página que ya no tiene referencias');
  assert.equal(lab.store.db.isTransaction, false);
  assert.deepEqual(todasLasTablas(lab.store), before, 'ROLLBACK restaura también las páginas borradas por GC');
  lab.store.save(world);
  assert.deepEqual(partDigests(lab.store), [firstPage, latest].sort(), 'el reintento conserva el slot profundo y recoge sólo la página huérfana');
  const committed = digestoCanonico(world);
  assert.equal(digestoCanonico(lab.reopen().load()!.world), committed);
});

for (const slot of [1, 2]) {
  test(`piezas: trigger que corrompe sólo página del slot ${slot} revierte todas las tablas y colas`, t => {
    const { lab, world } = withBackup(t);
    if (slot === 2) lab.store.db.exec('INSERT INTO snapshots SELECT 2,body,digest,saved_at FROM snapshots WHERE slot=1');
    const expectedPage = manifest(lab.store, slot === 1 ? 0 : 2).tiles.pages[0]!.digest;
    const committed = digestoCanonico(world), draft = cloneWorld(world, lab.store.context);
    draft.tiles[0]!.food = 0.5625;
    draft.retiredChunks = [generateChunk(draft.seed, 0, 10, paramsOf(draft).agua.cuencas)];
    draft.events.push(recordChronicleEvent(draft, { kind: 'ecology', actors: [], text: 'Observación sintética.', cause: 'Trigger que daña sólo el respaldo.', source: 'simulation' }));
    let observed: unknown;
    lab.store.db.function('observe_backup_page', digest => { observed = digest; return 0; });
    lab.store.db.exec(`CREATE TRIGGER mutate_backup_page AFTER INSERT ON snapshots WHEN NEW.slot=0 BEGIN
      UPDATE snapshot_parts SET body=body||' ' WHERE digest=json_extract((SELECT body FROM snapshots WHERE slot=${slot}),'$.tiles.pages[0].digest');
      SELECT observe_backup_page(json_extract((SELECT body FROM snapshots WHERE slot=${slot}),'$.tiles.pages[0].digest'));
    END`);
    const before = todasLasTablas(lab.store), expected = structuredClone(draft), pending = draft.chronicleJournal!.pending;
    assert.throws(() => lab.store.save(draft), /page missing or checksum mismatch/i);
    assert.equal(observed, expectedPage, 'el trigger dañó la página exclusiva del respaldo seleccionado');
    assert.equal(lab.store.db.isTransaction, false);
    assert.deepEqual(todasLasTablas(lab.store), before);
    assert.deepEqual(draft, expected);
    assert.equal(draft.chronicleJournal!.pending, pending);
    lab.store.db.exec('DROP TRIGGER mutate_backup_page');
    assert.equal(digestoCanonico(lab.reopen().load()!.world), committed);
  });
}

test('piezas: GC propaga un RangeError del decoder del respaldo sin ocultarlo como corrupción física', t => {
  const { lab } = withBackup(t), oldBody = snapshot(lab.store, 1).body;
  const gc = new SnapshotParts(lab.store.db, 5), before = todasLasTablas(lab.store);
  const parse = JSON.parse, failure = new RangeError('synthetic GC decoder resource failure');
  let observed = false;
  const mock = t.mock.method(JSON, 'parse', (body: string) => {
    if (body === oldBody) { observed = true; throw failure; }
    return parse(body);
  });
  lab.store.db.exec('BEGIN');
  try {
    assert.throws(() => gc.collect(), error => error === failure);
    assert.equal(observed, true);
    assert.equal(lab.store.db.isTransaction, true);
  } finally { mock.mock.restore(); lab.store.db.exec('ROLLBACK'); }
  assert.deepEqual(todasLasTablas(lab.store), before);
});

test('piezas: umbral default real conserva inline 32768 tiles y segmenta el siguiente chunk', t => {
  const lab = laboratory(t, {}), world = createWorld(42);
  let cx = 10;
  while (world.tiles.length < 32768) { activate(world, cx * 16, 0); cx++; }
  assert.equal(world.tiles.length, 32768);
  assertWorld(world);
  lab.store.save(world);
  const inlineDigest = digestoCanonico(world), saved = snapshot(lab.store);
  assert.equal(JSON.parse(saved.body).snapshotEncoding, undefined);
  assert.equal(saved.body, encodeSnapshot(world, paramsOf(world)));
  assert.deepEqual(partDigests(lab.store), []);
  const grown = lab.reopen().load()!.world;
  assert.equal(digestoCanonico(grown), inlineDigest);
  activate(grown, cx * 16, 0);
  assert.equal(grown.tiles.length, 33024);
  assertWorld(grown);
  lab.store.save(grown);
  const committed = digestoCanonico(grown), value = manifest(lab.store);
  assert.equal(value.tiles.count, 33024);
  assert.deepEqual(value.tiles.pages.map(page => page.count), [...Array<number>(8).fill(4096), 256]);
  for (const page of value.tiles.pages) pageBody(lab.store, page);
  const loaded = lab.reopen().load()!.world;
  assert.equal(digestoCanonico(loaded), committed);
  assert.deepEqual(paramsOf(loaded), paramsOf(grown));
});

test('piezas: previous revierte la copia completa si revocar sesiones dispara un trigger que corrompe una página', t => {
  const { lab } = withBackup(t);
  lab.store.db.prepare('INSERT INTO sessions(hash,expires) VALUES (?,?)').run('synthetic-recovery-session', Date.now() + 60_000);
  lab.store.db.exec(`CREATE TRIGGER corrupt_page_on_revoke AFTER DELETE ON sessions BEGIN
    UPDATE snapshot_parts SET body=body||' '
    WHERE digest=json_extract((SELECT body FROM snapshots WHERE slot=0),'$.tiles.pages[0].digest');
  END`);
  const before = todasLasTablas(lab.store), destination = join(dirname(lab.path), 'revoke-trigger-previous.sqlite');
  assert.throws(() => lab.store.previous(destination), /snapshot|page|checksum/i);
  assert.deepEqual(todasLasTablas(lab.store), before, 'el trigger de la copia no altera el origen');
  const recovered = openStore(destination, { readOnly: true });
  try {
    const after = todasLasTablas(recovered);
    t.diagnostic(`sesiones en copia tras rechazo: ${recovered.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n}`);
    assert.equal(isDeepStrictEqual(after, before), true,
      'el rechazo debe ocurrir antes del COMMIT: todas las tablas de la copia, incluidas sesiones, slots y páginas, vuelven al estado original');
    assert.equal(recovered.db.isTransaction, false);
  } finally { recovered.close(); }
});
