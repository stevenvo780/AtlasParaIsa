import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { assertTechnologyCatalogueState, bindTechnologyCatalogue, catalogueEnabled, enableTechnologyCatalogue,
  findTechnologyRecipe, hasTechnologyFunction, markTechnologyCatalogueCommitted, registerTechnologyRecipe,
  resolveTechnologyRecipe, TECHNOLOGY_FUNCTION_WORDS, technologyCatalogueStateForCommit,
  technologyCatalogueTotals, technologyFunctionCode, technologyFunctionCount, technologyMemoryCapacity,
  updateTechnologyRecipeStats, type TechnologyCatalogueReader } from '../src/world/technology-catalogue.js';
import { defaultTechnologyState, initialTechnologyKnowledge, researchTechnology, technologyWorkCost,
  type TechnologyActor, type TechnologyHost, type TechnologyProgram } from '../src/world/technology.js';

const programs: TechnologyProgram[] = [
  { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }], steps: [{ op: 'form', intensity: 4, shape: 'edge' }, { op: 'compress', intensity: 2 }] },
  { inputs: [{ source: 'raw', material: 'wood', mass: 1000 }], steps: [{ op: 'weave', intensity: 4 }, { op: 'form', intensity: 2, shape: 'sheet' }] },
  { inputs: [{ source: 'raw', material: 'wood', mass: 1000 }], steps: [{ op: 'form', intensity: 4, shape: 'rod' }] },
  { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }], steps: [{ op: 'form', intensity: 3, shape: 'hollow' }, { op: 'compress', intensity: 1 }] },
];

/** Definitions originate in completed physical work before the catalogue is enabled. */
function paidDefinitions() {
  const actor: TechnologyActor = { id: 'maker', x: 0, y: 0, energy: 1, fatigue: 0,
    materials: { wood: 10, stone: 10 }, skills: {}, technology: initialTechnologyKnowledge() };
  const host: TechnologyHost = { seed: 731, tick: 0, people: [actor], technology: defaultTechnologyState() };
  let prefix: TechnologyHost | undefined;
  for (const [index, program] of programs.entries()) {
    if (index === 3) prefix = structuredClone(host);
    actor.technology.project = { kind: 'research', program: structuredClone(program), parents: [], recipeId: null,
      progress: 0, requiredWork: technologyWorkCost(program), energyPaid: 0, startedAt: host.tick };
    let result = false;
    while (actor.technology.project) { host.tick++; result = researchTechnology(host, actor); }
    assert.equal(result, true);
  }
  return { host: prefix!, definitions: structuredClone(host.technology.recipes), throughTick: host.tick };
}

function archivedFixture() {
  const { host, definitions, throughTick } = paidDefinitions();
  host.tick = throughTick;
  const archive = new Map(definitions.slice(0, 3).map(recipe => [recipe.id, structuredClone(recipe)]));
  const reads: { kind: string; key: string; tick: number }[] = [];
  const reader: TechnologyCatalogueReader = {
    resolve(id, atTick) {
      reads.push({ kind: 'id', key: id, tick: atTick });
      const recipe = archive.get(id); return recipe && recipe.tick <= atTick ? structuredClone(recipe) : null;
    },
    findBySignature(signature, atTick) {
      reads.push({ kind: 'signature', key: signature, tick: atTick });
      const recipe = [...archive.values()].find(recipe => recipe.signature === signature && recipe.tick <= atTick);
      return recipe ? structuredClone(recipe) : null;
    },
  };
  enableTechnologyCatalogue(host.technology, { committedThrough: host.technology.recipeCounter });
  host.technology.budgets.maxRecipes = 2;
  host.technology.recipes = host.technology.recipes.slice(-2);
  bindTechnologyCatalogue(host.technology, reader);
  const newDefinition = { ...definitions[3]!, manufactured: 0, uses: 0, utility: 0 };
  return { host, archive, reader, reads, newDefinition };
}

test('new paid definitions outlive cache eviction and their pending statistics resolve ahead of an unchanged archive', () => {
  const { host, archive, newDefinition } = archivedFixture(), state = host.technology;
  registerTechnologyRecipe(host, newDefinition);
  updateTechnologyRecipeStats(host, newDefinition.id, { manufactured: 1, uses: 2, utility: 0.25 });
  updateTechnologyRecipeStats(host, 'recipe-1', { uses: 3, utility: 0.125 });
  for (const id of ['recipe-2', 'recipe-3']) resolveTechnologyRecipe(host, id);
  assert.deepEqual(state.recipes.map(recipe => recipe.id), ['recipe-2', 'recipe-3']);
  assert.equal(state.recipeCounter, 4); assert.equal(state.catalogue!.pending.length, 2);
  const cold = resolveTechnologyRecipe(host, newDefinition.id)!;
  assert.equal(cold.manufactured, 1); assert.equal(cold.uses, 2); assert.equal(cold.utility, 0.25);
  const modified = resolveTechnologyRecipe(host, 'recipe-1')!;
  assert.equal(modified.uses, 3); assert.equal(modified.utility, 0.125);
  assert.equal(archive.get('recipe-1')!.uses, 0); assert.equal(archive.has(newDefinition.id), false);
  assert.equal(state.catalogue!.pending.filter(recipe => recipe.id === 'recipe-1').length, 1);
  assert.deepEqual(technologyCatalogueTotals(host), { recipes: 4, maxGeneration: 1, manufactured: 4, uses: 5, utility: 0.375,
    functionalDiversity: new Set([...archive.values(), newDefinition].map(recipe => technologyFunctionCode(recipe.capacities))).size });
  assert.ok(state.recipes.length <= 2);
});

test('signature lookup resolves a cold discovery without allocating an identity, granting knowledge or rewriting its author', () => {
  const { host, archive, reads } = archivedFixture(), original = archive.get('recipe-1')!;
  const knowledge = structuredClone(host.people[0]!.technology), counter = host.technology.recipeCounter;
  const result = findTechnologyRecipe(host, original.signature)!;
  assert.deepEqual(result, original); assert.notEqual(result, original);
  assert.equal(host.technology.recipeCounter, counter); assert.deepEqual(host.people[0]!.technology, knowledge);
  assert.deepEqual(reads, [{ kind: 'signature', key: original.signature, tick: host.tick }]);
  assert.equal(host.technology.catalogue!.pending.length, 0);
  assert.throws(() => registerTechnologyRecipe(host, { ...result, id: `recipe-${counter + 1}`, manufactured: 0 }), /duplicate program/);
  assert.equal(host.technology.recipeCounter, counter);
});

test('read-only resolution and copied aggregate views leave cache order, pending writes and archive objects untouched', () => {
  const { host, archive, reads } = archivedFixture(), before = structuredClone(host.technology), cache = host.technology.recipes;
  const recipe = resolveTechnologyRecipe(host, 'recipe-1', { cache: false })!;
  recipe.utility = 123;
  const totals = technologyCatalogueTotals(host); totals.uses = 1000;
  assert.deepEqual(host.technology, before); assert.equal(host.technology.recipes, cache);
  assert.equal(archive.get('recipe-1')!.utility, 0);
  assert.deepEqual(reads, [{ kind: 'id', key: 'recipe-1', tick: host.tick }]);
});

test('invalid and overflowing statistics fail before changing cache order, pending references, records or totals', () => {
  for (const variation of ['negative', 'fraction', 'unknown-key', 'record-overflow', 'aggregate-overflow', 'utility-overflow'] as const) {
    const { host, archive } = archivedFixture(), state = host.technology;
    let delta: Parameters<typeof updateTechnologyRecipeStats>[2] = { uses: 1 };
    if (variation === 'negative') delta = { uses: -1 };
    if (variation === 'fraction') delta = { manufactured: 0.5 };
    if (variation === 'unknown-key') delta = { unknown: 1 } as unknown as typeof delta;
    if (variation === 'record-overflow') archive.get('recipe-1')!.uses = Number.MAX_SAFE_INTEGER;
    if (variation === 'aggregate-overflow') state.catalogue!.totals.uses = Number.MAX_SAFE_INTEGER;
    if (variation === 'utility-overflow') { state.catalogue!.totals.utility = Number.MAX_VALUE; delta = { utility: Number.MAX_VALUE }; }
    const before = structuredClone(state), cache = state.recipes, pending = state.catalogue!.pending, totals = state.catalogue!.totals;
    assert.throws(() => updateTechnologyRecipeStats(host, 'recipe-1', delta), /statistics/);
    assert.deepEqual(state, before, variation); assert.equal(state.recipes, cache); assert.equal(state.catalogue!.pending, pending); assert.equal(state.catalogue!.totals, totals);
  }
});

test('archive identity, signature and future-tick lies are rejected before entering the resident cache', () => {
  for (const variation of ['wrong-id', 'future-id', 'wrong-signature', 'future-signature'] as const) {
    const { host, archive } = archivedFixture(), original = archive.get('recipe-1')!, forged = structuredClone(original);
    if (variation === 'wrong-id') forged.id = 'recipe-2';
    if (variation === 'wrong-signature') forged.signature = 'forged';
    if (variation.startsWith('future')) forged.tick = host.tick + 1;
    bindTechnologyCatalogue(host.technology, { resolve: () => forged, findBySignature: () => forged });
    const before = structuredClone(host.technology);
    assert.throws(() => variation.endsWith('signature') ? findTechnologyRecipe(host, original.signature) : resolveTechnologyRecipe(host, original.id), /resolved/);
    assert.deepEqual(host.technology, before);
  }
});

test('missing and unsafe identities never call the archive or materialize a phantom record', () => {
  const { host, reads } = archivedFixture(), before = structuredClone(host.technology);
  for (const id of ['unknown', 'recipe-0', 'recipe-01', 'recipe-4', 'recipe-9007199254740992']) assert.equal(resolveTechnologyRecipe(host, id), undefined);
  assert.deepEqual(reads, []); assert.deepEqual(host.technology, before);
  assert.equal(findTechnologyRecipe(host, 'absent-program'), undefined);
  assert.equal(host.technology.catalogue!.pending.length, 0);
});

test('function coordinates have bounded bins, including unsigned high bits and both endpoint bins', () => {
  const capacities = (value: number) => ({ cutting: value, storage: value, insulation: value, cultivation: value, binding: value, abrasion: value });
  assert.equal(technologyFunctionCode(capacities(0)), 0);
  assert.equal(technologyFunctionCode(capacities(1)), 46655);
  assert.equal(technologyFunctionCode({ ...capacities(0), cutting: 0.199999 }), 0);
  assert.equal(technologyFunctionCode({ ...capacities(0), cutting: 0.2 }), 1);
  const words = Array<number>(TECHNOLOGY_FUNCTION_WORDS).fill(0); words[0] = 0x80000001; words[words.length - 1] = 0x80000000;
  assert.equal(technologyFunctionCount(words), 3);
  assert.equal(technologyFunctionCount(Array<number>(TECHNOLOGY_FUNCTION_WORDS).fill(0xffffffff)), 46656);
  for (const value of [-0.001, 1.001, Number.NaN, Infinity]) assert.throws(() => technologyFunctionCode(capacities(value)), /capability coordinate/);
  const { host, archive, reads } = archivedFixture();
  assert.equal(hasTechnologyFunction(host, archive.get('recipe-1')!.capacities), true);
  assert.equal(hasTechnologyFunction(host, capacities(1)), false); assert.deepEqual(reads, [], 'functional novelty uses the fixed summary without enumerating archived programs');
  assert.equal(host.technology.catalogue!.functions.length, TECHNOLOGY_FUNCTION_WORDS);
});

test('catalogue opt-in preserves the durable boundary and separates working memory from lifetime identity allocation', () => {
  const { host } = paidDefinitions(), before = structuredClone(host.technology);
  assert.equal(catalogueEnabled(host.technology), false); assert.equal(technologyMemoryCapacity(host.technology), 256);
  enableTechnologyCatalogue(host.technology, { committedThrough: 2 });
  assert.equal(catalogueEnabled(host.technology), true); assert.equal(technologyMemoryCapacity(host.technology), 32);
  assert.deepEqual(host.technology.catalogue!.pending.map(recipe => recipe.id), ['recipe-3']);
  assert.equal(host.technology.recipeCounter, before.recipeCounter); assert.deepEqual(host.technology.recipes, before.recipes);
  const metadata = host.technology.catalogue; enableTechnologyCatalogue(host.technology, { committedThrough: 0, memoryCapacity: 1 });
  assert.equal(host.technology.catalogue, metadata, 're-enabling cannot silently discard a pending boundary or alter capacity');
  host.technology.budgets.maxRecipes = 2; assert.equal(technologyMemoryCapacity(host.technology), 2);
});

test('invalid initial coverage fails before installing any catalogue metadata', () => {
  for (const variation of ['missing-definition', 'wrong-sequence', 'future-prefix', 'empty-memory'] as const) {
    const { host } = paidDefinitions();
    if (variation === 'missing-definition') host.technology.recipes.shift();
    if (variation === 'wrong-sequence') host.technology.recipes.reverse();
    const before = structuredClone(host.technology);
    assert.throws(() => enableTechnologyCatalogue(host.technology, variation === 'future-prefix' ? { committedThrough: 4 } : variation === 'empty-memory' ? { memoryCapacity: 0 } : {}), /initial/);
    assert.deepEqual(host.technology, before);
  }
});

test('commit preparation and clonable metadata retain pending references until the actual acknowledgement', () => {
  const { host, newDefinition, archive, reader } = archivedFixture(), state = host.technology;
  registerTechnologyRecipe(host, newDefinition); updateTechnologyRecipeStats(host, 'recipe-1', { uses: 2 });
  const before = structuredClone(state), pending = state.catalogue!.pending;
  const prepared = technologyCatalogueStateForCommit(state);
  assert.notEqual(prepared, state); assert.notEqual(prepared.catalogue, state.catalogue);
  assert.equal(prepared.catalogue!.committedThrough, state.recipeCounter); assert.deepEqual(prepared.catalogue!.pending, []);
  assert.deepEqual(state, before); assert.equal(state.catalogue!.pending, pending);
  const draft = structuredClone(state);
  assert.equal(draft.catalogue!.pending.find(recipe => recipe.id === 'recipe-1'), draft.recipes.find(recipe => recipe.id === 'recipe-1'));
  const restored = structuredClone(prepared), restoredHost = { technology: restored, tick: host.tick };
  restored.recipes = [];
  assert.throws(() => resolveTechnologyRecipe(restoredHost, 'recipe-2'), /requires its host reader/);
  for (const recipe of pending) archive.set(recipe.id, structuredClone(recipe));
  markTechnologyCatalogueCommitted(state);
  assert.deepEqual(state.catalogue!.pending, []); assert.equal(state.catalogue!.committedThrough, state.recipeCounter);
  bindTechnologyCatalogue(restored, reader);
  assert.equal(resolveTechnologyRecipe(restoredHost, 'recipe-1')!.uses, 2);
  assert.equal(resolveTechnologyRecipe(restoredHost, newDefinition.id)!.id, newDefinition.id);
});

test('a forged enormous uncommitted prefix is rejected within a bounded subprocess deadline', () => {
  const state = defaultTechnologyState(); enableTechnologyCatalogue(state);
  state.recipeCounter = Number.MAX_SAFE_INTEGER; state.catalogue!.totals.recipes = state.recipeCounter;
  const helperUrl = new URL('../src/world/technology-catalogue.ts', import.meta.url).href;
  const script = `import { readFileSync } from 'node:fs';
    const { assertTechnologyCatalogueState } = await import(${JSON.stringify(helperUrl)});
    try { assertTechnologyCatalogueState({ technology: JSON.parse(readFileSync(0, 'utf8')), tick: 0 }); process.exitCode = 2; }
    catch (error) { if (!/uncommitted definition gap/.test(String(error))) throw error; process.stdout.write('bounded rejection'); }`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { input: JSON.stringify(state), encoding: 'utf8', timeout: 2000 });
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, 'bounded rejection');
});

test('invalid fixed bitmap representation and divergent pending records cannot pass the local envelope', () => {
  const cases = [
    (host: TechnologyHost) => { host.technology.catalogue!.functions.pop(); },
    (host: TechnologyHost) => { host.technology.catalogue!.functions[0] = -1; },
    (host: TechnologyHost) => { host.technology.catalogue!.totals.functionalDiversity++; },
    (host: TechnologyHost) => { const first = structuredClone(host.technology.recipes[0]!); first.uses++; host.technology.catalogue!.pending.push(first); },
  ];
  for (const corrupt of cases) { const { host } = archivedFixture(); corrupt(host); assert.throws(() => assertTechnologyCatalogueState(host), /catalogue/); }
  const state = defaultTechnologyState(); enableTechnologyCatalogue(state);
  state.catalogue!.functions = Array<number>(TECHNOLOGY_FUNCTION_WORDS);
  assert.throws(() => assertTechnologyCatalogueState({ technology: state, tick: 0 }), /catalogue/);
});
