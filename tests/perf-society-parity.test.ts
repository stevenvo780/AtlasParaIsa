import test from 'node:test';
import assert from 'node:assert/strict';
import type { TechnologyProgram, TechnologyRecipe } from '../src/shared/technology.js';
import { assertWorld, createWorld, stepWorld, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { parseParams } from '../src/world/params.js';
import { maintainRegions, tileAt } from '../src/world/spatial.js';
import { applyPhysicalOperation, materialCapacities, programSignature, rawMaterial } from '../src/world/technology.js';
import { bindTechnologyCatalogue, enableTechnologyCatalogue } from '../src/world/technology-catalogue.js';
import { captureTechnologyCheckpoint } from '../src/world/technology-checkpoint.js';

// Paridad del reescrito de `society.ts` (enseñanza de recetas) y `demography.ts`: digestos tomados en
// 49c3c1c, antes del cambio. El digesto incluye el orden de `technology.recipes`, así que también fija
// la ventana LRU que tocan las resoluciones de `practicedRecipeToTeach`.
const openLaws = 'poblacion.natalidadVecindad=true,poblacion.radioVecindadNatalidad=16,social.radioConvivencia=12,social.disolucion=1,social.maxComunidades=0,conducta.aptitud=0.35,conducta.politicaPeso=0.35,tecnologia.evitarNoOp=true,tecnologia.dosisCuanto=50,tecnologia.enfriamiento=240';
const rareLaws = `${openLaws},social.ensenanzaRareza=0.5`;

function recipe(world: World, program: TechnologyProgram, capacities: TechnologyRecipe['capacities'], parents: string[]): void {
  world.technology.recipes.push({ id: `recipe-${++world.technology.recipeCounter}`, name: 'Prueba', program, signature: programSignature(program),
    generation: parents.length + 1, parents, inventorId: world.people[0]!.id, tick: 0, x: 8, y: 4, capacities,
    novelty: 'program', uses: 0, utility: 0, manufactured: 0 });
}

/** 400 habitantes a dos celdas, 224 recetas de piedra y 32 que piden el producto de otra: una receta
 * recordada puede desbloquear la enseñanza de su intermedio, y con rareza hay varias viables que ordenar. */
function teachingWorld(seed: number): World {
  const world = createWorld(seed, parseParams(rareLaws)), founders = world.people;
  world.people = Array.from({ length: 400 }, (_, i) => {
    const person = structuredClone(founders[i < 2 ? i : 2 + (i - 2) % (founders.length - 2)]!);
    person.id = i === 0 ? 's' : i === 1 ? 'i' : `perf-${i}`;
    if (i > 1) person.name = `P${i}`;
    person.x = 8 + i % 20 * 2; person.y = 4 + Math.floor(i / 20) * 2; person.target = { x: person.x, y: person.y };
    person.materials = { wood: 3 + i % 10, stone: 2 + i % 7 };
    person.bonds = {}; person.communityId = null;
    return person;
  });
  maintainRegions(world);
  for (const person of world.people) { const tile = tileAt(world, person)!; if (tile.terrain === 'water') tile.terrain = 'meadow'; }
  for (let n = 0; n < 224; n++) {
    const steps: TechnologyProgram['steps'] = [{ op: 'form', shape: 'edge', intensity: 1 + n % 4 }, { op: 'abrade', intensity: 1 + (n >> 2) % 4 },
      { op: n % 3 ? 'compress' : 'heat', intensity: 1 + (n >> 4) % 4 }, { op: 'cool', intensity: 1 + (n >> 6) % 4 }];
    const program: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }], steps };
    let item = rawMaterial('stone');
    for (const step of steps) item = applyPhysicalOperation(step, [item]).product!;
    recipe(world, program, materialCapacities(item), []);
  }
  for (let n = 1; n <= 32; n++) {
    const parent = world.technology.recipes[n - 1]!;
    const capacities = { ...parent.capacities, binding: Math.min(1, parent.capacities.binding + 0.3) };
    recipe(world, { inputs: [{ source: 'product', recipeId: parent.id, mass: 1000 }], steps: [{ op: 'abrade', intensity: 1 + n % 4 }] }, capacities, [parent.id]);
  }
  enableTechnologyCatalogue(world.technology);
  bindTechnologyCatalogue(world.technology, { resolve: () => null, findBySignature: () => null });
  world.people.forEach((person, i) => {
    person.technology.knownRecipes = Array.from({ length: 24 }, (_, j) => `recipe-${1 + (i * 7 + j) % 224}`);
    if (i % 3 === 0) person.technology.knownRecipes.push(`recipe-${225 + i % 32}`);
  });
  world.technology.checkpoint = captureTechnologyCheckpoint(world.technology, world.people, world.tick, 'initial');
  assertWorld(world);
  return world;
}

const scenes: Record<string, (seed: number) => World> = {
  'V11 por defecto': seed => createWorld(seed),
  'V12 mundo abierto': seed => createWorld(seed, parseParams(openLaws)),
  'V12 mundo abierto con ensenanzaRareza': seed => createWorld(seed, parseParams(rareLaws)),
  'V12 P400 enseñanza con rareza': teachingWorld,
};
const reference: Record<string, Record<number, [string, string]>> = {
  'V11 por defecto': {
    2002: ['31a74fd0684d7c9867e217ffce5a143f4c0f42c6b63374bb7d6002584cf747fb', 'fd589c596bb3db67a3d2096396242e04f2e45dae3117068334b8972e9f61c867'],
    42: ['ee74060dc11a38f9f93d574aa33c2c87ee2b9c58096331821a75057d86be0bc3', '52cc36725900572d452c5619e42148d374d553b34ec1e4ffd065f977f84a94bc'],
    51926: ['7d70c818adac9efbc90a91d50b4bed6fadd9d9c97fe36bd6a7cce996e304c4d5', 'a295b01b5b01707c146a94698dee039f732170897631f00075571ce59d0e3a50'],
  },
  'V12 mundo abierto': {
    2002: ['c6184737caecbb42e74e3387f2c971bf31407695b537f33256f888a47d95d34a', '7714c43044b9c805e29e24b7d1bd75042c2150e63fd19ef36605c0158e826ddd'],
    42: ['f24169064497b0c003e2acbf24316202cd340f28072038bc3be59eb567e8bc2c', '42271d871481e248d148073076b7bad730653cc4dab7c82cbed7361e3d66ff29'],
    51926: ['922a4d47952d4b8405f2d59c03d10e38035b59df42059f5cf63bc064aed4ec1f', '32c26281ec988c92c4b70811787e2fee6847b2bcf603d915f9dc7b400651e11a'],
  },
  'V12 mundo abierto con ensenanzaRareza': {
    2002: ['658ce36bb0a3df23d3fc51083a66bd3dfd7f82d39b90292fa34c35c1d4f8488a', 'fe5d62835c7f38afef7a857cb2a9a168484dc5f355ef48ea896f4c82cbca9c23'],
    42: ['6a400296a35132c739628c3111e4f997483238c3325232ad8844f970212fb0fd', 'a5c3314f401070ad75118effa0be8b2a9c7644e3ced9744e0c2997b54febab03'],
    51926: ['bbe6df281c34a0e371728d80ad3f716e2ff02bf3aeab21314fdda9053a7a9b8f', '3d2c116346504bfa4e0e494422a86ee17cd1beaf48add60325a3ffbc82b4f69d'],
  },
  'V12 P400 enseñanza con rareza': {
    2002: ['b874a4a9cfb287b4426d788709c3daa3f9f23134bd792cef3de0d8764d3da154', 'e7152142553c40f43b08e8e5bf01a5225ecff7ff2549c625c229c89bdb921441'],
    42: ['496c3a99effd2c1c1707a8354f037239e6dabc3a12aa12cec0511fa38368a4e6', 'c7278b6f7283e007eb0a0426b926d6ba730d34c0a9f32749731dc29fcbf53406'],
    51926: ['0e09a1aab25f3ae44d839ce0e3065964131e1604210fac19036c7de7190eb534', 'c30f141298667da97a725cbc032091970849625eedc2255c15f6096fc5c78db8'],
  },
};

for (const [name, make] of Object.entries(scenes)) test(`${name}: digestos idénticos a 49c3c1c en los ticks 300 y 600`, () => {
  for (const seed of [2002, 42, 51926]) {
    const world = make(seed);
    for (const [i, until] of [300, 600].entries()) {
      while (world.tick < until) stepWorld(world);
      assert.equal(digestoCanonico(world), reference[name]![seed]![i], `${name}, semilla ${seed}, tick ${until}`);
    }
    assertWorld(world);
  }
});
