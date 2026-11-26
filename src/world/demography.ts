import type { DemographicActor, DemographicDeathCause, DemographicEnvironment, DemographicState, DemographicTraits, DemographicTransition, LongevityLaw, SenescenceLaw } from '../shared/demography.js';
import { DEMOGRAPHY_TICKS_PER_DAY, longevityAges } from '../shared/demography.js';
import { ALLELE_COUNT, localRandom } from './genetics.js';
import { DEFAULT_PARAMS } from './params.js';
import { SALUD_FERTIL } from '../shared/naturaleza.js';

/** Reexportado desde `shared/demography.ts`, donde vive junto a la geometría de la ley de
 * longevidad para que `params.ts` pueda validarla sin importar el motor. */
export { DEMOGRAPHY_TICKS_PER_DAY };
export const MAX_DEMOGRAPHY_DT = DEMOGRAPHY_TICKS_PER_DAY;
export const PROTECTED_HEALTH_FLOOR = 0.05;
export const PROTECTED_VITALITY_FLOOR = 0.08;
/** Desgaste de vejez de la ley vigente: intacto (×1,00 del anterior), para que la vejez siga siendo legible. */
export const SENESCENCE_WEAR_PER_DAY = 0.8;
/** Cuánto alivia la resiliencia heredada el riesgo de senescencia (0,4 con resiliencia 1). Es una
 * constante de la ley, no un parámetro: cambiarla cambia la trayectoria de todos los mundos. */
const SENESCENCE_GENE_RELIEF = 0.4;
const CAUSES: readonly DemographicDeathCause[] = ['starvation', 'dehydration', 'exposure', 'senescence'];
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const unit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const nonNegative = (value: number) => Number.isFinite(value) && value >= 0;
const positiveSafe = (value: number) => Number.isSafeInteger(value) && value > 0;
const emptyDamage = (): DemographicTransition['damage'] => ({ starvation: 0, dehydration: 0, exposure: 0, senescence: 0 });

export function initialDemography(age = 0): DemographicState {
  if (!Number.isFinite(age) || age < 0 || age > Number.MAX_SAFE_INTEGER) throw new RangeError('Edad demográfica inválida.');
  return { age, health: 1, vitality: 1, deathCause: null };
}

/** V23 (`v23.cuerpos`): la salud guardada nunca supera la del cuerpo de átomos (tejido completo sobre la masa adulta de
 * su plantilla). Una herida, lo que se extrae del tejido o no haber crecido aún la bajan al momento; el desgaste de
 * esta ley (hambre, sed, intemperie y vejez, leídas ya de las vistas del cuerpo) sigue acumulándose por debajo, y la
 * curación escalar no puede subirla por encima de lo que el tejido haya vuelto a crecer. Un vivo conserva salud > 0
 * (la muerte la decide `updateDemography`); un cuerpo sin tejido llega con hambre y sed 1 y esa ley lo mata. */
export function acotarSalud(state: DemographicState, salud: number): void {
  if (state.deathCause !== null || !(salud < state.health)) return;
  state.health = salud > 0 ? salud : Number.MIN_VALUE;
}

/** Diploid model loci 4 (resilience) and 2 (activity), already inherited by genetics.ts.
 * Resistance trades against food demand and reproductive tempo; no skill or cultural value is read.
 *
 * La longevidad es LEY DEL MUNDO, no una constante del módulo (R3): `longevity` es
 * `paramsOf(world).cuerpo` y sus defaults (11 / 4 / 1 / 0,75) son exactamente los literales que
 * T010 dejó escritos a mano, así que omitirla devuelve el mundo de siempre bit a bit. El resto de
 * los rasgos (demanda de comida y agua, madurez, descanso reproductivo) no dependen de esta ley:
 * sólo del genoma, y por eso `assertLegacyRecord` puede seguir recalculándolos sin mundo. */
export function demographicTraits(genome: { alleles: readonly number[] }, longevity: Readonly<LongevityLaw> = DEFAULT_PARAMS.cuerpo): DemographicTraits {
  if (!Array.isArray(genome.alleles) || genome.alleles.length !== ALLELE_COUNT || !unitAlleles(genome.alleles)) throw new RangeError('Alelos demográficos inválidos.');
  if (!(nonNegative(longevity.longevidadBaseDias) && nonNegative(longevity.longevidadPorResiliencia) && nonNegative(longevity.longevidadPorActividad)
    && nonNegative(longevity.senescenciaInicioFraccion))) throw new RangeError('Ley de longevidad inválida.');
  const resilience = (genome.alleles[8]! + genome.alleles[9]!) / 2;
  const activity = (genome.alleles[4]! + genome.alleles[5]!) / 2;
  const { maturityAge, senescenceStart, maximumAge } = longevityAges(resilience, activity, longevity);
  // Aserción de estado imposible, NO la primera línea de defensa (revisión de R3): la condición
  // depende del genoma, así que aquí no rompería al fijar la ley sino cuando naciera el primer
  // cuerpo desafortunado —a mitad de una réplica de horas, o dentro del bucle de tick del servidor.
  // Quien fija los params (`parseParams`/`setParams`, vía `assertLongevityLaw`) ya rechazó toda ley
  // que pudiera llegar hasta aquí; si aun así llega, se oye en vez de seguir con edades absurdas.
  if (!(maturityAge < senescenceStart && senescenceStart < maximumAge)) {
    throw new RangeError(`Ley de longevidad degenerada: madurez ${maturityAge}, inicio de vejez ${senescenceStart}, edad máxima ${maximumAge} ticks. Revisa cuerpo.longevidad* y cuerpo.senescenciaInicioFraccion.`);
  }
  return { resilience, foodDemand: 0.85 + resilience * 0.4 + activity * 0.2,
    waterDemand: 1.15 - resilience * 0.35 + activity * 0.15,
    maturityAge,
    fertilityCooldown: Math.round((0.8 + resilience * 0.5 + activity * 0.1) * DEMOGRAPHY_TICKS_PER_DAY),
    senescenceStart, maximumAge };
}

/** `alleles.every(unit)` sin una llamada por alelo. Un arreglo denso de números en [0, 1] se decide en el
 * bucle; ante cualquier otro valor (también un hueco, que `every` se salta) decide `every` como siempre. */
function unitAlleles(alleles: readonly unknown[]): boolean {
  for (let i = 0; i < alleles.length; i++) {
    const allele = alleles[i];
    if (!(typeof allele === 'number' && allele >= 0 && allele <= 1)) return alleles.every(unit);
  }
  return true;
}

function validate(actor: DemographicActor, environment: DemographicEnvironment, dt: number): void {
  const state = actor.state, traits = actor.traits, law = environment.senescence;
  if (!Number.isFinite(dt) || dt < 0 || dt > MAX_DEMOGRAPHY_DT || !state || !traits
    || !(unit(actor.hunger) && unit(actor.thirst) && unit(actor.energy) && unit(actor.fatigue) && unit(state.health) && unit(state.vitality)
      && unit(environment.exposure) && unit(environment.shelter) && unit(traits.resilience))
    || typeof environment.protected !== 'boolean' || !Number.isFinite(state.age) || state.age < 0 || state.age + dt > Number.MAX_SAFE_INTEGER
    || (actor.id !== undefined && (typeof actor.id !== 'string' || actor.id.length === 0))
    || (environment.seed !== undefined && !Number.isInteger(environment.seed))
    || (environment.tick !== undefined && !Number.isFinite(environment.tick))
    || (law !== undefined && (typeof law !== 'object' || law === null
      || !(nonNegative(law.riesgoSenescenciaDiario) && nonNegative(law.riesgoSenescenciaPendiente))
      || !unit(law.cuidadoReduceRiesgo)))
    || (state.deathCause !== null && !CAUSES.includes(state.deathCause)) || ((state.health === 0) !== (state.deathCause !== null))
    || !Number.isFinite(traits.foodDemand) || traits.foodDemand <= 0 || traits.foodDemand > 3
    || !Number.isFinite(traits.waterDemand) || traits.waterDemand <= 0 || traits.waterDemand > 3
    || !(positiveSafe(traits.maturityAge) && positiveSafe(traits.fertilityCooldown) && positiveSafe(traits.senescenceStart) && positiveSafe(traits.maximumAge))
    || traits.maturityAge >= traits.senescenceStart || traits.senescenceStart >= traits.maximumAge) throw new RangeError('Estado, entorno o intervalo demográfico inválido.');
}

/** Con `v23.cuerpos` estos umbrales leen el cuerpo de átomos sin cambiar de número: `hunger` es lo que falta de la
 * reserva (≤ 0,45 deja más de un día de basal), `thirst` lo que falta de agua libre, `energy` el O₂ de la reserva y
 * `health` nunca supera tejido/plantilla (`acotarSalud`), así que SALUD_FERTIL exige además haber crecido. */
function eligible(actor: DemographicActor, state: DemographicState): boolean {
  return state.deathCause === null && state.age >= actor.traits.maturityAge && state.age < actor.traits.senescenceStart
    && state.health >= SALUD_FERTIL && state.vitality >= 0.5 && actor.hunger <= 0.45 && actor.thirst <= 0.45 && actor.energy >= 0.6 && actor.fatigue <= 0.65;
}

/** Exact integral of quadratic age pressure over the interval, in simulation-day units. The wear
 * is the pre-existing law, untouched: the hazard REPLACES the age cut, it does not stack on it.
 * Health still falls to ~0,2 at maximumAge, so old age stays legible, and it is not modulated by
 * care: an elder cannot buy back the years already worn. */
function senescenceDamage(startAge: number, endAge: number, traits: Readonly<DemographicTraits>): number {
  const width = traits.maximumAge - traits.senescenceStart;
  return (wearPrimitive(endAge, traits, width) - wearPrimitive(startAge, traits, width)) * SENESCENCE_WEAR_PER_DAY / DEMOGRAPHY_TICKS_PER_DAY;
}
/** Primitiva del desgaste de vejez. Función de módulo, no un cierre por llamada (camino caliente). */
function wearPrimitive(age: number, traits: Readonly<DemographicTraits>, width: number): number {
  return Math.pow(Math.max(0, Math.min(age, traits.maximumAge) - traits.senescenceStart), 3) / (3 * width * width);
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
    const e1 = riskExponent(a1, traits, care, law, slope);
    if (e1 >= 700) return 1;
    const span = Math.exp(e1) - Math.exp(riskExponent(a0, traits, care, law, slope));
    if (!(span > 0)) return 0;
    hazard = rate * geneRelief * (traits.maximumAge / (DEMOGRAPHY_TICKS_PER_DAY * slope)) * span;
  }
  if (!(hazard > 0)) return 0;
  return Number.isFinite(hazard) ? clamp(1 - Math.exp(-hazard)) : 1;
}
function riskExponent(age: number, traits: Readonly<DemographicTraits>, care: number, law: Readonly<SenescenceLaw>, slope: number): number {
  return slope * ((age - traits.maximumAge) / traits.maximumAge - law.cuidadoReduceRiesgo * care);
}

/** `[...CAUSES].sort((a, b) => damage[b] - damage[a])[0]`: la causa de mayor daño y, en un empate, la primera
 * de `CAUSES` (el orden es estable). Los daños son finitos: `validate` sólo deja pasar entradas finitas. */
function dominantCause(damage: Readonly<Record<DemographicDeathCause, number>>): DemographicDeathCause {
  let best = CAUSES[0]!;
  for (let i = 1; i < CAUSES.length; i++) if (damage[CAUSES[i]!] - damage[best] > 0) best = CAUSES[i]!;
  return best;
}

/** `updateDemography(actor, environment, dt).damage.exposure`, bit a bit: mismas validaciones y mismos
 * errores, y las mismas operaciones IEEE-754 en el mismo orden (`nextVitality` es la de `updateDemography`),
 * sin la tirada de senescencia ni las copias del resto de la transición. Lo usa `advancePopulation` para
 * medir el daño que un abrigo evitó sin repetir la transición entera. */
export function exposureDamage(actor: DemographicActor, environment: DemographicEnvironment, dt = 1): number {
  validate(actor, environment, dt);
  if (actor.state.deathCause !== null || dt === 0) return 0;
  if (actor.id === undefined || environment.seed === undefined || environment.tick === undefined || environment.senescence === undefined) {
    throw new RangeError('Avanzar un cuerpo exige id, semilla, tick y ley de senescencia explícitos.');
  }
  const days = dt / DEMOGRAPHY_TICKS_PER_DAY, traits = actor.traits;
  const hungry = clamp((actor.hunger - 0.72) / 0.28), thirsty = clamp((actor.thirst - 0.7) / 0.3);
  const exposure = environment.exposure * (1 - environment.shelter), resistance = 1 - traits.resilience * 0.7;
  const nourishment = clamp((0.65 - actor.hunger) / 0.55) * clamp((0.6 - actor.thirst) / 0.5);
  const vitality = nextVitality(actor, hungry, thirsty, exposure, resistance, nourishment, days);
  const vulnerability = 1 + (1 - (actor.state.vitality + vitality) / 2) * 0.75;
  return exposure * resistance * 0.48 * days * vulnerability;
}

/** Vitalidad al final del intervalo. Única definición: la comparten `updateDemography` y `exposureDamage`. */
function nextVitality(actor: DemographicActor, hungry: number, thirsty: number, exposure: number, resistance: number, nourishment: number, days: number): number {
  const traits = actor.traits;
  const recovery = nourishment * (0.15 + actor.energy * 0.2) * (1 - actor.fatigue * 0.5);
  const strain = hungry * 0.65 * traits.foodDemand + thirsty * traits.waterDemand + exposure * resistance * 0.2
    + actor.fatigue * (1 - actor.energy) * 0.08;
  return clamp(actor.state.vitality + (recovery - strain) * days);
}

/** Pure demographic transition. dt is simulation ticks (0..2400), not wall-clock seconds.
 * Needs/environment are held constant over this interval; age advances exactly once. The host
 * supplies the post-action body, handles deaths after the step and pays all reproduction costs. */
export function updateDemography(actor: DemographicActor, environment: DemographicEnvironment, dt = 1,
  detalle?: DetalleDemografia): DemographicTransition {
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
  state.vitality = nextVitality(actor, hungry, thirsty, exposure, resistance, nourishment, days);
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
  state.health = clamp(state.health + healing - (0 + damage.starvation + damage.dehydration + damage.exposure + damage.senescence));
  if (detalle) {
    detalle.reparacion = healing;
    detalle.desgasteEdad = damage.senescence;
    detalle.saludAntesSorteo = state.health;
  }
  let death: DemographicDeathCause | null = null;
  const senescenceRisk = mortalityRisk(actor.state.age, state.age, traits, care, law);
  if (state.health <= 0) death = dominantCause(damage);
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

/** Magnitudes de la transición antes de la tirada probabilística, solo para un observador. */
export interface DetalleDemografia { reparacion: number; desgasteEdad: number; saludAntesSorteo: number }
