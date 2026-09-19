import type { DemographicActor, DemographicDeathCause, DemographicEnvironment, DemographicState, DemographicTraits, DemographicTransition, SenescenceLaw } from '../shared/demography.js';
import { localRandom } from './genetics.js';

export const DEMOGRAPHY_TICKS_PER_DAY = 2400;
export const MAX_DEMOGRAPHY_DT = DEMOGRAPHY_TICKS_PER_DAY;
export const PROTECTED_HEALTH_FLOOR = 0.05;
export const PROTECTED_VITALITY_FLOOR = 0.08;
/** Desgaste de vejez de la ley vigente: intacto (×1,00 del anterior), para que la vejez siga siendo legible. */
export const SENESCENCE_WEAR_PER_DAY = 0.8;
const SENESCENCE_GENE_RELIEF = 0.4; // TODO params: cuerpo.alivioGenSenescencia
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
  const state = actor.state, traits = actor.traits, law = environment.senescence;
  if (!Number.isFinite(dt) || dt < 0 || dt > MAX_DEMOGRAPHY_DT || !state || !traits
    || ![actor.hunger, actor.thirst, actor.energy, actor.fatigue, state.health, state.vitality, environment.exposure, environment.shelter, traits.resilience].every(unit)
    || typeof environment.protected !== 'boolean' || !Number.isFinite(state.age) || state.age < 0 || state.age + dt > Number.MAX_SAFE_INTEGER
    || (actor.id !== undefined && (typeof actor.id !== 'string' || actor.id.length === 0))
    || (environment.seed !== undefined && !Number.isInteger(environment.seed))
    || (environment.tick !== undefined && !Number.isFinite(environment.tick))
    || (law !== undefined && (typeof law !== 'object' || law === null
      || ![law.riesgoSenescenciaDiario, law.riesgoSenescenciaPendiente].every(value => Number.isFinite(value) && value >= 0)
      || !unit(law.cuidadoReduceRiesgo)))
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

/** Exact integral of quadratic age pressure over the interval, in simulation-day units. The wear
 * is the pre-existing law, untouched: the hazard REPLACES the age cut, it does not stack on it.
 * Health still falls to ~0,2 at maximumAge, so old age stays legible, and it is not modulated by
 * care: an elder cannot buy back the years already worn. */
function senescenceDamage(startAge: number, endAge: number, traits: Readonly<DemographicTraits>): number {
  const width = traits.maximumAge - traits.senescenceStart;
  const primitive = (age: number) => Math.pow(Math.max(0, Math.min(age, traits.maximumAge) - traits.senescenceStart), 3) / (3 * width * width);
  return (primitive(endAge) - primitive(startAge)) * SENESCENCE_WEAR_PER_DAY / DEMOGRAPHY_TICKS_PER_DAY;
}

function mortalityRisk(startAge: number, endAge: number, traits: Readonly<DemographicTraits>, care: number, law: Readonly<SenescenceLaw>): number {
  const a0 = Math.max(startAge, traits.senescenceStart), a1 = Math.max(endAge, traits.senescenceStart);
  const rate = law.riesgoSenescenciaDiario, slope = law.riesgoSenescenciaPendiente;
  if (a1 <= a0 || rate <= 0) return 0;
  const geneRelief = 1 - traits.resilience * SENESCENCE_GENE_RELIEF;
  let hazard: number;
  if (slope <= Number.EPSILON) hazard = rate * geneRelief * (a1 - a0) / DEMOGRAPHY_TICKS_PER_DAY;
  else {
    // Care relief lives inside the exponent. The cap saturates the risk at 1 instead of
    // cancelling it: an unbounded age must never loop back into immunity.
    const exponent = (age: number) => slope * ((age - traits.maximumAge) / traits.maximumAge - law.cuidadoReduceRiesgo * care);
    if (exponent(a1) >= 700) return 1;
    const span = Math.exp(exponent(a1)) - Math.exp(exponent(a0));
    if (!(span > 0)) return 0;
    hazard = rate * geneRelief * (traits.maximumAge / (DEMOGRAPHY_TICKS_PER_DAY * slope)) * span;
  }
  if (!(hazard > 0)) return 0;
  return Number.isFinite(hazard) ? clamp(1 - Math.exp(-hazard)) : 1;
}

/** Pure demographic transition. dt is simulation ticks (0..2400), not wall-clock seconds.
 * Needs/environment are held constant over this interval; age advances exactly once. The host
 * supplies the post-action body, handles deaths after the step and pays all reproduction costs. */
export function updateDemography(actor: DemographicActor, environment: DemographicEnvironment, dt = 1): DemographicTransition {
  validate(actor, environment, dt);
  const state = { ...actor.state }, damage = emptyDamage();
  // Death is absorbing. Protection does not resurrect an identity already recorded as dead.
  if (state.deathCause !== null) return { state, death: state.deathCause, preventedDeath: null, offspringEligible: false, senescenceRisk: 0, damage };
  if (dt === 0) return { state, death: null, preventedDeath: null, offspringEligible: eligible(actor, state), senescenceRisk: 0, damage };
  const days = dt / DEMOGRAPHY_TICKS_PER_DAY, traits = actor.traits, law = environment.senescence;
  const { id } = actor, { seed, tick } = environment;
  // Sin valores por defecto: un bucle que avance cuerpos sin identidad, semilla, tick o ley tomaría
  // tiradas correlacionadas, idénticas entre semillas del mundo, y dejaría `cuerpo.*` fuera del alcance
  // de `parseParams`. Eso es exactamente lo que hay que oír romper, no absorber en silencio.
  if (id === undefined || seed === undefined || tick === undefined || law === undefined) {
    throw new RangeError('Avanzar un cuerpo exige id, semilla, tick y ley de senescencia explícitos.');
  }
  const hungry = clamp((actor.hunger - 0.72) / 0.28), thirsty = clamp((actor.thirst - 0.7) / 0.3);
  const exposure = environment.exposure * (1 - environment.shelter), resistance = 1 - traits.resilience * 0.7;
  const nourishment = clamp((0.65 - actor.hunger) / 0.55) * clamp((0.6 - actor.thirst) / 0.5);
  const recovery = nourishment * (0.15 + actor.energy * 0.2) * (1 - actor.fatigue * 0.5);
  const strain = hungry * 0.65 * traits.foodDemand + thirsty * traits.waterDemand + exposure * resistance * 0.2
    + actor.fatigue * (1 - actor.energy) * 0.08;
  state.vitality = clamp(state.vitality + (recovery - strain) * days);
  // El cuidado se lee del cuerpo GUARDADO, no del hipotético: así la decisión de senescencia es pura
  // en (seed, id, tick) y las ~9 previsiones por tick de index.ts devuelven exactamente lo mismo.
  const care = clamp(actor.state.health * actor.state.vitality);
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
  const senescenceRisk = mortalityRisk(actor.state.age, state.age, traits, care, law);
  if (state.health <= 0) death = [...CAUSES].sort((a, b) => damage[b] - damage[a])[0]!;
  else if (senescenceRisk > 0 && localRandom(seed, `senescence:${id}:${tick}`)() < senescenceRisk) {
    damage.senescence += state.health; state.health = 0; death = 'senescence';
  }
  if (death && environment.protected) {
    state.health = Math.max(PROTECTED_HEALTH_FLOOR, state.health); state.vitality = Math.max(PROTECTED_VITALITY_FLOOR, state.vitality);
    return { state, death: null, preventedDeath: death, offspringEligible: false, senescenceRisk, damage };
  }
  if (death) { state.deathCause = death; state.vitality = 0; }
  return { state, death, preventedDeath: null, offspringEligible: eligible(actor, state), senescenceRisk, damage };
}
