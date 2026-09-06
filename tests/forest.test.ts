import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.js';
import { createWorld } from '../src/world/index.js';
import { generateChunk, generateTile } from '../src/world/terrain.js';
import { harvestMaterial, initializeEcosystem, stepEcosystem } from '../src/world/ecosystem.js';
import { initialWood, woodySite } from '../src/world/forest.js';
import type { Tile } from '../src/shared/types.js';

const treeFeatures = new Set(['tree', 'pine', 'palm', 'stump']);
function patch(seed: number, x0: number, y0: number, width = 64): Tile[] {
  return Array.from({length: width * width}, (_, i) => generateTile(seed, x0 + i % width, y0 + Math.floor(i / width)));
}

test('generated forests contain physical gaps and clustered root sites across three seeds and regions', () => {
  let forests = 0, woodland = 0, grass = 0, grassWood = 0, sparse = 0, dense = 0, openSquares = 0;
  for (const seed of [51926, 42, 20260905]) for (const [x0,y0] of [[-16,-16],[-288,-224],[352,192]]) {
    const tiles = patch(seed,x0!,y0!), byKey = new Map(tiles.map(tile => [`${tile.x},${tile.y}`,tile]));
    for (const tile of tiles) {
      assert.ok(Number.isInteger(tile.wood) && tile.wood! >= 0 && tile.wood! <= 12);
      assert.notEqual(tile.feature,'stump','a new clearing has no invented history of cutting');
      if (tile.biome === 'forest') {
        forests++; woodland += Number(tile.wood! > 0);
        if (tile.wood === 0) assert.ok(!treeFeatures.has(tile.feature!), 'the regeneration support is absent in a real clearing');
        if (tile.x > x0! && tile.y > y0! && tile.x < x0! + 63 && tile.y < y0! + 63
          && [-1,0,1].every(dy => [-1,0,1].every(dx => byKey.get(`${tile.x+dx},${tile.y+dy}`)?.wood === 0))) openSquares++;
      }
      if (tile.biome === 'grassland') { grass++; grassWood += Number(tile.wood! > 0); }
    }
    for (let y = y0!; y < y0! + 64; y += 8) for (let x = x0!; x < x0! + 64; x += 8) {
      const square = tiles.filter(tile => tile.x >= x && tile.x < x+8 && tile.y >= y && tile.y < y+8);
      if (!square.every(tile => tile.biome === 'forest')) continue;
      const count = square.filter(tile => tile.wood! > 0).length;
      sparse += Number(count <= 4); dense += Number(count >= 13);
    }
  }
  assert.ok(forests > 10_000 && grass > 10_000, 'both habitats are materially represented in this fixed sample');
  assert.ok(woodland / forests > .10 && woodland / forests <= .26, 'forest keeps trees and substantial open ground');
  assert.ok(grassWood / grass < woodland / forests / 2, 'grassland does not become an equally dense forest');
  assert.ok(sparse > 5 && dense > 5 && openSquares > 100, 'there are broad clearings and denser groves, not just a reduced uniform count');
});

test('global forest sites and generated stock agree across negative, positive and far chunk seams', () => {
  for (const seed of [0,51926,0xffffffff]) for (const [cx,cy] of [[-2,-1],[0,0],[624998,-624999]]) {
    const chunks = [generateChunk(seed,cx!,cy!),generateChunk(seed,cx!+1,cy!)];
    const originals = structuredClone(chunks);
    for (const chunk of chunks.reverse()) for (const tile of chunk.tiles) {
      assert.deepEqual(tile,generateTile(seed,tile.x,tile.y));
      if (tile.biome === 'forest' || tile.biome === 'grassland') assert.equal(tile.wood! > 0,woodySite(seed,tile.x,tile.y,tile.biome));
    }
    for (const chunk of originals) assert.deepEqual(generateChunk(seed,chunk.cx,chunk.cy),chunk);
  }
  assert.notDeepEqual(patch(51926,-32,-32).map(t=>t.wood),patch(42,-32,-32).map(t=>t.wood));
});

test('site allocation preserves local material bounds and cannot refill an explicit saved zero', () => {
  const trees = patch(51926,-16,-16).filter(tile => tile.wood! > 0);
  assert.ok(trees.length > 100);
  for (const original of trees.slice(0,100)) {
    const depleted = { ...original, wood: 0, feature: 'stump' as const, growth: 0, vegetation: 0, food: 0, drinkingWater: 0 };
    assert.deepEqual(initializeEcosystem(51926,depleted),depleted);
    const empty = { ...depleted, feature: 'none' as const };
    assert.deepEqual(initializeEcosystem(51926,empty),empty);
    const unknownFeature: Tile = { ...depleted }; delete unknownFeature.feature;
    assert.equal(initializeEcosystem(51926,unknownFeature).wood,0);
    assert.notEqual(initializeEcosystem(51926,unknownFeature).feature,'stump');
    assert.equal(initialWood(51926,{...original,terrain:'water'}),0);
  }
});

test('a clearing never regrows wood; a physically cut tree pays growth for its conditional recovery', () => {
  const seed = 51926;
  const clearing = patch(seed,-16,-16).find(t => t.biome === 'forest' && t.feature === 'none' && t.wood === 0)!;
  assert.ok(clearing);
  // Matched fertile laboratory conditions, not free resources in an autonomous run.
  const ground: Tile = { ...clearing, moisture: .9, growth: .9, vegetation: .9, fertility: .8, traffic: 0, life: 0, fauna: 0 };
  const cut: Tile = { ...ground, feature: 'tree', wood: 2 };
  assert.equal(harvestMaterial(cut,'wood',2),2); assert.equal(cut.feature,'stump');
  const control = { ...cut, feature: 'none' as const };
  const dry = { ...cut, moisture: .1 }, dark = { ...cut };
  stepEcosystem([cut],100,'clear','day',false); stepEcosystem([control],100,'clear','day',false);
  stepEcosystem([dry],100,'clear','day',false); stepEcosystem([dark],100,'clear','night',false);
  assert.ok(cut.wood! > 0); assert.equal(control.wood,0); assert.equal(dry.wood,0); assert.equal(dark.wood,0);
  assert.ok(Math.abs(control.growth! - cut.growth! - cut.wood! * .05) < 1e-12,'wood recovery debits local growth');
  for (let tick=10;tick<=24_000;tick+=10) stepEcosystem([ground],tick,'rain','day',false);
  assert.equal(ground.wood,0); assert.equal(ground.feature,'none');
  assert.equal(initializeEcosystem(seed,ground).wood,0);
});

test('SQLite reload preserves exhausted root sites and clear ground instead of regenerating the new layout', () => {
  const world=createWorld(51926), store=new Store(':memory:');
  try {
    const tree=world.tiles.find(t=>t.feature==='tree'&&t.wood!>0)!, clear=world.tiles.find(t=>t.biome==='forest'&&t.feature==='none'&&t.wood===0)!;
    harvestMaterial(tree,'wood',tree.wood!); tree.growth=0; tree.vegetation=0;
    const expected=[{...tree},{...clear}]; store.save(world);
    const restored=store.load()!.world;
    for(const tile of expected) assert.deepEqual(restored.tiles.find(t=>t.x===tile.x&&t.y===tile.y),tile);
    assert.equal(tree.wood,0); assert.equal(clear.wood,0);
  } finally {store.close();}
});
