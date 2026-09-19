import type { GenomeView } from './types.js';

/** Causal labels for an artificial life model; these parameters are not human biology. */
export type DemographicDeathCause = 'starvation' | 'dehydration' | 'exposure' | 'senescence';

export interface DemographicState {
  /** Elapsed simulation ticks, advanced only by updateDemography. */
  age: number;
  health: number;
  vitality: number;
  deathCause: DemographicDeathCause | null;
}

export interface DemographicTraits {
  resilience: number;
  foodDemand: number;
  waterDemand: number;
  maturityAge: number;
  fertilityCooldown: number;
  senescenceStart: number;
  maximumAge: number;
}

/** Ley de longevidad (T010, cableada en R3). Subconjunto estructural de `WorldParams['cuerpo']`:
 * fija la edad máxima (base + resiliencia·gen − actividad·hábito) y el inicio de la vejez (fracción
 * de la edad máxima). La lee `demographicTraits`; el mundo se la pasa con `paramsOf(world).cuerpo`. */
export interface LongevityLaw {
  longevidadBaseDias: number;
  longevidadPorResiliencia: number;
  longevidadPorActividad: number;
  senescenciaInicioFraccion: number;
}

/** Ticks de simulación por día. Vive aquí, y no sólo en `world/demography.ts`, porque la geometría
 * de la ley de longevidad la leen dos módulos que no pueden importarse entre sí: el motor
 * (`world/demography.ts`) y la validación de `parseParams` (`world/params.ts`). */
export const DEMOGRAPHY_TICKS_PER_DAY = 2400;

/** Las tres edades, en ticks, que un cuerpo alcanza bajo una ley de longevidad: única copia de la
 * ley de T010. La evalúan `demographicTraits` (sobre el genoma de cada persona) y
 * `assertLongevityLaw` (sobre las cuatro esquinas de resiliencia/actividad, al fijar los params).
 * Antes de redondear, las tres edades son AFINES en (resiliencia, actividad), así que las cuatro
 * esquinas del cuadrado [0,1]² acotan todo el interior: si la ley es sana en las cuatro con una
 * holgura que cubra el redondeo, lo es para cualquier genoma posible. */
export function longevityAges(resilience: number, activity: number, law: Readonly<LongevityLaw>):
Pick<DemographicTraits, 'maturityAge' | 'senescenceStart' | 'maximumAge'> {
  const maximumAge = Math.round((law.longevidadBaseDias + resilience * law.longevidadPorResiliencia
    - activity * law.longevidadPorActividad) * DEMOGRAPHY_TICKS_PER_DAY);
  const maturityAge = Math.round((1.8 + resilience * 0.3 + activity * 0.1) * DEMOGRAPHY_TICKS_PER_DAY);
  return { maturityAge, senescenceStart: Math.round(maximumAge * law.senescenciaInicioFraccion), maximumAge };
}

/** Ley de senescencia (T010). Subconjunto estructural de `WorldParams['cuerpo']`. */
export interface SenescenceLaw {
  riesgoSenescenciaDiario: number;
  riesgoSenescenciaPendiente: number;
  cuidadoReduceRiesgo: number;
}

export interface DemographicActor {
  /** Identidad estable del cuerpo. Obligatoria en toda llamada con `dt > 0`: la tirada de
   * senescencia es pura en `(seed, id, tick)` y no existe ningún valor por defecto. */
  id?: string;
  state: Readonly<DemographicState>;
  traits: Readonly<DemographicTraits>;
  hunger: number;
  thirst: number;
  energy: number;
  fatigue: number;
}

export interface DemographicEnvironment {
  exposure: number;
  shelter: number;
  /** Semilla y tick del mundo. Obligatorios con `dt > 0`; sin ellos `updateDemography` lanza
   * en vez de caer en una semilla fija que sincronizaría las muertes entre réplicas. */
  seed?: number;
  tick?: number;
  /** `paramsOf(world).cuerpo`. Obligatoria con `dt > 0`: sin defaults ocultos, el laboratorio
   * (T016–T018) necesita que `parseParams` llegue hasta aquí. */
  senescence?: Readonly<SenescenceLaw>;
  /** External continuity policy, supplied by the caller for protected identities. */
  protected: boolean;
}

export interface DemographicTransition {
  state: DemographicState;
  death: DemographicDeathCause | null;
  /** A policy veto in this interval, not an additional death or a biological trait. */
  preventedDeath: DemographicDeathCause | null;
  offspringEligible: boolean;
  /** Probability of senescence death during this interval. */
  senescenceRisk: number;
  /** Integrated injury pressures before healing and the health floor. */
  damage: Record<DemographicDeathCause, number>;
}

/** Immutable identity evidence for the host's archive; learned history is not part of the genome. */
export interface LegacyRecord {
  id: string;
  name: string;
  role: 'S' | 'I' | 'neighbor';
  generation: number;
  parents: string[];
  bornAt: number;
  diedAt: number;
  cause: DemographicDeathCause;
  genome: GenomeView & { alleles: number[] };
  traits: DemographicTraits;
  communityId: string | null;
}
