import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Store } from '../src/server/store.js';
import { createWorld } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { paramsOf, parseParams } from '../src/world/params.js';

const checksum = (body: string): string => createHash('sha256').update(body).digest('hex');
const sqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`;
interface SnapshotMetadata { params: { agua: { cuencas: number } }; }
interface SnapshotBody extends SnapshotMetadata { snapshotEncoding?: string; world?: SnapshotMetadata; }

function allTables(store: Store): unknown {
  const names = store.db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' ORDER BY name").all() as { name: string }[];
  return names.map(({ name }) => [name, store.db.prepare(`SELECT * FROM main."${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]);
}

function fixture(t: TestContext, snapshotInlineTileLimit: number) {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-snapshot-recovery-boundary-'));
  const store = new Store(join(directory, 'world.sqlite'), { snapshotInlineTileLimit });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const world = createWorld(42, parseParams('agua.cuencas=0.8'));
  store.save(world);
  const previousDigest = digestoCanonico(world);
  world.tiles[0]!.food = 0.3125;
  store.save(world);
  const currentDigest = digestoCanonico(world);
  // Se necesita un candidato posterior válido para detectar un salto indebido.
  store.db.exec('INSERT INTO snapshots SELECT 2,body,digest,saved_at FROM snapshots WHERE slot=1');
  return { store, previousDigest, currentDigest, destination: join(directory, 'recovered.sqlite') };
}

for (const kind of ['RangeError', 'SQLite I/O', 'TypeError', 'Error ordinario'] as const) {
  test(`recovery boundary: ${kind} conserva la instancia, no visita slot 2 ni crea una copia`, t => {
    const { store, destination } = fixture(t, 0), before = allTables(store);
    const injected = kind === 'RangeError' ? new RangeError('synthetic snapshot page allocation failure')
      : kind === 'TypeError' ? new TypeError('synthetic unexpected snapshot decoder failure')
        : kind === 'Error ordinario' ? new Error('synthetic ordinary page lookup failure')
        : Object.assign(new Error('synthetic disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
    const prepare = store.db.prepare.bind(store.db), backup = store.backup.bind(store);
    const slots: number[] = [];
    let injectedCount = 0, backupCalls = 0, caught: unknown;
    store.db.prepare = (sql: string) => {
      if (!injectedCount && sql === 'SELECT body FROM main.snapshot_parts WHERE digest=?') {
        injectedCount++;
        throw injected;
      }
      const statement = prepare(sql);
      if (/^SELECT body,digest,saved_at FROM (?:main\.)?snapshots WHERE slot=\?$/.test(sql)) {
        const get = statement.get;
        t.mock.method(statement, 'get', (...parameters: unknown[]) => {
          if (typeof parameters[0] === 'number') slots.push(parameters[0]);
          return Reflect.apply(get, statement, parameters);
        });
      }
      return statement;
    };
    store.backup = destination => { backupCalls++; backup(destination); };
    try { store.previous(destination); } catch (error) { caught = error; }
    finally { store.db.prepare = prepare; store.backup = backup; }
    t.diagnostic(JSON.stringify({ kind, injectedCount, slots, backupCalls, destinationExists: existsSync(destination), sameInstance: caught === injected }));
    assert.deepEqual(allTables(store), before, 'el fallo operativo no modifica el origen');
    assert.equal(injectedCount, 1);
    assert.equal(caught, injected, 'un fallo operativo o inesperado se propaga sin convertirse en permiso para retroceder');
    assert.deepEqual(slots, [1]);
    assert.equal(backupCalls, 0);
    assert.equal(existsSync(destination), false);
    assert.equal(store.db.isTransaction, false);
  });
}

for (const snapshotInlineTileLimit of [32768, 0]) {
  const format = snapshotInlineTileLimit === 0 ? 'piezas' : 'inline';

  test(`recovery boundary: revoke que cambia agua 0.8 a 0.7 con checksum válido revierte ALLtables (${format})`, t => {
    const { store, destination, currentDigest } = fixture(t, snapshotInlineTileLimit);
    const row = store.db.prepare('SELECT body FROM snapshots WHERE slot=1').get() as { body: string };
    const changed = JSON.parse(row.body) as SnapshotBody;
    const metadata = changed.snapshotEncoding ? changed.world! : changed;
    assert.equal(metadata.params.agua.cuencas, 0.8);
    metadata.params.agua.cuencas = 0.7;
    const body = JSON.stringify(changed), digest = checksum(body);
    store.db.prepare('INSERT INTO sessions(hash,expires) VALUES (?,?)').run('synthetic-recovery-session', Date.now() + 60_000);
    store.db.exec(`CREATE TRIGGER alter_recovered_laws AFTER DELETE ON sessions BEGIN
      UPDATE snapshots SET body=${sqlString(body)},digest=${sqlString(digest)} WHERE slot=0;
    END`);
    const before = allTables(store);
    let caught: unknown;
    try { store.previous(destination); } catch (error) { caught = error; }
    assert.deepEqual(allTables(store), before, 'la recuperación no ejecuta el trigger sobre el origen');
    const copy = new Store(destination, { readOnly: true });
    try {
      const untouched = isDeepStrictEqual(allTables(copy), before);
      const copiedRow = copy.db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get() as { body: string; digest: string };
      assert.equal(checksum(copiedRow.body), copiedRow.digest, 'un checksum roto no explica el rechazo esperado');
      const decoded = JSON.parse(copiedRow.body) as SnapshotBody;
      t.diagnostic(JSON.stringify({ format, rejected: caught instanceof Error, allTablesRestored: untouched,
        copiedWater: (decoded.snapshotEncoding ? decoded.world! : decoded).params.agua.cuencas }));
      assert.ok(caught instanceof Error, 'la recuperación no puede informar éxito con otras leyes válidas');
      assert.equal(untouched, true, 'rechazar exige rollback antes del COMMIT, conservando todas las tablas de la copia original');
      const loaded = copy.load()!.world;
      assert.equal(paramsOf(loaded).agua.cuencas, 0.8);
      assert.equal(digestoCanonico(loaded), currentDigest);
    } finally { copy.close(); }
    assert.equal(store.db.isTransaction, false);
  });

  test(`recovery boundary: revoke que borra eventos revierte ALLtables antes del COMMIT (${format})`, t => {
    const { store, destination, currentDigest } = fixture(t, snapshotInlineTileLimit);
    assert.ok(Number(store.db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n) > 0);
    store.db.prepare('INSERT INTO sessions(hash,expires) VALUES (?,?)').run('synthetic-recovery-session', Date.now() + 60_000);
    store.db.exec('CREATE TRIGGER erase_recovered_chronicle AFTER DELETE ON sessions BEGIN DELETE FROM events; END');
    const before = allTables(store);
    let caught: unknown;
    try { store.previous(destination); } catch (error) { caught = error; }
    assert.deepEqual(allTables(store), before, 'la crónica original permanece intacta');
    const copy = new Store(destination, { readOnly: true });
    try {
      const untouched = isDeepStrictEqual(allTables(copy), before);
      t.diagnostic(JSON.stringify({ format, rejected: caught instanceof Error, allTablesRestored: untouched,
        copiedEvents: Number(copy.db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n),
        copiedSessions: Number(copy.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n) }));
      assert.ok(caught instanceof Error, 'una crónica borrada por el trigger impide confirmar la recuperación');
      assert.equal(untouched, true, 'el rechazo tardío de load() no sustituye un rollback de TODAS las tablas');
      assert.equal(digestoCanonico(copy.load()!.world), currentDigest);
    } finally { copy.close(); }
    assert.equal(store.db.isTransaction, false);
  });

  test(`recovery boundary: recuperación ordinaria conserva el mundo elegido y sus parámetros (${format})`, t => {
    const { store, destination, previousDigest } = fixture(t, snapshotInlineTileLimit);
    store.db.prepare('INSERT INTO sessions(hash,expires) VALUES (?,?)').run('synthetic-recovery-session', Date.now() + 60_000);
    const before = allTables(store);
    assert.equal(store.previous(destination), 1);
    assert.deepEqual(allTables(store), before);
    const copy = new Store(destination, { readOnly: true });
    try {
      const loaded = copy.load()!;
      assert.equal(loaded.slot, 0);
      assert.equal(digestoCanonico(loaded.world), previousDigest);
      assert.equal(paramsOf(loaded.world).agua.cuencas, 0.8);
      assert.equal(copy.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 0);
      assert.equal(copy.db.prepare('SELECT COUNT(*) AS n FROM snapshots').get()!.n, 1);
    } finally { copy.close(); }
  });
}

for (const damage of ['checksum físico', 'params fuera de rango'] as const) {
  test(`recovery boundary: recuperación explícita todavía puede saltar ${damage} conocido`, t => {
    const { store, destination, previousDigest } = fixture(t, 0);
    if (damage === 'checksum físico') store.db.exec("UPDATE snapshots SET body=body||' ' WHERE slot=1");
    else {
      const row = store.db.prepare('SELECT body FROM snapshots WHERE slot=1').get() as { body: string };
      const value = JSON.parse(row.body) as SnapshotBody;
      value.world!.params.agua.cuencas = 9;
      const body = JSON.stringify(value);
      store.db.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=1').run(body, checksum(body));
    }
    const before = allTables(store);
    assert.equal(store.previous(destination), 2);
    assert.deepEqual(allTables(store), before);
    const copy = new Store(destination, { readOnly: true });
    try { assert.equal(digestoCanonico(copy.load()!.world), previousDigest); }
    finally { copy.close(); }
  });
}
