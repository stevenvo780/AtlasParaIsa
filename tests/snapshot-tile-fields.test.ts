import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tile } from '../src/shared/types.js';
import { decodeSnapshotTileRows, encodeSnapshotTileRows, SNAPSHOT_TILE_FIELDS } from '../src/server/snapshot.js';

/** Un valor distinto en cada campo: si el codificador y `SNAPSHOT_TILE_FIELDS` se desalinean, dos
 * campos intercambian valores y la tupla deja de coincidir con la lista. */
const tile: Required<Tile> = {
  x: 3, y: -4, terrain: 'meadow', moisture: 0.11, vegetation: 0.12, food: 0.13, biome: 'forest', elevation: 0.14,
  wood: 1.5, stone: 2.5, feature: 'spring', variety: 0.15, growth: 0.16, fertility: 0.17, cultivation: 0.18,
  traffic: 0.19, drinkingWater: 0.21, species: 'deer', fauna: 4, life: 0.22,
};

test('the hand-written tile tuple follows SNAPSHOT_TILE_FIELDS and names every Tile field once', () => {
  const [row] = encodeSnapshotTileRows([tile]);
  assert.deepEqual(row, SNAPSHOT_TILE_FIELDS.map(field => tile[field]));
  assert.deepEqual([...SNAPSHOT_TILE_FIELDS].sort(), Object.keys(tile).sort());
  assert.deepEqual(decodeSnapshotTileRows([row!]), [tile]);
});
