import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world/index.js';
import { paramsOf } from '../src/world/params.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { sha256 } from './lib/store.js';

/** Previous 3dd615e byte contract, retained as an independent small-state oracle. */
function previousCanonical(value: unknown): unknown {
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(previousCanonical);
  return Object.fromEntries(Object.entries(value as object).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, previousCanonical(v)]));
}
function previousJson(value: unknown): string {
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : JSON.stringify(value);
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(previousJson).join(',')}]`;
  return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}:${previousJson(v)}`).join(',')}}`;
}

for (const seed of [1, 51926, 0xffffffff]) test(`streamed digest preserves prior bytes for seed ${seed}`, () => {
  const world = createWorld(seed);
  world.tiles[0]!.food = -0;
  // Instrument-only probe: key enumeration and Unicode, not a valid physical state.
  Object.assign(world, { digestProbe: { '10': 1, '2': 2, '0': 3, '01': 4, '-0': 5,
    '4294967294': 6, '4294967295': 7, missing: undefined, null: null,
    unicode: 'á🙂\ud800\n"', array: [null, false, -0, 1e-30, 'ñ🌱', { nested: true }] } });
  const bytes = previousJson(previousCanonical({ world, params: paramsOf(world) }));
  assert.ok(bytes.length > 64 * 1024, 'control crosses buffered emission boundaries');
  const before = structuredClone(world);
  assert.equal(digestoCanonico(world), sha256(bytes));
  assert.deepEqual(world, before);
});

test('streamed digest rejects unsupported array entries and non-finite nested values', () => {
  for (const value of [undefined, () => {}, Symbol('invalid'), 1n, NaN, Infinity]) {
    const world = createWorld(1); Object.assign(world, { digestProbe: [value] });
    assert.throws(() => digestoCanonico(world), /canonical world value/);
  }
});
