export type AnimalSpecies = 'hare' | 'deer' | 'boar' | 'fish' | 'wolf' | 'fox';
export type AnimalAction = 'roam' | 'graze' | 'drink' | 'rest' | 'hunt' | 'flee';
export interface AnimalGenes { speed: number; perception: number; metabolism: number; carnivory: number; waterEfficiency: number; camouflage: number; }
export interface AnimalView {
  id: string; species: AnimalSpecies; x: number; y: number; action: AnimalAction; reason: string;
  hunger: number; thirst: number; energy: number; fatigue: number; health: number;
  generation: number; parents: string[]; genes: AnimalGenes; age: number;
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
}
export interface InventionDynamics { attempts: number; accepted: number; repairs: number; waterCollected: number; foodStored: number; foodTaken: number; }

/**
 * Ruling R17 (2026-09-19): el límite de población lo pone el HARDWARE, no el software.
 * Esta constante NO es un tope de diseño: es la única barandilla contra snapshots
 * corruptos (un `people.length` absurdo tras una lectura dañada). El freno real al
 * crecimiento son el entorno (comida/agua) y el gobernador por p95 del paso
 * (`gobernador.presupuestoMs`), que apaga `reproductionEnabled` cuando el servidor
 * no alcanza. En un servidor más grande, más habitantes.
 */
export const POPULATION_HARD_LIMIT = 1_000_000;
