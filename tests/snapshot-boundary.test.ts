import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.js';
import { createWorld } from '../src/world/index.js';
import { filaInstantanea, reescribirInstantanea } from './lib/store.js';

function fixture(t: { after(callback: () => void): void }) {
  const store = new Store(':memory:'), world = createWorld(51926);
  t.after(() => store.close());
  store.save(world); store.save(world);
  return store;
}
function rows(store: Store) { return store.db.prepare('SELECT * FROM snapshots ORDER BY slot').all(); }
function rewrite(store: Store, body: string) {
  reescribirInstantanea(store, body);
}

for (const corruption of ['future encoding', 'short tuple', 'historical tile cap'] as const) {
  test(`a readable ${corruption} cannot silently select a healthy older checkpoint`, t => {
    const store = fixture(t), row = filaInstantanea(store);
    const value = JSON.parse(row.body) as { tileEncoding: string; tiles: unknown[][] };
    if (corruption === 'future encoding') value.tileEncoding = 'future-v999';
    if (corruption === 'short tuple') value.tiles[0]!.pop();
    if (corruption === 'historical tile cap') {
      // The decoder must reject cardinality before expanding any tuple. Distinct
      // coordinates ensure this does not rely on duplicate-identity rejection.
      value.tiles = Array.from({ length: 65_537 }, (_, x) => [x, 0, ...value.tiles[0]!.slice(2)]);
    }
    rewrite(store, JSON.stringify(value));
    const before = rows(store);
    assert.throws(() => store.load(), /Invalid snapshot tile (encoding|tuple)/);
    assert.deepEqual(rows(store), before, 'read failure never rewrites either checkpoint');
  });
}

test('unreadable JSON still permits physical recovery to a verified checkpoint', t => {
  const store = fixture(t); rewrite(store, '{broken JSON');
  const before = rows(store), loaded = store.load();
  assert.equal(loaded!.slot, 1); assert.equal(loaded!.skipped.length, 1);
  assert.deepEqual(rows(store), before);
});

test('an unexpected decoder resource error is not permission to rewind', t => {
  const store = fixture(t), row = filaInstantanea(store);
  const originalParse = JSON.parse, failure = new RangeError('synthetic decoder resource failure');
  t.mock.method(JSON, 'parse', (body: string) => {
    if (body === row.body) throw failure;
    return originalParse(body);
  });
  assert.throws(() => store.load(), error => error === failure);
});
