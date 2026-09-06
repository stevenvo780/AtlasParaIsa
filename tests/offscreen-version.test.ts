import test from 'node:test';
import assert from 'node:assert/strict';
import { Connection } from '../src/client/connection.js';
import { PROTOCOL_VERSION, type WorldView } from '../src/shared/types.js';
import { assertWorld, createWorld, migrateWorld, projectWorld, RULES_VERSION, stepWorld } from '../src/world/index.js';
import { enableContinuousEcology } from '../src/world/offscreen-state.js';

test('V6 migration preserves ecological and liquid stocks without inventing a past climate or dormant work', () => {
  const old = createWorld(42); old.version = 6;
  for (let n = 0; n < 12; n++) stepWorld(old);
  const before = structuredClone(old), migrated = migrateWorld(old);
  assert.equal(RULES_VERSION, 7); assert.equal(PROTOCOL_VERSION, 7); assert.equal(migrated.version, 7);
  assert.equal(migrated.ecology, undefined);
  assert.deepEqual({ ...migrated, version: 6 }, before); assert.deepEqual(old, before);
  assert.throws(() => enableContinuousEcology(migrated), /new world at tick zero/);
  assertWorld(migrated);
});

test('a snapshot from an older rule cannot hide continuous ecology fields, including an undefined field', () => {
  const original = createWorld(42); enableContinuousEcology(original);
  for (const ecology of [original.ecology, null, undefined, { version: 2 }]) {
    const old = { ...structuredClone(original), version: 6, ecology };
    assert.throws(() => migrateWorld(old), /incompatible/);
    assert.throws(() => assertWorld(old, 6), /incompatible/);
  }
});

test('the client accepts two V7 ecological revisions at the same physical tick and rejects incompatible protocol', () => {
  const received: WorldView[] = [], errors: string[] = [];
  const connection = new Connection({ world: world => received.push(world), error: error => errors.push(error),
    result: () => {}, status: () => {}, expired: () => {}, pending: () => {} });
  const accept = (connection as unknown as { accept(world: WorldView, reconnectSnapshot?: boolean): void }).accept.bind(connection);
  const view = projectWorld(createWorld(42)); view.sequence = 10;
  accept(view); accept({ ...view, sequence: 11 }); accept({ ...view, sequence: 10 });
  assert.deepEqual(received.map(world => [world.sequence, world.tick]), [[10, 0], [11, 0]]);
  accept({ ...view, version: 6, sequence: 12 });
  assert.equal(errors.length, 1); assert.equal(received.length, 2); connection.stop();
});
