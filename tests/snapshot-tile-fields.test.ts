import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tile } from '../src/shared/types.js';
import { decodeArchivedChunk, decodeSnapshotTileRows, encodeArchivedChunk, encodeSnapshotTileRows, SNAPSHOT_TILE_FIELDS } from '../src/server/snapshot.js';
import type { Chunk } from '../src/world/terrain.js';

/** Un valor distinto en cada campo: si el codificador y `SNAPSHOT_TILE_FIELDS` se desalinean, dos
 * campos intercambian valores y la tupla deja de coincidir con la lista. */
const tile: Required<Omit<Tile, 'mat' | 'T'>> = { // `mat` y `T` (V23) solo existen en la vista: no se guardan
  x: 3, y: -4, terrain: 'meadow', moisture: 0.11, vegetation: 0.12, food: 0.13, biome: 'forest', elevation: 0.14,
  wood: 1.5, stone: 2.5, feature: 'spring', variety: 0.15, growth: 0.16, fertility: 0.17, cultivation: 0.18,
  traffic: 0.19, drinkingWater: 0.21, species: 'deer', fauna: 4, life: 0.22, paved: 0.5, rocaLatente: 160_000,
};

test('the hand-written tile tuple follows SNAPSHOT_TILE_FIELDS and names every Tile field once', () => {
  const [row] = encodeSnapshotTileRows([tile]);
  assert.deepEqual(row, SNAPSHOT_TILE_FIELDS.map(field => tile[field]));
  assert.deepEqual([...SNAPSHOT_TILE_FIELDS].sort(), Object.keys(tile).sort());
  assert.deepEqual(decodeSnapshotTileRows([row!]), [tile]);
});

test('una página archivada admite tuplas con y sin la reserva de roca latente', () => {
  const { rocaLatente, ...normal } = { ...tile, x: 1, y: 0 };
  const chunk: Chunk = { key: '0,0', cx: 0, cy: 0, discovered: true, lastTick: 0, places: [],
    tiles: [{ ...tile, x: 0, y: 0 }, normal] };
  const codificado = encodeArchivedChunk(chunk);
  assert.deepEqual(JSON.parse(codificado).tiles.map((row: unknown[]) => row.length), [22, 19]);
  assert.deepEqual(decodeArchivedChunk(codificado), chunk);
});
