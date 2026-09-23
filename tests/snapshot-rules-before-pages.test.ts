import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../src/server/store.js';
import { createWorld } from '../src/world/index.js';
import { SnapshotSemanticError } from '../src/server/snapshot.js';
import { filaInstantanea, reescribirInstantanea } from './lib/store.js';

function tables(store: Store): string {
  const hash = createHash('sha256');
  for (const { name } of store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as { name: string }[]) {
    hash.update(name);
    for (const row of store.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).iterate()) hash.update(JSON.stringify(row));
  }
  return hash.digest('hex');
}

for (const profile of [true, false]) for (const version of [999, '9', null]) {
  test(`unknown rules ${String(version)} reject before missing pages, profile=${profile}`, () => {
    const store = new Store(':memory:', { snapshotInlineTileLimit: 0 });
    try {
      const world = createWorld(); store.save(world); world.tiles[0]!.food = 0.321; store.save(world);
      const manifest = JSON.parse(filaInstantanea(store).body);
      if (!profile) delete manifest.world.limitsProfile;
      manifest.world.version = version;
      const body = JSON.stringify(manifest);
      reescribirInstantanea(store, body);
      store.db.prepare('DELETE FROM snapshot_parts WHERE digest=?').run(manifest.tiles.pages[0].digest);
      const before = tables(store);
      assert.throws(() => store.load(), SnapshotSemanticError);
      assert.equal(tables(store), before); assert.equal(store.db.isTransaction, false);
    } finally { store.close(); }
  });
}
