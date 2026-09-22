import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorld, cloneWorld, createWorld, migrateWorld, RULES_VERSION, stepWorld } from '../src/world/index.js';
import { parseParams, paramsOf } from '../src/world/params.js';

for (const previousVersion of [6, 7, 8, 9]) test(`V10 is explicit and reading valid V${previousVersion} preserves its history, stocks, traits and parameters`, () => {
  const world = createWorld(7, parseParams('agua.cuencas=0.8'));
  for (let n = 0; n < 60; n++) stepWorld(world);
  world.version = previousVersion;
  // Old founder expressions are historical state, not retroactively corrected.
  world.people[2]!.traits.curiosity = 0.01;
  const before = cloneWorld(world), migrated = migrateWorld(world);
  assert.equal(RULES_VERSION, 10);
  assert.equal(createWorld().version, 10);
  assert.equal(migrated.version, 10);
  assert.deepEqual(migrated, { ...before, version: 10 });
  assert.deepEqual(world, before);
  assert.deepEqual(paramsOf(migrated), paramsOf(world));
  assertWorld(migrated);
});

for (const previousVersion of [6, 7, 8, 9]) test(`a V${previousVersion} label cannot launder corrupt physical state through the V10 reader`, () => {
  const world = createWorld(); world.version = previousVersion;
  world.people[2]!.materials.wood = -1;
  const before = structuredClone(world);
  assert.throws(() => migrateWorld(world));
  assert.deepEqual(world, before);
  const future = createWorld(); future.version = RULES_VERSION + 1;
  assert.throws(() => migrateWorld(future));
});
