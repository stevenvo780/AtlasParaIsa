import test from 'node:test';
import assert from 'node:assert/strict';
import { CHUNK_SIZE, MAX_COORDINATE, chunkCoords, chunkKey, generateChunk, generateTile, proceduralPlaceName } from '../src/world/terrain.js';
import type { Biome, Tile } from '../src/shared/types.js';

const SEED = 51926;

test('cell coordinates use floor division across positive and negative chunk boundaries', () => {
  for (const [x, expected] of [[-33, -3], [-32, -2], [-17, -2], [-16, -1], [-1, -1], [0, 0], [15, 0], [16, 1], [31, 1], [32, 2]] as const) {
    assert.deepEqual(chunkCoords(x, x), { cx: expected, cy: expected });
    assert.equal(chunkKey(x, x), `${expected},${expected}`);
    const local = x - expected * CHUNK_SIZE;
    assert.ok(local >= 0 && local < CHUNK_SIZE);
  }
});

test('chunks reproduce exactly independent of discovery order; changing the seed changes terrain', () => {
  const coordinates = [[0, 0], [-1, -1], [15327, -44128], [-624999, 624999]] as const;
  const original = coordinates.map(([cx, cy]) => generateChunk(SEED, cx, cy));
  for (const [cx, cy] of [...coordinates].reverse()) {
    const repeated = generateChunk(SEED, cx, cy);
    assert.deepEqual(repeated, original.find(chunk => chunk.cx === cx && chunk.cy === cy));
    assert.equal(repeated.tiles.length, CHUNK_SIZE ** 2);
    assert.equal(new Set(repeated.tiles.map(tile => `${tile.x},${tile.y}`)).size, CHUNK_SIZE ** 2);
  }
  assert.notDeepEqual(generateChunk(SEED, 3, -4).tiles, generateChunk(SEED + 1, 3, -4).tiles);
});

test('a rebuilt far window has no dependence on intervening exploration or caller mutations', () => {
  const cx = 524287, cy = -318427;
  const original = generateChunk(SEED, cx, cy);
  const saved = structuredClone(original);
  original.tiles[0]!.food = -100;
  original.tiles[0]!.x = 0;
  original.discovered = true;
  original.places.push({ id: 'caller-edit', name: 'Edición', x: 0, y: 0, description: 'Prueba', gatherings: 5 });
  for (let index = -12; index < 12; index++) generateChunk(SEED + (index + 12), index * 503, index * -37);
  assert.deepEqual(generateChunk(SEED, cx, cy), saved);
  assert.notDeepEqual(generateChunk(SEED, cx - 65536, cy).tiles.map(t => t.elevation), saved.tiles.map(t => t.elevation));
});

test('direct cells equal chunk cells on both sides of every tested positive, negative and far seam', () => {
  for (const [cx, cy] of [[0, 0], [-1, -1], [-2, 3], [73125, -325006]] as const) {
    const chunks = [generateChunk(SEED, cx, cy), generateChunk(SEED, cx + 1, cy), generateChunk(SEED, cx, cy + 1)];
    for (const chunk of chunks) {
      for (const tile of chunk.tiles) assert.deepEqual(tile, generateTile(SEED, tile.x, tile.y));
    }
    const left = chunks[0]!, right = chunks[1]!, bottom = chunks[2]!;
    assert.equal(left.tiles[15]!.x + 1, right.tiles[0]!.x);
    assert.equal(left.tiles[240]!.y + 1, bottom.tiles[0]!.y);
  }
});

test('elevation varies coherently across neighborhoods without an extra step at chunk seams', () => {
  let ordinary = 0, ordinaryCount = 0, seams = 0, seamCount = 0;
  let largestAdjacentStep = 0, minimum = 1, maximum = 0;
  for (const offset of [0, 8_123_456, -7_123_456]) {
    for (let y = -80; y < 80; y += 7) {
      let previous = generateTile(SEED, offset - 160, y - offset).elevation!;
      for (let x = -159; x <= 160; x++) {
        const elevation = generateTile(SEED, offset + x, y - offset).elevation!;
        const difference = Math.abs(elevation - previous);
        minimum = Math.min(minimum, elevation); maximum = Math.max(maximum, elevation);
        largestAdjacentStep = Math.max(largestAdjacentStep, difference);
        if ((offset + x) % CHUNK_SIZE === 0) { seams += difference; seamCount++; }
        else { ordinary += difference; ordinaryCount++; }
        previous = elevation;
      }
    }
  }
  assert.ok(maximum - minimum > 0.2, 'the control must include real hills and lowlands, not a flat field');
  assert.ok(ordinary / ordinaryCount > 0.0001, 'neighboring samples must contain measurable detail');
  assert.ok(largestAdjacentStep < 0.055, `unexpected terrain discontinuity: ${largestAdjacentStep}`);
  assert.ok(seams / seamCount <= ordinary / ordinaryCount * 1.35, 'chunk borders must not introduce a separate elevation jump');
});

test('broad reproducible samples contain six biomes with bounded correlated resources', () => {
  const biomes: Biome[] = ['grassland', 'forest', 'desert', 'mountain', 'wetland', 'ocean'];
  const samples = new Map<Biome, Tile[]>(biomes.map(biome => [biome, []]));
  for (let y = -1000; y <= 1000; y += 20) {
    for (let x = -1000; x <= 1000; x += 20) {
      const tile = generateTile(SEED, x, y);
      samples.get(tile.biome!)!.push(tile);
      for (const key of ['moisture', 'vegetation', 'food', 'elevation'] as const) {
        assert.ok(Number.isFinite(tile[key]) && tile[key]! >= 0 && tile[key]! <= 1, `${key} is bounded`);
      }
      assert.ok(Number.isInteger(tile.wood) && tile.wood! >= 0 && tile.wood! <= 12);
      assert.ok(Number.isInteger(tile.stone) && tile.stone! >= 0 && tile.stone! <= 8);
      assert.notEqual(tile.terrain, 'shelter', 'shelters need a human construction action');
      if (tile.biome === 'ocean') {
        assert.equal(tile.terrain, 'water'); assert.ok(tile.elevation! < 0.37);
        assert.equal(tile.food, 0); assert.equal(tile.wood, 0); assert.equal(tile.stone, 0);
      }
      if (tile.biome === 'wetland') {
        assert.notEqual(tile.terrain, 'water'); assert.ok(tile.elevation! >= 0.37 && tile.elevation! < 0.49);
        assert.ok(tile.moisture > 0.64);
      }
    }
  }
  for (const biome of biomes) assert.ok(samples.get(biome)!.length >= 50, `${biome} must be a nontrivial region of the sample`);
  const average = (biome: Biome, key: 'wood' | 'stone' | 'vegetation' | 'moisture'): number => {
    const tiles = samples.get(biome)!;
    return tiles.reduce((sum, tile) => sum + tile[key]!, 0) / tiles.length;
  };
  assert.ok(average('forest', 'wood') > average('grassland', 'wood') + 5);
  assert.ok(average('mountain', 'stone') > average('grassland', 'stone') + 3);
  assert.ok(average('forest', 'vegetation') > average('desert', 'vegetation') + 0.5);
  assert.ok(average('forest', 'moisture') > average('desert', 'moisture') + 0.3);
});

test('the smooth initial highland keeps legacy places and the initial region usable across seeds', () => {
  for (const seed of [0, 1, SEED, 20260905, 0xffff_ffff]) {
    for (const [x, y] of [[17, 13], [25, 8], [10, 20]] as const) assert.notEqual(generateTile(seed, x, y).terrain, 'water');
    let land = 0;
    for (let y = 0; y < 28; y++) for (let x = 0; x < 40; x++) if (generateTile(seed, x, y).terrain !== 'water') land++;
    assert.ok(land / (40 * 28) > 0.95);
  }
});

test('landmarks are optional deterministic landscape names with no manufactured history or shelter', () => {
  let found = 0, empty = 0;
  const ids = new Set<string>();
  for (let cx = -8; cx <= 8; cx++) {
    const chunk = generateChunk(SEED, cx, cx - 5);
    assert.equal(chunk.discovered, false); assert.equal(chunk.lastTick, 0);
    assert.ok(chunk.places.length <= 1);
    if (!chunk.places.length) empty++;
    for (const place of chunk.places) {
      found++;
      assert.equal(place.gatherings, 0);
      assert.equal(place.name, proceduralPlaceName(SEED, place.x, place.y));
      assert.equal(place.name, proceduralPlaceName(SEED, place.x, place.y));
      assert.equal(chunkKey(place.x, place.y), chunk.key);
      assert.notEqual(generateTile(SEED, place.x, place.y).terrain, 'water');
      assert.equal(ids.has(place.id), false); ids.add(place.id);
      assert.ok(place.name.length > 8 && place.name.length < 80);
    }
  }
  assert.ok(found > 0 && empty > 0);
});

test('technical limits are a complete half-open chunk domain; malformed coordinates and seeds fail', () => {
  const maximumChunk = MAX_COORDINATE / CHUNK_SIZE - 1;
  for (const cx of [-MAX_COORDINATE / CHUNK_SIZE, maximumChunk]) {
    const chunk = generateChunk(SEED, cx, cx);
    assert.equal(chunk.tiles.length, CHUNK_SIZE ** 2);
    assert.ok(chunk.tiles.every(t => t.x >= -MAX_COORDINATE && t.x < MAX_COORDINATE && t.y >= -MAX_COORDINATE && t.y < MAX_COORDINATE));
  }
  assert.doesNotThrow(() => generateTile(SEED, -MAX_COORDINATE, MAX_COORDINATE - 1));
  for (const bad of [NaN, Infinity, -Infinity, 0.5, MAX_COORDINATE, -MAX_COORDINATE - 1, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => generateTile(SEED, bad, 0), RangeError);
    assert.throws(() => generateTile(SEED, 0, bad), RangeError);
    assert.throws(() => chunkCoords(bad, 0), RangeError);
    assert.throws(() => chunkKey(0, bad), RangeError);
    assert.throws(() => proceduralPlaceName(SEED, bad, 0), RangeError);
  }
  for (const bad of [NaN, Infinity, 0.5, MAX_COORDINATE / CHUNK_SIZE, -MAX_COORDINATE / CHUNK_SIZE - 1]) assert.throws(() => generateChunk(SEED, bad, 0), RangeError);
  for (const seed of [-1, 0.5, NaN, Infinity, 0x1_0000_0000]) assert.throws(() => generateTile(seed, 0, 0), RangeError);
});
