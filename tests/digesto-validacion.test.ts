import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';

test('streamed digest rejects unsupported array entries and non-finite nested values', () => {
  for (const value of [undefined, () => {}, Symbol('invalid'), 1n, NaN, Infinity]) {
    const world = createWorld(1); Object.assign(world, { digestProbe: [value] });
    assert.throws(() => digestoCanonico(world), /canonical world value/);
  }
});

test('streamed digest reads each long-array slot once and ignores its toJSON', () => {
  const world = Object.assign(createWorld(1), { digestProbe: [] as unknown[] });
  const values = Array.from({ length: 128 }, (_, index) => index + 0.125);
  const live = Object.assign([...values], { toJSON: () => assert.fail('source toJSON') });
  let reads = 0;
  Object.defineProperty(live, 80, { get: () => ++reads === 1 ? -0 : NaN });
  world.digestProbe = live;
  const before = digestoCanonico(world);
  assert.equal(reads, 1);
  values[80] = -0;
  world.digestProbe = values;
  assert.equal(digestoCanonico(world), before);
  values[80] = 0;
  assert.notEqual(digestoCanonico(world), before);
});

test('streamed digest retains holes and inherited array entries', () => {
  const holes: unknown[] = Array.from({ length: 70 }, (_, index) => index);
  delete holes[0];
  holes[1] = -0;
  delete holes[2];
  const world = Object.assign(createWorld(1), { digestProbe: holes });
  const before = digestoCanonico(world);
  world.digestProbe = [null, -0, null, ...holes.slice(3)];
  const filled = digestoCanonico(world);
  assert.notEqual(filled, before);
  world.digestProbe = Object.setPrototypeOf(holes, Object.assign(Object.create(Array.prototype), { 0: null, 2: null }));
  assert.equal(digestoCanonico(world), filled);
});
