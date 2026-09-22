import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, migrateWorld, assertWorld, type World } from '../src/world/index.js';
import { initializeEcosystem } from '../src/world/ecosystem.js';
import { parseParams, paramsOf, setParams } from '../src/world/params.js';

function legacyFixture() {
  const source = createWorld(42), legacy = structuredClone(source) as unknown as Record<string, unknown>;
  for (const field of ['chronicleJournal', 'chunks', 'retiredChunks', 'discoveredChunks', 'settlementCount',
    'adaptationEnabled', 'noveltyEnabled', 'shelterBenefitEnabled', 'cooperationEnabled', 'reproductionEnabled',
    'communities', 'communityCounter', 'birthCounter', 'history', 'totals', 'animals', 'animalCounter', 'animalDynamics',
    'blueprints', 'structures', 'blueprintCounter', 'structureCounter', 'inventionDynamics']) delete legacy[field];
  legacy.version = 1; legacy.tick = 37;
  legacy.tiles = source.tiles.filter(t => t.x >= 0 && t.x < 40 && t.y >= 0 && t.y < 28)
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map(({ x, y, terrain, moisture, vegetation, food }) => ({ x, y, terrain, moisture, vegetation, food }));
  legacy.places = source.places.filter(p => ['claro', 'refugio', 'huerta'].includes(p.id));
  for (const person of legacy.people as Record<string, unknown>[]) {
    for (const field of ['traits', 'skills', 'materials', 'activity', 'values', 'visited', 'heading', 'command',
      'work', 'lastOutcome', 'controlMode', 'specialty', 'thirst', 'genome', 'bornAt', 'lastBirth', 'lastSocial',
      'lastDispute', 'lastPracticeMemory', 'culture', 'communityId', 'bonds', 'intentContext']) delete person[field];
  }
  return legacy;
}

for (const cuencas of [0.05, 1]) {
  test(`V1 migration applies cuencas=${cuencas} before generating ecosystem fields`, () => {
    const legacy = legacyFixture(), params = parseParams({ 'agua.cuencas': cuencas });
    const before = structuredClone(legacy);
    setParams(legacy, params);
    const migrated = migrateWorld(legacy);
    assert.deepEqual(legacy, before, 'migration does not mutate the original');
    assert.equal(paramsOf(migrated), params, 'the clone retains the declared laws');
    for (const tile of legacy.tiles as World['tiles']) {
      const actual = migrated.tiles.find(t => t.x === tile.x && t.y === tile.y)!;
      const expected = initializeEcosystem(migrated.seed, tile, cuencas);
      assert.equal(actual.drinkingWater, expected.drinkingWater, `water at ${tile.x},${tile.y}`);
      for (const [field, value] of Object.entries(tile)) assert.equal(actual[field as keyof typeof actual], value);
    }
    assertWorld(migrated);
  });
}

test('larger typed limits do not relax the fixed V1 rectangle', () => {
  const legacy = legacyFixture();
  (legacy.tiles as World['tiles']).push({ ...(legacy.tiles as World['tiles'])[0]!, x: 40 });
  setParams(legacy, parseParams({ 'limites.teselasActivas': 1_000_000 }));
  assert.throws(() => migrateWorld(legacy), /Estado del mundo inválido/);
});
