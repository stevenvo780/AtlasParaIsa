/**
 * Stress the catalogue's former 65 536-pending-record backstop with a valid, distinct sequence.
 * Definitions are synthetic and make no claim of paid discovery or biological plausibility;
 * this proves admission, archive commit and exact reload at the boundary. Run with
 * `TMPDIR=/datos/tmp-atlas-lab tsx scripts/lab/reproduce-catalogue-caps.mts --count 65537`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../../src/server/store.js';
import { digestoCanonico } from '../../src/world/digesto.js';
import { assertWorld, createWorld, stepWorld } from '../../src/world/index.js';
import { programSignature } from '../../src/world/technology.js';
import { registerTechnologyRecipe, technologyCataloguePendingCount,
  MAX_PENDING_TECHNOLOGY_RECIPES, TECHNOLOGY_CATALOGUE_COMMIT_THRESHOLD,
} from '../../src/world/technology-catalogue.js';
import type { TechnologyProgram, TechnologyRecipe } from '../../src/shared/technology.js';

const index = process.argv.indexOf('--count');
const count = index < 0 ? 65_537 : Number(process.argv[index + 1]);
if (!Number.isSafeInteger(count) || count < 1 || count > MAX_PENDING_TECHNOLOGY_RECIPES) {
  throw new Error('--count must be an integer from 1 to MAX_PENDING_TECHNOLOGY_RECIPES');
}

const directory = mkdtempSync(join(tmpdir(), 'atlas-catalogue-caps-'));
const store = new Store(join(directory, 'world.sqlite'));
try {
  const started = performance.now();
  const world = createWorld(97007);
  store.save(world); // Store attaches the durable catalogue before the first tick.
  stepWorld(world);
  assert.equal(world.technology.recipeCounter, 0, 'the fixture must begin without definitions');
  const inventor = world.people[2]!;
  assert.ok(inventor);
  const state = world.technology, catalogue = state.catalogue!;
  assert.ok(catalogue);

  const makeRecipe = (serial: number): TechnologyRecipe => {
    // Ten base-4 digits admit 1 048 576 distinct valid programs within maxSteps=12.
    const program: TechnologyProgram = {
      inputs: [{ source: 'raw', material: 'stone', mass: 1000 }],
      steps: [{ op: 'compress', intensity: 1 }, ...Array.from({ length: 10 }, (_, place) =>
        ({ op: 'cool' as const, intensity: 1 + Math.floor((serial - 1) / 4 ** place) % 4 }))],
    };
    return { id: `recipe-${serial}`, name: `Synthetic ${serial}`, program,
      signature: programSignature(program), parents: [], generation: 1,
      inventorId: inventor.id, tick: world.tick, x: inventor.x, y: inventor.y,
      novelty: serial === 1 ? 'both' : 'program',
      capacities: { cutting: 0, storage: 0, insulation: 0, cultivation: 0, binding: 0, abrasion: 0 },
      uses: 0, utility: 0, manufactured: 0 };
  };

  // Form a consistent pending prefix cheaply; use the real register function for the boundary
  // allocation that used to throw, then require full Store validation, commit and reload.
  const pending = Array.from({ length: count - 1 }, (_, n) => makeRecipe(n + 1));
  catalogue.pending = pending;
  catalogue.totals = { recipes: count - 1, maxGeneration: pending.length ? 1 : 0,
    manufactured: 0, uses: 0, utility: 0, functionalDiversity: pending.length ? 1 : 0 };
  if (pending.length) catalogue.functions[0] = 1;
  state.recipeCounter = count - 1;
  state.recipes = pending.slice(-state.budgets.maxRecipes);
  registerTechnologyRecipe(world, makeRecipe(count));
  assert.equal(state.recipeCounter, count);
  assert.equal(technologyCataloguePendingCount(state), count);
  assert.ok(count < TECHNOLOGY_CATALOGUE_COMMIT_THRESHOLD,
    'this stress case tests the old cap, not the early-commit threshold');
  assertWorld(world);
  const beforeCommitMs = performance.now() - started;

  store.save(world);
  assert.equal(technologyCataloguePendingCount(state), 0);
  const committedDigest = digestoCanonico(world);
  const afterCommitMs = performance.now() - started;
  const loaded = store.load();
  assert.ok(loaded);
  assert.equal(loaded.world.technology.recipeCounter, count);
  assert.equal(technologyCataloguePendingCount(loaded.world.technology), 0);
  assert.equal(digestoCanonico(loaded.world), committedDigest);
  const result = {
    status: 'PASS', count, oldCap: 65_536, maxPending: MAX_PENDING_TECHNOLOGY_RECIPES,
    commitThreshold: TECHNOLOGY_CATALOGUE_COMMIT_THRESHOLD,
    committedDigest, beforeCommitMs: Math.round(beforeCommitMs),
    commitMs: Math.round(afterCommitMs - beforeCommitMs),
    reloadMs: Math.round(performance.now() - started - afterCommitMs),
  };
  console.log(JSON.stringify(result));
} finally {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
