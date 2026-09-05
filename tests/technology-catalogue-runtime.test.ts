import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTechnologyCatalogue, enableTechnologyCatalogue, resolveTechnologyRecipe } from '../src/world/technology-catalogue.js';
import { assertTechnology, cancelTechnologyProject, craftTechnology, defaultTechnologyState, initialTechnologyKnowledge,
  maintainTechnologyMemory, projectTechnology, proposeTechnologyProgram, recordTechnologyBenefit, researchTechnology,
  shareTechnology, technologyOpportunity, technologyWorkCost, transferTechnologyItem, useTool,
  type TechnologyActor, type TechnologyHost, type TechnologyProgram, type TechnologyRecipe } from '../src/world/technology.js';

const edge: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }], steps: [{ op: 'form', intensity: 4, shape: 'edge' }, { op: 'compress', intensity: 2 }] };
const fibre: TechnologyProgram = { inputs: [{ source: 'raw', material: 'wood', mass: 1000 }], steps: [{ op: 'weave', intensity: 4 }, { op: 'form', intensity: 2, shape: 'sheet' }] };
const rod: TechnologyProgram = { inputs: [{ source: 'raw', material: 'wood', mass: 1000 }], steps: [{ op: 'form', intensity: 4, shape: 'rod' }] };
function scene() {
  const actor = (id: string): TechnologyActor => ({ id, x: 0, y: 0, energy: 1, fatigue: 0, materials: { wood: 1000, stone: 1000 }, skills: {}, technology: initialTechnologyKnowledge() });
  const a = actor('inventor'), b = actor('neighbor');
  const host: TechnologyHost = { seed: 751, tick: 0, people: [a, b], technology: defaultTechnologyState() };
  return { host, a, b };
}
function start(host: TechnologyHost, actor: TechnologyActor, program: TechnologyProgram, parents: string[] = []) {
  actor.technology.project = { kind: 'research', program: structuredClone(program), parents, recipeId: null,
    progress: 0, requiredWork: technologyWorkCost(program), energyPaid: 0, startedAt: host.tick };
}
function finish(host: TechnologyHost, actor: TechnologyActor): boolean {
  let success = false;
  while (actor.technology.project) { host.tick++; success = actor.technology.project.kind === 'research' ? researchTechnology(host, actor) : craftTechnology(host, actor); }
  return success;
}
function discover(host: TechnologyHost, actor: TechnologyActor, program: TechnologyProgram, parents: string[] = []): TechnologyRecipe {
  start(host, actor, program, parents); assert.equal(finish(host, actor), true);
  return resolveTechnologyRecipe(host, actor.technology.items.at(-1)!.recipeId!)!;
}
/** A narrow archive reader: no API exists here to enumerate global programs. */
function archiveScene(capacity = 2) {
  const { host, a, b } = scene();
  for (const program of [edge, fibre, rod]) discover(host, a, program);
  const definitions = new Map(host.technology.recipes.map(recipe => [recipe.id, structuredClone(recipe)]));
  const calls: string[] = [];
  enableTechnologyCatalogue(host.technology, { committedThrough: host.technology.recipeCounter, memoryCapacity: capacity });
  bindTechnologyCatalogue(host.technology, {
    resolve(id, atTick) { calls.push(id); const recipe = definitions.get(id); return recipe && recipe.tick <= atTick ? structuredClone(recipe) : null; },
    findBySignature(signature, atTick) { const recipe = [...definitions.values()].find(recipe => recipe.signature === signature && recipe.tick <= atTick); return recipe ? structuredClone(recipe) : null; },
  });
  host.technology.budgets.maxRecipes = capacity;
  host.technology.recipes = host.technology.recipes.slice(-capacity);
  for (const actor of host.people) maintainTechnologyMemory(host, actor);
  return { host, a, b, definitions, calls };
}

test('a cold archive resolves known programs without teaching observers or stopping at a two-entry cache', () => {
  const { host, a, b, calls } = archiveScene();
  assert.deepEqual(a.technology.knownRecipes, ['recipe-2', 'recipe-3']);
  const unknown = structuredClone(b.technology);
  assert.equal(resolveTechnologyRecipe(host, 'recipe-1')!.id, 'recipe-1');
  assert.deepEqual(b.technology, unknown);
  assert.equal(craftTechnology(host, b, 'recipe-1'), false);
  assert.equal(shareTechnology(host, a, b, undefined, 'recipe-1'), false, 'an owned artifact cannot teach forgotten instructions');
  const before = host.technology.recipeCounter;
  const newProgram = { ...rod, steps: [{ op: 'form' as const, intensity: 3, shape: 'rod' as const }] };
  discover(host, a, newProgram);
  assert.equal(host.technology.recipeCounter, before + 1);
  assert.ok(proposeTechnologyProgram(host, a));
  host.tick += 50; assert.ok(technologyOpportunity(host, a));
  assert.ok(host.technology.recipes.length <= 2); assert.equal(a.technology.knownRecipes.length, 2);
  const view = projectTechnology(host); assert.equal(view.dynamics.recipes, 4); assert.equal(view.dynamics.programDiversity, 4);
  assert.equal(view.dynamics.massError, 0); assert.ok(view.recipes.length <= 2); assert.ok(calls.includes('recipe-1'));
  assertTechnology(host);
});

test('paid rediscovery preserves a cold definition identity, author, ancestry and date while updating totals once', () => {
  const { host, a, b, definitions } = archiveScene();
  const original = definitions.get('recipe-1')!, before = { counter: host.technology.recipeCounter, work: host.technology.ledger.work, stone: b.materials.stone, energy: b.energy };
  assert.equal(a.technology.knownRecipes.includes(original.id), false);
  const rediscovered = discover(host, b, edge);
  for (const key of ['id', 'signature', 'inventorId', 'tick', 'generation', 'parents'] as const) assert.deepEqual(rediscovered[key], original[key]);
  assert.equal(host.technology.recipeCounter, before.counter);
  assert.equal(host.technology.ledger.work - before.work, technologyWorkCost(edge));
  assert.equal(before.stone - b.materials.stone, 1); assert.ok(b.energy < before.energy);
  assert.deepEqual(b.technology.knownRecipes, [original.id]);
  assert.equal(rediscovered.manufactured, original.manufactured + 1);
  const receipt = useTool(host, b, 'cutting')!; recordTechnologyBenefit(host, b, receipt, 0.125);
  const observed = resolveTechnologyRecipe(host, original.id)!;
  assert.equal(observed.uses, original.uses + 1); assert.equal(observed.utility, original.utility + 0.125);
  assert.equal(projectTechnology(host).dynamics.observedUtility, 0.125);
  assert.equal(definitions.get(original.id)!.manufactured, original.manufactured, 'the archive baseline is immutable until the host commits its pending overlay');
  assertTechnology(host);
});

test('local teaching and craft refresh recency, pin paid projects and do not teach manufacturing ancestors', () => {
  const { host, a, b } = archiveScene();
  assert.equal(shareTechnology(host, a, b, undefined, 'recipe-2'), true);
  assert.equal(shareTechnology(host, a, b, undefined, 'recipe-3'), true);
  craftTechnology(host, b, 'recipe-2'); assert.deepEqual(b.technology.knownRecipes, ['recipe-3', 'recipe-2']);
  const project = b.technology.project!, paid = project.progress;
  discover(host, a, edge);
  const energy = a.energy;
  assert.equal(shareTechnology(host, a, b, undefined, 'recipe-1'), true);
  assert.deepEqual(b.technology.knownRecipes, ['recipe-2', 'recipe-1']);
  assert.equal(b.technology.project, project); assert.equal(project.progress, paid); assert.ok(a.energy < energy);
  assert.equal(b.technology.learnedFrom.some(entry => entry.recipeId === 'recipe-3'), false);
  assert.equal(finish(host, b), true);
  assert.equal(b.technology.knownRecipes.at(-1), 'recipe-2');
  assertTechnology(host);

  const descendantProgram: TechnologyProgram = { inputs: [{ source: 'product', recipeId: 'recipe-1', mass: 300 }, { source: 'raw', material: 'wood', mass: 1000 }], steps: [{ op: 'combine', intensity: 4 }, { op: 'form', intensity: 4, shape: 'rod' }] };
  const descendant = discover(host, a, descendantProgram, ['recipe-1']);
  assert.equal(shareTechnology(host, a, b, undefined, descendant.id), true);
  assert.equal(b.technology.knownRecipes.includes('recipe-1'), false);
  craftTechnology(host, b, descendant.id); // It cannot start until the traded substrate arrives.
  assert.equal(b.technology.project, null);
  assert.equal(transferTechnologyItem(host, a, b, a.technology.items.find(item => item.recipeId === 'recipe-1')!.id), true);
  craftTechnology(host, b, descendant.id); assert.equal(finish(host, b), true);
  assert.equal(b.technology.knownRecipes.includes('recipe-1'), false, 'resolving ancestry never teaches the manufacturing ancestor');
  assertTechnology(host);
});

test('all pinned research instructions reject an incoming lesson atomically until the paid project ends', () => {
  const { host, a, b } = archiveScene();
  for (const id of ['recipe-2', 'recipe-3']) assert.equal(shareTechnology(host, a, b, undefined, id), true);
  start(host, b, rod, ['recipe-2', 'recipe-3']); host.tick++; researchTechnology(host, b);
  discover(host, a, edge);
  const before = structuredClone(b.technology), energy = a.energy, work = host.technology.ledger.work;
  assert.equal(shareTechnology(host, a, b, undefined, 'recipe-1'), false);
  assert.deepEqual(b.technology, before); assert.equal(a.energy, energy); assert.equal(host.technology.ledger.work, work);
  assert.equal(cancelTechnologyProject(host, b), true);
  assert.equal(shareTechnology(host, a, b, undefined, 'recipe-1'), true);
  assert.deepEqual(b.technology.knownRecipes, ['recipe-3', 'recipe-1']); assertTechnology(host);
});

test('practice follows only local instructions, owned artifacts and active work, then disappears with the last support', () => {
  const { host, a, b } = archiveScene();
  const first = a.technology.items.find(item => item.recipeId === 'recipe-1')!;
  assert.equal(a.technology.knownRecipes.includes(first.recipeId!), false); assert.ok(a.technology.competence[first.recipeId!]);
  assert.equal(transferTechnologyItem(host, a, b, first.id), true);
  assert.equal(a.technology.competence[first.recipeId!], undefined); assert.deepEqual(b.technology.knownRecipes, []);
  const receipt = useTool(host, b, 'cutting')!; recordTechnologyBenefit(host, b, receipt, 0.2);
  assert.ok(b.technology.competence[first.recipeId!]);
  const last = useTool(host, b, 'cutting', 1_000_000)!; recordTechnologyBenefit(host, b, last, 0.01);
  assert.equal(b.technology.items.length, 0); assert.equal(b.technology.competence[first.recipeId!], undefined);
  assertTechnology(host);
});

test('recycling the last artifact also releases forgotten competence instead of accumulating a lifetime practice table', () => {
  const { host, a } = archiveScene();
  assert.ok(a.technology.competence['recipe-1']); assert.equal(a.technology.knownRecipes.includes('recipe-1'), false);
  host.technology.budgets.maxItems = 1;
  discover(host, a, { ...rod, steps: [{ op: 'form', intensity: 2, shape: 'rod' }] });
  assert.equal(a.technology.items.length, 1); assert.equal(host.technology.ledger.recycled, 3);
  assert.equal(a.technology.competence['recipe-1'], undefined);
  assert.ok(Object.keys(a.technology.competence).every(id => a.technology.knownRecipes.includes(id) || a.technology.items.some(item => item.recipeId === id)));
  assertTechnology(host);
});

test('real paid lineage exceeds generation 32 with bounded working memory and executable physical outputs', () => {
  const { host, a } = scene();
  enableTechnologyCatalogue(host.technology, { memoryCapacity: 2 });
  bindTechnologyCatalogue(host.technology, { resolve: () => null, findBySignature: () => null });
  host.technology.budgets.maxRecipes = 2;
  let parent: string | undefined;
  for (let index = 0; index < 40; index++) {
    const program: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }],
      steps: [0, 1, 2].map(digit => ({ op: 'cool', intensity: 1 + Math.floor(index / 4 ** digit) % 4 })) };
    const recipe = discover(host, a, program, parent ? [parent] : []);
    assert.equal(recipe.generation, index + 1); parent = recipe.id;
    assert.ok(a.technology.knownRecipes.length <= 2); assert.ok(host.technology.recipes.length <= 2);
    assert.ok(Object.keys(a.technology.competence).length <= a.technology.knownRecipes.length + a.technology.items.length);
    assertTechnology(host);
  }
  assert.equal(projectTechnology(host).dynamics.generations, 40); assert.equal(projectTechnology(host).dynamics.recipes, 40);
  assert.equal(projectTechnology(host).dynamics.massError, 0);
  craftTechnology(host, a, parent); assert.equal(finish(host, a), true);
  assert.equal(a.technology.items.at(-1)!.generation, 40); assertTechnology(host);
});

test('archive validation still rejects future references, missing ancestry and modified physical envelopes', () => {
  const cases = [
    (host: TechnologyHost, a: TechnologyActor) => { a.technology.items[0]!.madeAt = 0; },
    (host: TechnologyHost, a: TechnologyActor) => { a.technology.items[0]!.generation++; },
    (host: TechnologyHost, a: TechnologyActor) => { a.technology.knownRecipes.push('recipe-999'); },
    (host: TechnologyHost, a: TechnologyActor) => { a.technology.items[0]!.composition.stone++; },
    (host: TechnologyHost, a: TechnologyActor) => { start(host, a, edge, ['recipe-1']); },
  ];
  for (const corrupt of cases) { const { host, a } = archiveScene(); corrupt(host, a); assert.throws(() => assertTechnology(host)); }
  const { host, a } = archiveScene(); craftTechnology(host, a, 'recipe-2');
  const work = host.technology.ledger.work; assert.equal(cancelTechnologyProject(host, a), true);
  assert.equal(host.technology.ledger.work, work); assert.equal(a.technology.project, null); assertTechnology(host);
});

test('pending definitions retain full physical validation after cache eviction', () => {
  const { host, a } = scene();
  enableTechnologyCatalogue(host.technology, { memoryCapacity: 2 });
  bindTechnologyCatalogue(host.technology, { resolve: () => null, findBySignature: () => null });
  host.technology.budgets.maxRecipes = 2;
  for (const program of [edge, fibre, rod]) discover(host, a, program);
  assert.equal(host.technology.recipes.some(recipe => recipe.id === 'recipe-1'), false);
  host.technology.catalogue!.pending.find(recipe => recipe.id === 'recipe-1')!.program.steps[0]!.intensity = 5;
  assert.throws(() => assertTechnology(host), /tecnología/);
});

test('an impossible parent generation cannot overflow a new identity or withdraw physical stock', () => {
  const { host, a } = archiveScene();
  const parent = resolveTechnologyRecipe(host, 'recipe-3')!;
  parent.generation = Number.MAX_SAFE_INTEGER; // Deliberate invalid input, never evidence of a real lineage.
  const materials = structuredClone(a.materials), counter = host.technology.recipeCounter, stock = structuredClone(a.technology.items);
  start(host, a, { ...rod, steps: [{ op: 'form', intensity: 1, shape: 'rod' }] }, [parent.id]);
  assert.throws(() => finish(host, a), /safe generation limit/);
  assert.equal(host.technology.recipeCounter, counter); assert.deepEqual(a.materials, materials); assert.deepEqual(a.technology.items, stock);
});
