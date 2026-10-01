import { types } from 'node:util';
import type { Capability, MaterialBatch, TechnologyRecipe } from '../shared/technology.js';
import type { World } from './index.js';

// This server-only module starts in the native Node realm. Inspect descriptors
// instead of reading methods: an accessor replacing an intrinsic must not run
// before the original availability path does. isProxy rejects before reflection.
const isProxy = types.isProxy, isMap = types.isMap, own = Object.getOwnPropertyDescriptor, proto = Object.getPrototypeOf;
const hasOwn = Object.hasOwn, objectPrototype = Object.prototype, arrayPrototype = Array.prototype;
const nativeObject = Object, nativeArray = Array, nativeMath = Math, nativeMap = Map;
const isArray = Array.isArray;
const mapPrototype = Map.prototype;
const arrayIteratorPrototype = proto([][Symbol.iterator]());
const mapIteratorPrototype = proto(new Map()[Symbol.iterator]());
const iteratorPrototype = proto(arrayIteratorPrototype);
const intrinsics = [
  [globalThis, 'Object', nativeObject], [globalThis, 'Array', nativeArray],
  [globalThis, 'Math', nativeMath], [globalThis, 'Map', nativeMap],
  [nativeMath, 'max', Math.max], [nativeObject, 'is', Object.is],
  [nativeObject, 'fromEntries', Object.fromEntries], [nativeArray, 'isArray', isArray],
  ...(['map', 'filter', 'reduce', 'every', 'some', 'includes'] as const).map(key => [arrayPrototype, key, arrayPrototype[key]]),
  [arrayPrototype, Symbol.iterator, arrayPrototype[Symbol.iterator]],
  [arrayPrototype, 'constructor', nativeArray],
  [arrayIteratorPrototype, 'next', arrayIteratorPrototype.next],
  [mapPrototype, 'get', mapPrototype.get], [mapPrototype, 'set', mapPrototype.set],
  [mapPrototype, Symbol.iterator, mapPrototype[Symbol.iterator]],
  [mapIteratorPrototype, 'next', mapIteratorPrototype.next],
] as readonly (readonly [object, PropertyKey, unknown])[];
const species = own(nativeArray, Symbol.species)!;
const nativeMapSize = own(mapPrototype, 'size')!.get!, apply = Reflect.apply;
const rejected = Symbol('unadmitted cooperation data');
const keys: readonly Capability[] = ['cutting', 'storage', 'insulation', 'cultivation', 'binding', 'abrasion'];
const active = new WeakSet<World>();
const activeHas = active.has.bind(active), activeAdd = active.add.bind(active), activeDelete = active.delete.bind(active);
export interface CooperationPruningDiagnostics {
  pairs: number; admittedPairs: number; known: number; admittedKnown: number;
  checked: number; admittedChecked: number; pruned: number; unavailable: number;
  inputsChecked: number; stepsChecked: number; inputsPruned: number; stepsPruned: number;
  rejections: Partial<Record<PruningRejection, number>>;
}
export type PruningRejection = 'intrinsics' | 'capabilities' | 'collections' | 'learner' | 'stock'
  | 'requested-reader' | 'requested-program' | 'memo' | 'items' | 'definitions' | 'candidates';
const probes = new WeakMap<World, CooperationPruningDiagnostics>();
const probeGet = probes.get.bind(probes), probeSet = probes.set.bind(probes), probeDelete = probes.delete.bind(probes);

/** External, opt-in counts only; nothing is added to the world or saved/logged.
 * A new probe owns its ordinary counters and returns them after evaluation. */
export function probeCooperationPruning<T>(world: World, evaluate: () => T): { value: T; diagnostics: CooperationPruningDiagnostics } {
  const previous = probeGet(world);
  const diagnostics: CooperationPruningDiagnostics = {
    pairs: 0, admittedPairs: 0, known: 0, admittedKnown: 0, checked: 0, admittedChecked: 0, pruned: 0, unavailable: 0,
    inputsChecked: 0, stepsChecked: 0, inputsPruned: 0, stepsPruned: 0, rejections: {},
  };
  probeSet(world, diagnostics);
  try { return { value: withCooperationPruning(world, evaluate), diagnostics }; }
  finally { if (previous) probeSet(world, previous); else probeDelete(world); }
}
export function cooperationPruningDiagnostics(world: World): CooperationPruningDiagnostics | undefined { return probeGet(world); }

/** Only the engine's synchronous people phase opts in. No certificate, stocks or
 * powers survive a pair; nested calls preserve the previous activation on throw. */
export function withCooperationPruning<T>(world: World, evaluate: () => T): T {
  const previous = activeHas(world);
  activeAdd(world);
  try { return evaluate(); } finally { if (!previous) activeDelete(world); }
}
export function cooperationPruningActive(world: World): boolean { return activeHas(world); }

function ordinary(value: unknown): value is Record<PropertyKey, unknown> {
  if (value === null || typeof value !== 'object' || isProxy(value)) return false;
  const parent = proto(value);
  return parent === objectPrototype || parent === null;
}
/** Missing optional fields are safe only with no inherited lookup to execute. */
function field(value: object, key: PropertyKey, optional = false): unknown {
  const descriptor = own(value, key);
  if (descriptor) return hasOwn(descriptor, 'value') ? descriptor.value : rejected;
  const parent = proto(value);
  return optional && (parent === null || parent === objectPrototype && !own(objectPrototype, key)) ? undefined : rejected;
}
function unchanged(value: object, key: PropertyKey, expected: unknown): boolean {
  const descriptor = own(value, key);
  return !!descriptor && hasOwn(descriptor, 'value') && descriptor.value === expected;
}
function nativeBoundary(): boolean {
  // Destructuring a Map entry closes its two-element Array iterator even when
  // next is native. Keep its complete lookup chain native and inspect return
  // as a descriptor: an inherited getter/callback would make omission visible.
  if (isProxy(arrayIteratorPrototype) || isProxy(mapIteratorPrototype) || isProxy(iteratorPrototype)
    || isProxy(objectPrototype) || proto(arrayIteratorPrototype) !== iteratorPrototype
    || proto(mapIteratorPrototype) !== iteratorPrototype || proto(iteratorPrototype) !== objectPrototype
    || proto(objectPrototype) !== null) return false;
  const iteratorChain = [arrayIteratorPrototype, mapIteratorPrototype, iteratorPrototype, objectPrototype];
  for (let index = 0; index < iteratorChain.length; index++) {
    const descriptor = own(iteratorChain[index]!, 'return');
    if (descriptor && (!hasOwn(descriptor, 'value') || descriptor.value !== undefined)) return false;
  }
  for (let index = 0; index < intrinsics.length; index++) {
    const row = intrinsics[index]!;
    if (!unchanged(row[0], row[1], row[2])) return false;
  }
  const current = own(nativeArray, Symbol.species);
  return !!current && !hasOwn(current, 'value') && current.get === species.get && current.set === species.set;
}
function denseArray(value: unknown): value is unknown[] {
  if (value === null || typeof value !== 'object' || isProxy(value) || !isArray(value) || proto(value) !== arrayPrototype) return false;
  const methods = ['constructor', 'map', 'filter', 'reduce', 'every', 'some', 'includes', Symbol.iterator] as const;
  for (let index = 0; index < methods.length; index++) {
    const key = methods[index]!;
    const descriptor = own(value, key);
    if (descriptor && (!hasOwn(descriptor, 'value') || descriptor.value !== own(arrayPrototype, key)!.value)) return false;
  }
  const length = field(value, 'length');
  if (typeof length !== 'number') return false;
  for (let index = 0; index < length; index++) {
    const descriptor = own(value, '' + index);
    if (!descriptor || !hasOwn(descriptor, 'value')) return false;
  }
  return true;
}
function coordinates(value: unknown): boolean {
  return ordinary(value) && keys.every(key => typeof field(value, key) === 'number');
}
function materials(value: unknown): boolean {
  return ordinary(value) && ['wood', 'stone', 'water'].every(key => typeof field(value, key) === 'number');
}
function programData(value: unknown): boolean {
  if (!ordinary(value)) return false;
  const inputs = field(value, 'inputs'), steps = field(value, 'steps');
  if (!denseArray(inputs) || !denseArray(steps)) return false;
  for (let index = 0; index < inputs.length; index++) {
    const input = inputs[index];
    if (!ordinary(input) || typeof field(input, 'mass') !== 'number') return false;
    const source = field(input, 'source');
    if (source === 'product') { if (typeof field(input, 'recipeId') !== 'string') return false; }
    else if (source === 'raw' || source === 'residue') {
      const material = field(input, 'material');
      if (material !== 'wood' && material !== 'stone' && material !== 'water') return false;
    } else return false;
  }
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (!ordinary(step) || typeof field(step, 'op') !== 'string') return false;
    if (field(step, 'op') === 'heat' && typeof field(step, 'intensity') !== 'number') return false;
    const catalyst = field(step, 'requiredCatalyst', true);
    if (catalyst !== undefined && (typeof catalyst !== 'string' || !keys.includes(catalyst as Capability))) return false;
  }
  return true;
}

/**
 * Called AFTER every remembered resolve and BEFORE the old filter. No values are
 * obtained through getters; no validation is advanced and false takes the exact
 * old route. Covers only the complete graph still read by localRecipeInputs and
 * the powers fold. An arbitrary reader may have changed it earlier: those changes
 * are already visible to both routes, and no reader runs during the pure fold.
 */
export function recipePowerPruningRejection(
  remembered: readonly TechnologyRecipe[], candidates: readonly TechnologyRecipe[], learner: unknown, items: readonly MaterialBatch[],
  raw: unknown, physicalPowers: unknown, massByRecipe: unknown, capabilities: readonly Capability[],
): PruningRejection | undefined {
  if (!nativeBoundary()) return 'intrinsics';
  if (!denseArray(capabilities) || capabilities.length !== keys.length
    || !keys.every((key, index) => capabilities[index] === key)) return 'capabilities';
  if (!denseArray(remembered) || !denseArray(candidates)) return 'collections';
  if (!ordinary(learner)) return 'learner';
  if (!denseArray(items) || !materials(raw) || !coordinates(physicalPowers)) return 'stock';
  const knowledge = field(learner, 'technology');
  if (!ordinary(knowledge) || !materials(field(knowledge, 'residue'))) return 'learner';
  const action = field(learner, 'action'), project = field(knowledge, 'project');
  if (typeof action !== 'string' || project === rejected) return 'learner';
  // The original known filter warms its product-mass memo. A later requested
  // resolve can mutate stock and make that warming observable, so keep oldroute.
  if (action === 'craft' && !project) return 'requested-reader';
  if ((action === 'craft' || action === 'research') && project
    && (!ordinary(project) || !programData(field(project, 'program')))) return 'requested-program';
  if (massByRecipe === null || typeof massByRecipe !== 'object' || isProxy(massByRecipe)
    || !isMap(massByRecipe) || proto(massByRecipe) !== mapPrototype) return 'memo';
  // A temporarily decorated constructor can expose and prefill this otherwise
  // private Map before a reader restores the native constructor. Reject all
  // prefilled values without coercing them or inspecting their definitions.
  if (apply(nativeMapSize, massByRecipe, []) !== 0) return 'memo';
  const methods = ['get', 'set'] as const;
  for (let index = 0; index < methods.length; index++) {
    const key = methods[index]!;
    const descriptor = own(massByRecipe, key);
    if (descriptor && (!hasOwn(descriptor, 'value') || descriptor.value !== own(mapPrototype, key)!.value)) return 'memo';
  }
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!ordinary(item) || typeof field(item, 'mass') !== 'number') return 'items';
    const id = field(item, 'recipeId');
    if (id !== null && typeof id !== 'string') return 'items';
  }
  for (let index = 0; index < remembered.length; index++) {
    const recipe = remembered[index];
    if (!ordinary(recipe) || !coordinates(field(recipe, 'capacities')) || !programData(field(recipe, 'program'))) return 'definitions';
  }
  // Availability/gain/dependencies must stay pure until the memo's last use.
  for (let index = 0; index < candidates.length; index++) {
    const recipe = candidates[index];
    if (!ordinary(recipe) || typeof field(recipe, 'id') !== 'string'
      || !coordinates(field(recipe, 'capacities')) || !programData(field(recipe, 'program'))) return 'candidates';
  }
  return undefined;
}
export function admitsRecipePowerPruning(
  remembered: readonly TechnologyRecipe[], candidates: readonly TechnologyRecipe[], learner: unknown, items: readonly MaterialBatch[],
  raw: unknown, physicalPowers: unknown, massByRecipe: unknown, capabilities: readonly Capability[],
): boolean {
  return recipePowerPruningRejection(remembered, candidates, learner, items, raw, physicalPowers, massByRecipe, capabilities) === undefined;
}
/** Diagnostics do not read a possibly effectful array length on a rejected path. */
export function recipeSequenceLength(value: unknown): number {
  if (value === null || typeof value !== 'object' || isProxy(value) || !isArray(value)) return 0;
  const descriptor = own(value, 'length');
  return descriptor && hasOwn(descriptor, 'value') && typeof descriptor.value === 'number' ? descriptor.value : 0;
}
