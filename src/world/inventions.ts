import type { BlueprintView, StructureComponent, StructureView } from '../shared/life.js';
import type { ChronicleEvent, Tile } from '../shared/types.js';
import type { Person, World } from './index.js';
import { localRandom } from './genetics.js';
import { tileAt } from './spatial.js';
import { chunkKey } from './terrain.js';

type Emit = (event: Omit<ChronicleEvent, 'id' | 'tick'>) => ChronicleEvent;
type Point = { x: number; y: number };
export const MAX_BLUEPRINTS = 64;
export const MAX_STRUCTURES = 512;
export const RESEARCH_WORK = 60;
export const REPAIR_WORK = 30;
export const RESEARCH_COOLDOWN = 1200;
export const BROKEN_CONDITION = 0.1;
export const REST_FATIGUE_RATE = 0.0018;
export const REST_ENERGY_RATE = 0.0011;
export const COMPONENTS: readonly StructureComponent[] = ['frame', 'roof', 'cistern', 'granary', 'garden', 'hearth'];
const COSTS: Record<StructureComponent, BlueprintView['cost']> = {
  frame: { wood: 2, stone: 1, work: 20 }, roof: { wood: 4, stone: 2, work: 70 },
  cistern: { wood: 2, stone: 3, work: 40 }, granary: { wood: 3, stone: 1, work: 35 },
  garden: { wood: 2, stone: 1, work: 30 }, hearth: { wood: 1, stone: 2, work: 30 },
};
const clamp = (value: number, maximum = 1) => Math.max(0, Math.min(maximum, value));
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const counts = (components: readonly StructureComponent[]) => Object.fromEntries(COMPONENTS.map(component => [component, components.filter(c => c === component).length])) as Record<StructureComponent, number>;
const canonical = (components: readonly StructureComponent[]) => COMPONENTS.flatMap(component => components.filter(c => c === component));
export const blueprintSignature = (components: readonly StructureComponent[]): string => COMPONENTS.map(component => components.filter(c => c === component).length).join(':');

export function blueprintCost(components: readonly StructureComponent[]): BlueprintView['cost'] {
  return components.reduce((cost, component) => ({ wood: cost.wood + COSTS[component].wood, stone: cost.stone + COSTS[component].stone, work: cost.work + COSTS[component].work }), { wood: 0, stone: 0, work: 0 });
}

/** A roof needs a frame; enclosed storage needs a roof; gardens need captured water.
 * Repetition is structural: extra frames support roofs and slow wear, extra modules add capacity. */
export function validBlueprint(components: unknown): components is StructureComponent[] {
  if (!Array.isArray(components) || components.length < 2 || components.length > 8 || !components.every(component => COMPONENTS.includes(component))) return false;
  const n = counts(components), cost = blueprintCost(components);
  return n.frame >= 1 && n.frame <= 2 && n.roof >= 1 && n.roof <= n.frame
    && n.cistern <= 2 && n.granary <= 2 && n.garden <= 2 && n.hearth <= 1
    && (n.garden === 0 || n.cistern > 0) && components.length - n.frame - n.roof <= n.frame * 4
    && cost.wood <= 12 && cost.stone <= 8;
}

export function blueprintAffordances(components: readonly StructureComponent[]) {
  const n = counts(components);
  return { waterCapacity: n.cistern * 0.6, foodCapacity: n.granary * 0.7,
    catchment: n.cistern ? n.roof * 0.012 : 0, irrigation: n.garden * 0.008,
    restQuality: clamp(0.82 + (n.roof - 1) * 0.09 + (n.frame - 1) * 0.03),
    hearths: n.hearth, durability: 1 + (n.frame - 1) * 0.5 };
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
function nextIdentity(counter: number, prefix: 'blueprint' | 'structure', ids: readonly string[]): { id: string; counter: number } | undefined {
  if (!Number.isSafeInteger(counter) || counter < 0) return;
  let largest = counter;
  for (const id of ids) {
    if (!id.startsWith(`${prefix}-`)) continue;
    const suffix = id.slice(prefix.length + 1); if (!/^\d+$/.test(suffix)) continue;
    const reserved = Number(suffix); if (!Number.isSafeInteger(reserved)) return;
    largest = Math.max(largest, reserved);
  }
  if (largest >= Number.MAX_SAFE_INTEGER) return;
  return { id: `${prefix}-${largest + 1}`, counter: largest + 1 };
}

function blueprintIdentity(world: World) {
  return nextIdentity(world.blueprintCounter, 'blueprint', [...world.blueprints.map(b => b.id), ...world.blueprints.flatMap(b => b.parents),
    ...world.structures.map(s => s.blueprintId), ...world.retiredChunks.flatMap(chunk => (chunk.structures ?? []).map(s => s.blueprintId))]);
}

function selectedBlueprint(world: World, person: Person): BlueprintView {
  return world.blueprints.find(b => b.id === person.blueprintId && validBlueprint(b.components)) ?? world.blueprints.find(b => b.id === 'blueprint-base') ?? defaultBlueprint();
}
export function constructionCost(world: World, person: Person): BlueprintView['cost'] { return blueprintCost(selectedBlueprint(world, person).components); }

export interface InventionContext { water: number; food: number; rest: number; rainPotential: number; foodSurplus: number; moisture: number; cold: number; fuel: number; }
/** Perceived local deficits, not global resource omniscience or invented weather history.
 * rainPotential is explicitly a soil/biome prior; only actual rain can fill a built cistern. */
export function inventionContext(world: World, person: Person): InventionContext {
  const nearby: Tile[] = [];
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    if (dx * dx + dy * dy > 16) continue;
    const tile = tileAt(world, { x: person.x + dx, y: person.y + dy });
    if (tile && tile.terrain !== 'water') nearby.push(tile);
  }
  const average = (get: (tile: Tile) => number) => nearby.reduce((sum, tile) => sum + get(tile), 0) / Math.max(1, nearby.length);
  const moisture = average(tile => tile.moisture), food = average(tile => tile.food);
  const portable = world.people.filter(p => distance(person, p) <= 4).reduce((sum, p) => sum + Math.max(0, p.inventory - 0.08), 0);
  const reserve = Math.max(0, ...nearby.map(tile => tile.drinkingWater ?? 0));
  const roofs = world.structures.filter(s => distance(person, s) <= 4 && s.condition > BROKEN_CONDITION && tileAt(world, s)?.terrain === 'shelter');
  const quality = Math.max(0, ...roofs.map(s => blueprintAffordances(s.components).restQuality * s.condition));
  return { water: clamp(0.65 * (1 - clamp(reserve * 5)) + person.thirst * 0.35),
    food: clamp(0.65 * (1 - clamp(food * 4)) + person.hunger * 0.35),
    rest: clamp((1 - quality) * 0.6 + person.fatigue * 0.4),
    rainPotential: world.weather === 'rain' ? 1 : clamp(0.15 + moisture * 0.55),
    foodSurplus: clamp(portable * 2 + food * 2), moisture,
    cold: world.weather === 'rain' || world.tick % 2400 >= 1800 ? 1 : 0.15,
    fuel: clamp((person.materials.wood + average(tile => tile.wood ?? 0)) / 4) };
}

/** Cultural parents must be known through ownership, nearby built examples, or trusted contacts. */
function knownBlueprints(world: World, person: Person): BlueprintView[] {
  const ids = new Set(['blueprint-base', person.blueprintId]);
  for (const structure of world.structures) if (distance(person, structure) <= 5 && structure.condition > BROKEN_CONDITION && tileAt(world, structure)?.terrain === 'shelter') ids.add(structure.blueprintId);
  if (world.cooperationEnabled) for (const other of world.people) {
    if (other !== person && distance(person, other) <= 3 && (person.bonds[other.id] ?? 0.2) >= 0.2 && person.culture.openness >= 0.15) ids.add(other.blueprintId);
  }
  return world.blueprints.filter(b => (ids.has(b.id) || b.inventorId === person.id) && validBlueprint(b.components));
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
  const context = inventionContext(world, person), known = knownBlueprints(world, person);
  if (!known.length) known.push(defaultBlueprint());
  known.sort((a, b) => expectedValue(b.components, context) + b.usefulness * 0.1 - expectedValue(a.components, context) - a.usefulness * 0.1 || a.id.localeCompare(b.id));
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
  for (let slot = 6; slot < 12; slot++) {
    const a = known[Math.floor(random() * Math.min(4, known.length))]!, b = known[Math.floor(random() * known.length)]!;
    if (slot < 9 && a.id !== b.id) {
      const ac = counts(a.components), bc = counts(b.components);
      const components = COMPONENTS.flatMap(component => Array.from({ length: random() < 0.5 ? ac[component] : bc[component] }, () => component));
      push(components, [a.id, b.id]);
    } else {
      const components = [...a.components], component = COMPONENTS[2 + Math.floor(random() * 4)]!;
      if (slot % 3 === 0 && components.length > 2) components.splice(2 + Math.floor(random() * (components.length - 2)), 1);
      else if (slot % 3 === 1 && components.length > 2) components[2 + Math.floor(random() * (components.length - 2))] = component;
      else components.push(component);
      push(components, [a.id]);
    }
  }
  const seen = new Set(world.blueprints.map(b => blueprintSignature(b.components))), candidates: InventionCandidate[] = [];
  for (const child of raw) {
    if (!validBlueprint(child.components)) continue;
    const signature = blueprintSignature(child.components); if (seen.has(signature)) continue; seen.add(signature);
    const value = expectedValue(child.components, context);
    candidates.push({ ...child, value, efficiency: value / normalizedCost(blueprintCost(child.components)),
      novelty: Math.min(...world.blueprints.map(b => genotypeDistance(child.components, b.components)), 8) / 8 });
  }
  return candidates;
}

export function paretoCandidates(candidates: readonly InventionCandidate[]): InventionCandidate[] {
  return candidates.filter(candidate => !candidates.some(other => other !== candidate
    && other.value >= candidate.value && other.efficiency >= candidate.efficiency && other.novelty >= candidate.novelty
    && (other.value > candidate.value || other.efficiency > candidate.efficiency || other.novelty > candidate.novelty)));
}

function chooseInvention(world: World, person: Person): InventionCandidate | undefined {
  const context = inventionContext(world, person), candidates = paretoCandidates(inventionCandidates(world, person));
  const bestKnown = Math.max(0, ...knownBlueprints(world, person).map(b => expectedValue(b.components, context)));
  const useful = candidates.filter(candidate => candidate.value > Math.max(0.035, bestKnown * 1.02));
  const valueScale = Math.max(0.001, ...useful.map(c => c.value)), efficiencyScale = Math.max(0.001, ...useful.map(c => c.efficiency));
  const score = (candidate: InventionCandidate) => candidate.value / valueScale * 0.76 + candidate.efficiency / efficiencyScale * 0.16 + candidate.novelty * 0.08;
  return useful.sort((a, b) => score(b) - score(a) || blueprintSignature(a.components).localeCompare(blueprintSignature(b.components)))[0];
}

function expertise(person: Person): number {
  return clamp(((person.activity.build ?? 0) + (person.activity.farm ?? 0) + (person.activity.gather ?? 0)) / 20
    + (person.skills.build ?? 0) + (person.skills.farm ?? 0) + (person.skills.gather ?? 0));
}
export function inventionOpportunity(world: World, person: Person): { score: number; target: Point; reason: string } | undefined {
  if (!world.noveltyEnabled || world.blueprints.length >= MAX_BLUEPRINTS || person.materials.wood < 1 || expertise(person) < 0.2
    || world.tick - (person.lastInvention ?? -RESEARCH_COOLDOWN) < RESEARCH_COOLDOWN
    || person.energy < 0.45 || Math.max(person.hunger, person.thirst, person.fatigue) > 0.72) return;
  const context = inventionContext(world, person), need = Math.max(context.water, context.food, context.rest);
  if (need < 0.35 || !chooseInvention(world, person)) return;
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
  const candidate = world.blueprints.length < MAX_BLUEPRINTS ? chooseInvention(world, person) : undefined;
  if (!candidate) {
    person.reason = 'El ensayo consumió una madera y sesenta unidades de trabajo; no produjo una receta novedosa y útil.';
    return false;
  }
  const parents = candidate.parents.map(id => world.blueprints.find(b => b.id === id)).filter((b): b is BlueprintView => !!b);
  const blueprint: BlueprintView = { id: identity.id, name: blueprintName(candidate.components), components: candidate.components,
    generation: Math.max(0, ...parents.map(b => b.generation)) + 1, parents: parents.map(b => b.id), inventorId: person.id, tick: world.tick,
    uses: 0, usefulness: 0, cost: blueprintCost(candidate.components) };
  world.blueprintCounter = identity.counter; world.blueprints.push(blueprint); person.blueprintId = blueprint.id; world.inventionDynamics.accepted++;
  const event = emit({ kind: 'invention', actors: [person.id], x: person.x, y: person.y, source: 'simulation',
    text: `${person.name} ideó ${blueprint.name.toLocaleLowerCase('es')}, generación ${blueprint.generation}.`,
    cause: `Ensayo real: −1 madera y ${RESEARCH_WORK} trabajo; selección Pareto entre combinaciones válidas; receta cultural derivada de ${blueprint.parents.join(', ')}. La utilidad deberá comprobarse al usarla.` });
  person.experiences.push({ tick: world.tick, text: `Diseñó ${blueprint.name}; aún debe construirlo y probarlo.`, causeId: event.id, placeId: '' });
  person.experiences = person.experiences.slice(-8); person.recentMemory = person.experiences.at(-1)!.text;
  return true;
}

/** The single debit boundary for construction. No stock is seeded into the finished building. */
export function completeConstruction(world: World, person: Person, tile: Tile, emit: Emit): StructureView | null {
  const blueprint = selectedBlueprint(world, person), cost = blueprintCost(blueprint.components);
  if (!validBlueprint(blueprint.components) || world.structures.length >= MAX_STRUCTURES || tileAt(world, tile) !== tile || distance(person, tile) > 0.5
    || tile.terrain === 'water' || tile.terrain === 'shelter' || world.places.some(p => distance(p, tile) < 5)
    || world.structures.some(s => s.x === tile.x && s.y === tile.y) || person.work < cost.work || person.materials.wood < cost.wood || person.materials.stone < cost.stone) return null;
  const identity = nextIdentity(world.structureCounter, 'structure', [...world.structures.map(s => s.id), ...world.retiredChunks.flatMap(chunk => (chunk.structures ?? []).map(s => s.id))]);
  if (!identity) return null;
  person.materials.wood -= cost.wood; person.materials.stone -= cost.stone; person.work -= cost.work; world.structureCounter = identity.counter;
  const structure: StructureView = { id: identity.id, x: tile.x, y: tile.y, blueprintId: blueprint.id, name: blueprint.name,
    components: [...blueprint.components], condition: 1, water: 0, food: 0, uses: 0, builtAt: world.tick, builderId: person.id };
  world.structures.push(structure); tile.terrain = 'shelter'; world.settlementCount++;
  const place = { id: `settlement-${tile.x}-${tile.y}`, name: blueprint.name, x: tile.x, y: tile.y,
    description: `Construido por ${person.name}; componentes ${blueprint.components.join(', ')}.`, gatherings: 0 };
  world.places.push(place); world.chunks[chunkKey(tile.x, tile.y)]?.places.push(place);
  const event = emit({ kind: 'settlement', actors: [person.id], x: tile.x, y: tile.y, source: 'simulation', text: `${person.name} construyó ${blueprint.name.toLocaleLowerCase('es')}.`,
    cause: `Plano ${blueprint.id}; trabajo ${cost.work}; inventario −${cost.wood} madera y −${cost.stone} piedra. Depósitos inicialmente vacíos.` });
  person.experiences.push({ tick: world.tick, text: `Construyó ${blueprint.name}.`, causeId: event.id, placeId: place.id });
  person.experiences = person.experiences.slice(-8); person.recentMemory = person.experiences.at(-1)!.text;
  return structure;
}

function observeUse(world: World, structure: StructureView, benefit: number): void {
  if (benefit <= 0) return;
  structure.uses++;
  const blueprint = world.blueprints.find(b => b.id === structure.blueprintId);
  if (blueprint) { blueprint.uses++; blueprint.usefulness = clamp(blueprint.usefulness + (clamp(benefit) - blueprint.usefulness) * 0.04); }
}
const functionalNear = (world: World, point: Point, radius = 1.5) => world.structures.filter(s => s.condition > BROKEN_CONDITION && tileAt(world, s)?.terrain === 'shelter' && distance(s, point) <= radius);
export function foodAvailable(world: World, person: Point): number { return functionalNear(world, person).reduce((sum, s) => sum + (blueprintAffordances(s.components).foodCapacity ? s.food : 0), 0); }
/** Returns food removed, never also credits inventory. The consumer owns the sole matching credit. */
export function takeFood(world: World, person: Point, requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return 0;
  let taken = 0;
  for (const structure of functionalNear(world, person).sort((a, b) => distance(person, a) - distance(person, b) || a.id.localeCompare(b.id))) {
    if (!blueprintAffordances(structure.components).foodCapacity) continue;
    const amount = Math.min(structure.food, requested - taken);
    structure.food -= amount; taken += amount; world.inventionDynamics.foodTaken += amount;
    if (world.people.some(p => p === person && p.action === 'eat' && p.hunger > 0)) observeUse(world, structure, amount * 10);
    if (taken >= requested) break;
  }
  return taken;
}

/** Perception includes cistern stock directly; keeping water in its reservoir retains provenance. */
export function waterAvailable(world: World, point: Point): number {
  return (tileAt(world, point)?.drinkingWater ?? 0) + functionalNear(world, point, 0.5)
    .reduce((sum, structure) => sum + (blueprintAffordances(structure.components).waterCapacity > 0 ? structure.water : 0), 0);
}

/** Sole drinking debit: use ambient water first, then credit only water delivered by a cistern.
 * The engine applies the matching thirst reduction immediately after this call. */
export function takeWater(world: World, person: Person, requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0 || !world.people.includes(person) || person.action !== 'drink'
    || distance(person, person.target) > 0.5 || person.thirst <= 0) return 0;
  const tile = tileAt(world, person); if (!tile) return 0;
  const needed = Math.min(requested, person.thirst / 3), ambient = Math.min(tile.drinkingWater ?? 0, needed);
  tile.drinkingWater = (tile.drinkingWater ?? 0) - ambient;
  let taken = ambient;
  for (const structure of functionalNear(world, person, 0.5)) {
    if (blueprintAffordances(structure.components).waterCapacity <= 0) continue;
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
    || before.fatigue < 0 || before.fatigue > 1 || before.energy < 0 || before.energy > 1 || !world.people.includes(person)
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
  return world.structures.filter(s => s.condition < 0.6 && distance(person, s) <= 5)
    .sort((a, b) => a.condition - b.condition || distance(person, a) - distance(person, b) || a.id.localeCompare(b.id))[0];
}
export function repair(world: World, person: Person, structure: StructureView, emit: Emit): boolean {
  if (!world.structures.includes(structure) || structure.condition >= 0.95 || distance(person, structure) > 1.5 || person.materials.wood < 1 || person.work < REPAIR_WORK) return false;
  person.materials.wood--; person.work -= REPAIR_WORK; structure.condition = clamp(structure.condition + 0.4); world.inventionDynamics.repairs++;
  emit({ kind: 'invention', actors: [person.id], x: structure.x, y: structure.y, source: 'simulation', text: `${person.name} reparó ${structure.name.toLocaleLowerCase('es')}.`,
    cause: `Mantenimiento real: −1 madera y ${REPAIR_WORK} trabajo; condición +0,4 hasta un máximo de 1.` });
  return true;
}

/** Bounded active structures only. Inflow, transfers and irrigation all have explicit debits. */
export function stepStructures(world: World, _emit: Emit): void {
  if (world.tick % 10 !== 0) return;
  for (const structure of world.structures) {
    const tile = tileAt(world, structure); if (!tile || tile.terrain !== 'shelter') continue;
    const a = blueprintAffordances(structure.components);
    structure.condition = clamp(structure.condition - (world.weather === 'rain' ? 0.00028 : 0.00018) / a.durability);
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
    if (a.foodCapacity > 0) for (const person of world.people) {
      if (distance(person, structure) > 1.5 || person.hunger >= 0.5 || person.inventory <= 0.12) continue;
      const deposited = Math.max(0, Math.min(person.inventory - 0.12, a.foodCapacity - structure.food, 0.012));
      person.inventory -= deposited; structure.food += deposited; world.inventionDynamics.foodStored += deposited;
    }
  }
  if (world.tick % 60 === 0 && world.learningEnabled) for (const person of world.people) {
    const context = inventionContext(world, person), current = selectedBlueprint(world, person);
    const value = (b: BlueprintView) => expectedValue(b.components, context) + b.usefulness * 0.12;
    const observed = knownBlueprints(world, person).sort((a, b) => value(b) - value(a) || a.id.localeCompare(b.id))[0];
    if (observed && observed.id !== current.id && value(observed) > value(current) + 0.025 && person.action !== 'build') person.blueprintId = observed.id;
  }
}
