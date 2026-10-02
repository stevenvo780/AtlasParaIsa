import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { transformSync } from 'esbuild';

// Literal unchanged MAIN/c4 function, from society.ts SHA256 95ee18c72414bac95c47a89d18f2f367e646363044dd74b13427cb9c2b4051dc.
// Test the actual private candidate without adding an export or requiring another checkout.
const baselineBody = String.raw`function localRecipeInputs(world: World, teacher: Person, learner: Person): (program: TechnologyProgram, prospectiveProductId?: string) => boolean {
  const raw = { wood: (learner.materials.wood + teacher.materials.wood) * MASS_UNIT,
    stone: (learner.materials.stone + teacher.materials.stone) * MASS_UNIT, water: 0 };
  for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {
    if (dx * dx + dy * dy > 49) continue;
    const tile = tileAt(world, { x: learner.x + dx, y: learner.y + dy });
    if (tile && tile.terrain !== 'water') { raw.wood += (tile.wood ?? 0) * MASS_UNIT; raw.stone += (tile.stone ?? 0) * MASS_UNIT; raw.water += (tile.drinkingWater ?? 0) * 50_000; }
  }
  const items = [...learner.technology.items, ...teacher.technology.items], powers = itemCapacities(items);
  // Masa por receta de producto, sumada en el orden de \`items\` como el \`filter\` + \`reduce\` de siempre.
  const massByRecipe = new Map<string | null, number>();
  const productMass = (id: string): number => {
    let mass = massByRecipe.get(id);
    if (mass === undefined) { mass = items.filter(item => item.recipeId === id).reduce((total, item) => total + item.mass, 0); massByRecipe.set(id, mass); }
    return mass;
  };
  return (program, prospectiveProductId) => {
    const required = { wood: 0, stone: 0, water: 0 }, residue = { wood: 0, stone: 0, water: 0 }, products = new Map<string, number>();
    for (const input of program.inputs) {
      if (input.source === 'product') products.set(input.recipeId!, (products.get(input.recipeId!) ?? 0) + input.mass);
      else (input.source === 'raw' ? required : residue)[input.material!] += input.mass;
    }
    const fuel = program.steps.reduce((n, step) => n + (step.op === 'heat' ? step.intensity * 50 : 0), 0);
    required.wood += Math.max(0, fuel - Math.max(0, learner.technology.residue.wood - residue.wood));
    return (['wood', 'stone', 'water'] as const).every(material => required[material] <= raw[material] && residue[material] <= learner.technology.residue[material]) &&
      [...products].every(([id, needed]) => id === prospectiveProductId || productMass(id) >= needed) &&
      program.steps.every(step => !step.requiredCatalyst || powers[step.requiredCatalyst] >= 0.1);
  };
}
`.replaceAll('\\`', '`');
const candidate = readFileSync(new URL('../src/world/society.ts', import.meta.url), 'utf8');
function body(source: string): string {
  const start = source.indexOf('function localRecipeInputs(');
  const end = source.indexOf('\n/** Recetas que el maestro', start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
const candidateBody = body(candidate);
assert.equal(candidateBody.split('  return (program, prospectiveProductId) => {')[0], baselineBody.split('  return (program, prospectiveProductId) => {')[0]);
assert.ok(candidate.includes('const NativeProductsMap = Map;'));
assert.ok(candidate.includes('const NativeProductsProxy = Proxy;'));
assert.ok(candidate.includes('const NativeProductsGetPrototypeOf = Object.getPrototypeOf;'));
assert.ok(candidate.includes('const NativeProductsTypeErrorPrototype = TypeError.prototype;'));
const compile = (source: string) => transformSync(source, { loader: 'ts', target: 'es2022' }).code;
const startup = candidate.split('\n').filter(line => /^const NativeProducts\w+ = /.test(line)).join('\n');
const scripts = [compile(baselineBody), compile(startup + '\n' + candidateBody)];
const setup = `
  globalThis.trace = [];
  globalThis.OriginalMap = Map;
  globalThis.OriginalProxy = Proxy;
  const MASS_UNIT = 1000;
  const tileAt = () => null;
  const itemCapacities = () => ({cutting:0,storage:0,insulation:0,cultivation:0,binding:0,abrasion:0});
  const teacher = {x:0,y:0,materials:{wood:1,stone:1},technology:{items:[]}};
  const learner = {x:0,y:0,materials:{wood:1,stone:1},technology:{items:[{recipeId:'r',mass:2000}],residue:{wood:0,stone:0,water:0}}};
`;
function outcome(script: string, scenario: string): unknown {
  const context = createContext({});
  runInContext(setup + script + '\nglobalThis.available = localRecipeInputs({}, teacher, learner);', context);
  runInContext(`try { ${scenario}\n globalThis.outcome={value:available(program, prospective),trace}; }
    catch(error) {globalThis.outcome={error:{name:error.name,message:error.message,sameObject:error===globalThis.expectedError},trace};}`, context);
  return JSON.parse(runInContext('JSON.stringify(outcome)', context) as string);
}
const cases: [string, string][] = [
  ['raw short circuit', `const prospective=undefined; const program={inputs:[{source:'raw',material:'wood',mass:3000}],steps:[]};`],
  ['empty product iteration', `const prospective=undefined; const program={inputs:[],steps:[]};`],
  ['residue fuel and catalyst', `const prospective=undefined; learner.technology.residue.wood=200;
    const program={inputs:[{source:'residue',material:'wood',mass:200}],steps:[{op:'heat',intensity:2},{op:'form',requiredCatalyst:'cutting'}]};`],
  ['duplicates and prospective product', `const prospective='r'; const program={inputs:[{source:'product',recipeId:'r',mass:.1},{source:'product',recipeId:'r',mass:.2}],steps:[]};`],
  ['NaN and minus zero', `const prospective=undefined; const program={inputs:[{source:'raw',material:'wood',mass:NaN},{source:'residue',material:'stone',mass:-0}],steps:[]};`],
  ['custom constructor eager', `globalThis.Map=class extends OriginalMap {constructor(){super();trace.push('construct')}};
    const prospective=undefined; const program={inputs:[{source:'raw',material:'wood',mass:3000}],steps:[]};`],
  ['proxy constructor eager', `globalThis.Map=new Proxy(OriginalMap,{construct(target,args,newTarget){trace.push('construct');return Reflect.construct(target,args,newTarget)},get(target,key,receiver){trace.push('constructor-get:'+String(key));return Reflect.get(target,key,receiver)}});
    const prospective=undefined; const program={inputs:[{source:'raw',material:'wood',mass:3000}],steps:[]};`],
  ['global accessor exactly once', `Object.defineProperty(globalThis,'Map',{configurable:true,get(){trace.push('global-read');return OriginalMap}});
    const prospective=undefined; const program={inputs:[{source:'raw',material:'wood',mass:3000}],steps:[]};`],
  ['accessor returning custom constructor', `const C=class extends OriginalMap {constructor(){super();trace.push('construct')}};
    Object.defineProperty(globalThis,'Map',{configurable:true,get(){trace.push('global-read');return C}});
    const prospective=undefined; const program={inputs:[],steps:[]};`],
  ['captured constructor despite input getter', `const prospective=undefined;
    const program={inputs:[{get source(){trace.push('source');globalThis.Map=function(){throw Error('wrong late constructor')};return 'product'},get recipeId(){trace.push('id');return 'r'},get mass(){trace.push('mass');return 1000}}],steps:[]};`],
  ['custom constructor restored by getter', `globalThis.Map=class extends OriginalMap {constructor(){super();trace.push('construct')}};
    const prospective=undefined; const program={inputs:[{get source(){trace.push('source');globalThis.Map=OriginalMap;return 'raw'},material:'wood',mass:3000}],steps:[]};`],
  ['set get and coercion order', `const set=OriginalMap.prototype.set,get=OriginalMap.prototype.get;
    Object.defineProperty(OriginalMap.prototype,'set',{get(){trace.push('lookup-set');return function(k,v){trace.push('set');return set.call(this,k,v)}}});
    Object.defineProperty(OriginalMap.prototype,'get',{get(){trace.push('lookup-get');return function(k){trace.push('get');return get.call(this,k)}}});
    const prospective='r'; const program={inputs:[{get source(){trace.push('source');return 'product'},get recipeId(){trace.push('id');return 'r'},get mass(){trace.push('mass');return {valueOf(){trace.push('coerce');return 1000}}}}],steps:[]};`],
  ['input iterator changes Map and product iterator', `const entries=OriginalMap.prototype[Symbol.iterator];const prospective=undefined;
    const program={inputs:{*[Symbol.iterator](){trace.push('inputs-iterator');globalThis.Map=function(){throw Error('wrong late constructor')};OriginalMap.prototype[Symbol.iterator]=function(){trace.push('products-iterator');return entries.call(this)};yield {source:'raw',material:'wood',mass:1000}}},steps:[]};`],
  ['fuel callback changes empty iterator and every', `const every=Array.prototype.every,entries=OriginalMap.prototype[Symbol.iterator];const prospective=undefined;
    const program={inputs:[],steps:{reduce(){trace.push('reduce');OriginalMap.prototype[Symbol.iterator]=function(){trace.push('products-iterator');return entries.call(this)};Array.prototype.every=function(fn){trace.push('every:'+this.length);return every.call(this,fn)};return 0},every(){trace.push('steps-every');return true}}};`],
  ['empty iterator accessor throws', `const prospective=undefined;
    const program={inputs:[],steps:{reduce(){Object.defineProperty(OriginalMap.prototype,Symbol.iterator,{get(){trace.push('iterator-get');throw Error('iterator')}});return 0},every(){trace.push('unreachable');return true}}};`],
  ['empty Array every is still called', `const every=Array.prototype.every;Array.prototype.every=function(fn){trace.push('every:'+this.length);if(this.length===0)return false;return every.call(this,fn)};
    const prospective=undefined;const program={inputs:[],steps:[]};`],
  ['constructor throw precedes input access', `globalThis.Map=function(){trace.push('construct');throw Error('constructor')};
    const prospective=undefined;const program={get inputs(){trace.push('unreachable-inputs');return []},steps:[]};`],
  ['global accessor throw precedes input access', `Object.defineProperty(globalThis,'Map',{get(){trace.push('global-read');throw Error('global')}});
    const prospective=undefined;const program={get inputs(){trace.push('unreachable-inputs');return []},steps:[]};`],
  ['input getter throws', `const prospective=undefined;const program={inputs:[{get source(){trace.push('source');throw Error('source')}}],steps:[]};`],
  ['undefined program', `const prospective=undefined;const program=undefined;`],
  ['undefined inputs', `const prospective=undefined;const program={inputs:undefined,steps:[]};`],
  ['null input', `const prospective=undefined;const program={inputs:[null],steps:[]};`],
  ['missing steps reduce', `const prospective=undefined;const program={inputs:[],steps:undefined};`],
  ['custom constructor malformed instance', `globalThis.Map=function(){trace.push('construct');return {}};const prospective=undefined;
    const program={inputs:[{source:'product',recipeId:'r',mass:1000}],steps:[]};`],
  ['undefined constructor', `globalThis.Map=undefined;const prospective=undefined;const program={inputs:[],steps:[]};`],
  ['null constructor', `globalThis.Map=null;const prospective=undefined;const program={inputs:[],steps:[]};`],
  ['nonconstructible arrow', `globalThis.Map=()=>{trace.push('unreachable')};const prospective=undefined;const program={inputs:[],steps:[]};`],
  ['accessor returning undefined', `Object.defineProperty(globalThis,'Map',{get(){trace.push('global-read');return undefined}});
    const prospective=undefined;const program={get inputs(){trace.push('unreachable-inputs');return []},steps:[]};`],
  ['invalid object does not run conversion or prototype getter', `globalThis.Map={get prototype(){trace.push('unreachable-prototype');throw Error('prototype')},[Symbol.toPrimitive](){trace.push('unreachable-conversion');throw Error('conversion')}};
    const prospective=undefined;const program={get inputs(){trace.push('unreachable-inputs');return []},steps:[]};`],
  ['constructible custom alias-message error is untouched', `globalThis.expectedError=new TypeError('ProductsMap is not a constructor');
    globalThis.Map=function(){trace.push('construct');throw expectedError};const prospective=undefined;const program={inputs:[],steps:[]};`],
  ['constructible custom error with message setter is untouched', `globalThis.expectedError=new TypeError('custom');Object.defineProperty(expectedError,'message',{get(){trace.push('read-message');return 'custom'},set(){trace.push('unreachable-message-write')}});
    globalThis.Map=function(){trace.push('construct');throw expectedError};const prospective=undefined;const program={inputs:[],steps:[]};`],
  ['proxy construct trap runs once and probe never reads target', `globalThis.expectedError=new TypeError('ProductsMap is not a constructor');globalThis.Map=new OriginalProxy(OriginalMap,{construct(){trace.push('construct-trap');throw expectedError},get(target,key,receiver){trace.push('get:'+String(key));return Reflect.get(target,key,receiver)}});
    const prospective=undefined;const program={inputs:[],steps:[]};`],
  ['proxy prototype trap runs once on original construction', `globalThis.expectedError=new TypeError('ProductsMap is not a constructor');globalThis.Map=new OriginalProxy(OriginalMap,{get(target,key,receiver){trace.push('get:'+String(key));if(key==='prototype')throw expectedError;return Reflect.get(target,key,receiver)}});
    const prospective=undefined;const program={inputs:[],steps:[]};`],
  ['bound constructor preserves eager work', `globalThis.Map=(class extends OriginalMap {constructor(){super();trace.push('construct')}}).bind(null);
    const prospective=undefined;const program={inputs:[{source:'product',recipeId:'r',mass:1000}],steps:[]};`],
  ['bound throwing constructor runs once', `globalThis.expectedError=new TypeError('ProductsMap is not a constructor');globalThis.Map=(function(){trace.push('construct');throw expectedError}).bind(null);
    const prospective=undefined;const program={inputs:[],steps:[]};`],
  ['bound arrow probe has no effects', `globalThis.Map=(()=>trace.push('unreachable-arrow')).bind(null);const prospective=undefined;const program={inputs:[],steps:[]};`],
  ['proxy arrow ignores construct and get traps', `globalThis.Map=new OriginalProxy(()=>trace.push('unreachable-arrow'),{construct(){trace.push('unreachable-construct');return {}},get(){trace.push('unreachable-get');throw Error('get')}});
    const prospective=undefined;const program={inputs:[],steps:[]};`],
  ['revoked constructor error is unchanged', `const pair=OriginalProxy.revocable(OriginalMap,{});pair.revoke();globalThis.Map=pair.proxy;
    const prospective=undefined;const program={inputs:[],steps:[]};`],
  ['revoked arrow remains nonconstructible', `const pair=OriginalProxy.revocable(()=>trace.push('unreachable-arrow'),{});pair.revoke();globalThis.Map=pair.proxy;
    const prospective=undefined;const program={inputs:[],steps:[]};`],
  ['constructor probe uses startup Proxy rather than global accessor', `globalThis.expectedError=new TypeError('custom');globalThis.Map=function(){trace.push('construct');throw expectedError};
    Object.defineProperty(globalThis,'Proxy',{get(){trace.push('unreachable-global-proxy');throw Error('Proxy')}});const prospective=undefined;const program={inputs:[],steps:[]};`],
  ['Map accessor returns throwing proxy exactly once', `globalThis.expectedError=new TypeError('custom');const chosen=new OriginalProxy(OriginalMap,{construct(){trace.push('construct-trap');throw expectedError},get(){trace.push('unreachable-get');throw Error('get')}});
    Object.defineProperty(globalThis,'Map',{get(){trace.push('global-read');return chosen}});const prospective=undefined;const program={inputs:[],steps:[]};`],
  ['native error preparation is not observed by probe', `Error.prepareStackTrace=()=>{trace.push('unreachable-stack');return 'stack'};Object.defineProperty(Error,'stackTraceLimit',{get(){trace.push('stack-limit');return 10}});
    globalThis.Map=()=>trace.push('unreachable-arrow');const prospective=undefined;const program={inputs:[],steps:[]};`],
  ['probe uses startup prototype reader and TypeError prototype', `Object.getPrototypeOf=()=>{trace.push('unreachable-getPrototypeOf');throw Error('getPrototypeOf')};
    Object.defineProperty(globalThis,'TypeError',{get(){trace.push('unreachable-TypeError');throw Error('TypeError')}});
    globalThis.Map=()=>trace.push('unreachable-arrow');const prospective=undefined;const program={inputs:[],steps:[]};`],
  ['constructible proxy error is never inspected by probe', `globalThis.expectedError=new OriginalProxy(new TypeError('ProductsMap is not a constructor'),{get(target,key,receiver){trace.push('error-get:'+String(key));return Reflect.get(target,key,receiver)}});
    globalThis.Map=function(){trace.push('construct');throw expectedError};const prospective=undefined;const program={inputs:[],steps:[]};`],
  ['probe does not read error name or constructor', `Object.defineProperty(TypeError.prototype,'name',{get(){trace.push('error-name');return 'TypeError'}});
    Object.defineProperty(TypeError.prototype,'constructor',{get(){trace.push('unreachable-error-constructor');throw Error('constructor')}});
    globalThis.Map=()=>trace.push('unreachable-arrow');const prospective=undefined;const program={inputs:[],steps:[]};`],
];
for (const [name, scenario] of cases) {
  test(`Maplazy matches MAIN result/errors/trace: ${name}`, () => {
    assert.deepEqual(outcome(scripts[1]!, scenario), outcome(scripts[0]!, scenario));
  });
}

// Fault injection only: preserve the original error when the probe cannot decide.
// These mocked intrinsics are not an admission claim for a decorated startup.
for (const [name, replacement] of [
  ['outer Proxy creation TypeError', 'function(){throw new TypeError("probe creation")}'],
  ['outer Proxy creation RangeError', 'function(){throw new RangeError("probe creation")}'],
  ['probe construction RangeError', 'function(){return function(){throw new RangeError("probe construction")}}'],
]) {
  test(`Maplazy unknown probe preserves the original error: ${name}`, () => {
    const injectedStartup = startup.replace('const NativeProductsProxy = Proxy;', `const NativeProductsProxy = ${replacement};`);
    assert.notEqual(injectedStartup, startup);
    const scenario = `globalThis.expectedError=new TypeError('ProductsMap is not a constructor');globalThis.Map=function(){trace.push('construct');throw expectedError};
      const prospective=undefined;const program={inputs:[],steps:[]};`;
    assert.deepEqual(outcome(compile(injectedStartup + '\n' + candidateBody), scenario), outcome(scripts[0]!, scenario));
  });
}
