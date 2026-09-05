import test from 'node:test';
import assert from 'node:assert/strict';
import type { TechnologyKnowledge } from '../src/shared/technology.js';
import { initialTechnologyKnowledge, rawMaterial } from '../src/world/technology.js';
import { rememberRecipe, touchKnownRecipe, type RecipeMemoryOptions } from '../src/world/technology-memory.js';

const practice = () => ({ attempts: 3, successes: 2, work: 90, benefit: 0.2 });
function memory(ids = ['recipe-1', 'recipe-2', 'recipe-3']): TechnologyKnowledge {
  return { ...initialTechnologyKnowledge(), knownRecipes: [...ids],
    learnedFrom: ids.map(recipeId => ({ recipeId, teacherId: 'teacher', tick: 10 })),
    competence: Object.fromEntries(ids.map(id => [id, practice()])), attempts: 8, lastAttempt: 20 };
}
const options = (capacity: number, protectedIds: RecipeMemoryOptions['protectedIds'] = []): RecipeMemoryOptions => ({ capacity, protectedIds });
function physical(knowledge: TechnologyKnowledge) {
  const { knownRecipes: _known, learnedFrom: _learned, competence: _competence, ...rest } = knowledge;
  return rest;
}

test('admission and remembering again order instructions by recency without duplicates', () => {
  const knowledge = memory(['recipe-1']);
  assert.deepEqual(rememberRecipe(knowledge, 'recipe-2', options(3)), { remembered: true, forgotten: [] });
  assert.deepEqual(knowledge.knownRecipes, ['recipe-1', 'recipe-2']);
  assert.deepEqual(rememberRecipe(knowledge, 'recipe-1', options(3)), { remembered: true, forgotten: [] });
  assert.deepEqual(knowledge.knownRecipes, ['recipe-2', 'recipe-1']);
  assert.equal(knowledge.competence['recipe-2'], undefined, 'admission does not invent practice');
  assert.equal(knowledge.learnedFrom.length, 1, 'the caller records an actual teacher separately');
});

test('touch refreshes only an already known recipe and leaves unknown requests unchanged', () => {
  const knowledge = memory(), provenance = knowledge.learnedFrom, competence = knowledge.competence;
  assert.equal(touchKnownRecipe(knowledge, 'recipe-1'), true);
  assert.deepEqual(knowledge.knownRecipes, ['recipe-2', 'recipe-3', 'recipe-1']);
  assert.equal(knowledge.learnedFrom, provenance); assert.equal(knowledge.competence, competence);
  const before = structuredClone(knowledge), order = knowledge.knownRecipes;
  assert.equal(touchKnownRecipe(knowledge, 'recipe-99'), false);
  assert.deepEqual(knowledge, before); assert.equal(knowledge.knownRecipes, order);
});

test('admission evicts the oldest unprotected recipe and removes unsupported provenance and competence', () => {
  const knowledge = memory();
  assert.deepEqual(rememberRecipe(knowledge, 'recipe-4', options(3, new Set(['recipe-1']))), { remembered: true, forgotten: ['recipe-2'] });
  assert.deepEqual(knowledge.knownRecipes, ['recipe-1', 'recipe-3', 'recipe-4']);
  assert.deepEqual(knowledge.learnedFrom.map(entry => entry.recipeId), ['recipe-1', 'recipe-3']);
  assert.equal(knowledge.competence['recipe-2'], undefined);
  assert.deepEqual(knowledge.competence['recipe-1'], practice());
});

test('a smaller capacity evicts as many oldest unprotected instructions as necessary', () => {
  const knowledge = memory(['recipe-1', 'recipe-2', 'recipe-3', 'recipe-4']);
  assert.deepEqual(rememberRecipe(knowledge, 'recipe-4', options(2, ['recipe-2'])), { remembered: true, forgotten: ['recipe-1', 'recipe-3'] });
  assert.deepEqual(knowledge.knownRecipes, ['recipe-2', 'recipe-4']);
});

test('all protected and partially satisfiable admissions fail atomically, without refreshing order', () => {
  for (const [id, capacity, protectedIds] of [
    ['recipe-4', 3, ['recipe-1', 'recipe-2', 'recipe-3']],
    ['recipe-4', 2, ['recipe-2', 'recipe-3']],
    ['recipe-1', 1, ['recipe-2', 'recipe-3']],
  ] as const) {
    const knowledge = memory(), before = structuredClone(knowledge);
    const references = [knowledge.knownRecipes, knowledge.learnedFrom, knowledge.competence];
    assert.deepEqual(rememberRecipe(knowledge, id, options(capacity, protectedIds)), { remembered: false, forgotten: [] });
    assert.deepEqual(knowledge, before);
    assert.equal(knowledge.knownRecipes, references[0]); assert.equal(knowledge.learnedFrom, references[1]); assert.equal(knowledge.competence, references[2]);
  }
});

test('owned artifacts preserve tacit competence after instructions are forgotten, without a membership backdoor', () => {
  const knowledge = memory(['recipe-1']);
  const item = { ...rawMaterial('stone', 1000), id: 'product-1', recipeId: 'recipe-1' };
  knowledge.items.push(item);
  const competence = knowledge.competence['recipe-1'];
  assert.deepEqual(rememberRecipe(knowledge, 'recipe-2', options(1)), { remembered: true, forgotten: ['recipe-1'] });
  assert.equal(knowledge.items[0], item); assert.equal(knowledge.competence['recipe-1'], competence);
  assert.deepEqual(knowledge.learnedFrom, []);
  assert.equal(knowledge.knownRecipes.includes('recipe-1'), false, 'fabrication membership no longer holds; this primitive does not wire runtime selection');
  const before = structuredClone(knowledge);
  assert.equal(touchKnownRecipe(knowledge, 'recipe-1'), false);
  assert.deepEqual(knowledge, before, 'artifact familiarity cannot recover forgotten instructions');
});

test('eviction preserves all physical state, paid project progress and global learning counters', () => {
  const knowledge = memory(['recipe-1', 'recipe-2']);
  knowledge.items.push({ ...rawMaterial('wood', 350), id: 'product-1', recipeId: 'recipe-2' });
  knowledge.residue = { wood: 9, stone: 4, water: 2 };
  knowledge.project = { kind: 'craft', program: { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }],
    steps: [{ op: 'form', intensity: 2, shape: 'edge' }] }, parents: [], recipeId: 'recipe-1', progress: 3,
    requiredWork: 20, energyPaid: 0.012, startedAt: 12 };
  const before = structuredClone(physical(knowledge)), items = knowledge.items, residue = knowledge.residue, project = knowledge.project;
  assert.deepEqual(rememberRecipe(knowledge, 'recipe-3', options(2)), { remembered: true, forgotten: ['recipe-1'] });
  assert.deepEqual(physical(knowledge), before);
  assert.equal(knowledge.items, items); assert.equal(knowledge.residue, residue); assert.equal(knowledge.project, project);
  assert.equal(knowledge.competence['recipe-1'], undefined, 'a project is not an implicit pin; the caller must provide protectedIds');
});

test('callers can pin the active recipe and parents while memory forgets only an unrelated oldest entry', () => {
  const knowledge = memory(['recipe-1', 'recipe-2', 'recipe-3']);
  assert.deepEqual(rememberRecipe(knowledge, 'recipe-4', options(3, ['recipe-1', 'recipe-3'])), { remembered: true, forgotten: ['recipe-2'] });
  assert.deepEqual(knowledge.knownRecipes, ['recipe-1', 'recipe-3', 'recipe-4']);
});

test('capacity bounds are inclusive and recipe identities can exceed the memory capacity', () => {
  const one = memory([]); assert.equal(rememberRecipe(one, 'recipe-1000', options(1)).remembered, true);
  const full = memory(Array.from({ length: 256 }, (_, n) => `recipe-${n + 1}`));
  assert.deepEqual(rememberRecipe(full, 'recipe-257', options(256)), { remembered: true, forgotten: ['recipe-1'] });
  assert.equal(full.knownRecipes.length, 256); assert.equal(full.knownRecipes.at(-1), 'recipe-257');
});

test('invalid capacity or protection inputs throw before any knowledge changes', () => {
  const invalid: unknown[] = [null, undefined, {}, ...[0, -1, 1.5, Number.NaN, Infinity, 257, '2'].map(capacity => ({ capacity, protectedIds: [] })),
    { capacity: 2 }, { capacity: 2, protectedIds: 'recipe-1' }, { capacity: 2, protectedIds: [' recipe-1'] }, { capacity: 2, protectedIds: new Set([null]) }];
  for (const candidate of invalid) {
    const knowledge = memory(), before = structuredClone(knowledge);
    assert.throws(() => rememberRecipe(knowledge, 'recipe-4', candidate as RecipeMemoryOptions), /memory/);
    assert.deepEqual(knowledge, before);
  }
});

test('malformed recipe identities, duplicate memories and invalid read fields are rejected without normalization', () => {
  for (const id of ['', 'unknown', 'recipe-0', 'recipe-01', ' recipe-1', 'recipe-9007199254740992', null] as unknown[]) {
    const knowledge = memory(), before = structuredClone(knowledge);
    assert.throws(() => rememberRecipe(knowledge, id as string, options(2)), /memory/);
    assert.throws(() => touchKnownRecipe(knowledge, id as string), /memory/);
    assert.deepEqual(knowledge, before);
  }
  const mutations: ((knowledge: TechnologyKnowledge) => void)[] = [
    value => { value.knownRecipes.push('recipe-1'); },
    value => { value.knownRecipes = new Array<string>(1); value.learnedFrom = []; },
    value => { value.knownRecipes[0] = 'recipe-01'; },
    value => { value.learnedFrom[0]!.recipeId = 'recipe-99'; },
    value => { value.learnedFrom[0]!.tick = -1; },
    value => { value.competence['recipe-1']!.successes = 9; },
    value => { value.competence['recipe-1']!.benefit = Number.NaN; },
    value => { value.competence = new Map() as unknown as TechnologyKnowledge['competence']; },
    value => { value.items = new Array<TechnologyKnowledge['items'][number]>(1); },
    value => { value.items.push({ recipeId: undefined } as unknown as TechnologyKnowledge['items'][number]); },
  ];
  for (const mutation of mutations) {
    const knowledge = memory(); mutation(knowledge); const before = structuredClone(knowledge);
    assert.throws(() => rememberRecipe(knowledge, 'recipe-4', options(2)), /memory/);
    assert.throws(() => touchKnownRecipe(knowledge, 'recipe-1'), /memory/);
    assert.deepEqual(knowledge, before);
  }
});

test('protection inputs are read only and unfamiliar protected IDs do not become knowledge', () => {
  const knowledge = memory(['recipe-1', 'recipe-2']);
  const protectedIds = Object.freeze(['recipe-1', 'recipe-99']);
  const settings = Object.freeze({ capacity: 2, protectedIds });
  assert.deepEqual(rememberRecipe(knowledge, 'recipe-3', settings), { remembered: true, forgotten: ['recipe-2'] });
  assert.deepEqual(protectedIds, ['recipe-1', 'recipe-99']);
  assert.deepEqual(knowledge.knownRecipes, ['recipe-1', 'recipe-3']);
});
