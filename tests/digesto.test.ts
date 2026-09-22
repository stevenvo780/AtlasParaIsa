import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneWorld, createWorld, stepWorld } from '../src/world/index.js';
import { digestoCanonico, diferenciaCanonica } from '../src/world/digesto.js';
import { generateChunk } from '../src/world/terrain.js';
import { encodeSnapshot } from '../src/server/snapshot.js';
import { paramsOf, setParams } from '../src/world/params.js';
import { recordChronicleEvent } from '../src/world/chronicle-journal.js';

test('canonical digest ignores record insertion order, but preserves person slots and laws', () => {
  const a = createWorld(51926), b = cloneWorld(a);
  b.people[0]!.skills = Object.fromEntries(Object.entries(b.people[0]!.skills).reverse());
  b.chunks = Object.fromEntries(Object.entries(b.chunks).reverse());
  assert.equal(digestoCanonico(a), digestoCanonico(b));
  assert.equal(diferenciaCanonica(a, b), null);
  b.people.reverse();
  assert.notEqual(digestoCanonico(a), digestoCanonico(b));
  b.people.reverse();
  b.tiles.reverse(); assert.notEqual(digestoCanonico(a), digestoCanonico(b)); b.tiles.reverse();
  b.places.reverse(); assert.notEqual(digestoCanonico(a), digestoCanonico(b)); b.places.reverse();
  assert.equal(digestoCanonico(a), digestoCanonico(b));
  const params = structuredClone(paramsOf(b)); params.genes.tasaMutacion *= 0.5; setParams(b, params);
  assert.notEqual(digestoCanonico(a), digestoCanonico(b));
});

test('canonical floating-point control preserves signed zero and rejects non-finite values', () => {
  const a = createWorld(), b = cloneWorld(a);
  a.tiles[0]!.food = 0; b.tiles[0]!.food = -0;
  assert.notEqual(digestoCanonico(a), digestoCanonico(b));
  assert.match(diferenciaCanonica(a, b)!.path, /tiles\[0\]\.food$/);
  for (const value of [NaN, Infinity, -Infinity]) {
    b.tiles[0]!.food = value;
    assert.throws(() => digestoCanonico(b), /Non-finite/);
  }
});

test('canonical digest includes dormant chunks that snapshot encoding omits', () => {
  const a = createWorld(51926); a.retiredChunks.push(generateChunk(a.seed, 100, 100));
  const b = cloneWorld(a);
  // Isolate a deliberate change, independent of cloneWorld's copy-on-write contract.
  b.retiredChunks = structuredClone(b.retiredChunks);
  b.retiredChunks[0]!.tiles[0]!.food += 0.01;
  assert.deepEqual(encodeSnapshot(a), encodeSnapshot(b));
  assert.notEqual(digestoCanonico(a), digestoCanonico(b));
  assert.match(diferenciaCanonica(a, b)!.path, /retiredChunks\[0\]\.tiles\[0\]\.food$/);
});

test('canonical difference locates a single cell field without changing the inputs', () => {
  const a = createWorld(51926), b = cloneWorld(a);
  const first = b.tiles[0]!;
  const before = first.food; first.food += 0.01;
  assert.deepEqual(diferenciaCanonica(a, b), { path: '$.world.tiles[0].food', before, after: first.food });
  assert.notEqual(a.tiles[0], b.tiles[0]);
});

test('canonical control repeats 1200 steps of the same seed exactly', () => {
  const a = createWorld(51926), b = createWorld(51926);
  for (let i = 0; i < 1200; i++) { stepWorld(a); stepWorld(b); }
  assert.equal(digestoCanonico(a), digestoCanonico(b));
});

test('pending history outside the visible chronicle still changes the digest', () => {
  const a = createWorld(51926);
  for (let i = 0; i < 3; i++) a.events.push(recordChronicleEvent(a, { kind: 'learning',
    actors: [], source: 'simulation', text: `Witness ${i}`, cause: 'Synthetic chronology control.' }));
  a.events = a.events.slice(-1);
  const b = cloneWorld(a);
  b.chronicleJournal!.pending[0]!.text += ' altered';
  assert.notEqual(digestoCanonico(a), digestoCanonico(b));
  assert.match(diferenciaCanonica(a, b)!.path, /chronicleJournal/);
});
