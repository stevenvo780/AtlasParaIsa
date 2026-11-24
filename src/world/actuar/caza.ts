import type { Person, World } from '../mundo/tipos.js';
import { distance, clamp, type TileLookup } from '../mundo/geometria.js';
import { workEffort, performWork } from './trabajo.js';
import { outcome } from '../decision/personas.js';
import { type ElementVector, evaluateMaterialProperties, type CompoundLot, vectorMass } from '../../shared/chemistry.js';
import { type Animal, isHerdAnimal, animalesVivosEnCelda } from '../animals.js';
import { defaultChemistryState, formulaSignature, MAX_PERSON_COMPOUNDS, applyChemOperator } from '../chemistry.js';
import { exertBody, assimilateFood } from '../body.js';
import { HAMBRE_POR_UNIDAD } from '../ecologia-constantes.js';
import { count } from '../statistics.js';

export const HUNT_ORGANIC: ElementVector = { C: 0.48, H: 0.28, Ca: 0.16, S: 0.05, Si: 0.02, Fe: 0.01 };

const TEND_ORGANIC: ElementVector = { C: 0.56, H: 0.34, Ca: 0.06, S: 0.04, Si: 0, Fe: 0 };

export const huntable = (a: Animal, hunger: number): boolean => (a.habituation ?? 0) < 0.45 || hunger > 0.78;


/** The same physical work estimate is used by planning and paid execution. */
export function huntWorkDuration(person: Person, prey: Animal): number {
  let weapon = 0;
  if (person.compounds) for (const lot of person.compounds) if (lot.mass >= 0.05) {
    const p = evaluateMaterialProperties(lot.composition, lot.phase);
    weapon = Math.max(weapon, p.hardness * p.toughness);
  }
  for (const item of person.technology.items) if (item.mass > 0) {
    const p = item.properties;
    weapon = Math.max(weapon, p.hardness * p.toughness * p.edge);
  }
  const base = Math.max(10, Math.min(34, Math.round(14 + prey.genes.speed * 12 + (prey.morphology?.caution ?? 0.5) * 10 - weapon * 10)));
  return Math.max(6, Math.ceil(base * (1 - (person.skills.hunt ?? 0) * 0.3)));
}

export function trackedPrey(animals: readonly Animal[], person: Person): Animal | undefined {
  return animals.find(a => a.id === person.huntingPreyId && a.health > 0 && distance(a, person) <= 7 && huntable(a, person.hunger));
}

export function canTend(a: Animal, person: Person, tick: number): boolean {
  return isHerdAnimal(a) && a.health > 0 && (a.habituation ?? 0) >= 0.45 && a.hunger < 0.45 && a.energy > 0.35
    && (a.lastTended === undefined || tick - a.lastTended >= 480)
    && (a.lastHunted === undefined || tick - a.lastHunted >= 120) && distance(a, person) <= 2;
}

function tendingAnimal(world: World, person: Person): Animal | undefined {
  let best: Animal | undefined;
  // Serial action phase: reuse the existing live fauna grid, with a two-cell
  // neighborhood. The linear fallback also supports callers outside stepWorld.
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    if (Math.abs(dx) + Math.abs(dy) > 2) continue;
    const nearby = animalesVivosEnCelda(world, person.x + dx, person.y + dy);
    if (nearby === undefined) {
      const animals = world.animals;
      for (const a of animals) if (canTend(a, person, world.tick) && (!best || a.id < best.id)) best = a;
      return best;
    }
    for (const a of nearby) if (canTend(a, person, world.tick) && (!best || a.id < best.id)) best = a;
  }
  return best;
}

/** Organic matter is transferred from a carcass or a paid animal reserve, never
 * extracted from geology. Raw lots use provenance signatures just like geo lots. */
export function organicLot(world: World, person: Person, mass: number, recipe: ElementVector): void {
  const state = world.chemistry ?? (world.chemistry = defaultChemistryState());
  const composition: ElementVector = { C: recipe.C * mass, H: recipe.H * mass, Ca: recipe.Ca * mass, S: recipe.S * mass, Si: recipe.Si * mass, Fe: recipe.Fe * mass };
  const lot: CompoundLot = { id: `L${++state.lotCounter}`, formulaId: `bio:${formulaSignature('raw', composition)}`,
    composition, mass: vectorMass(composition), phase: 'raw', properties: evaluateMaterialProperties(composition, 'raw') };
  const lots = person.compounds ?? (person.compounds = []);
  if (lots.length >= MAX_PERSON_COMPOUNDS) {
    const b = lots.pop()!, a = lots.pop()!;
    lots.push(applyChemOperator('bind', a, { b, temperatureTier: 0, tick: world.tick, actorId: person.id }, state).product);
  }
  lots.push(lot);
}

export function tendNearbyAnimal(world: World, person: Person): boolean {
  if (person.action !== 'forage' && person.action !== 'cooperate' && person.action !== 'share') { delete person.tending; return false; }
  const animal = tendingAnimal(world, person);
  if (!animal) { delete person.tending; return false; }
  if (person.tending?.id !== animal.id) person.tending = { id: animal.id, work: 0 };
  exertBody(person, workEffort(person));
  person.tending.work++;
  person.reason = 'Cuida un animal habituado y recoge una porción renovable de alimento y fibra.';
  if (person.tending.work < 6) return true;
  const size = animal.morphology?.size ?? 0.5, coat = animal.morphology?.coat ?? 0.5;
  const food = 0.08 + size * 0.06, fiber = (0.012 + coat * 0.028) * (0.75 + size * 0.65);
  // Renewable output consumes body reserves; grazing must replenish them before
  // another harvest. A cooldown belongs to the animal, shared by all inhabitants.
  animal.hunger = clamp(animal.hunger + (food + fiber) * 4);
  animal.energy = clamp(animal.energy - (food + fiber) * 0.5);
  animal.lastTended = world.tick; animal.tends = (animal.tends ?? 0) + 1;
  animal.habituation = clamp((animal.habituation ?? 0) + 0.06);
  const stored = Math.min(Math.max(0, 0.25 - person.inventory), food);
  person.inventory += stored;
  assimilateFood(person, food - stored, { hungerPerUnit: HAMBRE_POR_UNIDAD, energyPerUnit: 0 });
  organicLot(world, person, fiber, TEND_ORGANIC); count(world, 'foodHarvested', food);
  outcome(world, person, person.action, 0.14, true);
  delete person.tending; person.work = 0; person.decisionAt = world.tick + 1;
  return true;
}


export function trackHuntingPrey(world: World, person: Person): void {
  const prey = trackedPrey(world.animals, person);
  if (prey) person.target = { x: prey.x, y: prey.y };
  else { delete person.huntingPreyId; person.work = 0; person.decisionAt = world.tick; }
}


export function pursuePrey(world: World, person: Person, tileIn: TileLookup): void {
  const prey = trackedPrey(world.animals, person);
  if (prey && distance(person, prey) <= 1.5) {
    const preyTile = tileIn(prey.x, prey.y);
    if (preyTile) performWork(world, person, preyTile);
  }
}
