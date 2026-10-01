import test from 'node:test';
import assert from 'node:assert/strict';
import type { MaterialBatch, TechnologyRecipe } from '../src/shared/technology.js';
import { admitsRecipePowerPruning, cooperationPruningActive, probeCooperationPruning, withCooperationPruning } from '../src/world/cooperation-pruning.js';
import { cooperationOpportunity } from '../src/world/society.js';
import { CAPABILITIES } from '../src/world/technology.js';
import { bindTechnologyCatalogue, enableTechnologyCatalogue } from '../src/world/technology-catalogue.js';
import { aula } from './lib/escenas.js';

const powers = (value = 0) => ({ cutting: value, storage: value, insulation: value, cultivation: value, binding: value, abrasion: value });
function instruction(id: number, value: number): TechnologyRecipe {
  return { id: `recipe-${id}`, name: `Instruction ${id}`, capacities: powers(value), program: { inputs: [], steps: [] },
    signature: `signature-${id}`, parents: [], generation: 1, inventorId: 'inventor', tick: 0, x: 0, y: 0,
    novelty: 'both', manufactured: 0, uses: 0, utility: 0 };
}
function boundary() {
  const remembered = [instruction(1, 0.6), instruction(2, 0.4)], candidates = [instruction(3, 0.9)];
  const learner = { action: 'rest', technology: { residue: { wood: 0, stone: 0, water: 0 }, project: null } };
  const items: MaterialBatch[] = [], raw = { wood: 0, stone: 0, water: 0 }, physical = powers(), masses = new Map();
  const admits = () => admitsRecipePowerPruning(remembered, candidates, learner, items, raw, physical, masses, CAPABILITIES);
  return { remembered, candidates, learner, items, raw, physical, masses, admits };
}
function scene() {
  const { world, maestro, aprendiz } = aula({ cuerpo: { energy: 1, fatigue: 0, hunger: 0.1, thirst: 0.1 } });
  world.technology.recipes = [instruction(1, 0.6), instruction(2, 0.4), instruction(3, 0.9)];
  world.technology.recipeCounter = 3;
  maestro.technology.knownRecipes = ['recipe-3']; maestro.technology.competence['recipe-3'] = { attempts: 1, successes: 1, work: 1, benefit: 0.2 };
  aprendiz.technology.knownRecipes = ['recipe-1', 'recipe-2'];
  return { world, maestro, aprendiz };
}
function archiveScene(action: 'rest' | 'craft', effect?: (state: ReturnType<typeof scene>, id: string) => void) {
  const state = scene(); state.aprendiz.action = action;
  const definitions = new Map(state.world.technology.recipes.map(recipe => [recipe.id, recipe]));
  enableTechnologyCatalogue(state.world.technology, { committedThrough: 3, memoryCapacity: 1 });
  state.world.technology.budgets.maxRecipes = 1; state.world.technology.recipes = [];
  const calls: string[] = [];
  bindTechnologyCatalogue(state.world.technology, {
    freshCopies: true,
    resolve(id, tick) { calls.push(`${id}@${tick}`); effect?.(state, id); return definitions.get(id) ?? null; },
    findBySignature: () => null,
  });
  return { ...state, definitions, calls };
}
const describe = (value: ReturnType<typeof cooperationOpportunity>) => value && { person: value.person.id, kind: value.kind, recipeId: value.recipeId, score: value.score };

test('the engine route activates real dominated pruning and preserves the old outcome and world', () => {
  const old = scene(), next = scene();
  const before = structuredClone(next.world);
  const expected = cooperationOpportunity(old.world, old.maestro);
  const result = probeCooperationPruning(next.world, () => cooperationOpportunity(next.world, next.maestro));
  assert.deepEqual(describe(result.value), describe(expected));
  assert.equal(result.value?.recipeId, 'recipe-3');
  assert.equal(result.diagnostics.pairs, 1); assert.equal(result.diagnostics.admittedPairs, 1);
  assert.equal(result.diagnostics.known, 2); assert.equal(result.diagnostics.checked, 1); assert.equal(result.diagnostics.pruned, 1);
  assert.deepEqual(next.world, before); assert.deepEqual(next.world, old.world);
  assert.equal(cooperationPruningActive(next.world), false);
});

test('synthetic operation counts retain repeated raw/residue/products/fuel/catalysts while pruning dominated known work', () => {
  function largeScene() {
    const state = scene();
    state.world.technology.recipes = Array.from({ length: 41 }, (_, index) => instruction(index + 1, index === 40 ? 0.9 : index ? 0.4 : 0.6));
    state.world.technology.recipeCounter = 41;
    state.maestro.technology.knownRecipes = ['recipe-41']; state.maestro.technology.competence = { 'recipe-41': { attempts: 1, successes: 1, work: 1, benefit: 0.2 } };
    state.aprendiz.technology.knownRecipes = state.world.technology.recipes.slice(0, 40).map(recipe => recipe.id);
    state.aprendiz.materials.wood = 1; state.aprendiz.technology.residue.wood = 100_000;
    state.aprendiz.technology.items = [{ id: 'ingredient-item', recipeId: 'ingredient', mass: 1000, initialMass: 1000,
      composition: { wood: 0, stone: 1000, water: 0 }, generation: 1, madeAt: 0, parentItems: [],
      properties: { hardness: 1, toughness: 0, porosity: 0, flexibility: 0, edge: 1, containment: 0,
        insulation: 0, leverage: 0, cohesion: 1, temperature: 0, alignment: 0, firing: 0 } }];
    for (const recipe of state.world.technology.recipes) {
      recipe.program.inputs = [{ source: 'raw', material: 'wood', mass: 1 }, { source: 'raw', material: 'wood', mass: 1 },
        { source: 'raw', material: 'stone', mass: 1 }, { source: 'raw', material: 'stone', mass: 1 },
        { source: 'residue', material: 'wood', mass: 2 }, { source: 'residue', material: 'wood', mass: 2 },
        { source: 'product', recipeId: 'ingredient', mass: 2 }, { source: 'product', recipeId: 'ingredient', mass: 2 }];
      recipe.program.steps = [{ op: 'heat', intensity: 1 }, { op: 'heat', intensity: 1 },
        { op: 'form', intensity: 1, requiredCatalyst: 'cutting' }, { op: 'form', intensity: 1, requiredCatalyst: 'cutting' }];
    }
    return state;
  }
  const old = largeScene(), next = largeScene();
  const expected = cooperationOpportunity(old.world, old.maestro);
  const result = probeCooperationPruning(next.world, () => cooperationOpportunity(next.world, next.maestro));
  assert.equal(result.value?.recipeId, 'recipe-41'); assert.deepEqual(describe(result.value), describe(expected));
  assert.deepEqual(next.world, old.world);
  assert.deepEqual(result.diagnostics, { pairs: 1, admittedPairs: 1, known: 40, admittedKnown: 40,
    checked: 1, admittedChecked: 1, pruned: 39, unavailable: 0, inputsChecked: 8, stepsChecked: 4, inputsPruned: 312, stepsPruned: 156, rejections: {} });
});

test('plain archive copies and earlier reader mutations preserve all calls and final LRU', () => {
  const effect = (state: ReturnType<typeof scene>, id: string) => {
    if (id === 'recipe-2') { state.aprendiz.technology.residue.wood = 250; state.aprendiz.materials.wood = 3; }
  };
  const old = archiveScene('rest', effect), next = archiveScene('rest', effect);
  const expected = cooperationOpportunity(old.world, old.maestro);
  const result = probeCooperationPruning(next.world, () => cooperationOpportunity(next.world, next.maestro));
  assert.equal(result.diagnostics.admittedPairs, 1);
  assert.deepEqual(describe(result.value), describe(expected)); assert.deepEqual(next.calls, old.calls);
  assert.deepEqual(next.world.technology.recipes, old.world.technology.recipes);
  assert.deepEqual(next.world, old.world);
});

test('craft without a project keeps original requested resolves and product-mass memo warming', () => {
  const old = archiveScene('craft'), next = archiveScene('craft');
  const expected = cooperationOpportunity(old.world, old.maestro);
  const result = probeCooperationPruning(next.world, () => cooperationOpportunity(next.world, next.maestro));
  assert.equal(result.diagnostics.admittedPairs, 0); assert.equal(result.diagnostics.pruned, 0);
  assert.deepEqual(describe(result.value), describe(expected)); assert.deepEqual(next.calls, old.calls);
  assert.ok(next.calls.length >= 5, 'the original repeated known recipe resolutions are not drained or reused');
  assert.deepEqual(next.world, old.world);
});

test('a requested reader changing stock still observes product masses warmed by a dominated known recipe', () => {
  function stockScene() {
    let reads = 0;
    const state = archiveScene('craft', (scene, id) => {
      if (id === 'recipe-2' && ++reads === 3) scene.aprendiz.technology.items[0]!.mass = 0;
    });
    const item: MaterialBatch = { id: 'ingredient-item', recipeId: 'ingredient', mass: 1000, initialMass: 1000,
      composition: { wood: 0, stone: 1000, water: 0 }, generation: 1, madeAt: 0, parentItems: [],
      properties: { hardness: 0, toughness: 0, porosity: 0, flexibility: 0, edge: 0, containment: 0,
        insulation: 0, leverage: 0, cohesion: 0, temperature: 0, alignment: 0, firing: 0 } };
    state.aprendiz.technology.items = [item];
    for (const id of ['recipe-2', 'recipe-3']) state.definitions.get(id)!.program.inputs = [{ source: 'product', recipeId: 'ingredient', mass: 1000 }];
    return state;
  }
  const old = stockScene(), next = stockScene();
  const expected = cooperationOpportunity(old.world, old.maestro);
  const result = probeCooperationPruning(next.world, () => cooperationOpportunity(next.world, next.maestro));
  assert.equal(expected?.recipeId, 'recipe-3', 'the original candidate sees the earlier warm mass even after requested mutates the item');
  assert.equal(next.aprendiz.technology.items[0]!.mass, 0);
  assert.equal(result.diagnostics.rejections['requested-reader'], 1);
  assert.equal(result.diagnostics.admittedPairs, 0);
  assert.deepEqual(describe(result.value), describe(expected)); assert.deepEqual(next.calls, old.calls);
  assert.deepEqual(next.world, old.world);
});

test('admission never executes data getters, and rejects proxies before any reflection traps', () => {
  const row = boundary(); let reads = 0, traps = 0;
  Object.defineProperty(row.remembered[1]!.capacities, 'cutting', { get() { reads++; throw new Error('getter'); } });
  assert.equal(row.admits(), false); assert.equal(reads, 0);
  const other = boundary();
  other.remembered[1]!.program = new Proxy(other.remembered[1]!.program, {
    get() { traps++; throw new Error('get'); }, getPrototypeOf() { traps++; throw new Error('prototype'); },
    getOwnPropertyDescriptor() { traps++; throw new Error('descriptor'); },
  });
  assert.equal(other.admits(), false); assert.equal(traps, 0);
});

test('rejection does not perform IteratorClose or read a decorated iterator return', () => {
  const row = boundary(); Object.defineProperty(row.remembered[0]!.program.inputs, 'constructor', { value: 0 });
  const iterator = Object.getPrototypeOf([][Symbol.iterator]()), previous = Object.getOwnPropertyDescriptor(iterator, 'return');
  let returns = 0;
  Object.defineProperty(iterator, 'return', { configurable: true, get() { returns++; throw new Error('unexpected admission close'); } });
  try { assert.equal(row.admits(), false); assert.equal(returns, 0); }
  finally { if (previous) Object.defineProperty(iterator, 'return', previous); else delete iterator.return; }
});

test('iterator return descriptors and changed prototype chains reject without getters or proxy traps', () => {
  const row = boundary(), iterator = Object.getPrototypeOf([][Symbol.iterator]()), parent = Object.getPrototypeOf(iterator);
  const chain = [iterator, parent, Object.prototype];
  for (let index = 0; index < chain.length; index++) {
    const target = chain[index]!, previous = Object.getOwnPropertyDescriptor(target, 'return');
    let reads = 0, admitted;
    Object.defineProperty(target, 'return', { configurable: true, get() { reads++; throw new Error('iterator return getter'); } });
    try { admitted = row.admits(); }
    finally { if (previous) Object.defineProperty(target, 'return', previous); else delete target.return; }
    assert.equal(admitted, false); assert.equal(reads, 0);
  }
  let traps = 0;
  const layer = new Proxy(parent, {
    getPrototypeOf() { traps++; throw new Error('iterator prototype'); },
    getOwnPropertyDescriptor() { traps++; throw new Error('iterator descriptor'); },
    get() { traps++; throw new Error('iterator lookup'); },
  });
  let admitted;
  Object.setPrototypeOf(iterator, layer);
  try { admitted = row.admits(); }
  finally { Object.setPrototypeOf(iterator, parent); }
  assert.equal(admitted, false); assert.equal(traps, 0);
  const previous = Object.getOwnPropertyDescriptor(iterator, 'return');
  Object.defineProperty(iterator, 'return', { configurable: true, value: undefined });
  try { admitted = row.admits(); }
  finally { if (previous) Object.defineProperty(iterator, 'return', previous); else delete iterator.return; }
  assert.equal(admitted, true, 'a data undefined return has no callback or getter to omit');
});

test('product destructuring preserves inherited iterator return effects, outcome, resolves and LRU', () => {
  function run(prune: boolean) {
    const state = archiveScene('rest');
    state.aprendiz.technology.residue.wood = 1;
    for (const id of ['recipe-2', 'recipe-3']) state.definitions.get(id)!.program.inputs = [{ source: 'product', recipeId: 'recipe-1', mass: 1 }];
    state.definitions.get('recipe-3')!.program.inputs.push({ source: 'residue', material: 'wood', mass: 1 });
    state.aprendiz.technology.items = [{ id: 'product-1', recipeId: 'recipe-1', mass: 1000, initialMass: 1000,
      composition: { wood: 0, stone: 1000, water: 0 }, generation: 1, madeAt: 0, parentItems: [],
      properties: { hardness: 0, toughness: 0, porosity: 0, flexibility: 0, edge: 0, containment: 0,
        insulation: 0, leverage: 0, cohesion: 0, temperature: 0, alignment: 0, firing: 0 } }];
    const iterator = Object.getPrototypeOf([][Symbol.iterator]()), previous = Object.getOwnPropertyDescriptor(iterator, 'return');
    const events: string[] = []; let result;
    Object.defineProperty(iterator, 'return', { configurable: true, get() {
      events.push('return:residue.wood=0'); state.aprendiz.technology.residue.wood = 0; return undefined;
    } });
    try { result = prune ? withCooperationPruning(state.world, () => cooperationOpportunity(state.world, state.maestro)) : cooperationOpportunity(state.world, state.maestro); }
    finally { if (previous) Object.defineProperty(iterator, 'return', previous); else delete iterator.return; }
    return { outcome: describe(result), events, calls: state.calls, world: state.world };
  }
  const old = run(false), next = run(true);
  assert.equal(old.outcome, undefined); assert.deepEqual(old.events, ['return:residue.wood=0']);
  assert.deepEqual(next, old);
});

test('prefilled product-mass memo keeps legacy coercions, result, resolve trace and LRU', () => {
  function run(prune: boolean) {
    const state = scene(); state.aprendiz.action = 'rest';
    for (const recipe of state.world.technology.recipes.slice(1)) recipe.program.inputs = [{ source: 'product', recipeId: 'ingredient', mass: 1 }];
    const NativeMap = Map, definitions = new NativeMap(state.world.technology.recipes.map(recipe => [recipe.id, recipe]));
    enableTechnologyCatalogue(state.world.technology, { committedThrough: 3, memoryCapacity: 1 });
    state.world.technology.budgets.maxRecipes = 1; state.world.technology.recipes = [];
    let memo: Map<unknown, unknown> | undefined, coercions = 0;
    const calls: string[] = [];
    bindTechnologyCatalogue(state.world.technology, { freshCopies: true, resolve(id, tick) {
      calls.push(`${id}@${tick}`);
      if (id === 'recipe-2') {
        globalThis.Map = NativeMap;
        assert.ok(memo);
        memo.set('ingredient', { valueOf() { coercions++; return coercions === 1 ? 1000 : 0; } });
      }
      return definitions.get(id) ?? null;
    }, findBySignature: () => null });
    function CapturingMap(...args: unknown[]) {
      const value = Reflect.construct(NativeMap, args, NativeMap) as Map<unknown, unknown>;
      if (!args.length && new Error().stack?.includes('localRecipeInputs')) memo = value;
      return value;
    }
    CapturingMap.prototype = NativeMap.prototype; globalThis.Map = CapturingMap as unknown as typeof Map;
    let result;
    try { result = prune ? withCooperationPruning(state.world, () => cooperationOpportunity(state.world, state.maestro)) : cooperationOpportunity(state.world, state.maestro); }
    finally { globalThis.Map = NativeMap; }
    return { outcome: describe(result), coercions, calls, window: state.world.technology.recipes.map(recipe => recipe.id) };
  }
  const old = run(false), next = run(true);
  assert.equal(old.outcome, undefined); assert.equal(old.coercions, 2);
  assert.deepEqual(next, old);
});

test('function prototype proxies see no new metadata access in either public or engine routes', () => {
  for (const prune of [false, true]) {
    const state = scene(), parent = Object.getPrototypeOf(Function.prototype);
    let symbols = 0;
    const layer = new Proxy(parent, {
      get(target, key, receiver) { if (typeof key === 'symbol') { symbols++; throw new Error('new inherited metadata get'); } return Reflect.get(target, key, receiver); },
      set(target, key, value, receiver) { if (typeof key === 'symbol') { symbols++; throw new Error('new inherited metadata set'); } return Reflect.set(target, key, value, receiver); },
    });
    Object.setPrototypeOf(Function.prototype, layer);
    try {
      const result = prune ? withCooperationPruning(state.world, () => cooperationOpportunity(state.world, state.maestro)) : cooperationOpportunity(state.world, state.maestro);
      assert.equal(result?.recipeId, 'recipe-3'); assert.equal(symbols, 0);
    } finally { Object.setPrototypeOf(Function.prototype, parent); }
  }
});

test('all mutable closure nodes, candidate/project programs and sparse/decorated arrays are guarded', () => {
  for (const alter of [
    (row: ReturnType<typeof boundary>) => { Object.defineProperty(row.learner, 'technology', { get() { throw new Error('technology'); } }); },
    (row: ReturnType<typeof boundary>) => { Object.defineProperty(row.learner.technology, 'residue', { get() { throw new Error('residue'); } }); },
    (row: ReturnType<typeof boundary>) => { Object.defineProperty(row.learner.technology.residue, 'wood', { get() { throw new Error('wood'); } }); },
    (row: ReturnType<typeof boundary>) => { row.items.push({ recipeId: 'recipe-1', get mass(): number { throw new Error('mass'); } } as MaterialBatch); },
    (row: ReturnType<typeof boundary>) => { Object.defineProperty(row.candidates[0]!, 'id', { get() { throw new Error('id'); } }); },
    (row: ReturnType<typeof boundary>) => { row.remembered[0]!.program.inputs.length = 1; },
    (row: ReturnType<typeof boundary>) => { Object.defineProperty(row.remembered[0]!.program.steps, Symbol.iterator, { get() { throw new Error('iterator'); } }); },
    (row: ReturnType<typeof boundary>) => { row.remembered[0]!.program.inputs.push({ source: 'raw', material: 'other' as 'wood', mass: 1 }); },
    (row: ReturnType<typeof boundary>) => { Object.defineProperty(row.masses, 'get', { get() { throw new Error('memo'); } }); },
  ]) { const row = boundary(); alter(row); assert.equal(row.admits(), false); }
  const row = boundary();
  row.learner.action = 'research'; row.learner.technology.project = { get program() { throw new Error('project'); } } as never;
  assert.equal(row.admits(), false);
});

test('decorated intrinsics fail admission without invoking the replacement, including iterator next and species', () => {
  const row = boundary(), arrayIterator = Object.getPrototypeOf([][Symbol.iterator]()), mapIterator = Object.getPrototypeOf(new Map()[Symbol.iterator]());
  const cases: [object, PropertyKey][] = [[Math, 'max'], [Object, 'is'], [Object, 'fromEntries'], [Array, 'isArray'],
    [Array.prototype, 'every'], [Array.prototype, 'map'], [Array.prototype, 'reduce'], [Array.prototype, 'filter'], [Array.prototype, 'some'],
    [Array.prototype, Symbol.iterator], [arrayIterator, 'next'], [Map.prototype, 'get'], [Map.prototype, 'set'], [Map.prototype, Symbol.iterator], [mapIterator, 'next']];
  for (let index = 0; index < cases.length; index++) {
    const [target, key] = cases[index]!, previous = Object.getOwnPropertyDescriptor(target, key)!; let invoked = 0;
    Object.defineProperty(target, key, { configurable: true, get() { invoked++; throw new Error('intrinsic getter'); } });
    try { assert.equal(row.admits(), false); assert.equal(invoked, 0); }
    finally { Object.defineProperty(target, key, previous); }
  }
  const previous = Object.getOwnPropertyDescriptor(Array, Symbol.species)!; let invoked = 0;
  Object.defineProperty(Array, Symbol.species, { configurable: true, get() { invoked++; throw new Error('species'); } });
  try { assert.equal(row.admits(), false); assert.equal(invoked, 0); }
  finally { Object.defineProperty(Array, Symbol.species, previous); }
});

test('public oldroute preserves getter exceptions and decorated Math.max traces exactly', () => {
  const compare = (prune: boolean) => {
    const state = scene(); const events: string[] = [], original = Math.max;
    Math.max = (...values) => { events.push(values.map(String).join(',')); return original(...values); };
    try { return { outcome: describe(prune ? withCooperationPruning(state.world, () => cooperationOpportunity(state.world, state.maestro)) : cooperationOpportunity(state.world, state.maestro)), events }; }
    finally { Math.max = original; }
  };
  assert.deepEqual(compare(true), compare(false));
  for (const prune of [false, true]) {
    const state = scene(), failure = new Error('original program getter'), events: string[] = [];
    Object.defineProperty(state.world.technology.recipes[1]!, 'program', { get() { events.push('program'); throw failure; } });
    assert.throws(() => prune ? withCooperationPruning(state.world, () => cooperationOpportunity(state.world, state.maestro)) : cooperationOpportunity(state.world, state.maestro), error => error === failure);
    assert.deepEqual(events, ['program']); assert.equal(cooperationPruningActive(state.world), false);
  }
});

test('nested activation and throwing resolution clean up before the next pair and next step', () => {
  const state = archiveScene('rest'); const failure = new Error('reader failed');
  bindTechnologyCatalogue(state.world.technology, { resolve() { throw failure; }, findBySignature: () => null });
  assert.throws(() => withCooperationPruning(state.world, () => withCooperationPruning(state.world, () => cooperationOpportunity(state.world, state.maestro))), error => error === failure);
  assert.equal(cooperationPruningActive(state.world), false);
  const plain = scene();
  withCooperationPruning(plain.world, () => { withCooperationPruning(plain.world, () => assert.equal(cooperationPruningActive(plain.world), true)); assert.equal(cooperationPruningActive(plain.world), true); });
  assert.equal(cooperationPruningActive(plain.world), false);
  assert.equal(cooperationOpportunity(plain.world, plain.maestro)?.recipeId, 'recipe-3');
});
