import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { ARCHIVED_CHUNK_TILE_ENCODING, decodeArchivedChunk, encodeArchivedChunk } from '../src/server/snapshot.js';
import { stringifyExact } from '../src/shared/exact-json.js';
import { createWorld, cloneWorld, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { generateChunk, legacyStructures, type Chunk } from '../src/world/terrain.js';
import { materializeAnimals } from '../src/world/animals.js';
import { activate } from '../src/world/spatial.js';
import { sha256 } from './lib/store.js';

function fixture(t: { after: (callback: () => void) => void }): Store {
  const dir = mkdtempSync(join(tmpdir(), 'carta-chunks-tupla-'));
  const store = new Store(join(dir, 'world.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}

/** A fully valid dormant chunk: every optional tile field exercised, plus animals,
 * structures and places, so the round trip has something to lose in every branch. */
function richChunk(world: World): Chunk {
  const chunk = generateChunk(world.seed, -4, 7);
  chunk.discovered = true; chunk.lastTick = world.tick;
  chunk.tiles[0]!.food = 0.123456789;
  chunk.tiles[1]!.food = -0;
  const shelter = chunk.tiles.find(tile => tile.terrain !== 'water')!;
  shelter.terrain = 'shelter'; shelter.fauna = 0; delete shelter.species;
  const stocked = chunk.tiles.find(tile => tile.terrain !== 'water' && tile !== shelter)!;
  stocked.fauna = 2; stocked.species = 'hare';
  chunk.lifeVersion = 4;
  chunk.animals = materializeAnimals(world.seed, chunk.tiles, world.tick);
  chunk.structures = legacyStructures(chunk.tiles, world.tick);
  chunk.places = [...chunk.places, { id: 'landmark:t133', name: 'El mirador de la tupla', x: stocked.x, y: stocked.y,
    description: 'Lugar sintético de la prueba T133.', gatherings: 3 }];
  return chunk;
}

test('T133: encode/decodeArchivedChunk round-trips every field and reads the old JSON body', () => {
  const world = createWorld(51926);
  const chunk = richChunk(world);
  const encoded = encodeArchivedChunk(chunk);
  const parsed = JSON.parse(encoded) as { tileEncoding: string; tiles: unknown[]; animals?: unknown; structures?: unknown };
  assert.equal(parsed.tileEncoding, ARCHIVED_CHUNK_TILE_ENCODING);
  assert.equal(parsed.tileEncoding, 'chunk-tiles-tuple-v1');
  assert.ok(Array.isArray(parsed.tiles[0]), 'tiles travel as tuples, not objects');
  // Non-tile branches keep their plain shape (SQLite reads $.animals/$.structures).
  assert.deepEqual(parsed.animals, JSON.parse(stringifyExact(chunk.animals)));
  assert.deepEqual(parsed.structures, JSON.parse(stringifyExact(chunk.structures)));

  const decoded = decodeArchivedChunk(encoded);
  assert.deepEqual(decoded, chunk);
  assert.deepEqual(Object.keys(decoded).sort(), Object.keys(chunk).sort(), 'same keys, none added or lost');
  assert.equal(Object.is(decoded.tiles[1]!.food, -0), true, '-0 survives the tuple');
  // Historical body: plain JSON with object tiles, exactly as the old writer
  // (`stringifyExact(chunk)` in Store.save) stored it.
  assert.deepEqual(decodeArchivedChunk(stringifyExact(chunk)), chunk);
  assert.throws(() => decodeArchivedChunk('{"tileEncoding":"chunk-tiles-future","tiles":[]}'), /Explicit recovery required/);
});

test('T133: a chunk stored in the old JSON format is read and reanimated exactly as before', t => {
  const store = fixture(t);
  const world = createWorld(51926);
  const chunk = richChunk(world);
  const expected = structuredClone(chunk);
  world.retiredChunks = [chunk]; store.save(world);
  // Rewrite the archived row in the historical format, with its matching digest.
  const oldBody = stringifyExact(expected);
  store.db.prepare('UPDATE chunks SET body=?,digest=? WHERE key=?').run(oldBody, sha256(oldBody), chunk.key);
  assert.deepEqual(store.loadChunk(chunk.key), expected, 'old body decodes to the identical chunk');

  const resumed = store.load()!.world;
  const reference = cloneWorld(resumed);
  activate(reference, chunk.cx * 16, chunk.cy * 16, { loadChunk: () => structuredClone(expected) });
  activate(resumed, chunk.cx * 16, chunk.cy * 16, store.context);
  assert.deepEqual(resumed.tiles.filter(tile => tile.x >= chunk.cx * 16 && tile.x < chunk.cx * 16 + 16
    && tile.y >= chunk.cy * 16 && tile.y < chunk.cy * 16 + 16),
    reference.tiles.filter(tile => tile.x >= chunk.cx * 16 && tile.x < chunk.cx * 16 + 16
    && tile.y >= chunk.cy * 16 && tile.y < chunk.cy * 16 + 16));
  assert.equal(digestoCanonico(resumed), digestoCanonico(reference), 'reanimating the old format gives the same world');
});

test('T133: archiving retired chunks and reanimating them after Store.load loses nothing', t => {
  const store = fixture(t);
  const world = createWorld(51926);
  const chunk = richChunk(world);
  const expected = structuredClone(chunk);
  world.retiredChunks = [chunk]; store.save(world);
  assert.deepEqual(world.retiredChunks, [], 'save confirms and drains the retired queue');

  const row = store.db.prepare('SELECT body,digest,tick FROM chunks WHERE key=?').get(chunk.key) as { body: string; digest: string; tick: number };
  assert.equal(row.digest, sha256(row.body), 'digest is sha256 of the stored tuple body');
  assert.equal(JSON.parse(row.body).tileEncoding, 'chunk-tiles-tuple-v1');
  assert.deepEqual(store.loadChunk(chunk.key), expected, 'loadChunk returns animals, structures, places and every tile field');

  const resumed = store.load()!.world;
  const digestBefore = digestoCanonico(resumed);
  const reference = cloneWorld(resumed);
  activate(reference, chunk.cx * 16, chunk.cy * 16, { loadChunk: () => structuredClone(expected) });
  activate(resumed, chunk.cx * 16, chunk.cy * 16, store.context);
  assert.equal(digestoCanonico(resumed), digestoCanonico(reference),
    'world reanimated from the tuple archive is bit-identical to the in-memory reference');
  assert.notEqual(digestoCanonico(resumed), digestBefore, 'activation really brought the dormant region back');
  assert.deepEqual(resumed.animals.filter(a => a.x >= chunk.cx * 16 && a.x < chunk.cx * 16 + 16 && a.y >= chunk.cy * 16 && a.y < chunk.cy * 16 + 16),
    expected.animals);
  assert.deepEqual(resumed.structures.filter(s => s.x >= chunk.cx * 16 && s.x < chunk.cx * 16 + 16 && s.y >= chunk.cy * 16 && s.y < chunk.cy * 16 + 16),
    expected.structures);
  assert.ok(resumed.places.some(p => p.id === 'landmark:t133'));
});

test('T133: tuple bodies are at least 60% smaller than direct JSON in the chunks table', t => {
  const store = fixture(t);
  const world = createWorld(51926);
  const chunks: Chunk[] = [];
  for (const [cx, cy] of [[-4, 7], [-3, 7], [-4, 8], [5, -2], [6, 3], [-7, -5]] as const) {
    const chunk = generateChunk(world.seed, cx, cy);
    chunk.discovered = true; chunk.lastTick = world.tick;
    chunks.push(chunk); world.retiredChunks.push(chunk);
  }
  store.save(world);
  const rows = store.db.prepare('SELECT body FROM chunks').all() as { body: string }[];
  assert.equal(rows.length, chunks.length);
  const stored = rows.reduce((sum, row) => sum + Buffer.byteLength(row.body), 0);
  const direct = chunks.reduce((sum, chunk) => sum + Buffer.byteLength(JSON.stringify(chunk)), 0);
  const reduction = 1 - stored / direct;
  t.diagnostic(`chunks body bytes: tuple=${stored} direct JSON=${direct} reduction=${(reduction * 100).toFixed(1)}%`);
  assert.ok(rows.every(row => JSON.parse(row.body).tileEncoding === 'chunk-tiles-tuple-v1'));
  assert.ok(reduction >= 0.6, `expected >=60% smaller, got ${(reduction * 100).toFixed(1)}%`);
  for (const chunk of chunks) assert.deepEqual(store.loadChunk(chunk.key), chunk, 'every measured chunk still round-trips');
});
