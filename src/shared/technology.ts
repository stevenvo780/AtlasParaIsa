/** Technology is a bounded physical model, not a catalogue of named inventions.
 * One material unit is 1000 mass quanta. Composition is conserved exactly. */
export type Material = 'wood' | 'stone' | 'water';
export type Composition = Record<Material, number>;
export type Capability = 'cutting' | 'storage' | 'insulation' | 'cultivation' | 'binding' | 'abrasion';
export type PhysicalOperation = 'combine' | 'separate' | 'form' | 'abrade' | 'heat' | 'cool' | 'compress' | 'weave';
export type MaterialShape = 'edge' | 'hollow' | 'sheet' | 'rod' | 'granular';
export interface MaterialProperties {
  hardness: number; toughness: number; porosity: number; flexibility: number;
  edge: number; containment: number; insulation: number; leverage: number;
  cohesion: number; temperature: number; alignment: number; firing: number;
}
export interface MaterialBatch {
  id: string; recipeId: string | null; composition: Composition; mass: number;
  properties: MaterialProperties; generation: number; madeAt: number;
  parentItems: string[]; initialMass: number;
}
export interface MaterialRequirement {
  source: 'raw' | 'product' | 'residue'; material?: Material;
  recipeId?: string; mass: number;
}
export interface OperationInstruction {
  op: PhysicalOperation; intensity: number; shape?: MaterialShape; material?: Material;
  catalyst?: Capability; requiredCatalyst?: Capability;
}
export interface TechnologyProgram { inputs: MaterialRequirement[]; steps: OperationInstruction[]; }
export interface TechnologyRecipe {
  id: string; name: string; program: TechnologyProgram; signature: string;
  parents: string[]; generation: number; inventorId: string; tick: number;
  x: number; y: number; novelty: 'program' | 'function' | 'both';
  capacities: Record<Capability, number>; uses: number; utility: number; manufactured: number;
}
export interface TechnologyProject {
  kind: 'research' | 'craft'; program: TechnologyProgram; parents: string[];
  recipeId: string | null; progress: number; requiredWork: number; energyPaid: number;
  startedAt: number;
}
export interface TechnologyKnowledge {
  knownRecipes: string[]; items: MaterialBatch[]; residue: Composition;
  attempts: number; lastAttempt: number; project: TechnologyProject | null;
  learnedFrom: { recipeId: string; teacherId: string; tick: number }[];
  competence: Record<string, { attempts: number; successes: number; work: number; benefit: number }>;
}
export interface ResourceMass { resourceId: string; mass: number; }
export interface TechnologyExecution {
  id: string; kind: 'research' | 'craft' | 'use' | 'recycle' | 'estate' | 'transfer'; tick: number; actorId: string;
  transferId?: string; counterpartyId?: string;
  recipeId: string | null; programSignature: string; inputs: ResourceMass[]; outputs: ResourceMass[];
  residueMass: number; energy: number; work: number; success: boolean;
  parentRecipeIds: string[];
  catalysts: { executionId: string; itemId: string; recipeId: string | null; wear: number; required: boolean }[];
  benefit: number;
  /** Exact nested receipts included between this transaction's opening and closing stocks. */
  nestedExecutionIds?: string[];
  balance: { opening: ResourceMass[]; closing: ResourceMass[]; externalInputs: ResourceMass[]; externalLoss: ResourceMass[] };
}
export interface TechnologyBudgets {
  maxRecipes: number; maxSteps: number; maxInputs: number; maxItems: number;
  maxHistory: number; maxGeneration: number; maxMassPerInput: number;
}
/** Physical stock at the end of a tick. Receipts before this boundary are excluded. */
export interface TechnologyCheckpoint {
  version: 1; tick: number; executionCounter: number;
  reason: 'initial' | 'migration' | 'history-gap' | 'roster-change';
  inventories: { actorId: string; items: Pick<MaterialBatch, 'id' | 'recipeId' | 'mass' | 'composition'>[]; residue: Composition }[];
}
export interface TechnologyState {
  version: 1; recipes: TechnologyRecipe[]; history: TechnologyExecution[]; historyDropped: number;
  /** Optional only for loading older V5 snapshots and standalone unanchored hosts. */
  checkpoint?: TechnologyCheckpoint;
  recipeCounter: number; itemCounter: number; executionCounter: number;
  ledger: { imported: Composition; estateLoss: Composition; work: number; energy: number; fuelMass: number;
    attempts: number; failures: number; crafted: number; toolUses: number; shared: number; recycled: number };
  budgets: TechnologyBudgets;
}
export interface TechnologyView {
  recipes: TechnologyRecipe[];
  items: { id: string; ownerId: string; x: number; y: number; recipeId: string | null; mass: number; generation: number; capacities: Record<Capability, number> }[];
  dynamics: { attempts: number; failures: number; recipes: number; products: number; generations: number;
    toolUses: number; observedUtility: number; shared: number; importedMass: number; productMass: number;
    residueMass: number; massError: number; work: number; energy: number; programDiversity: number;
    functionalDiversity: number; reusedProducts: number; historyDropped: number; estateLostMass: number };
  budgets: TechnologyBudgets;
}
