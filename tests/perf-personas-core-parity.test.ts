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
import { bindTechnologyCatalogue, enableTechnologyCatalogue, resolveTechnologyRecipe, updateTechnologyRecipeStats, withRecipeSession } from '../src/world/technology-catalogue.js';
import { captureTechnologyCheckpoint } from '../src/world/technology-checkpoint.js';
import { pruneTechnologyCompetence } from '../src/world/technology-memory.js';
import { localForageSupport } from '../src/world/natalidad-local.js';
import { ResidentTopologyOwner } from '../src/world/soa/topologia.js';
import { TileStore } from '../src/world/soa/terreno.js';

const openLaws = 'poblacion.natalidadVecindad=true,poblacion.radioVecindadNatalidad=16,social.radioConvivencia=12,social.disolucion=1,social.maxComunidades=0,conducta.aptitud=0.35,conducta.politicaPeso=0.35,tecnologia.evitarNoOp=true,tecnologia.dosisCuanto=50,tecnologia.enfriamiento=240';

function perfWorld(seed: number, open = true) {
  const world = createWorld(seed, parseParams(open ? openLaws : ''));
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


// Captured from 847c2b1, before the personas core changes.
const references = [
  {
    "open": false,
    "seed": 2002,
    "digests": [
      "bc96987d3c73a0330fafa90c6cbd9f459ace55610671cea5f3b31543e7585c31",
      "483e375ba2b37a454cf5d8f3038552f81372c6a865f4c016dd90c82d59c4b4c7",
      "ed18dc0560acd932493ae2f6f5a10ce3cd25a85bc18dc879397b776ac38cf93b"
    ]
  },
  {
    "open": false,
    "seed": 42,
    "digests": [
      "58c4fd53092c3dc3710252aece17d224cd1a4f9f2872379273309f5af9fa8b8c",
      "5fad52cc9eca0ecb0cd4b6161788378692b202747e949340f4bd0a45f9121630",
      "384e2799016374959722279acdc77458a4da8d2d6192856ead5cde29ecf3570e"
    ]
  },
  {
    "open": false,
    "seed": 51926,
    "digests": [
      "b65eac2607075d63021e0681cb49041e5d11cca19d861041569b1825e76a49bb",
      "e491cfb34e9f34c0e5426c7a7f6791fff97bffd86e7b11ee54b8a5708111bee2",
      "4e69c41e983dfb7e7d1321e4fab830491bd762f75a3daff09306c36196f451ae"
    ]
  },
  {
    "open": true,
    "seed": 2002,
    "digests": [
      "afd85940347c567f7d25fd0db7268cc4db4dc8c9f575472a643f1ca876a77d84",
      "555a852f20d1c51b7218483893330745bb1b1bfe9d0ff6b166861432421aa51e",
      "4f5278d05fd4c07cb5e27793271e194c78dadefd305aff2d083b30425dd5ccfe"
    ]
  },
  {
    "open": true,
    "seed": 42,
    "digests": [
      "3c5cad8ca59030a260e0def8e8f4cd9583672b451f62348126a87e64ea8dd469",
      "741c3156448104e07b51f3a61eaa854ded81c6ae2fd3652ad9aade4d15dee2e7",
      "143b1fdb973eccde805a54b66b6d935974de65dd166a6ae59c0d265505bdbb13"
    ]
  },
  {
    "open": true,
    "seed": 51926,
    "digests": [
      "705b31dd45bfb35713bd38f1d9d0d129e9972ae9c5e819e7ce4bb874ffec6d91",
      "400c64b9c918aea2214ff41fd0ee14db1959b2bc7746c46f537db4098369bcf7",
      "eb3b0ef927482ca8ee3c05062edfedf806d5782606470db71dd1c8937427c7b3"
    ]
  }
] as const;

for (const { open, seed, digests } of references) {
  test(`personas core: ${open ? 'V12 open-world' : 'V11 defaults'}, seed=${seed}, P400/256 recipes, 600 ticks`, () => {
    assert.equal(RULES_VERSION, 13);
    const world = perfWorld(seed, open);
    for (const [index, until] of [60, 300, 600].entries()) {
      while (world.tick < until) stepWorld(world);
      assert.equal(digestoCanonico(world), digests[index], `tick=${until}`);
    }
    assertWorld(world);
  });
}

test('recipe sessions preserve retained windows, nested touches, mutator flushes and exception cleanup', () => {
  const world = perfWorld(42), state = world.technology;
  state.budgets.maxRecipes = 3;
  state.recipes = state.recipes.slice(0, 3);
  const original = state.recipes, ids = () => state.recipes.map(recipe => recipe.id);
  withRecipeSession(world, () => {
    resolveTechnologyRecipe(world, 'recipe-1');
    withRecipeSession(world, () => resolveTechnologyRecipe(world, 'recipe-2'));
    assert.equal(state.recipes, original);
  });
  assert.deepEqual(ids(), ['recipe-3', 'recipe-1', 'recipe-2']);
  assert.deepEqual(original.map(recipe => recipe.id), ['recipe-1', 'recipe-2', 'recipe-3']);
  state.recipes = original;
  withRecipeSession(world, () => {
    resolveTechnologyRecipe(world, 'recipe-4');
    updateTechnologyRecipeStats(world, 'recipe-1', { uses: 1 });
    assert.deepEqual(ids(), ['recipe-3', 'recipe-4', 'recipe-1']);
    resolveTechnologyRecipe(world, 'recipe-2');
  });
  assert.deepEqual(ids(), ['recipe-4', 'recipe-1', 'recipe-2']);
  assert.equal(resolveTechnologyRecipe(world, 'recipe-1', { cache: false })!.uses, 1);
  const before = state.recipes;
  withRecipeSession(world, () => resolveTechnologyRecipe(world, 'recipe-3', { cache: false }));
  assert.equal(state.recipes, before);
  assert.throws(() => withRecipeSession(world, () => {
    resolveTechnologyRecipe(world, 'recipe-3');
    throw new Error('evaluation failed');
  }), /evaluation failed/);
  assert.deepEqual(ids(), ['recipe-1', 'recipe-2', 'recipe-3']);
  assert.deepEqual(original.map(recipe => recipe.id), ['recipe-1', 'recipe-2', 'recipe-3']);
});

test('memory indexes detect same-array edits and validate before deleting unsupported practice', () => {
  const world = perfWorld(42), knowledge = world.people[0]!.technology;
  const practice = { attempts: 1, successes: 1, work: 1, benefit: 0 };
  knowledge.competence['recipe-256'] = { ...practice };
  pruneTechnologyCompetence(knowledge);
  assert.equal(knowledge.competence['recipe-256'], undefined);
  const ids = knowledge.knownRecipes;
  ids[0] = ids[1]!;
  knowledge.competence['recipe-256'] = { ...practice };
  assert.throws(() => pruneTechnologyCompetence(knowledge), /Invalid recipe memory input/);
  assert.deepEqual(knowledge.competence['recipe-256'], practice);
  ids[0] = 'recipe-256';
  pruneTechnologyCompetence(knowledge);
  assert.deepEqual(knowledge.competence['recipe-256'], practice);
  delete ids[0];
  assert.throws(() => pruneTechnologyCompetence(knowledge), /Invalid recipe memory input/);
});

test('local forage reads resident terrain exactly and falls back after descriptor changes', () => {
  const world = createWorld(42, parseParams('motor.soaTerreno=true,motor.hilos=1'));
  const owner = new ResidentTopologyOwner(), store = new TileStore();
  world.tiles = owner.tiles(world.tiles.map(tile => owner.tile(tile)));
  const center = { x: -0.4, y: -0.4 };
  const oracle = () => {
    let sum = 0, landTiles = 0;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const tile = tileAt(world, { x: Math.round(center.x) + dx, y: Math.round(center.y) + dy });
      if (!tile || tile.terrain === 'water') continue;
      landTiles++; sum += Number.isFinite(tile.food) ? tile.food : 0;
    }
    return { meanFood: landTiles ? sum / landTiles : 0, landTiles };
  };
  store.prepareParallel(world.tiles, 256);
  try {
    assert.deepEqual(localForageSupport(world, center), oracle());
    const tile = tileAt(world, { x: 0, y: 0 })!;
    tile.terrain = 'meadow'; tile.food = 0.75;
    assert.deepEqual(localForageSupport(world, center), oracle());
    delete (tile as unknown as Record<string, unknown>).food;
    assert.deepEqual(localForageSupport(world, center), oracle());
  } finally { store.releaseParallelObjects(); }
});
