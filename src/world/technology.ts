import type { ChronicleEvent } from '../shared/types.js';
import type { StructureView } from '../shared/life.js';
import type { Capability, Composition, Material, MaterialBatch, MaterialProperties, MaterialRequirement, OperationInstruction, PhysicalOperation, ResourceMass, TechnologyExecution, TechnologyKnowledge, TechnologyProgram, TechnologyProject, TechnologyRecipe, TechnologyState, TechnologyView } from '../shared/technology.js';
import { localRandom } from './genetics.js';
import { assertTechnologyCheckpoint } from './technology-checkpoint.js';
import { assertTechnologyJournal } from './technology-journal.js';
import { appendTechnologyExecution as appendExecution, renumberTechnologyExecutionBlock, technologyExecutionSerial, technologyStock } from './technology-execution.js';
import { assertTechnologyWater, assertWaterExecution, containedWaterStock, freeWaterCarryQuanta, settleContainedWaterCapacity, waterEnvelope } from './technology-water.js';
export { technologyStock } from './technology-execution.js';
import { assertTechnologyCatalogueState, catalogueEnabled, findTechnologyRecipe, hasTechnologyFunction, registerTechnologyRecipe, resolveTechnologyRecipe, technologyCatalogueTotals, technologyMemoryCapacity, updateTechnologyRecipeStats } from './technology-catalogue.js';
import { fuerzaReceta, nuevaTecnica, olvidarRecetas, pruneTechnologyCompetence, recetaRecordada, recordarReceta, rememberRecipe, tauRecetaTicks, technologyProjectPins, touchKnownRecipe, usarReceta } from './technology-memory.js';
import { containerAffordance } from './material-affordances.js';
import { firstTileAt } from './tile-index.js';
import { boundParamsOf, HISTORICAL_PARAMS, ley, paramsOf, type WorldParams } from './params.js';
import { ACTIVE_CAPABILITY_THRESHOLD, isGenuineFunctionalNovelty, novedadFuncional, type PerfilFuncional } from './tecnologia-complejidad.js';
import type { Person } from './mundo/tipos.js';
import type { RecetaRecordada, TecnicaPersona } from '../shared/technology.js';
import { formaDeCodigo } from '../shared/materia.js';
import { ctxSi, type CtxLeyMateria } from './motor/acceso.js';
import { REF_NULA, slotDe, TipoIntento } from './motor/contratos.js';
import { cargaKg, masaDe, pagar } from './materia/cuerpo.js';
import { fuegoEn, lotesDeCelda, temperaturaDe } from './materia/ley-mundo.js';
import { CLAVES_FUNCIONALES, POTENCIA_TRABAJO, SEGUNDOS_TICK, avanzarProcesoCon, celdaPropia, codificarReceta, iniciarProceso, leerReceta,
  objetosDeCelda, perfilDeVector, vectorFuncional, volumenLote } from './materia/proceso.js';
import { Parte, Rol, type Cuerpo, type LoteRef, type Paso, type ProcesoMaterial } from './materia/tipos.js';
import type { World } from './index.js';
import { BROKEN_CONDITION, storedMaterialsNear, withdrawMaterials, structureDistance } from './inventions.js';
import { filtrarCerca } from './indice-puntos.js';
import { blendForgedProfile, compoundHuntBonus, forgeWithCompound } from './chemistry.js';
import type { CompoundLot } from '../shared/chemistry.js';
import { marcarTesela } from './soa/barrera-percepcion.js';
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
  tiles?: { x: number; y: number; drinkingWater?: number; wood?: number; stone?: number; terrain?: string; moisture?: number; vegetation?: number; cultivation?: number; fauna?: number }[];
  cooperationEnabled?: boolean; learningEnabled?: boolean; noveltyEnabled?: boolean; emit?: Emit;
  /** Tiempo del paso (`World.weather`); sólo lo leen los usos de `tecnologia.efectosHerramientas`. */
  weather?: string;
  structures?: StructureView[];
  retiredChunks?: { structures?: StructureView[] }[];
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
/** Lee `tecnologia.*` del WeakMap si `host` es un `World` (o un host con `setParams`);
 * los `TechnologyHost` sintéticos sin registro usan siempre los valores históricos. */
function techParams(host: TechnologyHost): WorldParams['tecnologia'] {
  return boundParamsOf(host)?.tecnologia ?? HISTORICAL_PARAMS.tecnologia;
}
/** V23: química emergente activa en este anfitrión (un host sintético sin params nunca la activa). */
function chemistryWorld(host: TechnologyHost): boolean {
  return boundParamsOf(host)?.quimica.emergente === true;
}
/** Lotes químicos que lleva el actor (solo existen en mundos con `quimica.emergente`). */
const actorCompounds = (actor: TechnologyActor): CompoundLot[] | undefined => (actor as TechnologyActor & { compounds?: CompoundLot[] }).compounds;
function synergyWorld(host: TechnologyHost): host is TechnologyHost & World {
  return !!(boundParamsOf(host)?.construccion.poliminosYSinergia && host.structures && host.tiles && 'blueprints' in host);
}
/** Physical workshop contact only; never chains a second neighbour search from a decision. */
export function workshopWorkFactor(host: TechnologyHost, actor: TechnologyActor): number {
  if (!synergyWorld(host)) return 1;
  const workshops = filtrarCerca(host.structures, actor, 5, s => (!s.site || !!s.site.expansion) && s.condition > BROKEN_CONDITION
    && structureDistance(actor, s) <= 1.5 && (s.synergy?.workshopBonus ?? 0) > 0);
  return 1 - Math.min(0.30, Math.max(0, ...workshops.map(s => s.synergy!.workshopBonus)));
}
function availableRawMaterials(host: TechnologyHost, actor: TechnologyActor): TechnologyActor['materials'] {
  if (!synergyWorld(host)) return actor.materials;
  const stored = storedMaterialsNear(host, actor);
  return { wood: actor.materials.wood + stored.wood, stone: actor.materials.stone + stored.stone };
}
/** `host.people.includes(x)` on the decision path (T141 inventory: `technology.ts:584,605`): a cache
 * keyed by the array itself, invalidated by length, like `tile-index.ts` and `rejilla.ts`. Exact
 * because `host.people` (`world.people`) only ever gets reassigned to a new array (a death, `filter`
 * in `lineage.ts`) or grown with `push` (a birth, T141) — both change the reference or the length, so
 * a stale entry can never be read. The `Set` holds the SAME references as the array, so `.has(x)` is
 * exactly `.includes(x)`: `Array.prototype.includes` and `Set.prototype.has` both use SameValueZero,
 * which for objects is `===`. */
const peopleMemberships = new WeakMap<readonly TechnologyActor[], { length: number; members: Set<TechnologyActor> }>();
function isHostMember(people: readonly TechnologyActor[], actor: TechnologyActor): boolean {
  let cached = peopleMemberships.get(people);
  if (!cached || cached.length !== people.length) { cached = { length: people.length, members: new Set(people) }; peopleMemberships.set(people, cached); }
  return cached.members.has(actor);
}
export function defaultTechnologyState(): TechnologyState {
  return { version: 1, recipes: [], history: [], historyDropped: 0, recipeCounter: 0, itemCounter: 0, executionCounter: 0,
    ledger: { imported: empty(), estateLoss: empty(), work: 0, energy: 0, fuelMass: 0, attempts: 0, failures: 0, crafted: 0, toolUses: 0, shared: 0, recycled: 0 },
    budgets: { maxRecipes: 256, maxSteps: 12, maxInputs: 4, maxItems: 16, maxHistory: 256, maxGeneration: 32, maxMassPerInput: 4000 } };
}
export function initialTechnologyKnowledge(v23?: Pick<WorldParams['v23'], 'tecnica' | 'intentos'>): TechnologyKnowledge {
  return { knownRecipes: [], items: [], residue: empty(), attempts: 0, lastAttempt: -120, project: null, learnedFrom: [], competence: {},
    ...(v23?.tecnica || v23?.intentos ? { waterPreparation: undefined } : {}),
    ...(v23?.tecnica ? { tecnica: nuevaTecnica() } : {}) };
}
/** Keep local instructions and practice bounded, including after stock leaves an actor. */
export function maintainTechnologyMemory(host: TechnologyHost, actor: TechnologyActor): void {
  const knowledge = actor.technology, capacity = technologyMemoryCapacity(host.technology);
  if (knowledge.waterPreparation && !knowledge.items.some(item => item.id === knowledge.waterPreparation!.itemId)) knowledge.waterPreparation = undefined;
  if (ley(host, 'tecnica')) return;
  if (knowledge.knownRecipes.length > capacity && !rememberRecipe(knowledge, knowledge.knownRecipes.at(-1)!, {
    capacity, protectedIds: technologyProjectPins(knowledge),
  }).remembered) throw new Error('Active technology instructions exceed local memory capacity.');
  pruneTechnologyCompetence(knowledge);
}
function knownTechnologyRecipes(host: TechnologyHost, actor: TechnologyActor, cache = true): TechnologyRecipe[] {
  // The archive resolves only identities already held locally; its cache is not knowledge.
  const known: TechnologyRecipe[] = [];
  actor.technology.knownRecipes.forEach(id => {
    const recipe = resolveTechnologyRecipe(host, id, { cache });
    if (recipe) known.push(recipe);
  });
  return known;
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
/** Las seis capacidades de un lote en el orden de `CAPABILITIES`, escritas en `out` sin crear objetos (V18: eran
 * `materialCapacities` + `itemCapacities` ≈ 2,7 % del paso a 3 207 habitantes). Es la única fórmula: las
 * demás funciones la leen de aquí, así que no hay dos versiones que puedan divergir. Lee SÓLO `mass`,
 * `initialMass`, `composition.water` y las once propiedades que aparecen abajo —nada se cachea, un cambio
 * en sitio de `mass`, `composition` o `properties` se ve en la llamada siguiente—. Mismas expresiones y
 * mismo orden de operaciones que la versión con objeto: salida idéntica bit a bit (también `-0` y `NaN`). */
function fillCapacities(batch: MaterialBatch, out: Float64Array): void {
  const p = batch.properties, integrity = clamp(batch.mass / Math.max(1, batch.initialMass));
  const solidity = 1 - batch.composition.water / Math.max(1, batch.mass);
  const usable = Math.min(1, batch.mass / 500) * integrity * solidity * clamp(1 - p.temperature);
  out[0] = clamp(p.edge * p.hardness * p.cohesion * 1.7) * usable;
  out[1] = clamp(p.containment * p.cohesion * (1 - p.porosity) * 2) * usable;
  out[2] = clamp(p.insulation * p.cohesion * (0.3 + p.alignment) * 1.2) * usable;
  out[3] = clamp(p.leverage * (p.hardness * 0.7 + p.toughness * 0.3) * p.cohesion * 1.6) * usable;
  out[4] = clamp(p.flexibility * p.alignment * p.cohesion * 1.8) * usable;
  out[5] = clamp(p.hardness * (1 - p.porosity) * (1 - p.edge * 0.5) * p.cohesion) * usable;
}
const capacityScratch = new Float64Array(6);
const CAPABILITY_SLOT: Readonly<Record<Capability, number>> = { cutting: 0, storage: 1, insulation: 2, cultivation: 3, binding: 4, abrasion: 5 };
export function materialCapacities(batch: MaterialBatch): Record<Capability, number> {
  const c = capacityScratch; fillCapacities(batch, c);
  return { cutting: c[0]!, storage: c[1]!, insulation: c[2]!, cultivation: c[3]!, binding: c[4]!, abrasion: c[5]! };
}
/** `materialCapacities(batch)[capability]` sin construir el objeto. */
function materialCapacity(batch: MaterialBatch, capability: Capability): number {
  fillCapacities(batch, capacityScratch);
  return capacityScratch[CAPABILITY_SLOT[capability]]!;
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
interface Withdrawal { inputs: MaterialBatch[]; imported: Composition; fuel: Composition; fuelInputs: ResourceMass[]; itemMasses: Map<string, number>; itemCompositions: Map<string, Composition>; residue: Composition; waterTile?: { readonly x: number; readonly y: number; drinkingWater?: number }; }
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
  const available = availableRawMaterials(host, actor);
  if (available.wood * MASS_UNIT + 1e-8 < imported.wood || available.stone * MASS_UNIT + 1e-8 < imported.stone || MATERIALS.some(m => actor.technology.residue[m] < residue[m])) return;
  const waterTile = imported.water ? (host.tiles ? firstTileAt(host.tiles, Math.round(actor.x), Math.round(actor.y)) : undefined) : undefined;
  // Drinking stock uses fifty mass units per normalized water unit; only the occupied tile is observable.
  if (imported.water && (waterTile?.drinkingWater ?? 0) * 50_000 + 1e-8 < imported.water) return;
  for (const step of program.steps) if (step.requiredCatalyst && !actor.technology.items.some(item => item.mass - (itemMasses.get(item.id) ?? 0) >= 30 && materialCapacity(item, step.requiredCatalyst!) >= 0.1)) return;
  const fuelInputs: ResourceMass[] = [];
  if (fuelNeeded > scrapFuel) fuelInputs.push({ resourceId: 'raw:wood', mass: fuelNeeded - scrapFuel });
  if (scrapFuel) fuelInputs.push({ resourceId: 'residue:wood', mass: scrapFuel });
  return { inputs, imported, fuel, fuelInputs, itemMasses, itemCompositions, residue, waterTile };
}
function withdraw(host: TechnologyHost, actor: TechnologyActor, plan: Withdrawal): void {
  if (synergyWorld(host)) {
    const stock = withdrawMaterials(host, actor, {
      wood: Math.max(0, Math.ceil(plan.imported.wood / MASS_UNIT - actor.materials.wood - 1e-8)),
      stone: Math.max(0, Math.ceil(plan.imported.stone / MASS_UNIT - actor.materials.stone - 1e-8)),
    });
    actor.materials.wood += stock.wood; actor.materials.stone += stock.stone;
  }
  actor.materials.wood = Math.max(0, actor.materials.wood - plan.imported.wood / MASS_UNIT);
  actor.materials.stone = Math.max(0, actor.materials.stone - plan.imported.stone / MASS_UNIT);
  if (plan.waterTile) { plan.waterTile.drinkingWater = Math.max(0, plan.waterTile.drinkingWater! - plan.imported.water / 50_000); marcarTesela(plan.waterTile); }
  for (const item of actor.technology.items) {
    const amount = plan.itemMasses.get(item.id) ?? 0;
    if (amount && actor.technology.waterPreparation?.itemId === item.id) actor.technology.waterPreparation = undefined;
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
  return itemCapacities(actor.technology.items);
}
/** Lo mismo que `toolCapacities` de un actor con esos objetos, sin construir el actor (sprint noche-perf2:
 * los llamadores copiaban la persona entera sólo para cambiarle el inventario). */
export function itemCapacities(items: readonly MaterialBatch[]): Record<Capability, number> {
  const c = capacityScratch;
  let cutting = 0, storage = 0, insulation = 0, cultivation = 0, binding = 0, abrasion = 0;
  for (let i = 0; i < items.length; i++) {
    fillCapacities(items[i]!, c);
    cutting = Math.max(cutting, c[0]!); storage = Math.max(storage, c[1]!); insulation = Math.max(insulation, c[2]!);
    cultivation = Math.max(cultivation, c[3]!); binding = Math.max(binding, c[4]!); abrasion = Math.max(abrasion, c[5]!);
  }
  return { cutting, storage, insulation, cultivation, binding, abrasion };
}
export interface ToolReceipt { executionId: string; itemId: string; recipeId: string | null; capability: Capability; power: number; wear: number; }
function bestTool(actor: TechnologyActor, capability: Capability) {
  return actor.technology.items.map(item => ({ item, power: materialCapacity(item, capability) })).filter(i => i.power > 0.07)
    .sort((a, b) => b.power - a.power || a.item.id.localeCompare(b.item.id))[0];
}
/** Shared by execution and private forecasts: the useful impulse pays the same wear. */
function spendToolMaterial(actor: TechnologyActor, best: { item: MaterialBatch; power: number }, demand: number) {
  const requestedWear = Math.max(1, Math.ceil(demand * (2 + (1 - best.item.properties.toughness) * 8))), wear = Math.min(best.item.mass, requestedWear);
  const debris = splitComposition(best.item.composition, wear);
  subtract(best.item.composition, debris); best.item.mass -= wear; add(actor.technology.residue, debris);
  return { wear, debris, power: best.power * wear / requestedWear };
}
/** A receipt commits abrasion immediately. Call recordTechnologyBenefit only after applying the actual world delta. */
export function useTool(host: TechnologyHost, actor: TechnologyActor, capability: Capability, demand = 1): ToolReceipt | undefined {
  if (!CAPABILITIES.includes(capability) || !Number.isFinite(demand) || demand <= 0) return;
  const best = bestTool(actor, capability); if (!best) return;
  if (actor.technology.waterPreparation?.itemId === best.item.id) actor.technology.waterPreparation = undefined;
  const opening = technologyStock(actor), waterOpening = containedWaterStock(actor), { wear, debris, power } = spendToolMaterial(actor, best, demand);
  const waterLost = settleContainedWaterCapacity(host, best.item, best.item.mass === 0);
  actor.technology.items = actor.technology.items.filter(i => i.mass > 0);
  const state = host.technology; state.ledger.toolUses++;
  if (best.item.recipeId) { updateTechnologyRecipeStats(host, best.item.recipeId, { uses: 1 }); touchKnownRecipe(actor.technology, best.item.recipeId); }
  const water = waterEnvelope(actor, waterOpening, 'spill', waterLost ? { lost: waterLost } : {});
  const event = appendExecution(host, { kind: 'use', actorId: actor.id, recipeId: best.item.recipeId, programSignature: '', inputs: [{ resourceId: itemResource(best.item), mass: wear }], outputs: compositionResources(debris, 'residue'), residueMass: wear, energy: 0, work: 0, success: true, parentRecipeIds: [], catalysts: [], benefit: 0, ...(water ? { water } : {}), balance: { opening, closing: technologyStock(actor), externalInputs: [], externalLoss: [] } });
  maintainTechnologyMemory(host, actor);
  return { executionId: event.id, itemId: best.item.id, recipeId: best.item.recipeId, capability, power, wear };
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
/**
 * V16 — efectos físicos cualitativos de las seis capacidades (`tecnologia.efectosHerramientas`, por
 * defecto `false`: nada de esto ocurre y el mundo es el histórico bit a bit). Con la ley, el abrigo
 * (`insulation`), las ataduras y lazos (`binding`), el corte (`cutting`) y el desbaste (`abrasion`)
 * cambian la caza, la obra y la intemperie. Cada efecto pasa por `useTool` (desgaste material real,
 * conservado en el residuo del actor y en el libro) y su beneficio sólo se anota con
 * `recordTechnologyBenefit` después de medir el cambio que produjo en el mundo. Un anfitrión
 * sintético sin params nunca activa la ley.
 */
export function toolEffectsEnabled(host: TechnologyHost): boolean {
  return techParams(host).efectosHerramientas === true;
}
/** Por debajo de 0,07 un objeto no cuenta como herramienta: la misma cota con la que `bestTool` lo admite. */
const toolPower = (power: number): number => power > 0.07 ? power : 0;
/** Abrigo portátil (capa o manta tejida) que lleva el actor: sólo lectura, para prever la protección
 * a la intemperie (`bodilyShelter`/`choose`). El uso real y su desgaste van por `consumeInsulationTools`. */
export function portableInsulationPower(actor: TechnologyActor): number {
  return toolPower(itemCapacities(actor.technology.items).insulation);
}
/** Fracción del trabajo de caza que queda con lanza o cuchillo (`cutting`) y lazo o trampa (`binding`):
 * 1 sin la ley o sin herramientas; como mucho un 32 % menos. Sólo lectura (se paga en `consumeHuntingTools`). */
export function huntingWorkFactor(host: TechnologyHost, actor: TechnologyActor): number {
  // V23 (`quimica.emergente`): a hard and tough carried compound (smelted iron-rich, vitreous silica) is a
  // blade on its own: up to 30 % less hunt work, combined with the tools' reduction (at most 50 % in total).
  const chem = chemistryWorld(host) ? compoundHuntBonus(actorCompounds(actor)) * 0.3 : 0;
  if (!toolEffectsEnabled(host)) return chem > 0 ? 1 - chem : 1;
  const powers = itemCapacities(actor.technology.items);
  const tools = Math.min(0.32, toolPower(powers.cutting) * 0.2 + toolPower(powers.binding) * 0.16);
  return chem > 0 ? 1 - Math.min(0.5, tools + chem) : 1 - tools;
}
/** Tras una caza que rindió `foodGained` con el trabajo acortado por `huntingWorkFactor`: desgasta la mejor
 * herramienta de corte y la de atar (demanda 0,8) y anota a cada una su parte del rendimiento. */
export function consumeHuntingTools(host: TechnologyHost, actor: TechnologyActor, foodGained: number): void {
  if (!toolEffectsEnabled(host) || !Number.isFinite(foodGained) || foodGained <= 0) return;
  for (const [capability, share] of [['cutting', 0.2], ['binding', 0.16]] as const) {
    const receipt = useTool(host, actor, capability, 0.8);
    if (receipt) recordTechnologyBenefit(host, actor, receipt, foodGained * receipt.power * share);
  }
}
/** Fracción del trabajo de obra que queda con ataduras (`binding`), carpintería (`cutting`) y cantería
 * (`abrasion`): 1 sin la ley o sin herramientas; como mucho un 35 % menos. Sólo lectura. */
export function constructionWorkFactor(host: TechnologyHost, actor: TechnologyActor): number {
  if (!toolEffectsEnabled(host)) return 1;
  const powers = itemCapacities(actor.technology.items);
  return 1 - Math.min(0.35, toolPower(powers.binding) * 0.16 + toolPower(powers.cutting) * 0.12 + toolPower(powers.abrasion) * 0.12);
}
/** Tras una obra que ahorró `workSaved` unidades de trabajo gracias a `constructionWorkFactor`: desgasta la
 * mejor herramienta de atar, cortar y desbastar (demanda 0,7). Sin ahorro real no hay uso ni beneficio. */
export function consumeConstructionTools(host: TechnologyHost, actor: TechnologyActor, workSaved: number): void {
  if (!toolEffectsEnabled(host) || !Number.isFinite(workSaved) || workSaved <= 0) return;
  for (const capability of ['binding', 'cutting', 'abrasion'] as const) {
    const receipt = useTool(host, actor, capability, 0.7);
    recordTechnologyBenefit(host, actor, receipt, techParams(host).obrasPorPropiedades ? workSaved * 0.01 : Math.max(0.05, workSaved * 0.01));
  }
}
/** Tras una exposición cuyo daño corporal evitado por el abrigo portátil (`portableInsulationPower`) se
 * midió contra el mismo cuerpo sin él: desgasta la capa (demanda 0,5) y anota ese daño evitado. */
export function consumeInsulationTools(host: TechnologyHost, actor: TechnologyActor, avoidedDamage: number): void {
  if (!toolEffectsEnabled(host) || !Number.isFinite(avoidedDamage) || avoidedDamage <= 0) return;
  recordTechnologyBenefit(host, actor, useTool(host, actor, 'insulation', 0.5), avoidedDamage);
}
function randomInstruction(random: () => number): OperationInstruction {
  const op = PHYSICAL_OPERATIONS[Math.floor(random() * PHYSICAL_OPERATIONS.length)]!, instruction: OperationInstruction = { op, intensity: 1 + Math.floor(random() * 4) };
  if (op === 'form') instruction.shape = SHAPES[Math.floor(random() * SHAPES.length)]!;
  if (op === 'separate') instruction.material = MATERIALS[Math.floor(random() * MATERIALS.length)]!;
  if (op === 'abrade' && random() < 0.5) instruction.catalyst = 'abrasion';
  if (op === 'combine' && random() < 0.5) instruction.catalyst = 'binding';
  return instruction;
}
function isObviousNoOp(step: OperationInstruction, priorSteps: readonly OperationInstruction[], inputs: readonly MaterialRequirement[]): boolean {
  if (step.op === 'cool' && !priorSteps.some(prior => prior.op === 'heat')) return true;
  if (step.op === 'separate' && inputs.length === 1 && inputs[0]!.source === 'raw' && !priorSteps.some(prior => prior.op === 'combine')) return true;
  const previous = priorSteps[priorSteps.length - 1];
  if (previous && previous.op === step.op && previous.shape === step.shape && previous.material === step.material) return true;
  return false;
}
function nextInstruction(random: () => number, evitarNoOp: boolean, priorSteps: readonly OperationInstruction[], inputs: readonly MaterialRequirement[]): OperationInstruction {
  let instruction = randomInstruction(random);
  if (!evitarNoOp) return instruction;
  for (let retry = 0; retry < 4 && isObviousNoOp(instruction, priorSteps, inputs); retry++) instruction = randomInstruction(random);
  return instruction;
}
function localInputs(host: TechnologyHost, actor: TechnologyActor): MaterialRequirement[] {
  const result: MaterialRequirement[] = [], { dosisCuanto } = techParams(host);
  const availableRaw = availableRawMaterials(host, actor);
  for (const material of ['wood', 'stone'] as const) if (availableRaw[material] >= 1) result.push({ source: 'raw', material, mass: MASS_UNIT });
  const minResidue = dosisCuanto > 0 ? Math.max(150, dosisCuanto) : 150;
  for (const material of MATERIALS) {
    const available = actor.technology.residue[material];
    if (available >= minResidue) {
      const dose = dosisCuanto > 0 ? Math.min(1000, Math.floor(available / dosisCuanto) * dosisCuanto) : Math.min(1000, available);
      result.push({ source: 'residue', material, mass: dose });
    }
  }
  const minProduct = dosisCuanto > 0 ? Math.max(200, dosisCuanto) : 200;
  for (const item of actor.technology.items) {
    if (item.recipeId && item.mass >= minProduct && actor.technology.knownRecipes.includes(item.recipeId)) {
      const dose = dosisCuanto > 0 ? Math.min(1000, Math.floor(item.mass / dosisCuanto) * dosisCuanto) : Math.min(item.mass, 1000);
      result.push({ source: 'product', recipeId: item.recipeId, mass: dose });
    }
  }
  const tile = (host.tiles ? firstTileAt(host.tiles, Math.round(actor.x), Math.round(actor.y)) : undefined);
  if ((tile?.drinkingWater ?? 0) >= 0.01) result.push({ source: 'raw', material: 'water', mass: 500 });
  return result;
}
/** Search only draws from the actor's own learned programs and physically present feedstock. */
export function proposeTechnologyProgram(host: TechnologyHost, actor: TechnologyActor): { program: TechnologyProgram; parents: string[] } | undefined {
  const state = host.technology, random = localRandom(host.seed, `process:${actor.id}:${actor.technology.attempts}`), available = localInputs(host, actor);
  if (!available.length || !inventionRoom(state)) return;
  const { evitarNoOp } = techParams(host);
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
    if (mutation === 0 && program.steps.length < state.budgets.maxSteps) program.steps.push(nextInstruction(random, evitarNoOp, program.steps, program.inputs));
    else if (mutation === 1) {
      const index = Math.floor(random() * program.steps.length);
      program.steps[index] = nextInstruction(random, evitarNoOp, program.steps.slice(0, index), program.inputs);
    }
    else if (mutation === 2) program.steps[Math.floor(random() * program.steps.length)]!.intensity = 1 + Math.floor(random() * 4);
    else program.inputs = [structuredClone(pick(available))];
    // An existing product can replace a raw substrate; the input's physical properties survive.
    const products = available.filter(i => i.source === 'product');
    if (products.length && random() < 0.55) program.inputs[0] = structuredClone(pick(products));
    if (!planWithdrawal(host, actor, program)) program.inputs = [structuredClone(pick(available))];
  } else {
    const firstInput = structuredClone(pick(available)), count = 1 + Math.floor(random() * 3), steps: OperationInstruction[] = [];
    for (let i = 0; i < count; i++) steps.push(nextInstruction(random, evitarNoOp, steps, [firstInput]));
    program = { inputs: [firstInput], steps };
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
/** A forecast has no receipts, practice, catalogue writes or public stocks. All
 * substrates and catalyst wear still pass through the execution's physical laws. */
function forecastCraft(host: TechnologyHost, actor: TechnologyActor, recipe: TechnologyRecipe): MaterialBatch | undefined {
  const plan = planWithdrawal(host, actor, recipe.program);
  if (!plan) return;
  withdraw(host, actor, plan);
  let current = plan.inputs;
  for (const step of recipe.program.steps) {
    const capability = step.requiredCatalyst ?? step.catalyst, tool = capability ? bestTool(actor, capability) : undefined;
    const impulse = tool ? spendToolMaterial(actor, tool, step.intensity * 0.4).power : 0;
    actor.technology.items = actor.technology.items.filter(item => item.mass > 0);
    const result = applyPhysicalOperation(step, current, impulse);
    add(actor.technology.residue, result.residue);
    if (!result.success || !result.product) return;
    current = [result.product];
  }
  // Do not plan a chain that depends on silently recycling another needed tool.
  if (actor.technology.items.length >= host.technology.budgets.maxItems) return;
  const product = current[0]!;
  product.id = `product-${++host.technology.itemCounter}`; product.recipeId = recipe.id;
  actor.technology.items.push(product);
  return product;
}
function localTechnologyUses(host: TechnologyHost, actor: TechnologyActor): Capability[] {
  const tile = (host.tiles ? firstTileAt(host.tiles, Math.round(actor.x), Math.round(actor.y)) : undefined);
  if (!tile) return [];
  const uses: Capability[] = [];
  if ((tile.wood ?? 0) > 1 && actor.materials.wood < 11) uses.push('cutting');
  if ((tile.stone ?? 0) > 1 && actor.materials.stone < 7) uses.push('abrasion');
  if (actor.materials.wood >= 1 && tile.terrain !== 'shelter' && (tile.moisture ?? 0) > 0.2
    && (tile.vegetation ?? 1) < 0.9 && (tile.cultivation ?? 0) < 0.9) uses.push('cultivation');
  if (host.technology.water && (tile.drinkingWater ?? 0) > 0) uses.push('storage');
  if (techParams(host).efectosHerramientas) addToolEffectUses(uses, tile, actor, host.weather === 'rain');
  return uses;
}
/** V16 (`tecnologia.efectosHerramientas`): usos que aquí tienen las capacidades sin efecto histórico. Puro:
 * la tesela ya leída, el cuerpo y el tiempo del paso. Abrigo a la intemperie, con lluvia o sin capa propia;
 * ataduras, lazos y trampas con materia que atar o una presa; corte para cazar o construir; desbaste para
 * construir (la obra más ligera, un armazón, pide 2 maderas y 1 piedra). */
function addToolEffectUses(uses: Capability[], tile: { terrain?: string; fauna?: number }, actor: TechnologyActor, rain: boolean): void {
  const prey = (tile.fauna ?? 0) >= 1, canBuild = actor.materials.wood >= 2 && actor.materials.stone >= 1;
  const add = (capability: Capability) => { if (!uses.includes(capability)) uses.push(capability); };
  if (rain || tile.terrain !== 'shelter' || portableInsulationPower(actor) === 0) add('insulation');
  if (prey || actor.materials.wood >= 1 || actor.materials.stone >= 1) add('binding');
  if (prey || canBuild) add('cutting');
  if (canBuild) add('abrasion');
}
/** Clona los objetos de un actor para pronosticar fabricación sin `structuredClone` ni agua contenida. */
function cloneItemsForForecast(items: readonly MaterialBatch[]): MaterialBatch[] {
  const copy = new Array<MaterialBatch>(items.length);
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    copy[i] = {
      id: item.id, recipeId: item.recipeId,
      composition: { wood: item.composition.wood, stone: item.composition.stone, water: item.composition.water },
      mass: item.mass, properties: { ...item.properties },
      generation: item.generation, madeAt: item.madeAt,
      parentItems: [...item.parentItems], initialMass: item.initialMass,
    };
  }
  return copy;
}
/** Follow only locally remembered product dependencies, with at most one memory's
 * worth of fabrication steps per forecast. No alternative-program search or
 * unbounded quantity expansion; the next decision recomputes from actual stock. */
function dependencyCraft(host: TechnologyHost, actor: TechnologyActor, known: TechnologyRecipe[], powers: Record<Capability, number>): TechnologyRecipe | undefined {
  if (!known.some(recipe => recipe.program.inputs.some(input => input.source === 'product'))) return;
  const uses = localTechnologyUses(host, actor), byId = new Map(known.map(recipe => [recipe.id, recipe])), effects = techParams(host).efectosHerramientas;
  const improves = (capacities: Record<Capability, number>, capabilities: Capability[]) => capabilities.some(c => capacities[c] > Math.max(0.12, powers[c] * 1.35));
  const tile = (host.tiles ? firstTileAt(host.tiles, Math.round(actor.x), Math.round(actor.y)) : undefined);
  for (const goal of known) {
    if (!goal.program.inputs.some(input => input.source === 'product') || !improves(goal.capacities, uses)) continue;
    let reachableGoal = true;
    for (const input of goal.program.inputs) {
      if (input.source !== 'product' || byId.has(input.recipeId!)) continue;
      let held = 0;
      for (const item of actor.technology.items) if (item.recipeId === input.recipeId) held += item.mass;
      if (held < input.mass) { reachableGoal = false; break; }
    }
    if (!reachableGoal) continue;
    const privateActor: TechnologyActor = { ...actor, materials: { ...actor.materials }, technology: {
      ...actor.technology, residue: { ...actor.technology.residue }, items: cloneItemsForForecast(actor.technology.items),
    } };
    const privateHost: TechnologyHost = { seed: host.seed, tick: host.tick, people: [privateActor], tiles: tile ? [{ ...tile }] : [],
      technology: { ...defaultTechnologyState(), budgets: host.technology.budgets, itemCounter: host.technology.itemCounter } };
    const route: TechnologyRecipe[] = [], visiting = new Set<string>();
    let remaining = known.length, work = 0;
    const produce = (recipe: TechnologyRecipe): MaterialBatch | undefined => {
      if (remaining-- <= 0 || visiting.has(recipe.id)) return;
      visiting.add(recipe.id);
      const demands = new Map<string, number>();
      for (const input of recipe.program.inputs) if (input.source === 'product') demands.set(input.recipeId!, (demands.get(input.recipeId!) ?? 0) + input.mass);
      for (const [id, required] of demands) {
        const stock = () => privateActor.technology.items.reduce((n, item) => n + (item.recipeId === id ? item.mass : 0), 0);
        while (stock() < required) {
          const dependency = byId.get(id), before = stock();
          if (!dependency || !produce(dependency) || stock() <= before) return;
        }
      }
      const output = forecastCraft(privateHost, privateActor, recipe);
      if (!output) return;
      work += technologyWorkCost(recipe.program); route.push(recipe); visiting.delete(recipe.id);
      return output;
    };
    const output = produce(goal);
    if (!output || actor.energy - work * 0.00045 < 0.3 || actor.fatigue + work * 0.00032 > 0.72) continue;
    // The end product, not a remembered historical capacity, must improve an
    // available use after paying the whole chain, including its future farm wood.
    const finalUses = localTechnologyUses({ ...privateHost, technology: host.technology }, privateActor)
      .filter(capability => capability !== 'storage' || containerAffordance(output).capacityQuanta > 0);
    // The private host carries no laws; the forecast runs under the real host's.
    if (effects && tile) addToolEffectUses(finalUses, tile, privateActor, host.weather === 'rain');
    if (improves(materialCapacities(output), finalUses)) return route[0];
  }
  return;
}
export function technologyOpportunity(host: TechnologyHost, actor: TechnologyActor): { kind: 'research' | 'craft'; score: number; reason: string; recipeId?: string } | undefined {
  if (actor.energy < 0.3 || actor.fatigue > 0.72 || Math.max(actor.hunger ?? 0, actor.thirst ?? 0) > 0.78) return;
  const v23 = ctxTecnica(host);
  if (v23) return esPersonaV23(actor) ? oportunidadTecnica(v23, actor) : undefined;
  if (actor.technology.project) return { kind: actor.technology.project.kind, score: 0.86, reason: 'Continúa un proceso material que ya empezó y pagó.', recipeId: actor.technology.project.recipeId ?? undefined };
  const powers = toolCapacities(actor), known = knownTechnologyRecipes(host, actor, false).sort((a, b) => (actor.technology.competence[b.id]?.benefit ?? 0) - (actor.technology.competence[a.id]?.benefit ?? 0) || (actor.technology.competence[b.id]?.successes ?? 0) - (actor.technology.competence[a.id]?.successes ?? 0) || a.id.localeCompare(b.id));
  // A justified chain can continue its paid work without the cadence used to
  // space speculative research and unrelated replacement crafts.
  const dependency = dependencyCraft(host, actor, known, powers);
  if (dependency) return { kind: 'craft', recipeId: dependency.id, score: 0.58, reason: 'Reproduce un paso conocido de una cadena material que mejora un uso disponible aquí; cada paso exige sus propios insumos y trabajo.' };
  const tech = techParams(host);
  if (host.tick - actor.technology.lastAttempt < tech.enfriamiento) return;
  const stabilized = tech.mejoraLocal > 0 || tech.enfriamiento > 45;
  const craft = known.find(r => CAPABILITIES.some(c => r.capacities[c] > Math.max(0.12, powers[c] * 1.35)) && planWithdrawal(host, actor, r.program));
  if (craft && actor.technology.items.length < host.technology.budgets.maxItems && (stabilized || actor.technology.attempts % 3 !== 0)) return { kind: 'craft', recipeId: craft.id, score: 0.58, reason: 'Puede reproducir una técnica aprendida para recuperar una capacidad material.' };
  if (host.noveltyEnabled === false || !inventionRoom(host.technology) || !localInputs(host, actor).length) return;
  let score = 0.35 + (actor.curiosity ?? 0.5) * 0.3 + (actor.skills.technology ?? 0) * 0.08;
  if (stabilized && actor.technology.items.length >= host.technology.budgets.maxItems && Math.max(...Object.values(powers)) >= 0.4) score *= 0.35;
  return { kind: 'research', score, reason: 'Prueba una variación o composición de procesos conocidos con materiales presentes; el intento cuesta trabajo y recursos.' };
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
/** Puerta local de descubrimiento (`tecnologia.mejoraLocal > 0`). Un ensayo pagado sólo gana instrucciones
 * si su producto hace algo: nunca un lote inerte (ninguna capacidad ≥ 0,12), y además, o una novedad
 * funcional genuina (`isGenuineFunctionalNovelty`, tolerancia = `mejoraLocal`) frente a lo que el actor
 * sabe y a la ventana residente de recetas calientes, o la misma función que sus padres por estrictamente
 * menos trabajo (Pareto). La rejilla de 6⁶ casillas de `hasTechnologyFunction` ya no basta: aceptaba
 * microvariantes que sólo cambiaban de casilla y lotes casi inertes (V15: 27 969 recetas, 40 % sin uso). */
function locallyUsefulDiscovery(host: TechnologyHost, actor: TechnologyActor, project: TechnologyProject, parents: readonly TechnologyRecipe[],
  capacities: Record<Capability, number>, signature: string, generation: number, tolerance: number): boolean {
  if (Math.max(...CAPABILITIES.map(c => capacities[c])) < 0.12) return false;
  if (parents.length && technologyWorkCost(project.program) < Math.min(...parents.map(p => technologyWorkCost(p.program)))
    && CAPABILITIES.every(c => capacities[c] >= Math.max(...parents.map(p => p.capacities[c])) - 1e-9)) return true;
  // Known instructions resolve without touching the resident LRU; the window is read as it stands.
  const compared = new Map<string, TechnologyRecipe>();
  for (const recipe of knownTechnologyRecipes(host, actor, false)) compared.set(recipe.id, recipe);
  if (techParams(host).obrasPorPropiedades) {
    // Seeing an artifact permits a physical comparison, never grants its instructions.
    for (const other of host.people) if (other === actor || distance(actor, other) <= 5) for (const item of other.technology.items) {
      if (!item.recipeId || compared.has(item.recipeId)) continue;
      const recipe = resolveTechnologyRecipe(host, item.recipeId, { cache: false });
      if (recipe) compared.set(recipe.id, { ...recipe, capacities: materialCapacities(item) });
    }
    for (const structure of host.structures ?? []) if (distance(actor, structure) <= 5) for (const item of structure.installed ?? []) {
      if (!item.recipeId || compared.has(item.recipeId)) continue;
      const recipe = resolveTechnologyRecipe(host, item.recipeId, { cache: false });
      if (recipe) compared.set(recipe.id, { ...recipe, capacities: { cutting: 0, storage: item.containment * item.condition,
        insulation: item.insulation * item.condition, cultivation: 0, binding: item.binding * item.condition, abrasion: 0 } });
    }
  } else for (const recipe of host.technology.recipes) if (!compared.has(recipe.id)) compared.set(recipe.id, recipe);
  const candidate: TechnologyRecipe = { id: `recipe-${host.technology.recipeCounter + 1}`, name: '', program: project.program, signature,
    parents: [...project.parents], generation, inventorId: actor.id, tick: host.tick, x: actor.x, y: actor.y, novelty: 'program', capacities,
    uses: 0, utility: 0, manufactured: 0 };
  return isGenuineFunctionalNovelty(candidate, [...compared.values()], tolerance);
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
  const propertyDiscovery = techParams(host).obrasPorPropiedades && project.kind === 'research';
  const locallyAccepted = !propertyDiscovery || !output || locallyUsefulDiscovery(host, actor, project, parentRecipes as TechnologyRecipe[],
    materialCapacities(output), signature, nextGeneration, techParams(host).mejoraLocal || 0.05);
  // An interned remote program is reusable only after this paid local experiment qualifies.
  if (!locallyAccepted) recipe = undefined;
  if (success && output) {
    if (!recipe && locallyAccepted && inventionRoom(state)) {
      const capacities = materialCapacities(output), newFunction = !hasTechnologyFunction(host, capacities);
      const { mejoraLocal } = techParams(host);
      const accepted = propertyDiscovery ? locallyAccepted : mejoraLocal > 0
        ? locallyUsefulDiscovery(host, actor, project, parentRecipes as TechnologyRecipe[], capacities, signature, nextGeneration, mejoraLocal)
        : true;
      if (accepted) {
        recipe = { id: `recipe-${state.recipeCounter + 1}`, name: `${project.program.steps.map(s => s.op).join('·').slice(0, 70)} ${state.recipeCounter + 1}`,
          program: structuredClone(project.program), signature, parents: [...project.parents], generation: nextGeneration, inventorId: actor.id, tick: host.tick, x: actor.x, y: actor.y,
          novelty: newFunction ? 'both' : 'program', capacities, uses: 0, utility: 0, manufactured: 0 };
        registerTechnologyRecipe(host, recipe); emitDiscovery(host, actor, recipe, emit);
      }
    }
    if (recipe) {
      recycleToFit(host, actor);
      output.id = `product-${++state.itemCounter}`; output.recipeId = recipe.id; output.madeAt = host.tick; output.generation = recipe.generation;
      output.parentItems = [...new Set(plan.inputs.filter(i => i.recipeId).flatMap(i => i.parentItems.length ? i.parentItems : [i.id]))].slice(0, 16);
      knowledge.items.push(output);
      // V23: a carried useful compound lot is forged into the product (conserved debit, real tint/provenance).
      if (chemistryWorld(host)) forgeWithCompound(output, actorCompounds(actor));
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
  const factor = workshopWorkFactor(host, actor);
  if (synergyWorld(host)) project.requiredWork = Math.ceil(technologyWorkCost(project.program) * factor);
  project.progress++;
  project.energyPaid += energy; host.technology.ledger.work++; host.technology.ledger.energy += energy;
  return project.progress >= project.requiredWork ? finishProject(host, actor, project, emit) : false;
}
export function researchTechnology(host: TechnologyHost, actor: TechnologyActor, emit?: Emit): boolean {
  const v23 = ctxTecnica(host);
  if (v23) return esPersonaV23(actor) && host.noveltyEnabled !== false && trabajarTecnica(v23, actor, 'research');
  return advanceProject(host, actor, 'research', undefined, emit);
}
/** Explicitly abandoning a paid project preserves its spent work, without manufacturing or refunding matter. */
export function cancelTechnologyProject(host: TechnologyHost, actor: TechnologyActor): boolean {
  const v23 = ctxTecnica(host);
  if (v23) {
    const t = esPersonaV23(actor) ? actor.technology.tecnica : undefined;
    if (!t?.proceso) return false;
    interrumpir(actor as Person, t, host.tick, v23);
    return true;
  }
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
  const v23 = ctxTecnica(host);
  if (v23) {
    if (!esPersonaV23(actor)) return false;
    const t = tecnicaDe(actor);
    const id = recipeId !== undefined ? Number(recipeId)
      : t.proceso?.tipo === 'craft' ? t.proceso.receta : [...t.recetas].sort((a, b) => b.usada - a.usada || a.id - b.id)[0]?.id;
    return id !== undefined && Number.isSafeInteger(id) && trabajarTecnica(v23, actor, 'craft', id);
  }
  const selected = recipeId ?? actor.technology.project?.recipeId ?? knownTechnologyRecipes(host, actor)
    .filter(r => planWithdrawal(host, actor, r.program))
    .sort((a, b) => (actor.technology.competence[b.id]?.benefit ?? 0) - (actor.technology.competence[a.id]?.benefit ?? 0) || (actor.technology.competence[b.id]?.successes ?? 0) - (actor.technology.competence[a.id]?.successes ?? 0) || a.id.localeCompare(b.id))[0]?.id;
  return advanceProject(host, actor, 'craft', selected, emit);
}
export function shareTechnology(host: TechnologyHost, teacher: TechnologyActor, learner: TechnologyActor, emit?: Emit, recipeId?: string): boolean {
  if (host.cooperationEnabled === false || host.learningEnabled === false || teacher === learner || teacher.id === learner.id || distance(teacher, learner) > 2 || teacher.energy < 0.05) return false;
  const v23 = ctxTecnica(host);
  if (v23) {
    const aprendiz = learner as Person;
    if (!esPersonaV23(teacher) || aprendiz.uid === undefined) return false;
    const r = recetaParaEnsenar(v23, teacher, aprendiz, recipeId !== undefined ? Number(recipeId) : undefined);
    if (!r || !ensenarTecnica(v23, teacher, aprendiz.uid, r.id, aprendiz)) return false;
    v23.suceso({ kind: 'learning', actors: [teacher.id, learner.id], x: teacher.x, y: teacher.y, source: 'simulation',
      text: `${teacher.name ?? teacher.id} mostró a ${learner.name ?? learner.id} cómo hacer un proceso que practica.`,
      cause: 'Transmisión por demostración cercana: quien enseña paga el trabajo y su receta vuelve a estar fresca; quien aprende la recuerda hasta que la olvide.' });
    return true;
  }
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
  if (host.cooperationEnabled === false || from.id === to.id || !isHostMember(host.people, from) || !isHostMember(host.people, to) || distance(from, to) > 2 || to.technology.items.length >= host.technology.budgets.maxItems) return false;
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

/** Transfer a manufactured lot from portable stock into a local fixed asset.
 * estateLoss is the existing external-stock boundary (not destruction): retain the exact
 * composition on the structure and emit an explicit export receipt, so old checkpoint and
 * estate replay keep closing without inventing an immortal inventory owner. */
export function installTechnologyItem(host: TechnologyHost, actor: TechnologyActor, structure: StructureView): boolean {
  if (!techParams(host).obrasPorPropiedades || !host.structures?.includes(structure) || !isHostMember(host.people, actor)
    || distance(actor, structure) > 1.5 || (structure.installed?.length ?? 0) >= 4) return false;
  const item = actor.technology.items.find(i => {
    if (!i.recipeId || i.mass <= 0) return false;
    const c = materialCapacities(i);
    return c.binding > 0.15 || c.insulation > 0.15 || (c.storage > 0.15 && (structure.components.includes('cistern') || structure.components.includes('granary')));
  });
  if (!item) return false;
  const opening = technologyStock(actor), waterOpening = containedWaterStock(actor), capabilities = materialCapacities(item);
  const lost = settleContainedWaterCapacity(host, item, true);
  actor.technology.items.splice(actor.technology.items.indexOf(item), 1);
  (structure.installed ??= []).push({ id: item.id, recipeId: item.recipeId, mass: item.mass,
    composition: { ...item.composition }, containment: item.properties.containment, insulation: item.properties.insulation,
    cohesion: item.properties.cohesion, binding: capabilities.binding, condition: Math.min(1, item.mass / item.initialMass) });
  // V23: a compound-forged asset carries its real chemical tint and properties into the building's material profile.
  if (chemistryWorld(host) && item.materialTint) {
    const profile = blendForgedProfile(structure.materialProfile, item);
    if (profile) structure.materialProfile = profile;
  }
  add(host.technology.ledger.estateLoss, item.composition);
  const resources = [{ resourceId: itemResource(item), mass: item.mass }];
  const water = waterEnvelope(actor, waterOpening, 'spill', lost ? { lost } : {});
  appendExecution(host, { kind: 'estate', actorId: actor.id, recipeId: item.recipeId,
    programSignature: '', inputs: resources, outputs: [], residueMass: 0, energy: 0, work: 0, success: true,
    parentRecipeIds: [], catalysts: [], benefit: 0, ...(water ? { water } : {}),
    balance: { opening, closing: technologyStock(actor), externalInputs: [], externalLoss: resources } });
  maintainTechnologyMemory(host, actor);
  return true;
}

function fixedTechnologyAssets(host: TechnologyHost): NonNullable<StructureView['installed']> {
  return [...(host.structures ?? []), ...(host.retiredChunks ?? []).flatMap(c => c.structures ?? [])].flatMap(s => s.installed ?? []);
}
/** Death settles a physical estate before its owner is removed from the active population.
 * Local transfers move the existing objects; unclaimed material exits the technology model
 * at that location and is explicitly accounted as loss, never invented ecological food. */
export function settleTechnologyEstate(host: TechnologyHost, actor: TechnologyActor, recipients: TechnologyActor[] = []): { transfers: { to: string; items: string[]; mass: number }[]; lost: Composition; executionIds: string[] } {
  if (actor.technology.waterPreparation !== undefined) actor.technology.waterPreparation = undefined;
  const result = { transfers: [] as { to: string; items: string[]; mass: number }[], lost: empty(), executionIds: [] as string[] };
  const nearby = recipients.filter((p, index) => p !== actor && p.id !== actor.id && recipients.indexOf(p) === index && isHostMember(host.people, p) && distance(actor, p) <= 2).sort((a, b) => distance(actor, a) - distance(actor, b) || a.id.localeCompare(b.id));
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
/** A projection is drawn, not computed on: thousandths are what a meter can show and what the wire can pay. */
function viewCapacities(values: Record<Capability, number>): Record<Capability, number> {
  const out = {} as Record<Capability, number>;
  for (const capability of CAPABILITIES) out[capability] = Math.round(values[capability] * 1000) / 1000;
  return out;
}
export function projectTechnology(host: TechnologyHost, itemOwners: readonly TechnologyActor[] = host.people): TechnologyView {
  const state = host.technology, all = host.people.flatMap(p => p.technology.items), composition = sum(all.map(i => i.composition)), residue = sum(host.people.map(p => p.technology.residue));
  const importedMass = mass(state.ledger.imported), productMass = mass(composition), residueMass = mass(residue), totals = technologyCatalogueTotals(host);
  const installedMass = fixedTechnologyAssets(host).reduce((n, item) => n + item.mass, 0);
  /** T036(h): el repertorio de cada actor (≈13 KiB) ya no viaja en cada `state`: el inspector lo pide
   * por habitante con `{type:'persona'}`. FR-026: `items` se recorta al mismo viewport que `people`. */
  return { recipes: state.recipes.map(recipe => ({ id: recipe.id, name: recipe.name, generation: recipe.generation, capacities: viewCapacities(recipe.capacities) })),
    items: itemOwners.flatMap(p => p.technology.items.map(i => {
    const affordance = state.water ? containerAffordance(i) : undefined;
    return { id: i.id, ownerId: p.id, x: p.x, y: p.y, recipeId: i.recipeId, mass: i.mass, generation: i.generation, capacities: viewCapacities(materialCapacities(i)),
      ...(affordance ? { water: { version: 1 as const, quanta: i.contents?.water ?? 0, capacityQuanta: affordance.capacityQuanta,
        leakageNumerator: affordance.leakageNumerator } } : {}),
      ...(i.materialTint ? { materialTint: i.materialTint } : {}), ...(i.chemFormulaId ? { chemFormulaId: i.chemFormulaId } : {}),
      ...(i.chemPhase ? { chemPhase: i.chemPhase } : {}) };
  })),
    dynamics: { attempts: state.ledger.attempts, failures: state.ledger.failures, recipes: totals.recipes, products: all.length, generations: totals.maxGeneration,
      toolUses: state.ledger.toolUses, observedUtility: totals.utility, shared: state.ledger.shared,
      importedMass, productMass: productMass + installedMass, residueMass, massError: importedMass - productMass - residueMass - state.ledger.fuelMass - mass(state.ledger.estateLoss), estateLostMass: mass(state.ledger.estateLoss) - installedMass,
      work: state.ledger.work, energy: state.ledger.energy, programDiversity: totals.recipes,
      functionalDiversity: totals.functionalDiversity,
      reusedProducts: state.history.filter(e => ['research', 'craft'].includes(e.kind) && e.inputs.some(i => i.resourceId.startsWith('recipe:'))).length, historyDropped: state.historyDropped }, budgets: { ...state.budgets } };
}
/** One definition on demand, read-only: the resident cache is not extended by a reader's curiosity.
 * `undefined` means «this host cannot serve that program now», never «the procedure has no steps». */
export function technologyRecipeDetail(host: TechnologyHost, id: string): TechnologyRecipe | undefined {
  if (typeof id !== 'string' || !/^recipe-[1-9]\d{0,9}$/.test(id)) return undefined;
  try { return resolveTechnologyRecipe(host, id, { cache: false }); } catch { return undefined; }
}

export interface TechnologyTransactionRenumbering { executions: readonly TechnologyExecution[]; firstSerial: number; }

/**
 * T146: renumera transacciones completas en bloque —`id`, `nestedExecutionIds` y
 * `catalysts[].executionId`— y reordena `history`/`journal.pending` por el serial
 * nuevo, preservando `serial === previousSerial + 1`. Una referencia anidada o de
 * catalizador fuera de su propio bloque lanza: pertenece a otra transacción.
 * Las ejecuciones de un bloque que aún no estén en `history` se incorporan (y a
 * `journal.pending` si hay diario) antes de ordenar; `executionCounter` pasa a
 * ser `historyDropped + history.length`. No se llama en el camino por defecto.
 */
export function renumberTechnologyTransactionBlocks(state: TechnologyState, blocks: readonly TechnologyTransactionRenumbering[]): void {
  for (const block of blocks) {
    if (!block || !Array.isArray(block.executions)) throw new TypeError('Renumeración de tecnología: bloque sin ejecuciones.');
    const map = renumberTechnologyExecutionBlock(block.executions, block.firstSerial);
    const remap = (id: string): string => {
      const serial = technologyExecutionSerial(id), next = serial === null ? undefined : map.get(serial);
      if (next === undefined) throw new Error('Renumeración de tecnología: referencia a una ejecución fuera de su transacción.');
      return `process-${next}`;
    };
    for (const execution of block.executions) {
      if (execution.nestedExecutionIds !== undefined) execution.nestedExecutionIds = execution.nestedExecutionIds.map(remap);
      for (const catalyst of execution.catalysts) catalyst.executionId = remap(catalyst.executionId);
    }
    for (const execution of block.executions) {
      if (!state.history.includes(execution)) state.history.push(execution);
      if (state.journal && (technologyExecutionSerial(execution.id) ?? 0) > state.journal.committedThrough
        && !state.journal.pending.includes(execution)) state.journal.pending.push(execution);
    }
  }
  const bySerial = (a: TechnologyExecution, b: TechnologyExecution) => (technologyExecutionSerial(a.id) ?? 0) - (technologyExecutionSerial(b.id) ?? 0);
  state.history.sort(bySerial);
  if (state.journal) state.journal.pending.sort(bySerial);
  state.executionCounter = state.historyDropped + state.history.length;
  if (state.journal) assertTechnologyJournal(state, Number.MAX_SAFE_INTEGER);
}

export function assertTechnology(host: TechnologyHost): void {
  const fail = () => { throw new Error('Estado de tecnología física inválido.'); };
  const finite = (n: unknown, max = Number.MAX_SAFE_INTEGER): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max;
  const integer = (n: unknown, max = Number.MAX_SAFE_INTEGER): n is number => finite(n, max) && Number.isSafeInteger(n);
  const composition = (c: Composition) => c && MATERIALS.every(m => integer(c[m]));
  const state = host.technology;
  if (!state || state.version !== 1 || !state.budgets || !state.ledger || !composition(state.ledger.imported) || !composition(state.ledger.estateLoss)) fail();
  const v23 = paramsOf(host).v23, limitesHeredados = !v23.tecnica;
  const limits = defaultTechnologyState().budgets;
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) if (!integer(state.budgets[key], limitesHeredados ? limits[key] : Number.MAX_SAFE_INTEGER) || state.budgets[key] < 1) fail();
  if (!Array.isArray(state.recipes) || limitesHeredados && state.recipes.length > state.budgets.maxRecipes || !Array.isArray(state.history) || state.history.length > state.budgets.maxHistory) fail();
  for (const key of ['recipeCounter', 'itemCounter', 'executionCounter', 'historyDropped'] as const) if (!integer(state[key])) fail();
  if ((!catalogueEnabled(state) && state.recipeCounter !== state.recipes.length) || state.historyDropped + state.history.length !== state.executionCounter || state.ledger.attempts !== state.ledger.crafted + state.ledger.failures) fail();
  try { assertTechnologyCatalogueState(host); } catch { fail(); }
  assertTechnologyJournal(state, host.tick);
  for (const [key, value] of Object.entries(state.ledger)) if (!['imported', 'estateLoss'].includes(key) && !(key === 'energy' ? finite(value) : integer(value))) fail();
  const recipeIds = new Set<string>(), signatures = new Set<string>();
  const generationMax = limitesHeredados ? generationLimit(state) : Number.MAX_SAFE_INTEGER;
  const memoryMax = limitesHeredados ? technologyMemoryCapacity(state) : Infinity;
  const itemMax = limitesHeredados ? state.budgets.maxItems : Infinity;
  const getRecipe = (id: string, at = host.tick): TechnologyRecipe | undefined => {
    if (typeof id !== 'string' || !/^recipe-[1-9]\d*$/.test(id) || !integer(Number(id.slice(7)), state.recipeCounter)) return;
    const recipe = resolveTechnologyRecipe(host, id, { cache: false });
    return recipe && recipe.tick <= at ? recipe : undefined;
  };
  // Uncommitted definitions remain authoritative even after their display cache entry was evicted.
  const pendingRecipes = state.catalogue?.pending ?? [], pendingIds = new Set(pendingRecipes.map(recipe => recipe.id));
  for (const recipe of [...pendingRecipes, ...state.recipes.filter(recipe => !pendingIds.has(recipe.id))]) {
    if (!recipe || typeof recipe.id !== 'string' || !/^recipe-[1-9]\d*$/.test(recipe.id) || !integer(Number(recipe.id.slice(7)), state.recipeCounter) || recipeIds.has(recipe.id) || !validTechnologyProgram(recipe.program, state) || recipe.signature !== programSignature(recipe.program) || signatures.has(recipe.signature) || !integer(recipe.generation, generationMax) || recipe.generation < 1 || !integer(recipe.tick, host.tick) || !Array.isArray(recipe.parents) || recipe.parents.length > 6 || recipe.parents.some(id => !getRecipe(id, recipe.tick) || Number(id.slice(7)) >= Number(recipe.id.slice(7))) || !integer(recipe.uses) || !finite(recipe.utility) || !integer(recipe.manufactured) || !recipe.capacities || !CAPABILITIES.every(c => finite(recipe.capacities[c], 1))) fail();
    if (recipe.generation !== 1 + Math.max(0, ...recipe.parents.map(id => getRecipe(id, recipe.tick)!.generation))) fail();
    if (typeof recipe.name !== 'string' || recipe.name.length > 100 || typeof recipe.inventorId !== 'string' || recipe.inventorId.length > 100 || !Number.isFinite(recipe.x) || !Number.isFinite(recipe.y) || !['program', 'function', 'both'].includes(recipe.novelty) || new Set(recipe.parents).size !== recipe.parents.length || recipe.program.inputs.some(i => i.source === 'product' && (!getRecipe(i.recipeId!, recipe.tick) || !recipe.parents.includes(i.recipeId!)))) fail();
    recipeIds.add(recipe.id); signatures.add(recipe.signature);
  }
  const itemIds = new Set<string>(); let current = empty();
  for (const actor of host.people) {
    const knowledge = actor.technology;
    if (!knowledge || !Array.isArray(knowledge.items) || knowledge.items.length > itemMax || !Array.isArray(knowledge.knownRecipes) || knowledge.knownRecipes.length > memoryMax || new Set(knowledge.knownRecipes).size !== knowledge.knownRecipes.length || knowledge.knownRecipes.some(id => !getRecipe(id)) || !composition(knowledge.residue) || !integer(knowledge.attempts) || !Number.isSafeInteger(knowledge.lastAttempt) || knowledge.lastAttempt < -120 || knowledge.lastAttempt > host.tick || !Array.isArray(knowledge.learnedFrom) || knowledge.learnedFrom.length > memoryMax) fail();
    add(current, knowledge.residue);
    for (const learned of knowledge.learnedFrom) if (!getRecipe(learned.recipeId, learned.tick) || !knowledge.knownRecipes.includes(learned.recipeId) || !integer(learned.tick, host.tick) || typeof learned.teacherId !== 'string' || learned.teacherId === actor.id) fail();
    if (!knowledge.competence || typeof knowledge.competence !== 'object') fail();
    for (const [id, practice] of Object.entries(knowledge.competence)) if (!getRecipe(id) || !practice || !integer(practice.attempts) || !integer(practice.successes, practice.attempts) || !integer(practice.work) || !finite(practice.benefit)) fail();
    for (const item of knowledge.items) {
      if (!item || typeof item.id !== 'string' || !/^product-\d+$/.test(item.id) || Number(item.id.slice(8)) > state.itemCounter || itemIds.has(item.id) || !composition(item.composition) || item.mass !== mass(item.composition) || !integer(item.mass) || item.mass < 1 || !integer(item.initialMass) || item.initialMass < item.mass || !item.recipeId || !getRecipe(item.recipeId, item.madeAt) || !integer(item.madeAt, host.tick) || !integer(item.generation, generationMax) || item.generation !== getRecipe(item.recipeId, item.madeAt)?.generation || !item.properties || !Object.keys(rawProperties(empty())).every(k => finite(item.properties[k as keyof MaterialProperties], 1)) || !Array.isArray(item.parentItems) || item.parentItems.length > 16) fail();
      add(current, item.composition); itemIds.add(item.id);
    }
    const project = knowledge.project;
    const validWork = (p: TechnologyProject) => synergyWorld(host)
      ? integer(p.requiredWork, technologyWorkCost(p.program)) && p.requiredWork >= Math.ceil(technologyWorkCost(p.program) * 0.70)
      : p.requiredWork === technologyWorkCost(p.program);
    if (project !== null && (!project || !['research', 'craft'].includes(project.kind) || !validTechnologyProgram(project.program, state) || !integer(project.progress) || project.progress >= project.requiredWork || !validWork(project) || !integer(project.startedAt, host.tick) || !finite(project.energyPaid) || !Array.isArray(project.parents) || project.parents.length > 6 || new Set(project.parents).size !== project.parents.length || project.parents.some(id => !getRecipe(id, project.startedAt)) || (project.kind === 'research' && (project.recipeId !== null || project.parents.some(id => !knowledge.knownRecipes.includes(id)) || project.program.inputs.some(input => input.source === 'product' && !project.parents.includes(input.recipeId!)))) || (project.kind === 'craft' && (!knowledge.knownRecipes.includes(project.recipeId!) || getRecipe(project.recipeId!, project.startedAt)?.signature !== programSignature(project.program) || JSON.stringify(project.parents) !== JSON.stringify(getRecipe(project.recipeId!, project.startedAt)?.parents))))) fail();
  }
  // Exported fixed assets remain reserved identities and must be a subset of the
  // explicit external-stock ledger, including dormant chunks and dead installers.
  const fixed = empty();
  for (const item of fixedTechnologyAssets(host)) {
    if (!item || !/^product-[1-9]\d*$/.test(item.id) || !integer(Number(item.id.slice(8)), state.itemCounter)
      || itemIds.has(item.id) || !item.recipeId || !getRecipe(item.recipeId) || !item.composition || !composition(item.composition)
      || !integer(item.mass) || item.mass < 1 || item.mass !== mass(item.composition)
      || ![item.containment, item.insulation, item.cohesion, item.binding, item.condition].every(v => finite(v, 1))) fail();
    add(fixed, item.composition!); itemIds.add(item.id);
  }
  if (MATERIALS.some(m => fixed[m] > state.ledger.estateLoss[m])) fail();
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
  assertTechnologyCheckpoint(state, host.tick, v23);
}

// ── V23 (`v23.tecnica`): técnica sobre lotes ─────────────────────────────────────────────────────────────
// Una receta es una lista de `Paso` registrada en `c.globales.registro`; investigar y fabricar arrancan un proceso
// (`materia/proceso.ts`) y lo avanzan un tick por llamada. Sin tope de recetas, de pasos, de insumos ni de objetos:
// lo que se recuerda lo decide el olvido y lo que se lleva, la carga del cuerpo.

import { CARGA_MASA, CARGA_VOLUMEN, DENSIDAD_CUERPO, DURACION_PASO, PROB_VARIAR_CONOCIDA, PROB_CRUZAR } from '../shared/naturaleza.js';
export { CARGA_MASA, CARGA_VOLUMEN, DENSIDAD_CUERPO, DURACION_PASO, PROB_VARIAR_CONOCIDA, PROB_CRUZAR };

type PersonaTecnica = Person & { cuerpo: Cuerpo };
const esPersonaV23 = (a: TechnologyActor): a is PersonaTecnica => !!(a as Person).cuerpo;

/** El contexto de la técnica de lotes si la ley está encendida y el mundo pasó por el motor; si no, undefined. */
function ctxTecnica(host: object): CtxLeyMateria | undefined {
  if (!ley(host, 'tecnica')) return undefined;
  const c = ctxSi(host as World) as Partial<CtxLeyMateria> | undefined;
  return c?.materia && c.quimica ? c as CtxLeyMateria : undefined;
}

/** Estado técnico V23 de una persona. Lo crea `iniciar` para las que ya viven; para las que nacen después lo pone quien
 * las crea (pedido a n), y si aún falta se crea aquí. */
export function tecnicaDe(p: Person): TecnicaPersona { return p.technology.tecnica ??= nuevaTecnica(); }

const tauDe = (p: Person) => tauRecetaTicks(p.genome?.learningRate ?? 0);
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

/** F0 de la época: crea el estado técnico de las personas propias que no lo tienen. */
export function iniciarTecnica(c: CtxLeyMateria): void {
  for (const p of c.mundo.people) if (p.cuerpo) tecnicaDe(p);
}

/** F6: olvido de las personas propias (fuerza ← fuerza·e^(−Δt/τ), fuera por debajo de OLVIDO_RECETA). */
export function mantenerTecnica(c: CtxLeyMateria): void {
  for (const p of c.mundo.people) {
    const t = p.technology.tecnica;
    if (t && t.recetas.length) olvidarRecetas(t, c.tick, tauDe(p));
  }
}

/** F5: los pasos que solo esperan al mundo (calentar junto a un fuego, mojar) siguen aunque nadie trabaje en ellos;
 * quien está investigando o fabricando ya avanzó el suyo este tick por `researchTechnology`/`craftTechnology`, que
 * corren antes (en F3–F4). */
export function avanzarTecnicaDelMundo(c: CtxLeyMateria): void {
  for (const p of c.mundo.people) {
    const t = p.technology.tecnica, pe = t?.proceso;
    if (!t || !pe || t.avanzadoEn === c.tick || !esPersonaV23(p)) continue;
    const paso = pe.proceso.pasos[pe.proceso.i];
    if (!paso || paso.op === 'romper' || paso.op === 'unir') continue;
    t.avanzadoEn = c.tick;
    if (avanzarProcesoCon(c, pe.proceso as ProcesoMaterial, null, null, []) === 'hecho') terminarTecnica(c, p, t);
  }
}

/** Lo que alguien tiene a mano para unir: lo que lleva, los montones de su celda y su suelo. */
function insumosAMano(c: CtxLeyMateria, p: PersonaTecnica, celda: number): { insumo: number; forma: number; masa: number }[] {
  const fuego = fuegoEn(c, celda), out: { insumo: number; forma: number; masa: number }[] = [];
  const mirar = (l: LoteRef, conForma: boolean) => {
    if (l < 0 || l === fuego || !c.materia.vivo(l) || !c.materia.propio(l)) return;
    const v = c.materia.vista(l);
    if (v.masa > 0 && v.principal && (v.fase === 0 || v.fase === 3)) out.push({ insumo: v.principal, forma: conForma ? v.forma : 0, masa: v.masa });
  };
  for (const l of p.carga ?? []) mirar(l, true);
  for (const l of objetosDeCelda(c, celda)) mirar(l, true);
  mirar(lotesDeCelda(c, celda, { suelo: -1, agua: -1, vida: -1, aire: -1 }).suelo, false);
  return out;
}

function pasoAlAzar(c: CtxLeyMateria, insumos: readonly { insumo: number; forma: number; masa: number }[], volumen: number,
  celda: number): Paso {
  const u = () => c.azar(), op = Math.floor(u() * 4);
  if (op === 0 || volumen <= 0) {
    const i = insumos[Math.floor(u() * insumos.length)]!;
    return { op: 'unir', insumo: i.insumo, forma: i.forma, masa: i.masa * (1 - u()) };
  }
  if (op === 1) {
    // Dimensiones alrededor del lado del cubo de lo que se junta, hasta un factor e^1,5 arriba o abajo.
    const lado = Math.cbrt(volumen / 1000), dim = () => lado * Math.exp(3 * (u() - 0.5));
    return { op: 'romper', forma: { largo: dim(), ancho: dim(), grueso: dim(), hueco: u() ** 2, filo: u() } };
  }
  const ticks = Math.max(1, Math.round(-DURACION_PASO * Math.log(1 - u())));
  const fuego = fuegoEn(c, celda), Tamb = temperaturaDe(c, celda);
  if (op === 2 && fuego >= 0 && u() < 0.5) return { op: 'calentar', hasta: { T: Tamb + (c.materia.vista(fuego).T - Tamb) * u(), ticks } };
  return op === 2 ? { op: 'calentar', hasta: { ticks } } : { op: 'mojar', hasta: { ticks } };
}

/** Volumen (L) que tendría lo que juntan los pasos unir de una receta. */
function volumenReceta(c: CtxLeyMateria, pasos: readonly Paso[]): number {
  let v = 0;
  for (const p of pasos) if (p.op === 'unir') {
    const d = c.quimica.sustancia(p.insumo).prop.densidad;
    if (d > 0) v += p.masa / d;
  }
  return v;
}

/** Perturba un número positivo por un factor e^U(−1, 1). */
const perturbar = (c: CtxLeyMateria, x: number) => x * Math.exp(2 * c.azar() - 1);

function variarPaso(c: CtxLeyMateria, p: Paso): Paso {
  if (p.op === 'unir') return { ...p, masa: perturbar(c, p.masa) };
  if (p.op === 'romper') {
    const f = { ...p.forma }, k = Math.floor(c.azar() * 5);
    if (k === 0) f.largo = perturbar(c, f.largo); else if (k === 1) f.ancho = perturbar(c, f.ancho);
    else if (k === 2) f.grueso = perturbar(c, f.grueso); else if (k === 3) f.hueco = c.azar() ** 2; else f.filo = c.azar();
    return { op: 'romper', forma: f };
  }
  const hasta = { ...p.hasta };
  if (hasta.T !== undefined && c.azar() < 0.5) hasta.T = perturbar(c, hasta.T);
  else hasta.ticks = Math.max(1, Math.round(perturbar(c, hasta.ticks ?? DURACION_PASO)));
  return { op: p.op, hasta };
}

/**
 * Receta candidata para investigar: variación de una recordada (añadir, cambiar, retocar o quitar un paso, o cruzarla con
 * otra) o una nueva con lo que hay a mano. Siempre empieza uniendo: el proceso parte de un lote vacío.
 */
export function proponerReceta(c: CtxLeyMateria, p: PersonaTecnica, t: TecnicaPersona, celda: number):
  { pasos: Paso[]; padres: number[]; generacion: number } | undefined {
  const insumos = insumosAMano(c, p, celda);
  if (!insumos.length) return;
  const registro = c.globales.registro;
  const conocidas = t.recetas.map(r => ({ r, pasos: leerReceta(registro, r.id) })).filter((k): k is { r: RecetaRecordada; pasos: Paso[] } => !!k.pasos?.length);
  const elegir = <T>(xs: readonly T[]): T => xs[Math.floor(c.azar() * xs.length)]!;
  let pasos: Paso[], padres: RecetaRecordada[] = [];
  if (conocidas.length && c.azar() < PROB_VARIAR_CONOCIDA) {
    const a = elegir(conocidas);
    pasos = a.pasos.map(s => s); padres = [a.r];
    if (conocidas.length > 1 && c.azar() < PROB_CRUZAR) {
      const b = elegir(conocidas.filter(k => k !== a));
      pasos = [...pasos.slice(0, 1 + Math.floor(c.azar() * pasos.length)), ...b.pasos.slice(Math.floor(c.azar() * b.pasos.length))];
      padres.push(b.r);
    }
    const k = Math.floor(c.azar() * pasos.length), cambio = Math.floor(c.azar() * 4);
    const nuevo = () => pasoAlAzar(c, insumos, volumenReceta(c, pasos), celda);
    if (cambio === 0) pasos.splice(Math.floor(c.azar() * (pasos.length + 1)), 0, nuevo());
    else if (cambio === 1) pasos[k] = nuevo();
    else if (cambio === 2) pasos[k] = variarPaso(c, pasos[k]!);
    else if (pasos.length > 1) pasos.splice(k, 1);
  } else {
    pasos = [pasoAlAzar(c, insumos, 0, celda)];
    for (let n = Math.floor(c.azar() * 3); n >= 0; n--) pasos.push(pasoAlAzar(c, insumos, volumenReceta(c, pasos), celda));
  }
  if (pasos[0]?.op !== 'unir') { const i = elegir(insumos); pasos.unshift({ op: 'unir', insumo: i.insumo, forma: i.forma, masa: i.masa * (1 - c.azar()) }); }
  return { pasos, padres: padres.map(r => r.id), generacion: 1 + Math.max(0, ...padres.map(r => r.generacion)) };
}

/** Empieza un proceso de investigación o fabricación en la celda de la persona, sobre un lote vacío nuevo. */
function empezarProceso(c: CtxLeyMateria, p: PersonaTecnica, t: TecnicaPersona, tipo: 'research' | 'craft', recetaId?: number): boolean {
  const celda = celdaPropia(c, p.x, p.y);
  if (celda < 0) return false;
  let pasos: Paso[] | null | undefined, padres: number[] = [], generacion = 1, receta = -1;
  if (tipo === 'craft') {
    const r = recetaId !== undefined ? recetaRecordada(t, recetaId) : undefined;
    pasos = r ? leerReceta(c.globales.registro, r.id) : null;
    if (r) { padres = [...r.padres]; generacion = r.generacion; receta = r.id; }
  } else {
    const propuesta = proponerReceta(c, p, t, celda);
    if (propuesta) ({ pasos, padres, generacion } = propuesta);
  }
  if (!pasos?.length) return false;
  const lote = c.materia.nuevo(Rol.Objeto, celda, 0);
  const proceso = iniciarProceso(c, lote, pasos, Math.round(p.x), Math.round(p.y));
  t.proceso = { tipo, receta, generacion, padres, proceso, ...(tipo === 'research' ? { original: pasos } : {}) };
  return true;
}

/** El útil a cuestas que mejor rompe: el más duro, y con más filo a igual dureza. */
function mejorUtil(c: CtxLeyMateria, p: PersonaTecnica): LoteRef | null {
  let mejor: LoteRef | null = null, valor = 0;
  for (const l of p.carga ?? []) {
    if (!c.materia.propio(l)) continue;
    const v = c.materia.vista(l);
    if (!v.forma) continue;
    const x = v.dureza * (1 + formaDeCodigo(v.forma).filo);
    if (x > valor) { mejor = l; valor = x; }
  }
  return mejor;
}

/** Interrumpe el proceso en curso: el lote intermedio queda donde está (otro puede seguir con él o usarlo); si quedó
 * vacío, se libera. */
function interrumpir(p: Person, t: TecnicaPersona, tick: number, c?: CtxLeyMateria): void {
  const lote = t.proceso?.proceso.lote;
  if (c && lote !== undefined && c.materia.vivo(lote) && c.materia.propio(lote) && c.materia.vista(lote).masa <= 0
    && c.materia.calor(lote) === 0) c.materia.liberar(lote);
  t.proceso = null; t.intentos++; t.ultimoIntento = tick;
  p.technology.attempts++; p.technology.lastAttempt = tick;
}

/** Un tick de trabajo de la persona en su proceso (lo arranca si no tiene). Devuelve si terminó con éxito. */
function trabajarTecnica(c: CtxLeyMateria, p: PersonaTecnica, tipo: 'research' | 'craft', recetaId?: number): boolean {
  const t = tecnicaDe(p);
  if (t.avanzadoEn === c.tick) return false;
  if (t.proceso) {
    const pr = t.proceso.proceso;
    const aqui = celdaPropia(c, p.x, p.y), alla = celdaPropia(c, pr.x, pr.y);
    if (!c.materia.vivo(pr.lote) || aqui < 0 || aqui !== alla || t.proceso.tipo !== tipo
      || (tipo === 'craft' && recetaId !== undefined && t.proceso.receta !== recetaId)) interrumpir(p, t, c.tick, c);
  }
  if (!t.proceso && !empezarProceso(c, p, t, tipo, recetaId)) { interrumpir(p, t, c.tick, c); return false; }
  t.avanzadoEn = c.tick;
  const pr = t.proceso!.proceso as ProcesoMaterial;
  const avance = avanzarProcesoCon(c, pr, p.cuerpo, mejorUtil(c, p), p.carga ?? []);
  // Espera aun con quien trabaja delante: aquí no hay lo que el paso pide (insumo, fuego que prender, agua) o no le
  // quedan fuerzas. Lo deja (el lote se queda donde está); si no, seguir ese proceso volvía a ser su oportunidad
  // técnica cada tick y se quedaba esperando sin fin.
  if (avance === 'espera') { interrumpir(p, t, c.tick, c); return false; }
  return avance === 'hecho' && terminarTecnica(c, p, t);
}

/** Si quien lo hizo está en la celda y cabe en su carga (masa y volumen), el lote pasa a ir a cuestas; si no, se queda
 * en la celda como montón. */
function llevarOdejar(c: CtxLeyMateria, p: PersonaTecnica, lote: LoteRef, celda: number): boolean {
  const v = c.materia.vista(lote);
  if (!p.carga || !(v.masa > 0) || celda < 0 || celdaPropia(c, p.x, p.y) !== celda) return false;
  const masa = masaDe(c, p.cuerpo), carga = p.carga.filter(l => c.materia.propio(l));
  const volumen = carga.reduce((s, l) => s + volumenLote(c, l), volumenLote(c, lote));
  if (cargaKg(c, carga) + v.masa > CARGA_MASA * masa || volumen > CARGA_VOLUMEN * masa / DENSIDAD_CUERPO) return false;
  const llevado = c.materia.nuevo(Rol.Objeto, -1, v.forma);
  c.materia.moverParte(lote, llevado, { parte: Parte.Todo, esp: 0, cuantos: 0, kappa: null });
  if (c.materia.vista(lote).masa <= 0 && c.materia.calor(lote) === 0) c.materia.liberar(lote);
  p.carga.push(llevado);
  return true;
}

/** Perfil funcional de una receta recordada para `novedadFuncional`. */
function perfilReceta(c: CtxLeyMateria, r: RecetaRecordada): PerfilFuncional {
  const b = c.globales.registro.leer(r.id);
  return { id: String(r.id), signature: b ? hex(b) : '', generation: r.generacion, parents: r.padres.map(String), capacities: perfilDeVector(r.vector) };
}
const compuesta = (r: PerfilFuncional) => r.generation >= 2 && r.parents.length >= 2;

/** Cierra el proceso terminado: el producto va a cuestas o se queda; fabricar refresca la receta; investigar la gana
 * solo si su producto es una novedad funcional (propiedades del lote × forma) frente a lo que sabe y a lo que ve. */
function terminarTecnica(c: CtxLeyMateria, p: PersonaTecnica, t: TecnicaPersona): boolean {
  const pe = t.proceso!, lote = pe.proceso.lote, v = c.materia.vista(lote), vector = vectorFuncional(v);
  const celda = celdaPropia(c, pe.proceso.x, pe.proceso.y);
  const vistos: PerfilFuncional[] = [];
  if (celda >= 0) for (const l of objetosDeCelda(c, celda)) if (l !== lote && c.materia.vista(l).forma)
    vistos.push({ id: `lote:${l}`, signature: '', generation: 0, parents: [], capacities: perfilDeVector(vectorFuncional(c.materia.vista(l))) });
  if (v.masa > 0) llevarOdejar(c, p, lote, celda);
  interrumpir(p, t, c.tick, c);
  if (!(v.masa > 0)) return false;
  if (pe.tipo === 'craft') {
    recordarReceta(t, { id: pe.receta, usada: c.tick, generacion: pe.generacion, padres: pe.padres, vector });
    return true;
  }
  const original = pe.original as Paso[] | undefined;
  if (!original?.length) return false;
  const bytes = codificarReceta(original);
  const candidato: PerfilFuncional = { id: 'candidata', signature: hex(bytes), generation: pe.generacion,
    parents: pe.padres.map(String), capacities: perfilDeVector(vector) };
  const existentes = [...t.recetas.map(r => perfilReceta(c, r)), ...vistos];
  if (!novedadFuncional(CLAVES_FUNCIONALES, candidato, existentes, c.params.tecnologia.mejoraLocal, compuesta)) return false;
  const id = c.globales.registro.insertar(bytes);
  recordarReceta(t, { id, usada: c.tick, generacion: pe.generacion, padres: pe.padres, vector });
  for (const padre of pe.padres) usarReceta(t, padre, c.tick);
  c.suceso({ kind: 'invention', actors: [p.id], x: p.x, y: p.y, source: 'simulation',
    text: `${p.name} dio con un proceso nuevo: ${original.map(s => s.op).join(' → ')}.`,
    cause: `Proceso sobre lotes de generación ${pe.generacion}; el producto (${v.masa.toFixed(2)} kg a ${Math.round(v.T)} K) hace algo que no hacía lo que sabía ni lo que veía.` });
  return true;
}

/** ¿El vector `v` hace, al menos tan bien, todo lo que hace `r` (sus claves activas)? */
const cubre = (v: readonly number[], r: readonly number[], tol: number) =>
  r.every((x, i) => x < ACTIVE_CAPABILITY_THRESHOLD || (v[i] ?? 0) >= x - tol);

/** La oportunidad técnica V23: seguir un proceso, fabricar una receta cuya función no lleva encima o investigar con la
 * materia que tiene a mano. */
export function oportunidadTecnica(c: CtxLeyMateria, p: PersonaTecnica):
  { kind: 'research' | 'craft'; score: number; reason: string; recipeId?: string } | undefined {
  const t = tecnicaDe(p);
  if (t.proceso) return { kind: t.proceso.tipo, score: 0.86, reason: 'Sigue un proceso material que dejó a medias; el lote está donde lo dejó.',
    recipeId: t.proceso.tipo === 'craft' ? String(t.proceso.receta) : undefined };
  const llevado = (p.carga ?? []).filter(l => c.materia.propio(l)).map(l => vectorFuncional(c.materia.vista(l)));
  const tol = c.params.tecnologia.mejoraLocal;
  const falta = t.recetas.filter(r => !llevado.some(v => cubre(v, r.vector, tol))).sort((a, b) => b.usada - a.usada || a.id - b.id)[0];
  if (falta) return { kind: 'craft', recipeId: String(falta.id), score: 0.4 + 0.3 * fuerzaReceta(falta, c.tick, tauDe(p)),
    reason: 'Sabe hacer algo que no lleva encima; hacerlo cuesta trabajo y la materia que junte.' };
  if (c.tick - t.ultimoIntento < c.params.tecnologia.enfriamiento) return;
  const celda = celdaPropia(c, p.x, p.y);
  if (celda < 0 || !insumosAMano(c, p, celda).length) return;
  return { kind: 'research', score: 0.35 + (p.curiosity ?? 0.5) * 0.3 + (p.skills.technology ?? 0) * 0.08,
    reason: 'Prueba a romper, juntar, calentar o mojar lo que tiene a mano; el intento cuesta trabajo y materia.' };
}

/** Bytes de una enseñanza (`Intento.bytes` de Ensenar): «T1E», receta (f64), generación (u32), padres y vector. */
export function codificarEnsenanza(r: Pick<RecetaRecordada, 'id' | 'generacion' | 'padres' | 'vector'>): Uint8Array {
  const b = new Uint8Array(4 + 8 + 4 + 4 + 8 * r.padres.length + 4 + 8 * r.vector.length), d = new DataView(b.buffer);
  b.set([0x54, 0x31, 0x45, 0x01]);
  let o = 4;
  d.setFloat64(o, r.id, true); o += 8;
  d.setUint32(o, r.generacion, true); o += 4;
  d.setUint32(o, r.padres.length, true); o += 4;
  for (const x of r.padres) { d.setFloat64(o, x, true); o += 8; }
  d.setUint32(o, r.vector.length, true); o += 4;
  for (const x of r.vector) { d.setFloat64(o, x, true); o += 8; }
  return b;
}
export function decodificarEnsenanza(b: Uint8Array): Pick<RecetaRecordada, 'id' | 'generacion' | 'padres' | 'vector'> | null {
  if (b.length < 24 || b[0] !== 0x54 || b[1] !== 0x31 || b[2] !== 0x45 || b[3] !== 0x01) return null;
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 4;
  const id = d.getFloat64(o, true); o += 8;
  const generacion = d.getUint32(o, true); o += 4;
  const np = d.getUint32(o, true); o += 4;
  if (o + 8 * np + 4 > b.length) return null;
  const padres = Array.from({ length: np }, (_, k) => d.getFloat64(o + 8 * k, true)); o += 8 * np;
  const nv = d.getUint32(o, true); o += 4;
  if (o + 8 * nv !== b.length) return null;
  const vector = Array.from({ length: nv }, (_, k) => d.getFloat64(o + 8 * k, true));
  return Number.isSafeInteger(id) && id >= 0 ? { id, generacion, padres, vector } : null;
}

/** Aplicador de Ensenar en el dueño del aprendiz: recuerda la receta con fuerza 1. */
export function aprenderReceta(c: CtxLeyMateria, p: Person, e: Pick<RecetaRecordada, 'id' | 'generacion' | 'padres' | 'vector'>, _de: number): boolean {
  if (!p.cuerpo || !c.globales.registro.leer(e.id) || e.vector.length !== CLAVES_FUNCIONALES.length) return false;
  recordarReceta(tecnicaDe(p), { id: e.id, usada: c.tick, generacion: e.generacion, padres: [...e.padres], vector: [...e.vector] });
  return true;
}

/** La receta que `maestro` enseñaría a `aprendiz` (la más usada que no sepa ya; el aprendiz se lee de su propio estado
 * si es de este dueño, y si no, se enseña igual: recordar la refresca). */
export function recetaParaEnsenar(c: CtxLeyMateria, maestro: Person, aprendiz: Person | null, recetaId?: number): RecetaRecordada | undefined {
  const sabe = aprendiz?.technology.tecnica;
  return tecnicaDe(maestro).recetas.filter(r => (recetaId === undefined || r.id === recetaId) && !(sabe && recetaRecordada(sabe, r.id)))
    .sort((a, b) => b.usada - a.usada || a.id - b.id)[0];
}

/** Con `v23.tecnica` y contexto de motor, la receta de lotes que `maestro` enseñaría a `aprendiz` (su id del registro
 * en texto, o undefined si no hay); null si la técnica de lotes no rige y manda el catálogo viejo. */
export function recetaTecnicaParaEnsenar(host: object, maestro: Person, aprendiz: Person): string | undefined | null {
  const c = ctxTecnica(host);
  if (!c) return null;
  if (!esPersonaV23(maestro)) return undefined;
  const r = recetaParaEnsenar(c, maestro, aprendiz);
  return r ? String(r.id) : undefined;
}

/** Enseñar = intento Ensenar al dueño del aprendiz; quien enseña paga un tick de trabajo y la receta vuelve a 1. */
export function ensenarTecnica(c: CtxLeyMateria, maestro: Person, aprendizUid: number, recetaId?: number, aprendiz: Person | null = null): boolean {
  if (!maestro.cuerpo) return false;
  const r = recetaParaEnsenar(c, maestro, aprendiz, recetaId), ref = c.ref(aprendizUid);
  if (!r || ref === REF_NULA) return false;
  if (!(pagar(c, maestro.cuerpo, POTENCIA_TRABAJO * SEGUNDOS_TICK) > 0)) return false;
  usarReceta(tecnicaDe(maestro), r.id, c.tick);
  // Sin v23.intentos nadie vacía la cola A (la enseñanza se perdía y la cola crecía): el mundo es un solo heap y se
  // aprende directo, como hace natalidad con el vínculo.
  if (!ley(c.mundo, 'intentos')) {
    const quien = aprendiz ?? c.mundo.people.find(o => o.uid === aprendizUid);
    return !!quien && aprenderReceta(c, quien, r, maestro.uid === undefined ? REF_NULA : c.ref(maestro.uid));
  }
  c.buzon.enviar(c.frente.dueno[slotDe(ref)]!, { tipo: TipoIntento.Ensenar, de: maestro.uid === undefined ? REF_NULA : c.ref(maestro.uid), a: ref,
    celda: -1, lote: REF_NULA, nonce: c.id('nonce'), materia: null, dato: null, bytes: codificarEnsenanza(r) });
  return true;
}
