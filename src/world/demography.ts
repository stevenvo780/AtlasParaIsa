import type { DemographicActor, DemographicDeathCause, DemographicEnvironment, DemographicState, DemographicTraits, DemographicTransition } from '../shared/demography.js';

export const DEMOGRAPHY_TICKS_PER_DAY = 2400;
export const MAX_DEMOGRAPHY_DT = DEMOGRAPHY_TICKS_PER_DAY;
export const PROTECTED_HEALTH_FLOOR = 0.05;
export const PROTECTED_VITALITY_FLOOR = 0.08;
const CAUSES: readonly DemographicDeathCause[] = ['starvation', 'dehydration', 'exposure', 'senescence'];
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const unit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const emptyDamage = (): DemographicTransition['damage'] => ({ starvation: 0, dehydration: 0, exposure: 0, senescence: 0 });

export function initialDemography(age = 0): DemographicState {
  if (!Number.isFinite(age) || age < 0 || age > Number.MAX_SAFE_INTEGER) throw new RangeError('Edad demográfica inválida.');
  return { age, health: 1, vitality: 1, deathCause: null };
}

/** Diploid model loci 4 (resilience) and 2 (activity), already inherited by genetics.ts.
 * Resistance trades against food demand and reproductive tempo; no skill or cultural value is read. */
export function demographicTraits(genome: { alleles: readonly number[] }): DemographicTraits {
  if (!Array.isArray(genome.alleles) || genome.alleles.length !== 14 || !genome.alleles.every(unit)) throw new RangeError('Alelos demográficos inválidos.');
  const resilience = (genome.alleles[8]! + genome.alleles[9]!) / 2;
  const activity = (genome.alleles[4]! + genome.alleles[5]!) / 2;
  const maximumAge = Math.round((11 + resilience * 4 - activity) * DEMOGRAPHY_TICKS_PER_DAY);
  return { resilience, foodDemand: 0.85 + resilience * 0.4 + activity * 0.2,
    waterDemand: 1.15 - resilience * 0.35 + activity * 0.15,
    maturityAge: Math.round((1.8 + resilience * 0.3 + activity * 0.1) * DEMOGRAPHY_TICKS_PER_DAY),
    fertilityCooldown: Math.round((0.8 + resilience * 0.5 + activity * 0.1) * DEMOGRAPHY_TICKS_PER_DAY),
    senescenceStart: Math.round(maximumAge * 0.75), maximumAge };
}

function validate(actor: DemographicActor, environment: DemographicEnvironment, dt: number): void {
  const state = actor.state, traits = actor.traits;
  if (!Number.isFinite(dt) || dt < 0 || dt > MAX_DEMOGRAPHY_DT || !state || !traits
    || ![actor.hunger, actor.thirst, actor.energy, actor.fatigue, state.health, state.vitality, environment.exposure, environment.shelter, traits.resilience].every(unit)
    || typeof environment.protected !== 'boolean' || !Number.isFinite(state.age) || state.age < 0 || state.age + dt > Number.MAX_SAFE_INTEGER
    || (state.deathCause !== null && !CAUSES.includes(state.deathCause)) || ((state.health === 0) !== (state.deathCause !== null))
    || !Number.isFinite(traits.foodDemand) || traits.foodDemand <= 0 || traits.foodDemand > 3
    || !Number.isFinite(traits.waterDemand) || traits.waterDemand <= 0 || traits.waterDemand > 3
    || ![traits.maturityAge, traits.fertilityCooldown, traits.senescenceStart, traits.maximumAge].every(value => Number.isSafeInteger(value) && value > 0)
    || traits.maturityAge >= traits.senescenceStart || traits.senescenceStart >= traits.maximumAge) throw new RangeError('Estado, entorno o intervalo demográfico inválido.');
}

function eligible(actor: DemographicActor, state: DemographicState): boolean {
  return state.deathCause === null && state.age >= actor.traits.maturityAge && state.age < actor.traits.senescenceStart
    && state.health >= 0.55 && state.vitality >= 0.5 && actor.hunger <= 0.45 && actor.thirst <= 0.45 && actor.energy >= 0.6 && actor.fatigue <= 0.65;
}

/** Exact integral of quadratic age pressure over the interval, in simulation-day units. */
function senescenceDamage(startAge: number, endAge: number, traits: Readonly<DemographicTraits>): number {
  const width = traits.maximumAge - traits.senescenceStart;
  const primitive = (age: number) => Math.pow(Math.max(0, Math.min(age, traits.maximumAge) - traits.senescenceStart), 3) / (3 * width * width);
  return (primitive(endAge) - primitive(startAge)) * 0.8 / DEMOGRAPHY_TICKS_PER_DAY;
}

/** Pure demographic transition. dt is simulation ticks (0..2400), not wall-clock seconds.
 * Needs/environment are held constant over this interval; age advances exactly once. The host
 * supplies the post-action body, handles deaths after the step and pays all reproduction costs. */
export function updateDemography(actor: DemographicActor, environment: DemographicEnvironment, dt = 1): DemographicTransition {
  validate(actor, environment, dt);
  const state = { ...actor.state }, damage = emptyDamage();
  // Death is absorbing. Protection does not resurrect an identity already recorded as dead.
  if (state.deathCause !== null) return { state, death: state.deathCause, preventedDeath: null, offspringEligible: false, damage };
  if (dt === 0) return { state, death: null, preventedDeath: null, offspringEligible: eligible(actor, state), damage };
  const days = dt / DEMOGRAPHY_TICKS_PER_DAY, traits = actor.traits;
  const hungry = clamp((actor.hunger - 0.72) / 0.28), thirsty = clamp((actor.thirst - 0.7) / 0.3);
  const exposure = environment.exposure * (1 - environment.shelter), resistance = 1 - traits.resilience * 0.7;
  const nourishment = clamp((0.65 - actor.hunger) / 0.55) * clamp((0.6 - actor.thirst) / 0.5);
  const recovery = nourishment * (0.15 + actor.energy * 0.2) * (1 - actor.fatigue * 0.5);
  const strain = hungry * 0.65 * traits.foodDemand + thirsty * traits.waterDemand + exposure * resistance * 0.2
    + actor.fatigue * (1 - actor.energy) * 0.08;
  state.vitality = clamp(state.vitality + (recovery - strain) * days);
  const vulnerability = 1 + (1 - (actor.state.vitality + state.vitality) / 2) * 0.75;
  damage.starvation = hungry * hungry * 1.3 * traits.foodDemand * days * vulnerability;
  damage.dehydration = thirsty * thirsty * 2 * traits.waterDemand * days * vulnerability;
  damage.exposure = exposure * resistance * 0.48 * days * vulnerability;
  state.age += dt;
  damage.senescence = senescenceDamage(actor.state.age, state.age, traits);
  const aging = clamp((state.age - traits.senescenceStart) / (traits.maximumAge - traits.senescenceStart));
  const healing = nourishment * actor.energy * state.vitality * 0.08 * (1 - aging) * days;
  state.health = clamp(state.health + healing - CAUSES.reduce((sum, cause) => sum + damage[cause], 0));
  let death: DemographicDeathCause | null = null;
  if (state.age >= traits.maximumAge) {
    damage.senescence += state.health; state.health = 0; death = 'senescence';
  } else if (state.health <= 0) {
    death = [...CAUSES].sort((a, b) => damage[b] - damage[a])[0]!;
  }
  if (death && environment.protected) {
    state.health = Math.max(PROTECTED_HEALTH_FLOOR, state.health); state.vitality = Math.max(PROTECTED_VITALITY_FLOOR, state.vitality);
    return { state, death: null, preventedDeath: death, offspringEligible: false, damage };
  }
  if (death) { state.deathCause = death; state.vitality = 0; }
  return { state, death, preventedDeath: null, offspringEligible: eligible(actor, state), damage };
}
