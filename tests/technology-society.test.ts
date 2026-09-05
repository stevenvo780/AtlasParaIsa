import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, type Person, type World } from '../src/world/index.js';
import { cooperate, cooperationOpportunity } from '../src/world/society.js';
import { assertTechnology, craftTechnology, materialCapacities, researchTechnology, shareTechnology, technologyWorkCost, toolCapacities, transferTechnologyItem, type TechnologyProgram } from '../src/world/technology.js';
import { observeTechnologyOrganization } from '../src/world/technology-organization.js';
import type { ChronicleEvent } from '../src/shared/types.js';

const edge: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }], steps: [{ op: 'form', intensity: 4, shape: 'edge' }, { op: 'compress', intensity: 2 }] };
const fibre: TechnologyProgram = { inputs: [{ source: 'raw', material: 'wood', mass: 1000 }], steps: [{ op: 'weave', intensity: 4 }, { op: 'form', intensity: 2, shape: 'sheet' }] };
function emit(w: World) { return (event: Omit<ChronicleEvent, 'id' | 'tick'>): ChronicleEvent => { const result = { ...event, id: `e${++w.eventCounter}`, tick: w.tick }; w.events.push(result); return result; }; }
function scene() {
  const w = createWorld(51926), a = w.people[2]!, b = w.people[3]!;
  for (const p of w.people) { p.x = 10; p.y = 20; p.target = { x: 10, y: 20 }; p.action = 'rest'; p.energy = 1; p.fatigue = 0; p.hunger = p.thirst = 0.1; p.skills = {}; p.materials = { wood: 0, stone: 0 }; p.lastSocial = -30; }
  for (const p of [a, b]) { p.x = 36; p.y = 12; p.target = { x: 36, y: 12 }; }
  a.materials = { wood: 12, stone: 8 };
  return { w, a, b };
}
function start(w: World, p: Person, program: TechnologyProgram, parents: string[] = []) {
  p.technology.project = { kind: 'research', program: structuredClone(program), parents, recipeId: null, progress: 0, requiredWork: technologyWorkCost(program), energyPaid: 0, startedAt: w.tick };
}
function complete(w: World, p: Person) {
  let result = false;
  while (p.technology.project) { w.tick++; result = researchTechnology(w, p); }
  return result;
}
function discover(w: World, p: Person, program: TechnologyProgram, parents: string[] = []) { start(w, p, program, parents); assert.equal(complete(w, p), true); }
function prepareTrade() {
  const { w, a, b } = scene(); discover(w, a, edge); a.materials.wood = 0;
  b.action = 'gather'; b.materials.wood = 1;
  const tile = w.tiles.find(t => t.x === b.x && t.y === b.y)!; tile.wood = 8;
  return { w, a, b };
}

test('society teaches a practiced recipe locally, records its cause and charges the teacher exactly once', () => {
  const { w, a, b } = scene(); discover(w, a, edge);
  const recipe = w.technology.recipes[0]!, before = { energy: a.energy, fatigue: a.fatigue, techEnergy: w.technology.ledger.energy, trust: a.bonds[b.id] ?? 0.2 };
  assert.equal(cooperationOpportunity(w, a)?.kind, 'teach'); assert.equal(cooperationOpportunity(w, a)?.recipeId, recipe.id);
  assert.equal(cooperate(w, a, emit(w)), true);
  assert.ok(Math.abs(before.energy - a.energy - 0.003) < 1e-12); assert.ok(Math.abs(a.fatigue - before.fatigue - 0.002) < 1e-12);
  assert.ok(Math.abs(w.technology.ledger.energy - before.techEnergy - 0.003) < 1e-12);
  assert.deepEqual(b.technology.knownRecipes, [recipe.id]); assert.equal(b.technology.learnedFrom[0]!.teacherId, a.id);
  assert.equal(b.technology.items.length, 0); assert.equal(b.technology.competence[recipe.id], undefined);
  assert.equal(w.totals.teaching, 1); assert.equal(w.totals.cooperation, 1); assert.ok(a.bonds[b.id]! > before.trust);
  assert.ok(w.events.some(e => e.kind === 'learning' && e.actors.includes(b.id))); assert.ok(b.experiences.at(-1)!.causeId);
  assertTechnology(w);
});

test('cooperation disabled, out-of-reach recipients and unpracticed imported knowledge cannot spread recipes', () => {
  const { w, a, b } = scene(); discover(w, a, edge);
  const disabled = structuredClone(w); disabled.cooperationEnabled = false; const before = structuredClone(disabled);
  assert.equal(cooperationOpportunity(disabled, disabled.people[2]!), undefined); assert.equal(cooperate(disabled, disabled.people[2]!, emit(disabled)), false); assert.deepEqual(disabled, before);
  b.x = a.x + 2; assert.equal(cooperationOpportunity(w, a)?.kind, 'teach'); assert.equal(cooperate(w, a, emit(w)), false); assert.equal(b.technology.knownRecipes.length, 0);
  b.x = a.x + 8; assert.equal(cooperationOpportunity(w, a), undefined);
  b.x = a.x; assert.equal(shareTechnology(w, a, b), true);
  const c = w.people[4]!; c.x = a.x; c.y = a.y; b.skills = {}; a.x = 10; a.y = 20;
  assert.equal(cooperationOpportunity(w, b), undefined, 'memorizing a received recipe is not a practiced demonstration');
  assert.equal(c.technology.knownRecipes.length, 0); assertTechnology(w);
});

test('product exchange fills an observable capacity gap, preserves object identity and settles real compensation', () => {
  const { w, a, b } = prepareTrade(), item = a.technology.items[0]!, totalWood = a.materials.wood + b.materials.wood;
  const imported = structuredClone(w.technology.ledger.imported), materialMass = item.mass, beforeEnergy = a.energy;
  assert.equal(toolCapacities(b).cutting, 0); assert.equal(cooperationOpportunity(w, a)?.kind, 'tools');
  assert.equal(cooperate(w, a, emit(w)), true);
  assert.equal(a.technology.items.length, 0); assert.equal(b.technology.items[0], item); assert.equal(b.technology.items[0]!.mass, materialMass);
  assert.ok(toolCapacities(b).cutting > 0.6); assert.equal(b.technology.knownRecipes.length, 0);
  assert.equal(a.materials.wood, 1); assert.equal(b.materials.wood, 0); assert.equal(a.materials.wood + b.materials.wood, totalWood);
  assert.ok(Math.abs(beforeEnergy - a.energy - 0.005) < 1e-12); assert.deepEqual(w.technology.ledger.imported, imported);
  assert.equal(w.totals.trade, 1); const receipts = w.technology.history.slice(-2); assert.equal(receipts[0]!.kind, 'transfer'); assert.equal(receipts[0]!.transferId, receipts[1]!.transferId);
  const observation = observeTechnologyOrganization(w.technology, w.people, w.tick);
  assert.deepEqual(observation.diagnostics, []); assert.equal(observation.observation.window.complete, true);
  assertTechnology(w);
});

test('exchange requires demand, payment, reachability, capacity and actual ownership', () => {
  const { w, a, b } = prepareTrade(), itemId = a.technology.items[0]!.id;
  b.action = 'rest'; assert.notEqual(cooperationOpportunity(w, a)?.kind, 'tools'); b.action = 'gather';
  b.materials.wood = 0; assert.notEqual(cooperationOpportunity(w, a)?.kind, 'tools'); b.materials.wood = 1;
  b.x = a.x + 2; assert.equal(cooperate(w, a, emit(w)), false); b.x = a.x;
  const control = structuredClone(w); control.cooperationEnabled = false; assert.equal(transferTechnologyItem(control, control.people[2]!, control.people[3]!, itemId), false);
  assert.equal(transferTechnologyItem(w, a, b, 'missing'), false);
  assert.equal(cooperate(w, a, emit(w)), true); assert.equal(transferTechnologyItem(w, a, b, itemId), false);
  w.tick += 30; a.materials = { wood: 0, stone: 0 }; a.action = 'gather'; a.target = { x: a.x, y: a.y };
  assert.equal(cooperationOpportunity(w, b), undefined, 'a buyer cannot resell its only tool while its own gathering still needs it');
  assertTechnology(w);
});

test('a real traded catalyst enables a blocked local process without spending its reserved feedstock as payment', () => {
  const { w, a, b } = scene(); discover(w, a, fibre);
  const program: TechnologyProgram = { inputs: [{ source: 'raw', material: 'wood', mass: 1000 }, { source: 'raw', material: 'stone', mass: 1000 }], steps: [{ op: 'combine', intensity: 3, requiredCatalyst: 'binding' }, { op: 'form', intensity: 3, shape: 'rod' }] };
  b.action = 'research'; b.materials = { wood: 2, stone: 1 }; start(w, b, program);
  assert.ok(materialCapacities(a.technology.items[0]!).binding > 0.1);
  const chosen = cooperationOpportunity(w, a)!; assert.equal(chosen.kind, 'tools'); assert.equal(chosen.exchange!.material, 'wood');
  const blocked = structuredClone(w); assert.equal(complete(blocked, blocked.people[3]!), false); assert.equal(blocked.people[3]!.technology.items.length, 0);
  assert.equal(cooperate(w, a, emit(w)), true); assert.equal(b.materials.wood, 1); assert.equal(b.materials.stone, 1);
  assert.equal(complete(w, b), true); assert.equal(w.technology.history.at(-1)!.catalysts[0]!.required, true);
  assertTechnology(w);
});

test('a learned downstream recipe can be reproduced with a traded input without knowing its manufacturing ancestor', () => {
  const { w, a, b } = scene(); discover(w, a, edge); const parent = w.technology.recipes[0]!;
  const next: TechnologyProgram = { inputs: [{ source: 'product', recipeId: parent.id, mass: 400 }, { source: 'raw', material: 'wood', mass: 1000 }], steps: [{ op: 'combine', intensity: 4 }, { op: 'form', intensity: 4, shape: 'rod' }] };
  discover(w, a, next, [parent.id]); const descendant = w.technology.recipes[1]!;
  shareTechnology(w, a, b, undefined, descendant.id); assert.deepEqual(b.technology.knownRecipes, [descendant.id]);
  b.action = 'craft'; b.materials = { wood: 2, stone: 1 };
  const opportunity = cooperationOpportunity(w, a)!; assert.equal(opportunity.kind, 'tools'); assert.equal(opportunity.exchange!.itemId, a.technology.items.find(i => i.recipeId === parent.id)!.id);
  assert.equal(cooperate(w, a, emit(w)), true); craftTechnology(w, b, descendant.id); assertTechnology(w);
  while (b.technology.project) { w.tick++; craftTechnology(w, b, descendant.id); }
  assert.ok(b.technology.items.some(i => i.recipeId === descendant.id)); assert.equal(b.technology.knownRecipes.includes(parent.id), false);
  assertTechnology(w);
});

test('supply for an active experiment transfers only a truly missing raw input and never advances work for free', () => {
  const { w, a, b } = scene(); b.action = 'research'; b.materials = { wood: 0, stone: 0 }; start(w, b, edge);
  const opportunity = cooperationOpportunity(w, a)!; assert.equal(opportunity.kind, 'supply'); assert.equal(opportunity.supplyMaterial, 'stone');
  const sum = a.materials.stone + b.materials.stone;
  assert.equal(cooperate(w, a, emit(w)), true); assert.equal(b.materials.stone, 1); assert.equal(a.materials.stone + b.materials.stone, sum); assert.equal(b.technology.project!.progress, 0);
  assert.equal(w.technology.ledger.imported.stone, 0); w.tick += 30; assert.equal(cooperationOpportunity(w, a), undefined);
  assert.equal(complete(w, b), true); assert.equal(w.technology.ledger.imported.stone, 1000); assertTechnology(w);
});

test('learning ablation suppresses recipe and skill teaching while preserving physically paid exchanges', () => {
  const { w, a, b } = scene(); discover(w, a, edge); w.learningEnabled = false; a.skills.gather = 0.8;
  const events = w.events.length, energy = a.energy;
  assert.equal(cooperationOpportunity(w, a), undefined); assert.equal(cooperate(w, a, emit(w)), false); assert.equal(shareTechnology(w, a, b, emit(w)), false);
  assert.equal(b.technology.knownRecipes.length, 0); assert.equal(b.skills.gather, undefined); assert.equal(w.events.length, events); assert.equal(a.energy, energy);
  const exchange = prepareTrade(); exchange.w.learningEnabled = false;
  assert.equal(cooperationOpportunity(exchange.w, exchange.a)?.kind, 'tools'); assert.equal(cooperate(exchange.w, exchange.a, emit(exchange.w)), true);
  assert.equal(exchange.b.technology.items.length, 1); assert.equal(exchange.b.technology.knownRecipes.length, 0);
  assert.equal(exchange.w.events.some(e => e.kind === 'learning'), false); assertTechnology(exchange.w);
});

test('a full recipient inventory rejects both the proposal and direct product transfer without recycling its possessions', () => {
  const { w, a, b } = prepareTrade(); b.materials.wood = 2; discover(w, b, fibre); b.action = 'gather';
  w.technology.budgets.maxItems = 1; const before = structuredClone(w.technology), inventory = b.technology.items.map(i => i.id);
  assert.notEqual(cooperationOpportunity(w, a)?.kind, 'tools'); assert.equal(transferTechnologyItem(w, a, b, a.technology.items[0]!.id), false);
  assert.deepEqual(w.technology, before); assert.deepEqual(b.technology.items.map(i => i.id), inventory); assertTechnology(w);
});
