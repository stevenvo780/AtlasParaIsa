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

export interface DemographicActor {
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
  /** External continuity policy, supplied by the caller for protected identities. */
  protected: boolean;
}

export interface DemographicTransition {
  state: DemographicState;
  death: DemographicDeathCause | null;
  /** A policy veto in this interval, not an additional death or a biological trait. */
  preventedDeath: DemographicDeathCause | null;
  offspringEligible: boolean;
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
