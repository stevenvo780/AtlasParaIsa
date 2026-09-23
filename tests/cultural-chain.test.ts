import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cloneWorld, stepWorld, type Person, type World } from '../src/world/index.js';
import { HISTORICAL_PARAMS } from '../src/world/params.js';
import { cooperate, cooperationOpportunity } from '../src/world/society.js';
import { assertTechnology, craftTechnology, researchTechnology, shareTechnology, technologyOpportunity, technologyStock, technologyWorkCost, type TechnologyProgram } from '../src/world/technology.js';
import { recordChronicleEvent } from '../src/world/chronicle-journal.js';
import type { ChronicleEvent } from '../src/shared/types.js';
import { PROGRAMA_FILO as base, aula, proyectoInvestigacion } from './lib/escenas.js';

const intermediate: TechnologyProgram = { inputs: [{ source: 'residue', material: 'stone', mass: 60 }],
  steps: [{ op: 'form', intensity: 4, shape: 'edge' }] };

function nextTick(world: World) {
  world.tick++;
  for (const person of world.people) person.demography.age = world.tick - person.bornAt;
}
function discover(world: World, person: Person, program: TechnologyProgram) {
  const parents = [...new Set(program.inputs.flatMap(input => input.source === 'product' ? [input.recipeId!] : []))];
  person.technology.project = proyectoInvestigacion(structuredClone(program), world.tick, parents);
  let success = false;
  for (let n = 0; person.technology.project && n < 300; n++) { nextTick(world); success = researchTechnology(world, person); }
  assert.equal(success, true); assert.equal(person.technology.project, null);
  return world.technology.recipes.at(-1)!;
}
function fabricate(world: World, person: Person, recipeId: string) {
  let success = craftTechnology(world, person, recipeId);
  for (let n = 0; person.technology.project && n < 300; n++) { nextTick(world); success = craftTechnology(world, person, recipeId); }
  assert.equal(success, true); assert.equal(person.technology.project, null);
}
function scene(requiredTool = false) {
  // Reglas 10, etapa 1: escena medida en el mundo de antes; con el cortejo por defecto el aprendiz
  // sale a buscar pareja en vez de fabricar, así que parte de `HISTORICAL_PARAMS` explícitos.
  const { world, maestro: teacher, aprendiz: learner } = aula({ params: HISTORICAL_PARAMS, cuerpo: { energy: 1, fatigue: 0, hunger: 0, thirst: 0 } });
  teacher.materials = { wood: 12, stone: 8 }; learner.materials = { wood: 1, stone: 1 };
  const foundation = discover(world, teacher, base), precursor = discover(world, teacher, intermediate);
  const final = discover(world, teacher, { inputs: [{ source: 'raw', material: 'wood', mass: 1000 }, { source: 'product', recipeId: precursor.id, mass: 50 }],
    steps: [{ op: 'combine', intensity: 1 }, { op: 'form', intensity: 4, shape: 'rod', ...(requiredTool ? { requiredCatalyst: 'cutting' as const } : {}) }, { op: 'compress', intensity: 2 }] });
  assert.equal(shareTechnology(world, teacher, learner, undefined, foundation.id), true);
  fabricate(world, learner, foundation.id); // Its paid waste supplies the intermediate's substrate.
  assert.equal(shareTechnology(world, teacher, learner, undefined, final.id), true);
  teacher.materials = { wood: 0, stone: 0 };
  world.noveltyEnabled = false;
  assertTechnology(world);
  return { world, teacher, learner, precursor, final };
}
function emit(world: World) { return (event: Omit<ChronicleEvent, 'id' | 'tick'>) => {
  const result = recordChronicleEvent(world, event); world.events.push(result); return result;
}; }

test('a known procedure motivates learning its paid intermediate before fabrication can start', () => {
  const { world, teacher, learner, precursor, final } = scene();
  assert.ok(Math.max(...Object.values(precursor.capacities)) < 0.12, 'the intermediate has no stand-alone utility above the teaching threshold');
  assert.equal(learner.action, 'rest'); assert.equal(technologyOpportunity(world, learner), undefined);
  assert.equal(craftTechnology(world, learner, final.id), false, 'the missing intermediate prevents starting the final procedure');
  const stocks = structuredClone([technologyStock(teacher), technologyStock(learner)]), teacherEnergy = teacher.energy;
  assert.equal(cooperationOpportunity(world, teacher)?.recipeId, precursor.id);
  assert.equal(cooperate(world, teacher, emit(world)), true);
  assert.deepEqual([technologyStock(teacher), technologyStock(learner)], stocks, 'a lesson creates no products, waste or raw materials');
  assert.equal(teacher.energy, teacherEnergy - 0.003);
  assert.equal(learner.technology.competence[precursor.id], undefined, 'learning does not grant successful execution history');
  const work = world.technology.ledger.work, energy = learner.energy;
  const mass = technologyStock(learner).reduce((sum, stock) => sum + stock.mass, 0) + (learner.materials.wood + learner.materials.stone) * 1000;
  fabricate(world, learner, precursor.id); fabricate(world, learner, final.id);
  assert.equal(world.technology.ledger.work - work, technologyWorkCost(intermediate) + technologyWorkCost(final.program));
  assert.ok(learner.energy < energy); assert.equal(learner.materials.wood, 0);
  assert.ok(learner.technology.items.some(item => item.recipeId === final.id));
  assert.equal(technologyStock(learner).reduce((sum, stock) => sum + stock.mass, 0) + (learner.materials.wood + learner.materials.stone) * 1000, mass);
  assertTechnology(world);
});

test('a forgotten final recipe in the world catalogue cannot create a demand for its intermediate', () => {
  const { world, teacher, learner, final } = scene();
  for (const person of [teacher, learner]) {
    person.technology.knownRecipes = person.technology.knownRecipes.filter(id => id !== final.id);
    person.technology.learnedFrom = person.technology.learnedFrom.filter(entry => entry.recipeId !== final.id);
  }
  assert.ok(world.technology.recipes.some(recipe => recipe.id === final.id));
  assert.equal(cooperationOpportunity(world, teacher), undefined);
  assert.equal(cooperate(world, teacher, emit(world)), false);
  assertTechnology(world);
});

test('dependency teaching still requires available substrate for both stages and local interaction', () => {
  const { world, teacher, learner, precursor } = scene();
  assert.equal(cooperationOpportunity(world, teacher)?.recipeId, precursor.id);
  for (const missing of ['intermediate', 'final'] as const) {
    const blocked = cloneWorld(world), a = blocked.people[2]!, b = blocked.people[3]!;
    if (missing === 'intermediate') b.technology.residue.stone = 0;
    else {
      a.materials.wood = b.materials.wood = 0;
      for (const tile of blocked.tiles) tile.wood = 0;
      blocked.tiles.find(tile => tile.x === 28 && tile.y === 12)!.wood = 10; // Eight cells away.
    }
    assert.notEqual(cooperationOpportunity(blocked, a)?.recipeId, precursor.id, `${missing} inputs are unavailable locally`);
  }
  teacher.x = learner.x + 2;
  assert.equal(cooperationOpportunity(world, teacher)?.recipeId, precursor.id);
  assert.equal(cooperate(world, teacher, emit(world)), false, 'observing an opportunity is not an interaction at a distance');
  teacher.x = learner.x + 8;
  assert.equal(cooperationOpportunity(world, teacher), undefined);
});

test('disabling social learning cannot deliver an intermediate or start the dependent procedure', () => {
  const { world, teacher, learner, precursor, final } = scene();
  world.learningEnabled = false;
  const before = structuredClone({ teacher, learner, totals: world.totals, ledger: world.technology.ledger });
  assert.equal(cooperate(world, teacher, emit(world)), false);
  assert.deepEqual({ teacher, learner, totals: world.totals, ledger: world.technology.ledger }, before);
  assert.equal(craftTechnology(world, learner, precursor.id), false);
  assert.equal(craftTechnology(world, learner, final.id), false);
  assert.deepEqual(technologyStock(learner), technologyStock(before.learner));
  assert.deepEqual(learner.materials, before.learner.materials);
  assert.deepEqual(learner.technology.knownRecipes, before.learner.technology.knownRecipes);
  assert.equal(learner.energy, before.learner.energy);
  assertTechnology(world);
});

function autonomousScene() {
  const result = scene(true), { world, learner, teacher, precursor } = result;
  learner.materials.wood = 2; // One initial raw unit for fabrication, one for actual cultivation.
  for (const tile of world.tiles) { tile.wood = tile.stone = 0; tile.vegetation = 0.95; }
  const field = world.tiles.find(tile => tile.x === learner.x && tile.y === learner.y)!;
  field.terrain = 'meadow'; field.moisture = 0.7; field.vegetation = 0.3; field.cultivation = 0; field.food = 0.3;
  assert.equal(cooperate(world, teacher, emit(world)), true);
  assert.ok(learner.technology.knownRecipes.includes(precursor.id));
  teacher.x = 10; teacher.y = 20; teacher.target = { x: 10, y: 20 };
  learner.curiosity = 0; learner.traits.industriousness = 0.6; learner.culture.stewardship = 1;
  learner.decisionAt = world.tick; learner.command = null; learner.controlMode = 'auto';
  for (let n = 0; n < 45; n++) nextTick(world); // Existing cooldown, with no free fabrication.
  assertTechnology(world);
  return { ...result, field };
}

test('stepWorld autonomously fabricates a taught intermediate and uses its known final tool', () => {
  const { world, learner, precursor, final, field } = autonomousScene();
  const hash = () => createHash('sha256').update(JSON.stringify(world)).digest('hex'), before = hash();
  assert.equal(technologyOpportunity(world, learner)?.recipeId, precursor.id);
  assert.equal(hash(), before, 'planning is read-only, including knowledge, recipe cache, stocks, work and receipts');
  const executionBefore = world.technology.executionCounter, workBefore = world.technology.ledger.work;
  const actions = new Set<string>();
  // After preparation only the real autonomous world step may choose/execute work.
  for (let n = 0; n < 400 && !(learner.technology.competence[final.id]?.benefit); n++) {
    stepWorld(world); actions.add(learner.action); assert.equal(learner.command, null);
  }
  const receipts = world.technology.history.filter(event => Number(event.id.slice(8)) > executionBefore && event.actorId === learner.id);
  assert.deepEqual(receipts.filter(event => event.kind === 'craft' && event.success).map(event => event.recipeId), [precursor.id, final.id]);
  assert.ok(receipts.filter(event => event.kind === 'craft').every(event => event.work > 0 && event.energy > 0));
  assert.ok(world.technology.ledger.work - workBefore >= technologyWorkCost(intermediate) + technologyWorkCost(final.program));
  assert.ok(learner.technology.competence[final.id]!.benefit > 0, JSON.stringify({ actions: [...actions], action: learner.action, reason: learner.reason, tick: world.tick }));
  assert.ok(field.cultivation! > 0); assert.ok(actions.has('farm')); assert.ok(actions.has('craft'));
  assertTechnology(world);
});

test('a dependent craft opportunity disappears without its remembered goal, owned tool, paid material or local use', () => {
  const { world, learner, precursor, final } = autonomousScene();
  assert.equal(technologyOpportunity(world, learner)?.recipeId, precursor.id);
  for (const missing of ['goal', 'intermediate', 'tool', 'substrate', 'final-material', 'use-material', 'local-use'] as const) {
    const control = cloneWorld(world), actor = control.people[3]!, peer = control.people[2]!;
    if (missing === 'goal' || missing === 'intermediate') {
      const id = missing === 'goal' ? final.id : precursor.id;
      actor.technology.knownRecipes = actor.technology.knownRecipes.filter(known => known !== id);
      actor.technology.learnedFrom = actor.technology.learnedFrom.filter(lesson => lesson.recipeId !== id);
    } else if (missing === 'tool') peer.technology.items.push(...actor.technology.items.splice(0));
    else if (missing === 'substrate') actor.technology.residue.stone = 0;
    else if (missing === 'final-material') actor.materials.wood = 0;
    else if (missing === 'use-material') actor.materials.wood = 1;
    else {
      control.tiles.find(tile => tile.x === actor.x && tile.y === actor.y)!.vegetation = 0.95;
      const remote = control.tiles.find(tile => tile.x === 10 && tile.y === 20)!;
      remote.moisture = 0.7; remote.vegetation = 0.3; remote.cultivation = 0;
    }
    assert.equal(technologyOpportunity(control, actor), undefined, missing);
  }
});
