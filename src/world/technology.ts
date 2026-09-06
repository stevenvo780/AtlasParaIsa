import type { ChronicleEvent } from '../shared/types.js';
import type { Capability, Composition, Material, MaterialBatch, MaterialProperties, MaterialRequirement, OperationInstruction, PhysicalOperation, ResourceMass, TechnologyExecution, TechnologyKnowledge, TechnologyProgram, TechnologyProject, TechnologyRecipe, TechnologyState, TechnologyView } from '../shared/technology.js';
import { localRandom } from './genetics.js';
import { assertTechnologyCheckpoint } from './technology-checkpoint.js';
import { assertTechnologyJournal } from './technology-journal.js';
import { appendTechnologyExecution as appendExecution, technologyStock } from './technology-execution.js';
import { assertTechnologyWater, assertWaterExecution, containedWaterStock, freeWaterCarryQuanta, settleContainedWaterCapacity, waterEnvelope } from './technology-water.js';
export { technologyStock } from './technology-execution.js';
import { assertTechnologyCatalogueState, catalogueEnabled, findTechnologyRecipe, hasTechnologyFunction, registerTechnologyRecipe, resolveTechnologyRecipe, technologyCatalogueTotals, technologyMemoryCapacity, updateTechnologyRecipeStats } from './technology-catalogue.js';
import { pruneTechnologyCompetence, rememberRecipe, technologyProjectPins, touchKnownRecipe } from './technology-memory.js';
import { containerAffordance } from './material-affordances.js';
export type * from '../shared/technology.js';

export interface TechnologyActor {
  id: string; x: number; y: number; energy: number; fatigue: number;
  hunger?: number; thirst?: number; curiosity?: number; name?: string;
  materials: { wood: number; stone: number }; skills: Record<string, number>;
  technology: TechnologyKnowledge;
}
type Emit = (event: Omit<ChronicleEvent, 'id' | 'tick'>) => unknown;
export interface TechnologyHost {
  seed: number; tick: number; people: TechnologyActor[]; technology: TechnologyState;
  tiles?: { x: number; y: number; drinkingWater?: number }[];
  cooperationEnabled?: boolean; learningEnabled?: boolean; noveltyEnabled?: boolean; emit?: Emit;
}
export const MASS_UNIT = 1000;
export const CAPABILITIES: readonly Capability[] = ['cutting', 'storage', 'insulation', 'cultivation', 'binding', 'abrasion'];
export const PHYSICAL_OPERATIONS: readonly PhysicalOperation[] = ['combine', 'separate', 'form', 'abrade', 'heat', 'cool', 'compress', 'weave'];
export const OPERATION_CATALYSTS: Record<PhysicalOperation, readonly Capability[]> = {
  combine: ['binding'], separate: ['cutting', 'abrasion'], form: ['cutting', 'abrasion'], abrade: ['abrasion'],
  heat: ['insulation'], cool: ['storage'], compress: ['cultivation'], weave: ['binding'],
};
const MATERIALS: readonly Material[] = ['wood', 'stone', 'water'];
const SHAPES = ['edge', 'hollow', 'sheet', 'rod', 'granular'] as const;
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const empty = (): Composition => ({ wood: 0, stone: 0, water: 0 });
const mass = (c: Composition) => c.wood + c.stone + c.water;
function add(a: Composition, b: Composition): void { for (const m of MATERIALS) a[m] += b[m]; }
function subtract(a: Composition, b: Composition): void { for (const m of MATERIALS) a[m] -= b[m]; }
const sum = (cs: Composition[]): Composition => { const c = empty(); for (const x of cs) add(c, x); return c; };
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
export function defaultTechnologyState(): TechnologyState {
  return { version: 1, recipes: [], history: [], historyDropped: 0, recipeCounter: 0, itemCounter: 0, executionCounter: 0,
    ledger: { imported: empty(), estateLoss: empty(), work: 0, energy: 0, fuelMass: 0, attempts: 0, failures: 0, crafted: 0, toolUses: 0, shared: 0, recycled: 0 },
    budgets: { maxRecipes: 256, maxSteps: 12, maxInputs: 4, maxItems: 16, maxHistory: 256, maxGeneration: 32, maxMassPerInput: 4000 } };
}
export function initialTechnologyKnowledge(): TechnologyKnowledge {
  return { knownRecipes: [], items: [], residue: empty(), attempts: 0, lastAttempt: -120, project: null, learnedFrom: [], competence: {} };
}
/** Keep local instructions and practice bounded, including after stock leaves an actor. */
export function maintainTechnologyMemory(host: TechnologyHost, actor: TechnologyActor): void {
  const knowledge = actor.technology, capacity = technologyMemoryCapacity(host.technology);
  if (knowledge.knownRecipes.length > capacity && !rememberRecipe(knowledge, knowledge.knownRecipes.at(-1)!, {
    capacity, protectedIds: technologyProjectPins(knowledge),
  }).remembered) throw new Error('Active technology instructions exceed local memory capacity.');
  pruneTechnologyCompetence(knowledge);
}
function knownTechnologyRecipes(host: TechnologyHost, actor: TechnologyActor): TechnologyRecipe[] {
  // The archive resolves only identities already held locally; its cache is not knowledge.
  return actor.technology.knownRecipes.flatMap(id => {
    const recipe = resolveTechnologyRecipe(host, id);
    return recipe ? [recipe] : [];
  });
}
function inventionRoom(state: TechnologyState): boolean {
  return state.recipeCounter < Number.MAX_SAFE_INTEGER && (catalogueEnabled(state) || state.recipes.length < state.budgets.maxRecipes);
}
function generationLimit(state: TechnologyState): number {
  return catalogueEnabled(state) ? Number.MAX_SAFE_INTEGER : state.budgets.maxGeneration;
}
/** Integer largest-remainder allocation makes wear and splitting conserve every element. */
export function splitComposition(c: Composition, requested: number): Composition {
  const total = mass(c), amount = Math.min(total, Math.max(0, Math.floor(requested))), result = empty();
  if (!total || !amount) return result;
  const remainders = MATERIALS.map(m => { const exact = c[m] * amount / total; result[m] = Math.floor(exact); return { m, remainder: exact - result[m] }; });
  let left = amount - mass(result);
  for (const { m } of remainders.sort((a, b) => b.remainder - a.remainder || MATERIALS.indexOf(a.m) - MATERIALS.indexOf(b.m))) if (left-- > 0) result[m]++;
  return result;
}
function rawProperties(c: Composition): MaterialProperties {
  const total = Math.max(1, mass(c)), wood = c.wood / total, stone = c.stone / total, water = c.water / total;
  return { hardness: wood * 0.32 + stone * 0.84, toughness: wood * 0.78 + stone * 0.3,
    porosity: wood * 0.58 + stone * 0.2, flexibility: wood * 0.62 + water * 0.9,
    edge: 0.03 * (1 - water), containment: 0, insulation: wood * 0.58 + stone * 0.08,
    leverage: 0.05, cohesion: (1 - water) * 0.62, temperature: 0, alignment: 0, firing: 0 };
}
export function rawMaterial(material: Material, quantity = MASS_UNIT): MaterialBatch {
  const composition = empty(); composition[material] = quantity;
  return { id: `raw:${material}`, recipeId: null, composition, mass: quantity, properties: rawProperties(composition), generation: 0, madeAt: 0, parentItems: [], initialMass: quantity };
}
export function materialCapacities(batch: MaterialBatch): Record<Capability, number> {
  const p = batch.properties, integrity = clamp(batch.mass / Math.max(1, batch.initialMass));
  const solidity = 1 - batch.composition.water / Math.max(1, batch.mass);
  const usable = Math.min(1, batch.mass / 500) * integrity * solidity * clamp(1 - p.temperature);
  return { cutting: clamp(p.edge * p.hardness * p.cohesion * 1.7) * usable,
    storage: clamp(p.containment * p.cohesion * (1 - p.porosity) * 2) * usable,
    insulation: clamp(p.insulation * p.cohesion * (0.3 + p.alignment) * 1.2) * usable,
    cultivation: clamp(p.leverage * (p.hardness * 0.7 + p.toughness * 0.3) * p.cohesion * 1.6) * usable,
    binding: clamp(p.flexibility * p.alignment * p.cohesion * 1.8) * usable,
    abrasion: clamp(p.hardness * (1 - p.porosity) * (1 - p.edge * 0.5) * p.cohesion) * usable };
}
export interface OperationResult { product: MaterialBatch | null; residue: Composition; success: boolean; reason: string; }
/** Laws operate on physical state. Neither recipe names nor identity affect any property. */
export function applyPhysicalOperation(instruction: OperationInstruction, inputs: readonly MaterialBatch[], catalyst = 0): OperationResult {
  const composition = sum(inputs.map(i => i.composition)), residue = empty(), total = mass(composition);
  const fail = (reason: string): OperationResult => ({ product: null, residue: sum([composition, residue]), success: false, reason });
  if (!inputs.length || !total || !PHYSICAL_OPERATIONS.includes(instruction.op) || !Number.isInteger(instruction.intensity) || instruction.intensity < 1 || instruction.intensity > 4) return fail('invalid physical input');
  if (inputs.length > 1 && instruction.op !== 'combine') return fail('multiple substrates require combination');
  if (instruction.requiredCatalyst && catalyst < 0.1) return fail('required physical catalyst unavailable');
  const properties = { ...inputs[0]!.properties };
  for (const key of Object.keys(properties) as (keyof MaterialProperties)[]) properties[key] = inputs.reduce((n, b) => n + b.properties[key] * b.mass / total, 0);
  const p = properties, power = instruction.intensity / 4, wood = composition.wood / total, stone = composition.stone / total;
  const remove = (n: number) => { const fragment = splitComposition(composition, Math.min(mass(composition) - 1, Math.max(0, Math.round(n)))); subtract(composition, fragment); add(residue, fragment); };
  switch (instruction.op) {
    case 'combine':
      if (inputs.length < 2) { p.cohesion = clamp(p.cohesion - 0.04); break; }
      // Mechanical interfaces weaken a composite unless fibres or a binding catalyst hold it.
      p.cohesion = clamp(p.cohesion * 0.78 + wood * 0.12 + clamp(catalyst) * 0.25);
      p.leverage = clamp(p.leverage + wood * stone * power * 0.6);
      p.edge *= 0.82; break;
    case 'separate': {
      const material = instruction.material ?? 'stone';
      if (!MATERIALS.includes(material) || !composition[material]) return fail('separation target absent');
      for (const m of MATERIALS) if (m !== material) { const n = Math.floor(composition[m] * Math.min(0.95, 0.35 + power * 0.5 + clamp(catalyst) * 0.1)); composition[m] -= n; residue[m] += n; }
      remove(total * 0.02 * power); p.cohesion *= 0.9; p.containment *= 0.6; break;
    }
    case 'form':
      if (!instruction.shape || !SHAPES.includes(instruction.shape) || p.cohesion < 0.18 || composition.water / total > 0.65) return fail('substrate cannot retain form');
      remove(total * (0.04 + power * 0.07) * (1 - clamp(catalyst) * 0.35));
      if (instruction.shape === 'edge') { p.edge = clamp(p.edge + power * (0.45 + stone * 0.38)); p.containment *= 0.5; }
      if (instruction.shape === 'hollow') { p.containment = clamp(p.containment + power * 0.72); p.toughness *= 0.88; p.leverage *= 0.6; }
      if (instruction.shape === 'sheet') { p.insulation = clamp(p.insulation + power * wood * 0.18); p.alignment = clamp(p.alignment + power * 0.3); p.leverage *= 0.5; }
      if (instruction.shape === 'rod') { p.leverage = clamp(p.leverage + power * 0.74); p.edge *= 0.7; }
      if (instruction.shape === 'granular') { p.porosity = clamp(p.porosity + power * 0.3); p.cohesion *= 0.55; p.containment = 0; }
      break;
    case 'abrade':
      if (p.hardness < 0.1) return fail('abrasion of a fluid or incoherent substrate');
      remove(total * (0.02 + power * 0.045)); p.edge = clamp(p.edge + power * (0.25 + clamp(catalyst) * 0.28));
      p.porosity = clamp(p.porosity - power * 0.08); p.toughness *= 1 - power * 0.05; break;
    case 'heat': {
      p.temperature = clamp(p.temperature + power * 0.8);
      const evaporated = Math.floor(composition.water * p.temperature); composition.water -= evaporated; residue.water += evaporated;
      p.firing = clamp(p.firing + power * stone * 0.35); p.hardness = clamp(p.hardness + power * stone * 0.13);
      p.porosity = clamp(p.porosity - power * stone * 0.15 + power * wood * 0.06);
      p.toughness = clamp(p.toughness - wood * power * 0.19 * (1 - clamp(catalyst) * 0.4)); p.cohesion = clamp(p.cohesion - wood * power * 0.1);
      if (p.temperature > 0.9 && wood > 0.65) return fail('organic matrix fractured by overheating');
      break;
    }
    case 'cool': p.temperature = clamp(p.temperature - power * (0.9 + clamp(catalyst) * 0.4)); break;
    case 'compress':
      if (composition.water / total > 0.8) return fail('fluid escapes the compression');
      p.porosity = clamp(p.porosity - power * (0.25 + clamp(catalyst) * 0.1)); p.cohesion = clamp(p.cohesion + power * 0.16);
      p.flexibility *= 1 - power * 0.18; p.containment *= 1 - power * 0.2; break;
    case 'weave':
      if (wood < 0.45 || p.flexibility < 0.18) return fail('insufficient flexible fibres');
      p.alignment = clamp(p.alignment + power * 0.72); p.cohesion = clamp(p.cohesion + power * wood * (0.17 + clamp(catalyst) * 0.12));
      p.containment = clamp(p.containment + power * 0.16); p.insulation = clamp(p.insulation + wood * power * 0.16);
      p.edge *= 0.7; break;
  }
  if (mass(composition) < 30 || p.cohesion < 0.08) return fail('no coherent product remains');
  const remaining = mass(composition);
  return { product: { ...structuredClone(inputs[0]!), composition, mass: remaining, initialMass: remaining,
    properties: p, parentItems: inputs.map(i => i.id), generation: Math.min(Number.MAX_SAFE_INTEGER, Math.max(...inputs.map(i => i.generation)) + 1) }, residue, success: true, reason: 'physical transformation' };
}
export function programSignature(program: TechnologyProgram): string {
  return JSON.stringify([program.inputs.map(i => [i.source, i.material ?? '', i.recipeId ?? '', i.mass]), program.steps.map(s => [s.op, s.intensity, s.shape ?? '', s.material ?? '', s.catalyst ?? '', s.requiredCatalyst ?? ''])]);
}
export function validTechnologyProgram(program: TechnologyProgram, state = defaultTechnologyState()): boolean {
  if (!program || !Array.isArray(program.inputs) || !Array.isArray(program.steps) || program.inputs.length < 1 || program.inputs.length > state.budgets.maxInputs || program.steps.length < 1 || program.steps.length > state.budgets.maxSteps) return false;
  return program.inputs.every(i => i && ['raw', 'product', 'residue'].includes(i.source) && Number.isSafeInteger(i.mass) && i.mass >= 30 && i.mass <= state.budgets.maxMassPerInput &&
    (i.source === 'product' ? typeof i.recipeId === 'string' && i.recipeId.length <= 100 : MATERIALS.includes(i.material!)) && (i.source !== 'raw' || i.material === 'water' || i.mass % MASS_UNIT === 0)) &&
    program.steps.every(s => s && PHYSICAL_OPERATIONS.includes(s.op) && Number.isInteger(s.intensity) && s.intensity >= 1 && s.intensity <= 4 && (s.shape === undefined || SHAPES.includes(s.shape)) && (s.material === undefined || MATERIALS.includes(s.material)) && (s.catalyst === undefined || OPERATION_CATALYSTS[s.op].includes(s.catalyst)) && (s.requiredCatalyst === undefined || OPERATION_CATALYSTS[s.op].includes(s.requiredCatalyst)));
}
function fuelCost(program: TechnologyProgram): number { return program.steps.reduce((n, s) => n + (s.op === 'heat' ? s.intensity * 50 : 0), 0); }
export function technologyWorkCost(program: TechnologyProgram): number { return 10 + program.inputs.length * 3 + program.steps.reduce((n, s) => n + 3 + s.intensity * (s.op === 'heat' ? 3 : 1), 0); }
interface Withdrawal { inputs: MaterialBatch[]; imported: Composition; fuel: Composition; fuelInputs: ResourceMass[]; itemMasses: Map<string, number>; itemCompositions: Map<string, Composition>; residue: Composition; waterTile?: { drinkingWater?: number }; }
/** Plans aggregate demands before touching stocks; repeating an input cannot overspend it. */
function planWithdrawal(host: TechnologyHost, actor: TechnologyActor, program: TechnologyProgram): Withdrawal | undefined {
  if (!validTechnologyProgram(program, host.technology)) return;
  const inputs: MaterialBatch[] = [], imported = empty(), fuel = empty(), itemMasses = new Map<string, number>(), itemCompositions = new Map<string, Composition>(), residue = empty();
  for (const input of program.inputs) {
    if (input.source === 'raw') { imported[input.material!] += input.mass; inputs.push(rawMaterial(input.material!, input.mass)); }
    else if (input.source === 'residue') { residue[input.material!] += input.mass; inputs.push(rawMaterial(input.material!, input.mass)); }
    else {
      let needed = input.mass; const fragments: MaterialBatch[] = [];
      for (const item of actor.technology.items.filter(i => i.recipeId === input.recipeId).sort((a, b) => a.id.localeCompare(b.id))) {
        const previously = itemMasses.get(item.id) ?? 0, take = Math.min(item.mass - previously, needed);
        if (take <= 0) continue;
        const available = { ...item.composition }; subtract(available, itemCompositions.get(item.id) ?? empty());
        const c = splitComposition(available, take);
        const fragment = { ...structuredClone(item), composition: c, mass: take, initialMass: take };
        delete fragment.contents; // Reshaping a substrate does not duplicate or chemically absorb its fill.
        fragments.push(fragment);
        itemMasses.set(item.id, previously + take); itemCompositions.set(item.id, sum([itemCompositions.get(item.id) ?? empty(), c])); needed -= take; if (!needed) break;
      }
      if (needed) return;
      // Fragments of the same recipe have identical geometry; merge only their physical stock.
      const c = sum(fragments.map(i => i.composition)), first = fragments[0]!;
      inputs.push({ ...first, composition: c, mass: input.mass, initialMass: input.mass, parentItems: fragments.map(i => i.id) });
    }
  }
  const fuelNeeded = fuelCost(program), availableScrap = Math.max(0, actor.technology.residue.wood - residue.wood);
  const scrapFuel = Math.min(fuelNeeded, availableScrap); residue.wood += scrapFuel; fuel.wood = fuelNeeded;
  imported.wood += fuelNeeded - scrapFuel;
  if (actor.materials.wood * MASS_UNIT + 1e-8 < imported.wood || actor.materials.stone * MASS_UNIT + 1e-8 < imported.stone || MATERIALS.some(m => actor.technology.residue[m] < residue[m])) return;
  const waterTile = imported.water ? host.tiles?.find(t => t.x === Math.round(actor.x) && t.y === Math.round(actor.y)) : undefined;
  // Drinking stock uses fifty mass units per normalized water unit; only the occupied tile is observable.
  if (imported.water && (waterTile?.drinkingWater ?? 0) * 50_000 + 1e-8 < imported.water) return;
  for (const step of program.steps) if (step.requiredCatalyst && !actor.technology.items.some(item => item.mass - (itemMasses.get(item.id) ?? 0) >= 30 && materialCapacities(item)[step.requiredCatalyst!] >= 0.1)) return;
  const fuelInputs: ResourceMass[] = [];
  if (fuelNeeded > scrapFuel) fuelInputs.push({ resourceId: 'raw:wood', mass: fuelNeeded - scrapFuel });
  if (scrapFuel) fuelInputs.push({ resourceId: 'residue:wood', mass: scrapFuel });
  return { inputs, imported, fuel, fuelInputs, itemMasses, itemCompositions, residue, waterTile };
}
function withdraw(host: TechnologyHost, actor: TechnologyActor, plan: Withdrawal): void {
  actor.materials.wood = Math.max(0, actor.materials.wood - plan.imported.wood / MASS_UNIT);
  actor.materials.stone = Math.max(0, actor.materials.stone - plan.imported.stone / MASS_UNIT);
  if (plan.waterTile) plan.waterTile.drinkingWater = Math.max(0, plan.waterTile.drinkingWater! - plan.imported.water / 50_000);
  for (const item of actor.technology.items) {
    const amount = plan.itemMasses.get(item.id) ?? 0;
    if (amount) settleContainedWaterCapacity(host, item, true);
    subtract(item.composition, plan.itemCompositions.get(item.id) ?? empty()); item.mass -= amount;
  }
  actor.technology.items = actor.technology.items.filter(i => i.mass > 0);
  subtract(actor.technology.residue, plan.residue);
  // Fuel becomes inert carried residue. It preserves mass but cannot release heat a second time.
  // Keep fuel in the ledger's separate spent stock, outside recyclable material.
  host.technology.ledger.fuelMass += plan.fuel.wood;
  add(host.technology.ledger.imported, plan.imported);
}
function itemResource(i: MaterialBatch): string { return i.recipeId ? `recipe:${i.recipeId}` : 'unclassified'; }
function compositionResources(c: Composition, prefix: string): ResourceMass[] { return MATERIALS.filter(m => c[m]).map(m => ({ resourceId: `${prefix}:${m}`, mass: c[m] })); }
export function toolCapacities(actor: TechnologyActor): Record<Capability, number> {
  const result = Object.fromEntries(CAPABILITIES.map(c => [c, 0])) as Record<Capability, number>;
  for (const item of actor.technology.items) { const powers = materialCapacities(item); for (const c of CAPABILITIES) result[c] = Math.max(result[c], powers[c]); }
  return result;
}
export interface ToolReceipt { executionId: string; itemId: string; recipeId: string | null; capability: Capability; power: number; wear: number; }
/** A receipt commits abrasion immediately. Call recordTechnologyBenefit only after applying the actual world delta. */
export function useTool(host: TechnologyHost, actor: TechnologyActor, capability: Capability, demand = 1): ToolReceipt | undefined {
  if (!CAPABILITIES.includes(capability) || !Number.isFinite(demand) || demand <= 0) return;
  const ranked = actor.technology.items.map(item => ({ item, power: materialCapacities(item)[capability] })).filter(i => i.power > 0.07).sort((a, b) => b.power - a.power || a.item.id.localeCompare(b.item.id));
  const best = ranked[0]; if (!best) return;
  const opening = technologyStock(actor), waterOpening = containedWaterStock(actor), requestedWear = Math.max(1, Math.ceil(demand * (2 + (1 - best.item.properties.toughness) * 8))), wear = Math.min(best.item.mass, requestedWear);
  const debris = splitComposition(best.item.composition, wear); subtract(best.item.composition, debris); best.item.mass -= wear; add(actor.technology.residue, debris);
  const waterLost = settleContainedWaterCapacity(host, best.item, best.item.mass === 0);
  actor.technology.items = actor.technology.items.filter(i => i.mass > 0);
  const state = host.technology; state.ledger.toolUses++;
  if (best.item.recipeId) { updateTechnologyRecipeStats(host, best.item.recipeId, { uses: 1 }); touchKnownRecipe(actor.technology, best.item.recipeId); }
  const water = waterEnvelope(actor, waterOpening, 'spill', waterLost ? { lost: waterLost } : {});
  const event = appendExecution(host, { kind: 'use', actorId: actor.id, recipeId: best.item.recipeId, programSignature: '', inputs: [{ resourceId: itemResource(best.item), mass: wear }], outputs: compositionResources(debris, 'residue'), residueMass: wear, energy: 0, work: 0, success: true, parentRecipeIds: [], catalysts: [], benefit: 0, ...(water ? { water } : {}), balance: { opening, closing: technologyStock(actor), externalInputs: [], externalLoss: [] } });
  maintainTechnologyMemory(host, actor);
  return { executionId: event.id, itemId: best.item.id, recipeId: best.item.recipeId, capability, power: best.power * wear / requestedWear, wear };
}
export function recordTechnologyBenefit(host: TechnologyHost, actor: TechnologyActor, receipt: ToolReceipt | undefined, actualBenefit: number): void {
  if (!receipt || !Number.isFinite(actualBenefit) || actualBenefit <= 0) return;
  const state = host.technology;
  if (state.journal && Number(receipt.executionId.slice(8)) <= state.journal.committedThrough) {
    throw new Error('A committed technology receipt cannot receive a later benefit.');
  }
  const execution = (state.journal?.pending ?? state.history).find(e => e.id === receipt.executionId && e.kind === 'use' && e.actorId === actor.id && e.recipeId === receipt.recipeId);
  if (!execution || execution.benefit > 0) return;
  execution.benefit = actualBenefit;
  if (receipt.recipeId) updateTechnologyRecipeStats(host, receipt.recipeId, { utility: actualBenefit });
  if (receipt.recipeId) { const practice = actor.technology.competence[receipt.recipeId] ??= { attempts: 0, successes: 0, work: 0, benefit: 0 }; practice.benefit += actualBenefit; }
  maintainTechnologyMemory(host, actor);
}
function randomInstruction(random: () => number): OperationInstruction {
  const op = PHYSICAL_OPERATIONS[Math.floor(random() * PHYSICAL_OPERATIONS.length)]!, instruction: OperationInstruction = { op, intensity: 1 + Math.floor(random() * 4) };
  if (op === 'form') instruction.shape = SHAPES[Math.floor(random() * SHAPES.length)]!;
  if (op === 'separate') instruction.material = MATERIALS[Math.floor(random() * MATERIALS.length)]!;
  if (op === 'abrade' && random() < 0.5) instruction.catalyst = 'abrasion';
  if (op === 'combine' && random() < 0.5) instruction.catalyst = 'binding';
  return instruction;
}
function localInputs(host: TechnologyHost, actor: TechnologyActor): MaterialRequirement[] {
  const result: MaterialRequirement[] = [];
  for (const material of ['wood', 'stone'] as const) if (actor.materials[material] >= 1) result.push({ source: 'raw', material, mass: MASS_UNIT });
  for (const material of MATERIALS) if (actor.technology.residue[material] >= 150) result.push({ source: 'residue', material, mass: Math.min(1000, actor.technology.residue[material]) });
  for (const item of actor.technology.items) if (item.recipeId && item.mass >= 200 && actor.technology.knownRecipes.includes(item.recipeId)) result.push({ source: 'product', recipeId: item.recipeId, mass: Math.min(item.mass, 1000) });
  const tile = host.tiles?.find(t => t.x === Math.round(actor.x) && t.y === Math.round(actor.y));
  if ((tile?.drinkingWater ?? 0) >= 0.01) result.push({ source: 'raw', material: 'water', mass: 500 });
  return result;
}
/** Search only draws from the actor's own learned programs and physically present feedstock. */
export function proposeTechnologyProgram(host: TechnologyHost, actor: TechnologyActor): { program: TechnologyProgram; parents: string[] } | undefined {
  const state = host.technology, random = localRandom(host.seed, `process:${actor.id}:${actor.technology.attempts}`), available = localInputs(host, actor);
  if (!available.length || !inventionRoom(state)) return;
  const known = knownTechnologyRecipes(host, actor).filter(r => r.generation < generationLimit(state));
  const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)]!;
  let program: TechnologyProgram, parents: string[] = [];
  if (known.length && random() < 0.72) {
    const parent = pick(known); program = structuredClone(parent.program); parents = [parent.id];
    if (known.length > 1 && random() < 0.35) {
      const other = pick(known.filter(r => r.id !== parent.id)); parents.push(other.id);
      const split = Math.max(1, Math.floor(random() * program.steps.length));
      program.steps = [...program.steps.slice(0, split), ...structuredClone(other.program.steps.slice(Math.floor(random() * other.program.steps.length)))].slice(0, state.budgets.maxSteps);
    }
    const mutation = Math.floor(random() * 4);
    if (mutation === 0 && program.steps.length < state.budgets.maxSteps) program.steps.push(randomInstruction(random));
    else if (mutation === 1) program.steps[Math.floor(random() * program.steps.length)] = randomInstruction(random);
    else if (mutation === 2) program.steps[Math.floor(random() * program.steps.length)]!.intensity = 1 + Math.floor(random() * 4);
    else program.inputs = [structuredClone(pick(available))];
    // An existing product can replace a raw substrate; the input's physical properties survive.
    const products = available.filter(i => i.source === 'product');
    if (products.length && random() < 0.55) program.inputs[0] = structuredClone(pick(products));
    if (!planWithdrawal(host, actor, program)) program.inputs = [structuredClone(pick(available))];
  } else {
    program = { inputs: [structuredClone(pick(available))], steps: Array.from({ length: 1 + Math.floor(random() * 3) }, () => randomInstruction(random)) };
  }
  if (available.length > 1 && program.inputs.length < state.budgets.maxInputs && random() < 0.25) {
    program.inputs.push(structuredClone(pick(available))); program.steps.unshift({ op: 'combine', intensity: 1 + Math.floor(random() * 4), catalyst: 'binding' });
  }
  if (program.inputs.length > 1 && program.steps[0]!.op !== 'combine') program.steps.unshift({ op: 'combine', intensity: 2 });
  program.steps = program.steps.slice(0, state.budgets.maxSteps);
  if (program.steps.length >= 4) {
    const powers = toolCapacities(actor), last = program.steps[program.steps.length - 1]!, availableCatalysts = OPERATION_CATALYSTS[last.op].filter(c => powers[c] >= 0.15);
    if (availableCatalysts.length) last.requiredCatalyst = pick([...availableCatalysts]);
  }
  for (const input of program.inputs) if (input.recipeId && !parents.includes(input.recipeId)) parents.push(input.recipeId);
  if (parents.some(id => { const recipe = resolveTechnologyRecipe(host, id); return !actor.technology.knownRecipes.includes(id) || !recipe || recipe.generation >= generationLimit(state); })) return;
  return { program, parents: parents.slice(0, 6) };
}
export function technologyOpportunity(host: TechnologyHost, actor: TechnologyActor): { kind: 'research' | 'craft'; score: number; reason: string; recipeId?: string } | undefined {
  if (actor.energy < 0.3 || actor.fatigue > 0.72 || Math.max(actor.hunger ?? 0, actor.thirst ?? 0) > 0.78) return;
  if (actor.technology.project) return { kind: actor.technology.project.kind, score: 0.86, reason: 'Continúa un proceso material que ya empezó y pagó.', recipeId: actor.technology.project.recipeId ?? undefined };
  if (host.tick - actor.technology.lastAttempt < 45) return;
  const powers = toolCapacities(actor), known = knownTechnologyRecipes(host, actor);
  const craft = known.filter(r => planWithdrawal(host, actor, r.program) && CAPABILITIES.some(c => r.capacities[c] > Math.max(0.12, powers[c] * 1.35))).sort((a, b) => (actor.technology.competence[b.id]?.benefit ?? 0) - (actor.technology.competence[a.id]?.benefit ?? 0) || (actor.technology.competence[b.id]?.successes ?? 0) - (actor.technology.competence[a.id]?.successes ?? 0) || a.id.localeCompare(b.id))[0];
  if (craft && actor.technology.items.length < host.technology.budgets.maxItems && actor.technology.attempts % 3 !== 0) return { kind: 'craft', recipeId: craft.id, score: 0.58, reason: 'Puede reproducir una técnica aprendida para recuperar una capacidad material.' };
  if (host.noveltyEnabled === false || !inventionRoom(host.technology) || !localInputs(host, actor).length) return;
  return { kind: 'research', score: 0.35 + (actor.curiosity ?? 0.5) * 0.3 + (actor.skills.technology ?? 0) * 0.08, reason: 'Prueba una variación o composición de procesos conocidos con materiales presentes; el intento cuesta trabajo y recursos.' };
}
function recycleToFit(host: TechnologyHost, actor: TechnologyActor): void {
  while (actor.technology.items.length >= host.technology.budgets.maxItems) {
    const item = [...actor.technology.items].sort((a, b) => Math.max(...Object.values(materialCapacities(a))) - Math.max(...Object.values(materialCapacities(b))) || a.madeAt - b.madeAt)[0]!;
    const opening = technologyStock(actor), waterOpening = containedWaterStock(actor), lost = settleContainedWaterCapacity(host, item, true);
    actor.technology.items = actor.technology.items.filter(i => i !== item); add(actor.technology.residue, item.composition); host.technology.ledger.recycled++;
    const water = waterEnvelope(actor, waterOpening, 'spill', lost ? { lost } : {});
    appendExecution(host, { kind: 'recycle', actorId: actor.id, recipeId: item.recipeId, programSignature: '', inputs: [{ resourceId: itemResource(item), mass: item.mass }], outputs: compositionResources(item.composition, 'residue'), residueMass: item.mass, energy: 0, work: 0, success: true, parentRecipeIds: [], catalysts: [], benefit: 0, ...(water ? { water } : {}), balance: { opening, closing: technologyStock(actor), externalInputs: [], externalLoss: [] } });
  }
  maintainTechnologyMemory(host, actor);
}
function emitDiscovery(host: TechnologyHost, actor: TechnologyActor, recipe: TechnologyRecipe, emit?: Emit): void {
  (emit ?? host.emit)?.({ kind: 'invention', actors: [actor.id], x: actor.x, y: actor.y, source: 'simulation',
    text: `${actor.name ?? actor.id} descubrió ${recipe.name}: ${recipe.program.steps.map(s => s.op).join(' → ')}.`,
    cause: `Proceso físico nuevo, generación ${recipe.generation}, ${recipe.program.inputs.length} sustratos y ${recipe.program.steps.length} operaciones; masa y residuos conservados. La utilidad se mide al usar el producto.` });
}
function finishProject(host: TechnologyHost, actor: TechnologyActor, project: TechnologyProject, emit?: Emit): boolean {
  const state = host.technology, knowledge = actor.technology;
  const parentRecipes = project.parents.map(id => resolveTechnologyRecipe(host, id));
  if (parentRecipes.some(parent => !parent) || (project.kind === 'research' && project.parents.some(id => !knowledge.knownRecipes.includes(id)))) {
    throw new Error('Unknown technology project parent.');
  }
  const nextGeneration = 1 + Math.max(0, ...parentRecipes.map(parent => parent!.generation));
  if (project.kind === 'research' && (!Number.isSafeInteger(nextGeneration) || nextGeneration > generationLimit(state))) {
    throw new Error('Technology ancestry exceeds the safe generation limit.');
  }
  knowledge.attempts++; knowledge.lastAttempt = host.tick; state.ledger.attempts++;
  const opening = technologyStock(actor), waterOpening = containedWaterStock(actor), lossBefore = state.water?.environmentalLoss ?? 0,
    plan = planWithdrawal(host, actor, project.program), signature = programSignature(project.program), transactionStart = state.executionCounter;
  if (!plan) {
    state.ledger.failures++;
    if (project.recipeId) { const practice = knowledge.competence[project.recipeId] ??= { attempts: 0, successes: 0, work: 0, benefit: 0 }; practice.attempts++; practice.work += project.progress; }
    appendExecution(host, { kind: project.kind, actorId: actor.id, recipeId: project.recipeId, programSignature: signature, inputs: [], outputs: [], residueMass: 0, energy: project.energyPaid, work: project.progress, success: false, parentRecipeIds: project.parents, catalysts: [], benefit: 0, balance: { opening, closing: opening, externalInputs: [], externalLoss: [] } });
    knowledge.project = null; maintainTechnologyMemory(host, actor); return false;
  }
  withdraw(host, actor, plan);
  let current = plan.inputs, success = true; const residue = empty(), catalysts: TechnologyExecution['catalysts'] = [];
  for (const step of project.program.steps) {
    const capability = step.requiredCatalyst ?? step.catalyst;
    const receipt = capability ? useTool(host, actor, capability, step.intensity * 0.4) : undefined;
    if (receipt) catalysts.push({ executionId: receipt.executionId, itemId: receipt.itemId, recipeId: receipt.recipeId, wear: receipt.wear, required: !!step.requiredCatalyst });
    const controlInputs = current;
    const result = applyPhysicalOperation(step, current, receipt?.power ?? 0); add(residue, result.residue);
    if (!result.success || !result.product) { success = false; current = []; break; }
    current = [result.product];
    // The catalyst's effect is measurable against the same operation with no catalyst.
    if (receipt) {
      const control = applyPhysicalOperation({ ...step, requiredCatalyst: undefined }, controlInputs, 0);
      const delta = control.product ? Math.max(0, result.product.properties.cohesion - control.product.properties.cohesion) + Math.max(0, result.product.properties.edge - control.product.properties.edge) + Math.max(0, result.product.properties.toughness - control.product.properties.toughness) + Math.max(0, control.product.properties.temperature - result.product.properties.temperature) + Math.max(0, control.product.properties.porosity - result.product.properties.porosity) + Math.max(0, result.product.mass - control.product.mass) / MASS_UNIT : 0;
      recordTechnologyBenefit(host, actor, receipt, delta);
    }
  }
  add(knowledge.residue, residue);
  let recipe = project.recipeId ? resolveTechnologyRecipe(host, project.recipeId) : findTechnologyRecipe(host, signature);
  const output = current[0];
  if (success && output) {
    if (!recipe && inventionRoom(state)) {
      const capacities = materialCapacities(output), newFunction = !hasTechnologyFunction(host, capacities);
      recipe = { id: `recipe-${state.recipeCounter + 1}`, name: `${project.program.steps.map(s => s.op).join('·').slice(0, 70)} ${state.recipeCounter + 1}`,
        program: structuredClone(project.program), signature, parents: [...project.parents], generation: nextGeneration, inventorId: actor.id, tick: host.tick, x: actor.x, y: actor.y,
        novelty: newFunction ? 'both' : 'program', capacities, uses: 0, utility: 0, manufactured: 0 };
      registerTechnologyRecipe(host, recipe); emitDiscovery(host, actor, recipe, emit);
    }
    if (recipe) {
      recycleToFit(host, actor);
      output.id = `product-${++state.itemCounter}`; output.recipeId = recipe.id; output.madeAt = host.tick; output.generation = recipe.generation;
      output.parentItems = [...new Set(plan.inputs.filter(i => i.recipeId).flatMap(i => i.parentItems.length ? i.parentItems : [i.id]))].slice(0, 16);
      knowledge.items.push(output);
      // The completed paid experiment (or an already learned craft) earns instructions.
      // Parent pins end with the project, so a full memory cannot stop a discovery.
      knowledge.project = null;
      rememberRecipe(knowledge, recipe.id, { capacity: technologyMemoryCapacity(state), protectedIds: [] });
      updateTechnologyRecipeStats(host, recipe.id, { manufactured: 1 }); state.ledger.crafted++;
    } else { add(knowledge.residue, output.composition); add(residue, output.composition); success = false; }
  }
  if (!success) state.ledger.failures++;
  const practicedId = recipe?.id ?? project.recipeId;
  if (practicedId) { const practice = knowledge.competence[practicedId] ??= { attempts: 0, successes: 0, work: 0, benefit: 0 }; practice.attempts++; practice.successes += Number(success); practice.work += project.progress; }
  actor.skills.technology = clamp((actor.skills.technology ?? 0) + 0.008);
  const outputs = success && output && recipe ? [{ resourceId: `recipe:${recipe.id}`, mass: output.mass }] : [];
  outputs.push(...compositionResources(residue, 'residue'), ...compositionResources(plan.fuel, 'spent'));
  const lost = (state.water?.environmentalLoss ?? 0) - lossBefore;
  const water = waterEnvelope(actor, waterOpening, 'spill', lost ? { lost } : {});
  appendExecution(host, { kind: project.kind, actorId: actor.id, recipeId: recipe?.id ?? null, programSignature: signature,
    inputs: [...project.program.inputs.map(i => ({ resourceId: i.source === 'product' ? `recipe:${i.recipeId}` : `${i.source}:${i.material}`, mass: i.mass })), ...plan.fuelInputs], outputs,
    residueMass: mass(residue), energy: project.energyPaid, work: project.progress, success, parentRecipeIds: project.parents,
    catalysts, benefit: 0, ...(water ? { water } : {}), nestedExecutionIds: Array.from({ length: state.executionCounter - transactionStart }, (_, n) => `process-${transactionStart + n + 1}`), balance: { opening, closing: technologyStock(actor), externalInputs: compositionResources(plan.imported, 'raw'), externalLoss: compositionResources(plan.fuel, 'spent') } });
  knowledge.project = null; maintainTechnologyMemory(host, actor);
  return success;
}
function advanceProject(host: TechnologyHost, actor: TechnologyActor, kind: TechnologyProject['kind'], recipeId?: string, emit?: Emit): boolean {
  const knowledge = actor.technology;
  if (actor.energy < 0.08 || actor.fatigue > 0.94) return false;
  if (!knowledge.project) {
    let proposal: { program: TechnologyProgram; parents: string[] } | undefined;
    if (kind === 'research') { if (host.noveltyEnabled === false) return false; proposal = proposeTechnologyProgram(host, actor); }
    else {
      const recipe = recipeId && knowledge.knownRecipes.includes(recipeId) ? resolveTechnologyRecipe(host, recipeId) : undefined;
      if (recipe) proposal = { program: structuredClone(recipe.program), parents: [...recipe.parents] };
    }
    if (!proposal || !planWithdrawal(host, actor, proposal.program)) { knowledge.lastAttempt = host.tick; knowledge.attempts++; return false; }
    knowledge.project = { kind, program: proposal.program, parents: proposal.parents, recipeId: kind === 'craft' ? recipeId! : null, progress: 0,
      requiredWork: technologyWorkCost(proposal.program), energyPaid: 0, startedAt: host.tick };
    for (const id of technologyProjectPins(knowledge)) touchKnownRecipe(knowledge, id);
  }
  const project = knowledge.project;
  if (project.kind !== kind || (kind === 'craft' && recipeId && project.recipeId !== recipeId)) return false;
  const practice = project.recipeId ? knowledge.competence[project.recipeId] : undefined;
  const energy = 0.00045 * (1 - (actor.skills.technology ?? 0) * 0.2 - Math.min(1, (practice?.successes ?? 0) / 10) * 0.1);
  actor.energy = clamp(actor.energy - energy); actor.fatigue = clamp(actor.fatigue + 0.00032);
  project.progress++; project.energyPaid += energy; host.technology.ledger.work++; host.technology.ledger.energy += energy;
  return project.progress >= project.requiredWork ? finishProject(host, actor, project, emit) : false;
}
export function researchTechnology(host: TechnologyHost, actor: TechnologyActor, emit?: Emit): boolean { return advanceProject(host, actor, 'research', undefined, emit); }
/** Explicitly abandoning a paid project preserves its spent work, without manufacturing or refunding matter. */
export function cancelTechnologyProject(host: TechnologyHost, actor: TechnologyActor): boolean {
  const knowledge=actor.technology,project=knowledge.project;
  if(!project)return false;
  const opening=technologyStock(actor);
  knowledge.project=null;knowledge.attempts++;knowledge.lastAttempt=host.tick;
  host.technology.ledger.attempts++;host.technology.ledger.failures++;
  if(project.recipeId) {const practice=knowledge.competence[project.recipeId]??={attempts:0,successes:0,work:0,benefit:0};practice.attempts++;practice.work+=project.progress;}
  appendExecution(host,{kind:project.kind,actorId:actor.id,recipeId:project.recipeId,programSignature:programSignature(project.program),inputs:[],outputs:[],residueMass:0,energy:project.energyPaid,work:project.progress,success:false,parentRecipeIds:[...project.parents],catalysts:[],benefit:0,balance:{opening,closing:opening,externalInputs:[],externalLoss:[]}});
  maintainTechnologyMemory(host, actor);
  return true;
}
export function craftTechnology(host: TechnologyHost, actor: TechnologyActor, recipeId?: string, emit?: Emit): boolean {
  const selected = recipeId ?? actor.technology.project?.recipeId ?? knownTechnologyRecipes(host, actor)
    .filter(r => planWithdrawal(host, actor, r.program))
    .sort((a, b) => (actor.technology.competence[b.id]?.benefit ?? 0) - (actor.technology.competence[a.id]?.benefit ?? 0) || (actor.technology.competence[b.id]?.successes ?? 0) - (actor.technology.competence[a.id]?.successes ?? 0) || a.id.localeCompare(b.id))[0]?.id;
  return advanceProject(host, actor, 'craft', selected, emit);
}
export function shareTechnology(host: TechnologyHost, teacher: TechnologyActor, learner: TechnologyActor, emit?: Emit, recipeId?: string): boolean {
  if (host.cooperationEnabled === false || host.learningEnabled === false || teacher === learner || teacher.id === learner.id || distance(teacher, learner) > 2 || teacher.energy < 0.05) return false;
  const recipe = knownTechnologyRecipes(host, teacher).filter(r => (!recipeId || r.id === recipeId) && !learner.technology.knownRecipes.includes(r.id)).sort((a, b) => (teacher.technology.competence[b.id]?.benefit ?? 0) - (teacher.technology.competence[a.id]?.benefit ?? 0) || a.id.localeCompare(b.id))[0];
  if (!recipe) return false;
  if (!rememberRecipe(learner.technology, recipe.id, { capacity: technologyMemoryCapacity(host.technology), protectedIds: technologyProjectPins(learner.technology) }).remembered) return false;
  learner.technology.learnedFrom.push({ recipeId: recipe.id, teacherId: teacher.id, tick: host.tick });
  touchKnownRecipe(teacher.technology, recipe.id);
  teacher.energy = clamp(teacher.energy - 0.003); teacher.fatigue = clamp(teacher.fatigue + 0.002);
  host.technology.ledger.energy += 0.003; host.technology.ledger.work += 1; host.technology.ledger.shared++;
  maintainTechnologyMemory(host, teacher); maintainTechnologyMemory(host, learner);
  (emit ?? host.emit)?.({ kind: 'learning', actors: [teacher.id, learner.id], x: teacher.x, y: teacher.y, source: 'simulation', text: `${teacher.name ?? teacher.id} mostró a ${learner.name ?? learner.id} las operaciones de ${recipe.name}.`, cause: 'Transmisión cercana de una receta realmente conocida; enseñar cuesta energía y no entrega productos ni materias primas.' });
  return true;
}
/** Move one existing lot; callers settle any agreed raw payment after this atomic check.
 * Raw inventories remain outside the technology ledger until a process consumes them. */
export function transferTechnologyItem(host: TechnologyHost, from: TechnologyActor, to: TechnologyActor, itemId: string): boolean {
  if (host.cooperationEnabled === false || from.id === to.id || !host.people.includes(from) || !host.people.includes(to) || distance(from, to) > 2 || to.technology.items.length >= host.technology.budgets.maxItems) return false;
  const index = from.technology.items.findIndex(i => i.id === itemId); if (index < 0) return false;
  const item = from.technology.items[index]!, senderOpening = technologyStock(from), receiverOpening = technologyStock(to);
  const sentWater = item.contents?.water ?? 0;
  if ((sentWater || containedWaterStock(to).length) && freeWaterCarryQuanta(host, to) < item.mass + sentWater) return false;
  const senderWater = containedWaterStock(from), receiverWater = containedWaterStock(to);
  from.technology.items.splice(index, 1); to.technology.items.push(item);
  const resources = [{ resourceId: itemResource(item), mass: item.mass }], transferId = `transfer-${host.technology.executionCounter + 1}`;
  const common = { kind: 'transfer' as const, recipeId: item.recipeId, programSignature: '', residueMass: 0, energy: 0, work: 0, success: true, parentRecipeIds: [], catalysts: [], benefit: 0, transferId };
  const out = waterEnvelope(from, senderWater, 'transfer', sentWater ? { sent: sentWater } : {}), into = waterEnvelope(to, receiverWater, 'transfer', sentWater ? { received: sentWater } : {});
  appendExecution(host, { ...common, actorId: from.id, counterpartyId: to.id, inputs: resources, outputs: [], ...(out ? { water: out } : {}), balance: { opening: senderOpening, closing: technologyStock(from), externalInputs: [], externalLoss: resources } });
  appendExecution(host, { ...common, actorId: to.id, counterpartyId: from.id, inputs: [], outputs: resources, ...(into ? { water: into } : {}), balance: { opening: receiverOpening, closing: technologyStock(to), externalInputs: resources, externalLoss: [] } });
  maintainTechnologyMemory(host, from); maintainTechnologyMemory(host, to);
  return true;
}
/** Death settles a physical estate before its owner is removed from the active population.
 * Local transfers move the existing objects; unclaimed material exits the technology model
 * at that location and is explicitly accounted as loss, never invented ecological food. */
export function settleTechnologyEstate(host: TechnologyHost, actor: TechnologyActor, recipients: TechnologyActor[] = []): { transfers: { to: string; items: string[]; mass: number }[]; lost: Composition; executionIds: string[] } {
  const result = { transfers: [] as { to: string; items: string[]; mass: number }[], lost: empty(), executionIds: [] as string[] };
  const nearby = recipients.filter((p, index) => p !== actor && p.id !== actor.id && recipients.indexOf(p) === index && host.people.includes(p) && distance(actor, p) <= 2).sort((a, b) => distance(actor, a) - distance(actor, b) || a.id.localeCompare(b.id));
  for (const recipient of nearby) {
    const room = Math.max(0, host.technology.budgets.maxItems - recipient.technology.items.length);
    let free = freeWaterCarryQuanta(host, recipient);
    let bounded = containedWaterStock(recipient).length > 0;
    const items: MaterialBatch[] = [];
    for (const item of actor.technology.items) {
      if (items.length >= room) break;
      const carried = item.mass + (item.contents?.water ?? 0);
      if ((bounded || (item.contents?.water ?? 0) > 0) && carried > free) continue;
      bounded ||= (item.contents?.water ?? 0) > 0;
      free = Math.max(0, free - carried); items.push(item);
    }
    const debris = bounded ? splitComposition(actor.technology.residue, free) : { ...actor.technology.residue };
    if (!items.length && !mass(debris)) continue;
    const senderOpening = technologyStock(actor), receiverOpening = technologyStock(recipient), senderWater = containedWaterStock(actor), receiverWater = containedWaterStock(recipient);
    const movedWater = items.reduce((n, item) => n + (item.contents?.water ?? 0), 0);
    actor.technology.items = actor.technology.items.filter(item => !items.includes(item)); recipient.technology.items.push(...items);
    add(recipient.technology.residue, debris); subtract(actor.technology.residue, debris);
    const resources = [...items.map(i => ({ resourceId: itemResource(i), mass: i.mass })), ...compositionResources(debris, 'residue')];
    const transferId = `transfer-${host.technology.executionCounter + 1}`;
    const common = { kind: 'transfer' as const, recipeId: null, programSignature: '', residueMass: 0, energy: 0, work: 0, success: true, parentRecipeIds: [], catalysts: [], benefit: 0, transferId };
    const out = waterEnvelope(actor, senderWater, 'transfer', movedWater ? { sent: movedWater } : {}), into = waterEnvelope(recipient, receiverWater, 'transfer', movedWater ? { received: movedWater } : {});
    const sent = appendExecution(host, { ...common, actorId: actor.id, counterpartyId: recipient.id, inputs: resources, outputs: [], ...(out ? { water: out } : {}), balance: { opening: senderOpening, closing: technologyStock(actor), externalInputs: [], externalLoss: resources } });
    const received = appendExecution(host, { ...common, actorId: recipient.id, counterpartyId: actor.id, inputs: [], outputs: resources, ...(into ? { water: into } : {}), balance: { opening: receiverOpening, closing: technologyStock(recipient), externalInputs: resources, externalLoss: [] } });
    result.executionIds.push(sent.id, received.id); result.transfers.push({ to: recipient.id, items: items.map(i => i.id), mass: resources.reduce((n, r) => n + r.mass, 0) });
    maintainTechnologyMemory(host, recipient);
  }
  const opening = technologyStock(actor);
  if (opening.length) {
    const waterOpening = containedWaterStock(actor);
    let lost = 0; for (const item of actor.technology.items) lost += settleContainedWaterCapacity(host, item, true);
    result.lost = sum([...actor.technology.items.map(i => i.composition), actor.technology.residue]);
    add(host.technology.ledger.estateLoss, result.lost); actor.technology.items = []; actor.technology.residue = empty();
    const water = waterEnvelope(actor, waterOpening, 'spill', lost ? { lost } : {});
    const event = appendExecution(host, { kind: 'estate', actorId: actor.id, recipeId: null, programSignature: '', inputs: opening, outputs: [], residueMass: 0, energy: 0, work: 0, success: true, parentRecipeIds: [], catalysts: [], benefit: 0, ...(water ? { water } : {}), balance: { opening, closing: [], externalInputs: [], externalLoss: opening } });
    result.executionIds.push(event.id);
  }
  actor.technology.project = null;
  maintainTechnologyMemory(host, actor);
  return result;
}
export function projectTechnology(host: TechnologyHost): TechnologyView {
  const state = host.technology, all = host.people.flatMap(p => p.technology.items), composition = sum(all.map(i => i.composition)), residue = sum(host.people.map(p => p.technology.residue));
  const importedMass = mass(state.ledger.imported), productMass = mass(composition), residueMass = mass(residue), totals = technologyCatalogueTotals(host);
  return { recipes: structuredClone(state.recipes), items: host.people.flatMap(p => p.technology.items.map(i => {
    const affordance = state.water ? containerAffordance(i) : undefined;
    return { id: i.id, ownerId: p.id, x: p.x, y: p.y, recipeId: i.recipeId, mass: i.mass, generation: i.generation, capacities: materialCapacities(i),
      ...(affordance ? { water: { version: 1 as const, quanta: i.contents?.water ?? 0, capacityQuanta: affordance.capacityQuanta,
        quantaPerUnit: 50000 as const, leakageNumerator: affordance.leakageNumerator, leakageDenominator: 1000000 as const } } : {}) };
  })),
    knowledge: host.people.map(person => ({ actorId: person.id, recipeIds: [...person.technology.knownRecipes] })),
    dynamics: { attempts: state.ledger.attempts, failures: state.ledger.failures, recipes: totals.recipes, products: all.length, generations: totals.maxGeneration,
      toolUses: state.ledger.toolUses, observedUtility: totals.utility, shared: state.ledger.shared,
      importedMass, productMass, residueMass, massError: importedMass - productMass - residueMass - state.ledger.fuelMass - mass(state.ledger.estateLoss), estateLostMass: mass(state.ledger.estateLoss),
      work: state.ledger.work, energy: state.ledger.energy, programDiversity: totals.recipes,
      functionalDiversity: totals.functionalDiversity,
      reusedProducts: state.history.filter(e => ['research', 'craft'].includes(e.kind) && e.inputs.some(i => i.resourceId.startsWith('recipe:'))).length, historyDropped: state.historyDropped }, budgets: { ...state.budgets } };
}

export function assertTechnology(host: TechnologyHost): void {
  const fail = () => { throw new Error('Estado de tecnología física inválido.'); };
  const finite = (n: unknown, max = Number.MAX_SAFE_INTEGER): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max;
  const integer = (n: unknown, max = Number.MAX_SAFE_INTEGER): n is number => finite(n, max) && Number.isSafeInteger(n);
  const composition = (c: Composition) => c && MATERIALS.every(m => integer(c[m]));
  const state = host.technology;
  if (!state || state.version !== 1 || !state.budgets || !state.ledger || !composition(state.ledger.imported) || !composition(state.ledger.estateLoss)) fail();
  const limits = defaultTechnologyState().budgets;
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) if (!integer(state.budgets[key], limits[key]) || state.budgets[key] < 1) fail();
  if (!Array.isArray(state.recipes) || state.recipes.length > state.budgets.maxRecipes || !Array.isArray(state.history) || state.history.length > state.budgets.maxHistory) fail();
  for (const key of ['recipeCounter', 'itemCounter', 'executionCounter', 'historyDropped'] as const) if (!integer(state[key])) fail();
  if ((!catalogueEnabled(state) && state.recipeCounter !== state.recipes.length) || state.historyDropped + state.history.length !== state.executionCounter || state.ledger.attempts !== state.ledger.crafted + state.ledger.failures) fail();
  try { assertTechnologyCatalogueState(host); } catch { fail(); }
  assertTechnologyJournal(state, host.tick);
  for (const [key, value] of Object.entries(state.ledger)) if (!['imported', 'estateLoss'].includes(key) && !(key === 'energy' ? finite(value) : integer(value))) fail();
  const recipeIds = new Set<string>(), signatures = new Set<string>();
  const getRecipe = (id: string, at = host.tick): TechnologyRecipe | undefined => {
    if (typeof id !== 'string' || !/^recipe-[1-9]\d*$/.test(id) || !integer(Number(id.slice(7)), state.recipeCounter)) return;
    const recipe = resolveTechnologyRecipe(host, id, { cache: false });
    return recipe && recipe.tick <= at ? recipe : undefined;
  };
  // Uncommitted definitions remain authoritative even after their display cache entry was evicted.
  const pendingRecipes = state.catalogue?.pending ?? [], pendingIds = new Set(pendingRecipes.map(recipe => recipe.id));
  for (const recipe of [...pendingRecipes, ...state.recipes.filter(recipe => !pendingIds.has(recipe.id))]) {
    if (!recipe || typeof recipe.id !== 'string' || !/^recipe-[1-9]\d*$/.test(recipe.id) || !integer(Number(recipe.id.slice(7)), state.recipeCounter) || recipeIds.has(recipe.id) || !validTechnologyProgram(recipe.program, state) || recipe.signature !== programSignature(recipe.program) || signatures.has(recipe.signature) || !integer(recipe.generation, generationLimit(state)) || recipe.generation < 1 || !integer(recipe.tick, host.tick) || !Array.isArray(recipe.parents) || recipe.parents.length > 6 || recipe.parents.some(id => !getRecipe(id, recipe.tick) || Number(id.slice(7)) >= Number(recipe.id.slice(7))) || !integer(recipe.uses) || !finite(recipe.utility) || !integer(recipe.manufactured) || !recipe.capacities || !CAPABILITIES.every(c => finite(recipe.capacities[c], 1))) fail();
    if (recipe.generation !== 1 + Math.max(0, ...recipe.parents.map(id => getRecipe(id, recipe.tick)!.generation))) fail();
    if (typeof recipe.name !== 'string' || recipe.name.length > 100 || typeof recipe.inventorId !== 'string' || recipe.inventorId.length > 100 || !Number.isFinite(recipe.x) || !Number.isFinite(recipe.y) || !['program', 'function', 'both'].includes(recipe.novelty) || new Set(recipe.parents).size !== recipe.parents.length || recipe.program.inputs.some(i => i.source === 'product' && (!getRecipe(i.recipeId!, recipe.tick) || !recipe.parents.includes(i.recipeId!)))) fail();
    recipeIds.add(recipe.id); signatures.add(recipe.signature);
  }
  const itemIds = new Set<string>(); let current = empty();
  for (const actor of host.people) {
    const knowledge = actor.technology;
    if (!knowledge || !Array.isArray(knowledge.items) || knowledge.items.length > state.budgets.maxItems || !Array.isArray(knowledge.knownRecipes) || knowledge.knownRecipes.length > technologyMemoryCapacity(state) || new Set(knowledge.knownRecipes).size !== knowledge.knownRecipes.length || knowledge.knownRecipes.some(id => !getRecipe(id)) || !composition(knowledge.residue) || !integer(knowledge.attempts) || !Number.isSafeInteger(knowledge.lastAttempt) || knowledge.lastAttempt < -120 || knowledge.lastAttempt > host.tick || !Array.isArray(knowledge.learnedFrom) || knowledge.learnedFrom.length > technologyMemoryCapacity(state)) fail();
    add(current, knowledge.residue);
    for (const learned of knowledge.learnedFrom) if (!getRecipe(learned.recipeId, learned.tick) || !knowledge.knownRecipes.includes(learned.recipeId) || !integer(learned.tick, host.tick) || typeof learned.teacherId !== 'string' || learned.teacherId === actor.id) fail();
    if (!knowledge.competence || typeof knowledge.competence !== 'object') fail();
    for (const [id, practice] of Object.entries(knowledge.competence)) if (!getRecipe(id) || !practice || !integer(practice.attempts) || !integer(practice.successes, practice.attempts) || !integer(practice.work) || !finite(practice.benefit)) fail();
    for (const item of knowledge.items) {
      if (!item || typeof item.id !== 'string' || !/^product-\d+$/.test(item.id) || Number(item.id.slice(8)) > state.itemCounter || itemIds.has(item.id) || !composition(item.composition) || item.mass !== mass(item.composition) || !integer(item.mass) || item.mass < 1 || !integer(item.initialMass) || item.initialMass < item.mass || !item.recipeId || !getRecipe(item.recipeId, item.madeAt) || !integer(item.madeAt, host.tick) || !integer(item.generation, generationLimit(state)) || item.generation !== getRecipe(item.recipeId, item.madeAt)?.generation || !item.properties || !Object.keys(rawProperties(empty())).every(k => finite(item.properties[k as keyof MaterialProperties], 1)) || !Array.isArray(item.parentItems) || item.parentItems.length > 16) fail();
      add(current, item.composition); itemIds.add(item.id);
    }
    const project = knowledge.project;
    if (project !== null && (!project || !['research', 'craft'].includes(project.kind) || !validTechnologyProgram(project.program, state) || !integer(project.progress) || project.progress >= project.requiredWork || project.requiredWork !== technologyWorkCost(project.program) || !integer(project.startedAt, host.tick) || !finite(project.energyPaid) || !Array.isArray(project.parents) || project.parents.length > 6 || new Set(project.parents).size !== project.parents.length || project.parents.some(id => !getRecipe(id, project.startedAt)) || (project.kind === 'research' && (project.recipeId !== null || project.parents.some(id => !knowledge.knownRecipes.includes(id)) || project.program.inputs.some(input => input.source === 'product' && !project.parents.includes(input.recipeId!)))) || (project.kind === 'craft' && (!knowledge.knownRecipes.includes(project.recipeId!) || getRecipe(project.recipeId!, project.startedAt)?.signature !== programSignature(project.program) || JSON.stringify(project.parents) !== JSON.stringify(getRecipe(project.recipeId!, project.startedAt)?.parents))))) fail();
  }
  current.wood += state.ledger.fuelMass; add(current, state.ledger.estateLoss);
  if (MATERIALS.some(m => current[m] !== state.ledger.imported[m])) fail();
  assertTechnologyWater(host);
  // Pending receipts may exceed the recent display ring. Validate their physical envelopes too.
  const pending = state.journal?.pending;
  const executions = pending && pending.length > state.history.length ? pending : state.history;
  const executionIds = new Set<string>(); let previousSerial = executions === pending ? state.journal!.committedThrough : state.historyDropped;
  for (const e of executions) {
    assertWaterExecution(e);
    if (!e || typeof e.id !== 'string' || executionIds.has(e.id) || !integer(e.tick, host.tick) || !finite(e.energy) || !integer(e.work) || !finite(e.benefit) || !integer(e.residueMass) || typeof e.success !== 'boolean' || !Array.isArray(e.inputs) || !Array.isArray(e.outputs) || !e.balance || ![e.inputs, e.outputs, e.balance.opening, e.balance.closing, e.balance.externalInputs, e.balance.externalLoss].every(xs => Array.isArray(xs) && xs.every(r => typeof r.resourceId === 'string' && integer(r.mass)))) fail();
    const total = (rs: ResourceMass[]) => rs.reduce((n, r) => n + r.mass, 0);
    if (total(e.balance.opening) + total(e.balance.externalInputs) !== total(e.balance.closing) + total(e.balance.externalLoss)) fail();
    const serial = Number(e.id.slice(8));
    if (!/^process-\d+$/.test(e.id) || !integer(serial, state.executionCounter) || serial !== previousSerial + 1 || !['research', 'craft', 'use', 'recycle', 'estate', 'transfer', 'water'].includes(e.kind) || typeof e.actorId !== 'string' || e.actorId.length > 100 || !(e.recipeId === null || getRecipe(e.recipeId, e.tick)) || !Array.isArray(e.parentRecipeIds) || e.parentRecipeIds.length > 6 || e.parentRecipeIds.some(id => !getRecipe(id, e.tick)) || !Array.isArray(e.catalysts) || e.catalysts.length > state.budgets.maxSteps || e.catalysts.some(c => typeof c.itemId !== 'string' || !(c.recipeId === null || getRecipe(c.recipeId, e.tick)) || !integer(c.wear) || typeof c.required !== 'boolean' || !/^process-\d+$/.test(c.executionId))) fail();
    if (e.nestedExecutionIds !== undefined && (!Array.isArray(e.nestedExecutionIds) || e.nestedExecutionIds.length > state.budgets.maxSteps + 1 || new Set(e.nestedExecutionIds).size !== e.nestedExecutionIds.length || e.nestedExecutionIds.some(id => !/^process-\d+$/.test(id) || Number(id.slice(8)) >= serial || !integer(Number(id.slice(8)), state.executionCounter)))) fail();
    if (e.kind === 'transfer' && (typeof e.transferId !== 'string' || !/^transfer-\d+$/.test(e.transferId) || typeof e.counterpartyId !== 'string' || e.counterpartyId === e.actorId)) fail();
    previousSerial = serial;
    executionIds.add(e.id);
  }
  const totals = technologyCatalogueTotals(host);
  if (totals.manufactured !== state.ledger.crafted || totals.uses !== state.ledger.toolUses) fail();
  assertTechnologyCheckpoint(state, host.tick);
}
