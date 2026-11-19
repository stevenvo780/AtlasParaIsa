import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { types } from 'node:util';
import { transformSync } from 'esbuild';
import { bindWorldContext, worldContext, cooperationMembershipBoundary } from '../src/world/spatial.js';
import { nodeCooperationMembershipBoundary, nodeCooperationMembershipContext } from '../src/server/cooperation-membership.js';
import { Store } from '../src/server/store.js';
import { createRecipeMembership, type CooperationMembershipBoundary } from '../src/world/cooperation-membership.js';
import { cloneWorld, type World } from '../src/world/index.js';

// Actual candidate loop and helper, tested against the literal MAIN/c4 loop.
const society = readFileSync(new URL('../src/world/society.ts', import.meta.url), 'utf8');
const helper = readFileSync(new URL('../src/world/cooperation-membership.ts', import.meta.url), 'utf8');
const engine = readFileSync(new URL('../src/world/index.ts', import.meta.url), 'utf8');
const spatial = readFileSync(new URL('../src/world/spatial.ts', import.meta.url), 'utf8');
const host = readFileSync(new URL('../src/server/cooperation-membership.ts', import.meta.url), 'utf8');
const store = readFileSync(new URL('../src/server/store.ts', import.meta.url), 'utf8');
const start = society.indexOf('function practicedRecipeToTeach(');
const end = society.indexOf('  if (!candidates.length) return;', start);
assert.ok(start >= 0 && end > start);
const candidateLoop = society.slice(start, end) + '  return candidates;\n}';
const referenceLoop = `function practicedRecipeToTeach(world, teacher, learner, practiced) {
  if (!world.learningEnabled) return;
  const candidates = [];
  for (const id of practiced ?? practicedRecipes(teacher)) {
    if (learner.technology.knownRecipes.includes(id)) continue;
    const recipe = resolveTechnologyRecipe(world, id); if (recipe) candidates.push(recipe);
  }
  return candidates;
}`;
const compile = (code: string) => transformSync(code, { loader: 'ts', target: 'es2022' }).code;
// Pure counters in a test-only copy of the actual helper; no World callback.
const observedHelper = helper.replace(/^export /gm, '').replace('indexed = new NativeSet<string>();', 'globalThis.builds++; indexed = new NativeSet<string>();');
assert.notEqual(observedHelper, helper.replace(/^export /gm, ''));
const candidateCode = compile(observedHelper + '\n' + candidateLoop);
const referenceCode = compile(referenceLoop);
function outcome(code: string, scenario: string, candidate: boolean): { value: unknown; builds: number } {
  const context = createContext({ nativeIsProxy: types.isProxy });
  runInContext(`globalThis.trace=[];globalThis.builds=0;globalThis.isCandidate=${candidate};
    globalThis.learner={technology:{knownRecipes:['a','b','c','e','f','g']}};
    globalThis.teacher={ids:['a','b','c','d']};globalThis.world={learningEnabled:true};
    globalThis.practiced=teacher.ids;globalThis.onResolve=()=>{};
    const practicedRecipes=teacher=>{trace.push('practiced');return teacher.ids};
    const resolveTechnologyRecipe=(world,id)=>{trace.push('resolve:'+id);onResolve(id);return {id}};`, context);
  runInContext(code, context);
  runInContext(`globalThis.token=isCandidate?createCooperationMembershipBoundary(nativeIsProxy):{};
    const cooperationMembershipBoundary=()=>token;
    try { ${scenario}
      globalThis.result={ids:practicedRecipeToTeach(world,teacher,learner,practiced)?.map(r=>r.id),trace};
    } catch(error) {globalThis.result={error:{name:error.name,message:error.message,sameObject:error===globalThis.expectedError},trace};}`, context);
  return { value: JSON.parse(runInContext('JSON.stringify(result)', context)), builds: runInContext('builds', context) as number };
}
const cases: [string, string, number?][] = [
  ['ordinary repeated known IDs use one Set', `practiced=['a','b','c','a','b','c'];`, 1],
  ['more practiced than known avoids repeated full practiced scans', `learner.technology.knownRecipes=['a','b','c'];practiced=['a','b','c','a','b','c'];`, 0],
  ['one lookup remains original', `practiced=['a'];`, 0],
  ['empty practiced list', `practiced=[];`, 0],
  ['empty known array', `learner.technology.knownRecipes=[];practiced=['x','y'];`, 0],
  ['unknown ID discards before in-place resolver mutation', `practiced=['a','b','d','b','c'];onResolve=id=>{if(id==='d')learner.technology.knownRecipes[1]='x'};`, 1],
  ['resolver mutates a future practiced slot to accessor', `practiced=['a','b','d','a','b','c'];onResolve=id=>{if(id==='d')Object.defineProperty(practiced,'4',{get(){trace.push('practiced-slot');learner.technology.knownRecipes[1]='x';return 'b'}})};`],
  ['resolver replaces known array', `practiced=['a','b','d','a','b'];onResolve=id=>{if(id==='d')learner.technology.knownRecipes=['b']};`],
  ['resolver throw propagates the same object', `expectedError=new TypeError('resolver');practiced=['a','b','d'];onResolve=()=>{throw expectedError};`, 1],
  ['custom iterator mutates in place between yields', `practiced={*[Symbol.iterator](){yield 'a';yield 'b';learner.technology.knownRecipes[1]='x';yield 'b'}};`, 0],
  ['iterator getter restores itself but remains fallback', `const iterator=Array.prototype[Symbol.iterator];Object.defineProperty(practiced,Symbol.iterator,{configurable:true,get(){trace.push('iterator-get');Object.defineProperty(practiced,Symbol.iterator,{value:iterator});return function*(){yield 'a';yield 'b';learner.technology.knownRecipes[1]='x';yield 'b'}}});`, 0],
  ['next getter restores itself but captures a custom next', `const proto=Object.getPrototypeOf([][Symbol.iterator]()),next=proto.next;let n=0;
    Object.defineProperty(proto,'next',{configurable:true,get(){trace.push('next-get');Object.defineProperty(proto,'next',{value:next,writable:true,configurable:true});return function(){if(++n===3)learner.technology.knownRecipes[1]='x';return next.call(this)}}});practiced=['a','b','b'];`, 0],
  ['practiced slot getter runs once at its original point', `practiced=['a','b','b'];Object.defineProperty(practiced,'2',{get(){trace.push('slot');learner.technology.knownRecipes[1]='x';return 'b'}});`, 0],
  ['known slot accessor is not read by admission', `Object.defineProperty(learner.technology.knownRecipes,'0',{get(){trace.push('known-slot');return 'a'}});practiced=['c','b','a'];`, 0],
  ['known accessor restores data during first includes', `Object.defineProperty(learner.technology.knownRecipes,'0',{configurable:true,get(){trace.push('known-slot');Object.defineProperty(learner.technology.knownRecipes,'0',{value:'x',writable:true,configurable:true});return 'a'}});practiced=['a','b','a'];`],
  ['known getter replaces includes during the first original call', `const includes=Array.prototype.includes;Object.defineProperty(learner.technology.knownRecipes,'0',{get(){trace.push('known-slot');Array.prototype.includes=function(id){trace.push('later-includes:'+id);return includes.call(this,id)};return 'a'}});practiced=['a','b','c'];`, 0],
  ['technology accessor preserves every original get', `const technology=learner.technology;Object.defineProperty(learner,'technology',{get(){trace.push('technology');return technology}});`, 0],
  ['knownRecipes accessor preserves every original get', `const ids=learner.technology.knownRecipes;Object.defineProperty(learner.technology,'knownRecipes',{get(){trace.push('known');return ids}});`, 0],
  ['includes accessor returns native after an in-place mutation', `const includes=Array.prototype.includes;Object.defineProperty(learner.technology.knownRecipes,'includes',{configurable:true,get(){trace.push('includes-get');learner.technology.knownRecipes[1]='x';Object.defineProperty(learner.technology.knownRecipes,'includes',{value:includes});return includes}});`, 1],
  ['includes override effects and method receiver stay original', `const includes=Array.prototype.includes;Array.prototype.includes=function(id){trace.push('includes:'+id);return includes.call(this,id)};`, 0],
  ['includes getter throws', `Object.defineProperty(learner.technology.knownRecipes,'includes',{get(){trace.push('includes-get');throw Error('includes')}});`, 0],
  ['known array Proxy traps occur only through original includes', `learner.technology.knownRecipes=new Proxy(learner.technology.knownRecipes,{get(target,key,receiver){trace.push('known-get:'+String(key));return Reflect.get(target,key,receiver)}});`, 0],
  ['technology Proxy traps remain original', `learner.technology=new Proxy(learner.technology,{get(target,key,receiver){trace.push('technology-get:'+String(key));return Reflect.get(target,key,receiver)}});`, 0],
  ['learner Proxy traps remain original', `learner=new Proxy(learner,{get(target,key,receiver){trace.push('learner-get:'+String(key));return Reflect.get(target,key,receiver)}});`, 0],
  ['practiced Proxy traps remain original', `practiced=new Proxy(practiced,{get(target,key,receiver){trace.push('practiced-get:'+String(key));return Reflect.get(target,key,receiver)}});`, 0],
  ['sparse array inherited getter remains original', `learner.technology.knownRecipes=['a',,'c'];Object.defineProperty(Array.prototype,'1',{configurable:true,get(){trace.push('inherited-known');return 'b'},set(value){Object.defineProperty(this,'1',{value,writable:true,configurable:true})}});practiced=['c','b'];`, 0],
  ['no host token falls back', `token=undefined;practiced=['a','b','c'];`, 0],
  ['unrecognized Proxy token has no property effects', `token=new Proxy({},{get(){trace.push('unreachable-token');throw Error('token')}});practiced=['a','b','c'];`, 0],
  ['invalid learner preserves native error', `learner={};`, 0],
  ['invalid knownRecipes preserves native error', `learner.technology.knownRecipes=null;`, 0],
  ['known non-string IDs remain original', `learner.technology.knownRecipes=['a',NaN,undefined,'c'];practiced=['a','c','b'];`, 0],
  ['learning getter still comes first', `Object.defineProperty(world,'learningEnabled',{get(){trace.push('learning');return false}});`, 0],
  ['implicit practiced list evaluated at original point', `practiced=undefined;`, 1],
  ['duplicate candidates keep resolver order', `practiced=['d','d','d'];`, 0],
  ['later iterator override cannot alter captured next', `practiced=['a','b','d','a','b','c'];onResolve=()=>{Object.defineProperty(Array.prototype,Symbol.iterator,{get(){trace.push('unreachable-late-iterator');throw Error('iterator')}})};`, 2],
  ['iterator return getter on resolver throw is preserved', `const proto=Object.getPrototypeOf([][Symbol.iterator]());Object.defineProperty(proto,'return',{get(){trace.push('return-get');return function(){trace.push('return-call');return {done:true}}}});
    practiced=['a','b','d'];onResolve=()=>{throw Error('resolver')};`, 1],
  ['new Set methods decorated after startup add no callbacks', `Set.prototype.add=function(){trace.push('unreachable-set-add');throw Error('set-add')};Set.prototype.has=function(){trace.push('unreachable-set-has');throw Error('set-has')};practiced=['a','b','c'];`, 1],
  ['String decorated after startup adds no callback', `String=function(){trace.push('unreachable-String');throw Error('String')};practiced=['a','b','c'];`, 1],
  ['reflection intrinsics decorated after startup add no callbacks', `for(const key of ['getOwnPropertyDescriptor','getPrototypeOf','hasOwn'])Object[key]=()=>{trace.push('unreachable-reflection');throw Error('reflection')};Array.isArray=()=>{trace.push('unreachable-isArray');throw Error('isArray')};Set=()=>{throw Error('Set')};practiced=['a','b','c'];`, 1],
];
for (const [name, scenario, builds] of cases) test(`membership matches MAIN candidates/errors/trace: ${name}`, () => {
  const actual = outcome(candidateCode, scenario, true), expected = outcome(referenceCode, scenario, false);
  assert.deepEqual(actual.value, expected.value);
  if (builds !== undefined) assert.equal(actual.builds, builds);
});

test('bound context accessor and unknown tokens never invoke new callbacks', () => {
  const world = { technology: {} } as World;
  bindWorldContext(world, nodeCooperationMembershipContext({}));
  assert.equal(cooperationMembershipBoundary(world), nodeCooperationMembershipBoundary);
  let reads = 0;
  Object.defineProperty(worldContext(world), 'cooperationMembership', { get() { reads++; throw Error('accessor'); } });
  assert.equal(cooperationMembershipBoundary(world), undefined);
  assert.equal(reads, 0);
  const token = new Proxy({}, { get() { throw Error('token'); } }) as CooperationMembershipBoundary;
  const learner = { technology: { knownRecipes: ['a'] } };
  const membership = createRecipeMembership(token, learner as never, ['a','a']);
  assert.equal(membership.includes('a'), true);
  assert.equal(membership.includes('a'), true);
});

test('a Proxy injected into the context WeakMap is rejected without a new descriptor trap', () => {
  const world = { technology: {} } as World;
  const set = WeakMap.prototype.set;
  let descriptors = 0;
  WeakMap.prototype.set = function(key, value) {
    return set.call(this, key, new Proxy(value, { getOwnPropertyDescriptor() { descriptors++; throw Error('descriptor'); } }));
  };
  try { bindWorldContext(world, nodeCooperationMembershipContext({})); }
  finally { WeakMap.prototype.set = set; }
  assert.equal(cooperationMembershipBoundary(world), undefined);
  assert.equal(descriptors, 0);
});

test('unknown input context retains only the original spread traps', () => {
  const world = { technology: {} } as World, trace: string[] = [];
  const context = new Proxy({ cooperationMembership: nodeCooperationMembershipBoundary }, {
    ownKeys(target) { trace.push('ownKeys'); return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) { trace.push('descriptor:' + String(key)); return Reflect.getOwnPropertyDescriptor(target, key); },
    get(target, key, receiver) { trace.push('get:' + String(key)); return Reflect.get(target, key, receiver); },
  });
  bindWorldContext(world, context);
  assert.equal(cooperationMembershipBoundary(world), undefined);
  assert.deepEqual(trace, ['ownKeys','descriptor:cooperationMembership','get:cooperationMembership']);
});

test('actual Store.context factory supplies the Node capability without opening a database', () => {
  const getter = Object.getOwnPropertyDescriptor(Store.prototype, 'context')!.get!;
  const context = getter.call({ schemaVersion: 3 });
  const world = { technology: {} } as World;
  bindWorldContext(world, context);
  assert.equal(cooperationMembershipBoundary(world), nodeCooperationMembershipBoundary);
  const learner = { technology: { knownRecipes: ['a','b','c'] } };
  const membership = createRecipeMembership(cooperationMembershipBoundary(world), learner as never, ['a','b','c']);
  assert.equal(membership.includes('a'), true);
  assert.equal(membership.includes('b'), true);
  learner.technology.knownRecipes[1] = 'x';
  membership.discard();
  assert.equal(membership.includes('b'), false);
});

function minimalCloneableWorld(): World {
  return { seed: 1, tick: 12, learningEnabled: true, technology: {}, tiles: [], retiredChunks: [],
    people: [{ technology: { knownRecipes: ['a','b','c'] } }] } as unknown as World;
}
function actualStoreContext() {
  return Object.getOwnPropertyDescriptor(Store.prototype, 'context')!.get!.call({ schemaVersion: 3 });
}
test('actual cloneWorld propagates the actual Store.context capability without changing World data', () => {
  const world = minimalCloneableWorld();
  bindWorldContext(world, actualStoreContext());
  const draft = cloneWorld(world);
  assert.deepEqual(draft, world);
  assert.notEqual(draft.people, world.people);
  assert.equal(cooperationMembershipBoundary(draft), nodeCooperationMembershipBoundary);
  const membership = createRecipeMembership(cooperationMembershipBoundary(draft), draft.people[0]!, ['a','b','c']);
  assert.equal(membership.includes('a'), true);
  assert.equal(membership.includes('b'), true);
  membership.discard();
  draft.people[0]!.technology.knownRecipes[1] = 'x';
  assert.equal(membership.includes('b'), false);
});
test('actual cloneWorld with an unknown context preserves World data and rejects its token', () => {
  const world = minimalCloneableWorld();
  bindWorldContext(world, actualStoreContext());
  const draft = cloneWorld(world, { cooperationMembership: nodeCooperationMembershipBoundary });
  assert.deepEqual(draft, world);
  assert.equal(cooperationMembershipBoundary(draft), undefined);
});
test('actual cloneWorld rejects an injected context Proxy without a descriptor trap', () => {
  const world = minimalCloneableWorld();
  bindWorldContext(world, actualStoreContext());
  const set = WeakMap.prototype.set;
  let descriptors = 0, draft: World;
  WeakMap.prototype.set = function(key, value) {
    return set.call(this, key, value && Object.hasOwn(value, 'cooperationMembership') ?
      new Proxy(value, { getOwnPropertyDescriptor() { descriptors++; throw Error('descriptor'); } }) : value);
  };
  try { draft = cloneWorld(world); }
  finally { WeakMap.prototype.set = set; }
  assert.deepEqual(draft, world);
  assert.equal(cooperationMembershipBoundary(draft), undefined);
  assert.equal(descriptors, 0);
});

// Exercise the actual cloneWorld context-binding statement, actual spatial code,
// actual Store getter/factory and counted helper together in one stock VM realm.
const contextCode = spatial.slice(spatial.indexOf('const contexts ='), spatial.indexOf('export type ChunkMeta'));
const getterCode = store.slice(store.indexOf('  get context(): WorldContext {'), store.indexOf('  private readTechnologyRecipe('));
const cloneBinding = engine.split('\n').find(line => line.includes('bindWorldContext(draft, mergeCooperationMembershipContext('));
assert.ok(contextCode && getterCode && cloneBinding);
function clonedMembership(scenario: string, propagated: boolean) {
  const context = createContext({ types: { isProxy: types.isProxy } });
  const binding = propagated ? cloneBinding! :
    'bindWorldContext(draft, { ...worldContext(world), ...(context && typeof context === "object" ? context : {}) });';
  runInContext(compile(observedHelper + '\n' + contextCode.replace(/^export /gm, '') + '\n' +
    host.replace(/^import .*\n/gm, '').replace(/^export /gm, '') + '\n' +
    `class StoreContextFactory {schemaVersion=3; ${getterCode} }
    function cloneContext(world, context=worldContext(world)) {const draft={...world};${binding}return draft;}`), context);
  runInContext(`globalThis.trace=[];globalThis.builds=0;
    const world={technology:{},learningEnabled:true};bindWorldContext(world,new StoreContextFactory().context);
    ${scenario}
    const draft=cloneContext(world,extraContext), learner={technology:{knownRecipes:['a','b','c']}}, practiced=['a','b','c'];
    const membership=createRecipeMembership(cooperationMembershipBoundary(draft),learner,practiced);
    const answers=practiced.map(id=>membership.includes(id));
    globalThis.result={answers,trace,authorized:cooperationMembershipBoundary(draft)===nodeCooperationMembershipBoundary,builds};`, context);
  return JSON.parse(runInContext('JSON.stringify(result)', context)) as {answers:boolean[];trace:string[];authorized:boolean;builds:number};
}
test('the real clone context path activates a Set with the real Store factory', () => {
  const actual = clonedMembership('const extraContext=undefined;', true);
  const previous = clonedMembership('const extraContext=undefined;', false);
  assert.deepEqual(actual.answers, previous.answers);
  assert.deepEqual(actual.trace, previous.trace);
  assert.equal(actual.authorized, true);
  assert.equal(actual.builds, 1);
  assert.equal(previous.authorized, false);
  assert.equal(previous.builds, 0);
});
for (const [name, scenario] of [
  ['unknown Proxy', `const extraContext=new Proxy({cooperationMembership:nodeCooperationMembershipBoundary},{ownKeys(target){trace.push('ownKeys');return Reflect.ownKeys(target)},getOwnPropertyDescriptor(target,key){trace.push('descriptor:'+String(key));return Reflect.getOwnPropertyDescriptor(target,key)},get(target,key,receiver){trace.push('get:'+String(key));return Reflect.get(target,key,receiver)}});`],
  ['known context accessor', `const extraContext=worldContext(world);Object.defineProperty(extraContext,'cooperationMembership',{enumerable:true,get(){trace.push('context-token');return nodeCooperationMembershipBoundary}});`],
  ['Proxy stored through WeakMap.set', `const extraContext=undefined,set=WeakMap.prototype.set;WeakMap.prototype.set=function(key,value){return set.call(this,key,value&&Object.hasOwn(value,'cooperationMembership')?new Proxy(value,{getOwnPropertyDescriptor(target,key){trace.push('descriptor:'+String(key));return Reflect.getOwnPropertyDescriptor(target,key)}}):value)};bindWorldContext(world,new StoreContextFactory().context);`],
] as const) test(`clone context fallback preserves the original traps: ${name}`, () => {
  const actual = clonedMembership(scenario, true), previous = clonedMembership(scenario, false);
  assert.deepEqual(actual, previous);
  assert.equal(actual.authorized, false);
  assert.equal(actual.builds, 0);
});
