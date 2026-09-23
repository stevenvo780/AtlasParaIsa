import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTechnologyCatalogue, enableTechnologyCatalogue } from '../src/world/technology-catalogue.js';
import { assertTechnology, craftTechnology, defaultTechnologyState, initialTechnologyKnowledge, researchTechnology, shareTechnology,
  technologyOpportunity, toolCapacities, useTool, type TechnologyActor, type TechnologyHost, type TechnologyProgram } from '../src/world/technology.js';
import { PROGRAMA_FILO as foundation, proyectoInvestigacion } from './lib/escenas.js';


function discover(host: TechnologyHost, actor: TechnologyActor, program: TechnologyProgram) {
  const parents = [...new Set(program.inputs.flatMap(input => input.source === 'product' ? [input.recipeId!] : []))];
  actor.technology.project = proyectoInvestigacion(structuredClone(program), host.tick, parents);
  let success = false;
  while (actor.technology.project) { host.tick++; success = researchTechnology(host, actor); }
  assert.equal(success, true);
  return host.technology.recipes.at(-1)!;
}
function fabricate(host: TechnologyHost, actor: TechnologyActor, id: string) {
  let success = craftTechnology(host, actor, id);
  while (actor.technology.project) { host.tick++; success = craftTechnology(host, actor, id); }
  assert.equal(success, true);
}
function scene(options: { heat?: boolean; repeated?: boolean; longChain?: boolean; doubleTool?: boolean } = {}) {
  const actor = (id: string): TechnologyActor => ({ id, x: 0, y: 0, energy: 1, fatigue: 0, hunger: 0, thirst: 0,
    materials: { wood: 12, stone: 8 }, skills: {}, technology: initialTechnologyKnowledge() });
  const teacher = actor('teacher'), learner = actor('learner');
  const host: TechnologyHost = { seed: 51926, tick: 0, people: [teacher, learner], technology: defaultTechnologyState(),
    tiles: [{ x: 0, y: 0, terrain: 'meadow', moisture: 0.7, vegetation: 0.3, cultivation: 0, wood: 0, stone: 0 }] };
  const base = discover(host, teacher, foundation);
  fabricate(host, teacher, base.id);
  const first = discover(host, teacher, { inputs: [{ source: 'residue', material: 'stone', mass: 60 }],
    steps: [{ op: 'form', intensity: 4, shape: 'edge' }, ...(options.heat ? [{ op: 'heat' as const, intensity: 1 }, { op: 'cool' as const, intensity: 1 }] : [])] });
  let precursor = first;
  if (options.repeated) fabricate(host, teacher, first.id);
  if (options.longChain) precursor = discover(host, teacher, { inputs: [{ source: 'product', recipeId: first.id, mass: 50 }], steps: [{ op: 'compress', intensity: 1 }] });
  const final = discover(host, teacher, { inputs: [{ source: 'raw', material: 'wood', mass: 1000 }, { source: 'product', recipeId: precursor.id, mass: 50 },
    ...(options.repeated ? [{ source: 'product' as const, recipeId: precursor.id, mass: 50 }] : [])],
    steps: [{ op: 'combine', intensity: 1 }, { op: 'form', intensity: 4, shape: 'rod', requiredCatalyst: 'cutting' },
      ...(options.doubleTool ? [{ op: 'form' as const, intensity: 4, shape: 'rod' as const, requiredCatalyst: 'cutting' as const }] : []), { op: 'compress', intensity: 2 }] });
  learner.materials = { wood: 3, stone: 1 };
  assert.equal(shareTechnology(host, teacher, learner, undefined, base.id), true); fabricate(host, learner, base.id);
  for (const id of [...new Set([first.id, precursor.id, final.id])]) assert.equal(shareTechnology(host, teacher, learner, undefined, id), true);
  host.noveltyEnabled = false; host.tick += 45;
  assertTechnology(host);
  return { host, teacher, learner, first, precursor, final };
}

test('a finite three-stage plan selects the physically ready leaf and charges every later step', () => {
  const { host, learner, first, precursor, final } = scene({ longChain: true });
  const history = host.technology.executionCounter;
  for (const recipe of [first, precursor, final]) {
    const before = JSON.stringify(host);
    assert.equal(technologyOpportunity(host, learner)?.recipeId, recipe.id);
    assert.equal(JSON.stringify(host), before);
    fabricate(host, learner, recipe.id);
    // There is deliberately no research cooldown or attempts modulo manipulation.
  }
  const receipts = host.technology.history.filter(event => Number(event.id.slice(8)) > history && event.kind === 'craft');
  assert.deepEqual(receipts.map(event => event.recipeId), [first.id, precursor.id, final.id]);
  assert.ok(receipts.every(event => event.success && event.energy > 0 && event.work > 0));
  assert.equal(technologyOpportunity(host, learner), undefined, 'the obtained capacity ends this demand');
  assertTechnology(host);
});

test('the chain reserves real fuel as well as final material and the material needed to use its result', () => {
  const { host, learner, first } = scene({ heat: true });
  learner.materials.wood = 2.1;
  assert.equal(technologyOpportunity(host, learner)?.recipeId, first.id);
  const paid = host.technology.ledger.fuelMass;
  fabricate(host, learner, first.id);
  assert.equal(host.technology.ledger.fuelMass - paid, 50);
  assert.ok(Math.abs(learner.materials.wood - 2.05) < 1e-10);
  // Use a fresh paid fixture for the paired control: the missing 50 fuel quanta
  // cannot be borrowed from the wood already reserved for the final tool/use.
  const control = scene({ heat: true }); control.learner.materials.wood = 2;
  assert.equal(technologyOpportunity(control.host, control.learner), undefined);
  assertTechnology(host); assertTechnology(control.host);
});

test('repeated dependencies cannot spend the same residue twice', () => {
  const { host, learner } = scene({ repeated: true });
  assert.equal(learner.technology.residue.stone, 110);
  const before = JSON.stringify(host);
  assert.equal(technologyOpportunity(host, learner), undefined, 'two intermediates need 120, but only 110 residue quanta exist');
  assert.equal(JSON.stringify(host), before);
});

test('a cyclic remembered dependency cannot recurse or create an opportunity', () => {
  const { host, learner, first, final } = scene();
  first.program.inputs = [{ source: 'product', recipeId: final.id, mass: 50 }];
  // Corrupted instruction graph is a defensive negative, not a valid paid world.
  const before = JSON.stringify(host);
  assert.equal(technologyOpportunity(host, learner), undefined);
  assert.equal(JSON.stringify(host), before);
});

test('required catalyst wear is forecast between operations, not just checked once at entry', () => {
  const { host, learner, first, final } = scene({ doubleTool: true });
  assert.equal(technologyOpportunity(host, learner)?.recipeId, first.id);
  while (toolCapacities(learner).cutting > 0.1035) useTool(host, learner, 'cutting', 0.01);
  assert.ok(toolCapacities(learner).cutting >= 0.1, 'the first required operation can begin');
  assert.equal(technologyOpportunity(host, learner), undefined, 'wear makes the later required operation fail');
  fabricate(host, learner, first.id);
  let success = craftTechnology(host, learner, final.id);
  while (learner.technology.project) { host.tick++; success = craftTechnology(host, learner, final.id); }
  assert.equal(success, false, 'the unchanged real physical execution confirms the rejection');
  assertTechnology(host);
});

test('planning can resolve remembered archived instructions without cache mutation or catalogue-wide discovery', () => {
  const { host, learner, first } = scene(), archive = new Map(host.technology.recipes.map(recipe => [recipe.id, structuredClone(recipe)]));
  enableTechnologyCatalogue(host.technology, { committedThrough: host.technology.recipeCounter });
  host.technology.recipes = host.technology.recipes.slice(-1);
  const reads: string[] = [];
  bindTechnologyCatalogue(host.technology, {
    resolve(id) { reads.push(id); return archive.get(id) ?? null; },
    findBySignature() { assert.fail('a planner cannot search the global catalogue'); },
  });
  const before = JSON.stringify(host), cache = host.technology.recipes;
  assert.equal(technologyOpportunity(host, learner)?.recipeId, first.id);
  assert.equal(JSON.stringify(host), before); assert.equal(host.technology.recipes, cache);
  assert.ok(reads.length > 0); assert.ok(reads.every(id => learner.technology.knownRecipes.includes(id)));
});
