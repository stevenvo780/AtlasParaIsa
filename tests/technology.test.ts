import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPhysicalOperation, assertTechnology, craftTechnology, defaultTechnologyState, initialTechnologyKnowledge, materialCapacities, PHYSICAL_OPERATIONS, programSignature, projectTechnology, proposeTechnologyProgram, rawMaterial, recordTechnologyBenefit, researchTechnology, settleTechnologyEstate, shareTechnology, splitComposition, technologyOpportunity, technologyWorkCost, toolCapacities, useTool, validTechnologyProgram, type TechnologyActor, type TechnologyHost, type TechnologyProgram } from '../src/world/technology.js';
import type { Composition, OperationInstruction } from '../src/shared/technology.js';

function scene(seed = 51926) {
  const actor = (id: string): TechnologyActor => ({ id, x: 0, y: 0, energy: 1, fatigue: 0, hunger: 0.1, thirst: 0.1, curiosity: 0.9, materials: { wood: 12, stone: 8 }, skills: {}, technology: initialTechnologyKnowledge() });
  const a = actor('a'), b = actor('b');
  const host: TechnologyHost = { seed, tick: 0, people: [a, b], technology: defaultTechnologyState(), tiles: [{ x: 0, y: 0, drinkingWater: 0.2 }] };
  return { host, a, b };
}
function runProgram(host: TechnologyHost, actor: TechnologyActor, program: TechnologyProgram, parents: string[] = []): boolean {
  actor.technology.project = { kind: 'research', program: structuredClone(program), parents, recipeId: null, progress: 0, requiredWork: technologyWorkCost(program), energyPaid: 0, startedAt: host.tick };
  let result = false;
  for (let n = 0; actor.technology.project && n < 250; n++) { host.tick++; result = researchTechnology(host, actor); }
  return result;
}
const edge: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }], steps: [{ op: 'form', intensity: 4, shape: 'edge' }, { op: 'compress', intensity: 2 }] };
const fibre: TechnologyProgram = { inputs: [{ source: 'raw', material: 'wood', mass: 1000 }], steps: [{ op: 'weave', intensity: 4 }, { op: 'form', intensity: 2, shape: 'sheet' }] };
function conserved(before: Composition, product: Composition | undefined, residue: Composition) {
  for (const material of ['wood', 'stone', 'water'] as const) assert.equal((product?.[material] ?? 0) + residue[material], before[material], material);
}

test('all eight primitive laws conserve each material, including failed attempts and thermal residue', () => {
  for (const op of PHYSICAL_OPERATIONS) for (const intensity of [1, 2, 3, 4]) {
    const wood = rawMaterial('wood', 777), stone = rawMaterial('stone', 613), water = rawMaterial('water', 121);
    const mixed = applyPhysicalOperation({ op: 'combine', intensity: 2 }, [wood, stone, water]).product!;
    const inputs = op === 'combine' ? [wood, stone, water] : [mixed];
    const instruction: OperationInstruction = { op, intensity, ...(op === 'form' ? { shape: 'edge' as const } : {}), ...(op === 'separate' ? { material: 'stone' as const } : {}) };
    const result = applyPhysicalOperation(instruction, inputs);
    conserved({ wood: 777, stone: 613, water: 121 }, result.product?.composition, result.residue);
  }
  const hot = rawMaterial('wood'); hot.properties.temperature = 0.8;
  const failed = applyPhysicalOperation({ op: 'heat', intensity: 4 }, [hot]);
  assert.equal(failed.success, false); conserved(hot.composition, failed.product?.composition, failed.residue);
  const tiny = applyPhysicalOperation({ op: 'form', shape: 'edge', intensity: 4 }, [rawMaterial('stone', 31)]);
  assert.equal(tiny.success, false); conserved({ wood: 0, stone: 31, water: 0 }, tiny.product?.composition, tiny.residue);
});

test('integer split allocates every quantum without creating an element', () => {
  const c = { wood: 7, stone: 11, water: 3 };
  for (let amount = 0; amount <= 22; amount++) {
    const split = splitComposition(c, amount);
    assert.equal(Object.values(split).reduce((n, x) => n + x, 0), Math.min(21, amount));
    assert.ok(Object.keys(c).every(key => split[key as keyof Composition] <= c[key as keyof Composition]));
  }
});

test('a program spends actual material, body energy and work before producing a new functional form', () => {
  const { host, a } = scene(), before = structuredClone(a);
  assert.equal(host.technology.recipes.length, 0); assert.equal(toolCapacities(a).cutting, 0);
  assert.equal(runProgram(host, a, edge), true);
  assert.equal(a.materials.stone, before.materials.stone - 1); assert.ok(a.energy < before.energy); assert.ok(a.fatigue > before.fatigue);
  assert.equal(host.technology.ledger.work, technologyWorkCost(edge)); assert.equal(host.technology.ledger.imported.stone, 1000);
  assert.ok(toolCapacities(a).cutting > 0.6); assert.equal(host.technology.recipes[0]!.utility, 0);
  assert.equal(host.technology.recipes[0]!.signature, programSignature(edge)); assert.equal(projectTechnology(host).dynamics.massError, 0);
  assertTechnology(host);
});

test('empty stocks cannot produce outputs, and unavailable future ingredients cannot be observed at distance', () => {
  const { host, a } = scene(); a.materials = { wood: 0, stone: 0 }; host.tiles![0]!.x = 10;
  const before = structuredClone(host.technology);
  assert.equal(proposeTechnologyProgram(host, a), undefined); assert.equal(technologyOpportunity(host, a), undefined);
  for (let n = 0; n < 80; n++) { host.tick++; assert.equal(researchTechnology(host, a), false); }
  assert.equal(a.technology.items.length, 0); assert.deepEqual(host.technology, before);
  assert.equal(runProgram(host, a, edge), false); assert.equal(host.technology.ledger.failures, 1);
  assert.equal(host.technology.ledger.imported.stone, 0); assert.ok(host.technology.ledger.energy > 0);
  assertTechnology(host);
});

test('failed physical trials consume real input and fuel while retaining separately accounted spent matter', () => {
  const { host, a } = scene();
  const bad: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }], steps: [{ op: 'heat', intensity: 4 }, { op: 'weave', intensity: 4 }] };
  assert.equal(runProgram(host, a, bad), false);
  assert.equal(a.materials.stone, 7); assert.equal(a.materials.wood, 11.8); assert.equal(a.technology.residue.stone, 1000);
  assert.equal(host.technology.ledger.fuelMass, 200); assert.equal(host.technology.ledger.imported.wood, 200);
  assert.equal(a.technology.items.length, 0); assert.equal(host.technology.recipes.length, 0); assert.ok(host.technology.ledger.work > 0);
  assertTechnology(host);
});

test('products become later substrates with retained properties and cultural genealogy', () => {
  const { host, a } = scene(); runProgram(host, a, edge);
  const parent = host.technology.recipes[0]!, parentItem = a.technology.items[0]!, before = parentItem.mass;
  const next: TechnologyProgram = { inputs: [{ source: 'product', recipeId: parent.id, mass: 400 }, { source: 'raw', material: 'wood', mass: 1000 }], steps: [{ op: 'combine', intensity: 4 }, { op: 'form', shape: 'rod', intensity: 4 }] };
  assert.equal(runProgram(host, a, next, [parent.id]), true);
  const child = host.technology.recipes[1]!; assert.equal(child.generation, 2); assert.deepEqual(child.parents, [parent.id]);
  assert.equal(parentItem.mass, before - 400); assert.ok(toolCapacities(a).cultivation > 0.3);
  assert.ok(a.technology.items.at(-1)!.parentItems.includes(parentItem.id)); assert.equal(projectTechnology(host).dynamics.reusedProducts, 1);
  assertTechnology(host);
});

test('repeated mixed-product input demands cannot duplicate stock or lose a rounding quantum', () => {
  const { host, a } = scene();
  runProgram(host, a, { inputs: [{ source: 'raw', material: 'wood', mass: 1000 }, { source: 'raw', material: 'stone', mass: 1000 }], steps: [{ op: 'combine', intensity: 2 }] });
  const parent = host.technology.recipes[0]!;
  const program: TechnologyProgram = { inputs: [{ source: 'product', recipeId: parent.id, mass: 333 }, { source: 'product', recipeId: parent.id, mass: 334 }], steps: [{ op: 'combine', intensity: 2 }] };
  assert.equal(runProgram(host, a, program, [parent.id]), true); assertTechnology(host);
  const remaining = a.technology.items.find(i => i.recipeId === parent.id)!.mass;
  const unavailable = structuredClone(program); unavailable.inputs[0]!.mass = remaining; unavailable.inputs[1]!.mass = 333;
  const imported = structuredClone(host.technology.ledger.imported), masses = a.technology.items.map(i => i.mass);
  assert.equal(runProgram(host, a, unavailable, [parent.id]), false); assert.deepEqual(host.technology.ledger.imported, imported); assert.deepEqual(a.technology.items.map(i => i.mass), masses);
  assertTechnology(host);
});

test('tool receipts debit wear and utility only follows an actual observed benefit, once', () => {
  const { host, a } = scene(); runProgram(host, a, edge);
  const item = a.technology.items[0]!, before = item.mass, initialPower = toolCapacities(a).cutting;
  const receipt = useTool(host, a, 'cutting', 4)!;
  assert.ok(receipt.power > 0); assert.equal(item.mass, before - receipt.wear); assert.equal(host.technology.recipes[0]!.utility, 0);
  assert.ok(toolCapacities(a).cutting < initialPower); recordTechnologyBenefit(host, a, receipt, 0.04); recordTechnologyBenefit(host, a, receipt, 10);
  assert.equal(host.technology.recipes[0]!.utility, 0.04); assert.equal(a.technology.competence[item.recipeId!]!.benefit, 0.04);
  for (let n = 0; n < 300; n++) useTool(host, a, 'cutting', 4);
  assert.ok(toolCapacities(a).cutting <= 0.07); assert.ok(a.technology.residue.stone > before * 0.5);
  assertTechnology(host);
});

test('required physical catalysts block advanced work when absent, and successful use spends replacement stock', () => {
  const { host, a, b } = scene(); runProgram(host, a, fibre);
  assert.ok(toolCapacities(a).binding > 0.1);
  const advanced: TechnologyProgram = { inputs: [{ source: 'raw', material: 'wood', mass: 1000 }, { source: 'raw', material: 'stone', mass: 1000 }], steps: [{ op: 'combine', intensity: 3, requiredCatalyst: 'binding' }, { op: 'form', shape: 'rod', intensity: 3 }] };
  assert.equal(runProgram(host, b, advanced), false); assert.equal(b.technology.items.length, 0);
  const tool = a.technology.items[0]!, before = tool.mass;
  assert.equal(runProgram(host, a, advanced, [tool.recipeId!]), true); assert.ok(tool.mass < before);
  const event = host.technology.history.at(-1)!; assert.equal(event.catalysts.length, 1); assert.equal(event.catalysts[0]!.required, true);
  assert.equal(event.catalysts[0]!.wear, before - tool.mass); assert.ok(host.technology.history.some(e => e.id === event.catalysts[0]!.executionId));
  assert.ok(host.technology.recipes[0]!.utility > 0); assertTechnology(host);
});

test('local teaching transfers exact learned recipes with a cause and a cost, never inventory or distant knowledge', () => {
  const { host, a, b } = scene(); runProgram(host, a, edge);
  assert.equal(b.technology.knownRecipes.length, 0); assert.equal(craftTechnology(host, b, host.technology.recipes[0]!.id), false);
  b.x = 10; assert.equal(shareTechnology(host, a, b), false); b.x = 1;
  const energy = a.energy; assert.equal(shareTechnology(host, a, b), true); assert.ok(a.energy < energy);
  assert.equal(b.technology.items.length, 0); assert.equal(b.technology.learnedFrom[0]!.teacherId, a.id);
  assert.equal(b.technology.knownRecipes[0], host.technology.recipes[0]!.id);
  for (let n = 0; n < technologyWorkCost(edge); n++) { host.tick++; craftTechnology(host, b, b.technology.knownRecipes[0]); }
  assert.equal(b.technology.items.length, 1); assert.equal(b.technology.competence[b.technology.knownRecipes[0]!]!.successes, 1);
  assertTechnology(host);
});

test('procedural search is seed-reproducible and discovers diverse programs from local history without a recipe catalogue', () => {
  const run = () => {
    const { host, a } = scene();
    for (let attempt = 0; attempt < 90; attempt++) {
      a.materials = { wood: 12, stone: 8 }; a.energy = 1; a.fatigue = 0;
      host.tick++; researchTechnology(host, a);
      for (let n = 0; a.technology.project && n < 250; n++) { host.tick++; researchTechnology(host, a); }
      assertTechnology(host);
    }
    return host;
  };
  const first = run(), second = run(); assert.deepEqual(first, second);
  const view = projectTechnology(first); assert.ok(view.dynamics.recipes > 12); assert.ok(view.dynamics.generations > 2);
  assert.ok(view.dynamics.programDiversity > 12); assert.ok(view.dynamics.functionalDiversity > 3);
  assert.ok(first.technology.recipes.some(r => r.program.inputs.some(i => i.source === 'product')));
  assert.ok(first.technology.recipes.some(r => r.parents.length > 1)); assert.ok(first.technology.ledger.failures > 0);
  assert.equal(view.dynamics.massError, 0); assert.ok(view.items.length <= first.technology.budgets.maxItems);
});

test('search never reads another actor knowledge and bounded histories disclose dropped evidence', () => {
  const { host, a, b } = scene(); const before = proposeTechnologyProgram(host, b); runProgram(host, a, edge);
  assert.deepEqual(proposeTechnologyProgram(host, b), before);
  host.technology.budgets.maxHistory = 2;
  for (let n = 0; n < 8; n++) useTool(host, a, 'cutting');
  assert.equal(host.technology.history.length, 2); assert.equal(host.technology.historyDropped, host.technology.executionCounter - 2);
  assertTechnology(host);
});

test('state assertions reject invented mass, invalid programs, unknown ancestry and forged per-element ledgers', () => {
  const { host, a } = scene(); runProgram(host, a, edge);
  for (const corrupt of [
    (h: TechnologyHost) => h.people[0]!.technology.items[0]!.composition.stone++,
    (h: TechnologyHost) => h.technology.recipes[0]!.parents.push('unknown'),
    (h: TechnologyHost) => { h.technology.ledger.imported.wood++; h.technology.ledger.imported.stone--; },
    (h: TechnologyHost) => { h.technology.recipes[0]!.program.steps[0]!.intensity = 5; },
  ]) { const broken = structuredClone(host); corrupt(broken); assert.throws(() => assertTechnology(broken), /tecnología/); }
  assert.equal(validTechnologyProgram({ ...edge, steps: [{ op: 'heat', intensity: 1, requiredCatalyst: 'cutting' }] }), false);
  assert.equal(materialCapacities(rawMaterial('water')).cutting, 0);
});

test('death moves an estate only to present nearby hands, without inherited knowledge or duplicated objects', () => {
  const { host, a, b } = scene(); runProgram(host, a, edge); const id = a.technology.items[0]!.id;
  const distant = structuredClone(host); distant.people[1]!.x = 8;
  const lost = settleTechnologyEstate(distant, distant.people[0]!, [distant.people[1]!]);
  assert.equal(lost.transfers.length, 0); assert.equal(lost.lost.stone, 1000); assert.equal(distant.people[1]!.technology.items.length, 0);
  assert.equal(distant.technology.history.at(-1)!.kind, 'estate'); distant.people.shift(); assertTechnology(distant);
  const moved = settleTechnologyEstate(host, a, [b]); assert.equal(moved.transfers.length, 1); assert.equal(moved.transfers[0]!.mass, 1000);
  assert.equal(b.technology.items[0]!.id, id); assert.equal(b.technology.knownRecipes.length, 0); assert.equal(a.technology.items.length, 0);
  const receipts = host.technology.history.slice(-2); assert.equal(receipts[0]!.transferId, receipts[1]!.transferId); assert.equal(receipts[0]!.counterpartyId, b.id);
  host.people.shift(); assertTechnology(host); assert.equal(projectTechnology(host).dynamics.massError, 0);
});

test('explicit item and recipe budgets conserve stock and expose the finite search frontier', () => {
  const { host, a } = scene(); host.technology.budgets.maxItems = 1; host.technology.budgets.maxRecipes = 2;
  runProgram(host, a, edge); runProgram(host, a, fibre); assert.equal(a.technology.items.length, 1);
  assert.equal(host.technology.ledger.recycled, 1); assert.equal(host.technology.recipes.length, 2);
  assert.equal(proposeTechnologyProgram(host, a), undefined); assert.equal(projectTechnology(host).budgets.maxRecipes, 2);
  const last = host.technology.history.at(-1)!; assert.equal(last.nestedExecutionIds?.length, 1); assert.equal(host.technology.history.at(-2)!.kind, 'recycle');
  assertTechnology(host);
});

test('an explicit craft request uses an available learned process despite autonomous cooldown and an intact tool', () => {
  const { host, a, b } = scene(); runProgram(host, a, edge);
  assert.equal(technologyOpportunity(host, a), undefined); assert.ok(toolCapacities(a).cutting > 0.6);
  const before = a.technology.items.length;
  craftTechnology(host, a); assert.equal(a.technology.project?.kind, 'craft');
  while (a.technology.project) { host.tick++; craftTechnology(host, a); }
  assert.equal(a.technology.items.length, before + 1); assert.equal(a.materials.stone, 6);
  assert.equal(craftTechnology(host, b), false); assert.equal(b.technology.project, null);
  assertTechnology(host);
});
