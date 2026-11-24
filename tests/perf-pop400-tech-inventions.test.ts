import test from 'node:test';
import assert from 'node:assert/strict';
import type { StructureComponent } from '../src/shared/life.js';
import type { TechnologyProgram } from '../src/shared/technology.js';
import { assertWorld, createWorld, RULES_VERSION, stepWorld } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { parseParams } from '../src/world/params.js';
import { maintainRegions, tileAt } from '../src/world/spatial.js';
import { blueprintAffordances, blueprintCost, defaultBlueprint, validBlueprint } from '../src/world/inventions.js';
import { applyPhysicalOperation, materialCapacities, programSignature, rawMaterial } from '../src/world/technology.js';
import { bindTechnologyCatalogue, enableTechnologyCatalogue } from '../src/world/technology-catalogue.js';
import { captureTechnologyCheckpoint } from '../src/world/technology-checkpoint.js';

const openLaws = 'poblacion.natalidadVecindad=true,poblacion.radioVecindadNatalidad=16,social.radioConvivencia=12,social.disolucion=1,social.maxComunidades=0,conducta.aptitud=0.35,conducta.politicaPeso=0.35,tecnologia.evitarNoOp=true,tecnologia.dosisCuanto=50,tecnologia.enfriamiento=240';

function perfWorld(seed: number) {
  const world = createWorld(seed, parseParams(openLaws));
  const founders = world.people;
  world.people = Array.from({ length: 400 }, (_, i) => {
    const person = structuredClone(founders[i < 2 ? i : 2 + (i - 2) % (founders.length - 2)]!);
    person.id = i === 0 ? 's' : i === 1 ? 'i' : `perf-${i}`;
    if (i > 1) person.name = `P${i}`;
    person.x = 8 + i % 20 * 2; person.y = 4 + Math.floor(i / 20) * 2;
    person.target = { x: person.x, y: person.y };
    person.materials = { wood: 3 + i % 10, stone: 2 + i % 7 };
    person.skills = { build: 0.3, technology: 0.2 };
    person.bonds = {}; person.communityId = null;
    return person;
  });
  maintainRegions(world);
  world.structures = []; world.structureCounter = 0;
  for (const person of world.people) {
    const tile = tileAt(world, person)!;
    if (tile.terrain === 'water') tile.terrain = 'meadow';
  }
  for (let frames = 1; frames <= 2; frames++) for (let roofs = 1; roofs <= frames; roofs++)
    for (let cistern = 0; cistern <= 2; cistern++) for (let granary = 0; granary <= 2; granary++)
      for (let garden = 0; garden <= 2; garden++) for (let hearth = 0; hearth <= 1; hearth++) {
        const components = (['frame', 'roof', 'cistern', 'granary', 'garden', 'hearth'] as StructureComponent[])
          .flatMap((component, index) => Array<StructureComponent>([frames, roofs, cistern, granary, garden, hearth][index]!).fill(component));
        if (components.length === 2 || !validBlueprint(components)) continue;
        world.blueprints.push({ ...defaultBlueprint(), id: `blueprint-${++world.blueprintCounter}`,
          components, cost: blueprintCost(components), generation: 1, parents: ['blueprint-base'],
          inventorId: world.people[2]!.id, usefulness: world.blueprintCounter % 7 / 10 });
      }
  for (let i = 0; i < 40; i++) {
    const blueprint = world.blueprints[1 + i % (world.blueprints.length - 1)]!;
    const x = 8 + i % 8 * 5, y = 4 + Math.floor(i / 8) * 8;
    tileAt(world, { x, y })!.terrain = 'shelter';
    const capacities = blueprintAffordances(blueprint.components);
    world.structures.push({ id: `structure-${++world.structureCounter}`, x, y, blueprintId: blueprint.id,
      name: blueprint.name, components: [...blueprint.components], condition: 0.3 + i % 7 / 10,
      water: capacities.waterCapacity * 0.3, food: capacities.foodCapacity * 0.2, uses: 0, builtAt: 0, builderId: world.people[i]!.id });
  }
  for (let a = 1; a <= 4; a++) for (let b = 1; b <= 4; b++) for (let c = 1; c <= 4; c++) for (let d = 1; d <= 4; d++) {
    const program: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }], steps: [
      { op: 'form', shape: 'edge', intensity: a }, { op: 'abrade', intensity: b },
      { op: 'compress', intensity: c }, { op: 'cool', intensity: d },
    ] };
    let item = rawMaterial('stone');
    for (const step of program.steps) item = applyPhysicalOperation(step, [item]).product!;
    world.technology.recipes.push({ id: `recipe-${++world.technology.recipeCounter}`, name: 'Filo sintético',
      program, signature: programSignature(program), generation: 1, parents: [], inventorId: world.people[0]!.id,
      tick: 0, x: 8, y: 4, capacities: materialCapacities(item), novelty: 'program', uses: 0, utility: 0, manufactured: 0 });
  }
  enableTechnologyCatalogue(world.technology);
  bindTechnologyCatalogue(world.technology, { resolve: () => null, findBySignature: () => null });
  for (let i = 0; i < world.people.length; i++) {
    const person = world.people[i]!;
    person.blueprintId = world.blueprints[i % world.blueprints.length]!.id;
    person.technology.knownRecipes = Array.from({ length: 32 }, (_, j) => `recipe-${1 + (i * 7 + j) % 256}`);
  }
  world.technology.checkpoint = captureTechnologyCheckpoint(world.technology, world.people, world.tick, 'initial');
  assertWorld(world);
  return world;
}

// Reference digests are captured from 819fc31 before changing the hot paths.
test('V12 open-world P400: exact reference digests after 600 ticks', () => {
  assert.equal(RULES_VERSION, 14);
  const references = [
    { seed: 2002, digests: [
      'afd85940347c567f7d25fd0db7268cc4db4dc8c9f575472a643f1ca876a77d84',
      '555a852f20d1c51b7218483893330745bb1b1bfe9d0ff6b166861432421aa51e',
      '4f5278d05fd4c07cb5e27793271e194c78dadefd305aff2d083b30425dd5ccfe',
    ] },
    { seed: 42, digests: [
      '3c5cad8ca59030a260e0def8e8f4cd9583672b451f62348126a87e64ea8dd469',
      '741c3156448104e07b51f3a61eaa854ded81c6ae2fd3652ad9aade4d15dee2e7',
      '143b1fdb973eccde805a54b66b6d935974de65dd166a6ae59c0d265505bdbb13',
    ] },
    { seed: 51926, digests: [
      '705b31dd45bfb35713bd38f1d9d0d129e9972ae9c5e819e7ce4bb874ffec6d91',
      '400c64b9c918aea2214ff41fd0ee14db1959b2bc7746c46f537db4098369bcf7',
      'eb3b0ef927482ca8ee3c05062edfedf806d5782606470db71dd1c8937427c7b3',
    ] },
  ];
  for (const { seed, digests } of references) {
    const world = perfWorld(seed);
    assert.equal(world.people.length, 400);
    assert.equal(world.structures.length, 40);
    assert.equal(world.technology.recipes.length, 256);
    for (let i = 0; i < 3; i++) {
      const until = [60, 300, 600][i]!;
      while (world.tick < until) stepWorld(world);
      assert.equal(digestoCanonico(world), digests[i], `seed=${seed}, tick=${until}`);
    }
    assertWorld(world);
  }
});
