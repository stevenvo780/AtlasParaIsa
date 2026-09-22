import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { decodeSnapshot, encodeSnapshot, takeSnapshotParams } from '../src/server/snapshot.js';
import { assertWorld, createWorld, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { DEFAULT_PARAMS, paramsOf, parseParams, setParams } from '../src/world/params.js';

function restore(body: string): World {
  const world = decodeSnapshot(body) as World;
  setParams(world, takeSnapshotParams(world));
  return world;
}

for (const configuration of ['recursos.velocidadRegeneracion=-0', 'persistencia.ventanaEventosTicks=-0', 'motor.gpu=[-0]']) {
  test(`snapshot preserves signed zero in ${configuration}`, t => {
    const directory = mkdtempSync(join(tmpdir(), 'atlas-snapshot-numbers-')), path = join(directory, 'world.sqlite');
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const world = createWorld(51926, parseParams(configuration));
    let committed: string;
    const first = new Store(path);
    try { first.save(world); committed = digestoCanonico(world); }
    finally { first.close(); }
    const reopened = new Store(path);
    try {
      const loaded = reopened.load()!.world;
      assert.deepEqual(paramsOf(loaded), paramsOf(world));
      assert.equal(digestoCanonico(loaded), committed);
    } finally { reopened.close(); }
  });
}

test('snapshot preserves signed zero in tile, person and community values', () => {
  const world = createWorld(51926), person = world.people[0]!;
  world.tiles.find(t => t.x === 0)!.x = -0;
  person.inventory = -0;
  person.communityId = 'community-1'; world.communityCounter = 1;
  world.communities = [{ id: person.communityId, name: 'Synthetic', x: -0, y: person.y,
    color: '#ffffff', members: [person.id], culture: { ...person.culture }, formedAt: 0, cooperation: 0, disputes: 0 }];
  assertWorld(world);
  const restored = restore(encodeSnapshot(world, paramsOf(world)));
  assertWorld(restored);
  assert.equal(digestoCanonico(restored), digestoCanonico(world));
  assert.ok(Object.is(restored.tiles.find(t => t.x === 0)!.x, -0));
  assert.ok(Object.is(restored.people[0]!.inventory, -0));
  assert.ok(Object.is(restored.communities[0]!.x, -0));
});

test('ordinary compact bytes gain only the explicit limits profile; historical bytes stay compatible', () => {
  for (const params of [DEFAULT_PARAMS, parseParams('agua.cuencas=0.9,motor.gpu=[2,0]')]) {
    const world = createWorld(51926, params);
    const tiles = world.tiles.map(t => [t.x,t.y,t.terrain,t.moisture,t.vegetation,t.food,t.biome,t.elevation,
      t.wood,t.stone,t.feature,t.variety,t.growth,t.fertility,t.cultivation,t.traffic,t.drinkingWater,t.species,t.fauna,t.life]);
    const expected = { ...world, retiredChunks: [], retiredLegacy: [], tiles, tileEncoding: 'tiles-tuple-v1',
      ...(params === DEFAULT_PARAMS ? {} : { paramsEncoding: 'params-v1', params }) };
    assert.ok(encodeSnapshot(world, params) === JSON.stringify({ ...expected, limitsProfile: { version: 1, ...params.limites } }), 'current bytes equal the legacy encoding plus its explicit limits profile');
    assert.equal(digestoCanonico(restore(encodeSnapshot(world, params))), digestoCanonico(world));
    const historical = { ...world, version: 8 };
    assert.ok(encodeSnapshot(historical, params) === JSON.stringify({ ...expected, version: 8 }), 'historical writers preserve ordinary bytes');
  }
});
