import type { Person } from './index.js';

/** A host capability, not a statement about any World data. */
declare const boundaryBrand: unique symbol;
export interface CooperationMembershipBoundary { readonly [boundaryBrand]: true }
type IsProxy = (value: unknown) => boolean;
const nativeDescriptor = Object.getOwnPropertyDescriptor;
const nativePrototype = Object.getPrototypeOf;
const nativeHasOwn = Object.hasOwn;
const nativeIsArray = Array.isArray;
const nativeIncludes = Array.prototype.includes;
const arrayPrototype = Array.prototype;
const nativeIterator = Array.prototype[Symbol.iterator];
const iteratorPrototype = nativePrototype([][Symbol.iterator]());
const nativeNext = nativeDescriptor(iteratorPrototype, 'next')!.value;
const NativeSet = Set;
const setAdd = Function.prototype.call.bind(Set.prototype.add) as (set: Set<string>, id: string) => Set<string>;
const setHas = Function.prototype.call.bind(Set.prototype.has) as (set: Set<string>, id: string) => boolean;
const mapGet = Function.prototype.call.bind(WeakMap.prototype.get) as (map: WeakMap<object, IsProxy>, key: object) => IsProxy | undefined;
const mapSet = Function.prototype.call.bind(WeakMap.prototype.set) as (map: WeakMap<object, IsProxy>, key: object, value: IsProxy) => void;
const nativeFreeze = Object.freeze;
const detectors = new WeakMap<object, IsProxy>();
const contextGet = Function.prototype.call.bind(WeakMap.prototype.get) as (map: WeakMap<object, CooperationMembershipBoundary>, context: object) => CooperationMembershipBoundary | undefined;
const contextSet = Function.prototype.call.bind(WeakMap.prototype.set) as (map: WeakMap<object, CooperationMembershipBoundary>, context: object, boundary: CooperationMembershipBoundary) => void;
const ownedContexts = new WeakMap<object, CooperationMembershipBoundary>();

/** Only the controlled stock Node host supplies this intrinsic at startup. */
export function createCooperationMembershipBoundary(isProxy: IsProxy): CooperationMembershipBoundary {
  const token = nativeFreeze({}) as CooperationMembershipBoundary;
  mapSet(detectors, token, isProxy);
  return token;
}
/** Only this factory's literal contexts can authorize the host detector. */
export function createCooperationMembershipContext<T extends object>(context: T,
  boundary: CooperationMembershipBoundary): T & { cooperationMembership: CooperationMembershipBoundary } {
  const owned = { ...context, cooperationMembership: boundary };
  if (mapGet(detectors, boundary)) contextSet(ownedContexts, owned, boundary);
  return owned;
}
/** The same spread as bindWorldContext; no reflection on unknown source contexts. */
export function mergeCooperationMembershipContext<T extends object>(previous: T | undefined, context: T): T {
  const bound = { ...previous, ...context };
  const boundary = contextGet(ownedContexts, context);
  if (boundary && data(context, 'cooperationMembership')?.value === boundary &&
    data(bound, 'cooperationMembership')?.value === boundary) contextSet(ownedContexts, bound, boundary);
  return bound;
}
export function cooperationMembershipForContext(context: object | undefined): CooperationMembershipBoundary | undefined {
  const boundary = context && contextGet(ownedContexts, context);
  // A recognized identity was created as a literal, so this cannot trigger Proxy traps.
  return boundary && data(context!, 'cooperationMembership')?.value === boundary ? boundary : undefined;
}
function data(object: object, key: PropertyKey): PropertyDescriptor | undefined {
  const descriptor = nativeDescriptor(object, key);
  return descriptor && nativeHasOwn(descriptor, 'value') ? descriptor : undefined;
}
function ordinary(value: unknown, isProxy: IsProxy): value is object {
  return value !== null && typeof value === 'object' && !isProxy(value);
}
function array(value: unknown, isProxy: IsProxy): value is string[] {
  return ordinary(value, isProxy) && nativeIsArray(value) && nativePrototype(value) === arrayPrototype;
}
function method(array: string[], key: PropertyKey, expected: unknown): boolean {
  const own = nativeDescriptor(array, key);
  const descriptor = own ?? nativeDescriptor(arrayPrototype, key);
  return !!descriptor && nativeHasOwn(descriptor, 'value') && descriptor.value === expected;
}
function plainIds(ids: string[]): boolean {
  for (let i = 0; i < ids.length; i++) if (typeof data(ids, i)?.value !== 'string') return false;
  return true;
}
export interface RecipeMembership { includes(id: string): boolean; discard(): void }
/** The caller keeps its original for-of and discards BEFORE every resolver call. */
export function createRecipeMembership(boundary: CooperationMembershipBoundary | undefined,
  learner: Person, practiced: readonly string[]): RecipeMembership {
  const isProxy = boundary !== null && typeof boundary === 'object' ? mapGet(detectors, boundary) : undefined;
  // Inspect before the original for-of captures its iterator/next. Accessors that
  // restore themselves cannot make a custom captured next look native later.
  const iterable = isProxy && array(practiced, isProxy) && method(practiced, Symbol.iterator, nativeIterator) &&
    data(iteratorPrototype, 'next')?.value === nativeNext;
  let seen: string[] | undefined, size = 0, queries = 0, indexed: Set<string> | undefined, rejected = false;
  const discard = () => { seen = undefined; size = 0; queries = 0; indexed = undefined; rejected = false; };
  const original = (id: string) => learner.technology.knownRecipes.includes(id);
  return { discard, includes(id) {
    if (!iterable || rejected || !isProxy || typeof id !== 'string') return original(id);
    const technology = ordinary(learner, isProxy) ? data(learner, 'technology')?.value : undefined;
    const ids = ordinary(technology, isProxy) ? data(technology, 'knownRecipes')?.value : undefined;
    if (!array(ids, isProxy) || !method(ids, 'includes', nativeIncludes)) { discard(); return original(id); }
    if (seen !== ids || size !== ids.length) { discard(); seen = ids; size = ids.length; }
    if (indexed) return setHas(indexed, id);
    if (++queries < 2) return original(id);
    // Rechecking practiced slots after callbacks must not add a T-squared term.
    if (practiced.length > ids.length) { rejected = true; return original(id); }
    if (!plainIds(ids) || !plainIds(practiced as string[])) { rejected = true; return original(id); }
    indexed = new NativeSet<string>();
    for (let i = 0; i < ids.length; i++) setAdd(indexed, data(ids, i)!.value as string);
    return setHas(indexed, id);
  } };
}
