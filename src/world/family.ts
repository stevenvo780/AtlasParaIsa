import type { Person, World } from './index.js';
import { demographicTraits, updateDemography } from './demography.js';
import { localRandom } from './genetics.js';
import { paramsOf } from './params.js';

export const FAMILY_RESERVE_TARGET = 0.12;
const SHARE_AMOUNT = 0.025;
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** Direct parent/child or siblings sharing either parent. Founders with empty `parents` are never kin this way. */
export function closeKin(a: Person, b: Person): boolean {
  if (a.genome.parents.includes(b.id) || b.genome.parents.includes(a.id)) return true;
  return a.genome.parents.length > 0 && b.genome.parents.length > 0 && a.genome.parents.some(id => b.genome.parents.includes(id));
}

/** Higher is closer and more mutually trusted. Eligible pairs already sit within 3 cells. */
export function pairAffinity(a: Person, b: Person): number {
  return (1 - distance(a, b) / 3) + ((a.bonds[b.id] ?? 0) + (b.bonds[a.id] ?? 0)) / 2;
}

export function pairTie(world: Pick<World, 'seed' | 'tick'>, a: Person, b: Person): number {
  const lo = a.id < b.id ? a.id : b.id, hi = a.id < b.id ? b.id : a.id;
  return localRandom(world.seed, `reproduce:${world.tick}:${lo}:${hi}`)();
}

/** `byAffinity=false` keeps insertion order (first of `candidates`). Ties break with `localRandom`. */
export function chooseReproductivePartner(world: Pick<World, 'seed' | 'tick'>, person: Person, candidates: Person[], byAffinity = true): Person | undefined {
  if (!candidates.length) return undefined;
  if (!byAffinity) return candidates[0];
  let best: Person | undefined, bestScore = -Infinity, bestTie = -Infinity;
  for (const other of candidates) {
    const score = pairAffinity(person, other), tie = pairTie(world, person, other);
    if (!best || score > bestScore || (score === bestScore && (tie > bestTie || (tie === bestTie && other.id < best.id)))) {
      best = other; bestScore = score; bestTie = tie;
    }
  }
  return best;
}

/** The existing physiological/cooldown gate, without its separate portable-food requirement.
 * dt=0 queries the same demographic model without advancing age or recovering the body. */
export function reproductiveReadiness(world: World, person: Person): boolean {
  if (person.role !== 'neighbor') return false;
  const traits = demographicTraits(person.genome, paramsOf(world).cuerpo);
  if (world.tick - person.lastBirth < traits.fertilityCooldown) return false;
  return updateDemography({ state: person.demography, traits, hunger: person.hunger, thirst: person.thirst,
    energy: person.energy, fatigue: person.fatigue }, { exposure: 0, shelter: 0, protected: false }, 0).offspringEligible;
}

export interface FamilyOpportunity { partner: Person; reserveTarget: number; }

/** One decision's visible workers, preserving their order within each physical cell. */
export function observedForagersByCell(people: readonly Person[]): Map<string, Person[]> {
  const cells = new Map<string, Person[]>();
  for (const person of people) {
    if (person.action !== 'forage') continue;
    const key = `${person.x},${person.y}`, group = cells.get(key);
    if (group) group.push(person); else cells.set(key, [person]);
  }
  return cells;
}

/** Local prediction only: it grants no ownership, stock or knowledge of the next choice. */
export function earlierForagerExhausts(
  person: Person, source: { x: number; y: number; food: number }, observedPeople: readonly Person[],
  ownRemainingWork: number,
  physical: {
    tick: number; radius: number;
    duration: (other: Person) => number;
    capacity: (other: Person) => number;
    continues: (other: Person, ticks: number) => boolean;
  },
): boolean {
  for (const other of observedPeople) {
    if (other.id === person.id || distance(person, other) > physical.radius || other.action !== 'forage'
      || other.work <= 0 || distance(other, source) >= 0.5 || distance(other.target, source) >= 0.5
      || other.technology.waterPreparation) continue;
    const remaining = Math.max(1, physical.duration(other) - other.work);
    // The observer cannot know whether the other already worked in this tick.
    // Compare their latest completion with our earliest, even assuming no travel.
    // Ties and a one-tick lead remain uncertain; no actor-order arbitration.
    if (remaining + 1 >= ownRemainingWork || physical.tick + remaining >= other.decisionAt
      || physical.capacity(other) < source.food || !physical.continues(other, remaining + 1)) continue;
    return true;
  }
  return false;
}

/** A known, mutually trusted local partner allowed by the kinship gate can motivate acquiring real reserves.
 * This intent neither supplies food nor guarantees a birth; the host owns actions and costs.
 * Both partners retain their communities; mutual local trust can cross their labels. */
export function familyOpportunity(world: World, person: Person): FamilyOpportunity | null {
  if (!world.reproductionEnabled || !person.communityId || !reproductiveReadiness(world, person)) return null;
  const partner = world.people.filter(other => other !== person && other.id !== person.id && !!other.communityId
    && distance(person, other) <= 7 && (person.bonds[other.id] ?? 0) >= 0.3 && (other.bonds[person.id] ?? 0) >= 0.3
    && !closeKin(person, other) && reproductiveReadiness(world, other)
    && world.places.some(place => distance(person, place) <= 7 && (distance(person, place) <= 4 || distance(other, place) <= 4)))
    .sort((a, b) => distance(person, a) - distance(person, b) || a.id.localeCompare(b.id))[0];
  return partner ? { partner, reserveTarget: FAMILY_RESERVE_TARGET } : null;
}

/** Only a local, currently viable family intent earmarks food. Urgent recipient hunger
 * can use that reserve, but never invents the minimum share; the caller protects own needs. */
export function availableToShare(world: World, person: Person, recipient: Person): boolean {
  if (person.inventory < SHARE_AMOUNT) return false;
  if (recipient.hunger >= 0.8) return true;
  const family = familyOpportunity(world, person);
  return family === null || person.inventory >= family.reserveTarget + SHARE_AMOUNT;
}
