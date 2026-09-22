import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SnapshotParts } from '../src/server/snapshot-parts.js';
import { decodeSnapshot, encodeSnapshot } from '../src/server/snapshot.js';
import { stringifyExact } from '../src/shared/exact-json.js';
import { createWorld, type World } from '../src/world/index.js';
import { DEFAULT_PARAMS, parseParams } from '../src/world/params.js';

for (const order of ['original', 'first', 'last', 'reverse'] as const) {
  for (const nondefault of [false, true]) {
    test(`paged transport preserves exact root order: ${order}, custom laws ${nondefault}`, () => {
      const params = nondefault ? parseParams('agua.cuencas=0.8,motor.gpu=[1,0]') : DEFAULT_PARAMS;
      const initial = createWorld(1, params);
      initial.tiles[0]!.traffic = -0;
      const entries = Object.entries(initial), tile = entries.find(([key]) => key === 'tiles')!;
      const rest = entries.filter(([key]) => key !== 'tiles');
      const ordered = order === 'first' ? [tile, ...rest] : order === 'last' ? [...rest, tile]
        : order === 'reverse' ? [...entries].reverse() : entries;
      const world = Object.fromEntries(ordered) as unknown as World;
      const db = new DatabaseSync(':memory:');
      try {
        SnapshotParts.install(db); db.exec('BEGIN');
        const parts = new SnapshotParts(db, 5);
        const written = parts.write(parts.prepare(world, params, 0));
        const loaded = parts.read(written.body) as World;
        const expected = decodeSnapshot(encodeSnapshot(world, params)) as World;
        assert.deepEqual(Object.keys(loaded), Object.keys(expected));
        assert.ok(stringifyExact(loaded) === stringifyExact(expected), 'identical order and numeric bits without formatting a giant assertion diff');
        assert.ok(Object.is(loaded.tiles[0]!.traffic, -0));
        const manifest = JSON.parse(written.body);
        assert.equal(manifest.world.tiles, null, 'metadata reserves only the root property position');
        assert.ok(manifest.tiles.pages.length > 0);
        for (const marker of [undefined, [], false, 0]) {
          const broken = structuredClone(manifest);
          if (marker === undefined) delete broken.world.tiles;
          else broken.world.tiles = marker;
          assert.throws(() => parts.read(JSON.stringify(broken)), /metadata tile encoding/);
        }
        db.exec('ROLLBACK');
      } finally { db.close(); }
    });
  }
}
