import type { AnimalView, AnimalDynamics, BlueprintView, StructureView, InventionDynamics } from './life.js';
import type { TechnologyRecipe, TechnologyView } from './technology.js';
import type { OrganizationAnalysis } from './organization.js';
export type { AnimalView, AnimalDynamics, BlueprintView, StructureView, InventionDynamics } from './life.js';
export type { TechnologyRecipe, TechnologyRecipeSummary } from './technology.js';
/** 7: `TechnologyView.recipes` carries summaries; the program travels only on request.
 * A cached older client must fail in the open instead of drawing an absent program. */
export const PROTOCOL_VERSION = 7;
export interface Viewport { x: number; y: number; width: number; height: number; }
export type Biome = 'grassland' | 'forest' | 'desert' | 'mountain' | 'wetland' | 'ocean';
export type Terrain = 'water' | 'soil' | 'meadow' | 'shelter';
export type Feature = 'tree' | 'pine' | 'palm' | 'cactus' | 'reeds' | 'berries' | 'flowers' | 'rock' | 'clay' | 'stump' | 'spring' | 'pool' | 'none';
export type Species = 'hare' | 'deer' | 'boar' | 'fish' | 'wolf' | 'fox';
export interface Tile { x: number; y: number; terrain: Terrain; moisture: number; vegetation: number; food: number; biome?: Biome; elevation?: number; wood?: number; stone?: number; feature?: Feature; variety?: number; growth?: number; fertility?: number; cultivation?: number; traffic?: number; drinkingWater?: number; species?: Species; fauna?: number; life?: number; }
export type Action = 'explore' | 'eat' | 'forage' | 'drink' | 'hunt' | 'rest' | 'approach' | 'accompany' | 'retreat' | 'share' | 'gather' | 'farm' | 'build' | 'cooperate' | 'invent' | 'repair' | 'research' | 'craft';
export type Order = 'move' | 'explore' | 'forage' | 'gather' | 'farm' | 'build' | 'hunt' | 'drink' | 'rest' | 'cooperate' | 'invent' | 'repair' | 'research' | 'craft' | 'auto';
export interface GenomeView { generation: number; parents: string[]; learningRate: number; cooperation: number; mutations: number; }
export interface PersonView {
  id: string; name: string; role: 'S' | 'I' | 'neighbor'; x: number; y: number;
  color: string; action: Action; reason: string;
  energy: number; hunger: number; fatigue: number; need: string;
  recentMemory: string | null; thirst?: number;
  specialty?: string; controlMode?: 'auto' | 'directed';
  traits?: { curiosity: number; sociability: number; industriousness: number; care: number; resilience: number };
  skills?: Record<string, number>; materials?: { wood: number; stone: number };
  genome?: GenomeView; age?: number; experiences?: { tick: number; text: string; causeId: string }[];
  communityId?: string | null; culture?: { sharing: number; stewardship: number; openness: number }; trust?: { id: string; value: number }[];
  blueprintId?: string | null;
  target?: { x: number; y: number }; working?: boolean; workProgress?: number;
  foodReserve?: number; foodReserveCapacity?: number;
  health?: number; vitality?: number; continuityProtected?: boolean;
  /** Server-derived inherited age thresholds; absence means unknown, not reproductive readiness. */
  lifeStage?: 'juvenile' | 'adult' | 'senescent';
}
export interface PlaceView { id: string; name: string; x: number; y: number; description: string; gatherings: number; }
export interface ChronicleEvent {
  id: string; tick: number; kind: 'ecology' | 'meeting' | 'care' | 'learning' | 'adaptation' | 'memory' | 'gesture' | 'pause' | 'discovery' | 'settlement' | 'cooperation' | 'birth' | 'community' | 'conflict' | 'animal' | 'invention' | 'death';
  actors: string[]; text: string; cause: string; x?: number; y?: number; source: 'simulation' | 'sample' | 'approved';
  /** FR-006: only on kind 'death'. Explicit place, tick and up to 3 prior events of the same actor,
   * so the inspector can show legible context beyond the free-text `cause`. */
  death?: { cause: string; tick: number; x: number; y: number; previous: string[] };
}
export interface MemoryView { id: string; title: string; text: string; source: 'sample' | 'approved'; placeId: string; }
export interface WorldView {
  version: number; sequence: number; tick: number; day: number;
  phase: 'dawn' | 'day' | 'dusk' | 'night'; weather: 'clear' | 'rain';
  width: number; height: number; tiles: Tile[]; people: PersonView[]; places: PlaceView[];
  events: ChronicleEvent[]; memories: MemoryView[];
  paused?: boolean; pauseReason?: string;
  originX?: number; originY?: number; infinite?: boolean;
  discoveredChunks?: number; settlementCount?: number; activeChunks?: number;
  stats?: WorldStats; performance?: RuntimeStats;
  communities?: CommunityView[];
  animals?: AnimalView[]; blueprints?: BlueprintView[]; structures?: StructureView[];
  technology?: TechnologyView; organization?: OrganizationAnalysis;
  /** Identity of the served world; the projection omits it and the server adds it. */
  instanceId?: string;
  demography?: { deaths: number; causes: Record<string, number>; recent: { id: string; name: string; generation: number; parents: string[]; bornAt: number; diedAt: number; cause: string }[] };
}
export interface CommunityView { id: string; name: string; x: number; y: number; color: string; members: string[]; culture: { sharing: number; stewardship: number; openness: number }; formedAt: number; cooperation: number; disputes: number; }
export interface WorldSample { tick: number; population: number; energy: number; hunger: number; fatigue: number; thirst: number; discoveries: number; settlements: number; cooperation: number; births: number; }
export interface WorldStats { population: number; meanEnergy: number; meanHunger: number; meanFatigue: number; meanThirst: number; materials: { wood: number; stone: number }; actions: Record<string, number>; biomes: Record<string, number>; features: Record<string, number>; totals: Record<string, number>; generations: Record<string, number>; history: WorldSample[]; scope: 'active-regions'; wildlife: Record<string, number>; freshWater: number; cultivatedTiles: number; trailTiles: number; animalDynamics?: AnimalDynamics; structures?: Record<string, number>; blueprints?: number; inventionDynamics?: InventionDynamics;
  /** T019/T036(e): diversidad de conducta y de oficios de la población viva (0..1 cada una). */
  diversidad?: { conducta: number; oficios: number; total: number }; }
/** `tickHz`: ritmo real medido en reloj de pared sobre los últimos pasos, no el ritmo pedido. */
export interface RuntimeStats { stepMs: number; p95StepMs: number; saveMs: number; projectionMs: number; snapshotBytes: number; activeTiles: number; processRssMiB: number; tickHz: number; }
export type GestureKind = 'plant' | 'invite' | 'remember' | 'command';
export interface Gesture { id: string; kind: GestureKind; x: number; y: number; memoryId?: string; agentId?: string; order?: Order; }
export interface GestureResult {
  id: string; accepted: boolean; tick: number; order: number; message: string;
}
/** Everything a client may send upstream. A camera or a query is never a gesture. */
export type ClientMessage =
  | { type: 'gesture'; gesture: Gesture }
  | { type: 'viewport'; viewport: Viewport }
  | { type: 'recipe'; id: string }
  /** Modo ligero móvil (T024): cadencia mínima pedida por ese cliente; el servidor acota a 1000 ms. */
  | { type: 'suscripcion'; intervaloMs: number };
export type ServerMessage =
  | { type: 'state'; world: WorldView }
  | { type: 'result'; result: GestureResult }
  /** A null definition means the server cannot serve that program now, never that it is empty. */
  | { type: 'recipe'; id: string; recipe: TechnologyRecipe | null }
  | { type: 'error'; message: string };
