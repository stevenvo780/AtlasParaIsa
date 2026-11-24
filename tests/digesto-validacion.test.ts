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
