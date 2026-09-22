import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorld } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { validationFixture } from '../scripts/lib/validation-fixture.js';

test('indexed live references preserve the world and reject orphan bonds and duplicate IDs', () => {
  const world = validationFixture(200), before = digestoCanonico(world);
  assertWorld(world);
  assert.equal(digestoCanonico(world), before);
  world.people[0]!.bonds['absent-person'] = 0.5;
  assert.throws(() => assertWorld(world));
  delete world.people[0]!.bonds['absent-person'];
  world.people.at(-1)!.id = world.people[0]!.id;
  assert.throws(() => assertWorld(world));
});
