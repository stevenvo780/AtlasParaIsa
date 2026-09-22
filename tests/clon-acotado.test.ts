import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneWorld, createWorld, stepWorld } from '../src/world/index.js';
import { activate, maintainRegions, bindWorldContext, worldContext } from '../src/world/spatial.js';
import { paramsOf, setParams } from '../src/world/params.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { generateChunk } from '../src/world/terrain.js';

test('reactivating a shared dormant chunk cannot mutate the confirmed world or its archive', () => {
  const original = createWorld(51926);
  for (const person of original.people) { person.x = 400; person.y = 400; }
  maintainRegions(original);
  const chunk = original.retiredChunks.find(c => c.places.length > 0 && (c.animals?.length ?? 0) > 0)!;
  assert.ok(chunk, 'fixture must include nested places and animals');
  const before = digestoCanonico(original), draft = cloneWorld(original);
  assert.notEqual(draft.retiredChunks, original.retiredChunks);
  assert.equal(draft.retiredChunks.find(c => c.key === chunk.key), chunk);
  activate(draft, chunk.cx * 16, chunk.cy * 16);
  const place = draft.places.find(p => p.id === chunk.places[0]!.id)!;
  place.gatherings++;
  const animal = draft.animals.find(a => a.id === chunk.animals![0]!.id)!;
  animal.memory.push({ x: animal.x, y: animal.y, food: 0, water: 0.2, visited: true, tick: draft.tick });
  animal.health = 0.25;
  assert.equal(digestoCanonico(original), before);
  assert.notEqual(digestoCanonico(draft), before);
});

test('reactivation also isolates objects returned by a caching archive reader', () => {
  const original = createWorld(7), chunk = generateChunk(original.seed, 30, 30);
  const before = structuredClone(chunk);
  const draft = cloneWorld(original, { loadChunk: () => chunk });
  activate(draft, 480, 480);
  draft.tiles.find(tile => tile.x === chunk.tiles[0]!.x && tile.y === chunk.tiles[0]!.y)!.food = 0;
  draft.chunks[chunk.key]!.lastTick++;
  assert.deepEqual(chunk, before);
});

test('shared dormant chunks preserve the full-copy trajectory over three seeds', () => {
  for (const seed of [1, 7, 51926]) {
    const original = createWorld(seed);
    original.retiredChunks.push(generateChunk(seed, 30, 30));
    const copied = structuredClone(original);
    bindWorldContext(copied, worldContext(original)); setParams(copied, paramsOf(original));
    const shared = cloneWorld(original);
    for (let tick = 0; tick < 120; tick++) {
      if (tick === 0 || tick === 60) for (const world of [copied, shared]) {
        const x = tick === 0 ? 480 : 17;
        for (const person of world.people) { person.x = x; person.y = x; person.target = { x, y: x }; }
      }
      stepWorld(copied); stepWorld(shared);
      assert.equal(digestoCanonico(shared), digestoCanonico(copied));
    }
    assert.equal(digestoCanonico(shared), digestoCanonico(copied));
  }
});
