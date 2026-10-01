import test from 'node:test';
import assert from 'node:assert/strict';
import type { Capability, Composition, TechnologyProgram, TechnologyRecipe } from '../src/shared/technology.js';
import type { Person, World } from '../src/world/index.js';
import { cooperationOpportunity, type Opportunity } from '../src/world/society.js';
import { createProgramRequirementsCache, localProgramAvailability, prospectiveProgramsByProduct, summarizeProgramRequirements } from '../src/world/programa-requisitos.js';
import { CAPABILITIES, itemCapacities, MASS_UNIT, programSignature } from '../src/world/technology.js';
import { bindTechnologyCatalogue, enableTechnologyCatalogue, resolveTechnologyRecipe, withRecipeSession } from '../src/world/technology-catalogue.js';
import { diferenciaCanonica, digestoCanonico } from '../src/world/digesto.js';
import { paramsOf, setParams } from '../src/world/params.js';
import { tileAt } from '../src/world/spatial.js';
import { vecinos } from '../src/world/rejilla.js';
import { constructionCost } from '../src/world/inventions.js';
import { aula, proyectoInvestigacion } from './lib/escenas.js';

const empty = (): Composition => ({ wood: 0, stone: 0, water: 0 });
const noPowers = (): Record<Capability, number> => Object.fromEntries(CAPABILITIES.map(c => [c, 0])) as Record<Capability, number>;

// Fórmula literal anterior al cache (MAIN bb483260); sin resumir ni memoizar.
function referenceAvailability(program: TechnologyProgram, raw: Composition, availableResidue: Composition,
  powers: Record<Capability, number>, productMass: (id: string) => number, prospectiveProductId?: string): boolean {
  const required = { wood: 0, stone: 0, water: 0 }, residue = { wood: 0, stone: 0, water: 0 }, products = new Map<string, number>();
  for (const input of program.inputs) {
    if (input.source === 'product') products.set(input.recipeId!, (products.get(input.recipeId!) ?? 0) + input.mass);
    else (input.source === 'raw' ? required : residue)[input.material!] += input.mass;
  }
  const fuel = program.steps.reduce((n, step) => n + (step.op === 'heat' ? step.intensity * 50 : 0), 0);
  required.wood += Math.max(0, fuel - Math.max(0, availableResidue.wood - residue.wood));
  return (['wood', 'stone', 'water'] as const).every(material => required[material] <= raw[material] && residue[material] <= availableResidue[material]) &&
    [...products].every(([id, needed]) => id === prospectiveProductId || productMass(id) >= needed) &&
    program.steps.every(step => !step.requiredCatalyst || powers[step.requiredCatalyst] >= 0.1);
}

test('los resúmenes conservan bits y orden de sumas por material, productos y combustible', () => {
  const program: TechnologyProgram = {
    inputs: [
      { source: 'raw', material: 'wood', mass: 2 ** 53 }, { source: 'raw', material: 'stone', mass: -0 },
      { source: 'raw', material: 'wood', mass: 1 }, { source: 'raw', material: 'wood', mass: -(2 ** 53) },
      { source: 'product', recipeId: 'b', mass: 2 ** 53 }, { source: 'product', recipeId: 'a', mass: -0 },
      { source: 'product', recipeId: 'b', mass: 1 }, { source: 'product', recipeId: 'b', mass: -(2 ** 53) },
      { source: 'residue', material: 'wood', mass: Number.NaN }, { source: 'residue', material: 'water', mass: -0 },
    ],
    steps: [{ op: 'heat', intensity: 2 ** 53 / 50 }, { op: 'cool', intensity: 4, requiredCatalyst: 'binding' },
      { op: 'heat', intensity: 1 / 50 }, { op: 'heat', intensity: -(2 ** 53) / 50, requiredCatalyst: 'cutting' },
      { op: 'form', intensity: 1, requiredCatalyst: 'binding' }],
  };
  const summary = summarizeProgramRequirements(program);
  for (const material of ['wood', 'stone', 'water'] as const) {
    const raw = program.inputs.filter(i => i.source === 'raw' && i.material === material).reduce((n, i) => n + i.mass, 0);
    const residue = program.inputs.filter(i => i.source === 'residue' && i.material === material).reduce((n, i) => n + i.mass, 0);
    assert.ok(Object.is(summary.raw[material], raw)); assert.ok(Object.is(summary.residue[material], residue));
  }
  assert.deepEqual([...summary.products.keys()], ['b', 'a']);
  for (const [id, mass] of summary.products) assert.ok(Object.is(mass, program.inputs.filter(i => i.source === 'product' && i.recipeId === id).reduce((n, i) => n + i.mass, 0)));
  assert.ok(Object.is(summary.fuel, program.steps.reduce((n, s) => n + (s.op === 'heat' ? s.intensity * 50 : 0), 0)));
  assert.deepEqual(summary.catalysts, ['binding', 'cutting', 'binding']);
  const cache = createProgramRequirementsCache();
  assert.equal(cache(program), cache(program));
  assert.notEqual(cache(program), cache(structuredClone(program)));
  assert.notEqual(cache(program), createProgramRequirementsCache()(program));
});

test('disponibilidad coincide con la fórmula literal: residuo reservado, calor, duplicados, catalizadores y NaN', () => {
  const program: TechnologyProgram = {
    inputs: [{ source: 'raw', material: 'wood', mass: 70 }, { source: 'raw', material: 'wood', mass: 30 },
      { source: 'residue', material: 'wood', mass: 50 }, { source: 'residue', material: 'wood', mass: 50 },
      { source: 'residue', material: 'stone', mass: 10 }, { source: 'raw', material: 'water', mass: 20 },
      { source: 'product', recipeId: 'a', mass: 7 }, { source: 'product', recipeId: 'b', mass: 20 }, { source: 'product', recipeId: 'a', mass: 13 }],
    steps: [{ op: 'heat', intensity: 1 }, { op: 'cool', intensity: 2 }, { op: 'heat', intensity: 2, requiredCatalyst: 'binding' }, { op: 'form', intensity: 1, requiredCatalyst: 'binding' }],
  };
  const baseline = { raw: { wood: 250, stone: 0, water: 20 }, residue: { wood: 100, stone: 10, water: 0 },
    powers: { ...noPowers(), binding: 0.1 }, mass: { a: 20, b: 20 } };
  const cases = [baseline,
    { ...baseline, raw: { ...baseline.raw, wood: 249 } },
    { ...baseline, residue: { ...baseline.residue, wood: 99 } },
    { ...baseline, residue: { ...baseline.residue, wood: 250 }, raw: { ...baseline.raw, wood: 100 } },
    { ...baseline, mass: { a: 19, b: 20 } }, { ...baseline, mass: { a: 0, b: 19 } },
    { ...baseline, powers: { ...baseline.powers, binding: 0 } },
    { ...baseline, powers: { ...baseline.powers, binding: Number.NaN } },
    { ...baseline, raw: { ...baseline.raw, stone: Number.NaN } },
    { ...baseline, residue: { ...baseline.residue, wood: Number.NaN } },
    { ...baseline, mass: { a: Number.NaN, b: 20 } },
  ];
  for (const scenario of cases) {
    const mass = (id: string) => scenario.mass[id as 'a' | 'b'];
    const available = localProgramAvailability(scenario.raw, scenario.residue, scenario.powers, mass);
    for (const skip of [undefined, 'a', 'b', 'missing']) for (let repeated = 0; repeated < 2; repeated++) {
      assert.equal(available(program, skip), referenceAvailability(program, scenario.raw, scenario.residue, scenario.powers, mass, skip));
    }
  }
  const zero: TechnologyProgram = { inputs: [{ source: 'raw', material: 'wood', mass: -0 }], steps: [{ op: 'heat', intensity: -0 }] };
  const raw = { wood: -0, stone: -0, water: -0 }, residue = { wood: -0, stone: -0, water: -0 };
  assert.equal(localProgramAvailability(raw, residue, noPowers(), () => -0)(zero), referenceAvailability(zero, raw, residue, noPowers(), () => -0));
});

test('el memo es local al programa, producto prospectivo e inventario de la evaluación', () => {
  const program: TechnologyProgram = { inputs: [{ source: 'product', recipeId: 'a', mass: 20 }, { source: 'product', recipeId: 'b', mass: 20 }], steps: [] };
  const calls: string[] = [], requirements = createProgramRequirementsCache();
  const mass = (id: string) => { calls.push(id); return id === 'a' ? 20 : 0; };
  const available = localProgramAvailability(empty(), empty(), noPowers(), mass, requirements);
  assert.equal(available(program), false); assert.deepEqual(calls, ['a', 'b']);
  assert.equal(available(program), false); assert.deepEqual(calls, ['a', 'b']);
  assert.equal(available(program, 'b'), true); assert.deepEqual(calls, ['a', 'b', 'a']);
  assert.equal(available(program, 'a'), false); assert.deepEqual(calls, ['a', 'b', 'a', 'b']);
  assert.equal(available(structuredClone(program)), false); assert.deepEqual(calls, ['a', 'b', 'a', 'b', 'a', 'b']);
  // Una acción posterior usa una clausura nueva; ni siquiera compartir el resumen
  // del programa comparte las existencias o el resultado booleano.
  const refreshed = localProgramAvailability(empty(), empty(), noPowers(), () => 20, requirements);
  assert.equal(refreshed(program), true);
});

test('el índice prospectivo conserva la subsecuencia original y sus programas duplicados', () => {
  const a: TechnologyProgram = { inputs: [{ source: 'product', recipeId: 'x', mass: 1 }, { source: 'product', recipeId: 'x', mass: 2 }], steps: [] };
  const unrelated: TechnologyProgram = { inputs: [{ source: 'raw', material: 'wood', mass: 1 }], steps: [] };
  const b: TechnologyProgram = { inputs: [{ source: 'product', recipeId: 'y', mass: 1 }, { source: 'product', recipeId: 'x', mass: 3 }], steps: [] };
  const programs = [a, unrelated, a, b, a, b], index = prospectiveProgramsByProduct(programs);
  assert.deepEqual(index.get('x'), [a, a, b, a, b]); assert.deepEqual(index.get('y'), [b, b]);
  for (const id of ['x', 'y', 'missing']) for (const accepted of [undefined, a, b]) {
    const before: TechnologyProgram[] = [], after: TechnologyProgram[] = [];
    const reference = programs.some(program => program.inputs.some(input => input.source === 'product' && input.recipeId === id) && (before.push(program), program === accepted));
    const optimized = index.get(id)?.some(program => (after.push(program), program === accepted)) ?? false;
    assert.equal(optimized, reference); assert.deepEqual(after, before);
  }
});

function referenceLocalInputs(world: World, teacher: Person, learner: Person) {
  const raw = { wood: (learner.materials.wood + teacher.materials.wood) * MASS_UNIT,
    stone: (learner.materials.stone + teacher.materials.stone) * MASS_UNIT, water: 0 };
  for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {
    if (dx * dx + dy * dy > 49) continue;
    const tile = tileAt(world, { x: learner.x + dx, y: learner.y + dy });
    if (tile && tile.terrain !== 'water') { raw.wood += (tile.wood ?? 0) * MASS_UNIT; raw.stone += (tile.stone ?? 0) * MASS_UNIT; raw.water += (tile.drinkingWater ?? 0) * 50_000; }
  }
  const items = [...learner.technology.items, ...teacher.technology.items], powers = itemCapacities(items);
  return (program: TechnologyProgram, prospectiveProductId?: string) => referenceAvailability(program, raw, learner.technology.residue,
    powers, id => items.filter(item => item.recipeId === id).reduce((n, item) => n + item.mass, 0), prospectiveProductId);
}
function referenceRequested(world: World, person: Person): TechnologyProgram[] {
  if (!['research', 'craft'].includes(person.action)) return [];
  if (person.technology.project) return [person.technology.project.program];
  if (person.action !== 'craft') return [];
  return person.technology.knownRecipes.flatMap(id => { const recipe = resolveTechnologyRecipe(world, id); return recipe ? [recipe.program] : []; });
}
function referenceTeaching(world: World, teacher: Person, learner: Person): string | undefined {
  if (!world.learningEnabled) return;
  const candidates: TechnologyRecipe[] = [];
  for (const id of teacher.technology.knownRecipes.filter(id => !((teacher.technology.competence[id]?.successes ?? 0) <= 0))) {
    if (learner.technology.knownRecipes.includes(id)) continue;
    const recipe = resolveTechnologyRecipe(world, id); if (recipe) candidates.push(recipe);
  }
  if (!candidates.length) return;
  const available = referenceLocalInputs(world, teacher, learner);
  const remembered = learner.technology.knownRecipes.flatMap(id => { const recipe = resolveTechnologyRecipe(world, id); return recipe ? [recipe] : []; });
  const known = remembered.filter(recipe => available(recipe.program));
  const powers = Object.fromEntries(CAPABILITIES.map(capability => {
    let power = 0; for (const recipe of known) power = Math.max(power, recipe.capacities[capability]); return [capability, power];
  })) as Record<Capability, number>;
  const prospective = [...remembered.map(recipe => recipe.program), ...referenceRequested(world, learner)];
  const viable = candidates.filter(recipe => available(recipe.program)).map(recipe => ({ recipe,
    gain: Math.max(...CAPABILITIES.map(capability => recipe.capacities[capability] - powers[capability])) +
      (prospective.some(program => program.inputs.some(input => input.source === 'product' && input.recipeId === recipe.id) && available(program, recipe.id)) ? 1 : 0),
  })).filter(candidate => candidate.gain > 0.12);
  const rareza = paramsOf(world).social.ensenanzaRareza, holders = rareza > 0 ? new Map(viable.map(c => [c.recipe.id, 0])) : undefined;
  if (holders) for (const person of world.people) for (const id of person.technology.knownRecipes) {
    const held = holders.get(id); if (held !== undefined) holders.set(id, held + 1);
  }
  return viable.map(candidate => ({ ...candidate, key: candidate.gain + (holders ? rareza * (1 - (holders.get(candidate.recipe.id) ?? 0) / Math.max(1, world.people.length)) : 0) }))
    .sort((a, b) => b.key - a.key || (teacher.technology.competence[b.recipe.id]?.benefit ?? 0) - (teacher.technology.competence[a.recipe.id]?.benefit ?? 0) || a.recipe.id.localeCompare(b.recipe.id))[0]?.recipe.id;
}
function referenceProcessNeed(world: World, person: Person): { wood: number; stone: number } {
  const deficit = { wood: 0, stone: 0 };
  for (const program of referenceRequested(world, person)) {
    const required = { wood: 0, stone: 0 };
    for (const input of program.inputs) if (input.source === 'raw' && (input.material === 'wood' || input.material === 'stone')) required[input.material] += input.mass / MASS_UNIT;
    const fuel = program.steps.reduce((n, s) => n + (s.op === 'heat' ? s.intensity * 50 : 0), 0);
    const scrapUsed = program.inputs.filter(i => i.source === 'residue' && i.material === 'wood').reduce((n, i) => n + i.mass, 0);
    required.wood += Math.max(0, fuel - Math.max(0, person.technology.residue.wood - scrapUsed)) / MASS_UNIT;
    for (const material of ['wood', 'stone'] as const) deficit[material] = Math.max(deficit[material], required[material] - person.materials[material]);
  }
  return deficit;
}
// Referencia de MAIN restringida por el montaje: inventarios vacíos y acciones
// rest/craft/research excluyen intercambio, obra, caza y enseñanza de habilidades.
function referenceOpportunity(world: World, person: Person): Opportunity | undefined {
  if (!world.cooperationEnabled) return;
  const distance = (a: Person, b: Person) => Math.hypot(a.x - b.x, a.y - b.y);
  return withRecipeSession(world, () => {
    if (world.tick - person.lastSocial < 30) return;
    const opportunities: Opportunity[] = [];
    assert.equal(person.technology.items.length, 0);
    for (const other of vecinos(world, person, 8, other => !(other === person || distance(person, other) > 7), 'cooperationOpportunity')) {
      assert.equal(other.technology.items.length, 0); assert.ok(['rest', 'craft', 'research'].includes(other.action));
      const same = person.communityId && person.communityId === other.communityId;
      const trust = person.bonds[other.id] ?? 0.2;
      const openness = other.communityId !== person.communityId && !same ? person.culture.openness : 1;
      const score = 0.22 + person.genome.cooperation * 0.35 + trust * 0.16 + openness * 0.07;
      constructionCost(world, other);
      const need = referenceProcessNeed(world, other);
      const supplyMaterial = (['wood', 'stone'] as const).find(m => need[m] > 0 && person.materials[m] >= 1 && other.materials[m] <= (m === 'wood' ? 11 : 7));
      const recipeId = referenceTeaching(world, person, other);
      if (supplyMaterial) opportunities.push({ person: other, kind: 'supply', supplyMaterial, score: score + 0.22 });
      if (recipeId) opportunities.push({ person: other, kind: 'teach', recipeId, score: score + 0.06 });
      if (person.materials.wood >= 2 && person.materials.stone < 2 && other.materials.stone >= 2 && other.materials.wood < 6) opportunities.push({ person: other, kind: 'trade', score: score + 0.08 });
    }
    return opportunities.sort((a, b) => b.score - a.score || distance(person, a.person) - distance(person, b.person) || a.person.id.localeCompare(b.person.id))[0];
  });
}

function decisionScene(action: 'rest' | 'craft' | 'research', capacity: number, rareza: number, extraRecipes = 0) {
  const { world, maestro, aprendiz } = aula({ cuerpo: { energy: 1, fatigue: 0, hunger: 0.1, thirst: 0.1 } });
  maestro.materials = { wood: 12, stone: 8 }; aprendiz.materials = { wood: 12, stone: 8 }; aprendiz.action = action;
  const programs: TechnologyProgram[] = [
    { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }], steps: [{ op: 'form', intensity: 4, shape: 'edge' }] },
    { inputs: [{ source: 'raw', material: 'wood', mass: 1000 }], steps: [{ op: 'weave', intensity: 4 }] },
    { inputs: [{ source: 'raw', material: 'wood', mass: 800 }], steps: [{ op: 'compress', intensity: 4 }] },
    { inputs: [{ source: 'raw', material: 'stone', mass: 2e12 }], steps: [{ op: 'form', intensity: 4 }] },
    { inputs: [{ source: 'product', recipeId: 'recipe-1', mass: 400 }, { source: 'product', recipeId: 'recipe-1', mass: 600 }], steps: [{ op: 'cool', intensity: 1 }] },
    { inputs: [{ source: 'product', recipeId: 'recipe-2', mass: 300 }], steps: [{ op: 'combine', intensity: 1, requiredCatalyst: 'binding' }] },
  ];
  for (let i = 0; i < extraRecipes; i++) programs.push({ inputs: [{ source: 'raw', material: 'wood', mass: 1000 + i }], steps: [{ op: 'compress', intensity: 2 }] });
  world.technology.recipes = programs.map((program, i): TechnologyRecipe => ({ id: `recipe-${i + 1}`, name: `Program ${i + 1}`, program,
    signature: programSignature(program), parents: [], generation: 1, inventorId: maestro.id, tick: world.tick, x: maestro.x, y: maestro.y,
    novelty: 'program', capacities: { ...noPowers(), cutting: i === 0 ? 0.3 : 0.8 }, uses: 0, utility: 0, manufactured: 0 }));
  world.technology.recipeCounter = programs.length;
  maestro.technology.knownRecipes = ['recipe-1', 'recipe-2', 'recipe-3', 'recipe-1', 'recipe-4', 'recipe-6'];
  for (let i = 0; i < extraRecipes; i++) maestro.technology.knownRecipes.push(`recipe-${7 + i}`);
  for (const id of maestro.technology.knownRecipes) maestro.technology.competence[id] = { successes: id === 'recipe-6' ? 0 : 1, attempts: 1, benefit: id === 'recipe-3' ? 2 : 1, work: 1 };
  aprendiz.technology.knownRecipes = ['recipe-5', 'recipe-6', 'recipe-5'];
  if (action === 'research') aprendiz.technology.project = proyectoInvestigacion(programs[4]!, world.tick);
  const other = world.people[4]!; other.x = 35; other.y = 12; other.target = { x: 35, y: 12 }; other.action = action;
  other.materials = { wood: 12, stone: 8 }; other.technology.knownRecipes = ['recipe-6', 'recipe-5'];
  const params = structuredClone(paramsOf(world)); params.social.ensenanzaRareza = rareza; setParams(world, params);
  const definitions = new Map(world.technology.recipes.map(recipe => [recipe.id, structuredClone(recipe)]));
  enableTechnologyCatalogue(world.technology, { committedThrough: programs.length, memoryCapacity: capacity });
  world.technology.budgets.maxRecipes = capacity; world.technology.recipes = world.technology.recipes.slice(-capacity);
  return { world, definitions };
}
function bindScene(world: World, definitions: Map<string, TechnologyRecipe>): string[] {
  const calls: string[] = [];
  bindTechnologyCatalogue(world.technology, {
    freshCopies: true,
    resolve(id, atTick) { calls.push(`${id}@${atTick}`); return structuredClone(definitions.get(id) ?? null); },
    findBySignature() { throw new Error('Una evaluación social no busca definiciones nuevas.'); },
  });
  return calls;
}
function metadata(opportunity: Opportunity | undefined) {
  if (!opportunity) return undefined;
  const { person, ...detail } = opportunity; return { ...detail, personId: person.id };
}

test('cooperación conserva metadata, llamadas de archivo, LRU y digesto completo frente a MAIN', () => {
  for (const action of ['rest', 'craft', 'research'] as const) for (const capacity of [1, 2, 3]) for (const rareza of [0, 0.3]) {
    const { world, definitions } = decisionScene(action, capacity, rareza), reference = structuredClone(world);
    setParams(reference, paramsOf(world));
    const calls = bindScene(world, definitions), originalCalls = bindScene(reference, definitions);
    // También repetir después de cambiar existencias y las instrucciones: no hay
    // resultado escondido de la decisión previa, aunque el tick sea el mismo.
    for (let invocation = 0; invocation < 3; invocation++) {
      if (invocation === 1) { world.people[3]!.technology.knownRecipes.push('recipe-1'); reference.people[3]!.technology.knownRecipes.push('recipe-1'); }
      if (invocation === 2) { world.people[3]!.materials = { wood: 0, stone: 0 }; reference.people[3]!.materials = { wood: 0, stone: 0 }; }
      assert.deepEqual(metadata(cooperationOpportunity(world, world.people[2]!)), metadata(referenceOpportunity(reference, reference.people[2]!)), `${action}/${capacity}/${rareza}/${invocation}`);
      assert.deepEqual(calls, originalCalls);
      assert.deepEqual(world.technology.recipes.map(r => r.id), reference.technology.recipes.map(r => r.id));
      assert.equal(digestoCanonico(world), digestoCanonico(reference), JSON.stringify(diferenciaCanonica(world, reference)));
    }
  }
});

test('las guardas de cooperación y aprendizaje mantienen las lecturas y el estado de MAIN', () => {
  for (const guard of ['cooperation', 'learning', 'cooldown'] as const) {
    const { world, definitions } = decisionScene('craft', 1, 0);
    if (guard === 'cooperation') world.cooperationEnabled = false;
    if (guard === 'learning') world.learningEnabled = false;
    if (guard === 'cooldown') world.people[2]!.lastSocial = world.tick;
    const reference = structuredClone(world), calls = bindScene(world, definitions), originalCalls = bindScene(reference, definitions);
    setParams(reference, paramsOf(world));
    assert.deepEqual(metadata(cooperationOpportunity(world, world.people[2]!)), metadata(referenceOpportunity(reference, reference.people[2]!)));
    assert.deepEqual(calls, originalCalls); assert.equal(digestoCanonico(world), digestoCanonico(reference));
  }
});

test('las rutas perezosas conservan MAIN con práctica vacía, corta, larga y candidatas no viables', () => {
  const variants = ['empty', 'unpracticed', 'single', 'eight', 'large', 'known', 'unavailable', 'no-products'] as const;
  for (const variant of variants) for (const action of ['rest', 'craft'] as const) {
    const { world, definitions } = decisionScene(action, 2, 0, 12), teacher = world.people[2]!, learner = world.people[3]!;
    if (variant === 'empty') teacher.technology.knownRecipes = [];
    if (variant === 'unpracticed') for (const competence of Object.values(teacher.technology.competence)) competence.successes = 0;
    if (variant === 'single') teacher.technology.knownRecipes = ['recipe-1'];
    if (variant === 'eight') {
      teacher.technology.knownRecipes = ['recipe-1', 'recipe-2', 'recipe-3', 'recipe-4', 'recipe-7', 'recipe-8', 'recipe-9', 'recipe-10'];
      assert.equal(teacher.technology.knownRecipes.length, 8);
    }
    if (variant === 'large') assert.ok(teacher.technology.knownRecipes.filter(id => teacher.technology.competence[id]!.successes > 0).length > 8);
    if (variant === 'known') {
      learner.technology.knownRecipes = [...teacher.technology.knownRecipes];
      world.people[4]!.technology.knownRecipes = [...teacher.technology.knownRecipes];
    }
    if (variant === 'unavailable') teacher.technology.knownRecipes = ['recipe-4'];
    if (variant === 'no-products') { learner.technology.knownRecipes = []; world.people[4]!.technology.knownRecipes = []; }
    const reference = structuredClone(world); setParams(reference, paramsOf(world));
    const calls = bindScene(world, definitions), originalCalls = bindScene(reference, definitions);
    assert.deepEqual(metadata(cooperationOpportunity(world, teacher)), metadata(referenceOpportunity(reference, reference.people[2]!)), `${variant}/${action}`);
    assert.deepEqual(calls, originalCalls, `${variant}/${action}: archive calls`);
    assert.deepEqual(world.technology.recipes.map(r => r.id), reference.technology.recipes.map(r => r.id));
    assert.equal(digestoCanonico(world), digestoCanonico(reference), JSON.stringify(diferenciaCanonica(world, reference)));
  }
});

test('consultar primero un producto prospectivo no acredita la disponibilidad ordinaria', () => {
  const program: TechnologyProgram = { inputs: [{ source: 'product', recipeId: 'recipe-1', mass: 100 }], steps: [] };
  const calls: string[] = [], availability = localProgramAvailability(empty(), empty(), noPowers(), id => { calls.push(id); return 0; });
  assert.equal(availability(program, 'recipe-1'), true); assert.deepEqual(calls, []);
  assert.equal(availability(program), false); assert.deepEqual(calls, ['recipe-1']);
  assert.equal(availability(program, 'recipe-1'), true); assert.equal(availability(program), false);
  assert.deepEqual(calls, ['recipe-1']);
  assert.equal(availability(program, 'recipe-2'), false); assert.deepEqual(calls, ['recipe-1', 'recipe-1']);
});
