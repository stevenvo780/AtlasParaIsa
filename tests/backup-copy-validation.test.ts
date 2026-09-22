import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { Store } from '../src/server/store.js';
import { createWorld, stepWorld } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { parseParams } from '../src/world/params.js';

for (const paged of [false, true]) {
  test(`backup CLI verifies the copied world with live WAL and preserves archives, paged=${paged}`, t => {
    const directory = mkdtempSync(join(tmpdir(), 'atlas-backup-valid-copy-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const source = join(directory, 'world.sqlite'), target = join(directory, 'copy.sqlite');
    const original = new Store(source, paged ? { snapshotInlineTileLimit: 0 } : {});
    try {
      const world = createWorld(51926, parseParams('agua.cuencas=0.8'));
      original.save(world); stepWorld(world); original.save(world);
      const digest = digestoCanonico(world), before = readFileSync(source), wal = readFileSync(source + '-wal');
      const cli = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../scripts/storage.ts', import.meta.url)), 'backup', target],
        { env: { ...process.env, CARTA_DATA_DIR: directory }, encoding: 'utf8', timeout: 30000 });
      assert.equal(cli.status, 0, cli.stderr);
      const copied = new Store(target, { readOnly: true });
      try {
        const loaded = copied.load()!;
        assert.equal(loaded.slot, 0); assert.deepEqual(loaded.skipped, []);
        assert.equal(digestoCanonico(loaded.world), digest);
        const tables = original.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as { name: string }[];
        for (const { name } of tables) {
          assert.match(name, /^[a-z_]+$/);
          assert.ok(isDeepStrictEqual(copied.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(),
            original.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()), `copied table differs: ${name}`);
        }
      } finally { copied.close(); }
      assert.ok(readFileSync(source).equals(before)); assert.ok(readFileSync(source + '-wal').equals(wal));
    } finally { original.close(); }
  });
  test(`backup CLI rejects semantically invalid completed copy after source validation, paged=${paged}`, t => {
    const directory = mkdtempSync(join(tmpdir(), 'atlas-backup-copy-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const source = join(directory, 'world.sqlite'), target = join(directory, 'copy.sqlite');
    const original = new Store(source, paged ? { snapshotInlineTileLimit: 0 } : {});
    original.save(createWorld(51926, parseParams('agua.cuencas=0.8'))); original.close();
    const hook = join(directory, 'after-validation.mts');
    const storeUrl = new URL('../src/server/store.ts', import.meta.url).href;
    writeFileSync(hook, `
import { Store } from ${JSON.stringify(storeUrl)};
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
const backup = Store.prototype.backup;
Store.prototype.backup = function(destination) {
  const writer = new DatabaseSync(${JSON.stringify(source)});
  try {
    const row = writer.prepare('SELECT body FROM snapshots WHERE slot=0').get();
    const value = JSON.parse(row.body), world = value.snapshotEncoding ? value.world : value;
    world.params.agua.cuencas = -1;
    const body = JSON.stringify(value), digest = createHash('sha256').update(body).digest('hex');
    writer.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=0').run(body,digest);
  } finally { writer.close(); }
  return backup.call(this,destination);
};
`);
    const cli = spawnSync(process.execPath, ['--import', 'tsx', '--import', pathToFileURL(hook).href,
      fileURLToPath(new URL('../scripts/storage.ts', import.meta.url)), 'backup', target],
    { env: { ...process.env, CARTA_DATA_DIR: directory }, encoding: 'utf8', timeout: 30000 });
    assert.equal(cli.status, 1, 'a successful preload must not certify different bytes copied later');
    assert.match(cli.stderr, /Invalid snapshot parameters/);
    assert.doesNotMatch(cli.stdout, /Copia coherente creada/);
    const copied = new DatabaseSync(target, { readOnly: true });
    try { assert.equal(copied.prepare('PRAGMA quick_check').get()!.quick_check, 'ok', 'SQLite consistency alone is insufficient'); }
    finally { copied.close(); }
    const bytes = readFileSync(target);
    const invalid = new Store(target, { readOnly: true });
    try { assert.throws(() => invalid.load(), /Invalid snapshot parameters/); }
    finally { invalid.close(); }
    assert.ok(readFileSync(target).equals(bytes), 'failed copy remains unmodified for inspection');
  });
}

test('backup CLI rejects an empty database instead of reporting a world backup', t => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-backup-empty-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  new Store(join(directory, 'world.sqlite')).close();
  const cli = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../scripts/storage.ts', import.meta.url)),
    'backup', join(directory, 'copy.sqlite')], { env: { ...process.env, CARTA_DATA_DIR: directory }, encoding: 'utf8', timeout: 30000 });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /sin mundo/);
  assert.doesNotMatch(cli.stdout, /Copia coherente creada/);
});
