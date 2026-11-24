export type AnimalSpecies = 'hare' | 'deer' | 'boar' | 'fish' | 'wolf' | 'fox';
export type AnimalAction = 'roam' | 'graze' | 'drink' | 'rest' | 'hunt' | 'flee';
export interface AnimalGenes { speed: number; perception: number; metabolism: number; carnivory: number; waterEfficiency: number; camouflage: number; }
/** V23: heritable continuous evolutionary morphology & temperament traits (all in [0,1]). */
export interface AnimalMorphology {
  /** Lower = bolder/calmer near humans → natural domestication; higher = wild/skittish. */
  caution: number;
  /** Body bulk: larger = more meat/fiber & stockier sprite, slower; leaner = faster. */
  size: number;
  /** Fur/wool thickness: adapts to cold/mountains, yields fiber when tended, woollier sprite. */
  coat: number;
  /** Antlers/tusks/horns: deters predators & draws prominent defensive silhouette. */
  defense: number;
}
export interface AnimalView {
  id: string; species: AnimalSpecies; x: number; y: number; action: AnimalAction; reason: string;
  hunger: number; thirst: number; energy: number; fatigue: number; health: number;
  generation: number; parents: string[]; genes: AnimalGenes; age: number;
  reproReserve?: number;
  /** V23: heritable evolutionary morphology & temperament traits (optional for legacy snapshots). */
  morphology?: AnimalMorphology;
  /** V23: local habituation near non-hostile human settlements [0..1]; >= 0.45 enables emergent non-lethal tending & calm herd visuals. */
  habituation?: number;
  /** V23: count of non-lethal tending interactions received. */
  tends?: number;
}
export interface AnimalDynamics { births: number; deaths: number; predations: number; humanHunts: number; waterConsumed: number; plantConsumed: number; }
export type StructureComponent = 'frame' | 'roof' | 'cistern' | 'granary' | 'garden' | 'hearth';
export interface BlueprintView {
  id: string; name: string; components: StructureComponent[]; generation: number; parents: string[];
  inventorId: string | null; tick: number; uses: number; usefulness: number;
  cost: { wood: number; stone: number; work: number };
}
export interface StructureView {
  id: string; x: number; y: number; blueprintId: string; name: string; components: StructureComponent[];
  condition: number; water: number; food: number; uses: number; builtAt: number; builderId: string | null;
  footprint?: { width: 1 | 2; height: 1 | 2 };
  /** V20: contiguous land cells in anchor chunk (polyomino up to 6 cells: L, T, 3×1, 2×2, 3×2). */
  cells?: Array<{ x: number; y: number }>;
  storedWood?: number;
  storedStone?: number;
  /** V20: conserved compound lots stored in this warehouse/workshop. */
  storedCompounds?: import('./chemistry.js').CompoundLot[];
  /** V20: emergent physical material profile from deposited/installed matter (governs wear, seal, warmth & map tint). */
  materialProfile?: import('./chemistry.js').StructureMaterialProfile;
  /** V20: live local inter-structure synergies (shared walls, hearth drying, cistern irrigation, workshop speed). */
  synergy?: import('./chemistry.js').StructureSynergyView;
  site?: { requiredWood: number; requiredStone: number; depositedWood: number; depositedStone: number; requiredWork: number; completedWork: number;
    /** The old building remains operational; this paid delta reserves the target footprint. */
    expansion?: { blueprintId: string; components: StructureComponent[]; footprint?: { width: 1 | 2; height: 1 | 2 }; cells?: Array<{ x: number; y: number }> } };
  losses?: { water: number; food: number };
  installed?: Array<{ id: string; recipeId: string | null; mass: number; containment: number; insulation: number;
    cohesion: number; binding: number; condition: number;
    /** Fixed assets leave the portable technology ledger through its explicit estate outflow.
     * Retain their exact composition here, including after their installer dies. */
    composition?: import('./technology.js').Composition }>;
}
export interface InventionDynamics { attempts: number; accepted: number; repairs: number; waterCollected: number; foodStored: number; foodTaken: number; }

/**
 * Cota anticorrupción para `people.length` al validar una instantánea (ruling R17).
 * La disponibilidad de comida y agua condiciona el crecimiento de la población.
 */
export const POPULATION_HARD_LIMIT = 1_000_000;
