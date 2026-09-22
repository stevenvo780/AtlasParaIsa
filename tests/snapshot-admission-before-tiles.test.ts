import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world/index.js';
import { parseParams } from '../src/world/params.js';
import { encodeSnapshot, SnapshotSemanticError } from '../src/server/snapshot.js';

for (const key of ['teselasActivas', 'chunks', 'fauna', 'comunidades'] as const) {
  test(`inline encoder admits ${key} before touching tile rows`, () => {
    const world = createWorld();
    if (key === 'comunidades') world.communities = [{}, {}] as typeof world.communities;
    const params = parseParams({ limites: { [key]: 1 } });
    let reads = 0;
    const sentinel = new RangeError('tuple expansion must not happen before admission');
    Object.defineProperty(world.tiles[0]!, 'x', { get() { reads++; throw sentinel; }, enumerable: true });
    assert.throws(() => encodeSnapshot(world, params), SnapshotSemanticError);
    assert.equal(reads, 0);
  });
}

test('valid collection counts still expand rows and propagate unexpected getter failure unchanged', () => {
  const world = createWorld(), sentinel = new RangeError('unexpected tile getter failure'); let reads = 0;
  Object.defineProperty(world.tiles[0]!, 'x', { get() { reads++; throw sentinel; }, enumerable: true });
  assert.throws(() => encodeSnapshot(world), error => error === sentinel);
  assert.equal(reads, 1);
});
