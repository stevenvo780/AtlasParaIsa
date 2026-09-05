/** A quantity has one consistent unit per resource, including catalyst wear. */
export interface OrganizationQuantity { resourceId: string; amount: number; }

export interface OrganizationProcess {
  id: string;
  /** At least one positive input and output; material sources must be explicit. */
  inputs: OrganizationQuantity[];
  outputs: OrganizationQuantity[];
  /** All listed catalysts are required together (a catalyst ensemble, not alternatives). */
  catalysts: string[];
  parents: string[];
}

export interface OrganizationExecution {
  id: string;
  tick: number;
  actorId: string;
  processId: string;
  /** Defaults to one; successful receipts must match the declared quantities times this factor. */
  units?: number;
  inputs: OrganizationQuantity[];
  outputs: OrganizationQuantity[];
  /** Actual use, including optional tools; wear must be a real stock debit. */
  catalysts: { resourceId: string; wear: number }[];
  success: boolean;
}

export interface OrganizationResource {
  resourceId: string;
  /** Stock at the observation boundaries, not lifetime totals or initial-world stock. */
  openingStock?: number;
  closingStock?: number;
  /** Actual arrivals and departures during this window; transfers inside the scope cancel. */
  externalInput: number;
  externalLoss: number;
}

export interface OrganizationObservation {
  window: { startTick: number; endTick: number; complete: boolean };
  /** Ambient inputs allowed by the structural model; finite stocks are still checked. */
  food: string[];
  processes: OrganizationProcess[];
  /** Chronological order within a tick matters. Failed attempts also carry material debits. */
  executions: OrganizationExecution[];
  resources: OrganizationResource[];
}

export interface OrganizationResourceBalance extends OrganizationResource {
  food: boolean;
  output: number;
  /** Only successful, conforming executions earn internal production credit. */
  internalProduction: number;
  consumed: number;
  catalystWear: number;
  demand: number;
  replacementCoverage: number | null;
  /** Demand divided by stock at the start; null when the starting stock is unknown or zero. */
  turnover: number | null;
  netFlow: number;
  residual: number | null;
  balance: 'verified' | 'unverified' | 'inconsistent';
  depleting: boolean;
}

export interface OrganizationDependency {
  producerId: string;
  consumerId: string;
  resourceId: string;
  kind: 'input' | 'catalyst';
}

export interface OrganizationProcessAnalysis {
  id: string;
  executions: number;
  fluxPerTick: number;
  foodGenerated: boolean;
  structuralRaf: boolean;
  /** Catalysts must be available at each construction step; stricter than RAF. */
  constructibleFromFood: boolean;
  viableNow: boolean;
  maintained: boolean;
  blockers: string[];
  ancestorDepth: number | null;
}

export interface OrganizationAnalysis {
  window: OrganizationObservation['window'];
  /** Scope is the supplied process/material model. None of these fields certifies life. */
  boundary: 'not-modeled';
  autopoiesisEstablished: false;
  foodClosure: string[];
  maximalRaf: string[];
  constructibleFromFood: string[];
  processes: OrganizationProcessAnalysis[];
  resources: OrganizationResourceBalance[];
  structuralDependencies: OrganizationDependency[];
  /** Edges need actual production and actual consumption/use, not just matching recipe names. */
  observedDependencies: OrganizationDependency[];
  structuralComponents: string[][];
  observedComponents: string[][];
  /** Cycles with verified resource replacement during this finite observation window only. */
  maintainedComponents: string[][];
  evidence: {
    executed: number;
    successful: number;
    rejected: { executionId: string; reasons: string[] }[];
    ignoredOutsideWindow: number;
    balanced: boolean;
    failures: string[];
  };
  maintenance: {
    requiredResources: string[];
    depletedResources: string[];
    externallySuppliedNonFood: string[];
    unproducedCatalysts: string[];
    catalystReplacementCoverage: number | null;
    catalystsWithCompleteTurnover: string[];
  };
  diversity: { activeProcesses: number; effectiveProcesses: number; activeActors: number; maxAncestorDepth: number; unresolvedLineage: string[] };
  /** Practice evidence for division of work; no profession or group is assigned by this module. */
  actorActivity: { actorId: string; processId: string; executions: number }[];
  actorRoles: { actorId: string; executions: number; dominantProcessId: string; dominantShare: number; effectiveProcesses: number }[];
}
