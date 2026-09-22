import assert from 'node:assert/strict';
import test from 'node:test';
import type { LegacyRecord } from '../src/shared/demography.js';
import { createWorld, type World } from '../src/world/index.js';
import { demographicTraits } from '../src/world/demography.js';
import { assertLegacyRecord, assertPopulation, retainLegacy } from '../src/world/lineage.js';

function fixture(): World {
  const world = createWorld(42), founder = world.people.find(person => person.role === 'neighbor')!;
  const record: LegacyRecord = {
    id: 'numeric-lineage-fixture', name: 'Identidad sintética', role: 'neighbor', generation: 0, parents: [],
    bornAt: founder.bornAt, diedAt: world.tick, cause: 'exposure', genome: structuredClone(founder.genome),
    traits: demographicTraits(founder.genome), communityId: null,
  };
  world.legacy = [record];
  world.retiredLegacy = [structuredClone(record)];
  world.demographyDynamics.deaths = 1;
  world.demographyDynamics.causes.exposure = 1;
  assertLegacyRecord(record, world.tick);
  assertPopulation(world);
  return world;
}

for (const validate of [retainLegacy, assertPopulation]) {
  test(`${validate.name}: rechaza -0 frente a +0 para el mismo ID en caché y pendiente`, () => {
    const world = fixture();
    world.legacy[0]!.generation = -0;
    assert.equal(Object.is(world.legacy[0]!.generation, -0), true);
    assert.equal(Object.is(world.retiredLegacy[0]!.generation, 0), true);
    // Ambas entradas son válidas individualmente; sólo difiere el bit de signo.
    assertLegacyRecord(world.legacy[0], world.tick);
    assertLegacyRecord(world.retiredLegacy[0], world.tick);
    const beforeCache = structuredClone(world.legacy), beforePending = structuredClone(world.retiredLegacy);
    assert.throws(() => validate(world), /Registro de identidad o población inválido/,
      'no debe equiparar dos versiones distintas de la misma identidad');
    assert.deepEqual(world.legacy, beforeCache);
    assert.deepEqual(world.retiredLegacy, beforePending);
  });
}

test('identidades ordinarias iguales conservan equivalencia aunque se reordenen propiedades', () => {
  for (const reorder of [false, true]) {
    const world = fixture(), original = structuredClone(world.legacy[0]!);
    if (reorder) {
      const pending = world.retiredLegacy[0]!;
      pending.genome = Object.fromEntries(Object.entries(pending.genome).reverse()) as unknown as LegacyRecord['genome'];
      pending.traits = Object.fromEntries(Object.entries(pending.traits).reverse()) as unknown as LegacyRecord['traits'];
      world.retiredLegacy[0] = Object.fromEntries(Object.entries(pending).reverse()) as unknown as LegacyRecord;
      assert.notEqual(JSON.stringify(world.retiredLegacy[0]), JSON.stringify(original), 'el control cambia realmente el orden de propiedades');
      assertLegacyRecord(world.retiredLegacy[0], world.tick);
    }
    const queue = world.retiredLegacy;
    assert.doesNotThrow(() => assertPopulation(world));
    assert.doesNotThrow(() => retainLegacy(world));
    assert.deepEqual(world.legacy, [original]);
    assert.equal(world.retiredLegacy, queue, 'retener el caché conserva la cola pendiente');
    assert.deepEqual(world.retiredLegacy, [original]);
  }
});
