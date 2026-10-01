import test from 'node:test';
import assert from 'node:assert/strict';
import type { Capability, TechnologyProgram, TechnologyRecipe } from '../src/shared/technology.js';
import { pureAvailableRecipePowers } from '../src/world/cooperation-known-powers.js';

const capabilities: readonly Capability[] = ['cutting', 'storage', 'insulation', 'cultivation', 'binding', 'abrasion'];
type Recipe = Pick<TechnologyRecipe, 'capacities' | 'program'>;
function recipe(values: readonly number[]): Recipe {
  return {
    capacities: Object.fromEntries(capabilities.map((key, index) => [key, values[index] ?? 0])) as Record<Capability, number>,
    program: { inputs: [], steps: [] },
  };
}
/** Independent oracle copied from the original society filter + six reductions. */
function originalPowers(remembered: readonly Recipe[], available: (program: TechnologyProgram) => boolean): Record<Capability, number> {
  const known = remembered.filter(instruction => available(instruction.program));
  return Object.fromEntries(capabilities.map(capability => {
    let power = 0;
    for (const instruction of known) power = Math.max(power, instruction.capacities[capability]);
    return [capability, power];
  })) as Record<Capability, number>;
}
function identical(expected: Record<Capability, number>, actual: Record<Capability, number>): void {
  for (const key of capabilities) assert.ok(Object.is(actual[key], expected[key]), `${key}: ${actual[key]} versus ${expected[key]}`);
}

test('pure pruning matches the original after every prefix, including unavailable NaN and signed zero', () => {
  const rows = [
    { recipe: recipe([-0, -0, -0, -0, -0, -0]), present: true },
    { recipe: recipe([NaN, Infinity, 1, 0.6, 0.9, 0.4]), present: false },
    { recipe: recipe([0.8, 0.6, 0.4, 0.2, 0.1, 0.5]), present: true },
    { recipe: recipe([0.7, 0.5, 0.3, 0.1, -0, 0.2]), present: true },
    { recipe: recipe([0.7, 0.5, 0.3, 0.1, -0, 0.2]), present: false },
    { recipe: recipe([NaN, 0.7, 0, 0, 0, 0]), present: true },
    { recipe: recipe([0.9, 0.1, -0, -0, -0, -0]), present: true },
    { recipe: recipe([1, Infinity, 0.5, 0.1, 0.1, 0.5]), present: true },
    { recipe: recipe([NaN, Infinity, 0.5, 0.1, 0.1, 0.5]), present: true },
    { recipe: recipe([-Infinity, 0, 0, 0, 0, 0]), present: true },
  ];
  const available = (program: TechnologyProgram) => rows.find(row => row.recipe.program === program)!.present;
  for (let length = 0; length <= rows.length; length++) {
    const prefix = rows.slice(0, length).map(row => row.recipe);
    identical(originalPowers(prefix, available), pureAvailableRecipePowers(prefix, available));
  }
});

test('every availability mask and coordinate permutation agrees with the original oracle', () => {
  const values = [0, -0, -Infinity, 0.25, 0.5, Infinity, NaN];
  for (let rotation = 0; rotation < values.length; rotation++) {
    const recipes = values.map((_, row) => recipe(capabilities.map((_, coordinate) => values[(row + coordinate + rotation) % values.length]!)));
    for (let mask = 0; mask < 1 << recipes.length; mask++) {
      const byProgram = new Map(recipes.map((instruction, index) => [instruction.program, (mask & (1 << index)) !== 0]));
      const available = (program: TechnologyProgram) => byProgram.get(program)!;
      for (let length = 0; length <= recipes.length; length++) {
        const prefix = recipes.slice(0, length);
        identical(originalPowers(prefix, available), pureAvailableRecipePowers(prefix, available));
      }
    }
  }
});

test('dominated programs are omitted, unavailable improvers do not suppress a later available instruction', () => {
  const recipes = [recipe([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]), recipe([0.4, 0.4, 0.4, 0.4, 0.4, 0.4]),
    recipe([0.9, 0.9, 0.9, 0.9, 0.9, 0.9]), recipe([0.8, 0.8, 0.8, 0.8, 0.8, 0.8])];
  const inspected: TechnologyProgram[] = [];
  const actual = pureAvailableRecipePowers(recipes, program => { inspected.push(program); return program !== recipes[2]!.program; });
  identical(originalPowers(recipes, program => program !== recipes[2]!.program), actual);
  assert.deepEqual(inspected, [recipes[0]!.program, recipes[2]!.program, recipes[3]!.program]);
  assert.equal(recipes.length, 4, 'the original remembered sequence stays available to the later dependency gate');
});

test('the reduction has no state across pairs or calls and retains duplicate references', () => {
  const first = recipe([0.5, 0, 0, 0, 0, 0]), second = recipe([0.9, 0, 0, 0, 0, 0]);
  const recipes = [first, first, second, second];
  const before = structuredClone(recipes);
  identical(originalPowers(recipes, () => true), pureAvailableRecipePowers(recipes, () => true));
  identical(originalPowers(recipes, () => false), pureAvailableRecipePowers(recipes, () => false));
  assert.deepEqual(recipes, before);
  assert.equal(recipes[0], recipes[1]);
  assert.equal(recipes[2], recipes[3]);
});

test('throwing availability aborts locally, and the next call starts with +0 powers', () => {
  const recipes = [recipe([0.5, 0, 0, 0, 0, 0]), recipe([0.9, 0, 0, 0, 0, 0])];
  const failure = new Error('pure predicate fixture');
  assert.throws(() => pureAvailableRecipePowers(recipes, program => {
    if (program === recipes[1]!.program) throw failure;
    return true;
  }), error => error === failure);
  identical(originalPowers(recipes, () => false), pureAvailableRecipePowers(recipes, () => false));
  identical(originalPowers(recipes, () => true), pureAvailableRecipePowers(recipes, () => true));
});
