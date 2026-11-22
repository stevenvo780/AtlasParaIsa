import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorld, cloneWorld, createWorld, tileAt } from '../src/world/index.js';
import { advancePopulation } from '../src/world/lineage.js';
import { DEFAULT_PARAMS, parseParams } from '../src/world/params.js';
import { assertTechnology, rawMaterial, researchTechnology, technologyWorkCost } from '../src/world/technology.js';
import { advanceTechnologyCheckpoint } from '../src/world/technology-checkpoint.js';

function grantCloak(world: ReturnType<typeof createWorld>, person: ReturnType<typeof createWorld>['people'][number]) {
  person.materials.wood = 4;
  person.energy = 1;
  person.fatigue = 0;
  // Craft a woven wood sheet/cloak with real insulation capability through physical laws.
  const program = {
    inputs: [{ source: 'raw' as const, material: 'wood' as const, mass: 1000 }],
    steps: [
      { op: 'form' as const, intensity: 4 as const, shape: 'sheet' as const },
      { op: 'weave' as const, intensity: 4 as const },
      { op: 'weave' as const, intensity: 4 as const },
    ],
  };
  person.technology.project = {
    kind: 'research', program, parents: [], recipeId: null, progress: 0, requiredWork: technologyWorkCost(program), energyPaid: 0, startedAt: world.tick,
  };
  for (let i = 0; i < 60 && person.technology.project; i++) researchTechnology(world, person);
  advanceTechnologyCheckpoint(world.technology, world.people, world.tick);
  assert.ok(person.technology.items.length > 0, 'cloak must be fabricated');
}

test('V16 insulation demography: portable cloak reduces rain exposure damage with real conserved wear and utility', () => {
  const mk = (efectos: boolean) => {
    const world = createWorld(77, parseParams(`tecnologia.efectosHerramientas=${efectos}`, DEFAULT_PARAMS));
    world.weather = 'rain';
    const openTile = world.tiles.find(t => t.terrain !== 'water' && t.terrain !== 'shelter')!;
    const twinA = world.people[2]!;
    const twinB = world.people[3]!;
    for (const p of [twinA, twinB]) {
      p.x = openTile.x; p.y = openTile.y; p.target = { x: openTile.x, y: openTile.y };
      p.hunger = 0.2; p.thirst = 0.2; p.fatigue = 0.1; p.energy = 0.9;
      p.demography.health = 0.8; p.demography.vitality = 0.9;
    }
    twinB.genome = structuredClone(twinA.genome);
    world.tick++;
    for (const p of world.people) p.demography.age = world.tick - p.bornAt;
    grantCloak(world, twinA);
    for (const p of [twinA, twinB]) {
      p.hunger = 0.2; p.thirst = 0.2; p.fatigue = 0.1; p.energy = 0.9;
      p.demography.health = 0.8; p.demography.vitality = 0.9;
    }
    const massBefore = twinA.technology.items[0]!.mass;
    const healthABefore = twinA.demography.health;
    const healthBBefore = twinB.demography.health;
    for (let t = 1; t <= 20; t++) {
      world.tick++;
      for (const p of world.people) p.demography.age = world.tick - p.bornAt - 1;
      advancePopulation(world, { emit: ev => ({ ...ev, id: `e-${world.tick}`, tick: world.tick }) });
      advanceTechnologyCheckpoint(world.technology, world.people, world.tick);
    }
    assert.doesNotThrow(() => assertTechnology(world));
    assert.doesNotThrow(() => assertWorld(world));
    return {
      damageA: healthABefore - twinA.demography.health,
      damageB: healthBBefore - twinB.demography.health,
      wornMass: massBefore - (twinA.technology.items[0]?.mass ?? 0),
      utility: world.technology.recipes[0]?.utility ?? 0,
      tile: tileAt(world, twinA),
    };
  };

  const control = mk(false);
  const active = mk(true);

  assert.equal(control.damageA, control.damageB, 'control (efectosHerramientas=false) grants 0 extra protection');
  assert.equal(control.wornMass, 0, 'control wears 0 cloak mass');
  assert.equal(control.utility, 0, 'control records 0 cloak utility');

  assert.ok(active.damageA < active.damageB, `cloak must reduce rain exposure damage (${active.damageA} < ${active.damageB})`);
  assert.ok(active.wornMass > 0, `cloak must pay real material wear (${active.wornMass})`);
  assert.ok(active.utility > 0, `cloak recipe must accumulate positive observed utility (${active.utility})`);
  assert.ok(cloneWorld(createWorld(77, DEFAULT_PARAMS)).tick === 0 && rawMaterial('wood').mass === 1000);
});
