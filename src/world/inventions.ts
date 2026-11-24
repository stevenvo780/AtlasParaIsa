import type { BlueprintView, StructureComponent, StructureView } from '../shared/life.js';
import type { ChronicleEvent, Tile } from '../shared/types.js';
import type { Person, World } from './index.js';
import { localRandom } from './genetics.js';
import { tileAt } from './spatial.js';
import { tileLookup } from './tile-index.js';
import { residentFastAccess, type ResidentFastAccess } from './soa/terreno.js';
import { chunkKey } from './terrain.js';
import { INTERVALO_ECOLOGIA_TICKS, SED_POR_UNIDAD } from './ecologia-constantes.js';
import { algunoCerca, filtrarCerca } from './indice-puntos.js';
import { esMiembro, techoDelArchivo } from './indices.js';
import { openWorldCaps, OPEN_WORLD_MAX_BLUEPRINTS, paramsOf } from './params.js';
import { vecinos } from './rejilla.js';
import { constructionWorkFactor, consumeConstructionTools, installTechnologyItem, recordTechnologyBenefit, toolEffectsEnabled, useTool } from './technology.js';

type Emit = (event: Omit<ChronicleEvent, 'id' | 'tick'>) => ChronicleEvent;
type Point = { x: number; y: number };
export const MAX_BLUEPRINTS = 64;
export const MAX_STRUCTURES = 512;
export const structureCap = (world: World): number => openWorldCaps(world) ? paramsOf(world).limites.teselasActivas : MAX_STRUCTURES;
export const blueprintCap = (world: World): number => paramsOf(world).construccion.modular ? Number.MAX_SAFE_INTEGER : openWorldCaps(world) ? OPEN_WORLD_MAX_BLUEPRINTS : MAX_BLUEPRINTS;
export const RESEARCH_WORK = 60;
export const REPAIR_WORK = 30;
export const RESEARCH_COOLDOWN = 1200;
export const BROKEN_CONDITION = 0.1;
const REPAIR_CONDITION_LIMIT = 0.95;
export const REST_FATIGUE_RATE = 0.0018;
export const REST_ENERGY_RATE = 0.0011;
export const COMPONENTS: readonly StructureComponent[] = ['frame', 'roof', 'cistern', 'granary', 'garden', 'hearth'];
const COSTS: Record<StructureComponent, BlueprintView['cost']> = {
  frame: { wood: 2, stone: 1, work: 20 }, roof: { wood: 4, stone: 2, work: 70 },
  cistern: { wood: 2, stone: 3, work: 40 }, granary: { wood: 3, stone: 1, work: 35 },
  garden: { wood: 2, stone: 1, work: 30 }, hearth: { wood: 1, stone: 2, work: 30 },
};
const clamp = (value: number, maximum = 1) => Math.max(0, Math.min(maximum, value));
/** V18 ola 2: `Math.hypot` es el coste dominante de este módulo (≈ 60 % del tiempo propio con miles de habitantes: cada
 * llamada reserva un arreglo interno). Para dos argumentos V8 calcula `max·√Σ(|vᵢ|/max)²` con suma de Kahan; con dos
 * términos positivos la compensación de la primera vuelta es exactamente 0, así que se reduce a `√(a² + b²)·max` con las
 * mismas operaciones IEEE: el resultado es idéntico bit a bit (incluidos ±0, NaN e ∞). Al cargar el módulo se comprueba
 * contra `Math.hypot` en una muestra; si un motor distinto difiriera, se usa `Math.hypot`. */
export function hypotExact(x: number, y: number): number {
  const ax = Math.abs(x), ay = Math.abs(y);
  if (ax === Infinity || ay === Infinity) return Infinity;
  if (x !== x || y !== y) return NaN;
  const max = ax > ay ? ax : ay;
  if (max === 0) return 0;
  const a = ax / max, b = ay / max;
  return Math.sqrt(a * a + b * b) * max;
}
const HYPOT_EXACT = (() => {
  let state = 0x9e3779b9;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const samples: [number, number][] = [[0, 0], [-0, 0], [0, -0], [3, 4], [NaN, 1], [1, NaN], [Infinity, NaN], [-Infinity, 2], [5e-324, 0], [1e308, 1e308]];
  for (let i = 0; i < 512; i++) samples.push([(next() - 0.5) * 40, (next() - 0.5) * 40], [Math.floor(next() * 30) - 15, Math.floor(next() * 30) - 15]);
  return samples.every(([x, y]) => Object.is(hypotExact(x, y), Math.hypot(x, y)));
})();
const distance = (a: Point, b: Point) => HYPOT_EXACT ? hypotExact(a.x - b.x, a.y - b.y) : Math.hypot(a.x - b.x, a.y - b.y);
function counts(components: readonly StructureComponent[]): Record<StructureComponent, number> {
  const result = { frame: 0, roof: 0, cistern: 0, granary: 0, garden: 0, hearth: 0 };
  for (const component of components) {
    switch (component) {
      case 'frame': result.frame++; break;
      case 'roof': result.roof++; break;
      case 'cistern': result.cistern++; break;
      case 'granary': result.granary++; break;
      case 'garden': result.garden++; break;
      case 'hearth': result.hearth++; break;
    }
  }
  return result;
}
const canonical = (components: readonly StructureComponent[]) => COMPONENTS.flatMap(component => components.filter(c => c === component));
export const blueprintSignature = (components: readonly StructureComponent[]): string => {
  const n = counts(components);
  return `${n.frame}:${n.roof}:${n.cistern}:${n.granary}:${n.garden}:${n.hearth}`;
};

export function blueprintCost(components: readonly StructureComponent[]): BlueprintView['cost'] {
  let wood = 0, stone = 0, work = 0;
  for (let i = 0; i < components.length; i++) {
    const c = COSTS[components[i]!];
    wood += c.wood; stone += c.stone; work += c.work;
  }
  return { wood, stone, work };
}

/** A roof needs a frame; enclosed storage needs a roof; gardens need captured water.
 * Repetition is structural: extra frames support roofs and slow wear, extra modules add capacity. */
export function validBlueprint(components: unknown, modular = false): components is StructureComponent[] {
  if (!Array.isArray(components) || components.length < 2 || components.length > (modular ? 20 : 8)) return false;
  let frame = 0, roof = 0, cistern = 0, granary = 0, garden = 0, hearth = 0;
  let wood = 0, stone = 0;
  for (let i = 0; i < components.length; i++) {
    switch (components[i]) {
      case 'frame': frame++; wood += 2; stone += 1; break;
      case 'roof': roof++; wood += 4; stone += 2; break;
      case 'cistern': cistern++; wood += 2; stone += 3; break;
      case 'granary': granary++; wood += 3; stone += 1; break;
      case 'garden': garden++; wood += 2; stone += 1; break;
      case 'hearth': hearth++; wood += 1; stone += 2; break;
      default: return false;
    }
  }
  if (modular) return frame >= 1 && frame <= 6 && roof >= 1 && roof <= frame
    && cistern <= 6 && granary <= 6 && garden <= 6 && hearth <= 3
    && (garden === 0 || cistern > 0)
    // Roof spans and filled reservoirs exert twice the load of a light module.
    // Each wood/stone frame provides six units of supporting section.
    && roof * 2 + cistern * 2 + granary + garden + hearth * 2 <= frame * 6;
  return frame >= 1 && frame <= 2 && roof >= 1 && roof <= frame
    && cistern <= 2 && granary <= 2 && garden <= 2 && hearth <= 1
    && (garden === 0 || cistern > 0) && components.length - frame - roof <= frame * 4
    && wood <= 12 && stone <= 8;
}

export function blueprintAffordances(components: readonly StructureComponent[]) {
  let frame = 0, roof = 0, cistern = 0, granary = 0, garden = 0, hearth = 0;
  for (let i = 0; i < components.length; i++) {
    switch (components[i]) {
      case 'frame': frame++; break;
      case 'roof': roof++; break;
      case 'cistern': cistern++; break;
      case 'granary': granary++; break;
      case 'garden': garden++; break;
      case 'hearth': hearth++; break;
    }
  }
  return { waterCapacity: cistern * 0.6, foodCapacity: granary * 0.7,
    catchment: cistern ? roof * 0.012 : 0, irrigation: garden * 0.008,
    restQuality: clamp(0.82 + (roof - 1) * 0.09 + (frame - 1) * 0.03),
    hearths: hearth, durability: 1 + (frame - 1) * 0.5 };
}

function restQualityOf(components: readonly StructureComponent[]): number {
  let frame = 0, roof = 0;
  for (let i = 0; i < components.length; i++) {
    const c = components[i];
    if (c === 'frame') frame++;
    else if (c === 'roof') roof++;
  }
  return clamp(0.82 + (roof - 1) * 0.09 + (frame - 1) * 0.03);
}

const SOA_SAFE_COORD = 1_073_741_800; // 2^30 - 24: x ± 7 siempre en el dominio admisible SoA

function isShelterAt(
  tileIn: (x: number, y: number) => Tile | undefined,
  fast: ResidentFastAccess | undefined,
  x: number,
  y: number,
): boolean {
  if (fast) {
    const exact = fast.exact;
    if (exact) {
      const cell = exact.cellAt(x, y);
      return cell >= 0 && fast.terrainArr[cell] === fast.TERRAIN_SHELTER;
    }
    const tile = tileIn(x, y);
    if (!tile) return false;
    const cell = fast.cellOf(tile);
    return cell >= 0 ? fast.terrainArr[cell] === fast.TERRAIN_SHELTER : tile.terrain === 'shelter';
  }
  return tileIn(x, y)?.terrain === 'shelter';
}

function blueprintName(components: readonly StructureComponent[]): string {
  const n = counts(components), pieces: string[] = [n.roof > 1 ? 'Casa de dos cubiertas' : n.frame > 1 ? 'Refugio reforzado' : 'Refugio'];
  for (const [key, label] of [['cistern', 'cisterna'], ['granary', 'granero'], ['garden', 'huerta'], ['hearth', 'hogar']] as const) {
    if (n[key]) pieces.push(`${label}${n[key] > 1 ? ' doble' : ''}`);
  }
  return pieces.join(' · ');
}

export function defaultBlueprint(): BlueprintView {
  const components: StructureComponent[] = ['frame', 'roof'];
  return { id: 'blueprint-base', name: blueprintName(components), components, generation: 0, parents: [], inventorId: null, tick: 0, uses: 0, usefulness: 0, cost: blueprintCost(components) };
}

/** A caller may hold an outdated counter; active and pending archive identities remain reserved. */
function nextIdentity(counter: number, prefix: 'blueprint' | 'structure', ids: readonly string[], world: World): { id: string; counter: number } | undefined {
  if (!Number.isSafeInteger(counter) || counter < 0) return;
  let largest = counter;
  for (const id of ids) {
    if (!id.startsWith(`${prefix}-`)) continue;
    const suffix = id.slice(prefix.length + 1); if (!/^\d+$/.test(suffix)) continue;
    const reserved = Number(suffix); if (!Number.isSafeInteger(reserved)) return;
    largest = Math.max(largest, reserved);
  }
  const archive = techoDelArchivo(world.retiredChunks, world.tick);
  if (prefix === 'blueprint') {
    if (archive.blueprintCorrupto) return;
    largest = Math.max(largest, archive.blueprint);
  } else {
    if (archive.structureCorrupto) return;
    largest = Math.max(largest, archive.structure);
  }
  if (largest >= Number.MAX_SAFE_INTEGER) return;
  return { id: `${prefix}-${largest + 1}`, counter: largest + 1 };
}

/**
 * T146: base confirmada efectiva para el prefix-sum de `blueprint`/`structure`:
 * el mayor serial ya reservado entre el contador del mundo, los ids activos y
 * el techo del archivo dormido (`techoDelArchivo`, T140). Es exactamente la
 * reserva que `nextIdentity` hace hoy antes de asignar `largest + 1`, pero sin
 * asignar: el coordinador suma su prefix-sum sobre esta base. `undefined` si
 * algún sufijo es corrupto o desborda, como en `nextIdentity`. Sin cambios en
 * el camino por defecto, que sigue llamando a `nextIdentity`.
 */
export function identityBaseFromArchive(world: World, prefix: 'blueprint' | 'structure'): number | undefined {
  const planos = world.blueprints, obras = world.structures, ids: string[] = [];
  if (prefix === 'blueprint') {
    for (const plano of planos) ids.push(plano.id, ...plano.parents);
    for (const obra of obras) ids.push(obra.blueprintId);
  } else for (const obra of obras) ids.push(obra.id);
  const counter = prefix === 'blueprint' ? world.blueprintCounter : world.structureCounter;
  const siguiente = nextIdentity(counter, prefix, ids, world);
  return siguiente ? siguiente.counter - 1 : undefined;
}

function blueprintIdentity(world: World) {
  return nextIdentity(world.blueprintCounter, 'blueprint', [...world.blueprints.map(b => b.id), ...world.blueprints.flatMap(b => b.parents),
    ...world.structures.map(s => s.blueprintId)], world);
}

function selectedBlueprint(world: World, person: Person): BlueprintView {
  return world.blueprints.find(b => b.id === person.blueprintId && validBlueprint(b.components, paramsOf(world).construccion.modular)) ?? world.blueprints.find(b => b.id === 'blueprint-base') ?? defaultBlueprint();
}
export function constructionCost(world: World, person: Person): BlueprintView['cost'] {
  const cost = blueprintCost(selectedBlueprint(world, person).components);
  if (!paramsOf(world).construccion.modular) return cost;
  const site = constructionSite(world, person)?.site;
  // The existing selector requests one transport/work trip, not the whole building.
  return { wood: Math.min(12, site ? site.requiredWood - site.depositedWood : cost.wood),
    stone: Math.min(8, site ? site.requiredStone - site.depositedStone : cost.stone),
    work: Math.max(1, Math.min(30, site ? site.requiredWork - site.completedWork : cost.work)) };
}

export function constructionSite(world: World, person: Point): StructureView | undefined {
  if (!paramsOf(world).construccion.modular) return;
  return filtrarCerca(world.structures, person, 8, s => !!s.site && distance(person, s) <= 7)
    .sort((a, b) => distance(person, a) - distance(person, b) || a.id.localeCompare(b.id))[0];
}

const CONSTRUCTION_RADIUS = 7;
const MIN_SERVICE_GAIN = 0.025;
type Services = { rest: number; water: number; food: number; irrigation: number };

/** These are perceived opportunities, not occupancy or production receipts. Roofs are
 * reusable; storage/catchment and irrigation add across locally visible structures.
 * Normalized catchment discounts worn collectors without inventing water in them. */
function localServices(world: World, person: Person, replacement?: { structure: StructureView; condition: number }, added?: readonly StructureComponent[], fuelWood = person.materials.wood): Services {
  const result: Services = { rest: world.weather === 'rain' ? 0.2 : 0.55, water: 0, food: 0, irrigation: 0 };
  const add = (components: readonly StructureComponent[], condition: number, water = 0, food = 0, installed?: ReturnType<typeof blueprintAffordances>) => {
    if (condition <= BROKEN_CONDITION) return;
    const a = installed ?? blueprintAffordances(components);
    if (world.shelterBenefitEnabled) {
      const heated = (world.weather === 'rain' || world.tick % 2400 >= 1800) && fuelWood >= a.hearths * 0.0005;
      result.rest = Math.max(result.rest, clamp((a.restQuality + (heated ? a.hearths * 0.12 : 0)) * condition));
    }
    result.water += Math.max(water, a.waterCapacity * clamp(a.catchment / 0.012 * condition));
    result.food += Math.max(0, a.foodCapacity - food);
    result.irrigation += a.irrigation * condition;
  };
  // Negación literal del `continue` de siempre (no la forma positiva): preserva cómo se trata una
  // distancia o condición NaN, igual que hizo T141 en `share`/`evaluateCooperation`.
  for (const structure of filtrarCerca(world.structures, person, CONSTRUCTION_RADIUS + 1,
    structure => !structure.site && !(distance(person, structure) > CONSTRUCTION_RADIUS || tileAt(world, structure)?.terrain !== 'shelter'))) {
    add(structure.components, replacement?.structure === structure ? replacement.condition : structure.condition, structure.water, structure.food,
      paramsOf(world).tecnologia.obrasPorPropiedades ? structureAffordances(world, structure) : undefined);
  }
  if (added) add(added, 1);
  return result;
}

function constructionContext(world: World, person: Person) {
  const nearby = vecinos(world, person, CONSTRUCTION_RADIUS + 1, other => distance(person, other) <= CONSTRUCTION_RADIUS);
  return { ...inventionContext(world, person),
    // Drinking lowers thirst by three times the debited water. One full body's
    // dose is a planning reserve; additional demand comes only from people seen.
    waterDemand: Math.max(1 / SED_POR_UNIDAD, nearby.reduce((sum, other) => sum + other.thirst / SED_POR_UNIDAD, 0)),
    foodSurplus: nearby.reduce((sum, other) => sum + Math.max(0, other.inventory - 0.12), 0) };
}

function serviceValue(services: Services, context: ReturnType<typeof constructionContext>): number {
  return services.rest * context.rest
    + clamp(services.water / context.waterDemand) * context.rainPotential * context.water
    + Math.min(services.food, context.foodSurplus) * context.food
    + clamp(services.irrigation / 0.012) * context.rainPotential * (1 - context.moisture) * context.food * 0.65;
}

function localMaterials(world: World, person: Person): Person['materials'] {
  const materials = { ...person.materials };
  for (let dy = -CONSTRUCTION_RADIUS; dy <= CONSTRUCTION_RADIUS; dy++) for (let dx = -CONSTRUCTION_RADIUS; dx <= CONSTRUCTION_RADIUS; dx++) {
    if (dx * dx + dy * dy > CONSTRUCTION_RADIUS * CONSTRUCTION_RADIUS) continue;
    const tile = tileAt(world, { x: person.x + dx, y: person.y + dy });
    // The gathering action requires at least one unit on a tile. Fractional
    // leftovers spread across many tiles are not a reachable material reserve.
    if (tile && tile.terrain !== 'water') { materials.wood += Math.floor(tile.wood ?? 0); materials.stone += Math.floor(tile.stone ?? 0); }
  }
  return materials;
}

function usefulRepairs(world: World, person: Person, context?: ReturnType<typeof constructionContext>) {
  // Negación literal del `return []` de siempre: una condición/distancia NaN no debe excluir aquí lo
  // que el bucle de abajo (también insensible a NaN por `while (condition < LIMIT)`) habría procesado.
  const structures = filtrarCerca(world.structures, person, CONSTRUCTION_RADIUS + 1, structure => !structure.site && !(structure.condition >= REPAIR_CONDITION_LIMIT
    || distance(person, structure) > CONSTRUCTION_RADIUS || tileAt(world, structure)?.terrain !== 'shelter'));
  if (!structures.length) return [];
  const perceived = context ?? constructionContext(world, person), before = serviceValue(localServices(world, person), perceived);
  return structures.flatMap(structure => {
    // Evaluate each physically legal paid prefix. A broken roof can need several
    // steps before it helps; a last top-up with no extra service earns no benefit.
    let condition = structure.condition, steps = 0;
    const options: { structure: StructureView; gain: number; steps: number; efficiency: number }[] = [];
    while (condition < REPAIR_CONDITION_LIMIT) {
      condition = clamp(condition + 0.4); steps++;
      const gain = serviceValue(localServices(world, person, { structure, condition }, undefined, Math.max(0, person.materials.wood - steps)), perceived) - before;
      if (gain >= MIN_SERVICE_GAIN) options.push({ structure, gain, steps, efficiency: gain / (steps * (1 + REPAIR_WORK / 30)) });
    }
    return options;
  }).sort((a, b) => b.efficiency - a.efficiency || distance(person, a.structure) - distance(person, b.structure) || a.structure.id.localeCompare(b.structure.id));
}

/** Autonomous admission only. Explicit construction still uses completeConstruction
 * and pays the same material/work costs. No distant archive, historical uses or
 * invented number of occupants contributes to this local marginal comparison. */
export function constructionOpportunity(world: World, person: Person): { score: number; reason: string; target?: Point } | undefined {
  const site = constructionSite(world, person);
  if (site) return { target: { x: site.x, y: site.y }, score: 0.6 + person.traits.industriousness * 0.2,
    reason: 'Una obra local aún necesita entregas de materiales y trabajo pagado.' };
  if (world.structures.length >= structureCap(world)) return;
  const blueprint = selectedBlueprint(world, person), cost = blueprintCost(blueprint.components), materials = localMaterials(world, person);
  if (materials.wood < cost.wood || materials.stone < cost.stone) return;
  const context = constructionContext(world, person), before = serviceValue(localServices(world, person), context);
  // Material committed to the building cannot simultaneously fuel its hearth.
  const gain = serviceValue(localServices(world, person, undefined, blueprint.components, Math.max(0, person.materials.wood - cost.wood)), context) - before;
  const expense = normalizedCost(cost), baseExpense = normalizedCost(defaultBlueprint().cost);
  if (gain < MIN_SERVICE_GAIN * expense / baseExpense) return;
  const repair = usefulRepairs(world, person, context).find(option => materials.wood >= option.steps);
  if (repair && repair.efficiency >= gain / expense) return;
  return { score: 0.35 + person.traits.industriousness * 0.2 + Math.min(0.55, gain) - expense * 0.005,
    reason: 'El plano aporta una función adicional frente a las instalaciones que percibe; fabricarlo exige materiales y trabajo.' };
}

export interface InventionContext { water: number; food: number; rest: number; rainPotential: number; foodSurplus: number; moisture: number; cold: number; fuel: number; }
/** Perceived local deficits, not global resource omniscience or invented weather history.
 * rainPotential is explicitly a soil/biome prior; only actual rain can fill a built cistern. */
export function inventionContext(world: World, person: Person): InventionContext {
  let count = 0, moisture = 0, food = 0, wood = 0, reserve = 0;
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    if (dx * dx + dy * dy > 16) continue;
    const tile = tileAt(world, { x: person.x + dx, y: person.y + dy });
    if (tile && tile.terrain !== 'water') {
      count++; moisture += tile.moisture; food += tile.food; wood += tile.wood ?? 0;
      reserve = Math.max(reserve, tile.drinkingWater ?? 0);
    }
  }
  moisture /= Math.max(1, count); food /= Math.max(1, count); wood /= Math.max(1, count);
  const portable = vecinos(world, person, 5, p => distance(person, p) <= 4).reduce((sum, p) => sum + Math.max(0, p.inventory - 0.08), 0);
  const roofs = filtrarCerca(world.structures, person, 5, s => distance(person, s) <= 4 && s.condition > BROKEN_CONDITION && tileAt(world, s)?.terrain === 'shelter');
  const quality = Math.max(0, ...roofs.map(s => blueprintAffordances(s.components).restQuality * s.condition));
  return { water: clamp(0.65 * (1 - clamp(reserve * 5)) + person.thirst * 0.35),
    food: clamp(0.65 * (1 - clamp(food * 4)) + person.hunger * 0.35),
    rest: clamp((1 - quality) * 0.6 + person.fatigue * 0.4),
    rainPotential: world.weather === 'rain' ? 1 : clamp(0.15 + moisture * 0.55),
    foodSurplus: clamp(portable * 2 + food * 2), moisture,
    cold: world.weather === 'rain' || world.tick % 2400 >= 1800 ? 1 : 0.15,
    fuel: clamp((person.materials.wood + wood) / 4) };
}

/** Cultural parents must be known through ownership, nearby built examples, or trusted contacts. */
function knownBlueprints(world: World, person: Person): BlueprintView[] {
  const ids = new Set(['blueprint-base', person.blueprintId]);
  for (const structure of filtrarCerca(world.structures, person, 6, structure => distance(person, structure) <= 5
    && !structure.site && structure.condition > BROKEN_CONDITION && tileAt(world, structure)?.terrain === 'shelter')) ids.add(structure.blueprintId);
  if (world.cooperationEnabled) for (const other of vecinos(world, person, 4, other => other !== person && distance(person, other) <= 3
    && (person.bonds[other.id] ?? 0.2) >= 0.2 && person.culture.openness >= 0.15)) ids.add(other.blueprintId);
  return world.blueprints.filter(b => (ids.has(b.id) || b.inventorId === person.id) && validBlueprint(b.components, paramsOf(world).construccion.modular));
}

function expectedValue(components: readonly StructureComponent[], context: InventionContext): number {
  const a = blueprintAffordances(components);
  const water = clamp(a.waterCapacity) * context.rainPotential * context.water;
  const food = clamp(a.foodCapacity) * context.foodSurplus * context.food
    + clamp(a.irrigation / 0.012) * context.rainPotential * (1 - context.moisture) * context.food * 0.65;
  const rest = (a.restQuality - 0.82 + a.hearths * 0.12 * context.cold * context.fuel) * context.rest * 5;
  // A base roof is already known; novelty is evaluated on the additional functions it enables.
  return water + food + rest + (a.durability - 1) * context.rest * 0.1;
}
const normalizedCost = (cost: BlueprintView['cost']) => cost.wood + cost.stone * 1.5 + cost.work / 30;
const genotypeDistance = (a: readonly StructureComponent[], b: readonly StructureComponent[]) => {
  const ac = counts(a), bc = counts(b); return COMPONENTS.reduce((sum, component) => sum + Math.abs(ac[component] - bc[component]), 0);
};
export interface InventionCandidate { components: StructureComponent[]; parents: string[]; value: number; efficiency: number; novelty: number; }

/** Exactly twelve bounded proposals, including meaningful multi-component edits; invalid children
 * are rejected rather than silently repaired into a different claimed genotype. */
export function inventionCandidates(world: World, person: Person): InventionCandidate[] {
  return candidatesFromKnown(world, person, inventionContext(world, person), knownBlueprints(world, person));
}

function candidatesFromKnown(world: World, person: Person, context: InventionContext, known: BlueprintView[]): InventionCandidate[] {
  if (!known.length) known.push(defaultBlueprint());
  const values = new Map(known.map(b => [b, expectedValue(b.components, context)]));
  // Keep the original left-associative subtraction, including its rounding at ties.
  known.sort(paramsOf(world).construccion.modular
    ? (a, b) => values.get(b)! - values.get(a)! || blueprintSignature(a.components).localeCompare(blueprintSignature(b.components))
    : (a, b) => values.get(b)! + b.usefulness * 0.1 - values.get(a)! - a.usefulness * 0.1 || a.id.localeCompare(b.id));
  const random = localRandom(world.seed, `research:${person.id}:${world.tick}`), raw: { components: StructureComponent[]; parents: string[] }[] = [];
  const base = known.find(b => b.id === 'blueprint-base') ?? known[0]!;
  const push = (components: StructureComponent[], parents: string[]) => raw.push({ components: canonical(components), parents: [...new Set(parents)] });
  // Context-independent controls ensure selection, not proposal availability, explains contrasts.
  push([...base.components, 'cistern'], [base.id]);
  push([...base.components, 'granary'], [base.id]);
  push([...base.components, 'hearth'], [base.id]);
  push([...base.components, 'frame', 'roof'], [base.id]);
  push([...base.components, 'cistern', 'garden'], [base.id]);
  push([...base.components, 'granary', 'granary'], [base.id]);
  if (paramsOf(world).construccion.modular) for (const parent of known.slice(0, 4)) {
    push([...parent.components, 'frame', 'roof'], [parent.id]);
    push([...parent.components, 'frame'], [parent.id]);
  }
  for (let slot = 6; slot < 12; slot++) {
    const a = known[Math.floor(random() * Math.min(4, known.length))]!, b = known[Math.floor(random() * known.length)]!;
    if (slot < 9 && a.id !== b.id) {
      const ac = counts(a.components), bc = counts(b.components);
      const components = COMPONENTS.flatMap(component => Array.from({ length: random() < 0.5 ? ac[component] : bc[component] }, () => component));
      push(components, [a.id, b.id]);
    } else {
      const components = [...a.components], component = paramsOf(world).construccion.modular
        ? COMPONENTS[Math.floor(random() * COMPONENTS.length)]! : COMPONENTS[2 + Math.floor(random() * 4)]!;
      if (slot % 3 === 0 && components.length > 2) components.splice(2 + Math.floor(random() * (components.length - 2)), 1);
      else if (slot % 3 === 1 && components.length > 2) components[2 + Math.floor(random() * (components.length - 2))] = component;
      else components.push(component);
      push(components, [a.id]);
    }
  }
  const modular = paramsOf(world).construccion.modular, encountered = modular ? known : world.blueprints;
  const seen = new Set(encountered.map(b => blueprintSignature(b.components))), candidates: InventionCandidate[] = [];
  for (const child of raw) {
    if (!validBlueprint(child.components, modular)) continue;
    const signature = blueprintSignature(child.components); if (seen.has(signature)) continue; seen.add(signature);
    const value = expectedValue(child.components, context);
    candidates.push({ ...child, value, efficiency: value / normalizedCost(blueprintCost(child.components)),
      novelty: Math.min(...encountered.map(b => genotypeDistance(child.components, b.components)), 8) / 8 });
  }
  return candidates;
}

export function paretoCandidates(candidates: readonly InventionCandidate[]): InventionCandidate[] {
  return candidates.filter(candidate => !candidates.some(other => other !== candidate
    && other.value >= candidate.value && other.efficiency >= candidate.efficiency && other.novelty >= candidate.novelty
    && (other.value > candidate.value || other.efficiency > candidate.efficiency || other.novelty > candidate.novelty)));
}

/** Physical service/cost frontier in the actor's own niche; no global utility or labels. */
export function locallyUsefulBlueprint(components: readonly StructureComponent[], known: readonly BlueprintView[], context: InventionContext): boolean {
  const dimensions = (cs: readonly StructureComponent[]) => {
    const a = blueprintAffordances(cs), cost = normalizedCost(blueprintCost(cs)), value = expectedValue(cs, context);
    return [value, value / cost, value * a.durability / cost,
      a.waterCapacity * context.water * context.rainPotential / cost,
      a.foodCapacity * context.foodSurplus * context.food / cost,
      a.irrigation * (1 - context.moisture) * context.food * context.rainPotential / cost];
  };
  const candidate = dimensions(components);
  return candidate[0]! > 0.035 && !known.some(b => {
    const other = dimensions(b.components);
    return other.every((v, i) => v >= candidate[i]!) && other.some((v, i) => v > candidate[i]!);
  });
}

function chooseInvention(world: World, person: Person, context = inventionContext(world, person)): InventionCandidate | undefined {
  const known = knownBlueprints(world, person), raw = candidatesFromKnown(world, person, context, known);
  const candidates = paramsOf(world).construccion.modular ? raw : paretoCandidates(raw);
  const bestKnown = Math.max(0, ...known.map(b => expectedValue(b.components, context)));
  const useful = candidates.filter(candidate => paramsOf(world).construccion.modular
    ? locallyUsefulBlueprint(candidate.components, known, context) : candidate.value > Math.max(0.035, bestKnown * 1.02));
  const valueScale = Math.max(0.001, ...useful.map(c => c.value)), efficiencyScale = Math.max(0.001, ...useful.map(c => c.efficiency));
  const score = (candidate: InventionCandidate) => candidate.value / valueScale * 0.76 + candidate.efficiency / efficiencyScale * 0.16 + candidate.novelty * 0.08;
  return useful.sort((a, b) => score(b) - score(a) || blueprintSignature(a.components).localeCompare(blueprintSignature(b.components)))[0];
}

function expertise(person: Person): number {
  return clamp(((person.activity.build ?? 0) + (person.activity.farm ?? 0) + (person.activity.gather ?? 0)) / 20
    + (person.skills.build ?? 0) + (person.skills.farm ?? 0) + (person.skills.gather ?? 0));
}
export function inventionOpportunity(world: World, person: Person): { score: number; target: Point; reason: string } | undefined {
  if (!world.noveltyEnabled || world.blueprints.length >= blueprintCap(world) || person.materials.wood < 1 || expertise(person) < 0.2
    || world.tick - (person.lastInvention ?? -RESEARCH_COOLDOWN) < RESEARCH_COOLDOWN
    || person.energy < 0.45 || Math.max(person.hunger, person.thirst, person.fatigue) > 0.72) return;
  const context = inventionContext(world, person), need = Math.max(context.water, context.food, context.rest);
  if (need < 0.35 || !chooseInvention(world, person, context)) return;
  return { target: { x: person.x, y: person.y }, score: 0.4 + person.curiosity * 0.25 + expertise(person) * 0.18 + need * 0.22,
    reason: 'Su práctica y una carencia local motivan ensayar otra combinación; el intento cuesta madera y trabajo.' };
}

/** The single debit boundary for research. A completed unsuccessful trial still consumes effort. */
export function invent(world: World, person: Person, emit: Emit): boolean {
  if (!world.noveltyEnabled || person.work < RESEARCH_WORK || person.materials.wood < 1 || expertise(person) < 0.2
    || world.tick - (person.lastInvention ?? -RESEARCH_COOLDOWN) < RESEARCH_COOLDOWN) return false;
  const identity = blueprintIdentity(world); if (!identity) return false;
  person.materials.wood--; person.work -= RESEARCH_WORK; person.lastInvention = world.tick;
  world.inventionDynamics.attempts++;
  const candidate = world.blueprints.length < blueprintCap(world) ? chooseInvention(world, person) : undefined;
  if (!candidate) {
    person.reason = 'El ensayo consumió una madera y sesenta unidades de trabajo; no produjo una receta novedosa y útil.';
    return false;
  }
  const parents = candidate.parents.map(id => world.blueprints.find(b => b.id === id)).filter((b): b is BlueprintView => !!b);
  const blueprint: BlueprintView = { id: identity.id, name: blueprintName(candidate.components), components: candidate.components,
    generation: Math.max(0, ...parents.map(b => b.generation)) + 1, parents: parents.map(b => b.id), inventorId: person.id, tick: world.tick,
    uses: 0, usefulness: 0, cost: blueprintCost(candidate.components) };
  // Intern a remote signature only AFTER the paid local discovery passed its own frontier.
  const existing = paramsOf(world).construccion.modular ? world.blueprints.find(b => blueprintSignature(b.components) === blueprintSignature(candidate.components)) : undefined;
  if (!existing) { world.blueprintCounter = identity.counter; world.blueprints.push(blueprint); }
  person.blueprintId = existing?.id ?? blueprint.id; world.inventionDynamics.accepted++;
  const event = emit({ kind: 'invention', actors: [person.id], x: person.x, y: person.y, source: 'simulation',
    text: `${person.name} ideó ${blueprint.name.toLocaleLowerCase('es')}, generación ${blueprint.generation}.`,
    cause: `Ensayo real: −1 madera y ${RESEARCH_WORK} trabajo; selección Pareto entre combinaciones válidas; receta cultural derivada de ${blueprint.parents.join(', ')}. La utilidad deberá comprobarse al usarla.` });
  person.experiences.push({ tick: world.tick, text: `Diseñó ${blueprint.name}; aún debe construirlo y probarlo.`, causeId: event.id, placeId: '' });
  person.experiences = person.experiences.slice(-8); person.recentMemory = person.experiences.at(-1)!.text;
  return true;
}

/** The single debit boundary for construction. No stock is seeded into the finished building.
 * V16 (`tecnologia.efectosHerramientas`): lashings, carpentry and masonry tools shorten the work the
 * blueprint needs (`constructionWorkFactor`) without changing its materials. The work saved is measured,
 * not assumed: only work the builder really did not spend wears the tools and counts as their benefit. */
export function completeConstruction(world: World, person: Person, tile: Tile, emit: Emit): StructureView | null {
  if (paramsOf(world).construccion.modular) return modularConstruction(world, person, tile, emit);
  const blueprint = selectedBlueprint(world, person), cost = blueprintCost(blueprint.components);
  const tools = toolEffectsEnabled(world), requiredWork = tools ? cost.work * constructionWorkFactor(world, person) : cost.work;
  if (!validBlueprint(blueprint.components) || world.structures.length >= structureCap(world) || tileAt(world, tile) !== tile || distance(person, tile) > 0.5
    || tile.terrain === 'water' || tile.terrain === 'shelter' || algunoCerca(world.places, tile, 6, p => distance(p, tile) < 5)
    || algunoCerca(world.structures, tile, 1, s => s.x === tile.x && s.y === tile.y) || person.work < requiredWork || person.materials.wood < cost.wood || person.materials.stone < cost.stone) return null;
  const identity = nextIdentity(world.structureCounter, 'structure', world.structures.map(s => s.id), world);
  if (!identity) return null;
  const paidWork = tools ? Math.min(person.work, cost.work) : cost.work, savedWork = cost.work - paidWork;
  person.materials.wood -= cost.wood; person.materials.stone -= cost.stone; person.work -= paidWork; world.structureCounter = identity.counter;
  const structure: StructureView = { id: identity.id, x: tile.x, y: tile.y, blueprintId: blueprint.id, name: blueprint.name,
    components: [...blueprint.components], condition: 1, water: 0, food: 0, uses: 0, builtAt: world.tick, builderId: person.id };
  world.structures.push(structure); tile.terrain = 'shelter'; world.settlementCount++;
  installTechnologyItem(world, person, structure);
  const place = { id: `settlement-${tile.x}-${tile.y}`, name: blueprint.name, x: tile.x, y: tile.y,
    description: `Construido por ${person.name}; componentes ${blueprint.components.join(', ')}.`, gatherings: 0 };
  world.places.push(place); world.chunks[chunkKey(tile.x, tile.y)]?.places.push(place);
  if (savedWork > 0) consumeConstructionTools(world, person, savedWork);
  const toolNote = savedWork > 0 ? ` Herramientas de atar, cortar y desbastar ahorraron ${Math.round(savedWork * 10) / 10} de trabajo, con desgaste real.` : '';
  const event = emit({ kind: 'settlement', actors: [person.id], x: tile.x, y: tile.y, source: 'simulation', text: `${person.name} construyó ${blueprint.name.toLocaleLowerCase('es')}.`,
    cause: `Plano ${blueprint.id}; trabajo ${cost.work}; inventario −${cost.wood} madera y −${cost.stone} piedra. Depósitos inicialmente vacíos.${toolNote}` });
  person.experiences.push({ tick: world.tick, text: `Construyó ${blueprint.name}.`, causeId: event.id, placeId: place.id });
  person.experiences = person.experiences.slice(-8); person.recentMemory = person.experiences.at(-1)!.text;
  return structure;
}

function modularConstruction(world: World, person: Person, tile: Tile, emit: Emit): StructureView | null {
  if (tileAt(world, tile) !== tile || distance(person, tile) > 0.5 || tile.terrain === 'water') return null;
  const existing = world.structures.find(s => s.x === tile.x && s.y === tile.y);
  if (existing) return contributeConstruction(world, person, existing, emit) ? existing : null;
  const blueprint = selectedBlueprint(world, person), cost = blueprintCost(blueprint.components);
  if (!validBlueprint(blueprint.components, true) || tile.terrain === 'shelter' || world.structures.length >= structureCap(world)
    || algunoCerca(world.places, tile, 6, p => distance(p, tile) < 5)
    || (person.materials.wood <= 0 && person.materials.stone <= 0 && person.work <= 0)) return null;
  const identity = nextIdentity(world.structureCounter, 'structure', world.structures.map(s => s.id), world);
  if (!identity) return null;
  const structure: StructureView = { id: identity.id, x: tile.x, y: tile.y, blueprintId: blueprint.id, name: blueprint.name,
    components: [...blueprint.components], condition: 0, water: 0, food: 0, uses: 0, builtAt: world.tick, builderId: person.id,
    site: { requiredWood: cost.wood, requiredStone: cost.stone, depositedWood: 0, depositedStone: 0, requiredWork: cost.work, completedWork: 0 } };
  world.structureCounter = identity.counter; world.structures.push(structure);
  contributeConstruction(world, person, structure, emit);
  return structure;
}

/** Only present actors can debit their own carried load and already paid work. */
export function contributeConstruction(world: World, person: Person, structure: StructureView, emit: Emit): boolean {
  const site = structure.site;
  if (!paramsOf(world).construccion.modular || !site || !world.structures.includes(structure) || !world.people.includes(person)
    || distance(person, structure) > 1.5) return false;
  const wood = Math.max(0, Math.min(12, person.materials.wood, site.requiredWood - site.depositedWood));
  const stone = Math.max(0, Math.min(8, person.materials.stone, site.requiredStone - site.depositedStone));
  const work = Math.max(0, Math.min(person.work, site.requiredWork - site.completedWork));
  if (wood + stone + work <= 0) return false;
  person.materials.wood -= wood; person.materials.stone -= stone; person.work -= work;
  site.depositedWood += wood; site.depositedStone += stone; site.completedWork += work;
  installTechnologyItem(world, person, structure);
  if (site.depositedWood < site.requiredWood || site.depositedStone < site.requiredStone || site.completedWork < site.requiredWork) return true;
  delete structure.site; structure.condition = 1; structure.builtAt = world.tick;
  const tile = tileAt(world, structure)!; tile.terrain = 'shelter'; world.settlementCount++;
  const place = { id: `settlement-${tile.x}-${tile.y}`, name: structure.name, x: tile.x, y: tile.y,
    description: `Obra compartida; componentes ${structure.components.join(', ')}.`, gatherings: 0 };
  world.places.push(place); world.chunks[chunkKey(tile.x, tile.y)]?.places.push(place);
  emit({ kind: 'settlement', actors: [person.id], x: tile.x, y: tile.y, source: 'simulation',
    text: `${person.name} terminó ${structure.name.toLocaleLowerCase('es')}.`,
    cause: `Obra material completa: ${site.depositedWood} madera, ${site.depositedStone} piedra y ${site.completedWork} trabajo pagado. Depósitos vacíos.` });
  return true;
}

/** Added volume and protection come only from the condition of real installed products. */
export function structureAffordances(world: World, structure: StructureView) {
  const a = blueprintAffordances(structure.components);
  if (!paramsOf(world).tecnologia.obrasPorPropiedades || !structure.installed?.length) return a;
  const containment = structure.installed.reduce((n, i) => n + i.containment * i.condition * i.mass / 1000, 0);
  return { ...a, waterCapacity: a.waterCapacity * (1 + containment), foodCapacity: a.foodCapacity * (1 + containment) };
}

function installationProtection(world: World, structure: StructureView) {
  let insulation = 0, joining = 0;
  if (paramsOf(world).tecnologia.obrasPorPropiedades) for (const i of structure.installed ?? []) {
    insulation += i.insulation * i.condition * i.mass / 1000;
    joining += i.cohesion * i.binding * i.condition * i.mass / 1000;
  }
  return { insulation, joining };
}

function observeUse(world: World, structure: StructureView, benefit: number): void {
  if (benefit <= 0) return;
  structure.uses++;
  const blueprint = world.blueprints.find(b => b.id === structure.blueprintId);
  if (blueprint) { blueprint.uses++; blueprint.usefulness = clamp(blueprint.usefulness + (clamp(benefit) - blueprint.usefulness) * 0.04); }
}
// Sprint noche-perf 2026-09-22: se descarta primero lo que está a más de `radius + 1` en algún eje (entonces
// `Math.hypot` supera `radius` sin duda de redondeo) y el filtro completo, puro, decide igual que antes sobre
// el resto; el orden de `world.structures` se conserva. Evita un `tileAt` por estructura en cada consulta.
// Sprint noche-perf2: los candidatos salen del índice por casillas (indice-puntos.ts), en el orden del arreglo.
const functionalNear = (world: World, point: Point, radius = 1.5) => filtrarCerca(world.structures, point, radius + 1, s => Math.abs(s.x - point.x) <= radius + 1
  && Math.abs(s.y - point.y) <= radius + 1 && !s.site && s.condition > BROKEN_CONDITION && tileAt(world, s)?.terrain === 'shelter' && distance(s, point) <= radius);
// `foodCapacity = granary·0.7` es positiva exactamente cuando hay algún granero (y `waterCapacity` con alguna cisterna): basta mirar
// el componente, sin construir el recuento ni el objeto de capacidades por estructura.
export function foodAvailable(world: World, person: Point): number { return functionalNear(world, person).reduce((sum, s) => sum + (s.components.includes('granary') ? s.food : 0), 0); }
/** Returns food removed, never also credits inventory. The consumer owns the sole matching credit. */
export function takeFood(world: World, person: Point, requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return 0;
  const member = person as Person;
  let taken = 0;
  for (const structure of functionalNear(world, person).sort((a, b) => distance(person, a) - distance(person, b) || a.id.localeCompare(b.id))) {
    if (!structure.components.includes('granary')) continue;
    const amount = Math.min(structure.food, requested - taken);
    structure.food -= amount; taken += amount; world.inventionDynamics.foodTaken += amount;
    if (esMiembro(world.people, member, world.tick) && member.action === 'eat' && member.hunger > 0) observeUse(world, structure, amount * 10);
    if (taken >= requested) break;
  }
  return taken;
}

/** Perception includes cistern stock directly; keeping water in its reservoir retains provenance. */
export function waterAvailable(world: World, point: Point): number {
  return (tileAt(world, point)?.drinkingWater ?? 0) + functionalNear(world, point, 0.5)
    .reduce((sum, structure) => sum + (structure.components.includes('cistern') ? structure.water : 0), 0);
}

/** Sole drinking debit: use ambient water first, then credit only water delivered by a cistern.
 * The engine applies the matching thirst reduction immediately after this call. */
export function takeWater(world: World, person: Person, requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0 || !esMiembro(world.people, person, world.tick) || person.action !== 'drink'
    || distance(person, person.target) > 0.5 || person.thirst <= 0) return 0;
  const tile = tileAt(world, person); if (!tile) return 0;
  const needed = Math.min(requested, person.thirst / SED_POR_UNIDAD), ambient = Math.min(tile.drinkingWater ?? 0, needed);
  tile.drinkingWater = (tile.drinkingWater ?? 0) - ambient;
  let taken = ambient;
  for (const structure of functionalNear(world, person, 0.5)) {
    if (!structure.components.includes('cistern')) continue;
    const amount = Math.min(structure.water, needed - taken);
    structure.water -= amount; taken += amount;
    observeUse(world, structure, amount * 15);
    if (taken >= needed) break;
  }
  return taken;
}

function restFacility(world: World, person: Person): StructureView | undefined {
  return functionalNear(world, person, 0.5).sort((a, b) => b.condition - a.condition || a.id.localeCompare(b.id))[0];
}
function hearthFuel(world: World, person: Person, structure: StructureView): number {
  return world.weather === 'rain' || world.tick % 2400 >= 1800 ? blueprintAffordances(structure.components).hearths * 0.0005 : 0;
}
export function facilityRestQuality(world: World, person: Person): number {
  const outdoor = world.weather === 'rain' ? 0.2 : 0.55;
  if (!world.shelterBenefitEnabled) return outdoor;
  const structure = restFacility(world, person); if (!structure) return outdoor;
  const a = blueprintAffordances(structure.components), fuel = hearthFuel(world, person, structure);
  return Math.max(outdoor, clamp((a.restQuality + (fuel > 0 && person.materials.wood >= fuel ? 0.12 : 0)) * structure.condition));
}
/** Called after body recovery, with the pre-rest body. Only recovery beyond the outdoor
 * counterfactual is evidence; saturated bodies and degraded roofs cannot earn fictitious utility. */
export function recordFacilityRest(world: World, person: Person, before?: Pick<Person, 'fatigue' | 'energy'>): void {
  if (!world.shelterBenefitEnabled || !before || !Number.isFinite(before.fatigue) || !Number.isFinite(before.energy)
    || before.fatigue < 0 || before.fatigue > 1 || before.energy < 0 || before.energy > 1 || !esMiembro(world.people, person, world.tick)
    || person.action !== 'rest' || distance(person, person.target) > 0.5) return;
  const structure = restFacility(world, person); if (!structure) return;
  const outdoor = world.weather === 'rain' ? 0.2 : 0.55, quality = facilityRestQuality(world, person);
  const energyRate = REST_ENERGY_RATE * clamp((1 - Math.max(person.hunger, person.thirst)) / 0.5);
  const actualFatigue = Math.max(0, Math.min(before.fatigue - person.fatigue, before.fatigue, REST_FATIGUE_RATE * quality));
  const actualEnergy = Math.max(0, Math.min(person.energy - before.energy, 1 - before.energy, energyRate * quality));
  const extra = (counterfactual: number) => Math.max(0, actualFatigue - Math.min(before.fatigue, REST_FATIGUE_RATE * counterfactual))
    + Math.max(0, actualEnergy - Math.min(1 - before.energy, energyRate * counterfactual));
  const benefit = extra(outdoor);
  // Rounding at saturation must not fabricate an incremental benefit.
  if (quality <= outdoor || benefit <= 1e-12) return;
  const fuel = hearthFuel(world, person, structure), unheated = Math.max(outdoor, blueprintAffordances(structure.components).restQuality * structure.condition);
  if (fuel > 0 && person.materials.wood >= fuel && extra(unheated) > 1e-12) person.materials.wood -= fuel;
  observeUse(world, structure, benefit / (REST_FATIGUE_RATE + REST_ENERGY_RATE));
}

export function repairOpportunity(world: World, person: Person): StructureView | undefined {
  if (person.materials.wood < 1) return;
  const options = usefulRepairs(world, person);
  if (!options.length) return;
  const materials = localMaterials(world, person);
  return options.find(option => materials.wood >= option.steps)?.structure;
}
/** V16 (`tecnologia.efectosHerramientas`): lashings (`binding`) and dressed stone (`abrasion`) make the same wood
 * and work restore more condition, +0.25·power per tool up to 1. Each tool pays real wear and is credited
 * exactly the condition it added. Perception (`usefulRepairs`) still plans the bare +0.4 step. */
export function repair(world: World, person: Person, structure: StructureView, emit: Emit): boolean {
  if (!world.structures.includes(structure) || structure.site || structure.condition >= REPAIR_CONDITION_LIMIT || distance(person, structure) > 1.5 || person.materials.wood < 1 || person.work < REPAIR_WORK) return false;
  person.materials.wood--; person.work -= REPAIR_WORK; structure.condition = clamp(structure.condition + 0.4); world.inventionDynamics.repairs++;
  let toolGain = 0;
  if (toolEffectsEnabled(world)) for (const capability of ['binding', 'abrasion'] as const) {
    if (structure.condition >= 1) break;
    const receipt = useTool(world, person, capability, 0.7);
    if (!receipt) continue;
    const before = structure.condition;
    structure.condition = clamp(before + 0.25 * receipt.power); toolGain += structure.condition - before;
    recordTechnologyBenefit(world, person, receipt, structure.condition - before);
  }
  const toolNote = toolGain > 0 ? ` Ataduras y piedra desbastada sumaron +${Math.round(toolGain * 1000) / 1000} de condición, con desgaste real.` : '';
  installTechnologyItem(world, person, structure);
  emit({ kind: 'invention', actors: [person.id], x: structure.x, y: structure.y, source: 'simulation', text: `${person.name} reparó ${structure.name.toLocaleLowerCase('es')}.`,
    cause: `Mantenimiento real: −1 madera y ${REPAIR_WORK} trabajo; condición +0,4 hasta un máximo de 1.${toolNote}` });
  return true;
}

/** Bounded active structures only. Inflow, transfers and irrigation all have explicit debits. */
export function stepStructures(world: World, _emit: Emit): void {
  if (world.tick % INTERVALO_ECOLOGIA_TICKS !== 0) return;
  for (const structure of world.structures) {
    if (structure.site) continue;
    const tile = tileAt(world, structure); if (!tile || tile.terrain !== 'shelter') continue;
    const a = structureAffordances(world, structure), protection = installationProtection(world, structure);
    const wear = (world.weather === 'rain' ? 0.00028 : 0.00018) / a.durability;
    structure.condition = clamp(structure.condition - (paramsOf(world).tecnologia.obrasPorPropiedades ? wear / (1 + protection.joining) : wear));
    if (paramsOf(world).tecnologia.obrasPorPropiedades) {
      // Exposure consumes condition, never material quanta. Failed liners retain their matter.
      for (const i of structure.installed ?? []) i.condition = clamp(i.condition - wear);
      const capacity = structureAffordances(world, structure);
      // Overflow and exposure losses cannot turn into a credited use.
      const beforeWater = structure.water, beforeFood = structure.food;
      structure.water = Math.min(structure.water, capacity.waterCapacity);
      structure.food = Math.min(structure.food, capacity.foodCapacity);
      structure.water -= structure.water * 0.002 / (1 + protection.insulation);
      structure.food -= structure.food * 0.001 / (1 + protection.insulation);
      const losses = structure.losses ??= { water: 0, food: 0 };
      losses.water += beforeWater - structure.water; losses.food += beforeFood - structure.food;
      a.waterCapacity = capacity.waterCapacity; a.foodCapacity = capacity.foodCapacity;
    }
    if (structure.condition <= BROKEN_CONDITION) continue;
    if (world.weather === 'rain' && a.waterCapacity > 0) {
      const collected = Math.min(a.waterCapacity - structure.water, a.catchment * structure.condition);
      structure.water += Math.max(0, collected); world.inventionDynamics.waterCollected += Math.max(0, collected);
    }
    // Production remains stock. Only an actual consumer may turn supply into observed utility.
    if (a.irrigation > 0 && structure.water > 0) {
      const gardens = [[0, -1], [-1, 0], [1, 0], [0, 1]].map(([dx, dy]) => tileAt(world, { x: structure.x + dx!, y: structure.y + dy! }))
        .filter((t): t is Tile => !!t && t.terrain !== 'water' && t.terrain !== 'shelter' && t.moisture < 0.75);
      let budget = Math.min(structure.water, a.irrigation * structure.condition);
      for (const [index, garden] of gardens.entries()) {
        const amount = Math.min(budget / (gardens.length - index), 0.75 - garden.moisture);
        garden.moisture += amount; structure.water -= amount; budget -= amount;
      }
    }
    if (a.foodCapacity > 0) for (const person of vecinos(world, structure, 2.5,
      person => !(distance(person, structure) > 1.5 || person.hunger >= 0.5 || person.inventory <= 0.12))) {
      const deposited = Math.max(0, Math.min(person.inventory - 0.12, a.foodCapacity - structure.food, 0.012));
      person.inventory -= deposited; structure.food += deposited; world.inventionDynamics.foodStored += deposited;
    }
  }
  if (world.tick % 60 === 0 && world.learningEnabled) for (const person of world.people) {
    // El único efecto es la asignación de abajo, que exige `action !== 'build'` y otro plano mejor: quien construye, o sólo
    // conoce su propio plano (o ninguno), no cambia; se evita entonces calcular el contexto local, que es lo más caro.
    if (person.action === 'build') continue;
    const current = selectedBlueprint(world, person), candidates = knownBlueprints(world, person);
    if (candidates.length === 0 || (candidates.length === 1 && candidates[0]!.id === current.id)) continue;
    const context = inventionContext(world, person);
    const value = (b: BlueprintView) => paramsOf(world).construccion.modular ? expectedValue(b.components, context)
      : expectedValue(b.components, context) + b.usefulness * 0.12;
    const observed = candidates.map(blueprint => ({ blueprint, value: value(blueprint) }))
      .sort((a, b) => b.value - a.value || a.blueprint.id.localeCompare(b.blueprint.id))[0];
    if (observed && observed.blueprint.id !== current.id && observed.value > value(current) + 0.025) person.blueprintId = observed.blueprint.id;
  }
}
