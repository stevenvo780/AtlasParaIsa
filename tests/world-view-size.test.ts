import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld, projectWorld, VIEW_EVENTS, VIEW_MEMORIES } from '../src/world/index.js';
import { projectTechnology, technologyRecipeDetail } from '../src/world/technology.js';
import type { TechnologyRecipe } from '../src/shared/technology.js';

const KIB = 1024;
/** Without a Store the catalogue is absent and the resident definitions reach `maxRecipes` (256):
 * the heaviest snapshot this world can produce, which is the one the measurement must survive. */
function grownWorld(ticks: number): ReturnType<typeof createWorld> {
  const world = createWorld(51926);
  for (let i = 0; i < ticks; i++) stepWorld(world);
  return world;
}

test('a snapshot carries procedure summaries, never their programs, and the saving is measurable', t => {
  const world = grownWorld(8000);
  assert.equal(world.tick, 8000);
  assert.equal(world.people.length, 32, 'the measurement is stated for 32 inhabitants');
  assert.ok(world.technology.recipes.length >= 200, `resident definitions: ${world.technology.recipes.length}`);
  const view = projectWorld(world), technology = view.technology!;
  assert.equal(technology.recipes.length, world.technology.recipes.length);
  for (const recipe of technology.recipes) {
    assert.deepEqual(Object.keys(recipe).sort(), ['capacities', 'generation', 'id', 'name'], 'the summary is exactly id, name, generation and capacities');
    for (const value of Object.values(recipe.capacities)) assert.equal(value, Math.round(value * 1000) / 1000, 'a drawn capacity travels rounded');
  }
  assert.equal(JSON.stringify(technology.recipes).includes('"program"'), false);
  assert.equal(JSON.stringify(view).includes('"steps"'), false, 'no program crosses the wire inside the snapshot');
  const bytes = JSON.stringify(view).length;
  const before = JSON.stringify({ ...view, technology: { ...technology, recipes: world.technology.recipes } }).length;
  const summaryBytes = JSON.stringify(technology.recipes).length;
  t.diagnostic(`t=8000 · ${world.people.length} hab. · ${world.technology.recipes.length} recetas · state ${(bytes / KIB).toFixed(1)} KiB (con programas ${(before / KIB).toFixed(1)} KiB) · recetas ${(summaryBytes / KIB).toFixed(1)} KiB · tiles ${(JSON.stringify(view.tiles).length / KIB).toFixed(1)} KiB`);
  assert.ok(summaryBytes < 64 * KIB, `summaries at ${(summaryBytes / KIB).toFixed(1)} KiB`);
  assert.ok(before - bytes > 140 * KIB, `the programs weighed ${((before - bytes) / KIB).toFixed(1)} KiB`);
  assert.ok(bytes < before * 0.83, `the snapshot keeps ${(100 * bytes / before).toFixed(1)} % of its size with programs`);
  // Honest ceiling of what T020 alone can reach: `tiles` (≈292 KiB) and `people` (≈83 KiB) still
  // travel whole every tick, so the brief's 120 KiB needs the delta/camera work, not this fix.
  assert.ok(bytes < 640 * KIB, `state at ${(bytes / KIB).toFixed(1)} KiB`);
});

test('the chronicle and the letter reach the snapshot through a declared window', () => {
  const world = grownWorld(600), view = projectWorld(world);
  assert.ok(view.events.length > 0 && view.events.length <= VIEW_EVENTS);
  assert.ok(view.memories.length <= VIEW_MEMORIES);
  assert.deepEqual(view.events.map(event => event.id), world.events.slice(-VIEW_EVENTS).map(event => event.id));
  assert.deepEqual(view.memories.map(memory => memory.id), world.memories.slice(-VIEW_MEMORIES).map(memory => memory.id));
});

test('a program is served one at a time and reading it never touches the world', () => {
  const world = grownWorld(600);
  const id = world.technology.recipes[0]!.id, before = structuredClone(world);
  const detail = technologyRecipeDetail(world, id) as TechnologyRecipe;
  assert.equal(detail.id, id);
  assert.ok(detail.program.steps.length > 0 && typeof detail.signature === 'string');
  assert.deepEqual(world, before, 'a query is not a transaction: the world is untouched');
  for (const invalid of ['', 'recipe-0', 'recipe-x', 'receta-1', 'recipe-01', '../recipe-1', 'recipe-99999999999999']) {
    assert.equal(technologyRecipeDetail(world, invalid), undefined, `rejected: ${invalid}`);
  }
  assert.equal(technologyRecipeDetail(world, `recipe-${world.technology.recipeCounter + 1}`), undefined, 'an unknown definition is absent, not invented');
  assert.equal(projectTechnology(world).recipes.some(recipe => 'program' in recipe), false);
});
