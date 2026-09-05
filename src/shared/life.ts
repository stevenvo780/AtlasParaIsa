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
