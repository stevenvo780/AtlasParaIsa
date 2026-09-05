import type { Person, World } from './index.js';
import { demographicTraits, updateDemography } from './demography.js';

export const FAMILY_RESERVE_TARGET = 0.12;
const SHARE_AMOUNT = 0.025;
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** The existing physiological/cooldown gate, without its separate portable-food requirement.
 * dt=0 queries the same demographic model without advancing age or recovering the body. */
export function reproductiveReadiness(world: World, person: Person): boolean {
  if (person.role !== 'neighbor') return false;
  const traits = demographicTraits(person.genome);
  if (world.tick - person.lastBirth < traits.fertilityCooldown) return false;
  return updateDemography({ state: person.demography, traits, hunger: person.hunger, thirst: person.thirst,
    energy: person.energy, fatigue: person.fatigue }, { exposure: 0, shelter: 0, protected: false }, 0).offspringEligible;
}

export interface FamilyOpportunity { partner: Person; reserveTarget: number; }

/** A known, mutually trusted local partner can motivate acquiring real reserves.
 * This intent neither supplies food nor guarantees a birth; the host owns actions and costs.
 * Group membership stays a requirement here to isolate reserve preparation in the A/B run. */
export function familyOpportunity(world: World, person: Person): FamilyOpportunity | null {
  if (!world.reproductionEnabled || !person.communityId || !reproductiveReadiness(world, person)) return null;
  const partner = world.people.filter(other => other !== person && other.id !== person.id && other.communityId === person.communityId
    && distance(person, other) <= 7 && (person.bonds[other.id] ?? 0) >= 0.3 && (other.bonds[person.id] ?? 0) >= 0.3
    && reproductiveReadiness(world, other)
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
